import { fixedClock, loadEnv, seededIds } from "@veritymem/ledger";
import { createRunnerDriver, createWorld } from "./src/world.ts";
import { runReferenceWorkload } from "./src/scenario.ts";
import { DEFAULT_COMMIT_POLICY } from "@veritymem/contracts";

const env = loadEnv();
const slug = `full-${Date.now()}`;
const clock = fixedClock("2026-09-01T09:00:00.000Z");
const world = createWorld({ tenantSlug: slug, project: "payments", databaseUrl: env.databaseUrl, blobDir: `${env.repoRoot}/.veritymem/blobs`, clock, ids: seededIds(`${slug}@${slug}`) });
try {
  const driver = createRunnerDriver(world);
  const result = await runReferenceWorkload(world, {
    driver: {
      async drain() {
        const summary = await driver.drain();
        const st = await world.db.withSystemContext({ tenant: world.tenantId, actor: "x" }, async (ex) => ({
          claims: (await ex.query("SELECT claim_id, predicate, status::text s, scope_id FROM claims ORDER BY claim_id")).rows,
          scopes: (await ex.query("SELECT scope_id, user_id FROM scopes")).rows,
          emb: (await ex.query("SELECT claim_id FROM claim_embeddings")).rows,
        }));
        console.log("DRAIN", JSON.stringify(summary), "claims", st.claims.length, "emb", st.emb.length);
        const probeDeps = { db: world.db, ledger: world.ledger, embeddings: new (await import("@veritymem/retrieval")).HashEmbeddingBackend({ dimensions: 1024 }), ids: world.ids, clock: world.clock, policyVersion: "commit-v3", gateBackend: "lexical-overlap@1" };
        const { compose } = await import("@veritymem/retrieval");
        const r = await compose(probeDeps, { tenant_id: world.tenantId, query: "deploy window approved", scope: { tenant: slug, project: "payments", user: "alice" }, purpose: "release_planning", action_risk: "low", limit: 12 }, { principal: "user:alice" });
        console.log("   probe scopes", JSON.stringify(r.plan.authorized_scope_ids), "channels", JSON.stringify(r.channels.map((c) => [c.channel, c.hits.length])), "claims", r.packet.claims.length, "|", r.plan.scope_resolution, "| aliceScope?", st.scopes.map((x) => x.user_id));
        return summary;
      },
    },
    embeddingModelId: "hash-ngram-v1",
    policyVersion: DEFAULT_COMMIT_POLICY.version,
    onStep: (step) => console.log("STEP", step.step, step.name),
  });
  console.log("isolation:", JSON.stringify(result.isolation));
  const probeDeps = { db: world.db, ledger: world.ledger, embeddings: new (await import("@veritymem/retrieval")).HashEmbeddingBackend({ dimensions: 1024 }), ids: world.ids, clock: world.clock, policyVersion: "commit-v3", gateBackend: "lexical-overlap@1" };
  const { compose } = await import("@veritymem/retrieval");
  for (const [label, scope] of [["alice", { tenant: slug, project: "payments", user: "alice" }], ["project", { tenant: slug, project: "payments" }]]) {
    const r = await compose(probeDeps, { tenant_id: world.tenantId, query: "deploy window approved", scope, purpose: "release_planning", action_risk: "low", limit: 12 }, { principal: "user:alice" });
    console.log("PROBE", label, JSON.stringify(r.plan.authorized_scope_ids), JSON.stringify(r.channels.map((c) => [c.channel, c.hits.length])), r.packet.claims.length, r.plan.scope_resolution);
  }
  const st = await world.db.withSystemContext({ tenant: world.tenantId, actor: "x" }, async (ex) => ({
    scopes: (await ex.query("SELECT scope_id, project, user_id FROM scopes")).rows,
    claims: (await ex.query("SELECT claim_id, predicate, status::text s, scope_id FROM claims ORDER BY claim_id")).rows,
    ps: (await ex.query("SELECT principal_id, scope_id FROM principal_scopes")).rows,
  }));
  console.log(JSON.stringify(st, null, 1));
} finally { await world.close(); }
