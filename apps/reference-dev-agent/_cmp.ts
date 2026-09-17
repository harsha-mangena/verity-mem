import { fixedClock, loadEnv, seededIds } from "@veritymem/ledger";
import { createRunnerDriver, createWorld } from "./src/world.ts";
import { runReferenceWorkload } from "./src/scenario.ts";
import { DEFAULT_COMMIT_POLICY } from "@veritymem/contracts";
import { HashEmbeddingBackend, compose } from "@veritymem/retrieval";

const env = loadEnv();
const slug = `cmp-${Date.now()}`;
const clock = fixedClock("2026-09-01T09:00:00.000Z");
const ids = seededIds(`${slug}@${slug}`);
const world = createWorld({ tenantSlug: slug, project: "payments", databaseUrl: env.databaseUrl, blobDir: `${env.repoRoot}/.veritymem/blobs`, clock, ids });
const base = createRunnerDriver(world);
const sharedDeps = { db: world.db, ledger: world.ledger, embeddings: new HashEmbeddingBackend({ dimensions: 1024 }), ids, clock, policyVersion: "commit-v3", gateBackend: "lexical-overlap@1" };
try {
  await runReferenceWorkload(world, {
    driver: base,
    embeddingModelId: "hash-ngram-v1",
    policyVersion: DEFAULT_COMMIT_POLICY.version,
    onStep: async (step) => {
      if (step.step !== 4) return;
      for (const [label, d] of [["shared-instance", sharedDeps], ["fresh-instance", { ...sharedDeps, embeddings: new HashEmbeddingBackend({ dimensions: 1024 }) }]] as const) {
        const r = await compose(d, { tenant_id: world.tenantId, query: "Which deploy window did Alice approve?", scope: { tenant: slug, project: "payments", user: "alice" }, purpose: "release_planning", action_risk: "low", limit: 12 }, { principal: "user:alice" });
        console.log(label, JSON.stringify(r.plan.authorized_scope_ids), JSON.stringify(r.channels.map((c) => [c.channel, c.hits.length, c.note])), r.packet.claims.length);
      }
    },
  });
} finally { await world.close(); }
