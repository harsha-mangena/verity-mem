/**
 * Tenant-scoped outbox loop.
 *
 * ## Port notice — read this before changing anything here
 *
 * This module is a port of `OutboxWorker.runOnce/claim/complete/fail` from
 * `packages/ledger/src/outbox.ts`, and it exists because the original cannot claim
 * a single message under row-level security. The reason is precise, and it is worth
 * stating exactly because the symptom is silent:
 *
 *   - `migrations/0009` enables RLS on `outbox` with the policy
 *     `tenant_id = veritymem.current_tenant_id()`.
 *   - `OutboxWorker.claim()` issues its `UPDATE ... FOR UPDATE SKIP LOCKED` through
 *     `Db.systemQuery`, which by contract takes a **fresh pooled connection** with
 *     no request context bound. `current_tenant_id()` is therefore NULL,
 *     `COALESCE(...)` is FALSE, and the claim matches zero rows.
 *   - `.complete()` and `.fail()` are `systemQuery` calls too, so even a claimed
 *     message could not be settled.
 *
 * Measured, not reasoned about — with one pending `extract.event` row for the tenant:
 *
 *     db.query(...)        inside a system context -> 1 row
 *     db.systemQuery(...)  inside a system context -> 0 rows   <-- a different connection
 *     new OutboxWorker(db).runOnce(5)              -> {claimed: 0, completed: 0, failed: 0}
 *
 * Wrapping `OutboxWorker.runOnce` in `db.withSystemContext` therefore does not help:
 * the GUC is transaction-local on the outer connection and `systemQuery` never sees
 * it. The queue stalls permanently while the worker reports clean, empty batches.
 *
 * The correct fix is inside `packages/ledger` — `claim`, `complete` and `fail`
 * each need a tenant scope (a `withSystemContext` wrapper inside the worker, or a
 * `SECURITY DEFINER` claim function). That package is verified and owned elsewhere
 * and `apps/worker/` must not edit it, so the loop is ported here instead.
 *
 * ## What is deliberately preserved from the original
 *
 * A port that quietly changed semantics would be worse than the bug. These are
 * byte-for-byte the original's behaviour:
 *
 *   - `SKIP LOCKED` with the same predicate and ordering, so N workers scale out
 *     without a coordination service;
 *   - `attempts = attempts + 1` at claim time and a cap of `max_attempts`, so a
 *     poison message eventually stops consuming capacity;
 *   - exponential backoff `min(300, 2 ** min(attempts, 8))` seconds on failure, and
 *     the error truncated to 2000 characters into `last_error`;
 *   - an unknown message kind throws, leaving the row retryable rather than
 *     deleting work this worker cannot do;
 *   - `bindingFor` from `@veritymem/ledger` — **not** a reimplementation — so a
 *     message without `scope_ids` or `purposes` still throws the same deliberate
 *     error before any handler runs.
 *
 * What is *lost* relative to the original is one thing: tenant-agnostic claiming.
 * That is the point. This loop claims for one named tenant at a time, which is what
 * makes the claim authorized in the first place, and it means the worker has to be
 * told which tenants to serve (see README.md).
 */
import {
  bindingFor,
  workerId,
  type Db,
  type OutboxMessage,
  type OutboxProcessor,
  type OutboxRunSummary,
  type QueryExecutor,
} from "@veritymem/ledger";

/** Mirrors the original's cap. Exported so the README and tests agree with the code. */
export const MAX_BACKOFF_SECONDS = 300;

export interface TenantScopedClaimLoopOptions {
  readonly db: Db;
  readonly processors: readonly OutboxProcessor[];
  /** Recorded in `outbox.locked_by`, so claims are attributable to a process. */
  readonly workerName?: string;
  /** Recorded as `principal_id` on the system context. */
  readonly actor?: string;
}

export interface ClaimLoop {
  /**
   * Claim and handle up to `limit` messages for one tenant.
   *
   * Runs entirely inside one transaction bound to that tenant's system context, so
   * the claim, the handler and the settle are serialized on a single connection and
   * cannot observe different GUCs.
   */
  runOnce(tenant: string, limit: number): Promise<OutboxRunSummary>;
}

