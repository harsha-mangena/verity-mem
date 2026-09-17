/**
 * A misconfigured embedding model must look like a misconfiguration.
 *
 * The dense channel filters on `claim_embeddings.model_id`, so a reader whose backend
 * reports a different id than the writer's matches zero rows. From the database's point of
 * view nothing is wrong — it is being asked for rows that do not exist — so there is no
 * error, and the caller sees an empty dense channel. That is indistinguishable from an
 * authorization denial or from a corpus with nothing relevant in it, and it is one
 * constructor argument away: `HashEmbeddingBackend` appends its dimension count to the
 * default id.
 *
 * The channel therefore checks the model that wrote the projection before it queries, and
 * reports a mismatch as a skipped channel carrying the two ids and what to do about it.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { resolveTenantId } from "@veritymem/ledger";
import { createTestContext, type TestContext } from "@veritymem/testkit";
import { HashEmbeddingBackend, denseChannel, projectClaim } from "./index.ts";

interface Harness {
  readonly ctx: TestContext;
  readonly tenantId: string;
  /** Set by the first test once the scope exists; the second reuses it. */
  scopeId: string;
  close(): Promise<void>;
}

async function harness(label: string): Promise<Harness> {
  const ctx = await createTestContext(label);
  return { ctx, tenantId: resolveTenantId(ctx.tenantSlug), scopeId: "", close: () => ctx.close() };
}

