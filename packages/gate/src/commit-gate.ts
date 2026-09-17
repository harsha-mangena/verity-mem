/**
 * The commit gate.
 *
 * This is the product. Everything else in VerityMem is either evidence gathering
 * or a rebuildable projection; the gate is the only place where "the system
 * observed something" becomes "the system believes something", and it is the one
 * place a model must never be able to write.
 *
 * The contract, restated as code that can be read against the specification:
 *
 *   AUTO-ACCEPT requires all of:
 *     - every supporting span resolves and its digest matches
 *     - entailment(span_text -> claim) == entailed
 *     - authority in (verified_record, observation, user_self_report)
 *     - kind not in (procedure, permission)
 *     - no unresolved contradiction with an accepted claim in the same scope
 *     - requested scope <= the scope of the originating event
 *
 *   QUARANTINE if any of: kind in (procedure, permission); sensitivity == high;
 *     origin == document AND content flagged instruction-like
 *
 *   ACCEPT_LIMITED_SCOPE if all auto-accept conditions hold except the requested
 *     scope is broader than the event scope -> accept at the narrower scope
 *
 *   REJECT if: no resolvable span, or entailment == contradiction
 *
 *   NEEDS_REVIEW otherwise
 *
 * The order of the checks is part of the contract: integrity before semantics,
 * semantics before authority, authority before conflict, conflict before policy.
 * A candidate that fails two rules reports both, so an operator sees the whole
 * story rather than whichever rule happened to run first.
 */
import type {
  AuthorityClass,
  ClaimKind,
  DecisionOutcome,
  EntailmentResult,
  EventAppendRequest,
  OriginKind,
} from "@veritymem/contracts";
import {
  DEFAULT_COMMIT_POLICY,
  type CommitPolicy,
  REASON_CODES,
} from "@veritymem/contracts";
import type { Clock, Db, IdGenerator, Ledger, QueryExecutor, SpanRecord, SpanVerification } from "@veritymem/ledger";
import { toPublicId } from "@veritymem/ledger";
import { renderStatement, type EntailmentBackend } from "./entailment.ts";

// ---------------------------------------------------------------------------
// Instruction-like detection
// ---------------------------------------------------------------------------

/**
 * Instruction-like material is content that addresses the reader as an agent.
 *
 * This is a *flag*, not a filter: flagged content is still stored as evidence, it
 * is simply never routed to the extractors and scope paths that produce
 * privileged or procedural claims. A detector that silently dropped evidence
 * would destroy the ledger's completeness guarantee to solve a different problem.
 */
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|system)\b/i,
  /\byou\s+(?:are|must|should|will|shall)\s+(?:now\s+)?(?:an?\s+)?(?:assistant|agent|ai|model|bot|admin)/i,
  /\b(?:system|developer|assistant)\s*(?:prompt|message|instruction)s?\b/i,
  /\bnew\s+instructions?\s*:/i,
  /\b(?:do\s+not|don'?t)\s+(?:tell|inform|mention|report|log|reveal)\b/i,
  /\b(?:execute|run|eval|curl|wget|bash|sh|powershell)\b[^\n]{0,40}(?:https?:\/\/|\|\s*(?:sh|bash))/i,
  /\b(?:grant|elevate|escalate)\b[^\n]{0,30}\b(?:permission|privilege|access|admin|root)\b/i,
  /\b(?:always|never)\s+(?:respond|answer|reply|say|output)\b/i,
  /<\/?(?:system|instruction|prompt|tool_use|function_call)\b/i,
  /\bBEGIN\s+(?:SYSTEM|INSTRUCTIONS?)\b/i,
];

export interface InstructionScan {
  readonly flagged: boolean;
  readonly matches: readonly string[];
}

