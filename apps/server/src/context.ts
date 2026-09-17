/**
 * Request context: tenant resolution, caller reach, and the binding every handler
 * runs inside.
 *
 * Three rules are implemented here and nowhere else, which is the reason this is a
 * module rather than a handful of helpers spread across the route files:
 *
 *  1. **The tenant comes from the credential.** A body that names a tenant is
 *     checked against the token's tenant and refused on mismatch. A caller that can
 *     choose its own tenant is a caller that can read another tenant's ledger by
 *     writing a different string, and no downstream check would catch it because
 *     every downstream check is scoped by that same value.
 *  2. **Every database call is bound.** `Db.query` throws outside
 *     `withRequest`/`withSystemContext` by design; `withReadContext` and
 *     `withWriteContext` are how a route gets one, so a route cannot accidentally
 *     reach the unbound path.
 *  3. **Reach is computed from server-side state.** Membership and live grants, never
 *     from the request. A request that names a scope it does not hold is narrowed to
 *     what it holds, and a direct read of an object it cannot reach returns the same
 *     404 as an object that does not exist.
 *
 * The reach query duplicates the planner's union of membership and grants instead of
 * calling `resolveScopes`, and that duplication is deliberate: `resolveScopes` takes
 * the purpose set as an *input*, so it cannot be used to discover which purposes a
 * caller reaches — which is exactly what an object read by id needs, because an
 * object's purpose is a property of the object, not of the request. Reusing the
 * planner would mean passing the purposes it is supposed to compute.
 */
import type { QueryExecutor } from "@veritymem/ledger";
import { resolveTenantId } from "@veritymem/ledger";
import { ApiError } from "./errors.ts";
import type { Identity } from "./identity.ts";
import type { ServerDeps } from "./config.ts";

export interface CallerScope {
  readonly scope_id: string;
  readonly project: string | null;
  readonly user_id: string | null;
  readonly agent_id: string | null;
  readonly session_id: string | null;
  readonly purpose: readonly string[];
  readonly [column: string]: unknown;
}

export interface TenantContext {
  readonly tenant: string;
  readonly tenantId: string;
  readonly principal: string;
  readonly identity: Identity;
}

/**
 * Resolve the tenant a request acts on, refusing a body that disagrees with the
 * credential.
 *
 * `requestTenant` is read from the *body* by the caller and passed here as a plain
 * string, so this function cannot be fooled by a nested object it did not expect.
 * The 403 rather than 400 is deliberate: the request is well-formed and the caller
 * is authenticated; it is asking for something it may not have, and the error code
 * should send the reader to the grant table rather than to the schema.
 */
export function resolveCallerTenant(input: {
  readonly identity: Identity;
  readonly requestTenant: string | undefined;
  readonly required?: boolean;
  readonly what?: string;
}): TenantContext {
  const { identity, requestTenant } = input;
  if (identity.tenant !== null && requestTenant !== undefined && requestTenant !== identity.tenant) {
    throw new ApiError(
      "tenant_mismatch",
      "the request names a tenant the credential is not bound to",
      403,
      { credential_tenant_bound: true },
    );
  }
  const tenant = identity.tenant ?? requestTenant ?? null;
  if (tenant === null || tenant.length === 0) {
    if (input.required === false) {
      throw new ApiError(
        "validation_failed",
        `${input.what ?? "this route"} requires an explicit tenant when the credential is not tenant-bound`,
        400,
      );
    }
    throw new ApiError(
      "validation_failed",
      `${input.what ?? "this route"} requires a tenant, either bound to the credential or named in the request`,
      400,
    );
  }
  return { tenant, tenantId: resolveTenantId(tenant), principal: identity.principal, identity };
}

/**
 * The scopes a principal reaches, with their dimensions.
 *
 * Membership is established server-side when an event is appended
 * (`veritymem.record_participation`), and grants are the mechanism for reaching
 * something the principal does not participate in. The request is not consulted
 * here at all, which is what makes "a caller cannot widen its own read scope by
 * asking" true rather than aspirational.
 */
export async function callerScopes(
  executor: QueryExecutor,
  input: { readonly tenantId: string; readonly principal: string; readonly now: string },
): Promise<CallerScope[]> {
  const memberScopes = await executor.query<CallerScope>(
    `SELECT s.scope_id, s.project, s.user_id, s.agent_id, s.session_id, s.purpose
       FROM principal_scopes ps
       JOIN scopes s ON s.scope_id = ps.scope_id
      WHERE ps.tenant_id = $1::uuid
        AND ps.principal_id = $2`,
    [input.tenantId, input.principal],
  );

  const grants = await executor.query<{
    matrix: { project?: string; user?: string; agent?: string; session?: string };
    actions: string[];
    purpose: string[];
    expires_at: Date | string | null;
  }>(
    `SELECT matrix, actions, purpose, expires_at
       FROM grants
      WHERE tenant_id = $1::uuid
        AND subject = $2
        AND (expires_at IS NULL OR expires_at > $3::timestamptz)`,
    [input.tenantId, input.principal, input.now],
  );

  const clauses: string[] = [];
  const params: unknown[] = [input.tenantId];
  for (const grant of grants.rows) {
    if (!grant.actions.some((action) => action === "read" || action === "query" || action === "*")) continue;
    const parts: string[] = [];
    for (const dimension of ["project", "user", "agent", "session"] as const) {
      const value = grant.matrix[dimension];
      if (value === undefined) continue;
      const column =
        dimension === "user"
          ? "user_id"
          : dimension === "agent"
            ? "agent_id"
            : dimension === "session"
              ? "session_id"
              : "project";
      params.push(value);
      parts.push(`s.${column} = $${params.length}`);
    }
    if (parts.length === 0) continue;
    clauses.push(`(${parts.join(" AND ")})`);
  }

  const grantedScopes =
    clauses.length === 0
      ? []
      : (
          await executor.query<CallerScope>(
            `SELECT s.scope_id, s.project, s.user_id, s.agent_id, s.session_id, s.purpose
               FROM scopes s
              WHERE s.tenant_id = $1::uuid
                AND (${clauses.join(" OR ")})`,
            params,
          )
        ).rows;

  const byId = new Map<string, CallerScope>();
  for (const scope of [...memberScopes.rows, ...grantedScopes]) byId.set(scope.scope_id, scope);
  return [...byId.values()];
}

