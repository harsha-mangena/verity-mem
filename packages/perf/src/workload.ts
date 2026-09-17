/**
 * The declared query mix.
 *
 * A single "query latency" number is meaningless without saying what was asked. This
 * module turns a declared mix of time modes and query shapes into the exact list of
 * requests the benchmark issues, and the same declaration is what the report prints —
 * so the number and the workload that produced it cannot drift apart.
 *
 * Three properties are deliberate:
 *
 *   * **The three time modes get their own budget, not a share of one pool.** The
 *     spec requires p50/p95/p99 reported separately for `current`, `as_of` and
 *     `during`, which means the sample count per mode has to be large enough for a
 *     p99 to mean anything. A mode with 20 samples has no p99.
 *   * **`limit` is fixed across the mix** so that the "result-set size" the report
 *     declares is one number. Changing the limit inside a mix would make the
 *     percentiles an average over different amounts of work, which is how a
 *     benchmark accidentally hides the expensive shape.
 *   * **Every request has distinct query text.** Repeated identical text is answered
 *     partly from caches a first-time query does not have. `position` seeds the text,
 *     so the workload is deterministic and still varied.
 */
import type { QueryRequest, TimeSpec } from "@veritymem/contracts";
import { BENCH_PROJECT, BENCH_PURPOSE, BENCH_USER_COUNT, queryTextFor } from "./corpus.ts";

export type TimeMode = "current" | "as_of" | "during";

/** A named query shape. The `shape` string is what the report prints. */
export interface WorkloadShape {
  readonly shape: string;
  readonly mode: TimeMode;
  readonly proportion: number;
  readonly description: string;
  /** True when the request declares `subjects`, which is what enables the relation channel. */
  readonly declares_subject: boolean;
}

/**
 * The default mix.
 *
 * Read it as a sentence: for every 100 queries, 50 are `current` (30 free-text, 12
 * entity-bearing, 8 subject-scoped with relation traversal enabled), 25 are `as_of`
 * (15 at a recent instant, 10 at a historical one), and 25 are `during` (10 over a
 * 1-day window, 8 over a 7-day window, 7 over a 90-day window, which is where the
 * temporal channel does the most work).
 *
 * `subjects` appears in exactly one shape on purpose. The relation channel is a
 * bounded one-hop traversal and the design says it only runs when the caller names a
 * subject, so leaving it out entirely would understate the cost of the most expensive
 * documented shape, and putting it in every shape would overstate the average.
 */
export const DEFAULT_MIX: readonly WorkloadShape[] = [
  {
    shape: "current/free-text",
    mode: "current",
    proportion: 0.30,
    description: "websearch_to_tsquery over prose; no declared subject",
    declares_subject: false,
  },
  {
    shape: "current/entity",
    mode: "current",
    proportion: 0.12,
    description: "query text naming a principal and a repo; entity channel resolves aliases",
    declares_subject: false,
  },
  {
    shape: "current/subject+relation",
    mode: "current",
    proportion: 0.08,
    description: "declared subjects, which enables the bounded relation channel",
    declares_subject: true,
  },
  {
    shape: "as_of/recent-30d",
    mode: "as_of",
    proportion: 0.15,
    description: "as_of at anchor − 30 days; matches still-open claims plus recently closed ones",
    declares_subject: false,
  },
  {
    shape: "as_of/historical-150d",
    mode: "as_of",
    proportion: 0.10,
    description: "as_of at anchor − 150 days; matches a much older accepted/superseded set",
    declares_subject: false,
  },
  {
    shape: "during/1d",
    mode: "during",
    proportion: 0.10,
    description: "valid-time window of one day",
    declares_subject: false,
  },
  {
    shape: "during/7d",
    mode: "during",
    proportion: 0.08,
    description: "valid-time window of seven days",
    declares_subject: false,
  },
  {
    shape: "during/90d",
    mode: "during",
    proportion: 0.07,
    description: "valid-time window of ninety days; the widest window measured",
    declares_subject: false,
  },
];

export const ALL_TIME_MODES: readonly TimeMode[] = ["current", "as_of", "during"];

const DAY_MS = 86_400_000;

export interface WorkloadPlan {
  readonly requests: readonly PlannedRequest[];
  readonly mix: readonly WorkloadShape[];
  readonly per_mode: Readonly<Record<TimeMode, number>>;
}

