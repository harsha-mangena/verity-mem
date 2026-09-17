/**
 * Isolation over the REST read surfaces.
 *
 * `packages/retrieval/src/isolation-corpus.test.ts` drives `compose()` directly, which
 * proves the *retrieval* path enforces a boundary. It does not prove the HTTP surface
 * does, and the two are different code: a route handler reads by id, and an id is a
 * capability unless the read is authorised. `docs/isolation-assessment.md` §5 records
 * this as uncovered and names `/explain` as the most valuable target, because it is
 * designed to be the most complete read in the system — claim, evidence, spans,
 * decisions, relations and promotion history in one response.
 *
 * So every case here is a *foreign* read: tenant B's credential presenting tenant A's
 * identifier. Two failure modes are assertions, not one:
 *
 *   1. a 200 carrying A's data, which is a leak; and
 *   2. a response whose *status* differs between an existing-but-unreachable id and a
 *      nonexistent one, which is an existence oracle even when no data is returned.
 *
 * Both leaks are invisible to a test that only asserts "did not return the row", which
 * is why the negative control is a malformed id and the positive control is the owner's
 * own read. Without the positive control a route that 404s everything would pass.
 *
 * `app.inject()` is used rather than a socket, and it is not a mock: the same router,
 * hooks, schema validation and handlers run, and row-level security is enforced by
 * Postgres rather than by a stub.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Db, MemoryBlobStore, Ledger, fixedClock, loadEnv, resolveTenantId, seededIds } from "@veritymem/ledger";
import { DEFAULT_COMMIT_POLICY } from "@veritymem/contracts";
import { buildDeps, buildEmbeddingBackend, buildEntailmentBackend, loadServerConfig } from "./config.ts";
import type { ServerDeps } from "./config.ts";
import { createServer } from "./server.ts";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";

const env = loadEnv();

interface Tenant {
  readonly app: FastifyInstance;
  readonly deps: ServerDeps;
  readonly slug: string;
  readonly tenantId: string;
  readonly token: string;
  readonly project: string;
  readonly user: string;
  readonly purposes: readonly string[];
  /** Scope ids written through this tenant's own request path, for the RLS probe. */
  readonly scopeIds: string[];
  close(): Promise<void>;
}

