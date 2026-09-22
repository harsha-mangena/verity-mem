/**
 * `eval:perf migration-rehearsal` — apply 0014 and 0015 to a production-shaped database
 * while the application keeps working.
 *
 * ## What this measures, and what it deliberately does not
 *
 * It measures **migration safety**: how long each migration took, what it locked, who waited
 * behind it, what it wrote to WAL, how much it grew the database, and whether the application
 * stayed available while it ran. It does **not** measure whether the migrations make
 * retrieval faster — that is a different experiment on a different corpus — and no result
 * from this command may be reported as a latency improvement, an ANN benchmark, or a
 * statement of production readiness.
 *
 * ## The order of operations, and why it is this order
 *
 *   1. Create (or select) a **disposable** database and prove it is disposable.
 *   2. Migrate it **through 0013 only**. Loading the corpus there is not a shortcut: at 0013
 *      `claim_entities` does not exist, which is exactly the state a production database is
 *      in before 0015, and it is why the loader stops before its last phase.
 *   3. Load a deterministic corpus, as the owner role.
 *   4. Start the workload, as `veritymem_app`, and verify every probe operation works before
 *      anything is measured.
 *   5. Apply **0014** while the workload runs.
 *   6. Run the two failing attempts at **0015** — a lock timeout and a terminated backend —
 *      with the workload paused, because each holds a lock that blocks every read and an
 *      outage measured there would be caused by the fault injector rather than the migration.
 *   7. Apply **0015** for real, under load. It is the *rerun after the interruption*, so the
 *      migration whose telemetry is published has already been proved to recover from an
 *      abort.
 *   8. Rerun once more to prove idempotence.
 *   9. Verify the projection and the tenant boundary, then write the report.
 *
 * ## The safety rule that overrides everything
 *
 * The developer's ordinary database is never touched. The target is validated by name against
 * the configured `DATABASE_URL` and `MIGRATION_DATABASE_URL` before a single connection is
 * opened; see `rehearsal-target.ts`. There is no flag that turns that check off, and the
 * rehearsal never drops a database it did not create or one that does not carry its marker.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { DEFAULT_COMMIT_POLICY } from "@veritymem/contracts";
import { CommitGate, LexicalEntailmentBackend } from "@veritymem/gate";
import {
  Db,
  FilesystemBlobStore,
  Ledger,
  loadEnv,
  resolveTenantId,
  runMigrations,
  systemClock,
  systemIds,
} from "@veritymem/ledger";
import { DETERMINISTIC_EXTRACTORS, IngestPipeline } from "@veritymem/model-adapters";
import {
  HashEmbeddingBackend,
  lexicalChannel,
  projectClaim,
  type ProjectionDependencies,
} from "@veritymem/retrieval";
import { loadCorpus, syncStreams } from "./load.ts";
import { assertJsonSafe, type MigrationTelemetry } from "./migration-telemetry.ts";
import { readHistory, runInstrumentedMigrations, type MigrationHistoryRow } from "./migration-run.ts";
import {
  PROBE_OPERATIONS,
  channelQueryFor,
  probeAppend,
  probeEntity,
  probeHydration,
  probeLexical,
  probeProject,
  errorCodeOf,
  startWorkload,
  type ProbeDependencies,
  type ProbeTenant,
  type WorkloadHandle,
} from "./rehearsal-probes.ts";
import {
  WorkloadRecorder,
  measured,
  missing,
  missingMeasurements,
  noteFor,
  notApplicable,
  type MeasurementNote,
  type WorkloadPhase,
  type WorkloadStats,
} from "./rehearsal-metrics.ts";
import {
  PROJECTION_INVARIANTS,
  measureResidue,
  transitionStatus,
  verifyProjection,
  verifyProjectionBehaviours,
  verifyProjectionIsolation,
  type BehaviourCase,
  type ProjectionVerification,
  type RlsCheck,
} from "./rehearsal-verify.ts";
import {
  MIGRATION_APPLICATION_NAME,
  runRecoveryCases,
  type RecoveryCase,
} from "./rehearsal-recovery.ts";
import {
  assertSelectableTarget,
  inspectTarget,
  rehearsalDatabaseName,
  validateRehearsalTarget,
} from "./rehearsal-target.ts";

/** Bumped when the report's shape changes in a way a reader would have to handle. */
export const REHEARSAL_SCHEMA_VERSION = "vm-a2.migration-rehearsal.1";

/** The migration the corpus load stops at, and the two the rehearsal measures. */
export const CORPUS_MIGRATION = "0013_projection_versions_per_tenant.sql";
export const FIRST_MEASURED_MIGRATION = "0014_precomputed_scope_reach.sql";
export const FINAL_MIGRATION = "0015_claim_entity_index.sql";

export interface RehearsalProfile {
  readonly claims_per_tenant: number;
  readonly tenants: number;
  readonly read_concurrency: number;
  readonly write_concurrency: number;
  readonly duration_seconds: number;
  readonly statement_timeout_ms: number;
  readonly lock_timeout_ms: number;
  readonly note: string;
}

/**
 * The two profiles.
 *
 * Neither is called "production scale", because neither is: the CI profile exists to run on
 * every commit, and the local profile exists to be the largest corpus a laptop loads in a few
 * minutes. A profile name that implied production would turn a rehearsal into a claim.
 */
export const REHEARSAL_PROFILES: Readonly<Record<"ci" | "local", RehearsalProfile>> = {
  ci: {
    claims_per_tenant: 2_000,
    tenants: 2,
    read_concurrency: 2,
    write_concurrency: 1,
    duration_seconds: 20,
    statement_timeout_ms: 5_000,
    lock_timeout_ms: 400,
    note:
      "small deterministic rehearsal sized for CI: it finishes in about a minute and " +
      "exercises every operation on both tenants. Not production scale.",
  },
  local: {
    claims_per_tenant: 50_000,
    tenants: 2,
    read_concurrency: 4,
    write_concurrency: 2,
    duration_seconds: 300,
    statement_timeout_ms: 30_000,
    lock_timeout_ms: 2_000,
    note:
      "larger local rehearsal: a corpus big enough that 0015's backfill and index builds take " +
      "measurable time, over a probe window of several minutes. Not production scale, and not " +
      "a benchmark of any kind.",
  },
};

export type ProfileName = keyof typeof REHEARSAL_PROFILES;

