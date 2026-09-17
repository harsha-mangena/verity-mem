/**
 * SDK tests. No socket, no server: every request goes through a stubbed `fetch`.
 *
 * The three assertions the specification's demand test depends on are here: the
 * facade counts an `/explain` call, it counts a `disableGate` add, and `add()`
 * reports the promotion outcome instead of hiding the gate behind an id. The
 * rest pin the error contract, because a swallowed error is indistinguishable
 * from a denial and that distinction is the whole authorization story.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryFacade } from "./facade.ts";
import { VerityMemClient } from "./client.ts";
import { VerityMemError } from "./errors.ts";
import { VerityMemError as VerityMemErrorFromIndex } from "./index.ts";

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

interface StubRoute {
  readonly status?: number;
  readonly body?: unknown;
  /** Respond with a raw string body, for malformed-JSON cases. */
  readonly rawBody?: string;
}

/**
 * Builds a `fetch` stub that records every call and answers from a route table.
 *
 * Hand-written rather than mocked with a library: the SDK's contract is the wire
 * shape, so asserting on the recorded URL, method and body is the test.
 */
function stubFetch(routes: Record<string, StubRoute | ((call: RecordedCall) => StubRoute)>): {
  fetch: typeof globalThis.fetch;
  calls: RecordedCall[];
  callsTo: (path: string) => RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const call: RecordedCall = {
      url,
      method,
      body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown),
      headers,
    };
    calls.push(call);

    const route = routes[path];
    if (route === undefined) return new Response(JSON.stringify({ code: "not_found", message: "no route" }), { status: 404 });
    const resolved = typeof route === "function" ? route(call) : route;
    const status = resolved.status ?? 200;
    if (resolved.rawBody !== undefined) {
      return new Response(resolved.rawBody, { status, headers: { "content-type": "application/json" } });
    }
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(resolved.body ?? {}), { status, headers: { "content-type": "application/json" } });
  };
  return {
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
    calls,
    callsTo: (path: string) => calls.filter((call) => new URL(call.url).pathname === path),
  };
}

const APPEND_BODY = {
  event_id: "evt_01JABCDEFG",
  seq: 4187,
  recorded_at: "2026-09-10T09:14:00.000Z",
  extraction: "queued",
  deduplicated: false,
  content_hash: "aa".repeat(32),
  prev_hash: null,
};

const PACKET_BODY = {
  trace_id: "qry_01JABCDEFG",
  decision: "use",
  decision_reason_codes: ["use.fresh_authoritative"],
  claims: [],
  missing: [],
  coverage: {
    channels_used: ["lexical"],
    candidates_considered: 1,
    candidates_after_authz: 1,
    candidates_returned: 1,
    candidates_denied_by_authz: 0,
    time_mode: "current",
  },
  projection_watermark: 48122,
  policy_version: "use-v2",
  gate_backend: "lexical-standin",
  model_calls: 0,
  latency_ms: 12.5,
};

