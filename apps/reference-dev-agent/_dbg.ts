import { fixedClock, loadEnv, seededIds, resolveTenantId } from "@veritymem/ledger";
import { createWorld } from "./src/world.ts";
import { HashEmbeddingBackend, planQuery, compose } from "@veritymem/retrieval";
const env = loadEnv();
const slug = process.argv[2]!;
const world = createWorld({ tenantSlug: slug, project: "payments", databaseUrl: env.databaseUrl, blobDir: `${env.repoRoot}/.veritymem/blobs`, clock: fixedClock("2026-09-01T09:00:00.000Z"), ids: seededIds("dbg") });
try {
  const info = await world.db.withSystemContext({ tenant: world.tenantId, actor: "dbg" }, async (ex) => {
    const ps = await ex.query("SELECT principal_id, scope_id FROM principal_scopes");
    const sc = await ex.query("SELECT scope_id, project, user_id, purpose FROM scopes ORDER BY user_id NULLS FIRST");
    const cl = await ex.query("SELECT claim_id, status::text AS s, authority::text AS a, subject, predicate, scope_id FROM claims ORDER BY claim_id");
    return { ps: ps.rows, sc: sc.rows, cl: cl.rows };
  });
  console.log(JSON.stringify(info, null, 1));
  const plan = await world.db.withRequest({ tenant: world.tenantId, principal: "user:alice", scopeIds: [], purposes: ["release_planning"], action: "query:plan" }, (ex) =>
    planQuery(ex, { tenant_id: world.tenantId, principal: "user:alice", query: { query: "deploy window", scope: { tenant: slug, project: "payments", user: "alice" }, purpose: "release_planning" } }));
  console.log("plan authorized scope ids:", JSON.stringify(plan.authorized_scope_ids), "denied:", JSON.stringify(plan.denied_dimensions), plan.scope_resolution);
  const composed = await compose({ db: world.db, ledger: world.ledger, embeddings: new HashEmbeddingBackend({ dimensions: 1024 }), ids: world.ids, clock: world.clock, policyVersion: "commit-v3", gateBackend: "lexical-overlap@1" },
    { tenant_id: world.tenantId, query: "deploy window", scope: { tenant: slug, project: "payments", user: "alice" }, purpose: "release_planning", action_risk: "low", limit: 12 },
    { principal: "user:alice" });
  console.log("compose plan scopes:", JSON.stringify(composed.plan.authorized_scope_ids), "denied:", JSON.stringify(composed.plan.denied_dimensions));
  console.log("compose claims:", composed.packet.claims.map(c=>c.claim_id), "missing:", JSON.stringify(composed.packet.missing));
  const composedCi = await compose({ db: world.db, ledger: world.ledger, embeddings: new HashEmbeddingBackend({ dimensions: 1024 }), ids: world.ids, clock: world.clock, policyVersion: "commit-v3", gateBackend: "lexical-overlap@1" },
    { tenant_id: world.tenantId, query: "ci status branch commit tests passed exit code", scope: { tenant: slug, project: "payments", user: "alice" }, purpose: "release_planning", action_risk: "low", limit: 12 },
    { principal: "user:alice" });
  console.log("compose CI claims:", composedCi.packet.claims.map(c=>c.claim_id), "coverage:", JSON.stringify(composedCi.packet.coverage));
} finally { await world.close(); }
