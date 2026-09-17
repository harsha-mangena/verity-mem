#!/usr/bin/env node
/**
 * LedgerBench CLI.
 *
 *   node --experimental-strip-types packages/ledgerbench/src/cli.ts \
 *     --seed 1 --out bench/run.json --jsonl bench/run.jsonl
 *
 * Exits non-zero when a fixture assertion fails or a required conformance check
 * fails, so it is usable as a gate in CI. It does *not* exit non-zero merely
 * because stages are unimplemented: that is a fact about the build, reported at the
 * top of the output, and a gate that fails for a known and recorded reason gets
 * disabled, which is worse than a gate that reports.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LexicalEntailmentBackend } from "@veritymem/gate";
import { FixtureRunner } from "./run.ts";
import { loadConformanceTraces, loadFixtures } from "./parse.ts";
import { runConformance } from "./conformance.ts";
import { buildReport, type EvaluationReport } from "./report.ts";
import type { Suite } from "./types.ts";

interface Options {
  readonly seed: number;
  readonly suite: Suite | undefined;
  readonly filter: string | undefined;
  readonly fixturesRoot: string;
  readonly out: string | null;
  readonly jsonl: string | null;
  readonly runScope: string | undefined;
  readonly quiet: boolean;
  readonly conformanceOnly: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES = resolve(HERE, "../../../fixtures");

export function parseArgs(argv: readonly string[]): Options {
  let seed = 1;
  let suite: Suite | undefined;
  let filter: string | undefined;
  let fixturesRoot = DEFAULT_FIXTURES;
  let out: string | null = null;
  let jsonl: string | null = null;
  let runScope: string | undefined;
  let quiet = false;
  let conformanceOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${String(arg)} needs a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--seed":
        seed = Number.parseInt(next(), 10);
        if (!Number.isFinite(seed)) throw new Error("--seed must be an integer");
        break;
      case "--suite": {
        const value = next();
        if (value !== "ledgerbench" && value !== "poisoning" && value !== "deletion") {
          throw new Error("--suite must be ledgerbench, poisoning or deletion");
        }
        suite = value;
        break;
      }
      case "--filter":
        filter = next();
        break;
      case "--fixtures":
        fixturesRoot = resolve(next());
        break;
      case "--out":
        out = resolve(next());
        break;
      case "--jsonl":
        jsonl = resolve(next());
        break;
      case "--run-scope":
        runScope = next();
        break;
      case "--conformance-only":
        conformanceOnly = true;
        break;
      case "--quiet":
        quiet = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        process.exit(0);
      default:
        throw new Error(`unknown option ${String(arg)}`);
    }
  }
  return {
    seed,
    suite,
    filter,
    fixturesRoot,
    out,
    jsonl,
    runScope,
    quiet,
    conformanceOnly,
  };
}

const USAGE = `LedgerBench — VerityMem's internal go/no-go instrument

Usage: node --experimental-strip-types src/cli.ts [options]

  --seed <n>            deterministic seed (default 1)
  --suite <name>        ledgerbench | poisoning | deletion
  --filter <substring>  only fixtures whose path contains this
  --fixtures <dir>      fixtures root (default <repo>/fixtures)
  --out <file>          write the full JSON report
  --jsonl <file>        write one JSON line per fixture run (raw traces)
  --run-scope <token>   re-enter a previous run's tenant; ids stay freshly seeded
  --conformance-only    run only the ten Phase 0 traces
  --quiet               only print the summary block
  -h, --help            this message
`;

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const runId = `evr_${randomUUID().replace(/-/g, "")}`;

  const runner = new FixtureRunner({
    seed: options.seed,
    ...(options.runScope !== undefined ? { runScope: options.runScope } : {}),
  });

  try {
    const runs: Awaited<ReturnType<FixtureRunner["run"]>>[] = [];
    const paths: string[] = [];
    const failures: string[] = [];

    if (!options.conformanceOnly) {
      const report = loadFixtures({
        root: options.fixturesRoot,
        ...(options.suite !== undefined ? { suite: options.suite } : {}),
        ...(options.filter !== undefined ? { filter: options.filter } : {}),
      });
      for (const failure of report.failures) {
        failures.push(`${failure.file}:${failure.line} [${failure.code}] ${failure.message}`);
      }
      if (report.failures.length > 0) {
        process.stderr.write("fixture parse failures:\n");
        for (const failure of failures) process.stderr.write(`  ${failure}\n`);
        return 2;
      }
      for (const fixture of report.files) {
        if (fixture.header.suite === ("conformance" as unknown as Suite)) continue;
        const result = await runner.run(fixture);
        runs.push(result);
        paths.push(fixture.path);
        if (!options.quiet) printFixture(result);
      }
    }

    let conformance = null;
    if (options.suite === undefined || options.conformanceOnly) {
      const traces = loadConformanceTraces(options.fixturesRoot);
      for (const failure of traces.failures) {
        failures.push(`${failure.file}:${failure.line} [${failure.code}] ${failure.message}`);
      }
      if (traces.traces.length > 0) {
        conformance = await runConformance(traces.traces, runner);
        for (const trace of conformance.traces) {
          paths.push(`${options.fixturesRoot}/conformance/${trace.trace_id}`);
          if (!options.quiet) printTrace(trace);
        }
      }
    }

    const report: EvaluationReport = buildReport({
      runs,
      conformance,
      fixturesRoot: options.fixturesRoot,
      fixturePaths: paths,
      seed: options.seed,
      runScope: runner.runScope,
      runId,
      startedAt,
      durationMs: Date.now() - started,
      gateBackend: new LexicalEntailmentBackend().name,
      gateModelSha256: null,
    });

    printSummary(report);

    if (options.out !== null) {
      mkdirSync(dirname(options.out), { recursive: true });
      writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      process.stdout.write(`\nreport: ${options.out}\n`);
    }
    if (options.jsonl !== null) {
      mkdirSync(dirname(options.jsonl), { recursive: true });
      writeFileSync(options.jsonl, `${runs.map((run) => JSON.stringify(run)).join("\n")}\n`, "utf8");
      process.stdout.write(`raw traces: ${options.jsonl}\n`);
    }

    const assertionFailures = runs.reduce((sum, run) => sum + run.assertions_failed, 0);
    const conformanceFailures = conformance?.required_checks_failed ?? 0;
    return assertionFailures + conformanceFailures > 0 ? 1 : 0;
  } finally {
    await runner.close();
  }
}

function printFixture(run: Awaited<ReturnType<FixtureRunner["run"]>>): void {
  const flag = run.assertions_failed > 0 ? "FAIL" : "ok  ";
  process.stdout.write(
    `${flag} ${run.fixture_id} [${run.ground_truth}] ` +
      `${run.assertions_passed}/${run.assertions_total} passed` +
      `${run.assertions_not_evaluated > 0 ? `, ${run.assertions_not_evaluated} not evaluated` : ""}` +
      ` (${run.duration_ms} ms)\n`,
  );
  for (const line of run.lines) {
    if (line.error !== undefined) process.stdout.write(`       line ${line.line_id}: ${line.error}\n`);
    for (const assertion of line.assertions) {
      if (assertion.status === "pass") continue;
      process.stdout.write(`       ${assertion.status.toUpperCase()} ${line.line_id} ${assertion.expectation}: ${assertion.detail}\n`);
    }
  }
}

function printTrace(trace: NonNullable<EvaluationReport["conformance"]>["traces"][number]): void {
  const flag = trace.required_failed > 0 ? "FAIL" : "ok  ";
  process.stdout.write(
    `${flag} ${trace.trace_id} ${trace.title} — ${trace.required_passed}/${
      trace.required_passed + trace.required_failed
    } required checks\n`,
  );
  for (const check of [...trace.checks, ...trace.unimplemented]) {
    if (check.status === "pass") continue;
    process.stdout.write(`       ${check.status.toUpperCase()} ${check.requirement}: ${check.detail}\n`);
  }
}

function printSummary(report: EvaluationReport): void {
  const lines: string[] = [];
  lines.push("");
  lines.push("LedgerBench");
  lines.push(`  run       ${report.manifest.run_id}`);
  lines.push(`  dataset   ${report.manifest.dataset_versions.join(", ")} (digest ${report.manifest.dataset_digest.slice(0, 16)}…)`);
  lines.push(`  seed      ${report.manifest.seed}   scope ${report.manifest.run_scope}`);
  lines.push(`  policy    ${report.manifest.policy_version}   gate ${report.manifest.gate_backend}`);
  lines.push("");
  lines.push("  stage                     status           cases   headline metric");
  for (const stage of report.stages) {
    const headline = headlineMetric(stage);
    lines.push(
      `  ${stage.stage.padEnd(24)}  ${stage.status.padEnd(15)}  ${String(stage.cases).padStart(5)}   ${headline}`,
    );
  }
  lines.push("");
  const unimplemented = report.stages.filter((stage) => stage.status === "not_implemented");
  if (unimplemented.length > 0) {
    lines.push(`  NOT MEASURED (${unimplemented.length} stage(s)) — these are not zeros:`);
    for (const stage of unimplemented) lines.push(`    - ${stage.stage}: ${stage.note ?? ""}`);
    lines.push("");
  }
  lines.push("  v0.1 exit targets");
  for (const check of report.targets.checks) {
    const mark = check.verdict === "pass" ? "PASS" : check.verdict === "fail" ? "FAIL" : "N/M ";
    lines.push(`    ${mark} ${check.id} — ${check.target}`);
    if (check.verdict !== "pass") {
      lines.push(
        `         observed ${check.observed === null ? "not measured" : String(check.observed)}` +
          `${check.blocked_by ? `; blocked by ${check.blocked_by}` : ""}`,
      );
    }
  }
  lines.push("");
  lines.push(
    `  review burden ${(report.review_burden.burden * 100).toFixed(1)}% of ${report.review_burden.writes} writes ` +
      `(ceiling ${(report.review_burden.ceiling * 100).toFixed(0)}%) — ` +
      `${report.review_burden.within_ceiling ? "within ceiling" : "OVER CEILING"}`,
  );
  if (report.targets.checks.some((check) => check.note !== undefined)) {
    lines.push("");
    lines.push("  notes");
    for (const check of report.targets.checks) {
      if (check.note === undefined) continue;
      lines.push(`    ${check.id}: ${check.note}`);
    }
  }
  lines.push("");
  lines.push(`  ${report.verdict.statement}`);
  lines.push("");
  process.stdout.write(`${lines.join("\n")}\n`);
}

function headlineMetric(stage: EvaluationReport["stages"][number]): string {
  const pick = (name: string, format: (value: number) => string): string | null => {
    const value = stage.metrics[name];
    return value === undefined ? null : `${name}=${format(value)}`;
  };
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const raw = (value: number) => value.toFixed(2);
  const candidates: (string | null)[] = [
    pick("malicious_instruction_acceptance_rate", pct),
    pick("unsafe_auto_accept_rate", pct),
    pick("review_burden", pct),
    pick("contradiction_recall", pct),
    pick("residual_matches", raw),
    pick("decision_set_equality", pct),
    pick("ms_per_event", raw),
  ];
  return candidates.find((entry) => entry !== null) ?? "—";
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`ledgerbench failed: ${(error as Error).message}\n${(error as Error).stack ?? ""}\n`);
    process.exitCode = 2;
  });
