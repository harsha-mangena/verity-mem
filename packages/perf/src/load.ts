/**
 * The bulk loader.
 *
 * ## The honest statement about what this bypasses
 *
 * **A synthetic bulk insert bypasses the write path. This benchmark therefore
 * measures the read path only, and it says nothing about the commit gate, the
 * extraction pipeline, the review burden, or the outbox.** The v0.1 latency target
 * is a *query* target — "p95 non-LLM query under 250 ms at one million accepted
 * claims" — so the read path is the thing under test. Producing the same rows
 * through `Ledger.append` + `IngestPipeline` + `CommitGate` would add hours of
 * extraction and entailment work and would leave the measured claim rows identical,
 * because the gate's product is a row in `claims` with a status, an authority class
 * and a verified evidence span. That is exactly what this loader writes, and it
 * writes **no `decisions` row and no `candidates` row**: a reader of the generated
 * dataset must not be able to mistake it for evidence that the gate ran.
 *
 * The loader connects with the migration/owner URL and writes under
 * `veritymem.set_system_context`, i.e. it is a maintenance path, not a request. The
 * benchmark's *read* path runs on the ordinary RLS-bound application connection and
 * goes through `compose()`.
 *
 * ## Resumability
 *
 * Two mechanisms, deliberately belt and braces:
 *
 *   1. **Derived keys.** Every primary key is `corpusUuid(tenant, label, index)`, so
 *      re-running any phase re-inserts the same keys and conflicts instead of
 *      duplicating. Inserts use `ON CONFLICT DO NOTHING` where a conflict is
 *      expected on resume.
 *   2. **A sidecar checkpoint.** `load-state.json` records the phase and the index
 *      reached, so a resumed run starts where the last one stopped instead of
 *      re-deriving a million rows to discover they exist. A lost or stale
 *      checkpoint costs time, never correctness, because of (1).
 *
 * Batches are sized per phase from the column count rather than as one number,
 * because PostgreSQL's parameter limit is per statement: a 400-row `claims` batch
 * and a 400-row `claim_embeddings` batch differ by an order of magnitude in bytes.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";
import { HashEmbeddingBackend, toVectorLiteral } from "@veritymem/retrieval";
import {
  BENCH_PRINCIPAL,
  BENCH_PROJECT,
  BENCH_PURPOSE,
  BENCH_USER_COUNT,
  corpusUuid,
  generateClaim,
  type CorpusClaim,
  type CorpusOptions,
} from "./corpus.ts";

const { Pool } = pg;

/** Order of load phases. Resumption is only ever forward, within this list. */
export const LOAD_PHASES = [
  "events",
  "spans",
  "claims",
  "claim_evidence",
  "embeddings",
  "relations",
  "aliases",
  "claim_entities",
] as const;
export type LoadPhase = (typeof LOAD_PHASES)[number];

export interface LoadCheckpoint {
  readonly tenant_slug: string;
  readonly corpus_seed: string;
  readonly claims_requested: number;
  readonly anchor: string;
  readonly embedding_model_id: string;
  readonly embedding_dimensions: number;
  /** `1` = complete; any other number = the next index to process. */
  readonly phases: Record<string, number>;
  readonly started_at: string;
  readonly updated_at: string;
}

export interface ScopeRow {
  readonly scopeIndex: number;
  readonly scopeId: string;
  readonly userId: string | null;
  readonly project: string | null;
}

export interface LoadOptions {
  readonly migrationUrl: string;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly claims: number;
  readonly corpusSeed: string;
  readonly anchor: Date;
  readonly embeddingModelId: string;
  readonly embeddingDimensions: number;
  readonly statePath: string;
  /** Rows per INSERT per phase. Zero uses the built-in defaults. */
  readonly batchSize?: number;
  /** Progress callback. Called after each committed batch. */
  readonly onProgress?: (progress: LoadProgress) => void;
}