/** The reachable scope ids, for binding a request context. */
export async function callerScopeIds(
  executor: QueryExecutor,
  input: { readonly tenantId: string; readonly principal: string; readonly now: string },
): Promise<string[]> {
  return (await callerScopes(executor, input)).map((scope) => scope.scope_id);
}

/**
 * Read one object inside a bound request context, or report that it is not there.
 *
 * Two sequential transactions, deliberately not nested. The first discovers the
 * caller's reach — membership plus live grants — and the second performs the read
 * with that reach bound. Nesting them would check a second connection out of the
 * pool while the first is held, and with a pool of N, N concurrent requests would
 * deadlock: every request holding an outer connection and waiting for an inner one.
 * That failure mode is invisible in a single-request test and appears as a
 * unexplained hang under load, so the shape is avoided structurally rather than
 * documented.
 *
 * The binding carries the caller's reachable scope ids and no purposes. That is not
 * a loosening: `veritymem.row_authorized` requires the tenant to match *and*
 * `scope_reachable(scope, current_purposes())`, and it is the scope set — computed
 * from membership and grants, never from the request — that decides. Passing the
 * object's own purpose as the request purpose would let a caller name a purpose it
 * was never granted for and read the row anyway, which is the empty-purpose bug in
 * a new costume.
 */
export async function withReadContext<T>(
  deps: ServerDeps,
  caller: TenantContext,
  fn: (executor: QueryExecutor) => Promise<T>,
): Promise<T> {
  const scopes = await discoverReach(deps, caller);
  return deps.db.withRequest(
    {
      tenant: caller.tenantId,
      principal: caller.principal,
      scopeIds: scopes,
      purposes: [],
      action: "api:read",
    },
    fn,
    { readOnly: true },
  );
}

/**
 * Bind a write.
 *
 * The scope set is the caller's reach, because every write this server performs is
 * either inside a scope the caller participates in or is a decision about an object
 * in one. A write that needs to reach an object the caller does not hold is not a
 * write this server performs.
 */
export async function withWriteContext<T>(
  deps: ServerDeps,
  caller: TenantContext,
  action: string,
  fn: (executor: QueryExecutor) => Promise<T>,
): Promise<T> {
  const scopes = await discoverReach(deps, caller);
  return deps.db.withRequest(
    {
      tenant: caller.tenantId,
      principal: caller.principal,
      scopeIds: scopes,
      purposes: [],
      action,
    },
    fn,
  );
}

/**
 * Discover reach in its own short transaction.
 *
 * `action: "api:reach"` rather than `"api:read"`: the trace of what a request did
 * should show that one round trip resolved authorization and did not touch claim
 * data, which is the property the whole read path depends on.
 */
async function discoverReach(deps: ServerDeps, caller: TenantContext): Promise<string[]> {
  const now = deps.clock.now().toISOString();
  return deps.db.withRequest(
    {
      tenant: caller.tenantId,
      principal: caller.principal,
      scopeIds: [],
      purposes: [],
      action: "api:reach",
    },
    async (executor) => callerScopeIds(executor, { tenantId: caller.tenantId, principal: caller.principal, now }),
    { readOnly: true },
  );
}

/**
 * Bind a request context to an exact scope set and purpose set.
 *
 * Used where the correct boundary is already known and is narrower than the
 * caller's reach: the extraction path binds the origin event's own scope, because
 * ingest writes candidates and spans that belong to that event and to nothing else.
 */
export async function withBoundContext<T>(
  deps: ServerDeps,
  binding: {
    readonly tenantId: string;
    readonly principal: string;
    readonly scopeIds: readonly string[];
    readonly purposes: readonly string[];
    readonly action: string;
    readonly readOnly?: boolean;
  },
  fn: (executor: QueryExecutor) => Promise<T>,
): Promise<T> {
  return deps.db.withRequest(
    {
      tenant: binding.tenantId,
      principal: binding.principal,
      scopeIds: binding.scopeIds,
      purposes: binding.purposes,
      action: binding.action,
    },
    fn,
    binding.readOnly === true ? { readOnly: true } : {},
  );
}

/**
 * Tenant-wide maintenance, for the administrative routes.
 *
 * `withSystemContext` reaches every row in one tenant and no other, which is
 * correct for retention, replay and projection rebuild — operations whose subject
 * is a tenant rather than a caller's intent. It is never used on a request path
 * that returns claim data, because those must be answered from the caller's reach.
 */
export async function withAdminContext<T>(
  deps: ServerDeps,
  input: { readonly tenantId: string; readonly actor: string },
  fn: (executor: QueryExecutor) => Promise<T>,
): Promise<T> {
  return deps.db.withSystemContext({ tenant: input.tenantId, actor: input.actor }, fn);
}
