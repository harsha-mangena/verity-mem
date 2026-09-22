/**
 * Migration runner.
 *
 * Migrations are plain SQL files applied in name order, each inside a
 * transaction, each recorded with a checksum. A migration whose checksum no
 * longer matches what was applied is refused rather than silently re-run: the
 * ledger's replay guarantee is only as good as the schema's history.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly verified: readonly { name: string; checksum: string }[];
}

/**
 * What a hook knows about the migration currently being applied.
 *
 * Carries the backend pid because the only honest way to measure a migration's locks,
 * waits and blocking is to look at the session that is running it, and nothing outside
 * the runner can name that session.
 */
export interface MigrationRunContext {
  readonly name: string;
  readonly checksum: string;
  /** The pid the server reports for the connection applying this migration. */
  readonly backend_pid: number;
}

/**
 * Optional observation points around one migration.
 *
 * `beforeApply` runs after `BEGIN` and before the migration's SQL; `afterApply` runs
 * after `COMMIT`. Nothing here can change what is applied: the hooks cannot rewrite the
 * SQL or suppress the history row, because a runner that let a caller do that would not
 * be a migration runner. They exist so a rehearsal can sample the server while a
 * migration is in flight.
 *
 * A `beforeApply` hook that throws aborts the migration. `afterApply` runs after COMMIT;
 * its failure is reported as `MigrationPostCommitHookError`, never as a rollback.
 */
export interface MigrationHooks {
  readonly beforeApply?: (context: MigrationRunContext) => void | Promise<void>;
  readonly afterApply?: (context: MigrationRunContext) => void | Promise<void>;
  readonly onFailure?: (context: MigrationRunContext, error: unknown) => void | Promise<void>;
}

/**
 * An observer failed only after PostgreSQL committed the migration.
 *
 * This must not be reported as a rollback: callers need to know that schema history is
 * durable but their telemetry is incomplete. `onFailure` is intentionally not called.
 */
export class MigrationPostCommitHookError extends Error {
  readonly context: MigrationRunContext;
  override readonly cause: unknown;

