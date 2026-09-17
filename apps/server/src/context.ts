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
 * The tenant a credential is bound to.
 *
 * For the routes that address an object by id — an event, a claim, a candidate, a
 * trace — there is no tenant in the body to check, so the credential's binding is the
 * only tenant the request can be about. A tenant-less credential cannot use these
 * routes at all: without a binding there is no tenant to *be* in, and choosing one
 * from the request would be the caller selecting its own tenant.
 */
export function tenantFromCredential(input: { readonly identity: Identity; readonly what: string }): TenantContext {
  if (input.identity.tenant === null || input.identity.tenant.length === 0) {
    throw new ApiError(
      "validation_failed",
      `${input.what} addresses an existing object by id, so the credential must be bound to a tenant`,
      400,
    );
  }
  return {
    tenant: input.identity.tenant,
    tenantId: resolveTenantId(input.identity.tenant),
    principal: input.identity.principal,
    identity: input.identity,
  };
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

/** The scope ids a caller reaches, together with the purposes those scopes carry. */
export interface CallerReach {
  readonly scopeIds: readonly string[];
  /**
   * Every purpose named by a scope the caller holds.
   *
   * This is the set the request context must declare, and it is not optional. Since
   * migration 0006 the authorization predicate is a single conjunction —
   * tenant match AND `scope_reachable(scope, current_purposes())` — and
   * `scope_reachable` denies an empty purpose set outright, because an empty purpose
   * set is the absence of an authorization basis rather than a wildcard. A read bound
   * with no purposes therefore sees *nothing at all*, including rows the caller
   * plainly holds. That failure is silent: it returns 404, which is also the correct
   * answer for an unreachable object, so a server that got this wrong would look like
   * a server whose database was empty.
   *
   * The purposes are read from the scopes, never from the request. A caller cannot
   * widen them by asking, and they are the caller's own purposes, so declaring them
   * grants nothing that membership did not already grant.
   */
  readonly purposes: readonly string[];
}

export async function callerReach(
  executor: QueryExecutor,
  input: { readonly tenantId: string; readonly principal: string; readonly now: string },
): Promise<CallerReach> {
  const scopes = await callerScopes(executor, input);
  const purposes = new Set<string>();
  for (const scope of scopes) for (const purpose of scope.purpose) purposes.add(purpose);
  return { scopeIds: scopes.map((scope) => scope.scope_id), purposes: [...purposes] };
}

/**
 * Read one object inside a bound request context, or report that it is not there.
 *
 * Two sequential transactions, deliberately not nested. The first discovers the
 * caller's reach — membership plus live grants — and the second performs the read
 * with that reach bound. Nesting them would check a second connection out of the
 * pool while the first is held, and with a pool of N, N concurrent requests would
 * deadlock: every request holding an outer connection and waiting for an inner one.
 * That failure mode is invisible in a single-request test and appears as an
 * unexplained hang under load, so the shape is avoided structurally rather than
 * documented.
 *
 * The binding carries the caller's reachable scope ids *and* the purposes those
 * scopes hold. Both are required: the predicate denies an empty purpose set, so a
 * read bound without purposes returns nothing even for rows the caller holds. See
 * `CallerReach.purposes`.
 */
export async function withReadContext<T>(
  deps: ServerDeps,
  caller: TenantContext,
  fn: (executor: QueryExecutor) => Promise<T>,
): Promise<T> {
  const reach = await discoverReach(deps, caller);
  return deps.db.withRequest(
    {
      tenant: caller.tenantId,
      principal: caller.principal,
      scopeIds: reach.scopeIds,
      purposes: reach.purposes,
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
  const reach = await discoverReach(deps, caller);
  return deps.db.withRequest(
    {
      tenant: caller.tenantId,
      principal: caller.principal,
      scopeIds: reach.scopeIds,
      purposes: reach.purposes,
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
async function discoverReach(deps: ServerDeps, caller: TenantContext): Promise<CallerReach> {
  const now = deps.clock.now().toISOString();
  // The discovery transaction binds no scope and no purpose, and that is safe rather
  // than convenient: it reads `principal_scopes`, `grants` and `scopes`, none of which
  // carries claim content, and `scopes` is deliberately readable within the tenant
  // because resolving a scope *is* part of authorization. It cannot read an event or a
  // claim, because those tables are guarded by the predicate whose inputs this
  // transaction exists to compute.
  return deps.db.withRequest(
    {
      tenant: caller.tenantId,
      principal: caller.principal,
      scopeIds: [],
      purposes: [],
      action: "api:reach",
    },
    async (executor) => callerReach(executor, { tenantId: caller.tenantId, principal: caller.principal, now }),
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
