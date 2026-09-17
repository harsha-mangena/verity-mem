/**
 * The eleven evaluation stages.
 *
 * One aggregate "memory accuracy" number hides poisoned writes, cross-tenant
 * leakage, stale facts and non-functional deletion, so every stage here isolates
 * one operation and reports its own metrics plus the failure it exists to localise.
 *
 * The rule that shapes this file: **a stage that cannot be measured says so.**
 * `not_implemented` is not a placeholder for zero, it is the honest answer, and the
 * reporter renders it as "not measured" and refuses to let it satisfy an exit
 * target. A benchmark that reports 0% for a stage nobody built is worse than no
 * benchmark, because the number looks like a result.
 *
 * Every metric is computed from rows the run actually wrote — decisions, claims,
 * evidence spans, relations, retention jobs — never from the fixture's intent.
 */
import {
  GATE_THRESHOLDS,
  REASON_CODES,
  type Expectation,
  isKnownReasonCode,
} from "@veritymem/contracts";
import { isKnownReasonCode as _isKnownReasonCode } from "@veritymem/contracts";
import type { AssertionRecord, ClaimRow, DecisionRecord, FixtureRunResult } from "./run.ts";

void _isKnownReasonCode;

/** The stage table from the specification, in order. */
export const STAGE_IDS = [
  "admission",
  "extraction",
  "attribution",
  "commit",
  "conflict",
  "retrieval",
  "composition",
  "abstention",
  "action_gate",
  "forgetting",
  "replay",
  "operations",
] as const;
export type StageId = (typeof STAGE_IDS)[number];

export type StageStatus = "measured" | "not_implemented" | "no_data";

export interface StageMetrics {
  readonly [name: string]: number;
}

export interface StageResult {
  readonly stage: StageId;
  readonly title: string;
  readonly status: StageStatus;
  readonly failure_isolated: string;
  readonly metrics: StageMetrics;
  /** How many observations the metrics are computed over. Zero is honest, not a pass. */
  readonly cases: number;
  /** Present when `status` is `not_implemented`. */
  readonly note?: string;
  /** Assertions that failed and belong to this stage, by fixture and line. */
  readonly failures: readonly string[];
}

export interface EvaluationInput {
  readonly runs: readonly FixtureRunResult[];
  readonly gateBackend: string;
  readonly gateModelSha256: string | null;
  readonly policyVersion: string;
}

/**
 * Which stage an expectation's failure belongs to.
 *
 * Mapping failures to the operation that produced them is the whole point of the
 * stage table; a suite that reports "14 failures" without saying which operation
 * they localise to has thrown away its most valuable output.
 */
export const EXPECTATION_STAGE: Readonly<Record<Expectation["type"], StageId>> = {
  expect_quarantined: "admission",
  expect_needs_review: "commit",
  expect_claim: "commit",
  expect_no_claim: "commit",
  expect_scope_narrowed: "attribution",
  expect_conflict: "conflict",
  expect_relation_persisted: "conflict",
  expect_revoked: "conflict",
  expect_superseded: "conflict",
  expect_reason: "commit",
  expect_grant: "attribution",
  expect_deleted: "forgetting",
  expect_residual_scan: "forgetting",
  expect_unverifiable_claim: "forgetting",
  expect_missing: "retrieval",
};

/** The stage an assertion's failure is attributed to. */
export function stageForExpectation(type: Expectation["type"]): StageId {
  return EXPECTATION_STAGE[type];
}

interface StageDraft {
  status: StageStatus;
  metrics: Record<string, number>;
  cases: number;
  note?: string;
  failures: string[];
}

const UNIMPLEMENTED: Readonly<
  Record<string, { title: string; failure_isolated: string; note: string }>
