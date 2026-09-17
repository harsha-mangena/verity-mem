import { fixedClock, loadEnv, seededIds } from "@veritymem/ledger";
import { createWorld } from "./src/world.ts";
const env = loadEnv();
const world = createWorld({ tenantSlug: process.argv[2]!, project: "payments", databaseUrl: env.databaseUrl, blobDir: `${env.repoRoot}/.veritymem/blobs`, clock: fixedClock("2026-09-01T09:00:00.000Z"), ids: seededIds("x") });
try {
  const out = await world.db.withSystemContext({ tenant: world.tenantId, actor: "x" }, async (ex) => ({
    scopes: (await ex.query("SELECT scope_id, project, user_id, purpose FROM scopes")).rows,
    events: (await ex.query("SELECT event_id, actor_id, origin::text o, scope_id, payload IS NULL AS redacted FROM events ORDER BY seq")).rows,
    claims: (await ex.query("SELECT claim_id, subject, predicate, status::text s, scope_id FROM claims ORDER BY claim_id")).rows,
    ps: (await ex.query("SELECT principal_id, scope_id FROM principal_scopes")).rows,
    traces: (await ex.query("SELECT trace_id, caller FROM query_traces")).rows,
  }));
  console.log(JSON.stringify(out, null, 1));
} finally { await world.close(); }
