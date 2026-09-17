/**
 * The conformance replay oracle.
 *
 * Phase 0 of the specification requires ten end-to-end adversarial traces and a
 * replay oracle that runs them. The oracle does not grade the trace by reading its
 * prose: it executes the trace through the same runner the fixtures use and then
 * checks the required outcome against what was persisted.
 *
 * A trace may declare an `unimplemented_outcome`. That is not a get-out: it names a
 * requirement the specification makes and the current build cannot meet, and the
 * oracle reports it as an outstanding gap. A trace that quietly dropped half of its
 * requirement would be a conformance suite in name only.
 */
import type { ConformanceOutcome, ConformanceTrace } from "./types.ts";
import { FixtureRunner, type ClaimRow, type FixtureRunResult } from "./run.ts";

export interface ConformanceCheck {
  readonly trace_id: string;
  readonly title: string;
  readonly adversary: string;
  readonly requirement: string;
  readonly status: "pass" | "fail" | "not_measured";
  readonly detail: string;
}

export interface ConformanceTraceResult {
  readonly trace_id: string;
  readonly title: string;
  readonly adversary: string;
  readonly ground_truth: string;
  readonly requires: readonly string[];
  readonly checks: readonly ConformanceCheck[];
  readonly required_passed: number;
  readonly required_failed: number;
  /** Requirements the specification makes that this build cannot yet meet. */
  readonly unimplemented: readonly ConformanceCheck[];
  readonly run: FixtureRunResult;
}

export interface ConformanceReport {
  readonly traces: readonly ConformanceTraceResult[];
  readonly traces_passed: number;
  readonly traces_failed: number;
  readonly required_checks_passed: number;
  readonly required_checks_failed: number;
  readonly unimplemented_checks: number;
}

export async function runConformance(
  traces: readonly ConformanceTrace[],
  runner: FixtureRunner,
): Promise<ConformanceReport> {
  const results: ConformanceTraceResult[] = [];
  for (const trace of traces) {
    results.push(await runTrace(trace, runner));
  }
  return {
    traces: results,
    traces_passed: results.filter((result) => result.required_failed === 0).length,
    traces_failed: results.filter((result) => result.required_failed > 0).length,
    required_checks_passed: results.reduce((sum, result) => sum + result.required_passed, 0),
    required_checks_failed: results.reduce((sum, result) => sum + result.required_failed, 0),
    unimplemented_checks: results.reduce((sum, result) => sum + result.unimplemented.length, 0),
  };
}

async function runTrace(trace: ConformanceTrace, runner: FixtureRunner): Promise<ConformanceTraceResult> {
  const run = await runner.run({
    path: `<conformance:${trace.trace_id}>`,
    header: {
      kind: "header",
      line: 1,
      fixture_version: trace.fixture_version,
      dataset_version: trace.dataset_version,
      fixture_id: `conformance/${trace.trace_id}`,
      suite: "conformance" as unknown as "ledgerbench",
      title: trace.title,
      ground_truth: trace.ground_truth,
    },
    body: trace.inputs,
    conformance: trace,
  });

  const required = checkOutcome(trace, run, trace.required_outcome);
  const unimplemented = trace.unimplemented_outcome
    ? checkOutcome(trace, run, trace.unimplemented_outcome)
    : [];
  return {
    trace_id: trace.trace_id,
    title: trace.title,
    adversary: trace.adversary,
    ground_truth: trace.ground_truth,
    requires: trace.requires,
    checks: required,
    required_passed: required.filter((check) => check.status === "pass").length,
    required_failed: required.filter((check) => check.status === "fail").length,
    unimplemented: unimplemented.map((check) => ({
      ...check,
      status: check.status === "pass" ? "pass" : "not_measured",
      detail:
        check.status === "pass"
          ? `${check.detail} (the requirement is met after all; move it into required_outcome)`
          : `${check.detail}${trace.unimplemented_outcome?.because ? ` — ${trace.unimplemented_outcome.because}` : ""}`,
    })),
    run,
  };
}

