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
import type { TimeSpec } from "@veritymem/contracts";
import { HashEmbeddingBackend } from "@veritymem/retrieval";
import { bootstrapDatabase } from "./isolated.ts";
import { countAll, loadCorpus, syncStreams } from "./load.ts";
import { capturePlans, PlanCaptureRefusal } from "./plan-capture.ts";
import { FIXTURE_FROM, FIXTURE_TO, provisionFixture } from "./plan-fixture.ts";
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

const EXPLAIN_USAGE = `Plan capture — real PostgreSQL plans for every retrieval stage

Usage: pnpm eval:perf explain [options]

Required
  --tenant <slug>        tenant to capture against
  --query <text>         the query text to plan
  --limit <number>       QueryRequest.limit (1..100)
  --output <path>        artifact path; refuses to overwrite without --force

Optional
  --database-url <url>   read path connection (RLS-bound application role)
  --migration-url <url>  metadata and version reads (owner role)
  --purpose <purpose>    declared purpose (default release_planning)
  --principal <id>       caller principal; must participate in the tenant. Omit to
                         use the first participant found, which is reported.
  --subject <subject>    declare a subject, repeatable. The relation channel is only
                         planned for caller-declared subjects, so without one the
                         artifact reports that stage as missing rather than inventing it.
  --time-mode <mode>     current | as_of | during (default current). Only 'during' makes
                         the temporal channel issue a statement; the mode is recorded in
                         the artifact so a missing stage can be read correctly.
  --as-of <timestamp>    required for --time-mode as_of; rejected otherwise
  --from <timestamp>     required for --time-mode during; rejected otherwise
  --to <timestamp>       required for --time-mode during; rejected otherwise
  --force                overwrite an existing artifact

Exit codes: 0 captured; 1 refused (see the message); 2 could not run.
`;

interface ExplainArgs {
  readonly tenant: string;
  readonly query: string;
  readonly limit: number;
  readonly output: string;
  readonly databaseUrl: string | null;
  readonly migrationUrl: string | null;
  readonly purpose: string;
  readonly principal: string | null;
  readonly subjects: readonly string[];
  /** The complete TimeSpec, validated. Never assembled from loose option strings. */
  readonly time: TimeSpec;
  readonly force: boolean;
}

/**
 * Parse the `explain` command's arguments.
 *
 * Every required option is required here rather than defaulted. A capture run that guessed
 * its tenant or its query would produce a well-formed artifact about something nobody
 * asked for, and the artifact carries no way to notice.
 */
