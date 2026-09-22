/**
 * VM-A3 regression assertions against a live capture.
 *
 * These are the tests that make the artifact worth producing. A captured plan is only
 * evidence if something asserts what it must contain, and the assertions are written against
 * *relations, predicates and the absence of a forbidden shape* rather than against a
 * particular index scan: on a few hundred rows PostgreSQL may correctly choose a sequential
 * scan, and a test demanding an index scan would fail on a correct plan.
 *
 * The forbidden-shape assertions are the ones with teeth. Migration 0015 exists because the
 * entity channel joined a dictionary to every claim in the tenant with an `OR` over
 * `lower(object::text)`, which no index could serve. A capture that did not assert its
 * absence would happily record the regression.
 *
 * ## This file fails; it does not skip
 *
 * An earlier version caught every failure in its `before` hook, set a flag, and let each test
 * return early when the flag was set. Every test then passed while asserting nothing —
 * including on a machine with no database at all. **A test that converts missing evidence
 * into a passing test is worse than no test**, because the report says the artifact was
 * verified.
 *
 * So there is no `describeCaptured`, no `unavailable`, and no early `return`. The `before`
 * hook provisions the fixture and runs the capture; if either fails, the hook throws and
 * every test in the file fails with that error.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { capturePlans, PLAN_SCHEMA_VERSION, REQUIRED_STAGES, type StageCapture } from "./plan-capture.ts";
import {
  FIXTURE_FROM,
  FIXTURE_QUERY,
  FIXTURE_TO,
  provisionFixture,
  type Fixture,
} from "./plan-fixture.ts";

interface Captured {
  readonly artifact: Record<string, unknown>;
  readonly stages: readonly StageCapture[];
  readonly byStage: Map<string, StageCapture>;
  readonly fixture: Fixture;
  readonly completion: Awaited<ReturnType<typeof capturePlans>>["completion"];
}

/**
 * The capture, produced once for the whole file.
 *
 * `undefined` means "the hook has not run yet", which no test can observe because the hook
 * runs first and throws on failure. There is deliberately no null-and-branch form: the type
 * is non-optional at every use site, so a test cannot silently proceed without it.
 */
let captured: Captured;

before(async () => {
  const fixture = await provisionFixture();
  const result = await capturePlans({
    tenant: fixture.tenantSlug,
    query: FIXTURE_QUERY,
    limit: 10,
    output: `/tmp/vm-a3-plan-capture-test-${process.pid}.json`,
    databaseUrl: null,
    migrationUrl: null,
    force: true,
    purpose: "release_planning",
    principal: fixture.principal,
    subjects: [fixture.subject],
    // `during` with a real window, because that is the only mode in which the temporal
    // channel issues a statement — and the all-stage contract requires it.
    time: { mode: "during", from: FIXTURE_FROM, to: FIXTURE_TO },
    log: () => undefined,
  });

  const artifact = result.artifact as Record<string, unknown>;
  const stages = artifact["stages"] as StageCapture[];
  captured = {
    artifact,
    stages,
    byStage: new Map(stages.map((stage) => [stage.stage, stage])),
    fixture,
    completion: result.completion,
  };
});

describe("VM-A3 · the capture is complete", () => {
  it("provisions a fixture with a row for every stage", () => {
    // Printed, not just asserted, so a reader can see what the assertions ran against.
    process.stderr.write(
      `\n[plan-capture] fixture '${captured.fixture.tenantSlug}': ` +
        `${JSON.stringify(captured.fixture.counts)}\n` +
        `[plan-capture] reused existing corpus: ${captured.fixture.reused}\n`,
    );
    assert.equal(captured.fixture.reused || captured.fixture.counts.claims > 0, true);
    for (const [field, count] of Object.entries(captured.fixture.counts)) {
      assert.ok(Number(count) > 0, `the fixture's ${field} is ${count}, so a stage would be silently empty`);
    }
    assert.ok(
      captured.fixture.counts.accepted_in_window > 0,
      "the fixture has no accepted claim inside the during window, so the temporal channel " +
        "would produce a plan over an empty set",
    );
  });

  it("captured all twelve stages with none missing, failed, duplicated or unlabelled", () => {
    // The all-stage contract, asserted as one statement rather than as twelve presence
    // checks, because the interesting failure is a stage that is absent *and* the run
    // reported success.
    assert.equal(
      captured.completion.complete,
      true,
      `the capture is incomplete: ${captured.completion.reasons.join("; ")}`,
    );
    assert.deepEqual(captured.completion.unexpected_missing, [], "a selected stage was not captured");
    assert.deepEqual(captured.completion.failed, [], "a stage failed to produce a plan");
    assert.deepEqual(captured.completion.duplicated, [], "a stage captured more than one statement");
    assert.equal(captured.completion.unlabeled, 0, "a statement was captured without a stage name");

    // And all twelve by name, so the count cannot be satisfied by the wrong set.
    assert.equal(REQUIRED_STAGES.length, 12, "the contract is twelve stages");
    const present = captured.stages.map((stage) => stage.stage);
    for (const stage of REQUIRED_STAGES) {
      assert.ok(present.includes(stage), `stage '${stage}' is absent; captured: ${present.join(", ")}`);
    }
    assert.equal(new Set(present).size, present.length, "a stage appears twice");
  });

  it("reports the assessment in the artifact, so a reader need not re-derive it", () => {
    const capture = captured.artifact["capture"] as Record<string, unknown>;
    assert.equal(capture["complete"], true);
    assert.deepEqual(capture["unexpectedly_missing_stages"], []);
    assert.deepEqual(capture["failed_stages"], []);
    assert.deepEqual(capture["duplicated_stages"], []);
    assert.equal(capture["unlabeled_statements"], 0);
    assert.deepEqual(capture["missing_stages"], [], "with during and a subject, nothing is conditionally absent");
  });
});

