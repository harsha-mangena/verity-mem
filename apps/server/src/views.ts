/**
 * Row → contract projections.
 *
 * Hydration lives in one module because every route that returns a claim must
 * hydrate it the *same* way: the six dimensions the specification keeps separate —
 * extractor, entailment, authority, freshness, conflict state, use decision — are
 * read from different tables, and a route that assembled them slightly differently
 * would be a second, quietly divergent definition of a claim.
 *
 * The one rule these functions enforce: per-span digests are re-verified on every
 * read. `readClaimEvidence` calls `ledger.verifySpans`, which recomputes the hash of
 * the payload slice rather than trusting `evidence_spans.span_digest`. A cached
 * verification is exactly the silent drift the design exists to prevent, so a claim
 * whose evidence no longer hashes to what it recorded is returned with
 * `digest_ok: false` and a null quote rather than with its old quote attached.
 */
import type {
  ClaimEvidenceRef,
  ClaimRecord,
  EntailmentResult,
  PacketEvidence,
} from "@veritymem/contracts";
import { ageInDays, render, stalenessHorizonFor, toIso, type ClaimRelation, type ClaimRowShape } from "@veritymem/claims";
import { toPublicId, type Ledger, type QueryExecutor, type SpanRecord } from "@veritymem/ledger";

/** A joined evidence row, as the three read paths select it. */
export interface EvidenceJoinRow {
  readonly claim_id: string;
  readonly span_id: string;
  readonly event_id: string;
  readonly start_off: number;
  readonly end_off: number;
  readonly span_digest: Buffer | string;
  readonly role: "supports" | "refutes";
  readonly [column: string]: unknown;
}

export interface HydratedEvidence {
  readonly refs: readonly ClaimEvidenceRef[];
  readonly digestOk: boolean;
}

const EVIDENCE_SELECT = `
  SELECT ce.claim_id, s.span_id, s.event_id, s.start_off, s.end_off, s.span_digest,
         ce.role, c.extractor AS claim_extractor, c.model_version AS claim_model_version,
         d.detail AS decision_detail
    FROM claim_evidence ce
    JOIN evidence_spans s ON s.span_id = ce.span_id
    JOIN claims c ON c.claim_id = ce.claim_id
    LEFT JOIN LATERAL (
      SELECT detail FROM decisions
       WHERE claim_id = ce.claim_id
       ORDER BY decided_at ASC
       LIMIT 1
    ) d ON TRUE
   WHERE ce.claim_id = ANY($1::uuid[])
   ORDER BY s.start_off ASC
`;

/**
 * Load and verify the evidence for a set of claims.
 *
 * The decision detail is joined because the per-span entailment verdict is recorded
 * there by the gate — `decisions.detail` carries the aggregate and each span's
 * verdict — and the evidence tables themselves carry no entailment column. Leaving
 * it out would make `entailment` on every returned span `unknown`, which is a false
 * statement about what the gate established at promotion time.
 */
export async function readClaimEvidence(
  ledger: Ledger,
  executor: QueryExecutor,
  claimIds: readonly string[],
): Promise<Map<string, HydratedEvidence>> {
  const out = new Map<string, HydratedEvidence>();
  if (claimIds.length === 0) return out;

  const rows = await executor.query<EvidenceJoinRow>(EVIDENCE_SELECT, [
    claimIds.map(stripPrefix),
  ]);

  const spanRecords: SpanRecord[] = rows.rows.map((row) => ({
    span_id: toPublicId("spn", row.span_id),
    event_id: toPublicId("evt", row.event_id),
    start: Number(row.start_off),
    end: Number(row.end_off),
    selector: null,
    digest: digestHex(row.span_digest),
    quote: "",
  }));
  const verifications = await ledger.verifySpans(executor, spanRecords);

  for (const row of rows.rows) {
    const claimId = toPublicId("clm", row.claim_id);
    const spanId = toPublicId("spn", row.span_id);
    const verification = verifications.get(spanId);
    const digestOk = verification?.status === "ok";
    const perSpan = entailmentFromDecision(row.decision_detail, spanId);

    const list = out.get(claimId) ?? { refs: [], digestOk: true };
    const refs: ClaimEvidenceRef[] = [...list.refs];
    refs.push({
      span_id: spanId,
      role: row.role,
      event_id: toPublicId("evt", row.event_id),
      start: Number(row.start_off),
      end: Number(row.end_off),
      quote: verification && verification.status === "ok" ? verification.quote : null,
      digest: digestHex(row.span_digest),
      digest_ok: digestOk,
      entailment: perSpan.entailment,
      entailment_score: perSpan.score,
      extractor: (row["claim_extractor"] as string | null) ?? null,
      model_version: (row["claim_model_version"] as string | null) ?? null,
    });
    out.set(claimId, { refs, digestOk: list.digestOk && digestOk });
  }
  return out;
}

/**
 * Pull one span's entailment verdict out of the decision detail.
 *
 * Returns `unknown` rather than a default of `entailed` when the detail is absent
 * or shaped differently: a missing verdict means the check did not run, and
 * "did not run" is never permission.
 */