export interface RehearsalOptions {
  readonly profile: ProfileName;
  readonly claims_per_tenant: number;
  readonly tenants: number;
  readonly read_concurrency: number;
  readonly write_concurrency: number;
  readonly duration_seconds: number;
  readonly statement_timeout_ms: number;
  readonly lock_timeout_ms: number;
  readonly output: string;
  /** An explicit disposable database URL, or null to create a uniquely named one. */
  readonly rehearsal_url: string | null;
  readonly database_name: string | null;
  readonly migrations_dir: string;
  readonly sample_interval_ms: number;
  readonly blocked_threshold_ms: number;
  readonly observation_timeout_ms: number;
  readonly corpus_seed: string;
  readonly anchor: string;
  readonly log: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface RoleFact {
  readonly rolname: string | null;
  readonly rolsuper: boolean | null;
  readonly rolbypassrls: boolean | null;
  readonly owns_migrated_tables: boolean | null;
}

export interface RehearsalReport {
  readonly report_version: string;
  readonly generated_at: string;
  readonly git: {
    readonly commit: string | null;
    readonly branch: string | null;
    readonly dirty: boolean | null;
  };
  readonly postgres: {
    readonly server_version: string | null;
    readonly pgvector_version: string | null;
    readonly settings: Record<string, string>;
  };
  readonly migrations: {
    readonly dir: string;
    readonly applied_through_0013: readonly string[];
    readonly hashes: readonly { readonly name: string; readonly sha256: string }[];
  };
  readonly environment: {
    readonly profile: ProfileName;
    readonly profile_note: string;
    readonly parameters: Record<string, string | number>;
  };
  readonly target: {
    readonly database: string;
    readonly mode: "created" | "selected" | "recreated";
    readonly url_redacted: string;
    readonly protections: readonly string[];
    readonly size_before_bytes: number | null;
    readonly size_after_bytes: number | null;
  };
  readonly roles: {
    readonly migration: RoleFact;
    readonly app: RoleFact;
    readonly statement: string;
  };
  readonly corpus: {
    readonly seed: string;
    readonly anchor: string;
    readonly claims_per_tenant: number;
    readonly tenants: readonly {
      readonly slug: string;
      readonly tenant_id: string;
      readonly counts: Record<string, number>;
    }[];
    readonly total_claims: number;
    readonly load_elapsed_ms: number;
  };
  readonly telemetry: readonly MigrationTelemetry[];
  readonly workload: WorkloadStats;
  readonly projection: {
    readonly invariants: typeof PROJECTION_INVARIANTS;
    readonly verification: ProjectionVerification;
    readonly residue: {
      readonly rows: number | null;
      readonly claims: number | null;
      readonly by_status: Record<string, number>;
    };
    readonly behaviours: readonly BehaviourCase[];
    readonly rls: RlsCheck;
  };
  readonly recovery: {
    readonly cases: readonly RecoveryCase[];
    readonly objects_after_lock_timeout: Record<string, boolean>;
    readonly objects_after_interruption: Record<string, boolean>;
    readonly objects_final: Record<string, boolean>;
    readonly history: readonly MigrationHistoryRow[];
  };
  /**
   * What the *current* application code can do at each schema state.
   *
   * Recorded because it is a property of the rollout, not of the migration: the retrieval
   * channels call a function 0014 creates, and the projection writes into a table 0015
   * creates, so the order in which the schema and the application are deployed is a
   * correctness question rather than a performance one.
   */
  readonly compatibility: readonly CompatibilityPhase[];
  /** Facts derived from the measurements that constrain how this can be deployed. */
  readonly findings: readonly Finding[];
  readonly measurements: readonly MeasurementNote[];
  readonly limitations: readonly string[];
  readonly complete: boolean;
  readonly incompleteness_reasons: readonly string[];
}

export interface CompatibilityPhase {
  readonly phase: WorkloadPhase;
  readonly schema: string;
  readonly operations: readonly {
    readonly operation: string;
    readonly attempts: number;
    readonly successes: number;
    readonly error_codes: readonly string[];
  }[];
}

export interface Finding {
  readonly id: string;
  readonly statement: string;
  readonly evidence: string;
}

/**
 * Everything this rehearsal is not evidence for.
 *
 * Stated in the report rather than only in the documentation, because the report is what gets
 * quoted and the documentation is what gets skimmed.
 */
export const LIMITATIONS: readonly string[] = [
  "This is a migration-safety rehearsal, not a latency measurement. It says nothing about " +
    "whether retrieval is faster or slower after 0014 and 0015, and no timing in it may be " +
    "reported as a performance improvement.",
  "The corpus is synthetic and deterministic. Its claim sizes, entity cardinalities, relation " +
    "density and query distribution are generated, not observed from a real deployment, so the " +
    "lock and WAL figures describe this corpus rather than any production workload.",
  "Neither profile is production scale. The database is one PostgreSQL instance on the same " +
    "host as the client, with the server's own configuration, and there is no replication, no " +
    "connection pooler and no traffic other than this rehearsal.",
  "WAL bytes are a cluster-wide measurement: PostgreSQL publishes one WAL stream per cluster, " +
    "so the workload's own writes are included in every WAL delta. The corpus's claim counts " +
    "and the probe's write counts are published next to it so the contamination can be sized.",
  "Lock acquisition wait is a sampled lower bound. A wait shorter than the sampling interval " +
    "can fall entirely between two samples, and a wait spanning several intervals is counted " +
    "as whole intervals. Only the failing lock_timeout case has an exact wait, and there it is " +
    "the configured timeout.",
  "Blocked-session durations come from `now() - query_start` at sample time, which is an upper " +
    "bound on the lock wait: it includes whatever work the statement did before it blocked.",
  "The projection-behaviour checks mutate a few of the claims the probe wrote, moving them to " +
    "disputed, revoked and rejected so those paths can be observed. The rehearsal therefore " +
    "leaves its database correct but no longer a pristine post-migration copy.",
  "The rehearsal measures one PostgreSQL major version on one machine. The version and the " +
    "pgvector extension version are read from the server at run time; a different version may " +
    "lock, plan or write WAL differently.",
  "`--duration` bounds the *measured* probe window; time spent inside the paused failing " +
    "migration attempts is excluded and reported as each case's own elapsed time.",
  "The migrations measured here are the two named in the report, at the checksums recorded in " +
    "it. A different revision of those files is a different experiment.",
];

const ROLES_STATEMENT =
  "Migrations and every verification query run on a connection authenticated as the " +
  "table-owner role; all workload operations run on a connection authenticated as " +
  "veritymem_app, whose rolsuper and rolbypassrls are read from pg_roles and must both be " +
  "false. A rehearsal whose application probes used the owner role would be measuring a " +
  "system with row-level security switched off.";

/** The report's own bookkeeping: which measurements were taken, and which were not. */
export function assessRehearsal(report: RehearsalReport): {
  readonly complete: boolean;
  readonly reasons: readonly string[];
} {
  const reasons: string[] = [];
  for (const note of missingMeasurements(report.measurements)) {
    reasons.push(`${note.field}: ${note.reason}`);
  }

  if (report.git.commit === null) reasons.push("git.commit could not be read");
  if (report.migrations.hashes.length === 0) reasons.push("no migration hashes were computed");
  for (const name of [FIRST_MEASURED_MIGRATION, FINAL_MIGRATION]) {
    if (!report.migrations.hashes.some((entry) => entry.name === name)) {
      reasons.push(`migration ${name} was not found on disk, so its hash is unknown`);
    }
  }
  if (report.corpus.total_claims <= 0) {
    reasons.push("the corpus holds no claims, so every projection check would be vacuous");
  }
  if (report.roles.app.rolsuper !== false) {
    reasons.push("the application role's superuser attribute was not verified false");
  }
  if (report.roles.app.rolbypassrls !== false) {
    reasons.push("the application role's BYPASSRLS attribute was not verified false");
  }
  if (report.roles.migration.owns_migrated_tables !== true) {
    reasons.push("the migration role was not verified to own the tables it migrates");
  }
  if (report.telemetry.length < 2) {
    reasons.push(
      `only ${report.telemetry.length} migration telemetry record(s) were produced; expected ` +
        `one for ${FIRST_MEASURED_MIGRATION} and one for ${FINAL_MIGRATION}`,
    );
  }
  for (const record of report.telemetry) {
    if (record.outcome !== "committed") {
      reasons.push(`migration ${record.name} did not commit (${record.outcome})`);
    }
    if (record.elapsed_ms === null || record.elapsed_ms <= 0) {
      reasons.push(`migration ${record.name} has no measured elapsed time`);
    }
    if (record.wal.bytes_generated === null) {
      reasons.push(
        `migration ${record.name} has no WAL byte count: ${record.wal.error ?? "unmeasured"}`,
      );
    }
    if (record.database_size.before_bytes === null || record.database_size.after_bytes === null) {
      reasons.push(`migration ${record.name} has no database-size measurement on both sides`);
    }
    if (record.sampling === null || record.sampling.samples === 0) {
      reasons.push(`migration ${record.name} has no lock samples, so blocking was not observed`);
    }
    if (record.temporary_files.files_before === null || record.temporary_files.files_after === null) {
      reasons.push(`migration ${record.name} has no temporary-file counters`);
    }
  }
  const final = report.telemetry.find((record) => record.name === FINAL_MIGRATION);
  if (final !== undefined && final.claim_entities.rows_backfilled === null) {
    reasons.push(`${FINAL_MIGRATION} has no backfilled-row count`);
  }

  if (report.workload.samples_from_non_probe !== 0) {
    reasons.push(
      `${report.workload.samples_from_non_probe} workload sample(s) came from a non-probe ` +
        `source, so application latency is contaminated by migration timings`,
    );
  }
  for (const operation of PROBE_OPERATIONS) {
    const stats = report.workload.operations.find((entry) => entry.operation === operation);
    if (stats === undefined || stats.attempts === 0) {
      reasons.push(`the ${operation} probe recorded no attempt, so it was never exercised`);
      continue;
    }
    if (stats.successes === 0) {
      reasons.push(
        `the ${operation} probe never succeeded, so no availability can be claimed for it`,
      );
    }
  }
  for (const check of report.projection.verification.checks) {
    if (!check.ok) {
      reasons.push(
        `projection invariant ${check.name} is ${check.count ?? "unmeasured"}, expected ${check.expected}`,
      );
    }
  }
  if (!report.projection.rls.ok) {
    reasons.push("the tenant-boundary check on claim_entities did not pass");
  }
  if (report.projection.behaviours.length === 0) {
    reasons.push("no projection-behaviour case was run");
  }
  for (const behaviour of report.projection.behaviours) {
    if (!behaviour.ok) {
      reasons.push(`projection behaviour ${behaviour.case} did not meet its expectation`);
    }
  }
  for (const recovery of report.recovery.cases) {
    if (recovery.status !== "passed") {
      reasons.push(`recovery case ${recovery.case} is ${recovery.status}: ${recovery.detail}`);
    }
  }
  if (report.recovery.history.length === 0) {
    reasons.push("the migration history is empty");
  }

  return { complete: reasons.length === 0, reasons };
}

export function renderRehearsal(report: RehearsalReport): string {
  const lines: string[] = [];
  lines.push(`migration rehearsal  ${report.report_version}`);
  lines.push(`  profile     ${report.environment.profile} — ${report.environment.profile_note}`);
  lines.push(`  target      ${report.target.database} (${report.target.mode})`);
  lines.push(
    `  postgres    ${report.postgres.server_version ?? "unknown"}  ` +
      `pgvector ${report.postgres.pgvector_version ?? "unknown"}`,
  );
  lines.push(
    `  corpus      ${report.corpus.total_claims.toLocaleString("en-US")} claims across ` +
      `${report.corpus.tenants.length} tenant(s), loaded in ` +
      `${(report.corpus.load_elapsed_ms / 1000).toFixed(1)}s`,
  );
  lines.push("");
  for (const record of report.telemetry) {
    lines.push(
      `  ${record.name.padEnd(34)} ${record.outcome.padEnd(10)} ` +
        `${((record.elapsed_ms ?? 0) / 1000).toFixed(2)}s  ` +
        `wal ${record.wal.bytes_generated === null ? "?" : `${(record.wal.bytes_generated / 1_048_576).toFixed(2)}MiB`}  ` +
        `locks ${record.locks_held.map((lock) => lock.mode).join(",") || "none"}  ` +
        `blocked ${record.blocked_sessions_count ?? "?"}`,
    );
  }
  lines.push("");
  for (const operation of report.workload.operations) {
    const d = operation.durations;
    lines.push(
      `  ${operation.operation.padEnd(20)} n=${String(operation.attempts).padStart(5)} ` +
        `ok=${String(operation.successes).padStart(5)} fail=${String(operation.failures).padStart(4)} ` +
        `to=${String(operation.timeouts).padStart(4)} ` +
        `p50=${d.p50_ms === null ? "-" : `${d.p50_ms.toFixed(1)}ms`} ` +
        `p95=${d.p95_ms === null ? "-" : `${d.p95_ms.toFixed(1)}ms`} ` +
        `max=${d.max_ms === null ? "-" : `${d.max_ms.toFixed(1)}ms`} ` +
        `outage=${operation.outage.longest_ms === null ? "-" : `${(operation.outage.longest_ms / 1000).toFixed(1)}s`}`,
    );
    for (const group of operation.errors) {
      lines.push(`      ${group.code} x${group.count}  ${group.sample_message}`);
    }
  }
  lines.push("");
  lines.push(`  tenant boundary  ${report.projection.rls.ok ? "isolated" : "NOT VERIFIED"}`);
  for (const check of report.projection.verification.checks) {
    lines.push(`  ${check.ok ? "ok  " : "FAIL"} ${check.name.padEnd(36)} ${check.count ?? "?"}`);
  }
  for (const entry of report.projection.behaviours) {
    lines.push(`  ${entry.ok ? "ok  " : "FAIL"} ${entry.case}`);
  }
  for (const entry of report.recovery.cases) {
    lines.push(
      `  ${entry.status === "passed" ? "ok  " : entry.status === "failed" ? "FAIL" : "n/a "} ${entry.case}`,
    );
  }
  lines.push("");
  lines.push(`  complete    ${report.complete ? "yes" : "NO"}`);
  for (const reason of report.incompleteness_reasons) lines.push(`    INCOMPLETE ${reason}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** `postgres://user:pw@host/db` with the credentials replaced. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return (
      `${parsed.protocol}//<credentials>@${parsed.hostname}:${parsed.port || "5432"}` +
      `/${parsed.pathname.replace(/^\//, "")}`
    );
  } catch {
    return "postgres://<credentials>@<host>/<database>";
  }
}

