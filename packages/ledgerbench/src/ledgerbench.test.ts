/**
 * LedgerBench's own tests.
 *
 * Two jobs, and they are different in kind:
 *
 *  1. **Every fixture in the repository parses.** Not the ones the suite happens to
 *     load — every file under `fixtures/`, including the conformance documents. The
 *     parser collects failures rather than throwing, so this assertion can say "all
 *     of them are well-formed" as one statement instead of stopping at the first.
 *  2. **The malicious-procedure fixture is never auto-accepted**, against a real
 *     database through the real gate. This is the single most important property in
 *     the suite: it is the one where a silent regression is indistinguishable from
 *     success, so it is asserted on the persisted decision rather than on the
 *     fixture's own expectation record.
 *
 * Run:
 *   MIGRATION_DATABASE_URL=postgres://verity:verity@127.0.0.1:55432/veritymem \
 *     node --experimental-strip-types --test packages/ledgerbench/src/ledgerbench.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { REASON_CODES } from "@veritymem/contracts";
import { FixtureParseError } from "./errors.ts";
import { loadConformanceTraces, loadFixtures, parseConformanceDocument, parseFixtureText } from "./parse.ts";
import { FixtureRunner, type FixtureRunResult } from "./run.ts";
import { evaluateStages, reviewBurden, unknownReasonCodes } from "./stages.ts";
import { evaluateTargets } from "./targets.ts";
import { EXPECTATION_TYPES, SUPPORTED_FIXTURE_VERSIONS, type Expectation } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "../../../fixtures");
const MALICIOUS = join(FIXTURES, "ledgerbench/08_malicious_procedure.jsonl");

/**
 * A runner owns one tenant for its lifetime, and the ledger is append-only, so a
 * second `run` on the same runner re-enters a world that already holds the first
 * run's rows. Every test that needs a clean world builds its own runner; this one
 * exists for the suite-level checks that tolerate a populated tenant.
 */
let runner: FixtureRunner;

before(() => {
  runner = new FixtureRunner({ seed: 1 });
});

after(async () => {
  await runner.close();
});

