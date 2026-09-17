/**
 * The claim loop.
 *
 * ## Port notice — read this before changing anything here
 *
 * This module is a thin host around the real `OutboxWorker` from
 * `@veritymem/ledger`. It does not reimplement claiming, completing, failing,
 * backoff or processor dispatch; `OutboxWorker.runOnce` does all of that. What it
 * adds is one thing: a tenant-bound transaction wrapped around each `runOnce`
 * call.
 *
 * That wrapper is required because of a defect in the ledger package, and it is
 * recorded here rather than silently worked around because it changes what the
 * worker can do:
 *
 *   - `migrations/0009` enables row-level security on `outbox` with the policy
 *     `tenant_id = veritymem.current_tenant_id()`.
 *   - `OutboxWorker.claim()` runs its `UPDATE ... FOR UPDATE SKIP LOCKED` through
 *     `Db.systemQuery`, which by contract runs with no request context bound.
 *     `current_tenant_id()` is therefore NULL and `COALESCE(...)` is FALSE, so the
 *     claim matches zero rows.
 *   - `OutboxWorker.complete()` and `.fail()` are `systemQuery` calls too, so even
 *     a claimed message could not be settled.
 *
 * The observable symptom is the worst kind: `runOnce()` returns
 * `{claimed: 0, completed: 0, failed: 0}`, the queue never drains, and the worker
 * looks healthy while doing nothing indefinitely.
 *
 * The fix is a one-line change in `packages/ledger/src/outbox.ts` — claim, complete
 * and fail each need a tenant scope, which means either a `withSystemContext`
 * wrapper inside the worker or a `SECURITY DEFINER` claim function. That package
 * is owned elsewhere and `apps/worker/` must not edit it, so this module binds the
 * tenant around the outside of `runOnce` instead, which authorizes the same
 * statements without touching the package.
 *
 * The cost of hosting it here is honest and bounded: the worker must be told which
 * tenants to claim for, because there is no unbound read that can enumerate them
 * either (`tenants` is tenant-keyed too, and `tenants_context` allows
 * `system_context()` only). One `runOnce` per configured tenant per cycle is a real
 * throughput ceiling for a multi-tenant deployment; see README.md.
 */
import { OutboxWorker, type Db, type OutboxRunSummary, type OutboxProcessor } from "@veritymem/ledger";

export interface OutboxRunnerOptions {
  readonly db: Db;
  readonly processors: readonly OutboxProcessor[];
  /**
   * Tenants to claim for, as UUIDs.
   *
   * UUIDs rather than slugs because resolving a slug (`resolveTenantId`) is a pure
   * function that belongs at configuration time, and a runner that resolved slugs
   * per cycle would hide a typo until the queue stalled rather than at startup.
   */
  readonly tenantIds: readonly string[];
  readonly batchSize: number;
  readonly actor?: string;
}

export interface CycleSummary extends OutboxRunSummary {
  /** Tenants that had at least one message claimed or failed. */
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
 * Build a runner around one `OutboxWorker`.
 *
 * One worker instance, not one per tenant: the instance id is what `locked_by`
 * records, and two instances would make a single process's claims unattributable
 * in the queue.
 */
export function createOutboxRunner(options: OutboxRunnerOptions): OutboxRunner {
  const worker = new OutboxWorker(options.db, options.processors);
  const actor = options.actor ?? "worker:outbox";

  const runCycle = async (): Promise<CycleSummary> => {
    let claimed = 0;
    let completed = 0;
    let failed = 0;
    const kinds: Record<string, number> = {};
    const tenantsWithWork: string[] = [];

    for (const tenant of options.tenantIds) {
      // The system context reaches every row in this tenant and no other, and it
      // is set by a database function that only this call site can reach. It does
      // not make the handler privileged: `runOnce` re-binds a *request* context
      // from the message payload before each processor runs, and `bindingFor`
      // throws if the payload is incomplete.
      const summary = await options.db.withSystemContext({ tenant, actor }, async () => {
        return worker.runOnce(options.batchSize);
      });

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
    stop: () => worker.stop(),
    async drain(drainOptions = {}): Promise<CycleSummary> {
      const maxCycles = drainOptions.maxCycles ?? 10_000;
      const total: CycleSummary = { claimed: 0, completed: 0, failed: 0, kinds: {}, tenants_with_work: [] };
      const seen = new Set<string>();
      for (let cycle = 0; cycle < maxCycles; cycle += 1) {
        const summary = await runCycle();
        total.claimed += summary.claimed;
        total.completed += summary.completed;
        total.failed += summary.failed;
        for (const [kind, count] of Object.entries(summary.kinds)) {
          total.kinds[kind] = (total.kinds[kind] ?? 0) + count;
        }
        for (const tenant of summary.tenants_with_work) seen.add(tenant);
        // An empty cycle is the only signal that the queue is drained. Backoff
        // means a failed message is *not* retried immediately, so a cycle that
        // claims nothing is genuinely finished rather than momentarily empty.
        if (summary.claimed === 0) break;
      }
      return { ...total, tenants_with_work: [...seen] };
    },
  };
}

/**
 * Pending outbox rows for the tenants this worker serves — projection lag.
 *
 * The specification names projection lag as an observable metric, and this is the
 * honest form of it for a Postgres outbox: the queue *is* the lag. `max_attempts`
 * rows are excluded because a message that has exhausted its retries is a dead
 * letter, not lag, and counting it would make the metric climb forever on a
 * permanent failure and hide a real backlog behind a known one.
 */
export async function countProjectionLag(
  db: Db,
  tenantIds: readonly string[],
): Promise<{ pending: number; oldest_pending_at: string | null }> {
  if (tenantIds.length === 0) return { pending: 0, oldest_pending_at: null };

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
