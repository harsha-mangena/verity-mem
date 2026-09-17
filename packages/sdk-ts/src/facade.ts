/**
 * ============================================================================
 * THIS FACADE EXISTS TO TEST AN UNVALIDATED DEMAND ASSUMPTION.
 * ============================================================================
 *
 * The specification's "one bet" is that developers will accept added write
 * latency and governance friction in exchange for correctness. Nothing in the
 * architecture validates that bet. This file exists to falsify it cheaply, in
 * month two rather than month twelve, and it is a kill-criterion instrument
 * before it is a convenience wrapper.
 *
 * `add()` and `search()` are deliberately Mem0-shaped so that adoption requires
 * no new mental model. Two things are measured, exactly as the specification
 * requires:
 *
 *   1. **Whether the caller ever calls `explain`.** A memory layer that nobody
 *      audits is a retrieval layer with extra steps. `metrics().explains` counts
 *      calls made through this facade and through any client obtained from
 *      `countingClient()`.
 *   2. **Whether the caller tolerates the gate.** `disableGate` is recorded in
 *      `metrics().gate_disabled_count` when it is used. It cannot actually turn
 *      the commit gate off — no client-side option can, because no model call may
 *      set `status = accepted` — so it exists only to make the intent countable.
 *      A facade that honoured it would be lying about the product's central
 *      invariant.
 *
 * **The blunt reading of the result:** if nobody opens `explain` and everyone
 * turns the gate off, the thesis is wrong. Not "needs tuning" — wrong. That
 * result is worth more than any benchmark number in the specification, and it is
 * the reason this file is instrumented rather than merely convenient.
 *
 * The facade also refuses to hide the gate:
 *
 *   - `add()` returns a `promotion` outcome, not just an id. `add()` on a Mem0
 *     facade means "stored"; here it means "appended, and here is what the commit
 *     gate did or did not yet do with it".
 *   - Nothing is called accepted until a decision says so. The write path answers
 *     202 before extraction runs, so the facade reports `pending_extraction`
 *     rather than guessing; `awaitPromotion()` waits and reports the real outcome.
 *   - `reviews_required` is counted, because review burden above 2% of writes is
 *     specified as a product failure rather than an ops metric.
 *
 * Because the write path is asynchronous, `add()` cannot know the gate's verdict
 * at the moment it returns, and inventing one would be the exact promotion
 * collapse the system exists to prevent. `awaitPromotion(result)` is the opt-in
 * that pays the extra round trip; `promotionOf(eventId)` does the same for an
 * event id the caller already holds.
 */
import type {
  ClaimExplanation,
  ClaimKind,
  DecisionOutcome,
  EventAppendResponse,
  EventExtractResponse,
  MemoryPacket,
  OriginKind,
  QueryRequest,
  TimeSpec,
  UseDecision,
  WriteScope,
} from "@veritymem/contracts";
import { VerityMemClient } from "./client.ts";
import { isVerityMemError } from "./errors.ts";

/** Default port matches `deploy/compose`; override in `VerityMemFacadeOptions`. */
export const DEFAULT_BASE_URL = "http://127.0.0.1:8080";

/**
 * Snapshot of the two demand signals plus basic traffic counts.
 *
 * `mean_add_latency_ms` covers the `POST /v1/events` round trip only. It
 * deliberately excludes any promotion wait, which is dominated by the extractor
 * and would make the number describe queue depth rather than the write latency a
 * developer actually experiences at the call site.
 */
export interface FacadeMetrics {
  readonly adds: number;
  readonly searches: number;
  readonly explains: number;
  readonly gate_disabled_count: number;
  readonly reviews_required: number;
  readonly mean_add_latency_ms: number;
}

/**
 * What the commit gate did with a write, in the facade's own vocabulary.
 *
 * `not_gated` is a first-class outcome rather than a missing one: content that
 * produced no candidate, or an append that was deduplicated, was never put in
 * front of the gate, and reporting that as "accepted" would be the promotion
 * collapse this system exists to prevent. `pending_extraction` is likewise an
 * answer, not an absence: the append is durable and nothing is believed yet.
 */
export type FacadePromotionOutcome =
  | "promoted"
  | "pending_extraction"
  | "needs_review"
  | "quarantined"
  | "rejected"
  | "revoked"
  | "not_gated"
  | "unresolved";

