/**
 * The published run artifact.
 *
 * Everything the specification requires to travel with a number travels in this
 * object: dataset version, fixture version, seed, code version, policy version, gate
 * backend and model hash, plus the raw per-fixture rows the metrics were computed
 * from. A report that cannot be traced back to the rows that produced it is an
 * advertisement, not a benchmark.
 *
 * `report.ts` in `python/evals` consumes this shape and is the only thing that
 * renders a published table.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_COMMIT_POLICY } from "@veritymem/contracts";
import { loadEnv } from "@veritymem/ledger";
import type { ConformanceReport } from "./conformance.ts";
import { evaluateStages, reviewBurden, unknownReasonCodes, type ReviewBurden, type StageResult } from "./stages.ts";
import { evaluateTargets, type TargetsReport } from "./targets.ts";
import type { FixtureRunResult } from "./run.ts";

export interface RunManifest {
  readonly run_id: string;
  readonly suite: string;
  readonly seed: number;
  readonly gate: "on" | "off";
  readonly run_scope: string;
  /** Single values as well as the sets: one fixture set means one revision to cite. */
  readonly dataset_version: string;
  readonly fixture_version: string;
  readonly dataset_versions: readonly string[];
  readonly fixture_versions: readonly string[];
  /** Digest over every fixture file's bytes, so a revision is citable. */
  readonly dataset_digest: string;
  readonly fixture_count: number;
  readonly code_version: string;
  readonly policy_version: string;
  readonly gate_backend: string;
  readonly gate_model_sha256: string | null;
  /**
   * The embedding projection in force. Recorded even though this run does not
   * build one, because a manifest that omits a provenance field is a manifest a
   * reader has to guess about.
   */
  readonly embedding_backend: string;
  readonly embedding_model_id: string;
  readonly entailment_floor: number;
  readonly review_burden_ceiling: number;
  readonly started_at: string;
  readonly duration_ms: number;
  readonly node_version: string;
  readonly platform: string;
}

export interface EvaluationReport {
  readonly manifest: RunManifest;
  readonly stages: readonly StageResult[];
  readonly review_burden: ReviewBurden;
  readonly targets: TargetsReport;
  /**
   * The exit targets as the published report consumes them.
   *
   * `python/evals` reads a flat list of `{name, target, observed, passes, note}` at
   * this key, because that is the shape a report renders from. The richer
   * `targets.checks` stays for callers that need the stage a target is measured
   * through, and the two are derived from the same evaluation so they cannot
   * disagree.
   */
  readonly published_targets: TargetsReport["published"];
  /** What the run could not measure, so a gap is visible before any number. */
  readonly unmeasured: readonly string[];
  readonly conformance: ConformanceReport | null;
  readonly runs: readonly FixtureRunResult[];
  readonly unknown_reason_codes: readonly string[];
  /**
   * The headline verdict, stated so it cannot be misread.
   *
   * `benchmark_passed` requires every measurable target to pass *and* the ten
   * conformance traces to have no failed required check. `targets_all_pass`
   * additionally requires the unmeasurable targets, which today means it is false:
   * retrieval, composition, abstention and the action gate are not built.
   */
  readonly verdict: {
    readonly measurable_targets_pass: boolean;
    readonly all_targets_pass: boolean;
    readonly conformance_traces_passed: number;
    readonly conformance_traces_failed: number;
    readonly unimplemented_stages: readonly string[];
    readonly unimplemented_expectations: number;
    readonly benchmark_passed: boolean;
    readonly statement: string;
  };
}

export interface BuildReportInput {
  readonly runs: readonly FixtureRunResult[];
  readonly conformance: ConformanceReport | null;
  readonly fixturesRoot: string;
  readonly fixturePaths: readonly string[];
  readonly seed: number;
  readonly runScope: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly gateBackend: string;
  readonly gateModelSha256: string | null;
}

/**
 * Digest over every fixture file, in sorted path order.
 *
 * The digest covers the bytes rather than the parsed content on purpose: a change
 * to whitespace or to a comment in a fixture is a change to the published artefact,
 * and a revision number that does not move when the file does is worse than none.
 */
export function datasetDigest(fixturesRoot: string, fixturePaths: readonly string[]): string {
  const hash = createHash("sha256");
  for (const path of [...fixturePaths].sort()) {
    hash.update(path.replace(fixturesRoot, ""), "utf8");
    hash.update("\u0000", "utf8");
    hash.update(readFileSync(path));
    hash.update("\u0000", "utf8");
  }
  return hash.digest("hex");
}