describe("embedding model mismatch", () => {
  let h: Harness;

  before(async () => {
    h = await harness("model-mismatch");
  });
  after(async () => {
    await h.close();
  });

  it("does not run the dense channel, and says why, when the projection was written by another model", async () => {
    const writer = new HashEmbeddingBackend({ dimensions: 1024, modelId: "hash-ngram-v1-1024" });
    const reader = new HashEmbeddingBackend({ dimensions: 1024, modelId: "hash-ngram-v2-1024" });

    // Write a claim and project it with the writer's model, so `projection_versions`
    // records `hash-ngram-v1-1024` and the row carries that model_id.
    const receipt = await h.ctx.ledger.append({
      stream_id: "s1",
      origin: "user",
      actor_id: "user:alice",
      scope: { tenant: h.ctx.tenantSlug, project: "payments", user: "alice", purpose: ["release_planning"] },
      occurred_at: "2026-09-10T09:14:00Z",
      content: "I approved the Sunday 02:00 UTC deploy window.",
    });
    h.scopeId = receipt.scope.scope_id;

    await h.ctx.db.withRequest(
      {
        tenant: h.tenantId,
        principal: "user:alice",
        scopeIds: [receipt.scope.scope_id],
        purposes: ["release_planning"],
        action: "test:project",
      },
      async (executor) => {
        await executor.query(
          `INSERT INTO claims (claim_id, tenant_id, scope_id, kind, subject, predicate, object, status, authority, valid_from, origin_event_id)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'decision', 'user:alice', 'decision.approved',
                   '{"window":"Sunday 02:00 UTC"}'::jsonb, 'accepted', 'user_self_report', now(), $3::uuid)`,
          [h.tenantId, receipt.scope.scope_id, receipt.event_id.replace(/^evt_/, "").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5")],
        );
        const claim = await executor.query<{ claim_id: string }>(
          `SELECT claim_id FROM claims WHERE tenant_id = $1::uuid ORDER BY recorded_at DESC LIMIT 1`,
          [h.tenantId],
        );
        const claimId = claim.rows[0]?.claim_id;
        assert.ok(claimId);
        const projected = await projectClaim(executor, { db: h.ctx.db, embeddings: writer }, claimId);
        assert.equal(projected.projected, true, `projection failed: ${projected.reason}`);
      },
    );

    // The reader is configured with a different model. It must not silently return nothing.
    const result = await h.ctx.db.withRequest(
      {
        tenant: h.tenantId,
        principal: "user:alice",
        scopeIds: [receipt.scope.scope_id],
        purposes: ["release_planning"],
        action: "query:read",
      },
      (executor) =>
        denseChannel(executor, {
          tenant_id: h.tenantId,
          text: "deploy window approved",
          authorized_scopes: [
            { scope_id: receipt.scope.scope_id, project: "payments", user_id: "alice", agent_id: null, session_id: null },
          ],
          purposes: ["release_planning"],
          time: { mode: "current" },
          kinds: null,
          subjects: null,
          entity_terms: [],
          limit: 10,
          now: new Date().toISOString(),
        }, reader),
    );

    assert.equal(result.ran, false, "the channel must not run against a projection it cannot match");
    assert.deepEqual(result.hits, []);
    assert.ok(result.note, "a skipped channel must carry a reason");
    assert.match(result.note, /hash-ngram-v1-1024/, "the note must name the model that wrote the projection");
    assert.match(result.note, /hash-ngram-v2-1024/, "and the model the reader is configured with");
    assert.match(result.note, /replay/i, "and what to do about it");
  });

  it("runs normally when the reader matches the writer", async () => {
    const same = new HashEmbeddingBackend({ dimensions: 1024, modelId: "hash-ngram-v1-1024" });
    const result = await h.ctx.db.withRequest(
      {
        tenant: h.tenantId,
        principal: "user:alice",
        scopeIds: [h.scopeId],
        purposes: ["release_planning"],
        action: "query:read",
      },
      (executor) =>
        denseChannel(executor, {
          tenant_id: h.tenantId,
          text: "deploy window approved",
          authorized_scopes: [
            { scope_id: h.scopeId, project: "payments", user_id: "alice", agent_id: null, session_id: null },
          ],
          purposes: ["release_planning"],
          time: { mode: "current" },
          kinds: null,
          subjects: null,
          entity_terms: [],
          limit: 10,
          now: new Date().toISOString(),
        }, same),
    );
    assert.equal(result.ran, true);
    assert.ok(result.hits.length > 0, "a matching reader must find the projected claim");
    assert.equal(result.note, null);
  });
});

describe("action-gate refusals are distinguishable", () => {
  let h: Harness;

  before(async () => {
    h = await harness("action-refusals");
  });
  after(async () => {
    await h.close();
  });

  it("names a missing participation differently from an unknown claim", async () => {
    // The assessment's requirement: distinct operator-facing reason codes for unknown claim,
    // scope denial and missing participation. A single "denied" code leaves an operator
    // unable to tell a typo from an onboarding problem, and their remedies differ.
    const { evaluateAction } = await import("./action-gate.ts");
    const receipt = await h.ctx.ledger.append({
      stream_id: "s1",
      origin: "user",
      actor_id: "user:alice",
      scope: { tenant: h.ctx.tenantSlug, project: "payments", user: "alice", purpose: ["release_planning"] },
      occurred_at: "2026-09-10T09:14:00Z",
      content: "I approved the Sunday 02:00 UTC deploy window.",
    });

    // A claim that exists, recorded by alice, in a scope bob has no membership in.
    let existingClaimId = "";
    await h.ctx.db.withSystemContext({ tenant: h.tenantId, actor: "test" }, async (executor) => {
      const inserted = await executor.query<{ claim_id: string }>(
        `INSERT INTO claims (claim_id, tenant_id, scope_id, kind, subject, predicate, object, status, authority, valid_from, origin_event_id)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'decision', 'user:alice', 'decision.approved',
                 '{"window":"Sunday 02:00 UTC"}'::jsonb, 'accepted', 'user_self_report', now(), $3::uuid)
         RETURNING claim_id`,
        [h.tenantId, receipt.scope.scope_id, receipt.event_id.replace(/^evt_/, "").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5")],
      );
      existingClaimId = `clm_${inserted.rows[0]!.claim_id.replace(/-/g, "")}`;
    });

    const deps = {
      db: h.ctx.db,
      ledger: h.ctx.ledger,
      embeddings: new HashEmbeddingBackend({ dimensions: 1024 }),
      clock: h.ctx.clock,
    };

    // Bob holds no scope that reaches alice's claim.
    const missing = await evaluateAction(
      deps,
      {
        action: "deploy.production",
        action_risk: "medium",
        scope: { tenant: h.ctx.tenantSlug, project: "payments", user: "bob" },
        purpose: "release_planning",
        claim_ids: [existingClaimId],
      },
      { principal: "user:bob" },
    );
    assert.equal(missing.allowed, false);
    assert.ok(
      missing.reason_codes.includes("action.denied_missing_participation"),
      `expected a participation refusal, saw ${missing.reason_codes.join(", ")}`,
    );

    // A claim id that was never real.
    const unknown = await evaluateAction(
      deps,
      {
        action: "deploy.production",
        action_risk: "medium",
        scope: { tenant: h.ctx.tenantSlug, project: "payments" },
        purpose: "release_planning",
        claim_ids: [`clm_${"0".repeat(32)}`],
      },
      { principal: "user:alice" },
    );
    assert.equal(unknown.allowed, false);
    assert.ok(
      unknown.reason_codes.includes("action.denied_unknown_claim"),
      `expected an unknown-claim refusal, saw ${unknown.reason_codes.join(", ")}`,
    );
    assert.ok(
      !unknown.reason_codes.includes("action.denied_missing_participation"),
      "the two refusals must not be reported together, or they are one code",
    );
  });
});

describe("operational health checks", () => {
  it("reports a failing projection when the reader's model differs from the writer's", async () => {
    const h = await harness("health-projection");
    try {
      const writer = new HashEmbeddingBackend({ dimensions: 1024, modelId: "hash-ngram-v1-1024" });
      const receipt = await h.ctx.ledger.append({
        stream_id: "s1",
        origin: "user",
        actor_id: "user:alice",
        scope: { tenant: h.ctx.tenantSlug, project: "payments", user: "alice", purpose: ["release_planning"] },
        occurred_at: "2026-09-10T09:14:00Z",
        content: "I approved the Sunday 02:00 UTC deploy window.",
      });
      await h.ctx.db.withSystemContext({ tenant: h.tenantId, actor: "test" }, async (executor) => {
        const inserted = await executor.query<{ claim_id: string }>(
          `INSERT INTO claims (claim_id, tenant_id, scope_id, kind, subject, predicate, object, status, authority, valid_from)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'decision', 'user:alice', 'decision.approved',
                   '{"window":"Sunday 02:00 UTC"}'::jsonb, 'accepted', 'user_self_report', now())
           RETURNING claim_id`,
          [h.tenantId, receipt.scope.scope_id],
        );
        await projectClaim(executor, { db: h.ctx.db, embeddings: writer }, `clm_${inserted.rows[0]!.claim_id.replace(/-/g, "")}`);
      });

      const { healthCheck } = await import("./health.ts");
      const report = await healthCheck(
        { db: h.ctx.db, embeddings: new HashEmbeddingBackend({ dimensions: 1024, modelId: "hash-ngram-v9-1024" }) },
        { tenantId: h.tenantId },
      );
      assert.equal(report.status, "failing");
      const finding = report.findings.find((f) => f.id === "projection.dense.model_mismatch");
      assert.ok(finding, `expected a model-mismatch finding, saw ${report.findings.map((f) => f.id).join(", ")}`);
      assert.match(finding.detail, /hash-ngram-v1-1024/);
      assert.ok(finding.remedy, "a non-ok finding must tell an operator what to do");
    } finally {
      await h.close();
    }
  });

  it("reports ok when the reader matches, and explains the onboarding state for a new principal", async () => {
    const h = await harness("health-ok");
    try {
      const { healthCheck } = await import("./health.ts");
      const report = await healthCheck(
        { db: h.ctx.db, embeddings: new HashEmbeddingBackend({ dimensions: 1024 }) },
        { tenantId: h.tenantId, principal: "user:newcomer" },
      );
      // No projection yet, and a principal with no membership: both are expected on a fresh
      // deployment, and both must be reported rather than passing silently.
      const ids = report.findings.map((f) => f.id);
      assert.ok(ids.includes("projection.dense.absent"), `expected an absent-projection finding, saw ${ids.join(", ")}`);
      assert.ok(ids.includes("authority.no_reach"), `expected a no-reach finding, saw ${ids.join(", ")}`);
      const authority = report.findings.find((f) => f.id === "authority.no_reach");
      assert.match(String(authority?.remedy), /v1\/grants/);
      assert.equal(report.status, "degraded");
    } finally {
      await h.close();
    }
  });
});