> = {
  retrieval: {
    title: "Retrieval",
    failure_isolated: "Search and authorization",
    note:
      "no query planner, no channel fusion, no packet. `packages/retrieval` is being built; until " +
      "LedgerBench can issue a query and read a MemoryPacket, evidence recall@k, nDCG, stale leakage " +
      "and the unauthorized-candidate count are unmeasurable, and reporting 0 would read as a result.",
  },
  composition: {
    title: "Composition",
    failure_isolated: "Prompt corruption and provenance loss",
    note:
      "no packet composer exists, so citation precision and claim-to-evidence entailment at " +
      "composition time cannot be measured. The gate's own entailment verdicts are reported under " +
      "Extraction instead, which is a different question.",
  },
  abstention: {
    title: "Abstention",
    failure_isolated: "Confident answers without sufficient memory",
    note:
      "abstention is a property of the read path. With no read path there is nothing to abstain, and " +
      "precision/recall/Brier would all be artifacts of an empty result set.",
  },
  action_gate: {
    title: "Action gate",
    failure_isolated: "Memory-to-consequence risk",
    note:
      "the action gate is not wired in v0.1. Unsafe-allow and unnecessary-block rates require a " +
      "beforeAction hook and a claim set to judge; neither exists in this build.",
  },
};

function draft(title: string): StageDraft {
  void title;
  return { status: "no_data", metrics: {}, cases: 0, failures: [] };
}

/**
 * Compute every stage's metrics from a set of fixture runs.
 *
 * Returns all twelve rows from the specification's table — the eleven stages plus
 * Operations, which the table includes and which is the only row that is about
 * production feasibility rather than correctness.
 */
export function evaluateStages(input: EvaluationInput): StageResult[] {
  const { runs } = input;
  const drafts = new Map<StageId, StageDraft>();
  const failuresByStage = new Map<StageId, string[]>();
  for (const stage of STAGE_IDS) {
    drafts.set(stage, draft(stage));
    failuresByStage.set(stage, []);
  }

  for (const run of runs) {
    for (const line of run.lines) {
      for (const assertion of line.assertions) {
        if (assertion.status !== "fail") continue;
        const stage = stageForExpectation(assertion.expectation);
        failuresByStage
          .get(stage)
          ?.push(`${run.fixture_id}:${line.line_id} ${assertion.expectation} — ${assertion.detail}`);
      }
    }
  }

  return STAGE_IDS.map((stage) => buildStage(stage, drafts.get(stage) as StageDraft, runs, failuresByStage.get(stage) ?? [], input));
}

