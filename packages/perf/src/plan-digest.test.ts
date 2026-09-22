/**
 * Structural plan digests, tested without a database.
 *
 * The digest is what every plan assertion in this package rests on, so its two required
 * properties are checked on synthetic plans where the expected answer is known exactly
 * rather than inferred from whatever PostgreSQL happened to plan:
 *
 *   * two plans that differ only in volatile fields — timing, rows, loops, buffers, WAL,
 *     cost estimates, worker statistics — must hash identically;
 *   * two plans that differ in *shape* must not.
 *
 * Testing this against a live database would be circular. If the digest were broken in the
 * direction of ignoring too much, every live comparison would trivially pass, and the test
 * asserting "the digest is stable" would confirm the bug rather than catch it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalPlan, planCounters, planOutline, planTimings, structuralDigest } from "./plan-digest.ts";

/** One explain document, shaped as PostgreSQL produces it. */
function explain(plan: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown[] {
  return [{ Plan: plan, "Planning Time": 0.1, "Execution Time": 0.2, ...extra }];
}

const ENTITY_PLAN = {
  "Node Type": "Limit",
  "Startup Cost": 12.0,
  "Total Cost": 34.0,
  "Plan Rows": 10,
  "Actual Startup Time": 0.05,
  "Actual Total Time": 0.11,
  "Actual Rows": 10,
  "Actual Loops": 1,
  "Shared Hit Blocks": 42,
  "Shared Read Blocks": 3,
  "WAL Records": 0,
  "WAL Bytes": 0,
  Plans: [
    {
      "Node Type": "Nested Loop",
      "Join Type": "Inner",
      "Startup Cost": 1.0,
      "Total Cost": 30.0,
      "Plan Rows": 10,
      "Actual Rows": 10,
      "Actual Loops": 1,
      "Shared Hit Blocks": 40,
      Plans: [
        {
          "Node Type": "Index Scan",
          "Relation Name": "entity_aliases",
          "Index Name": "entity_aliases_pkey",
          "Index Cond": "(tenant_id = $1)",
          "Filter": "(alias = ANY($2))",
          "Actual Rows": 2,
          "Actual Loops": 1,
          "Shared Hit Blocks": 4,
        },
        {
          "Node Type": "Index Scan",
          "Relation Name": "claim_entities",
          "Index Name": "claim_entities_pkey",
          "Index Cond": "(canonical = alias.canonical)",
          "Actual Rows": 10,
          "Actual Loops": 2,
          "Shared Hit Blocks": 36,
        },
      ],
    },
  ],
};

describe("structural plan digest", () => {
  it("is identical when only volatile fields differ", () => {
    const first = explain(structuredClone(ENTITY_PLAN));
    const second = explain(structuredClone(ENTITY_PLAN));

    // Every volatile field changed: timings, row and loop counts, cost estimates, buffer
    // counters, WAL, and the top-level planning/execution time.
    const mutate = (node: Record<string, unknown>, scale: number): void => {
      node["Actual Startup Time"] = 99 * scale;
      node["Actual Total Time"] = 123 * scale;
      node["Actual Rows"] = 999 * scale;
      node["Actual Loops"] = 7 * scale;
      node["Startup Cost"] = 500 * scale;
      node["Total Cost"] = 900 * scale;
      node["Plan Rows"] = 4242 * scale;
      node["Shared Hit Blocks"] = 1 * scale;
      node["Shared Read Blocks"] = 2 * scale;
      node["WAL Records"] = 3 * scale;
      node["WAL Bytes"] = 4 * scale;
      for (const child of (node["Plans"] as Record<string, unknown>[] | undefined) ?? []) mutate(child, scale);
    };
    mutate((second[0] as Record<string, unknown>)["Plan"] as Record<string, unknown>, 13);
    (second[0] as Record<string, unknown>)["Planning Time"] = 812.5;
    (second[0] as Record<string, unknown>)["Execution Time"] = 910.25;

    assert.equal(
      structuralDigest(second),
      structuralDigest(first),
      "a plan that differs only in volatile fields must hash identically, or every plan comparison is flaky",
    );
  });

  it("is identical when key order differs", () => {
    // PostgreSQL does not promise key order, and JSON object order is not meaningful here.
    const reordered = explain({
      Plans: ENTITY_PLAN.Plans,
      "Total Cost": ENTITY_PLAN["Total Cost"],
      "Node Type": ENTITY_PLAN["Node Type"],
      "Actual Loops": 1,
    });
    const straight = explain({
      "Node Type": ENTITY_PLAN["Node Type"],
      "Actual Loops": 1,
      "Total Cost": ENTITY_PLAN["Total Cost"],
      Plans: ENTITY_PLAN.Plans,
    });
    assert.equal(structuralDigest(reordered), structuralDigest(straight));
  });

  it("changes when the relation or index changes", () => {
    const base = explain(structuredClone(ENTITY_PLAN));
    const other = explain(structuredClone(ENTITY_PLAN));
    const scan = ((other[0] as Record<string, unknown>)["Plan"] as Record<string, unknown>)[
      "Plans"
    ] as Record<string, unknown>[];
    const nested = scan[0]!["Plans"] as Record<string, unknown>[];
    nested[1]!["Index Name"] = "claim_entities_claim_idx";
    assert.notEqual(
      structuralDigest(other),
      structuralDigest(base),
      "a different index is a different plan and must be visible",
    );
  });

  it("changes when a join type changes", () => {
    const base = explain(structuredClone(ENTITY_PLAN));
    const other = explain(structuredClone(ENTITY_PLAN));
    const node = ((other[0] as Record<string, unknown>)["Plan"] as Record<string, unknown>)[
      "Plans"
    ] as Record<string, unknown>[];
    node[0]!["Join Type"] = "Left";
    assert.notEqual(structuralDigest(other), structuralDigest(base));
  });

  it("changes when a filter or index condition changes, so a lost predicate is visible", () => {
    // This is the property the security assertions depend on: if a tenant predicate
    // disappeared, the digest must move.
    const base = explain(structuredClone(ENTITY_PLAN));
    const other = explain(structuredClone(ENTITY_PLAN));
    const node = ((other[0] as Record<string, unknown>)["Plan"] as Record<string, unknown>)[
      "Plans"
    ] as Record<string, unknown>[];
    node[0]!["Index Cond"] = "(canonical = alias.canonical)";
    assert.notEqual(
      structuralDigest(other),
      structuralDigest(base),
      "a dropped predicate must change the digest, or a security regression would pass",
    );
  });

  it("changes when the parallel topology changes", () => {
    const base = explain(structuredClone(ENTITY_PLAN));
    const other = explain(structuredClone(ENTITY_PLAN));
    const node = ((other[0] as Record<string, unknown>)["Plan"] as Record<string, unknown>)[
      "Plans"
    ] as Record<string, unknown>[];
    node[0]!["Parallel Aware"] = true;
    node[0]!["Plans"] = [
      { "Node Type": "Gather", Plans: [node[0]!["Plans"]] },
    ];
    assert.notEqual(structuralDigest(other), structuralDigest(base));
  });

  it("reports an absent plan as absent rather than as a stable digest", () => {
    // `canonicalPlan` is the guard: `null` is how a caller tells "there is no plan" from
    // "there is a plan", and the capture records such a stage as unsuccessful. Without it,
    // every failed capture would hash to the same value and compare as *equal* to every
    // other failed capture — a missing plan masquerading as a matching one.
    assert.equal(canonicalPlan([]), null);
    assert.equal(canonicalPlan([null as unknown]), null);
    // A document with only timing fields has no plan tree, so it is absent rather than empty.
    assert.equal(canonicalPlan([{ "Planning Time": 1 }]), null);

    // And that value is not equal to any real plan's digest, so "absent" cannot be mistaken
    // for "present and unchanged".
    const absent = structuralDigest([]);
    const present = structuralDigest(explain(structuredClone(ENTITY_PLAN)));
    assert.notEqual(absent, present);
  });

  it("reports timing and counters beside the digest, not inside it", () => {
    const plan = explain(structuredClone(ENTITY_PLAN));
    const timings = planTimings(plan);
    assert.equal(timings.planning_time_ms, 0.1);
    assert.equal(timings.execution_time_ms, 0.2);

    const counters = planCounters(plan);
    // Summed across nodes: 42 + 40 + 4 + 36 shared hits, 3 shared reads.
    assert.equal(counters.shared_hit, 122);
    assert.equal(counters.shared_read, 3);
    assert.equal(counters.wal_records, 0);
  });

  it("summarises the plan outline with relations and indexes", () => {
    const outline = planOutline(explain(structuredClone(ENTITY_PLAN)));
    const joined = outline.join("\n");
    assert.match(joined, /Limit/);
    assert.match(joined, /Index Scan on entity_aliases using entity_aliases_pkey/);
    assert.match(joined, /Index Scan on claim_entities using claim_entities_pkey/);
  });
});
