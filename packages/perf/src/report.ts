/**
 * The report.
 *
 * Two outputs from one structure: `reports/perf-benchmark.json` for a machine, and a
 * plain-text summary for a person. They are built from the same object so the prose
 * cannot claim something the JSON does not contain.
 *
 * The verdict logic is the part worth reading closely. The v0.1 exit target is
 * "p95 non-LLM query under 250 ms at one million accepted claims **on a published
 * reference machine**", and the assessment's completion rule is "repeatable benchmark
 * meets the target with hardware and concurrency declared". A run on somebody's laptop
 * therefore cannot close the block however good its numbers are: it can only be
 * evidence. This module encodes that distinction instead of leaving it to whoever
 * writes the summary, and it refuses to let the word "reference" appear on a machine
 * that was not declared as one.
 */
import type { BufferStats, HostFacts, PostgresFacts } from "./host.ts";
import type { TableCount } from "./load.ts";
import {
  compareToTarget,
  MIN_SAMPLES_FOR_P99,
  summarise,
  summariseContent,
  type ContentSummary,
  type LatencySummary,
  type Sample,
} from "./metrics.ts";
import type { TimeMode, WorkloadShape } from "./workload.ts";

export const REPORT_VERSION = "perf-benchmark@1";
export const TARGET_P95_MS = 250;
/** The claim count the v0.1 target names. */
export const TARGET_CLAIMS = 1_000_000;

export type CacheState = "cold" | "warm";

export interface ScenarioResult {
  readonly cache_state: CacheState;
  readonly label: string;
  readonly trace_writes: boolean;
  readonly started_at: string;
  readonly duration_ms: number;
  readonly by_mode: Readonly<Record<TimeMode, LatencySummary>>;
  readonly all: LatencySummary;
  readonly content: Readonly<Record<TimeMode, ContentSummary>>;
  readonly by_shape: readonly {
    readonly shape: string;
    readonly mode: TimeMode;
    readonly summary: LatencySummary;
  }[];
  readonly buffers: {
    readonly before: BufferStats;
    readonly after: BufferStats;
    readonly delta: BufferStats;
  };
}

export interface BenchmarkReport {
  readonly report_version: string;
  readonly generated_at: string;
  readonly commit: CommitFact;
  readonly node: { readonly version: string; readonly pg_library: string };
  readonly host: HostFacts;
  readonly postgres: PostgresFacts;
  readonly dataset: DatasetFact;
  readonly workload: WorkloadFact;
  readonly measurements: readonly ScenarioResult[];
  readonly target: TargetFact;
  readonly verdict: VerdictFact;
}

export interface CommitFact {
  readonly sha: string;
  readonly short: string;
  readonly branch: string | null;
  readonly dirty: boolean;
  readonly dirty_files: readonly string[];
  readonly note: string;
}

export interface DatasetFact {
  readonly tenant_slug: string;
  readonly tenant_id: string;
  readonly corpus_seed: string;
  readonly claims_requested: number;
  readonly claims_measured: number;
  readonly is_target_size: boolean;
  readonly generator: string;
  readonly generator_bypassed_write_path: true;
  readonly write_path_statement: string;
  readonly anchor: string;
  readonly load_elapsed_ms: number | null;
  readonly resumed_from: string | null;
  readonly counts: readonly TableCount[];
  readonly embedding: {
    readonly backend: string;
    readonly model_id: string;
    readonly dimensions: number;
    readonly is_model_call: boolean;
  };
  readonly scope_shape: {
    readonly project: string;
    readonly user_scopes: number;
    readonly purposes: readonly string[];
    readonly principal: string;
    readonly authorized_scope_ids: number;
    readonly reach_description: string;
  };
  readonly status_mix: Readonly<Record<string, number>>;
  /** Widths of the closed valid-time intervals, read back from the database. */
  readonly temporal_mix: {
    readonly distinct: readonly {
      readonly interval_days: number;
      readonly claims: number;
      readonly fraction_accepted: number;
    }[];
  };
  readonly historical_probe: {
    readonly as_of: string;
    readonly accepted_visible: number;
    readonly open_fraction: number;
  } | null;
  readonly sample_digest: { readonly digest: string; readonly sampled: number } | null;
}