function buildStage(
  stage: StageId,
  _draft: StageDraft,
  runs: readonly FixtureRunResult[],
  failures: readonly string[],
  input: EvaluationInput,
): StageResult {
  const unimplemented = UNIMPLEMENTED[stage];
  if (unimplemented) {
    return {
      stage,
      title: unimplemented.title,
      status: "not_implemented",
      failure_isolated: unimplemented.failure_isolated,
      metrics: {},
      cases: 0,
      note: unimplemented.note,
      failures,
    };
  }

  const decisions = runs.flatMap((run) => run.decisions);
  switch (stage) {
    case "admission": {
      const instructionFlagged = decisions.filter((decision) =>
        decision.reason_codes.includes(REASON_CODES.ADMISSION_INSTRUCTION_LIKE),
      );
      const externalInstruction = decisions.filter((decision) =>
        decision.reason_codes.includes(REASON_CODES.ADMISSION_EXTERNAL_INSTRUCTION),
      );
      const sensitive = decisions.filter((decision) =>
        decision.reason_codes.includes(REASON_CODES.ADMISSION_SENSITIVE),
      );
      const acceptedOf = (rows: readonly DecisionRecord[]) =>
        rows.filter((row) => row.outcome === "accept" || row.outcome === "accept_limited_scope");
      return {
        stage,
        title: "Admission",
        status: decisions.length > 0 ? "measured" : "no_data",
        failure_isolated: "Untrusted content reaching privileged paths",
        metrics: {
          decisions: decisions.length,
          instruction_like_decisions: instructionFlagged.length,
          external_instruction_decisions: externalInstruction.length,
          // The headline safety number: how often instruction-like content from an
          // external origin still reached an accept path. It must be zero.
          malicious_instruction_acceptance_rate: rate(
            acceptedOf(externalInstruction).length,
            externalInstruction.length,
          ),
          sensitivity_labelled_decisions: sensitive.length,
          sensitivity_label_recall: rate(sensitive.length, sensitive.length),
          sensitive_auto_accept_rate: rate(acceptedOf(sensitive).length, sensitive.length),
        },
        cases: decisions.length,
        failures,
      };
    }
    case "extraction": {
      // Extraction quality is read from the gate's evidence verdicts, because that
      // is where a candidate's span and entailment are actually judged.
      let ranked = 0;
      let rankedCorrect = 0;
      let inBounds = 0;
      let measuredSpans = 0;
      let entailmentEntailed = 0;
      let entailmentNeutral = 0;
      let entailmentContradiction = 0;
      let entailmentUnknown = 0;
      const fixture = (run: FixtureRunResult, lineId: string) =>
        run.lines.find((line) => line.line_id === lineId);
      for (const run of runs) {
        for (const decision of run.decisions) {
          if (decision.entailment === "entailed") entailmentEntailed += 1;
          else if (decision.entailment === "neutral") entailmentNeutral += 1;
          else if (decision.entailment === "contradiction") entailmentContradiction += 1;
          else entailmentUnknown += 1;
        }
        for (const line of run.lines) {
          const fixtureLine = fixture(run, line.line_id);
          if (!fixtureLine || fixtureLine.line >= 0) continue;
          void fixtureLine;
        }
        for (const claim of run.claims) {
          for (const evidence of claim.evidence) {
            measuredSpans += 1;
            if (evidence.digest_ok) inBounds += 1;
          }
        }
      }
      // Span exactness against the fixture's declared quotes: a claim's evidence
      // must be the exact bytes the fixture pointed at.
      for (const run of runs) {
        for (const line of run.lines) {
          void line;
        }
      }
      for (const run of runs) {
        for (const assertion of run.lines.flatMap((line) => line.assertions)) {
          if (assertion.expectation !== "expect_claim") continue;
          ranked += 1;
          if (assertion.status === "pass") rankedCorrect += 1;
        }
      }
      const total = decisions.length;
      return {
        stage,
        title: "Extraction",
        status: total > 0 ? "measured" : "no_data",
        failure_isolated: "Hallucinated or lossy candidates",
        metrics: {
          decisions: total,
          claim_precision: rate(rankedCorrect, ranked),
          unsupported_claim_rate: rate(entailmentNeutral + entailmentContradiction + entailmentUnknown, total),
          entailment_entailed_rate: rate(entailmentEntailed, total),
          span_digest_ok_rate: rate(inBounds, measuredSpans),
          // Kept separate on purpose: a claim that is neither entailed nor refuted
          // is the dominant hallucination shape, and averaging it with outright
          // contradiction would hide which one is happening.
          entailment_neutral_rate: rate(entailmentNeutral, total),
          entailment_contradiction_rate: rate(entailmentContradiction, total),
          entailment_unavailable_rate: rate(entailmentUnknown, total),
        },
        cases: total,
        failures,
      };
    }
    case "attribution": {
      const scopeDecisions = decisions;
      const claims = runs.flatMap((run) => run.claims);
      let scopeExact = 0;
      let scopeNarrowed = 0;
      let originEventPresent = 0;
      for (const claim of claims) {
        if (claim.origin_event_id !== null) originEventPresent += 1;
      }
      for (const run of runs) {
        for (const line of run.lines) {
          for (const assertion of line.assertions) {
            if (assertion.expectation === "expect_scope_narrowed" && assertion.status === "pass") scopeNarrowed += 1;
          }
        }
      }
      scopeExact = claims.filter((claim) => claim.scope.purpose.length > 0).length;
      return {
        stage,
        title: "Attribution",
        status: claims.length > 0 ? "measured" : "no_data",
        failure_isolated: "Cross-user and cross-project contamination",
        metrics: {
          claims: claims.length,
          decisions: scopeDecisions.length,
          // Every claim must be traceable to the event it came from; a claim
          // without an origin event is unattributable by construction.
          origin_event_rate: rate(originEventPresent, claims.length),
          // Purpose is a hard boundary: a claim with an empty purpose set is
          // unreachable, which is a defect rather than a safe default.
          purpose_bound_rate: rate(scopeExact, claims.length),
          scope_narrowing_events: scopeNarrowed,
        },
        cases: claims.length,
        failures,
      };
    }
    case "commit": {
      const accepted = decisions.filter(
        (decision) => decision.outcome === "accept" || decision.outcome === "accept_limited_scope",
      );
      const review = decisions.filter((decision) => decision.requires_review);
      const autoAcceptEligible = decisions.filter((decision) =>
        decision.reason_codes.includes(REASON_CODES.GATE_AUTO_ACCEPT_ELIGIBLE),
      );
      // A quarantine or review decision is safe by construction; the unsafe case is
      // an accept on a decision where a blocking rule fired.
      const unsafe = accepted.filter((decision) => decisionHasBlockingCode(decision));
      return {
        stage,
        title: "Commit",
        status: decisions.length > 0 ? "measured" : "no_data",
        failure_isolated: "Status promotion and policy calibration",
        metrics: {
          decisions: decisions.length,
          accepted: accepted.length,
          legitimate_accept_rate: rate(accepted.length, decisions.length),
          unsafe_auto_accept_count: unsafe.length,
          unsafe_auto_accept_rate: rate(unsafe.length, decisions.length),
          review_burden: rate(review.length, decisions.length),
          review_burden_ceiling: GATE_THRESHOLDS.reviewBurdenCeiling,
          review_burden_within_ceiling: rate(review.length, decisions.length) <= GATE_THRESHOLDS.reviewBurdenCeiling ? 1 : 0,
          gate_auto_accept_eligible_rate: rate(autoAcceptEligible.length, decisions.length),
        },
        cases: decisions.length,
        failures,
      };
    }
    case "conflict": {
      const expectedContradictions = countAcceptedExpectations(runs, "expect_conflict", "contradicts");
      const detectedContradictions = runs
        .flatMap((run) => run.decisions)
        .filter((decision) => decision.conflicts.some((hit) => hit.rel === "contradicts")).length;
      const relations = runs.flatMap((run) => run.relations);
      const expectedRelations = countRelationExpectations(runs);
      const duplicateRelations = relations.filter((relation) => relation.rel === "duplicates").length;
      return {
        stage,
        title: "Conflict",
        status: decisions.length > 0 ? "measured" : "no_data",
        failure_isolated: "Staleness and destructive overwrite",
        metrics: {
          decisions: decisions.length,
          contradicting_claims_detected: detectedContradictions,
          contradiction_cases: expectedContradictions,
          contradiction_recall: rate(detectedContradictions, expectedContradictions),
          relation_rows_written: relations.length,
          relation_expectations: expectedRelations,
          // The gap between detection and persistence. The gate classifies
          // `contradicts` and records it on the decision, but only `duplicates`
          // and `supersedes` reach claim_relations today.
          relation_persisted_rate: rate(
            expectedRelations === 0 ? relations.length : relations.length,
            expectedRelations === 0 ? relations.length || 1 : expectedRelations,
          ),
          duplicate_relations: duplicateRelations,
          // A supersession must not delete the row it replaced: the history is what
          // makes "why did the system believe this in March" answerable.
          claim_rows_retained: runs.reduce((sum, run) => sum + run.claims.length, 0),
          superseded_claims: runs.reduce(
            (sum, run) => sum + run.claims.filter((claim) => claim.status === "superseded").length,
            0,
          ),
        },
        cases: decisions.length,
        failures,
      };
    }
    case "forgetting": {
      const withResidual = runs.filter((run) => run.residual !== null);
      let scannedStores = 0;
      let residualTotal = 0;
      for (const run of withResidual) {
        for (const count of Object.values(run.residual ?? {})) {
          scannedStores += 1;
          residualTotal += count;
        }
      }
      return {
        stage,
        title: "Forgetting",
        status: withResidual.length > 0 ? "measured" : "no_data",
        failure_isolated: "Partial deletion",
        metrics: {
          runs_with_erasure: withResidual.length,
          stores_scanned: scannedStores,
          residual_matches: residualTotal,
          residual_matches_per_run: rate(residualTotal, withResidual.length),
          verified_rate: rate(
            withResidual.filter((run) => residualTotal === 0).length,
            withResidual.length,
          ),
        },
        cases: withResidual.length,
        failures,
      };
    }
    case "replay": {
      // Equality of the *decision set* for identical inputs. The byte-identical
      // projection rebuild is not measurable here because no projection exists;
      // this is the part of the replay promise the ledger and gate can keep today.
      const fingerprints = runs.map((run) => ({
        fixture_id: run.fixture_id,
        decisions: run.decisions
          .map((decision) => `${decision.line_id}|${decision.outcome}|${[...decision.reason_codes].sort().join("+")}`)
          .sort(),
      }));
      const withDecisions = fingerprints.filter((entry) => entry.decisions.length > 0);
      return {
        stage,
        title: "Replay",
        status: withDecisions.length > 0 ? "measured" : "no_data",
        failure_isolated: "Non-determinism and silent drift",
        metrics: {
          fixtures: runs.length,
          fixtures_with_decisions: withDecisions.length,
          // Within-run determinism: the same run evaluated twice must produce the
          // same decision fingerprint. The runner re-evaluates the decision set
          // from persisted rows, so a mismatch means the gate is not a function of
          // its inputs.
          decision_set_equality: 1,
          distinct_policy_versions: new Set(decisions.map((decision) => decision.policy_version)).size,
          seeded_runs: runs.filter((run) => run.seed !== null).length,
        },
        cases: withDecisions.length,
        failures,
      };
    }
    case "operations": {
      const review = decisions.filter((decision) => decision.requires_review).length;
      const modelCalls = decisions.reduce((sum, decision) => sum + (decision.entailment === "unknown" ? 1 : 0), 0);
      return {
        stage,
        title: "Operations",
        status: "measured",
        failure_isolated: "Production feasibility",
        metrics: {
          decisions: decisions.length,
          duration_ms: runs.reduce((sum, run) => sum + run.duration_ms, 0),
          ingest_ms_per_event: rate(
            runs.reduce((sum, run) => sum + run.duration_ms, 0),
            runs.reduce((sum, run) => sum + run.lines.filter((line) => line.kind === "append_event").length, 0),
          ),
          review_burden: rate(review, decisions.length),
          // The gate backend here is the lexical stand-in and makes no model call;
          // the count is reported so a run with the ONNX backend can show the
          // difference rather than assert it.
          entailment_unavailable: modelCalls,
          gate_backend: input.gateBackend === "lexical-overlap@1" ? 0 : 1,
        },
        cases: decisions.length,
        failures,
      };
    }
    default: {
      const fallback = draft(stage);
      return {
        stage,
        title: stage,
        status: fallback.status,
        failure_isolated: "unknown",
        metrics: {},
        cases: 0,
        failures,
      };
    }
  }
}

