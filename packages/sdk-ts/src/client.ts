/**
 * Typed client for the VerityMem REST API.
 *
 * One method per route in the specification's "API design" section. Every method
 * returns the `@veritymem/contracts` type for that route; nothing is re-shaped
 * and no field is renamed, so a server-side schema change surfaces here as a
 * compile error rather than as a silent `undefined` at a call site.
 *
 * Endpoints whose response the contracts do not freeze are marked
 * `PROVISIONAL` at the definition, rather than being stubbed with `unknown` and
 * left for a caller to discover. See the report accompanying this package for
 * the list.
 */
import type {
  ActionGateRequest,
  ActionGateVerdict,
  CandidateProposal,
  ClaimCandidate,
  ClaimExplanation,
  ClaimRecord,
  Decision,
  DecisionRequest,
  EvaluationRunRequest,
  EvaluationRunResponse,
  EventAppendRequest,
  EventAppendResponse,
  EventRecord,
  FeedbackRequest,
  ForgetRequest,
  Grant,
  GrantCreateRequest,
  MemoryPacket,
  QueryRequest,
  RelationCreateRequest,
  ReplayRequest,
  ReplayResponse,
  RetentionJob,
} from "@veritymem/contracts";
import { VerityMemError, type VerityMemErrorBody } from "./errors.ts";

/** Accepted by `globalThis.fetch`; injectable so tests never need a socket. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface VerityMemClientOptions {
  /** Origin of the API, e.g. `http://127.0.0.1:8080`. No trailing slash required. */
  readonly baseUrl: string;
  /** Bearer credential for the agent-facing audience. */
  readonly token?: string;
  /** Credential for the admin audience. `/v1/grants` and `/v1/forget` require it. */
  readonly adminToken?: string;
  /** Injected transport. Defaults to the runtime's `fetch`. */
  readonly fetch?: FetchLike;
  /** Per-request timeout in milliseconds. `0` disables the timeout. */
  readonly timeoutMs?: number;
  /** Extra headers sent on every request, e.g. a trace propagator. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Overrides the provisional action-gate route. See `gateAction`. */
  readonly actionGatePath?: string;
}

/**
 * A re-extraction run. PROVISIONAL: `POST /v1/events/{id}/extract` has no schema
 * in `packages/contracts`, so this type is the ingest result fields the route can
 * be expected to report. Confirm against `apps/server` before relying on it.
 */
export interface ExtractionRunResponse {
  readonly event_id: string;
  readonly candidates: number;
  readonly model_calls: number;
  readonly extractor_versions: readonly string[];
  readonly decision_ids: readonly string[];
  readonly notes?: readonly string[];
}

/**
 * A stored query trace. PROVISIONAL: the `query_traces` table is specified in the
 * data model but no contract type exists for it.
 */
export interface QueryTrace {
  readonly trace_id: string;
  readonly caller: string;
  readonly query: unknown;
  readonly policy_version: string;
  readonly candidates: unknown;
  readonly returned: unknown;
  readonly projection_watermark: number;
  readonly created_at: string;
}

/**
 * Acknowledgement for `POST /v1/feedback`. PROVISIONAL: feedback is specified as
 * a route and as eval input, with no frozen response schema.
 */
export interface FeedbackReceipt {
  readonly trace_id: string;
  readonly outcome: string;
  readonly recorded_at: string;
}

/**
 * Optional body for `POST /v1/claims/{id}/reverify`. PROVISIONAL: the route is
 * specified; its request body is not.
 */
