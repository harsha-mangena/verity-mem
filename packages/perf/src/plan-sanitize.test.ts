/**
 * Sanitization, leak detection and structural digests — tested without a database.
 *
 * These are the properties the artifact's safety and its usefulness both rest on, and both
 * are easier to get wrong in the direction that looks fine:
 *
 *   * a sanitizer that removes too little publishes a tenant id, and nothing about the
 *     artifact's shape reveals it;
 *   * a digest that removes too much makes every plan compare equal, so a regression passes;
 *   * a digest that removes too little makes every plan compare different, so the comparison
 *     is useless and gets ignored.
 *
 * All three are checked here on synthetic plans where the expected answer is known, because a
 * live plan cannot tell you which of its fields carried a bound value.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findLeaks, findMarkers, redactUuids, sanitizeExpression, sanitizePlan } from "./plan-sanitize.ts";
import { structuralDigest } from "./plan-digest.ts";

const TENANT = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const OTHER_TENANT = "9c1b8a7d-6e5f-4a3b-9c8d-7e6f5a4b3c2d";

/** A plan of the shape the entity channel produces, with bound values substituted in. */
function entityPlan(options: { tenant?: string; query?: string; subject?: string } = {}): unknown[] {
  const tenant = options.tenant ?? TENANT;
  const query = options.query ?? "deployment window";
  const subject = options.subject ?? "user:eng-00";
  return [
    {
      Plan: {
        "Node Type": "Limit",
        "Startup Cost": 12,
        "Total Cost": 34,
        "Plan Rows": 10,
        "Actual Startup Time": 0.05,
        "Actual Total Time": 0.11,
        "Actual Rows": 10,
        "Actual Loops": 1,
        "Shared Hit Blocks": 42,
        Plans: [
          {
            "Node Type": "Nested Loop",
            "Join Type": "Inner",
            "Join Filter": `(ce.canonical = (a.alias || ' ${subject}'::text))`,
            "Actual Rows": 10,
            "Actual Loops": 1,
            Plans: [
              {
                "Node Type": "Index Scan",
                "Relation Name": "entity_aliases",
                "Index Name": "entity_aliases_pkey",
                "Index Cond": `((tenant_id = '${tenant}'::uuid) AND (alias = '${query}'::text))`,
                Filter: `(canonical <> '${subject}'::text)`,
                Output: `a.alias, a.canonical, ce.claim_id`,
                "Actual Rows": 2,
                "Actual Loops": 1,
                "Shared Hit Blocks": 4,
              },
              {
                "Node Type": "Index Scan",
                "Relation Name": "claim_entities",
                "Index Name": "claim_entities_pkey",
                "Index Cond": `(tenant_id = '${tenant}'::uuid)`,
                Output: `ce.claim_id, ce.canonical`,
                "Sort Key": `ce.canonical, '${query}'::text`,
                "Actual Rows": 10,
                "Actual Loops": 2,
                "Shared Hit Blocks": 36,
              },
            ],
          },
        ],
      },
      "Planning Time": 0.1,
      "Execution Time": 0.2,
      Settings: { enable_seqscan: "on", work_mem: "4MB" },
    },
  ];
}

describe("sanitizeExpression", () => {
  it("removes string literals and UUIDs while keeping structure", () => {
    const input = `((tenant_id = '${TENANT}'::uuid) AND (alias = 'deployment window'::text))`;
    const out = sanitizeExpression(input);
    assert.ok(!out.includes(TENANT), `a UUID survived: ${out}`);
    assert.ok(!out.includes("deployment window"), `query text survived: ${out}`);
    // Structure is what the artifact is for.
    assert.match(out, /tenant_id/);
    assert.match(out, /alias/);
    assert.match(out, /::uuid/);
    assert.match(out, /AND/);
  });

  it("removes numbers but keeps identifiers that merely contain digits", () => {
    const out = sanitizeExpression("(t1.span_count > 42)");
    assert.match(out, /t1\.span_count/, "an identifier containing a digit must survive");
    assert.ok(!out.includes("42"), `the numeric literal survived: ${out}`);
  });

  it("removes booleans, which PostgreSQL substitutes into rewritten plans", () => {
    const out = sanitizeExpression("(chained = false)");
    assert.ok(!out.includes("false"), `the boolean literal survived: ${out}`);
    assert.match(out, /chained/);
  });

  it("removes array contents", () => {
    const out = sanitizeExpression(`(scope_id = ANY('{${TENANT}}'::uuid[]))`);
    assert.ok(!out.includes(TENANT), `a UUID inside an array literal survived: ${out}`);
    assert.match(out, /scope_id/);
    assert.match(out, /ANY/);
  });

  it("keeps parameter placeholders, which are structure rather than values", () => {
    const out = sanitizeExpression("(tenant_id = $1::uuid)");
    assert.match(out, /\$1/, "a placeholder identifies which parameter is used and must survive");
  });

  it("keeps quoted identifiers", () => {
    const out = sanitizeExpression(`("my column" = 'value')`);
    assert.match(out, /"my column"/);
    assert.ok(!out.includes("value"));
  });
});

