/**
 * The worker process.
 *
 * Extraction, gating and projection, driven entirely by the Postgres outbox. It
 * has no HTTP listener and no administrative surface: the queue is the interface,
 * the ledger is the state, and a worker that could be addressed directly would be a
 * second way into the claim store.
 *
 * Two runtime properties are the point of this file:
 *
 *   - **Graceful shutdown.** On SIGINT or SIGTERM the loop stops claiming, the
 *     batch already in flight finishes, and only then is the pool closed. Killing
 *     mid-batch would leave claimed messages locked until their `locked_at` is
 *     reaped and would leave a half-extracted event; `OutboxWorker.stop()` plus
 *     one awaited completion of the current `runCycle()` gets both right.
 *   - **Observable progress.** Every batch emits one JSON line with claimed,
 *     completed and failed counts, the per-kind breakdown, and projection lag. Lag
 *     is the count of pending outbox rows across the tenants this worker serves,
 *     which the specification names as an observable metric.
 *
 * Retry is not implemented here. `OutboxWorker.fail` already records the error and
 * applies exponential backoff up to `max_attempts`, and a second retry mechanism
 * would either double the delay or, worse, retry a message the outbox had already
 * given up on.
 */
import {
  Db,
  FilesystemBlobStore,
  Ledger,
  resolveTenantId,
  systemClock,
  systemIds,
  type OutboxProcessor,
} from "@veritymem/ledger";
import { HashEmbeddingBackend, HostedEmbeddingBackend, createProjectionProcessor } from "@veritymem/retrieval";
import { loadWorkerConfig, type WorkerConfig } from "./config.ts";
import { createLogger, describeError, type Logger } from "./log.ts";
import { countProjectionLag, createOutboxRunner } from "./outbox-runner.ts";
import {
  createEntailmentBackend,
  createGate,
  createIngestProcessor,
  createModelExtractor,
} from "./processors.ts";

export interface WorkerHandle {
  /** Drain until the queue is empty, then stop. Used by tests and by `--once`. */
  drainOnce(): Promise<void>;
  /** Stop claiming, wait for the in-flight batch, close the pool. */
  shutdown(reason: string): Promise<void>;
  readonly started: Promise<void>;
}

/**
 * Start the worker loop.
 *
 * Returns a handle rather than running forever, because a `main()` that owns an
 * infinite loop cannot be stopped from a test and cannot be reused by a supervisor
 * that wants to drain before exit.
 */
