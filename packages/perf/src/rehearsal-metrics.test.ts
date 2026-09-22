/**
 * The rehearsal's arithmetic, tested without a database.
 *
 * These are the functions that decide what the report says, so each test states the answer it
 * expects before it computes it — a percentile of five known values, a WAL difference of two
 * known LSNs, an outage window with a known longest gap. A test that only asserted "a number
 * came back" would leave the report's meaning unverified exactly where it matters.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  groupErrors,
  longestOutage,
  missing,
  missingMeasurements,
  noteFor,
  notApplicable,
  measured,
  percentile,
  redactIdentifiers,
  summariseDurations,
  tidyMessage,
  walLsnDelta,
  WorkloadRecorder,
  type AttemptSample,
} from "./rehearsal-metrics.ts";

describe("percentiles", () => {
  it("returns null rather than zero when there is no sample", () => {
    // The rule the whole report depends on: an absent measurement is not a zero.
    assert.equal(percentile([], 0.5), null);
    assert.deepEqual(summariseDurations([]), {
      count: 0,
      p50_ms: null,
      p95_ms: null,
      p99_ms: null,
      max_ms: null,
      mean_ms: null,
    });
  });

  it("uses nearest-rank, which always returns an observed value", () => {
    const values = [10, 20, 30, 40, 50];
    assert.equal(percentile(values, 0.5), 30);
    assert.equal(percentile(values, 0.95), 50);
    assert.equal(percentile(values, 1), 50);
  });

  it("is order-independent and does not mutate its input", () => {
    const values = [50, 10, 40, 20, 30];
    assert.equal(percentile(values, 0.5), 30);
    assert.deepEqual(values, [50, 10, 40, 20, 30]);
  });

  it("reports the single observation for every percentile when there is one sample", () => {
    // A p99 from one sample is that sample. Saying so is honest; interpolating would not be.
    assert.equal(percentile([7], 0.99), 7);
  });

  it("refuses a fraction outside (0, 1]", () => {
    assert.throws(() => percentile([1, 2], 0), /fraction must be in/);
    assert.throws(() => percentile([1, 2], 1.5), /fraction must be in/);
  });

  it("summarises count, max and mean alongside the percentiles", () => {
    const summary = summariseDurations([2, 4, 6, 8]);
    assert.equal(summary.count, 4);
    assert.equal(summary.max_ms, 8);
    assert.equal(summary.mean_ms, 5);
    assert.equal(summary.p50_ms, 4);
    assert.equal(summary.p99_ms, 8);
  });
});

describe("outage windows", () => {
  const window = { start_ms: 0, end_ms: 1_000 };

  it("measures the longest gap between successful completions", () => {
    const attempts = [
      { started_at_ms: 0, finished_at_ms: 100, ok: true },
      { started_at_ms: 150, finished_at_ms: 200, ok: false },
      { started_at_ms: 250, finished_at_ms: 300, ok: false },
      { started_at_ms: 350, finished_at_ms: 700, ok: true },
      { started_at_ms: 750, finished_at_ms: 800, ok: true },
      { started_at_ms: 850, finished_at_ms: 1_000, ok: true },
    ];
    const outage = longestOutage(attempts, window);
    // 100 -> 700 is the longest gap with no success; the trailing gap is 1000 - 1000 = 0.
    assert.equal(outage.longest_ms, 600);
    assert.equal(outage.from_ms, 100);
    assert.equal(outage.to_ms, 700);
    assert.equal(outage.has_success, true);
  });

  it("counts a leading gap from the start of the window", () => {
    const outage = longestOutage(
      [
        { started_at_ms: 900, finished_at_ms: 950, ok: true },
        { started_at_ms: 960, finished_at_ms: 990, ok: true },
      ],
      window,
    );
    assert.equal(outage.longest_ms, 950);
    assert.equal(outage.from_ms, 0);
    assert.equal(outage.to_ms, 950);
  });

  it("counts a trailing gap to the end of the window", () => {
    const outage = longestOutage(
      [
        { started_at_ms: 0, finished_at_ms: 100, ok: true },
        { started_at_ms: 110, finished_at_ms: 200, ok: false },
      ],
      window,
    );
    assert.equal(outage.longest_ms, 900);
    assert.equal(outage.from_ms, 100);
    assert.equal(outage.to_ms, 1_000);
  });

  it("reports the whole window as an outage when nothing succeeded", () => {
    const outage = longestOutage(
      [
        { started_at_ms: 0, finished_at_ms: 50, ok: false },
        { started_at_ms: 60, finished_at_ms: 90, ok: false },
      ],
      window,
    );
    assert.equal(outage.longest_ms, 1_000);
    assert.equal(outage.has_success, false);
  });

  it("is zero when the only attempt succeeded at the end of the window", () => {
    const outage = longestOutage([{ started_at_ms: 900, finished_at_ms: 1_000, ok: true }], {
      start_ms: 1_000,
      end_ms: 1_000,
    });
    assert.equal(outage.longest_ms, 0);
    assert.equal(outage.has_success, true);
  });

  it("refuses an inverted window", () => {
    assert.throws(() => longestOutage([], { start_ms: 10, end_ms: 5 }), /end precedes its start/);
  });
});

describe("WAL LSN differences", () => {
  it("subtracts within one segment", () => {
    // 16/100 to 16/200 is 0x100 bytes.
    assert.deepEqual(walLsnDelta("16/100", "16/200"), { bytes: 256, error: null });
  });

  it("carries across a segment boundary", () => {
    // The last byte of segment 0 is 0/FFFFFFFF, so the next segment starts one byte later.
    assert.deepEqual(walLsnDelta("0/FFFFFFFF", "1/0"), { bytes: 1, error: null });
  });

  it("compares the high half as a number, not as text", () => {
    // 0xF -> 0x10 is one segment forward. A text comparison would call this backwards,
    // because "10/0" sorts before "F/0", and would refuse a perfectly ordinary reading.
    assert.deepEqual(walLsnDelta("F/0", "10/0"), { bytes: 4_294_967_296, error: null });
  });

  it("is zero for an unchanged position", () => {
    assert.deepEqual(walLsnDelta("16/B374D848", "16/B374D848"), { bytes: 0, error: null });
  });

  it("refuses to invent a number when the LSN moved backwards", () => {
    const delta = walLsnDelta("1/0", "0/FFFFFFFF");
    assert.equal(delta.bytes, null);
    assert.match(delta.error ?? "", /moved backwards/);
  });

  it("refuses an unparseable LSN and names it", () => {
    const delta = walLsnDelta("not-an-lsn", "1/0");
    assert.equal(delta.bytes, null);
    assert.match(delta.error ?? "", /not a PostgreSQL LSN/);
  });

  it("refuses a delta too large for an exact JSON number", () => {
    const delta = walLsnDelta("0/0", "FFFFFFFF/FFFFFFFF");
    assert.equal(delta.bytes, null);
    assert.match(delta.error ?? "", /exceeds the exact integer range/);
  });
});

describe("error grouping", () => {
  it("groups by SQLSTATE, most frequent first, and keeps one sample", () => {
    const groups = groupErrors([
      { code: "42P01", message: 'relation "claim_entities" does not exist' },
      { code: "55P03", message: "canceling statement due to lock timeout" },
      { code: "42P01", message: 'relation "claim_entities" does not exist' },
      { code: "42P01", message: "a different message for the same code" },
    ]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.code, "42P01");
    assert.equal(groups[0]?.count, 3);
    // The first message seen for a code is the sample; later ones must not replace it.
    assert.match(groups[0]?.sample_message ?? "", /claim_entities/);
    assert.equal(groups[1]?.code, "55P03");
    assert.equal(groups[1]?.count, 1);
  });

  it("breaks ties by code so the order does not depend on arrival", () => {
    const groups = groupErrors([
      { code: "55P03", message: "b" },
      { code: "42P01", message: "a" },
    ]);
    assert.deepEqual(
      groups.map((group) => group.code),
      ["42P01", "55P03"],
    );
  });

  it("returns nothing for no failures, rather than a zero-count group", () => {
    assert.deepEqual(groupErrors([]), []);
  });

  it("collapses whitespace and truncates a long message", () => {
    assert.equal(tidyMessage("a\n\n  b\tc"), "a b c");
    const long = tidyMessage("x".repeat(500));
    assert.equal(long.length, 240);
    assert.ok(long.endsWith("…"));
  });

  it("removes UUIDs, so no scope or claim id reaches the report", () => {
    const message =
      'duplicate key value violates unique constraint on (tenant_id, canonical, claim_id) = ' +
      "(0f8fad5b-d9cb-469f-a165-70867728950e, alice, 7c9e6679-7425-40de-944b-e07fc1f90ae7)";
    const tidied = tidyMessage(message);
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(tidied), tidied);
    assert.match(tidied, /<uuid>/);
    assert.equal(redactIdentifiers("no ids here"), "no ids here");
  });
});

describe("workload accounting", () => {
  const sample = (input: Partial<AttemptSample> & Pick<AttemptSample, "operation" | "phase">): AttemptSample => ({
    started_at_ms: 0,
    finished_at_ms: 1,
    duration_ms: 1,
    ok: true,
    error_code: null,
    error_message: null,
    timed_out: false,
    result_count: 1,
    source: "probe",
    ...input,
  });

  it("counts attempts, successes, failures and timeouts separately", () => {
    const recorder = new WorkloadRecorder();
    recorder.record(sample({ operation: "lexical_retrieval", phase: "pre_migration" }));
    recorder.record(
      sample({
        operation: "lexical_retrieval",
        phase: "pre_migration",
        ok: false,
        error_code: "42883",
        error_message: "function does not exist",
        timed_out: false,
        result_count: null,
      }),
    );
    recorder.record(
      sample({
        operation: "lexical_retrieval",
        phase: "pre_migration",
        ok: false,
        error_code: "55P03",
        error_message: "lock timeout",
        timed_out: true,
        result_count: null,
      }),
    );
    const stats = recorder.snapshot({ started_at_ms: 0, ended_at_ms: 10 });
    const lexical = stats.operations.find((entry) => entry.operation === "lexical_retrieval");
    assert.equal(lexical?.attempts, 3);
    assert.equal(lexical?.successes, 1);
    assert.equal(lexical?.failures, 2);
    assert.equal(lexical?.timeouts, 1);
    // Both failures have count 1, so the tie-break is by code, not by arrival order.
    assert.deepEqual(
      lexical?.errors.map((group) => group.code),
      ["42883", "55P03"],
    );
  });

  it("counts an operation that returned no rows as an empty result, not as a failure", () => {
    const recorder = new WorkloadRecorder();
    recorder.record(
      sample({ operation: "entity_retrieval", phase: "post_migration", result_count: 0 }),
    );
    const stats = recorder.snapshot({ started_at_ms: 0, ended_at_ms: 10 });
    assert.equal(stats.operations.find((e) => e.operation === "entity_retrieval")?.empty_results, 1);
    assert.equal(stats.operations.find((e) => e.operation === "entity_retrieval")?.failures, 0);
  });

  it("records which phase each attempt belongs to", () => {
    const recorder = new WorkloadRecorder();
    recorder.openPhase("pre_migration", 0);
    recorder.record(sample({ operation: "append_event", phase: "pre_migration" }));
    recorder.closeAllPhases(100);
    recorder.openPhase("post_migration", 200);
    recorder.record(sample({ operation: "append_event", phase: "post_migration" }));
    recorder.closeAllPhases(300);
    const stats = recorder.snapshot({ started_at_ms: 0, ended_at_ms: 300 });
    assert.deepEqual(
      stats.phases.map((phase) => phase.phase),
      ["pre_migration", "post_migration"],
    );
    assert.equal(stats.phases[0]?.window.ended_at_ms, 100);
    assert.equal(stats.total_samples, 2);
  });

  it("reports samples that did not come from a probe", () => {
    const recorder = new WorkloadRecorder();
    recorder.record(sample({ operation: "append_event", phase: "pre_migration" }));
    const clean = recorder.snapshot({ started_at_ms: 0, ended_at_ms: 1 });
    assert.equal(clean.samples_from_non_probe, 0);
    // The check is real even though the production path cannot produce one: it is what stops
    // a migration's own timings being counted as application latency.
    assert.equal(
      clean.operations.every((operation) => operation.samples_from_non_probe === 0),
      true,
    );
  });
});

describe("measurement bookkeeping", () => {
  it("distinguishes measured, not applicable and missing", () => {
    assert.equal(noteFor("a", 0, "absent").state, "measured");
    assert.equal(noteFor("b", null, "absent").state, "missing");
    assert.equal(notApplicable("c", "the table does not exist yet").state, "not_applicable");
    assert.equal(measured("d").state, "measured");
  });

  it("treats a measured zero as measured, and only an absent value as missing", () => {
    // This is the rule that stops an unmeasured field becoming a zero in a chart.
    assert.deepEqual(noteFor("count", 0, "unread"), { field: "count", state: "measured", reason: "measured" });
    assert.deepEqual(noteFor("count", null, "unread"), {
      field: "count",
      state: "missing",
      reason: "unread",
    });
  });

  it("lists only the missing measurements as incompleteness reasons", () => {
    const notes = [
      measured("a"),
      missing("b", "no sample"),
      notApplicable("c", "0015 does not exist during 0014"),
      missing("d", "no reading"),
    ];
    assert.deepEqual(
      missingMeasurements(notes).map((note) => note.field),
      ["b", "d"],
    );
  });
});
