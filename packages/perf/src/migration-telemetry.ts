/**
 * What the server was doing while a migration ran.
 *
 * ## Why every number here is sampled rather than inferred
 *
 * A migration's cost to a running system is not the time the `ALTER TABLE` took. It is the
 * time other sessions spent waiting behind a lock the migration held, and PostgreSQL does
 * not publish "milliseconds spent waiting for a lock" as a counter an observer can read
 * afterwards. `pg_stat_activity` reports only the *current* wait event; `pg_locks` reports
 * only the locks that exist right now.
 *
 * So this module samples both, from its own connection, for as long as the migration is in
 * flight, and reports what it saw together with the sampling interval. Every derived figure
 * is labelled as a sampled lower bound rather than presented as an exact total, because a
 * lock wait that begins and ends between two samples is invisible here — and a report that
 * hid that would be claiming a precision it does not have.
 *
 * One case is measured exactly: when a migration fails with `lock_timeout`, the wait it
 * experienced is the configured timeout, and the failure's own elapsed time is the wait.
 */
import pg from "pg";
import { walLsnDelta, type WalDelta } from "./rehearsal-metrics.ts";

/**
 * The part of a PostgreSQL client this module needs.
 *
 * Named as a structural type rather than `pg.Client` so the summarisation and the sampling
 * can be tested against a scripted client, without a server and without a cast.
 */
