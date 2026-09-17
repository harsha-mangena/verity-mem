/**
 * The policy-first query planner.
 *
 * The order of operations is the whole point of this module:
 *
 *   1. resolve the caller's scope through grants,
 *   2. compute the set of scope ids the caller may reach,
 *   3. bind that set into the request context so row-level security enforces it,
 *   4. *then* run any retrieval channel.
 *
 * Step 3 before step 4 is not an optimisation. Filtering after a vector search
 * leaks through result counts, timing differences and generated summaries: a
 * caller learns that *something* exists even when the something is withheld. An
 * unauthorized claim is never a retrieval candidate here, so it cannot influence
 * a count, a ranking or a latency.
 */
import type {
  ActionRisk,
  ClaimKind,
  QueryRequest,
  ScopeSelector,
  TimeSpec,
} from "@veritymem/contracts";
import { DEFAULT_USE_POLICY_VERSION } from "@veritymem/contracts";
import type { QueryExecutor } from "@veritymem/ledger";

export interface PlanRequest {
  readonly tenant_id: string;
  readonly principal: string;
  readonly query: QueryRequest;
}

/**
 * A structured plan. Deliberately inspectable: the whole object is stored in the
 * query trace, so "why did the system return this" has an answer that does not
 * require re-running anything.
 */
export interface QueryPlan {
  readonly policy_version: string;
  readonly tenant_id: string;
  readonly principal: string;
  readonly text: string;
  readonly purpose: string;
  readonly action_risk: ActionRisk;
  readonly time: TimeSpec;
  readonly kinds: readonly ClaimKind[] | null;
  readonly subjects: readonly string[] | null;
  /** Vocabulary for the entity channel. Never a filter on its own. */
  readonly entity_terms: readonly string[];
  readonly limit: number;
  /**
   * The concrete scopes the caller may reach, with dimensions. Every channel is
   * restricted to the containment closure of this set.
   */
  readonly authorized_scopes: readonly ResolvedScopeRow[];
  /** Just the ids, for binding the request context and for the trace. */
  readonly authorized_scope_ids: readonly string[];
  /** How the scope set was derived, for the trace. */
  readonly scope_resolution: string;
  /** Scopes that were requested but not granted, recorded so narrowing is visible. */
  readonly denied_dimensions: readonly string[];
  readonly channels: readonly string[];
  readonly authz_before_retrieval: true;
}

export interface GrantRow {
  readonly grant_id: string;
  readonly subject: string;
  readonly matrix: {
    readonly tenant?: string;
    readonly project?: string;
    readonly user?: string;
    readonly agent?: string;
    readonly session?: string;
  };
  readonly actions: string[];
  readonly purpose: string[];
  readonly expires_at: Date | string | null;
  readonly [column: string]: unknown;
}

/**
 * Expand the caller's own scope plus every live grant into concrete scope ids.
 *
 * Grants are matched by dimension, not by string equality on a namespace: a grant
 * naming only a project reaches every scope inside that project, and a grant
 * naming a user reaches only that user's scopes. Matching on a concatenated
 * namespace string is how purpose and tenant boundaries get lost, which is the
 * specific flaw the specification calls out for adapters.
 */
export interface ResolvedScopeRow {
  readonly scope_id: string;
  readonly project: string | null;
  readonly user_id: string | null;
  readonly agent_id: string | null;
  readonly session_id: string | null;
  readonly purpose: readonly string[];
  readonly [column: string]: unknown;
}

export interface ScopeResolution {
  /**
   * Every scope the caller may reach, with its dimensions.
   *
   * Dimensions, not just ids, because the containment rule is per-dimension: a
   * caller holding both a project scope and a user scope must not be handed the
   * union of what each reaches independently. A principal's access is the union of
   * grants they *hold*, and within each granted scope the ordinary containment
   * rules apply.
   */
  readonly scopes: readonly ResolvedScopeRow[];
  readonly resolution: string;
  readonly denied: readonly string[];
}

