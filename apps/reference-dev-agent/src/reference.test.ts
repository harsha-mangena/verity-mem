/**
 * The reference workload, asserted.
 *
 * This is not a second implementation of the demo. It calls `runReferenceWorkload`
 * — the same function `src/main.ts` runs — and asserts on what that run observed in
 * the database. A test that re-implemented the nine steps would pass while the demo
 * was broken, which is the exact failure this file exists to prevent.
 *
 * Every assertion reads a value the *system* produced: a decision outcome, a set of
 * reason codes, a retention manifest's residual scan, an action verdict. None of
 * them is a number the scenario computed for itself.
 *
 * Run it alone with:
 *
 *     MIGRATION_DATABASE_URL=postgres://verity:verity@127.0.0.1:55432/veritymem \
 *       node --experimental-strip-types --test apps/reference-dev-agent/src/reference.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_COMMIT_POLICY, GATE_THRESHOLDS, REASON_CODES } from "@veritymem/contracts";
import { createEmbeddings, createRunnerDriver, createWorld } from "./world.ts";
import { runReferenceWorkload, type ReferenceRun } from "./scenario.ts";
import { runDemo, freshTenantSlug } from "./main.ts";
import { loadEnv, fixedClock, seededIds } from "@veritymem/ledger";

/**
 * One run per suite, shared by every assertion.
 *
 * The scenario is ordered — a correction after a contradiction, a retention after
 * the writes it erases — so a per-test run would either duplicate the whole thing
 * nine times or test steps in an order they cannot occur in.
 */
async function once(): Promise<ReferenceRun> {
  const env = loadEnv();
  const slug = freshTenantSlug("test");
  const clock = fixedClock("2026-09-01T09:00:00.000Z");
  const world = createWorld({
    tenantSlug: slug,
    project: "payments",
    databaseUrl: env.databaseUrl,
    blobDir: `${env.repoRoot}/.veritymem/blobs`,
    clock,
    ids: seededIds(`${slug}@${slug}`),
  });
  const embeddings = createEmbeddings();
  try {
    return await runReferenceWorkload(world, {
      driver: createRunnerDriver(world, embeddings),
      embeddings,
      policyVersion: DEFAULT_COMMIT_POLICY.version,
    });
  } finally {
    await world.close();
  }
}

