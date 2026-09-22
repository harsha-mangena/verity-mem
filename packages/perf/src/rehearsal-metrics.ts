/**
 * The arithmetic behind the migration rehearsal, kept away from the database.
 *
 * Everything here is a pure function over plain values so it can be tested without a
 * PostgreSQL server. That is not tidiness for its own sake: the rehearsal's whole output is
 * a set of numbers, and the only way to know the numbers mean what the report says they
 * mean is to be able to call the functions that produce them with inputs whose answers are
 * known by hand.
 *
 * ## The rule that shapes every signature here
 *
 * **An absent measurement is not zero.** `percentile([])` returns `null` rather than `0`,
 * and a WAL delta that cannot be computed returns `null` with a reason rather than a
 * negative or a guess. The report's completeness check walks those nulls and refuses to
 * call a run complete while any of them remains unexplained. A `0` in this file always
 * means "measured, and the measurement was zero", which is a different fact.
 */

/** Nearest-rank percentile of a sample, or null when there is no sample at all. */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new Error(`percentile fraction must be in (0, 1]; got ${String(fraction)}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: the smallest value whose rank covers the requested fraction. With one
  // sample every percentile is that sample, which is the honest answer for a single
  // observation and the reason a caller must also publish the sample count.
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(Math.max(rank - 1, 0), sorted.length - 1)] ?? null;
}

export interface DurationSummary {
  readonly count: number;
  readonly p50_ms: number | null;
  readonly p95_ms: number | null;
  readonly p99_ms: number | null;
  readonly max_ms: number | null;
  readonly mean_ms: number | null;
}

export function summariseDurations(values: readonly number[]): DurationSummary {
  if (values.length === 0) {
    return { count: 0, p50_ms: null, p95_ms: null, p99_ms: null, max_ms: null, mean_ms: null };
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    p50_ms: percentile(values, 0.5),
    p95_ms: percentile(values, 0.95),
    p99_ms: percentile(values, 0.99),
    max_ms: Math.max(...values),
    mean_ms: total / values.length,
  };
}

// ---------------------------------------------------------------------------
// Outage windows
// ---------------------------------------------------------------------------

export interface AttemptTimes {
  readonly started_at_ms: number;
  readonly finished_at_ms: number;
  readonly ok: boolean;
}

export interface OutageWindow {
  /** The longest interval in which no attempt of this operation completed successfully. */
  readonly longest_ms: number | null;
  readonly from_ms: number | null;
  readonly to_ms: number | null;
  /**
   * False when the window contains no successful completion at all, in which case
   * `longest_ms` is the whole observation window and is an outage by definition rather
   * than by measurement.
   */
  readonly has_success: boolean;
}

/**
 * Longest continuous period in which an operation never completed successfully.
 *
 * Measured on `finished_at_ms` rather than on start times, because what an operator cares
 * about is when the system last served a request, not when the next one was attempted.
 *
 * The gaps considered are: from the start of the observation window to the first success,
 * between consecutive successes, and from the last success to the end of the window. The
 * trailing gap therefore includes the probe's own shutdown; that is deliberate, since a
 * shutdown that waits on an in-flight request is time the operation was not serving, and
 * the attempt counts are published next to it so the reader can see how much traffic the
 * gap actually contained.
 *
 * `finished_at_ms` values that were never observed (a probe still in flight when the
 * window closed) cannot appear here: the caller records only completed attempts.
 */
export function longestOutage(
  attempts: readonly AttemptTimes[],
  window: { readonly start_ms: number; readonly end_ms: number },
): OutageWindow {
  if (window.end_ms < window.start_ms) {
    throw new Error("outage window end precedes its start");
  }
  const successes = attempts
    .filter((attempt) => attempt.ok)
    .map((attempt) => attempt.finished_at_ms)
    .sort((a, b) => a - b);

  if (successes.length === 0) {
    return {
      longest_ms: window.end_ms - window.start_ms,
      from_ms: window.start_ms,
      to_ms: window.end_ms,
      has_success: false,
    };
  }

  let best = { ms: -1, from: window.start_ms, to: window.start_ms };
  let cursor = window.start_ms;
  for (const success of successes) {
    const gap = success - cursor;
    if (gap > best.ms) best = { ms: gap, from: cursor, to: success };
    cursor = success;
  }
  const trailing = window.end_ms - cursor;
  if (trailing > best.ms) best = { ms: trailing, from: cursor, to: window.end_ms };

  return { longest_ms: best.ms, from_ms: best.from, to_ms: best.to, has_success: true };
}

// ---------------------------------------------------------------------------
// WAL
// ---------------------------------------------------------------------------

export interface WalDelta {
  readonly bytes: number | null;
  readonly error: string | null;
}

/**
 * Parse a PostgreSQL LSN (`X/Y` in hexadecimal) into a monotonic integer.
 *
 * The high half is not a fixed width — `16/B374D848` and `1/0` are both valid — so the
 * parts are parsed as hex and combined as `high << 32 | low` rather than being compared as
 * strings, which would sort `10/0` before `9/0`.
 */
export function parseLsn(lsn: string): bigint {
  const match = /^([0-9A-Fa-f]+)\/([0-9A-Fa-f]+)$/.exec(lsn.trim());
  if (match === null) throw new Error(`not a PostgreSQL LSN: ${JSON.stringify(lsn)}`);
  return (BigInt(`0x${match[1]}`) << 32n) | BigInt(`0x${match[2]}`);
}

/**
 * Bytes of WAL written between two LSNs.
 *
 * Refuses to produce a number it cannot justify: an unparseable LSN, or an "after" that
 * precedes "before" (which means the two readings did not come from one server's timeline,
 * e.g. a failover or a restored cluster), yields `bytes: null` and a reason. Returning a
 * negative byte count, or clamping it to zero, would put a fabricated measurement in the
 * report — the exact failure this project exists to prevent.
 *
 * The value is a property of the *cluster*, not of the migration: concurrent writers
 * advance the same LSN. The report says so next to the number, and states the workload's
 * own write count so the reader can size the contamination.
 */
export function walLsnDelta(before: string, after: string): WalDelta {
  let low: bigint;
  let high: bigint;
  try {
    low = parseLsn(before);
    high = parseLsn(after);
  } catch (error) {
    return { bytes: null, error: (error as Error).message };
  }
  if (high < low) {
    return {
      bytes: null,
      error:
        `the WAL LSN moved backwards (${before} -> ${after}); the two readings are not from ` +
        `one server timeline and no byte count can be derived from them`,
    };
  }
  const delta = high - low;
  if (delta > BigInt(Number.MAX_SAFE_INTEGER)) {
    return {
      bytes: null,
      error: `the WAL delta ${delta.toString()} exceeds the exact integer range of a JSON number`,
    };
  }
  return { bytes: Number(delta), error: null };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface OperationFailure {
  readonly code: string;
  readonly message: string;
}

export interface ErrorGroup {
  readonly code: string;
  readonly count: number;
  /** One representative message, truncated and with identifiers removed. */
  readonly sample_message: string;
}

/** Replace UUID-shaped text, so a grouped error cannot carry a scope id into the report. */
export function redactIdentifiers(text: string): string {
  return text.replace(
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
    "<uuid>",
  );
}

export function tidyMessage(text: string, limit = 240): string {
  const collapsed = redactIdentifiers(text.replace(/\s+/g, " ").trim());
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

/**
 * Group failures by SQLSTATE, most frequent first.
 *
 * Grouped by code rather than by message because the code is the part PostgreSQL
 * guarantees: a hundred `55P03` failures are one fact about locking, while a hundred
 * distinct message strings are one fact that has been made to look like a hundred.
 */
export function groupErrors(failures: readonly OperationFailure[]): readonly ErrorGroup[] {
  const groups = new Map<string, { count: number; message: string }>();
  for (const failure of failures) {
    const existing = groups.get(failure.code);
    if (existing === undefined) {
      groups.set(failure.code, { count: 1, message: tidyMessage(failure.message) });
    } else {
      existing.count += 1;
    }
  }
  return [...groups.entries()]
    .map(([code, entry]) => ({ code, count: entry.count, sample_message: entry.message }))
    .sort((a, b) => (b.count - a.count) || a.code.localeCompare(b.code));
}

// ---------------------------------------------------------------------------
// Workload accounting
// ---------------------------------------------------------------------------

export const PROBE_OPERATIONS = [
  "lexical_retrieval",
  "entity_retrieval",
  "claim_hydration",
  "append_event",
  "project_claim",
] as const;
export type ProbeOperation = (typeof PROBE_OPERATIONS)[number];

export const WORKLOAD_PHASES = [
  /** Running against the 0013 schema, before 0014 commits. */
  "pre_migration",
  "migration_0014",
  /** After 0014 committed and before the failing 0015 attempts. */
  "post_0014",
  "migration_0015",
  "post_migration",
  /** The deliberately failing migration attempts, during which the probes are paused. */
  "recovery",
] as const;
export type WorkloadPhase = (typeof WORKLOAD_PHASES)[number];

export interface AttemptSample {
  readonly operation: ProbeOperation;
  readonly phase: WorkloadPhase;
  readonly started_at_ms: number;
  readonly finished_at_ms: number;
  readonly duration_ms: number;
  readonly ok: boolean;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly timed_out: boolean;
  /**
   * How many rows the operation returned, when it has a meaningful count.
   *
   * A retrieval probe that succeeds while returning nothing has not served the request it
   * was measuring, so the count is recorded rather than discarded. `null` means the
   * operation has no row count (an append, a projection), not that the count was zero.
   */
  readonly result_count: number | null;
  /**
   * Always `probe`. The workload is the only producer of samples, and the report asserts
   * that no sample came from anywhere else — a migration statement timed on the migration
   * connection has a completely different meaning from an application operation, and
   * mixing them would silently inflate every percentile.
   */
  readonly source: "probe";
}

export interface OperationStats {
  readonly operation: ProbeOperation;
  readonly attempts: number;
  readonly successes: number;
  readonly failures: number;
  readonly timeouts: number;
  /** Successful attempts that returned no rows at all. */
  readonly empty_results: number;
  readonly durations: DurationSummary;
  readonly outage: OutageWindow;
  readonly errors: readonly ErrorGroup[];
  readonly samples_from_non_probe: number;
}

export interface WorkloadStats {
  readonly window: { readonly started_at_ms: number; readonly ended_at_ms: number };
  readonly phases: readonly PhaseStats[];
  readonly operations: readonly OperationStats[];
  readonly total_samples: number;
  readonly samples_from_non_probe: number;
}

export interface PhaseStats {
  readonly phase: WorkloadPhase;
  readonly window: { readonly started_at_ms: number; readonly ended_at_ms: number };
  readonly operations: readonly OperationStats[];
}

/**
 * Accumulates probe outcomes.
 *
 * Samples are appended by the workload and read by the report, never on the same tick, so
 * a snapshot taken while probes are still running is a consistent prefix rather than a
 * torn read. Nothing here mutates a sample on the way in; the only transformation is the
 * arithmetic in `summarise`.
 */
export class WorkloadRecorder {
  private readonly samples: AttemptSample[] = [];
  private readonly phaseWindows = new Map<WorkloadPhase, { start_ms: number; end_ms: number }>();
  private activePhase: WorkloadPhase | null = null;

  record(sample: AttemptSample): void {
    this.samples.push(sample);
  }

  /** How many samples have been recorded so far. */
  size(): number {
    return this.samples.length;
  }

  /**
   * Open a phase, closing whichever phase was open.
   *
   * Only the phase that is actually open may be extended. An earlier version closed *every*
   * phase at the current time, so each phase's window ran to the end of the run: the
   * per-phase outage windows were then measured against a window that had nothing to do with
   * the phase, and a two-second outage inside 0014 was reported as a two-minute one. A test
   * with two phases caught it.
   */
  openPhase(phase: WorkloadPhase, at_ms: number): void {
    if (this.activePhase !== null && this.activePhase !== phase) {
      const previous = this.phaseWindows.get(this.activePhase);
      if (previous !== undefined) previous.end_ms = Math.max(previous.end_ms, at_ms);
    }
    const existing = this.phaseWindows.get(phase);
    if (existing === undefined) {
      this.phaseWindows.set(phase, { start_ms: at_ms, end_ms: at_ms });
    } else {
      existing.end_ms = Math.max(existing.end_ms, at_ms);
    }
    this.activePhase = phase;
  }

  /** Close the open phase. Phases that have already closed are left alone. */
  closeAllPhases(at_ms: number): void {
    if (this.activePhase === null) return;
    const open = this.phaseWindows.get(this.activePhase);
    if (open !== undefined) open.end_ms = Math.max(open.end_ms, at_ms);
    this.activePhase = null;
  }

  /** The stats for one phase, for a caller that needs them before the run has finished. */
  phaseSnapshot(
    phase: WorkloadPhase,
    window: { readonly started_at_ms: number; readonly ended_at_ms: number },
  ): PhaseStats | null {
    return this.snapshot(window).phases.find((entry) => entry.phase === phase) ?? null;
  }

  snapshot(window: { readonly started_at_ms: number; readonly ended_at_ms: number }): WorkloadStats {
    const phases: PhaseStats[] = [];
    for (const [phase, times] of [...this.phaseWindows.entries()].sort(
      (a, b) => a[1].start_ms - b[1].start_ms,
    )) {
      const phaseWindow = { started_at_ms: times.start_ms, ended_at_ms: times.end_ms };
      phases.push({
        phase,
        window: phaseWindow,
        operations: PROBE_OPERATIONS.map((operation) =>
          summariseOperation(
            operation,
            this.samples.filter((sample) => sample.phase === phase),
            phaseWindow,
          ),
        ),
      });
    }
    return {
      window,
      phases,
      operations: PROBE_OPERATIONS.map((operation) =>
        summariseOperation(operation, this.samples, window),
      ),
      total_samples: this.samples.length,
      samples_from_non_probe: this.samples.filter((sample) => sample.source !== "probe").length,
    };
  }
}

function summariseOperation(
  operation: ProbeOperation,
  samples: readonly AttemptSample[],
  window: { readonly started_at_ms: number; readonly ended_at_ms: number },
): OperationStats {
  const mine = samples.filter((sample) => sample.operation === operation);
  const failures = mine.filter((sample) => !sample.ok);
  return {
    operation,
    attempts: mine.length,
    successes: mine.length - failures.length,
    failures: failures.length,
    timeouts: mine.filter((sample) => sample.timed_out).length,
    empty_results: mine.filter((sample) => sample.ok && sample.result_count === 0).length,
    durations: summariseDurations(mine.map((sample) => sample.duration_ms)),
    outage: longestOutage(mine, { start_ms: window.started_at_ms, end_ms: window.ended_at_ms }),
    errors: groupErrors(
      failures.map((sample) => ({
        code: sample.error_code ?? "unknown",
        message: sample.error_message ?? "",
      })),
    ),
    samples_from_non_probe: mine.filter((sample) => sample.source !== "probe").length,
  };
}

// ---------------------------------------------------------------------------
// Measurement bookkeeping
// ---------------------------------------------------------------------------

/**
 * Whether a required measurement was taken.
 *
 * `not_applicable` exists because some fields genuinely have no value in some runs — there
 * is no `claim_entities` before 0015 creates it — and a report that treated those as
 * missing would never be complete, while one that treated them as zero would be lying.
 * `missing` is the only state that blocks completeness.
 */
export type MeasurementState = "measured" | "not_applicable" | "missing";

export interface MeasurementNote {
  readonly field: string;
  readonly state: MeasurementState;
  readonly reason: string;
}

export function measured(field: string, reason = "measured"): MeasurementNote {
  return { field, state: "measured", reason };
}

export function notApplicable(field: string, reason: string): MeasurementNote {
  return { field, state: "not_applicable", reason };
}

export function missing(field: string, reason: string): MeasurementNote {
  return { field, state: "missing", reason };
}

/** The notes that make a report incomplete, in the order they were recorded. */
export function missingMeasurements(
  notes: readonly MeasurementNote[],
): readonly MeasurementNote[] {
  return notes.filter((note) => note.state === "missing");
}

/**
 * Record a value as measured or missing, in one place.
 *
 * A `null` value with no explanation is how an unmeasured field silently becomes a zero in
 * a downstream chart. This forces every nullable field to declare which it is.
 */
export function noteFor(field: string, value: unknown, reasonWhenMissing: string): MeasurementNote {
  return value === null || value === undefined
    ? missing(field, reasonWhenMissing)
    : measured(field);
}
