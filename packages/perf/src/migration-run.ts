/**
 * Apply migrations with the server watched.
 *
 * Wraps the ledger's `runMigrations` — it does not reimplement it. The migration runner owns
 * the transaction boundary, the history row and the checksum check; this module only
 * observes, through the hooks the runner exposes and its own telemetry connection. That
 * separation is what lets the rehearsal claim something about *the* migration path rather
 * than about a second copy of it written for the occasion.
 *
 * One telemetry connection serves both the snapshots and the sampler. They are serialised by
 * the driver's own query queue, and a snapshot taken between two samples costs the sampler
 * one interval — visible in the reported sample count, not hidden.
 */
import pg from "pg";
import { runMigrations, type MigrationResult } from "@veritymem/ledger";
import { readProjectionCounts } from "./rehearsal-verify.ts";
import {
  MigrationSampler,
  takeServerSnapshot,
  walBetween,
  type MigrationSampling,
  type MigrationTelemetry,
  type ServerSnapshot,
} from "./migration-telemetry.ts";

export interface MigrationHistoryRow {
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: string;
}

export interface InstrumentedRunOptions {
  readonly migrationUrl: string;
  readonly migrationsDir: string;
  /** Apply only migrations up to and including this one. */
  readonly until?: string;
  readonly applicationName: string;
  readonly lockTimeoutMs: number;
  readonly telemetryClient: pg.Client;
  readonly sampleIntervalMs: number;
  readonly blockedThresholdMs: number;
  /**
   * Called after `BEGIN` and before the migration's SQL, with the backend that will run it.
   *
   * This is where a rehearsal switches its workload into the migration's phase and where a
   * fault-injection case arms whatever it is about to do to that backend.
   */
  readonly onBeforeApply?: (input: {
    readonly name: string;
    readonly backend_pid: number;
  }) => Promise<void> | void;
  readonly log: (message: string) => void;
}

export interface InstrumentedRun {
  readonly result: MigrationResult | null;
  readonly error: Error | null;
  readonly error_code: string | null;
  readonly telemetry: readonly MigrationTelemetry[];
  readonly history: readonly MigrationHistoryRow[];
  readonly elapsed_ms: number;
}

interface OpenMigration {
  readonly name: string;
  readonly checksum: string;
  readonly backend_pid: number;
  readonly started_at: string;
  readonly started_ms: number;
  readonly before: ServerSnapshot;
  readonly sampler: MigrationSampler;
  readonly lock_timeout_ms: number;
}

/** Read the applied-migration history as the owner role. */
export async function readHistory(client: pg.Client): Promise<readonly MigrationHistoryRow[]> {
  const result = await client.query<{ name: string; checksum: string; applied_at: Date | string }>(
    "SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name",
  );
  return result.rows.map((row) => ({
    name: String(row.name),
    checksum: String(row.checksum),
    applied_at: new Date(row.applied_at).toISOString(),
  }));
}

