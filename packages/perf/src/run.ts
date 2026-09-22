/**
 * The benchmark run.
 *
 * The order is: load (or detect) the dataset, read the facts, issue a declared
 * workload against it through the real `compose()` read path, write the report. Each
 * of those is delegated to its own module; this file is the orchestration and the
 * decisions about *what* is measured, which are worth stating because they are the
 * decisions a reader would otherwise have to guess at.
 *
 * ## What is measured, exactly
 *
 * * The read path is `compose()` from `@veritymem/retrieval`, on an RLS-bound
 *   application connection, as the participating principal. No hand-written SQL
 *   stands in for it, because the interesting costs — the planner's scope
 *   resolution, four channels, rank fusion, evidence re-verification, the use
 *   policy, the trace write — exist only in that call.
 * * Latency is wall-clock around the `await compose(...)`, in microseconds, taken on
 *   the issuing process. It therefore includes connection-pool checkout, planning,
 *   the two bounded retrieval lanes, hydration and the `query_traces` insert, because
 *   `compose()` writes one and it cannot be turned off without editing
 *   `packages/retrieval` — which this task explicitly forbids. The number of trace
 *   rows written is reported so the contribution is visible and bounded rather than
 *   unknown.
 * * `cold` and `warm` are **cache states of this process's pool**, and the buffer
 *   counters for each pass are reported so the claim is evidenced: a cold pass runs
 *   on a pool that has issued no query, a warm pass re-issues shapes already seen
 *   while the preceding pass ran. Neither state drops the operating system's page
 *   cache or the server's shared buffers — doing that needs root, and pretending to
 *   have done it would be worse than saying so.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";
import {
  Db,
  FilesystemBlobStore,
  Ledger,
  loadEnv,
  resolveTenantId,
  systemClock,
  systemIds,
} from "@veritymem/ledger";
import { HashEmbeddingBackend, compose } from "@veritymem/retrieval";
import {
  BENCH_PRINCIPAL,
  BENCH_PROJECT,
  BENCH_PURPOSE,
  BENCH_USER_COUNT,
} from "./corpus.ts";
import {
  readBufferStats,
  readHostFacts,
  readPgLibraryVersion,
  readPostgresFacts,
  type BufferStats,
} from "./host.ts";
import { corpusDigest, countAll, loadCorpus, syncStreams, type TableCount } from "./load.ts";
import {
  buildReport,
  renderSummary,
  summariseScenario,
  type BenchmarkReport,
  type CacheState,
  type DatasetFact,
  type ScenarioResult,
} from "./report.ts";
import type { Sample } from "./metrics.ts";
import { buildWorkload, type TimeMode, type WorkloadPlan } from "./workload.ts";

const { Pool } = pg;

export interface RunOptions {
  readonly claims: number;
  readonly corpusSeed: string;
  readonly tenantSlug: string;
  readonly workloadSize: number;
  readonly concurrency: number;
  readonly limit: number;
  readonly warmupRequests: number;
  readonly skipLoad: boolean;
  readonly skipCold: boolean;
  readonly statePath: string;
  readonly reportsDir: string;
  readonly blobDir: string;
  readonly anchor: Date | null;
  readonly referenceMachineDeclared: boolean;
  /**
   * Overrides for the connection strings. Set when the benchmark is pointed at an
   * isolated database; left unset for the reference database from `.env`.
   */
  readonly databaseUrl?: string;
  readonly migrationUrl?: string;
  readonly log: (message: string) => void;
}

export interface RunOutcome {
  readonly report: BenchmarkReport;
  readonly summary: string;
  readonly jsonPath: string;
  readonly summaryPath: string;
  readonly exitCode: number;
}

/**
 * Anchor of the corpus's time axis.
 *
 * A fixed instant by default, not "now". The anchor defines every `as_of` instant and
 * `during` window the workload issues, and it is recorded in the report as part of the
 * dataset's identity — so a run next week against the same dataset must use the same
 * anchor or it is asking a different question of the same rows. `--anchor now` is
 * available for someone who deliberately wants the corpus to end today.
 */