describe("VM-A3 · the capture is correct", () => {
  it("labels every statement with the stage that actually issued it", () => {
    // A regression test for a defect that produced a *complete-looking* artifact.
    //
    // `runChannels` runs the ordinary channels and the dense channel on two concurrent
    // transactions. Two attempts at a queue of pending stage names — global, then per lane —
    // let the lanes pair each other's names with each other's statements; a trace showed
    // `entity_channel` popping `dense_vector_search`. Every stage was present, every digest
    // was distinct, and every label was wrong.
    //
    // Each case is a statement fragment that only that stage issues.
    const expected: ReadonlyArray<readonly [string, RegExp]> = [
      ["scope_binding", /set_request_context/],
      ["lexical_channel", /ts_rank\(c\.search_tsv/],
      ["entity_channel", /count\(DISTINCT a\.alias\)/],
      ["dense_model_version", /SELECT model_version, ledger_watermark\s+FROM projection_versions/],
      ["dense_vector_search", /e\.embedding <=> \$\d+::vector/],
      ["temporal_channel", /valid_range &&|valid_from/],
      ["relation_channel", /FROM claim_relations r/],
      ["claim_hydration", /SELECT c\.claim_id, c\.tenant_id, c\.scope_id, c\.kind/],
      ["claim_relations_read", /FROM claim_relations/],
      ["claim_evidence_read", /FROM claim_evidence ce/],
      ["span_verification", /FROM events/],
      ["projection_watermark", /COALESCE\(max\(ledger_watermark\)/],
    ];

    for (const [stage, pattern] of expected) {
      const entry = captured.byStage.get(stage);
      assert.ok(entry, `stage '${stage}' was not captured`);
      assert.match(
        entry.sanitized_sql,
        pattern,
        `stage '${stage}' is labelled onto a statement it does not issue — the attribution has ` +
          `crossed again. Captured SQL: ${entry.sanitized_sql.replace(/\s+/g, " ").slice(0, 120)}`,
      );
    }
  });

  it("ran every retrieval stage as the application role, never as the owner", () => {
    const role = captured.artifact["application_role"] as {
      role: string;
      superuser: boolean;
      bypassrls: boolean;
    };
    assert.equal(role.role, "veritymem_app", "the artifact must name the application role");
    assert.equal(role.bypassrls, false, "a role that bypasses RLS would omit the policy predicate");
    assert.equal(role.superuser, false, "a superuser would omit the policy predicate");
  });

  it("uses current_reachable_scope_ids() and never scope_reachable per row", () => {
    const retrieval = captured.stages.filter(
      (stage) => stage.stage.endsWith("_channel") || stage.stage === "claim_hydration",
    );
    assert.ok(retrieval.length > 0, "at least one retrieval plan must be captured");
    assert.ok(
      retrieval.some((stage) => stage.sanitized_sql.includes("current_reachable_scope_ids")),
      "no retrieval statement consults current_reachable_scope_ids()",
    );
    for (const stage of captured.stages) {
      assert.ok(
        !stage.sanitized_sql.includes("veritymem.scope_reachable("),
        `stage '${stage.stage}' calls scope_reachable directly, which is the per-candidate path ` +
          `migration 0014 removed`,
      );
    }
  });

  it("keeps the entity channel on claim_entities with the tenant boundary and no OR join", () => {
    const entity = captured.byStage.get("entity_channel");
    assert.ok(entity, "the entity channel must be captured");
    assert.match(entity.sanitized_sql, /claim_entities/, "the entity channel must read the projection");
    assert.match(entity.sanitized_sql, /tenant_id/, "the entity channel must retain a tenant predicate");
    assert.doesNotMatch(
      entity.sanitized_sql,
      /OR\s+a\.canonical/i,
      "the alias-to-all-claims OR join has returned; 0015 exists to prevent exactly this",
    );
    assert.doesNotMatch(
      entity.sanitized_sql,
      /object::text/,
      "the entity channel compares an alias against object::text, which quotes a JSON string so " +
        "the comparison can never match",
    );
    assert.match(
      entity.plan_outline.join("\n"),
      /claim_entities/,
      `the entity plan does not reference claim_entities; outline:\n${entity.plan_outline.join("\n")}`,
    );
  });

  it("keeps the dense channel's tenant and model predicates as distinct plans", () => {
    const version = captured.byStage.get("dense_model_version");
    const search = captured.byStage.get("dense_vector_search");
    assert.ok(version, "the model-version lookup must be captured separately");
    assert.ok(search, "the vector search must be captured");
    assert.match(version.sanitized_sql, /projection_versions/);
    assert.match(search.sanitized_sql, /claim_embeddings/);
    assert.match(search.sanitized_sql, /tenant_id/, "the vector search must retain the tenant predicate");
    assert.match(search.sanitized_sql, /model_id/, "the vector search must retain the model predicate");
    assert.match(search.sanitized_sql, /<=>/, "the vector search must use the distance operator");
    assert.notEqual(
      version.structural_plan_digest,
      search.structural_plan_digest,
      "the version lookup and the vector search must be distinct plans",
    );
  });

  it("made no hosted-model call and recorded the local embedder", () => {
    const embeddings = captured.artifact["embeddings"] as {
      model_id: string;
      dimensions: number;
      is_model_call: boolean;
    };
    assert.equal(embeddings.is_model_call, false, "the capture must not call a hosted model");
    assert.match(embeddings.model_id, /hash/, "the local deterministic embedder must be recorded");
    assert.ok(embeddings.dimensions > 0);
  });
});

describe("VM-A3 · parameter types for every statement", () => {
  it("records types for every statement that has placeholders", () => {
    // The earlier version recorded types only for `scope_binding`, keyed by `stage:sql.length`.
    // That key is wrong twice: two statements can share a length, and a one-character edit
    // silently reattaches the previous statement's types to a different query.
    const withPlaceholders = captured.stages.filter((stage) => /\$\d/.test(stage.sanitized_sql));
    assert.ok(withPlaceholders.length >= 10, "most statements bind parameters");
    for (const stage of withPlaceholders) {
      assert.ok(
        stage.parameter_types.length > 0,
        `stage '${stage.stage}' binds parameters but recorded no types: ` +
          `${stage.sanitized_sql.replace(/\s+/g, " ").slice(0, 100)}`,
      );
    }
  });

  it("records enough types to cover the highest placeholder number", () => {
    for (const stage of captured.stages) {
      const numbers = [...stage.sanitized_sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
      if (numbers.length === 0) continue;
      const highest = Math.max(...numbers);
      assert.ok(
        stage.parameter_types.length >= highest,
        `stage '${stage.stage}' uses $${highest} but recorded ${stage.parameter_types.length} type(s)`,
      );
    }
  });

  it("gives the two dense statements independent type records", () => {
    // They run from two executors on the same connection, which is exactly where a fixed
    // prepared-statement name would collide and make one of them report nothing.
    const version = captured.byStage.get("dense_model_version");
    const search = captured.byStage.get("dense_vector_search");
    assert.ok(version && search);
    assert.ok(version.parameter_types.length > 0, "the model-version lookup recorded no types");
    assert.ok(search.parameter_types.length > 0, "the vector search recorded no types");
    assert.notEqual(
      version.sanitized_sql,
      search.sanitized_sql,
      "the two dense statements must be different statements",
    );
  });

  it("records types the database actually inferred, not guesses from the values", () => {
    // `current_reachable_scope_ids()` and the tenant parameter are uuid-typed; a guess from
    // the JavaScript values would say `text`.
    const lexical = captured.byStage.get("lexical_channel");
    assert.ok(lexical, "the lexical channel must be captured");
    assert.ok(
      lexical.parameter_types.some((type) => type === "uuid" || type === "uuid[]"),
      `expected at least one uuid-typed parameter; got ${JSON.stringify(lexical.parameter_types)}`,
    );
  });
});

describe("VM-A3 · the artifact's contract", () => {
  it("carries every required top-level field", () => {
    const artifact = captured.artifact;
    for (const field of [
      "schema_version",
      "generated_at",
      "commit",
      "postgres",
      "migrations",
      "settings",
      "application_role",
      "tenant",
      "request",
      "embeddings",
      "capture",
      "stages",
    ]) {
      assert.ok(field in artifact, `the artifact is missing '${field}'`);
    }
    assert.equal(artifact["schema_version"], PLAN_SCHEMA_VERSION);
    assert.match(String(artifact["commit"]), /^[0-9a-f]{40}$|^unknown$/);
  });

  it("carries every required field on every stage entry", () => {
    for (const stage of captured.stages) {
      for (const field of [
        "stage",
        "success",
        "structural_plan_digest",
        "sanitized_plan",
        "planning_time_ms",
        "execution_time_ms",
        "buffers",
        "selected_settings",
        "parameter_types",
        "sanitized_sql",
        "error",
      ]) {
        assert.ok(field in stage, `stage '${stage.stage}' is missing '${field}'`);
      }
      assert.ok(stage.sanitized_plan !== null, `stage '${stage.stage}' has no plan to diagnose with`);
      assert.ok(stage.buffers !== null, `stage '${stage.stage}' has no buffer counters`);
    }
  });

  it("names the sanitized plan honestly and does not claim it is raw", () => {
    for (const stage of captured.stages) {
      assert.ok(
        !("raw_plan" in stage),
        `stage '${stage.stage}' exposes a 'raw_plan' field; the document is sanitized and calling ` +
          `it raw is a false claim about what a reader is looking at`,
      );
    }
  });

  it("contains no secret anywhere in the serialized artifact, plan trees included", () => {
    // The whole serialized document, not only `sanitized_sql`. `EXPLAIN (FORMAT JSON)` puts
    // the rewritten statement — with bound values substituted — into `Filter`, `Index Cond`,
    // `Output` and others, so inspecting the SQL field alone would miss the leak entirely.
    const serialized = JSON.stringify(captured.artifact);
    const fixture = captured.fixture;

    const probes: ReadonlyArray<readonly [string, string]> = [
      ["tenant id", fixture.tenantId],
      ["tenant slug", fixture.tenantSlug],
      ["principal", fixture.principal],
      ["query text", FIXTURE_QUERY],
      ["declared subject", fixture.subject],
    ];
    for (const [label, value] of probes) {
      assert.ok(
        !serialized.includes(value),
        `the artifact contains the ${label} ('${value.slice(0, 24)}…')`,
      );
    }
    // The scope ids, read from the fixture rather than guessed.
    for (const marker of ["postgres://", "postgresql://", "password", "Bearer "]) {
      assert.ok(
        !serialized.toLowerCase().includes(marker.toLowerCase()),
        `the artifact contains '${marker}', which is a credential or a connection string`,
      );
    }
    // Case-insensitive: a plan field could upper-case a value.
    assert.ok(
      !serialized.toLowerCase().includes(FIXTURE_QUERY.toLowerCase()),
      "the artifact contains the query text in a plan field",
    );

    // And the digest fields really are digests.
    const request = captured.artifact["request"] as { query_digest: string; principal_digest: string };
    assert.match(request.query_digest, /^sha256:[0-9a-f]{16}$/);
    assert.match(request.principal_digest, /^sha256:[0-9a-f]{16}$/);
    const tenant = captured.artifact["tenant"] as { digest: string };
    assert.match(tenant.digest, /^[0-9a-f]{16}$/);
  });

  it("records the database, role and request facts the plans depend on", () => {
    const postgres = captured.artifact["postgres"] as { version: string; pgvector_version: string | null };
    assert.match(postgres.version, /^17\./, "the PostgreSQL version must be recorded");
    assert.match(String(postgres.pgvector_version), /^0\.8\./, "the pgvector version must be recorded");

    const migrations = captured.artifact["migrations"] as { applied: number; latest: string | null };
    assert.ok(migrations.applied >= 15);
    assert.equal(migrations.latest, "0015_claim_entity_index.sql");

    const settings = captured.artifact["settings"] as Record<string, string>;
    assert.ok(settings["server_version"], "server_version must be among the recorded settings");
    assert.ok(settings["shared_buffers"], "shared_buffers must be recorded; it explains a plan choice");

    const request = captured.artifact["request"] as {
      time_mode: string;
      time_window: { from: string; to: string } | null;
      declared_subjects: number;
    };
    assert.equal(request.time_mode, "during", "the capture ran with a during window");
    assert.deepEqual(
      request.time_window,
      { from: FIXTURE_FROM, to: FIXTURE_TO },
      "the resolved window must be recorded so the artifact is self-contained",
    );
    assert.equal(request.declared_subjects, 1);
  });

  it("states that captured timings are not latency evidence", () => {
    const capture = captured.artifact["capture"] as { timing_note: string; wall_ms: number };
    assert.match(capture.timing_note, /second|warm/i);
    assert.ok(capture.wall_ms > 0);
  });
});
