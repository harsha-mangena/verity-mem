/**
 * The outbox worker.
 *
 * This file exists because the worker failed silently in production shape and nothing
 * caught it. Migration 0009 enabled row-level security on `outbox` with a tenant
 * policy; the worker's claim path used `systemQuery`, which is *not* a bypass, so the
 * claim matched zero rows. `runOnce` returned `{claimed: 0}` and the worker reported
 * itself healthy forever, with 5,531 messages pending and invisible.
 *
 * The tests that should have caught it did not, because they exercised a private
 * claim loop written inside `apps/worker` rather than the package's `OutboxWorker`.
 * So the first test here is deliberately about the *package* class, and it asserts a
 * claim actually happens rather than asserting a summary object looks well-formed.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Db, Ledger, MemoryBlobStore, OutboxWorker, resolveTenantId, seededIds, fixedClock, loadEnv } from "./index.ts";
import type { OutboxProcessor } from "./outbox.ts";

interface Harness {
  readonly db: Db;
  readonly ledger: Ledger;
  readonly tenantSlug: string;
  readonly tenantId: string;
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
  const tenantSlug = `outbox-${Math.random().toString(36).slice(2, 10)}`;
  return { db, ledger, tenantSlug, tenantId: resolveTenantId(tenantSlug), close: () => db.close() };
}

/** Append one event, which enqueues exactly one `extract.event` message. */
async function enqueueOne(h: Harness, content = "I approved the Sunday 02:00 UTC deploy window.") {
  return h.ledger.append({
    stream_id: "s",
    origin: "user",
    actor_id: "user:alice",
    scope: { tenant: h.tenantSlug, project: "payments", user: "alice", purpose: ["release_planning"] },
    occurred_at: "2026-09-10T00:00:00Z",
    content,
  });
}

