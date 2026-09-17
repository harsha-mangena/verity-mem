/**
 * The published run artifact.
 *
 * Everything the specification requires to travel with a number travels in this
 * object: dataset version, fixture version, seed, code version, policy version, gate
 * backend and model hash, plus the raw per-fixture rows the metrics were computed
 * from. A report that cannot be traced back to the rows that produced it is an
 * advertisement, not a benchmark.
 *
 * The manifest is stricter than "we recorded something" in three places, because each
 * of them was the difference between an artifact a release can cite and one it cannot:
 *
 *  - **The commit is read from git**, not from an environment variable a CI job may or
 *    may not export, and a dirty working tree is recorded rather than hidden. A report
 *    whose code version is "ledgerbench@local" cannot be tied to a revision, which is
 *    the whole point of retaining it.
 *  - **The gate backend carries its digest.** A verifier named without the hash of the
 *    model that produced its verdicts is not pinned, and the same name can mean two
 *    different gates.
 *  - **The unmeasured list is derived from the target table**, so a target nobody could
 *    measure appears before any number rather than in a footnote.
 *
 * `report.ts` in `python/evals` consumes this shape and is the only thing that
 * renders a published table.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_COMMIT_POLICY } from "@veritymem/contracts";
import { loadEnv } from "@veritymem/ledger";
import type { ConformanceReport } from "./conformance.ts";
import { evaluateStages, reviewBurden, unknownReasonCodes, type ReviewBurden, type StageResult } from "./stages.ts";
import { evaluateTargets, type TargetsReport } from "./targets.ts";
import type { GateBackendSelection } from "./backend.ts";
import type { FixtureRunResult } from "./run.ts";

/**
 * Where the code version came from and whether the tree it names was clean.
 *
 * `dirty` is recorded rather than refused: an operator running the benchmark before
 * committing needs a number, and a report that hid the modification would attribute it
 * to the commit it names. The `deterministic_projections` target turns a missing or
 * dirty revision into a failure, so the report is honest either way.
 */
export interface VersionProvenance {
  readonly commit: string | null;
  readonly short: string | null;
  readonly source: "git" | "environment" | "unknown";
  readonly dirty: boolean | null;
  /** Digest over the benchmark package's own sources, so a dirty tree is still citable. */
  readonly package_digest: string;
}

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
  readonly code_commit: string | null;
  readonly code_commit_short: string | null;
  readonly code_version_source: VersionProvenance["source"];
  readonly code_worktree_dirty: boolean | null;
  readonly package_digest: string;
  readonly policy_version: string;
  readonly gate_backend: string;
  readonly gate_backend_kind: "onnx" | "lexical";
  readonly gate_backend_reason: string;
  /**
   * True when model assets are present on the machine that produced this artifact.
   *
   * Beside `gate_backend_kind` so a reader can see the difference between "there is no
   * production verifier here" and "there is one and this run did not use it".
   */
  readonly gate_production_verifier_available: boolean;
  readonly gate_model_sha256: string | null;
  readonly gate_tokenizer_sha256: string | null;
  readonly gate_model_path: string | null;
  readonly gate_entailment_threshold: number;
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
  /**
   * A sentence about which verifier this run scored, or empty.
   *
   * Top-level rather than buried in the manifest because a reader who takes one number out
   * of this artifact has to take the verifier with it.
   */
  readonly verifier_caveat: string;
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
  /** Every target that is not passing, with the reason. The CLI's exit code reads this. */
  readonly unmet_targets: TargetsReport["unmet"];
  readonly conformance: ConformanceReport | null;
  readonly runs: readonly FixtureRunResult[];
  readonly unknown_reason_codes: readonly string[];
  /**
   * The headline verdict, stated so it cannot be misread.
   *
   * `benchmark_passed` requires every v0.1 target to pass — including the ones this
   * instrument cannot measure, which is deliberate: the specification's own posture is
   * that an unmeasured target is not a passing one, so a benchmark that cannot measure a
   * target must say the gate is unmet rather than report on the part it could see.
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
  /** The verifier that actually ran, with its digest and the reason it was chosen. */
  readonly gate: GateBackendSelection;
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
    gateBackend: input.gate.name,
    gateModelSha256: input.gate.modelSha256,
    policyVersion: DEFAULT_COMMIT_POLICY.version,
  });
  const provenance = codeProvenance();
  const targets = evaluateTargets({ runs: input.runs, stages, gate: input.gate, provenance });
  const burden = reviewBurden(input.runs);
  const unimplementedStages = stages.filter((stage) => stage.status === "not_implemented").map((stage) => stage.stage);
  const notEvaluated = input.runs
    .flatMap((run) => run.lines)
    .flatMap((line) => line.assertions)
    .filter((assertion) => assertion.status === "not_evaluated").length;

  const conformancePassed = input.conformance?.traces_passed ?? 0;
  const conformanceFailed = input.conformance?.traces_failed ?? 0;
  const benchmarkPassed = targets.all_targets_pass && conformanceFailed === 0 && notEvaluated === 0;

  // Stated before any number, because the difference between the two verifiers is the
  // single largest determinant of what every other number means.
  const verifierCaveat =
    input.gate.kind === "lexical" && input.gate.production_verifier_available
      ? "This run scored the LEXICAL STAND-IN while pinned production model assets are present on " +
        "this machine. The numbers describe the stand-in, not the DeBERTa-v3 verifier. " +
        "Re-run with GATE_ENTAILMENT_BACKEND=onnx (or --gate-backend onnx) to score the production gate."
      : input.gate.kind === "lexical"
        ? "This run scored the lexical stand-in; no production model assets were found on this machine."
        : "";

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
    code_version: provenance.commit ?? `ledgerbench@local+${provenance.package_digest.slice(0, 12)}`,
    code_commit: provenance.commit,
    code_commit_short: provenance.short,
    code_version_source: provenance.source,
    code_worktree_dirty: provenance.dirty,
    package_digest: provenance.package_digest,
    policy_version: DEFAULT_COMMIT_POLICY.version,
    gate_backend: input.gate.name,
    gate_backend_kind: input.gate.kind,
    gate_backend_reason: input.gate.reason,
    gate_production_verifier_available: input.gate.production_verifier_available,
    gate_model_sha256: input.gate.modelSha256,
    gate_tokenizer_sha256: input.gate.tokenizerSha256,
    gate_model_path: input.gate.modelPath,
    gate_entailment_threshold: input.gate.threshold,
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
    verifier_caveat: verifierCaveat,
    stages,
    review_burden: burden,
    targets,
    published_targets: targets.published,
    unmet_targets: targets.unmet,
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
        ? `Every v0.1 exit target passed on LedgerBench seed ${input.seed} under gate ${input.gate.name}` +
          `${input.gate.modelSha256 === null ? " (no model digest: the lexical stand-in)" : ` (model ${input.gate.modelSha256.slice(0, 12)}…)`}, ` +
          `and all ${conformancePassed} conformance traces met their required outcomes. ` +
          `${unimplementedStages.length} stage(s) remain unimplemented (${unimplementedStages.join(", ") || "none"}).`
        : `${verifierCaveat} ` +
          `Not passing: ${targets.checks.filter((check) => check.verdict === "fail").length} target(s) failed, ` +
          `${targets.checks.filter((check) => check.verdict === "not_measured").length} could not be measured, ` +
          `${conformanceFailed} conformance trace(s) failed a required check, and ${notEvaluated} ` +
          `expectation(s) were not evaluated.`,
    },
  };
}

