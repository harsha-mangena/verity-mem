/**
 * The HTTP surface this adapter needs, behind one injectable seam.
 *
 * Two things are deliberate here.
 *
 * First, the adapter depends on a *narrow interface* (`VerityApiClient`), not on a
 * concrete client. `@veritymem/sdk-ts` is the intended production implementation
 * and is structurally compatible with it — same method names, same
 * `@veritymem/contracts` request and response types — but this package does not
 * import it: an adapter that cannot be tested or typechecked while a sibling
 * package is mid-write is an adapter nobody can run. Tests inject a stub that
 * records requests; applications inject whatever client they already have.
 *
 * Second, `HttpVerityClient` exists so the default path has no dependency beyond
 * `fetch`. It implements one method per route in the specification's "API design"
 * section and nothing else, so a route that does not exist cannot be hidden behind
 * a convenience wrapper.
 */
import type {
  ActionGateRequest,
  ActionGateVerdict,
  ClaimRecord,
  EventAppendRequest,
  EventAppendResponse,
  MemoryPacket,
  QueryRequest,
} from "@veritymem/contracts";
import { VerityApiError } from "./errors.ts";

/** Accepted by `globalThis.fetch`; injectable so tests never open a socket. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * The routes this adapter is allowed to use.
 *
 * Kept as data so the action-gate path — which the specification's REST list does
 * not include, while the task that produced this package names
 * `POST /v1/actions/gate` — is correctable without a code change in the adapter.
 */
export interface VerityRoutes {
  readonly events: string;
  readonly claims: string;
  readonly query: string;
  readonly actionGate: string;
}

export const DEFAULT_ROUTES: VerityRoutes = Object.freeze({
  events: "/v1/events",
  claims: "/v1/claims",
  query: "/v1/query",
  actionGate: "/v1/actions/gate",
});

/**
 * The client seam.
 *
 * Every read in this package goes through one of these four calls, and three of
 * them are the canonical VerityMem read/write path: append evidence, read a claim,
 * run the authorized retrieval, and ask the action gate. The action gate is
 * deliberately not optional — an adapter that can be constructed without an
 * enforcement point ends up deployed without one.
 */
export interface VerityApiClient {
  /** `POST /v1/events` — append an untrusted event to the canonical ledger. */
  appendEvent(request: EventAppendRequest): Promise<EventAppendResponse>;
  /** `GET /v1/claims/{claim_id}` — read a believed claim with its six dimensions. */
  getClaim(claimId: string): Promise<ClaimRecord>;
  /** `POST /v1/query` — the authorized read path; returns a packet, never snippets. */
  query(request: QueryRequest): Promise<MemoryPacket>;
  /** `POST /v1/actions/gate` — the enforcement point for a consequential side effect. */
  gateAction(request: ActionGateRequest): Promise<ActionGateVerdict>;
}

export interface HttpVerityClientOptions {
  /** Origin of the API, e.g. `http://127.0.0.1:8080`. No trailing slash required. */
  readonly baseUrl: string;
  /** Bearer credential for the agent-facing audience. Admin routes are not reachable from here. */
  readonly token?: string;
  /** Injected transport. Defaults to the runtime's `fetch`. */
  readonly fetch?: FetchLike;
  /** Per-request timeout in milliseconds. `0` disables it. */
  readonly timeoutMs?: number;
  /** Extra headers on every request, e.g. a trace propagator. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Overrides the provisional action-gate route. See `DEFAULT_ROUTES`. */
  readonly routes?: Partial<VerityRoutes>;
}

/**
 * The default agent-facing client.
 *
 * Refuses to be constructed with an empty base URL, because the alternative is an
 * opaque `fetch` failure at the first write — after the graph has already decided
 * to act.
 */
export class HttpVerityClient implements VerityApiClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  private readonly routes: VerityRoutes;

  constructor(options: HttpVerityClientOptions) {
    if (options.baseUrl.trim() === "") {
      throw new TypeError("HttpVerityClient requires a non-empty baseUrl");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.extraHeaders = options.headers ?? {};
    this.routes = { ...DEFAULT_ROUTES, ...(options.routes ?? {}) };
  }

  async appendEvent(request: EventAppendRequest): Promise<EventAppendResponse> {
    return await this.send<EventAppendResponse>("POST", this.routes.events, request);
  }

  async getClaim(claimId: string): Promise<ClaimRecord> {
    return await this.send<ClaimRecord>("GET", `${this.routes.claims}/${encodeURIComponent(claimId)}`);
  }

  async query(request: QueryRequest): Promise<MemoryPacket> {
    return await this.send<MemoryPacket>("POST", this.routes.query, request);
  }

  async gateAction(request: ActionGateRequest): Promise<ActionGateVerdict> {
    // Checked here as well as at the hook, because this is the last point before
    // the wire and the property being protected is a security property: the gate
    // re-reads claims, and a packet smuggled into the request would invite a
    // future server-side "optimization" that trusts it.
    assertGateRequestCarriesNoPacket(request);
    return await this.send<ActionGateVerdict>("POST", this.routes.actionGate, request);
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", ...this.extraHeaders };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token !== undefined) headers["authorization"] = `Bearer ${this.token}`;

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (this.timeoutMs > 0) init.signal = AbortSignal.timeout(this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      // Status 0 means "no answer", which must never be confused with a denial or
      // with an absent claim: a timeout on the action gate is not permission.
      throw new VerityApiError({
        status: 0,
        method,
        path,
        message: `${method} ${path} could not be sent: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      });
    }

    const raw = await response.text();
    const parsed = parseJsonOrUndefined(raw);

    if (!response.ok) {
      throw new VerityApiError({
        status: response.status,
        method,
        path,
        message: `${method} ${path} failed with HTTP ${response.status}`,
        body: parsed,
      });
    }
    if (parsed === undefined) {
      throw new VerityApiError({
        status: response.status,
        method,
        path,
        message: `${method} ${path} returned HTTP ${response.status} with a body that is not JSON`,
        body: raw,
      });
    }
    return parsed as T;
  }
}

/**
 * The action gate request is `ActionGateRequest` and nothing more.
 *
 * The gate re-reads claims and re-verifies evidence digests on every call; that is
 * what makes a revocation or an erasure between the query and the action change the
 * answer. A packet, a claim object or a cached verdict in the request would make
 * that impossible while still looking like an enforcement point, so any extra field
 * is refused loudly rather than dropped silently.
 */
export function assertGateRequestCarriesNoPacket(request: ActionGateRequest): void {
  const allowed = new Set(["action", "action_risk", "scope", "purpose", "claim_ids", "trace_id"]);
  const extra = Object.keys(request as unknown as Record<string, unknown>).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new TypeError(
      `action gate request carries unsupported field(s) [${extra.join(", ")}]. The gate must re-read claims: ` +
        "a packet or a claim body in this request would be stale state pretending to be evidence",
    );
  }
  if (!Array.isArray(request.claim_ids) || request.claim_ids.length === 0) {
    throw new TypeError(
      "action gate request references no claims. An action that depends on no memory does not need the gate; " +
        "calling it with an empty claim set would verify nothing and always allow",
    );
  }
}

/**
 * Parses a body without throwing.
 *
 * `undefined` means "no JSON body"; the caller decides whether one was required.
 * A 204 on a route that promised a body is a server bug, and reporting it as
 * `undefined` would let the store mistake it for an empty result.
 */
function parseJsonOrUndefined(raw: string): unknown {
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