async function boot(label: string): Promise<Tenant> {
  const suffix = randomUUID().slice(0, 8);
  const slug = `restiso-${label}-${suffix}`;
  const token = `token-${label}-${suffix}`;
  const db = new Db({ connectionString: env.databaseUrl, max: 4 });
  const blobs = new MemoryBlobStore();
  const clock = fixedClock("2026-09-17T12:00:00.000Z");
  // Salted per harness: the ledger's primary keys are the generated event and claim
  // ids, so two harnesses sharing a seed collide on the first append.
  const ids = seededIds(`restiso-${label}-${randomUUID()}`);
  const ledger = new Ledger({ db, blobs, clock, ids });

  const config = loadServerConfig({
    DATABASE_URL: env.databaseUrl,
    GATE_ENTAILMENT_BACKEND: "lexical",
    EMBEDDING_BACKEND: "hash",
    // Both credentials are bound to the tenant. The by-id routes have no tenant in the
    // body to bind, so a credential that is not bound to one cannot use them at all —
    // which is the property under test rather than an inconvenience.
    AGENT_TOKEN: `tenant:${slug}:${token}`,
    ADMIN_TOKEN: `tenant:${slug}:admin-${suffix}`,
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
    slug,
    tenantId: resolveTenantId(slug),
    token,
    project: `proj-${suffix}`,
    user: `user-${suffix}`,
    purposes: ["release_planning"],
    scopeIds: [],
    async close() {
      await app.close();
      await db.close();
    },
  };
}

/**
 * Auth for a request that carries no body.
 *
 * `content-type: application/json` on a bodyless POST is rejected by Fastify before any
 * handler runs, with a 400 that looks like an authorisation failure and is not one. The
 * two header sets are separate so that a bodyless route is not accidentally probed with a
 * header that makes it fail for an unrelated reason -- which is what happened when this
 * file was first written and cost an hour of chasing a boundary that was never crossed.
 */
function auth(t: Tenant): Record<string, string> {
  return { authorization: `Bearer ${t.token}` };
}

/** Auth for a request that carries a JSON body. */
function authJson(t: Tenant): Record<string, string> {
  return { authorization: `Bearer ${t.token}`, "content-type": "application/json" };
}

/** Write one event and accept one claim, returning both ids. */
async function seed(t: Tenant): Promise<{ eventId: string; claimId: string; traceId: string; candidateId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const appended = await t.app.inject({
    method: "POST",
    url: "/v1/events",
    headers: authJson(t),
    payload: {
      stream_id: `thread:${suffix}`,
      idempotency_key: `turn-${suffix}`,
      origin: "user",
      actor_id: `user:owner-${suffix}`,
      scope: { tenant: t.slug, project: t.project, user: t.user, purpose: [...t.purposes] },
      occurred_at: "2026-09-10T09:14:00Z",
      content: "I approved the Sunday 02:00 UTC deploy window.",
    },
  });
  assert.equal(appended.statusCode, 202, `seed append failed: ${appended.body}`);
  const eventId = (appended.json() as { event_id: string }).event_id;

  const extracted = await t.app.inject({ method: "POST", url: `/v1/events/${eventId}/extract`, headers: auth(t) });
  assert.equal(extracted.statusCode, 200, `seed extract failed: ${extracted.body}`);
  const extractBody = extracted.json() as { claims: string[]; candidates: string[] };
  const claimId = extractBody.claims[0];
  const candidateId = extractBody.candidates[0];
  assert.ok(claimId, `seed produced no claim: ${extracted.body}`);
  assert.ok(candidateId, `seed produced no candidate: ${extracted.body}`);

  // A query, so there is a stored trace to read. The trace id is returned on the packet.
  const queried = await t.app.inject({
    method: "POST",
    url: "/v1/query",
    headers: authJson(t),
    payload: {
      query: "Sunday 02:00 UTC deploy window",
      scope: { tenant: t.slug, project: t.project, user: t.user },
      purpose: "release_planning",
    },
  });
  assert.equal(queried.statusCode, 200, `seed query failed: ${queried.body}`);
  const traceId = (queried.json() as { trace_id: string }).trace_id;
  assert.ok(traceId, `seed query returned no trace id: ${queried.body}`);

  return { eventId, claimId, traceId, candidateId };
}

/**
 * The scope ids the tenant's events were written under.
 *
 * Read back rather than remembered, because the scope is created by the ledger on
 * append and its id is the one the RLS predicate consults.
 */
async function scopeIdsFor(t: Tenant, eventId: string): Promise<string[]> {
  const rows = await t.deps.db.withSystemContext({ tenant: t.tenantId, actor: "rest-isolation" }, (executor) =>
    executor.query<{ scope_id: string }>("SELECT DISTINCT scope_id FROM events WHERE tenant_id = $1::uuid", [
      t.tenantId,
    ]),
  );
  assert.ok(rows.rows.length > 0, `no scope found for the seeded event ${eventId}`);
  return rows.rows.map((row) => row.scope_id);
}

/** The ids the by-id read routes accept, plus a well-formed id that exists nowhere. */
const ABSENT_CLAIM = `clm_${"0".repeat(32)}`;
const ABSENT_EVENT = `evt_${"0".repeat(32)}`;

describe("REST read surfaces enforce isolation", () => {
  let owner: Tenant;
  let foreignTenant: Tenant;
  let seeded: { eventId: string; claimId: string; traceId: string; candidateId: string };

  before(async () => {
    owner = await boot("owner");
    foreignTenant = await boot("foreign");
    seeded = await seed(owner);
    owner.scopeIds.push(...(await scopeIdsFor(owner, seeded.eventId)));
  });

  after(async () => {
    await owner?.close();
    await foreignTenant?.close();
  });

  /**
   * The routes that return tenant data by identifier.
   *
   * `GET /v1/claims/:id/explain` is listed deliberately: it returns the claim, its
   * evidence spans with quotes, the full decision history, the relations and the
   * promotion path, so it is the richest thing an attacker can ask for and the most
   * expensive to get wrong.
   */
  const byIdRoutes = (ids: {
    claimId: string;
    eventId: string;
    candidateId: string;
    traceId: string;
  }): Array<{ route: string; url: string }> => [
    { route: "GET /v1/claims/:claim_id", url: `/v1/claims/${ids.claimId}` },
    { route: "GET /v1/claims/:claim_id/explain", url: `/v1/claims/${ids.claimId}/explain` },
    { route: "GET /v1/events/:event_id", url: `/v1/events/${ids.eventId}` },
    { route: "GET /v1/candidates/:candidate_id", url: `/v1/candidates/${ids.candidateId}` },
    { route: "GET /v1/query-traces/:trace_id", url: `/v1/query-traces/${ids.traceId}` },
  ];

  it("refuses a foreign claim and a foreign event, and does not leak their content", async () => {
    // Positive control first. If the owner's own read fails, every assertion below would
    // pass for the wrong reason: a route that is broken for everyone is not isolated.
    for (const { route, url } of byIdRoutes(seeded)) {
      const own = await owner.app.inject({ method: "GET", url, headers: auth(owner) });
      assert.equal(own.statusCode, 200, `${route} must succeed for the owner: ${own.body}`);
    }

    for (const { route, url } of byIdRoutes(seeded)) {
      const response = await foreignTenant.app.inject({ method: "GET", url, headers: auth(foreignTenant) });
      assert.notEqual(response.statusCode, 200, `${route} returned 200 to a foreign tenant: ${response.body}`);
      // The content assertions are belt and braces on top of the status: a 200 with an
      // empty body would already have failed above, but a *non-200* that echoes the row
      // in an error payload would not.
      const body = response.body;
      assert.ok(!body.includes(seeded.claimId), `${route} leaked the claim id in a refusal: ${body}`);
      assert.ok(!body.includes(seeded.eventId), `${route} leaked the event id in a refusal: ${body}`);
      assert.ok(!body.includes(seeded.candidateId), `${route} leaked the candidate id in a refusal: ${body}`);
      assert.ok(!body.includes(seeded.traceId), `${route} leaked the trace id in a refusal: ${body}`);
      assert.ok(
        !body.includes("Sunday 02:00 UTC deploy window"),
        `${route} leaked the event content in a refusal: ${body}`,
      );
    }
  });

  it("does not distinguish an unreachable identifier from a nonexistent one", async () => {
    // An existence oracle does not need to return data. If `explain` answers 403 for an
    // id in another tenant but 404 for an id that exists nowhere, an attacker has a
    // membership test even though both responses are refusals -- and iterating it
    // enumerates the deployment.
    const pairs: Array<{ route: string; reachable: string; absent: string }> = [
      {
        route: "GET /v1/claims/:claim_id",
        reachable: `/v1/claims/${seeded.claimId}`,
        absent: `/v1/claims/${ABSENT_CLAIM}`,
      },
      {
        route: "GET /v1/claims/:claim_id/explain",
        reachable: `/v1/claims/${seeded.claimId}/explain`,
        absent: `/v1/claims/${ABSENT_CLAIM}/explain`,
      },
      {
        route: "GET /v1/events/:event_id",
        reachable: `/v1/events/${seeded.eventId}`,
        absent: `/v1/events/${ABSENT_EVENT}`,
      },
      {
        route: "GET /v1/candidates/:candidate_id",
        reachable: `/v1/candidates/${seeded.candidateId}`,
        absent: `/v1/candidates/cnd_${"0".repeat(32)}`,
      },
      {
        route: "GET /v1/query-traces/:trace_id",
        reachable: `/v1/query-traces/${seeded.traceId}`,
        absent: `/v1/query-traces/qry_${"0".repeat(32)}`,
      },
    ];

    for (const { route, reachable, absent } of pairs) {
      // Positive control: the identifier in question *is* readable by its owner, so the
      // foreign 404 below is the boundary and not an id that exists nowhere. Without this
      // the whole test could pass on a route that 404s everything.
      const ownerRead = await owner.app.inject({ method: "GET", url: reachable, headers: auth(owner) });
      assert.equal(ownerRead.statusCode, 200, `${route} must be readable by its owner: ${ownerRead.body}`);

      const existing = await foreignTenant.app.inject({ method: "GET", url: reachable, headers: auth(foreignTenant) });
      const missing = await foreignTenant.app.inject({ method: "GET", url: absent, headers: auth(foreignTenant) });
      assert.equal(
        existing.statusCode,
        missing.statusCode,
        `${route} distinguishes an unreachable id (${existing.statusCode}) from a nonexistent one ` +
          `(${missing.statusCode}), which is an existence oracle even though neither returns data`,
      );
      const code = (r: { json(): unknown }): unknown =>
        (r.json() as { error?: { code?: string } }).error?.code;
      assert.equal(
        code(existing),
        code(missing),
        `${route} returns a different error code for an unreachable id than for a nonexistent one`,
      );
    }
  });

  it("returns the owner's own candidate and trace, so the refusals above are the boundary", async () => {
    // Part of the positive control, split out because a candidate and a trace are the
    // two surfaces whose owner-visibility is least obvious: a candidate is a proposal
    // rather than a belief, and a trace records what the caller asked for.
    for (const [route, url] of [
      ["GET /v1/candidates/:candidate_id", `/v1/candidates/${seeded.candidateId}`],
      ["GET /v1/query-traces/:trace_id", `/v1/query-traces/${seeded.traceId}`],
    ] as const) {
      const own = await owner.app.inject({ method: "GET", url, headers: auth(owner) });
      assert.equal(own.statusCode, 200, `${route} must succeed for the owner: ${own.body}`);
      const foreignRead = await foreignTenant.app.inject({ method: "GET", url, headers: auth(foreignTenant) });
      assert.notEqual(foreignRead.statusCode, 200, `${route} returned 200 to a foreign tenant`);
    }
  });

  it("refuses an unauthenticated read on every by-id surface", async () => {
    // The boundary must not depend on a token being present-but-wrong. An anonymous
    // request that reaches a handler is a handler that has to remember to authorise.
    for (const { route, url } of byIdRoutes(seeded)) {
      const response = await foreignTenant.app.inject({ method: "GET", url });
      assert.ok(
        response.statusCode === 401 || response.statusCode === 403,
        `${route} answered ${response.statusCode} without a credential: ${response.body}`,
      );
      assert.ok(!response.body.includes(seeded.claimId), `${route} leaked to an anonymous caller`);
    }
  });

  it("does not return another tenant's claims through a query", async () => {
    // The query path is the one `isolation-corpus.test.ts` already covers at the
    // library level. Asserting it over HTTP as well is cheap and catches a route that
    // resolves the tenant from the body while the library resolves it from the caller.
    const response = await foreignTenant.app.inject({
      method: "POST",
      url: "/v1/query",
      headers: authJson(foreignTenant),
      payload: {
        query: "Sunday 02:00 UTC deploy window",
        scope: { tenant: foreignTenant.slug, project: foreignTenant.project, user: foreignTenant.user },
        purpose: "release_planning",
      },
    });
    assert.equal(response.statusCode, 200, `query failed: ${response.body}`);
    const packet = response.body;
    assert.ok(!packet.includes(seeded.claimId), `query leaked a foreign claim: ${packet}`);

    // Negative control for the assertion above: the owner's identical query *does*
    // return the claim, so the absence is the boundary and not a query that matches
    // nothing.
    const own = await owner.app.inject({
      method: "POST",
      url: "/v1/query",
      headers: authJson(owner),
      payload: {
        query: "Sunday 02:00 UTC deploy window",
        scope: { tenant: owner.slug, project: owner.project, user: owner.user },
        purpose: "release_planning",
      },
    });
    assert.equal(own.statusCode, 200, `owner query failed: ${own.body}`);
    assert.ok(
      own.body.includes(seeded.claimId),
      `the owner's own query did not return the seeded claim, so the foreign assertion above proves nothing: ${own.body}`,
    );
  });

  it("refuses a query that names a tenant the credential is not bound to", async () => {
    // The caller does not get to choose its tenant. A credential valid for one tenant
    // must not be usable against another by naming it in the body.
    const response = await foreignTenant.app.inject({
      method: "POST",
      url: "/v1/query",
      headers: authJson(foreignTenant),
      payload: {
        query: "deploy window",
        scope: { tenant: owner.slug, project: owner.project, user: owner.user },
        purpose: "release_planning",
      },
    });
    assert.equal(response.statusCode, 403, `a foreign tenant in the body was accepted: ${response.body}`);
    assert.equal((response.json() as { error: { code: string } }).error.code, "tenant_mismatch");
  });

  it("relies on row-level security that binds without any request context", async () => {
    // The route-level assertions above cannot distinguish a handler that refuses a
    // foreign id from a database that never showed it the row. This asserts the second,
    // because that is the one that survives a handler forgetting to check.
    //
    // A raw client as the *application role* -- the same role the server connects as, so
    // no superuser and no BYPASSRLS -- with no tenant context and no transaction. If RLS
    // were not load-bearing, this is the query that would return every tenant's events.
    const client = new Client({ connectionString: env.databaseUrl });
    await client.connect();
    try {
      const contextless = await client.query<{ events: string; claims: string }>(
        "SELECT (SELECT count(*) FROM events)::text AS events, (SELECT count(*) FROM claims)::text AS claims",
      );
      assert.equal(
        contextless.rows[0]?.events,
        "0",
        "the application role can read events with no request context, so row-level security is not binding",
      );
      assert.equal(contextless.rows[0]?.claims, "0", "the application role can read claims with no request context");

      // With a real request context the same role over the same connection sees its own
      // rows. This is the positive control for the zeroes above and the proof that RLS is
      // filtering rather than refusing the role outright: the context is the only thing
      // that changed.
      //
      // The binding goes through `veritymem.set_request_context`, which is the function
      // `Db.withRequest` calls, rather than through individual `set_config` calls. That
      // matters: setting the tenant alone is *not* enough to confer reach, because the
      // predicate also consults the caller's scopes and purposes. A test that set the
      // tenant by hand and then saw rows would have proved something the server never
      // does.
      await client.query("BEGIN");
      await client.query("SELECT veritymem.set_request_context($1::uuid, $2, $3::uuid[], $4::text[], $5)", [
        owner.tenantId,
        "user:rls-probe",
        `{${owner.scopeIds.join(",")}}`,
        "{release_planning}",
        "read",
      ]);
      const bound = await client.query<{ events: string; claims: string }>(
        "SELECT (SELECT count(*) FROM events)::text AS events, (SELECT count(*) FROM claims)::text AS claims",
      );
      await client.query("ROLLBACK");

      assert.notEqual(
        bound.rows[0]?.events,
        "0",
        "the owner's tenant has no events, so the RLS zeroes above prove nothing; or the context " +
          "does not confer reach, in which case row-level security is blocking rather than filtering",
      );
      assert.notEqual(bound.rows[0]?.claims, "0", "the bound context did not confer reach to claims");
    } finally {
      await client.end();
    }
  });
});