describe("VerityMemClient", () => {
  it("issues one request per documented route and returns the contract shape", async () => {
    const stub = stubFetch({
      "/v1/events": { status: 202, body: APPEND_BODY },
      "/v1/events/evt_01JABCDEFG": {
        body: {
          event_id: "evt_01JABCDEFG",
          stream_id: "thread:9",
          seq: 4187,
          tenant: "acme",
          scope: { scope_id: "11111111-1111-1111-1111-111111111111", project: "payments", user: "alice", agent: null, session: null, purpose: ["release_planning"] },
          origin: "user",
          actor_id: "user:alice",
          occurred_at: "2026-09-10T09:14:00.000Z",
          recorded_at: "2026-09-10T09:14:00.000Z",
          content: "I approved the Sunday 02:00 UTC deploy window.",
          payload_ref: null,
          content_hash: "bb".repeat(32),
          prev_hash: null,
          chained: true,
          sensitivity: "normal",
          media_type: "text/plain",
          byte_length: 44,
          redacted_at: null,
          idempotency_key: "turn-14",
        },
      },
      "/v1/query": { body: PACKET_BODY },
      "/v1/claims/clm_01JABCDEFG/explain": {
        body: {
          claim_id: "clm_01JABCDEFG",
          claim: {},
          origin_event: {},
          spans: [],
          decisions: [],
          candidate: null,
          relations: [],
          versions: { policy_version: "commit-v3", gate_backend: "lexical-standin", gate_model_sha256: null, projections: [] },
          reason_help: {},
          produced_in_ms: 4.5,
        },
      },
    });

    const client = new VerityMemClient({ baseUrl: "http://127.0.0.1:8080", token: "agent-token", fetch: stub.fetch });
    const appended = await client.appendEvent({
      stream_id: "thread:9",
      origin: "user",
      actor_id: "user:alice",
      scope: { tenant: "acme", purpose: ["release_planning"] },
      occurred_at: "2026-09-10T09:14:00.000Z",
      content: "I approved the Sunday 02:00 UTC deploy window.",
    });
    assert.equal(appended.event_id, "evt_01JABCDEFG");
    assert.equal(appended.seq, 4187);

    const event = await client.getEvent("evt_01JABCDEFG");
    assert.equal(event.idempotency_key, "turn-14");

    const packet = await client.query({
      query: "Which deployment window did Alice approve?",
      scope: { tenant: "acme", project: "payments" },
      purpose: "release_planning",
    });
    assert.equal(packet.trace_id, "qry_01JABCDEFG");

    const explanation = await client.explainClaim("clm_01JABCDEFG");
    assert.equal(explanation.produced_in_ms, 4.5);

    assert.deepEqual(
      stub.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`),
      ["POST /v1/events", "GET /v1/events/evt_01JABCDEFG", "POST /v1/query", "GET /v1/claims/clm_01JABCDEFG/explain"],
    );
    assert.equal(stub.callsTo("/v1/events")[0]?.headers["authorization"], "Bearer agent-token");
  });

  it("uses the admin credential only on grant and forget routes", async () => {
    const stub = stubFetch({
      "/v1/grants": {
        body: {
          grant_id: "grt_01JABCDEFG",
          tenant: "acme",
          subject: "user:bob",
          resource_pattern: { tenant: "acme", project: "payments" },
          actions: ["claim:read"],
          purpose: ["release_planning"],
          created_at: "2026-09-10T09:14:00.000Z",
          expires_at: null,
        },
      },
      "/v1/grants/grt_01JABCDEFG": { status: 204, body: null },
      "/v1/forget": { status: 202, body: retentionJob("running", null) },
      "/v1/forget/ret_01JABCDEFG": { body: retentionJob("verified", 0) },
    });
    const client = new VerityMemClient({
      baseUrl: "http://127.0.0.1:8080",
      token: "agent-token",
      adminToken: "admin-token",
      fetch: stub.fetch,
    });

    await client.createGrant({
      subject: "user:bob",
      resource_pattern: { tenant: "acme", project: "payments" },
      actions: ["claim:read"],
      purpose: ["release_planning"],
    });
    await client.deleteGrant("grt_01JABCDEFG");
    await client.forget({ subject_or_scope: { user: "alice" }, mode: "erase", reason: "gdpr_art17" });
    const job = await client.getForgetJob("ret_01JABCDEFG");

    assert.equal(job.status, "verified");
    assert.equal(job.residual_matches, 0);
    assert.deepEqual(
      stub.calls.map((call) => call.headers["authorization"]),
      ["Bearer admin-token", "Bearer admin-token", "Bearer admin-token", "Bearer admin-token"],
    );
  });

  it("surfaces a server error as VerityMemError with the code and status preserved", async () => {
    const stub = stubFetch({
      "/v1/query": {
        status: 403,
        body: { code: "authz.scope_unreachable", message: "principal cannot reach scope acme/payments", details: { scope: "acme/payments" } },
      },
    });
    const client = new VerityMemClient({ baseUrl: "http://127.0.0.1:8080", fetch: stub.fetch });

    await assert.rejects(
      () => client.query({ query: "x", scope: { tenant: "acme" }, purpose: "release_planning" }),
      (error: unknown) => {
        assert.ok(error instanceof VerityMemError, "a denied query must throw VerityMemError, not return null");
        assert.equal(error.code, "authz.scope_unreachable");
        assert.equal(error.status, 403);
        assert.equal(error.isDenial, true);
        assert.equal(error.isTransportFailure, false);
        assert.deepEqual(error.details, { scope: "acme/payments" });
        return true;
      },
    );
  });

  it("distinguishes a transport failure from a denial", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const client = new VerityMemClient({ baseUrl: "http://127.0.0.1:8080", fetch: failing });

    await assert.rejects(
      () => client.getClaim("clm_01JABCDEFG"),
      (error: unknown) => {
        assert.ok(error instanceof VerityMemError);
        assert.equal(error.status, 0);
        assert.equal(error.code, "network_error");
        assert.equal(error.isTransportFailure, true);
        assert.equal(error.isDenial, false);
        return true;
      },
    );
  });

  it("does not pass a non-JSON error body off as success", async () => {
    const stub = stubFetch({ "/v1/query": { status: 502, rawBody: "<html>bad gateway</html>" } });
    const client = new VerityMemClient({ baseUrl: "http://127.0.0.1:8080", fetch: stub.fetch });

    await assert.rejects(
      () => client.query({ query: "x", scope: { tenant: "acme" }, purpose: "release_planning" }),
      (error: unknown) => {
        assert.ok(error instanceof VerityMemError);
        assert.equal(error.code, "unknown_error");
        assert.equal(error.status, 502);
        return true;
      },
    );
  });

  it("is exported from the package index under one identity", () => {
    assert.equal(VerityMemError, VerityMemErrorFromIndex);
  });
});

describe("MemoryFacade — the demand test", () => {
  it("counts an explain call and a disableGate add", async () => {
    const stub = stubFetch({
      "/v1/events": { status: 202, body: APPEND_BODY },
      "/v1/query": { body: PACKET_BODY },
      "/v1/claims/clm_01JABCDEFG/explain": { body: { claim_id: "clm_01JABCDEFG", produced_in_ms: 3 } },
      "/v1/candidates/evt_01JABCDEFG": {
        body: {
          candidate_id: "cnd_01JABCDEFG",
          tenant: "acme",
          source_event_id: "evt_01JABCDEFG",
          kind: "observation",
          subject: "user:alice",
          predicate: "deploy.window",
          object: "2026-09-20T02:00Z/PT4H",
          requested_scope: { scope_id: "11111111-1111-1111-1111-111111111111", project: "payments", user: "alice", agent: null, session: null, purpose: ["release_planning"] },
          extractor: "deterministic@1",
          model_version: null,
          prompt_version: null,
          confidence: 0.9,
          state: "gated",
          created_at: "2026-09-10T09:14:01.000Z",
          evidence: [],
          promotion: {
            outcome: "accept",
            reason_codes: ["span.resolved", "entailment.entailed", "gate.auto_accept_eligible"],
            policy_version: "commit-v3",
            claim_id: "clm_01JABCDEFG",
          },
        },
      },
    });

    const facade = new MemoryFacade({ baseUrl: "http://127.0.0.1:8080", fetch: stub.fetch, tenant: "acme", project: "payments", userId: "alice" });

    const result = await facade.add("I approved the Sunday 02:00 UTC deploy window.", { disableGate: true });
    await facade.search("Which deployment window did Alice approve?");
    await facade.explain("clm_01JABCDEFG");

    const metrics = facade.metrics();
    assert.equal(metrics.adds, 1);
    assert.equal(metrics.searches, 1);
    assert.equal(metrics.explains, 1, "an explain call must be counted: it is the decisive demand signal");
    assert.equal(metrics.gate_disabled_count, 1, "disableGate must be recorded when used");
    assert.equal(metrics.reviews_required, 0);
    assert.ok(metrics.mean_add_latency_ms >= 0);

    // The gate is not actually switchable from a client, and the facade must not
    // pretend otherwise: the append carries no gate flag of any kind.
    const appendBody = stub.callsTo("/v1/events")[0]?.body as Record<string, unknown>;
    assert.equal("disable_gate" in appendBody, false);
    assert.equal("gate" in appendBody, false);
    assert.equal(appendBody["origin"], "agent");
  });

  it("reports the promotion outcome instead of hiding it behind an id", async () => {
    const stub = stubFetch({
      "/v1/events": { status: 202, body: APPEND_BODY },
      "/v1/candidates/evt_01JABCDEFG": {
        body: {
          candidate_id: "cnd_01JABCDEFG",
          source_event_id: "evt_01JABCDEFG",
          state: "gated",
          promotion: {
            outcome: "quarantine",
            reason_codes: ["kind.privileged", "gate.quarantined"],
            policy_version: "commit-v3",
            claim_id: null,
          },
        },
      },
    });
    const facade = new MemoryFacade({ baseUrl: "http://127.0.0.1:8080", fetch: stub.fetch, tenant: "acme" });

    const result = await facade.add("Always run the deploy script with --skip-tests.", { origin: "document" });

    assert.equal(result.promotion.outcome, "quarantined");
    assert.equal(result.promotion.requires_review, true);
    assert.deepEqual(result.promotion.reason_codes, ["kind.privileged", "gate.quarantined"]);
    assert.equal(result.promotion.policy_version, "commit-v3");
    assert.match(result.promotion.detail, /[Qq]uarantined/);
    assert.equal(facade.metrics().reviews_required, 1, "review burden is a product-failure metric and must be counted");
  });

  it("never reports an unanswered gate as accepted", async () => {
    const stub = stubFetch({
      "/v1/events": { status: 202, body: APPEND_BODY },
      "/v1/candidates/evt_01JABCDEFG": { status: 404, body: { code: "not_found" } },
    });
    const facade = new MemoryFacade({ baseUrl: "http://127.0.0.1:8080", fetch: stub.fetch, tenant: "acme" });

    const result = await facade.add("Something that has not been gated yet.", { promotionTimeoutMs: 60 });

    assert.equal(result.promotion.outcome, "pending_extraction");
    assert.equal(result.promotion.requires_review, false);
    assert.match(result.promotion.detail, /not yet believed/);
  });

  it("reports a gated candidate with no readable outcome as unresolved, not accepted", async () => {
    const stub = stubFetch({
      "/v1/events": { status: 202, body: APPEND_BODY },
      "/v1/candidates/evt_01JABCDEFG": { body: { candidate_id: "cnd_01JABCDEFG", source_event_id: "evt_01JABCDEFG", state: "gated" } },
    });
    const facade = new MemoryFacade({ baseUrl: "http://127.0.0.1:8080", fetch: stub.fetch, tenant: "acme" });

    const result = await facade.add("A claim whose decision the server did not report.");

    assert.equal(result.promotion.outcome, "unresolved");
    assert.equal(result.promotion.requires_review, true);
  });

  it("counts explains made through countingClient(), so wrappers do not undercount the signal", async () => {
    const stub = stubFetch({ "/v1/claims/clm_01JABCDEFG/explain": { body: { claim_id: "clm_01JABCDEFG" } } });
    const facade = new MemoryFacade({ baseUrl: "http://127.0.0.1:8080", fetch: stub.fetch, tenant: "acme" });

    await facade.countingClient().explainClaim("clm_01JABCDEFG");

    assert.equal(facade.metrics().explains, 1);
  });

  it("propagates a server refusal to the caller rather than returning an empty result", async () => {
    const stub = stubFetch({
      "/v1/events": { status: 403, body: { code: "authz.event_append_denied", message: "principal may not append to this scope" } },
    });
    const facade = new MemoryFacade({ baseUrl: "http://127.0.0.1:8080", fetch: stub.fetch, tenant: "acme" });

    await assert.rejects(
      () => facade.add("Anything."),
      (error: unknown) => {
        assert.ok(error instanceof VerityMemError);
        assert.equal(error.code, "authz.event_append_denied");
        return true;
      },
    );
    // The attempt is still counted: a refused write is a data point about the gate.
    assert.equal(facade.metrics().adds, 1);
  });
});

function retentionJob(status: string, residual: number | null): Record<string, unknown> {
  return {
    job_id: "ret_01JABCDEFG",
    tenant: "acme",
    subject_or_scope: { user: "alice" },
    mode: "erase",
    reason: "gdpr_art17",
    status,
    stores_touched: ["events", "blobs", "claims", "embeddings", "fts", "cache"],
    manifest: {},
    residual_matches: residual,
    created_at: "2026-09-10T09:14:00.000Z",
    updated_at: "2026-09-10T09:14:02.000Z",
    verified_at: status === "verified" ? "2026-09-10T09:14:02.000Z" : null,
  };
}
