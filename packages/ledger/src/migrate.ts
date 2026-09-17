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
export async function runMigrations(options: {
  connectionString: string;
  dir?: string;
  verifyOnly?: boolean;
  log?: (message: string) => void;
}): Promise<MigrationResult> {
  const log = options.log ?? (() => {});
  const dir = options.dir ?? defaultMigrationsDir();
  const files = await loadMigrations(dir);

  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  const verified: { name: string; checksum: string }[] = [];

  try {
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
      try {
        await client.query(file.sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [file.name, file.checksum],
        );
        await client.query("COMMIT");
        applied.push(file.name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(
          `migration ${file.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { applied, skipped, verified };
  } finally {
    await client.end();
  }
}
