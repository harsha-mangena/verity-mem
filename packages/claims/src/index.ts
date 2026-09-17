/**
 * Claim reads and the bi-temporal query surface.
 *
 * Three time modes, all served from the same columns:
 *
 *   current      valid_to IS NULL AND status = 'accepted'
 *   as_of: T     what the system *believed* at T — recorded_at <= T and the
 *                validity interval still open at T
 *   during       every claim whose validity interval overlaps the window,
 *                including superseded ones, so an operator sees the belief
 *                history rather than only the winner
 *
 * `as_of` is the one that is easy to get wrong. It is transaction time
 * (`recorded_at`), not valid time: "what did the system believe on the 3rd" is a
 * question about the system, and answering it with valid-time columns produces a
 * plausible and wrong answer.
 */
import type {
  AuthorityClass,
  ClaimKind,
  ClaimRecord,
  ClaimStatus,
  EntailmentResult,
  RelationKind,
  TimeSpec,
  UseDecision,
} from "@veritymem/contracts";
import {
  DEFAULT_USE_POLICY_VERSION,
  REASON_CODES,
  stalenessHorizonFor,
} from "@veritymem/contracts";
import { canonicalize, type Ledger, type QueryExecutor } from "@veritymem/ledger";
import { toPublicId } from "@veritymem/ledger";

export interface ClaimRowShape {
  readonly claim_id: string;
  readonly tenant_id: string;
  readonly scope_id: string;
  readonly kind: ClaimKind;
  readonly subject: string;
  readonly predicate: string;
  readonly object: unknown;
  readonly status: ClaimStatus;
  readonly authority: AuthorityClass;
  readonly valid_from: Date | string;
  readonly valid_to: Date | string | null;
  readonly recorded_at: Date | string;
  readonly expires_at: Date | string | null;
  readonly origin_event_id: string | null;
  readonly extractor: string | null;
  readonly model_version: string | null;
  readonly prompt_version: string | null;
  readonly project: string | null;
  readonly user_id: string | null;
  readonly agent_id: string | null;
  readonly session_id: string | null;
  readonly purpose: string[];
  /** Query-result rows are addressed by column name; this keeps the shape usable
   *  as a `pg` row type without widening every field to `unknown`. */
  readonly [column: string]: unknown;
}

export const CLAIM_SELECT = `
  SELECT c.claim_id, c.tenant_id, c.scope_id, c.kind, c.subject, c.predicate, c.object,
         c.status, c.authority, c.valid_from, c.valid_to, c.recorded_at, c.expires_at,
         c.origin_event_id, c.extractor, c.model_version, c.prompt_version,
         s.project, s.user_id, s.agent_id, s.session_id, s.purpose
    FROM claims c
    JOIN scopes s ON s.scope_id = c.scope_id
`;

export interface ClaimListFilters {
  readonly tenantId: string;
  readonly scopeIds: readonly string[];
  readonly time?: TimeSpec;
  readonly kinds?: readonly ClaimKind[];
  readonly statuses?: readonly ClaimStatus[];
  readonly subjects?: readonly string[];
  readonly predicates?: readonly string[];
  readonly claimIds?: readonly string[];
  readonly limit?: number;
  readonly now?: string;
}

/** Build the time predicate for a mode. Exported so retrieval and /explain agree. */
export function timePredicate(
  time: TimeSpec | undefined,
  alias: string,
  now: string,
): { sql: string; params: unknown[] } {
  const mode = time?.mode ?? "current";
  switch (mode) {
    case "current":
      return { sql: `${alias}.valid_to IS NULL AND ${alias}.status = 'accepted'`, params: [] };
    case "as_of":
      // Transaction time: what the system had recorded by T, and what it still
      // considered open at T.
      return {
        sql: `${alias}.recorded_at <= $NOW$::timestamptz
              AND (${alias}.valid_to IS NULL OR ${alias}.valid_to > $NOW$::timestamptz)
              AND ${alias}.status IN ('accepted','superseded','expired')`,
        params: [],
      };
    case "during":
      return {
        sql: `${alias}.valid_range && tstzrange($FROM$::timestamptz, $TO$::timestamptz, '[)')`,
        params: [],
      };
    default: {
      const exhaustive: never = mode;
      throw new Error(`unhandled time mode: ${String(exhaustive)}`);
    }
  }
}