  constructor(context: MigrationRunContext, cause: unknown) {
    super(
      `migration ${context.name} committed, but afterApply failed: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "MigrationPostCommitHookError";
    this.context = context;
    this.cause = cause;
  }
}

export interface RunMigrationsOptions {
  readonly connectionString: string;
  readonly dir?: string;
  readonly verifyOnly?: boolean;
  readonly log?: (message: string) => void;
  /**
   * Apply only migrations up to and including this one.
   *
   * Used to build an intermediate schema — a database migrated to 0013 so that 0014 and
   * 0015 can be rehearsed against a production-shaped one. An unknown name is refused
   * rather than treated as "everything", because a typo that silently applies a migration
   * the caller meant to hold back is the failure mode this option exists to prevent.
   */
  readonly until?: string;
  /** `application_name` for the migration connection, so its backend is identifiable. */
  readonly applicationName?: string;
  /**
   * Session settings applied with `set_config(..., false)` immediately after connecting.
   *
   * Parameters rather than interpolated SQL: a settings name comes from a caller, and
   * the runner has no business building `SET` statements out of caller strings. Numbers
   * and booleans are stringified; anything else must be a string already.
   */
  readonly sessionSettings?: Readonly<Record<string, string | number | boolean>>;
  readonly hooks?: MigrationHooks;
}

export function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../migrations");
}

export async function loadMigrations(dir = defaultMigrationsDir()): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  if (entries.length === 0) {
    throw new Error(`no migrations found in ${dir}`);
  }
  const files: MigrationFile[] = [];
  for (const name of entries) {
    const sql = await readFile(join(dir, name), "utf8");
    files.push({
      name,
      sql,
      checksum: createHash("sha256").update(sql, "utf8").digest("hex"),
    });
  }
  return files;
}

/**
 * Apply every pending migration as a superuser/owner connection.
 *
 * This deliberately uses its own client rather than the application `Db`: the
 * application role is bound by row-level security and cannot create policies, so
 * migrations must not run through it.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationResult> {
  const log = options.log ?? (() => {});
  const dir = options.dir ?? defaultMigrationsDir();
  const all = await loadMigrations(dir);

  let files = all;
  if (options.until !== undefined) {
    // Names are zero-padded, so lexical order is application order and the comparison is
    // the same one `readdir().sort()` used to build the list.
    const boundary = all.findIndex((file) => file.name === options.until);
    if (boundary === -1) {
      throw new Error(
        `--until ${options.until} does not name a migration in ${dir}; known migrations end at ` +
          `${all.at(-1)?.name ?? "(none)"}`,
      );
    }
    files = all.slice(0, boundary + 1);
  }

  const client = new pg.Client({
    connectionString: options.connectionString,
    ...(options.applicationName !== undefined ? { application_name: options.applicationName } : {}),
  });
  await client.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  const verified: { name: string; checksum: string }[] = [];

  /**
   * A backend that is deliberately terminated mid-migration makes the *connection* fail,
   * not the statement, and node-postgres reports that separately from the query's own
   * rejection. Without a listener the client emits an `error` event with no handler, which
   * takes the process down — and the caller who asked for the termination is the one
   * process that must survive to record what happened. Recorded, never swallowed: it is
   * re-thrown by name from the failure path if the statement itself did not report it.
   */
  let connectionError: Error | null = null;
  if (options.hooks !== undefined) {
    client.on("error", (error: Error) => {
      connectionError = error;
      log(`migration connection error: ${error.message}`);
    });
  }

  try {
    if (options.sessionSettings !== undefined) {
      for (const [name, value] of Object.entries(options.sessionSettings)) {
        if (!/^[a-z_][a-z0-9_.]*$/i.test(name)) {
          throw new Error(`session setting name ${JSON.stringify(name)} is not a PostgreSQL GUC name`);
        }
        await client.query("SELECT set_config($1, $2, false)", [name, String(value)]);
      }
    }

    const backendPid = options.hooks === undefined ? null : await readBackendPid(client);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const existing = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations",
    );
    const byName = new Map(existing.rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const prior = byName.get(file.name);
      if (prior !== undefined) {
        if (prior !== file.checksum) {
          throw new Error(
            `migration ${file.name} was modified after it was applied ` +
              `(recorded ${prior.slice(0, 12)}, found ${file.checksum.slice(0, 12)}). ` +
              `Add a new migration instead of editing an applied one.`,
          );
        }
        skipped.push(file.name);
        verified.push({ name: file.name, checksum: file.checksum });
        continue;
      }
      if (options.verifyOnly) {
        throw new Error(`migration ${file.name} is pending; run without --verify to apply`);
      }
      log(`applying ${file.name}`);
      await client.query("BEGIN");
      const context: MigrationRunContext = {
        name: file.name,
        checksum: file.checksum,
        backend_pid: backendPid ?? 0,
      };
      try {
        await options.hooks?.beforeApply?.(context);
        await client.query(file.sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [file.name, file.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The transaction is already gone — which is what a terminated backend looks
          // like. The caller's error is the interesting one, so this is not surfaced.
        }
        await options.hooks?.onFailure?.(context, error);
        const reported =
          connectionError !== null && !/terminat|connection|closed/i.test(String(error))
            ? connectionError
            : error;
        throw new Error(
          `migration ${file.name} failed: ${reported instanceof Error ? reported.message : String(reported)}`,
        );
      }
      applied.push(file.name);
      try {
        await options.hooks?.afterApply?.(context);
      } catch (error) {
        // COMMIT already succeeded. Never enter the rollback/onFailure path above, which
        // would make a committed schema look absent in a recovery report.
        throw new MigrationPostCommitHookError(context, error);
      }
    }
    return { applied, skipped, verified };
  } finally {
    try {
      await client.end();
    } catch {
      // A deliberately terminated backend cannot be shut down gracefully; there is nothing
      // left to close and the caller is unwinding a real failure.
    }
  }
}

/** The pid of the connection, so a hook can name the session it is measuring. */
async function readBackendPid(client: pg.Client): Promise<number> {
  const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return Number(result.rows[0]?.pid ?? 0);
}
