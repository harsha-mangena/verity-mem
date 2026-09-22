/**
 * An isolated database for the benchmark.
 *
 * ## Why this exists
 *
 * `claim_embeddings` carries an HNSW index that is **global, not per tenant**, and the
 * `model_id`/tenant/scope filters on the dense channel's query cannot be pushed into the
 * index scan — pgvector walks the graph and the filters are applied to the rows it
 * returns. That has a consequence for measurement that is easy to miss: a tenant holding
 * 40% of a table whose remaining 60% was written by two other corpora gets an HNSW walk
 * that is mostly wasted work. The first attempt at this benchmark measured exactly that
 * and reported seconds per query for a 5 000-claim tenant, which is a fact about the
 * neighbours in the index, not about the tenant.
 *
 * The fix is not to tune anything. It is to measure in a database that contains this
 * corpus and nothing else, which is what a published benchmark is obliged to do anyway:
 * the number is supposed to describe *a million claims*, not "a million claims sharing an
 * index with whatever else happened to be in the developer's database".
 *
 * ## What it does, in order
 *
 * 1. `CREATE DATABASE` (empty, owned by the migration user).
 * 2. `CREATE EXTENSION vector` and `pg_trgm`, which need a superuser — the same two the
 *    compose file's `initdb` script installs for the reference database.
 * 3. Grant `veritymem_app` connect and schema usage, so the read path runs as the same
 *    RLS-bound role it does everywhere else. The role is cluster-wide and already exists;
 *    a missing role is created, with the same attributes the compose file declares.
 * 4. Apply `migrations/` with the ledger's own migration runner, so the schema is the
 *    one a deployment gets and not a hand-built approximation of it.
 *
 * The server configuration is deliberately *not* touched. `shared_buffers`, `work_mem`
 * and the rest stay at whatever the running PostgreSQL was started with, and the report
 * reads them back and publishes them — an isolated database with a silently different
 * configuration would be a different measurement wearing the same label.
 */
import pg from "pg";
import { runMigrations } from "@veritymem/ledger";

const { Client } = pg;

export interface BootstrapOptions {
  /** Superuser connection, e.g. `postgres://verity:verity@127.0.0.1:55432/veritymem`. */
  readonly adminUrl: string;
  readonly databaseName: string;
  readonly migrationsDir: string;
  readonly log: (message: string) => void;
}

export interface BootstrapResult {
  readonly database: string;
  /** URLs to pass to `load` and `bench`. */
  readonly migrationUrl: string;
  readonly databaseUrl: string;
  readonly migrationsApplied: readonly string[];
  readonly migrationsAlreadyApplied: number;
  readonly created: boolean;
}

/** Derive the connection strings for the new database from the admin connection. */
export function urlsFor(
  adminUrl: string,
  databaseName: string,
): { readonly migrationUrl: string; readonly databaseUrl: string } {
  const parsed = new URL(adminUrl);
  const appUrl = new URL(adminUrl);
  appUrl.username = "veritymem_app";
  appUrl.password = "veritymem_app";
  const withDatabase = (url: URL): string => {
    url.pathname = `/${databaseName}`;
    return url.toString();
  };
  return {
    migrationUrl: withDatabase(parsed),
    // The read path connects as the RLS-bound application role, exactly as it does in
    // the reference database. A benchmark that read as the owner would be measuring a
    // system with row-level security turned off.
    databaseUrl: withDatabase(appUrl),
  };
}

/**
 * Create and migrate a benchmark-only database.
 *
 * Idempotent: an existing database is left in place and its pending migrations are
 * applied, which is what someone re-running the benchmark after a `git pull` wants.
 */
export async function bootstrapDatabase(options: BootstrapOptions): Promise<BootstrapResult> {
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(options.databaseName)) {
    throw new Error(
      `database name ${options.databaseName} must be lowercase letters, digits and underscores; ` +
        `it is interpolated into DDL, where a parameter placeholder is not available`,
    );
  }
  const { migrationUrl, databaseUrl } = urlsFor(options.adminUrl, options.databaseName);
  const admin = new Client({ connectionString: options.adminUrl });

  let created = false;
  await admin.connect();
  try {
    const existing = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [
      options.databaseName,
    ]);
    if (existing.rowCount === 0) {
      // CREATE DATABASE cannot run inside a transaction, and identifiers cannot be
      // parameterised — hence the name validation above rather than a placeholder.
      await admin.query(`CREATE DATABASE ${options.databaseName}`);
      created = true;
      options.log(`created database ${options.databaseName}`);
    } else {
      options.log(`database ${options.databaseName} already exists`);
    }
  } finally {
    await admin.end();
  }

  const target = new Client({ connectionString: migrationUrl });
  await target.connect();
  try {
    await target.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await target.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    // The role is cluster-wide, so it usually exists already; created here with the same
    // attributes the compose file's initdb uses, so a fresh cluster behaves identically.
    await target.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'veritymem_app') THEN
          CREATE ROLE veritymem_app LOGIN PASSWORD 'veritymem_app'
            NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
        END IF;
      END
      $$;
    `);
    await target.query(`GRANT CONNECT ON DATABASE ${options.databaseName} TO veritymem_app`);
    await target.query(`GRANT USAGE ON SCHEMA public TO veritymem_app`);
    options.log(`extensions and grants ready on ${options.databaseName}`);
  } finally {
    await target.end();
  }

  const applied = await runMigrations({
    connectionString: migrationUrl,
    dir: options.migrationsDir,
    verifyOnly: false,
    log: options.log,
  });

  // Grant again *after* migrating: the tables the migrations created did not exist when
  // the first grant ran, and `ALTER DEFAULT PRIVILEGES` only covers objects created later
  // by the same role.
  const after = new Client({ connectionString: migrationUrl });
  await after.connect();
  try {
    await after.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO veritymem_app`);
    await after.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO veritymem_app`);
    await after.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA veritymem TO veritymem_app`);
    await after.query(`GRANT USAGE ON SCHEMA veritymem TO veritymem_app`);
  } finally {
    await after.end();
  }

  return {
    database: options.databaseName,
    migrationUrl,
    databaseUrl,
    migrationsApplied: applied.applied,
    migrationsAlreadyApplied: applied.skipped.length,
    created,
  };
}
