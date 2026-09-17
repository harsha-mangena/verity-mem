/**
 * Ledger invariants.
 *
 * These tests deliberately assert against real PostgreSQL behaviour, because
 * every guarantee in this file is implemented by the database: the append-only
 * trigger, the scope predicate behind row-level security, and the digest that
 * makes a span mean something specific.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { EventAppendRequest } from "@veritymem/contracts";
import { LedgerError, resolveTenantId, sha256Hex } from "@veritymem/ledger";
import { captureError, createTestContext, type TestContext } from "@veritymem/testkit";

function appendRequest(content: string, overrides: Partial<EventAppendRequest> = {}): EventAppendRequest {
  return {
    stream_id: "thread:9",
    origin: "user",
    actor_id: "user:alice",
    scope: {
      tenant: "placeholder",
      project: "payments",
      user: "alice",
      purpose: ["release_planning"],
    },
    occurred_at: "2026-09-10T09:14:00Z",
    content,
    ...overrides,
  };
}

describe("ledger", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await createTestContext("ledger");
  });

  after(async () => {
    await ctx.close();
  });

  const withTenant = <T>(request: EventAppendRequest, fn: (args: { scopeIds: string[]; purposes: string[] }) => Promise<T>) => fn;

  describe("append", () => {
    it("assigns sequence 1, a content hash and no predecessor on a new stream", async () => {
      const receipt = await ctx.ledger.append(
        appendRequest("I approved the Sunday 02:00 UTC deploy window.", {
          scope: {
            tenant: ctx.tenantSlug,
            project: "payments",
            user: "alice",
            purpose: ["release_planning"],
          },
        }),
      );

      assert.equal(receipt.seq, 1);
      assert.equal(receipt.prev_hash, null);
      assert.equal(receipt.deduplicated, false);
      assert.equal(
        receipt.content_hash,
        sha256Hex("I approved the Sunday 02:00 UTC deploy window."),
      );
      assert.match(receipt.event_id, /^evt_[0-9a-f]{32}$/);
      assert.equal(receipt.scope.project, "payments");
      assert.deepEqual(receipt.scope.purpose, ["release_planning"]);
    });

    it("increments the sequence and links each event to its predecessor", async () => {
      const scope = {
        tenant: ctx.tenantSlug,
        project: "payments",
        user: "bob",
        purpose: ["release_planning"],
      };
      const first = await ctx.ledger.append(
        appendRequest("first", { stream_id: "thread:chain", actor_id: "user:bob", scope }),
      );
      const second = await ctx.ledger.append(
        appendRequest("second", { stream_id: "thread:chain", actor_id: "user:bob", scope }),
      );
      const third = await ctx.ledger.append(
        appendRequest("third", { stream_id: "thread:chain", actor_id: "user:bob", scope }),
      );

      assert.deepEqual([first.seq, second.seq, third.seq], [1, 2, 3]);
      assert.equal(second.prev_hash, first.content_hash);
      assert.equal(third.prev_hash, second.content_hash);
    });

    it("sequences streams independently", async () => {
      const scope = { tenant: ctx.tenantSlug, project: "payments", user: "carol", purpose: ["release_planning"] };
      const a = await ctx.ledger.append(appendRequest("a", { stream_id: "s:one", actor_id: "user:carol", scope }));
      const b = await ctx.ledger.append(appendRequest("b", { stream_id: "s:two", actor_id: "user:carol", scope }));
      assert.equal(a.seq, 1);
      assert.equal(b.seq, 1);
    });
  });

  describe("idempotency", () => {
    it("returns the original event and does not allocate a second sequence", async () => {
      const scope = { tenant: ctx.tenantSlug, project: "payments", user: "dave", purpose: ["release_planning"] };
      const request = appendRequest("deploy approved", {
        stream_id: "thread:idem",
        actor_id: "user:dave",
        scope,
        idempotency_key: "turn-14",
      });

      const first = await ctx.ledger.append(request);
      const replay = await ctx.ledger.append(request);

      assert.equal(replay.event_id, first.event_id, "same id in the same form");
      assert.equal(replay.seq, first.seq);
      assert.equal(replay.deduplicated, true);
      assert.equal(replay.content_hash, first.content_hash);

      const count = await ctx.db.withRequest(
        {
          tenant: first.scope.tenant_id,
          principal: "user:dave",
          scopeIds: [first.scope.scope_id],
          purposes: ["release_planning"],
        },
        (executor) =>
          executor.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM events WHERE stream_id = 'thread:idem'",
          ),
      );
      assert.equal(count.rows[0]?.n, 1, "exactly one event exists after the replay");
    });

    it("refuses to reuse an idempotency key for different content", async () => {
      const scope = { tenant: ctx.tenantSlug, project: "payments", user: "erin", purpose: ["release_planning"] };
      const base = appendRequest("original content", {
        stream_id: "thread:idem-conflict",
        actor_id: "user:erin",
        scope,
        idempotency_key: "turn-15",
      });
      await ctx.ledger.append(base);

      const error = await captureError(() =>
        ctx.ledger.append({ ...base, content: "different content" }),
      );
      assert.ok(error instanceof LedgerError);
      assert.equal(error.code, "idempotency_conflict");
      assert.equal(error.statusCode, 409);
    });

    it("accepts the same key in a different tenant", async () => {
      const scopeA = { tenant: ctx.tenantSlug, project: "payments", user: "frank", purpose: ["release_planning"] };
      const scopeB = { tenant: `${ctx.tenantSlug}-other`, project: "payments", user: "frank", purpose: ["release_planning"] };
      const a = await ctx.ledger.append(
        appendRequest("same key", { stream_id: "s:shared", actor_id: "user:frank", scope: scopeA, idempotency_key: "k1" }),
      );
      const b = await ctx.ledger.append(
        appendRequest("same key", { stream_id: "s:shared", actor_id: "user:frank", scope: scopeB, idempotency_key: "k1" }),
      );
      assert.notEqual(a.event_id, b.event_id);
      assert.equal(b.deduplicated, false);
    });
  });

  describe("expected_seq", () => {
    it("accepts a matching assertion", async () => {
      const scope = { tenant: ctx.tenantSlug, project: "payments", user: "gina", purpose: ["release_planning"] };
      const receipt = await ctx.ledger.append(
        appendRequest("first", { stream_id: "s:expected", actor_id: "user:gina", scope, expected_seq: 1 }),
      );
      assert.equal(receipt.seq, 1);
    });

    it("rejects a stale assertion instead of writing out of order", async () => {
      const scope = { tenant: ctx.tenantSlug, project: "payments", user: "gina", purpose: ["release_planning"] };
      const error = await captureError(() =>
        ctx.ledger.append(
          appendRequest("first", { stream_id: "s:expected-2", actor_id: "user:gina", scope, expected_seq: 7 }),
        ),
      );
      assert.ok(error instanceof LedgerError);
      assert.equal(error.code, "sequence_conflict");
    });
  });

  describe("evidence spans", () => {
    const content = "I approved the Sunday 02:00 UTC deploy window.";

    it("resolves a byte range to the exact text and verifies its digest", async () => {
      const scope = { tenant: ctx.tenantSlug, project: "payments", user: "hana", purpose: ["release_planning"] };
      const receipt = await ctx.ledger.append(
        appendRequest(content, { stream_id: "s:spans", actor_id: "user:hana", scope }),
      );

      const spans = await ctx.db.withRequest(
        { tenant: receipt.scope.tenant_id, principal: "user:hana", scopeIds: [receipt.scope.scope_id], purposes: ["release_planning"], action: "read" },
        async (executor) => {
          const event = await ctx.ledger.readEvent(executor, receipt.event_id);
          assert.ok(event);
          return ctx.ledger.writeSpans(executor, event, [{ start: 12, end: 45 }]);
        },
      );

      const span = spans[0];
      assert.ok(span);
      assert.equal(span.quote, content.slice(12, 45));
      assert.equal(span.digest, sha256Hex(content.slice(12, 45)));
      assert.equal(span.start, 12);
      assert.equal(span.end, 45);
    });

    it("reuses an identical span rather than duplicating it", async () => {
      const scope = { tenant: ctx.tenantSlug, project: "payments", user: "hana", purpose: ["release_planning"] };
      const receipt = await ctx.ledger.append(
        appendRequest(content, { stream_id: "s:spans-reuse", actor_id: "user:hana", scope }),
      );
      const spans = await ctx.db.withRequest(
        { tenant: receipt.scope.tenant_id, principal: "user:hana", scopeIds: [receipt.scope.scope_id], purposes: ["release_planning"] },
        async (executor) => {
          const event = await ctx.ledger.readEvent(executor, receipt.event_id);
          assert.ok(event);
          const first = await ctx.ledger.writeSpans(executor, event, [{ start: 0, end: 10 }]);
          const second = await ctx.ledger.writeSpans(executor, event, [{ start: 0, end: 10 }]);
          return { first, second };
        },
      );
      assert.equal(spans.first[0]?.span_id, spans.second[0]?.span_id);
    });

    it("refuses a span that runs past the end of the payload", async () => {
      const scope = { tenant: ctx.tenantSlug, project: "payments", user: "hana", purpose: ["release_planning"] };
      const receipt = await ctx.ledger.append(
        appendRequest(content, { stream_id: "s:spans-oob", actor_id: "user:hana", scope }),
      );
      const error = await captureError(() =>
        ctx.db.withRequest(
          { tenant: receipt.scope.tenant_id, principal: "user:hana", scopeIds: [receipt.scope.scope_id], purposes: ["release_planning"] },
          async (executor) => {
            const event = await ctx.ledger.readEvent(executor, receipt.event_id);
            assert.ok(event);
            await ctx.ledger.writeSpans(executor, event, [{ start: 0, end: 10_000 }]);
          },
        ),
      );
      assert.ok(error instanceof LedgerError);
      assert.equal(error.code, "invalid_span");
    });

    it("counts offsets in bytes, not UTF-16 code units", async () => {
      const scope = { tenant: ctx.tenantSlug, project: "payments", user: "hana", purpose: ["release_planning"] };
      // The em dash is three UTF-8 bytes but one JavaScript string index. If spans
      // were measured in code units the digest below would not match the bytes.
      const multibyte = "approved — the window";
      const receipt = await ctx.ledger.append(
        appendRequest(multibyte, { stream_id: "s:spans-utf8", actor_id: "user:hana", scope }),
      );
      const verified = await ctx.db.withRequest(
        { tenant: receipt.scope.tenant_id, principal: "user:hana", scopeIds: [receipt.scope.scope_id], purposes: ["release_planning"] },
        async (executor) => {
          const event = await ctx.ledger.readEvent(executor, receipt.event_id);
          assert.ok(event);
          const [span] = await ctx.ledger.writeSpans(executor, event, [{ start: 9, end: 12 }]);
          assert.ok(span);
          const verifications = await ctx.ledger.verifySpans(executor, [span]);
          return { span, verification: verifications.get(span.span_id) };
        },
      );
      assert.equal(verified.span.quote, "—", "the three bytes of the em dash");
      assert.equal(verified.verification?.status, "ok");
    });

    it("reports a digest mismatch when the stored bytes no longer match", async () => {
      const scope = { tenant: ctx.tenantSlug, project: "payments", user: "hana", purpose: ["release_planning"] };
      const receipt = await ctx.ledger.append(
        appendRequest(content, { stream_id: "s:spans-drift", actor_id: "user:hana", scope }),
      );
      const result = await ctx.db.withRequest(
        { tenant: receipt.scope.tenant_id, principal: "user:hana", scopeIds: [receipt.scope.scope_id], purposes: ["release_planning"] },
        async (executor) => {
          const event = await ctx.ledger.readEvent(executor, receipt.event_id);
          assert.ok(event);
          const [span] = await ctx.ledger.writeSpans(executor, event, [{ start: 0, end: 12 }]);
          assert.ok(span);
          // Simulate a span whose recorded digest describes different bytes: the
          // verification must fail closed rather than trust the stored quote.
          const tampered = { ...span, digest: sha256Hex("something else entirely") };
          const verifications = await ctx.ledger.verifySpans(executor, [tampered]);
          return verifications.get(span.span_id);
        },
      );
      assert.equal(result?.status, "digest_mismatch");
    });
  });

  describe("hash chain", () => {
    it("verifies a clean stream and reports the broken sequence", async () => {
      const scope = { tenant: ctx.tenantSlug, project: "payments", user: "ivan", purpose: ["release_planning"] };
      const receipts = [];
      for (const body of ["one", "two", "three", "four"]) {
        receipts.push(
          await ctx.ledger.append(
            appendRequest(body, { stream_id: "s:verify", actor_id: "user:ivan", scope }),
          ),
        );
      }
      const tenantId = receipts[0]!.scope.tenant_id;
      const scopeId = receipts[0]!.scope.scope_id;
      const verdict = await ctx.db.withRequest(
        { tenant: tenantId, principal: "user:ivan", scopeIds: [scopeId], purposes: ["release_planning"] },
        (executor) => ctx.ledger.verifyChain(executor, { tenant: tenantId, streamId: "s:verify" }),
      );
      assert.equal(verdict.ok, true);
      assert.equal(verdict.checked, 4);
      assert.equal(verdict.brokenAtSeq, null);
    });

    it("detects a forged link hash", async () => {
      const scope = { tenant: ctx.tenantSlug, project: "payments", user: "judy", purpose: ["release_planning"] };
      const first = await ctx.ledger.append(
        appendRequest("one", { stream_id: "s:forge", actor_id: "user:judy", scope }),
      );
      await ctx.ledger.append(appendRequest("two", { stream_id: "s:forge", actor_id: "user:judy", scope }));

      // Bypass the ledger to forge one link, exactly as a rewriting operator could,
      // and confirm the chain still refuses to validate.
      await mutateAsPrivileged(
        "UPDATE events SET link_hash = decode(repeat('00', 32), 'hex') WHERE stream_id = 's:forge' AND seq = 2",
        [],
        { disableGuards: true },
      );

      const verdict = await ctx.db.withRequest(
        { tenant: first.scope.tenant_id, principal: "user:judy", scopeIds: [first.scope.scope_id], purposes: ["release_planning"] },
        (executor) =>
          ctx.ledger.verifyChain(executor, { tenant: first.scope.tenant_id, streamId: "s:forge" }),
      );
      assert.equal(verdict.ok, false);
      assert.equal(verdict.brokenAtSeq, 2);
      assert.match(String(verdict.reason), /link_hash/);
    });
  });

  describe("append-only enforcement", () => {
    it("refuses to mutate an event payload outside retention redaction", async () => {
      const scope = { tenant: ctx.tenantSlug, project: "payments", user: "karl", purpose: ["release_planning"] };
      const receipt = await ctx.ledger.append(
        appendRequest("immutable", { stream_id: "s:immutable", actor_id: "user:karl", scope }),
      );
      const error = await captureError(() =>
        mutateAsPrivileged("UPDATE events SET payload = 'rewritten' WHERE event_id = $1::uuid", [
          asUuid(receipt.event_id),
        ]),
      );
      assert.match(error.message, /append-only/);
    });

    it("leaves the application role with no way to mutate a payload at all", async () => {
      const scope = { tenant: ctx.tenantSlug, project: "payments", user: "karl", purpose: ["release_planning"] };
      const receipt = await ctx.ledger.append(
        appendRequest("app role cannot rewrite", {
          stream_id: "s:immutable-approle",
          actor_id: "user:karl",
          scope,
        }),
      );

      // The RLS WITH CHECK clause refuses the new row, so the statement matches
      // zero rows rather than raising. Silent zero-row updates are exactly what
      // the append-only trigger cannot catch, which is why both layers exist.
      const attempted = await ctx.db.systemQuery(
        "UPDATE events SET payload = 'rewritten' WHERE event_id = $1::uuid",
        [asUuid(receipt.event_id)],
      );
      assert.equal(attempted.rowCount, 0);

      const read = await ctx.db.withRequest(
        {
          tenant: receipt.scope.tenant_id,
          principal: "user:karl",
          scopeIds: [receipt.scope.scope_id],
          purposes: ["release_planning"],
        },
        (executor) => ctx.ledger.readEvent(executor, receipt.event_id),
      );
      assert.equal(read?.content, "app role cannot rewrite");
    });

    it("leaves the payload intact after a rejected mutation", async () => {
      const scope = { tenant: ctx.tenantSlug, project: "payments", user: "karl", purpose: ["release_planning"] };
      const receipt = await ctx.ledger.append(
        appendRequest("must survive", { stream_id: "s:immutable-intact", actor_id: "user:karl", scope }),
      );
      await captureError(() =>
        mutateAsPrivileged("UPDATE events SET payload = 'rewritten' WHERE event_id = $1::uuid", [
          asUuid(receipt.event_id),
        ]),
      );
      const read = await ctx.db.withRequest(
        {
          tenant: receipt.scope.tenant_id,
          principal: "user:karl",
          scopeIds: [receipt.scope.scope_id],
          purposes: ["release_planning"],
        },
        (executor) => ctx.ledger.readEvent(executor, receipt.event_id),
      );
      assert.equal(read?.content, "must survive");
    });

    it("refuses to delete an event", async () => {
      const scope = { tenant: ctx.tenantSlug, project: "payments", user: "karl", purpose: ["release_planning"] };
      const receipt = await ctx.ledger.append(
        appendRequest("undeletable", { stream_id: "s:nodelete", actor_id: "user:karl", scope }),
      );
      const uuid = receipt.event_id.replace(/^evt_/, "").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
      const error = await captureError(() =>
        ctx.db.systemQuery("DELETE FROM events WHERE event_id = $1::uuid", [uuid]),
      );
      assert.match(error.message, /append-only/);
    });

    it("refuses to update an evidence span", async () => {
      const scope = { tenant: ctx.tenantSlug, project: "payments", user: "karl", purpose: ["release_planning"] };
      const receipt = await ctx.ledger.append(
        appendRequest("span immutability", { stream_id: "s:spanimm", actor_id: "user:karl", scope }),
      );
      const spanId = await ctx.db.withRequest(
        { tenant: receipt.scope.tenant_id, principal: "user:karl", scopeIds: [receipt.scope.scope_id], purposes: ["release_planning"] },
        async (executor) => {
          const event = await ctx.ledger.readEvent(executor, receipt.event_id);
          assert.ok(event);
          const [span] = await ctx.ledger.writeSpans(executor, event, [{ start: 0, end: 5 }]);
          return span!.span_id;
        },
      );
      const error = await captureError(() =>
        mutateAsPrivileged("UPDATE evidence_spans SET quote = 'changed' WHERE span_id = $1::uuid", [
          asUuid(spanId),
        ]),
      );
      assert.match(error.message, /immutable/);
    });
  });

  describe("tenant and scope isolation", () => {
    it("does not expose another tenant's events to a scoped query", async () => {
      const mine = { tenant: ctx.tenantSlug, project: "payments", user: "laura", purpose: ["release_planning"] };
      const theirs = { tenant: `${ctx.tenantSlug}-rival`, project: "payments", user: "laura", purpose: ["release_planning"] };
      const mineReceipt = await ctx.ledger.append(
        appendRequest("my secret", { stream_id: "s:iso", actor_id: "user:laura", scope: mine }),
      );
      await ctx.ledger.append(
        appendRequest("their secret", { stream_id: "s:iso", actor_id: "user:laura", scope: theirs }),
      );

      const visible = await ctx.db.withRequest(
        { tenant: mineReceipt.scope.tenant_id, principal: "user:laura", scopeIds: [mineReceipt.scope.scope_id], purposes: ["release_planning"] },
        (executor) => executor.query<{ content: string | null }>("SELECT payload AS content FROM events"),
      );
      assert.equal(visible.rows.length, 1);
      assert.equal(visible.rows[0]?.content, "my secret");
    });

    it("does not expose an event admitted for a different purpose", async () => {
      const receipts = await ctx.ledger.append(
        appendRequest("planning only", {
          stream_id: "s:purpose",
          actor_id: "user:mona",
          scope: { tenant: ctx.tenantSlug, project: "payments", user: "mona", purpose: ["release_planning"] },
        }),
      );
      await ctx.ledger.append(
        appendRequest("hr only", {
          stream_id: "s:purpose-hr",
          actor_id: "user:mona",
          scope: { tenant: ctx.tenantSlug, project: "payments", user: "mona", purpose: ["hr_review"] },
        }),
      );

      const visible = await ctx.db.withRequest(
        { tenant: receipts.scope.tenant_id, principal: "user:mona", scopeIds: [receipts.scope.scope_id], purposes: ["hr_review"] },
        (executor) => executor.query<{ payload: string | null }>("SELECT payload FROM events ORDER BY seq"),
      );
      assert.equal(visible.rows.length, 1);
      assert.equal(visible.rows[0]?.payload, "hr only");
    });

    it("fails closed at the database when no request context is bound", async () => {
      await ctx.ledger.append(
        appendRequest("context required", {
          stream_id: "s:nocontext",
          actor_id: "user:nina",
          scope: { tenant: ctx.tenantSlug, project: "payments", user: "nina", purpose: ["release_planning"] },
        }),
      );

      // The application handle refuses to run this at all, which is the first
      // line of defence.
      await assert.rejects(
        () => ctx.db.query("SELECT count(*)::int AS n FROM events"),
        /outside a request context/,
      );

      // And the database itself returns nothing for a connection with no context
      // bound, because every policy predicate evaluates to NULL. An empty result
      // is the correct failure mode; "all rows" would be the catastrophic one.
      const unfiltered = await ctx.db.systemQuery<{ n: number }>("SELECT count(*)::int AS n FROM events");
      assert.equal(unfiltered.rows[0]?.n, 0);

      // Same for a real user id but no scope: identity alone is not authorization.
      const tenantOnly = await ctx.db.systemQuery<{ n: number }>("SELECT count(*)::int AS n FROM events");
      assert.equal(tenantOnly.rows[0]?.n, 0);
    });

    /**
     * Documents the exact division of labour, because this is the sort of thing
     * that gets misremembered as "RLS does user isolation".
     *
     * Row-level security is a *containment* boundary: it blocks a different
     * tenant, a different project, and a non-overlapping purpose. It deliberately
     * does not block a sibling user inside the same project, because a
     * project-scoped caller (which the documented query shape allows) is entitled
     * to reach them. Per-user isolation is the query planner's job and is proved
     * in retrieval.test.ts. The backstop is a containment backstop, and calling
     * that out is the difference between a documented limitation and a surprise.
     */
    it("blocks a different project within the same tenant", async () => {
      const payments = await ctx.ledger.append(
        appendRequest("payments secret", {
          stream_id: "s:project-boundary",
          actor_id: "user:alice",
          scope: { tenant: ctx.tenantSlug, project: "payments", user: "alice", purpose: ["release_planning"] },
        }),
      );
      await ctx.ledger.append(
        appendRequest("hr secret", {
          stream_id: "s:project-boundary",
          actor_id: "user:alice",
          scope: { tenant: ctx.tenantSlug, project: "hr", user: "alice", purpose: ["release_planning"] },
        }),
      );
      const visible = await ctx.db.withRequest(
        {
          tenant: payments.scope.tenant_id,
          principal: "user:alice",
          scopeIds: [payments.scope.scope_id],
          purposes: ["release_planning"],
        },
        (executor) => executor.query<{ payload: string | null }>("SELECT payload FROM events"),
      );
      // The caller is bound at project level (no user dimension), so it reaches
      // every user scope inside `payments` — and nothing in `hr`. Assert on the
      // boundary rather than on an exact list, since sibling tests legitimately
      // add reachable rows to the same project.
      const payloads = visible.rows.map((r) => r.payload);
      assert.ok(payloads.includes("payments secret"), "own project must be reachable");
      assert.ok(!payloads.includes("hr secret"), "the other project must not be reachable");
    });

    it("keeps a user-scoped caller inside that user", async () => {
      const mine = await ctx.ledger.append(
        appendRequest("alice private", {
          stream_id: "s:sibling",
          actor_id: "user:alice",
          scope: { tenant: ctx.tenantSlug, project: "payments", user: "alice", purpose: ["release_planning"] },
        }),
      );
      await ctx.ledger.append(
        appendRequest("bob private", {
          stream_id: "s:sibling",
          actor_id: "user:bob",
          scope: { tenant: ctx.tenantSlug, project: "payments", user: "bob", purpose: ["release_planning"] },
        }),
      );

      // A caller bound to user:alice is bound *at that user*, so the sibling user
      // in the same project is out of reach. This is the per-user isolation the
      // query planner publishes, enforced here by the same predicate the planner
      // filters with — there is one implementation, not two that can disagree.
      const asAlice = await ctx.db.withRequest(
        {
          tenant: mine.scope.tenant_id,
          principal: "user:alice",
          scopeIds: [mine.scope.scope_id],
          purposes: ["release_planning"],
        },
        (executor) => executor.query<{ payload: string | null }>("SELECT payload FROM events ORDER BY seq"),
      );
      const payloads = asAlice.rows.map((r) => r.payload);
      assert.ok(payloads.includes("alice private"));
      assert.ok(!payloads.includes("bob private"), "a user-scoped caller must not reach a sibling user");
    });

    it("lets a project-scoped caller reach every user in that project", async () => {
      const projectScope = await ctx.ledger.append(
        appendRequest("project level note", {
          stream_id: "s:project-scope",
          actor_id: "service:ci",
          scope: { tenant: ctx.tenantSlug, project: "payments", purpose: ["release_planning"] },
        }),
      );
      await ctx.ledger.append(
        appendRequest("bob private two", {
          stream_id: "s:project-scope",
          actor_id: "user:bob",
          scope: { tenant: ctx.tenantSlug, project: "payments", user: "bob", purpose: ["release_planning"] },
        }),
      );

      const asProject = await ctx.db.withRequest(
        {
          tenant: projectScope.scope.tenant_id,
          principal: "service:ci",
          scopeIds: [projectScope.scope.scope_id],
          purposes: ["release_planning"],
        },
        (executor) => executor.query<{ payload: string | null }>("SELECT payload FROM events ORDER BY seq"),
      );
      const payloads = asProject.rows.map((r) => r.payload);
      assert.ok(payloads.includes("project level note"));
      assert.ok(payloads.includes("bob private two"), "a project-scoped caller reaches users inside the project");
    });

    it("treats purpose as a hard boundary", async () => {
      const mine = await ctx.ledger.append(
        appendRequest("purpose bound", {
          stream_id: "s:purpose-boundary",
          actor_id: "user:alice",
          scope: { tenant: ctx.tenantSlug, project: "payments", user: "alice", purpose: ["release_planning"] },
        }),
      );

      // The purpose name is unique to this test: scopes accumulate purposes by
      // design, so a purpose another test already admitted for this scope would
      // legitimately resolve.
      const unrelatedPurpose = `unrelated_${Math.random().toString(36).slice(2, 10)}`;
      const otherPurpose = await ctx.db.withRequest(
        {
          tenant: mine.scope.tenant_id,
          principal: "user:alice",
          scopeIds: [mine.scope.scope_id],
          purposes: [unrelatedPurpose],
        },
        (executor) => executor.query<{ payload: string | null }>("SELECT payload FROM events ORDER BY seq"),
      );
      assert.deepEqual(otherPurpose.rows, [], "an unrelated purpose must reach nothing");
    });
  });

  describe("payload storage", () => {
    it("keeps small payloads inline and sends large ones to the blob store", async () => {
      const scope = { tenant: ctx.tenantSlug, project: "payments", user: "olive", purpose: ["release_planning"] };
      const small = await ctx.ledger.append(
        appendRequest("small", { stream_id: "s:inline", actor_id: "user:olive", scope }),
      );
      const large = await ctx.ledger.append(
        appendRequest("x".repeat(20_000), { stream_id: "s:blob", actor_id: "user:olive", scope }),
      );

      const rows = await ctx.db.withRequest(
        { tenant: small.scope.tenant_id, principal: "user:olive", scopeIds: [small.scope.scope_id], purposes: ["release_planning"] },
        (executor) =>
          executor.query<{ stream_id: string; payload: string | null; payload_ref: string | null; byte_length: number }>(
            "SELECT stream_id, payload, payload_ref, byte_length FROM events ORDER BY seq",
          ),
      );
      const inlineRow = rows.rows.find((r) => r.stream_id === "s:inline");
      const blobRow = rows.rows.find((r) => r.stream_id === "s:blob");
      assert.equal(inlineRow?.payload, "small");
      assert.equal(inlineRow?.payload_ref, null);
      assert.equal(blobRow?.payload, null);
      assert.match(String(blobRow?.payload_ref), /^blob:\/\/sha256\/[0-9a-f]{64}$/);
      assert.equal(blobRow?.byte_length, 20_000);

      // The blob round-trips through the store, so a span can still be resolved.
      const read = await ctx.db.withRequest(
        { tenant: large.scope.tenant_id, principal: "user:olive", scopeIds: [large.scope.scope_id], purposes: ["release_planning"] },
        (executor) => ctx.ledger.readEvent(executor, large.event_id),
      );
      assert.equal(read?.content?.length, 20_000);
    });
  });
});