function entailmentFromDecision(
  detail: unknown,
  spanId: string,
): { entailment: EntailmentResult; score: number | null } {
  if (detail === null || typeof detail !== "object") return { entailment: "unknown", score: null };
  const evidence = (detail as { evidence?: unknown }).evidence;
  if (!Array.isArray(evidence)) return { entailment: "unknown", score: null };
  for (const entry of evidence) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as { span_id?: unknown; entailment?: unknown; entailment_score?: unknown };
    if (record.span_id !== spanId) continue;
    const result = typeof record.entailment === "string" ? (record.entailment as EntailmentResult) : "unknown";
    const score = typeof record.entailment_score === "number" ? record.entailment_score : null;
    return { entailment: result, score };
  }
  return { entailment: "unknown", score: null };
}

/** The promotion that decided a claim's status, as `ClaimRecord.promotion`. */
export interface PromotionRow {
  readonly outcome: string;
  readonly policy_version: string;
  readonly reason_codes: string[];
  readonly approver: string | null;
  readonly decided_at: Date | string;
}

export async function readPromotions(
  executor: QueryExecutor,
  claimIds: readonly string[],
): Promise<Map<string, PromotionRow>> {
  const out = new Map<string, PromotionRow>();
  if (claimIds.length === 0) return out;
  // Oldest first so the *first* decision for a claim is the promotion that created
  // it; a later revocation must not be reported as the reason it exists.
  const rows = await executor.query<PromotionRow & { claim_id: string }>(
    `SELECT claim_id, outcome, policy_version, reason_codes, approver, decided_at
       FROM decisions
      WHERE claim_id = ANY($1::uuid[])
      ORDER BY decided_at ASC`,
    [claimIds.map(stripPrefix)],
  );
  for (const row of rows.rows) {
    const claimId = toPublicId("clm", row.claim_id);
    if (!out.has(claimId)) out.set(claimId, row);
  }
  return out;
}

/**
 * Build a `ClaimRecord`.
 *
 * There is no `use` field, and that absence is the design: a use decision belongs to
 * a *query*, with its own action risk and purpose, and a claim fetched by id has no
 * query to be judged against. Inventing one here would be the single-confidence-
 * number mistake in a different costume — a verdict with no question behind it. The
 * record therefore carries the six separate dimensions and the promotion that
 * created it, and the verdict stays in the packet.
 */
export function toClaimRecord(input: {
  readonly claim: ClaimRowShape;
  readonly evidence: HydratedEvidence | undefined;
  readonly relations: readonly ClaimRelation[];
  readonly promotion: PromotionRow | undefined;
  readonly now: string;
}): ClaimRecord {
  const claim = input.claim;
  const evidence = input.evidence?.refs ?? [];
  const validFrom = toIso(claim.valid_from);
  const age = ageInDays(validFrom, input.now);
  const horizon = stalenessHorizonFor(claim.kind);

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
      scope_id: formatUuid(claim.scope_id),
      project: claim.project,
      user: claim.user_id,
      agent: claim.agent_id,
      session: claim.session_id,
      purpose: [...claim.purpose],
    },
    valid_time: {
      from: validFrom,
      to: claim.valid_to === null ? null : toIso(claim.valid_to),
    },
    recorded_at: toIso(claim.recorded_at),
    expires_at: claim.expires_at === null ? null : toIso(claim.expires_at),
    freshness: { age_days: age, stale: age > horizon, staleness_horizon_days: horizon },
    evidence: [...evidence],
    conflicts: input.relations.map((relation) => ({
      claim_id: relation.direction === "outgoing" ? relation.to_claim : relation.from_claim,
      rel: relation.rel,
      direction: relation.direction,
      ...(relation.other_statement !== undefined ? { statement: relation.other_statement } : {}),
      ...(relation.other_status !== undefined ? { status: relation.other_status } : {}),
    })),
    promotion: {
      decided_by: input.promotion?.approver ?? null,
      policy_version: input.promotion?.policy_version ?? null,
      outcome: (input.promotion?.outcome ?? null) as ClaimRecord["promotion"]["outcome"],
      reason_codes: input.promotion ? [...input.promotion.reason_codes] : [],
      decided_at: input.promotion ? toIso(input.promotion.decided_at) : null,
    },
  };
}

/**
 * The packet-shaped evidence list, used by `POST /v1/context/compose`.
 *
 * Built from the same verified rows as `ClaimRecord`, never re-read: two reads of
 * the same evidence in one request could disagree if a payload were redacted
 * between them, and the prose would then cite a quote the packet did not contain.
 */
export function toPacketEvidence(evidence: HydratedEvidence | undefined): PacketEvidence[] {
  return (evidence?.refs ?? []).map((ref) => ({
    event_id: ref.event_id,
    span_id: ref.span_id,
    start: ref.start,
    end: ref.end,
    quote: ref.quote,
    digest: ref.digest,
    digest_ok: ref.digest_ok,
    entailment: ref.entailment,
    entailment_score: ref.entailment_score,
  }));
}

export function digestHex(value: Buffer | string): string {
  return typeof value === "string" ? value : value.toString("hex");
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

export function formatUuid(value: string | Buffer): string {
  const hex = typeof value === "string" ? value.replace(/-/g, "") : value.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}
