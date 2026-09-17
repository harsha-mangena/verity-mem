#!/usr/bin/env node
/**
 * Apply or verify migrations.
 *
 *   pnpm migrate            apply pending migrations
 *   pnpm migrate --verify   fail if anything is pending, change nothing
 */
import { existsSync } from "node:fs";
import { runMigrations } from "../packages/ledger/src/migrate.ts";
import { loadEnv } from "../packages/ledger/src/config.ts";

const env = loadEnv();
const url = env.migrationDatabaseUrl;
if (!url) {
  console.error(
    "MIGRATION_DATABASE_URL is not set. Copy .env.example to .env, or pass it in the environment.",
  );
  process.exit(2);
}
if (!existsSync(env.migrationsDir)) {
  console.error(`migrations directory not found: ${env.migrationsDir}`);
  process.exit(2);
}

const verifyOnly = process.argv.includes("--verify");
const result = await runMigrations({
  connectionString: url,
  dir: env.migrationsDir,
  verifyOnly,
  log: (message) => console.log(message),
});

console.log(
  `${verifyOnly ? "verified" : "migrated"}: applied=${result.applied.length} ` +
    `already-applied=${result.skipped.length} total=${result.verified.length + result.applied.length}`,
);
for (const name of result.applied) console.log(`  + ${name}`);
