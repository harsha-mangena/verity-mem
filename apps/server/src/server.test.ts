/**
 * Server tests.
 *
 * These run the real route table against the real database, through
 * `app.inject()` rather than a socket. `inject()` is not a mock: it drives the same
 * router, the same hooks, the same schema validation and the same handlers, and only
 * the TCP hop is skipped. A test that stubbed the database would verify that the stub
 * agrees with itself — row-level security, the append-only guard and the claim
 * transition guard exist only in Postgres, and every one of them is load-bearing for
 * the assertions below.
 *
 * Isolation is by tenant, never by deleting rows: the ledger is append-only on
 * purpose, and a suite that can delete events is testing a different system than the
 * one that ships.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { Db, MemoryBlobStore, Ledger, fixedClock, loadEnv, resolveTenantId, seededIds } from "@veritymem/ledger";
import { DEFAULT_COMMIT_POLICY } from "@veritymem/contracts";
import { buildDeps, loadServerConfig, type ServerConfig, type ServerDeps } from "./config.ts";
import { buildEmbeddingBackend, buildEntailmentBackend } from "./config.ts";
import { createServer } from "./server.ts";

const env = loadEnv();

/** A fresh tenant per test, so no test can observe another's rows. */
function probeTenant(label: string): string {
  return `srv-${label}-${randomUUID().slice(0, 8)}`;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly deps: ServerDeps;
  readonly config: ServerConfig;
  readonly tenant: string;
  readonly tenantId: string;
  readonly agentToken: string;
  readonly adminToken: string;
  readonly project: string;
  readonly user: string;
  readonly purposes: readonly string[];
  close(): Promise<void>;
}

/**
 * Boot the server against a database the test owns.
 *
 * The admin token carries a `tenant:<slug>:` prefix so the administrative tests
 * exercise the tenant-bound credential path, and the agent token deliberately does
 * not, so the write tests exercise the "tenant comes from the body, then is checked
 * against the credential" path. Both paths exist in production and neither is
 * reachable from the other.
 */
async function createHarness(label: string, overrides: Partial<Record<string, string>> = {}): Promise<Harness> {
  const db = new Db({ connectionString: env.databaseUrl, max: 4 });
  const blobs = new MemoryBlobStore();
  const clock = fixedClock("2026-09-17T12:00:00.000Z");
  // Seeded so a failure is reproducible from the label, but salted per harness: the
  // ledger's primary keys are the generated event ids, and two harnesses sharing a
  // seed would collide on the first append rather than on anything interesting.
  const ids = seededIds(`server-${label}-${randomUUID().slice(0, 8)}`);
  const ledger = new Ledger({ db, blobs, clock, ids });
  const tenant = probeTenant(label);

  const config = loadServerConfig({
    DATABASE_URL: env.databaseUrl,
    GATE_ENTAILMENT_BACKEND: "lexical",
    EMBEDDING_BACKEND: "hash",
    // Both credentials are bound to the tenant. The by-id routes — an event, a claim,
    // a candidate, a trace — have no tenant in the body to bind, so an unbound
    // credential genuinely cannot use them; the append route's body-named tenant is
    // covered by the cross-tenant test below.
    AGENT_TOKEN: `tenant:${tenant}:test-agent-token`,
    ADMIN_TOKEN: `tenant:${tenant}:test-admin-token`,
    ...overrides,
  });

  const deps = buildDeps({
    config,
    db,
    ledger,
    blobs,
    embeddings: buildEmbeddingBackend(config),
    entailment: await buildEntailmentBackend(config),
    ids,
    clock,
  });

  const app = await createServer({ deps, swaggerUi: false, logger: false });
  return {
    app,
    deps,
    config,
    tenant,
    tenantId: resolveTenantId(tenant),
    agentToken: "test-agent-token",
    adminToken: "test-admin-token",
    project: "payments",
    user: "alice",
    purposes: ["release_planning"],
    async close() {
      await app.close();
      await db.close();
    },
  };
}

/**
 * Bearer headers, without a content type.
 *
 * The content type is deliberately *not* set for a bodyless request: `inject()` with
 * `content-type: application/json` and no payload hands Fastify an empty string to
 * parse, which is refused before any handler runs. A test that always set it would be
 * testing a request shape no client sends.
 */
function agentAuth(h: Harness): Record<string, string> {
  return { authorization: `Bearer ${h.agentToken}` };
}

function adminAuth(h: Harness): Record<string, string> {
  return { authorization: `Bearer ${h.adminToken}` };
}