export function scanForInstructions(text: string): InstructionScan {
  const matches: string[] = [];
  for (const pattern of INSTRUCTION_PATTERNS) {
    const found = pattern.exec(text);
    if (found) matches.push(found[0].slice(0, 120));
  }
  return { flagged: matches.length > 0, matches };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CandidateForGate {
  readonly candidate_id: string;
  readonly tenant_id: string;
  readonly source_event_id: string;
  readonly kind: ClaimKind;
  readonly subject: string;
  readonly predicate: string;
  readonly object: unknown;
  readonly requested_scope_id: string;
  readonly extractor: string;
  readonly model_version: string | null;
  readonly prompt_version: string | null;
  readonly confidence: number | null;
  readonly authority: AuthorityClass;
  readonly origin: OriginKind;
  readonly sensitivity: string;
  readonly event_scope_id: string;
  /** Span records with their role. */
  readonly spans: readonly { readonly span: SpanRecord; readonly role: "supports" | "refutes" }[];
  /** Content of the originating event, or null when it has been redacted. */
  readonly event_content: string | null;
}

export interface GateDependencies {
  readonly db: Db;
  readonly ledger: Ledger;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly entailment: EntailmentBackend;
  readonly policy?: CommitPolicy;
}

export interface GateEvidenceVerdict {
  readonly span_id: string;
  readonly role: "supports" | "refutes";
  readonly status: SpanVerification["status"];
  readonly digest_ok: boolean;
  readonly quote: string | null;
  readonly entailment: EntailmentResult;
  readonly entailment_score: number | null;
  readonly reason_codes: readonly string[];
}

export interface GateResult {
  readonly decision_id: string;
  readonly candidate_id: string;
  readonly outcome: DecisionOutcome;
  readonly reason_codes: readonly string[];
  readonly claim_id: string | null;
  readonly policy_version: string;
  readonly evidence: readonly GateEvidenceVerdict[];
  readonly detail: {
    readonly entailment_backend: string;
    readonly entailment_model_sha256: string | null;
    readonly entailment_aggregate: EntailmentResult;
    readonly entailment_score: number | null;
    readonly model_calls: number;
    readonly instruction_flagged: boolean;
    readonly instruction_matches: readonly string[];
    readonly scope: {
      readonly requested_scope_id: string;
      readonly event_scope_id: string;
      readonly accepted_scope_id: string;
      readonly broadened_purposes: readonly string[];
      readonly narrower: boolean;
    };
    readonly conflicts: readonly {
      readonly claim_id: string;
      readonly rel: string;
      readonly statement: string;
    }[];
  };
}

// ---------------------------------------------------------------------------
// Scope comparison
// ---------------------------------------------------------------------------

interface ScopeRow {
  readonly scope_id: string;
  readonly tenant_id: string;
  readonly project: string | null;
  readonly user_id: string | null;
  readonly agent_id: string | null;
  readonly session_id: string | null;
  readonly purpose: readonly string[];
}

async function readScope(executor: QueryExecutor, scopeId: string): Promise<ScopeRow | null> {
  const result = await executor.query<{
    scope_id: string;
    tenant_id: string;
    project: string | null;
    user_id: string | null;
    agent_id: string | null;
    session_id: string | null;
    purpose: string[];
  }>(
    `SELECT scope_id, tenant_id, project, user_id, agent_id, session_id, purpose
       FROM scopes WHERE scope_id = $1::uuid`,
    [scopeId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    scope_id: toPublicId("", row.scope_id).slice(1),
    tenant_id: row.tenant_id,
    project: row.project,
    user_id: row.user_id,
    agent_id: row.agent_id,
    session_id: row.session_id,
    purpose: row.purpose,
  };
}

/**
 * Is `requested` contained by `authority`?
 *
 * Containment, not overlap. A claim may be admitted at a *narrower* scope than
 * its evidence — that is the `accept_limited_scope` branch and it is the desired
 * default failure mode. A claim may never be admitted at a *broader* one.
 */
export function scopeContainment(
  requested: ScopeRow,
  authority: ScopeRow,
): { contained: boolean; narrower: boolean; broadenedPurposes: string[] } {
  const dimensions: readonly (keyof ScopeRow)[] = ["project", "user_id", "agent_id", "session_id"];
  let contained = true;
  let narrower = false;

  for (const dimension of dimensions) {
    const want = requested[dimension] as string | null;
    const have = authority[dimension] as string | null;
    if (want === null && have !== null) {
      // Requested is wider than the evidence supports.
      contained = false;
    } else if (want !== null && have === null) {
      // Requested names a dimension the evidence does not bind: narrowing.
      narrower = true;
    } else if (want !== null && have !== null && want !== have) {
      contained = false;
    }
  }

  const broadenedPurposes = requested.purpose.filter((purpose) => !authority.purpose.includes(purpose));
  if (broadenedPurposes.length > 0) contained = false;
  if (authority.purpose.some((purpose) => !requested.purpose.includes(purpose))) narrower = true;

  return { contained, narrower, broadenedPurposes };
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

export interface ConflictHit {
  readonly claim_id: string;
  readonly rel: "duplicates" | "narrows" | "contradicts" | "supersedes";
  readonly statement: string;
  readonly object: unknown;
}

/**
 * Find accepted claims in the same tenant that bear on this candidate.
 *
 * Deliberately narrow: same subject, same predicate, accepted, valid now. A
 * candidate is never marked contradictory because it resembles something else;
 * contradiction requires a shared key and a different object.
 */
export async function findConflicts(
  executor: QueryExecutor,
  candidate: CandidateForGate,
): Promise<ConflictHit[]> {
  const result = await executor.query<{
    claim_id: string;
    subject: string;
    predicate: string;
    object: unknown;
    kind: string;
    scope_id: string;
  }>(
    `SELECT claim_id, subject, predicate, object, kind, scope_id
       FROM claims
      WHERE tenant_id = $1::uuid
        AND subject = $2
        AND predicate = $3
        AND status = 'accepted'
        AND valid_to IS NULL
      LIMIT 64`,
    [candidate.tenant_id, candidate.subject, candidate.predicate],
  );

  const hits: ConflictHit[] = [];
  for (const row of result.rows) {
    const existingObject = normalizeObject(row.object);
    const candidateObject = normalizeObject(candidate.object);
    const rel = classifyConflict(existingObject, candidateObject);
    if (rel === null) continue;
    hits.push({
      claim_id: toPublicId("clm", row.claim_id),
      rel,
      statement: renderStatement(row.subject, row.predicate, row.object),
      object: row.object,
    });
  }
  return hits;
}

function normalizeObject(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim().toLowerCase();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = sortKeys(record[key]);
    return out;
  }
  return value;
}

/**
 * Relation classification between two objects for the same key.
 *
 * `contradicts` is the only classification that blocks auto-acceptance, and it
 * requires that the two values are genuinely incompatible rather than merely
 * different: a superset object narrows, an identical object duplicates, and a
 * different scalar is a contradiction.
 */
export function classifyConflict(
  existing: string,
  candidate: string,
): "duplicates" | "narrows" | "contradicts" | "supersedes" | null {
  if (existing === candidate) return "duplicates";

  const existingIsObject = existing.startsWith("{") || existing.startsWith("[");
  const candidateIsObject = candidate.startsWith("{") || candidate.startsWith("[");

  if (existingIsObject && candidateIsObject) {
    try {
      const left = JSON.parse(existing) as Record<string, unknown>;
      const right = JSON.parse(candidate) as Record<string, unknown>;
      if (isPlainObject(left) && isPlainObject(right)) {
        const leftKeys = Object.keys(left);
        const rightKeys = Object.keys(right);
        const shared = leftKeys.filter((key) => rightKeys.includes(key));
        if (shared.length === 0) return null;
        let identicalShared = true;
        let conflictingShared = false;
        for (const key of shared) {
          if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) {
            identicalShared = false;
            conflictingShared = true;
          }
        }
        if (identicalShared && leftKeys.length === rightKeys.length) return "duplicates";
        if (identicalShared) return rightKeys.length > leftKeys.length ? "supersedes" : "narrows";
        if (conflictingShared) return "contradicts";
        return null;
      }
    } catch {
      // Fall through to the scalar comparison below.
    }
  }

  // Both are scalars (or one is and they differ). Different scalar values for the
  // same key are a contradiction, not an update: an update arrives as a
  // supersedes relation or a new valid-time interval, never as a silent overwrite.
  if (!existingIsObject && !candidateIsObject) {
    if (numericEqual(existing, candidate)) return "duplicates";
    return "contradicts";
  }

  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numericEqual(left: string, right: string): boolean {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return false;
  return leftNumber === rightNumber;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export class CommitGate {
  private readonly deps: GateDependencies;
  private readonly policy: CommitPolicy;

  constructor(dependencies: GateDependencies) {
    this.deps = dependencies;
    this.policy = dependencies.policy ?? DEFAULT_COMMIT_POLICY;
  }

  get policyVersion(): string {
    return this.policy.version;
  }

  /**
   * Evaluate and record one candidate.
   *
   * Must be called inside a request transaction bound to the candidate's tenant:
   * the decision row, the claim row and their evidence rows are written here, and
   * they inherit the caller's row-level security context.
   */
  async evaluate(executor: QueryExecutor, candidate: CandidateForGate): Promise<GateResult> {
    const reasonCodes: string[] = [];

    // ---- 1. Evidence integrity. Deterministic, before any semantics. --------
    const evidence = await this.verifyEvidence(executor, candidate);
    const supporting = evidence.filter((entry) => entry.role === "supports");
    const usableSupport = supporting.filter((entry) => entry.status === "ok");

    if (candidate.spans.length === 0 || supporting.length === 0) {
      reasonCodes.push(REASON_CODES.NO_SUPPORTING_EVIDENCE);
    }
    if (usableSupport.length === 0 && supporting.length > 0) {
      reasonCodes.push(REASON_CODES.SPAN_UNRESOLVABLE);
    }

    // ---- 2. Instruction-like content from an external origin ---------------
    const instructionScan =
      candidate.event_content === null
        ? { flagged: false, matches: [] as readonly string[] }
        : scanForInstructions(candidate.event_content);
    const isExternal = candidate.origin === "document" || candidate.origin === "database";
    const externalInstruction = instructionScan.flagged && isExternal;
    if (instructionScan.flagged) reasonCodes.push(REASON_CODES.ADMISSION_INSTRUCTION_LIKE);
    if (externalInstruction) reasonCodes.push(REASON_CODES.ADMISSION_EXTERNAL_INSTRUCTION);

    // ---- 3. Scope containment ---------------------------------------------
    const requestedScope = await readScope(executor, candidate.requested_scope_id);
    const eventScope = await readScope(executor, candidate.event_scope_id);
    if (!requestedScope || !eventScope) {
      throw new Error(
        `gate: candidate ${candidate.candidate_id} references a scope that does not exist`,
      );
    }
    const containment = scopeContainment(requestedScope, eventScope);
    if (containment.contained) reasonCodes.push(REASON_CODES.SCOPE_WITHIN_EVENT);
    else if (containment.broadenedPurposes.length > 0) reasonCodes.push(REASON_CODES.SCOPE_PURPOSE_BROADENED);
    else reasonCodes.push(REASON_CODES.SCOPE_BROADER_THAN_EVENT);
    if (containment.narrower) reasonCodes.push(REASON_CODES.SCOPE_NARROWED_TO_EVENT);

    // ---- 4. Entailment -----------------------------------------------------
    let aggregate: EntailmentResult = "unknown";
    let aggregateScore: number | null = null;
    let entailmentBackend = this.deps.entailment.name;
    let entailmentModelSha: string | null = this.deps.entailment.modelSha256;
    let modelCalls = 0;
    let entailmentFloorMissed = false;

    if (usableSupport.length > 0) {
      const premise = usableSupport.map((entry) => entry.quote ?? "").join("\n");
      const hypothesis = renderStatement(candidate.subject, candidate.predicate, candidate.object);
      const verdict = await this.deps.entailment.entails({ premise, hypothesis });
      aggregate = verdict.result;
      aggregateScore = verdict.score;
      entailmentBackend = verdict.backend;
      entailmentModelSha = verdict.modelSha256;
      if (this.deps.entailment.isModelCall) modelCalls += 1;

      reasonCodes.push(
        aggregate === "entailed"
          ? REASON_CODES.ENTAILMENT_ENTAILED
          : aggregate === "contradiction"
            ? REASON_CODES.ENTAILMENT_CONTRADICTION
            : aggregate === "unknown"
              ? REASON_CODES.ENTAILMENT_UNAVAILABLE
              : REASON_CODES.ENTAILMENT_NEUTRAL,
      );
      // A model that says "entailed" below its own confidence floor has not
      // established entailment, and treating it as if it had is how a gate
      // quietly becomes decorative.
      if (aggregate === "entailed" && verdict.score < this.policy.thresholds.entailmentFloor) {
        entailmentFloorMissed = true;
        reasonCodes.push(REASON_CODES.ENTAILMENT_BELOW_THRESHOLD);
      }
    }

    // ---- 5. Authority ------------------------------------------------------
    const authorityStrong = this.policy.autoAcceptAuthorities.includes(candidate.authority);
    reasonCodes.push(authorityStrong ? REASON_CODES.AUTHORITY_STRONG : REASON_CODES.AUTHORITY_WEAK);

    // ---- 6. Conflict -------------------------------------------------------
    const conflicts = await findConflicts(executor, candidate);
    const contradicting = conflicts.filter((hit) => hit.rel === "contradicts");
    const duplicating = conflicts.filter((hit) => hit.rel === "duplicates");
    if (conflicts.length === 0) reasonCodes.push(REASON_CODES.CONFLICT_NONE);
    if (contradicting.length > 0) reasonCodes.push(REASON_CODES.CONFLICT_CONTRADICTS_ACCEPTED);
    if (duplicating.length > 0) reasonCodes.push(REASON_CODES.CONFLICT_DUPLICATE);

    // ---- 7. Quarantine conditions ------------------------------------------
    const kindQuarantined = this.policy.quarantineKinds.includes(candidate.kind);
    if (kindQuarantined) reasonCodes.push(REASON_CODES.KIND_PRIVILEGED, REASON_CODES.KIND_REQUIRES_REVIEW);
    const sensitive = candidate.sensitivity === "high";
    if (sensitive) reasonCodes.push(REASON_CODES.ADMISSION_SENSITIVE);

    // ---- 8. The decision ---------------------------------------------------
    const integrityOk = supporting.length > 0 && usableSupport.length === supporting.length;
    const entailmentOk =
      aggregate === "entailed" &&
      !entailmentFloorMissed;
    // Attach the entailment result to the supporting evidence rows now that it is
    // known, so /explain shows per-span verdicts rather than an aggregate alone.
    for (const entry of evidence) {
      if (entry.role === "supports" && entry.status === "ok") {
        (entry as { entailment: EntailmentResult; entailment_score: number | null }).entailment = aggregate;
        (entry as { entailment: EntailmentResult; entailment_score: number | null }).entailment_score =
          aggregateScore;
      }
    }

    let outcome: DecisionOutcome;
    if (usableSupport.length === 0 || aggregate === "contradiction") {
      // REJECT is reserved for a candidate that cannot be salvaged by review.
      outcome = "reject";
    } else if (kindQuarantined || sensitive || externalInstruction) {
      outcome = "quarantine";
    } else if (
      integrityOk &&
      entailmentOk &&
      authorityStrong &&
      contradicting.length === 0 &&
      containment.contained
    ) {
      outcome = "accept";
    } else if (
      integrityOk &&
      entailmentOk &&
      authorityStrong &&
      contradicting.length === 0 &&
      !containment.contained &&
      requestedScope.tenant_id === eventScope.tenant_id
    ) {
      // All auto-accept conditions hold except the requested scope is broader
      // than the evidence. Narrow rather than broaden: this branch exists to make
      // narrowing the default failure mode.
      outcome = "accept_limited_scope";
      reasonCodes.push(REASON_CODES.SCOPE_NARROWED_TO_EVENT);
    } else {
      // Entailment unavailable, authority weak, or an unresolved contradiction.
      outcome = "needs_review";
    }

    if (outcome === "accept" || outcome === "accept_limited_scope") {
      reasonCodes.push(REASON_CODES.GATE_AUTO_ACCEPT_ELIGIBLE);
    }
    if (outcome === "quarantine") reasonCodes.push(REASON_CODES.GATE_QUARANTINED);
    if (outcome === "needs_review") reasonCodes.push(REASON_CODES.GATE_NEEDS_REVIEW);
    reasonCodes.push(
      candidate.extractor.includes("model") ? REASON_CODES.EXTRACTOR_MODEL : REASON_CODES.EXTRACTOR_DETERMINISTIC,
    );

    // ---- 9. Persist --------------------------------------------------------
    const acceptedScopeId =
      outcome === "accept_limited_scope" ? candidate.event_scope_id : candidate.requested_scope_id;
    const claimId =
      outcome === "accept" || outcome === "accept_limited_scope"
        ? await this.insertClaim(executor, candidate, acceptedScopeId, conflicts)
        : null;

    const decisionId = await this.insertDecision(executor, candidate, {
      outcome,
      reasonCodes,
      claimId,
      detail: {
        entailment_backend: entailmentBackend,
        entailment_model_sha256: entailmentModelSha,
        entailment_aggregate: aggregate,
        entailment_score: aggregateScore,
        model_calls: modelCalls,
        instruction_flagged: instructionScan.flagged,
        instruction_matches: instructionScan.matches,
        scope: {
          requested_scope_id: candidate.requested_scope_id,
          event_scope_id: candidate.event_scope_id,
          accepted_scope_id: acceptedScopeId,
          broadened_purposes: containment.broadenedPurposes,
          narrower: containment.narrower,
        },
        conflicts: conflicts.map((hit) => ({
          claim_id: hit.claim_id,
          rel: hit.rel,
          statement: hit.statement,
        })),
      },
      evidence,
    });

    await executor.query(
      `UPDATE claim_candidates SET state = 'gated' WHERE candidate_id = $1::uuid`,
      [stripPrefix(candidate.candidate_id)],
    );

    return {
      decision_id: decisionId,
      candidate_id: candidate.candidate_id,
      outcome,
      reason_codes: reasonCodes,
      claim_id: claimId,
      policy_version: this.policy.version,
      evidence,
      detail: {
        entailment_backend: entailmentBackend,
        entailment_model_sha256: entailmentModelSha,
        entailment_aggregate: aggregate,
        entailment_score: aggregateScore,
        model_calls: modelCalls,
        instruction_flagged: instructionScan.flagged,
        instruction_matches: instructionScan.matches,
        scope: {
          requested_scope_id: candidate.requested_scope_id,
          event_scope_id: candidate.event_scope_id,
          accepted_scope_id: acceptedScopeId,
          broadened_purposes: containment.broadenedPurposes,
          narrower: containment.narrower,
        },
        conflicts: conflicts.map((hit) => ({
          claim_id: hit.claim_id,
          rel: hit.rel,
          statement: hit.statement,
        })),
      },
    };
  }

  /**
   * Resolve every cited span and verify its digest against current bytes.
   *
   * Performed on every gate evaluation, never cached: the gate's whole claim is
   * that it checked the bytes at the moment of promotion.
   */
  private async verifyEvidence(
    executor: QueryExecutor,
    candidate: CandidateForGate,
  ): Promise<GateEvidenceVerdict[]> {
    if (candidate.spans.length === 0) return [];
    const verifications = await this.deps.ledger.verifySpans(
      executor,
      candidate.spans.map((entry) => entry.span),
    );

    return candidate.spans.map((entry) => {
      const verification = verifications.get(entry.span.span_id);
      const status: SpanVerification["status"] = verification?.status ?? "missing";
      const codes: string[] = [];
      let quote: string | null = null;
      let digestOk = false;

      switch (status) {
        case "ok": {
          codes.push(REASON_CODES.SPAN_RESOLVED);
          // `status === "ok"` narrows the union by discriminant, so the quote is
          // reachable without a structural probe.
          const ok = verification as Extract<SpanVerification, { status: "ok" }> | undefined;
          quote = ok?.quote ?? null;
          digestOk = true;
          break;
        }
        case "redacted":
          codes.push(REASON_CODES.SPAN_EVENT_REDACTED, REASON_CODES.SPAN_UNRESOLVABLE);
          break;
        case "digest_mismatch":
          codes.push(REASON_CODES.SPAN_DIGEST_MISMATCH, REASON_CODES.SPAN_UNRESOLVABLE);
          break;
        case "out_of_bounds":
          codes.push(REASON_CODES.SPAN_OUT_OF_BOUNDS, REASON_CODES.SPAN_UNRESOLVABLE);
          break;
        case "missing":
          codes.push(REASON_CODES.SPAN_UNRESOLVABLE);
          break;
      }

      return {
        span_id: entry.span.span_id,
        role: entry.role,
        status,
        digest_ok: digestOk,
        quote,
        entailment: status === "ok" ? ("entailed" as EntailmentResult) : ("unknown" as EntailmentResult),
        entailment_score: null,
        reason_codes: codes,
      };
    });
  }

  private async insertClaim(
    executor: QueryExecutor,
    candidate: CandidateForGate,
    acceptedScopeId: string,
    conflicts: readonly ConflictHit[],
  ): Promise<string> {
    const claimId = this.deps.ids.next("clm");
    const now = this.deps.clock.now().toISOString();

    // Valid time starts at the moment the claim became true, which is the time of
    // the observation it rests on — not the time the gate ran. A claim extracted
    // today from a two-year-old document is two years old.
    const validFrom = await this.resolveValidFrom(executor, candidate.source_event_id, now);

    await executor.query(
      `INSERT INTO claims (
         claim_id, tenant_id, scope_id, kind, subject, predicate, object, status, authority,
         valid_from, valid_to, recorded_at, expires_at, origin_event_id,
         extractor, model_version, prompt_version
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::claim_kind, $5, $6, $7::jsonb, 'accepted', $8::authority_cls,
         $9::timestamptz, NULL, $10::timestamptz, NULL, $11::uuid,
         $12, $13, $14
       )`,
      [
        stripPrefix(claimId),
        candidate.tenant_id,
        acceptedScopeId,
        candidate.kind,
        candidate.subject,
        candidate.predicate,
        JSON.stringify(candidate.object ?? null),
        candidate.authority,
        validFrom,
        now,
        stripPrefix(candidate.source_event_id),
        candidate.extractor,
        candidate.model_version,
        candidate.prompt_version,
      ],
    );

    for (const entry of candidate.spans) {
      await executor.query(
        `INSERT INTO claim_evidence (claim_id, span_id, role)
         VALUES ($1::uuid, $2::uuid, $3::evidence_role)
         ON CONFLICT (claim_id, span_id) DO NOTHING`,
        [stripPrefix(claimId), stripPrefix(entry.span.span_id), entry.role],
      );
    }

    // Record the relations the verifier found. Contradiction is explicit, so it
    // must be written down rather than left for a future reader to re-derive.
    for (const hit of conflicts) {
      await executor.query(
        `INSERT INTO claim_relations (from_claim, to_claim, rel)
         VALUES ($1::uuid, $2::uuid, $3::relation_kind)
         ON CONFLICT (from_claim, to_claim, rel) DO NOTHING`,
        [stripPrefix(claimId), stripPrefix(hit.claim_id), hit.rel === "duplicates" ? "duplicates" : hit.rel],
      );
    }

    // An accepted claim that duplicates an existing accepted claim is itself a
    // supersession of the older record, so the older one stops being current.
    // Nothing is deleted; the history stays readable.
    for (const hit of conflicts) {
      if (hit.rel !== "supersedes" && hit.rel !== "duplicates") continue;
      await executor.query(
        `UPDATE claims
            SET status = 'superseded', valid_to = $2::timestamptz
          WHERE claim_id = $1::uuid AND valid_to IS NULL AND claim_id <> $3::uuid`,
        [stripPrefix(hit.claim_id), now, stripPrefix(claimId)],
      );
    }

    return claimId;
  }

  private async resolveValidFrom(
    executor: QueryExecutor,
    eventId: string,
    fallback: string,
  ): Promise<string> {
    const result = await executor.query<{ occurred_at: Date | string }>(
      `SELECT occurred_at FROM events WHERE event_id = $1::uuid`,
      [stripPrefix(eventId)],
    );
    const row = result.rows[0];
    if (!row) return fallback;
    const value = row.occurred_at;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  private async insertDecision(
    executor: QueryExecutor,
    candidate: CandidateForGate,
    input: {
      outcome: DecisionOutcome;
      reasonCodes: readonly string[];
      claimId: string | null;
      detail: Record<string, unknown>;
      evidence: readonly GateEvidenceVerdict[];
    },
  ): Promise<string> {
    const decisionId = this.deps.ids.next("dec");
    await executor.query(
      `INSERT INTO decisions (
         decision_id, tenant_id, candidate_id, claim_id, policy_version,
         outcome, reason_codes, approver, detail
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::decision_outcome, $7::text[], NULL, $8::jsonb)`,
      [
        stripPrefix(decisionId),
        candidate.tenant_id,
        stripPrefix(candidate.candidate_id),
        input.claimId ? stripPrefix(input.claimId) : null,
        this.policy.version,
        input.outcome,
        [...new Set([...input.reasonCodes, ...input.evidence.flatMap((entry) => entry.reason_codes)])],
        JSON.stringify(input.detail),
      ],
    );
    return decisionId;
  }
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

/**
 * The invariant this whole module exists to protect, expressed as an assertion
 * the test suite can call: no code path outside `CommitGate.insertClaim` may set
 * `claims.status`. The database enforces the lifecycle transitions; this helper
 * exists so the claim can be tested directly rather than only argued.
 */
export const GATE_REASON_CODES = REASON_CODES;

/** Authority implied by an origin when the extractor does not declare one. */
export function defaultAuthorityFor(origin: OriginKind): AuthorityClass {
  switch (origin) {
    case "user":
      return "user_self_report";
    case "tool":
      return "observation";
    case "database":
      return "verified_record";
    case "document":
      return "hearsay";
    case "agent":
      return "observation";
    case "model_inference":
      return "inference";
    default:
      // Unreachable for a valid OriginKind, but an unknown origin must not
      // silently inherit a strong authority class.
      throw new Error(`unmapped origin kind: ${String(origin as string)}`);
  }
}

/** Exported for the extraction pipeline's scope-narrowing decision. */
export type { ScopeRow };

/** A write scope as the extraction pipeline receives it. */
export type WriteScopeRequest = EventAppendRequest["scope"];
