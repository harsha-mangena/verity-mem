import { fixedClock, loadEnv, seededIds, resolveTenantId } from "@veritymem/ledger";
import { createWorld, createRunnerDriver } from "./src/world.ts";
import { HashEmbeddingBackend, compose } from "@veritymem/retrieval";

const env = loadEnv();
const slug = `repro-${Date.now()}`;
const clock = fixedClock("2026-09-01T09:00:00.000Z");
const ids = seededIds(`${slug}-seed`);
const world = createWorld({ tenantSlug: slug, project: "payments", databaseUrl: env.databaseUrl, blobDir: `${env.repoRoot}/.veritymem/blobs`, clock, ids });
clock.advance(86_400_000);
try {
  await world.ledger.append({ stream_id: "s", idempotency_key: "k1", origin: "user", actor_id: "user:alice", scope: { tenant: slug, project: "payments", user: "alice", purpose: ["release_planning"] }, occurred_at: clock.now().toISOString(), content: "I approved the Sunday 02:00 UTC deploy window." });
  const driver = createRunnerDriver(world);
  console.log("drain:", JSON.stringify(await driver.drain()));
  const deps = { db: world.db, ledger: world.ledger, embeddings: new HashEmbeddingBackend({ dimensions: 1024 }), ids: world.ids, clock: world.clock, policyVersion: "commit-v3", gateBackend: "lexical-overlap@1" };
  const r = await compose(deps, { tenant_id: world.tenantId, query: "Which deploy window did Alice approve?", scope: { tenant: slug, project: "payments", user: "alice" }, purpose: "release_planning", action_risk: "low", limit: 12 }, { principal: "user:alice" });
  console.log("plan scopes:", JSON.stringify(r.plan.authorized_scope_ids));
  console.log("resolution:", r.plan.scope_resolution, "denied:", JSON.stringify(r.plan.denied_dimensions));
  console.log("channels:", JSON.stringify(r.channels.map(c=>({c:c.channel, ran:c.ran, hits:c.hits.length, note:c.note}))));
  console.log("fused:", r.fused.length, "claims:", r.packet.claims.map(c=>c.claim_id), "missing:", JSON.stringify(r.packet.missing));
  const raw = await world.db.withSystemContext({ tenant: world.tenantId, actor: "x" }, (ex) => ex.query("SELECT claim_id, subject, predicate, status::text s, scope_id FROM claims"));
  console.log("claims in db:", JSON.stringify(raw.rows));
  const ps = await world.db.withRequest({ tenant: world.tenantId, principal: "user:alice", scopeIds: [], purposes: ["release_planning"], action: "read" }, (ex) => ex.query("SELECT principal_id, scope_id FROM principal_scopes"));
  console.log("principal_scopes visible to alice:", JSON.stringify(ps.rows));
} finally { await world.close(); }
