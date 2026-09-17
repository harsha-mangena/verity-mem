/**
 * Database handle.
 *
 * One rule the rest of the codebase relies on: every request that reads or
 * writes tenant data runs inside `withRequest`, which opens a transaction and
 * sets the Postgres GUCs that row-level security reads. A query issued outside
 * that scope sees no rows rather than all rows, because the policies fail closed
 * on an unset context. That is the difference between a missing WHERE clause
 * being a leak and being an empty result.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { canonicalize } from "./canonical.ts";

const { Pool, types } = pg;

// Postgres returns bigint as a string by default to avoid precision loss. Every
// bigint in this schema is a sequence number or a row count, which is exactly the
// range where JavaScript numbers are exact, and treating them as strings makes
// every comparison a coercion bug waiting to happen.
types.setTypeParser(types.builtins.INT8, (value: string) => Number.parseInt(value, 10));

export interface QueryResultRow {
  [column: string]: unknown;
}

export interface QueryExecutor {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

interface RequestBinding {
  readonly tenant: string;
  readonly principal: string;
  readonly scopeIds: readonly string[];
  readonly purposes: readonly string[];
  /**
   * The operation being performed, recorded so a policy can distinguish a read
   * from a write in an audit trail. Defaults to `read` because the least
   * privileged label is the safe default for an omitted one.
   */
  readonly action?: string;
}

const requestContext = new AsyncLocalStorage<{ tx: pg.PoolClient }>();

export interface DbOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly applicationName?: string;
}

export class Db {
  readonly pool: pg.Pool;

  constructor(options: DbOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.max ?? 10,
      application_name: options.applicationName ?? "veritymem",
      // Fail fast and loudly rather than hanging a request behind a dead connection.
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
    });
  }

  /**
   * Query inside the active request transaction.
   *
   * Throws when no request context is bound. This is deliberate: an unbindable
   * query means either a bug or a pool-state problem, and both are situations
   * where silently reading whatever the connection happens to be carrying is the
   * worst available behaviour. System tables and maintenance work use
   * `systemQuery`, which says out loud that it is outside the request model.
   */
  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    const active = requestContext.getStore();
    if (!active) {
      throw new Error(
        "database access outside a request context: wrap tenant data access in Db.withRequest, " +
          "or call Db.systemQuery if the statement genuinely does not touch tenant rows",
      );
    }
    const result = await active.tx.query(text, params as unknown[]);
    return { rows: result.rows as R[], rowCount: result.rowCount };
  }

  /**
   * Run a statement on a pooled connection with no request context bound, after
   * clearing any leftover session state.
   *
   * Only for statements that do not read or write tenant rows: schema checks,
   * maintenance, and tests that prove row-level security fails closed. A query
   * against a tenant table through this method returns nothing rather than
   * everything, because the policies treat an unset context as denial.
   */
  async systemQuery<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    const client = await this.pool.connect();
    try {
      // A pooled connection may carry a previous caller's context. Clear it
      // rather than trusting that the last COMMIT discarded it.
      await client.query("ROLLBACK");
      await client.query("RESET ALL");
      const result = await client.query(text, params as unknown[]);
      return { rows: result.rows as R[], rowCount: result.rowCount };
    } finally {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore.
      }
      try {
        await client.query("RESET ALL");
      } catch {
        // Ignore.
      }
      client.release();
    }
  }

  /**
   * Run `fn` inside a transaction bound to a caller's tenant, scope and purpose.
   *
   * `readOnly` transactions are used for the read path so that a retrieval bug
   * cannot mutate the ledger.
   */
  async withRequest<T>(
    binding: RequestBinding,
    fn: (executor: QueryExecutor) => Promise<T>,
    options: { readOnly?: boolean } = {},
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(options.readOnly ? "BEGIN READ ONLY" : "BEGIN");
      await client.query(
        `SELECT veritymem.set_request_context($1::uuid, $2, $3::uuid[], $4::text[], $5)`,
        [
          binding.tenant,
          binding.principal,
          `{${binding.scopeIds.join(",")}}`,
          `{${binding.purposes.map(escapeArrayElement).join(",")}}`,
          binding.action ?? "read",
        ],
      );
      const result = await requestContext.run({ tx: client }, () => fn(this));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // A failed rollback means the connection is already unusable; the pool
        // will discard it. Surfacing the original error matters more.
      }
      throw error;
    } finally {
      // Clear the request context before the connection returns to the pool.
      //
      // `set_config(..., true)` is transaction-local, so COMMIT already discards
      // it — but a connection that comes back from a *failed* transaction, or one
      // whose ROLLBACK itself failed, can still carry a previous caller's tenant
      // id. A pooled connection that remembers who used it last is a
      // cross-tenant read waiting to happen, so this is reset unconditionally.
      try {
        await client.query("RESET ALL");
      } catch {
        // Ignore: the connection is being discarded anyway.
      }
      client.release();
    }
  }

  /**
   * Run `fn` in a transaction bound to a tenant-wide system context.
   *
   * For maintenance paths only: projection rebuilds, retention, replay. The
   * context reaches every row in its own tenant and nothing outside it, and it is
   * set through a dedicated database function rather than by passing an empty
   * scope array — an empty scope array with an empty purpose set is *denied* by
   * every policy, which is how a retention job once scanned nothing and reported
   * success.
   *
   * Requiring the call to be named makes the privilege visible at the call site.
   */
  async withSystemContext<T>(
    binding: { readonly tenant: string; readonly actor: string },
    fn: (executor: QueryExecutor) => Promise<T>,
    options: { readOnly?: boolean } = {},
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(options.readOnly ? "BEGIN READ ONLY" : "BEGIN");
      await client.query(`SELECT veritymem.set_system_context($1::uuid, $2)`, [
        binding.tenant,
        binding.actor,
      ]);
      const result = await requestContext.run({ tx: client }, () => fn(this));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore: the connection is unusable either way.
      }
      throw error;
    } finally {
      try {
        await client.query("RESET ALL");
      } catch {
        // Ignore.
      }
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Quote a value for a Postgres array literal. Purpose strings come from callers,
 * so a value containing a quote or backslash must not be able to terminate the
 * literal early.
 */
function escapeArrayElement(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Advisory lock key. One lock serialises every mutating maintenance task in a
 * deployment (projection build, replay, retention) so that two of them cannot
 * interleave and produce a state that is neither the old nor the new one.
 */
export const MAINTENANCE_LOCK_KEY = 8_274_119_033_551_001n;

/** Hash arbitrary structured data the same way everywhere. */
export async function sha256HexOfJson(value: unknown): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}
