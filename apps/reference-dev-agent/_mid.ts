import { fixedClock, loadEnv, seededIds } from "@veritymem/ledger";
import { createWorld, createRunnerDriver } from "./src/world.ts";
import { HashEmbeddingBackend, compose } from "@veritymem/retrieval";

const env = loadEnv();
const slug = `mid-${Date.now()}`;
const clock = fixedClock("2026-09-01T09:00:00.000Z");
const world = createWorld({ tenantSlug: slug, project: "payments", databaseUrl: env.databaseUrl, blobDir: `${env.repoRoot}/.veritymem/blobs`, clock, ids: seededIds(`${slug}-s`) });
const driver = createRunnerDriver(world);
const deps = { db: world.db, ledger: world.ledger, embeddings: new HashEmbeddingBackend({ dimensions: 1024 }), ids: world.ids, clock: world.clock, policyVersion: "commit-v3", gateBackend: "lexical-overlap@1" };
try {
  clock.advance(86_400_000);
  await world.ledger.append({ stream_id: "ci", idempotency_key: "ci", origin: "tool", actor_id: "user:bob", scope: { tenant: slug, project: "payments", purpose: ["release_planning"] }, occurred_at: clock.now().toISOString(), content: "ci-job 8842 on branch: main, commit 9f2c1ab4d3e5f60718293a4b5c6d7e8f90a1b2c3: status: success, 128 tests passed, 0 tests failed, exit code: 0" });
  console.log("drain1", JSON.stringify(await driver.drain()));
  clock.advance(86_400_000);
  await world.ledger.append({ stream_id: "rel", idempotency_key: "ap", origin: "user", actor_id: "user:alice", scope: { tenant: slug, project: "payments", user: "alice", purpose: ["release_planning"] }, occurred_at: clock.now().toISOString(), content: "I approved the Sunday 02:00 UTC deploy window." });
  console.log("drain2", JSON.stringify(await driver.drain()));
  const st = await world.db.withSystemContext({ tenant: world.tenantId, actor: "x" }, async (ex) => ({
    claims: (await ex.query("SELECT claim_id, subject, predicate, status::text s, scope_id, valid_to FROM claims ORDER BY claim_id")).rows,
    emb: (await ex.query("SELECT claim_id, model_id FROM claim_embeddings")).rows,
    outbox: (await ex.query("SELECT kind, completed_at IS NOT NULL done, last_error, attempts FROM outbox ORDER BY outbox_id")).rows,
  }));
  console.log(JSON.stringify(st, null, 1));
  const r = await compose(deps, { tenant_id: world.tenantId, query: "Which deploy window did Alice approve?", scope: { tenant: slug, project: "payments", user: "alice" }, purpose: "release_planning", action_risk: "low", limit: 12 }, { principal: "user:alice" });
  console.log("scopes", JSON.stringify(r.plan.authorized_scope_ids), "channels", JSON.stringify(r.channels.map(c=>[c.channel,c.hits.length])), "claims", r.packet.claims.length);
} finally { await world.close(); }
