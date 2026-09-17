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

/**
 * Normalise a claimed payload to an object.
 *
 * Returns an empty object for anything unusable, which the binding guard then rejects
 * with its own message — a payload that cannot be parsed is a message that cannot be
 * processed, and saying so is better than a cast that fails later and elsewhere.
 */
export function parsePayload(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

export interface OutboxRunSummary {
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly kinds: Record<string, number>;
}

/**
 * Build the request context for a message.
 *
 * The scope and purposes come from the message payload, because the handler must
 * see the rows it is meant to process. Binding an empty scope array with an empty
 * purpose set is not "unrestricted" — the policies deny every row — so a worker
 * that omitted them would silently do nothing while reporting success, which is
 * exactly the bug this function exists to prevent recurring.
 *
 * A partial binding is an error rather than a default: a message that names a scope
 * but no purposes cannot be processed correctly, and guessing "no purposes" would
 * reproduce the silent no-op in a subtler form.
 */
export function bindingFor(message: OutboxMessage): {
  tenant: string;
  principal: string;
  scopeIds: readonly string[];
  purposes: readonly string[];
  action: string;
} {
  const scopeIds = Array.isArray(message.payload["scope_ids"])
    ? (message.payload["scope_ids"] as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  const purposes = Array.isArray(message.payload["purposes"])
    ? (message.payload["purposes"] as unknown[]).filter((value): value is string => typeof value === "string")
    : [];

  if (scopeIds.length === 0) {
    throw new Error(
      `outbox message ${message.outbox_id} (kind ${message.kind}) carries no scope_ids; ` +
        `a handler bound without a scope would read nothing and report success`,
    );
  }
  if (purposes.length === 0) {
    throw new Error(
      `outbox message ${message.outbox_id} (kind ${message.kind}) carries no purposes; ` +
        `an empty purpose set is denied by every policy, so the handler would be a silent no-op`,
    );
  }

  return {
    tenant: message.tenant_id,
    principal: "system:worker",
    scopeIds,
    purposes,
    action: "worker:process",
  };
}

export interface OutboxWorkerOptions {
  /**
   * Tenants this worker serves.
   *
   * `null` means every tenant, which is right for a single-tenant deployment and for
   * an operator draining the queue, and is the honest way to say "I do not know which
   * tenants exist yet". An empty array is rejected: a worker configured with no
   * tenants would claim nothing and look exactly like an idle one.
   *
   * This exists because a global claim is wrong in both directions — it takes work
   * belonging to another deployment, and a backlog in one tenant starves every other
   * tenant behind it in queue order.
   */
  readonly tenants?: readonly string[] | null;
}

export class OutboxWorker {
  private readonly db: Db;
  private readonly processors = new Map<string, OutboxProcessor>();
  private readonly id = workerId();
  private readonly tenants: readonly string[] | null;
  private stopping = false;

  constructor(db: Db, processors: readonly OutboxProcessor[] = [], options: OutboxWorkerOptions = {}) {
    this.db = db;
    this.tenants = options.tenants ?? null;
    if (this.tenants !== null && this.tenants.length === 0) {
      throw new Error(
        "OutboxWorker was given an empty tenant list; pass undefined to claim from every tenant",
      );
    }
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
        await this.db.withRequest(bindingFor(message), async () => {
          await processor.handle(message);
        });
        await this.complete(message.outbox_id);
        completed += 1;
      } catch (error) {
        failed += 1;
        await this.fail(message, error);
      }
    }

    return { claimed: claimed.length, completed, failed, kinds };
  }

  /**
   * Claim pending messages.
   *
   * Goes through `veritymem.outbox_claim`, a SECURITY DEFINER function, and not
   * through a plain UPDATE. Migration 0009 enabled row-level security on `outbox`
   * with a tenant policy, and claiming is legitimately cross-tenant — the worker must
   * find work before it knows which tenant the work belongs to — so an unbound
   * connection matches nothing under that policy. The previous implementation used
   * `systemQuery`, which is *not* a bypass (it holds a rollback and `RESET ALL`, not
   * owner rights), and the result was a worker that claimed nothing, forever, while
   * reporting itself healthy.
   *
   * A queue a worker cannot read is worse than a queue with no policy, because the
   * failure is invisible.
   */
  private async claim(limit: number): Promise<OutboxMessage[]> {
    const result = await this.db.systemQuery<{
      outbox_id: number;
      tenant_id: string;
      kind: string;
      payload: Record<string, unknown>;
      attempts: number;
    }>(`SELECT * FROM veritymem.outbox_claim($1, $2, $3::uuid[])`, [this.id, limit, this.tenants]);
    return result.rows.map((row) => ({
      outbox_id: Number(row.outbox_id),
      tenant_id: row.tenant_id,
      kind: row.kind,
      // A `JSONB` column normally arrives parsed, but a `RETURNS TABLE` over
      // `SELECT * FROM fn()` can arrive as text depending on how the driver infers the
      // column type. Tolerating both here is deliberate: without it the
      // missing-scope guard fires on a row whose scope is present, and every message
      // fails with an error about the wrong thing.
      payload: parsePayload(row.payload),
      attempts: Number(row.attempts),
    }));
  }

  private async complete(outboxId: number): Promise<void> {
    await this.db.systemQuery(`SELECT veritymem.outbox_complete($1)`, [outboxId]);
  }

  /**
   * Retry with exponential backoff. Extraction is idempotent by construction
   * (candidates are keyed on the event and span set), so retrying is always safe
   * and a poison message eventually stops consuming capacity instead of looping.
   */
  private async fail(message: OutboxMessage, error: unknown): Promise<void> {
    const message_text = error instanceof Error ? error.message : String(error);
    // The backoff is computed inside the database function, so two workers cannot
    // disagree about it and a caller cannot schedule an immediate retry loop.
    await this.db.systemQuery(`SELECT veritymem.outbox_fail($1, $2)`, [message.outbox_id, message_text]);
  }

  /**
   * Projection lag: pending messages, optionally for one tenant.
   *
   * Read through the privileged function for the same reason the claim is: a count
   * taken under the tenant policy on an unbound connection is always zero, and a lag
   * metric that always reads zero is worse than no metric because it looks healthy.
   */
  async lag(tenantId?: string): Promise<number> {
    const result = await this.db.systemQuery<{ lag: number }>(
      `SELECT veritymem.outbox_lag($1::uuid) AS lag`,
      [tenantId ?? null],
    );
    return Number(result.rows[0]?.lag ?? 0);
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
