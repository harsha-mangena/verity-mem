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

/**
 * A query function, bound or unbound.
 *
 * Deliberately a function rather than a `QueryExecutor`, because reach discovery runs
 * on a pooled connection *outside* a request context while every other read runs
 * inside one, and the two only look alike. Taking an executor would let a caller pass
 * either one and the type would not say which — which is how a `Db` handed to a
 * function expecting a bound executor throws "database access outside a request
 * context" at runtime instead of failing to compile.
 */
export type QueryFn = <R extends Record<string, unknown>>(
  text: string,
  params?: readonly unknown[],
) => Promise<{ rows: R[]; rowCount: number | null }>;

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
  query: QueryFn,
  input: {
    readonly tenantId: string;
    readonly principal: string;
    readonly now: string;
    /**
     * Whether this credential administers the tenant.
     *
     * `privacy-admin` is the profile that owns sharing, forgetting, replay and
     * evaluation, and those operations act on the tenant rather than on the caller's
     * own participation — an administrator who has never written to a scope has no
     * `principal_scopes` row for it and would otherwise be unable to revoke a grant or
     * review a candidate in it. The reach is still server-owned: it is bounded by the
     * tenant, recorded in `principal_scopes` with `source = 'admin'` so an operator can
     * see how it arose, and it does not extend to reading claim *content* on the
     * ordinary read path, which binds the caller's own reach.
     */
    readonly tenantAdmin?: boolean;
  },
): Promise<CallerScope[]> {
  const memberScopes = await query<CallerScope>(
    `SELECT s.scope_id, s.project, s.user_id, s.agent_id, s.session_id, s.purpose
       FROM principal_scopes ps
       JOIN scopes s ON s.scope_id = ps.scope_id
      WHERE ps.tenant_id = $1::uuid
        AND ps.principal_id = $2`,
    [input.tenantId, input.principal],
  );

  const grants = await query<{
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
          await query<CallerScope>(
            `SELECT s.scope_id, s.project, s.user_id, s.agent_id, s.session_id, s.purpose
               FROM scopes s
              WHERE s.tenant_id = $1::uuid
                AND (${clauses.join(" OR ")})`,
            params,
          )
        ).rows;

  const adminScopes = input.tenantAdmin === true
    ? (
        await query<CallerScope>(
          `SELECT s.scope_id, s.project, s.user_id, s.agent_id, s.session_id, s.purpose
             FROM scopes s
            WHERE s.tenant_id = $1::uuid`,
          [input.tenantId],
        )
      ).rows
    : [];

  const byId = new Map<string, CallerScope>();
  for (const scope of [...memberScopes.rows, ...grantedScopes, ...adminScopes]) byId.set(scope.scope_id, scope);
  return [...byId.values()];
}

/**
 * Record that a tenant administrator participates in a scope.
 *
 * Written through `veritymem.record_participation`, which is the SECURITY DEFINER
 * function the write path already uses, so the row is indistinguishable in shape from
 * an organic membership and is labelled `admin` by the caller. Idempotent, and it
 * fails closed: a failure to record does not grant anything, it only leaves the reach
 * smaller than it was.
 */
export async function recordAdminParticipation(
  query: QueryFn,
  input: { readonly tenantId: string; readonly principal: string; readonly scopeIds: readonly string[] },
): Promise<void> {
  for (const scopeId of input.scopeIds) {
    await query(`SELECT veritymem.record_participation($1::uuid, $2, $3::uuid)`, [
      input.tenantId,
      input.principal,
      scopeId,
    ]);
  }
}

/**
 * The reachable scope ids, for binding a request context.
 *
 * Takes a `QueryFn` rather than a `QueryExecutor`, because the two are not
 * interchangeable to the compiler even though every executor satisfies the shape at
 * runtime: `QueryExecutor.query` is generic over `R extends QueryResultRow` — an
 * index-signature type — while `QueryFn` is generic over `R extends Record<string,
 * unknown>`. Callers inside a transaction pass
 * `(text, params) => executor.query(text, params)`.
 */
export async function callerScopeIds(
  query: QueryFn,
  input: { readonly tenantId: string; readonly principal: string; readonly now: string },
): Promise<string[]> {
  return (await callerScopes(query, input)).map((scope) => scope.scope_id);
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
  query: QueryFn,
  input: {
    readonly tenantId: string;
    readonly principal: string;
    readonly now: string;
    readonly tenantAdmin?: boolean;
  },
): Promise<CallerReach> {
  const scopes = await callerScopes(query, input);
  const purposes = new Set<string>();
  for (const scope of scopes) for (const purpose of scope.purpose) purposes.add(purpose);
  return { scopeIds: scopes.map((scope) => scope.scope_id), purposes: [...purposes] };
}