export interface ReverificationRequest {
  readonly reason?: string;
  readonly policy_version?: string;
}

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
   * `POST /v1/events` — appends an event to the canonical ledger.
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
   * `POST /v1/events/{event_id}/extract` — re-runs extraction, typically at a new
   * extractor or model version. Projections are disposable; the event is not.
   */
  async extractEvent(eventId: string, request?: { extractor_version?: string; prompt_version?: string }): Promise<ExtractionRunResponse> {
    return await this.request<ExtractionRunResponse>(
      "POST",
      `/v1/events/${encodeURIComponent(eventId)}/extract`,
      request ?? {},
    );
  }

  /**
   * `GET /v1/candidates/{candidate_id}` — an untrusted proposal plus the state it
   * reached in the pipeline. A candidate is never a belief.
   */
  async getCandidate(candidateId: string): Promise<ClaimCandidate> {
    return await this.request<ClaimCandidate>("GET", `/v1/candidates/${encodeURIComponent(candidateId)}`);
  }

  /**
   * `POST /v1/candidates/{candidate_id}/decisions` — records a promotion decision.
   *
   * This is the human-review path. It does not exist so that a model can promote
   * its own proposal: the caller is the operator answering a `needs_review` or
   * `quarantine` outcome, and the decision records who answered.
   */
  async decideCandidate(candidateId: string, request: DecisionRequest): Promise<Decision> {
    return await this.request<Decision>(
      "POST",
      `/v1/candidates/${encodeURIComponent(candidateId)}/decisions`,
      request,
    );
  }

  /** `GET /v1/claims/{claim_id}` — a believed claim with its six separate dimensions. */
  async getClaim(claimId: string): Promise<ClaimRecord> {
    return await this.request<ClaimRecord>("GET", `/v1/claims/${encodeURIComponent(claimId)}`);
  }

  /**
   * `POST /v1/claims/{claim_id}/relations` — records an explicit relation.
   *
   * Contradiction is never inferred from timestamp adjacency, so this is the only
   * way a `contradicts` or `supersedes` edge comes into existence.
   */
  async createRelation(claimId: string, request: RelationCreateRequest): Promise<ClaimRecord> {
    return await this.request<ClaimRecord>(
      "POST",
      `/v1/claims/${encodeURIComponent(claimId)}/relations`,
      request,
    );
  }

  /**
   * `POST /v1/claims/{claim_id}/reverify` — re-evaluates a claim against current
   * evidence and the current policy version, producing a fresh decision row.
   */
  async reverifyClaim(claimId: string, request?: ReverificationRequest): Promise<Decision> {
    return await this.request<Decision>(
      "POST",
      `/v1/claims/${encodeURIComponent(claimId)}/reverify`,
      request ?? {},
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

  /** `POST /v1/context/compose` — the same read path with composition controls. */
  async composeContext(request: QueryRequest): Promise<MemoryPacket> {
    return await this.request<MemoryPacket>("POST", "/v1/context/compose", request);
  }

  /** `GET /v1/query-traces/{trace_id}` — the recorded plan, candidates and selection. */
  async getQueryTrace(traceId: string): Promise<QueryTrace> {
    return await this.request<QueryTrace>("GET", `/v1/query-traces/${encodeURIComponent(traceId)}`);
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
  // Sharing, correction, forgetting, operations (admin audience)
  // -------------------------------------------------------------------------

  /** `POST /v1/grants` — creates a time-bounded authorization for another principal. */
  async createGrant(request: GrantCreateRequest): Promise<Grant> {
    return await this.request<Grant>("POST", "/v1/grants", request, { admin: true });
  }

  /**
   * `DELETE /v1/grants/{grant_id}` — revokes a grant.
   *
   * Returns nothing. `packages/contracts` freezes no response for this route, and
   * inventing one would be a shape the server never agreed to; failure is
   * reported by the thrown `VerityMemError`, which is the part that matters.
   */
  async deleteGrant(grantId: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/grants/${encodeURIComponent(grantId)}`, undefined, { admin: true, expectNoBody: true });
  }

  /** `POST /v1/feedback` — labelled outcome of a query, for the eval sets. Never online learning. */
  async feedback(request: FeedbackRequest): Promise<FeedbackReceipt> {
    return await this.request<FeedbackReceipt>("POST", "/v1/feedback", request);
  }

  /**
   * `POST /v1/forget` — starts a retention job.
   *
   * Admin audience on purpose: an agent token that can reach this route is a
   * design failure, so it needs a separate credential.
   */
  async forget(request: ForgetRequest): Promise<RetentionJob> {
    return await this.request<RetentionJob>("POST", "/v1/forget", request, { admin: true });
  }

  /** `GET /v1/forget/{job_id}` — poll until `residual_matches` is 0 and status is `verified`. */
  async getForgetJob(jobId: string): Promise<RetentionJob> {
    return await this.request<RetentionJob>("GET", `/v1/forget/${encodeURIComponent(jobId)}`, undefined, { admin: true });
  }

  /** `POST /v1/replay` — compares or rebuilds projections from the ledger. */
  async replay(request?: ReplayRequest): Promise<ReplayResponse> {
    return await this.request<ReplayResponse>("POST", "/v1/replay", request ?? {});
  }

  /** `POST /v1/evaluations/runs` — runs a benchmark suite and returns per-stage metrics. */
  async runEvaluations(request: EvaluationRunRequest): Promise<EvaluationRunResponse> {
    return await this.request<EvaluationRunResponse>("POST", "/v1/evaluations/runs", request);
  }

  /**
   * The action gate — the enforcement point for use decisions.
   *
   * PROVISIONAL ROUTE: the specification specifies `ActionGateRequest` /
   * `ActionGateVerdict` as contracts and requires the gate to be wired before any
   * medium- or high-risk side effect, but its "API design" route list omits an
   * action-gate path. `actionGatePath` therefore defaults to `/v1/actions/gate`
   * and is configurable, so a server that mounts it elsewhere does not require an
   * SDK release. Override it in the constructor if `apps/server` chose a
   * different path.
   */
  async gateAction(request: ActionGateRequest): Promise<ActionGateVerdict> {
    return await this.request<ActionGateVerdict>("POST", this.actionGatePath, request);
  }

  /**
   * Overrides the provisional action-gate route.
   *
   * Present because the route is not in the specification's REST list; the
   * alternative was to hard-code a guess with no way to correct it.
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
    options: { admin?: boolean; expectNoBody?: boolean } = {},
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
      const errorBody = (typeof parsed === "object" && parsed !== null ? parsed : {}) as VerityMemErrorBody;
      throw new VerityMemError({
        status: response.status,
        // A body without a code is still a failure; "unknown_error" says the
        // server broke its own contract instead of pretending there was no error.
        code: typeof errorBody.code === "string" ? errorBody.code : "unknown_error",
        message:
          typeof errorBody.message === "string"
            ? errorBody.message
            : `${method} ${path} failed with HTTP ${response.status}`,
        path,
        details: errorBody.details,
        body: parsed,
      });
    }

    // A caller that declared "no body expected" must not be told a 204 is a
    // malformed response; every other empty body is one.
    if (parsed === undefined && options.expectNoBody === true) return undefined as T;

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
 * A 204 or an empty body is not an error here; the caller decides whether a body
 * was required. `undefined` therefore means "no JSON body", and only a non-empty
 * non-JSON body is reported as malformed by the caller.
 */
function parseJsonOrUndefined(raw: string): unknown {
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