/** Substitute named placeholders, which keeps positional numbering readable. */
function hydrate(sql: string, values: Record<string, unknown>): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const text = sql.replace(/\$([A-Z_]+)\$/g, (_match, name: string) => {
    if (!(name in values)) throw new Error(`unbound placeholder $${name}$`);
    params.push(values[name]);
    return `$${params.length}`;
  });
  return { text, params };
}

export async function listClaims(
  executor: QueryExecutor,
  filters: ClaimListFilters,
): Promise<ClaimRowShape[]> {
  const now = filters.now ?? new Date().toISOString();
  const time = timePredicate(filters.time, "c", now);
  const clauses: string[] = [
    "c.tenant_id = $TENANT$::uuid",
    "c.scope_id = ANY($SCOPES$::uuid[])",
    time.sql,
  ];
  const values: Record<string, unknown> = {
    TENANT: filters.tenantId,
    SCOPES: filters.scopeIds.length > 0 ? filters.scopeIds : ["00000000-0000-0000-0000-000000000000"],
    NOW: now,
    FROM: filters.time?.mode === "during" ? filters.time.from : now,
    TO: filters.time?.mode === "during" ? filters.time.to : now,
  };

  if (filters.time?.mode === "as_of") values["NOW"] = filters.time.as_of;
  if (filters.time?.mode === "during") {
    values["FROM"] = filters.time.from;
    values["TO"] = filters.time.to;
  }

  if (filters.kinds && filters.kinds.length > 0) {
    clauses.push("c.kind = ANY($KINDS$::claim_kind[])");
    values["KINDS"] = filters.kinds;
  }
  if (filters.statuses && filters.statuses.length > 0) {
    clauses.push("c.status = ANY($STATUSES$::claim_status[])");
    values["STATUSES"] = filters.statuses;
  }
  if (filters.subjects && filters.subjects.length > 0) {
    clauses.push("c.subject = ANY($SUBJECTS$::text[])");
    values["SUBJECTS"] = filters.subjects;
  }
  if (filters.predicates && filters.predicates.length > 0) {
    clauses.push("c.predicate = ANY($PREDICATES$::text[])");
    values["PREDICATES"] = filters.predicates;
  }
  if (filters.claimIds && filters.claimIds.length > 0) {
    clauses.push("c.claim_id = ANY($CLAIMIDS$::uuid[])");
    values["CLAIMIDS"] = filters.claimIds.map(stripPrefix);
  }

  values["LIMIT"] = filters.limit ?? 100;
  const query = hydrate(
    `${CLAIM_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY c.valid_from DESC, c.claim_id ASC LIMIT $LIMIT$`,
    values,
  );
  const result = await executor.query<ClaimRowShape>(query.text, query.params);
  return result.rows;
}

export async function readClaim(
  executor: QueryExecutor,
  claimId: string,
): Promise<ClaimRowShape | null> {
  const result = await executor.query<ClaimRowShape>(`${CLAIM_SELECT} WHERE c.claim_id = $1::uuid`, [
    stripPrefix(claimId),
  ]);
  return result.rows[0] ?? null;
}