function checkOutcome(
  trace: ConformanceTrace,
  run: FixtureRunResult,
  outcome: ConformanceOutcome,
): ConformanceCheck[] {
  const checks: ConformanceCheck[] = [];
  const add = (requirement: string, status: ConformanceCheck["status"], detail: string) =>
    checks.push({ trace_id: trace.trace_id, title: trace.title, adversary: trace.adversary, requirement, status, detail });

  // --- decisions -----------------------------------------------------------
  for (const assertion of outcome.decisions ?? []) {
    const decisions = run.decisions.filter((decision) => decision.line_id === assertion.line_id);
    if (decisions.length === 0) {
      add(`decision for ${assertion.line_id}`, "fail", "no decision was recorded for this input");
      continue;
    }
    for (const decision of decisions) {
      if (assertion.outcome !== undefined && decision.outcome !== assertion.outcome) {
        add(
          `decision for ${assertion.line_id} is ${assertion.outcome}`,
          "fail",
          `observed ${decision.outcome} (reason codes: ${decision.reason_codes.join(", ")})`,
        );
        continue;
      }
      const missing = (assertion.must_include_reason_codes ?? []).filter(
        (code) => !decision.reason_codes.includes(code),
      );
      if (missing.length > 0) {
        add(
          `decision for ${assertion.line_id} cites ${missing.join(", ")}`,
          "fail",
          `observed: ${decision.reason_codes.join(", ")}`,
        );
        continue;
      }
      const forbidden = (assertion.must_exclude_reason_codes ?? []).filter((code) =>
        decision.reason_codes.includes(code),
      );
      if (forbidden.length > 0) {
        add(
          `decision for ${assertion.line_id} does not cite ${forbidden.join(", ")}`,
          "fail",
          `observed: ${decision.reason_codes.join(", ")}`,
        );
        continue;
      }
      add(
        `decision for ${assertion.line_id}`,
        "pass",
        `${decision.outcome}${assertion.must_include_reason_codes ? ` (${assertion.must_include_reason_codes.join(", ")})` : ""}`,
      );
    }
  }

  // --- claim counts --------------------------------------------------------
  const live = run.claims.filter((claim) => claim.valid_to === null && claim.status === "accepted");
  if (outcome.accepted_claims !== undefined) {
    add(
      `${outcome.accepted_claims} currently accepted claim(s)`,
      live.length === outcome.accepted_claims ? "pass" : "fail",
      `observed ${live.length}: ${live.map(describeClaim).join("; ") || "none"}`,
    );
  }
  if (outcome.superseded_claims !== undefined) {
    const superseded = run.claims.filter((claim) => claim.status === "superseded");
    add(
      `${outcome.superseded_claims} superseded claim(s)`,
      superseded.length === outcome.superseded_claims ? "pass" : "fail",
      `observed ${superseded.length}`,
    );
  }
  if (outcome.revoked_claims !== undefined) {
    const revoked = run.claims.filter((claim) => claim.status === "revoked");
    add(
      `${outcome.revoked_claims} revoked claim(s)`,
      revoked.length === outcome.revoked_claims ? "pass" : "fail",
      `observed ${revoked.length}`,
    );
  }
  if (outcome.claim_rows_retained !== undefined) {
    add(
      `${outcome.claim_rows_retained} claim row(s) retained`,
      run.claims.length === outcome.claim_rows_retained ? "pass" : "fail",
      `observed ${run.claims.length}; a correction must not delete the row it replaced`,
    );
  }

  // --- relations -----------------------------------------------------------
  for (const assertion of outcome.relations ?? []) {
    const from = run.claims.find((claim) => describeClaim(claim) === assertion.from);
    const to = run.claims.find((claim) => describeClaim(claim) === assertion.to);
    if (!from || !to) {
      add(
        `relation ${assertion.rel} ${assertion.from} -> ${assertion.to}`,
        "fail",
        `could not resolve both endpoints (from ${from ? "found" : "missing"}, to ${to ? "found" : "missing"})`,
      );
      continue;
    }
    const found = run.relations.some(
      (relation) =>
        relation.rel === assertion.rel && relation.from_claim === from.claim_id && relation.to_claim === to.claim_id,
    );
    add(
      `relation ${assertion.rel} ${assertion.from} -> ${assertion.to}`,
      found ? "pass" : "fail",
      found
        ? "persisted in claim_relations"
        : `no ${assertion.rel} row; relations written this run: ${
            run.relations.map((relation) => relation.rel).join(", ") || "none"
          }`,
    );
  }
  if (outcome.contradicting_relations !== undefined) {
    const contradicting = run.relations.filter((relation) => relation.rel === "contradicts").length;
    const detected = run.decisions.filter((decision) =>
      decision.conflicts.some((hit) => hit.rel === "contradicts"),
    ).length;
    add(
      `${outcome.contradicting_relations} contradicting relation(s)`,
      contradicting === outcome.contradicting_relations ? "pass" : "fail",
      `claim_relations holds ${contradicting}; the gate detected ${detected} contradiction(s) on decisions. ` +
        `Contradiction is detected and recorded on the decision, but only duplicates and supersedes are ` +
        `written to claim_relations today`,
    );
  }

  // --- scope ---------------------------------------------------------------
  if (outcome.accepted_scope !== undefined) {
    const wanted = outcome.accepted_scope;
    const match = live.find(
      (claim) =>
        (wanted.project === undefined || claim.scope.project === wanted.project) &&
        (wanted.user === undefined || claim.scope.user === wanted.user) &&
        (wanted.agent === undefined || claim.scope.agent === wanted.agent) &&
        (wanted.session === undefined || claim.scope.session === wanted.session),
    );
    add(
      `accepted at scope ${JSON.stringify(wanted)}`,
      match ? "pass" : "fail",
      match
        ? `claim ${match.claim_id} scope ${JSON.stringify(match.scope)}`
        : `accepted scopes: ${live.map((claim) => JSON.stringify(claim.scope)).join(", ") || "none"}`,
    );
  }

  // --- deletion ------------------------------------------------------------
  if (outcome.residual_matches !== undefined) {
    const residual = run.residual;
    if (residual === null) {
      add("residual scan ran", "fail", "no residual scan was performed for this trace");
    } else {
      const total = Object.values(residual).reduce((sum, count) => sum + count, 0);
      add(
        `${outcome.residual_matches} residual match(es)`,
        total === outcome.residual_matches ? "pass" : "fail",
        JSON.stringify(residual),
      );
    }
  }
  if (outcome.residual_stores !== undefined && run.residual !== null) {
    const missing = outcome.residual_stores.filter((store) => !(store in (run.residual ?? {})));
    add(
      `every declared store was scanned`,
      missing.length === 0 ? "pass" : "fail",
      missing.length === 0 ? outcome.residual_stores.join(", ") : `not scanned: ${missing.join(", ")}`,
    );
  }
  if (outcome.ledger_rows_preserved !== undefined) {
    add(
      `${outcome.ledger_rows_preserved} ledger row(s) preserved`,
      run.ledger_row_count === outcome.ledger_rows_preserved ? "pass" : "fail",
      `observed ${run.ledger_row_count}; redaction must clear the bytes without removing the row`,
    );
  }

  if (checks.length === 0) {
    add("trace declares a required outcome", "fail", "the trace has no machine-checkable requirement");
  }
  return checks;
}

function describeClaim(claim: ClaimRow): string {
  return `${claim.subject}|${claim.predicate}|${renderObject(claim.object)}`;
}

function renderObject(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
