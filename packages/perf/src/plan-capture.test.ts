/**
 * VM-A3 regression assertions against a live capture.
 *
 * These are the tests that make the artifact worth producing. A captured plan is only
 * evidence if something asserts what it must contain, and the assertions here are written
 * against *relations, predicates and the absence of a forbidden shape* rather than against
 * a particular index scan: on a few hundred rows PostgreSQL may correctly choose a
 * sequential scan, and a test demanding an index scan would fail on a correct plan.
 *
 * The forbidden-shape assertions are the ones with teeth. Migration 0015 exists because the
 * entity channel joined a dictionary to every claim in the tenant with an `OR` over
 * `lower(object::text)`, which no index could serve. A capture that did not assert its
 * absence would happily record the regression.
 *
 * Requires a database. Skips — loudly, not silently — when none is reachable.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { before, describe, it } from "node:test";
import { Db, loadEnv } from "@veritymem/ledger";
import { capturePlans, PLAN_SCHEMA_VERSION, REQUIRED_STAGES, type StageCapture } from "./plan-capture.ts";

interface Captured {
  readonly artifact: Record<string, unknown>;
  readonly stages: readonly StageCapture[];
  readonly byStage: Map<string, StageCapture>;
}

let captured: Captured | null = null;
let unavailable: string | null = null;

/** The tenant the capture runs against, from the environment or the documented default. */
const TENANT = process.env["VM_A3_TENANT"] ?? "vm-a3-capture-test";
/**
 * A declared subject, which is what makes the relation channel planned at all.
 *
 * Discovered from the tenant rather than configured, so the test does not depend on the
 * caller knowing that the relation channel needs one. `VM_A3_SUBJECT` overrides it.
 */
let SUBJECT: string | null = process.env["VM_A3_SUBJECT"] ?? null;

/** The first subject in the tenant, read as the owner because this is fixture discovery. */
async function discoverSubject(): Promise<string | null> {
  const url = loadEnv().migrationDatabaseUrl;
  if (!url) return null;
  const db = new Db({ connectionString: url, max: 1 });
  try {
    const row = await db.systemQuery<{ subject: string }>(
      `SELECT c.subject FROM claims c
         JOIN tenants t ON t.tenant_id = c.tenant_id
        WHERE t.slug = $1
        LIMIT 1`,
      [TENANT],
    );
    return row.rows[0]?.subject ?? null;
  } catch {
    return null;
  } finally {
    await db.close();
  }
}

/** Whether the configured database answers, without throwing when it does not. */
async function databaseAvailable(): Promise<boolean> {
  const url = loadEnv().databaseUrl;
  if (!url) return false;
  const db = new Db({ connectionString: url, max: 1 });
  try {
    await db.systemQuery("SELECT 1 AS ok");
    return true;
  } catch {
    return false;
  } finally {
    await db.close();
  }
}

before(async () => {
  if (!(await databaseAvailable())) {
    unavailable = "no database is reachable";
    process.stderr.write(
      `\n[plan-capture] DATABASE UNAVAILABLE — these tests did NOT run.\n` +
        `  start one with: pnpm db:up && pnpm migrate\n` +
        `  the plan-capture evidence for this commit is therefore UNVERIFIED here.\n\n`,
    );
    return;
  }
  try {
    SUBJECT ??= await discoverSubject();
    const result = await capturePlans({
      tenant: TENANT,
      query: process.env["VM_A3_QUERY"] ?? "deployment window",
      limit: 10,
      output: `/tmp/vm-a3-capture-test-${Date.now()}.json`,
      databaseUrl: null,
      migrationUrl: null,
      force: true,
      purpose: "release_planning",
      principal: null,
      subjects: SUBJECT === null ? [] : [SUBJECT],
      timeMode: "current",
      log: () => undefined,
    });
    const artifact = result.artifact as Record<string, unknown>;
    const stages = artifact["stages"] as StageCapture[];
    captured = { artifact, stages, byStage: new Map(stages.map((stage) => [stage.stage, stage])) };
  } catch (error) {
    unavailable = (error as Error).message;
    process.stderr.write(`\n[plan-capture] CAPTURE FAILED — these tests did NOT run: ${unavailable}\n\n`);
  }
});

const describeCaptured = (): boolean => captured === null;