export interface WorkloadFact {
  readonly mix: readonly WorkloadShape[];
  readonly per_mode_issued: Readonly<Record<TimeMode, number>>;
  readonly concurrency: number;
  readonly result_limit: number;
  readonly channel_fetch_limit: number;
  readonly fusion_limit: number;
  readonly requests_total: number;
  readonly requests_per_mode_per_pass: Readonly<Record<TimeMode, number>>;
  readonly warmup_requests: number;
  readonly query_text: string;
  readonly read_path: string;
  readonly model_calls_per_query: number;
  readonly cache_states: string;
}

export interface TargetFact {
  readonly statement: string;
  readonly target_p95_ms: number;
  readonly target_claims: number;
  readonly reference_machine_published: false;
  readonly reference_machine_note: string;
  readonly completion_rule: string;
}

export interface VerdictFact {
  readonly target_met_on_this_machine: boolean;
  readonly measured_dataset_size: number;
  readonly measured_dataset_is_target_size: boolean;
  readonly compared_against: "headline (warm cache, trace writes enabled)";
  readonly p95_ms_by_mode: Readonly<Record<TimeMode, number>>;
  readonly slowest_mode: TimeMode | null;
  readonly slowest_mode_p95_ms: number;
  readonly statement: string;
  readonly block_status: "evidence, not closure";
  readonly block_b7_closed: false;
  readonly why_not_closed: readonly string[];
  readonly what_this_does_not_measure: readonly string[];
}

export interface BuildReportInput {
  readonly generatedAt: string;
  readonly commit: CommitFact;
  readonly pgLibrary: string;
  readonly host: HostFacts;
  readonly postgres: PostgresFacts;
  readonly dataset: DatasetFact;
  readonly workload: WorkloadFact;
  readonly measurements: readonly ScenarioResult[];
  readonly referenceMachineDeclared: boolean;
}

/** Build the report object. All judgement lives in `verdict`, not scattered in prose. */
export function buildReport(input: BuildReportInput): BenchmarkReport {
  const headline = pickHeadline(input.measurements);
  const p95ByMode: Record<TimeMode, number> = {
    current: headline?.by_mode.current.p95_ms ?? Number.NaN,
    as_of: headline?.by_mode.as_of.p95_ms ?? Number.NaN,
    during: headline?.by_mode.during.p95_ms ?? Number.NaN,
  };
  const modes = (["current", "as_of", "during"] as const).filter((mode) => Number.isFinite(p95ByMode[mode]));
  const slowest = modes.length === 0
    ? null
    : modes.reduce((worst, mode) => (p95ByMode[mode] > p95ByMode[worst] ? mode : worst), modes[0] as TimeMode);
  const slowestP95 = slowest === null ? Number.NaN : p95ByMode[slowest];
  const met = modes.length > 0 && slowestP95 < TARGET_P95_MS;

  const smallSamples: string[] = [];
  for (const scenario of input.measurements) {
    for (const mode of ["current", "as_of", "during"] as const) {
      const summary = scenario.by_mode[mode];
      if (summary.n > 0 && summary.n < MIN_SAMPLES_FOR_P99) {
        smallSamples.push(`${scenario.cache_state}/${mode} has ${summary.n} samples`);
      }
    }
  }

  const whyNotClosed = [
    "The v0.1 target names a *published reference machine*; this run declares the machine it ran on but that machine is not published, provisioned or reproducible by a third party, so it cannot serve as the reference system the exit gate names.",
    input.referenceMachineDeclared
      ? "A reference machine was declared for this run, but no external party has reproduced these numbers on it."
      : "The run is on a laptop-class machine. A second party repeating the run would get a different CPU, so the result is evidence rather than a reference measurement.",
    `The dataset was produced by a synthetic bulk insert that bypasses the write path, so nothing here is evidence about the commit gate, extraction, review burden or outbox.`,
    ...(input.dataset.is_target_size
      ? []
      : [
          `The measured dataset is ${input.dataset.claims_measured.toLocaleString("en-US")} accepted claims, not the ${TARGET_CLAIMS.toLocaleString("en-US")} the target names.`,
        ]),
    ...(smallSamples.length > 0
      ? [`Some cells have fewer than ${MIN_SAMPLES_FOR_P99} samples, so their p99 is the largest observation rather than a percentile: ${smallSamples.join(", ")}.`]
      : []),
  ];

  const whatThisDoesNotMeasure = [
    "The write path: no gate decision, extraction or promotion was exercised. `decisions` and `claim_candidates` are empty for this tenant by construction.",
    "Embedding quality or the dense channel's recall: the embedding backend is the deterministic hash embedder, which is the repository default and is not a semantic model.",
    "LLM latency, cost or token counts. The default read path makes zero model calls, and the report asserts that per query rather than per run.",
    "Ingest latency, projection lag or outbox drain time. The Operations metric row in the specification asks for those too; this benchmark answers only the query-latency half.",
    "Concurrency beyond the declared level, and multi-tenant interference: one tenant is measured at a time.",
    "Deletion, retention or replay behaviour.",
    "An external ISO-date or network filesystem; PostgreSQL runs in a local container.",
  ];

  return {
    report_version: REPORT_VERSION,
    generated_at: input.generatedAt,
    commit: input.commit,
    node: { version: input.host.node_version, pg_library: input.pgLibrary },
    host: input.host,
    postgres: input.postgres,
    dataset: input.dataset,
    workload: input.workload,
    measurements: input.measurements,
    target: {
      statement:
        "p95 non-LLM query under 250 ms at one million accepted claims on a published reference machine",
      target_p95_ms: TARGET_P95_MS,
      target_claims: TARGET_CLAIMS,
      reference_machine_published: false,
      reference_machine_note:
        "This machine is declared in `host` but is NOT published as the v0.1 reference machine. The specification requires the target to be met on a published reference machine, so this run is evidence towards block B7 and does not close it.",
      completion_rule: "Repeatable benchmark meets the target with hardware and concurrency declared.",
    },
    verdict: {
      target_met_on_this_machine: met,
      measured_dataset_size: input.dataset.claims_measured,
      measured_dataset_is_target_size: input.dataset.is_target_size,
      compared_against: "headline (warm cache, trace writes enabled)",
      p95_ms_by_mode: p95ByMode,
      slowest_mode: slowest,
      slowest_mode_p95_ms: slowestP95,
      statement: verdictStatement(met, input.dataset.claims_measured),
      block_status: "evidence, not closure",
      block_b7_closed: false,
      why_not_closed: whyNotClosed,
      what_this_does_not_measure: whatThisDoesNotMeasure,
    },
  };
}