export interface FacadePromotion {
  readonly outcome: FacadePromotionOutcome;
  /** True when a human still has to answer before this becomes believable. */
  readonly requires_review: boolean;
  readonly reason_codes: readonly string[];
  readonly policy_version: string | null;
  readonly claim_id: string | null;
  /** Every candidate the extraction produced for this event. */
  readonly candidate_ids: readonly string[];
  /** Plain-language statement of what happened, suitable for a log line or a console. */
  readonly detail: string;
}

export interface FacadeAddResult {
  readonly event_id: string;
  readonly seq: number;
  readonly extraction: EventAppendResponse["extraction"];
  readonly deduplicated: boolean;
  /** The scope the write was admitted into, after the facade's defaults were applied. */
  readonly scope: WriteScope;
  readonly promotion: FacadePromotion;
  readonly latency_ms: number;
}

/** Options for {@link MemoryFacade.add}. */
export interface FacadeAddOptions {
  /**
   * Declares that the caller wants an ungated comparison. Recorded in
   * `metrics().gate_disabled_count`; it cannot and does not disable the gate.
   */
  readonly disableGate?: boolean;
  readonly origin?: OriginKind;
  readonly actorId?: string;
  readonly scope?: Partial<WriteScope> & { tenant?: string };
  readonly occurredAt?: string;
  readonly purpose?: readonly string[];
  readonly sensitivity?: "normal" | "private" | "high";
  readonly idempotencyKey?: string;
  readonly streamId?: string;
}

/** Options for {@link MemoryFacade.awaitPromotion} and {@link MemoryFacade.promotionOf}. */
export interface PromotionWaitOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

/** Options for {@link MemoryFacade.search}. */
export interface FacadeSearchOptions {
  readonly scope?: Partial<WriteScope> & { tenant?: string };
  readonly purpose?: string | readonly string[];
  readonly time?: TimeSpec;
  readonly actionRisk?: "low" | "medium" | "high";
  readonly kinds?: readonly ClaimKind[];
  readonly subjects?: readonly string[];
  readonly limit?: number;
}

/**
 * Search result in the facade's vocabulary.
 *
 * `decision` and `packet` are both returned: `claims` is what a Mem0 user
 * expects, the packet is what VerityMem actually produces. Dropping the packet
 * would hide the six separate dimensions that are the point of the product.
 */
export interface FacadeSearchResult {
  readonly claims: MemoryPacket["claims"];
  readonly decision: UseDecision;
  readonly decision_reason_codes: readonly string[];
  readonly trace_id: string;
  readonly missing: readonly string[];
  readonly packet: MemoryPacket;
}

export interface VerityMemFacadeOptions {
  /** Injected client, for tests. Ignored when `baseUrl`, `token` or `fetch` are given. */
  readonly client?: VerityMemClient;
  readonly baseUrl?: string;
  readonly token?: string;
  readonly adminToken?: string;
  readonly fetch?: ConstructorParameters<typeof VerityMemClient>[0]["fetch"];
  /**
   * Tenant every facade call defaults into. Required in practice: a `ScopeSelector`
   * always names a tenant, because an application that omits it is asking the
   * wrong question.
   */
  readonly tenant?: string;
  readonly actorId?: string;
  readonly project?: string;
  readonly userId?: string;
  readonly agentId?: string;
  readonly sessionId?: string;
  /** Purpose recorded on every write and read. Defaults to `agent_memory`. */
  readonly purpose?: string;
}

/** The defaults a facade applies when a call site omits a dimension. */
interface FacadeDefaults {
  readonly tenant: string;
  readonly actorId: string;
  readonly purpose: string;
  readonly project?: string;
  readonly user?: string;
  readonly agent?: string;
  readonly session?: string;
}

const DEFAULT_PURPOSE = "agent_memory";
const DEFAULT_ACTOR = "agent";
const DEFAULT_PROMOTION_TIMEOUT_MS = 4_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

/**
 * Mem0-shaped facade over the VerityMem write and read paths.
 *
 * Read the file header before using it in anything but the demand test: the
 * whole reason it exists is to make one assumption measurable, and its return
 * values are shaped to keep the commit gate visible rather than to be pretty.
 */
export class MemoryFacade {
  private readonly client: VerityMemClient;
  private readonly defaults: FacadeDefaults;

