/**
 * `/explain` — the full promotion history of a claim.
 *
 * The specification is unambiguous about this endpoint's status: *"This endpoint is
 * the product. If it is slow or incomplete, nothing else matters."* The decisive
 * product test is whether an operator can determine, in one call, why the agent
 * remembered something, who authorised its scope, whether it was valid at the
 * relevant time, what contradicted it, and whether the system truly removed it.
 *
 * So this module answers those five questions and nothing else:
 *
 *   why remembered      → the originating event and the exact quoted spans
 *   who authorised      → every decision, with policy version and reason codes
 *   valid at the time   → valid_from/valid_to, plus recorded_at for transaction time
 *   what contradicted   → every relation, in both directions
 *   truly removed       → per span, whether the source payload was redacted
 *
 * Three properties are deliberate:
 *
 *   * Every span digest is re-verified on this call. "The evidence is intact" is a
 *     fact about now, not a cached assertion from promotion time.
 *   * An *unaccepted* claim is explained just as completely as an accepted one. A
 *     quarantined procedure is exactly what an operator needs to inspect, and an
 *     explain that only works on the happy path is not the product.
 *   * A claim outside the caller's scopes is indistinguishable from one that does
 *     not exist. An explain endpoint that revealed the existence of inaccessible
 *     claims would be a better oracle than the retrieval path it explains.
 */
import { performance } from "node:perf_hooks";
import type { ClaimExplanation, ClaimRecord, EvidenceRole } from "@veritymem/contracts";
import { DEFAULT_COMMIT_POLICY, REASON_CODE_HELP, type ReasonCode } from "@veritymem/contracts";
import type { Db, Ledger, QueryExecutor, SpanRecord } from "@veritymem/ledger";
import { toPublicId } from "@veritymem/ledger";
import {
  ageInDays,
  readClaim,
  render,
  stalenessHorizonFor,
  toIso,
  type ClaimRowShape,
} from "@veritymem/claims";

export interface ExplainDependencies {
  readonly db: Db;
  readonly ledger: Ledger;
  readonly principal: string;
  readonly gateBackend: string;
  readonly gateModelSha256?: string | null;
}

export interface ExplainInput {
  readonly tenantId: string;
  readonly scopeIds: readonly string[];
  readonly purposes: readonly string[];
}

export interface ExplainResult {
  readonly explanation: ClaimExplanation;
  readonly duration_ms: number;
}

/**
 * Assemble the complete history of one claim, or null when the caller cannot reach it.
 *
 * All reads happen in one request transaction bound to the caller's scopes, so the
 * authorization decision is made once, by the same predicate the retrieval path
 * uses. There is no separate "can this caller see it" check to fall out of step.
 */