describe("sanitizePlan", () => {
  it("removes bound values from every expression-bearing field", () => {
    const plan = entityPlan();
    const sanitized = sanitizePlan(plan);
    const serialized = JSON.stringify(sanitized);
    assert.ok(!serialized.includes(TENANT), "the tenant UUID survived sanitization");
    assert.ok(!serialized.includes("deployment window"), "the query text survived sanitization");
    assert.ok(!serialized.includes("user:eng-00"), "the declared subject survived sanitization");
  });

  it("preserves topology, relations, indexes and operators", () => {
    const sanitized = JSON.stringify(sanitizePlan(entityPlan()));
    assert.match(sanitized, /Nested Loop/);
    assert.match(sanitized, /entity_aliases/);
    assert.match(sanitized, /claim_entities_pkey/);
    assert.match(sanitized, /tenant_id/);
    assert.match(sanitized, /::uuid/);
    // Settings explain a plan choice, so they are kept.
    assert.match(sanitized, /enable_seqscan/);
  });

  it("removes a value that appears under a field it has never heard of", () => {
    // The reason sanitization cannot be a list of field names: a PostgreSQL version can add
    // one, and a value surviving by accident is the failure mode.
    const plan = entityPlan();
    (plan[0] as Record<string, unknown>)["Some Future Field"] = `(secret = '${TENANT}'::uuid)`;
    const serialized = JSON.stringify(sanitizePlan(plan));
    assert.ok(
      !serialized.includes(TENANT),
      "a UUID under an unrecognised field survived; the sanitizer relies on a field list",
    );
  });

  it("removes UUIDs even when the expression scanner mis-parses them", () => {
    // `redactUuids` is the second line of defence, so it is tested on input the scanner has
    // no reason to treat as an expression at all.
    assert.ok(!redactUuids(`prefix ${TENANT} suffix`).includes(TENANT));
    assert.ok(!redactUuids(`{"a":"${TENANT}"}`).includes(TENANT));
  });
});

describe("findLeaks", () => {
  it("finds a probe that is present and reports which one", () => {
    const artifact = { stages: [{ sanitized_plan: entityPlan() }] };
    // The raw plan is used deliberately: this asserts the *detector* works, which is the
    // independent check that catches a sanitizer miss.
    const leaked = findLeaks(artifact, [{ label: "tenant id", value: TENANT }]);
    assert.equal(leaked.length, 1);
    assert.equal(leaked[0]?.label, "tenant id");
  });

  it("finds a probe inside a plan field, not only in the SQL text", () => {
    const artifact = { stages: [{ sanitized_plan: sanitizePlan(entityPlan()) }] };
    const leaked = findLeaks(artifact, [
      { label: "tenant id", value: TENANT },
      { label: "query text", value: "deployment window" },
    ]);
    assert.deepEqual(leaked, [], "a sanitized plan must contain neither probe");
  });

  it("ignores probes too short to be meaningful, so the check is not noise", () => {
    const artifact = { anything: "the word en appears everywhere" };
    assert.deepEqual(findLeaks(artifact, [{ label: "fragment", value: "en" }]), []);
  });

  it("detects connection strings and credential markers case-insensitively", () => {
    assert.deepEqual(findMarkers({ a: "postgres://user:pw@host/db" }, ["postgres://"]), ["postgres://"]);
    assert.deepEqual(findMarkers({ a: "Authorization: Bearer abc" }, ["bearer "]), ["bearer "]);
    assert.deepEqual(findMarkers({ a: "nothing here" }, ["postgres://", "password"]), []);
  });
});