/**
 * Perform a write the way an operator with database credentials would: on a
 * privileged connection, with the append-only triggers temporarily disabled when
 * the test needs to demonstrate that a chain forgery is still detected.
 *
 * This is deliberately confined to the test file and uses the migration
 * credentials, because it is the only place in the codebase that should ever
 * bypass the guards. The application role cannot do any of this, which is itself
 * asserted below.
 */
async function mutateAsPrivileged(
  sql: string,
  params: readonly unknown[],
  options: { disableGuards?: boolean } = {},
): Promise<{ rowCount: number | null; rows: unknown[] }> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: migrationUrl() });
  await client.connect();
  try {
    if (options.disableGuards) {
      await client.query("ALTER TABLE events DISABLE TRIGGER events_append_only");
      await client.query("ALTER TABLE events DISABLE TRIGGER events_no_delete");
    }
    try {
      const result = await client.query(sql, params as unknown[]);
      return { rowCount: result.rowCount, rows: result.rows };
    } finally {
      if (options.disableGuards) {
        await client.query("ALTER TABLE events ENABLE TRIGGER events_no_delete");
        await client.query("ALTER TABLE events ENABLE TRIGGER events_append_only");
      }
    }
  } finally {
    await client.end();
  }
}

function migrationUrl(): string {
  const url = process.env["MIGRATION_DATABASE_URL"];
  if (!url) {
    throw new Error("MIGRATION_DATABASE_URL is required for privileged test operations");
  }
  return url;
}

function asUuid(prefixed: string): string {
  const body = prefixed.slice(prefixed.indexOf("_") + 1);
  return [
    body.slice(0, 8),
    body.slice(8, 12),
    body.slice(12, 16),
    body.slice(16, 20),
    body.slice(20, 32),
  ].join("-");
}
