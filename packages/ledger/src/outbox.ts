/**
 * The outbox worker's claim loop.
 *
 * The ledger is already an event source, so the async spine lives in the same
 * database rather than behind a second broker — two sources of truth is exactly
 * the failure this project exists to criticise. `SKIP LOCKED` means N workers
 * scale out without a coordination service.
 *
 * Every processor runs inside a transaction bound to the message's tenant, so
 * row-level security applies to background work exactly as it does to requests.
 * A worker that bypassed RLS would be the softest target in the system.
 */
import type { Db } from "./db.ts";
import { workerId } from "./ids.ts";

export interface OutboxMessage {
  readonly outbox_id: number;
  readonly tenant_id: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
}

export interface OutboxProcessor {
  readonly kind: string;
  handle(message: OutboxMessage): Promise<void>;
}

export interface OutboxRunSummary {
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly kinds: Record<string, number>;
}

export class OutboxWorker {
  private readonly db: Db;
  private readonly processors = new Map<string, OutboxProcessor>();
  private readonly id = workerId();
  private stopping = false;

  constructor(db: Db, processors: readonly OutboxProcessor[] = []) {
    this.db = db;
    for (const processor of processors) {
      this.processors.set(processor.kind, processor);
    }
  }

  register(processor: OutboxProcessor): void {
    this.processors.set(processor.kind, processor);
  }

  stop(): void {
    this.stopping = true;
  }

  /** Claim and handle up to `limit` messages. Returns when the batch is drained. */
  async runOnce(limit = 25): Promise<OutboxRunSummary> {
    const claimed = await this.claim(limit);
    let completed = 0;
    let failed = 0;
    const kinds: Record<string, number> = {};

    for (const message of claimed) {
      kinds[message.kind] = (kinds[message.kind] ?? 0) + 1;
      const processor = this.processors.get(message.kind);
      try {
        if (!processor) {
          // An unknown message kind is a deployment skew, not a data problem.
          // Leave it retryable rather than deleting work this worker cannot do.
          throw new Error(`no processor registered for outbox kind ${message.kind}`);
        }
        await this.db.withRequest(
          {
            tenant: message.tenant_id,
            principal: "system:worker",
            scopeIds: [],
            purposes: [],
            action: "worker:process",
          },
          async () => {
            await processor.handle(message);
          },
        );
        await this.complete(message.outbox_id);
        completed += 1;
      } catch (error) {
        failed += 1;
        await this.fail(message, error);
      }
    }

    return { claimed: claimed.length, completed, failed, kinds };
  }

  private async claim(limit: number): Promise<OutboxMessage[]> {
    const result = await this.db.systemQuery<{
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
      [this.id, limit],
    );
    return result.rows.map((row) => ({
      outbox_id: Number(row.outbox_id),
      tenant_id: row.tenant_id,
      kind: row.kind,
      payload: row.payload,
      attempts: Number(row.attempts),
    }));
  }

  private async complete(outboxId: number): Promise<void> {
    await this.db.systemQuery(
      `UPDATE outbox SET completed_at = now(), locked_by = NULL, locked_at = NULL
        WHERE outbox_id = $1`,
      [outboxId],
    );
  }

  /**
   * Retry with exponential backoff. Extraction is idempotent by construction
   * (candidates are keyed on the event and span set), so retrying is always safe
   * and a poison message eventually stops consuming capacity instead of looping.
   */
  private async fail(message: OutboxMessage, error: unknown): Promise<void> {
    const message_text = error instanceof Error ? error.message : String(error);
    const backoffSeconds = Math.min(300, 2 ** Math.min(message.attempts, 8));
    await this.db.systemQuery(
      `UPDATE outbox
          SET last_error = $2,
              locked_by = NULL,
              locked_at = NULL,
              available_at = now() + ($3 || ' seconds')::interval
        WHERE outbox_id = $1`,
      [message.outbox_id, message_text.slice(0, 2000), String(backoffSeconds)],
    );
  }

  /** Drain until empty or stopped. Used by the worker process and by tests. */
  async drain(options: { maxBatches?: number; batchSize?: number; onBatch?: (s: OutboxRunSummary) => void } = {}): Promise<OutboxRunSummary> {
    const maxBatches = options.maxBatches ?? 1000;
    const batchSize = options.batchSize ?? 25;
    const total: { claimed: number; completed: number; failed: number; kinds: Record<string, number> } = {
      claimed: 0,
      completed: 0,
      failed: 0,
      kinds: {},
    };
    for (let i = 0; i < maxBatches && !this.stopping; i += 1) {
      const summary = await this.runOnce(batchSize);
      total.claimed += summary.claimed;
      total.completed += summary.completed;
      total.failed += summary.failed;
      for (const [kind, count] of Object.entries(summary.kinds)) {
        total.kinds[kind] = (total.kinds[kind] ?? 0) + count;
      }
      options.onBatch?.(summary);
      if (summary.claimed === 0) break;
    }
    return total;
  }
}