export function startWorker(config: WorkerConfig, logger: Logger): WorkerHandle {
  const db = new Db({ connectionString: config.databaseUrl, max: 8, applicationName: "veritymem-worker" });
  const ledger = new Ledger({
    db,
    blobs: new FilesystemBlobStore(config.blobDir),
    // The system clock and the system id generator, deliberately: a worker that
    // reused a fixed clock would date every claim `valid_from` to the same instant,
    // and a replay of the same event stream under a different clock would produce a
    // different claim set.
    clock: systemClock,
    ids: systemIds,
  });

  const embeddings =
    config.embedding.backend === "openai"
      ? new HostedEmbeddingBackend({
          baseUrl: config.extraction.baseUrl ?? "",
          apiKey: config.extraction.apiKey,
          model: config.embedding.modelId,
          dimensions: config.embedding.dimensions,
        })
      : new HashEmbeddingBackend({
          dimensions: config.embedding.dimensions,
          modelId: config.embedding.modelId,
        });

  let runner: ReturnType<typeof createOutboxRunner> | null = null;
  let closing = false;
  let inFlight: Promise<void> | null = null;

  /**
   * One batch for every configured tenant, then the lag reading.
   *
   * Declared as a hoisted function rather than a `const` arrow so the loop below
   * can call it: a `const` would be in its temporal dead zone while the loop's
   * first iteration ran.
   */
  async function runCycleOnce(): Promise<void> {
    if (runner === null) return;
    try {
      const summary = await runner.runCycle();
      const lag = await countProjectionLag(db, config.tenantSlugs.map((slug) => resolveTenantId(slug)));
      logger.info("worker.batch", {
        claimed: summary.claimed,
        completed: summary.completed,
        failed: summary.failed,
        kinds: summary.kinds,
        tenants_with_work: summary.tenants_with_work.length,
        projection_lag_pending: lag.pending,
        projection_lag_oldest_available_at: lag.oldest_pending_at,
      });
    } catch (error) {
      // A cycle-level failure is a database or configuration problem, not a message
      // problem — message failures are already recorded per row by the outbox. The
      // loop keeps running so a transient outage does not stop the worker.
      logger.error("worker.cycle_failed", { ...describeError(error) });
    }
  }

  const started = (async () => {
    const entailment = await createEntailmentBackend({
      db,
      ledger,
      ids: systemIds,
      clock: systemClock,
      backend: config.gate.backend,
      modelPath: config.gate.modelPath,
      modelSha256: config.gate.modelSha256,
      lexicalFloor: config.entailmentFloor,
    });
    const gate = createGate({ db, ledger, ids: systemIds, clock: systemClock, entailment });
    const modelExtractor = createModelExtractor(config.extraction);

    const processors: OutboxProcessor[] = [
      createIngestProcessor({ db, ledger, gate, ids: systemIds, clock: systemClock, modelExtractor }),
      // The projection processor comes from the retrieval package unchanged. It
      // reads `claim_id` off the message and projects only accepted claims, so a
      // quarantined claim is never indexed in the first place.
      createProjectionProcessor({ db, embeddings }),
    ];

    const tenantIds = config.tenantSlugs.map((slug) => resolveTenantId(slug));
    runner = createOutboxRunner({ db, processors, tenantIds, batchSize: config.batchSize });

    logger.info("worker.start", {
      gate_backend: entailment.name,
      entailment_model_sha256: entailment.modelSha256,
      embedding_backend: embeddings.model_id,
      embedding_is_model_call: embeddings.isModelCall,
      model_extractor: modelExtractor === null ? null : modelExtractor.id,
      batch_size: config.batchSize,
      poll_interval_ms: config.pollIntervalMs,
      tenants: [...config.tenantSlugs],
      processors: processors.map((processor) => processor.kind),
      telemetry: "none",
    });

    if (tenantIds.length === 0) {
      // Said out loud rather than discovered as a silent, permanent zero. Without a
      // tenant list the claim query cannot be authorized at all (see the port
      // notice in outbox-runner.ts), so an empty list is a misconfiguration and not
      // an idle worker.
      logger.warn("worker.no_tenants", {
        detail:
          "WORKER_TENANT_SLUGS is empty; the outbox claim cannot be authorized without a tenant, so every cycle will claim nothing",
      });
    }

    while (!closing) {
      const cycle = runCycleOnce();
      inFlight = cycle;
      await cycle;
      inFlight = null;
      if (closing) break;
      await sleep(config.pollIntervalMs);
    }
  })();

  return {
    started,
    async drainOnce(): Promise<void> {
      await started;
      if (runner === null) return;
      const summary = await runner.drain();
      const lag = await countProjectionLag(db, config.tenantSlugs.map((slug) => resolveTenantId(slug)));
      logger.info("worker.drained", {
        claimed: summary.claimed,
        completed: summary.completed,
        failed: summary.failed,
        kinds: summary.kinds,
        projection_lag_pending: lag.pending,
      });
    },
    async shutdown(reason: string): Promise<void> {
      if (closing) return;
      closing = true;
      // Stop claiming first: a `stop()` that raced the claim would let one more
      // batch be taken on after the process had committed to exiting.
      runner?.stop();
      logger.info("worker.stopping", { reason, in_flight: inFlight !== null });
      // Wait for the batch that is already handling messages. This is the
      // "finish the in-flight batch" half of graceful shutdown; without it, closing
      // the pool below would abort a transaction mid-gate.
      if (inFlight) {
        try {
          await inFlight;
        } catch (error) {
          logger.warn("worker.in_flight_failed", { ...describeError(error) });
        }
      }
      await db.close();
      logger.info("worker.stopped", { reason });
    },
  };
}

/** Wire signal handlers to a graceful shutdown. */
export function installSignalHandlers(handle: WorkerHandle, logger: Logger): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void (async () => {
        try {
          await handle.shutdown(signal);
          process.exitCode = 0;
        } catch (error) {
          logger.error("worker.shutdown_failed", { ...describeError(error) });
          process.exitCode = 1;
        }
      })();
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const logger = createLogger({ service: "veritymem-worker" });
  const once = process.argv.includes("--once");
  const config = loadWorkerConfig();
  const handle = startWorker(config, logger);
  installSignalHandlers(handle, logger);

  if (once) {
    // `--once` drains and exits: the form a cron job or a CI smoke test wants, and
    // the only way to run this process to completion without a signal.
    await handle.started;
    await handle.drainOnce();
    await handle.shutdown("once");
    return;
  }
  await handle.started;
}

// Only run when executed directly, so importing this module from a test does not
// start a database pool as a side effect of the import graph.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ level: "error", msg: "worker.fatal", ...describeError(error) })}\n`);
    process.exitCode = 1;
  });
}