/**
 * Expand the caller's own scope plus every live grant into concrete scopes.
 *
 * Grants are matched by dimension, not by string equality on a namespace: a grant
 * naming only a project reaches every scope inside that project, and a grant
 * naming a user reaches only that user's scopes. Matching on a concatenated
 * namespace string is how purpose and tenant boundaries get lost, which is the
 * specific flaw the specification calls out for adapters.
 */
/**
 * Resolve what a principal may reach.
 *
 * Reach is computed from state the server owns:
 *
 *     reach(principal) = scopes the principal belongs to  ∪  scopes named by live grants
 *
 * The request's selector can only *narrow* that set. It cannot widen it, because
 * the alternative — treating the selector as an assertion of what the caller is —
 * lets a request naming only a tenant and a project claim to be the project, and
 * the containment rule then hands it every user inside that project.
 *
 * The containment rule applied to each candidate is `veritymem.scope_contains`,
 * the same function the RLS predicate calls, with the same directional semantics:
 * a caller unbound on a dimension reaches any binding of it, and a caller bound on
 * a dimension requires the row to bind the same value.
 */
export async function resolveScopes(
  executor: QueryExecutor,
  input: {
    readonly tenant_id: string;
    readonly principal: string;
    readonly selector: ScopeSelector;
    readonly purposes: readonly string[];
    readonly now: string;
  },
): Promise<ScopeResolution> {
  const denied: string[] = [];

  // Scopes the principal belongs to, from server-side membership.
  const memberScopes = await executor.query<ResolvedScopeRow>(
    `SELECT s.scope_id, s.project, s.user_id, s.agent_id, s.session_id, s.purpose
       FROM principal_scopes ps
       JOIN scopes s ON s.scope_id = ps.scope_id
      WHERE ps.tenant_id = $1::uuid
        AND ps.principal_id = $2
        AND s.purpose && $3::text[]`,
    [input.tenant_id, input.principal, [...input.purposes]],
  );

  // Scopes named by live grants. A grant is the mechanism for reaching something
  // the principal does not participate in, so it is expanded by dimension.
  const grants = await executor.query<GrantRow>(
    `SELECT grant_id, subject, matrix, actions, purpose, expires_at
       FROM grants
      WHERE tenant_id = $1::uuid
        AND subject = $2
        AND (expires_at IS NULL OR expires_at > $3::timestamptz)`,
    [input.tenant_id, input.principal, input.now],
  );

  const grantedClauses: string[] = [];
  const grantedParams: unknown[] = [input.tenant_id, [...input.purposes]];
  let grantCount = 0;
  for (const grant of grants.rows) {
    if (!grant.actions.some((action) => action === "read" || action === "query" || action === "*")) {
      continue;
    }
    if (grant.purpose.length > 0 && !grant.purpose.some((purpose) => input.purposes.includes(purpose))) {
      continue;
    }
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
      grantedParams.push(value);
      parts.push(`s.${column} = $${grantedParams.length}`);
    }
    if (parts.length === 0) continue;
    grantedClauses.push(`(${parts.join(" AND ")})`);
    grantCount += 1;
  }

  const grantedScopes =
    grantedClauses.length === 0
      ? []
      : (
          await executor.query<ResolvedScopeRow>(
            `SELECT s.scope_id, s.project, s.user_id, s.agent_id, s.session_id, s.purpose
               FROM scopes s
              WHERE s.tenant_id = $1::uuid
                AND s.purpose && $2::text[]
                AND (${grantedClauses.join(" OR ")})`,
            grantedParams,
          )
        ).rows;

  // Union, then narrow by the selector. A selector dimension is an extra
  // restriction the caller imposes on its own reach — never a widening.
  const candidates = new Map<string, ResolvedScopeRow>();
  for (const scope of [...memberScopes.rows, ...grantedScopes]) {
    candidates.set(scope.scope_id, scope);
  }

  const narrow = (scope: ResolvedScopeRow): boolean => {
    if (scope.purpose.length === 0) return false;
    if (!scope.purpose.some((purpose) => input.purposes.includes(purpose))) return false;
    if (input.selector.project !== undefined && scope.project !== null && scope.project !== input.selector.project) {
      return false;
    }
    if (input.selector.user !== undefined && scope.user_id !== null && scope.user_id !== input.selector.user) {
      return false;
    }
    if (input.selector.agent !== undefined && scope.agent_id !== null && scope.agent_id !== input.selector.agent) {
      return false;
    }
    if (input.selector.session !== undefined && scope.session_id !== null && scope.session_id !== input.selector.session) {
      return false;
    }
    return true;
  };

  // A selector that names a dimension the principal's scopes do not bind is
  // asking for something those scopes cannot express. Rather than dropping the
  // scope (which would silently return nothing useful), the selector dimension is
  // applied to the reachable *set*: the principal reaches what it holds, filtered
  // to the requested dimensions.
  const scopes = [...candidates.values()].filter(narrow);

  const resolution =
    grantCount > 0
      ? `${memberScopes.rows.length} participating scope(s) and ${grantCount} live grant(s), narrowed by the request`
      : `${memberScopes.rows.length} participating scope(s), narrowed by the request`;

  if (scopes.length === 0) {
    denied.push(
      input.selector.project
        ? `project:${input.selector.project}`
        : input.selector.user
          ? `user:${input.selector.user}`
          : "requested scope",
    );
  }

  return { scopes, resolution, denied };
}

