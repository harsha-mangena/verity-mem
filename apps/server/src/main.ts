/**
 * Process entry point.
 *
 * The only place in the server that reads configuration, opens a pool and binds a
 * socket. Everything else takes what it needs as an argument, which is what lets the
 * test suite boot the identical route table against a real database with `inject()`.
 *
 * Shutdown is handled explicitly rather than left to the runtime. The pool holds
 * connections that the database counts against a limit, and a container that is
 * killed with connections open leaves the server side waiting on a socket that will
 * never speak again — the failure shows up as connection exhaustion in a *different*
 * process, which is the most expensive kind of bug to attribute.
 */
import { buildBlobStore, buildDeps, buildEmbeddingBackend, buildEntailmentBackend, loadServerConfig } from "./config.ts";
import { createServer } from "./server.ts";
import { Db, Ledger, generateId } from "@veritymem/ledger";

async function main(): Promise<void> {
  const config = loadServerConfig();
  const db = new Db({
    connectionString: config.env.databaseUrl,
    applicationName: "veritymem-server",
    // The pool must exceed the nesting depth any single request reaches. Every read
    // discovers the caller's reach in one transaction and then performs the read in a
    // second, so one request occupies at most one connection at a time by design; the
    // headroom here is for concurrency, not for depth.
    max: 12,
  });

  const ledger = new Ledger({
    db,
    blobs: buildBlobStore(config),
    clock: { now: () => new Date() },
    ids: { next: (prefix) => generateId(prefix) },
    inlinePayloadLimit: config.env.ledgerInlinePayloadLimit,
  });

  const embeddings = buildEmbeddingBackend(config);
  const entailment = await buildEntailmentBackend(config);

  const deps = buildDeps({ config, db, ledger, embeddings, entailment });
  const app = await createServer({ deps, logger: true });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      await db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      host: config.host,
      port: config.port,
      gate_backend: entailment.name,
      gate_is_model_call: entailment.isModelCall,
      embedding_backend: embeddings.model_id,
      embedding_is_model_call: embeddings.isModelCall,
      docs: `http://${config.host}:${config.port}/docs`,
    },
    "veritymem server listening",
  );
}

main().catch((error: unknown) => {
  // A startup failure must be loud and must not leave a half-initialised process
  // serving traffic with a missing backend. `process.exitCode` rather than a bare
  // throw so the message reaches the operator's log rather than a stack trace alone.
  console.error("veritymem server failed to start:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