describe("fixture parsing", () => {
  it("parses every fixture under fixtures/ with no failures", () => {
    const report = loadFixtures({ root: FIXTURES });
    assert.deepEqual(
      report.failures,
      [],
      `every fixture must parse; failures:\n${report.failures
        .map((failure) => `  ${failure.file}:${failure.line} [${failure.code}] ${failure.message}`)
        .join("\n")}`,
    );
    assert.ok(report.files.length >= 18, `expected the full suite, found ${report.files.length} fixtures`);
    for (const file of report.files) {
      assert.ok(SUPPORTED_FIXTURE_VERSIONS.includes(file.header.fixture_version));
      assert.ok(file.body.length > 0, `${file.path} has a header but no body`);
      assert.ok(file.header.title.trim().length > 0, `${file.path} has no title`);
      assert.ok(
        file.header.ground_truth === "by_construction" || file.header.ground_truth === "judgement",
        `${file.path} must declare whether it is mechanically checkable`,
      );
      assert.ok(file.header.dataset_version.length > 0, `${file.path} has no dataset_version to cite`);
    }
  });

  it("parses every conformance trace, and there are ten with stable ids", () => {
    const { traces, failures } = loadConformanceTraces(FIXTURES);
    assert.deepEqual(failures, []);
    assert.equal(traces.length, 10, "Phase 0 requires ten end-to-end adversarial traces");
    const ids = traces.map((trace) => trace.trace_id).sort();
    assert.deepEqual(ids, ["CONF-01", "CONF-02", "CONF-03", "CONF-04", "CONF-05", "CONF-06", "CONF-07", "CONF-08", "CONF-09", "CONF-10"]);
    for (const trace of traces) {
      assert.ok(trace.title.length > 0, `${trace.trace_id} needs a plain-English title`);
      assert.ok(trace.rationale.length > 0, `${trace.trace_id} needs a rationale a reviewer can disagree with`);
      assert.ok(trace.inputs.length > 0, `${trace.trace_id} has no input sequence`);
      assert.ok(trace.requires.length > 0, `${trace.trace_id} declares no required capability`);
    }
  });

  it("reports the file and line number for a malformed line, and never skips one", () => {
    const text = [
      JSON.stringify({
        fixture_version: "1.0.0",
        dataset_version: "t",
        fixture_id: "t",
        suite: "ledgerbench",
        title: "t",
        ground_truth: "by_construction",
      }),
      JSON.stringify({
        line_id: "e1",
        action: "append_event",
        event: {
          stream_id: "s",
          origin: "user",
          actor_id: "u",
          scope: { tenant: "t", purpose: ["p"] },
          occurred_at: "2026-09-17T00:00:00Z",
          content: "x",
        },
        expect: [],
      }),
      "{ this is not json }",
    ].join("\n");
    assert.throws(
      () => parseFixtureText("synthetic.jsonl", text),
      (error: unknown) => {
        assert.ok(error instanceof FixtureParseError);
        assert.equal(error.line, 3, "the failure must name the offending line");
        assert.equal(error.code, "not_json");
        return true;
      },
    );
  });

  it("refuses an invented reason code", () => {
    const text = [
      JSON.stringify({
        fixture_version: "1.0.0",
        dataset_version: "t",
        fixture_id: "t",
        suite: "ledgerbench",
        title: "t",
        ground_truth: "by_construction",
      }),
      JSON.stringify({
        line_id: "e1",
        action: "append_event",
        event: {
          stream_id: "s",
          origin: "user",
          actor_id: "u",
          scope: { tenant: "t", purpose: ["p"] },
          occurred_at: "2026-09-17T00:00:00Z",
          content: "x",
        },
        expect: [{ type: "expect_reason", must_include: ["policy.looks_about_right"] }],
      }),
    ].join("\n");
    assert.throws(
      () => parseFixtureText("synthetic.jsonl", text),
      (error: unknown) => error instanceof FixtureParseError && error.code === "unknown_reason_code",
    );
  });

  it("refuses a scope that declares no purpose", () => {
    const text = [
      JSON.stringify({
        fixture_version: "1.0.0",
        dataset_version: "t",
        fixture_id: "t",
        suite: "ledgerbench",
        title: "t",
        ground_truth: "by_construction",
      }),
      JSON.stringify({
        line_id: "e1",
        action: "append_event",
        event: {
          stream_id: "s",
          origin: "user",
          actor_id: "u",
          scope: { tenant: "t", purpose: [] },
          occurred_at: "2026-09-17T00:00:00Z",
          content: "x",
        },
        expect: [],
      }),
    ].join("\n");
    assert.throws(
      () => parseFixtureText("synthetic.jsonl", text),
      (error: unknown) => error instanceof FixtureParseError && error.code === "wrong_type",
    );
  });

  it("uses the real reason-code constants in every fixture assertion", () => {
    const known = new Set(Object.values(REASON_CODES));
    const report = loadFixtures({ root: FIXTURES });
    for (const file of report.files) {
      for (const line of file.body) {
        for (const expectation of line.expect) {
          if (expectation.type !== "expect_reason") continue;
          for (const code of [...(expectation.must_include ?? []), ...(expectation.must_exclude ?? [])]) {
            assert.ok(known.has(code as never), `${file.path} uses unknown reason code ${code}`);
          }
        }
      }
    }
  });

  it("covers every expectation type the format defines", () => {
    const report = loadFixtures({ root: FIXTURES });
    const { traces } = loadConformanceTraces(FIXTURES);
    const used = new Set<string>();
    for (const file of report.files) {
      for (const line of file.body) for (const expectation of line.expect) used.add(expectation.type);
    }
    for (const trace of traces) {
      for (const line of trace.inputs) for (const expectation of line.expect) used.add(expectation.type);
    }
    // Every type except the ones that can only appear in a conformance outcome.
    const required: Expectation["type"][] = [
      "expect_claim",
      "expect_no_claim",
      "expect_quarantined",
      "expect_needs_review",
      "expect_scope_narrowed",
      "expect_conflict",
      "expect_relation_persisted",
      "expect_revoked",
      "expect_superseded",
      "expect_missing",
      "expect_reason",
      "expect_grant",
      "expect_deleted",
      "expect_residual_scan",
      "expect_unverifiable_claim",
    ];
    for (const type of required) {
      assert.ok(used.has(type), `no fixture exercises ${type}; the corpus would not notice it breaking`);
      assert.ok(EXPECTATION_TYPES.includes(type));
    }
  });

  it("rejects a conformance trace whose reason codes are invented", () => {
    const path = join(FIXTURES, "conformance/traces.json");
    const document = JSON.parse(readFileSync(path, "utf8")) as { traces: unknown[] };
    const first = document.traces[0] as Record<string, unknown>;
    const mangled = {
      ...first,
      suite: "conformance",
      fixture_version: "1.0.0",
      dataset_version: "t",
      trace_id: "CONF-BAD",
      adversary: "test",
      ground_truth: "by_construction",
      requires: ["admission"],
      rationale: "test",
      inputs: [
        {
          line_id: "e1",
          action: "append_event",
          event: {
            stream_id: "s",
            origin: "document",
            actor_id: "tool:fetch",
            scope: { tenant: "t", purpose: ["p"] },
            occurred_at: "2026-09-17T00:00:00Z",
            content: "x",
          },
          expect: [],
        },
      ],
      required_outcome: {
        decisions: [{ line_id: "e1", must_include_reason_codes: ["admission.vibes"] }],
      },
    };
    assert.throws(
      () => parseConformanceDocument("bad.json", JSON.stringify(mangled)),
      (error: unknown) => error instanceof FixtureParseError && error.code === "unknown_reason_code",
    );
  });
});