/**
 * Turn a request into a plan.
 *
 * Note what is absent: there is no place to put a filter that runs after
 * retrieval. `authorized_scopes` is a required field, every channel takes it,
 * and the request context is bound from it before any channel is called. A
 * planner bug is therefore a *missing result*, not a leak.
 */
export async function planQuery(
  executor: QueryExecutor,
  request: PlanRequest,
  options: { readonly entitySubjects?: readonly string[]; readonly policyVersion?: string } = {},
): Promise<QueryPlan> {
  const purposes = [request.query.purpose];
  const resolved = await resolveScopes(executor, {
    tenant_id: request.tenant_id,
    principal: request.principal,
    selector: request.query.scope,
    purposes,
    now: new Date().toISOString(),
  });

  // Only *caller-declared* subjects narrow the query. Terms mined from the query
  // text are handed to the entity channel as its search vocabulary, and are not
  // promoted into a hard `subject = ANY(...)` filter.
  //
  // Promoting them is a real bug and it was a silent one: the entity extractor
  // returns ordinary keywords like "alice" or "deployment", the claim store keys
  // subjects as `user:alice`, and the filter then excluded every row. A relevance
  // signal became an exact-match predicate, which is the same category of mistake
  // as collapsing per-channel scores into a truth score.
  const subjects = new Set<string>(request.query.subjects ?? []);

  const kinds = request.query.kinds && request.query.kinds.length > 0 ? request.query.kinds : null;
  const channels: string[] = ["lexical", "dense", "entity", "temporal"];
  // Relation traversal is bounded and only worth running when the caller has
  // narrowed to specific subjects; an unbounded traversal is a graph query by
  // another name, and the design deliberately keeps graph out of the source of
  // truth.
  if (subjects.size > 0) channels.push("relation");

  const authorizedScopes = resolved.scopes;
  return {
    policy_version: options.policyVersion ?? DEFAULT_USE_POLICY_VERSION,
    tenant_id: request.tenant_id,
    principal: request.principal,
    text: request.query.query,
    purpose: request.query.purpose,
    action_risk: request.query.action_risk ?? "low",
    time: request.query.time ?? { mode: "current" },
    kinds,
    subjects: subjects.size > 0 ? [...subjects] : null,
    /** Query-derived entity vocabulary, used by the entity channel only. */
    entity_terms: options.entitySubjects ?? [],
    limit: request.query.limit ?? 12,
    authorized_scopes: authorizedScopes,
    authorized_scope_ids: authorizedScopes.map((scope) => scope.scope_id),
    scope_resolution: resolved.resolution,
    denied_dimensions: resolved.denied,
    channels,
    authz_before_retrieval: true,
  };
}