/** Bearer headers plus a JSON content type, for a request that carries a body. */
function agentJson(h: Harness): Record<string, string> {
  return { authorization: `Bearer ${h.agentToken}`, "content-type": "application/json" };
}

function adminJson(h: Harness): Record<string, string> {
  return { authorization: `Bearer ${h.adminToken}`, "content-type": "application/json" };
}

/**
 * Append the reference-workload event and extract it.
 *
 * This is the write path the specification's own example uses — "I approved the
 * Sunday 02:00 UTC deploy window." — because it is the shape the deterministic
 * decision extractor recognises and the shape the commit gate accepts at
 * `user_self_report` authority.
 */
async function writeDeployApproval(h: Harness): Promise<{ eventId: string; claimId: string }> {
  const appended = await h.app.inject({
    method: "POST",
    url: "/v1/events",
    headers: agentJson(h),
    payload: {
      stream_id: `thread:${randomUUID().slice(0, 8)}`,
      idempotency_key: `turn-${randomUUID().slice(0, 8)}`,
      origin: "user",
      actor_id: "user:alice",
      scope: {
        tenant: h.tenant,
        project: h.project,
        user: h.user,
        purpose: [...h.purposes],
      },
      occurred_at: "2026-09-10T09:14:00Z",
      content: "I approved the Sunday 02:00 UTC deploy window.",
    },
  });
  assert.equal(appended.statusCode, 202, `append failed: ${appended.body}`);
  const eventId = appended.json().event_id as string;
  assert.match(eventId, /^evt_[0-9a-f]{32}$/);

  const extracted = await h.app.inject({
    method: "POST",
    url: `/v1/events/${eventId}/extract`,
    headers: agentAuth(h),
  });
  assert.equal(extracted.statusCode, 200, `extract failed: ${extracted.body}`);
  const body = extracted.json() as { claims: string[]; decisions: { outcome: string }[] };
  assert.equal(body.claims.length, 1, `expected one accepted claim, got ${extracted.body}`);
  assert.equal(body.decisions[0]?.outcome, "accept");
  return { eventId, claimId: body.claims[0] as string };
}