/**
 * Build the loop.
 *
 * `workerId()` is read once rather than per call: an id that changed between the
 * claim and the settle would make `locked_by` describe a process that no longer
 * exists.
 */
export function createClaimLoop(options: TenantScopedClaimLoopOptions): ClaimLoop {
  const id = options.workerName ?? workerId();
  const actor = options.actor ?? "worker:outbox";

  return {
    async runOnce(tenant: string, limit: number): Promise<OutboxRunSummary> {
      return options.db.withSystemContext({ tenant, actor }, async (executor) => {
        const claimed = await claim(executor, id, limit);
        let completed = 0;
        let failed = 0;
        const kinds: Record<string, number> = {};

        for (const message of claimed) {
          kinds[message.kind] = (kinds[message.kind] ?? 0) + 1;
          const processor = options.processors.find((candidate) => candidate.kind === message.kind);
          try {
            if (!processor) {
              // An unknown message kind is a deployment skew, not a data problem.
              // Leave it retryable rather than deleting work this worker cannot do.
              throw new Error(`no processor registered for outbox kind ${message.kind}`);
            }
            // `bindingFor` throws when `scope_ids` or `purposes` is missing. That is
            // the ledger's deliberate fix for a worker that used to bind an empty
            // context, read nothing and report success, so it is called and not
            // defaulted.
            const binding = bindingFor(message);
            await options.db.withRequest(binding, async () => {
              await processor.handle(message);
            });
            await complete(executor, message.outbox_id);
            completed += 1;
          } catch (error) {
            failed += 1;
            await fail(executor, message, error);
          }
        }

        return { claimed: claimed.length, completed, failed, kinds };
      });
    },
  };
}

async function claim(executor: QueryExecutor, worker: string, limit: number): Promise<OutboxMessage[]> {
  const result = await executor.query<{
    outbox_id: number;
    tenant_id: string;
    kind: string;
    payload: Record<string, unknown>;
    attempts: number;
  }>(
    `UPDATE outbox
        SET locked_by = $1, locked_at = now(), attempts = attempts + 1
      WHERE outbox_id IN (
              SELECT outbox_id FROM outbox
               WHERE completed_at IS NULL
                 AND available_at <= now()
                 AND attempts < max_attempts
               ORDER BY outbox_id ASC
               FOR UPDATE SKIP LOCKED
               LIMIT $2
            )
    RETURNING outbox_id, tenant_id, kind, payload, attempts`,
    [worker, limit],
  );
  return result.rows.map((row) => ({
    outbox_id: Number(row.outbox_id),
    tenant_id: row.tenant_id,
    kind: row.kind,
    payload: row.payload,
    attempts: Number(row.attempts),
  }));
}

async function complete(executor: QueryExecutor, outboxId: number): Promise<void> {
  await executor.query(
    `UPDATE outbox SET completed_at = now(), locked_by = NULL, locked_at = NULL
      WHERE outbox_id = $1`,
    [outboxId],
  );
}

/**
 * Record the failure and schedule the retry.
 *
 * Extraction is idempotent by construction (candidates are keyed on the event, the
 * extractor and the span set), so retrying is always safe and the backoff exists
 * only to stop a poison message consuming capacity in a tight loop.
 */
async function fail(executor: QueryExecutor, message: OutboxMessage, error: unknown): Promise<void> {
  const messageText = error instanceof Error ? error.message : String(error);
  const backoffSeconds = Math.min(MAX_BACKOFF_SECONDS, 2 ** Math.min(message.attempts, 8));
  await executor.query(
    `UPDATE outbox
        SET last_error = $2,
            locked_by = NULL,
            locked_at = NULL,
            available_at = now() + ($3 || ' seconds')::interval
      WHERE outbox_id = $1`,
    [message.outbox_id, messageText.slice(0, 2000), String(backoffSeconds)],
  );
}