/**
 * Run a handler with the caller's reach bound into the request context.
 *
 * One transaction, and this shape is a correctness requirement rather than a style
 * choice. Two constraints force it, and each rules out an obvious alternative:
 *
 *  1. `veritymem.set_request_context` writes *transaction-local* GUCs. A nested
 *     `withRequest` therefore does not shadow an outer binding — it overwrites it for
 *     the remainder of the outer transaction. A handler that discovered its reach in a
 *     nested transaction would run its real query under the discovery binding, whose
 *     scope set is empty, and every row would vanish. The symptom is a 404 on an object
 *     that demonstrably exists.
 *  2. `principal_scopes` is readable only to the principal it describes: its policy is
 *     `tenant_id = current_tenant_id() AND principal_id = current_principal_id()`.
 *     Membership therefore cannot be read on an unbound connection at all — it would
 *     come back empty and the caller would appear to belong to nothing.
 *
 * So the binding is taken once, with the tenant and principal set, and the reach is
 * read with it. That first binding names no scopes and no purposes, which grants
 * nothing: `principal_scopes`, `grants` and `scopes` carry no claim content, and the
 * tables that do carry claim content are guarded by the predicate whose inputs this
 * call exists to compute. Only after the reach is known is the context re-set, in the
 * same transaction, to the caller's scopes and purposes.
 */
async function withReachContext<T>(
  deps: ServerDeps,
  caller: TenantContext,
  action: string,
  options: { readonly readOnly: boolean },
  fn: (executor: QueryExecutor) => Promise<T>,
): Promise<T> {
  const now = deps.clock.now().toISOString();
  return deps.db.withRequest(
    {
      tenant: caller.tenantId,
      principal: caller.principal,
      scopeIds: [],
      purposes: [],
      action: `${action}:reach`,
    },
    async (executor) => {
      const query: QueryFn = (text, params) => executor.query(text, params);
      const reach = await callerReach(query, {
        tenantId: caller.tenantId,
        principal: caller.principal,
        now,
        tenantAdmin: caller.identity.profile === "privacy-admin",
      });
      if (caller.identity.profile === "privacy-admin") {
        await recordAdminParticipation(query, {
          tenantId: caller.tenantId,
          principal: caller.principal,
          scopeIds: reach.scopeIds,
        });
      }
      await executor.query(`SELECT veritymem.set_request_context($1::uuid, $2, $3::uuid[], $4::text[], $5)`, [
        caller.tenantId,
        caller.principal,
        `{${reach.scopeIds.join(",")}}`,
        `{${reach.purposes.map(quoteArrayElement).join(",")}}`,
        action,
      ]);
      return fn(executor);
    },
    { readOnly: options.readOnly },
  );
}

/**
 * Read one object, or report that it is not there.
 *
 * The binding carries the caller's reachable scope ids *and* the purposes those scopes
 * hold. Both are required: the predicate denies an empty purpose set, so a read bound
 * without purposes returns nothing even for rows the caller holds. See
 * `CallerReach.purposes`.
 */
export async function withReadContext<T>(
  deps: ServerDeps,
  caller: TenantContext,
  fn: (executor: QueryExecutor) => Promise<T>,
): Promise<T> {
  return withReachContext(deps, caller, "api:read", { readOnly: true }, fn);
}

/**
 * Bind a write.
 *
 * The scope set is the caller's reach, because every write this server performs is
 * either inside a scope the caller participates in or is a decision about an object in
 * one. A write that needs to reach an object the caller does not hold is not a write
 * this server performs.
 */
export async function withWriteContext<T>(
  deps: ServerDeps,
  caller: TenantContext,
  action: string,
  fn: (executor: QueryExecutor) => Promise<T>,
): Promise<T> {
  return withReachContext(deps, caller, action, { readOnly: false }, fn);
}

/**
 * Quote one element of a Postgres array literal.
 *
 * The scope-id array is interpolated rather than bound, because `set_request_context`
 * takes an array and the driver's parameter handling for `uuid[]` through a text
 * literal is what the ledger package already does. Purposes are caller-adjacent
 * strings, so a quote or backslash in one must not be able to terminate the literal
 * early and append a purpose of the caller's choosing.
 */
function quoteArrayElement(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
