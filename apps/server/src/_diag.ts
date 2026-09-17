import { randomUUID } from "node:crypto";
import { Db, MemoryBlobStore, Ledger, fixedClock, loadEnv, seededIds } from "@veritymem/ledger";
import { buildDeps, loadServerConfig, buildEmbeddingBackend } from "./config.ts";
import { createServer } from "./server.ts";
import { DEFAULT_COMMIT_POLICY } from "@veritymem/contracts";

const env = loadEnv();
const db = new Db({ connectionString: env.databaseUrl, max: 4 });
const tenant = `diag-${randomUUID().slice(0, 8)}`;
const clock = fixedClock("2026-09-17T12:00:00.000Z");
const ids = seededIds(`diag-${randomUUID()}`);
const config = loadServerConfig({
  DATABASE_URL: env.databaseUrl, GATE_ENTAILMENT_BACKEND: "lexical", EMBEDDING_BACKEND: "hash",
  AGENT_TOKEN: `tenant:${tenant}:diag-agent`, ADMIN_TOKEN: `tenant:${tenant}:diag-admin`,
});
const deps = buildDeps({
  config, db, ledger: new Ledger({ db, blobs: new MemoryBlobStore(), clock, ids }),
  embeddings: buildEmbeddingBackend(config), ids, clock,
});
const app = await createServer({ deps, swaggerUi: false, logger: true });
const json = { authorization: "Bearer diag-agent", "content-type": "application/json" };
for (let i = 0; i < 2; i += 1) {
  const appended = await app.inject({ method: "POST", url: "/v1/events", headers: json, payload: {
    stream_id: `thread:diag${i}`, origin: "user", actor_id: "user:alice",
    scope: { tenant, project: "payments", user: "alice", purpose: ["release_planning"] },
    occurred_at: "2026-09-10T09:14:00Z", content: "I approved the Sunday 02:00 UTC deploy window." } });
  const ex = await app.inject({ method: "POST", url: `/v1/events/${appended.json().event_id}/extract`, headers: { authorization: "Bearer diag-agent" } });
  console.log("extract", i, ex.statusCode, ex.body.slice(0, 160));
}
await app.close(); await db.close();