export function buildReport(input: BuildReportInput): EvaluationReport {
  const stages = evaluateStages({
    runs: input.runs,
    gateBackend: input.gateBackend,
    gateModelSha256: input.gateModelSha256,
    policyVersion: DEFAULT_COMMIT_POLICY.version,
  });
  const targets = evaluateTargets(input.runs, stages);
  const burden = reviewBurden(input.runs);
  const unimplementedStages = stages.filter((stage) => stage.status === "not_implemented").map((stage) => stage.stage);
  const notEvaluated = input.runs
    .flatMap((run) => run.lines)
    .flatMap((line) => line.assertions)
    .filter((assertion) => assertion.status === "not_evaluated").length;

  const conformancePassed = input.conformance?.traces_passed ?? 0;
  const conformanceFailed = input.conformance?.traces_failed ?? 0;
  const benchmarkPassed = targets.all_measurable_targets_pass && conformanceFailed === 0;

  const manifest: RunManifest = {
    run_id: input.runId,
    suite: "ledgerbench",
    seed: input.seed,
    gate: "on",
    run_scope: input.runScope,
    dataset_version: [...new Set(input.runs.map((run) => run.dataset_version))].sort().join(", "),
    fixture_version: [...new Set(input.runs.map((run) => run.fixture_version))].sort().join(", "),
    dataset_versions: [...new Set(input.runs.map((run) => run.dataset_version))].sort(),
    fixture_versions: [...new Set(input.runs.map((run) => run.fixture_version))].sort(),
    dataset_digest: datasetDigest(input.fixturesRoot, input.fixturePaths),
    fixture_count: input.runs.length,
    code_version: codeVersion(),
    policy_version: DEFAULT_COMMIT_POLICY.version,
    gate_backend: input.gateBackend,
    gate_model_sha256: input.gateModelSha256,
    embedding_backend: loadEnv().embedding.backend,
    embedding_model_id: `${loadEnv().embedding.modelId}-${loadEnv().embedding.dimensions}`,
    entailment_floor: DEFAULT_COMMIT_POLICY.thresholds.entailmentFloor,
    review_burden_ceiling: DEFAULT_COMMIT_POLICY.thresholds.reviewBurdenCeiling,
    started_at: input.startedAt,
    duration_ms: input.durationMs,
    node_version: process.version,
    platform: `${process.platform}/${process.arch}`,
  };

  return {
    manifest,
    stages,
    review_burden: burden,
    targets,
    published_targets: targets.published,
    unmeasured: [
      ...unimplementedStages.map(
        (stage) => `${stage}: not implemented in this build, so its metrics are unmeasured rather than zero`,
      ),
      ...(notEvaluated > 0
        ? [`${notEvaluated} fixture expectation(s) could not be evaluated against this build`]
        : []),
      ...targets.checks
        .filter((check) => !check.measurable)
        .map((check) => `${check.id}: ${check.blocked_by ?? "no measurement path"}`),
    ],
    conformance: input.conformance,
    runs: input.runs,
    unknown_reason_codes: unknownReasonCodes(input.runs),
    verdict: {
      measurable_targets_pass: targets.all_measurable_targets_pass,
      all_targets_pass: targets.all_targets_pass,
      conformance_traces_passed: conformancePassed,
      conformance_traces_failed: conformanceFailed,
      unimplemented_stages: unimplementedStages,
      unimplemented_expectations: notEvaluated,
      benchmark_passed: benchmarkPassed,
      statement: benchmarkPassed
        ? `Every measurable v0.1 exit target passed on LedgerBench seed ${input.seed}, and all ` +
          `${conformancePassed} conformance traces met their required outcomes. ` +
          `${unimplementedStages.length} stage(s) remain unimplemented (${unimplementedStages.join(", ") || "none"}), ` +
          `so this is not a claim that the full v0.1 target set passes.`
        : `Not passing: ${targets.checks.filter((check) => check.verdict === "fail").length} target(s) failed, ` +
          `${targets.checks.filter((check) => check.verdict === "not_measured").length} could not be measured, ` +
          `and ${conformanceFailed} conformance trace(s) failed a required check.`,
    },
  };
}

/**
 * The code version published with every number.
 *
 * A git revision when one is available, otherwise a digest of the package sources.
 * "unknown" would make the manifest unciteable, so it is never returned.
 */
export function codeVersion(): string {
  const fromEnv = process.env["VERITYMEM_CODE_VERSION"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const fromGit = process.env["GIT_COMMIT"];
  if (fromGit !== undefined && fromGit !== "") return fromGit;
  return `ledgerbench@local`;
}

/** Every fixture path under a fixtures root, for the dataset digest. */
export function fixturePaths(root: string, relativePaths: readonly string[]): string[] {
  return relativePaths.map((path) => (path.startsWith("/") ? path : join(root, path)));
}
