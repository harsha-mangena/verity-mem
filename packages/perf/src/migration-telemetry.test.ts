/**
 * Telemetry: what is recorded, how it is folded, and how it is serialised.
 *
 * The sampler is exercised against a scripted client rather than a live server, because the
 * interesting behaviour is arithmetic over a sample series — how a lock wait accumulates, how
 * a blocked session's duration is bounded — and a test that had to arrange real lock
 * contention to check a sum would be slower and less precise than one that states the series.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MigrationSampler,
  assertJsonSafe,
  serialiseTelemetry,
  summariseSamples,
  takeServerSnapshot,
  walBetween,
  type ActivitySample,
  type TelemetryQueryClient,
} from "./migration-telemetry.ts";
import { setTimeout as delay } from "node:timers/promises";

/** A client that answers from a script, keyed by a fragment of the statement. */
class ScriptedClient implements TelemetryQueryClient {
  private readonly answers: readonly { readonly match: string; readonly rows: readonly unknown[] }[];
  readonly seen: string[] = [];

  constructor(answers: readonly { readonly match: string; readonly rows: readonly unknown[] }[]) {
    this.answers = answers;
  }

  async query<R extends Record<string, unknown>>(
    text: string,
    _params?: unknown[],
  ): Promise<{ rows: R[] }> {
    this.seen.push(text);
    const answer = this.answers.find((entry) => text.includes(entry.match));
    if (answer === undefined) throw new Error(`the script has no answer for: ${text.slice(0, 60)}`);
    return { rows: answer.rows as R[] };
  }
}

const activity = (
  rows: readonly { pid: number; wait_event_type: string | null; query?: string }[],
): readonly Record<string, unknown>[] =>
  rows.map((row) => ({
    pid: row.pid,
    wait_event_type: row.wait_event_type,
    wait_event: row.wait_event_type === "Lock" ? "transactionid" : null,
    statement_elapsed_ms: row.wait_event_type === "Lock" ? "1500" : "3",
    query: row.query ?? "SELECT 1",
  }));

const locks = (
  rows: readonly {
    pid: number;
    locktype?: string;
    mode: string;
    granted: boolean;
    relation?: string | null;
  }[],
): readonly Record<string, unknown>[] =>
  rows.map((row) => ({
    pid: row.pid,
    locktype: row.locktype ?? "relation",
    mode: row.mode,
    granted: row.granted,
    relation: row.relation ?? "claims",
  }));

