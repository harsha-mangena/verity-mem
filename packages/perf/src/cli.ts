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
import { bootstrapDatabase } from "./isolated.ts";
import { countAll, loadCorpus, syncStreams } from "./load.ts";
import { TARGET_CLAIMS } from "./report.ts";
import { DEFAULT_ANCHOR, defaultAnchor, runBenchmark } from "./run.ts";

export interface CliOptions {
  readonly command: "bench" | "load" | "status" | "isolated";
  readonly claims: number;
  /** Accepted claims the corpus was sized from, or null when `--claims` set the size directly. */
  readonly acceptedRequested: number | null;
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
  /** Superuser connection used by `isolated` to create the benchmark database. */
  readonly adminUrl: string;
  readonly isolatedDatabase: string;
  readonly fastEmbed: boolean;
  /** Explicit connection overrides; unset means "use .env". */
  readonly databaseUrl: string | null;
  readonly migrationUrl: string | null;
  readonly migrationsDir: string | null;
}

/**
 * Fraction of generated claims that carry an open valid-time interval, i.e. that a
 * `current` query can see. The corpus's status mix is fixed at 21/25 accepted and 4/25
 * superseded, so this constant is derived from that and not tuned per run.
 */
export const OPEN_CLAIM_FRACTION = 21 / 25;

/**
 * The tenant slug a corpus lives under.
 *
 * Keyed on the *corpus size*, not on how the size was requested. `--accepted 1000000`
 * and `--claims 1190477` name the same corpus, so they must resolve to the same tenant
 * or the second command silently measures an empty dataset — which is exactly what
 * happened on the first attempt at this benchmark, because `--accepted` rounded the size
 * up to a number the plain `--claims` form did not produce.
 */
export function corpusSlug(corpusSeed: string, claims: number): string {
  return `perf-bench-${corpusSeed}-${claims}`;
}

export const USAGE = `VerityMem one-million-claim performance benchmark

Usage: node --experimental-strip-types packages/perf/src/main.ts [bench|load|status] [options]

  bench (default)      load if needed, then measure and write the report
  load                 load the corpus only
  status               print the row counts for the benchmark tenant
  isolated             create and migrate a benchmark-only database, then exit. Use this
                       when the shared database already holds other corpora: the HNSW
                       index is global, so a tenant sharing it with unrelated vectors
                       measures its neighbours as well as itself.

Dataset
  --claims <n>         total claims in the corpus (default ${TARGET_CLAIMS}). Roughly 84%
                       of them are open intervals and 16% are closed, so a corpus of
                       ${TARGET_CLAIMS} holds about ${Math.round(TARGET_CLAIMS * 0.84 / 1000)}k currently-accepted claims and a
                       historical tail for the as_of and during modes. Use --accepted
                       to size the corpus from the accepted count instead.
  --seed <text>        corpus seed (default "veritymem-perf-v1")
  --tenant <slug>      tenant slug. The tenant id is derived from it, so a fresh slug is
                       a fresh dataset and an existing one is reused.
                       (default "perf-bench-<seed>-<claims>")
  --anchor <iso|now>   corpus time anchor. Default ${DEFAULT_ANCHOR} — a fixed
                       instant, because the anchor defines every as_of and during query
                       in the workload and must not drift between runs.
  --new-dataset        append a random suffix to the tenant slug; use this to keep an
                       earlier corpus in the same database

Measurement
  --workload <n>       requests per pass, split across the query mix (default 4000)
  --concurrency <n>    simultaneous in-flight compose() calls (default 4)
  --limit <n>          QueryRequest.limit, i.e. returned claims per packet (default 12)
  --warmup <n>         requests issued before a warm pass without being recorded (default 50)
  --skip-load          measure the dataset already in the database
  --skip-cold          skip the cold-cache pass (the warm pass is primed explicitly)
  --fast-embed         drop the HNSW index while the embeddings load and rebuild it once
                       afterwards, instead of maintaining it per insert. The final schema
                       is identical; only the loading time changes.

Output
  --reports <dir>      report directory (default <repo>/reports)
  --state <dir>        loader checkpoint directory (default <repo>/.veritymem/perf)
  --reference-machine  record that a reference machine was declared for this run. It does
                       NOT make the machine published; the report says so either way.

Where the benchmark runs
  --db-url <url>       read path connection (RLS-bound application role)
  --migration-url <url> loader and fact-reading connection (owner role)
  --admin-url <url>    superuser connection used by the isolated command (default: the
                       .env migration URL)
  --database <name>    name for the isolated database (default veritymem_perf)
  --migrations <dir>   migrations directory for the isolated command (default <repo>/migrations)

  -h, --help           this message
`;