export function defaultAnchor(explicit: Date | null): Date {
  if (explicit !== null) return explicit;
  return new Date(DEFAULT_ANCHOR);
}

/** The anchor used when `--anchor` is not given. Immutable, so the corpus is reproducible. */
export const DEFAULT_ANCHOR = "2026-09-17T12:00:00.000Z";

export async function runBenchmark(options: RunOptions): Promise<RunOutcome> {
  const env = loadEnv();
  const migrationUrl = options.migrationUrl ?? env.migrationDatabaseUrl ?? env.databaseUrl;
  const databaseUrl = options.databaseUrl ?? env.databaseUrl;
  const tenantId = resolveTenantId(options.tenantSlug);
  const anchor = defaultAnchor(options.anchor);
  const backend = new HashEmbeddingBackend({
    dimensions: env.embedding.dimensions,
    modelId: env.embedding.modelId,
  });
  const embedding = { backend, modelId: backend.model_id, dimensions: backend.dimensions };

  options.log(`tenant      ${options.tenantSlug} (${tenantId})`);
  options.log(`corpus      seed "${options.corpusSeed}", anchor ${anchor.toISOString()}`);
  options.log(`embedding   ${embedding.modelId} (${embedding.dimensions} dims)`);

  let loadElapsed: number | null = null;
  let resumedFrom: string | null = null;
  if (!options.skipLoad) {
    options.log(`loading ${options.claims.toLocaleString("en-US")} claims ...`);
    let lastLog = 0;
    const loaded = await loadCorpus({
      migrationUrl,
      tenantId,
      tenantSlug: options.tenantSlug,
      claims: options.claims,
      corpusSeed: options.corpusSeed,
      anchor,
      embeddingModelId: embedding.modelId,
      embeddingDimensions: embedding.dimensions,
      statePath: options.statePath,
      onProgress: (progress) => {
        // One line per phase. A million-row load emits thousands of batches, and a
        // wall of progress lines is not progress — the phase boundary is the useful
        // signal, and a stalled load is diagnosed with `status`, not by scrolling.
        if (progress.done < progress.total) return;
        lastLog = Date.now();
        options.log(
          `  ${progress.phase.padEnd(15)} ${progress.done.toLocaleString("en-US").padStart(9)} claims  ` +
            `${(progress.elapsed_ms / 1000).toFixed(1)}s  ` +
            `${progress.rows_per_second.toLocaleString("en-US")} claims/s`,
        );
      },
    });
    loadElapsed = loaded.elapsed_ms;
    resumedFrom = loaded.resumed_from;
    options.log(`load done   ${(loaded.elapsed_ms / 1000).toFixed(1)} s`);
    await syncStreams(migrationUrl, tenantId);
  }

  const counts = await countAll(migrationUrl, tenantId);
  const claimsMeasured = counts.find((entry) => entry.table === "claims")?.rows ?? 0;
  if (claimsMeasured === 0) {
    throw new Error(
      `tenant ${options.tenantSlug} holds no claims; run without --skip-load, or check that the ` +
        `tenant slug and corpus seed match the dataset that was loaded`,
    );
  }
  options.log(`dataset     ${claimsMeasured.toLocaleString("en-US")} claims`);

  const workload = buildWorkload({
    total: options.workloadSize,
    limit: options.limit,
    corpusSeed: options.tenantSlug,
    tenantId,
    anchor,
  });

  const db = new Db({
    connectionString: databaseUrl,
    // `compose()` has two bounded read lanes (ordinary and dense). Size for both
    // so a benchmark measures the database rather than self-inflicted pool waits.
    max: Math.max(2, options.concurrency * 2),
    applicationName: "veritymem-perf-benchmark",
  });
  // A pooled connection can be closed under us — an operator restarting PostgreSQL, a
  // container being recycled — and `pg` emits `error` on the pool for an *idle* client.
  // Without a listener that is an unhandled 'error' event and the process dies with a
  // stack trace instead of reporting how many samples it had already taken.
  const poolErrors: string[] = [];
  db.pool.on("error", (error: Error) => {
    poolErrors.push(error.message);
  });
  const startPoolErrors = poolErrors.length;
  // `compose()` needs a ledger for evidence re-verification. It is the real one, with a
  // memory blob store because this corpus writes every payload inline; the read path
  // never touches a blob unless an event has a payload_ref, and asserting that here
  // would mean inventing a second code path to measure.
  const ledger = new Ledger({
    db,
    blobs: new FilesystemBlobStore(options.blobDir),
    clock: systemClock,
    ids: systemIds,
  });
  const dependencies = {
    db,
    ledger,
    embeddings: backend,
    ids: systemIds,
    clock: systemClock,
    gateBackend: "perf-benchmark (no gate: synthetic corpus)",
  };

  const measurements: ScenarioResult[] = [];
  let postgres;
  try {
    const factsClient = await db.pool.connect();
    try {
      postgres = await readPostgresFacts(factsClient);
    } finally {
      factsClient.release();
    }

    const passes: { state: CacheState; label: string }[] = [];
    if (!options.skipCold) {
      passes.push({
        state: "cold",
        label: "fresh pool, no query issued by this process yet; server buffers and OS page cache not dropped",
      });
    }
    passes.push({
      state: "warm",
      label: "pool, plan caches and buffers primed by the preceding passes; workload re-issued",
    });

    let primed = !options.skipCold;
    for (const pass of passes) {
      if (!primed && pass.state === "warm") {
        // No cold pass ran, so "warm" would be an unearned label. Warm it explicitly
        // with a half-size priming pass that is not measured.
        await warmUp(
          dependencies,
          workload,
          Math.max(1, Math.floor(workload.requests.length / 2)),
          options.log,
        );
        primed = true;
      }
      const result = await issuePass(db, dependencies, workload, {
        concurrency: options.concurrency,
        warmupRequests: pass.state === "cold" ? 0 : options.warmupRequests,
        log: options.log,
        label: pass.label,
        poolErrors,
      });
      measurements.push({ ...result, cache_state: pass.state, label: pass.label });
    }
  } finally {
    await db.close();
  }

  const digest = await corpusDigest(migrationUrl, tenantId, 2_000);
  const dataset = await buildDatasetFact({
    migrationUrl,
    tenantSlug: options.tenantSlug,
    tenantId,
    corpusSeed: options.corpusSeed,
    anchor,
    claimsRequested: options.claims,
    claimsMeasured,
    counts,
    loadElapsed,
    resumedFrom,
    embeddingModelId: embedding.modelId,
    embeddingDimensions: embedding.dimensions,
    digest,
  });

  const report = buildReport({
    generatedAt: new Date().toISOString(),
    commit: readCommitFact(),
    pgLibrary: readPgLibraryVersion(),
    host: readHostFacts(),
    postgres,
    dataset,
    workload: {
      mix: workload.mix,
      per_mode_issued: workload.per_mode,
      concurrency: options.concurrency,
      result_limit: options.limit,
      channel_fetch_limit: Math.max(options.limit * 4, 24),
      fusion_limit: options.limit * 3,
      requests_total: workload.requests.length,
      requests_per_mode_per_pass: workload.per_mode,
      warmup_requests: options.warmupRequests,
      query_text: "distinct text per request, drawn from the corpus vocabulary (see workload.ts queryTextFor)",
      read_path:
        "compose(deps, QueryRequest, { principal }) from @veritymem/retrieval on an RLS-bound application connection, default non-reranked path, query trace written",
      model_calls_per_query: 0,
      cache_states:
        "cold = pool that has issued no query in this process; warm = pool, plan caches and buffers primed by the " +
        "preceding pass. Neither state drops the server's shared buffers or the OS page cache; per-pass buffer " +
        "read/hit counters are reported instead so the state is evidenced rather than asserted.",
    },
    measurements,
    referenceMachineDeclared: options.referenceMachineDeclared,
  });

  const summary = renderSummary(report);
  const jsonPath = `${options.reportsDir}/perf-benchmark.json`;
  const summaryPath = `${options.reportsDir}/perf-benchmark.txt`;
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(summaryPath, summary, "utf8");

  return {
    report,
    summary,
    jsonPath,
    summaryPath,
    // Zero exit code when the run completed. It deliberately does NOT encode "the
    // target was met": a benchmark that exits non-zero because a laptop missed a
    // target is a benchmark that gets dropped from the acceptance run, and the point
    // of running it there is to produce evidence, not a green tick.
    exitCode: 0,
  };
}

