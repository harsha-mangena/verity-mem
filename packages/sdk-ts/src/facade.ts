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
 *      calls made through this facade (and through a client wrapped by
 *      `countingClient()`).
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
 *     facade means "stored"; here it means "appended, and here is what the gate
 *     did or did not yet do with it".
 *   - `reviews_required` is counted, because review burden above 2% of writes is
 *     specified as a product failure rather than an ops metric.
 *
 * `disableGate` therefore has one honest meaning and is documented as such: the
 * caller is declaring that they intend to run their own comparison against an
 * ungated baseline. Use `metrics()` to see how many people do.
 */
import type {
  AuthorityClass,
  ClaimExplanation,
  ClaimKind,
  EventAppendResponse,
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
 * deliberately excludes the promotion poll, which is dominated by the
 * asynchronous extractor and would make the number describe queue depth rather
 * than the write latency a developer actually experiences at the call site.
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
 * front of the gate, and reporting that as "accepted" would be the exact
 * promotion collapse the system exists to prevent.
 */
export type FacadePromotionOutcome =
  | "promoted"
  | "promoted_limited_scope"
  | "pending_extraction"
  | "needs_review"
  | "quarantined"
  | "rejected"
  | "revoked"
  | "unresolved"
  | "not_gated";

export interface FacadePromotion {
  readonly outcome: FacadePromotionOutcome;
  /** True when a human still has to answer before this becomes believable. */
  readonly requires_review: boolean;
  readonly reason_codes: readonly string[];
  readonly policy_version: string | null;
  readonly claim_id: string | null;
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
  /**
   * Wait for the asynchronous extraction and gate to report an outcome, so that
   * `promotion` is a real answer instead of `pending_extraction`. Default `true`.
   */
  readonly awaitPromotion?: boolean;
  /** How long to wait for the promotion outcome. Default 4000 ms. */
  readonly promotionTimeoutMs?: number;
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

const DEFAULT_PURPOSE = "agent_memory";
const DEFAULT_ACTOR = "agent";

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
      ...(options.sessionId === undefined ? {} : { session: options.sessionId }),
    };
  }

  /** The client this facade wraps, so `explain` calls made directly can also be counted. */
  get rawClient(): VerityMemClient {
    return this.client;
  }

  /**
   * `add(content)` — appends an event and reports what the gate did with it.
   *
   * Equivalent to Mem0's `add()` in shape and different in kind: nothing is
   * believed until the commit gate says so, so the return value carries the
   * promotion outcome instead of an id. Callers who only want the id read
   * `event_id`; callers who want to know whether their agent just wrote a durable
   * belief read `promotion`.
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

    const promotion = await this.promotionFor(appended, options);
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

  private writeScope(options: FacadeAddOptions): WriteScope {
    const merged = { ...this.defaults, ...options.scope };
    const purpose = options.purpose ?? (options.scope?.purpose ?? [this.defaults.purpose]);
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

  /**
   * Turns an append acknowledgement into a promotion outcome.
   *
   * The gate runs asynchronously after the durable append, so this polls
   * `GET /v1/candidates/{event_id}` — the ingest pipeline keys candidates by
   * their originating event — until a decision appears. Polling is bounded and a
   * timeout is reported as `pending_extraction`, never as success: an unanswered
   * gate is not an accepted claim.
   *
   * The poll reads the decision off a `promotion` object on the candidate
   * response. `ClaimCandidate` in `packages/contracts` does not include that
   * object, so this is the facade's one dependency on a server response field the
   * contracts do not freeze. When it is absent the outcome is reported as
   * `unresolved`, never guessed, and `packages/sdk-ts/src/sdk.test.ts` pins that
   * behaviour.
   */
  private async promotionFor(
    appended: EventAppendResponse,
    options: FacadeAddOptions,
  ): Promise<FacadePromotion> {
    if (appended.extraction !== "queued") {
      return {
        outcome: "not_gated",
        requires_review: false,
        reason_codes: [],
        policy_version: null,
        claim_id: null,
        detail:
          appended.deduplicated
            ? "Idempotency key matched an existing event; nothing was appended and nothing was proposed to the gate."
            : `Extraction state is "${appended.extraction}"; no candidate reached the commit gate.`,
      };
    }

    if (options.awaitPromotion === false) {
      return {
        outcome: "pending_extraction",
        requires_review: false,
        reason_codes: [],
        policy_version: null,
        claim_id: null,
        detail: "Append acknowledged. Extraction is asynchronous and was not awaited; nothing is believed yet.",
      };
    }

    const deadline = performance.now() + (options.promotionTimeoutMs ?? 4_000);
    let lastError: unknown;
    for (;;) {
      try {
        const candidate = await this.client.getCandidate(appended.event_id);
        if (candidate.state === "gated") return promotionFromDecision(candidate);
      } catch (error) {
        // A 404 means extraction has not produced a candidate row yet; anything
        // else is a real failure and must surface rather than be polled away.
        if (!(isVerityMemError(error) && (error.status === 404 || error.status === 409))) throw error;
        lastError = error;
      }
      if (performance.now() >= deadline) {
        return {
          outcome: "pending_extraction",
          requires_review: false,
          reason_codes: [],
          policy_version: null,
          claim_id: null,
          detail: `No decision within ${options.promotionTimeoutMs ?? 4_000} ms; the write is durably appended but not yet believed.${
            lastError === undefined ? "" : " Last poll failed with " + describe(lastError) + "."
          }`,
        };
      }
      await sleep(50);
    }
  }
}

