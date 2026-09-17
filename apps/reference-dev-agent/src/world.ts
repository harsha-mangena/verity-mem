/**
 * The reference workload's world: tenants, drivers, and the two read helpers the
 * scenario needs.
 *
 * Two things here are the reason this file exists rather than the scenario
 * inlining them.
 *
 * **A driver seam.** The scenario must run identically from `src/main.ts` against
 * the real worker and from `src/reference.test.ts` in-process, and the only
 * difference between those two is how the outbox gets drained. `WorkerDriver` is
 * that difference and nothing else, so the test asserts the behaviour of the demo
 * rather than the behaviour of a re-implementation of the demo. Both drivers build
 * the *same* processors and the *same* claim loop.
 *
 * **A fresh tenant per run with a seeded id generator.** The ledger is append-only
 * and ids are primary keys, so a fixed tenant *and* a fixed seed would collide on
 * the second run against the same database. The tenant is therefore fresh — which
 * is how every suite in this repository isolates — while the seed is printed and
 * re-runnable against a fresh tenant.
 */
import { createHash } from "node:crypto";
import { Db, FilesystemBlobStore, Ledger, resolveTenantId, type Clock, type IdGenerator, type OutboxProcessor } from "@veritymem/ledger";
import { DEFAULT_COMMIT_POLICY } from "@veritymem/contracts";
import { CommitGate, LexicalEntailmentBackend } from "@veritymem/gate";
import { DETERMINISTIC_EXTRACTORS, IngestPipeline, type Extractor } from "@veritymem/model-adapters";
import { HashEmbeddingBackend, createProjectionProcessor } from "@veritymem/retrieval";
import { createClaimLoop } from "../../worker/src/claim-loop.ts";
import { createOutboxRunner } from "../../worker/src/outbox-runner.ts";

/** Purposes the reference project writes and reads under. */
export const PROJECT_PURPOSES = ["release_planning"] as const;

/**
 * The embedding backend, built once per run and shared by the projection writer and
 * the retrieval reader.
 *
 * This is not tidiness. `denseChannel` filters on `claim_embeddings.model_id`, so a
 * reader whose backend reports a different model id than the writer's retrieves
 * **nothing at all** — no error, no warning, an empty packet that looks exactly like
 * an authorization denial. The hash backend appends its dimension count to whatever
 * model id it is given, so passing `model_id` on one side and `modelId` + dimensions
 * on the other is enough to produce that silent split. One instance, one id.
 */
export function createEmbeddings(): HashEmbeddingBackend {
  return new HashEmbeddingBackend({ dimensions: 1024, modelId: "hash-ngram-v1-1024" });
}

export interface World {
  readonly db: Db;
  readonly ledger: Ledger;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly tenantSlug: string;
  readonly tenantId: string;
  readonly project: string;
  close(): Promise<void>;
}

