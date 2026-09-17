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
const json = { authorization: "Bearer diag-agent", "content-type": "application/json" };
const appended = await app.inject({ method: "POST", url: "/v1/events", headers: json, payload: {
  stream_id: "thread:diag", origin: "user", actor_id: "user:alice",
  scope: { tenant, project: "payments", user: "alice", purpose: ["release_planning"] },
  occurred_at: "2026-09-10T09:14:00Z", content: "I approved the Sunday 02:00 UTC deploy window." } });
const eventId = appended.json().event_id;
const ex = await app.inject({ method: "POST", url: `/v1/events/${eventId}/extract`, headers: { authorization: "Bearer diag-agent" } });
console.log("extract:", ex.statusCode, ex.body.slice(0, 300));
console.log("extract body full:", ex.body); const claimId = (ex.json().claims ?? [])[0]; if (!claimId) { await app.close(); await db.close(); process.exit(0); }
const explained = await app.inject({ method: "GET", url: `/v1/claims/${claimId}/explain`, headers: { authorization: "Bearer diag-agent" } });
const cid = explained.json().candidate.candidate_id;
console.log("candidateId:", cid, "len-after-prefix:", cid.slice(4).length);
const rows = await db.withSystemContext({ tenant: resolveTenantId(tenant), actor: "diag" }, async (e) =>
  e.query("SELECT candidate_id FROM claim_candidates"));
console.log("db candidate_id:", JSON.stringify(rows.rows));
const read = await app.inject({ method: "GET", url: `/v1/candidates/${cid}`, headers: { authorization: "Bearer diag-agent" } });
console.log("candidate read:", read.statusCode, read.body.slice(0, 300));
await app.close(); await db.close();