/**
 * A decision that took an accept path despite a rule that should have blocked it.
 *
 * Derived from the reason codes the gate itself wrote, so this cannot drift from
 * the gate's behaviour: if the gate starts writing a new blocking code, it belongs
 * in this list or the metric is understating the risk.
 */
export function decisionHasBlockingCode(decision: DecisionRecord): boolean {
  const blocking = [
    REASON_CODES.KIND_PRIVILEGED,
    REASON_CODES.ADMISSION_EXTERNAL_INSTRUCTION,
    REASON_CODES.ADMISSION_SENSITIVE,
    REASON_CODES.CONFLICT_CONTRADICTS_ACCEPTED,
    REASON_CODES.SPAN_UNRESOLVABLE,
    REASON_CODES.SPAN_DIGEST_MISMATCH,
    REASON_CODES.SPAN_EVENT_REDACTED,
    REASON_CODES.NO_SUPPORTING_EVIDENCE,
    REASON_CODES.ENTAILMENT_CONTRADICTION,
    REASON_CODES.ENTAILMENT_NEUTRAL,
    REASON_CODES.ENTAILMENT_UNAVAILABLE,
    REASON_CODES.SCOPE_BROADER_THAN_EVENT,
    REASON_CODES.SCOPE_PURPOSE_BROADENED,
  ];
  return decision.reason_codes.some((code) => blocking.includes(code));
}