function parseExplainArgs(argv: readonly string[]): ExplainArgs {
  let tenant: string | undefined;
  let query: string | undefined;
  let limit: number | undefined;
  let output: string | undefined;
  let databaseUrl: string | null = null;
  let migrationUrl: string | null = null;
  let purpose = "release_planning";
  let principal: string | null = null;
  const subjects: string[] = [];
  let timeMode: string | null = null;
  let asOf: string | null = null;
  let from: string | null = null;
  let to: string | null = null;
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${String(arg)} requires a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--tenant": tenant = next(); break;
      case "--query": query = next(); break;
      case "--output": output = next(); break;
      case "--purpose": purpose = next(); break;
      case "--principal": principal = next(); break;
      case "--subject": subjects.push(next()); break;
      case "--time-mode": timeMode = next(); break;
      case "--as-of": asOf = next(); break;
      case "--from": from = next(); break;
      case "--to": to = next(); break;
      case "--limit": limit = Number.parseInt(next(), 10); break;
      case "--database-url": databaseUrl = next(); break;
      case "--migration-url": migrationUrl = next(); break;
      case "--force": force = true; break;
      case "--help":
      case "-h":
        process.stdout.write(EXPLAIN_USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option ${String(arg)} for explain`);
    }
  }

  if (tenant === undefined) throw new Error("--tenant is required");
  if (query === undefined || query.length === 0) throw new Error("--query is required");
  if (output === undefined) throw new Error("--output is required");
  if (limit === undefined || !Number.isFinite(limit) || limit < 1 || limit > 100) {
    throw new Error("--limit is required and must be 1..100 (the contract's maximum)");
  }
  return {
    tenant,
    query,
    limit,
    output,
    databaseUrl,
    migrationUrl,
    purpose,
    principal,
    subjects,
    time: buildTimeSpec({ timeMode, asOf, from, to }),
    force,
  };
}

/**
 * Build the `TimeSpec` the contract defines, or refuse.
 *
 * The three modes are a discriminated union, not a mode plus optional fields: `as_of`
 * carries exactly one instant and `during` exactly one interval, so a request cannot express
 * "during with no window" or "current with an as-of instant". Producing that union from
 * command-line strings means every way of getting it wrong has to be rejected here, because
 * a `TimeSpec` built by casting would pass an invalid request into `compose` and the planner
 * would then either throw somewhere less legible or, worse, quietly plan a different query
 * than the caller asked for.
 *
 * The rejections, and why each is not merely pedantic:
 *
 *   * **a mode-specific option given without its mode** — `--from/--to` with `current`, or
 *     `--as-of` with `during`. Accepting these silently would produce an artifact whose
 *     recorded `time_mode` disagrees with the window the caller believed they set, and the
 *     plan inside would be for a query they did not ask for.
 *   * **a missing required value** — the mode is meaningless without it.
 *   * **an unparseable timestamp** — `new Date("yesterday")` is not an error in JavaScript,
 *     it is `Invalid Date`, and it would reach PostgreSQL as a string. The check is that the
 *     input parses *and* round-trips, so `2026-13-45` is refused rather than normalised.
 *   * **`from >= to`** — an empty or inverted window. The temporal channel's range predicate
 *     would match nothing and the capture would record a successful plan over an empty set.
 */
function buildTimeSpec(input: {
  readonly timeMode: string | null;
  readonly asOf: string | null;
  readonly from: string | null;
  readonly to: string | null;
}): TimeSpec {
  const mode = input.timeMode ?? "current";

  const parse = (label: string, value: string): string => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`${label} must be an ISO-8601 timestamp; '${value}' could not be parsed`);
    }
    // Round-trip: `2026-02-31` parses to March, which is a *different* instant than the
    // caller wrote. Comparing the day back catches that class rather than accepting it.
    const iso = parsed.toISOString();
    if (!value.startsWith(iso.slice(0, 10)) && !value.startsWith(iso.slice(0, 7))) {
      throw new Error(`${label} '${value}' is not a real instant; it normalises to ${iso}`);
    }
    return iso;
  };

  if (mode === "current") {
    if (input.asOf !== null) throw new Error("--as-of is only valid with --time-mode as_of");
    if (input.from !== null || input.to !== null) {
      throw new Error("--from and --to are only valid with --time-mode during");
    }
    return { mode: "current" };
  }

  if (mode === "as_of") {
    if (input.from !== null || input.to !== null) {
      throw new Error("--from and --to are only valid with --time-mode during");
    }
    if (input.asOf === null) throw new Error("--time-mode as_of requires --as-of <ISO-8601 timestamp>");
    return { mode: "as_of", as_of: parse("--as-of", input.asOf) };
  }

  if (mode === "during") {
    if (input.asOf !== null) throw new Error("--as-of is only valid with --time-mode as_of");
    if (input.from === null) throw new Error("--time-mode during requires --from <ISO-8601 timestamp>");
    if (input.to === null) throw new Error("--time-mode during requires --to <ISO-8601 timestamp>");
    const fromIso = parse("--from", input.from);
    const toIso = parse("--to", input.to);
    if (fromIso >= toIso) {
      throw new Error(
        `--from (${fromIso}) must be strictly before --to (${toIso}); an empty or inverted ` +
          `window matches nothing and the temporal channel's plan would be over an empty set`,
      );
    }
    return { mode: "during", from: fromIso, to: toIso };
  }

  throw new Error(`--time-mode must be current, as_of or during; got '${mode}'`);
}

