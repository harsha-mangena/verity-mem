/**
 * The extraction pipeline: admission, extraction, gate.
 *
 * This is the write path's second half. It is idempotent by construction rather
 * than by locking, because the outbox retries and a half-applied extraction must
 * be indistinguishable from one that never ran. Everything for a single event
 * happens in one transaction, so a crash leaves no partial candidate set.
 *
 * Two admission rules are enforced here and nowhere else:
 *
 *   - instruction-like content from an *external* origin is never routed to
 *     extractors that can produce privileged claim kinds. It is still stored as
 *     evidence and still extracted for ordinary observations, because dropping it
 *     would destroy the ledger's completeness to solve a different problem.
 *   - deterministic extractors always run before model extractors, and the model
 *     extractor is skipped entirely when there is nothing left for it to add and
 *     the cost budget is one call per unstructured event.
 */
import type {
  AuthorityClass,
  ClaimKind,
  OriginKind,
  Sensitivity,
} from "@veritymem/contracts";
import { REASON_CODES } from "@veritymem/contracts";
import type {
  Clock,
  Db,
  IdGenerator,
  Ledger,
  LedgerEvent,
  ProposalSpanInput,
  QueryExecutor,
  ResolvedScope,
} from "@veritymem/ledger";
import { ensureScope, toPublicId } from "@veritymem/ledger";
import { CommitGate, defaultAuthorityFor, scanForInstructions, type GateResult } from "@veritymem/gate";
import { isExternalOrigin } from "./deterministic.ts";
import type { Extractor, Proposal } from "./extractor.ts";
import type { ExtractionInput } from "./extractor.ts";

export interface AdmissionResult {
  readonly trust_zone: "internal" | "external";
  readonly instruction_like: boolean;
  readonly instruction_matches: readonly string[];
  readonly sensitive: boolean;
  /** Extractor ids that must not run for this event. */
  readonly blocked_extractors: readonly string[];
  readonly reason_codes: readonly string[];
}

/**
 * Classify an event before anything is extracted from it.
 *
 * Separate from extraction because it produces evidence in its own right: the
 * fact that content was flagged is recorded on the decision, so an operator can
 * see that the system noticed an injection attempt even when the gate correctly
 * rejected the claim it produced.
 */
export function admit(event: Pick<LedgerEvent, "origin" | "content" | "sensitivity">): AdmissionResult {
  const external = isExternalOrigin(event.origin);
  const scan = event.content === null ? { flagged: false, matches: [] as readonly string[] } : scanForInstructions(event.content);
  const sensitive = event.sensitivity === "high";

  const reasonCodes: string[] = [];
  if (scan.flagged) reasonCodes.push(REASON_CODES.ADMISSION_INSTRUCTION_LIKE);
  if (scan.flagged && external) reasonCodes.push(REASON_CODES.ADMISSION_EXTERNAL_INSTRUCTION);
  if (sensitive) reasonCodes.push(REASON_CODES.ADMISSION_SENSITIVE);

  // A privileged extractor is blocked whenever the content is external and
  // instruction-like. The blocked list is by extractor id so that adding a new
  // privileged extractor without adding it here is a visible omission rather than
  // a silent hole: the extractor declares `produces` and this checks it.
  const blocked: string[] = [];
  if (scan.flagged && external) blocked.push("privileged");

  return {
    trust_zone: external ? "external" : "internal",
    instruction_like: scan.flagged,
    instruction_matches: scan.matches,
    sensitive,
    blocked_extractors: blocked,
    reason_codes: reasonCodes,
  };
}

export interface PersistedCandidate {
  readonly candidate_id: string;
  readonly kind: ClaimKind;
  readonly subject: string;
  readonly predicate: string;
  readonly object: unknown;
  readonly extractor: string;
  readonly model_version: string | null;
  readonly prompt_version: string | null;
  readonly confidence: number | null;
  readonly authority: AuthorityClass;
  readonly requested_scope_id: string;
  readonly span_ids: readonly string[];
  readonly state: string;
}

export interface IngestDependencies {
  readonly db: Db;
  readonly ledger: Ledger;
  readonly gate: CommitGate;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly deterministicExtractors: readonly Extractor[];
  /** Null when no model is configured. The pipeline then records that honestly. */
  readonly modelExtractor: Extractor | null;
}