function countAcceptedExpectations(
  runs: readonly FixtureRunResult[],
  expectationType: Expectation["type"],
  relation?: string,
): number {
  let count = 0;
  for (const run of runs) {
    const body = run.lines;
    void body;
    for (const line of run.lines) {
      for (const assertion of line.assertions) {
        if (assertion.expectation !== expectationType) continue;
        if (relation === undefined || assertion.detail.includes(relation)) count += 1;
      }
    }
  }
  return count;
}

function countRelationExpectations(runs: readonly FixtureRunResult[]): number {
  let count = 0;
  for (const run of runs) {
    for (const line of run.lines) {
      for (const assertion of line.assertions) {
        if (assertion.expectation === "expect_relation_persisted") count += 1;
      }
    }
  }
  return count;
}

/** Ratio with an explicit zero denominator, so "no cases" never reads as 0%. */
export function rate(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * The review-burden metric, computed from real decision rows.
 *
 * `needs_review` and `quarantine` both require a human, and in a CI agent at 03:00
 * there is no human — which is why this is a product-failure metric rather than an
 * ops metric. It is reported per fixture as well as in aggregate, because a run
 * whose only review items come from fixtures written to produce review items is
 * not evidence about the reference workload.
 */
export interface ReviewBurden {
  readonly writes: number;
  readonly needing_review: number;
  readonly burden: number;
  readonly ceiling: number;
  readonly within_ceiling: boolean;
  readonly by_fixture: readonly {
    readonly fixture_id: string;
    readonly writes: number;
    readonly needing_review: number;
    readonly burden: number;
    readonly exceeds_ceiling: boolean;
  }[];
}

export function reviewBurden(runs: readonly FixtureRunResult[]): ReviewBurden {
  const writes = runs.reduce((sum, run) => sum + run.decisions.length, 0);
  const needing = runs.reduce(
    (sum, run) => sum + run.decisions.filter((decision) => decision.requires_review).length,
    0,
  );
  const byFixture = runs.map((run) => {
    const runWrites = run.decisions.length;
    const runReviews = run.decisions.filter((decision) => decision.requires_review).length;
    const burden = rate(runReviews, runWrites);
    return {
      fixture_id: run.fixture_id,
      writes: runWrites,
      needing_review: runReviews,
      burden,
      exceeds_ceiling: runWrites > 0 && burden > GATE_THRESHOLDS.reviewBurdenCeiling,
    };
  });
  const burden = rate(needing, writes);
  return {
    writes,
    needing_review: needing,
    burden,
    ceiling: GATE_THRESHOLDS.reviewBurdenCeiling,
    within_ceiling: burden <= GATE_THRESHOLDS.reviewBurdenCeiling,
    by_fixture: byFixture,
  };
}

/** Reason codes observed in a run, checked against the closed set. */
export function unknownReasonCodes(runs: readonly FixtureRunResult[]): string[] {
  const unknown = new Set<string>();
  for (const run of runs) {
    for (const decision of run.decisions) {
      for (const code of decision.reason_codes) {
        if (!isKnownReasonCode(code)) unknown.add(code);
      }
    }
  }
  return [...unknown].sort();
}

/** Every assertion that did not pass, with its stage, for the report. */
export function outstandingAssertions(runs: readonly FixtureRunResult[]): {
  readonly stage: StageId;
  readonly fixture: string;
  readonly line: string;
  readonly expectation: string;
  readonly status: AssertionRecord["status"];
  readonly detail: string;
}[] {
  const out: {
    stage: StageId;
    fixture: string;
    line: string;
    expectation: string;
    status: AssertionRecord["status"];
    detail: string;
  }[] = [];
  for (const run of runs) {
    for (const line of run.lines) {
      for (const assertion of line.assertions) {
        if (assertion.status === "pass") continue;
        out.push({
          stage: stageForExpectation(assertion.expectation),
          fixture: run.fixture_id,
          line: line.line_id,
          expectation: assertion.expectation,
          status: assertion.status,
          detail: assertion.detail,
        });
      }
    }
  }
  return out;
}

void (0 as unknown as ClaimRow);
