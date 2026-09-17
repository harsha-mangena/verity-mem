#!/usr/bin/env node
/**
 * LedgerBench CLI.
 *
 *   node --experimental-strip-types packages/ledgerbench/src/cli.ts \
 *     --seed 1 --out bench/run.json --jsonl bench/run.jsonl
 *
 * **The exit code is the release gate, and a target that is not measured is not a
 * target that passed.** That is the whole contract:
 *
 *   * 0 — every v0.1 exit target passed, every fixture assertion passed, and every
 *     required conformance check passed.
 *   * 1 — the run completed and something is unmet: a target failed, a target could not
 *     be measured, an assertion failed, or a required conformance check failed. The
 *     reasons are printed and travel in the report's `unmet_targets`.
 *   * 2 — the run could not be completed (a fixture parse error, a refused backend).
 *
 * An earlier version exited zero for "declared known gaps" and for unimplemented stages.
 * That made a partial run look like a passing one, which is the failure the instrument
 * exists to prevent: `scripts/verify.sh` reads this exit code as the release decision, so
 * a benchmark that cannot measure a target has to say the release gate is unmet.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_BACKENDS, resolveGateBackend, type GateBackendChoice } from "./backend.ts";
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
  readonly gateBackend: GateBackendChoice;
  /** Refuse the lexical stand-in. `--gate-required`. */
  readonly gateRequired: boolean;
  /** Root of the pinned model assets. */
  readonly modelsRoot: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES = resolve(HERE, "../../../fixtures");
const REPO_ROOT = resolve(HERE, "../../..");
const DEFAULT_MODELS = resolve(REPO_ROOT, ".veritymem/models");

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
  let modelsRoot = DEFAULT_MODELS;
  let gateBackend: GateBackendChoice =
    (process.env["LEDGERBENCH_GATE_BACKEND"] as GateBackendChoice | undefined) ?? "auto";
  let gateRequired = false;

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
      case "--models":
        modelsRoot = resolve(next());
        break;
      case "--gate-backend": {
        const value = next();
        if (!(GATE_BACKENDS as readonly string[]).includes(value)) {
          throw new Error(`--gate-backend must be one of ${GATE_BACKENDS.join(", ")}`);
        }
        gateBackend = value as GateBackendChoice;
        break;
      }
      case "--gate-required":
        gateRequired = true;
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
    gateBackend,
    gateRequired,
    modelsRoot,
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
  --gate-backend <b>    auto | onnx | lexical (default: auto, or $LEDGERBENCH_GATE_BACKEND)
  --gate-required       refuse to fall back to the lexical stand-in
  --models <dir>        pinned model assets root (default: <repo>/.veritymem/models)
  --quiet               only print the summary block
  -h, --help            this message