interface RetrievalDependenciesLike {
  readonly db: Db;
  readonly ledger: Ledger;
  readonly embeddings: HashEmbeddingBackend;
  readonly ids: typeof systemIds;
  readonly clock: typeof systemClock;
  readonly gateBackend: string;
}

interface PassOptions {
  readonly concurrency: number;
  readonly warmupRequests: number;
  readonly log: (message: string) => void;
  readonly label?: string;
  readonly poolErrors: readonly string[];
}

/**
 * Prime the caches, for a run that skips the cold pass.
 *
 * Errors are swallowed on purpose. A priming request that times out has told us the
 * corpus is slow, which is the measurement's business and not a reason to abort before
 * the measurement starts; the recorded pass will hit the same query and record it.
 */
async function warmUp(
  dependencies: RetrievalDependenciesLike,
  workload: WorkloadPlan,
  count: number,
  log: (message: string) => void,
): Promise<void> {
  for (const entry of workload.requests.slice(0, count)) {
    try {
      await compose(dependencies, entry.request, { principal: BENCH_PRINCIPAL });
    } catch (error) {
      log(`warmup      ${entry.shape} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Run one pass over the workload at the declared concurrency and return its samples.
 *
 * Concurrency is N independent workers pulling from a shared cursor, which is what a
 * service does under N simultaneous callers. The caller sizes the pool for the two
 * bounded connections each compose may use, so the measurement includes database
 * contention without accidentally serialising the dense lane behind its own request.
 */
async function issuePass(
  db: Db,
  dependencies: RetrievalDependenciesLike,
  workload: WorkloadPlan,
  options: PassOptions,
): Promise<Omit<ScenarioResult, "cache_state" | "label">> {
  const warmup = workload.requests.slice(0, Math.min(options.warmupRequests, workload.requests.length));
  for (const entry of warmup) {
    await compose(dependencies, entry.request, { principal: BENCH_PRINCIPAL });
  }

  const before = await bufferStats(db);
  const poolErrorBase = options.poolErrors.length;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const samples: Sample[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const entry = workload.requests[index];
      if (!entry) return;
      const atSeconds = (performance.now() - started) / 1000;
      const requestStarted = performance.now();
      try {
        const result = await compose(dependencies, entry.request, { principal: BENCH_PRINCIPAL });
        const latency = (performance.now() - requestStarted) * 1000;
        samples.push({
          position: entry.position,
          mode: entry.mode,
          shape: entry.shape,
          latency_us: latency,
          returned: result.packet.claims.length,
          candidates_considered: result.packet.coverage.candidates_considered,
          decision: result.packet.decision,
          empty: result.packet.claims.length === 0,
          error: null,
          at_s: atSeconds,
          channels: Object.fromEntries(
            result.channels.map((channel) => [channel.channel, channel.duration_ms]),
          ),
        });
      } catch (error) {
        // Recorded, not dropped. A request that hit the server's `statement_timeout`
        // is a latency observation, and the alternative — letting it kill the pass —
        // loses every sample already taken. The elapsed time is kept, so the errored
        // sample sits in the distribution at the timeout value it actually reached,
        // and the per-mode error count says how many did.
        samples.push({
          position: entry.position,
          mode: entry.mode,
          shape: entry.shape,
          latency_us: (performance.now() - requestStarted) * 1000,
          returned: 0,
          candidates_considered: 0,
          decision: "error",
          empty: true,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          at_s: atSeconds,
          channels: {},
        });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, () => worker()));
  const durationMs = performance.now() - started;
  const after = await bufferStats(db);
  const summary = summariseScenario(samples);

  options.log(
    `pass        ${options.label ?? ""} — ${samples.length} samples in ${durationMs.toFixed(0)} ms`,
  );

  return {
    trace_writes: true,
    started_at: startedAt,
    duration_ms: Math.round(durationMs),
    by_mode: summary.by_mode,
    all: summary.all,
    content: summary.content,
    by_shape: summary.by_shape,
    channels: summary.channels,
    buffers: { before, after, delta: diffBuffers(before, after) },
    pool_errors: [...options.poolErrors].slice(poolErrorBase),
  };
}

async function bufferStats(db: Db): Promise<BufferStats> {
  const client = await db.pool.connect();
  try {
    return await readBufferStats(client);
  } finally {
    client.release();
  }
}

function diffBuffers(before: BufferStats, after: BufferStats): BufferStats {
  const heapRead = after.heap_blks_read - before.heap_blks_read;
  const heapHit = after.heap_blks_hit - before.heap_blks_hit;
  const idxRead = after.idx_blks_read - before.idx_blks_read;
  const idxHit = after.idx_blks_hit - before.idx_blks_hit;
  const hits = heapHit + idxHit;
  const reads = heapRead + idxRead;
  return {
    heap_blks_read: heapRead,
    heap_blks_hit: heapHit,
    idx_blks_read: idxRead,
    idx_blks_hit: idxHit,
    hit_ratio: reads + hits === 0 ? null : hits / (reads + hits),
  };
}

interface DatasetFactInput {
  readonly migrationUrl: string;
  readonly tenantSlug: string;
  readonly tenantId: string;
  readonly corpusSeed: string;
  readonly anchor: Date;
  readonly claimsRequested: number;
  readonly claimsMeasured: number;
  readonly counts: readonly TableCount[];
  readonly loadElapsed: number | null;
  readonly resumedFrom: string | null;
  readonly embeddingModelId: string;
  readonly embeddingDimensions: number;
  readonly digest: { readonly digest: string; readonly sampled: number };
}

async function buildDatasetFact(input: DatasetFactInput): Promise<DatasetFact> {
  const probe = await probeTemporalShape(input.migrationUrl, input.tenantSlug, input.anchor.getTime());
  // Read the accepted count back from the database rather than deriving it from the
  // generator's stated 21/25 mix: the target is stated in accepted claims, so the
  // number that decides "is this the target size" has to be a measurement.
  const acceptedClaims = probe.status_mix["accepted"] ?? 0;
  return {
    tenant_slug: input.tenantSlug,
    tenant_id: input.tenantId,
    corpus_seed: input.corpusSeed,
    claims_requested: input.claimsRequested,
    claims_measured: input.claimsMeasured,
    accepted_claims: acceptedClaims,
    accepted_claims_target: 1_000_000,
    is_target_size: acceptedClaims >= 1_000_000,
    generator: "packages/perf/src/corpus.ts (deterministic, seeded per claim index)",
    generator_bypassed_write_path: true,
    write_path_statement:
      "Rows were inserted directly by packages/perf/src/load.ts under veritymem.set_system_context. " +
      "No Ledger.append, no extraction, no commit gate, no outbox: this dataset measures the READ path only " +
      "and proves nothing about promotion. decisions and claim_candidates are empty for this tenant by construction.",
    anchor: input.anchor.toISOString(),
    load_elapsed_ms: input.loadElapsed,
    resumed_from: input.resumedFrom,
    counts: input.counts,
    embedding: {
      backend: "HashEmbeddingBackend (@veritymem/retrieval)",
      model_id: input.embeddingModelId,
      dimensions: input.embeddingDimensions,
      is_model_call: false,
    },
    scope_shape: {
      project: BENCH_PROJECT,
      user_scopes: BENCH_USER_COUNT,
      purposes: [BENCH_PURPOSE],
      principal: BENCH_PRINCIPAL,
      authorized_scope_ids: BENCH_USER_COUNT + 1,
      reach_description:
        "The caller participates in the project scope and requests the project scope only, so it reaches the " +
        "project scope plus every user scope inside it. That is the widest realistic reach and the honest " +
        "worst case for the pre-retrieval authorization filter.",
    },
    status_mix: probe.status_mix,
    temporal_mix: probe.temporal_mix,
    historical_probe: probe.historical_probe,
    sample_digest: input.digest,
  };
}

interface TemporalProbe {
  readonly status_mix: Record<string, number>;
  readonly temporal_mix: DatasetFact["temporal_mix"];
  readonly historical_probe: DatasetFact["historical_probe"];
}

/**
 * Ask the database what the corpus's time axis actually looks like.
 *
 * The corpus is *designed* to have open and closed intervals in a known proportion, and
 * a design is not a measurement. These probes read the distribution back, because the
 * `as_of` and `during` percentiles are only meaningful if those queries really do
 * return a historical set rather than the whole table under a different predicate.
 */
async function probeTemporalShape(
  migrationUrl: string,
  tenantSlug: string,
  anchorMs: number,
): Promise<TemporalProbe> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  const tenantId = resolveTenantId(tenantSlug);
  try {
    const status = await pool.query<{ status: string; n: number }>(
      `SELECT status::text AS status, count(*)::int AS n
         FROM claims WHERE tenant_id = $1::uuid GROUP BY 1 ORDER BY 1`,
      [tenantId],
    );
    const statusMix: Record<string, number> = {};
    for (const row of status.rows) statusMix[row.status] = Number(row.n);

    const asOf = new Date(anchorMs - 2 * 86_400_000).toISOString();
    const distinct = await pool.query<{ days: number; n: number; accepted: number }>(
      `SELECT GREATEST(1, round(EXTRACT(EPOCH FROM (valid_to - valid_from)) / 86400))::int AS days,
              count(*)::int AS n,
              count(*) FILTER (WHERE status = 'accepted')::int AS accepted
         FROM claims
        WHERE tenant_id = $1::uuid AND valid_to IS NOT NULL
        GROUP BY 1 ORDER BY 1`,
      [tenantId],
    );
    const historical = await pool.query<{ accepted: number; open_claims: number; total: number }>(
      `SELECT count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
              count(*) FILTER (WHERE valid_to IS NULL)::int AS open_claims,
              count(*)::int AS total
         FROM claims
        WHERE tenant_id = $1::uuid AND recorded_at <= $2::timestamptz
          AND (valid_to IS NULL OR valid_to > $2::timestamptz)
          AND status IN ('accepted','superseded','expired')`,
      [tenantId, asOf],
    );
    const historicalRow = historical.rows[0];
    return {
      status_mix: statusMix,
      temporal_mix: {
        distinct: distinct.rows.map((row) => ({
          interval_days: Number(row.days),
          claims: Number(row.n),
          fraction_accepted: round4(Number(row.accepted) / Math.max(1, Number(row.n))),
        })),
      },
      historical_probe: historicalRow
        ? {
            as_of: asOf,
            accepted_visible: Number(historicalRow.accepted),
            open_fraction: round4(
              Number(historicalRow.open_claims) / Math.max(1, Number(historicalRow.total)),
            ),
          }
        : null,
    };
  } finally {
    await pool.end();
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * The exact commit, and whether the tree it was measured from was clean.
 *
 * A dirty tree makes a measurement unattributable: the commit alone would not
 * reconstruct the code that produced the number. The changed paths are recorded so the
 * discrepancy is visible rather than argued about.
 */
export function readCommitFact(): {
  readonly sha: string;
  readonly short: string;
  readonly branch: string | null;
  readonly dirty: boolean;
  readonly dirty_files: readonly string[];
  readonly note: string;
} {
  const git = (args: readonly string[]): string | null => {
    try {
      return execFileSync("git", [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const sha = git(["rev-parse", "HEAD"]) ?? "unknown";
  const status = git(["status", "--porcelain"]) ?? "";
  const dirtyFiles = status
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\S+\s+/, ""));
  return {
    sha,
    short: sha.slice(0, 7),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: dirtyFiles.length > 0,
    dirty_files: dirtyFiles,
    note:
      dirtyFiles.length > 0
        ? "measured from a working tree with uncommitted changes; the commit alone does not reconstruct this measurement"
        : "measured from a clean working tree at the recorded commit",
  };
}

export type { TimeMode };