export interface LoadProgress {
  readonly phase: LoadPhase;
  readonly done: number;
  readonly total: number;
  readonly elapsed_ms: number;
  readonly rows_per_second: number;
}

export interface TableCount {
  readonly table: string;
  readonly rows: number;
}

export interface LoadResult {
  readonly tenant_id: string;
  readonly tenant_slug: string;
  readonly scopes: readonly ScopeRow[];
  readonly elapsed_ms: number;
  readonly resumed_from: LoadPhase | null;
  readonly counts: readonly TableCount[];
}

/** Rows per statement, chosen so one statement is at most a couple of megabytes. */
function batchRows(phase: LoadPhase, override: number | undefined): number {
  if (override !== undefined && override > 0) return override;
  switch (phase) {
    case "events":
      return 500;
    case "spans":
      return 1_000;
    case "claims":
      return 400;
    case "claim_evidence":
      return 2_000;
    case "embeddings":
      return 50;
    case "relations":
      return 1_000;
    case "aliases":
      return 2_000;
    case "claim_entities":
      return 2_000;
  }
}

function readState(path: string): LoadCheckpoint | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LoadCheckpoint;
  } catch {
    return null;
  }
}

function writeState(path: string, state: LoadCheckpoint): void {
  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename: a checkpoint that is half-written when the process is killed
  // must not be readable, or a resumed run starts at an index it never reached.
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

interface Chunk {
  readonly values: string;
  readonly params: unknown[];
}

/**
 * Build multi-row `VALUES` clauses for one batch.
 *
 * Rows are chunked so that no single statement exceeds PostgreSQL's 65 535
 * parameter ceiling. Hitting that ceiling is a hard error at the end of a long load,
 * which is why it is computed here rather than tuned by hand at each call site.
 */
function chunks(columnsPerRow: number, rows: readonly unknown[][]): Chunk[] {
  const maxRows = Math.max(1, Math.floor(60_000 / Math.max(1, columnsPerRow)));
  const out: Chunk[] = [];
  for (let start = 0; start < rows.length; start += maxRows) {
    const slice = rows.slice(start, start + maxRows);
    const params: unknown[] = [];
    const tuples: string[] = [];
    for (const row of slice) {
      const placeholders: string[] = [];
      for (const value of row) {
        params.push(value);
        placeholders.push(`$${params.length}`);
      }
      tuples.push(`(${placeholders.join(",")})`);
    }
    out.push({ values: tuples.join(","), params });
  }
  return out;
}

/**
 * How many claims to materialise in memory at once.
 *
 * A generated claim is roughly a kilobyte, so 4 000 is a few megabytes of transient
 * garbage per batch rather than a million-row array that would defeat the point of
 * batching. It is also the unit of resumable progress.
 */
const GENERATION_WINDOW = 4_000;

/** Next index for a phase, from the checkpoint. `null` means the phase is complete. */
function resumeIndex(state: LoadCheckpoint | null, phase: LoadPhase): number | null {
  if (!state) return 0;
  const value = Number(state.phases[phase] ?? 0);
  if (value === 1) return null;
  return value;
}

function markPhase(
  state: LoadCheckpoint,
  phase: LoadPhase,
  index: number,
  done: boolean,
): LoadCheckpoint {
  return {
    ...state,
    phases: { ...state.phases, [phase]: done ? 1 : index },
    updated_at: new Date().toISOString(),
  };
}

interface PhaseContext {
  readonly tenantId: string;
  readonly corpusSeed: string;
  readonly embeddingModelId: string;
  readonly embeddingDimensions: number;
  readonly scopes: readonly ScopeRow[];
}

interface PhaseSpec {
  readonly phase: LoadPhase;
  readonly sql: string;
  readonly columnsPerRow: number;
  /** Rows this claim contributes. Empty when the claim contributes nothing. */
  readonly rows: (claim: CorpusClaim, context: PhaseContext) => unknown[][];
  readonly writer?: (
    claims: readonly CorpusClaim[],
    client: pg.PoolClient,
    context: PhaseContext,
  ) => Promise<void>;
}

/**
 * Load the corpus.
 *
 * Idempotent for a given `(tenant slug, seed, claim count)`: running it twice
 * inserts nothing the second time. Growing the requested count later appends the
 * missing tail, because every claim's identity depends only on its index.
 */
export async function loadCorpus(options: LoadOptions): Promise<LoadResult> {
  const started = Date.now();
  const pool = new Pool({
    connectionString: options.migrationUrl,
    max: 2,
    application_name: "veritymem-perf-loader",
    statement_timeout: 0,
  });
  const existing = readState(options.statePath);
  const resumable =
    existing !== null &&
    existing.tenant_slug === options.tenantSlug &&
    existing.corpus_seed === options.corpusSeed &&
    existing.anchor === options.anchor.toISOString() &&
    existing.embedding_model_id === options.embeddingModelId &&
    existing.embedding_dimensions === options.embeddingDimensions &&
    existing.claims_requested <= options.claims;

  let state: LoadCheckpoint = resumable
    ? { ...existing, claims_requested: options.claims }
    : {
        tenant_slug: options.tenantSlug,
        corpus_seed: options.corpusSeed,
        claims_requested: options.claims,
        anchor: options.anchor.toISOString(),
        embedding_model_id: options.embeddingModelId,
        embedding_dimensions: options.embeddingDimensions,
        phases: {},
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
  const resumedFrom = resumable
    ? (LOAD_PHASES.find((phase) => resumeIndex(state, phase) !== null) ?? null)
    : null;

  const client = await pool.connect();
  try {
    await client.query(`SELECT veritymem.ensure_tenant($1::uuid, $2)`, [
      options.tenantId,
      options.tenantSlug,
    ]);
    const scopes = await ensureScopes(client, options.tenantId);
    const context: PhaseContext = {
      tenantId: options.tenantId,
      corpusSeed: options.corpusSeed,
      embeddingModelId: options.embeddingModelId,
      embeddingDimensions: options.embeddingDimensions,
      scopes,
    };

    for (const spec of phaseSpecs(context)) {
      state = await runPhase(client, state, spec, options, context);
    }

    // Verify the load actually landed, rather than trusting that the phases ran.
    //
    // `runPhase` commits and checkpoints after each batch, so a phase reaching its final
    // index means the statements were accepted -- not that they inserted anything. Every
    // corpus insert ends in `ON CONFLICT ... DO NOTHING`, which reports success while
    // writing zero rows, and that is exactly what happened here: the primary keys were
    // derived from the corpus seed instead of the tenant, so the second tenant to use a
    // seed had every `events` row discarded by `ON CONFLICT (event_id) DO NOTHING`. The
    // loader printed seven completed phases and a throughput figure for each. The
    // benchmark then failed with "tenant holds no claims", which reads as a corpus
    // problem and is a loader defect.
    //
    // A loader that reports success while writing nothing is the failure this project
    // exists to prevent, so this is an error rather than a warning. It runs on the same
    // client, inside the same tenant, so it observes exactly what a reader will.
    const landed = await readCounts(client, options.tenantId);
    const emptyPhases = landed.filter((entry) => entry.rows === 0);
    if (emptyPhases.length > 0) {
      throw new Error(
        `the corpus did not land: ${emptyPhases.map((entry) => entry.table).join(", ")} ` +
          `hold no rows for tenant ${options.tenantSlug} after all phases reported complete. ` +
          `Every corpus insert uses ON CONFLICT DO NOTHING, so a collision on a derived ` +
          `primary key is silent. Check that the ids are derived from the tenant, not the ` +
          `corpus seed.`,
      );
    }

    // The dense projection's recorded model, so the retrieval channel's model-mismatch
    // guard sees the writer's id instead of an empty row and skipping the channel.
    await client.query(
      `INSERT INTO projection_versions (projection, tenant_id, code_version, model_version, ledger_watermark, updated_at)
       VALUES ('dense', $1::uuid, 'perf-corpus@1', $2,
               COALESCE((SELECT COALESCE(max(seq), 0) FROM events WHERE tenant_id = $1::uuid), 0), now())
       ON CONFLICT (projection, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid))
       DO UPDATE SET code_version = EXCLUDED.code_version,
                     model_version = EXCLUDED.model_version,
                     ledger_watermark = EXCLUDED.ledger_watermark,
                     updated_at = now()`,
      [options.tenantId, options.embeddingModelId],
    );

    return {
      tenant_id: options.tenantId,
      tenant_slug: options.tenantSlug,
      scopes,
      elapsed_ms: Date.now() - started,
      resumed_from: resumedFrom,
      counts: await readCounts(client, options.tenantId),
    };
  } finally {
    client.release();
    await pool.end();
  }
}

/** The phases, in dependency order. */
function phaseSpecs(context: PhaseContext): readonly PhaseSpec[] {
  const scopeOf = (claim: CorpusClaim): ScopeRow => {
    const scope = context.scopes[claim.scopeIndex];
    if (!scope) throw new Error(`no scope for user index ${claim.scopeIndex}`);
    return scope;
  };
  return [
    {
      phase: "events",
      columnsPerRow: 19,
      sql: `INSERT INTO events (
              event_id, stream_id, seq, tenant_id, scope_id, origin, actor_id,
              occurred_at, recorded_at, payload, payload_ref, content_hash, prev_hash, link_hash,
              chained, sensitivity, idempotency_key, media_type, byte_length
            ) VALUES %%VALUES%% ON CONFLICT (event_id) DO NOTHING`,
      rows: (claim) => [
        [
          claim.eventId,
          claim.streamId,
          claim.sequence,
          context.tenantId,
          scopeOf(claim).scopeId,
          claim.origin,
          claim.actorId,
          claim.validFrom,
          claim.recordedAt,
          claim.payload,
          null,
          Buffer.from(claim.contentHashHex, "hex"),
          null,
          null,
          false,
          "normal",
          null,
          "text/plain",
          Buffer.byteLength(claim.payload, "utf8"),
        ],
      ],
    },
    {
      phase: "spans",
      columnsPerRow: 7,
      sql: `INSERT INTO evidence_spans (
              span_id, event_id, start_off, end_off, selector, span_digest, quote
            ) VALUES %%VALUES%% ON CONFLICT (span_id) DO NOTHING`,
      rows: (claim) => [
        [
          claim.spanId,
          claim.eventId,
          claim.startOffset,
          claim.endOffset,
          null,
          Buffer.from(claim.spanDigestHex, "hex"),
          claim.payload.slice(claim.startOffset, claim.endOffset),
        ],
      ],
    },
    {
      phase: "claims",
      columnsPerRow: 17,
      sql: `INSERT INTO claims (
              claim_id, tenant_id, scope_id, kind, subject, predicate, object, status, authority,
              valid_from, valid_to, recorded_at, expires_at, origin_event_id, extractor,
              model_version, prompt_version
            ) VALUES %%VALUES%% ON CONFLICT (claim_id) DO NOTHING`,
      rows: (claim) => [
        [
          claim.claimId,
          context.tenantId,
          scopeOf(claim).scopeId,
          claim.kind,
          claim.subject,
          claim.predicate,
          claim.objectJson,
          claim.status,
          claim.authority,
          claim.validFrom,
          claim.validTo,
          claim.recordedAt,
          null,
          claim.eventId,
          "perf-corpus@1",
          context.embeddingModelId,
          "none",
        ],
      ],
    },
    {
      phase: "claim_evidence",
      columnsPerRow: 3,
      sql: `INSERT INTO claim_evidence (claim_id, span_id, role)
            VALUES %%VALUES%% ON CONFLICT (claim_id, span_id) DO NOTHING`,
      rows: (claim) => [[claim.claimId, claim.spanId, "supports"]],
    },
    {
      // `HashEmbeddingBackend` is the projection the retrieval package itself uses for
      // the dense channel, not a stand-in invented here: running the real backend keeps
      // the vectors in the same space as the query vector, so the HNSW index is
      // measuring the projection the system actually queries.
      phase: "embeddings",
      columnsPerRow: 4,
      sql: `INSERT INTO claim_embeddings (claim_id, tenant_id, embedding, model_id)
            VALUES %%VALUES%% ON CONFLICT (claim_id) DO NOTHING`,
      rows: () => [],
      writer: async (claims, client, ctx) => {
        const embeddings = new HashEmbeddingBackend({
          dimensions: ctx.embeddingDimensions,
          modelId: ctx.embeddingModelId,
        });
        const vectors = await embeddings.embed(claims.map((claim) => claim.embeddingText));
        const values = claims.map((claim, position) => {
          const vector = vectors[position];
          if (!vector) throw new Error(`embedding backend returned no vector for index ${claim.index}`);
          return [claim.claimId, ctx.tenantId, toVectorLiteral(vector), ctx.embeddingModelId];
        });
        for (const chunk of chunks(4, values)) {
          await client.query(
            `INSERT INTO claim_embeddings (claim_id, tenant_id, embedding, model_id)
             VALUES ${chunk.values} ON CONFLICT (claim_id) DO NOTHING`,
            chunk.params,
          );
        }
      },
    },
    {
      // Only the *later* claim of a pair carries the edge, so the pair is emitted once
      // and the foreign key to the earlier claim is satisfied by construction.
      phase: "relations",
      columnsPerRow: 3,
      sql: `INSERT INTO claim_relations (from_claim, to_claim, rel)
            VALUES %%VALUES%% ON CONFLICT (from_claim, to_claim, rel) DO NOTHING`,
      rows: (claim, ctx) =>
        claim.contradictsIndex === null
          ? []
          : [[claim.claimId, corpusUuid(ctx.tenantId, "clm", claim.contradictsIndex), "contradicts"]],
    },
    {
      // Two aliases per claim (its subject and its object). `entity_aliases` has no
      // claim reference, so this is a projection and not a fact about the claim; it is
      // what makes the entity channel's join return rows at all.
      phase: "aliases",
      columnsPerRow: 5,
      sql: `INSERT INTO entity_aliases (tenant_id, alias, canonical, source, confidence)
            VALUES %%VALUES%% ON CONFLICT (tenant_id, alias, canonical) DO NOTHING`,
      rows: (claim, ctx) => [
        [ctx.tenantId, claim.subject.toLowerCase(), claim.subject.toLowerCase(), "perf_corpus", 1],
        [ctx.tenantId, claim.objectText.toLowerCase(), claim.objectText.toLowerCase(), "perf_corpus", 1],
      ],
    },
    {
      // The dictionary above resolves alias -> canonical. This inverted projection
      // resolves canonical -> claim without scanning the tenant's claim population.
      phase: "claim_entities",
      columnsPerRow: 5,
      sql: `INSERT INTO claim_entities (tenant_id, canonical, claim_id, source, confidence)
            VALUES %%VALUES%% ON CONFLICT (tenant_id, canonical, claim_id) DO NOTHING`,
      rows: (claim, ctx) => [
        [ctx.tenantId, claim.subject.toLowerCase(), claim.claimId, "perf_corpus", 1],
        [ctx.tenantId, claim.objectText.toLowerCase(), claim.claimId, "perf_corpus", 1],
      ],
    },
  ];
}

/**
 * Run one load phase in fixed-size batches, committing each batch and checkpointing
 * after it.
 *
 * Each batch is its own transaction. One transaction over a million rows would hold
 * a single snapshot for the whole load, grow WAL without bound and make the load
 * unresumable — the opposite of what a resumable loader is for.
 */
async function runPhase(
  client: pg.PoolClient,
  state: LoadCheckpoint,
  spec: PhaseSpec,
  options: LoadOptions,
  context: PhaseContext,
): Promise<LoadCheckpoint> {
  const phaseStart = Date.now();
  const resumeAt = resumeIndex(state, spec.phase);
  if (resumeAt === null) return state;

  const total = options.claims;
  const batchSize = batchRows(spec.phase, options.batchSize);
  const corpusOptions: CorpusOptions = {
    seed: options.corpusSeed,
    // Identity comes from the tenant so two tenants can hold the same corpus without
    // colliding on the global `events.event_id` primary key.
    tenantId: context.tenantId,
    anchor: options.anchor,
  };
  let index = resumeAt;
  let written = 0;
  let current = state;

  while (index < total) {
    const end = Math.min(index + Math.max(batchSize, GENERATION_WINDOW), total);
    const claims: CorpusClaim[] = [];
    for (let claimIndex = index; claimIndex < end; claimIndex += 1) {
      claims.push(generateClaim(claimIndex, corpusOptions));
    }

    await client.query("BEGIN");
    try {
      if (spec.writer) {
        await spec.writer(claims, client, context);
      } else {
        const values: unknown[][] = [];
        for (const claim of claims) {
          for (const row of spec.rows(claim, context)) values.push(row);
        }
        for (const chunk of chunks(spec.columnsPerRow, values)) {
          await client.query(spec.sql.replace("%%VALUES%%", chunk.values), chunk.params);
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    written += end - index;
    index = end;
    current = markPhase(current, spec.phase, index, index >= total);
    writeState(options.statePath, current);
    options.onProgress?.({
      phase: spec.phase,
      done: index,
      total,
      elapsed_ms: Date.now() - phaseStart,
      rows_per_second: Math.round(written / Math.max(0.001, (Date.now() - phaseStart) / 1000)),
    });
  }
  return current;
}

async function ensureScopes(client: pg.PoolClient, tenantId: string): Promise<ScopeRow[]> {
  const scopes: ScopeRow[] = [];
  const project = await client.query<{ scope_id: string }>(
    `SELECT scope_id FROM veritymem.ensure_scope($1::uuid, $2, NULL, NULL, NULL, $3::text[])`,
    [tenantId, BENCH_PROJECT, [BENCH_PURPOSE]],
  );
  const projectScopeId = project.rows[0]?.scope_id;
  if (!projectScopeId) throw new Error("ensure_scope returned no project scope id");
  // The project scope is where the benchmark caller participates. Membership is
  // recorded through the same SECURITY DEFINER function the write path uses, so the
  // planner resolves reach from server-owned state rather than from the request.
  await client.query(`SELECT veritymem.record_participation($1::uuid, $2, $3::uuid)`, [
    tenantId,
    BENCH_PRINCIPAL,
    projectScopeId,
  ]);

  for (let userIndex = 0; userIndex < BENCH_USER_COUNT; userIndex += 1) {
    const userId = `user:eng-${String(userIndex).padStart(2, "0")}`;
    const result = await client.query<{ scope_id: string }>(
      `SELECT scope_id FROM veritymem.ensure_scope($1::uuid, $2, $3, NULL, NULL, $4::text[])`,
      [tenantId, BENCH_PROJECT, userId, [BENCH_PURPOSE]],
    );
    const scopeId = result.rows[0]?.scope_id;
    if (!scopeId) throw new Error(`ensure_scope returned no scope id for ${userId}`);
    await client.query(`SELECT veritymem.record_participation($1::uuid, $2, $3::uuid)`, [
      tenantId,
      `agent:perf-writer-${userIndex % 8}`,
      scopeId,
    ]);
    scopes.push({ scopeIndex: userIndex, scopeId, userId, project: BENCH_PROJECT });
  }
  return scopes;
}

/** Row counts for the benchmark tenant, read with an unbound connection. */
export async function readCounts(
  client: pg.PoolClient,
  tenantId: string,
): Promise<readonly TableCount[]> {
  const result = await client.query<{ table_name: string; rows: number }>(
    `SELECT 'claims' AS table_name, count(*)::int AS rows FROM claims WHERE tenant_id = $1::uuid
     UNION ALL SELECT 'events', count(*)::int FROM events WHERE tenant_id = $1::uuid
     UNION ALL SELECT 'evidence_spans', count(*)::int FROM evidence_spans s
       JOIN events e ON e.event_id = s.event_id WHERE e.tenant_id = $1::uuid
     UNION ALL SELECT 'claim_evidence', count(*)::int FROM claim_evidence ce
       JOIN claims c ON c.claim_id = ce.claim_id WHERE c.tenant_id = $1::uuid
     UNION ALL SELECT 'claim_embeddings', count(*)::int FROM claim_embeddings WHERE tenant_id = $1::uuid
     UNION ALL SELECT 'claim_relations', count(*)::int FROM claim_relations r
       JOIN claims c ON c.claim_id = r.from_claim WHERE c.tenant_id = $1::uuid
     UNION ALL SELECT 'entity_aliases', count(*)::int FROM entity_aliases WHERE tenant_id = $1::uuid
     UNION ALL SELECT 'claim_entities', count(*)::int FROM claim_entities WHERE tenant_id = $1::uuid
     ORDER BY table_name`,
    [tenantId],
  );
  return result.rows.map((row) => ({ table: String(row.table_name), rows: Number(row.rows) }));
}

/** Table row counts on a fresh connection, for the CLI's `status` command. */
export async function countAll(migrationUrl: string, tenantId: string): Promise<readonly TableCount[]> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    const client = await pool.connect();
    try {
      return await readCounts(client, tenantId);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/**
 * Re-establish `streams.last_seq` for the corpus's stream ids.
 *
 * The loader writes events without going through `Ledger.append`, which is what
 * normally allocates a stream's sequence. Without this the `streams` table would
 * claim a stream is empty while a million events carry sequences in it, and a later
 * append into the same stream would collide on `(tenant_id, stream_id, seq)`. The
 * benchmark never appends, but a dataset that cannot be written to is a trap for
 * whoever runs the next experiment.
 */
export async function syncStreams(migrationUrl: string, tenantId: string): Promise<number> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    const result = await pool.query(
      `INSERT INTO streams (tenant_id, stream_id, last_seq)
       SELECT tenant_id, stream_id, max(seq) FROM events WHERE tenant_id = $1::uuid
        GROUP BY tenant_id, stream_id
       ON CONFLICT (tenant_id, stream_id) DO UPDATE SET last_seq = EXCLUDED.last_seq`,
      [tenantId],
    );
    return result.rowCount ?? 0;
  } finally {
    await pool.end();
  }
}

/**
 * Digest of a deterministic sample of the projection, so a report names the exact
 * dataset it measured instead of "a million claims".
 *
 * Sampled rather than exact: hashing the whole projection would add minutes to every
 * benchmark run to prove something the primary-key derivation already guarantees.
 */
export async function corpusDigest(
  migrationUrl: string,
  tenantId: string,
  sampleSize: number,
): Promise<{ readonly digest: string; readonly sampled: number }> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    const rows = await pool.query<{ line: string }>(
      `SELECT c.claim_id::text || '|' || c.status::text || '|' || c.subject || '|' || c.predicate
              || '|' || (c.object::text) || '|' || e.model_id AS line
         FROM claims c
         JOIN claim_embeddings e ON e.claim_id = c.claim_id
        WHERE c.tenant_id = $1::uuid
        ORDER BY c.claim_id
        LIMIT $2`,
      [tenantId, sampleSize],
    );
    const hash = createHash("sha256");
    for (const row of rows.rows) hash.update(`${row.line}\n`, "utf8");
    return { digest: hash.digest("hex"), sampled: rows.rows.length };
  } finally {
    await pool.end();
  }
}
