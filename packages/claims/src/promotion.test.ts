/**
 * The promotion invariant.
 *
 * "No model call has direct write access to `claims.status = 'accepted'`" is the
 * specification's critical invariant. Until migration 0010 it was an interface
 * property — the gate was the only code that promoted a claim — but a single SQL
 * statement could do it. These tests assert the database refuses, because an
 * invariant that one statement can void is a convention rather than an invariant.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DEFAULT_COMMIT_POLICY, REASON_CODES } from "@veritymem/contracts";
import { CommitGate, LexicalEntailmentBackend } from "@veritymem/gate";
import { DETERMINISTIC_EXTRACTORS, IngestPipeline } from "@veritymem/model-adapters";
import { resolveTenantId } from "@veritymem/ledger";
import { createTestContext, type TestContext } from "@veritymem/testkit";
import { applyStatus, readClaim } from "./index.ts";

interface Harness {
  readonly ctx: TestContext;
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
    tenantId: resolveTenantId(ctx.tenantSlug),
    tenantSlug: ctx.tenantSlug,
    close: () => ctx.close(),
  };
}

async function acceptedClaim(h: Harness, content: string): Promise<string> {
  const receipt = await h.ctx.ledger.append({
    stream_id: "thread:1",
    origin: "user",
    actor_id: "user:alice",
    scope: { tenant: h.tenantSlug, project: "payments", user: "alice", purpose: ["release_planning"] },
    occurred_at: "2026-09-10T09:14:00Z",
    content,
  });
  let claimId: string | null = null;
  await h.ctx.db.withRequest(
    {
      tenant: h.tenantId,
      principal: "user:alice",
      scopeIds: [receipt.scope.scope_id],
      purposes: ["release_planning"],
      action: "worker:process",
    },
    async (executor) => {
      const event = await h.ctx.ledger.readEvent(executor, receipt.event_id);
      assert.ok(event);
      const result = await h.pipeline.ingest(executor, event);
      claimId = result.decisions.find((decision) => decision.claim_id)?.claim_id ?? null;
    },
  );
  assert.ok(claimId, "the fixture must produce an accepted claim");
  return claimId;
}

function uuidOf(prefixed: string): string {
  const body = prefixed.slice(prefixed.indexOf("_") + 1);
  return [body.slice(0, 8), body.slice(8, 12), body.slice(12, 16), body.slice(16, 20), body.slice(20, 32)].join("-");
}

describe("claim promotion invariant", () => {
  let h: Harness;
  let claimId: string;

  before(async () => {
    h = await harness("promotion");
    claimId = await acceptedClaim(h, "I approved the Sunday 02:00 UTC deploy window.");
  });
  after(async () => {
    await h.close();
  });

  it("refuses an authority upgrade by direct UPDATE", async () => {
    await assert.rejects(
      () =>
        h.ctx.db.withSystemContext({ tenant: h.tenantId, actor: "attacker" }, (executor) =>
          executor.query(`UPDATE claims SET authority = 'verified_record' WHERE claim_id = $1::uuid`, [
            uuidOf(claimId),
          ]),
        ),
      /immutable/,
      "an authority upgrade is the most valuable thing write access could buy, and must be refused",
    );
  });

  it("refuses rewriting the proposition in place", async () => {
    await assert.rejects(
      () =>
        h.ctx.db.withSystemContext({ tenant: h.tenantId, actor: "attacker" }, (executor) =>
          executor.query(`UPDATE claims SET object = '{"rewritten": true}'::jsonb WHERE claim_id = $1::uuid`, [
            uuidOf(claimId),
          ]),
        ),
      /immutable/,
      "a rewritten object would leave the evidence spans pointing at text that no longer supports the claim",
    );
  });

  it("refuses moving a claim into a scope it was not admitted for", async () => {
    await assert.rejects(
      () =>
        h.ctx.db.withSystemContext({ tenant: h.tenantId, actor: "attacker" }, (executor) =>
          executor.query(`UPDATE claims SET scope_id = gen_random_uuid() WHERE claim_id = $1::uuid`, [
            uuidOf(claimId),
          ]),
        ),
      /immutable/,
    );
  });

  it("refuses a status change with no decision behind it", async () => {
    await assert.rejects(
      () =>
        h.ctx.db.withSystemContext({ tenant: h.tenantId, actor: "attacker" }, (executor) =>
          executor.query(`UPDATE claims SET status = 'disputed' WHERE claim_id = $1::uuid`, [uuidOf(claimId)]),
        ),
      /requires a decision row/,
      "an unrecorded promotion is exactly what the invariant forbids",
    );
  });

  it("allows the legitimate path, which records its decision", async () => {
    await h.ctx.db.withSystemContext({ tenant: h.tenantId, actor: "operator:test" }, async (executor) => {
      await applyStatus(
        executor,
        { claimId, status: "disputed", reasonCodes: [REASON_CODES.CONFLICT_CONTRADICTS_ACCEPTED] },
        {
          decisionId: h.ctx.ids.next("dec"),
          policyVersion: "review-v1",
          approver: "operator:test",
        },
      );
    });
    const claim = await h.ctx.db.withSystemContext({ tenant: h.tenantId, actor: "test" }, (executor) =>
      readClaim(executor, claimId),
    );
    assert.equal(claim?.status, "disputed");

    // And the decision is readable, so the transition is explainable.
    const decisions = await h.ctx.db.withSystemContext({ tenant: h.tenantId, actor: "test" }, (executor) =>
      executor.query<{ outcome: string; reason_codes: string[]; approver: string | null }>(
        "SELECT outcome, reason_codes, approver FROM decisions WHERE claim_id = $1::uuid ORDER BY decided_at DESC",
        [uuidOf(claimId)],
      ),
    );
    assert.ok(decisions.rows.length >= 1);
    assert.equal(decisions.rows[0]?.approver, "operator:test");
  });

  it("refuses reopening a closed validity interval", async () => {
    await h.ctx.db.withSystemContext({ tenant: h.tenantId, actor: "operator:test" }, async (executor) => {
      await applyStatus(
        executor,
        { claimId, status: "superseded", reasonCodes: [REASON_CODES.CONFLICT_SUPERSEDES_ACCEPTED] },
        { decisionId: h.ctx.ids.next("dec"), policyVersion: "review-v1", approver: "operator:test" },
      );
    });
    await assert.rejects(
      () =>
        h.ctx.db.withSystemContext({ tenant: h.tenantId, actor: "attacker" }, (executor) =>
          executor.query(`UPDATE claims SET valid_to = NULL WHERE claim_id = $1::uuid`, [uuidOf(claimId)]),
        ),
      /cannot be reopened/,
      "a claim that ended did not stop having ended",
    );
  });
});