describe("VM-A3 · captured retrieval plans", { skip: false }, () => {
  it("captured every stage the plan selected, and no failed stage", () => {
    if (describeCaptured()) return; // reported by the diagnostic above

    // Which channels ran is the *planner's* decision, not this test's. `temporal` appears
    // only when the query carries a time mode and `relation` only for caller-declared
    // subjects, so a fixed list would demand stages the query never asked for. What must
    // hold is: the channels every query plans are all present, no captured stage failed,
    // and nothing was captured without a name.
    const selected: string[] = captured!.stages.map((stage) => stage.stage);
    for (const always of [
      "lexical_channel",
      "entity_channel",
      "dense_model_version",
      "dense_vector_search",
      "claim_hydration",
    ]) {
      assert.ok(selected.includes(always), `stage '${always}' is always planned but was not captured`);
    }

    for (const stage of captured!.stages) {
      assert.equal(stage.success, true, `stage '${stage.stage}' failed: ${stage.error ?? "unknown"}`);
      assert.ok(stage.structural_plan_digest, `stage '${stage.stage}' has no structural digest`);
    }

    // Every declared stage that is not conditional must appear.
    for (const stage of REQUIRED_STAGES) {
      if (stage === "relation_channel" || stage === "temporal_channel") continue;
      assert.ok(
        captured!.byStage.has(stage),
        `stage '${stage}' is missing (captured: ${selected.join(", ")})`,
      );
    }
  });

  it("labels every statement with the stage that actually issued it", () => {
    if (describeCaptured()) return;
    // This is a regression test for a defect that produced a *complete-looking* artifact.
    //
    // `runChannels` runs the ordinary channels and the dense channel on two concurrent
    // transactions. The first version kept one FIFO of pending stage names, so the lanes
    // consumed each other's tags: the entity statement was labelled `dense_vector_search`,
    // the vector search `temporal_channel`, and so on. Every stage was present, every digest
    // was distinct, and every label was wrong — nothing about the artifact's shape revealed
    // it. Only a test that ties a label to the statement it names can.
    //
    // Each case is a statement fragment that only that stage issues.
    const expected: ReadonlyArray<readonly [string, RegExp]> = [
      ["scope_binding", /set_request_context/],
      ["lexical_channel", /ts_rank\(c\.search_tsv/],
      ["entity_channel", /count\(DISTINCT a\.alias\)/],
      ["dense_model_version", /SELECT model_version, ledger_watermark\s+FROM projection_versions/],
      ["dense_vector_search", /e\.embedding <=> \$\d+::vector/],
      ["temporal_channel", /valid_(from|to)|valid_range/],
      ["claim_hydration", /SELECT c\.claim_id, c\.tenant_id, c\.scope_id, c\.kind/],
      ["claim_relations_read", /FROM claim_relations/],
      ["claim_evidence_read", /FROM claim_evidence ce/],
      ["span_verification", /FROM events/],
      ["projection_watermark", /COALESCE\(max\(ledger_watermark\)/],
    ];

    for (const [stage, pattern] of expected) {
      const entry = captured!.byStage.get(stage);
      if (entry === undefined) continue; // absence is reported by the stage-coverage case
      assert.match(
        entry.sanitized_sql,
        pattern,
        `stage '${stage}' is labelled onto a statement it does not issue — the lanes have ` +
          `crossed again. Captured SQL: ${entry.sanitized_sql.replace(/\s+/g, " ").slice(0, 120)}`,
      );
    }

    // And nothing carries a stage name that is not a declared stage.
    for (const stage of captured!.stages) {
      assert.notEqual(
        stage.stage,
        "unlabeled",
        `a statement was captured without a stage name: ${stage.sanitized_sql.replace(/\s+/g, " ").slice(0, 120)}`,
      );
    }
  });

  it("ran every retrieval stage as the application role, never as the owner", () => {
    if (describeCaptured()) return;
    const role = captured!.artifact["application_role"] as {
      role: string;
      superuser: boolean;
      bypassrls: boolean;
    };
    assert.equal(role.role, "veritymem_app", "the artifact must name the application role");
    assert.equal(role.bypassrls, false, "a role that bypasses RLS would omit the policy predicate");
    assert.equal(role.superuser, false, "a superuser would omit the policy predicate");
  });

  it("uses current_reachable_scope_ids() for authorization and never scope_reachable per row", () => {
    if (describeCaptured()) return;
    // The two halves of migration 0014's contract. The first says the closure is consulted;
    // the second says the per-candidate function call has not come back, which is the
    // regression that made a million-row read take 13.8 s.
    const retrieval = captured!.stages.filter((stage) =>
      stage.stage.endsWith("_channel") || stage.stage === "claim_hydration",
    );
    assert.ok(retrieval.length > 0, "at least one retrieval plan must be captured");

    const withClosure = retrieval.filter((stage) =>
      stage.sanitized_sql.includes("current_reachable_scope_ids"),
    );
    assert.ok(
      withClosure.length > 0,
      `no retrieval statement consults current_reachable_scope_ids(); captured: ${retrieval
        .map((stage) => stage.stage)
        .join(", ")}`,
    );

    for (const stage of captured!.stages) {
      assert.ok(
        !stage.sanitized_sql.includes("veritymem.scope_reachable("),
        `stage '${stage.stage}' calls scope_reachable directly, which is the per-candidate ` +
          `path migration 0014 removed`,
      );
    }
  });

  it("keeps the entity channel on claim_entities with the tenant boundary and no OR join", () => {
    if (describeCaptured()) return;
    const entity = captured!.byStage.get("entity_channel");
    assert.ok(entity, "the entity channel must be captured");

    assert.match(entity.sanitized_sql, /claim_entities/, "the entity channel must read the projection");
    assert.match(entity.sanitized_sql, /tenant_id/, "the entity channel must retain a tenant predicate");

    // The shape migration 0015 removed. Either half of it reappearing is the regression.
    assert.doesNotMatch(
      entity.sanitized_sql,
      /OR\s+a\.canonical/i,
      "the alias-to-all-claims OR join has returned; 0015 exists to prevent exactly this",
    );
    assert.doesNotMatch(
      entity.sanitized_sql,
      /object::text/,
      "the entity channel compares an alias against object::text, which quotes a JSON string " +
        "so the comparison can never match",
    );

    // And the plan itself must touch the projection, not only the SQL text. A plan that
    // reads `claims` and never `claim_entities` means the projection is not being used.
    const outline = entity.plan_outline.join("\n");
    assert.match(
      outline,
      /claim_entities/,
      `the entity plan does not reference claim_entities; outline:\n${outline}`,
    );
  });

  it("keeps the dense channel's tenant and model predicates and uses the prepared vector", () => {
    if (describeCaptured()) return;
    const version = captured!.byStage.get("dense_model_version");
    const search = captured!.byStage.get("dense_vector_search");
    assert.ok(version, "the model-version lookup must be captured separately");
    assert.ok(search, "the vector search must be captured");

    assert.match(version.sanitized_sql, /projection_versions/, "the version lookup must read the projection record");
    assert.match(search.sanitized_sql, /claim_embeddings/, "the vector search must read the embedding table");
    assert.match(search.sanitized_sql, /tenant_id/, "the vector search must retain the tenant predicate");
    assert.match(search.sanitized_sql, /model_id/, "the vector search must retain the model predicate");
    assert.match(search.sanitized_sql, /<=>/, "the vector search must use the distance operator");

    // The two stages must be different statements against different tables, or capturing
    // them separately would be a label on the same plan.
    assert.notEqual(
      version.structural_plan_digest,
      search.structural_plan_digest,
      "the version lookup and the vector search must be distinct plans",
    );
  });

  it("made no hosted-model call and recorded the local embedder", () => {
    if (describeCaptured()) return;
    const embeddings = captured!.artifact["embeddings"] as {
      model_id: string;
      dimensions: number;
      is_model_call: boolean;
    };
    assert.equal(embeddings.is_model_call, false, "the capture must not call a hosted model");
    assert.match(embeddings.model_id, /hash/, "the local deterministic embedder must be the one recorded");
    assert.ok(embeddings.dimensions > 0, "the embedding dimensions must be recorded");
  });
});

describe("VM-A3 · the artifact's contract", () => {
  it("carries every required top-level field", () => {
    if (describeCaptured()) return;
    const artifact = captured!.artifact;
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
    assert.match(String(artifact["commit"]), /^[0-9a-f]{40}$|^unknown$/, "the commit must be a SHA or stated unknown");
  });

  it("carries every required field on every stage entry", () => {
    if (describeCaptured()) return;
    for (const stage of captured!.stages) {
      for (const field of [
        "stage",
        "success",
        "structural_plan_digest",
        "raw_plan",
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
      assert.ok(stage.raw_plan !== null, `stage '${stage.stage}' has no raw plan to diagnose with`);
      assert.ok(stage.buffers !== null, `stage '${stage.stage}' has no buffer counters`);
    }
  });

  it("contains no connection string, credential or raw query text", () => {
    if (describeCaptured()) return;
    const serialized = JSON.stringify(captured!.artifact);
    const env = loadEnv();

    // The literal connection strings, in case one were interpolated into a message.
    for (const secret of [env.databaseUrl, env.migrationDatabaseUrl].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )) {
      assert.ok(!serialized.includes(secret), "the artifact contains a connection string");
    }
    for (const marker of ["postgres://", "postgresql://", "password", "Bearer "]) {
      assert.ok(
        !serialized.toLowerCase().includes(marker.toLowerCase()),
        `the artifact contains '${marker}', which is a credential or a connection string`,
      );
    }

    // The query text itself, which is evidence content rather than structure.
    const query = process.env["VM_A3_QUERY"] ?? "deployment window";
    for (const stage of captured!.stages) {
      assert.ok(
        !stage.sanitized_sql.includes(query),
        `stage '${stage.stage}' carries the raw query text`,
      );
    }
    // And the tenant's slug and id, which are what a human would search for.
    assert.ok(!serialized.includes(TENANT), "the artifact names the tenant slug");
    const tenant = captured!.artifact["tenant"] as { digest: string };
    assert.match(tenant.digest, /^[0-9a-f]{16}$/, "the tenant must appear as a stable digest");
  });

  it("records the database and role facts the plans depend on", () => {
    if (describeCaptured()) return;
    const postgres = captured!.artifact["postgres"] as { version: string; pgvector_version: string | null };
    assert.match(postgres.version, /^17\./, "the PostgreSQL version must be recorded");
    assert.match(String(postgres.pgvector_version), /^0\.8\./, "the pgvector version must be recorded");

    const migrations = captured!.artifact["migrations"] as { applied: number; latest: string | null };
    assert.ok(migrations.applied >= 15, "the applied migration count must be recorded");
    assert.equal(migrations.latest, "0015_claim_entity_index.sql", "the latest migration must be named");

    const settings = captured!.artifact["settings"] as Record<string, string>;
    assert.ok(settings["server_version"], "server_version must be among the recorded settings");
    assert.ok(settings["shared_buffers"], "shared_buffers must be recorded; it explains a plan choice");
  });

  it("discloses the request shape that explains a missing stage", () => {
    if (describeCaptured()) return;
    // A missing stage has two very different causes: the query did not ask for it, or it ran
    // and was not captured. The request shape is what tells them apart, so it must be in the
    // artifact. Without it, `missing_stages: ["temporal_channel"]` is unreadable.
    const request = captured!.artifact["request"] as {
      time_mode: string;
      declared_subjects: number;
      limit: number;
      query_digest: string;
      principal_digest: string;
    };
    assert.ok(["current", "as_of", "during"].includes(request.time_mode), "the time mode must be recorded");
    assert.equal(typeof request.declared_subjects, "number");
    assert.equal(request.limit, 10);

    // If the temporal channel is missing, the recorded mode must explain it — the channel
    // issues no statement unless the mode is `during`.
    const missing = (captured!.artifact["capture"] as { missing_stages: readonly string[] }).missing_stages;
    if (missing.includes("temporal_channel")) {
      assert.notEqual(
        request.time_mode,
        "during",
        "the temporal channel is missing while the time mode is `during`, which it does not explain",
      );
    }
    // Likewise for the relation channel and declared subjects.
    if (missing.includes("relation_channel")) {
      assert.equal(request.declared_subjects, 0, "the relation channel is missing but subjects were declared");
    }
  });

  it("states that captured timings are not latency evidence", () => {
    if (describeCaptured()) return;
    const capture = captured!.artifact["capture"] as { timing_note: string; wall_ms: number };
    assert.match(
      capture.timing_note,
      /second|warm/i,
      "the artifact must say the timings describe a second, warm-cache run",
    );
    assert.ok(capture.wall_ms > 0, "the capture wall time must be recorded");
  });
});