/**
 * The code version published with every number, and where it came from.
 *
 * Read from git rather than from `GIT_COMMIT` because an environment variable is set by
 * whoever ran the job: a benchmark invoked by hand would publish `unknown`, which is
 * exactly the artifact that cannot be retained as release evidence. The environment
 * override still wins when present, so a CI job that checks out a shallow mirror can name
 * its revision explicitly, and `source` records which path was taken.
 *
 * The package digest is always computed. It is what makes a run from a modified tree
 * citable: the commit alone would attribute the number to code that was not the code.
 */
export function codeProvenance(repoRoot = process.cwd()): VersionProvenance {
  const packageDigest = digestPackage(repoRoot);
  const fromEnv = firstNonEmpty(process.env["VERITYMEM_CODE_VERSION"], process.env["GIT_COMMIT"]);
  if (fromEnv !== null) {
    return {
      commit: fromEnv,
      short: fromEnv.slice(0, 12),
      source: "environment",
      dirty: null,
      package_digest: packageDigest,
    };
  }
  const commit = git(["rev-parse", "HEAD"], repoRoot);
  if (commit === null) {
    return { commit: null, short: null, source: "unknown", dirty: null, package_digest: packageDigest };
  }
  const status = git(["status", "--porcelain"], repoRoot);
  return {
    commit,
    short: commit.slice(0, 12),
    source: "git",
    // `null` means git could not answer, which is different from "clean" and is recorded
    // as such rather than defaulted to false.
    dirty: status === null ? null : status.length > 0,
    package_digest: packageDigest,
  };
}

function git(args: readonly string[], cwd: string): string | null {
  try {
    return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | null {
  for (const value of values) {
    if (value !== undefined && value !== "") return value;
  }
  return null;
}

/**
 * A digest over this package's own sources.
 *
 * Read as bytes and hashed in sorted path order, so the value moves when the benchmark
 * changes and does not move when something unrelated does. It is the fallback identity for
 * a run whose revision cannot be named, and a cross-check for a run whose revision can.
 */
export function digestPackage(repoRoot: string): string {
  const directory = join(repoRoot, "packages", "ledgerbench", "src");
  const hash = createHash("sha256");
  let names: string[];
  try {
    names = readdirSorted(directory);
  } catch {
    return createHash("sha256").update("ledgerbench-sources-unavailable").digest("hex");
  }
  for (const name of names) {
    if (!name.endsWith(".ts")) continue;
    hash.update(name, "utf8");
    hash.update("\u0000", "utf8");
    hash.update(readFileSync(join(directory, name)));
    hash.update("\u0000", "utf8");
  }
  return hash.digest("hex");
}

function readdirSorted(directory: string): string[] {
  return readdirSync(directory).sort();
}

/** Every fixture path under a fixtures root, for the dataset digest. */
export function fixturePaths(root: string, relativePaths: readonly string[]): string[] {
  return relativePaths.map((path) => (path.startsWith("/") ? path : join(root, path)));
}
