/**
 * The worker's claim cycle.
 *
 * One `OutboxWorker.runOnce` per batch, plus the projection-lag reading. Claiming,
 * completing, failure recording and exponential backoff are all the ledger package's
 * — `OutboxWorker.claim` goes through the `veritymem.outbox_claim` SECURITY DEFINER
 * function and `fail` goes through `veritymem.outbox_fail`, so the backoff is computed
 * in one place and two workers cannot disagree about it.
 *
 * `tenants` is passed to the worker rather than left null, which would claim the head
 * of a global queue. A global claim is wrong in both directions: it picks up work
 * belonging to another deployment's tenants, and a backlog in one tenant starves every
 * other tenant behind it in `outbox_id` order.
 *
 * The tenant list is a real operational requirement and is stated rather than hidden.
 * It is a configuration value because claiming is tenant-addressable, and an empty
 * list is rejected by `OutboxWorker`'s constructor rather than silently claiming
 * nothing — a worker with no tenants looks exactly like an idle one.
 */
import { OutboxWorker, type Db, type OutboxProcessor, type OutboxRunSummary } from "@veritymem/ledger";

export interface OutboxRunnerOptions {
  readonly db: Db;
  readonly processors: readonly OutboxProcessor[];
  /**
   * Tenants to claim for, as UUIDs.
   *
   * UUIDs rather than slugs because resolving a slug (`resolveTenantId`) is a pure
   * function that belongs at configuration time: a runner that resolved slugs per
   * cycle would hide a typo until the queue had already stalled.
   */
  readonly tenantIds: readonly string[];
  readonly batchSize: number;
}

export interface CycleSummary extends OutboxRunSummary {
  /** Pending messages for this worker's tenants, after the cycle. */
  readonly projection_lag: number;
}

export interface OutboxRunner {
  /** One cycle: claim and handle one batch, then read the lag. */
  runCycle(): Promise<CycleSummary>;
  /** Read lag without claiming another batch. Used after a bounded drain. */
  lag(): Promise<number>;
  /** Stop after the batch currently being handled. */
  stop(): void;
  /** Drain until the queue is empty. Used by `--once` and by the reference workload. */
  drain(options?: { maxCycles?: number }): Promise<Omit<CycleSummary, "projection_lag">>;
}

/**
 * Build a runner around one `OutboxWorker`.
 *
 * One worker, not one per tenant: the worker id is what `locked_by` records, and two
 * ids in one process would make its own claims unattributable in the queue.
 */
export function createOutboxRunner(options: OutboxRunnerOptions): OutboxRunner {
  const worker = new OutboxWorker(options.db, options.processors, { tenants: options.tenantIds });

  const runCycle = async (): Promise<CycleSummary> => {
    const summary = await worker.runOnce(options.batchSize);
    return { ...summary, projection_lag: await readProjectionLag(worker, options.tenantIds) };
  };

  return {
    runCycle,
    lag: () => readProjectionLag(worker, options.tenantIds),
    stop: () => worker.stop(),
    async drain(drainOptions = {}) {
      const maxCycles = drainOptions.maxCycles ?? 10_000;
      let claimed = 0;
      let completed = 0;
      let failed = 0;
      const kinds: Record<string, number> = {};
      for (let cycle = 0; cycle < maxCycles; cycle += 1) {
        const summary = await worker.runOnce(options.batchSize);
        claimed += summary.claimed;
        completed += summary.completed;
        failed += summary.failed;
        for (const [kind, count] of Object.entries(summary.kinds)) {
          kinds[kind] = (kinds[kind] ?? 0) + count;
        }
        // An empty batch is the only signal that the queue is drained. Backoff means a
        // failed message is *not* retried immediately, so a batch that claims nothing
        // is genuinely finished rather than momentarily empty.
        if (summary.claimed === 0) break;
      }
      return { claimed, completed, failed, kinds };
    },
  };
}

/**
 * Projection lag across this worker's tenants.
 *
 * The specification names projection lag as an observable metric, and for a Postgres
 * outbox the queue *is* the lag. Read through `OutboxWorker.lag`, which goes through
 * the privileged `veritymem.outbox_lag` function: a count taken under the tenant policy
 * on an unbound connection is always zero, and a lag metric that always reads zero is
 * worse than no metric because it looks healthy.
 *
 * A `tenantId` of `null` would mean every tenant. This sums per configured tenant
 * instead, so a worker that serves two of five tenants reports the backlog it is
 * actually responsible for.
 */
export async function readProjectionLag(worker: OutboxWorker, tenantIds: readonly string[]): Promise<number> {
  let total = 0;
  for (const tenant of tenantIds) {
    total += await worker.lag(tenant);
  }
  return total;
}