describe("outbox worker", () => {
  let h: Harness;

  before(async () => {
    h = await harness("outbox");
  });
  after(async () => {
    await h.close();
  });

  it("claims a message that the app role cannot see without a context", async () => {
    await enqueueOne(h);

    // The premise of the bug: an unbound read sees nothing, which is correct and is
    // why the claim path cannot use one.
    const unbound = await h.db.systemQuery<{ n: number }>(
      "SELECT count(*)::int AS n FROM outbox WHERE completed_at IS NULL",
    );
    assert.equal(unbound.rows[0]?.n, 0, "the tenant policy must still deny an unbound read");

    // The privileged path must see it.
    const lag = await new OutboxWorker(h.db, [], { tenants: [h.tenantId] }).lag(h.tenantId);
    assert.equal(lag, 1, "the privileged lag function must see the pending message");

    // And the worker must actually claim it. Asserting the summary's shape would have
    // passed while nothing happened; asserting `claimed > 0` is the whole point.
    const seen: string[] = [];
    const worker = new OutboxWorker(
      h.db,
      [
        {
          kind: "extract.event",
          async handle(message) {
            seen.push(String(message.payload["event_id"]));
            void message;
          },
        },
      ],
      { tenants: [h.tenantId] },
    );
    const summary = await worker.runOnce(5);
    assert.equal(summary.claimed, 1, `expected one claim, got ${JSON.stringify(summary)}`);
    assert.equal(summary.completed, 1);
    assert.equal(summary.failed, 0);
    assert.equal(seen.length, 1, "the processor must have run");

    // The message must be settled, not still pending.
    assert.equal(await worker.lag(h.tenantId), 0);
  });

  it("does not claim a message twice", async () => {
    const worker = new OutboxWorker(h.db, [{ kind: "extract.event", async handle() {} }], {
      tenants: [h.tenantId],
    });
    const first = await worker.runOnce(10);
    const second = await worker.runOnce(10);
    assert.equal(second.claimed, 0, `a completed message must not be re-claimed: ${JSON.stringify(second)}`);
    void first;
  });

  it("refuses a message that carries no scope, rather than reading nothing and reporting success", async () => {
    // Fabricate a message the enqueue path would never produce. The handler must not be
    // reached, because a handler bound without a scope reads nothing — which is the
    // class of bug this whole file exists for.
    const tenantRow = await h.db.withSystemContext({ tenant: h.tenantId, actor: "test" }, (executor) =>
      executor.query<{ scope_id: string }>("SELECT scope_id FROM scopes LIMIT 1"),
    );
    const scopeId = tenantRow.rows[0]?.scope_id;
    assert.ok(scopeId);

    await h.db.withSystemContext({ tenant: h.tenantId, actor: "test" }, (executor) =>
      executor.query(
        `INSERT INTO outbox (tenant_id, kind, payload)
         VALUES ($1::uuid, 'scopeless.message', $2::jsonb)`,
        [h.tenantId, JSON.stringify({ nothing: true })],
      ),
    );

    let handled = false;
    const worker = new OutboxWorker(
      h.db,
      [{ kind: "scopeless.message", async handle() { handled = true; } }],
      { tenants: [h.tenantId] },
    );
    const summary = await worker.runOnce(10);
    assert.equal(summary.claimed, 1);
    assert.equal(summary.failed, 1, "a scopeless message must fail loudly, not complete silently");
    assert.equal(handled, false, "the handler must not run without a binding");
  });

  it("reports the failure and retries with backoff instead of dropping the message", async () => {
    const receipt = await enqueueOne(h, "I approved the Tuesday 06:00 UTC window.");
    void receipt;

    let attempts = 0;
    const worker = new OutboxWorker(
      h.db,
      [
        {
          kind: "extract.event",
          async handle() {
            attempts += 1;
            throw new Error("synthetic failure");
          },
        },
      ],
      { tenants: [h.tenantId] },
    );
    const summary = await worker.runOnce(5);
    assert.equal(summary.failed, 1);
    assert.equal(attempts, 1);

    // It must still exist, with its error recorded, and be scheduled later rather than
    // immediately — an immediate retry would spin.
    const row = await h.db.withSystemContext({ tenant: h.tenantId, actor: "test" }, (executor) =>
      executor.query<{ attempts: number; last_error: string | null; available_at: Date }>(
        `SELECT attempts, last_error, available_at FROM outbox WHERE last_error = 'synthetic failure'`,
      ),
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0]?.attempts, 1);

    // And a second immediate drain must not pick it up.
    const second = await worker.runOnce(5);
    assert.equal(second.claimed, 0, "a backed-off message must not be re-claimed immediately");
  });

  it("surfaces an unknown message kind as a failure rather than deleting the work", async () => {
    await h.db.withSystemContext({ tenant: h.tenantId, actor: "test" }, (executor) =>
      executor.query(
        `INSERT INTO outbox (tenant_id, kind, payload)
         VALUES ($1::uuid, 'unregistered.kind', $2::jsonb)`,
        [h.tenantId, JSON.stringify({ scope_ids: ["00000000-0000-0000-0000-000000000000"], purposes: ["p"] })],
      ),
    );
    const worker = new OutboxWorker(h.db, [], { tenants: [h.tenantId] });
    const summary = await worker.runOnce(10);
    assert.equal(summary.claimed, 1);
    assert.equal(summary.failed, 1, "an unknown kind is a deployment skew, not a data problem to discard");
  });

  it("runs the processor inside a request context bound from the message", async () => {
    // The handler must be able to read the rows it is meant to process. This is the
    // property the projection worker silently lacked.
    const receipt = await enqueueOne(h, "The release passed CI.");
    let sawTenant: string | null = null;
    const worker = new OutboxWorker(
      h.db,
      [
        {
          kind: "extract.event",
          async handle(message) {
            const rows = await h.db.query<{ t: string }>(
              "SELECT current_setting('veritymem.tenant_id', true) AS t",
            );
            sawTenant = rows.rows[0]?.t ?? null;
            assert.equal(message.payload["event_id"], receipt.event_id);
          },
        } satisfies OutboxProcessor,
      ],
      { tenants: [h.tenantId] },
    );
    const summary = await worker.runOnce(5);
    assert.equal(summary.completed, 1, `processor should have run: ${JSON.stringify(summary)}`);
    assert.equal(sawTenant, h.tenantId, "the handler must run with the message's tenant bound");
  });
});