/**
 * Provision the plan-capture fixture.
 *
 * A command rather than something the test file does behind the scenes, because provisioning
 * a corpus is a minutes-long, database-writing act and a test suite is the wrong place to
 * hide one. The tests call the same function, so the fixture they assert against is the one
 * this command produces.
 *
 * Idempotent: an already-complete fixture is returned without loading anything, so running it
 * twice is free and deterministic.
 */
async function runFixtureCommand(argv: readonly string[]): Promise<number> {
  const log = (message: string): void => {
    process.stdout.write(`${message}\n`);
  };
  const force = argv.includes("--force");
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      `Plan-capture fixture

Usage: pnpm eval:perf fixture [--force]

Provisions a deterministic tenant with a row for every retrieval stage: accepted claims,
events, spans, claim evidence, dense embeddings, a projection version, relations, entity
aliases and entity projections, plus a validity interval overlapping the during window.

  --force   reload the corpus even if the fixture already looks complete

Idempotent without --force: an already-complete fixture costs nothing.
`,
    );
    return 0;
  }

  const fixture = await provisionFixture({ log, force });
  log("");
  log(`fixture     ${fixture.tenantSlug}${fixture.reused ? " (reused)" : " (loaded)"}`);
  log(`principal   ${fixture.principal}`);
  log(`subject     ${fixture.subject}`);
  log(`during      ${FIXTURE_FROM} .. ${FIXTURE_TO}`);
  for (const [field, count] of Object.entries(fixture.counts)) {
    log(`  ${field.padEnd(20)} ${count}`);
  }
  return 0;
}

/** Run `explain`. Returns the process exit code. */
async function runExplainCommand(argv: readonly string[]): Promise<number> {
  const log = (message: string): void => {
    process.stdout.write(`${message}\n`);
  };
  let args: ExplainArgs;
  try {
    args = parseExplainArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${EXPLAIN_USAGE}`);
    return 1;
  }

  try {
    const { artifact, output, completion } = await capturePlans({ ...args, log });
    const parsed = artifact as {
      stages: readonly { stage: string; success: boolean; structural_plan_digest: string | null }[];
    };
    log("");
    log(`artifact    ${output}`);
    for (const stage of parsed.stages) {
      const digest = stage.structural_plan_digest;
      log(`  ${stage.success ? "ok  " : "FAIL"} ${stage.stage.padEnd(20)} ${digest?.slice(0, 16) ?? "-"}`);
    }
    if (completion.missing.length > 0) {
      const conditional = completion.missing.filter(
        (stage) => !completion.unexpected_missing.includes(stage),
      );
      if (conditional.length > 0) {
        log(`not selected ${conditional.join(", ")}  (the request did not ask for these)`);
      }
    }
    log(`complete    ${completion.complete ? "yes" : "NO"}`);

    // A capture that is not complete exits non-zero. Every reason is named, because the
    // operator's next action differs per reason: a failed plan is a database problem, a
    // duplicated stage is a labelling bug, and an unlabelled statement is a seam that did
    // not report itself.
    if (!completion.complete) {
      log("");
      for (const reason of completion.reasons) log(`INCOMPLETE  ${reason}`);
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof PlanCaptureRefusal) {
      // A refusal is an answer about the environment, so it is printed as one line and
      // without a stack trace. Exit 1 distinguishes it from "could not run at all".
      process.stderr.write(`refused: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  // `explain` is dispatched before the benchmark parser, on the raw argv.
  //
  // It takes different arguments (`--query`, `--output`, `--force`) and different
  // defaults — a benchmark run defaults its tenant, a plan capture must be told which one —
  // and it is a different kind of command: a diagnostic that refuses to run on an
  // unsuitable database, not a measurement that reports whatever it found. Folding it into
  // `parseArgs` would have meant its required arguments were optional to the benchmark and
  // the benchmark's were optional to it.
  if (argv.includes("explain")) return runExplainCommand(argv.filter((arg) => arg !== "explain"));
  if (argv.includes("fixture")) return runFixtureCommand(argv.filter((arg) => arg !== "fixture"));

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
