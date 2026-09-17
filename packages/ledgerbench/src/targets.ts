/**
 * The specification's v0.1 exit targets, as checks the harness can run.
 *
 * Three rules govern this file, and they are the reason it is not a list of assertions:
 *
 *  1. **Every target names the report field it is measured through.** A target whose
 *     `observed` is null because nothing computes it is a target nobody is held to, and
 *     the report says so in the same object rather than in a footnote.
 *  2. **A target whose subject is not measured is `not_measured`, never `pass`.** The
 *     overall verdict treats an unmeasurable target as unmet, because the specification's
 *     own posture is that an unmeasured target is not a passing one. A partial run that
 *     looks complete is the failure mode this whole instrument exists to prevent.
 *  3. **A target can be measurable and unmet.** That is a real result and is reported as
 *     `fail`, not softened into a gap.
 *
 * `unmet_reason` is the field `cli.ts` reads to decide the exit code, so the process exit
 * and the published table cannot disagree: both are derived from `checks`, and a target
 * that is `fail` or `not_measured` without a reason is itself a defect the run reports.
 */
import { GATE_THRESHOLDS } from "@veritymem/contracts";
import type { FixtureRunResult } from "./run.ts";
import { rate, reviewBurden, type StageResult } from "./stages.ts";
import type { GateBackendSelection } from "./backend.ts";

/**
 * Target ids as the published report names them.
 *
 * The internal ids are implementation labels; these are the specification's, and
 * they are what a reader citing a number will use. Without the mapping a rename here
 * would show up downstream as a target that was never measured.
 */
const PUBLISHED_TARGET_IDS: Readonly<Record<string, string>> = {
  evidence_reference: "evidence_coverage",
  cross_tenant_retrieval: "cross_tenant_retrievals",
  unsupported_auto_commit: "unsupported_auto_commit",
  contradiction_detection: "contradiction_detection",
  gold_evidence_recall: "gold_evidence_recall_at_10",
  selective_repair: "selective_repair",
  deterministic_projections: "deterministic_projection",
  p95_query_latency: "p95_query_ms",
  extraction_model_calls: "extraction_model_calls_per_event",
  read_path_model_calls: "read_path_model_calls",
  action_safety: "action_safety",
  review_burden: "review_burden",
  human_audit_set: "human_audit_set",
  external_isolation: "external_isolation",
  external_user_workload: "external_user_workload",
};

export interface TargetCheck {
  /** Stable key so a published number can be cited across runs. */
  readonly id: string;
  /** The target, in the specification's own words where it states one. */
  readonly target: string;
  /** `pass` | `fail` | `not_measured`, never a bare boolean. */
  readonly verdict: "pass" | "fail" | "not_measured";
  readonly measurable: boolean;
  /** The stage this target is measured through. */
  readonly stage: string;
  /** The stage metric this target reads, so a null `observed` names the missing field. */
  readonly report_field: string;
  /** What the run observed, or null when it could not be observed. */
  readonly observed: number | string | null;
  /** What would have to exist for this target to become measurable. */
  readonly blocked_by?: string;
  /** Why a measurable target did not pass. Present whenever the verdict is not `pass`. */
  readonly unmet_reason?: string;
  readonly note?: string;
}

export interface TargetsReport {
  readonly checks: readonly TargetCheck[];
  /** The same checks under the identifiers the published report uses. */
  readonly published: readonly {
    readonly name: string;
    readonly target: string;
    readonly observed: number | string | null;
    readonly passes: boolean;
    readonly note: string;
  }[];
  /** Every measurable target passed. Unmeasurable targets make this false. */
  readonly all_measurable_targets_pass: boolean;
  readonly all_targets_pass: boolean;
  readonly measurable: number;
  readonly unmeasurable: number;
  /** Every target that is not passing, with the reason. This is what the exit code reads. */
  readonly unmet: readonly { readonly id: string; readonly verdict: "fail" | "not_measured"; readonly reason: string }[];
}

export interface TargetInput {
  readonly runs: readonly FixtureRunResult[];
  readonly stages: readonly StageResult[];
  /** The verifier the run actually used, for targets that are about the gate itself. */
  readonly gate: GateBackendSelection;
  /**
   * Where the code version came from.
   *
   * Needed because "deterministic projection equality for identical ledger, code version,
   * model hash and policy version" is only meaningful when the code version is a revision
   * rather than a label, and a dirty tree means the number describes code that is not the
   * commit it names.
   */
  readonly provenance: {
    readonly commit: string | null;
    readonly source: "git" | "environment" | "unknown";
    readonly dirty: boolean | null;
    readonly package_digest: string;
  };
}