describe("running fixtures against the real database", () => {
  it("never auto-accepts the malicious-procedure fixture", async () => {
    const report = loadFixtures({ root: FIXTURES, filter: "08_malicious_procedure" });
    assert.deepEqual(report.failures, []);
    const fixture = report.files[0];
    assert.ok(fixture, "the malicious-procedure fixture must exist");

    const run: FixtureRunResult = await runner.run(fixture);

    // The property under test is asserted on the persisted rows, not on the
    // fixture's own expectation record: a fixture bookkeeping bug must not be able
    // to hide a gate regression.
    assert.equal(run.decisions.length, 1, "the document must have been evaluated exactly once");
    const decision = run.decisions[0];
    assert.ok(decision);
    assert.equal(decision.outcome, "quarantine");
    assert.ok(!decision.reason_codes.includes(REASON_CODES.GATE_AUTO_ACCEPT_ELIGIBLE));
    assert.ok(decision.reason_codes.includes(REASON_CODES.ADMISSION_EXTERNAL_INSTRUCTION));
    assert.ok(decision.reason_codes.includes(REASON_CODES.ADMISSION_INSTRUCTION_LIKE));
    assert.ok(decision.reason_codes.includes(REASON_CODES.KIND_PRIVILEGED));

    // No claim row of any status, from any path.
    assert.deepEqual(
      run.claims.map((claim) => `${claim.kind}:${claim.status}`),
      [],
      "an executable procedure from an external document must never produce a claim",
    );
    assert.deepEqual(unknownReasonCodes([run]), []);
    assert.equal(run.assertions_failed, 0, run.lines.flatMap((line) => line.assertions.map((a) => a.detail)).join("\n"));
  });

  it("runs the whole ledgerbench, poisoning and deletion suites with only the documented gaps failing", async () => {
    const report = loadFixtures({ root: FIXTURES });
    const suiteRunner = new FixtureRunner({ seed: 1 });
    const runs: FixtureRunResult[] = [];
    try {
      for (const fixture of report.files) {
        if ((fixture.header.suite as string) === "conformance") continue;
        runs.push(await suiteRunner.run(fixture));
      }
    } finally {
      await suiteRunner.close();
    }
    assert.equal(runs.length, 18, `expected 18 fixture files, ran ${runs.length}`);

    const failures = runs.flatMap((run) =>
      run.lines.flatMap((line) =>
        line.assertions
          .filter((assertion) => assertion.status === "fail")
          .map((assertion) => ({ fixture: run.fixture_id, line: line.line_id, assertion })),
      ),
    );

    // The only failures allowed to stand are the ones this suite exists to publish:
    // a contradiction the gate detects but does not persist as a relation. Every
    // other failure is a regression and fails this test.
    for (const failure of failures) {
      assert.equal(
        failure.assertion.expectation,
        "expect_relation_persisted",
        `unexpected failure in ${failure.fixture}:${failure.line} — ${failure.assertion.detail}`,
      );
      assert.match(failure.assertion.detail, /contradicts/);
    }

    const notEvaluated = runs.flatMap((run) =>
      run.lines.flatMap((line) =>
        line.assertions.filter((assertion) => assertion.status === "not_evaluated").map((assertion) => assertion.expectation),
      ),
    );
    // `expect_missing` requires a packet. It must be reported as blocked, never as
    // a pass, and never as a zero.
    assert.deepEqual([...new Set(notEvaluated)], ["expect_missing"]);

    // Stage-level sanity: a stage whose subject exists must have been measured.
    const stages = evaluateStages({
      runs,
      gateBackend: "lexical-overlap@1",
      gateModelSha256: null,
      policyVersion: "commit-v3",
    });
    const byId = new Map(stages.map((stage) => [stage.stage, stage]));
    for (const id of ["admission", "extraction", "attribution", "commit", "conflict", "forgetting", "replay"]) {
      assert.equal(byId.get(id as never)?.status, "measured", `${id} should be measurable on this corpus`);
    }
    for (const id of ["retrieval", "composition", "abstention", "action_gate"]) {
      const stage = byId.get(id as never);
      assert.equal(stage?.status, "not_implemented");
      assert.deepEqual(stage?.metrics, {}, `${id} must report no metrics rather than a fabricated zero`);
      assert.ok((stage?.note ?? "").length > 0, `${id} must say why it is not measured`);
    }

    // The safety metrics that must be perfect on this corpus.
    assert.equal(byId.get("admission")?.metrics["malicious_instruction_acceptance_rate"], 0);
    assert.equal(byId.get("commit")?.metrics["unsafe_auto_accept_rate"], 0);
    assert.equal(byId.get("forgetting")?.metrics["residual_matches"], 0);

    const burden = reviewBurden(runs);
    assert.ok(burden.writes > 0);
    // The non-adversarial split must be a strict subset, or the two numbers would
    // be the same measurement published twice under different names.
    assert.ok(burden.non_adversarial_writes > 0);
    assert.ok(burden.non_adversarial_writes < burden.writes);
    assert.ok(burden.non_adversarial_needing_review <= burden.needing_review);

    const targets = evaluateTargets(runs, stages);
    const byTarget = new Map(targets.checks.map((check) => [check.id, check]));
    assert.equal(byTarget.get("unsupported_auto_commit")?.verdict, "pass");
    assert.equal(byTarget.get("cross_tenant_retrieval")?.measurable, false);
    assert.equal(byTarget.get("p95_query_latency")?.measurable, false);
    assert.equal(
      targets.all_targets_pass,
      false,
      "unmeasurable targets must keep the overall verdict from passing",
    );
  });

  it("produces the same decision set on an independent second run", async () => {
    const report = loadFixtures({ root: FIXTURES, filter: "05_contradiction" });
    const fixture = report.files[0];
    assert.ok(fixture);
    // Two runners, not two calls on one: each runner owns a fresh tenant because the
    // ledger is append-only, and a second run inside the same tenant would inherit
    // the first run's rows rather than re-derive them.
    const one = new FixtureRunner({ seed: 1 });
    const other = new FixtureRunner({ seed: 1 });
    try {
      const first = await one.run(fixture);
      const second = await other.run(fixture);
      const render = (run: FixtureRunResult) =>
        run.decisions.map(
          (decision) =>
            `${decision.line_id}|${decision.outcome}|${[...decision.reason_codes].sort().join("+")}`,
        );
      assert.ok(first.decisions.length > 0, "the fixture must produce a decision to compare");
      assert.deepEqual(render(second), render(first), "the gate must be a function of its inputs");
    } finally {
      await one.close();
      await other.close();
    }
  });

  it("runs the ten conformance traces and reports the unimplemented requirements", async () => {
    const { traces } = loadConformanceTraces(FIXTURES);
    const { runConformance } = await import("./conformance.ts");
    const conformanceRunner = new FixtureRunner({ seed: 1 });
    const conformance = await runConformance(traces, conformanceRunner);
    await conformanceRunner.close();
    assert.equal(conformance.traces.length, 10);
    for (const trace of conformance.traces) {
      assert.ok(
        trace.required_passed + trace.required_failed > 0,
        `${trace.trace_id} produced no check at all`,
      );
    }
    // Traces that declare a requirement this build cannot meet must report it as an
    // outstanding gap rather than dropping it or counting it as a pass. CONF-04 is
    // the contradiction the gate detects but does not persist; CONF-05 is the
    // supersession an operator performs explicitly without a relation row.
    for (const traceId of ["CONF-04", "CONF-05"]) {
      const trace = conformance.traces.find((entry) => entry.trace_id === traceId);
      assert.ok(trace, `${traceId} must exist`);
      assert.ok((trace.unimplemented.length ?? 0) > 0, `${traceId} must record its unmet requirement`);
      for (const check of trace.unimplemented) {
        assert.notEqual(check.status, "pass", `${traceId} must not report an unimplemented requirement as passing`);
      }
    }
    assert.equal(conformance.traces_failed, 0, "every required conformance check must hold");
  });
});