describe("reference workload: multi-agent software delivery", () => {
  let run: ReferenceRun;

  it("runs the nine steps", async () => {
    run = await once();
    assert.equal(run.steps.length, 9, `expected nine steps, saw ${run.steps.map((step) => step.name).join(", ")}`);
    assert.deepEqual(
      run.steps.map((step) => step.step),
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
    );
  });

  it("1. auto-accepts a CI tool result as an observation", () => {
    assert.equal(run.ci.outcome, "accept", `reason codes: ${run.ci.reason_codes.join(", ")}`);
    assert.equal(run.ci.authority, "observation", "a tool result carries observation authority, not verification");
    assert.ok(run.ci.claim_id, "an accepted decision must name the claim it created");
    assert.ok(
      run.ci.reason_codes.includes(REASON_CODES.SPAN_RESOLVED),
      "an accepted claim must have had its span resolved on this evaluation",
    );
    assert.ok(
      run.ci.reason_codes.includes(REASON_CODES.GATE_AUTO_ACCEPT_ELIGIBLE),
      "the accept must be accounted for by the auto-accept branch, not by an unrecorded rule",
    );
    // Every returned claim carries at least one resolvable evidence reference, which
    // is the first v0.1 exit target.
    assert.ok(run.ci.evidence.length > 0, "the CI claim must carry evidence");
    for (const evidence of run.ci.evidence) {
      assert.equal(evidence.digest_ok, true, "the digest must re-verify on this read");
      assert.ok(evidence.quote !== null && evidence.quote.length > 0, "a resolvable span returns its quote");
    }
  });

  it("2. accepts a human approval as user_self_report", () => {
    assert.equal(run.approval.outcome, "accept", `reason codes: ${run.approval.reason_codes.join(", ")}`);
    assert.equal(run.approval.authority, "user_self_report");
    assert.ok(run.approval.claim_id);
    assert.ok(
      !run.approval.reason_codes.includes(REASON_CODES.GATE_QUARANTINED),
      "an approval is not a privileged kind and must not be quarantined",
    );
  });

  it("3. quarantines the hostile procedure and never accepts it", () => {
    assert.ok(run.hostile.outcomes.length > 0, "the hostile document must produce candidates, or nothing was tested");
    assert.ok(
      run.hostile.outcomes.includes("quarantine"),
      `expected a quarantine, saw ${run.hostile.outcomes.join(", ")}`,
    );
    assert.ok(
      !run.hostile.outcomes.includes("accept"),
      `no candidate from an external instruction may be accepted, saw ${run.hostile.outcomes.join(", ")}`,
    );
    // `accepted_claims` is what must be empty — the invariant is that the hostile
    // document never produces a claim that holds belief. It is not that no row exists:
    // a quarantined candidate now gets a claim row with status `proposed`, which is what
    // lets an operator see what was refused, on what evidence, and why. A refusal that
    // left no trace would be unauditable.
    assert.deepEqual(run.hostile.accepted_claims, [], "the hostile document must create no accepted claim");
    assert.ok(
      run.hostile.quarantined_candidates.length > 0,
      "the decision record must show the quarantine, not just the absence of a claim",
    );
    // The reason codes are the audit trail. All three of these must be present: the
    // kind is privileged, the content was instruction-like, and it came from outside.
    for (const code of [
      REASON_CODES.KIND_PRIVILEGED,
      REASON_CODES.ADMISSION_INSTRUCTION_LIKE,
      REASON_CODES.ADMISSION_EXTERNAL_INSTRUCTION,
      REASON_CODES.GATE_QUARANTINED,
    ]) {
      assert.ok(
        run.hostile.reason_codes.includes(code),
        `missing reason code ${code}; saw ${run.hostile.reason_codes.join(", ")}`,
      );
    }
    assert.ok(
      run.hostile.instruction_matches.length > 0,
      "admission must record the phrase that tripped it, so an operator can see what was noticed",
    );
  });

  it("4a. does not return another project's memory, and the probe is not vacuous", () => {
    // The probe is a *cross-project* probe, so the constraint that matters is that
    // nothing from the other project comes back. A weak lexical or dense signal can
    // still surface a claim from the caller's own project, and asserting "nothing at
    // all" would make this test fail for a relevance reason while claiming to be about
    // authorization.
    assert.equal(
      run.isolation.cross_project.reached_other_principals_claim_own_user,
      false,
      `the second project must not reach the first project's claims, saw ${run.isolation.cross_project.claims_returned_own_user.join(", ")}`,
    );
    // The teammate *does* reach their own project, so this is a boundary and not a
    // principal who can see nothing at all. The scope string is the teammate's own
    // user scope inside billing, because that is the scope they wrote in; what matters
    // is that a billing scope is authorized and that Alice's window is not in it.
    assert.ok(
      run.isolation.cross_project.authorized_scopes_project_wide.includes("user=bob"),
      `the teammate must hold a billing scope, saw ${run.isolation.cross_project.authorized_scopes_project_wide.join(", ") || "none"}`,
    );
    assert.ok(
      run.isolation.cross_project.claims_returned_project_wide.length > 0,
      "and must actually receive their own project's claims, or the probe proves only that they are blind",
    );
    // No reachable scope holds the predicate, so the boundary is applied before
    // retrieval rather than as a filter afterwards.
    assert.deepEqual(
      run.isolation.cross_project.reachable_scopes,
      [],
      "the authorization read must be empty too: the boundary is before retrieval, not a filter after it",
    );
    // The teammate does receive their *own* billing claim — a preference they wrote in
    // their own scope — and that is a correctness control rather than a leak: a probe
    // that returned nothing at all could not tell isolation from blindness. What must
    // not appear is anything of Alice's or anything from the payments project.
    assert.equal(run.isolation.cross_project.reached_other_principals_claim_own_user, false);
    // The controls. Without them, "returned nothing" would be indistinguishable from
    // "can reach nothing", and a resolver that returned an empty set for everyone
    // would pass this test while the system was broken.
    assert.ok(run.isolation.ci_claim_id, "the CI event must have produced a claim for the controls to look for");
    assert.equal(
      run.isolation.teammate_reaches_project_scope,
      true,
      "the teammate must reach project-scope claims, or this probe cannot distinguish isolation from blindness",
    );
    assert.equal(
      run.isolation.owner_reaches_project_scope,
      true,
      "the owner must reach project-scope claims too, so nothing was lost by the boundary",
    );
  });

  it("4b. same-project cross-user probe reports the boundary as evidence, not as an assertion", () => {
    // The probe: a second user *in the same project* asks for the first user's memory,
    // and the selector names the asker. This must return nothing.
    assert.deepEqual(
      run.isolation.same_project.claims_returned_own_user,
      [],
      `a user-named selector must not reach another user's claims, saw ${run.isolation.same_project.claims_returned_own_user.join(", ")}`,
    );
    assert.equal(run.isolation.same_project.reached_other_principals_claim_own_user, false);
    assert.deepEqual(
      run.isolation.same_project.reachable_scopes,
      [],
      "the authorization read underneath the channels must be empty too, not just the packet",
    );
    // The calibration, and it is the reason this probe is not a tautology: the same
    // principal asking project-wide *does* reach the project's users, because a
    // project-scope operator is supposed to see the project. A deployment where this
    // returned nothing would be broken rather than isolated, so the two outcomes are
    // asserted together.
    assert.equal(
      run.isolation.same_project.reached_other_principals_claim_project_wide,
      true,
      "a project-wide selector must still reach the project, or the probe proves only that the teammate is blind",
    );
    assert.deepEqual(run.isolation.same_project.authorized_scopes_own_user, []);
    assert.deepEqual(run.isolation.same_project.authorized_scopes_project_wide, ["project=payments"]);
  });

  it("5. detects the contradiction and does not overwrite the first claim", () => {
    assert.equal(
      run.contradiction.outcome,
      "needs_review",
      `expected needs_review, saw ${String(run.contradiction.outcome)} with ${run.contradiction.reason_codes.join(", ")}`,
    );
    assert.ok(
      run.contradiction.reason_codes.includes(REASON_CODES.CONFLICT_CONTRADICTS_ACCEPTED),
      `the conflict must be named, not inferred; saw ${run.contradiction.reason_codes.join(", ")}`,
    );
    assert.equal(run.contradiction.first_claim_status, "accepted", "the first claim must survive the second attempt");
    assert.equal(run.contradiction.first_claim_still_current, true, "and it must still be the current belief");
  });

  it("6. keeps the superseded claim readable while a current-time query drops it", () => {
    assert.equal(run.correction.status_after, "superseded");
    assert.equal(run.correction.readable_after_supersession, true, "the old claim must still be readable");
    assert.ok(run.correction.decisions_after >= 2, "the promotion history must include the correction's decision");
    assert.equal(
      run.correction.in_current_query,
      false,
      "a superseded claim must not be returned by a current-time query",
    );
    const window = run.correction.validity_history.find((entry) => entry.claim_id === run.correction.superseded_claim_id);
    assert.ok(window, "the closed validity interval must be recorded");
    assert.equal(window.current, false);
    assert.ok(window.valid_to !== null, "the interval must be closed, not deleted");
  });

  it("7. proves the deletion with a per-store residual scan and keeps the ledger row", () => {
    assert.equal(run.retention.status, "verified", "the job reports verified only when the scan is clean");
    assert.equal(run.retention.residual_matches, 0);
    // Per store, because an aggregate zero with an unexamined store proves nothing.
    assert.ok(run.retention.residual_scan.length >= 5, "the scan must name every declared store");
    for (const scan of run.retention.residual_scan) {
      assert.equal(scan.matches, 0, `residual matches in ${scan.store}`);
    }
    assert.ok(
      run.retention.stores_touched.includes("events.payload"),
      "the ledger payload store must be declared in the manifest",
    );
    assert.equal(run.retention.ledger_row_survives, true, "the row survives so the system can testify the event existed");
    assert.equal(run.retention.payload_gone, true, "but its content is gone");
    assert.match(
      String(run.retention.content_hash_survives),
      /^[0-9a-f]{64}$/,
      "the content hash survives as testimony",
    );
  });

  it("8. refuses a high-risk action on both strong authority classes, and allows a low-risk one", () => {
    const selfReport = run.action_gate.high_risk_on_user_self_report;
    assert.equal(selfReport.allowed, false, "high risk must refuse a user self-report");
    assert.ok(
      selfReport.reason_codes.includes(REASON_CODES.ACTION_DENIED_RISK_EXCEEDS_USE),
      `the refusal must name the rule; saw ${selfReport.reason_codes.join(", ")}`,
    );

    const observation = run.action_gate.high_risk_on_observation;
    assert.equal(
      observation.allowed,
      false,
      "high risk must also refuse a tool observation: the threshold is verified_record, which is the documented calibration",
    );
    assert.ok(
      observation.reason_codes.includes(REASON_CODES.ACTION_DENIED_RISK_EXCEEDS_USE),
      `the refusal must name the rule; saw ${observation.reason_codes.join(", ")}`,
    );

    const low = run.action_gate.low_risk_on_user_self_report;
    assert.equal(low.allowed, true, `low risk must permit a fresh, well-evidenced claim; saw ${low.reason_codes.join(", ")}`);
    assert.ok(low.reason_codes.includes(REASON_CODES.ACTION_ALLOWED));
  });

  it("9. reports review burden against the ceiling as a product-failure metric", () => {
    assert.equal(run.review_burden.ceiling, GATE_THRESHOLDS.reviewBurdenCeiling);
    assert.ok(run.review_burden.total_decisions > 0, "the denominator must be read from the decisions table");
    assert.equal(
      run.review_burden.review_required,
      (run.review_burden.by_outcome["needs_review"] ?? 0) + (run.review_burden.by_outcome["quarantine"] ?? 0),
      "review burden counts both branches that stop an unattended agent",
    );
    assert.ok(run.review_burden.fraction > 0, "this workload writes adversarial content on purpose");
    // The demo deliberately writes material that must be reviewed, so it is expected
    // to exceed the ceiling. Asserting the *comparison* rather than a threshold keeps
    // the number honest: a run that silently dropped to zero review items would mean
    // the review branches stopped firing, not that the gate improved.
    assert.equal(
      run.review_burden.within_ceiling,
      run.review_burden.fraction <= GATE_THRESHOLDS.reviewBurdenCeiling,
    );
  });
});

describe("reference workload: the demo prints what it observed", () => {
  it("prints the tenant and the id seed so a run can be cited", async () => {
    const lines: string[] = [];
    const run = await runDemo({
      seed: "reference-dev-agent-test",
      tenantSlug: freshTenantSlug("narrate"),
      write: (line) => lines.push(line),
    });
    const text = lines.join("\n");
    assert.ok(text.includes(run.tenant_slug), "the narrative must name the tenant");
    assert.ok(text.includes(run.tenant_id), "the narrative must name the tenant id");
    assert.ok(text.includes(run.seed), "the narrative must name the id seed");
    assert.ok(text.includes("REVIEW BURDEN"), "the narrative must print the review-burden readout");
    assert.ok(
      text.includes("product-failure metric"),
      "and it must say what kind of metric review burden is, rather than printing a bare number",
    );
    // The residual scan is the proof of deletion, so the demo has to show it per
    // store rather than only the aggregate.
    for (const scan of run.retention.residual_scan) {
      assert.ok(text.includes(scan.store), `the narrative must print the residual scan for ${scan.store}`);
    }
  });
});