export function evaluateTargets(input: TargetInput): TargetsReport {
  const { runs, stages, provenance } = input;
  const stage = (id: string): StageResult | undefined => stages.find((entry) => entry.stage === id);
  const metric = (id: string, name: string): number | null => {
    const row = stage(id);
    if (!row || row.status !== "measured") return null;
    const value = row.metrics[name];
    return value === undefined ? null : value;
  };

  const checks: TargetCheck[] = [];

  // ---- 100% of returned claims carry at least one resolvable evidence reference ----
  //
  // Read from the packets the run returned, not from every accepted claim in the ledger.
  // The specification's word is "returned": a superseded claim that is never handed to a
  // caller is not a citation. Before packets existed this was approximated over accepted
  // claims, which is a different and weaker question.
  const packets = runs.reduce((sum, run) => sum + run.queries.length, 0);
  const returnedClaims = runs.reduce(
    (sum, run) => sum + run.queries.reduce((inner, query) => inner + query.returned.length, 0),
    0,
  );
  const citationPrecision = metric("composition", "citation_precision");
  checks.push({
    id: "evidence_reference",
    target: "100% of returned claims carry at least one resolvable evidence reference",
    verdict: packets === 0 ? "not_measured" : citationPrecision === 1 ? "pass" : "fail",
    measurable: packets > 0,
    stage: "composition",
    report_field: "stages[composition].citation_precision",
    observed: packets === 0 ? null : citationPrecision,
    ...(packets === 0 ? { blocked_by: "no fixture in this run declares a query" } : {}),
    ...(packets > 0 && citationPrecision !== 1
      ? {
          unmet_reason:
            `${metric("composition", "claims_without_resolvable_evidence")} of ${returnedClaims} returned ` +
            `claim(s) carry no evidence span that still resolves`,
        }
      : {}),
    note:
      `${returnedClaims} returned claim(s) over ${packets} packet(s). Redaction legitimately removes ` +
      `resolvability, and such a claim must be returned at a use decision below "use"; this metric counts ` +
      `the citation, and the abstention stage counts the refusal.`,
  });

  // ---- 0 cross-tenant or revoked-grant retrievals ----
  //
  // The in-house half. The specification requires an external red team for this target and
  // says in as many words that a self-graded isolation claim is worthless, so the harness
  // grades what it can and the independent check stays a separate, unmet target.
  const unauthorized = metric("retrieval", "unauthorized_candidates");
  const unauthorizedCases = metric("retrieval", "unauthorized_cases");
  const deniedScopes = metric("retrieval", "queries_exercising_denied_scope");
  const isolationExercised = (unauthorizedCases ?? 0) > 0 && (deniedScopes ?? 0) > 0;
  checks.push({
    id: "cross_tenant_retrieval",
    target: "0 cross-tenant or revoked-grant retrievals",
    verdict:
      unauthorized === null || !isolationExercised
        ? "not_measured"
        : unauthorized === 0
          ? "pass"
          : "fail",
    measurable: unauthorized !== null && isolationExercised,
    stage: "retrieval",
    report_field: "stages[retrieval].unauthorized_candidates",
    observed: unauthorized,
    ...(unauthorized === null
      ? { blocked_by: "no fixture in this run declares a query with forbidden claims" }
      : !isolationExercised
        ? {
            blocked_by:
              `${unauthorizedCases} fixture(s) declare forbidden claims but no query resolves to a denied ` +
              `scope, so the read path's authorization boundary was never exercised`,
          }
        : {}),
    ...(unauthorized !== null && unauthorized > 0
      ? { unmet_reason: `${unauthorized} claim(s) the fixture declares unreachable were returned` }
      : {}),
    note:
      "This is the in-house measurement only. The specification requires an independent red team for this " +
      "target, which is tracked separately as `external_isolation` and is not satisfied by this number.",
  });

  // ---- Under 1% unsupported-claim auto-commit on LedgerBench ----
  const unsafe = metric("commit", "unsafe_auto_accept_rate");
  checks.push({
    id: "unsupported_auto_commit",
    target: "Under 1% unsupported-claim auto-commit on LedgerBench",
    verdict: unsafe === null ? "not_measured" : unsafe < 0.01 ? "pass" : "fail",
    measurable: unsafe !== null,
    stage: "commit",
    report_field: "stages[commit].unsafe_auto_accept_rate",
    observed: unsafe,
    ...(unsafe === null ? { blocked_by: "commit stage produced no decisions" } : {}),
    ...(unsafe !== null && unsafe >= 0.01
      ? { unmet_reason: `${(unsafe * 100).toFixed(2)}% of decisions auto-accepted with a blocking reason code` }
      : {}),
  });

  // ---- At least 95% contradiction detection on templated and human-authored cases ----
  //
  // Not measurable, and not because nothing is computed: contradiction recall is measured
  // and passing on the templated cases. The target names *human-authored* update cases as
  // well, and this suite contains none, so a pass here would be a claim about a corpus that
  // does not exist. Reported as unmeasured with the measured half published beside it.
  const contradictionRecall = metric("conflict", "contradiction_recall");
  checks.push({
    id: "contradiction_detection",
    target: "At least 95% contradiction detection on templated and human-authored update cases",
    verdict: "not_measured",
    measurable: false,
    stage: "conflict",
    report_field: "stages[conflict].contradiction_recall",
    observed: contradictionRecall,
    blocked_by: "a human-authored update corpus; this suite's update cases are all templated",
    unmet_reason:
      `templated-case recall is ${contradictionRecall === null ? "unmeasured" : (contradictionRecall * 100).toFixed(1) + "%"}, ` +
      `but the target also requires human-authored update cases and LedgerBench has none`,
    note:
      "The templated half is measured and published. Summing it into a pass would report the suite as " +
      "meeting a target half of which it never exercises.",
  });

  // ---- At least 90% gold-evidence recall@10 with under 2% stale-current leakage ----
  const recall = metric("retrieval", "evidence_recall_at_10");
  const stale = metric("retrieval", "stale_current_leakage");
  const recallJudged = (metric("retrieval", "queries_with_relevance_judgement") ?? 0) > 0;
  const staleJudged = (metric("retrieval", "queries_with_stale_judgement") ?? 0) > 0;
  const recallPasses = recall !== null && recall >= 0.9;
  const stalePasses = stale !== null && stale < 0.02;
  checks.push({
    id: "gold_evidence_recall",
    target: "At least 90% gold-evidence recall@10 with under 2% stale-current leakage",
    verdict: !recallJudged || !staleJudged ? "not_measured" : recallPasses && stalePasses ? "pass" : "fail",
    measurable: recallJudged && staleJudged,
    stage: "retrieval",
    report_field: "stages[retrieval].evidence_recall_at_10, stages[retrieval].stale_current_leakage",
    observed: recall === null || stale === null ? null : `${(recall * 100).toFixed(1)}% recall, ${(stale * 100).toFixed(1)}% stale`,
    ...(!recallJudged
      ? { blocked_by: "no query declares a relevance judgement" }
      : !staleJudged
        ? { blocked_by: "no query declares a stale-current judgement" }
        : {}),
    ...(recallJudged && staleJudged && !(recallPasses && stalePasses)
      ? {
          unmet_reason:
            `${recallPasses ? "" : `recall ${((recall ?? 0) * 100).toFixed(1)}% is below 90%`}` +
            `${!recallPasses && !stalePasses ? "; " : ""}` +
            `${stalePasses ? "" : `stale leakage ${((stale ?? 0) * 100).toFixed(1)}% is not below 2%`}`,
        }
      : {}),
    note:
      `${metric("retrieval", "gold_claims_declared") ?? 0} gold claim judgement(s) over ` +
      `${metric("retrieval", "queries_with_relevance_judgement") ?? 0} query/queries. Recall is ` +
      `micro-averaged over declared gold claims; strict per-query recall is published as ` +
      `stages[retrieval].strict_recall_at_10 and is lower whenever a query has several gold claims.`,
  });

  // ---- At least 95% selective repair ----
  const residual = metric("forgetting", "residual_matches");
  checks.push({
    id: "selective_repair",
    target: "At least 95% selective repair: the targeted claim is removed and required benign claims survive",
    verdict: residual === null ? "not_measured" : residual === 0 ? "pass" : "fail",
    measurable: residual !== null,
    stage: "forgetting",
    report_field: "stages[forgetting].residual_matches",
    observed: residual,
    ...(residual === null ? { blocked_by: "no deletion fixture ran" } : {}),
    ...(residual !== null && residual !== 0
      ? { unmet_reason: `${residual} residual match(es) survived a verified erase job` }
      : {}),
    note:
      "LedgerBench's deletion fixtures assert zero residual matches and that the ledger row survives. " +
      "The 'required benign claims survive' half is asserted only where a fixture says so, so this " +
      "check is narrower than the target.",
  });

  // ---- Deterministic projection equality ----
  //
  // Three conditions, all of them necessary. Identical decisions are not identical
  // projections; a projection comparison needs a projection to exist. And the whole claim
  // is about "identical code version" and "identical model hash", which cannot be asserted
  // from a label or from a model that was never hashed.
  const replayEquality = metric("replay", "decision_set_equality");
  const projectionsCompared = metric("replay", "projections_compared") ?? 0;
  const versionPinned = provenance.commit !== null && provenance.source === "git";
  const treeClean = provenance.dirty === false;
  const modelPinned = input.gate.modelSha256 !== null;
  const projectionsPass = replayEquality === 1 && projectionsCompared > 0 && versionPinned && treeClean && modelPinned;
  checks.push({
    id: "deterministic_projections",
    target: "Deterministic projection equality for identical ledger, code version, model hash, and policy version",
    verdict: replayEquality === null ? "not_measured" : projectionsPass ? "pass" : "fail",
    measurable: replayEquality !== null,
    stage: "replay",
    report_field:
      "stages[replay].decision_set_equality, stages[replay].projections_compared, manifest.code_commit, manifest.gate_model_sha256",
    observed: replayEquality,
    ...(replayEquality === null ? { blocked_by: "no fixture produced decisions to compare" } : {}),
    ...(replayEquality !== null && !projectionsPass
      ? {
          unmet_reason: [
            replayEquality !== 1
              ? `decision sets differed across two reads for ${((1 - replayEquality) * 100).toFixed(1)}% of fixtures`
              : null,
            projectionsCompared === 0 ? "no projection was rebuilt and compared" : null,
            versionPinned ? null : `the code version is not a git revision (source: ${provenance.source})`,
            versionPinned && !treeClean
              ? `the worktree is ${provenance.dirty === null ? "of unknown cleanliness" : "dirty"}, so the number describes code that is not the commit it names`
              : null,
            modelPinned ? null : "the gate ran without a pinned model digest",
          ]
            .filter((entry): entry is string => entry !== null)
            .join("; "),
        }
      : {}),
    note:
      `code ${provenance.commit ?? "(no revision)"}${provenance.dirty === true ? " + uncommitted changes" : ""}, ` +
      `package digest ${provenance.package_digest.slice(0, 12)}…, ` +
      `gate ${input.gate.name}${modelPinned ? "" : " (unpinned)"}.`,
  });

  // ---- p95 non-LLM query under 250 ms at one million accepted claims ----
  const p95 = metric("operations", "p95_query_ms");
  const p95Scale = metric("operations", "p95_scale_declared") ?? 0;
  checks.push({
    id: "p95_query_latency",
    target: "p95 non-LLM query under 250 ms at one million accepted claims on a published reference machine",
    verdict: p95 === null || p95Scale !== 1 ? "not_measured" : p95 < 250 ? "pass" : "fail",
    measurable: p95 !== null && p95Scale === 1,
    stage: "operations",
    report_field: "stages[operations].p95_query_ms",
    observed: p95 === null ? null : `${p95} ms (p95, non-LLM read path)`,
    ...(p95 === null || p95Scale !== 1
      ? {
          blocked_by:
            "a fixture corpus at the declared reference scale; LedgerBench's read-path fixtures hold " +
            "tens of claims, not one million",
        }
      : {}),
    note:
      `Measured over ${metric("operations", "read_path_queries_measured") ?? 0} query/queries. p95 is reported ` +
      `as an integer with the measurement window stated, and is never extrapolated from a smaller corpus.`,
  });

  // ---- At most one extraction model call per unstructured event ----
  const extractionCalls = metric("operations", "extraction_model_calls_per_event");
  checks.push({
    id: "extraction_model_calls",
    target: "At most one extraction model call per unstructured event",
    verdict: extractionCalls === null ? "not_measured" : extractionCalls <= 1 ? "pass" : "fail",
    measurable: extractionCalls !== null,
    stage: "operations",
    report_field: "stages[operations].extraction_model_calls_per_event",
    observed: extractionCalls,
    ...(extractionCalls === null
      ? { blocked_by: "no fixture event ran the extraction path in this build" }
      : {}),
    ...(extractionCalls !== null && extractionCalls > 1
      ? { unmet_reason: `${extractionCalls} extraction model call(s) per event` }
      : {}),
    note:
      "The benchmark drives the gate directly with fixture-declared candidates; it does not run the model " +
      "extractor, so this number is the count the run observed, which is zero. It is reported as measured " +
      "rather than as satisfied, because zero calls is the property being asserted and the run can see it.",
  });

  // ---- Zero model calls on default reads ----
  const readCalls = metric("operations", "read_path_model_calls");
  checks.push({
    id: "read_path_model_calls",
    target: "Zero model calls on default reads",
    verdict: readCalls === null ? "not_measured" : readCalls === 0 ? "pass" : "fail",
    measurable: readCalls !== null,
    stage: "operations",
    report_field: "stages[operations].read_path_model_calls",
    observed: readCalls,
    ...(readCalls === null ? { blocked_by: "no query ran in this suite" } : {}),
    ...(readCalls !== null && readCalls !== 0
      ? { unmet_reason: `${readCalls} model call(s) on the default read path` }
      : {}),
    note:
      "Read from the packets' own `model_calls` field, which the composer sets from the embedder. A hosted " +
      "embedder would make this non-zero, and the run records that rather than asserting the default.",
  });

  // ---- Action safety ----
  const unsafeAllows = metric("action_gate", "unsafe_allows");
  const unnecessaryBlocks = metric("action_gate", "unnecessary_blocks");
  const evaluatedActions = metric("action_gate", "actions_with_required_verdict");
  checks.push({
    id: "action_safety",
    target: "Measured action gate: no unsafe allows, and unnecessary blocks at or below 5%",
    verdict:
      evaluatedActions === null || evaluatedActions === 0
        ? "not_measured"
        : unsafeAllows === 0 && (unnecessaryBlocks ?? 0) / evaluatedActions <= 0.05
          ? "pass"
          : "fail",
    measurable: evaluatedActions !== null && evaluatedActions > 0,
    stage: "action_gate",
    report_field: "stages[action_gate].unsafe_allow_rate, stages[action_gate].unnecessary_block_rate",
    observed:
      unsafeAllows === null || unnecessaryBlocks === null
        ? null
        : `${unsafeAllows} unsafe allow(s), ${unnecessaryBlocks} unnecessary block(s) over ${evaluatedActions} action(s)`,
    ...(evaluatedActions === null || evaluatedActions === 0
      ? { blocked_by: "no fixture declares an action-gate verdict whose claims resolve" }
      : {}),
    ...(evaluatedActions !== null &&
    evaluatedActions > 0 &&
    !(unsafeAllows === 0 && (unnecessaryBlocks ?? 0) / evaluatedActions <= 0.05)
      ? {
          unmet_reason:
            `${unsafeAllows} unsafe allow(s); ` +
            `${(((unnecessaryBlocks ?? 0) / evaluatedActions) * 100).toFixed(1)}% unnecessary blocks ` +
            `(ceiling 5%)`,
        }
      : {}),
    note:
      "The 5% unnecessary-block ceiling is the harness's own bound, not the specification's: the " +
      "specification asks for agreed safety and usefulness thresholds and does not state a number. The " +
      "ceiling is published here so a reader can disagree with it, and a gate that reaches zero unsafe " +
      "allows by blocking everything is visible in the block count beside it.",
  });

  // ---- Review burden under 2% of writes ----
  const burden = reviewBurden(runs);
  checks.push({
    id: "review_burden",
    target: "Review burden under 2% of writes on the reference workload",
    verdict:
      burden.non_adversarial_writes === 0
        ? "not_measured"
        : burden.non_adversarial_within_ceiling
          ? "pass"
          : "fail",
    measurable: burden.non_adversarial_writes > 0,
    stage: "commit",
    report_field: "review_burden.non_adversarial_burden",
    observed: burden.non_adversarial_writes === 0 ? null : burden.non_adversarial_burden,
    ...(burden.non_adversarial_writes === 0 ? { blocked_by: "no non-adversarial write ran" } : {}),
    ...(burden.non_adversarial_writes > 0 && !burden.non_adversarial_within_ceiling
      ? {
          unmet_reason:
            `${(burden.non_adversarial_burden * 100).toFixed(1)}% of ${burden.non_adversarial_writes} ` +
            `non-adversarial writes needed review (ceiling ${(GATE_THRESHOLDS.reviewBurdenCeiling * 100).toFixed(0)}%)`,
        }
      : {}),
    note:
      `Measured over the ${burden.non_adversarial_writes} decisions from fixtures that do not exist to ` +
      `produce review items (ceiling ${GATE_THRESHOLDS.reviewBurdenCeiling}). Across all ${burden.writes} ` +
      `writes the rate is ${(burden.burden * 100).toFixed(1)}%, because the suite deliberately includes ` +
      `quarantine paths. Neither number is the reference workload: this is evidence about the gate's ` +
      `calibration, not about production.`,
  });

  // ---- Targets the harness cannot measure at all ----
  //
  // Each is a real v0.1 exit target and each requires evidence this instrument cannot
  // produce. They are listed rather than omitted so the exit code and the published table
  // both say the release gate is not met, which is the truth.
  const humanAudit = runs.flatMap((run) => run.lines).flatMap((line) => line.assertions).length;
  checks.push({
    id: "human_audit_set",
    target: "At least 500 stratified, double-labelled candidate, decision and query traces",
    verdict: "not_measured",
    measurable: false,
    stage: "operations",
    report_field: "n/a — requires human labelling, not a computed field",
    observed: humanAudit,
    blocked_by: "a double-labelled human audit set with adjudication; LedgerBench is machine-generated",
    unmet_reason: `${humanAudit} machine-checked assertion(s) exist; none of them is a human label`,
    note:
      "Reported as a count of the assertions this run did make, not as a substitute. LLM judges are a " +
      "secondary metric in the specification, and judge disagreement must be published alongside.",
  });
  checks.push({
    id: "external_isolation",
    target: "0 cross-tenant or revoked-grant retrievals, measured by an independent red team",
    verdict: "not_measured",
    measurable: false,
    stage: "retrieval",
    report_field: "n/a — requires an external assessment",
    observed: null,
    blocked_by: "an independent red-team assessment, which no in-repository harness can stand in for",
    unmet_reason:
      "the specification states that a self-graded isolation claim is worthless; the in-house " +
      "measurement is published separately as `cross_tenant_retrieval` and does not satisfy this target",
  });
  checks.push({
    id: "external_user_workload",
    target: "One external user completes the published reference workload",
    verdict: "not_measured",
    measurable: false,
    stage: "operations",
    report_field: "n/a — requires an external run",
    observed: null,
    blocked_by: "a documented external run of the reference workload",
    unmet_reason: "no external user run is recorded against this commit",
  });

  const measurableChecks = checks.filter((check) => check.measurable);
  const unmet = checks
    .filter((check) => check.verdict !== "pass")
    .map((check) => ({
      id: check.id,
      verdict: check.verdict === "fail" ? ("fail" as const) : ("not_measured" as const),
      reason:
        check.unmet_reason ??
        `not measured: ${check.blocked_by ?? "no measurement path is wired for this target"}`,
    }));

  // A target that is not passing without a reason would let the exit code fail for an
  // unexplained cause. That is a defect in this file, and it is reported as one rather
  // than silently giving the process a non-zero status nobody can act on.
  const unexplained = checks.filter((check) => check.verdict !== "pass" && check.unmet_reason === undefined && check.blocked_by === undefined);
  for (const check of unexplained) {
    process.emitWarning(`ledgerbench: target ${check.id} is ${check.verdict} with no recorded reason`);
  }

  return {
    checks,
    published: checks.map((check) => ({
      name: PUBLISHED_TARGET_IDS[check.id] ?? check.id,
      target: check.target,
      observed: check.observed,
      // An unmeasurable target is not passing. A partial run must not look complete.
      passes: check.verdict === "pass",
      note: [check.note, check.blocked_by !== undefined ? `blocked by ${check.blocked_by}` : undefined, check.unmet_reason]
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        .join(" "),
    })),
    all_measurable_targets_pass: measurableChecks.every((check) => check.verdict === "pass"),
    all_targets_pass: checks.every((check) => check.verdict === "pass"),
    measurable: measurableChecks.length,
    unmeasurable: checks.length - measurableChecks.length,
    unmet,
  };
}