function pickHeadline(measurements: readonly ScenarioResult[]): ScenarioResult | null {
  return (
    measurements.find((scenario) => scenario.cache_state === "warm" && scenario.trace_writes) ??
    measurements.find((scenario) => scenario.cache_state === "warm") ??
    measurements[0] ??
    null
  );
}

function verdictStatement(met: boolean, claims: number): string {
  const size = `${claims.toLocaleString("en-US")} accepted claims`;
  if (met) {
    return (
      `The 250 ms p95 target is MET on this machine at ${size}, in every time mode, ` +
      `with warm caches and trace writes enabled. This does not close block B7: the target ` +
      `is stated against a published reference machine, and this host is not one.`
    );
  }
  return (
    `The 250 ms p95 target is NOT met on this machine at ${size}; at least one time mode ` +
    `exceeds it. The number is reported as measured, with the hardware and configuration that ` +
    `produced it, so it can be compared with a run on a declared reference machine.`
  );
}

export function summariseScenario(samples: readonly Sample[]): {
  readonly by_mode: Readonly<Record<TimeMode, LatencySummary>>;
  readonly all: LatencySummary;
  readonly content: Readonly<Record<TimeMode, ContentSummary>>;
  readonly by_shape: readonly { readonly shape: string; readonly mode: TimeMode; readonly summary: LatencySummary }[];
} {
  const modes: TimeMode[] = ["current", "as_of", "during"];
  const byMode: Record<TimeMode, LatencySummary> = {
    current: summarise(samples.filter((sample) => sample.mode === "current")),
    as_of: summarise(samples.filter((sample) => sample.mode === "as_of")),
    during: summarise(samples.filter((sample) => sample.mode === "during")),
  };
  const content: Record<TimeMode, ContentSummary> = {
    current: summariseContent(samples.filter((sample) => sample.mode === "current")),
    as_of: summariseContent(samples.filter((sample) => sample.mode === "as_of")),
    during: summariseContent(samples.filter((sample) => sample.mode === "during")),
  };
  const shapes = new Map<string, { mode: TimeMode; samples: Sample[] }>();
  for (const sample of samples) {
    const entry = shapes.get(sample.shape) ?? { mode: sample.mode, samples: [] };
    entry.samples.push(sample);
    shapes.set(sample.shape, entry);
  }
  return {
    by_mode: byMode,
    all: summarise(samples),
    content,
    by_shape: [...shapes.entries()]
      .map(([shape, entry]) => ({ shape, mode: entry.mode, summary: summarise(entry.samples) }))
      .sort((left, right) => left.shape.localeCompare(right.shape)),
  };
}

