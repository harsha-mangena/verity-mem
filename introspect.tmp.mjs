import pg from "pg";
const c = new pg.Client({ connectionString: "postgres://verity:verity@127.0.0.1:55432/veritymem" });
await c.connect();
const q = async (label, sql) => {
  const r = await c.query(sql);
  console.log("\n### " + label);
  for (const row of r.rows) console.log(JSON.stringify(row));
};
await q("policies", `SELECT schemaname, tablename, policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename, policyname`);
await q("rls enabled", `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('events','claims','claim_candidates','claim_embeddings','evidence_spans','decisions','claim_relations','grants','query_traces','retention_jobs','scopes','principals','tenants','outbox','streams','projection_versions','entity_aliases') ORDER BY relname`);
await q("triggers", `SELECT c.relname AS table_name, t.tgname, p.proname, t.tgtype, t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal ORDER BY c.relname, t.tgname`);
await q("claims columns", `SELECT column_name, data_type, is_generated, generation_expression, is_nullable FROM information_schema.columns WHERE table_name='claims' ORDER BY ordinal_position`);
await q("claim_relations", `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='claim_relations' ORDER BY ordinal_position`);
await c.end();