export interface IngestOptions {
  /** The scope a proposal may request, before the gate narrows it. */
  readonly requestedScope?: {
    readonly project?: string;
    readonly user?: string;
    readonly agent?: string;
    readonly session?: string;
    readonly purpose?: readonly string[];
  };
  /** Set by the caller to attribute authority when the extractor does not. */
  readonly authorityOverride?: AuthorityClass;
  /** Skip the model extractor even when one is configured. */
  readonly deterministicOnly?: boolean;
}

export interface IngestResult {
  readonly event_id: string;
  readonly admission: AdmissionResult;
  readonly candidates: readonly PersistedCandidate[];
  readonly decisions: readonly GateResult[];
  readonly model_calls: number;
  readonly extractor_versions: readonly string[];
  /** Reasons the pipeline produced nothing, for the decision trace. */
  readonly notes: readonly string[];
}

export class IngestPipeline {
  private readonly deps: IngestDependencies;

  constructor(dependencies: IngestDependencies) {
    this.deps = dependencies;
  }

  /**
   * Run admission, extraction and gating for one event.
   *
   * Must be called inside a request transaction bound to the event's tenant and
   * scope: candidates, claims and decisions are written here and inherit the
   * caller's row-level security context.
   */
  async ingest(executor: QueryExecutor, event: LedgerEvent, options: IngestOptions = {}): Promise<IngestResult> {
    const admission = admit(event);
    const notes: string[] = [];
    const candidates: PersistedCandidate[] = [];
    const decisions: GateResult[] = [];
    const extractorVersions: string[] = [];
    let modelCalls = 0;

    if (event.content === null) {
      notes.push("event payload has been redacted; nothing to extract");
      return {
        event_id: event.event_id,
        admission,
        candidates,
        decisions,
        model_calls: 0,
        extractor_versions: extractorVersions,
        notes,
      };
    }

    const input: ExtractionInput = {
      content: event.content,
      origin: event.origin,
      actor_id: event.actor_id,
      media_type: event.media_type,
      instruction_flagged: admission.instruction_like,
      external: admission.trust_zone === "external",
    };

    // ---- Deterministic pass -------------------------------------------------
    for (const extractor of this.deps.deterministicExtractors) {
      if (this.isBlocked(extractor, admission)) {
        notes.push(`extractor ${extractor.id} blocked by admission (external instruction-like content)`);
        continue;
      }
      const proposals = await extractor.extract(input);
      extractorVersions.push(extractor.id);
      for (const proposal of proposals) {
        const persisted = await this.persistCandidate(executor, event, extractor, proposal, options);
        if (persisted) candidates.push(persisted);
      }
    }

    // ---- Model pass ---------------------------------------------------------
    const model = this.deps.modelExtractor;
    if (model && !options.deterministicOnly) {
      if (this.isBlocked(model, admission)) {
        notes.push(`extractor ${model.id} blocked by admission (external instruction-like content)`);
      } else if (!model.isModelCall) {
        notes.push(`model extractor ${model.id} is not a model call; running as a stand-in`);
        const proposals = await model.extract(input);
        extractorVersions.push(model.id);
        for (const proposal of proposals) {
          const persisted = await this.persistCandidate(executor, event, model, proposal, options);
          if (persisted) candidates.push(persisted);
        }
      } else {
        // One extraction call per unstructured event is the budget. A single
        // call is made regardless of how many candidates it yields.
        modelCalls += 1;
        try {
          const proposals = await model.extract(input);
          extractorVersions.push(model.id);
          for (const proposal of proposals) {
            const persisted = await this.persistCandidate(executor, event, model, proposal, options);
            if (persisted) candidates.push(persisted);
          }
        } catch (error) {
          // A model outage degrades the system to "deterministically extracted",
          // never to "lost" and never to "ungated".
          notes.push(`model extraction unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else if (!model) {
      notes.push("no model extractor configured; deterministic extraction only");
    }

    // ---- Gate ---------------------------------------------------------------
    for (const candidate of candidates) {
      const gateInput = await this.toGateInput(executor, event, candidate);
      const result = await this.deps.gate.evaluate(executor, gateInput);
      decisions.push(result);
      await this.enqueueProjection(executor, event, result);
    }

    return {
      event_id: event.event_id,
      admission,
      candidates,
      decisions,
      model_calls: modelCalls,
      extractor_versions: extractorVersions,
      notes,
    };
  }

  /**
   * Whether admission forbids this extractor from running.
   *
   * Read from the extractor's own declared `produces` rather than a hardcoded
   * list, so a newly added privileged extractor is blocked by declaring what it
   * produces rather than by remembering to update this function.
   */
  private isBlocked(extractor: Extractor, admission: AdmissionResult): boolean {
    if (!admission.blocked_extractors.includes("privileged")) return false;
    return extractor.produces.some((kind) => kind === "procedure" || kind === "permission");
  }

  private async persistCandidate(
    executor: QueryExecutor,
    event: LedgerEvent,
    extractor: Extractor,
    proposal: Proposal,
    options: IngestOptions,
  ): Promise<PersistedCandidate | null> {
    const requestedScope = await this.resolveRequestedScope(executor, event.scope, proposal, options);
    // The extractor's span shape and the ledger's input shape are structurally
    // identical but nominally distinct, so the role union is mapped explicitly
    // rather than bridged with a cast.
    // Built with an explicit loop rather than `.map` because the callback's
    // inferred return type widens the role union to `string`, which then fails to
    // satisfy the ledger's input type. The loop gives each field full contextual
    // typing, so the union survives without a cast.
    const spanInputs: ProposalSpanInput[] = [];
    for (const span of proposal.spans) {
      spanInputs.push({
        start: span.start,
        end: span.end,
        role: span.role ?? "supports",
        ...(span.selector !== undefined ? { selector: span.selector } : {}),
      });
    }
    const spans = await this.deps.ledger.writeSpans(executor, event, spanInputs);
    if (spans.length === 0) return null;

    const authority =
      options.authorityOverride ?? proposal.authority ?? defaultAuthorityFor(event.origin);

    // Idempotency: the outbox may retry, and a retry must not double-extract.
    // The identity of a candidate is its proposition plus its evidence, so a
    // deterministic extractor replaying the same event produces the same key.
    const existing = await executor.query<{ candidate_id: string; state: string }>(
      `SELECT candidate_id, state FROM claim_candidates
        WHERE source_event_id = $1::uuid
          AND extractor = $2
          AND kind = $3::claim_kind
          AND subject = $4
          AND predicate = $5
          AND object = $6::jsonb
        LIMIT 1`,
      [
        stripPrefix(event.event_id),
        extractor.id,
        proposal.kind,
        proposal.subject,
        proposal.predicate,
        JSON.stringify(proposal.object ?? null),
      ],
    );
    const prior = existing.rows[0];
    if (prior) {
      return {
        candidate_id: toPublicId("cnd", prior.candidate_id),
        kind: proposal.kind,
        subject: proposal.subject,
        predicate: proposal.predicate,
        object: proposal.object,
        extractor: extractor.id,
        model_version: extractor.isModelCall ? extractor.id : null,
        prompt_version: proposal.prompt_version ?? null,
        confidence: proposal.confidence ?? null,
        authority,
        requested_scope_id: requestedScope.scope_id,
        span_ids: spans.map((span) => span.span_id),
        state: prior.state,
      };
    }

    const candidateId = this.deps.ids.next("cnd");
    const modelVersion = extractor.isModelCall ? extractor.id : null;

    await executor.query(
      `INSERT INTO claim_candidates (
         candidate_id, tenant_id, source_event_id, kind, subject, predicate, object,
         requested_scope, extractor, model_version, prompt_version, confidence, state
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::claim_kind, $5, $6, $7::jsonb,
         $8::uuid, $9, $10, $11, $12, 'extracted'
       )`,
      [
        stripPrefix(candidateId),
        event.tenant_id,
        stripPrefix(event.event_id),
        proposal.kind,
        proposal.subject,
        proposal.predicate,
        JSON.stringify(proposal.object ?? null),
        requestedScope.scope_id,
        extractor.id,
        modelVersion,
        proposal.prompt_version ?? null,
        proposal.confidence ?? null,
      ],
    );

    for (const span of spans) {
      const role = proposal.spans.find((s) => s.start === span.start && s.end === span.end)?.role ?? "supports";
      await executor.query(
        `INSERT INTO candidate_evidence (candidate_id, span_id, role)
         VALUES ($1::uuid, $2::uuid, $3::evidence_role)
         ON CONFLICT (candidate_id, span_id) DO UPDATE SET role = EXCLUDED.role`,
        [stripPrefix(candidateId), stripPrefix(span.span_id), role],
      );
    }

    return {
      candidate_id: candidateId,
      kind: proposal.kind,
      subject: proposal.subject,
      predicate: proposal.predicate,
      object: proposal.object,
      extractor: extractor.id,
      model_version: modelVersion,
      prompt_version: proposal.prompt_version ?? null,
      confidence: proposal.confidence ?? null,
      authority,
      requested_scope_id: requestedScope.scope_id,
      span_ids: spans.map((span) => span.span_id),
      state: "extracted",
    };
  }

  /**
   * Resolve the scope a candidate asks to be admitted into.
   *
   * Default is the event's own scope, which is the only scope that requires no
   * judgement. An extractor that asks for something narrower gets it; an
   * extractor that asks for something broader gets the event's scope and the gate
   * records the narrowing. An extractor cannot name a dimension the event did not
   * bind and have it widen the claim, because the gate re-checks containment.
   */
  private async resolveRequestedScope(
    executor: QueryExecutor,
    eventScope: ResolvedScope,
    proposal: Proposal,
    options: IngestOptions,
  ): Promise<{ scope_id: string }> {
    const request = { ...(proposal.requested_scope ?? {}), ...(options.requestedScope ?? {}) };
    if (Object.keys(request).length === 0) {
      return { scope_id: eventScope.scope_id };
    }
    const purposes = request.purpose && request.purpose.length > 0 ? request.purpose : eventScope.purpose;
    const scope = await ensureScope(executor, {
      tenant: eventScope.tenant_id,
      ...(request.project ?? eventScope.project ? { project: request.project ?? eventScope.project ?? undefined } : {}),
      ...(request.user ?? eventScope.user ? { user: request.user ?? eventScope.user ?? undefined } : {}),
      ...(request.agent ?? eventScope.agent ? { agent: request.agent ?? eventScope.agent ?? undefined } : {}),
      ...(request.session ?? eventScope.session ? { session: request.session ?? eventScope.session ?? undefined } : {}),
      purpose: purposes,
    });
    return { scope_id: scope.scope_id };
  }

  private async toGateInput(
    executor: QueryExecutor,
    event: LedgerEvent,
    candidate: PersistedCandidate,
  ): Promise<Parameters<CommitGate["evaluate"]>[1]> {
    const spanRows = await executor.query<{
      span_id: string;
      event_id: string;
      start_off: number;
      end_off: number;
      selector: string | null;
      span_digest: Buffer;
      quote: string;
      role: "supports" | "refutes";
    }>(
      `SELECT s.span_id, s.event_id, s.start_off, s.end_off, s.selector, s.span_digest, s.quote, ce.role
         FROM candidate_evidence ce
         JOIN evidence_spans s ON s.span_id = ce.span_id
        WHERE ce.candidate_id = $1::uuid`,
      [stripPrefix(candidate.candidate_id)],
    );

    return {
      candidate_id: candidate.candidate_id,
      tenant_id: event.tenant_id,
      source_event_id: event.event_id,
      kind: candidate.kind,
      subject: candidate.subject,
      predicate: candidate.predicate,
      object: candidate.object,
      requested_scope_id: candidate.requested_scope_id,
      extractor: candidate.extractor,
      model_version: candidate.model_version,
      prompt_version: candidate.prompt_version,
      confidence: candidate.confidence,
      authority: candidate.authority,
      origin: event.origin as OriginKind,
      sensitivity: event.sensitivity as Sensitivity,
      event_scope_id: event.scope.scope_id,
      spans: spanRows.rows.map((row) => ({
        span: {
          span_id: toPublicId("spn", row.span_id),
          event_id: toPublicId("evt", row.event_id),
          start: Number(row.start_off),
          end: Number(row.end_off),
          selector: row.selector,
          digest: row.span_digest.toString("hex"),
          quote: row.quote,
        },
        role: row.role,
      })),
      event_content: event.content,
    };
  }

  /**
   * Enqueue a projection update for a claim the gate accepted.
   *
   * Only accepted claims enter projections. A quarantined claim is in the claim
   * store and visible to /explain, but it is not a retrieval candidate, and
   * putting it in the index and filtering later is exactly the "filter after
   * vector search" pattern the design rejects.
   */
  private async enqueueProjection(
    executor: QueryExecutor,
    event: LedgerEvent,
    result: GateResult,
  ): Promise<void> {
    if (result.claim_id === null) return;
    await executor.query(
      `INSERT INTO outbox (tenant_id, kind, payload)
       VALUES ($1::uuid, 'project.claim', $2::jsonb)`,
      [
        event.tenant_id,
        JSON.stringify({
          claim_id: result.claim_id,
          tenant_id: event.tenant_id,
          scope_id: event.scope.scope_id,
          decision_id: result.decision_id,
        }),
      ],
    );
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