/**
 * Maps a gated candidate onto the facade's outcome vocabulary.
 *
 * Exhaustive over `DecisionOutcome` so that adding an outcome to the contract is
 * a compile error here rather than an unlabelled pass-through.
 *
 * The parameter is structurally open (`[key: string]: unknown`) because the
 * server attaches the decision to this response and `ClaimCandidate` in
 * `packages/contracts` does not describe it yet. An open shape here records that
 * uncertainty instead of asserting a field the contracts have not frozen.
 */
function promotionFromDecision(candidate: {
  readonly promotion?: {
    readonly outcome?: string | null;
    readonly reason_codes?: readonly string[];
    readonly policy_version?: string | null;
    readonly claim_id?: string | null;
  };
  readonly claim_id?: string | null;
  readonly [key: string]: unknown;
}): FacadePromotion {
  const outcome = candidate.promotion?.outcome ?? null;
  const reasonCodes = candidate.promotion?.reason_codes ?? [];
  const policyVersion = candidate.promotion?.policy_version ?? null;
  const claimId = candidate.promotion?.claim_id ?? candidate.claim_id ?? null;
  switch (outcome) {
    case "accept":
      return { outcome: "promoted", requires_review: false, reason_codes: reasonCodes, policy_version: policyVersion, claim_id: claimId, detail: "The commit gate accepted this claim into the claim store." };
    case "accept_limited_scope":
      return { outcome: "promoted_limited_scope", requires_review: false, reason_codes: reasonCodes, policy_version: policyVersion, claim_id: claimId, detail: "Accepted at a narrower scope than requested. Scope broadening is downgraded, never upgraded." };
    case "needs_review":
      return { outcome: "needs_review", requires_review: true, reason_codes: reasonCodes, policy_version: policyVersion, claim_id: claimId, detail: "No gate rule matched decisively; a human must decide. This write is not believed." };
    case "quarantine":
      return { outcome: "quarantined", requires_review: true, reason_codes: reasonCodes, policy_version: policyVersion, claim_id: claimId, detail: "Quarantined pending review: identity, permission, money, safety or executable-procedure risk." };
    case "reject":
      return { outcome: "rejected", requires_review: false, reason_codes: reasonCodes, policy_version: policyVersion, claim_id: claimId, detail: "Rejected: no resolvable supporting span, an entailed contradiction, or an unmet gate precondition." };
    case "revoke":
      return { outcome: "revoked", requires_review: false, reason_codes: reasonCodes, policy_version: policyVersion, claim_id: claimId, detail: "Revoked; this claim must never be used." };
    default:
      // A gated candidate always carries an outcome. Reaching here means the
      // server changed shape — or omitted the gate decision entirely — and
      // saying so beats inventing "accepted".
      return {
        outcome: "unresolved",
        requires_review: true,
        reason_codes: reasonCodes,
        policy_version: policyVersion,
        claim_id: claimId,
        detail: `Candidate is gated but reported outcome ${JSON.stringify(outcome)}, which this SDK cannot interpret. Treat as unresolved, not as accepted.`,
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Re-exported so a caller can type an authority class without a second import. */
export type { AuthorityClass };
