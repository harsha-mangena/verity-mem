/**
 * Cross-user isolation, through the public read path.
 *
 * This file exists because isolation did not hold and the existing tests did not
 * notice. Both of those facts are informative:
 *
 *   * The `scope_contains` rule in migration 0007 is deliberately directional — a
 *     caller unbound on a dimension reaches any binding of it — so a project-scoped
 *     caller reaches every user scope inside that project. That is intended, and a
 *     project-wide operator depends on it.
 *   * But `resolveScopes` treated a scope that binds *no* user as satisfying a selector
 *     that named one. So a principal whose only membership was project-wide resolved to
 *     the project scope, the directional rule then reached every user in it, and
 *     `user:bob` received `user:alice`'s claims. Naming yourself did not narrow
 *     anything, because the project scope binds no user and therefore matched.
 *
 * The tests that existed asserted a *project-scoped* caller reaches the project's
 * users — which is true and intended — and never asserted the converse, that a caller
 * asking as a specific user does not receive a different user's claims. A suite can
 * only find the direction it looks in.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DEFAULT_COMMIT_POLICY } from "@veritymem/contracts";
import { CommitGate, LexicalEntailmentBackend } from "@veritymem/gate";
import { DETERMINISTIC_EXTRACTORS, IngestPipeline } from "@veritymem/model-adapters";
import { resolveTenantId } from "@veritymem/ledger";
import { createTestContext, type TestContext } from "@veritymem/testkit";
import { HashEmbeddingBackend, compose, projectClaim, type RetrievalDependencies } from "./index.ts";

interface Harness {
  readonly ctx: TestContext;
  readonly deps: RetrievalDependencies;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly pipeline: IngestPipeline;
  readonly embeddings: HashEmbeddingBackend;
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
  const embeddings = new HashEmbeddingBackend({ dimensions: 1024 });
  return {
    ctx,
    embeddings,
    pipeline: new IngestPipeline({
      db: ctx.db,
      ledger: ctx.ledger,
      gate,
      ids: ctx.ids,
      clock: ctx.clock,
      deterministicExtractors: DETERMINISTIC_EXTRACTORS,
      modelExtractor: null,
    }),
    deps: { db: ctx.db, ledger: ctx.ledger, embeddings, ids: ctx.ids, clock: ctx.clock, gateBackend: "lexical-overlap@1" },
    tenantId: resolveTenantId(ctx.tenantSlug),
    tenantSlug: ctx.tenantSlug,
    close: () => ctx.close(),
  };
}

/**
 * Write an event and return its accepted claim id.
 *
 * `user` may be omitted, which is how a project-wide principal writes: a CI service
 * whose events bind the project and no user. That membership shape is the one that
 * produced the leak, so it has to be constructible here.
 */
async function write(
  h: Harness,
  content: string,
  scope: { user?: string; project?: string },
): Promise<string> {
  const receipt = await h.ctx.ledger.append({
    stream_id: "s",
    origin: "user",
    actor_id: scope.user ? `user:${scope.user}` : "service:ci",
    scope: {
      tenant: h.tenantSlug,
      project: scope.project ?? "payments",
      ...(scope.user ? { user: scope.user } : {}),
      purpose: ["release_planning"],
    },
    occurred_at: "2026-09-10T09:14:00Z",
    content,
  });
  let claimId: string | null = null;
  await h.ctx.db.withRequest(
    {
      tenant: h.tenantId,
      principal: scope.user ? `user:${scope.user}` : "service:ci",
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
          claimId = decision.claim_id;
          await projectClaim(executor, { db: h.ctx.db, embeddings: h.embeddings }, decision.claim_id);
        }
      }
    },
  );
  assert.ok(claimId, `expected an accepted claim for ${JSON.stringify(content)}`);
  return claimId;
}

async function queryAs(h: Harness, principal: string, scope: Record<string, string>, text: string) {
  return compose(
    h.deps,
    {
      tenant_id: h.tenantId,
      query: text,
      // The selector is exactly what the caller declares.
      scope: { tenant: h.tenantSlug, ...scope },
      purpose: "release_planning",
    },
    { principal },
  );
}

describe("cross-user isolation", () => {
  let h: Harness;
  let aliceClaimId: string;

  before(async () => {
    h = await harness("isolation");
    aliceClaimId = await write(h, "I approved the Sunday 02:00 UTC deploy window.", { user: "alice" });
    // A project-wide principal: an event that binds the project and no user. This is
    // the membership that used to reach every user in the project.
    //
    // The content is first-person on purpose — the deterministic extractor requires a
    // self-report shape, and a project-wide event that yields no claim would make the
    // membership untestable rather than absent.
    await write(h, "The deadline is 2026-11-01T17:00Z.", {});
  });
  after(async () => {
    await h.close();
  });

  it("does not hand one user's claims to another user who names only the project", async () => {
    const result = await queryAs(h, "user:bob", { project: "payments" }, "deploy window approved");
    const leaked = result.packet.claims.filter((claim) => claim.scope.user === "alice");
    assert.deepEqual(
      leaked.map((claim) => claim.claim_id),
      [],
      "a user must not receive another user's claims by asking at project scope",
    );
  });

  it("does not hand one user's claims to another user who names themselves", async () => {
    // The regression that made the leak worse: naming yourself must narrow, not widen.
    const result = await queryAs(h, "user:bob", { project: "payments", user: "bob" }, "deploy window approved");
    const leaked = result.packet.claims.filter((claim) => claim.scope.user === "alice");
    assert.deepEqual(leaked.map((claim) => claim.claim_id), []);
  });

  it("still lets a caller reach their own claims", async () => {
    const result = await queryAs(h, "user:alice", { project: "payments", user: "alice" }, "deploy window approved");
    assert.ok(
      result.packet.claims.some((claim) => claim.claim_id === aliceClaimId),
      `alice must still reach her own claim; got ${result.packet.claims.length} claims`,
    );
  });

  it("still lets a project-wide principal reach the project's users", async () => {
    // The intended behaviour, asserted so the fix above cannot be "make everyone see
    // nothing". A project-wide operator legitimately reaches the users in its project.
    const result = await queryAs(h, "service:ci", { project: "payments" }, "deploy window approved");
    assert.ok(
      result.packet.claims.some((claim) => claim.claim_id === aliceClaimId),
      "a project-scoped principal must still reach the users in its project",
    );
  });

  it("reaches nothing when the named user is not one the caller holds", async () => {
    const result = await queryAs(h, "user:mallory", { project: "payments", user: "mallory" }, "deploy window");
    assert.deepEqual(
      result.packet.claims,
      [],
      "a principal with no membership must not be answered with someone else's memory",
    );
    assert.ok(result.packet.missing.length > 0, "an empty packet must say why rather than look like absent data");
  });

  it("does not let a project-scoped principal act on another user's claim", async () => {
    const { evaluateAction } = await import("./action-gate.ts");
    const verdict = await evaluateAction(
      h.deps,
      {
        action: "deploy.production",
        action_risk: "medium",
        scope: { tenant: h.tenantSlug, project: "payments" },
        purpose: "release_planning",
        claim_ids: [aliceClaimId],
      },
      { principal: "user:bob" },
    );
    assert.equal(verdict.allowed, false, "the action gate must not inherit the read-path leak");
  });
});
