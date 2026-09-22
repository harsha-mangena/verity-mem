/**
 * One measured request.
 *
 * Kept per-request rather than aggregated on the fly, because a percentile cannot be
 * computed from a running mean and a benchmark that only stores an average has thrown
 * away the number the target is stated in terms of.
 */
export interface Sample {
  readonly position: number;
  readonly mode: "current" | "as_of" | "during";
  readonly shape: string;
  /** Wall-clock duration of the whole `compose()` call, microseconds. */
  readonly latency_us: number;
  /** Claims in the returned packet. */
  readonly returned: number;
  /** Candidates the channels saw, before fusion and hydration. */
  readonly candidates_considered: number;
  /** Packet decision, so a degraded run is visible rather than averaged in. */
  readonly decision: string;
  /** True when the packet came back empty. An all-empty workload measures nothing. */
  readonly empty: boolean;
  /**
   * Set when `compose()` rejected, e.g. a statement timeout. The request is not
   * dropped: a slow query that hits the server's `statement_timeout` is the most
   * important thing a latency benchmark can report, and quietly excluding it would
   * turn a timeout into a missing sample.
   */
  readonly error: string | null;
  /** Seconds since the start of the pass. Used to check for drift within a pass. */
  readonly at_s: number;
  /**
   * Per-channel durations in milliseconds, as the channel itself measured them.
   *
   * Kept because a request's total says nothing about *which* channel is the problem,
   * and at a million claims the answer is not predictable from a small-corpus run: the
   * dense channel's plan changes with the row count.
   */
  readonly channels: Readonly<Record<string, number>>;
}

/** Per-channel mean/p95 duration, page reads included as the channel reported them. */
export interface ChannelSummary {
  readonly channel: string;
  readonly n: number;
  readonly mean_ms: number;
  readonly p95_ms: number;
  readonly max_ms: number;
  /** Requests in which this channel did not run at all (skipped, not empty). */
  readonly skipped: number;
}

export function summariseChannels(samples: readonly Sample[]): readonly ChannelSummary[] {
  const byChannel = new Map<string, number[]>();
  const seen = new Map<string, number>();
  let total = 0;
  for (const sample of samples) {
    total += 1;
    for (const [name, duration] of Object.entries(sample.channels)) {
      const list = byChannel.get(name) ?? [];
      list.push(duration);
      byChannel.set(name, list);
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
  }
  return [...byChannel.entries()]
    .map(([channel, values]) => ({
      channel,
      n: values.length,
      mean_ms: round3(values.reduce((sum, value) => sum + value, 0) / values.length),
      p95_ms: round3(percentile(values, 95)),
      max_ms: round3(Math.max(...values)),
      skipped: total - (seen.get(channel) ?? 0),
    }))
    .sort((left, right) => right.mean_ms - left.mean_ms);
}

export interface LatencySummary {
  readonly n: number;
  readonly min_ms: number;
  readonly p50_ms: number;
  readonly p90_ms: number;
  readonly p95_ms: number;
  readonly p99_ms: number;
  readonly max_ms: number;
  readonly mean_ms: number;
  /** Percentile method, stated because "p95" means different things to different tools. */
  readonly method: string;
}

export const PERCENTILE_METHOD = "nearest-rank on sorted samples (no interpolation)";

/**
 * Nearest-rank percentile.
 *
 * `ceil(p/100 * n)`-th smallest value. Chosen over linear interpolation because it is
 * the definition `pgbench`, `wrk` and most latency SLO documents use, and an
 * interpolated p95 between two samples is a number no request ever experienced.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  const value = sorted[Math.min(rank, sorted.length) - 1];
  if (value === undefined) return Number.NaN;
  return value;
}

export function summarise(samples: readonly Sample[]): LatencySummary {
  const values = samples.map((sample) => sample.latency_us / 1000);
  if (values.length === 0) {
    return {
      n: 0,
      min_ms: Number.NaN,
      p50_ms: Number.NaN,
      p90_ms: Number.NaN,
      p95_ms: Number.NaN,
      p99_ms: Number.NaN,
      max_ms: Number.NaN,
      mean_ms: Number.NaN,
      method: PERCENTILE_METHOD,
    };
  }
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    n: values.length,
    min_ms: round3(Math.min(...values)),
    p50_ms: round3(percentile(values, 50)),
    p90_ms: round3(percentile(values, 90)),
    p95_ms: round3(percentile(values, 95)),
    p99_ms: round3(percentile(values, 99)),
    max_ms: round3(Math.max(...values)),
    mean_ms: round3(sum / values.length),
    method: PERCENTILE_METHOD,
  };
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Result-set and content statistics, so an empty workload cannot pass as a fast one. */
export interface ContentSummary {
  readonly errors: number;
  readonly error_examples: readonly string[];
  readonly returned_total: number;
  readonly returned_mean: number;
  readonly returned_min: number;
  readonly returned_max: number;
  readonly candidates_mean: number;
  readonly empty_packets: number;
  readonly empty_fraction: number;
  readonly decisions: Readonly<Record<string, number>>;
}

export function summariseContent(samples: readonly Sample[]): ContentSummary {
  const returned = samples.map((sample) => sample.returned);
  const candidates = samples.map((sample) => sample.candidates_considered);
  const decisions: Record<string, number> = {};
  for (const sample of samples) decisions[sample.decision] = (decisions[sample.decision] ?? 0) + 1;
  const empty = samples.filter((sample) => sample.empty).length;
  const errored = samples.filter((sample) => sample.error !== null);
  const errorExamples = [...new Set(errored.map((sample) => sample.error ?? ""))].slice(0, 5);
  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : round3(values.reduce((total, value) => total + value, 0) / values.length);
  return {
    errors: errored.length,
    error_examples: errorExamples,
    returned_total: returned.reduce((total, value) => total + value, 0),
    returned_mean: mean(returned),
    returned_min: returned.length === 0 ? 0 : Math.min(...returned),
    returned_max: returned.length === 0 ? 0 : Math.max(...returned),
    candidates_mean: mean(candidates),
    empty_packets: empty,
    empty_fraction: samples.length === 0 ? 0 : round3(empty / samples.length),
    decisions,
  };
}

/**
 * Samples below this count are flagged.
 *
 * A p99 computed from 40 samples is the largest of 40 numbers wearing a percentile's
 * name. The number is not suppressed — hiding a measurement is worse — but it is
 * marked so a reader does not compare it with a p99 from 2 000 samples.
 */
export const MIN_SAMPLES_FOR_P99 = 200;

export function compareToTarget(summary: LatencySummary, targetMs: number): {
  readonly met: boolean;
  readonly headroom_ms: number;
  readonly overshoot_ms: number;
} {
  const met = Number.isFinite(summary.p95_ms) && summary.p95_ms < targetMs;
  return {
    met,
    headroom_ms: round3(targetMs - summary.p95_ms),
    overshoot_ms: round3(Math.max(0, summary.p95_ms - targetMs)),
  };
}
