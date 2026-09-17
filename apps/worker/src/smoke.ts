/**
 * Manual worker smoke test.
 *
 * Not a test file — it is a script you run against a live database when you want
 * to watch the worker do something, which is the one thing the unit tests cannot
 * show you. It appends one event for a slug it derives from `SMOKE_TENANT` (default
 * `worker-smoke`), drains the worker `--once` style, and prints the resulting
 * decisions and projection.
 *
 *     SMOKE_TENANT=worker-smoke node --experimental-strip-types apps/worker/src/smoke.ts
 *
 * It is deliberately not wired into `pnpm test`: it writes to a named tenant rather
 * than a fresh one, so running it twice would append to the same stream.
 */
import { Db, FilesystemBlobStore, Ledger, loadEnv, resolveTenantId, systemClock, systemIds } from "@veritymem/ledger";
import { HashEmbeddingBackend, createProjectionProcessor } from "@veritymem/retrieval";
import { createLogger } from "./log.ts";
import { countProjectionLag, createOutboxRunner } from "./outbox-runner.ts";
import { createEntailmentBackend, createGate, createIngestProcessor, createModelExtractor } from "./processors.ts";
import { loadWorkerConfig } from "./config.ts";
import { DEFAULT_COMMIT_POLICY } from "@veritymem/contracts";

const CONTENT = "I approved the Sunday 02:00 UTC deploy window for the smoke run.";

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const slug = process.env["SMOKE_TENANT"] ?? "worker-smoke";
  const logger = createLogger({ service: "veritymem-worker-smoke" });

  const db = new Db({ connectionString: config.databaseUrl, max: 4, applicationName: "veritymem-worker-smoke" });
  try {
    const ledger = new Ledger({
      db,
      blobs: new FilesystemBlobStore(loadEnv().repoRoot + "/.veritymem/blobs"),
      clock: systemClock,
      ids: systemIds,
    });

    const receipt = await ledger.append({
      stream_id: `smoke:${new Date().toISOString().slice(0, 10)}`,
      idempotency_key: `smoke-${Date.now()}`,
      origin: "user",
      actor_id: "user:smoke",
      scope: { tenant: slug, project: "smoke", user: "smoke", purpose: ["release_planning"] },
      occurred_at: new Date().toISOString(),
      content: CONTENT,
    });
    logger.info("smoke.appended", { event_id: receipt.event_id, seq: receipt.seq, tenant: slug });

    const entailment = await createEntailmentBackend({
      db,
      ledger,
      ids: systemIds,
      clock: systemClock,
      backend: config.gate.backend,
      modelPath: config.gate.modelPath,
      modelSha256: config.gate.modelSha256,
      lexicalFloor: DEFAULT_COMMIT_POLICY.thresholds.lexicalEntailmentFloor,
    });
    const gate = createGate({ db, ledger, ids: systemIds, clock: systemClock, entailment });
    const embeddings = new HashEmbeddingBackend({
      dimensions: config.embedding.dimensions,
      modelId: config.embedding.modelId,
    });

    const runner = createOutboxRunner({
      db,
      processors: [
        createIngestProcessor({
          db,
          ledger,
          gate,
          ids: systemIds,
          clock: systemClock,
          modelExtractor: createModelExtractor(config.extraction),
        }),
        createProjectionProcessor({ db, embeddings }),
      ],
      tenantIds: [resolveTenantId(slug)],
      batchSize: 25,
    });

    const summary = await runner.drain();
    logger.info("smoke.drained", {
      claimed: summary.claimed,
      completed: summary.completed,
      failed: summary.failed,
      kinds: summary.kinds,
    });

    const tenantId = resolveTenantId(slug);
    const outcome = await db.withSystemContext({ tenant: tenantId, actor: "smoke:read" }, async (executor) => {
      const rows = await executor.query<{ outcome: string; reason_codes: string[]; claim_id: string | null }>(
        `SELECT d.outcome::text AS outcome, d.reason_codes, d.claim_id
           FROM decisions d
          ORDER BY d.decided_at DESC
          LIMIT 5`,
      );
      const claims = await executor.query<{ claim_id: string; status: string; authority: string; subject: string; predicate: string; object: unknown }>(
        `SELECT claim_id, status::text AS status, authority::text AS authority, subject, predicate, object
           FROM claims ORDER BY recorded_at DESC LIMIT 5`,
      );
      const projected = await executor.query<{ n: number }>(`SELECT count(*)::int AS n FROM claim_embeddings`);
      return { rows: rows.rows, claims: claims.rows, projected: projected.rows[0]?.n ?? 0 };
    });

    logger.info("smoke.result", {
      decisions: outcome.rows.map((row) => ({ outcome: row.outcome, reason_codes: row.reason_codes })),
      claims: outcome.claims,
      projected_embeddings: outcome.projected,
      projection_lag: (await countProjectionLag(db, [tenantId])).pending,
    });
  } finally {
    await db.close();
  }
}

await main();
