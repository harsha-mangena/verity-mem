import { randomUUID } from "node:crypto";
import { Db, MemoryBlobStore, Ledger, fixedClock, loadEnv, seededIds, resolveTenantId } from "@veritymem/ledger";
import { buildDeps, loadServerConfig, buildEmbeddingBackend } from "./config.ts";
import { createServer } from "./server.ts";

const env = loadEnv();
const db = new Db({ connectionString: env.databaseUrl, max: 4 });
const tenant = `diag-${randomUUID().slice(0, 8)}`;
const clock = fixedClock("2026-09-17T12:00:00.000Z");
const ids = seededIds(`diag-${randomUUID().slice(0, 8)}`);
const config = loadServerConfig({
  DATABASE_URL: env.databaseUrl, GATE_ENTAILMENT_BACKEND: "lexical", EMBEDDING_BACKEND: "hash",
  AGENT_TOKEN: `tenant:${tenant}:diag-agent`, ADMIN_TOKEN: `tenant:${tenant}:diag-admin`,
});
const deps = buildDeps({
  config, db, ledger: new Ledger({ db, blobs: new MemoryBlobStore(), clock, ids }),
  embeddings: buildEmbeddingBackend(config), ids, clock,
});
const app = await createServer({ deps, swaggerUi: false, logger: false });
const headers = { authorization: "Bearer diag-agent", "content-type": "application/json" };
const appended = await app.inject({ method: "POST", url: "/v1/events", headers, payload: {
  stream_id: "thread:diag", origin: "user", actor_id: "user:alice",
  scope: { tenant, project: "payments", user: "alice", purpose: ["release_planning"] },
  occurred_at: "2026-09-10T09:14:00Z", content: "I approved the Sunday 02:00 UTC deploy window." } });
console.log("append:", appended.statusCode, appended.body);
const eventId = appended.json().event_id;
for (const url of [`/v1/events/${eventId}`, `/v1/events/${eventId}/extract`]) {
  const r = await app.inject({ method: url.endsWith("extract") ? "POST" : "GET", url, headers });
  console.log(url, "->", r.statusCode, r.body.slice(0, 400));
}
const tid = resolveTenantId(tenant);
const rows = await db.withSystemContext({ tenant: tid, actor: "diag" }, async (ex) =>
  ex.query("SELECT event_id, tenant_id, scope_id, payload FROM events"));
console.log("tenantId", tid);
console.log("rows:", JSON.stringify(rows.rows));
const scopes = await db.withSystemContext({ tenant: tid, actor: "diag" }, async (ex) =>
  ex.query("SELECT scope_id, project, user_id, purpose FROM scopes"));
console.log("scopes:", JSON.stringify(scopes.rows));
const ev = await db.withRequest({ tenant: tid, principal: "agent:client", scopeIds: [], purposes: [], action: "diag" },
  async (ex) => {
    const r = await ex.query("SELECT count(*)::int AS n FROM events");
    const r2 = await ex.query("SELECT count(*)::int AS n FROM events WHERE event_id = $1::uuid", ["23a826dd-c1bc-0d3d-b5a6-000000000001"]);
    const r3 = await ex.query("SELECT current_setting('veritymem.tenant_id', true) AS t, current_setting('veritymem.system', true) AS s");
    return { all: r.rows[0], byId: r2.rows[0], guc: r3.rows[0] };
  });
console.log("withRequest:", JSON.stringify(ev));
const ev2 = await db.withRequest({ tenant: tid, principal: "agent:client", scopeIds: [], purposes: [], action: "diag" },
  async (ex) => deps.ledger.readEvent(ex, "evt_23a826ddc1bc0d3db5a6000000000001"));
console.log("readEvent:", JSON.stringify(ev2));
await app.close(); await db.close();
