/**
 * Typed client for the VerityMem REST API.
 *
 * One method per route in the specification's "API design" section, and every
 * return type is the `@veritymem/contracts` schema the server declares for that
 * route — including the HTTP response envelopes in `contracts/responses.ts`,
 * which are the shapes the routes actually send rather than the domain objects
 * they are built from. Nothing is re-shaped and no field is renamed, so a
 * contract change surfaces here as a compile error instead of an `undefined` at a
 * call site.
 *
 * The one route that is not in the specification's list is the action gate. It is
 * implemented anyway (see {@link VerityMemClient.gateAction}) because the
 * specification calls the action gate the only real enforcement point, and an
 * enforcement point that a non-JavaScript adapter cannot reach is not one.
 */
import type {
  ActionGateHTTPResponse,
  ActionGateRequest,
  CandidateReadResponse,
  ClaimExplanation,
  ClaimReadResponse,
  ClaimReverifyResponse,
  ContextComposeResponse,
  DecisionRequest,
  DecisionResponse,
  EvaluationRunRequest,
  EvaluationRunResult,
  EventAppendRequest,
  EventAppendResponse,
  EventExtractResponse,
  EventRecord,
  FeedbackRequest,
  FeedbackResponse,
  ForgetRequest,
  ForgetResponse,
  GrantCreateRequest,
  GrantCreateResponse,
  GrantDeleteResponse,
  MemoryPacket,
  QueryRequest,
  QueryTraceResponse,
  RelationCreateRequest,
  RelationCreateResponse,
  ReplayRequest,
  ReplayResultResponse,
} from "@veritymem/contracts";
import { VerityMemError, type VerityMemErrorBody } from "./errors.ts";

/** Accepted by `globalThis.fetch`; injectable so tests never need a socket. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Client configuration.
 *
 * Two credentials rather than one because the server keeps a separate audience
 * for the admin routes: reusing an agent token for `/v1/grants` would be the
 * "agent token that can reach /v1/forget" design failure the specification names.
 */
export interface VerityMemClientOptions {
  /** Origin of the API, e.g. `http://127.0.0.1:8080`. No trailing slash required. */
  readonly baseUrl: string;
  /** Bearer credential for the agent-facing audience. */
  readonly token?: string;
  /**
   * Credential for the admin audience.
   *
   * `/v1/grants` and `/v1/forget` require it. The server holds a separate audience
   * for those routes on purpose: "an agent token that can reach `/v1/grants` or
   * `/v1/forget` is a design failure", so the SDK will not silently reuse the
   * agent token for them.
   */
  readonly adminToken?: string;
  /** Injected transport. Defaults to the runtime's `fetch`. */
  readonly fetch?: FetchLike;
  /** Per-request timeout in milliseconds. `0` disables the timeout. */
  readonly timeoutMs?: number;
  /** Extra headers sent on every request, e.g. a trace propagator. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Overrides the action-gate route. Defaults to the server's `/v1/actions/gate`. */
  readonly actionGatePath?: string;
}

/**
 * Typed client over the VerityMem REST API.
 *
 * Constructed with an injectable `fetch` so a test can exercise every route
 * without a socket, and so a deployment can supply instrumentation around the
 * transport without forking this class.
 */
