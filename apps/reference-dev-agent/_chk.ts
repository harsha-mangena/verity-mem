import { fixedClock, loadEnv, seededIds } from "@veritymem/ledger";
import { createEmbeddings, createRunnerDriver, createWorld } from "./src/world.ts";
import { runReferenceWorkload } from "./src/scenario.ts";
import { freshTenantSlug } from "./src/main.ts";
import { DEFAULT_COMMIT_POLICY } from "@veritymem/contracts";

const env = loadEnv();
const slug = freshTenantSlug("chk");
const clock = fixedClock("2026-09-01T09:00:00.000Z");
const world = createWorld({ tenantSlug: slug, project: "payments", databaseUrl: env.databaseUrl, blobDir: `${env.repoRoot}/.veritymem/blobs`, clock, ids: seededIds(`${slug}@${slug}`) });
const embeddings = createEmbeddings();
try {
  const run = await runReferenceWorkload(world, { driver: createRunnerDriver(world, embeddings), embeddings, policyVersion: DEFAULT_COMMIT_POLICY.version });
  console.log("same_project:", JSON.stringify(run.isolation.same_project, null, 1));
  console.log("cross_project claims:", JSON.stringify(run.isolation.cross_project.claims_returned));
  const claims = await world.db.withSystemContext({ tenant: world.tenantId, actor: "x" }, (ex) => ex.query("SELECT c.claim_id, c.predicate, s.user_id FROM claims c JOIN scopes s ON s.scope_id=c.scope_id ORDER BY c.claim_id"));
  console.log("all claims:", JSON.stringify(claims.rows));
} finally { await world.close(); }