export function parseArgs(argv: readonly string[]): CliOptions {
  const command: CliOptions["command"] =
    argv[0] === "load" || argv[0] === "status" || argv[0] === "isolated" ? argv[0] : "bench";
  const rest = command === "bench" && argv[0] !== "bench" ? argv : argv.slice(1);

  let claims = TARGET_CLAIMS;
  let acceptedRequested: number | null = null;
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
  let adminUrl: string | null = null;
  let isolatedDatabase = "veritymem_perf";
  let fastEmbed = false;
  let databaseUrl: string | null = null;
  let migrationUrl: string | null = null;
  let migrationsDir: string | null = null;

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
        acceptedRequested = null;
        break;
      case "--accepted":
        acceptedRequested = Number.parseInt(next(), 10);
        // The corpus keeps a 16% closed-interval tail so that `as_of` and `during`
        // have a genuinely different row set to find. A caller who asks for N
        // accepted claims therefore gets a corpus of N / 0.84.
        claims = Math.ceil((acceptedRequested ?? 0) / OPEN_CLAIM_FRACTION);
        break;
      case "--seed":
        corpusSeed = next();
        break;
      case "--tenant":
        tenantSlug = next();
        break;
      case "--anchor": {
        const raw = next();
        const parsed = raw === "now" ? new Date() : new Date(raw);
        if (Number.isNaN(parsed.getTime())) throw new Error("--anchor must be an ISO instant or 'now'");
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
      case "--fast-embed":
        fastEmbed = true;
        break;
      case "--admin-url":
        adminUrl = next();
        break;
      case "--database":
        isolatedDatabase = next();
        break;
      case "--db-url":
        databaseUrl = next();
        break;
      case "--migration-url":
        migrationUrl = next();
        break;
      case "--migrations":
        migrationsDir = resolve(next());
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
    acceptedRequested,
    corpusSeed,
    tenantSlug:
      tenantSlug ??
      (newDataset ? `${corpusSlug(corpusSeed, claims)}-${randomBytes(3).toString("hex")}` : corpusSlug(corpusSeed, claims)),
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
    adminUrl: adminUrl ?? env0().migrationDatabaseUrl ?? env0().databaseUrl,
    isolatedDatabase,
    fastEmbed,
    databaseUrl,
    migrationUrl,
    migrationsDir,
  };
}

/**
 * `.env` values, read at argument-parse time only for a default that depends on them.
 *
 * Kept as a function because `loadEnv()` re-reads the file and is not free, and because
 * argument parsing should not depend on the database being reachable.
 */
function env0(): { readonly databaseUrl: string; readonly migrationDatabaseUrl: string | null } {
  return loadEnv();
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
  const migrationUrl = options.migrationUrl ?? env.migrationDatabaseUrl ?? env.databaseUrl;
  const tenantId = resolveTenantId(options.tenantSlug);
  const backend = new HashEmbeddingBackend({
    dimensions: env.embedding.dimensions,
    modelId: env.embedding.modelId,
  });

  if (options.command === "isolated") {
    const result = await bootstrapDatabase({
      adminUrl: options.adminUrl,
      databaseName: options.isolatedDatabase,
      migrationsDir: options.migrationsDir ?? resolve(env.repoRoot, "migrations"),
      log,
    });
    log("");
    log(`isolated database ready: ${result.database}${result.created ? " (created)" : " (existing)"}`);
    log(`  migrations applied now      ${result.migrationsApplied.length}`);
    log(`  migrations already applied  ${result.migrationsAlreadyApplied}`);
    log("");
    log("Load and benchmark against it with:");
    log(`  pnpm eval:perf load  --accepted 1000000 --fast-embed --migration-url '${result.migrationUrl}'`);
    log(`  pnpm eval:perf bench --skip-load --db-url '${result.databaseUrl}' --migration-url '${result.migrationUrl}'`);
    return 0;
  }

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
      ...(options.fastEmbed ? { indexStrategy: "defer" as const } : {}),
      onProgress: (progress) => {
        // One line per phase. A million-row load emits thousands of batches, and a wall
        // of progress lines is not progress; `status` is how a stalled load is diagnosed.
        if (progress.done < progress.total) return;
        log(
          `  ${progress.phase.padEnd(15)} ${(progress.elapsed_ms / 1000).toFixed(1).padStart(7)}s  ` +
            `${progress.rows_per_second.toLocaleString("en-US").padStart(9)} claims/s  ` +
            `(${progress.total.toLocaleString("en-US")} of ${progress.total.toLocaleString("en-US")})`,
        );
      },
    });
    await syncStreams(migrationUrl, loaded.tenant_id);
    log(`loaded in ${(loaded.elapsed_ms / 1000).toFixed(1)} s`);
    if (loaded.index_rebuild_ms !== null) {
      log(
        `  HNSW index rebuilt after the embeddings phase in ${(loaded.index_rebuild_ms / 1000).toFixed(1)} s ` +
          `(strategy: ${loaded.index_strategy})`,
      );
    }
    for (const count of loaded.counts) log(`  ${count.table.padEnd(18)} ${count.rows.toLocaleString("en-US")}`);
    return 0;
  }

  if (options.acceptedRequested !== null) {
    log(
      `sizing      ${options.acceptedRequested.toLocaleString("en-US")} accepted claims -> ` +
        `${options.claims.toLocaleString("en-US")} total claims in the corpus`,
    );
    log(`tenant slug ${options.tenantSlug}  (pass --tenant with this to reuse the corpus later)`);
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
    ...(options.databaseUrl !== null ? { databaseUrl: options.databaseUrl } : {}),
    ...(options.migrationUrl !== null ? { migrationUrl: options.migrationUrl } : {}),
    log,
  });

  process.stdout.write(`\n${outcome.summary}`);
  process.stdout.write(`\nreport:  ${outcome.jsonPath}\nsummary: ${outcome.summaryPath}\n`);
  return outcome.exitCode;
}