export interface PlannedRequest {
  readonly position: number;
  readonly mode: TimeMode;
  readonly shape: string;
  readonly request: QueryRequest;
}

export interface WorkloadOptions {
  readonly total: number;
  readonly limit: number;
  readonly corpusSeed: string;
  readonly anchor: Date;
  readonly principal: string;
  readonly mix?: readonly WorkloadShape[];
}

/**
 * Allocate `total` requests across the mix, then build each one.
 *
 * Largest-remainder allocation, so the counts sum exactly to `total` rather than to
 * `total ± rounding`, and the per-mode totals in the report are the counts actually
 * issued. A mode that ends up with fewer than 100 samples is reported as such by the
 * report rather than being quietly averaged into a percentile.
 */
export function buildWorkload(options: WorkloadOptions): WorkloadPlan {
  const mix = options.mix ?? DEFAULT_MIX;
  const exact = mix.map((shape) => shape.proportion * options.total);
  const counts = exact.map((value) => Math.floor(value));
  let assigned = counts.reduce((sum, value) => sum + value, 0);
  const remainders = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder);
  for (const entry of remainders) {
    if (assigned >= options.total) break;
    counts[entry.index] = (counts[entry.index] ?? 0) + 1;
    assigned += 1;
  }

  const requests: PlannedRequest[] = [];
  let position = 0;
  mix.forEach((shape, index) => {
    const count = counts[index] ?? 0;
    for (let offset = 0; offset < count; offset += 1) {
      requests.push({
        position,
        mode: shape.mode,
        shape: shape.shape,
        request: buildRequest(shape, position, options),
      });
      position += 1;
    }
  });

  const perMode: Record<TimeMode, number> = { current: 0, as_of: 0, during: 0 };
  for (const entry of requests) perMode[entry.mode] += 1;

  return { requests, mix, per_mode: perMode };
}

function buildRequest(
  shape: WorkloadShape,
  position: number,
  options: WorkloadOptions,
): QueryRequest {
  const text = queryTextFor(position, { seed: `${options.corpusSeed}:${shape.shape}`, origin: options.anchor });
  const time = timeSpecFor(shape, position, options);
  const subjectIndex = position % BENCH_USER_COUNT;
  const request: QueryRequest = {
    query: text,
    scope: {
      tenant: options.corpusSeed,
      project: BENCH_PROJECT,
      // No user dimension: the benchmark caller is the project-scoped operator, so the
      // request resolves to the project scope and reaches every user scope beneath it.
      // That is the widest realistic reach and therefore the honest worst case for the
      // authorization filter the read path applies before retrieval.
    },
    purpose: BENCH_PURPOSE,
    time,
    action_risk: "low",
    limit: options.limit,
    ...(shape.declares_subject
      ? { subjects: [`user:eng-${String(subjectIndex).padStart(2, "0")}`] }
      : {}),
  };
  return request;
}

/**
 * The time predicate for one shape.
 *
 * `as_of` instants and `during` windows are relative to the corpus anchor and spread
 * across the whole recorded window, because a corpus whose timestamps all cluster in
 * one week would make `during` queries return either everything or nothing and the
 * measurement would be reporting the corpus rather than the query.
 */
function timeSpecFor(shape: WorkloadShape, position: number, options: WorkloadOptions): TimeSpec {
  const anchor = options.anchor.getTime();
  switch (shape.shape) {
    case "as_of/recent-30d":
      return { mode: "as_of", as_of: new Date(anchor - (30 + (position % 5)) * DAY_MS).toISOString() };
    case "as_of/historical-150d":
      return { mode: "as_of", as_of: new Date(anchor - (120 + (position % 55)) * DAY_MS).toISOString() };
    case "during/1d": {
      const start = anchor - (10 + (position % 60)) * DAY_MS;
      return { mode: "during", from: new Date(start).toISOString(), to: new Date(start + DAY_MS).toISOString() };
    }
    case "during/7d": {
      const start = anchor - (10 + (position % 60)) * DAY_MS;
      return { mode: "during", from: new Date(start).toISOString(), to: new Date(start + 7 * DAY_MS).toISOString() };
    }
    case "during/90d": {
      const start = anchor - (10 + (position % 60)) * DAY_MS;
      return { mode: "during", from: new Date(start).toISOString(), to: new Date(start + 90 * DAY_MS).toISOString() };
    }
    default:
      return { mode: "current" };
  }
}
