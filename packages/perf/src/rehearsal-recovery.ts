/**
 * Failure and recovery, with the failure actually caused.
 *
 * ## What each case is allowed to do
 *
 * Migration 0015 is attempted four times in four different circumstances. None of the
 * failures is simulated: a real lock is held by a real session, and a real backend is
 * terminated mid-transaction with `pg_terminate_backend`. Only the *conditions* are
 * arranged, and they are arranged out of PostgreSQL's own locking.
 *
 * The third case is the one that matters for the rehearsal's main measurement: it is the
 * **successful** application of 0015, performed after a real abort, with the application
 * workload running. So the migration whose locks and WAL the report publishes is one that
 * has already been proved to recover from an interruption — not a first attempt on a clean
 * database.
 *
 * ## The rule about terminating backends
 *
 * `pg_terminate_backend` is aimed at one pid, and that pid is checked first: it must be
 * connected to this rehearsal's own database and carry this rehearsal's `application_name`.
 * The shared container's postmaster is never a target — the case only ever names a backend
 * PostgreSQL reported for this database, and refuses if the identity does not match.
 *
 * ## Why the interruption is deterministic
 *
 * Terminating a migration "after a while" is a race: once 0015's backfill commits, the case
 * would report a successful rollback of nothing. So the interruption is aimed at a statement
 * that is *provably* blocked. A second session holds `LOCK TABLE events IN EXCLUSIVE MODE`,
 * which conflicts with the `SHARE` lock `CREATE INDEX` takes and with nothing a plain read
 * needs, and the case polls `pg_locks` until the migration's own backend is observed waiting
 * before it terminates it. By then 0015 has created the table, backfilled it and added its
 * primary key inside an uncommitted transaction — so the rollback has real work to undo. If
 * the wait is never observed, the case reports `not_exercised`, which makes the report
 * incomplete rather than falsely green.
 */
import pg from "pg";
import type { MigrationTelemetry } from "./migration-telemetry.ts";
import {
  readHistory,
  runInstrumentedMigrations,
  type InstrumentedRun,
  type MigrationHistoryRow,
} from "./migration-run.ts";

/** The name the migration connection carries, so its backend can be identified. */
export const MIGRATION_APPLICATION_NAME = "veritymem-migration-rehearsal";

/**
 * Objects 0015 creates, in the order it creates them. The interruption is aimed after the
 * primary key, so an aborted run has to roll all of these back.
 */
export const MIGRATION_0015_OBJECTS: readonly string[] = [
  "claim_entities",
  "claim_entities_pkey",
  "claim_entities_claim_idx",
  "claim_embeddings_tenant_model_idx",
  "events_tenant_seq_desc_idx",
  "claims_current_tenant_scope_idx",
];

export type RecoveryStatus = "passed" | "failed" | "not_exercised";

export interface RecoveryCase {
  readonly case: string;
  readonly expectation: string;
  readonly status: RecoveryStatus;
  readonly detail: string;
  readonly error: string | null;
  readonly error_code: string | null;
  readonly elapsed_ms: number | null;
  readonly evidence: Record<string, string | number | boolean | null>;
  readonly telemetry: readonly MigrationTelemetry[];
}

export interface RecoveryResult {
  readonly cases: readonly RecoveryCase[];
  /** The objects 0015 creates, and whether each exists, sampled immediately after each failure. */
  readonly objects_after_lock_timeout: Record<string, boolean>;
  readonly objects_after_interruption: Record<string, boolean>;
  readonly objects_final: Record<string, boolean>;
  readonly history_after: readonly MigrationHistoryRow[];
  /** The successful application of 0015, which is case three. */
  readonly applied_0015: InstrumentedRun | null;
}

export interface RecoveryOptions {
  readonly migrationUrl: string;
  readonly database: string;
  readonly migrationsDir: string;
  readonly telemetryClient: pg.Client;
  readonly sampleIntervalMs: number;
  readonly blockedThresholdMs: number;
  /** The last migration the runs may apply. The failing attempts stop at it. */
  readonly until: string;
  /** The bound each failing run gives `lock_timeout`. */
  readonly lockTimeoutMs: number;
  /** How long to wait for the migration to reach its conflicting statement. */
  readonly observationTimeoutMs: number;
  /** Called when the successful 0015 application is about to run. */
  readonly onSuccessfulApply?: (input: { readonly backend_pid: number }) => Promise<void> | void;
  /** Called once the successful application has committed. */
  readonly onSuccessfulApplied?: () => Promise<void> | void;
  /**
   * Re-verify the projection, called inside the last case.
   *
   * The report's own projection verification runs after every recovery case, but attributing
   * the check to the case that must prove it is what stops a future reordering from quietly
   * verifying the projection *before* the recovery cases ran.
   */
  readonly verifyProjection?: () => Promise<Record<string, number | null>>;
  readonly log: (message: string) => void;
}