export async function readClaims(
  executor: QueryExecutor,
  claimIds: readonly string[],
): Promise<Map<string, ClaimRowShape>> {
  if (claimIds.length === 0) return new Map();
  const result = await executor.query<ClaimRowShape>(
    `${CLAIM_SELECT} WHERE c.claim_id = ANY($1::uuid[])`,
    [claimIds.map(stripPrefix)],
  );
  const out = new Map<string, ClaimRowShape>();
  for (const row of result.rows) out.set(toPublicId("clm", row.claim_id), row);
  return out;
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export interface ClaimRelation {
  readonly from_claim: string;
  readonly to_claim: string;
  readonly rel: RelationKind;
  readonly direction: "outgoing" | "incoming";
  readonly recorded_at: string;
  readonly other_statement?: string;
  readonly other_status?: ClaimStatus;
}

export async function readRelations(
  executor: QueryExecutor,
  claimIds: readonly string[],
): Promise<Map<string, ClaimRelation[]>> {
  const out = new Map<string, ClaimRelation[]>();
  if (claimIds.length === 0) return out;
  const internal = claimIds.map(stripPrefix);

  const result = await executor.query<{
    from_claim: string;
    to_claim: string;
    rel: RelationKind;
    recorded_at: Date | string;
    from_status: ClaimStatus;
    to_status: ClaimStatus;
    from_statement_subject: string;
    from_statement_predicate: string;
    from_statement_object: unknown;
    to_statement_subject: string;
    to_statement_predicate: string;
    to_statement_object: unknown;
  }>(
    `SELECT r.from_claim, r.to_claim, r.rel, r.recorded_at,
            fc.status AS from_status, tc.status AS to_status,
            fc.subject AS from_statement_subject, fc.predicate AS from_statement_predicate,
            fc.object AS from_statement_object,
            tc.subject AS to_statement_subject, tc.predicate AS to_statement_predicate,
            tc.object AS to_statement_object
       FROM claim_relations r
       JOIN claims fc ON fc.claim_id = r.from_claim
       JOIN claims tc ON tc.claim_id = r.to_claim
      WHERE r.from_claim = ANY($1::uuid[]) OR r.to_claim = ANY($1::uuid[])`,
    [internal],
  );

  for (const row of result.rows) {
    const fromId = toPublicId("clm", row.from_claim);
    const toId = toPublicId("clm", row.to_claim);
    const recordedAt = toIso(row.recorded_at);

    if (internal.includes(row.from_claim)) {
      const list = out.get(fromId) ?? [];
      list.push({
        from_claim: fromId,
        to_claim: toId,
        rel: row.rel,
        direction: "outgoing",
        recorded_at: recordedAt,
        other_statement: render(row.to_statement_subject, row.to_statement_predicate, row.to_statement_object),
        other_status: row.to_status,
      });
      out.set(fromId, list);
    }
    if (internal.includes(row.to_claim)) {
      const list = out.get(toId) ?? [];
      list.push({
        from_claim: fromId,
        to_claim: toId,
        rel: row.rel,
        direction: "incoming",
        recorded_at: recordedAt,
        other_statement: render(row.from_statement_subject, row.from_statement_predicate, row.from_statement_object),
        other_status: row.from_status,
      });
      out.set(toId, list);
    }
  }
  return out;
}

export async function createRelation(
  executor: QueryExecutor,
  fromClaimId: string,
  toClaimId: string,
  rel: RelationKind,
): Promise<void> {
  await executor.query(
    `INSERT INTO claim_relations (from_claim, to_claim, rel)
     VALUES ($1::uuid, $2::uuid, $3::relation_kind)
     ON CONFLICT (from_claim, to_claim, rel) DO NOTHING`,
    [stripPrefix(fromClaimId), stripPrefix(toClaimId), rel],
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface StatusChange {
  readonly claimId: string;
  readonly status: ClaimStatus;
  readonly validTo?: string | null;
  readonly reasonCodes: readonly string[];
}

/**
 * Apply a status transition.
 *
 * The database enforces the lifecycle: `veritymem.enforce_claim_transition`
 * rejects an illegal edge, so this function does not have to be the only guard
 * against one. It exists to record the decision that accompanied the transition.
 */
export async function applyStatus(
  executor: QueryExecutor,
  change: StatusChange,
): Promise<void> {
  await executor.query(
    `UPDATE claims
        SET status = $2::claim_status,
            valid_to = CASE
              WHEN $3::timestamptz IS NOT NULL THEN $3::timestamptz
              WHEN $2::claim_status IN ('superseded','revoked','expired') AND valid_to IS NULL THEN now()
              ELSE valid_to
            END
      WHERE claim_id = $1::uuid`,
    [stripPrefix(change.claimId), change.status, change.validTo ?? null],
  );
}

// ---------------------------------------------------------------------------
// Use policy
// ---------------------------------------------------------------------------

export interface UseVerdict {
  readonly use: UseDecision;
  readonly reason_codes: readonly string[];
  readonly staleness_horizon_days: number;
  readonly age_days: number;
}

export interface UseEvaluationInput {
  readonly status: ClaimStatus;
  readonly kind: ClaimKind;
  readonly authority: AuthorityClass;
  readonly valid_to: string | null;
  readonly expires_at: string | null;
  readonly has_conflicts: boolean;
  readonly digest_ok: boolean;
  readonly span_count: number;
  readonly age_days: number;
  readonly action_risk: "low" | "medium" | "high";
  readonly query_purpose_matches: boolean;
  readonly now: string;
}

/**
 * Assign `use`, `verify`, `clarify` or `deny` to a claim.
 *
 * This is a policy evaluation, not a confidence score, and the four outcomes are
 * ordered by consequence rather than by likelihood. `verify` means "a human or a
 * second source should confirm this before it changes behaviour"; it is
 * explicitly not "probably true".
 */
export function evaluateUse(input: UseEvaluationInput): UseVerdict {
  const horizon = stalenessHorizonFor(input.kind);
  const codes: string[] = [];
  const base = { staleness_horizon_days: horizon, age_days: input.age_days };

  if (input.status === "revoked") {
    return { use: "deny", reason_codes: [REASON_CODES.USE_REVOKED], ...base };
  }
  if (input.status !== "accepted" && input.status !== "disputed") {
    return { use: "deny", reason_codes: [REASON_CODES.USE_REVOKED], ...base };
  }
  if (input.span_count === 0 || !input.digest_ok) {
    // A claim whose evidence no longer resolves cannot be cited, and a claim
    // that cannot be cited is not usable at any risk level.
    return { use: "deny", reason_codes: [REASON_CODES.SPAN_UNRESOLVABLE], ...base };
  }
  if (input.expires_at !== null && input.expires_at <= input.now) {
    return { use: "deny", reason_codes: [REASON_CODES.USE_EXPIRED], ...base };
  }
  if (!input.query_purpose_matches) {
    return { use: "deny", reason_codes: [REASON_CODES.USE_SENSITIVE_PURPOSE_MISMATCH], ...base };
  }
  if (input.status === "disputed" || input.has_conflicts) {
    // A contradiction at high action risk is a denial rather than a caution: an
    // unattended agent will treat "verify" as "proceed".
    return {
      use: input.action_risk === "high" ? "deny" : "clarify",
      reason_codes: [REASON_CODES.USE_CONFLICTED],
      ...base,
    };
  }

  const weakAuthority = input.authority === "inference" || input.authority === "hearsay";
  const stale = input.age_days > horizon;

  if (weakAuthority) codes.push(REASON_CODES.USE_WEAK_AUTHORITY);
  if (stale) codes.push(REASON_CODES.USE_STALE);

  if (weakAuthority || stale) {
    // A highly relevant guess stays a guess: `use` is reserved for claims that
    // are both well-evidenced and current.
    return {
      use: input.action_risk === "high" ? "deny" : "verify",
      reason_codes: codes,
      ...base,
    };
  }

  if (input.action_risk === "high" && input.authority !== "verified_record") {
    return {
      use: "verify",
      reason_codes: [REASON_CODES.USE_ENTAILED_UNVERIFIED],
      ...base,
    };
  }

  return { use: "use", reason_codes: [REASON_CODES.USE_FRESH_AUTHORITATIVE], ...base };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function render(subject: string, predicate: string, object: unknown): string {
  let rendered: string;
  if (object === null || object === undefined) rendered = "";
  else if (typeof object === "string") rendered = object;
  else if (typeof object === "number" || typeof object === "boolean") rendered = String(object);
  else rendered = canonicalize(object);
  return `${subject} ${predicate} ${rendered}`.replace(/\s+/g, " ").trim();
}

export function ageInDays(from: string | Date, now: string): number {
  const start = from instanceof Date ? from.getTime() : new Date(from).getTime();
  const end = new Date(now).getTime();
  return Math.max(0, Math.round(((end - start) / 86_400_000) * 100) / 100);
}

export function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function stripPrefix(id: string): string {
  const underscore = id.indexOf("_");
  const body = underscore >= 0 ? id.slice(underscore + 1) : id;
  if (body.includes("-")) return body;
  if (body.length !== 32) return body;
  return [
    body.slice(0, 8),
    body.slice(8, 12),
    body.slice(12, 16),
    body.slice(16, 20),
    body.slice(20, 32),
  ].join("-");
}

export { DEFAULT_USE_POLICY_VERSION };
export type { EntailmentResult, ClaimRecord };