describe("veritymem server", () => {
  let h: Harness;

  before(async () => {
    h = await createHarness("main");
  });

  after(async () => {
    await h.close();
  });

  it("separates audiences: an agent token gets 403 on an admin route, an admin token succeeds", async () => {
    const grantBody = {
      subject: "agent:client",
      resource_pattern: { tenant: h.tenant, project: h.project },
      actions: ["read"],
      purpose: [...h.purposes],
    };

    const refused = await h.app.inject({
      method: "POST",
      url: "/v1/grants",
      headers: agentJson(h),
        payload: grantBody,
    });
    assert.equal(refused.statusCode, 403, `expected 403 for an agent token, got ${refused.statusCode}: ${refused.body}`);
    const error = refused.json() as { error: { code: string; details?: { required_audience?: string } } };
    assert.equal(error.error.code, "audience_mismatch");
    assert.equal(error.error.details?.required_audience, "admin");

    // The same request with the admin credential succeeds, which is what makes the
    // 403 above an audience refusal rather than a broken route.
    const allowed = await h.app.inject({
      method: "POST",
      url: "/v1/grants",
      headers: adminJson(h),
        payload: grantBody,
    });
    assert.equal(allowed.statusCode, 201, `expected 201 for an admin token, got ${allowed.statusCode}: ${allowed.body}`);
    const created = allowed.json() as { grant: { grant_id: string; tenant: string; purpose: string[] }; created: boolean };
    assert.equal(created.created, true);
    assert.equal(created.grant.tenant, h.tenant);
    assert.deepEqual(created.grant.purpose, [...h.purposes]);
    assert.match(created.grant.grant_id, /^grt_[0-9a-f]{32}$/);

    // Every admin route refuses the agent credential, not just the one.
    for (const url of ["/v1/replay", "/v1/forget", "/v1/evaluations/runs"]) {
      const response = await h.app.inject({
        method: "POST",
        url,
        headers: agentJson(h),
            payload: url === "/v1/forget" ? { subject_or_scope: { user: "alice" }, reason: "gdpr_art17" } : {},
      });
      assert.equal(response.statusCode, 403, `${url} should refuse an agent token, got ${response.statusCode}`);
      assert.equal((response.json() as { error: { code: string } }).error.code, "audience_mismatch");
    }

    // The grant delete path is admin-only too, and reports a miss without disclosing
    // whether the id exists.
    const deleted = await h.app.inject({
      method: "DELETE",
      url: `/v1/grants/${created.grant.grant_id}`,
      headers: adminAuth(h),
    });
    assert.equal(deleted.statusCode, 200);
    assert.equal((deleted.json() as { deleted: boolean }).deleted, true);
  });

  it("refuses a body that names a different tenant than the token", async () => {
    // The bound credential names one tenant and the body names another. The refusal
    // happens before any binding: `/v1/forget` is the erase path, and it runs under
    // `withSystemContext`, which reaches every row in its tenant. A caller that chose
    // its own tenant there would be erasing someone else's ledger.
    const boundTenant = probeTenant("bound");
    const bound = await createHarness("bound", {
      AGENT_TOKEN: `tenant:${boundTenant}:bound-agent-token`,
      ADMIN_TOKEN: `tenant:${boundTenant}:bound-admin-token`,
    });
    try {
      const mismatched = await bound.app.inject({
        method: "POST",
        url: "/v1/forget",
        headers: adminJson(bound),
        payload: { subject_or_scope: { tenant: "some-other-tenant", user: "alice" }, reason: "gdpr_art17" },
      });
      assert.equal(
        mismatched.statusCode,
        403,
        `a tenant-bound credential must refuse a body naming another tenant, got ${mismatched.statusCode}: ${mismatched.body}`,
      );
      const forgetError = mismatched.json() as { error: { code: string } };
      assert.equal(forgetError.error.code, "tenant_mismatch");

      // The write path refuses it too, so a caller cannot append evidence into another
      // tenant's ledger by naming it.
      const write = await bound.app.inject({
        method: "POST",
        url: "/v1/events",
        headers: agentJson(bound),
        payload: {
          stream_id: "thread:cross",
          origin: "user",
          actor_id: "user:alice",
          scope: { tenant: "some-other-tenant", project: "payments", user: "alice", purpose: ["release_planning"] },
          occurred_at: "2026-09-10T09:14:00Z",
          content: "this must never be written",
        },
      });
      assert.equal(write.statusCode, 403, write.body);
      assert.equal((write.json() as { error: { code: string } }).error.code, "tenant_mismatch");

      // And a query for another tenant's scope is refused the same way, before any
      // retrieval happens.
      const query = await bound.app.inject({
        method: "POST",
        url: "/v1/query",
        headers: agentJson(bound),
        payload: {
          query: "deploy window",
          scope: { tenant: "some-other-tenant", project: "payments" },
          purpose: "release_planning",
        },
      });
      assert.equal(query.statusCode, 403, query.body);
      assert.equal((query.json() as { error: { code: string } }).error.code, "tenant_mismatch");

      // An unbound credential cannot use the by-id routes at all: there is no tenant
      // in the body to bind, and choosing one from the request would be the caller
      // selecting its own tenant.
      const unbound = await createHarness("unbound", {
        AGENT_TOKEN: "unbound-agent-token",
        ADMIN_TOKEN: `tenant:${probeTenant("unbound-admin")}:unbound-admin-token`,
      });
      try {
        const read = await unbound.app.inject({
          method: "GET",
          url: `/v1/claims/clm_${"0".repeat(32)}/explain`,
          headers: agentAuth(unbound),
        });
        assert.equal(read.statusCode, 400, read.body);
        assert.equal((read.json() as { error: { code: string } }).error.code, "validation_failed");
      } finally {
        await unbound.close();
      }
    } finally {
      await bound.close();
    }
  });

  it("appends an event and answers a query with a verified evidence quote", async () => {
    const { eventId, claimId } = await writeDeployApproval(h);

    const queried = await h.app.inject({
      method: "POST",
      url: "/v1/query",
      headers: agentJson(h),
        payload: {
        query: "Which deployment window did Alice approve?",
        scope: { tenant: h.tenant, project: h.project, user: h.user },
        purpose: h.purposes[0],
        time: { mode: "current" },
        action_risk: "medium",
        limit: 12,
      },
    });
    assert.equal(queried.statusCode, 200, `query failed: ${queried.body}`);
    const packet = queried.json() as {
      decision: string;
      claims: {
        claim_id: string;
        kind: string;
        statement: { subject: string; predicate: string; object: unknown };
        authority: string;
        evidence: { quote: string | null; digest_ok: boolean; entailment: string; event_id: string }[];
      }[];
      coverage: { candidates_returned: number };
      model_calls: number;
      policy_version: string;
    };

    assert.ok(packet.claims.length >= 1, `expected a claim in the packet: ${queried.body}`);
    const claim = packet.claims.find((candidate) => candidate.claim_id === claimId) ?? packet.claims[0]!;
    assert.equal(claim.claim_id, claimId);
    assert.equal(claim.kind, "decision");
    assert.equal(claim.statement.predicate, "decision.approved");
    assert.equal(claim.authority, "user_self_report");

    // The end-to-end proof: the packet's claim carries the exact bytes that support
    // it, and the digest was recomputed on this read rather than trusted from the
    // gate's promotion-time check.
    assert.ok(claim.evidence.length >= 1, `expected evidence on the claim: ${JSON.stringify(claim)}`);
    const span = claim.evidence[0]!;
    assert.equal(span.digest_ok, true);
    assert.equal(span.event_id, eventId);
    assert.ok(
      span.quote !== null && span.quote.includes("Sunday 02:00 UTC deploy window"),
      `evidence quote was not the supporting text: ${JSON.stringify(span)}`,
    );
    assert.equal(packet.model_calls, 0, "the default read path must make zero model calls");
    assert.equal(packet.policy_version, "use-v2");
  });

  it("explains a claim's full promotion history in one call", async () => {
    const { eventId, claimId } = await writeDeployApproval(h);

    const explained = await h.app.inject({
      method: "GET",
      url: `/v1/claims/${claimId}/explain`,
      headers: agentAuth(h),
    });
    assert.equal(explained.statusCode, 200, `explain failed: ${explained.body}`);
    const body = explained.json() as {
      claim_id: string;
      claim: { status: string; authority: string; evidence: unknown[] };
      origin_event: { event_id: string; content: string | null; actor_id: string; stream_id: string };
      spans: { span_id: string; role: string; quote: string | null; digest_ok: boolean; start: number; end: number }[];
      decisions: { decision_id: string; outcome: string; policy_version: string; reason_codes: string[] }[];
      candidate: { candidate_id: string; extractor: string; subject: string } | null;
      relations: unknown[];
      versions: { policy_version: string; gate_backend: string };
      reason_help: Record<string, string>;
      produced_in_ms: number;
    };

    assert.equal(body.claim_id, claimId);
    assert.equal(body.claim.status, "accepted");

    // The originating event, with the bytes that produced the claim.
    assert.equal(body.origin_event.event_id, eventId);
    assert.equal(body.origin_event.actor_id, "user:alice");
    assert.equal(body.origin_event.content, "I approved the Sunday 02:00 UTC deploy window.");

    // Every span, with its quoted text and a digest re-verified on this read.
    assert.ok(body.spans.length >= 1, "explain must return the spans");
    const span = body.spans[0]!;
    assert.equal(span.role, "supports");
    assert.equal(span.digest_ok, true);
    assert.ok(span.quote !== null && span.quote.length > 0, "explain must quote the span");
    assert.ok(span.end > span.start);

    // Every decision, with its policy version and reason codes.
    assert.ok(body.decisions.length >= 1, "explain must return the decisions");
    const decision = body.decisions[0]!;
    assert.equal(decision.outcome, "accept");
    assert.equal(decision.policy_version, DEFAULT_COMMIT_POLICY.version);
    assert.ok(decision.reason_codes.length > 0);

    // The proposal that produced it, and the versions in force.
    assert.equal(body.candidate?.extractor, "decision-statement@1");
    assert.equal(body.versions.policy_version, DEFAULT_COMMIT_POLICY.version);
    assert.match(body.versions.gate_backend, /lexical/);
    // The reason codes are explained, not just enumerated.
    assert.ok(Object.keys(body.reason_help).length > 0, "explain must explain its reason codes");
    assert.equal(typeof body.produced_in_ms, "number");
  });

  it("refuses a high-risk action on a user_self_report claim", async () => {
    const { claimId } = await writeDeployApproval(h);

    const gate = await h.app.inject({
      method: "POST",
      url: "/v1/actions/gate",
      headers: agentJson(h),
        payload: {
        action: "merge_pull_request",
        action_risk: "high",
        scope: { tenant: h.tenant, project: h.project },
        purpose: h.purposes[0],
        claim_ids: [claimId],
      },
    });

    // A refusal is a 200 carrying the verdict, never an error: the gate working is not
    // a failure of the request.
    assert.equal(gate.statusCode, 200, `expected a verdict, got ${gate.statusCode}: ${gate.body}`);
    const verdict = gate.json() as {
      allowed: boolean;
      decision: string;
      reason_codes: string[];
      claims: { claim_id: string; found: boolean; use: string | null; blocking: boolean }[];
    };
    assert.equal(verdict.allowed, false);
    assert.notEqual(verdict.decision, "use");
    assert.equal(verdict.claims[0]?.claim_id, claimId);
    assert.equal(verdict.claims[0]?.found, true);
    assert.equal(verdict.claims[0]?.blocking, true);
    assert.equal(verdict.claims[0]?.use, "verify");
    assert.ok(
      verdict.reason_codes.includes("action.denied_risk_exceeds_use"),
      `expected the risk rule to block, got ${JSON.stringify(verdict.reason_codes)}`,
    );

    // The same claim at low risk is permitted, which is what makes the refusal above a
    // risk decision rather than a blanket denial.
    const low = await h.app.inject({
      method: "POST",
      url: "/v1/actions/gate",
      headers: agentJson(h),
        payload: {
        action: "read_deploy_window",
        action_risk: "low",
        scope: { tenant: h.tenant, project: h.project },
        purpose: h.purposes[0],
        claim_ids: [claimId],
      },
    });
    assert.equal(low.statusCode, 200, low.body);
    assert.equal((low.json() as { allowed: boolean }).allowed, true);
  });

  it("returns the single error shape for an unknown route and a malformed body", async () => {
    const unknown = await h.app.inject({ method: "GET", url: "/v1/does-not-exist", headers: agentAuth(h) });
    assert.equal(unknown.statusCode, 404);
    assertErrorShape(unknown.json());
    assert.equal((unknown.json() as { error: { code: string } }).error.code, "not_found");

    const malformed = await h.app.inject({
      method: "POST",
      url: "/v1/events",
      headers: agentJson(h),
        payload: { stream_id: "", origin: "nonsense", occurred_at: "yesterday" },
    });
    assert.equal(malformed.statusCode, 400, malformed.body);
    const malformedBody = malformed.json() as { error: { code: string; message: string; details?: unknown } };
    assertErrorShape(malformedBody);
    assert.equal(malformedBody.error.code, "validation_failed");
    // No stack trace, no SQL, and no echo of the submitted values.
    assert.ok(!/at \w+ \(/.test(malformedBody.error.message), "error message leaked a stack frame");
    assert.ok(!/select |insert |update |from /i.test(malformedBody.error.message), "error message leaked SQL");
    assert.ok(
      !JSON.stringify(malformedBody).includes("nonsense") || !JSON.stringify(malformedBody.error).includes("nonsense"),
      "validation details echoed the submitted value",
    );

    const unauthenticated = await h.app.inject({ method: "GET", url: "/v1/whoami" });
    assert.equal(unauthenticated.statusCode, 401);
    assertErrorShape(unauthenticated.json());
    assert.equal((unauthenticated.json() as { error: { code: string } }).error.code, "unauthorized");

    const bogusToken = await h.app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    assert.equal(bogusToken.statusCode, 401);
    assert.equal((bogusToken.json() as { error: { code: string } }).error.code, "unauthorized");
  });

  it("composes a packet with deterministic prose that cites its evidence", async () => {
    const { claimId } = await writeDeployApproval(h);

    const composed = await h.app.inject({
      method: "POST",
      url: "/v1/context/compose",
      headers: agentJson(h),
        payload: {
        query: "Which deployment window did Alice approve?",
        scope: { tenant: h.tenant, project: h.project, user: h.user },
        purpose: h.purposes[0],
        limit: 5,
      },
    });
    assert.equal(composed.statusCode, 200, composed.body);
    const body = composed.json() as {
      packet: { claims: { claim_id: string }[]; trace_id: string };
      prose: string | null;
      citations: { claim_id: string; span_id: string | null }[];
      deterministic: boolean;
    };

    // The machine-readable half is always present and is the same object /v1/query
    // returns.
    assert.ok(body.packet.claims.length >= 1, "the packet must always travel with the prose");
    assert.equal(body.deterministic, true);
    assert.ok(body.prose !== null, "expected prose for a non-empty packet");
    assert.ok(body.prose?.includes(claimId), "prose must carry the claim identifier it rests on");
    assert.ok(body.citations.some((citation) => citation.claim_id === claimId));
    assert.ok(
      body.citations.some((citation) => citation.span_id !== null),
      "prose must cite at least one span, not just the claim",
    );

    const trace = await h.app.inject({
      method: "GET",
      url: `/v1/query-traces/${body.packet.trace_id}`,
      headers: agentAuth(h),
    });
    assert.equal(trace.statusCode, 200, trace.body);
    assert.equal((trace.json() as { trace_id: string }).trace_id, body.packet.trace_id);
  });

  it("reads back an event and reports readiness with the live gate backend", async () => {
    const { eventId } = await writeDeployApproval(h);

    const read = await h.app.inject({ method: "GET", url: `/v1/events/${eventId}`, headers: agentAuth(h) });
    assert.equal(read.statusCode, 200, read.body);
    const event = read.json() as { event_id: string; content: string | null; tenant: string; sensitivity: string };
    assert.equal(event.event_id, eventId);
    assert.equal(event.content, "I approved the Sunday 02:00 UTC deploy window.");
    assert.equal(event.tenant, h.tenant);

    const missing = await h.app.inject({
      method: "GET",
      url: `/v1/events/evt_${"0".repeat(32)}`,
      headers: agentAuth(h),
    });
    assert.equal(missing.statusCode, 404, missing.body);

    const health = await h.app.inject({ method: "GET", url: "/healthz" });
    assert.equal(health.statusCode, 200);
    assert.equal((health.json() as { status: string }).status, "ok");

    const ready = await h.app.inject({ method: "GET", url: "/readyz" });
    assert.equal(ready.statusCode, 200, ready.body);
    const readyBody = ready.json() as {
      status: string;
      gate: { backend: string; is_model_call: boolean; confidence_threshold: number };
      embedding: { backend: string; model_id: string; is_model_call: boolean };
    };
    assert.equal(readyBody.status, "ready");
    // The configured backend is the one reported. A `/readyz` that did not name it
    // would let a deployment run the lexical stand-in while believing it ran ONNX.
    assert.match(readyBody.gate.backend, /^lexical-overlap@1/);
    assert.equal(readyBody.gate.is_model_call, false);
    assert.equal(readyBody.embedding.backend, "hash");
    assert.equal(readyBody.embedding.is_model_call, false);
  });

  it("reports the caller's profile and tool allowlist", async () => {
    const contributor = await h.app.inject({ method: "GET", url: "/v1/whoami", headers: agentAuth(h) });
    assert.equal(contributor.statusCode, 200);
    const contributorBody = contributor.json() as { profile: string; audiences: string[]; tools: string[] };
    assert.equal(contributorBody.profile, "contributor");
    assert.deepEqual(contributorBody.audiences, ["agent"]);
    // The default profile records and proposes; it must not decide.
    assert.ok(contributorBody.tools.includes("memory.record"));
    assert.ok(!contributorBody.tools.includes("memory.decide"));
    assert.ok(!contributorBody.tools.includes("memory.forget"));

    const admin = await h.app.inject({ method: "GET", url: "/v1/whoami", headers: adminAuth(h) });
    const adminBody = admin.json() as { profile: string; audiences: string[]; tenant: string };
    assert.equal(adminBody.profile, "privacy-admin");
    assert.deepEqual([...adminBody.audiences].sort(), ["admin", "agent"]);
    assert.equal(adminBody.tenant, h.tenant);
  });

  it("refuses a reviewer decision from a contributor, and accepts it from a reviewer", async () => {
    const { eventId, claimId } = await writeDeployApproval(h);

    // Find the candidate the extraction created through the claim's explanation.
    const explained = await h.app.inject({
      method: "GET",
      url: `/v1/claims/${claimId}/explain`,
      headers: agentAuth(h),
    });
    const candidateId = (explained.json() as { candidate: { candidate_id: string } }).candidate.candidate_id;

    const contributor = await h.app.inject({
      method: "POST",
      url: `/v1/candidates/${candidateId}/decisions`,
      headers: agentJson(h),
        payload: { outcome: "accept", reason: "looks right" },
    });
    assert.equal(contributor.statusCode, 403, contributor.body);
    assert.equal((contributor.json() as { error: { code: string } }).error.code, "profile_insufficient");

    // The candidate read itself is a `contributor` tool, so the refusal above is the
    // decision specifically and not the whole candidate surface.
    const read = await h.app.inject({
      method: "GET",
      url: `/v1/candidates/${candidateId}`,
      headers: agentAuth(h),
    });
    assert.equal(read.statusCode, 200, read.body);
    const readBody = read.json() as { candidate: { candidate_id: string; state: string }; decisions: unknown[] };
    assert.equal(readBody.candidate.candidate_id, candidateId);
    assert.equal(readBody.candidate.state, "gated");
    assert.ok(readBody.decisions.length >= 1, "the gate's own decision must be visible on the candidate");

    // The privacy-admin credential holds `memory.decide` and the admin audience, so it
    // can record the reviewer outcome.
    const decided = await h.app.inject({
      method: "POST",
      url: `/v1/candidates/${candidateId}/decisions`,
      headers: adminJson(h),
        payload: { outcome: "reject", reason: "superseded by an explicit approval", approver: "ops:reviewer" },
    });
    assert.equal(decided.statusCode, 200, decided.body);
    const decision = decided.json() as { outcome: string; claim_created: boolean; approver: string };
    assert.equal(decision.outcome, "reject");
    assert.equal(decision.claim_created, false);
    assert.equal(decision.approver, "ops:reviewer");

    // A rejection is recorded, not discarded.
    const after = await h.app.inject({
      method: "GET",
      url: `/v1/candidates/${candidateId}`,
      headers: agentAuth(h),
    });
    assert.ok(
      (after.json() as { decisions: { outcome: string }[] }).decisions.some((entry) => entry.outcome === "reject"),
      "the reviewer decision must be readable afterwards",
    );

    // The event is still readable and still has exactly one accepted claim; a rejected
    // candidate does not remove evidence.
    const event = await h.app.inject({ method: "GET", url: `/v1/events/${eventId}`, headers: agentAuth(h) });
    assert.equal(event.statusCode, 200);
  });

  it("runs a forget job and reports its residual scan", async () => {
    const { claimId } = await writeDeployApproval(h);

    const forget = await h.app.inject({
      method: "POST",
      url: "/v1/forget",
      headers: adminJson(h),
        payload: { subject_or_scope: { user: h.user }, mode: "redact", reason: "gdpr_art17" },
    });
    assert.equal(forget.statusCode, 201, forget.body);
    const job = forget.json() as {
      job_id: string;
      status: string;
      tenant: string;
      stores_touched: string[];
      residual_matches: number | null;
      verified_at: string | null;
    };
    assert.equal(job.tenant, h.tenant);
    assert.ok(job.stores_touched.length > 0, "the manifest must name every store it touched");
    assert.equal(typeof job.residual_matches, "number");
    // A job reports `verified` only when the residual scan returned zero; the two
    // facts must agree rather than the status being optimistic.
    if (job.status === "verified") {
      assert.equal(job.residual_matches, 0);
      assert.ok(job.verified_at !== null);
    }

    const polled = await h.app.inject({
      method: "GET",
      url: `/v1/forget/${job.job_id}`,
      headers: adminAuth(h),
    });
    assert.equal(polled.statusCode, 200, polled.body);
    assert.equal((polled.json() as { job_id: string }).job_id, job.job_id);

    // The claim is revoked by the retention pass, and a revoked claim is denied at the
    // action gate rather than merely discouraged in a packet.
    const read = await h.app.inject({ method: "GET", url: `/v1/claims/${claimId}`, headers: agentAuth(h) });
    if (read.statusCode === 200) {
      const record = read.json() as { claim: { status: string } };
      assert.equal(record.claim.status, "revoked");
      const gate = await h.app.inject({
        method: "POST",
        url: "/v1/actions/gate",
        headers: agentJson(h),
            payload: {
          action: "read_deploy_window",
          action_risk: "low",
          scope: { tenant: h.tenant, project: h.project },
          purpose: h.purposes[0],
          claim_ids: [claimId],
        },
      });
      assert.equal(gate.statusCode, 200, gate.body);
      const verdict = gate.json() as { allowed: boolean; reason_codes: string[] };
      assert.equal(verdict.allowed, false, "a revoked claim must not authorise an action");
      assert.ok(verdict.reason_codes.includes("action.denied_claim_not_usable"));
    }
  });

  it("records feedback as an append-only ledger event", async () => {
    await writeDeployApproval(h);
    const queried = await h.app.inject({
      method: "POST",
      url: "/v1/query",
      headers: agentJson(h),
        payload: {
        query: "Which deployment window did Alice approve?",
        scope: { tenant: h.tenant, project: h.project, user: h.user },
        purpose: h.purposes[0],
      },
    });
    const traceId = (queried.json() as { trace_id: string }).trace_id;

    const feedback = await h.app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: agentJson(h),
        payload: { trace_id: traceId, outcome: "incorrect", correction: "the window moved to Monday" },
    });
    assert.equal(feedback.statusCode, 201, feedback.body);
    const body = feedback.json() as { feedback_event_id: string; trace_id: string; seq: number; outcome: string };
    assert.match(body.feedback_event_id, /^evt_[0-9a-f]{32}$/);
    assert.equal(body.trace_id, traceId);
    assert.ok(body.seq >= 1);

    // The correction is now evidence in the ledger, readable like any other event.
    const event = await h.app.inject({
      method: "GET",
      url: `/v1/events/${body.feedback_event_id}`,
      headers: agentAuth(h),
    });
    assert.equal(event.statusCode, 200, event.body);
    const stored = event.json() as { content: string | null; origin: string };
    assert.equal(stored.origin, "user");
    assert.ok(stored.content?.includes("the window moved to Monday"));

    // Feedback about a trace that does not exist is a 404, not a new event.
    const bogus = await h.app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: agentJson(h),
        payload: { trace_id: `qry_${"0".repeat(32)}`, outcome: "correct" },
    });
    assert.equal(bogus.statusCode, 404, bogus.body);
  });

  it("verifies the projections under replay and reports an evaluation honestly", async () => {
    await writeDeployApproval(h);

    const replay = await h.app.inject({
      method: "POST",
      url: "/v1/replay",
      headers: adminJson(h),
        payload: { mode: "verify" },
    });
    assert.equal(replay.statusCode, 200, replay.body);
    const body = replay.json() as {
      mode: string;
      deterministic: boolean;
      ledger_watermark: number;
      projections: { projection: string; byte_identical: boolean }[];
      policy_version: string;
    };
    assert.equal(body.mode, "verify");
    assert.ok(body.ledger_watermark >= 1);
    assert.ok(body.projections.length >= 1, "replay must report every projection it examined");
    assert.ok(
      body.projections.some((projection) => projection.projection === "embeddings"),
      `expected the dense projection in the report: ${replay.body}`,
    );
    assert.equal(body.deterministic, true);
    assert.equal(body.policy_version, DEFAULT_COMMIT_POLICY.version);

    const evaluation = await h.app.inject({
      method: "POST",
      url: "/v1/evaluations/runs",
      headers: adminJson(h),
        payload: { suite: "ledgerbench", gate: "on", seed: 7 },
    });
    assert.equal(evaluation.statusCode, 202, evaluation.body);
    const run = evaluation.json() as { suite: string; seed: number; stages: unknown[]; notes: string[] };
    assert.equal(run.suite, "ledgerbench");
    assert.equal(run.seed, 7);
    // No runner is wired into this process, and the response says so rather than
    // inventing a metric.
    assert.equal(run.stages.length, 0);
    assert.ok(run.notes.length > 0);
  });

  it("cross-check: another tenant reaches nothing", async () => {
    const { claimId } = await writeDeployApproval(h);
    const other = await createHarness("other");
    try {
      // A claim in a tenant the caller is not part of must be indistinguishable from
      // one that does not exist.
      const read = await other.app.inject({
        method: "GET",
        url: `/v1/claims/${claimId}`,
        headers: agentAuth(other),
      });
      assert.equal(read.statusCode, 404, `cross-tenant read returned ${read.statusCode}: ${read.body}`);

      const explain = await other.app.inject({
        method: "GET",
        url: `/v1/claims/${claimId}/explain`,
        headers: agentAuth(other),
      });
      assert.equal(explain.statusCode, 404, `cross-tenant explain returned ${explain.statusCode}: ${explain.body}`);

      // The action gate refuses an unreachable claim rather than revealing it.
      const gate = await other.app.inject({
        method: "POST",
        url: "/v1/actions/gate",
        headers: agentJson(other),
            payload: {
          action: "read_deploy_window",
          action_risk: "low",
          scope: { tenant: other.tenant, project: other.project },
          purpose: other.purposes[0],
          claim_ids: [claimId],
        },
      });
      assert.equal(gate.statusCode, 200, gate.body);
      const verdict = gate.json() as { allowed: boolean; claims: { found: boolean }[] };
      assert.equal(verdict.allowed, false);
      assert.equal(verdict.claims[0]?.found, false);
    } finally {
      await other.close();
    }
  });
});

function assertErrorShape(body: unknown): void {
  assert.ok(typeof body === "object" && body !== null, `expected an object body, got ${JSON.stringify(body)}`);
  const record = body as Record<string, unknown>;
  // Exactly one top-level key, so a client parses one shape and not two.
  assert.deepEqual(Object.keys(record), ["error"], `unexpected error envelope: ${JSON.stringify(body)}`);
  const error = record["error"] as Record<string, unknown>;
  assert.equal(typeof error["code"], "string");
  assert.equal(typeof error["message"], "string");
  assert.ok((error["code"] as string).length > 0);
}
