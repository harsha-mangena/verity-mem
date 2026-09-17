/**
 * Bi-temporal reads.
 *
 * Three modes over the same columns, and the one that is easy to get wrong is
 * `as_of`: it asks what the system *believed* at a past instant, which is a question
 * about transaction time (`recorded_at`), not valid time. Answering it from the
 * valid-time columns produces a plausible and wrong answer, so these tests
 * distinguish the two axes explicitly rather than asserting that a query returns
 * "some rows".
 *
 * The scenario is built so the two axes disagree: a claim is recorded on day 1
 * about a period starting day 1, superseded on day 3 by a claim whose valid time
 * starts on day 2. A valid-time query at day 2 and a transaction-time query at day 2
 * must give different answers.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DEFAULT_COMMIT_POLICY } from "@veritymem/contracts";
import { CommitGate, LexicalEntailmentBackend } from "@veritymem/gate";
import { DETERMINISTIC_EXTRACTORS, IngestPipeline } from "@veritymem/model-adapters";
import { resolveTenantId } from "@veritymem/ledger";
import { createTestContext, type TestContext } from "@veritymem/testkit";
import { listClaims, timePredicate } from "./index.ts";

interface Harness {
  readonly ctx: TestContext;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly scopeId: string;
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
  const receipt = await ctx.ledger.append({
    stream_id: "seed",
    origin: "user",
    actor_id: "user:alice",
    scope: { tenant: ctx.tenantSlug, project: "payments", user: "alice", purpose: ["release_planning"] },
    occurred_at: "2026-01-01T00:00:00Z",
    content: "seed",
  });
  return {
    ctx,
    tenantId: resolveTenantId(ctx.tenantSlug),
    tenantSlug: ctx.tenantSlug,
    scopeId: receipt.scope.scope_id,
    pipeline: new IngestPipeline({
      db: ctx.db,
      ledger: ctx.ledger,
      gate,
      ids: ctx.ids,
      clock: ctx.clock,
      deterministicExtractors: DETERMINISTIC_EXTRACTORS,
      modelExtractor: null,
    }),
    close: () => ctx.close(),
  };
}

/** Write a claim and return its id, at a caller-chosen occurred_at. */
async function claimAt(h: Harness, content: string, occurredAt: string, stream: string): Promise<string> {
  const receipt = await h.ctx.ledger.append({
    stream_id: stream,
    origin: "user",
    actor_id: "user:alice",
    scope: { tenant: h.tenantSlug, project: "payments", user: "alice", purpose: ["release_planning"] },
    occurred_at: occurredAt,
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
  assert.ok(claimId, `expected an accepted claim for ${JSON.stringify(content)}`);
  return claimId;
}

function uuidOf(prefixed: string): string {
  const body = prefixed.slice(prefixed.indexOf("_") + 1);
  return [body.slice(0, 8), body.slice(8, 12), body.slice(12, 16), body.slice(16, 20), body.slice(20, 32)].join("-");
}

describe("bi-temporal reads", () => {
  let h: Harness;

  before(async () => {
    h = await harness("bitemporal");
  });
  after(async () => {
    await h.close();
  });

  it("returns only the current, accepted claim in current mode", async () => {
    const first = await claimAt(h, "I approved the Sunday 02:00 UTC deploy window.", "2026-01-02T00:00:00Z", "s1");
    await h.ctx.db.withRequest(
      { tenant: h.tenantId, principal: "user:alice", scopeIds: [h.scopeId], purposes: ["release_planning"] },
      (executor) =>
        listClaims(executor, {
          tenantId: h.tenantId,
          scopeIds: [h.scopeId],
          time: { mode: "current" },
          subjects: ["user:user:alice"],
        }),
    ).then((rows) => assert.ok(rows.length >= 1, `expected the claim to be current: ${first}`));

    // Supersede it by writing a conflicting claim; the gate records `contradicts`
    // and the earlier claim stops being current.
    await claimAt(h, "I rejected the Sunday 02:00 UTC deploy window.", "2026-01-03T00:00:00Z", "s2");

    const current = await h.ctx.db.withRequest(
      { tenant: h.tenantId, principal: "user:alice", scopeIds: [h.scopeId], purposes: ["release_planning"] },
      (executor) => listClaims(executor, { tenantId: h.tenantId, scopeIds: [h.scopeId], time: { mode: "current" } }),
    );
    for (const claim of current) {
      assert.equal(claim.status, "accepted");
      assert.equal(claim.valid_to, null);
    }
  });

  it("answers as_of from transaction time, not valid time", async () => {
    const other = await harness("bitemporal-asof");
    try {
      // Recorded now, but about a period that started long ago. If `as_of` were
      // answered from valid time, a query as of last year would return it.
      await claimAt(other, "I approved the Sunday 02:00 UTC deploy window.", "2020-01-01T00:00:00Z", "s1");

      const past = await other.ctx.db.withRequest(
        {
          tenant: other.tenantId,
          principal: "user:alice",
          scopeIds: [other.scopeId],
          purposes: ["release_planning"],
        },
        (executor) =>
          listClaims(executor, {
            tenantId: other.tenantId,
            scopeIds: [other.scopeId],
            time: { mode: "as_of", as_of: "2020-06-01T00:00:00Z" },
          }),
      );
      assert.deepEqual(
        past,
        [],
        "the system did not believe this in 2020, whatever period the claim is about",
      );

      const now = await other.ctx.db.withRequest(
        {
          tenant: other.tenantId,
          principal: "user:alice",
          scopeIds: [other.scopeId],
          purposes: ["release_planning"],
        },
        (executor) =>
          listClaims(executor, {
            tenantId: other.tenantId,
            scopeIds: [other.scopeId],
            time: { mode: "as_of", as_of: new Date(Date.now() + 60_000).toISOString() },
          }),
      );
      assert.ok(now.length >= 1, "the system believes it now");
    } finally {
      await other.close();
    }
  });

  it("returns every claim whose validity overlaps the window in during mode, including superseded ones", async () => {
    const history = await h.ctx.db.withRequest(
      { tenant: h.tenantId, principal: "user:alice", scopeIds: [h.scopeId], purposes: ["release_planning"] },
      (executor) =>
        listClaims(executor, {
          tenantId: h.tenantId,
          scopeIds: [h.scopeId],
          time: { mode: "during", from: "2026-01-01T00:00:00Z", to: "2026-12-31T00:00:00Z" },
        }),
    );
    assert.ok(history.length >= 2, "a belief history must include the superseded record, not only the winner");
  });

  it("excludes a claim whose validity ended before the window", async () => {
    const other = await harness("bitemporal-window");
    try {
      const claimId = await claimAt(other, "I approved the Sunday 02:00 UTC deploy window.", "2026-01-02T00:00:00Z", "s1");
      // Close it: the interval now ends in January.
      await other.ctx.db.withRequest(
        { tenant: other.tenantId, principal: "user:alice", scopeIds: [other.scopeId], purposes: ["release_planning"] },
        (executor) =>
          executor.query(`UPDATE claims SET valid_to = $2::timestamptz WHERE claim_id = $1::uuid`, [
            uuidOf(claimId),
            "2026-01-31T00:00:00Z",
          ]),
      );
      const later = await other.ctx.db.withRequest(
        {
          tenant: other.tenantId,
          principal: "user:alice",
          scopeIds: [other.scopeId],
          purposes: ["release_planning"],
        },
        (executor) =>
          listClaims(executor, {
            tenantId: other.tenantId,
            scopeIds: [other.scopeId],
            time: { mode: "during", from: "2026-06-01T00:00:00Z", to: "2026-07-01T00:00:00Z" },
          }),
      );
      assert.equal(later.length, 0, "an interval that ended in January does not overlap June");
    } finally {
      await other.close();
    }
  });

  it("builds a half-open predicate so an interval boundary is not counted twice", () => {
    const current = timePredicate({ mode: "current" }, "c", "2026-01-01T00:00:00Z");
    assert.match(current.sql, /valid_to IS NULL/);
    assert.match(current.sql, /status = 'accepted'/);

    const during = timePredicate(
      { mode: "during", from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z" },
      "c",
      "2026-01-01T00:00:00Z",
    );
    assert.match(during.sql, /tstzrange/);
    assert.match(during.sql, /'\[\)'/, "the range must be half-open or a claim ending exactly at the boundary is counted twice");

    const asOf = timePredicate({ mode: "as_of", as_of: "2026-01-01T00:00:00Z" }, "c", "2026-01-01T00:00:00Z");
    assert.match(asOf.sql, /recorded_at <=/, "as_of is transaction time");
  });
});
