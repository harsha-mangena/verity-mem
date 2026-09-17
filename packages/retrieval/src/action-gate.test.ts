/**
 * The action gate.
 *
 * The specification's own words: if the action gate is not wired, the use decision
 * is decoration. So these tests are about the gate refusing, not about it allowing.
 * A gate that only ever allows is indistinguishable from no gate, and every one of
 * these cases is a way a plausible-looking packet could authorise a consequential
 * side effect on memory that does not support it.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DEFAULT_COMMIT_POLICY, REASON_CODES } from "@veritymem/contracts";
import { CommitGate, LexicalEntailmentBackend } from "@veritymem/gate";
import { DETERMINISTIC_EXTRACTORS, IngestPipeline } from "@veritymem/model-adapters";
import { applyStatus } from "@veritymem/claims";
import { createTestContext, type TestContext } from "@veritymem/testkit";
import { resolveTenantId } from "@veritymem/ledger";
import {
  HashEmbeddingBackend,
  compose,
  evaluateAction,
  projectClaim,
  type RetrievalDependencies,
} from "./index.ts";

interface Harness {
  readonly ctx: TestContext;
  readonly deps: RetrievalDependencies;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly pipeline: IngestPipeline;
  readonly purposes: readonly string[];
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
  const pipeline = new IngestPipeline({
    db: ctx.db,
    ledger: ctx.ledger,
    gate,
    ids: ctx.ids,
    clock: ctx.clock,
    deterministicExtractors: DETERMINISTIC_EXTRACTORS,
    modelExtractor: null,
  });
  const embeddings = new HashEmbeddingBackend({ dimensions: 1024 });
  return {
    ctx,
    pipeline,
    tenantId: resolveTenantId(ctx.tenantSlug),
    tenantSlug: ctx.tenantSlug,
    purposes: ["release_planning"],
    deps: {
      db: ctx.db,
      ledger: ctx.ledger,
      embeddings,
      ids: ctx.ids,
      clock: ctx.clock,
      gateBackend: "lexical-overlap@1",
    },
    close: () => ctx.close(),
  };
}

async function writeClaim(
  h: Harness,
  content: string,
  user = "alice",
  origin: "user" | "tool" = "user",
): Promise<string> {
  const receipt = await h.ctx.ledger.append({
    stream_id: "thread:1",
    origin,
    actor_id: origin === "tool" ? "tool:ci" : `user:${user}`,
    scope: { tenant: h.tenantSlug, project: "payments", user, purpose: [...h.purposes] },
    occurred_at: "2026-09-10T09:14:00Z",
    content,
  });
  let claimId: string | null = null;
  await h.ctx.db.withRequest(
    {
      tenant: h.tenantId,
      principal: `user:${user}`,
      scopeIds: [receipt.scope.scope_id],
      purposes: [...h.purposes],
      action: "worker:process",
    },
    async (executor) => {
      const event = await h.ctx.ledger.readEvent(executor, receipt.event_id);
      assert.ok(event);
      const result = await h.pipeline.ingest(executor, event);
      for (const decision of result.decisions) {
        if (decision.claim_id) {
          claimId = decision.claim_id;
          await projectClaim(executor, { db: h.ctx.db, embeddings: h.deps.embeddings }, decision.claim_id);
        }
      }
    },
  );
  assert.ok(claimId, `expected an accepted claim for ${JSON.stringify(content)}`);
  return claimId;
}

function uuidOf(prefixed: string): string {
  const body = prefixed.slice(prefixed.indexOf("_") + 1);
  return [body.slice(0, 8), body.slice(8, 12), body.slice(12, 16), body.slice(16, 20), body.slice(20, 32)].join("-");
}

describe("action gate", () => {
  let h: Harness;
  let claimId: string;

  before(async () => {
    h = await harness("actiongate");
    claimId = await writeClaim(h, "I approved the Sunday 02:00 UTC deploy window.");
  });
  after(async () => {
    await h.close();
  });

  it("allows a medium-risk action on a fresh user self-report", async () => {
    const verdict = await evaluateAction(
      h.deps,
      {
        action: "update.release.notes",
        action_risk: "medium",
        scope: { tenant: h.tenantSlug, project: "payments" },
        purpose: "release_planning",
        claim_ids: [claimId],
      },
      { principal: "user:alice" },
    );
    assert.equal(verdict.allowed, true, `blocked with: ${verdict.reason_codes.join(", ")}`);
    assert.equal(verdict.decision, "use");
    assert.ok(verdict.reason_codes.includes(REASON_CODES.ACTION_ALLOWED));
  });

  it("refuses a high-risk action on a user self-report, and says which claim blocked it", async () => {
    // Authority and relevance are separate, and consequence is a third axis. A
    // person saying they approved something is enough to update a release note and
    // not enough to trigger a production deploy: the write path records the
    // strongest available authority, and `user_self_report` is not `verified_record`.
    const verdict = await evaluateAction(
      h.deps,
      {
        action: "deploy.production",
        action_risk: "high",
        scope: { tenant: h.tenantSlug, project: "payments" },
        purpose: "release_planning",
        claim_ids: [claimId],
      },
      { principal: "user:alice" },
    );
    assert.equal(verdict.allowed, false, "a self-report must not authorise a high-risk side effect");
    assert.ok(verdict.reason_codes.includes(REASON_CODES.ACTION_DENIED_RISK_EXCEEDS_USE));
    assert.equal(verdict.decision, "verify");
    assert.equal(verdict.claims[0]?.blocking, true);
  });

  it("refuses a high-risk action on a tool observation, which is not yet a verified record", async () => {
    // The reference workload's design intent is that CI output carries verified
    // authority, and `defaultAuthorityFor("database")` does map to
    // `verified_record`. A `tool` origin maps to `observation`, which the use policy
    // accepts at low and medium risk and refuses at high risk.
    //
    // That is the current calibrated behaviour, asserted here rather than papered
    // over: a tool result is a strong signal, and "the tool said so" is not yet the
    // same claim as "an authoritative record says so". Widening it is a policy
    // change with a version bump, not a test edit — see docs/policy-cookbook.md.
    const observed = await writeClaim(h, "tool:ci status: success commit a1b2c3d", "alice", "tool");
    const verdict = await evaluateAction(
      h.deps,
      {
        action: "deploy.production",
        action_risk: "high",
        scope: { tenant: h.tenantSlug, project: "payments" },
        purpose: "release_planning",
        claim_ids: [observed],
      },
      { principal: "user:alice" },
    );
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.reason_codes.includes(REASON_CODES.ACTION_DENIED_RISK_EXCEEDS_USE));
    assert.equal(verdict.claims[0]?.use, "verify");
  });

  it("denies an unknown claim rather than assuming it is fine", async () => {
    const verdict = await evaluateAction(
      h.deps,
      {
        action: "deploy.production",
        action_risk: "medium",
        scope: { tenant: h.tenantSlug, project: "payments" },
        purpose: "release_planning",
        claim_ids: [`clm_${"0".repeat(32)}`],
      },
      { principal: "user:alice" },
    );
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.claims[0]?.found, false);
    assert.ok(verdict.reason_codes.includes(REASON_CODES.ACTION_DENIED_UNKNOWN_CLAIM));
  });

  it("denies a claim the acting principal cannot reach", async () => {
    const verdict = await evaluateAction(
      h.deps,
      {
        action: "deploy.production",
        action_risk: "medium",
        scope: { tenant: h.tenantSlug, project: "payments" },
        purpose: "release_planning",
        claim_ids: [claimId],
      },
      { principal: "user:mallory" },
    );
    assert.equal(verdict.allowed, false, "a principal with no membership must not be able to act on this claim");
    assert.ok(verdict.reason_codes.includes(REASON_CODES.ACTION_DENIED_UNKNOWN_CLAIM));
  });

  it("denies when the purpose does not match the admission purpose", async () => {
    const verdict = await evaluateAction(
      h.deps,
      {
        action: "deploy.production",
        action_risk: "medium",
        scope: { tenant: h.tenantSlug, project: "payments" },
        purpose: `unrelated_${Math.random().toString(36).slice(2)}`,
        claim_ids: [claimId],
      },
      { principal: "user:alice" },
    );
    assert.equal(verdict.allowed, false);
  });

  it("denies after revocation, even though the packet that informed the action said use", async () => {
    const doomed = await writeClaim(h, "The deadline is 2026-12-01T09:00Z.");
    const before = await evaluateAction(
      h.deps,
      {
        action: "notify.vendor",
        action_risk: "medium",
        scope: { tenant: h.tenantSlug, project: "payments" },
        purpose: "release_planning",
        claim_ids: [doomed],
      },
      { principal: "user:alice" },
    );
    assert.equal(before.allowed, true, `expected the fresh claim to pass: ${before.reason_codes.join(", ")}`);

    // Revoke between the query and the action. The gate must re-read, not trust the
    // earlier verdict — this is the whole reason it does not accept a packet.
    await h.ctx.db.withSystemContext({ tenant: h.tenantId, actor: "operator:test" }, async (executor) => {
      await applyStatus(
        executor,
        { claimId: doomed, status: "revoked", reasonCodes: [REASON_CODES.USE_REVOKED] },
        { decisionId: h.ctx.ids.next("dec"), policyVersion: "revocation-v1", approver: "operator:test" },
      );
    });

    const after = await evaluateAction(
      h.deps,
      {
        action: "notify.vendor",
        action_risk: "medium",
        scope: { tenant: h.tenantSlug, project: "payments" },
        purpose: "release_planning",
        claim_ids: [doomed],
      },
      { principal: "user:alice" },
    );
    assert.equal(after.allowed, false, "a revoked claim must block the action it was cited for");
  });

  it("denies when the evidence behind a claim has been erased", async () => {
    const other = await harness("actiongate-erased");
    try {
      const target = await writeClaim(other, "I approved the Thursday 06:00 UTC maintenance window.");
      // Erase the subject's payload: the claim survives as testimony, but its
      // evidence no longer resolves, so it cannot authorise anything.
      await other.ctx.db.withSystemContext({ tenant: other.tenantId, actor: "retention:test" }, async (executor) => {
        await executor.query(
          `UPDATE events SET payload = NULL, payload_ref = NULL, redacted_at = now()
            WHERE event_id IN (
              SELECT s.event_id FROM evidence_spans s
                JOIN claim_evidence ce ON ce.span_id = s.span_id
               WHERE ce.claim_id = $1::uuid)`,
          [uuidOf(target)],
        );
      });

      const verdict = await evaluateAction(
        other.deps,
        {
          action: "deploy.production",
          action_risk: "high",
          scope: { tenant: other.tenantSlug, project: "payments" },
          purpose: "release_planning",
          claim_ids: [target],
        },
        { principal: "user:alice" },
      );
      assert.equal(verdict.allowed, false, "a claim whose evidence is gone must not authorise a side effect");
    } finally {
      await other.close();
    }
  });

  it("produces the same verdict for the same inputs, so a gate decision is reproducible", async () => {
    const first = await evaluateAction(
      h.deps,
      {
        action: "read.release.notes",
        action_risk: "low",
        scope: { tenant: h.tenantSlug, project: "payments" },
        purpose: "release_planning",
        claim_ids: [claimId],
      },
      { principal: "user:alice" },
    );
    const second = await evaluateAction(
      h.deps,
      {
        action: "read.release.notes",
        action_risk: "low",
        scope: { tenant: h.tenantSlug, project: "payments" },
        purpose: "release_planning",
        claim_ids: [claimId],
      },
      { principal: "user:alice" },
    );
    assert.equal(first.allowed, second.allowed);
    assert.deepEqual(first.reason_codes, second.reason_codes);
    assert.equal(first.policy_version, second.policy_version);
  });

  it("annotates the trace with the action check when one is supplied", async () => {
    const composed = await compose(
      h.deps,
      {
        tenant_id: h.tenantId,
        query: "deploy window",
        scope: { tenant: h.tenantSlug, project: "payments" },
        purpose: "release_planning",
      },
      { principal: "user:alice" },
    );
    const verdict = await evaluateAction(
      h.deps,
      {
        action: "deploy.production",
        action_risk: "medium",
        scope: { tenant: h.tenantSlug, project: "payments" },
        purpose: "release_planning",
        claim_ids: [claimId],
        trace_id: composed.packet.trace_id,
      },
      { principal: "user:alice" },
    );
    assert.equal(verdict.allowed, true);

    const trace = await h.ctx.db.withSystemContext({ tenant: h.tenantId, actor: "system:test" }, (executor) =>
      executor.query<{ query: { action_gate?: { allowed: boolean } } }>(
        "SELECT query FROM query_traces WHERE trace_id = $1::uuid",
        [uuidOf(composed.packet.trace_id)],
      ),
    );
    assert.equal(trace.rows[0]?.query.action_gate?.allowed, true);
  });
});