export interface TelemetryQueryClient {
  query<R extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/** A read-only view of the server, taken at one instant. */
export interface ServerSnapshot {
  readonly at: string;
  readonly lsn: string | null;
  readonly database_size_bytes: number | null;
  readonly temp_files: number | null;
  readonly temp_bytes: number | null;
  readonly claim_entities_present: boolean;
  readonly claim_entities_total_bytes: number | null;
  readonly claim_entities_index_bytes: number | null;
  readonly claim_entities_rows: number | null;
  readonly schema_migrations_rows: number | null;
  /** Non-null when the snapshot could not be taken at all. */
  readonly error: string | null;
}

/** A null-tolerant bigint read: `pg` may hand back a string or a number. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Read the server's size, WAL position, temporary-file counters and projection footprint.
 *
 * The `claim_entities` reads are separate statements rather than part of the first one,
 * because before 0015 the table does not exist and a single statement naming it would fail
 * as a whole — losing the WAL position that 0015's own telemetry needs. `present: false`
 * is a fact about the schema, not a failed measurement.
 */
export async function takeServerSnapshot(
  client: TelemetryQueryClient,
  label: string,
): Promise<ServerSnapshot> {
  const at = new Date().toISOString();
  try {
    const base = await client.query<{
      lsn: string;
      database_size_bytes: string | null;
      temp_files: string | null;
      temp_bytes: string | null;
      migration_rows: string | null;
      claim_entities_present: boolean;
    }>(
      `SELECT pg_current_wal_lsn()::text AS lsn,
              pg_database_size(current_database())::text AS database_size_bytes,
              (SELECT temp_files::text FROM pg_stat_database WHERE datname = current_database()) AS temp_files,
              (SELECT temp_bytes::text FROM pg_stat_database WHERE datname = current_database()) AS temp_bytes,
              (SELECT count(*)::text FROM schema_migrations) AS migration_rows,
              to_regclass('public.claim_entities') IS NOT NULL AS claim_entities_present`,
    );
    const row = base.rows[0];
    const present = row?.claim_entities_present === true;
    let total: number | null = null;
    let indexes: number | null = null;
    let rows: number | null = null;
    if (present) {
      const detail = await client.query<{ total: string | null; indexes: string | null; rows: string | null }>(
        `SELECT pg_total_relation_size('public.claim_entities')::text AS total,
                pg_indexes_size('public.claim_entities')::text AS indexes,
                (SELECT count(*)::text FROM claim_entities) AS rows`,
      );
      total = toNumber(detail.rows[0]?.total);
      indexes = toNumber(detail.rows[0]?.indexes);
      rows = toNumber(detail.rows[0]?.rows);
    }
    return {
      at: toIso(at) ?? at,
      lsn: row?.lsn ?? null,
      database_size_bytes: toNumber(row?.database_size_bytes),
      temp_files: toNumber(row?.temp_files),
      temp_bytes: toNumber(row?.temp_bytes),
      claim_entities_present: present,
      claim_entities_total_bytes: total,
      claim_entities_index_bytes: indexes,
      claim_entities_rows: rows,
      schema_migrations_rows: toNumber(row?.migration_rows),
      error: null,
    };
  } catch (error) {
    return {
      at,
      lsn: null,
      database_size_bytes: null,
      temp_files: null,
      temp_bytes: null,
      claim_entities_present: false,
      claim_entities_total_bytes: null,
      claim_entities_index_bytes: null,
      claim_entities_rows: null,
      schema_migrations_rows: null,
      error: `${label}: ${(error as Error).message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

export interface LockObservation {
  readonly locktype: string;
  readonly mode: string;
  /** The relation name when the lock is on a relation; empty otherwise. */
  readonly relation: string;
  readonly granted: boolean;
}

export interface ActivitySample {
  readonly at_ms: number;
  readonly at: string;
  readonly migration_waiting_on_lock: boolean;
  readonly migration_locks: readonly LockObservation[];
  readonly blocked: readonly {
    readonly pid: number;
    readonly mode: string;
    readonly relation: string;
    /** `now() - query_start` for the waiting session: an upper bound on its lock wait. */
    readonly statement_elapsed_ms: number | null;
    readonly query_sample: string;
  }[];
  readonly error: string | null;
}

export interface MigrationSampling {
  readonly samples: number;
  /** The configured interval, which applies once the warm-up window has passed. */
  readonly interval_ms: number;
  /**
   * The mean gap actually observed between samples.
   *
   * Published separately because the sampler deliberately samples faster for the first
   * fraction of a second: a migration that commits in tens of milliseconds otherwise
   * produces two samples that bracket it and miss everything in between — including the
   * locks it held. Reporting only the configured interval would make that look like a
   * measurement rather than an artefact of the schedule.
   */
  readonly effective_interval_ms: number | null;
  readonly warmup_ms: number;
  readonly blocked_threshold_ms: number;
  /**
   * Sum of sample intervals during which the migration backend was observed waiting for a
   * lock. A **lower bound**: a wait shorter than the interval can fall entirely between two
   * samples, and a wait that spans N intervals is counted as N intervals.
   */
  readonly lock_acquisition_wait_ms: number;
  readonly lock_wait_windows: readonly { readonly from_ms: number; readonly to_ms: number }[];
  readonly locks_held: readonly {
    readonly locktype: string;
    readonly mode: string;
    readonly relation: string;
    readonly samples_observed: number;
  }[];
  readonly blocked_sessions: readonly {
    readonly pid: number;
    readonly mode: string;
    readonly relation: string;
    readonly observed_waiting_ms: number;
    readonly max_statement_elapsed_ms: number | null;
    readonly query_sample: string;
  }[];
  /** Distinct blocked sessions whose longest observed statement exceeded the threshold. */
  readonly statements_blocked_over_threshold: number;
  readonly sampling_errors: readonly string[];
}

/** How fast the sampler runs before it settles into the configured interval. */
export const SAMPLER_WARMUP_MS = 500;
export const SAMPLER_WARMUP_INTERVAL_MS = 20;

const EMPTY_SAMPLING = (
  interval_ms: number,
  threshold_ms: number,
  warmup_ms: number,
): MigrationSampling => ({
  samples: 0,
  interval_ms,
  effective_interval_ms: null,
  warmup_ms,
  blocked_threshold_ms: threshold_ms,
  lock_acquisition_wait_ms: 0,
  lock_wait_windows: [],
  locks_held: [],
  blocked_sessions: [],
  statements_blocked_over_threshold: 0,
  sampling_errors: [],
});

/**
 * Samples `pg_stat_activity` and `pg_locks` on a timer while one migration runs.
 *
 * The timer reschedules itself after each sample rather than firing on a fixed clock, so a
 * slow sample cannot produce two overlapping reads whose "interval" is fiction. The actual
 * interval observed is reported; the configured one is not assumed.
 */
export class MigrationSampler {
  private readonly client: TelemetryQueryClient;
  private readonly migrationPid: number;
  private readonly intervalMs: number;
  private readonly thresholdMs: number;
  private readonly observations: ActivitySample[] = [];
  private readonly errors: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;
  private startedAtMs = 0;
  private readonly warmupMs: number;

  constructor(options: {
    readonly client: TelemetryQueryClient;
    readonly migration_pid: number;
    readonly interval_ms: number;
    readonly blocked_threshold_ms: number;
    /** Overridable so a test can drive the warm-up window deterministically. */
    readonly warmup_ms?: number;
  }) {
    this.client = options.client;
    this.migrationPid = options.migration_pid;
    this.intervalMs = options.interval_ms;
    this.thresholdMs = options.blocked_threshold_ms;
    this.warmupMs = options.warmup_ms ?? SAMPLER_WARMUP_MS;
  }

  /** Take one sample immediately, then keep sampling until `stop()`. */
  async start(): Promise<void> {
    this.startedAtMs = Date.now();
    await this.tick();
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    const elapsed = Date.now() - this.startedAtMs;
    const delay =
      elapsed < this.warmupMs ? Math.min(this.intervalMs, SAMPLER_WARMUP_INTERVAL_MS) : this.intervalMs;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule());
    }, delay);
    // Sampling must never hold the process open on its own: a rehearsal that has finished
    // its migrations has to be able to exit even if a timer is still pending.
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const at = Date.now();
      const activity = await this.client.query<{
        pid: number;
        wait_event_type: string | null;
        wait_event: string | null;
        statement_elapsed_ms: string | null;
        query: string | null;
      }>(
        `SELECT pid,
                wait_event_type,
                wait_event,
                (EXTRACT(EPOCH FROM (now() - query_start)) * 1000)::text AS statement_elapsed_ms,
                left(query, 160) AS query
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()`,
      );
      const locks = await this.client.query<{
        pid: number;
        locktype: string;
        mode: string;
        granted: boolean;
        relation: string | null;
      }>(
        // An object created inside the migration's own transaction is locked while its
        // `pg_class` row is still invisible to this session, so the join finds no name. The
        // most important lock a migration takes — the ACCESS EXCLUSIVE on the table it is
        // creating — is exactly that case, and reporting it as an empty string hid it. The
        // OID is published instead, which identifies the object within the run.
        `SELECT l.pid, l.locktype, l.mode, l.granted,
                COALESCE(c.relname, CASE WHEN l.relation IS NULL THEN '' ELSE 'oid:' || l.relation::text END) AS relation
           FROM pg_locks l
           LEFT JOIN pg_class c ON c.oid = l.relation
           JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE a.datname = current_database()`,
      );

      const migrationLocks = locks.rows
        .filter((row) => Number(row.pid) === this.migrationPid)
        .map((row) => ({
          locktype: String(row.locktype),
          mode: String(row.mode),
          relation: row.relation ?? "",
          granted: row.granted === true,
        }));

      const waitingByPid = new Map(
        activity.rows
          .filter((row) => row.wait_event_type === "Lock" && Number(row.pid) !== this.migrationPid)
          .map((row) => [Number(row.pid), row]),
      );
      const blocked = [...waitingByPid.entries()].map(([pid, row]) => {
        const ungranted = locks.rows.find(
          (lock) => Number(lock.pid) === pid && lock.granted !== true,
        );
        return {
          pid,
          mode: ungranted === undefined ? "unknown" : String(ungranted.mode),
          relation: ungranted?.relation ?? "",
          statement_elapsed_ms: toNumber(row.statement_elapsed_ms),
          query_sample: (row.query ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
        };
      });

      this.observations.push({
        at_ms: at,
        at: new Date(at).toISOString(),
        migration_waiting_on_lock: migrationLocks.some((lock) => !lock.granted),
        migration_locks: migrationLocks,
        blocked,
        error: null,
      });
    } catch (error) {
      this.errors.push((error as Error).message);
      this.observations.push({
        at_ms: Date.now(),
        at: new Date().toISOString(),
        migration_waiting_on_lock: false,
        migration_locks: [],
        blocked: [],
        error: (error as Error).message,
      });
    } finally {
      this.running = false;
    }
  }

  async stop(): Promise<MigrationSampling> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    // One final sample, so a lock held only at the very end of a migration is still seen.
    await this.tick();
    return this.summarise();
  }

  /** The raw series, for a caller that wants to look at when a wait started. */
  series(): readonly ActivitySample[] {
    return this.observations;
  }

  private summarise(): MigrationSampling {
    return summariseSamples(this.observations, {
      interval_ms: this.intervalMs,
      blocked_threshold_ms: this.thresholdMs,
      warmup_ms: this.warmupMs,
      errors: this.errors,
    });
  }
}

/**
 * Fold a sample series into the summary the report publishes.
 *
 * Pure, and exported, so the interesting arithmetic — how a lock wait is accumulated, how a
 * blocked session's duration is bounded — can be tested with a series whose answer is known by
 * hand rather than by racing a timer.
 */
export function summariseSamples(
  observations: readonly ActivitySample[],
  input: {
    readonly interval_ms: number;
    readonly blocked_threshold_ms: number;
    readonly warmup_ms?: number;
    readonly errors?: readonly string[];
  },
): MigrationSampling {
  const intervalMs = input.interval_ms;
  const thresholdMs = input.blocked_threshold_ms;
  const warmupMs = input.warmup_ms ?? SAMPLER_WARMUP_MS;
  const errors = input.errors ?? [];
  {
    if (observations.length === 0) {
      return {
        ...EMPTY_SAMPLING(intervalMs, thresholdMs, warmupMs),
        sampling_errors: [...errors],
      };
    }
    // The mean gap between consecutive samples, which is what the weights below are made of.
    // The final sample's gap is excluded because it was never observed.
    const gaps: number[] = [];
    for (let index = 0; index + 1 < observations.length; index += 1) {
      gaps.push(observations[index + 1]!.at_ms - observations[index]!.at_ms);
    }
    const effectiveInterval =
      gaps.length === 0 ? null : gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;

    const lockCounts = new Map<string, { locktype: string; mode: string; relation: string; n: number }>();
    const blocked = new Map<
      number,
      { pid: number; mode: string; relation: string; observed_waiting_ms: number; max_statement_elapsed_ms: number | null; query_sample: string }
    >();
    const windows: { from_ms: number; to_ms: number }[] = [];
    let lockWaitMs = 0;
    let openWindow: { from_ms: number; to_ms: number } | null = null;

    for (let index = 0; index < observations.length; index += 1) {
      const sample = observations[index]!;
      const next = observations[index + 1];
      // The weight of one sample is the time until the following one; the final sample
      // covers nothing, because its interval was never observed.
      const weight = next === undefined ? 0 : Math.max(0, next.at_ms - sample.at_ms);

      for (const lock of sample.migration_locks.filter((entry) => entry.granted)) {
        const key = `${lock.locktype}|${lock.mode}|${lock.relation}`;
        const existing = lockCounts.get(key);
        if (existing === undefined) {
          lockCounts.set(key, { locktype: lock.locktype, mode: lock.mode, relation: lock.relation, n: 1 });
        } else {
          existing.n += 1;
        }
      }

      if (sample.migration_waiting_on_lock) {
        lockWaitMs += weight;
        if (openWindow === null) openWindow = { from_ms: sample.at_ms, to_ms: sample.at_ms + weight };
        else openWindow.to_ms = sample.at_ms + weight;
      } else if (openWindow !== null) {
        // A zero-width window is not a window: it is the last sample, whose interval was
        // never observed. Reporting it would put a wait in the report that was not measured.
        if (openWindow.to_ms > openWindow.from_ms) windows.push(openWindow);
        openWindow = null;
      }

      for (const entry of sample.blocked) {
        const existing = blocked.get(entry.pid);
        const elapsed = entry.statement_elapsed_ms;
        if (existing === undefined) {
          blocked.set(entry.pid, {
            pid: entry.pid,
            mode: entry.mode,
            relation: entry.relation,
            observed_waiting_ms: weight,
            max_statement_elapsed_ms: elapsed,
            query_sample: entry.query_sample,
          });
        } else {
          existing.observed_waiting_ms += weight;
          existing.max_statement_elapsed_ms =
            elapsed === null
              ? existing.max_statement_elapsed_ms
              : Math.max(existing.max_statement_elapsed_ms ?? 0, elapsed);
        }
      }
    }
    if (openWindow !== null && openWindow.to_ms > openWindow.from_ms) windows.push(openWindow);

    const blockedSessions = [...blocked.values()].sort((a, b) => b.observed_waiting_ms - a.observed_waiting_ms);
    return {
      samples: observations.length,
      interval_ms: intervalMs,
      effective_interval_ms: effectiveInterval,
      warmup_ms: warmupMs,
      blocked_threshold_ms: thresholdMs,
      lock_acquisition_wait_ms: lockWaitMs,
      lock_wait_windows: windows,
      locks_held: [...lockCounts.values()]
        .map((entry) => ({
          locktype: entry.locktype,
          mode: entry.mode,
          relation: entry.relation,
          samples_observed: entry.n,
        }))
        .sort((a, b) => b.samples_observed - a.samples_observed || a.mode.localeCompare(b.mode)),
      blocked_sessions: blockedSessions,
      statements_blocked_over_threshold: blockedSessions.filter(
        (entry) => (entry.max_statement_elapsed_ms ?? 0) > thresholdMs,
      ).length,
      sampling_errors: [...errors],
    };
  }
}

// ---------------------------------------------------------------------------
// Per-migration record
// ---------------------------------------------------------------------------

export interface MigrationTelemetry {
  readonly name: string;
  readonly checksum: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly elapsed_ms: number | null;
  /** 0 committed, 1 the migration failed and was rolled back, null it never started. */
  readonly exit_code: number | null;
  readonly outcome: "committed" | "failed" | "not_started";
  readonly error: string | null;
  readonly backend_pid: number | null;
  readonly lock_timeout_ms: number | null;
  readonly lock_acquisition_wait_ms: number | null;
  readonly locks_held: MigrationSampling["locks_held"];
  readonly blocked_sessions: MigrationSampling["blocked_sessions"];
  readonly blocked_sessions_count: number | null;
  readonly statements_blocked_over_threshold: number | null;
  readonly wal: {
    readonly lsn_before: string | null;
    readonly lsn_after: string | null;
    readonly bytes_generated: number | null;
    readonly error: string | null;
  };
  readonly database_size: {
    readonly before_bytes: number | null;
    readonly after_bytes: number | null;
    readonly delta_bytes: number | null;
  };
  readonly claim_entities: {
    readonly present_before: boolean;
    readonly present_after: boolean;
    readonly total_bytes_before: number | null;
    readonly total_bytes_after: number | null;
    readonly index_bytes_before: number | null;
    readonly index_bytes_after: number | null;
    readonly rows_before: number | null;
    readonly rows_after: number | null;
    readonly rows_backfilled: number | null;
  };
  readonly temporary_files: {
    readonly files_before: number | null;
    readonly files_after: number | null;
    readonly bytes_before: number | null;
    readonly bytes_after: number | null;
  };
  readonly sampling: MigrationSampling | null;
  /** The projection checks run immediately after this migration committed. */
  readonly projection_after: Record<string, number | null>;
}

/** Build the WAL half of a telemetry record, refusing to invent a number. */
export function walBetween(before: ServerSnapshot, after: ServerSnapshot): MigrationTelemetry["wal"] {
  if (before.lsn === null || after.lsn === null) {
    return {
      lsn_before: before.lsn,
      lsn_after: after.lsn,
      bytes_generated: null,
      error: "a WAL position could not be read, so no byte count exists for this migration",
    };
  }
  const delta: WalDelta = walLsnDelta(before.lsn, after.lsn);
  return {
    lsn_before: before.lsn,
    lsn_after: after.lsn,
    bytes_generated: delta.bytes,
    error: delta.error,
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Refuse to serialise anything a JSON round trip would change.
 *
 * The report is written with `JSON.stringify`, which silently turns `BigInt` into a thrown
 * `TypeError`, a `Date` into a string, `NaN` into `null` and `undefined` into a missing
 * key. Every one of those is a measurement quietly becoming something else. This walks the
 * value first and names the offending path, so the failure happens where the mistake is
 * rather than three steps later in a chart.
 */
export function assertJsonSafe(value: unknown, path = "$"): void {
  if (value === null) return;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return;
  if (kind === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error(`${path} is ${String(value)}, which JSON would write as null`);
    }
    return;
  }
  if (kind === "bigint") {
    throw new Error(`${path} is a BigInt, which JSON.stringify refuses to serialise`);
  }
  if (kind === "undefined") {
    throw new Error(`${path} is undefined, which JSON would drop entirely`);
  }
  if (value instanceof Date) {
    throw new Error(`${path} is a Date; convert it to an ISO string before it enters the report`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonSafe(entry, `${path}[${index}]`));
    return;
  }
  if (kind === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assertJsonSafe(entry, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path} is a ${kind}, which the report schema has no representation for`);
}

/** The JSON text for a telemetry record, after proving the round trip loses nothing. */
export function serialiseTelemetry(value: unknown): string {
  assertJsonSafe(value);
  const text = JSON.stringify(value, null, 2);
  const reparsed: unknown = JSON.parse(text);
  if (JSON.stringify(reparsed, null, 2) !== text) {
    throw new Error("the telemetry record does not survive a JSON round trip unchanged");
  }
  return text;
}