/** Which of 0015's objects exist right now. */
export async function probeObjects(client: pg.Client): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const name of MIGRATION_0015_OBJECTS) {
    const row = await client.query<{ present: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS present",
      [`public.${name}`],
    );
    out[name] = row.rows[0]?.present === true;
  }
  const policy = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'claim_entities'
     ) AS present`,
  );
  out["claim_entities_authorized_policy"] = policy.rows[0]?.present === true;
  return out;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Is this backend waiting for a lock, and is it this rehearsal's migration connection? */
async function isOurBackendBlocked(
  observer: pg.Client,
  input: { readonly pid: number; readonly database: string },
): Promise<boolean> {
  const row = await observer.query<{ waiting: boolean; ours: boolean }>(
    `SELECT COALESCE(a.wait_event_type = 'Lock', FALSE) AS waiting,
            COALESCE(a.datname = $2 AND a.application_name = $3, FALSE) AS ours
       FROM pg_stat_activity a WHERE a.pid = $1`,
    [input.pid, input.database, MIGRATION_APPLICATION_NAME],
  );
  const found = row.rows[0];
  return found !== undefined && found.waiting === true && found.ours === true;
}

/**
 * Terminate one backend, after proving it is this rehearsal's migration connection on this
 * rehearsal's database.
 */
export async function terminateOwnMigrationBackend(
  observer: pg.Client,
  input: { readonly pid: number; readonly database: string },
): Promise<{ terminated: boolean; detail: string }> {
  const identity = await observer.query<{
    datname: string;
    application_name: string;
  }>(
    "SELECT datname, application_name FROM pg_stat_activity WHERE pid = $1",
    [input.pid],
  );
  const row = identity.rows[0];
  if (row === undefined) {
    return { terminated: false, detail: `backend ${input.pid} is already gone` };
  }
  if (row.datname !== input.database || row.application_name !== MIGRATION_APPLICATION_NAME) {
    return {
      terminated: false,
      detail:
        `refusing to terminate pid ${input.pid}: it is connected to ${row.datname} as ` +
        `${JSON.stringify(row.application_name)}, not to ${input.database} as ` +
        `${MIGRATION_APPLICATION_NAME}`,
    };
  }
  const killed = await observer.query<{ ok: boolean }>("SELECT pg_terminate_backend($1) AS ok", [
    input.pid,
  ]);
  return {
    terminated: killed.rows[0]?.ok === true,
    detail:
      `pg_terminate_backend(${input.pid}) on ${input.database} as ${MIGRATION_APPLICATION_NAME} ` +
      `returned ${String(killed.rows[0]?.ok)}`,
  };
}

/** Run the cases in order. The database must already be migrated through 0014. */
export async function runRecoveryCases(options: RecoveryOptions): Promise<RecoveryResult> {
  const cases: RecoveryCase[] = [];
  const blocker = new pg.Client({ connectionString: options.migrationUrl });
  await blocker.connect();

  const runCase = (ho: (input: {
    readonly name: string;
    readonly backend_pid: number;
  }) => Promise<void> | void): Promise<InstrumentedRun> =>
    runInstrumentedMigrations({
      migrationUrl: options.migrationUrl,
      migrationsDir: options.migrationsDir,
      until: options.until,
      applicationName: MIGRATION_APPLICATION_NAME,
      lockTimeoutMs: options.lockTimeoutMs,
      telemetryClient: options.telemetryClient,
      sampleIntervalMs: options.sampleIntervalMs,
      blockedThresholdMs: options.blockedThresholdMs,
      log: (message) => options.log(`  ${message}`),
      onBeforeApply: ho,
    });

  // ---- 1. lock_timeout while 0015 waits on a conflicting lock --------------
  let afterLockTimeout: Record<string, boolean> = {};
  {
    const started = Date.now();
    let run: InstrumentedRun | null = null;
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE claims IN ACCESS EXCLUSIVE MODE");
      options.log("recovery lock_timeout: holding ACCESS EXCLUSIVE on claims");
      run = await runCase(() => undefined);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
    }
    afterLockTimeout = await probeObjects(options.telemetryClient);
    const recorded = run.history.filter((row) => row.name.startsWith("0015")).length;
    const absent = MIGRATION_0015_OBJECTS.every((name) => afterLockTimeout[name] === false);
    const timedOut = run.error_code === "55P03" || run.error_code === "57014";
    cases.push({
      case: "lock_timeout_while_0015_waits_on_a_conflicting_lock",
      expectation:
        "with another session holding ACCESS EXCLUSIVE on claims, 0015 waits and fails with " +
        "SQLSTATE 55P03 (lock_not_available); no migration-history row is recorded and none " +
        "of the objects 0015 creates survives, because its DDL is inside the aborted " +
        "transaction",
      status:
        run.error !== null && run.error_code !== null && recorded === 0 && absent && timedOut
          ? "passed"
          : "failed",
      detail:
        `failure: ${run.error?.message ?? "(none)"}; SQLSTATE ${run.error_code ?? "(none)"}; ` +
        `0015 history rows ${recorded}; all objects absent ${String(absent)}`,
      error: run.error?.message ?? null,
      error_code: run.error_code,
      elapsed_ms: Date.now() - started,
      evidence: {
        lock_timeout_ms: options.lockTimeoutMs,
        history_rows_for_0015: recorded,
        observed_as_lock_timeout: timedOut,
        ...prefix(afterLockTimeout, "object_present_"),
      },
      telemetry: run.telemetry,
    });
  }

  // ---- 2. interrupted before commit ---------------------------------------
  let afterInterruption: Record<string, boolean> = {};
  {
    const started = Date.now();
    let run: InstrumentedRun | null = null;
    let observedWaiting = false;
    let termination = "not attempted";
    let backendPid: number | null = null;
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE events IN EXCLUSIVE MODE");
      options.log("recovery interrupted: holding EXCLUSIVE on events");
      // The watcher must not be awaited from inside the hook. `beforeApply` runs after
      // BEGIN and before the migration's SQL, so a hook that waited for the migration to
      // block would be waiting for a statement it is itself holding back — which is how the
      // first version of this case spent twenty seconds and reported `not_exercised`.
      // It is started here and awaited after the run returns.
      let watcher: Promise<void> | null = null;
      run = await runCase(({ name, backend_pid }) => {
        if (!name.startsWith("0015")) return;
        backendPid = backend_pid;
        watcher = (async () => {
          observedWaiting = await waitFor(
            () =>
              isOurBackendBlocked(options.telemetryClient, {
                pid: backend_pid,
                database: options.database,
              }),
            options.observationTimeoutMs,
          );
          if (!observedWaiting) {
            termination =
              `backend ${backend_pid} was not observed waiting for a lock within ` +
              `${options.observationTimeoutMs} ms`;
            return;
          }
          const killed = await terminateOwnMigrationBackend(options.telemetryClient, {
            pid: backend_pid,
            database: options.database,
          });
          termination = killed.detail;
        })();
      });
      if (watcher !== null) await (watcher as Promise<void>);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
    }
    afterInterruption = await probeObjects(options.telemetryClient);
    const recorded = run.history.filter((row) => row.name.startsWith("0015")).length;
    const absent =
      MIGRATION_0015_OBJECTS.every((name) => afterInterruption[name] === false) &&
      afterInterruption["claim_entities_authorized_policy"] === false;

    cases.push({
      case: "interrupted_transaction_before_commit",
      expectation:
        "the 0015 backend is terminated while blocked inside its transaction; no " +
        "migration-history row is recorded, and every object 0015 created — the table, its " +
        "primary key, both of its own indexes, the three tenant indexes it adds to existing " +
        "tables, and its row-level-security policy — is rolled back, which PostgreSQL " +
        "guarantees for DDL inside a transaction",
      status: !observedWaiting ? "not_exercised" : run.error !== null && recorded === 0 && absent ? "passed" : "failed",
      detail: !observedWaiting
        ? `the migration backend was never observed waiting, so the interruption was not exercised (${termination})`
        : `failure: ${run.error?.message ?? "(none)"}; 0015 history rows ${recorded}; ` +
          `all objects absent ${String(absent)}; ${termination}`,
      error: run.error?.message ?? null,
      error_code: run.error_code,
      elapsed_ms: Date.now() - started,
      evidence: {
        backend_pid: backendPid,
        observed_waiting_for_lock: observedWaiting,
        termination,
        history_rows_for_0015: recorded,
        ...prefix(afterInterruption, "object_present_"),
      },
      telemetry: run.telemetry,
    });
  }

  // ---- 3. rerun after the interruption: this is the successful 0015 --------
  let applied: InstrumentedRun | null = null;
  {
    const started = Date.now();
    applied = await runCase(async ({ name, backend_pid }) => {
      if (name.startsWith("0015")) await options.onSuccessfulApply?.({ backend_pid });
    });
    if (applied.error === null) await options.onSuccessfulApplied?.();
    const objects = await probeObjects(options.telemetryClient);
    const recorded = applied.history.filter((row) => row.name.startsWith("0015")).length;
    cases.push({
      case: "rerun_after_interruption",
      expectation:
        "running the migrations again applies exactly 0015, records exactly one " +
        "migration-history row for it, and creates every object the aborted run did not",
      status:
        applied.error === null &&
        applied.result?.applied.includes(options.until) === true &&
        recorded === 1 &&
        MIGRATION_0015_OBJECTS.every((name) => objects[name] === true)
          ? "passed"
          : "failed",
      detail:
        `applied ${JSON.stringify(applied.result?.applied ?? [])}; 0015 history rows ${recorded}; ` +
        `all objects present ${String(MIGRATION_0015_OBJECTS.every((name) => objects[name] === true))}`,
      error: applied.error?.message ?? null,
      error_code: applied.error_code,
      elapsed_ms: Date.now() - started,
      evidence: {
        applied: (applied.result?.applied ?? []).join(","),
        history_rows_for_0015: recorded,
        ...prefix(objects, "object_present_"),
      },
      telemetry: applied.telemetry,
    });
  }

  // ---- 4. rerun after successful application ------------------------------
  {
    const started = Date.now();
    const run = await runCase(() => undefined);
    const appliedNames = run.result?.applied ?? [];
    const skipped = run.result?.skipped.length ?? 0;
    let projection: Record<string, number | null> = {};
    let projectionError: string | null = null;
    try {
      projection = (await options.verifyProjection?.()) ?? {};
    } catch (error) {
      projectionError = (error as Error).message;
    }
    const missing =
      (projection["missing_rows_write_path"] ?? 0) + (projection["missing_rows_migration_predicate"] ?? 0);
    const expectations: readonly [string, boolean][] = [
      ["applies nothing", appliedNames.length === 0],
      ["records no new history row", skipped === run.history.length],
      ["reports no error", run.error === null],
      ["re-verifies the projection", projectionError === null],
      ["leaves the projection exact", missing === 0],
    ];
    const unmet = expectations.filter(([, ok]) => !ok).map(([what]) => what);
    cases.push({
      case: "rerun_after_successful_application",
      expectation:
        "rerunning over a fully applied schema applies nothing, records no new history row, and " +
        "leaves the projection exact when it is re-verified immediately afterwards",
      status: unmet.length === 0 ? "passed" : "failed",
      detail:
        `applied ${appliedNames.length}; already applied ${skipped} of ${run.history.length} ` +
        `recorded migration(s); missing projection rows ${missing}; ` +
        `verify error ${projectionError ?? "(none)"}` +
        (unmet.length === 0 ? "" : `; unmet: ${unmet.join(", ")}`),
      error: run.error?.message ?? null,
      error_code: run.error_code,
      elapsed_ms: Date.now() - started,
      evidence: {
        applied: appliedNames.length,
        already_applied: skipped,
        missing_projection_rows: missing,
        projection_verify_error: projectionError,
        ...prefix(
          Object.fromEntries(
            Object.entries(projection).map(([key, value]) => [key, value !== null]),
          ),
          "projection_measured_",
        ),
      },
      telemetry: run.telemetry,
    });
  }

  await blocker.end().catch(() => undefined);
  return {
    cases,
    objects_after_lock_timeout: afterLockTimeout,
    objects_after_interruption: afterInterruption,
    objects_final: await probeObjects(options.telemetryClient),
    history_after: await readHistory(options.telemetryClient),
    applied_0015: applied,
  };
}

function prefix(values: Record<string, boolean>, pre: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(values)) out[`${pre}${key}`] = value;
  return out;
}