/** The human-readable summary. Printed to stdout and written next to the JSON. */
export function renderSummary(report: BenchmarkReport): string {
  const lines: string[] = [];
  const mode = (name: TimeMode): string => name.padEnd(7);
  const ms = (value: number): string => (Number.isFinite(value) ? value.toFixed(2).padStart(9) : "        —");

  lines.push("VerityMem one-million-claim query benchmark");
  lines.push(`  report      ${report.report_version}`);
  lines.push(`  generated   ${report.generated_at}`);
  lines.push(`  commit      ${report.commit.short}${report.commit.dirty ? " (working tree dirty)" : ""}  ${report.commit.note}`);
  lines.push("");
  lines.push("  THIS IS NOT A PUBLISHED REFERENCE MACHINE.");
  lines.push("  Block B7's completion rule names a published reference machine. This run reports the");
  lines.push("  machine it actually ran on and is evidence towards the block, not closure of it.");
  lines.push("");
  lines.push("  host");
  lines.push(`    cpu        ${report.host.cpu_model}`);
  lines.push(
    `    cores      ${report.host.cpu_cores_logical} logical` +
      (report.host.cpu_performance_cores !== null
        ? ` (${report.host.cpu_performance_cores}P + ${report.host.cpu_efficiency_cores ?? 0}E)`
        : "") +
      (report.host.cpu_cores_physical !== null ? `, ${report.host.cpu_cores_physical} physical` : ""),
  );
  lines.push(`    memory     ${report.host.ram_gb} GiB`);
  lines.push(`    os         ${report.host.os} (${report.host.os_version}), kernel ${report.host.kernel}, ${report.host.arch}`);
  lines.push(`    node       ${report.node.version}   pg driver ${report.node.pg_library}`);
  lines.push("");
  lines.push("  postgresql");
  lines.push(`    version    ${report.postgres.version.split(" on ")[0]}`);
  lines.push(`    pgvector   ${report.postgres.pgvector_version ?? "unknown"}`);
  lines.push(`    database   ${(report.postgres.database_size_bytes / 1024 ** 3).toFixed(2)} GiB total in this database`);
  for (const setting of [
    "shared_buffers",
    "work_mem",
    "maintenance_work_mem",
    "effective_cache_size",
    "max_connections",
    "random_page_cost",
    "synchronous_commit",
    "wal_level",
    "hnsw.ef_search",
  ]) {
    const value = report.postgres.settings[setting];
    if (value !== undefined) lines.push(`    ${setting.padEnd(24)} ${value}`);
  }
  for (const index of report.postgres.hnsw) {
    lines.push(
      `    hnsw       ${index.table_name}.${index.index_name} ${index.operator_class} ` +
        `m=${index.m ?? "?"} ef_construction=${index.ef_construction ?? "?"} ` +
        `${index.size_bytes === null ? "" : `${(index.size_bytes / 1024 ** 2).toFixed(1)} MiB`}`,
    );
  }
  lines.push("");
  lines.push("  dataset");
  lines.push(`    tenant     ${report.dataset.tenant_slug}`);
  lines.push(`    corpus     seed "${report.dataset.corpus_seed}", anchor ${report.dataset.anchor}`);
  lines.push(
    `    measured   ${report.dataset.claims_measured.toLocaleString("en-US")} accepted claims` +
      (report.dataset.is_target_size ? " (the target size)" : ` (NOT the ${TARGET_CLAIMS.toLocaleString("en-US")} the target names)`),
  );
  for (const count of report.dataset.counts) {
    lines.push(`      ${count.table.padEnd(18)} ${count.rows.toLocaleString("en-US").padStart(12)}`);
  }
  lines.push(
    `    embeddings ${report.dataset.embedding.model_id} (${report.dataset.embedding.dimensions} dims, ` +
      `${report.dataset.embedding.backend}${report.dataset.embedding.is_model_call ? ", model call" : ", local, no network"})`,
  );
  lines.push(
    `    scopes     ${report.dataset.scope_shape.user_scopes} user scopes + 1 project scope; ` +
      `caller reaches ${report.dataset.scope_shape.authorized_scope_ids}`,
  );
  if (report.dataset.load_elapsed_ms !== null) {
    lines.push(`    load       ${(report.dataset.load_elapsed_ms / 1000).toFixed(1)} s${report.dataset.resumed_from ? ` (resumed from ${report.dataset.resumed_from})` : ""}`);
  }
  lines.push("");
  lines.push("  workload");
  lines.push(`    path       ${report.workload.read_path}`);
  lines.push(`    concurrency ${report.workload.concurrency}   result limit ${report.workload.result_limit}   model calls/query ${report.workload.model_calls_per_query}`);
  lines.push(`    requests/pass ${report.workload.requests_per_mode_per_pass.current} current, ${report.workload.requests_per_mode_per_pass.as_of} as_of, ${report.workload.requests_per_mode_per_pass.during} during (${report.workload.requests_total} issued by the mix)`);
  lines.push("    mix");
  for (const shape of report.workload.mix) {
    lines.push(`      ${(shape.proportion * 100).toFixed(0).padStart(3)}%  ${shape.shape.padEnd(22)} ${shape.description}`);
  }
  lines.push("");
  lines.push("  measurements");
  lines.push("    mode    cache  n      p50       p90       p95       p99       max      mean    empty");
  for (const scenario of report.measurements) {
    for (const name of ["current", "as_of", "during"] as const) {
      const summary = scenario.by_mode[name];
      const content = scenario.content[name];
      lines.push(
        `    ${mode(name)} ${scenario.cache_state.padEnd(6)} ${String(summary.n).padStart(5)} ` +
          `${ms(summary.p50_ms)} ${ms(summary.p90_ms)} ${ms(summary.p95_ms)} ${ms(summary.p99_ms)} ` +
          `${ms(summary.max_ms)} ${ms(summary.mean_ms)}  ` +
          `${(content.empty_fraction * 100).toFixed(0).padStart(3)}%`,
      );
    }
    lines.push(
      `    ${"all".padEnd(7)} ${scenario.cache_state.padEnd(6)} ${String(scenario.all.n).padStart(5)} ` +
        `${ms(scenario.all.p50_ms)} ${ms(scenario.all.p90_ms)} ${ms(scenario.all.p95_ms)} ${ms(scenario.all.p99_ms)} ` +
        `${ms(scenario.all.max_ms)} ${ms(scenario.all.mean_ms)}`,
    );
    lines.push(
      `      ${scenario.label}: ${scenario.duration_ms} ms wall; trace writes ${scenario.trace_writes ? "on" : "off"}; ` +
        `buffer hit ratio ${fmtRatio(scenario.buffers.delta.hit_ratio)} ` +
        `(${scenario.buffers.delta.heap_blks_read + scenario.buffers.delta.idx_blks_read} block reads during the pass)`,
    );
    lines.push("      by shape:");
    for (const entry of scenario.by_shape) {
      lines.push(`        ${entry.shape.padEnd(24)} n=${String(entry.summary.n).padStart(5)} p50=${entry.summary.p50_ms.toFixed(2)} p95=${entry.summary.p95_ms.toFixed(2)} p99=${entry.summary.p99_ms.toFixed(2)}`);
    }
  }
  lines.push("");
  lines.push("  verdict");
  lines.push(`    target     ${report.target.statement}`);
  lines.push(`    met here   ${report.verdict.target_met_on_this_machine ? "YES" : "NO"}`);
  for (const name of ["current", "as_of", "during"] as const) {
    lines.push(`      p95 ${mode(name)} ${ms(report.verdict.p95_ms_by_mode[name])} ms`);
  }
  lines.push(`    ${report.verdict.statement}`);
  lines.push("");
  lines.push("  why this does not close block B7");
  for (const reason of report.verdict.why_not_closed) lines.push(`    - ${reason}`);
  lines.push("");
  lines.push("  what this does not measure");
  for (const item of report.verdict.what_this_does_not_measure) lines.push(`    - ${item}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function fmtRatio(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

export { compareToTarget };