export interface WorldOptions {
  readonly tenantSlug: string;
  readonly project: string;
  readonly databaseUrl: string;
  readonly blobDir: string;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** Build a world. No tenant row is written here; the first append registers it. */
export function createWorld(options: WorldOptions): World {
  const db = new Db({
    connectionString: options.databaseUrl,
    max: 6,
    applicationName: "veritymem-reference-dev-agent",
  });
  const ledger = new Ledger({
    db,
    blobs: new FilesystemBlobStore(options.blobDir),
    clock: options.clock,
    ids: options.ids,
  });
  return {
    db,
    ledger,
    ids: options.ids,
    clock: options.clock,
    tenantSlug: options.tenantSlug,
    tenantId: resolveTenantId(options.tenantSlug),
    project: options.project,
    close: () => db.close(),
  };
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

export interface DrainSummary {
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly cycles: number;
}

export interface WorkerDriver {
  /** Drain the outbox for the scenario's tenant, and say how much work it saw. */
  drain(): Promise<DrainSummary>;
}

/**
 * The worker's own code path: the processors from `buildProcessors`, driven by the
 * runner `apps/worker/src/main.ts` uses.
 */
export function createRunnerDriver(world: World, embeddings: HashEmbeddingBackend = createEmbeddings()): WorkerDriver {
  const runner = createOutboxRunner({
    db: world.db,
    processors: buildProcessors(world, embeddings),
    tenantIds: [world.tenantId],
    batchSize: 25,
  });

  return {
    async drain(): Promise<DrainSummary> {
      let claimed = 0;
      let completed = 0;
      let failed = 0;
      let cycles = 0;
      for (let index = 0; index < 50; index += 1) {
        cycles += 1;
        const summary = await runner.runCycle();
        claimed += summary.claimed;
        completed += summary.completed;
        failed += summary.failed;
        if (summary.claimed === 0) break;
      }
      return { claimed, completed, failed, cycles };
    },
  };
}

/**
 * The same processors through the bare claim loop, with no cycle wrapper.
 *
 * Kept because it is the smaller surface: a failure here is in the claim loop or a
 * processor, and a failure that reproduces only under `createRunnerDriver` is in
 * the cycle wrapper. Having both makes that distinction observable instead of
 * guessed.
 */
export function createClaimLoopDriver(world: World, embeddings: HashEmbeddingBackend = createEmbeddings()): WorkerDriver {
  const loop = createClaimLoop({
    db: world.db,
    processors: buildProcessors(world, embeddings),
    actor: "reference-dev-agent:worker",
  });

  return {
    async drain(): Promise<DrainSummary> {
      let claimed = 0;
      let completed = 0;
      let failed = 0;
      let cycles = 0;
      for (let index = 0; index < 50; index += 1) {
        cycles += 1;
        const summary = await loop.runOnce(world.tenantId, 25);
        claimed += summary.claimed;
        completed += summary.completed;
        failed += summary.failed;
        if (summary.claimed === 0) break;
      }
      return { claimed, completed, failed, cycles };
    },
  };
}

// ---------------------------------------------------------------------------
// Processors and the gate
// ---------------------------------------------------------------------------

/**
 * The processors the worker registers, with no model extractor.
 *
 * Deterministic extraction only, and that is a property of the workload rather than
 * a shortcut: the reference workload's claim is that commits, CI results, issue
 * decisions and tool outputs give *mechanically checkable* authority, and a model
 * call would make every decision depend on an endpoint a reviewer does not have.
 * The pipeline records "no model extractor configured; deterministic extraction
 * only" on every event, so the run does not pretend otherwise.
 */
export function buildProcessors(
  world: World,
  embeddings: HashEmbeddingBackend,
  modelExtractor: Extractor | null = null,
): OutboxProcessor[] {
  const pipeline = new IngestPipeline({
    db: world.db,
    ledger: world.ledger,
    gate: createGate(world),
    ids: world.ids,
    clock: world.clock,
    deterministicExtractors: DETERMINISTIC_EXTRACTORS,
    modelExtractor,
  });
  return [
    {
      kind: "extract.event",
      async handle(message): Promise<void> {
        const eventId = message.payload["event_id"];
        if (typeof eventId !== "string") {
          throw new Error(`extract.event message ${message.outbox_id} carries no event_id`);
        }
        const event = await world.ledger.readEvent(world.db, eventId);
        if (!event) throw new Error(`event ${eventId} is not visible in this request context`);
        await pipeline.ingest(world.db, event);
      },
    },
    // The projection processor comes from `@veritymem/retrieval` unchanged. Only
    // accepted claims reach it, because the ingest pipeline enqueues `project.claim`
    // only for a decision that produced a claim. It shares the caller's embedding
    // instance, so its `model_id` cannot differ from the reader's.
    createProjectionProcessor({ db: world.db, embeddings }),
  ];
}

/** The commit gate, with the versioned policy document rather than a local copy. */
export function createGate(world: World): CommitGate {
  return new CommitGate({
    db: world.db,
    ledger: world.ledger,
    ids: world.ids,
    clock: world.clock,
    entailment: new LexicalEntailmentBackend({
      floor: DEFAULT_COMMIT_POLICY.thresholds.lexicalEntailmentFloor,
    }),
    policy: DEFAULT_COMMIT_POLICY,
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ScopeVisibility {
  readonly scope_id: string;
  readonly project: string | null;
  readonly user: string | null;
  /** Claim ids in this scope whose predicate matches. Empty means the scope is blind to it. */
  readonly matching_claims: readonly string[];
}

/**
 * What a principal can see when bound to the scopes the planner authorized.
 *
 * This is the raw authorization read, underneath every channel: it binds exactly the
 * scope ids `resolveScopes` produced and asks the database which claims with a given
 * predicate are visible. Nothing filters after retrieval, so a non-empty result here
 * *is* reachability — which is why a cross-user probe has to check it directly rather
 * than inferring isolation from an empty packet. An empty packet can also mean the
 * query text did not match, the purpose was wrong, or the claim expired, and all
 * three look identical from the outside.
 */
export async function scopeVisibility(
  world: World,
  input: {
    readonly principal: string;
    readonly scopeIds: readonly string[];
    readonly purposes: readonly string[];
    readonly predicate: string;
  },
): Promise<readonly ScopeVisibility[]> {
  if (input.scopeIds.length === 0) return [];
  return world.db.withRequest(
    {
      tenant: world.tenantId,
      principal: input.principal,
      scopeIds: input.scopeIds,
      purposes: [...input.purposes],
      action: "reference:visibility",
    },
    async (executor) => {
      const rows = await executor.query<{
        scope_id: string;
        project: string | null;
        user_id: string | null;
        claim_id: string;
      }>(
        `SELECT s.scope_id, s.project, s.user_id, c.claim_id
           FROM claims c
           JOIN scopes s ON s.scope_id = c.scope_id
          WHERE c.predicate = $1
          ORDER BY s.user_id NULLS FIRST, c.claim_id ASC`,
        [input.predicate],
      );
      const byScope = new Map<string, { project: string | null; user: string | null; claims: string[] }>();
      for (const row of rows.rows) {
        const entry = byScope.get(row.scope_id) ?? { project: row.project, user: row.user_id, claims: [] };
        entry.claims.push(toPublicId("clm", row.claim_id));
        byScope.set(row.scope_id, entry);
      }
      return [...byScope.entries()].map(([scopeId, entry]) => ({
        scope_id: scopeId,
        project: entry.project,
        user: entry.user,
        matching_claims: entry.claims,
      }));
    },
  );
}

export interface Counts {
  readonly claims: number;
  readonly decisions: number;
  readonly completed_outbox: number;
  readonly failed_outbox: number;
  readonly projected: number;
}

/** Table counts for this tenant, read under a tenant-wide system context. */
export async function counts(world: World): Promise<Counts> {
  return world.db.withSystemContext({ tenant: world.tenantId, actor: "reference:counts" }, async (executor) => {
    const result = await executor.query<{
      claims: number;
      decisions: number;
      completed_outbox: number;
      failed_outbox: number;
      projected: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM claims)                                AS claims,
         (SELECT count(*)::int FROM decisions)                             AS decisions,
         (SELECT count(*)::int FROM outbox WHERE completed_at IS NOT NULL) AS completed_outbox,
         (SELECT count(*)::int FROM outbox WHERE last_error IS NOT NULL)   AS failed_outbox,
         (SELECT count(*)::int FROM claim_embeddings)                      AS projected`,
    );
    const row = result.rows[0];
    return {
      claims: Number(row?.claims ?? 0),
      decisions: Number(row?.decisions ?? 0),
      completed_outbox: Number(row?.completed_outbox ?? 0),
      failed_outbox: Number(row?.failed_outbox ?? 0),
      projected: Number(row?.projected ?? 0),
    };
  });
}

/** Evidence rows for one claim, read the way `/explain` reads them. */
export interface EvidenceRow {
  readonly span_id: string;
  readonly event_id: string;
  readonly start: number;
  readonly end: number;
  readonly role: string;
  readonly quote: string | null;
  readonly digest: string;
  readonly digest_ok: boolean;
  readonly redacted: boolean;
}

/**
 * Read a claim's evidence with its spans re-resolved and digests re-verified.
 *
 * Deliberately not cached and deliberately not read from the packet: the digest is
 * recomputed here from the stored payload bytes, so a demo that says "the evidence
 * still resolves" has checked rather than remembered. Redaction is reported instead
 * of hidden, which is what makes the retention step's output honest.
 */
export async function readEvidence(world: World, claimId: string): Promise<EvidenceRow[]> {
  return world.db.withSystemContext({ tenant: world.tenantId, actor: "reference:explain" }, async (executor) => {
    const rows = await executor.query<{
      span_id: string;
      event_id: string;
      start_off: number;
      end_off: number;
      role: string;
      span_digest: Buffer;
      payload: string | null;
      redacted_at: Date | null;
    }>(
      `SELECT s.span_id, s.event_id, s.start_off, s.end_off, ce.role, s.span_digest,
              e.payload, e.redacted_at
         FROM claim_evidence ce
         JOIN evidence_spans s ON s.span_id = ce.span_id
         JOIN events e ON e.event_id = s.event_id
        WHERE ce.claim_id = $1::uuid
        ORDER BY s.start_off ASC`,
      [stripPrefix(claimId)],
    );
    return rows.rows.map((row) => {
      const start = Number(row.start_off);
      const end = Number(row.end_off);
      const digest = row.span_digest.toString("hex");
      if (row.payload === null) {
        return {
          span_id: row.span_id,
          event_id: row.event_id,
          start,
          end,
          role: row.role,
          quote: null,
          digest,
          digest_ok: false,
          redacted: row.redacted_at !== null,
        };
      }
      const slice = Buffer.from(row.payload, "utf8").subarray(start, end);
      return {
        span_id: row.span_id,
        event_id: row.event_id,
        start,
        end,
        role: row.role,
        quote: slice.toString("utf8"),
        digest,
        digest_ok: sha256Hex(slice) === digest,
        redacted: false,
      };
    });
  });
}

export interface DecisionRow {
  readonly decision_id: string;
  readonly claim_id: string | null;
  readonly candidate_id: string | null;
  readonly outcome: string;
  readonly reason_codes: readonly string[];
  readonly policy_version: string;
  readonly decided_at: string;
}

/**
 * The decisions recorded after the first `offset` ones, in decision order.
 *
 * An offset rather than a timestamp, because the scenario must be able to say
 * exactly which decisions its own write produced: a timestamp comparison loses
 * microseconds through `Date`, and re-deriving a boundary from measured times is how
 * a demo starts reporting a neighbouring step's work as its own. The order is
 * `(decided_at, decision_id)`, which is stable because `decided_at` is stamped from
 * the injected clock and the id breaks any tie within one instant.
 */
export async function decisionsSince(world: World, offset: number): Promise<DecisionRow[]> {
  return world.db.withSystemContext({ tenant: world.tenantId, actor: "reference:decisions" }, async (executor) => {
    const rows = await executor.query<{
      decision_id: string;
      claim_id: string | null;
      candidate_id: string | null;
      outcome: string;
      reason_codes: string[];
      policy_version: string;
      decided_at: Date;
    }>(
      `SELECT decision_id, claim_id, candidate_id, outcome::text AS outcome, reason_codes,
              policy_version, decided_at
         FROM decisions
        ORDER BY decided_at ASC, decision_id ASC
        OFFSET $1`,
      [offset],
    );
    return rows.rows.map((row) => ({
      decision_id: toPublicId("dec", row.decision_id),
      claim_id: row.claim_id === null ? null : toPublicId("clm", row.claim_id),
      candidate_id: row.candidate_id === null ? null : toPublicId("cnd", row.candidate_id),
      outcome: row.outcome,
      reason_codes: row.reason_codes,
      policy_version: row.policy_version,
      decided_at: row.decided_at.toISOString(),
    }));
  });
}

/**
 * The review burden: the fraction of gate decisions that demanded a human.
 *
 * `needs_review` and `quarantine` both stop an unattended agent, so both count. The
 * denominator is every decision the gate recorded in the tenant, read from the table
 * rather than accumulated by the caller — a driver that reported its own numbers
 * could report a flattering one.
 *
 * It is computed over *decisions*, not events, because a review item is a decision:
 * one event with four candidates that all need review is four items of human work.
 */
export async function reviewBurden(world: World): Promise<{
  total_decisions: number;
  review_required: number;
  fraction: number;
  by_outcome: Record<string, number>;
}> {
  return world.db.withSystemContext({ tenant: world.tenantId, actor: "reference:review-burden" }, async (executor) => {
    const rows = await executor.query<{ outcome: string; n: number }>(
      `SELECT outcome::text AS outcome, count(*)::int AS n FROM decisions GROUP BY 1 ORDER BY 1`,
    );
    const byOutcome: Record<string, number> = {};
    let total = 0;
    for (const row of rows.rows) {
      byOutcome[row.outcome] = Number(row.n);
      total += Number(row.n);
    }
    const reviewRequired = (byOutcome["needs_review"] ?? 0) + (byOutcome["quarantine"] ?? 0);
    return {
      total_decisions: total,
      review_required: reviewRequired,
      fraction: total === 0 ? 0 : reviewRequired / total,
      by_outcome: byOutcome,
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `evt_<uuid>` from a Postgres uuid, matching `toPublicId` in the ledger. */
export function toPublicId(prefix: string, value: string): string {
  const hex = value.includes("-") ? value.replace(/-/g, "") : value;
  return `${prefix}_${hex}`;
}

function stripPrefix(id: string): string {
  const underscore = id.indexOf("_");
  const body = underscore >= 0 ? id.slice(underscore + 1) : id;
  if (body.includes("-")) return body;
  if (body.length !== 32) return body;
  return [
    body.slice(0, 8),
    body.slice(8, 12),
    body.slice(12, 16),
    body.slice(16, 20),
    body.slice(20, 32),
  ].join("-");
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