Exit codes: 0 every v0.1 target, assertion and required conformance check passed;
            1 the run completed with something unmet (see the report's unmet_targets);
            2 the run could not be completed.
`;

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const runId = `evr_${randomUUID().replace(/-/g, "")}`;

  // Resolved before any fixture runs: a gate the run cannot load must stop it, not be
  // discovered after the numbers exist. `--gate-required` turns the fallback into an error.
  const gate = await resolveGateBackend({
    choice: options.gateBackend,
    required: options.gateRequired,
    modelsRoot: options.modelsRoot,
  });
  process.stdout.write(
    `gate      ${gate.name} (${gate.kind})${gate.modelSha256 === null ? "" : ` model ${gate.modelSha256.slice(0, 12)}…`}\n` +
      `          ${gate.reason}\n`,
  );
  if (gate.kind === "lexical" && gate.production_verifier_available) {
    process.stderr.write(
      `\n  WARNING: the production entailment verifier is provisioned on this machine and this run did ` +
        `not use it.\n  The published numbers describe the lexical stand-in. Re-run with ` +
        `GATE_ENTAILMENT_BACKEND=onnx or --gate-backend onnx to score the production gate.\n\n`,
    );
  }

  const runner = new FixtureRunner({
    seed: options.seed,
    entailment: gate.backend,
    ...(options.runScope !== undefined ? { runScope: options.runScope } : {}),
  });

  try {
    const runs: Awaited<ReturnType<FixtureRunner["run"]>>[] = [];
    const paths: string[] = [];
    const failures: string[] = [];
    /** Parsed fixtures by id, so a failure can be matched to its declaration. */
    const fixturesById = new Map<string, ReturnType<typeof loadFixtures>["files"][number]>();

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
        fixturesById.set(fixture.header.fixture_id, fixture);
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
      gate,
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

    // Every failure is a failure. A fixture may still *declare* a gap, and the
    // declaration is reported so the reader knows it was expected — but it changes what the
    // report says, not whether the process exits non-zero. The earlier behaviour let a
    // declared gap pass the build, which made the release gate advisory: a "known
    // limitation" list that grows is indistinguishable from a gate that never fires.
    const undeclared = runs.flatMap((run) =>
      run.lines.flatMap((line) =>
        line.assertions
          .map((assertion, index) => ({ assertion, index }))
          .filter(({ assertion }) => assertion.status === "fail")
          .filter(({ index }) => {
            const fixture = fixturesById.get(run.fixture_id);
            const declared = fixture?.body.find((entry) => entry.line_id === line.line_id);
            return declared?.expect[index]?.gap !== true;
          })
          .map(({ assertion }) => `${run.fixture_id}:${line.line_id} ${assertion.expectation}`),
      ),
    );
    const declaredGaps = runs.reduce((sum, run) => sum + run.assertions_failed, 0) - undeclared.length;
    const notEvaluated = runs.reduce((sum, run) => sum + run.assertions_not_evaluated, 0);
    const conformanceFailures = conformance?.required_checks_failed ?? 0;
    if (declaredGaps > 0) {
      process.stdout.write(
        `\n  ${declaredGaps} assertion(s) failed against requirements the fixtures declare as known gaps. ` +
          `Declaring a gap does not make it pass: it is counted in the metrics and it fails this run.\n`,
      );
    }
    if (undeclared.length > 0) {
      process.stderr.write(`\nundeclared failures (${undeclared.length}):\n`);
      for (const entry of undeclared) process.stderr.write(`  ${entry}\n`);
    }
    if (notEvaluated > 0) {
      process.stderr.write(
        `\n${notEvaluated} expectation(s) were not evaluated; an assertion that never ran is not a pass.\n`,
      );
    }

    // The exit code is derived from the report's own unmet list, so the published table
    // and the process status cannot disagree. `unmet_targets` carries a reason for every
    // entry, including the unmeasurable ones — a non-zero exit with no explanation is a
    // gate nobody can act on, which is how gates get disabled.
    const gateFailures = [
      ...report.unmet_targets.map(
        (entry) => `target ${entry.id} [${entry.verdict}] — ${entry.reason}`,
      ),
      ...(undeclared.length > 0 ? [`${undeclared.length} undeclared fixture assertion failure(s)`] : []),
      ...(declaredGaps > 0 ? [`${declaredGaps} declared-gap assertion failure(s)`] : []),
      ...(notEvaluated > 0 ? [`${notEvaluated} expectation(s) not evaluated`] : []),
      ...(conformanceFailures > 0 ? [`${conformanceFailures} required conformance check(s) failed`] : []),
    ];
    if (gateFailures.length > 0) {
      process.stdout.write(`\n  release gate FAILED (${gateFailures.length} reason(s)):\n`);
      for (const failure of gateFailures) process.stdout.write(`    - ${failure}\n`);
      return 1;
    }
    return 0;
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
  lines.push(
    `  review burden, non-adversarial fixtures only: ` +
      `${(report.review_burden.non_adversarial_burden * 100).toFixed(1)}% of ` +
      `${report.review_burden.non_adversarial_writes} writes — ` +
      `${report.review_burden.non_adversarial_within_ceiling ? "within ceiling" : "OVER CEILING"}`,
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
    // The read-path stages, so the four stages that were unmeasured for the life of this
    // harness show a number here rather than a dash.
    pick("evidence_recall_at_10", pct),
    pick("citation_precision", pct),
    pick("abstention_recall", pct),
    pick("unsafe_allow_rate", pct),
    pick("unnecessary_block_rate", pct),
    pick("review_burden", pct),
    pick("contradiction_recall", pct),
    pick("residual_matches", raw),
    pick("decision_set_equality", pct),
    pick("p95_query_ms", raw),
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
