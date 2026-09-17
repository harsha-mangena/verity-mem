/**
 * The replay oracle's tests.
 *
 * Two properties are asserted, and the second matters as much as the first:
 *
 *   1. For a fixed ledger, code version and embedding model, a rebuild produces
 *      byte-identical projections. This is the specification's exit target.
 *   2. The oracle refuses to call anything deterministic that it did not actually
 *      compare. A function that reports `deterministic: true` after comparing
 *      nothing is worse than no oracle, because it produces a green tick nobody can
 *      audit.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DEFAULT_COMMIT_POLICY } from "@veritymem/contracts";
import { CommitGate, LexicalEntailmentBackend } from "@veritymem/gate";
import { DETERMINISTIC_EXTRACTORS, IngestPipeline } from "@veritymem/model-adapters";
import { resolveTenantId } from "@veritymem/ledger";
import { createTestContext, type TestContext } from "@veritymem/testkit";
import { HashEmbeddingBackend, projectClaim, replay, type ReplayDependencies } from "./index.ts";

interface Harness {
  readonly ctx: TestContext;
  readonly deps: ReplayDependencies;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly pipeline: IngestPipeline;
  close(): Promise<void>;
}

async function harness(label: string): Promise<Harness> {
  const ctx = await createTestContext(label);
  const gate = new CommitGate({
    db: ctx.db,
    ledger: ctx.ledger,
    ids: ctx.ids,
    clock: ctx.clock,
    entailment: new LexicalEntailmentBackend({ floor: DEFAULT_COMMIT_POLICY.thresholds.lexicalEntailmentFloor }),
    policy: DEFAULT_COMMIT_POLICY,
  });
  return {
    ctx,
    pipeline: new IngestPipeline({
      db: ctx.db,
      ledger: ctx.ledger,
      gate,
      ids: ctx.ids,
      clock: ctx.clock,
      deterministicExtractors: DETERMINISTIC_EXTRACTORS,
      modelExtractor: null,
    }),
    deps: {
      db: ctx.db,
      embeddings: new HashEmbeddingBackend({ dimensions: 1024 }),
      clock: ctx.clock,
      gateBackend: "lexical-overlap@1",
    } as ReplayDependencies,
    tenantId: resolveTenantId(ctx.tenantSlug),
    tenantSlug: ctx.tenantSlug,
    close: () => ctx.close(),
  };
}

async function writeAndProject(h: Harness, content: string, user: string, stream: string): Promise<void> {
  const receipt = await h.ctx.ledger.append({
    stream_id: stream,
    origin: "user",
    actor_id: `user:${user}`,
    scope: { tenant: h.tenantSlug, project: "payments", user, purpose: ["release_planning"] },
    occurred_at: "2026-09-10T09:14:00Z",
    content,
  });
  await h.ctx.db.withRequest(
    {
      tenant: h.tenantId,
      principal: `user:${user}`,
      scopeIds: [receipt.scope.scope_id],
      purposes: ["release_planning"],
      action: "worker:process",
    },
    async (executor) => {
      const event = await h.ctx.ledger.readEvent(executor, receipt.event_id);
      assert.ok(event);
      const result = await h.pipeline.ingest(executor, event);
      for (const decision of result.decisions) {
        if (decision.claim_id) {
          await projectClaim(executor, { db: h.ctx.db, embeddings: h.deps.embeddings }, decision.claim_id);
        }
      }
    },
  );
}

describe("replay oracle", () => {
  let h: Harness;

  before(async () => {
    h = await harness("replay");
    await writeAndProject(h, "I approved the Sunday 02:00 UTC deploy window.", "alice", "s1");
    await writeAndProject(h, "My editor keymap is vim.", "alice", "s2");
    await writeAndProject(h, "I approved the Tuesday 06:00 UTC maintenance window.", "bob", "s3");
  });
  after(async () => {
    await h.close();
  });

  it("reports byte-identical projections for a fixed ledger and model", async () => {
    const result = await replay(h.deps, { mode: "verify" }, { tenantId: h.tenantId, actor: "system:replay" });
    assert.equal(result.deterministic, true, `digests moved: ${JSON.stringify(result.projections, null, 2)}`);
    for (const projection of result.projections) {
      assert.equal(projection.byte_identical, true, `${projection.projection} changed across a rebuild`);
      assert.ok(projection.after.rows >= 1, `${projection.projection} projected nothing`);
    }
  });

  it("covers all three projections rather than silently skipping one", async () => {
    const result = await replay(h.deps, { mode: "verify" }, { tenantId: h.tenantId, actor: "system:replay" });
    assert.deepEqual(
      result.projections.map((projection) => projection.projection).sort(),
      ["dense", "entities", "lexical"],
    );
  });

  it("reports the same code and policy versions it was configured with", async () => {
    const deps: ReplayDependencies = { ...h.deps, codeVersion: "projections@test", policyVersion: "commit-vtest" };
    const result = await replay(deps, { mode: "verify" }, { tenantId: h.tenantId, actor: "system:replay" });
    assert.equal(result.code_version, "projections@test");
    assert.equal(result.policy_version, "commit-vtest");
    assert.ok(result.duration_ms >= 0);
  });

  it("is not deterministic when the embedder changes, which is what makes a rebuild a migration", async () => {
    // A different model id is a different projection. The digests must move, and the
    // oracle must say so — this is the mechanism by which "a model upgrade is a
    // rebuild, not a migration" is observable rather than asserted.
    // Same dimensionality, different model id. The width cannot change — the column
    // is `vector(1024)` and a differently-shaped projection is a schema migration,
    // not a rebuild — so the identity of the model is carried by `model_id` and by
    // the recorded `projection_versions` row rather than by the vector length.
    const different: ReplayDependencies = {
      ...h.deps,
      embeddings: new HashEmbeddingBackend({ dimensions: 1024, modelId: "hash-ngram-v2-1024" }),
    };
    const result = await replay(different, { mode: "verify" }, { tenantId: h.tenantId, actor: "system:replay" });
    const dense = result.projections.find((projection) => projection.projection === "dense");
    assert.ok(dense);
    assert.equal(dense.byte_identical, false, "a different embedding model must produce a different projection digest");
    assert.equal(result.deterministic, false);
  });

  it("refuses to call an uncompared run deterministic", async () => {
    const empty = await harness("replay-empty");
    try {
      // No claims, therefore no dense projection rows and no prior digests to
      // compare. Reporting `deterministic: true` here would be a green tick with
      // nothing behind it.
      const result = await replay(empty.deps, { mode: "verify" }, { tenantId: empty.tenantId, actor: "system:replay" });
      assert.equal(result.deterministic, false, "nothing was compared, so nothing was shown to be deterministic");
    } finally {
      await empty.close();
    }
  });

  it("rebuild mode performs the rebuild without asserting stability", async () => {
    const result = await replay(h.deps, { mode: "rebuild" }, { tenantId: h.tenantId, actor: "system:replay" });
    assert.ok(result.projections.every((projection) => projection.after.rows >= 1));
  });

  it("reports the ledger watermark it replayed to", async () => {
    const result = await replay(h.deps, { mode: "verify" }, { tenantId: h.tenantId, actor: "system:replay" });
    assert.ok(result.ledger_watermark >= 1, "the watermark must reflect the events that were replayed");
  });
});
