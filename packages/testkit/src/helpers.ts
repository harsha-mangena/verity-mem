/**
 * Shared test scaffolding.
 *
 * Tests run against a real PostgreSQL 17 with pgvector, as the RLS-bound
 * application role — not against a mock. The invariants under test (row-level
 * security, append-only triggers, HNSW indexing, `SKIP LOCKED` claiming) exist
 * only in the database, so a mock would verify that the mock agrees with itself.
 *
 * Isolation is by tenant rather than by wiping tables: the ledger is append-only
 * on purpose, and a test suite that can delete events is testing a different
 * system than the one that ships.
 */
import { randomUUID } from "node:crypto";
import {
  Db,
  FilesystemBlobStore,
  Ledger,
  MemoryBlobStore,
  fixedClock,
  loadEnv,
  seededIds,
} from "@veritymem/ledger";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const env = loadEnv();

export interface TestContext {
  readonly db: Db;
  readonly ledger: Ledger;
  readonly tenantSlug: string;
  readonly blobs: MemoryBlobStore;
  readonly startedAt: string;
  close(): Promise<void>;
}

export async function createTestContext(label: string): Promise<TestContext> {
  const db = new Db({ connectionString: env.databaseUrl, max: 4 });
  const blobs = new MemoryBlobStore();
  const clock = fixedClock("2026-09-17T12:00:00.000Z");
  const ledger = new Ledger({
    db,
    blobs,
    clock,
    ids: seededIds(`${label}-${randomUUID().slice(0, 8)}`),
  });
  return {
    db,
    ledger,
    tenantSlug: `test-${label}-${randomUUID().slice(0, 8)}`,
    blobs,
    startedAt: "2026-09-17T12:00:00.000Z",
    async close() {
      await db.close();
    },
  };
}

/** A filesystem-backed context, used to prove the on-disk blob store round-trips. */
export async function createFilesystemBlobStore(): Promise<FilesystemBlobStore> {
  const dir = await mkdtemp(join(tmpdir(), "veritymem-blobs-"));
  return new FilesystemBlobStore(dir);
}

let connected: boolean | null = null;

export async function databaseAvailable(): Promise<boolean> {
  if (connected !== null) return connected;
  const db = new Db({ connectionString: env.databaseUrl, max: 1 });
  try {
    await db.query("SELECT 1");
    connected = true;
  } catch {
    connected = false;
  } finally {
    await db.close();
  }
  return connected;
}

/**
 * Bind a request context for a test. `action` is optional because the production
 * binding treats an omitted action as a read, and tests should exercise the same
 * default rather than a stricter one.
 */
export interface TestRequestBinding {
  readonly tenant: string;
  readonly principal: string;
  readonly scopeIds: readonly string[];
  readonly purposes: readonly string[];
  readonly action?: string;
}

export function requireDatabase(): void {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is not set; run `pnpm db:up` and `pnpm migrate` first");
  }
}

/** Assert a promise rejects and return the error, for negative-path tests. */
export async function captureError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected the call to reject, but it resolved");
}

export interface SeededClaimWorld {
  readonly tenantSlug: string;
  readonly project: string;
  readonly userId: string;
  readonly scopeId: string;
  readonly tenantId: string;
  readonly purposes: readonly string[];
}

export const DEFAULT_TEST_SCOPE = {
  project: "payments",
  user: "alice",
  purposes: ["release_planning"] as const,
};