describe("folding a sample series", () => {
  const sample = (overrides: Partial<ActivitySample>): ActivitySample => ({
    at_ms: 0,
    at: "2026-09-22T00:00:00.000Z",
    migration_waiting_on_lock: false,
    migration_locks: [],
    blocked: [],
    error: null,
    ...overrides,
  });

  it("returns an empty summary for an empty series, not a zero-filled one", () => {
    const summary = summariseSamples([], { interval_ms: 200, blocked_threshold_ms: 1_000 });
    assert.equal(summary.samples, 0);
    assert.equal(summary.lock_acquisition_wait_ms, 0);
    assert.equal(summary.effective_interval_ms, null);
    assert.deepEqual(summary.locks_held, []);
    assert.deepEqual(summary.blocked_sessions, []);
  });

  it("reports the interval it actually sampled at, not only the configured one", () => {
    // A migration that commits in tens of milliseconds is sampled during the warm-up window,
    // so the configured interval would not describe what happened.
    const summary = summariseSamples(
      [sample({ at_ms: 0 }), sample({ at_ms: 20 }), sample({ at_ms: 40 }), sample({ at_ms: 60 })],
      { interval_ms: 200, blocked_threshold_ms: 1_000, warmup_ms: 500 },
    );
    assert.equal(summary.interval_ms, 200);
    assert.equal(summary.effective_interval_ms, 20);
    assert.equal(summary.warmup_ms, 500);
  });

  it("counts each granted lock mode once per sample it was held in", () => {
    const summary = summariseSamples(
      [
        sample({
          at_ms: 0,
          migration_locks: [
            { locktype: "relation", mode: "AccessExclusiveLock", relation: "claims", granted: true },
            { locktype: "virtualxid", mode: "ExclusiveLock", relation: "", granted: true },
          ],
        }),
        sample({
          at_ms: 200,
          migration_locks: [
            { locktype: "relation", mode: "AccessExclusiveLock", relation: "claims", granted: true },
          ],
        }),
        sample({ at_ms: 400 }),
      ],
      { interval_ms: 200, blocked_threshold_ms: 1_000 },
    );
    const exclusive = summary.locks_held.find((lock) => lock.mode === "AccessExclusiveLock");
    assert.equal(exclusive?.samples_observed, 2);
    assert.equal(exclusive?.relation, "claims");
    assert.equal(summary.locks_held.find((lock) => lock.mode === "ExclusiveLock")?.samples_observed, 1);
  });

  it("accumulates lock wait over the intervals the migration was waiting", () => {
    // Three samples at 200 ms intervals, the middle two waiting: one full interval of wait.
    const summary = summariseSamples(
      [
        sample({ at_ms: 0 }),
        sample({ at_ms: 200, migration_waiting_on_lock: true }),
        sample({ at_ms: 400, migration_waiting_on_lock: true }),
        sample({ at_ms: 600 }),
      ],
      { interval_ms: 200, blocked_threshold_ms: 1_000 },
    );
    assert.equal(summary.lock_acquisition_wait_ms, 400);
    assert.deepEqual(summary.lock_wait_windows, [{ from_ms: 200, to_ms: 600 }]);
  });

  it("weights the final sample by nothing, because its interval was never observed", () => {
    const summary = summariseSamples(
      [sample({ at_ms: 0 }), sample({ at_ms: 200, migration_waiting_on_lock: true })],
      { interval_ms: 200, blocked_threshold_ms: 1_000 },
    );
    assert.equal(summary.lock_acquisition_wait_ms, 0);
    assert.deepEqual(summary.lock_wait_windows, []);
  });

  it("keeps two separate wait windows apart", () => {
    const summary = summariseSamples(
      [
        sample({ at_ms: 0, migration_waiting_on_lock: true }),
        sample({ at_ms: 100 }),
        sample({ at_ms: 200, migration_waiting_on_lock: true }),
        sample({ at_ms: 300 }),
      ],
      { interval_ms: 100, blocked_threshold_ms: 1_000 },
    );
    assert.deepEqual(summary.lock_wait_windows, [
      { from_ms: 0, to_ms: 100 },
      { from_ms: 200, to_ms: 300 },
    ]);
    assert.equal(summary.lock_acquisition_wait_ms, 200);
  });

  it("records a blocked session with its longest observed statement, once", () => {
    const blocked = {
      pid: 42,
      mode: "AccessExclusiveLock",
      relation: "claim_entities",
      statement_elapsed_ms: 1_500,
      query_sample: "INSERT INTO claim_entities ...",
    };
    const summary = summariseSamples(
      [
        sample({ at_ms: 0, blocked: [blocked] }),
        sample({ at_ms: 100, blocked: [{ ...blocked, statement_elapsed_ms: 2_500 }] }),
        sample({ at_ms: 200, blocked: [{ ...blocked, statement_elapsed_ms: 900 }] }),
        sample({ at_ms: 300 }),
      ],
      { interval_ms: 100, blocked_threshold_ms: 1_000 },
    );
    assert.equal(summary.blocked_sessions.length, 1);
    assert.equal(summary.blocked_sessions[0]?.pid, 42);
    // Three sampled intervals with the session waiting, each weighted by the gap to the next
    // sample: 100 + 100 + 100.
    assert.equal(summary.blocked_sessions[0]?.observed_waiting_ms, 300);
    // The maximum, not the last: a statement that waited 2.5 s waited 2.5 s.
    assert.equal(summary.blocked_sessions[0]?.max_statement_elapsed_ms, 2_500);
  });

  it("counts only sessions whose longest statement exceeded the threshold", () => {
    const entry = (pid: number, elapsed: number) => ({
      pid,
      mode: "ShareLock",
      relation: "claims",
      statement_elapsed_ms: elapsed,
      query_sample: "SELECT",
    });
    const summary = summariseSamples(
      [
        sample({ at_ms: 0, blocked: [entry(1, 2_000), entry(2, 100), entry(3, 1_000)] }),
        sample({ at_ms: 100 }),
      ],
      { interval_ms: 100, blocked_threshold_ms: 1_000 },
    );
    assert.equal(summary.blocked_sessions.length, 3);
    // Strictly greater: exactly at the threshold is not "longer than the threshold".
    assert.equal(summary.statements_blocked_over_threshold, 1);
  });

  it("names a lock the sampler could not resolve, rather than reporting an empty string", () => {
    const summary = summariseSamples(
      [
        sample({
          at_ms: 0,
          migration_locks: [
            { locktype: "relation", mode: "AccessExclusiveLock", relation: "oid:16401", granted: true },
          ],
        }),
        sample({ at_ms: 20 }),
      ],
      { interval_ms: 200, blocked_threshold_ms: 1_000 },
    );
    assert.equal(summary.locks_held[0]?.relation, "oid:16401");
  });

  it("carries sampling errors through rather than hiding them", () => {
    const summary = summariseSamples([sample({ at_ms: 0, error: "connection reset" })], {
      interval_ms: 100,
      blocked_threshold_ms: 1_000,
      errors: ["connection reset"],
    });
    assert.deepEqual(summary.sampling_errors, ["connection reset"]);
  });
});

