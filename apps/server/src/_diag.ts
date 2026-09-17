import { Db, MemoryBlobStore, Ledger, fixedClock, loadEnv, seededIds, resolveTenantId } from "@veritymem/ledger";
import { buildDeps, loadServerConfig, buildEmbeddingBackend } from "./config.ts";
import { createServer } from "./server.ts";
import { resolveIdentity } from "./identity.ts";

const env = loadEnv();
const db = new Db({ connectionString: env.databaseUrl, max: 2 });
const config = loadServerConfig({
  DATABASE_URL: env.databaseUrl,
  AGENT_TOKEN: "diag-agent",
  ADMIN_TOKEN: "tenant:t1:diag-admin",
});
console.log("agentToken=", JSON.stringify(config.agentToken), "adminToken=", JSON.stringify(config.adminToken));
console.log("resolve:", JSON.stringify(resolveIdentity("Bearer diag-agent", { agentToken: config.agentToken, adminToken: config.adminToken })));

const deps = buildDeps({
  config, db,
  ledger: new Ledger({ db, blobs: new MemoryBlobStore(), clock: fixedClock(), ids: seededIds("diag") }),
  embeddings: buildEmbeddingBackend(config),
});
const app = await createServer({ deps, swaggerUi: false, logger: false });
const res = await app.inject({ method: "GET", url: "/v1/whoami", headers: { authorization: "Bearer diag-agent" } });
console.log("whoami:", res.statusCode, res.body);
await app.close();
await db.close();
