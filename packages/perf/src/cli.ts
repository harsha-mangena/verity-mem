/**
 * The benchmark CLI.
 *
 *     node --experimental-strip-types packages/perf/src/main.ts --claims 1000000
 *
 * Three subcommands, because loading a million rows and measuring against them are
 * separate acts with separate costs: `load` is idempotent and resumable, `bench` can
 * be re-run against an existing dataset in seconds, and `status` answers "how big is
 * the dataset right now" without touching it. Running load and bench together is the
 * default because that is what a fresh reader wants; `--skip-load` is what an
 * iterating one wants.
 *
 * The exit code is zero when the run completed, and non-zero only when it failed to
 * run. It deliberately does *not* encode whether the latency target was met. The
 * acceptance script runs this as a non-blocking step: a run that exited non-zero
 * because a laptop missed a 250 ms target would be dropped from the acceptance
 * output, and the point of running it there is to produce evidence. The verdict lives
 * in the report, where it can be read next to the hardware that produced it.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { loadEnv, resolveTenantId } from "@veritymem/ledger";
import { HashEmbeddingBackend } from "@veritymem/retrieval";
import { countAll, loadCorpus, syncStreams } from "./load.ts";
import { TARGET_CLAIMS } from "./report.ts";
import { defaultAnchor, runBenchmark } from "./run.ts";

export interface CliOptions {
  readonly command: "bench" | "load" | "status";
  readonly claims: number;
  readonly corpusSeed: string;
  readonly tenantSlug: string;
  readonly workloadSize: number;
  readonly concurrency: number;
  readonly limit: number;
  readonly warmupRequests: number;
  readonly skipLoad: boolean;
  readonly skipCold: boolean;
  readonly reportsDir: string;
  readonly stateDir: string;
  readonly anchor: Date | null;
  readonly referenceMachineDeclared: boolean;
}

export const USAGE = `VerityMem one-million-claim performance benchmark

Usage: node --experimental-strip-types packages/perf/src/main.ts [bench|load|status] [options]

  bench (default)      load if needed, then measure and write the report
  load                 load the corpus only
  status               print the row counts for the benchmark tenant

Dataset
  --claims <n>         accepted claims to generate (default ${TARGET_CLAIMS})
  --seed <text>        corpus seed (default "veritymem-perf-v1")
  --tenant <slug>      tenant slug. The tenant id is derived from it, so a fresh slug is
                       a fresh dataset and an existing one is reused.
                       (default "perf-bench-<seed>-<claims>")
  --anchor <iso>       corpus time anchor, e.g. 2026-09-17T00:00:00Z (default: now, to
                       the minute)
  --new-dataset        append a random suffix to the tenant slug; use this to keep an
                       earlier corpus in the same database

Measurement
  --workload <n>       requests per pass, split across the query mix (default 4000)
  --concurrency <n>    simultaneous in-flight compose() calls (default 4)
  --limit <n>          QueryRequest.limit, i.e. returned claims per packet (default 12)
  --warmup <n>         requests issued before a warm pass without being recorded (default 50)
  --skip-load          measure the dataset already in the database
  --skip-cold          skip the cold-cache pass (the warm pass is primed explicitly)

Output
  --reports <dir>      report directory (default <repo>/reports)
  --state <dir>        loader checkpoint directory (default <repo>/.veritymem/perf)
  --reference-machine  record that a reference machine was declared for this run. It does
                       NOT make the machine published; the report says so either way.
  -h, --help           this message
`;

export function parseArgs(argv: readonly string[]): CliOptions {
  const command: CliOptions["command"] =
    argv[0] === "load" || argv[0] === "status" ? argv[0] : "bench";
  const rest = command === "bench" && argv[0] !== "bench" ? argv : argv.slice(1);

  let claims = TARGET_CLAIMS;
  let corpusSeed = "veritymem-perf-v1";
  let tenantSlug: string | null = null;
  let workloadSize = 4_000;
  let concurrency = 4;
  let limit = 12;
  let warmupRequests = 50;
  let skipLoad = false;
  let skipCold = false;
  let reportsDir = resolve("reports");
  let stateDir = resolve(".veritymem/perf");
  let anchor: Date | null = null;
  let referenceMachineDeclared = false;
  let newDataset = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const next = (): string => {
      const value = rest[index + 1];
      if (value === undefined) throw new Error(`${String(arg)} needs a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--claims":
        claims = Number.parseInt(next(), 10);
        break;
      case "--seed":
        corpusSeed = next();
        break;
      case "--tenant":
        tenantSlug = next();
        break;
      case "--anchor": {
        const parsed = new Date(next());
        if (Number.isNaN(parsed.getTime())) throw new Error("--anchor must be an ISO instant");
        anchor = parsed;
        break;
      }
      case "--workload":
        workloadSize = Number.parseInt(next(), 10);
        break;
      case "--concurrency":
        concurrency = Number.parseInt(next(), 10);
        break;
      case "--limit":
        limit = Number.parseInt(next(), 10);
        break;
      case "--warmup":
        warmupRequests = Number.parseInt(next(), 10);
        break;
      case "--reports":
        reportsDir = resolve(next());
        break;
      case "--state":
        stateDir = resolve(next());
        break;
      case "--skip-load":
        skipLoad = true;
        break;
      case "--skip-cold":
        skipCold = true;
        break;
      case "--reference-machine":
        referenceMachineDeclared = true;
        break;
      case "--new-dataset":
        newDataset = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option ${String(arg)}`);
    }
  }

  if (!Number.isFinite(claims) || claims < 1) throw new Error("--claims must be a positive integer");
  if (!Number.isFinite(workloadSize) || workloadSize < 30) {
    throw new Error("--workload must be at least 30 so every time mode gets a usable sample count");
  }
  if (!Number.isFinite(concurrency) || concurrency < 1) throw new Error("--concurrency must be >= 1");
  if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
    throw new Error("--limit must be 1..100 (the contract's maximum)");
  }
  if (!Number.isFinite(warmupRequests) || warmupRequests < 0) throw new Error("--warmup must be >= 0");

  return {
    command,
    claims,
    corpusSeed,
    tenantSlug:
      tenantSlug ??
      (newDataset
        ? `perf-bench-${corpusSeed}-${claims}-${randomBytes(3).toString("hex")}`
        : `perf-bench-${corpusSeed}-${claims}`),
    workloadSize,
    concurrency,
    limit,
    warmupRequests,
    skipLoad,
    skipCold,
    reportsDir,
    stateDir,
    anchor,
    referenceMachineDeclared,
  };
}

/** Run the CLI. Returns the process exit code. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  const env = loadEnv();
  const log = (message: string): void => {
    process.stdout.write(`${message}\n`);
  };
  const anchor = defaultAnchor(options.anchor);
  const statePath = resolve(options.stateDir, `${options.tenantSlug}.load-state.json`);
  const migrationUrl = env.migrationDatabaseUrl ?? env.databaseUrl;
  const tenantId = resolveTenantId(options.tenantSlug);
  const backend = new HashEmbeddingBackend({
    dimensions: env.embedding.dimensions,
    modelId: env.embedding.modelId,
  });

  if (options.command === "status") {
    const counts = await countAll(migrationUrl, tenantId);
    log(`tenant ${options.tenantSlug} (${tenantId})`);
    for (const count of counts) log(`  ${count.table.padEnd(18)} ${count.rows.toLocaleString("en-US")}`);
    return 0;
  }

  if (options.command === "load") {
    const loaded = await loadCorpus({
      migrationUrl,
      tenantId,
      tenantSlug: options.tenantSlug,
      claims: options.claims,
      corpusSeed: options.corpusSeed,
      anchor,
      embeddingModelId: backend.model_id,
      embeddingDimensions: backend.dimensions,
      statePath,
      onProgress: (progress) => {
        log(
          `  ${progress.phase.padEnd(15)} ${progress.done.toLocaleString("en-US").padStart(9)}/` +
            `${progress.total.toLocaleString("en-US")}  ${(progress.elapsed_ms / 1000).toFixed(0)}s  ` +
            `${progress.rows_per_second.toLocaleString("en-US")} rows/s`,
        );
      },
    });
    await syncStreams(migrationUrl, loaded.tenant_id);
    log(`loaded in ${(loaded.elapsed_ms / 1000).toFixed(1)} s`);
    for (const count of loaded.counts) log(`  ${count.table.padEnd(18)} ${count.rows.toLocaleString("en-US")}`);
    return 0;
  }

  const outcome = await runBenchmark({
    claims: options.claims,
    corpusSeed: options.corpusSeed,
    tenantSlug: options.tenantSlug,
    workloadSize: options.workloadSize,
    concurrency: options.concurrency,
    limit: options.limit,
    warmupRequests: options.warmupRequests,
    skipLoad: options.skipLoad,
    skipCold: options.skipCold,
    statePath,
    reportsDir: options.reportsDir,
    blobDir: resolve(".veritymem/blobs"),
    anchor: options.anchor,
    referenceMachineDeclared: options.referenceMachineDeclared,
    log,
  });

  process.stdout.write(`\n${outcome.summary}`);
  process.stdout.write(`\nreport:  ${outcome.jsonPath}\nsummary: ${outcome.summaryPath}\n`);
  return outcome.exitCode;
}