export async function runInstrumentedMigrations(
  options: InstrumentedRunOptions,
): Promise<InstrumentedRun> {
  const started = Date.now();
  const telemetry: MigrationTelemetry[] = [];
  let open: OpenMigration | null = null;
  let failureCode: string | null = null;

  const closeCurrent = async (input: {
    readonly outcome: "committed" | "failed";
    readonly error: string | null;
    readonly finished_at: string;
  }): Promise<void> => {
    const current = open;
    if (current === null) return;
    open = null;
    const sampling = await current.sampler.stop();
    const after = await takeServerSnapshot(
      options.telemetryClient,
      `snapshot after ${current.name}`,
    );
    const projection = await readProjectionCounts(options.telemetryClient);
    telemetry.push(
      buildTelemetry({
        current,
        after,
        sampling,
        projection,
        outcome: input.outcome,
        error: input.error,
        finished_at: input.finished_at,
        elapsed_ms: Date.now() - current.started_ms,
      }),
    );
  };

  const result = await runMigrations({
    connectionString: options.migrationUrl,
    dir: options.migrationsDir,
    applicationName: options.applicationName,
    sessionSettings: { lock_timeout: options.lockTimeoutMs },
    ...(options.until !== undefined ? { until: options.until } : {}),
    log: options.log,
    hooks: {
      beforeApply: async (context) => {
        const before = await takeServerSnapshot(
          options.telemetryClient,
          `snapshot before ${context.name}`,
        );
        const sampler = new MigrationSampler({
          client: options.telemetryClient,
          migration_pid: context.backend_pid,
          interval_ms: options.sampleIntervalMs,
          blocked_threshold_ms: options.blockedThresholdMs,
        });
        open = {
          name: context.name,
          checksum: context.checksum,
          backend_pid: context.backend_pid,
          started_at: new Date().toISOString(),
          started_ms: Date.now(),
          before,
          sampler,
          lock_timeout_ms: options.lockTimeoutMs,
        };
        await sampler.start();
        // Last, so that a fault-injection hook which terminates this backend does so only
        // after the sampler is already watching it.
        await options.onBeforeApply?.({ name: context.name, backend_pid: context.backend_pid });
      },
      afterApply: async () => {
        await closeCurrent({ outcome: "committed", error: null, finished_at: new Date().toISOString() });
      },
      onFailure: async (_context, error) => {
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: unknown }).code;
        failureCode = typeof code === "string" ? code : null;
        await closeCurrent({ outcome: "failed", error: message, finished_at: new Date().toISOString() });
      },
    },
  }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({
      ok: false as const,
      error: error instanceof Error ? error : new Error(String(error)),
    }),
  );

  const history = await readHistory(options.telemetryClient);
  if (!result.ok) {
    return {
      result: null,
      error: result.error,
      error_code: failureCode,
      telemetry,
      history,
      elapsed_ms: Date.now() - started,
    };
  }
  return {
    result: result.value,
    error: null,
    error_code: null,
    telemetry,
    history,
    elapsed_ms: Date.now() - started,
  };
}

function buildTelemetry(input: {
  readonly current: OpenMigration;
  readonly after: ServerSnapshot;
  readonly sampling: MigrationSampling;
  readonly projection: { readonly present: boolean; readonly values: Record<string, number | null> };
  readonly outcome: "committed" | "failed";
  readonly error: string | null;
  readonly finished_at: string;
  readonly elapsed_ms: number;
}): MigrationTelemetry {
  const { current, after } = input;
  const before = current.before;

  const sizeDelta =
    before.database_size_bytes === null || after.database_size_bytes === null
      ? null
      : after.database_size_bytes - before.database_size_bytes;

  const rowsBackfilled =
    after.claim_entities_rows === null
      ? null
      : after.claim_entities_rows - (before.claim_entities_rows ?? 0);

  const temporaryBefore = before.temp_files === null && before.temp_bytes === null ? null : before;
  const temporaryAfter = after.temp_files === null && after.temp_bytes === null ? null : after;

  return {
    name: current.name,
    checksum: current.checksum,
    started_at: current.started_at,
    finished_at: input.finished_at,
    elapsed_ms: input.elapsed_ms,
    exit_code: input.outcome === "committed" ? 0 : 1,
    outcome: input.outcome,
    error: input.error,
    backend_pid: current.backend_pid,
    lock_timeout_ms: current.lock_timeout_ms,
    lock_acquisition_wait_ms: input.sampling.lock_acquisition_wait_ms,
    locks_held: input.sampling.locks_held,
    blocked_sessions: input.sampling.blocked_sessions,
    blocked_sessions_count: input.sampling.blocked_sessions.length,
    statements_blocked_over_threshold: input.sampling.statements_blocked_over_threshold,
    wal: walBetween(before, after),
    database_size: {
      before_bytes: before.database_size_bytes,
      after_bytes: after.database_size_bytes,
      delta_bytes: sizeDelta,
    },
    claim_entities: {
      present_before: before.claim_entities_present,
      present_after: after.claim_entities_present,
      total_bytes_before: before.claim_entities_total_bytes,
      total_bytes_after: after.claim_entities_total_bytes,
      index_bytes_before: before.claim_entities_index_bytes,
      index_bytes_after: after.claim_entities_index_bytes,
      rows_before: before.claim_entities_rows,
      rows_after: after.claim_entities_rows,
      rows_backfilled: rowsBackfilled,
    },
    temporary_files: {
      files_before: temporaryBefore?.temp_files ?? null,
      files_after: temporaryAfter?.temp_files ?? null,
      bytes_before: temporaryBefore?.temp_bytes ?? null,
      bytes_after: temporaryAfter?.temp_bytes ?? null,
    },
    sampling: input.sampling,
    projection_after: input.projection.values,
  };
}