describe("structural digest is a function of shape", () => {
  it("is identical for the same topology with different bound values", () => {
    // The property that makes the digest useful: two captures of the same query shape against
    // different tenants must compare equal, or every run reports a change.
    const one = structuralDigest(entityPlan({ tenant: TENANT, query: "deployment window" }));
    const two = structuralDigest(
      entityPlan({ tenant: OTHER_TENANT, query: "a completely different question", subject: "user:eng-07" }),
    );
    assert.equal(two, one, "identical topology with different literals must hash identically");
  });

  it("is identical when only timing, rows, loops, buffers and WAL differ", () => {
    const first = entityPlan();
    const second = entityPlan();
    const mutate = (node: Record<string, unknown>, scale: number): void => {
      for (const key of [
        "Actual Startup Time",
        "Actual Total Time",
        "Actual Rows",
        "Actual Loops",
        "Startup Cost",
        "Total Cost",
        "Plan Rows",
        "Shared Hit Blocks",
        "Shared Read Blocks",
        "WAL Records",
        "WAL Bytes",
      ]) {
        node[key] = 1000 * scale;
      }
      for (const child of (node["Plans"] as Record<string, unknown>[] | undefined) ?? []) mutate(child, scale);
    };
    mutate((second[0] as Record<string, unknown>)["Plan"] as Record<string, unknown>, 13);
    (second[0] as Record<string, unknown>)["Planning Time"] = 812.5;
    (second[0] as Record<string, unknown>)["Execution Time"] = 910.25;
    assert.equal(structuralDigest(second), structuralDigest(first));
  });

  it("changes when the node type changes", () => {
    const base = entityPlan();
    const other = entityPlan();
    ((other[0] as Record<string, unknown>)["Plan"] as Record<string, unknown>)["Node Type"] = "Sort";
    assert.notEqual(structuralDigest(other), structuralDigest(base));
  });

  it("changes when the relation or index changes", () => {
    for (const key of ["Relation Name", "Index Name"]) {
      const base = entityPlan();
      const other = entityPlan();
      const inner = (((other[0] as Record<string, unknown>)["Plan"] as Record<string, unknown>)[
        "Plans"
      ] as Record<string, unknown>[])[0]!["Plans"] as Record<string, unknown>[];
      inner[1]![key] = "something_else_idx";
      assert.notEqual(structuralDigest(other), structuralDigest(base), `a different ${key} must change the digest`);
    }
  });

  it("changes when the join topology changes", () => {
    const base = entityPlan();
    const other = entityPlan();
    const inner = (((other[0] as Record<string, unknown>)["Plan"] as Record<string, unknown>)[
      "Plans"
    ] as Record<string, unknown>[])[0]!;
    inner["Join Type"] = "Left";
    assert.notEqual(structuralDigest(other), structuralDigest(base));
  });

  it("changes when a predicate changes, so a lost filter is visible", () => {
    const base = entityPlan();
    const other = entityPlan();
    const inner = (((other[0] as Record<string, unknown>)["Plan"] as Record<string, unknown>)[
      "Plans"
    ] as Record<string, unknown>[])[0]!["Plans"] as Record<string, unknown>[];
    inner[0]!["Index Cond"] = "(alias = $1::text)";
    assert.notEqual(
      structuralDigest(other),
      structuralDigest(base),
      "a dropped tenant predicate must change the digest",
    );
  });

  it("preserves Parallel Aware and Workers Planned, and drops Workers Launched", () => {
    const base = entityPlan();
    const planned = entityPlan();
    const plan = (planned[0] as Record<string, unknown>)["Plan"] as Record<string, unknown>;
    plan["Parallel Aware"] = true;
    plan["Workers Planned"] = 2;
    plan["Workers Launched"] = 2;
    assert.notEqual(
      structuralDigest(planned),
      structuralDigest(base),
      "a parallel-aware plan must not share a digest with its serial form",
    );

    // Two runs that launched different numbers of workers, with the same planned topology.
    const twoWorkers = entityPlan();
    const oneWorker = entityPlan();
    for (const [plan_, launched] of [
      [(twoWorkers[0] as Record<string, unknown>)["Plan"] as Record<string, unknown>, 2],
      [(oneWorker[0] as Record<string, unknown>)["Plan"] as Record<string, unknown>, 1],
    ] as const) {
      plan_["Parallel Aware"] = true;
      plan_["Workers Planned"] = 2;
      plan_["Workers Launched"] = launched;
    }
    assert.equal(
      structuralDigest(oneWorker),
      structuralDigest(twoWorkers),
      "the number of workers actually launched is runtime data, not topology",
    );
  });

  it("reports an absent plan as absent rather than as a digest shared by every failure", () => {
    assert.equal(structuralDigest([]), structuralDigest([{ "Planning Time": 1 }]));
    assert.notEqual(structuralDigest([]), structuralDigest(entityPlan()));
  });
});
