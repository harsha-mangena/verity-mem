/**
 * Worker tests.
 *
 * Two things are asserted here and nothing else, because they are the two things
 * about this app that a reader cannot check by reading `@veritymem/ledger`:
 *
 *   1. the processors are registered under the kinds the write path enqueues, with
 *      the message shapes those kinds carry — a wrong kind string is a worker that
 *      claims every message and processes none, and `OutboxWorker` only discovers
 *      that at runtime, one failed message at a time;
 *   2. the batch log line is one JSON object per line carrying claimed, completed,
 *      failed, the per-kind breakdown and projection lag, because that line is the
 *      worker's only interface.
 *
 * Claiming, completing, backoff and dispatch are asserted in
 * `packages/ledger/src/outbox.test.ts`, against the same database this file would
 * use. Duplicating them here would test the package twice and this app not at all.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_COMMIT_POLICY } from "@veritymem/contracts";
import { Db, Ledger, MemoryBlobStore, fixedClock, loadEnv, resolveTenantId, seededIds } from "@veritymem/ledger";
import { createLogger } from "./log.ts";
import { EXTRACT_KIND, createEntailmentBackend, createGate, createIngestProcessor, createModelExtractor } from "./processors.ts";
import { readProjectionLag } from "./outbox-runner.ts";
import { shouldBackOff } from "./main.ts";

describe("worker processors", () => {
  it("registers the kinds the write path enqueues", async () => {
    const db = new Db({ connectionString: loadEnv().databaseUrl, max: 2 });
    try {
      const ledger = new Ledger({
        db,
        blobs: new MemoryBlobStore(),
        clock: fixedClock(),
        ids: seededIds(`worker-test-${Date.now()}`),
      });
      const entailment = await createEntailmentBackend({
        db,
        ledger,
        ids: seededIds("worker-test-gate"),
        clock: fixedClock(),
        backend: "lexical",
        modelPath: null,
        modelSha256: null,
        lexicalFloor: DEFAULT_COMMIT_POLICY.thresholds.lexicalEntailmentFloor,
      });
      const gate = createGate({ db, ledger, ids: seededIds("worker-test-gate-2"), clock: fixedClock(), entailment });
      const ingest = createIngestProcessor({
        db,
        ledger,
        gate,
        ids: seededIds("worker-test-ingest"),
        clock: fixedClock(),
        modelExtractor: null,
      });

      // `extract.event` is what `Ledger.append` enqueues. A mismatch here would leave
      // every appended event permanently unextracted.
      assert.equal(ingest.kind, EXTRACT_KIND);
      assert.equal(EXTRACT_KIND, "extract.event");
      // The projection kind belongs to the retrieval package, so it is read from the
      // processor that package builds rather than hardcoded here: this app registers
      // two kinds and a drift in either one is a worker that claims messages it cannot
      // process.
      const { createProjectionProcessor, HashEmbeddingBackend } = await import("@veritymem/retrieval");
      const projection = createProjectionProcessor({ db, embeddings: new HashEmbeddingBackend({ dimensions: 1024 }) });
      assert.equal(projection.kind, "project.claim");
      assert.notEqual(projection.kind, ingest.kind, "the two kinds must be distinct or dispatch cannot work");
    } finally {
      await db.close();
    }
  });

  it("returns null rather than an unavailable model extractor", () => {
    // Null is a supported deployment and the pipeline records it on every event
    // ("no model extractor configured; deterministic extraction only"). Building an
    // extractor around an unavailable adapter would produce the same empty result
    // with no such note, which is the difference between a cheap deployment and a
    // broken one.
    assert.equal(createModelExtractor({ baseUrl: null, apiKey: null, model: null }), null);
    assert.equal(createModelExtractor({ baseUrl: "http://127.0.0.1:1", apiKey: null, model: null }), null);
    assert.equal(createModelExtractor({ baseUrl: null, apiKey: null, model: "gpt-4o-mini" }), null);
    assert.ok(createModelExtractor({ baseUrl: "http://127.0.0.1:1", apiKey: null, model: "gpt-4o-mini" }) !== null);
  });

  it("takes its entailment floor from the versioned policy rather than a local default", async () => {
    const db = new Db({ connectionString: loadEnv().databaseUrl, max: 2 });
    try {
      const ledger = new Ledger({
        db,
        blobs: new MemoryBlobStore(),
        clock: fixedClock(),
        ids: seededIds(`worker-test-floor-${Date.now()}`),
      });
      const backend = await createEntailmentBackend({
        db,
        ledger,
        ids: seededIds("worker-test-floor"),
        clock: fixedClock(),
        backend: "lexical",
        modelPath: null,
        modelSha256: null,
        lexicalFloor: DEFAULT_COMMIT_POLICY.thresholds.lexicalEntailmentFloor,
      });
      // The backend's own name carries the floor it was constructed with, so a
      // deployment running a gate that no `decisions.policy_version` row describes is
      // visible in `worker.start` rather than inferred.
      assert.match(backend.name, /lexical-overlap@1/);
      assert.match(backend.name, new RegExp(String(DEFAULT_COMMIT_POLICY.thresholds.lexicalEntailmentFloor)));
      assert.equal(backend.modelSha256, null, "the lexical backend is a stand-in and must not claim a model hash");
    } finally {
      await db.close();
    }
  });
});

describe("projection lag", () => {
  it("is zero for a tenant with nothing pending, and is read through the privileged function", async () => {
    const env = loadEnv();
    const db = new Db({ connectionString: env.databaseUrl, max: 2 });
    try {
      const { OutboxWorker } = await import("@veritymem/ledger");
      const tenantId = resolveTenantId(`worker-lag-${Date.now()}`);
      const worker = new OutboxWorker(db, [], { tenants: [tenantId] });
      // A tenant that has never written has nothing pending. The value matters less
      // than the path: this goes through `veritymem.outbox_lag`, and a count taken
      // under the tenant policy on an unbound connection would be zero here *and*
      // zero on a real backlog, which is a metric that always looks healthy.
      assert.equal(await readProjectionLag(worker, [tenantId]), 0);
      assert.equal(await worker.lag(tenantId), 0);
      assert.equal(await readProjectionLag(worker, []), 0, "no tenants means no lag to report, not a global lag");
    } finally {
      await db.close();
    }
  });
});

describe("batch logging", () => {
  it("emits one JSON object per line with the batch counts and the lag", () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: "veritymem-worker-test",
      sink: (line) => lines.push(line),
      now: () => new Date("2026-09-17T12:00:00.000Z"),
    });
    logger.info("worker.batch", {
      claimed: 3,
      completed: 2,
      failed: 1,
      kinds: { "extract.event": 2, "project.claim": 1 },
      projection_lag_pending: 7,
    });

    assert.equal(lines.length, 1, "one log call is one line");
    assert.ok(!lines[0]!.includes("\n"), "a log line must not contain a newline, or JSON-per-line stops being parseable");
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(parsed["level"], "info");
    assert.equal(parsed["service"], "veritymem-worker-test");
    assert.equal(parsed["msg"], "worker.batch");
    assert.equal(parsed["ts"], "2026-09-17T12:00:00.000Z");
    assert.deepEqual(parsed["kinds"], { "extract.event": 2, "project.claim": 1 });
    assert.equal(parsed["projection_lag_pending"], 7);
    // Sorted keys, so two lines describing the same event diff cleanly.
    assert.deepEqual(Object.keys(parsed), ["ts", "level", "service", "msg", "claimed", "completed", "failed", "kinds", "projection_lag_pending"]);
  });
});

describe("worker polling", () => {
  it("drains a real backlog immediately but backs off for retry-delayed rows", () => {
    assert.equal(
      shouldBackOff({ claimed: 25, completed: 25, failed: 0, kinds: {}, projection_lag: 50 }),
      false,
      "a productive cycle with queued work must not pay the poll interval",
    );
    assert.equal(
      shouldBackOff({ claimed: 0, completed: 0, failed: 0, kinds: {}, projection_lag: 1 }),
      true,
      "a retry-delayed row must not cause a busy loop",
    );
    assert.equal(
      shouldBackOff({ claimed: 1, completed: 1, failed: 0, kinds: {}, projection_lag: 0 }),
      true,
      "an empty queue should use the idle poll interval",
    );
    assert.equal(shouldBackOff(null), true, "a failed cycle should back off before retrying the database");
  });
});