describe("the migration sampler", () => {
  it("observes the migration backend's locks and a blocked session on a timer", async () => {
    const client = new ScriptedClient([
      {
        match: "FROM pg_stat_activity",
        rows: activity([
          { pid: 99, wait_event_type: null },
          { pid: 42, wait_event_type: "Lock", query: "INSERT INTO claim_entities VALUES (...)" },
        ]),
      },
      {
        match: "FROM pg_locks",
        rows: locks([
          { pid: 99, mode: "AccessExclusiveLock", granted: true, relation: "claims" },
          { pid: 42, mode: "AccessExclusiveLock", granted: false, relation: "claims" },
        ]),
      },
    ]);
    const sampler = new MigrationSampler({
      client,
      migration_pid: 99,
      interval_ms: 20,
      blocked_threshold_ms: 1_000,
    });
    await sampler.start();
    await delay(120);
    const summary = await sampler.stop();

    assert.ok(summary.samples >= 1, `expected at least one sample, got ${summary.samples}`);
    assert.equal(summary.interval_ms, 20);
    assert.equal(
      summary.locks_held.some((lock) => lock.mode === "AccessExclusiveLock"),
      true,
      "the migration's own lock was not recorded",
    );
    // The migration itself is never reported as blocked by its own lock.
    assert.equal(summary.blocked_sessions.some((entry) => entry.pid === 99), false);
    assert.equal(summary.blocked_sessions[0]?.pid, 42);
    assert.deepEqual(summary.sampling_errors, []);
  });

  it("accumulates a wait when the migration is the one blocked", async () => {
    const client = new ScriptedClient([
      { match: "FROM pg_stat_activity", rows: activity([{ pid: 99, wait_event_type: "Lock" }]) },
      {
        match: "FROM pg_locks",
        rows: locks([{ pid: 99, mode: "ShareLock", granted: false, relation: "events" }]),
      },
    ]);
    const sampler = new MigrationSampler({
      client,
      migration_pid: 99,
      interval_ms: 20,
      blocked_threshold_ms: 1_000,
    });
    await sampler.start();
    await delay(120);
    const summary = await sampler.stop();
    assert.ok(
      summary.lock_acquisition_wait_ms > 0,
      `expected a sampled wait, got ${summary.lock_acquisition_wait_ms}`,
    );
    assert.equal(summary.locks_held.length, 0, "an ungranted lock is not a held lock");
  });
});

describe("serialising the report", () => {
  it("accepts JSON-safe values and refuses the ones JSON would change", () => {
    assert.doesNotThrow(() => assertJsonSafe({ a: 1, b: "x", c: null, d: [true, 2.5] }));
    assert.throws(() => assertJsonSafe({ a: 1n }), /\$\.a is a BigInt/);
    assert.throws(() => assertJsonSafe({ a: Number.NaN }), /\$\.a is NaN/);
    assert.throws(() => assertJsonSafe({ a: Number.POSITIVE_INFINITY }), /\$\.a is Infinity/);
    assert.throws(() => assertJsonSafe({ a: undefined }), /\$\.a is undefined/);
    assert.throws(() => assertJsonSafe({ a: new Date() }), /\$\.a is a Date/);
  });

  it("names the exact path of an offending value", () => {
    assert.throws(
      () => assertJsonSafe({ telemetry: [{ wal: { bytes_generated: 5n } }] }),
      /\$\.telemetry\[0\]\.wal\.bytes_generated is a BigInt/,
    );
  });

  it("round-trips a telemetry record unchanged", () => {
    const record = {
      name: "0015_claim_entity_index.sql",
      elapsed_ms: 27,
      outcome: "committed",
      error: null,
      wal: { lsn_before: "10/6DF4BBF8", lsn_after: "10/6DF4FA90", bytes_generated: 16024, error: null },
      claim_entities: { present_before: false, rows_backfilled: 769 },
      locks_held: [{ locktype: "relation", mode: "AccessExclusiveLock", relation: "claims", samples_observed: 2 }],
      blocked_sessions: [],
      sampling: { samples: 2, interval_ms: 200, lock_wait_windows: [], sampling_errors: [] },
    };
    const text = serialiseTelemetry(record);
    assert.deepEqual(JSON.parse(text), record);
  });

  it("refuses to write a record that would lose a measurement on the way out", () => {
    assert.throws(
      () => serialiseTelemetry({ rows_backfilled: 0, sampled_wait: Number.NaN }),
      /which JSON would write as null/,
    );
    // A measured zero, by contrast, serialises: zero is a fact, null is an absence.
    assert.equal(JSON.parse(serialiseTelemetry({ rows_backfilled: 0 })).rows_backfilled, 0);
  });
});

