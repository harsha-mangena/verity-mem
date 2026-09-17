/**
 * Ledger replay.
 *
 * The specification's must-have is "append-only ledger with idempotency keys,
 * sequence numbers, content hashes, and replay", and its v0.1 exit target is
 * "deterministic projection equality for identical ledger, code version, model hash,
 * and policy version".
 *
 * The projection half is proved in `packages/retrieval/src/replay.test.ts`. This file
 * proves the half that everything else stands on: that the ledger itself is a
 * *replayable* record. Reading it back in order must reproduce every event's content,
 * its content hash, and every link of the chain — because a rebuild is only as
 * trustworthy as the stream it rebuilds from, and a stream that cannot be read back
 * identically is not an event source, it is a table.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createHash } from "node:crypto";
import { Db, Ledger, MemoryBlobStore, canonicalize, resolveTenantId, seededIds, fixedClock, ensureScope } from "./index.ts";
import { loadEnv } from "./config.ts";

interface Harness {
  readonly db: Db;
  readonly ledger: Ledger;
  readonly tenantSlug: string;
  readonly tenantId: string;
  readonly scopeId: string;
  readonly purposes: readonly string[];
  close(): Promise<void>;
}

async function harness(label: string): Promise<Harness> {
  const db = new Db({ connectionString: loadEnv().databaseUrl, max: 4 });
  const ledger = new Ledger({
    db,
    blobs: new MemoryBlobStore(),
    clock: fixedClock("2026-09-17T12:00:00.000Z"),
    ids: seededIds(`${label}-${Math.random().toString(36).slice(2, 10)}`),
  });
  const tenantSlug = `ledger-replay-${Math.random().toString(36).slice(2, 10)}`;
  const tenantId = resolveTenantId(tenantSlug);
  const purposes = ["release_planning"];
  const seed = await ledger.append({
    stream_id: "seed",
    origin: "user",
    actor_id: "user:alice",
    scope: { tenant: tenantSlug, project: "payments", user: "alice", purpose: [...purposes] },
    occurred_at: "2026-01-01T00:00:00Z",
    content: "seed",
  });
  return {
    db,
    ledger,
    tenantSlug,
    tenantId,
    scopeId: seed.scope.scope_id,
    purposes,
    close: () => db.close(),
  };
}

describe("ledger replay", () => {
  let h: Harness;

  before(async () => {
    h = await harness("ledger-replay");
  });
  after(async () => {
    await h.close();
  });

  it("reads back every event in ledger order with content, hash and link intact", async () => {
    const contents = [
      "I approved the Sunday 02:00 UTC deploy window.",
      "The release candidate passed CI.",
      "Multi-byte content: café — naïve — 東京.",
      "",
    ];
    for (const content of contents.slice(0, 3)) {
      await h.ledger.append({
        stream_id: "thread:replay",
        origin: "user",
        actor_id: "user:alice",
        scope: { tenant: h.tenantSlug, project: "payments", user: "alice", purpose: [...h.purposes] },
        occurred_at: "2026-09-10T09:14:00Z",
        content,
      });
    }
    // A large payload takes the blob path, so replay must exercise blob retrieval too.
    await h.ledger.append({
      stream_id: "thread:replay",
      idempotency_key: "big-1",
      origin: "document",
      actor_id: "doc:spec",
      scope: { tenant: h.tenantSlug, project: "payments", user: "alice", purpose: [...h.purposes] },
      occurred_at: "2026-09-10T10:00:00Z",
      content: "x".repeat(20_000),
    });

    const replayed = await h.db.withRequest(
      {
        tenant: h.tenantId,
        principal: "system:replay",
        scopeIds: [h.scopeId],
        purposes: [...h.purposes],
        action: "ledger:replay",
      },
      async (executor) => {
        const events = [];
        for await (const event of h.ledger.readAll(executor, { tenant: h.tenantId })) events.push(event);
        return events;
      },
    );

    const thread = replayed.filter((event) => event.stream_id === "thread:replay");
    assert.equal(thread.length, 4);

    // Order, sequence and content, and the hash must recompute from the content.
    for (const [index, event] of thread.entries()) {
      assert.equal(event.seq, index + 1, "sequences must be contiguous and in order");
      const expectedHash = createHash("sha256").update(Buffer.from(event.content ?? "", "utf8")).digest("hex");
      assert.equal(event.content_hash, expectedHash, `content hash does not recompute for seq ${event.seq}`);
      assert.equal(event.byte_length, Buffer.byteLength(event.content ?? "", "utf8"));
    }

    // The links must hold across the replayed stream.
    for (let index = 1; index < thread.length; index += 1) {
      assert.equal(
        thread[index]!.prev_hash,
        thread[index - 1]!.content_hash,
        `link broken at seq ${thread[index]!.seq}`,
      );
    }
  });

  it("reproduces the same chain verdict from a fresh read, so replay is repeatable", async () => {
    const read = async () =>
      h.db.withRequest(
        {
          tenant: h.tenantId,
          principal: "system:replay",
          scopeIds: [h.scopeId],
          purposes: [...h.purposes],
          action: "ledger:replay",
        },
        (executor) => h.ledger.verifyChain(executor, { tenant: h.tenantId, streamId: "thread:replay" }),
      );
    const first = await read();
    const second = await read();
    assert.deepEqual(first, second, "two reads of an unchanged stream must agree");
    assert.equal(first.ok, true);
    assert.equal(first.checked, 4);
  });

  it("digests the same logical event identically regardless of key order", () => {
    // Canonicalisation is what makes a rebuild byte-identical rather than
    // merely equivalent, and it is the property the projection digests rest on.
    const a = canonicalize({ z: 1, a: { b: [1, 2, 3], c: null } });
    const b = canonicalize({ a: { c: null, b: [1, 2, 3] }, z: 1 });
    assert.equal(a, b);
  });

  it("reads back the exact bytes of a non-ASCII payload, which is what spans point at", async () => {
    const content = "Multi-byte content: café — naïve — 東京.";
    const receipt = await h.ledger.append({
      stream_id: "thread:utf8",
      origin: "user",
      actor_id: "user:alice",
      scope: { tenant: h.tenantSlug, project: "payments", user: "alice", purpose: [...h.purposes] },
      occurred_at: "2026-09-10T11:00:00Z",
      content,
    });
    const event = await h.db.withRequest(
      {
        tenant: h.tenantId,
        principal: "system:replay",
        scopeIds: [h.scopeId],
        purposes: [...h.purposes],
        action: "ledger:replay",
      },
      (executor) => h.ledger.readEvent(executor, receipt.event_id),
    );
    assert.equal(event?.content, content, "the payload must round-trip byte for byte");
    assert.equal(event?.byte_length, Buffer.byteLength(content, "utf8"));
    assert.notEqual(event?.byte_length, content.length, "the byte length differs from the string length, which is why spans count bytes");
  });

  it("is not disturbed by an idempotent replay of an existing write", async () => {
    const before = await h.db.withRequest(
      { tenant: h.tenantId, principal: "system:replay", scopeIds: [h.scopeId], purposes: [...h.purposes] },
      (executor) => executor.query<{ n: number }>("SELECT count(*)::int AS n FROM events WHERE stream_id = 'thread:replay'"),
    );

    await h.ledger.append({
      stream_id: "thread:replay",
      idempotency_key: "big-1",
      origin: "document",
      actor_id: "doc:spec",
      scope: { tenant: h.tenantSlug, project: "payments", user: "alice", purpose: [...h.purposes] },
      occurred_at: "2026-09-10T10:00:00Z",
      content: "x".repeat(20_000),
    });

    const after = await h.db.withRequest(
      { tenant: h.tenantId, principal: "system:replay", scopeIds: [h.scopeId], purposes: [...h.purposes] },
      (executor) => executor.query<{ n: number }>("SELECT count(*)::int AS n FROM events WHERE stream_id = 'thread:replay'"),
    );
    assert.equal(after.rows[0]?.n, before.rows[0]?.n, "a replay of an existing key must not extend the stream");
  });

  void ensureScope;
});

describe("tenant derivation", () => {
  let h: Harness;
  before(async () => {
    h = await harness("tenant-derivation");
  });
  after(async () => {
    await h.close();
  });

  it("is idempotent, so passing a slug or its derived id lands in the same partition", async () => {
    // The bug this asserts against: `append` resolved the slug, then `ensureScope`
    // resolved the result again, so a caller passing a slug wrote under
    // `resolveTenantId(resolveTenantId(slug))` — a valid partition it could not predict
    // and its own read path would never look in.
    const once = resolveTenantId(h.tenantSlug);
    assert.equal(resolveTenantId(once), once, "resolving an already-resolved tenant must be a no-op");

    const a = await h.ledger.append({
      stream_id: "s",
      origin: "user",
      actor_id: "user:alice",
      scope: { tenant: h.tenantSlug, project: "payments", user: "alice", purpose: ["p"] },
      occurred_at: "2026-09-10T00:00:00Z",
      content: "written with a slug",
    });
    const b = await h.ledger.append({
      stream_id: "s2",
      origin: "user",
      actor_id: "user:alice",
      scope: { tenant: once, project: "payments", user: "alice", purpose: ["p"] },
      occurred_at: "2026-09-10T00:00:00Z",
      content: "written with the derived id",
    });
    assert.equal(
      a.scope.tenant_id,
      b.scope.tenant_id,
      "a slug and its derived id must resolve to the same tenant, not to two partitions",
    );
  });

  it("records the slug a caller used, not an intermediate id", async () => {
    const rows = await h.db.withSystemContext({ tenant: h.tenantId, actor: "test" }, (executor) =>
      executor.query<{ slug: string }>(`SELECT slug FROM tenants WHERE tenant_id = $1::uuid`, [h.tenantId]),
    );
    assert.equal(rows.rows[0]?.slug, h.tenantSlug, "the tenants table must map the slug a caller used");
  });
});