function git(input: readonly string[]): string | null {
  try {
    return execFileSync("git", [...input], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Derive the application URL for a database from the owner URL. */
export function appUrlFor(migrationUrl: string): string {
  const parsed = new URL(migrationUrl);
  parsed.username = "veritymem_app";
  parsed.password = "veritymem_app";
  return parsed.toString();
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function sleep(ms: number, log?: (message: string) => void): Promise<void> {
  const step = 15_000;
  let remaining = ms;
  while (remaining > 0) {
    const slice = Math.min(step, remaining);
    await new Promise((resolve) => setTimeout(resolve, slice));
    remaining -= slice;
    if (log !== undefined && remaining > 0) {
      log(`  … ${Math.ceil(remaining / 1000)}s left in this phase`);
    }
  }
}

async function readServerFacts(client: pg.Client): Promise<{
  server_version: string | null;
  pgvector_version: string | null;
  settings: Record<string, string>;
}> {
  const names = [
    "server_version",
    "shared_buffers",
    "work_mem",
    "maintenance_work_mem",
    "effective_cache_size",
    "max_connections",
    "max_parallel_workers",
    "max_parallel_workers_per_gather",
    "max_parallel_maintenance_workers",
    "fsync",
    "synchronous_commit",
    "full_page_writes",
    "wal_level",
    "track_io_timing",
  ];
  const settings: Record<string, string> = {};
  for (const name of names) {
    try {
      const row = await client.query<{ value: string }>("SELECT current_setting($1) AS value", [name]);
      settings[name] = row.rows[0]?.value ?? "";
    } catch {
      settings[name] = "(unavailable)";
    }
  }
  const version = await client.query<{ server_version: string; vector: string | null }>(
    `SELECT current_setting('server_version') AS server_version,
            (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector`,
  );
  return {
    server_version: version.rows[0]?.server_version ?? null,
    pgvector_version: version.rows[0]?.vector ?? null,
    settings,
  };
}

async function readRole(client: pg.Client, role: string): Promise<RoleFact> {
  const result = await client.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
    [role],
  );
  const row = result.rows[0];
  return {
    rolname: row?.rolname ?? null,
    rolsuper: row?.rolsuper ?? null,
    rolbypassrls: row?.rolbypassrls ?? null,
    owns_migrated_tables: null,
  };
}

/** Does `role` own every table the migrations create in `public`? */
async function roleOwnsTables(client: pg.Client, role: string): Promise<boolean> {
  const result = await client.query<{ owned: string; total: string }>(
    `SELECT count(*) FILTER (WHERE pg_get_userbyid(c.relowner) = $1)::text AS owned,
            count(*)::text AS total
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')`,
    [role],
  );
  const row = result.rows[0];
  if (row === undefined) return false;
  const owned = Number(row.owned);
  const total = Number(row.total);
  return total > 0 && owned === total;
}

// ---------------------------------------------------------------------------
// Target preparation
// ---------------------------------------------------------------------------

interface TargetPlan {
  readonly database: string;
  readonly migrationUrl: string;
  readonly mode: "created" | "selected" | "recreated";
  readonly protections: readonly string[];
}

/**
 * Decide the target, then prove it is disposable.
 *
 * When no URL is given, a uniquely named database is created and nothing is dropped. When a
 * URL is given, the name is validated first; a database that already carries this
 * rehearsal's marker is recreated, and one that holds relations without the marker is
 * refused outright rather than dropped.
 */
export async function planTarget(input: {
  readonly adminUrl: string;
  readonly rehearsalUrl: string | null;
  readonly databaseName: string | null;
  readonly protectedNames: readonly string[];
  readonly runId: string;
  readonly log: (message: string) => void;
}): Promise<TargetPlan> {
  if (input.rehearsalUrl !== null) {
    const validated = validateRehearsalTarget({
      url: input.rehearsalUrl,
      protected_names: input.protectedNames,
    });
    const inspection = await inspectTarget(input.adminUrl, validated.database);
    assertSelectableTarget(inspection, validated.database);
    const mode: TargetPlan["mode"] = !inspection.exists
      ? "created"
      : inspection.has_marker
        ? "recreated"
        : "selected";
    input.log(
      `target ${validated.database}: exists=${String(inspection.exists)} ` +
        `marker=${String(inspection.has_marker)} relations=${inspection.foreign_relations.length} -> ${mode}`,
    );
    return {
      database: validated.database,
      migrationUrl: validated.url,
      mode,
      protections: validated.protections,
    };
  }

  const database = input.databaseName ?? rehearsalDatabaseName(new Date(), input.runId);
  const candidate = new URL(input.adminUrl);
  candidate.pathname = `/${database}`;
  const validated = validateRehearsalTarget({
    url: candidate.toString(),
    protected_names: input.protectedNames,
  });
  return {
    database: validated.database,
    migrationUrl: validated.url,
    mode: "created",
    protections: validated.protections,
  };
}

/** Create the database if needed, and mark it as a rehearsal database. */
export async function prepareTarget(input: {
  readonly adminUrl: string;
  readonly database: string;
  readonly migrationUrl: string;
  readonly mode: TargetPlan["mode"];
  readonly log: (message: string) => void;
}): Promise<void> {
  const admin = new pg.Client({ connectionString: input.adminUrl });
  await admin.connect();
  try {
    const existing = await admin.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS present",
      [input.database],
    );
    const present = existing.rows[0]?.present === true;
    if (input.mode === "recreated" && present) {
      input.log(`dropping and recreating rehearsal database ${input.database}`);
      await admin.query(`DROP DATABASE ${input.database} WITH (FORCE)`);
    }
    if (input.mode === "recreated" || !present) {
      await admin.query(`CREATE DATABASE ${input.database}`);
      input.log(`created database ${input.database}`);
    } else {
      input.log(`reusing empty database ${input.database}`);
    }
  } finally {
    await admin.end();
  }

  const owner = new pg.Client({ connectionString: input.migrationUrl });
  await owner.connect();
  try {
    await owner.query("CREATE EXTENSION IF NOT EXISTS vector");
    await owner.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await owner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'veritymem_app') THEN
          CREATE ROLE veritymem_app LOGIN PASSWORD 'veritymem_app'
            NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
        END IF;
      END
      $$;
    `);
    await owner.query(`GRANT CONNECT ON DATABASE ${input.database} TO veritymem_app`);
    await owner.query("GRANT USAGE ON SCHEMA public TO veritymem_app");
    await owner.query(`
      CREATE TABLE IF NOT EXISTS vm_a2_rehearsal (
        label          TEXT NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        report_version TEXT NOT NULL
      )
    `);
    await owner.query("INSERT INTO vm_a2_rehearsal (label, report_version) VALUES ($1, $2)", [
      `created by eval:perf migration-rehearsal at ${new Date().toISOString()}`,
      REHEARSAL_SCHEMA_VERSION,
    ]);
  } finally {
    await owner.end();
  }
}

async function grantApplicationRole(migrationUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    await client.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO veritymem_app",
    );
    await client.query("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO veritymem_app");
    await client.query("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA veritymem TO veritymem_app");
    await client.query("GRANT USAGE ON SCHEMA veritymem TO veritymem_app");
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Probe preflight
// ---------------------------------------------------------------------------

/**
 * Run the probes that must work once 0014 has committed.
 *
 * A retrieval probe that returns nothing has not exercised the operation it claims to
 * measure, and a rehearsal that discovered this at the end would have produced minutes of
 * meaningless percentiles. Each failure names the operation and what it observed.
 *
 * `project_claim` is deliberately absent: it writes into `claim_entities`, which 0015 creates,
 * so before 0015 it *must* fail. That failure is checked on its own, after 0015.
 */
export async function preflightAfter0014(
  dependencies: ProbeDependencies,
  tenant: ProbeTenant,
  log: (message: string) => void,
): Promise<{ readonly entity_error: string | null }> {
  const now = new Date().toISOString();
  const results: Record<string, number | null> = {};
  results["lexical_retrieval"] = await probeLexical(dependencies, tenant, { limit: 12, now });
  results["claim_hydration"] = await probeHydration(dependencies, tenant, { batch: 8 });
  const appended = await probeAppend(dependencies, tenant, {
    stream: `probe:preflight:${tenant.tenantSlug}`,
    content: "I approved the Sunday 02:00 UTC deploy window.",
    occurred_at: now,
  });
  results["append_event"] = appended.rows;

  // The entity channel joins claim_entities, which 0015 creates. Before 0015 it must fail
  // with 42P01; any other outcome, including success, would mean the rehearsal's model of
  // the schema is wrong.
  let entityError: string | null = null;
  try {
    const hits = await probeEntity(dependencies, tenant, { limit: 12, now });
    results["entity_retrieval"] = hits;
    entityError = hits < 1 ? "the entity channel returned no rows before 0015" : null;
  } catch (error) {
    entityError = errorCodeOf(error);
    results["entity_retrieval"] = null;
  }
  log(
    `preflight after 0014: ${Object.entries(results)
      .map(([key, value]) => `${key}=${value === null ? "ran" : value}`)
      .join(" ")} (entity: ${entityError ?? "unexpectedly succeeded"})`,
  );
  for (const operation of ["lexical_retrieval", "claim_hydration"] as const) {
    if ((results[operation] ?? 0) < 1) {
      throw new Error(
        `the ${operation} probe returned ${results[operation] ?? 0} rows on a fully loaded ` +
          `corpus after 0014 committed, so it would measure an operation that does nothing. ` +
          `The rehearsal refuses to report availability for a probe that cannot fail visibly.`,
      );
    }
  }
  return { entity_error: entityError };
}

/** Run the probes that can only work once 0015 has committed. */
export async function preflightAfter0015(
  dependencies: ProbeDependencies,
  tenant: ProbeTenant,
  log: (message: string) => void,
): Promise<void> {
  const now = new Date().toISOString();
  const entity = await probeEntity(dependencies, tenant, { limit: 12, now });
  const projected = await writePostMigrationClaims({
    dependencies,
    tenant,
    count: 1,
    actorPrefix: "user:rehearsal-preflight",
    log: () => undefined,
  });
  log(`preflight after 0015: entity_retrieval=${entity} projected_claim_events=${projected.length}`);
  if (entity < 1) {
    throw new Error(
      `the entity_retrieval probe returned ${entity} rows after 0015 committed, so the entity ` +
        `channel is not actually reading the projection this rehearsal exists to verify`,
    );
  }
}

/** Pick a query text the tenant's own data actually matches, or refuse to run. */
async function resolveQueryText(input: {
  readonly appDb: Db;
  readonly probe: ProbeTenant;
  readonly candidates: readonly string[];
}): Promise<string> {
  for (const text of input.candidates) {
    const hits = await input.appDb.withRequest(
      {
        tenant: input.probe.tenantId,
        principal: input.probe.principal,
        scopeIds: input.probe.scopes.map((scope) => scope.scope_id),
        purposes: [...input.probe.purposes],
        action: "rehearsal:vocabulary",
      },
      async (executor) =>
        (
          await lexicalChannel(
            executor,
            channelQueryFor(input.probe, text, 12, new Date().toISOString()),
          )
        ).hits.length,
      { readOnly: true },
    );
    if (hits > 0) return text;
  }
  throw new Error(
    `none of the ${input.candidates.length} candidate query texts matched a claim for tenant ` +
      `${input.probe.tenantId}; the lexical probe would have nothing to measure`,
  );
}

/** Choose a query text the tenant's data actually matches, now that the channels can run. */
async function resolveProbeVocabulary(
  appDb: Db,
  probeTenants: readonly ProbeTenant[],
  owner: pg.Client,
): Promise<ProbeTenant[]> {
  const resolved: ProbeTenant[] = [];
  for (const probe of probeTenants) {
    const sample = await owner.query<{ object: string | null; subject: string }>(
      `SELECT CASE WHEN jsonb_typeof(object) = 'string' THEN object #>> '{}' ELSE NULL END AS object,
              subject
         FROM claims
        WHERE tenant_id = $1::uuid AND status = 'accepted'
        ORDER BY claim_id
        LIMIT 40`,
      [probe.tenantId],
    );
    const candidates = [
      ...new Set(sample.rows.map((row) => row.object).filter((v): v is string => v !== null)),
    ];
    const queryText = await resolveQueryText({
      appDb,
      probe,
      candidates: candidates.length > 0 ? candidates : [sample.rows[0]?.subject ?? probe.queryText],
    });
    resolved.push({ ...probe, queryText });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// The rehearsal
// ---------------------------------------------------------------------------

export interface RehearsalOutcome {
  readonly report: RehearsalReport;
  readonly output: string;
  readonly summary: string;
}

export async function runRehearsal(options: RehearsalOptions): Promise<RehearsalOutcome> {
  const log = options.log;
  const env = loadEnv();
  const adminUrl = env.migrationDatabaseUrl ?? env.databaseUrl;
  const migrationsDir = options.migrations_dir;
  if (!existsSync(migrationsDir)) {
    throw new Error(`the migrations directory does not exist: ${migrationsDir}`);
  }
  const protectedNames = [env.databaseUrl, env.migrationDatabaseUrl]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => new URL(value).pathname.replace(/^\//, ""));

  const runId = randomBytes(3).toString("hex");
  const target = await planTarget({
    adminUrl,
    rehearsalUrl: options.rehearsal_url,
    databaseName: options.database_name,
    protectedNames,
    runId,
    log,
  });
  log(`target      ${target.database} (${target.mode})`);
  for (const protection of target.protections) log(`  protection ${protection}`);
  await prepareTarget({
    adminUrl,
    database: target.database,
    migrationUrl: target.migrationUrl,
    mode: target.mode,
    log,
  });

  const migrationUrl = target.migrationUrl;
  const appUrl = appUrlFor(migrationUrl);
  const telemetryClient = new pg.Client({
    connectionString: migrationUrl,
    application_name: "veritymem-rehearsal-telemetry",
  });
  await telemetryClient.connect();

  let openAppDb: Db | null = null;
  let workload: WorkloadHandle | null = null;
  try {
    // ---- 2. migrate through 0013 only -----------------------------------
    const corpusMigration = await runMigrations({
      connectionString: migrationUrl,
      dir: migrationsDir,
      until: CORPUS_MIGRATION,
      log: (message) => log(`  ${message}`),
    });
    log(
      `migrated through ${CORPUS_MIGRATION}: applied ${corpusMigration.applied.length}, ` +
        `already applied ${corpusMigration.skipped.length}`,
    );
    const sizeBefore = await telemetryClient.query<{ bytes: string }>(
      "SELECT pg_database_size(current_database())::text AS bytes",
    );

    const hashes = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => ({ name, sha256: sha256File(resolve(migrationsDir, name)) }));

    await grantApplicationRole(migrationUrl);

    // ---- 3. the corpus ---------------------------------------------------
    const embeddings = new HashEmbeddingBackend({
      dimensions: env.embedding.dimensions,
      modelId: env.embedding.modelId,
    });
    const anchor = new Date(options.anchor);
    if (Number.isNaN(anchor.getTime())) throw new Error(`--anchor is not a timestamp: ${options.anchor}`);
    const corpusTenants: {
      readonly slug: string;
      readonly tenantId: string;
      readonly counts: Record<string, number>;
    }[] = [];
    const loadStarted = Date.now();
    for (let index = 0; index < options.tenants; index += 1) {
      const slug = `rehearsal-${runId}-t${index}`;
      const tenantId = resolveTenantId(slug);
      log(`loading corpus for ${slug} (${options.claims_per_tenant} claims)`);
      const loaded = await loadCorpus({
        migrationUrl,
        tenantId,
        tenantSlug: slug,
        claims: options.claims_per_tenant,
        corpusSeed: options.corpus_seed,
        anchor,
        embeddingModelId: embeddings.model_id,
        embeddingDimensions: embeddings.dimensions,
        statePath: resolve(".veritymem/perf", `${slug}.load-state.json`),
        indexStrategy: "maintain",
        stopAfterPhase: "aliases",
        onProgress: (progress) => {
          if (progress.done >= progress.total) log(`  ${progress.phase.padEnd(16)} ${progress.total}`);
        },
      });
      await syncStreams(migrationUrl, tenantId);
      const counts: Record<string, number> = {};
      for (const count of loaded.counts) counts[count.table] = count.rows;
      corpusTenants.push({ slug, tenantId, counts });
    }
    const loadElapsed = Date.now() - loadStarted;

    // ---- 4. the application role and the write path ----------------------
    const appDb = new Db({
      connectionString: appUrl,
      max: options.read_concurrency + 2 * options.write_concurrency + 8,
      applicationName: "veritymem-rehearsal-app",
      statementTimeoutMs: options.statement_timeout_ms,
      lockTimeoutMs: options.lock_timeout_ms,
    });
    openAppDb = appDb;
    const ledger = new Ledger({
      db: appDb,
      blobs: new FilesystemBlobStore(resolve(".veritymem/blobs")),
      clock: systemClock,
      ids: systemIds,
    });
    const gate = new CommitGate({
      db: appDb,
      ledger,
      ids: systemIds,
      clock: systemClock,
      entailment: new LexicalEntailmentBackend({
        floor: DEFAULT_COMMIT_POLICY.thresholds.lexicalEntailmentFloor,
      }),
      policy: DEFAULT_COMMIT_POLICY,
    });
    const pipeline = new IngestPipeline({
      db: appDb,
      ledger,
      gate,
      ids: systemIds,
      clock: systemClock,
      deterministicExtractors: DETERMINISTIC_EXTRACTORS,
      modelExtractor: null,
    });
    const projections: ProjectionDependencies = { db: appDb, embeddings };
    const dependencies: ProbeDependencies = { db: appDb, ledger, pipeline, projections };
    const probeTenants = await buildProbeTenants({
      owner: telemetryClient,
      corpusTenants,
      log,
    });

    // ---- 5. workload -----------------------------------------------------
    const recorder = new WorkloadRecorder();
    let phase: WorkloadPhase = "pre_migration";
    workload = startWorkload(dependencies, probeTenants, recorder, {
      read_concurrency: options.read_concurrency,
      write_concurrency: options.write_concurrency,
      probe_timeout_ms: Math.max(
        2_000,
        options.statement_timeout_ms + options.lock_timeout_ms + 1_000,
      ),
      limit: 12,
      hydration_batch: 8,
      now: () => new Date().toISOString(),
      phase: () => phase,
      log,
    });
    const activeWorkload = workload;
    const setPhase = (next: WorkloadPhase): void => {
      const at = Date.now();
      recorder.closeAllPhases(at);
      phase = next;
      recorder.openPhase(next, at);
      log(`phase       ${next}`);
    };

    const workloadStarted = Date.now();
    const compatibility: CompatibilityPhase[] = [];
    const recordCompatibility = (name: WorkloadPhase, schema: string): void => {
      const stats = recorder.phaseSnapshot(name, {
        started_at_ms: workloadStarted,
        ended_at_ms: Date.now(),
      });
      if (stats === null) return;
      compatibility.push({
        phase: name,
        schema,
        operations: stats.operations.map((operation) => ({
          operation: operation.operation,
          attempts: operation.attempts,
          successes: operation.successes,
          error_codes: [...new Set(operation.errors.map((group) => group.code))].sort(),
        })),
      });
    };

    setPhase("pre_migration");
    log(
      "NOTE the probes run against the 0013 schema in this phase. The current retrieval read " +
        "path calls veritymem.current_reachable_scope_ids(), which 0014 creates, so every read " +
        "probe is expected to fail here with SQLSTATE 42883. That is a finding about the " +
        "rollout order, and it is recorded rather than hidden.",
    );
    await sleep(Math.max(2, Math.min(10, Math.round(options.duration_seconds * 0.12))) * 1_000, log);
    recordCompatibility("pre_migration", "through 0013");

    // ---- 6. 0014, under load --------------------------------------------
    setPhase("migration_0014");
    const run0014 = await runInstrumentedMigrations({
      migrationUrl,
      migrationsDir,
      until: FIRST_MEASURED_MIGRATION,
      applicationName: MIGRATION_APPLICATION_NAME,
      lockTimeoutMs: options.lock_timeout_ms,
      telemetryClient,
      sampleIntervalMs: options.sample_interval_ms,
      blockedThresholdMs: options.blocked_threshold_ms,
      log: (message) => log(`  ${message}`),
      onBeforeApply: ({ name, backend_pid }) => {
        log(`applying ${name} while the workload runs (backend ${backend_pid})`);
      },
    });
    if (run0014.error !== null) {
      throw new Error(`${FIRST_MEASURED_MIGRATION} failed: ${run0014.error.message}`);
    }
    recordCompatibility("migration_0014", "0014 applying inside its transaction");

    // ---- 6b. settled state after 0014 -----------------------------------
    const resolved = await resolveProbeVocabulary(appDb, probeTenants, telemetryClient);
    // The workload holds the array, so the resolved tenants replace the provisional ones in
    // place rather than being handed over as a second list it would never look at.
    resolved.forEach((tenant, index) => {
      probeTenants[index] = tenant;
    });
    setPhase("post_0014");
    await sleep(Math.max(2, Math.min(10, Math.round(options.duration_seconds * 0.08))) * 1_000, log);
    recordCompatibility("post_0014", "through 0014");
    for (const tenant of probeTenants) await preflightAfter0014(dependencies, tenant, log);

    // ---- 7. the two failing 0015 attempts, paused, then the real one -----
    await activeWorkload.pause(true);
    setPhase("recovery");
    let migration0015AppliedAt: string | null = null;
    const recovery = await runRecoveryCases({
      migrationUrl,
      database: target.database,
      migrationsDir,
      telemetryClient,
      sampleIntervalMs: options.sample_interval_ms,
      blockedThresholdMs: options.blocked_threshold_ms,
      until: FINAL_MIGRATION,
      lockTimeoutMs: options.lock_timeout_ms,
      observationTimeoutMs: options.observation_timeout_ms,
      log,
      onSuccessfulApply: async () => {
        migration0015AppliedAt = new Date().toISOString();
        setPhase("migration_0015");
        await activeWorkload.pause(false);
      },
      verifyProjection: async () => (await verifyProjection(telemetryClient, { writtenAfter: null })).observed,
    });
    const successful = recovery.applied_0015;
    const telemetry0015 =
      successful?.telemetry.find((record) => record.name === FINAL_MIGRATION) ?? null;
    if (successful === null || successful.error !== null || telemetry0015 === null) {
      throw new Error(
        `the successful application of ${FINAL_MIGRATION} did not happen: ` +
          `${successful?.error?.message ?? "no run was performed"}`,
      );
    }

    recordCompatibility("migration_0015", "0015 applying inside its transaction");

    // ---- 8. post-migration availability ---------------------------------
    setPhase("post_migration");
    const pausedMs = recovery.cases
      .filter(
        (entry) =>
          entry.case.startsWith("lock_timeout") || entry.case.startsWith("interrupted"),
      )
      .reduce((sum, entry) => sum + (entry.elapsed_ms ?? 0), 0);
    const remaining = Math.max(3_000, options.duration_seconds * 1_000 - (Date.now() - workloadStarted - pausedMs));
    log(`post-migration probe window: ${Math.round(remaining / 1000)}s`);
    await sleep(remaining, log);

    await activeWorkload.stop();
    workload = null;
    recorder.closeAllPhases(Date.now());
    recordCompatibility("post_migration", "through 0015");
    for (const tenant of probeTenants) await preflightAfter0015(dependencies, tenant, log);
    const workloadStats = recorder.snapshot({
      started_at_ms: workloadStarted,
      ended_at_ms: Date.now(),
    });

    // ---- 9. deterministic post-migration writes, then verification --------
    //
    // The workload's write probe records one approval at a time under one identity, so the
    // gate's duplicate handling keeps a single current accepted claim per key. The behaviour
    // checks need claims that are *distinct* and known to be accepted, so three are written
    // here with three identities — through the same append, ingest and projection path the
    // probe uses. They are written after 0015 committed, so they can only have been projected
    // incrementally: 0015's backfill never saw them.
    const incremental = await writePostMigrationClaims({
      dependencies,
      tenant: probeTenants[0]!,
      count: 3,
      log,
    });
    if (incremental.length < 3) {
      throw new Error("fewer post-migration claims were written than the behaviour checks need");
    }
    const verification = await verifyProjection(telemetryClient, {
      writtenAfter: migration0015AppliedAt,
    });
    const residue = await measureResidue(telemetryClient);
    const probeClaims = await claimsWrittenByProbe(
      telemetryClient,
      corpusTenants,
      migration0015AppliedAt,
    );
    const behaviours = await verifyProjectionBehaviours(appDb, telemetryClient, {
      tenants: probeTenants,
      claims: probeClaims,
      decisions: async (tenantId, claimId, status) => {
        await transitionStatus(
          appDb,
          tenantId,
          { decisionId: systemIds.next("dec"), reasonCodes: ["rehearsal_status_change"] },
          claimId,
          status,
        );
      },
      reproject: (tenantId, claimId) =>
        appDb.withSystemContext({ tenant: tenantId, actor: "rehearsal:verify" }, (executor) =>
          projectClaim(executor, projections, claimId),
        ),
      limit: 12,
      now: new Date().toISOString(),
    });
    const rls =
      probeTenants.length >= 2
        ? await verifyProjectionIsolation(appDb, {
            tenantA: probeTenants[0]!,
            tenantB: probeTenants[1]!,
            limit: 12,
            now: new Date().toISOString(),
          })
        : {
            statement: "not run",
            tenant_a: probeTenants[0]?.tenantSlug ?? "",
            tenant_b: "",
            owner_rows_a: null,
            owner_rows_b: null,
            app_visible_rows_a: null,
            app_visible_rows_b_from_a: null,
            app_visible_claims_b_from_a: null,
            ok: false,
            note: "the tenant-boundary check needs two tenants; run with --tenants 2 or more",
          };

    const history = await readHistory(telemetryClient);
    const facts = await readServerFacts(telemetryClient);
    const ownerName = await telemetryClient.query<{ current_user: string }>(
      "SELECT current_user",
    );
    const migrationRoleName = ownerName.rows[0]?.current_user ?? "";
    const migrationRole = await readRole(telemetryClient, migrationRoleName);
    const appRole = await readRole(telemetryClient, "veritymem_app");
    const owns = await roleOwnsTables(telemetryClient, migrationRoleName);
    const sizeAfter = await telemetryClient.query<{ bytes: string }>(
      "SELECT pg_database_size(current_database())::text AS bytes",
    );

    const telemetry: readonly MigrationTelemetry[] = [...run0014.telemetry, telemetry0015];
    const measurements = buildMeasurements({
      measured: telemetry,
      workload: workloadStats,
      verification,
      rls,
      behaviours,
      recovery: recovery.cases,
      history,
    });

    const draft: RehearsalReport = {
      report_version: REHEARSAL_SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      git: {
        commit: git(["rev-parse", "HEAD"]),
        branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
        dirty: git(["status", "--porcelain"]) === null ? null : git(["status", "--porcelain"]) !== "",
      },
      postgres: facts,
      migrations: {
        dir: migrationsDir,
        applied_through_0013: corpusMigration.applied,
        hashes,
      },
      environment: {
        profile: options.profile,
        profile_note: REHEARSAL_PROFILES[options.profile].note,
        parameters: {
          claims_per_tenant: options.claims_per_tenant,
          tenants: options.tenants,
          read_concurrency: options.read_concurrency,
          write_concurrency: options.write_concurrency,
          duration_seconds: options.duration_seconds,
          statement_timeout_ms: options.statement_timeout_ms,
          lock_timeout_ms: options.lock_timeout_ms,
          sample_interval_ms: options.sample_interval_ms,
          blocked_threshold_ms: options.blocked_threshold_ms,
          observation_timeout_ms: options.observation_timeout_ms,
          corpus_seed: options.corpus_seed,
          anchor: options.anchor,
        },
      },
      target: {
        database: target.database,
        mode: target.mode,
        url_redacted: redactUrl(migrationUrl),
        protections: target.protections,
        size_before_bytes: sizeBefore.rows[0] === undefined ? null : Number(sizeBefore.rows[0].bytes),
        size_after_bytes: sizeAfter.rows[0] === undefined ? null : Number(sizeAfter.rows[0].bytes),
      },
      roles: {
        migration: { ...migrationRole, owns_migrated_tables: owns },
        app: appRole,
        statement: ROLES_STATEMENT,
      },
      corpus: {
        seed: options.corpus_seed,
        anchor: options.anchor,
        claims_per_tenant: options.claims_per_tenant,
        tenants: corpusTenants.map((tenant) => ({
          slug: tenant.slug,
          tenant_id: tenant.tenantId,
          counts: tenant.counts,
        })),
        total_claims: corpusTenants.reduce((sum, tenant) => sum + (tenant.counts["claims"] ?? 0), 0),
        load_elapsed_ms: loadElapsed,
      },
      telemetry,
      workload: workloadStats,
      projection: {
        invariants: PROJECTION_INVARIANTS,
        verification,
        residue,
        behaviours,
        rls,
      },
      recovery: {
        cases: recovery.cases,
        objects_after_lock_timeout: recovery.objects_after_lock_timeout,
        objects_after_interruption: recovery.objects_after_interruption,
        objects_final: recovery.objects_final,
        history,
      },
      compatibility,
      findings: deriveFindings(compatibility),
      measurements,
      limitations: LIMITATIONS,
      complete: false,
      incompleteness_reasons: [],
    };

    const verdict = assessRehearsal(draft);
    const report: RehearsalReport = {
      ...draft,
      complete: verdict.complete,
      incompleteness_reasons: verdict.reasons,
    };
    assertJsonSafe(report);

    const outputPath = resolve(options.output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { report, output: outputPath, summary: renderRehearsal(report) };
  } finally {
    // The workload is stopped before the pool is closed, and both are bounded. An
    // earlier version of this function let a failure escape while the probe loops were
    // still running, and `pool.end()` — which waits for every checked-out client to be
    // returned — never resolved. A rehearsal that cannot fail is worse than one that
    // fails loudly, so cleanup gets a deadline.
    if (workload !== null) {
      await Promise.race([
        (workload as WorkloadHandle).stop(),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]).catch(() => undefined);
    }
    if (openAppDb !== null) {
      await Promise.race([
        (openAppDb as Db).close(),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]).catch(() => undefined);
    }
    await telemetryClient.end().catch(() => undefined);
  }
}

/**
 * Write `count` claims through the real write path, after the migrations, and require each to
 * be projected.
 *
 * Distinct acting identities are what make them distinct claims: the commit gate compares
 * subject and predicate to detect duplicates and contradictions, so three approvals by three
 * identities are three current accepted claims rather than one that supersedes the others.
 * A run that produced fewer projected claims than asked for is a failure, not a warning —
 * "incremental projection still works" is not a claim that can be made from zero examples.
 */
async function writePostMigrationClaims(input: {
  readonly dependencies: ProbeDependencies;
  readonly tenant: ProbeTenant;
  readonly count: number;
  readonly actorPrefix?: string;
  readonly log: (message: string) => void;
}): Promise<readonly string[]> {
  const prefix = input.actorPrefix ?? "user:rehearsal-writer";
  const written: string[] = [];
  for (let index = 0; index < input.count; index += 1) {
    const actor = `${prefix}-${index}`;
    const occurredAt = new Date().toISOString();
    const appended = await probeAppend(input.dependencies, input.tenant, {
      stream: `probe:post-migration:${index}:${input.tenant.tenantSlug}`,
      content: `I approved the ${["Sunday", "Monday", "Tuesday", "Wednesday"][index % 4]} 02:00 UTC deploy window for rehearsal writer ${index}.`,
      occurred_at: occurredAt,
      actor,
    });
    const projected = await probeProject(input.dependencies, input.tenant, {
      event_id: appended.event_id,
      scope_id: appended.scope_id,
    });
    if (projected < 1) {
      throw new Error(
        `the post-migration write for actor ${actor} produced ${projected} projected claim(s). ` +
          `Incremental projection cannot be verified without at least one, and reporting it as ` +
          `verified from zero examples would be false.`,
      );
    }
    written.push(appended.event_id);
  }
  input.log(
    `post-migration writes: ${written.length} event(s) appended, ingested and projected as ` +
      `distinct identities`,
  );
  return written;
}

/**
 * The claims the probe wrote, so the behaviour checks can mutate them instead of the corpus.
 *
 * Chosen from claims recorded after 0015 committed, which is also the set that proves
 * incremental projection works: they could not have been reached by 0015's backfill.
 */
async function claimsWrittenByProbe(
  owner: pg.Client,
  tenants: readonly { readonly tenantId: string }[],
  writtenAfter: string | null,
): Promise<readonly { readonly claimId: string; readonly tenantId: string }[]> {
  if (writtenAfter === null) return [];
  const result = await owner.query<{ claim_id: string; tenant_id: string }>(
    `SELECT claim_id, tenant_id FROM claims
      WHERE tenant_id = ANY($1::uuid[])
        AND recorded_at >= $2::timestamptz
        AND status = 'accepted'
      ORDER BY recorded_at
      LIMIT 6`,
    [tenants.map((tenant) => tenant.tenantId), writtenAfter],
  );
  return result.rows.map((row) => ({ claimId: row.claim_id, tenantId: row.tenant_id }));
}

/**
 * Build the probe tenant for each corpus tenant.
 *
 * The query text is provisional here. Resolving it means running the lexical channel, and the
 * lexical channel needs 0014, so the real text is chosen once 0014 has committed — see
 * `resolveProbeVocabulary`. Starting the workload before that is deliberate: the pre-0014
 * phase is where the read path's dependency on 0014 gets measured.
 */
async function buildProbeTenants(input: {
  readonly owner: pg.Client;
  readonly corpusTenants: readonly {
    readonly slug: string;
    readonly tenantId: string;
    readonly counts: Record<string, number>;
  }[];
  readonly log: (message: string) => void;
}): Promise<ProbeTenant[]> {
  const out: ProbeTenant[] = [];
  for (const corpus of input.corpusTenants) {
    const scope = await input.owner.query<{
      scope_id: string;
      project: string | null;
      user_id: string | null;
      agent_id: string | null;
      session_id: string | null;
      purpose: string[];
    }>(
      `SELECT scope_id, project, user_id, agent_id, session_id, purpose
         FROM scopes
        WHERE tenant_id = $1::uuid AND project IS NOT NULL AND user_id IS NULL
        LIMIT 1`,
      [corpus.tenantId],
    );
    const row = scope.rows[0];
    if (row === undefined) throw new Error(`no project scope exists for tenant ${corpus.slug}`);

    const sample = await input.owner.query<{
      claim_id: string;
      subject: string;
      object: string | null;
    }>(
      `SELECT claim_id, subject,
              CASE WHEN jsonb_typeof(object) = 'string' THEN object #>> '{}' ELSE NULL END AS object
         FROM claims
        WHERE tenant_id = $1::uuid AND status = 'accepted'
        ORDER BY claim_id
        LIMIT 40`,
      [corpus.tenantId],
    );
    const first = sample.rows[0];
    if (first === undefined) throw new Error(`tenant ${corpus.slug} holds no accepted claim`);
    const candidates = [
      ...new Set(sample.rows.map((entry) => entry.object).filter((v): v is string => v !== null)),
    ];

    const base: ProbeTenant = {
      tenantSlug: corpus.slug,
      tenantId: corpus.tenantId,
      principal: "agent:perf-bench-runner",
      scopes: [
        {
          scope_id: row.scope_id,
          project: row.project,
          user_id: row.user_id,
          agent_id: row.agent_id,
          session_id: row.session_id,
        },
      ],
      purposes: row.purpose.length > 0 ? row.purpose : ["release_planning"],
      queryText: candidates[0] ?? first.subject,
      entityTerms: [first.subject.trim().toLowerCase()],
      claimIds: sample.rows.map((entry) => entry.claim_id),
    };
    out.push({ ...base, queryText: candidates[0] ?? first.subject });
  }
  return out;
}

/**
 * Turn the compatibility observations into findings.
 *
 * Each candidate finding names the phase, the operation and the SQLSTATEs that would
 * establish it, so a finding appears only when the run recorded that evidence. A run that did
 * not observe the dependency produces no finding, which is the only honest way to write a
 * conclusion into a report.
 */
const FINDING_RULES: readonly {
  readonly id: string;
  readonly phases: readonly WorkloadPhase[];
  readonly operation: string;
  readonly codes: readonly string[];
  readonly statement: string;
}[] = [
  {
    id: "read_path_requires_0014",
    phases: ["pre_migration", "migration_0014"],
    operation: "lexical_retrieval",
    codes: ["42883"],
    statement:
      "The lexical retrieval channel calls veritymem.current_reachable_scope_ids(), which " +
      "migration 0014 creates. Against a 0013 schema, and for as long as 0014's transaction is " +
      "open, lexical retrieval fails with SQLSTATE 42883 (undefined_function). A rollout must " +
      "therefore apply 0014 before the application version that calls it serves reads, or " +
      "accept a read outage for exactly the length of 0014.",
  },
  {
    id: "entity_channel_requires_0015",
    phases: ["pre_migration", "migration_0014", "post_0014", "migration_0015"],
    operation: "entity_retrieval",
    codes: ["42P01"],
    statement:
      "The entity retrieval channel joins claim_entities, which migration 0015 creates inside " +
      "its own transaction. Entity retrieval fails with SQLSTATE 42P01 (undefined_table) from " +
      "the moment a database is at 0013 until 0015 commits — that is, for the whole of both " +
      "migrations. Callers that fuse channel results must treat the entity channel as " +
      "unavailable rather than empty for that window.",
  },
  {
    id: "projection_exposed_to_function_replacement",
    phases: ["migration_0014"],
    operation: "project_claim",
    codes: ["42601", "42501"],
    statement:
      "The write path is exposed to the same function replacement as the read path: " +
      "projection attempts fail with 42501 while 0014 swaps the row-level-security predicate " +
      "under them.",
  },
  {
    id: "projection_requires_0015",
    phases: ["pre_migration", "migration_0014", "post_0014", "migration_0015"],
    operation: "project_claim",
    codes: ["42P01"],
    statement:
      "The projection write path inserts into claim_entities, which migration 0015 creates " +
      "inside its own transaction. Until 0015 commits the table is not visible to any other " +
      "session, so projection attempts fail with SQLSTATE 42P01 (undefined_table) rather than " +
      "waiting on a lock. A deployment must expect projection failures for the whole of 0015 " +
      "and retry them, and must not read them as lock contention.",
  },
  {
    id: "function_replacement_disrupts_active_callers",
    phases: ["migration_0014"],
    operation: "claim_hydration",
    codes: ["42601", "42501"],
    statement:
      "Migration 0014 replaces veritymem.set_request_context, veritymem.scope_reachable and " +
      "veritymem.row_authorized with CREATE OR REPLACE FUNCTION while other sessions are " +
      "calling them. A session that is mid-call when the replacement commits can fail with " +
      "SQLSTATE 42601 (syntax error, raised against the function's own body) or 42501 (a " +
      "row-level-security check evaluating against a request context that is no longer fully " +
      "bound). Both were observed only during the 0014 window. This makes 0014 an *offline* " +
      "migration for the read path: the new function is not merely required before the new " +
      "application version (see read_path_requires_0014), it also makes the old one fail " +
      "intermittently while it is being swapped.",
  },
  {
    id: "projection_blocked_by_0015_lock",
    phases: ["migration_0015"],
    operation: "project_claim",
    codes: ["55P03", "57014"],
    statement:
      "While 0015 builds its primary key it holds ACCESS EXCLUSIVE on claim_entities, so a " +
      "projection write waits, and under a lock_timeout it fails with SQLSTATE 55P03 " +
      "(lock_not_available). The measured blocked-session figures in this report are the " +
      "duration of exactly that wait.",
  },
];

export function deriveFindings(compatibility: readonly CompatibilityPhase[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const rule of FINDING_RULES) {
    const hits: string[] = [];
    for (const phase of rule.phases) {
      const entry = compatibility
        .find((candidate) => candidate.phase === phase)
        ?.operations.find((candidate) => candidate.operation === rule.operation);
      if (entry === undefined) continue;
      const matched = entry.error_codes.filter((code) => rule.codes.includes(code));
      if (matched.length === 0) continue;
      const failures = entry.attempts - entry.successes;
      hits.push(`${phase}: ${failures} failure(s), SQLSTATE ${matched.join("/")}`);
    }
    if (hits.length === 0) continue;
    findings.push({
      id: rule.id,
      statement: rule.statement,
      evidence: `${rule.operation} — ${hits.join("; ")}`,
    });
  }
  return findings;
}

/** The measurements the report claims to have taken, and the ones it does not. */
function buildMeasurements(input: {
  readonly measured: readonly MigrationTelemetry[];
  readonly workload: WorkloadStats;
  readonly verification: ProjectionVerification;
  readonly rls: RlsCheck;
  readonly behaviours: readonly BehaviourCase[];
  readonly recovery: readonly RecoveryCase[];
  readonly history: readonly MigrationHistoryRow[];
}): readonly MeasurementNote[] {
  const notes: MeasurementNote[] = [];
  for (const record of input.measured) {
    notes.push(noteFor(`${record.name}.elapsed_ms`, record.elapsed_ms, "the migration never started"));
    notes.push(
      noteFor(
        `${record.name}.wal_bytes`,
        record.wal.bytes_generated,
        record.wal.error ?? "no WAL reading was taken",
      ),
    );
    notes.push(
      noteFor(
        `${record.name}.database_size`,
        record.database_size.before_bytes === null || record.database_size.after_bytes === null
          ? null
          : record.database_size.delta_bytes,
        "pg_database_size could not be read on both sides of the migration",
      ),
    );
    notes.push(
      noteFor(
        `${record.name}.lock_samples`,
        record.sampling !== null && record.sampling.samples > 0 ? record.sampling.samples : null,
        "the lock sampler produced no sample",
      ),
    );
    notes.push(
      noteFor(
        `${record.name}.temporary_files`,
        record.temporary_files.files_before === null || record.temporary_files.files_after === null
          ? null
          : record.temporary_files.files_after - record.temporary_files.files_before,
        "pg_stat_database did not report temporary-file counters",
      ),
    );
    if (record.claim_entities.present_after) {
      notes.push(
        noteFor(
          `${record.name}.claim_entities_sizes`,
          record.claim_entities.total_bytes_after,
          "the projection table exists but its size could not be read",
        ),
      );
      notes.push(
        noteFor(
          `${record.name}.rows_backfilled`,
          record.claim_entities.rows_backfilled,
          "the projection table exists but its row count could not be read",
        ),
      );
    } else {
      notes.push(
        notApplicable(
          `${record.name}.claim_entities_sizes`,
          "claim_entities is created by 0015, so it does not exist during 0014",
        ),
      );
      notes.push(
        notApplicable(
          `${record.name}.rows_backfilled`,
          "0014 backfills nothing; the entity projection is created by 0015",
        ),
      );
    }
  }

  notes.push(
    noteFor(
      "workload.samples",
      input.workload.total_samples > 0 ? input.workload.total_samples : null,
      "the workload recorded no sample",
    ),
  );
  for (const operation of PROBE_OPERATIONS) {
    const stats = input.workload.operations.find((entry) => entry.operation === operation);
    notes.push(
      noteFor(
        `workload.${operation}.attempts`,
        stats !== undefined && stats.attempts > 0 ? stats.attempts : null,
        "the operation was never attempted",
      ),
    );
    notes.push(
      noteFor(
        `workload.${operation}.p50`,
        stats !== undefined && stats.successes > 0 ? stats.durations.p50_ms : null,
        "no successful attempt was recorded for this operation",
      ),
    );
  }
  notes.push(
    input.workload.samples_from_non_probe === 0
      ? measured("workload.samples_from_non_probe", "every workload sample is tagged probe")
      : missing(
          "workload.samples_from_non_probe",
          `${input.workload.samples_from_non_probe} sample(s) did not come from a probe`,
        ),
  );

  for (const check of input.verification.checks) {
    notes.push(
      noteFor(
        `projection.${check.name}`,
        check.count === null ? null : check.count,
        "the invariant count could not be read",
      ),
    );
  }
  notes.push(
    input.rls.ok
      ? measured("projection.rls", "the tenant-boundary check ran and passed")
      : missing("projection.rls", `the tenant-boundary check did not pass: ${input.rls.note}`),
  );
  notes.push(
    input.behaviours.length > 0
      ? measured("projection.behaviours", `${input.behaviours.length} behaviour case(s) ran`)
      : missing("projection.behaviours", "no projection-behaviour case ran"),
  );

  for (const entry of input.recovery) {
    notes.push(
      entry.status === "passed"
        ? measured(`recovery.${entry.case}`, entry.detail)
        : missing(`recovery.${entry.case}`, `${entry.status}: ${entry.detail}`),
    );
  }
  notes.push(
    noteFor(
      "recovery.history",
      input.history.length > 0 ? input.history.length : null,
      "the migration history is empty",
    ),
  );
  return notes;
}