describe("taking a server snapshot", () => {
  const baseAnswer = (
    rows: readonly Record<string, unknown>[],
  ): { match: string; rows: readonly unknown[] } => ({
    match: "pg_current_wal_lsn",
    rows,
  });

  it("reads sizes, WAL position and temporary-file counters", async () => {
    const client = new ScriptedClient([
      baseAnswer([
        {
          lsn: "16/B374D848",
          database_size_bytes: "1048576",
          temp_files: "3",
          temp_bytes: "8192",
          migration_rows: "15",
          claim_entities_present: false,
        },
      ]),
    ]);
    const snapshot = await takeServerSnapshot(client, "before 0015");
    assert.equal(snapshot.lsn, "16/B374D848");
    assert.equal(snapshot.database_size_bytes, 1_048_576);
    assert.equal(snapshot.temp_files, 3);
    assert.equal(snapshot.temp_bytes, 8_192);
    assert.equal(snapshot.claim_entities_present, false);
    assert.equal(snapshot.claim_entities_rows, null);
    assert.equal(snapshot.error, null);
  });

  it("reads the projection's size and rows when the table exists", async () => {
    const client = new ScriptedClient([
      baseAnswer([
        {
          lsn: "16/B374D848",
          database_size_bytes: "2097152",
          temp_files: "0",
          temp_bytes: "0",
          migration_rows: "15",
          claim_entities_present: true,
        },
      ]),
      { match: "pg_total_relation_size", rows: [{ total: "524288", indexes: "262144", rows: "769" }] },
    ]);
    const snapshot = await takeServerSnapshot(client, "after 0015");
    assert.equal(snapshot.claim_entities_total_bytes, 524_288);
    assert.equal(snapshot.claim_entities_index_bytes, 262_144);
    assert.equal(snapshot.claim_entities_rows, 769);
  });

  it("reports a failed snapshot as an error instead of a snapshot of nulls", async () => {
    const client = new ScriptedClient([]);
    const snapshot = await takeServerSnapshot(client, "after 0015");
    assert.equal(snapshot.lsn, null);
    assert.match(snapshot.error ?? "", /^after 0015: the script has no answer/);
  });
});

describe("the WAL half of a telemetry record", () => {
  const snapshot = (lsn: string | null) => ({
    at: "2026-09-22T00:00:00.000Z",
    lsn,
    database_size_bytes: 1,
    temp_files: 0,
    temp_bytes: 0,
    claim_entities_present: false,
    claim_entities_total_bytes: null,
    claim_entities_index_bytes: null,
    claim_entities_rows: null,
    schema_migrations_rows: 15,
    error: null,
  });

  it("computes the difference when both positions were read", () => {
    const wal = walBetween(snapshot("16/100"), snapshot("16/200"));
    assert.equal(wal.bytes_generated, 256);
    assert.equal(wal.error, null);
  });

  it("refuses to compute a difference from a missing reading", () => {
    const wal = walBetween(snapshot("16/100"), snapshot(null));
    assert.equal(wal.bytes_generated, null);
    assert.match(wal.error ?? "", /could not be read/);
    assert.equal(wal.lsn_after, null);
  });

  it("carries the reason the difference could not be computed", () => {
    const wal = walBetween(snapshot("16/200"), snapshot("16/100"));
    assert.equal(wal.bytes_generated, null);
    assert.match(wal.error ?? "", /moved backwards/);
  });
});