  private adds = 0;
  private searches = 0;
  private explains = 0;
  private gateDisabled = 0;
  private reviewsRequired = 0;
  private addLatencyTotalMs = 0;

  constructor(options: VerityMemFacadeOptions) {
    if (options.client !== undefined) {
      this.client = options.client;
    } else {
      this.client = new VerityMemClient({
        baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
        ...(options.token === undefined ? {} : { token: options.token }),
        ...(options.adminToken === undefined ? {} : { adminToken: options.adminToken }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
    }
    this.defaults = {
      tenant: options.tenant ?? "default",
      actorId: options.actorId ?? DEFAULT_ACTOR,
      purpose: options.purpose ?? DEFAULT_PURPOSE,
      ...(options.project === undefined ? {} : { project: options.project }),
      ...(options.userId === undefined ? {} : { user: options.userId }),
      ...(options.agentId === undefined ? {} : { agent: options.agentId }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    };
  }

  /**
   * `add(content)` — appends an event and reports where it stands with the gate.
   *
   * Equivalent to Mem0's `add()` in shape and different in kind. Mem0's `add()`
   * means "stored"; this one means "appended", and the returned `promotion` says
   * what the commit gate has done so far. Callers who only want the id read
   * `event_id`. Callers who want the gate's verdict call `awaitPromotion(result)`
   * or read `promotion.outcome` and accept that it may be `pending_extraction`.
   */
  async add(content: string, options: FacadeAddOptions = {}): Promise<FacadeAddResult> {
    this.adds += 1;
    if (options.disableGate === true) this.gateDisabled += 1;

    const scope = this.writeScope(options);
    const startedAt = performance.now();
    const appended = await this.client.appendEvent({
      stream_id: options.streamId ?? `facade:${scope.tenant}`,
      origin: options.origin ?? "agent",
      actor_id: options.actorId ?? this.defaults.actorId,
      scope,
      occurred_at: options.occurredAt ?? new Date().toISOString(),
      content,
      ...(options.idempotencyKey === undefined ? {} : { idempotency_key: options.idempotencyKey }),
      ...(options.sensitivity === undefined ? {} : { sensitivity: options.sensitivity }),
    });
    const latencyMs = performance.now() - startedAt;
    this.addLatencyTotalMs += latencyMs;

    const promotion = this.pendingPromotion(appended, content.length);
    if (promotion.requires_review) this.reviewsRequired += 1;

    return {
      event_id: appended.event_id,
      seq: appended.seq,
      extraction: appended.extraction,
      deduplicated: appended.deduplicated,
      scope,
      promotion,
      latency_ms: round(latencyMs),
    };
  }

  /**
   * Waits for the commit gate and returns its real outcome.
   *
   * `POST /v1/events/{id}/extract` runs extraction and the gate synchronously and
   * answers with the decisions, which is the only honest way to learn what
   * happened: no model call can set `status = accepted`, and the facade must not
   * pretend the append was a belief. Re-extraction is idempotent and the
   * projections are disposable, so running it for a caller who wants the answer
   * now is a read of derived state, not a second write.
   *
   * Idempotent outcomes are not re-decided: an event whose earlier extraction
   * produced no candidates because its payload was redacted, or an append that
   * was deduplicated, reports `not_gated` immediately instead of burning a round
   * trip on a gate that has nothing to look at.
   */
  async awaitPromotion(result: FacadeAddResult, options: PromotionWaitOptions = {}): Promise<FacadePromotion> {
    const outcome = await this.promotionOf(result.event_id, options);
    if (outcome.requires_review) this.reviewsRequired += 1;
    return outcome;
  }

  /**
   * The gate outcome for an event already appended.
   *
   * Separate from {@link awaitPromotion} so a caller holding an event id from an
   * earlier session can ask what became of it without re-appending anything.
   */
  async promotionOf(eventId: string, options: PromotionWaitOptions = {}): Promise<FacadePromotion> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROMOTION_TIMEOUT_MS;
    const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = performance.now() + timeoutMs;
    let lastDetail = "";

    for (;;) {
      try {
        const extraction = await this.client.extractEvent(eventId);
        const promotion = promotionFromExtraction(extraction);
        // A decision exists, or the gate had nothing to decide. Either way there is
        // nothing further to wait for.
        if (promotion.outcome !== "pending_extraction") return promotion;
        lastDetail = promotion.detail;
      } catch (error) {
        // A 404 means extraction has not caught up with the append yet. Anything
        // else — a denial, a transport failure — is a real answer and must surface
        // rather than be polled away.
        if (!(isVerityMemError(error) && (error.isNotFound || error.status === 409))) throw error;
        lastDetail = `Extraction has not reported yet (${error.code}).`;
      }

      if (performance.now() >= deadline) {
        return {
          outcome: "pending_extraction",
          requires_review: false,
          reason_codes: [],
          policy_version: null,
          claim_id: null,
          candidate_ids: [],
          detail: `${lastDetail} No decision within ${timeoutMs} ms; the write is durably appended but not yet believed.`,
        };
      }
      await sleep(intervalMs);
    }
  }

  /** `search(query)` — maps onto `POST /v1/query` and returns the claims. */
  async search(query: string, options: FacadeSearchOptions = {}): Promise<FacadeSearchResult> {
    this.searches += 1;
    const packet = await this.client.query(this.queryRequest(query, options));
    return {
      claims: packet.claims,
      decision: packet.decision,
      decision_reason_codes: packet.decision_reason_codes,
      trace_id: packet.trace_id,
      missing: packet.missing,
      packet,
    };
  }

  /**
   * The full promotion history of a claim.
   *
   * Counted in `metrics().explains` because whether anyone calls it is the
   * decisive demand signal, not a convenience method.
   */
  async explain(claimId: string): Promise<ClaimExplanation> {
    this.explains += 1;
    return await this.client.explainClaim(claimId);
  }

  /** Current demand-test counters. A snapshot; calling it does not reset anything. */
  metrics(): FacadeMetrics {
    return {
      adds: this.adds,
      searches: this.searches,
      explains: this.explains,
      gate_disabled_count: this.gateDisabled,
      reviews_required: this.reviewsRequired,
      mean_add_latency_ms: this.adds === 0 ? 0 : round(this.addLatencyTotalMs / this.adds),
    };
  }

  /**
   * Wraps a client so that `explainClaim` calls made outside this facade still
   * move `metrics().explains`.
   *
   * Without this, the demand signal undercounts exactly the users who like the
   * facade for writes but reach past it to `/explain` — the population the
   * thesis depends on.
   */
  countingClient(): VerityMemClient {
    const facade = this;
    return new Proxy(this.client, {
      get(target, property, receiver) {
        if (property === "explainClaim") {
          return async (claimId: string) => {
            facade.explains += 1;
            return await target.explainClaim(claimId);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  // -------------------------------------------------------------------------

  private pendingPromotion(appended: EventAppendResponse, contentLength: number): FacadePromotion {
    const base = {
      reason_codes: [] as readonly string[],
      policy_version: null,
      claim_id: null,
      candidate_ids: [] as readonly string[],
    };
    if (appended.deduplicated) {
      return {
        ...base,
        outcome: "not_gated",
        requires_review: false,
        detail: "Idempotency key matched an existing event; nothing was appended and nothing was proposed to the gate.",
      };
    }
    if (appended.extraction !== "queued") {
      return {
        ...base,
        outcome: "not_gated",
        requires_review: false,
        detail: `Extraction state is "${appended.extraction}"; no candidate will reach the commit gate for this ${contentLength}-character event.`,
      };
    }
    return {
      ...base,
      outcome: "pending_extraction",
      requires_review: false,
      detail: "Append acknowledged durably. Extraction is asynchronous; call awaitPromotion() for the gate's verdict.",
    };
  }

  private writeScope(options: FacadeAddOptions): WriteScope {
    const merged = { ...this.defaults, ...options.scope };
    const purpose = options.purpose ?? options.scope?.purpose ?? [this.defaults.purpose];
    return {
      tenant: merged.tenant,
      purpose: [...purpose],
      ...(merged.project === undefined ? {} : { project: merged.project }),
      ...(merged.user === undefined ? {} : { user: merged.user }),
      ...(merged.agent === undefined ? {} : { agent: merged.agent }),
      ...(merged.session === undefined ? {} : { session: merged.session }),
    };
  }

  private queryRequest(query: string, options: FacadeSearchOptions): QueryRequest {
    const merged = { ...this.defaults, ...options.scope };
    const purpose = options.purpose === undefined ? this.defaults.purpose : firstPurpose(options.purpose);
    return {
      query,
      purpose,
      scope: {
        tenant: merged.tenant,
        ...(merged.project === undefined ? {} : { project: merged.project }),
        ...(merged.user === undefined ? {} : { user: merged.user }),
        ...(merged.agent === undefined ? {} : { agent: merged.agent }),
        ...(merged.session === undefined ? {} : { session: merged.session }),
      },
      ...(options.time === undefined ? {} : { time: options.time }),
      ...(options.actionRisk === undefined ? {} : { action_risk: options.actionRisk }),
      ...(options.kinds === undefined ? {} : { kinds: [...options.kinds] }),
      ...(options.subjects === undefined ? {} : { subjects: [...options.subjects] }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    };
  }
}

/**
 * Maps an extraction result onto the facade's outcome vocabulary.
 *
 * Exhaustive over `DecisionOutcome` so that adding an outcome to the contract is
 * a compile error here rather than an unlabelled pass-through. A `contradicts`
 * relation recorded by the gate is surfaced in the detail text, because "accepted
 * alongside unresolved conflict" is a different fact from "accepted cleanly" and
 * a facade that flattened the two would be hiding the thing it exists to expose.
 */
export function promotionFromExtraction(extraction: EventExtractResponse): FacadePromotion {
  const candidateIds = [...extraction.candidates];
  const base = {
    candidate_ids: candidateIds,
    reason_codes: [] as readonly string[],
    policy_version: null as string | null,
    claim_id: null as string | null,
  };

  if (!extraction.extracted) {
    return {
      ...base,
      outcome: "not_gated",
      requires_review: false,
      detail: "The event payload is no longer available (redacted under retention), so nothing could be extracted or gated.",
    };
  }
  if (extraction.candidates.length === 0) {
    return {
      ...base,
      outcome: "not_gated",
      requires_review: false,
      detail: `Extraction produced no candidate, so nothing reached the commit gate. Extraction versions: ${extraction.extractor_versions.join(", ") || "(none)"}.`,
    };
  }

  const decision = extraction.decisions.at(-1);
  if (decision === undefined) {
    return {
      ...base,
      outcome: "pending_extraction",
      requires_review: false,
      detail: `${candidateIds.length} candidate(s) were extracted but no decision is recorded yet. Nothing is believed.`,
    };
  }

  const withDecision = {
    candidate_ids: candidateIds,
    reason_codes: [...decision.reason_codes],
    policy_version: decision.policy_version,
    claim_id: decision.claim_id,
  };
  const outcome: DecisionOutcome = decision.outcome;
  switch (outcome) {
    case "accept":
      return { ...withDecision, outcome: "promoted", requires_review: false, detail: "The commit gate accepted this claim into the claim store." };
    case "accept_limited_scope":
      return {
        ...withDecision,
        outcome: "promoted",
        requires_review: false,
        detail: "Accepted at a narrower scope than requested. Scope broadening is downgraded, never upgraded.",
      };
    case "needs_review":
      return { ...withDecision, outcome: "needs_review", requires_review: true, detail: "No gate rule matched decisively; a human must decide. This write is not believed." };
    case "quarantine":
      return { ...withDecision, outcome: "quarantined", requires_review: true, detail: "Quarantined pending review: identity, permission, money, safety or executable-procedure risk." };
    case "reject":
      return { ...withDecision, outcome: "rejected", requires_review: false, detail: `Rejected: ${decision.reason_codes.join(", ") || "an unmet gate precondition"}.` };
    case "revoke":
      return { ...withDecision, outcome: "revoked", requires_review: false, detail: "Revoked; this claim must never be used." };
    default:
      // `decision.outcome` is a closed union, so reaching here means the server
      // sent something the contracts do not describe. Saying so beats inventing
      // "accepted" — that invention is the failure this system exists to prevent.
      return {
        ...withDecision,
        outcome: "unresolved",
        requires_review: true,
        detail: `The gate reported outcome ${JSON.stringify(outcome)}, which this SDK cannot interpret. Treat as unresolved, not as accepted.`,
      };
  }
}

function firstPurpose(purpose: string | readonly string[]): string {
  if (typeof purpose === "string") return purpose;
  const first = purpose[0];
  if (first === undefined) throw new TypeError("search() requires at least one purpose; no purpose means unreachable.");
  return first;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
