/**
 * The worker's claim cycle.
 *
 * One `runOnce` per configured tenant, plus the projection-lag reading. The
 * claiming itself lives in `claim-loop.ts`, which documents why it is a port of
 * `OutboxWorker` rather than a call to it — in short, `OutboxWorker.claim()` runs
 * through `Db.systemQuery`, which has no request context, and the `outbox` policy
 * in migration 0009 denies every row without one.
 *
 * The tenant list is a real operational cost and is stated rather than hidden:
 * there is no unbound read that can enumerate tenants either (`tenants` is
 * tenant-keyed too, and `tenants_context` admits `system_context()` only), so
 * throughput is bounded by tenants × batch size per cycle.
 */
import type { Db, OutboxProcessor, OutboxRunSummary } from "@veritymem/ledger";
import { createClaimLoop } from "./claim-loop.ts";

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
  readonly actor?: string;
}

export interface CycleSummary extends OutboxRunSummary {
  /** Tenants that had at least one message claimed. */
  readonly tenants_with_work: readonly string[];
}

export interface OutboxRunner {
  /** One cycle: claim and handle a batch for every configured tenant. */
  runCycle(): Promise<CycleSummary>;
  /** Stop after the batch currently being handled. */
  stop(): void;
  /** Drain every configured tenant, terminating when a full cycle claims nothing. */
  drain(options?: { maxCycles?: number }): Promise<CycleSummary>;
}

/**
 * Build a runner.
 *
 * One claim loop, not one per tenant: the loop's worker id is what `locked_by`
 * records, and two ids in one process would make its own claims unattributable.
 */
export function createOutboxRunner(options: OutboxRunnerOptions): OutboxRunner {
  const loop = createClaimLoop({
    db: options.db,
    processors: options.processors,
    ...(options.actor !== undefined ? { actor: options.actor } : {}),
  });
  let stopping = false;

  const runCycle = async (): Promise<CycleSummary> => {
    let claimed = 0;
    let completed = 0;
    let failed = 0;
    const kinds: Record<string, number> = {};
    const tenantsWithWork: string[] = [];

    for (const tenant of options.tenantIds) {
      if (stopping) break;
      const summary = await loop.runOnce(tenant, options.batchSize);
      claimed += summary.claimed;
      completed += summary.completed;
      failed += summary.failed;
      for (const [kind, count] of Object.entries(summary.kinds)) {
        kinds[kind] = (kinds[kind] ?? 0) + count;
      }
      if (summary.claimed > 0) tenantsWithWork.push(tenant);
    }

    return { claimed, completed, failed, kinds, tenants_with_work: tenantsWithWork };
  };

  return {
    runCycle,
    stop: () => {
      stopping = true;
    },
    async drain(drainOptions = {}): Promise<CycleSummary> {
      const maxCycles = drainOptions.maxCycles ?? 10_000;
      let claimed = 0;
      let completed = 0;
      let failed = 0;
      const kinds: Record<string, number> = {};
      const seen = new Set<string>();
      for (let cycle = 0; cycle < maxCycles; cycle += 1) {
        const summary = await runCycle();
        claimed += summary.claimed;
        completed += summary.completed;
        failed += summary.failed;
        for (const [kind, count] of Object.entries(summary.kinds)) {
          kinds[kind] = (kinds[kind] ?? 0) + count;
        }
        for (const tenant of summary.tenants_with_work) seen.add(tenant);
        // An empty cycle is the only signal that the queue is drained. Backoff
        // means a failed message is *not* retried immediately, so a cycle that
        // claims nothing is genuinely finished rather than momentarily empty.
        if (summary.claimed === 0) break;
      }
      return { claimed, completed, failed, kinds, tenants_with_work: [...seen] };
    },
  };
}

/**
 * Pending outbox rows for the tenants this worker serves — projection lag.
 *
 * The specification names projection lag as an observable metric, and this is the
 * honest form of it for a Postgres outbox: the queue *is* the lag. Rows that have
 * exhausted `max_attempts` are excluded, because a message that will never be
 * retried is a dead letter rather than lag, and counting it would let the metric
 * climb forever on a permanent failure and hide a real backlog behind a known one.
 */
export async function countProjectionLag(
  db: Db,
  tenantIds: readonly string[],
): Promise<{ pending: number; oldest_pending_at: string | null }> {
  let pending = 0;
  let oldest: string | null = null;
  for (const tenant of tenantIds) {
    const result = await db.withSystemContext({ tenant, actor: "worker:metrics" }, async (executor) =>
      executor.query<{ pending: number; oldest: Date | string | null }>(
        `SELECT count(*)::int AS pending, min(available_at) AS oldest
           FROM outbox
          WHERE tenant_id = $1::uuid
            AND completed_at IS NULL
            AND attempts < max_attempts`,
        [tenant],
      ),
    );
    const row = result.rows[0];
    pending += Number(row?.pending ?? 0);
    const candidate = row?.oldest ?? null;
    if (candidate !== null) {
      const iso = candidate instanceof Date ? candidate.toISOString() : new Date(candidate).toISOString();
      if (oldest === null || iso < oldest) oldest = iso;
    }
  }
  return { pending, oldest_pending_at: oldest };
}