export class VerityMemClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly adminToken: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  private actionGatePath: string;

  constructor(options: VerityMemClientOptions) {
    if (options.baseUrl.trim() === "") {
      // A client with no origin fails at the first call with an opaque fetch
      // error; failing at construction names the actual mistake.
      throw new TypeError("VerityMemClient requires a non-empty baseUrl");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.adminToken = options.adminToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.extraHeaders = options.headers ?? {};
    this.actionGatePath = options.actionGatePath ?? "/v1/actions/gate";
  }

  // -------------------------------------------------------------------------
  // Evidence and claims
  // -------------------------------------------------------------------------

  /**
   * `POST /v1/events` — appends an event to the canonical ledger. Answers 202.
   *
   * The response reports extraction state rather than awaiting it: durability is
   * acknowledged before extraction, so a model outage degrades the system to
   * "unextracted" instead of "lost".
   */
  async appendEvent(request: EventAppendRequest): Promise<EventAppendResponse> {
    return await this.request<EventAppendResponse>("POST", "/v1/events", request);
  }

  /** `GET /v1/events/{event_id}` — the stored event, with its chain and digest fields. */
  async getEvent(eventId: string): Promise<EventRecord> {
    return await this.request<EventRecord>("GET", `/v1/events/${encodeURIComponent(eventId)}`);
  }

  /**
   * `POST /v1/events/{event_id}/extract` — re-runs extraction, synchronously.
   *
   * Accepted claims are projected in the same transaction, so the response is the
   * promotion outcome for this event rather than a queue acknowledgement: this is
   * the route a caller uses to learn what the commit gate decided right now.
   */
  async extractEvent(eventId: string): Promise<EventExtractResponse> {
    return await this.request<EventExtractResponse>("POST", `/v1/events/${encodeURIComponent(eventId)}/extract`, {});
  }

  /**
   * `GET /v1/candidates/{candidate_id}` — an untrusted proposal plus the decisions
   * already recorded against it. A candidate is never a belief.
   */
  async getCandidate(candidateId: string): Promise<CandidateReadResponse> {
    return await this.request<CandidateReadResponse>("GET", `/v1/candidates/${encodeURIComponent(candidateId)}`);
  }

  /**
   * `POST /v1/candidates/{candidate_id}/decisions` — records a promotion decision.
   *
   * This is the human-review path. It does not exist so that a model can promote
   * its own proposal: the caller is the operator answering a `needs_review` or
   * `quarantine` outcome, and the decision records who answered. A refusal
   * (`reject`, `quarantine`, `needs_review`) is a 200 with that outcome, not an
   * error, so `claim_created: false` is the field to branch on.
   */
  async decideCandidate(candidateId: string, request: DecisionRequest): Promise<DecisionResponse> {
    return await this.request<DecisionResponse>(
      "POST",
      `/v1/candidates/${encodeURIComponent(candidateId)}/decisions`,
      request,
    );
  }

  /** `GET /v1/claims/{claim_id}` — a believed claim with its relations and six separate dimensions. */
  async getClaim(claimId: string): Promise<ClaimReadResponse> {
    return await this.request<ClaimReadResponse>("GET", `/v1/claims/${encodeURIComponent(claimId)}`);
  }

  /**
   * `POST /v1/claims/{claim_id}/relations` — records an explicit relation.
   *
   * Contradiction is never inferred from timestamp adjacency, so this is the only
   * way a `contradicts` or `supersedes` edge comes into existence. Creation is
   * idempotent and reports `created: false` on a repeat.
   */
  async createRelation(claimId: string, request: RelationCreateRequest): Promise<RelationCreateResponse> {
    return await this.request<RelationCreateResponse>(
      "POST",
      `/v1/claims/${encodeURIComponent(claimId)}/relations`,
      request,
    );
  }

  /**
   * `POST /v1/claims/{claim_id}/reverify` — re-reads the claim's spans, re-checks
   * their digests and re-runs the current policy against it.
   */
  async reverifyClaim(claimId: string): Promise<ClaimReverifyResponse> {
    return await this.request<ClaimReverifyResponse>(
      "POST",
      `/v1/claims/${encodeURIComponent(claimId)}/reverify`,
      {},
    );
  }

  // -------------------------------------------------------------------------
  // Retrieval and explanation
  // -------------------------------------------------------------------------

  /**
   * `POST /v1/query` — one call that answers what is believed, on what evidence,
   * with what conflicts, how fresh, and whether the caller may act on it.
   */
  async query(request: QueryRequest): Promise<MemoryPacket> {
    return await this.request<MemoryPacket>("POST", "/v1/query", request);
  }

  /**
   * `POST /v1/context/compose` — the same packet, plus deterministically rendered
   * prose and the citations it rests on. Never a model call.
   */
  async composeContext(request: QueryRequest): Promise<ContextComposeResponse> {
    return await this.request<ContextComposeResponse>("POST", "/v1/context/compose", request);
  }

  /** `GET /v1/query-traces/{trace_id}` — the recorded plan, candidates and selection. */
  async getQueryTrace(traceId: string): Promise<QueryTraceResponse> {
    return await this.request<QueryTraceResponse>("GET", `/v1/query-traces/${encodeURIComponent(traceId)}`);
  }

  /**
   * `GET /v1/claims/{claim_id}/explain` — the full promotion history.
   *
   * The specification calls this endpoint "the product": if it is slow or
   * incomplete, nothing else about the system matters.
   */
  async explainClaim(claimId: string): Promise<ClaimExplanation> {
    return await this.request<ClaimExplanation>("GET", `/v1/claims/${encodeURIComponent(claimId)}/explain`);
  }

  // -------------------------------------------------------------------------
  // Sharing, correction, forgetting, operations
  // -------------------------------------------------------------------------

  /** `POST /v1/grants` — creates a time-bounded authorization for another principal. Answers 201. */
  async createGrant(request: GrantCreateRequest): Promise<GrantCreateResponse> {
    return await this.request<GrantCreateResponse>("POST", "/v1/grants", request, { admin: true });
  }

  /** `DELETE /v1/grants/{grant_id}` — revokes a grant. Answers 200 with `deleted`. */
  async deleteGrant(grantId: string): Promise<GrantDeleteResponse> {
    return await this.request<GrantDeleteResponse>("DELETE", `/v1/grants/${encodeURIComponent(grantId)}`, undefined, {
      admin: true,
    });
  }

  /**
   * `POST /v1/feedback` — labelled outcome of a query. Answers 201.
   *
   * Recorded as a ledger event, not as a mutable field: feedback produces labelled
   * decisions and eval data, never online learning.
   */
  async feedback(request: FeedbackRequest): Promise<FeedbackResponse> {
    return await this.request<FeedbackResponse>("POST", "/v1/feedback", request);
  }

  /**
   * `POST /v1/forget` — starts a retention job. Answers 201.
   *
   * Admin audience on purpose: an agent token that can reach this route is a
   * design failure, so it needs a separate credential.
   */
  async forget(request: ForgetRequest): Promise<ForgetResponse> {
    return await this.request<ForgetResponse>("POST", "/v1/forget", request, { admin: true });
  }

  /** `GET /v1/forget/{job_id}` — poll until `residual_matches` is 0 and status is `verified`. */
  async getForgetJob(jobId: string): Promise<ForgetResponse> {
    return await this.request<ForgetResponse>("GET", `/v1/forget/${encodeURIComponent(jobId)}`, undefined, {
      admin: true,
    });
  }

  /** `POST /v1/replay` — compares or rebuilds projections from the ledger. */
  async replay(request?: ReplayRequest): Promise<ReplayResultResponse> {
    return await this.request<ReplayResultResponse>("POST", "/v1/replay", request ?? {}, { admin: true });
  }

  /**
   * `POST /v1/evaluations/runs` — runs a benchmark suite and returns per-stage metrics.
   *
   * PROVISIONAL: `packages/contracts` freezes the response as `EvaluationRunResult`,
   * but `apps/server/src/routes` has no evaluations route registered as this
   * package was written. The method is here because the specification's route list
   * names it, and it will fail with a `not_found` `VerityMemError` until the route
   * lands — plainly rather than silently.
   */
  async runEvaluations(request: EvaluationRunRequest): Promise<EvaluationRunResult> {
    return await this.request<EvaluationRunResult>("POST", "/v1/evaluations/runs", request);
  }

  /**
   * `POST /v1/actions/gate` — the action gate, the enforcement point for use
   * decisions.
   *
   * The specification's REST list omits this path, but its own argument requires
   * it: "a `verify` or `deny` verdict in a packet does not bind an LLM — the only
   * real enforcement is the action gate", and an adapter in another process cannot
   * call a TypeScript function. `apps/server` mounts it at `/v1/actions/gate`.
   *
   * A refusal is a **200** with `allowed: false`. That is deliberate on the
   * server's side and it matters here: a blocked action is the gate working, not a
   * failed request, and an SDK that turned it into a thrown error would make every
   * adapter's retry logic wrong. Use {@link VerityMemError} for transport and
   * authorization failures, and read `allowed` for the verdict.
   */
  async gateAction(request: ActionGateRequest): Promise<ActionGateHTTPResponse> {
    return await this.request<ActionGateHTTPResponse>("POST", this.actionGatePath, request);
  }

  /**
   * Overrides the action-gate route.
   *
   * Kept because the path is not in the specification; a deployment that mounts it
   * elsewhere should not need an SDK release to say so.
   */
  setActionGatePath(path: string): this {
    this.actionGatePath = path.startsWith("/") ? path : `/${path}`;
    return this;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { admin?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", ...this.extraHeaders };
    if (body !== undefined) headers["content-type"] = "application/json";
    const credential = options.admin === true ? this.adminToken : this.token;
    if (credential !== undefined) headers["authorization"] = `Bearer ${credential}`;

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (this.timeoutMs > 0) init.signal = AbortSignal.timeout(this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      // Status 0 marks "no answer", which is a different situation from any HTTP
      // status and must not be mistaken for a denial.
      throw new VerityMemError({
        status: 0,
        code: "network_error",
        message: `${method} ${path} could not be sent: ${cause instanceof Error ? cause.message : String(cause)}`,
        path,
        cause,
      });
    }

    const raw = await response.text();
    const parsed = parseJsonOrUndefined(raw);

    if (!response.ok) {
      // The server nests the machine-readable fields under `error`; a bare `code`
      // is tolerated in case an intermediary rewrites the envelope.
      const envelope = (typeof parsed === "object" && parsed !== null ? parsed : {}) as VerityMemErrorBody;
      const errorField = envelope.error;
      const code = typeof errorField?.code === "string" ? errorField.code : typeof envelope.code === "string" ? envelope.code : "unknown_error";
      const message =
        typeof errorField?.message === "string"
          ? errorField.message
          : typeof envelope.message === "string"
            ? envelope.message
            : `${method} ${path} failed with HTTP ${response.status}`;
      throw new VerityMemError({
        status: response.status,
        code,
        message,
        path,
        details: errorField?.details,
        body: parsed,
      });
    }

    if (parsed === undefined) {
      throw new VerityMemError({
        status: response.status,
        code: "invalid_response",
        message: `${method} ${path} returned HTTP ${response.status} with a body that is not JSON`,
        path,
        body: raw,
      });
    }
    return parsed as T;
  }
}

/**
 * Parses a body without throwing.
 *
 * An empty body is not an error here; `undefined` means "no JSON body", and only a
 * non-empty non-JSON body is reported as malformed by the caller.
 */
function parseJsonOrUndefined(raw: string): unknown {
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