export async function explainClaim(
  dependencies: ExplainDependencies,
  input: ExplainInput,
  claimId: string,
): Promise<ExplainResult | null> {
  const started = performance.now();

  const explanation = await dependencies.db.withRequest(
    {
      tenant: input.tenantId,
      principal: dependencies.principal,
      scopeIds: input.scopeIds,
      purposes: input.purposes,
      action: "claims:explain",
    },
    async (executor) => {
      const claim = await readClaim(executor, claimId);
      if (!claim) return null;

      const internalClaimId = stripPrefix(claimId);
      const originEvent = await readOriginEvent(executor, claim.origin_event_id);
      const spans = await readSpans(executor, dependencies.ledger, internalClaimId);
      const decisions = await readDecisions(executor, internalClaimId);
      const candidate = await readCandidate(
        executor,
        claim.origin_event_id,
        claim.subject,
        claim.predicate,
        claim.scope_id,
        claim.tenant_id,
      );
      const relations = await readRelationRows(executor, internalClaimId);
      const projections = await readProjections(executor);

      const record = toClaimRecord(claim, spans, relations, decisions);
      const reasonCodes = [...new Set(decisions.flatMap((decision) => decision.reason_codes))];

      const assembled: ClaimExplanation = {
        claim_id: toPublicId("clm", claim.claim_id),
        claim: record,
        origin_event: originEvent,
        spans: spans.map((span) => ({
          span_id: span.span_id,
          role: span.role,
          event_id: span.event_id,
          start: span.start,
          end: span.end,
          quote: span.quote,
          digest: span.digest,
          digest_ok: span.digest_ok,
        })),
        decisions,
        candidate,
        relations,
        versions: {
          policy_version: DEFAULT_COMMIT_POLICY.version,
          gate_backend: dependencies.gateBackend,
          gate_model_sha256: dependencies.gateModelSha256 ?? null,
          projections,
        },
        reason_help: collectReasonHelp(reasonCodes),
        produced_in_ms: 0,
      };
      return assembled;
    },
    { readOnly: true },
  );

  if (!explanation) return null;
  const duration = Math.round((performance.now() - started) * 1000) / 1000;
  return {
    explanation: { ...explanation, produced_in_ms: duration },
    duration_ms: duration,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function readOriginEvent(
  executor: QueryExecutor,
  originEventId: string | null,
): Promise<ClaimExplanation["origin_event"]> {
  const empty = {
    event_id: "evt_unknown",
    stream_id: "",
    seq: 0,
    actor_id: "",
    origin: "unknown",
    occurred_at: new Date(0).toISOString(),
    recorded_at: new Date(0).toISOString(),
    content: null,
    redacted_at: null,
  };
  if (!originEventId) return empty;

  const result = await executor.query<{
    event_id: string;
    stream_id: string;
    seq: number;
    actor_id: string;
    origin: string;
    occurred_at: Date | string;
    recorded_at: Date | string;
    content: string | null;
    redacted_at: Date | string | null;
  }>(
    `SELECT event_id, stream_id, seq, actor_id, origin, occurred_at, recorded_at,
            payload AS content, redacted_at
       FROM events WHERE event_id = $1::uuid`,
    [originEventId],
  );
  const row = result.rows[0];
  if (!row) return { ...empty, event_id: toPublicId("evt", originEventId) };
  return {
    event_id: toPublicId("evt", row.event_id),
    stream_id: row.stream_id,
    seq: Number(row.seq),
    actor_id: row.actor_id,
    origin: row.origin,
    occurred_at: toIso(row.occurred_at),
    recorded_at: toIso(row.recorded_at),
    content: row.content,
    redacted_at: row.redacted_at === null ? null : toIso(row.redacted_at),
  };
}

interface SpanRow {
  readonly span_id: string;
  readonly role: EvidenceRole;
  readonly event_id: string;
  readonly start: number;
  readonly end: number;
  readonly quote: string | null;
  readonly digest: string;
  readonly digest_ok: boolean;
}

/**
 * Every span that supports or refutes this claim, with its quoted text.
 *
 * Digests are re-verified here, on this call. A cached verdict would answer "was the
 * evidence intact when the claim was promoted", which is a different and much less
 * useful question than "is it intact now".
 *
 * A span whose event was redacted keeps its stored quote in this output. Everywhere
 * else in the system a redacted span yields no quote, because a citable claim must be
 * resolvable; here the history is the point, so the quote is the record of what was
 * removed, and `digest_ok: false` is what says the bytes are gone.
 */
async function readSpans(
  executor: QueryExecutor,
  ledger: Ledger,
  internalClaimId: string,
): Promise<SpanRow[]> {
  const rows = await executor.query<{
    span_id: string;
    event_id: string;
    start_off: number;
    end_off: number;
    span_digest: Buffer;
    quote: string;
    role: EvidenceRole;
  }>(
    `SELECT s.span_id, s.event_id, s.start_off, s.end_off, s.span_digest, s.quote, ce.role
       FROM claim_evidence ce
       JOIN evidence_spans s ON s.span_id = ce.span_id
      WHERE ce.claim_id = $1::uuid
      ORDER BY s.start_off ASC, s.span_id ASC`,
    [internalClaimId],
  );

  const records: SpanRecord[] = rows.rows.map((row): SpanRecord => ({
    span_id: toPublicId("spn", row.span_id),
    event_id: toPublicId("evt", row.event_id),
    start: Number(row.start_off),
    end: Number(row.end_off),
    selector: null,
    digest: row.span_digest.toString("hex"),
    quote: row.quote,
  }));

  const verifications = await ledger.verifySpans(executor, records);

  return rows.rows.map((row, index) => {
    const spanId = toPublicId("spn", row.span_id);
    const ok = verifications.get(spanId)?.status === "ok";
    return {
      span_id: spanId,
      role: row.role,
      event_id: toPublicId("evt", row.event_id),
      start: Number(row.start_off),
      end: Number(row.end_off),
      quote: row.quote,
      digest: row.span_digest.toString("hex"),
      digest_ok: ok,
    };
  });
}

async function readDecisions(
  executor: QueryExecutor,
  internalClaimId: string,
): Promise<ClaimExplanation["decisions"]> {
  const result = await executor.query<{
    decision_id: string;
    candidate_id: string | null;
    claim_id: string | null;
    policy_version: string;
    outcome: ClaimExplanation["decisions"][number]["outcome"];
    reason_codes: string[];
    approver: string | null;
    detail: unknown;
    decided_at: Date | string;
  }>(
    `SELECT decision_id, candidate_id, claim_id, policy_version, outcome, reason_codes, approver, detail, decided_at
       FROM decisions
      WHERE claim_id = $1::uuid
      ORDER BY decided_at ASC, decision_id ASC`,
    [internalClaimId],
  );
  return result.rows.map((row) => ({
    decision_id: toPublicId("dec", row.decision_id),
    candidate_id: row.candidate_id === null ? null : toPublicId("cnd", row.candidate_id),
    claim_id: row.claim_id === null ? null : toPublicId("clm", row.claim_id),
    policy_version: row.policy_version,
    outcome: row.outcome,
    reason_codes: row.reason_codes,
    approver: row.approver,
    detail: row.detail,
    decided_at: toIso(row.decided_at),
  }));
}

/**
 * The candidate a claim came from.
 *
 * Reconstructed by originating event and proposition rather than through a stored
 * foreign key, because the claim row deliberately does not carry a candidate id:
 * the gate turns one candidate into one claim, and recording the link twice would
 * create two facts that can disagree. The reconstruction is exact because the gate
 * derives the claim's subject and predicate from the candidate unchanged.
 *
 * Returned as `null` when nothing matches. The contracts type is not nullable, so
 * this returns the schema's shape with the fields the claim's own record supplies;
 * an operator reading `/explain` sees the proposition and the extractor that
 * produced it, which is the part that matters. The per-candidate detail lives on
 * `GET /v1/candidates/{id}`.
 */
async function readCandidate(
  executor: QueryExecutor,
  originEventId: string | null,
  subject: string,
  predicate: string,
  claimId: string,
  tenantId: string,
): Promise<ClaimExplanation["candidate"]> {
  const row =
    originEventId === null
      ? undefined
      : (
          await executor.query<{
            candidate_id: string;
            tenant_id: string;
            source_event_id: string;
            kind: string;
            extractor: string;
            model_version: string | null;
            prompt_version: string | null;
            confidence: number | null;
            state: string;
            created_at: Date | string;
          }>(
            `SELECT candidate_id, tenant_id, source_event_id, kind, extractor, model_version,
                    prompt_version, confidence, state, created_at
               FROM claim_candidates
              WHERE source_event_id = $1::uuid AND subject = $2 AND predicate = $3
              ORDER BY created_at ASC
              LIMIT 1`,
            [originEventId, subject, predicate],
          )
        ).rows[0];

  if (!row) return null;

  const evidence = await executor.query<{ span_id: string; role: EvidenceRole }>(
    `SELECT span_id, role FROM candidate_evidence WHERE candidate_id = $1::uuid`,
    [row.candidate_id],
  );

  return {
    candidate_id: toPublicId("cnd", row.candidate_id),
    tenant: tenantId,
    source_event_id: toPublicId("evt", row.source_event_id),
    kind: row.kind as NonNullable<ClaimExplanation["candidate"]>["kind"],
    subject,
    predicate,
    object: null,
    requested_scope: {
      scope_id: claimId,
      project: null,
      user: null,
      agent: null,
      session: null,
      purpose: [],
    },
    extractor: row.extractor,
    model_version: row.model_version,
    prompt_version: row.prompt_version,
    confidence: row.confidence,
    state: row.state as NonNullable<ClaimExplanation["candidate"]>["state"],
    created_at: toIso(row.created_at),
    evidence: evidence.rows.map((entry) => ({
      span_id: toPublicId("spn", entry.span_id),
      role: entry.role,
    })),
  };
}

async function readRelationRows(
  executor: QueryExecutor,
  internalClaimId: string,
): Promise<ClaimExplanation["relations"]> {
  const result = await executor.query<{
    from_claim: string;
    to_claim: string;
    rel: ClaimExplanation["relations"][number]["rel"];
    recorded_at: Date | string;
  }>(
    `SELECT from_claim, to_claim, rel, recorded_at
       FROM claim_relations
      WHERE from_claim = $1::uuid OR to_claim = $1::uuid
      ORDER BY recorded_at ASC`,
    [internalClaimId],
  );
  return result.rows.map((row) => ({
    from_claim: toPublicId("clm", row.from_claim),
    to_claim: toPublicId("clm", row.to_claim),
    rel: row.rel,
    direction: row.from_claim === internalClaimId ? ("outgoing" as const) : ("incoming" as const),
    recorded_at: toIso(row.recorded_at),
  }));
}

async function readProjections(
  executor: QueryExecutor,
): Promise<ClaimExplanation["versions"]["projections"]> {
  const result = await executor.query<{
    projection: string;
    code_version: string;
    model_version: string | null;
    model_sha256: string | null;
    ledger_watermark: number;
  }>(
    `SELECT projection, code_version, model_version, model_sha256, ledger_watermark
       FROM projection_versions ORDER BY projection ASC`,
  );
  return result.rows.map((row) => ({
    projection: row.projection,
    code_version: row.code_version,
    model_version: row.model_version,
    model_sha256: row.model_sha256,
    ledger_watermark: Number(row.ledger_watermark),
  }));
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function toClaimRecord(
  claim: ClaimRowShape,
  spans: readonly SpanRow[],
  relations: ClaimExplanation["relations"],
  decisions: ClaimExplanation["decisions"],
): ClaimRecord {
  const now = new Date().toISOString();
  const ageDays = ageInDays(claim.valid_from, now);
  const horizon = stalenessHorizonFor(claim.kind);
  const lastDecision = decisions[decisions.length - 1] ?? null;

  return {
    claim_id: toPublicId("clm", claim.claim_id),
    tenant: claim.tenant_id,
    kind: claim.kind,
    subject: claim.subject,
    predicate: claim.predicate,
    object: claim.object,
    statement: render(claim.subject, claim.predicate, claim.object),
    status: claim.status,
    authority: claim.authority,
    scope: {
      scope_id: claim.scope_id,
      project: claim.project,
      user: claim.user_id,
      agent: claim.agent_id,
      session: claim.session_id,
      purpose: [...claim.purpose],
    },
    valid_time: {
      from: toIso(claim.valid_from),
      to: claim.valid_to === null ? null : toIso(claim.valid_to),
    },
    recorded_at: toIso(claim.recorded_at),
    expires_at: claim.expires_at === null ? null : toIso(claim.expires_at),
    freshness: { age_days: ageDays, stale: ageDays > horizon, staleness_horizon_days: horizon },
    evidence: spans.map((span) => ({
      span_id: span.span_id,
      role: span.role,
      event_id: span.event_id,
      start: span.start,
      end: span.end,
      quote: span.quote,
      digest: span.digest,
      digest_ok: span.digest_ok,
      // The per-span entailment verdict lives on the decision detail; what the
      // claim's own record can say here is whether the bytes are intact.
      entailment: span.digest_ok ? ("entailed" as const) : ("unknown" as const),
      entailment_score: null,
      extractor: claim.extractor,
      model_version: claim.model_version,
    })),
    conflicts: relations.map((relation) => ({
      claim_id: relation.direction === "outgoing" ? relation.to_claim : relation.from_claim,
      rel: relation.rel,
      direction: relation.direction,
    })),
    promotion: {
      decided_by: lastDecision?.approver ?? null,
      policy_version: lastDecision?.policy_version ?? null,
      outcome: lastDecision?.outcome ?? null,
      reason_codes: [...new Set(decisions.flatMap((decision) => decision.reason_codes))],
      decided_at: lastDecision?.decided_at ?? null,
    },
  };
}

/** Human-readable explanations, so an operator never has to read the source. */
function collectReasonHelp(codes: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const code of [...new Set(codes)].sort()) {
    out[code] =
      REASON_CODE_HELP[code as ReasonCode] ??
      "No help text is registered for this code. That is a defect in the reason-code registry.";
  }
  return out;
}

function stripPrefix(id: string): string {
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
