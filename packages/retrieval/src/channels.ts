/**
 * Retrieval channels.
 *
 * Four independent signals, each returning its own score, and **no truth score**.
 * The channels are deliberately not blended into one number at this layer: a
 * lexical match and a vector near-neighbour are different kinds of evidence about
 * relevance, and collapsing them hides which one fired. Fusion happens later, on
 * ranks rather than scores, and the per-channel signals stay on the returned
 * claim.
 *
 * Every channel takes `authorized_scope_ids` as a required argument. There is no
 * overload that omits it, so a channel cannot be called before authorization
 * without the caller having to pass an explicitly empty array — which is a
 * visible act, not an oversight.
 */
import type { ClaimKind, TimeSpec } from "@veritymem/contracts";
import type { QueryExecutor } from "@veritymem/ledger";
import { toVectorLiteral, type EmbeddingBackend } from "./embeddings.ts";

export interface ChannelQuery {
  readonly tenant_id: string;
  readonly text: string;
  /**
   * The concrete scopes the caller holds, with their dimensions.
   *
   * Dimensions as well as ids, because the containment check is per-dimension and
   * it must run against the scope that actually reaches the row — not against the
   * union of everything any held scope reaches. A caller holding a project scope
   * and a user scope in the same project holds two grants; the union of their
   * closures would silently widen the user grant into the project.
   */
  readonly authorized_scopes: readonly {
    readonly scope_id: string;
    readonly project: string | null;
    readonly user_id: string | null;
    readonly agent_id: string | null;
    readonly session_id: string | null;
  }[];
  readonly purposes: readonly string[];
  readonly time: TimeSpec;
  readonly kinds: readonly ClaimKind[] | null;
  /** Caller-declared subjects. A hard filter, because the caller asked for it. */
  readonly subjects: readonly string[] | null;
  /** Query-derived entity vocabulary for the entity channel's alias lookup. */
  readonly entity_terms: readonly string[];
  readonly limit: number;
  readonly now: string;
}

export interface ChannelHit {
  readonly claim_id: string;
  readonly score: number;
  readonly channel: string;
}

export interface ChannelResult {
  readonly channel: string;
  readonly hits: readonly ChannelHit[];
  /** True when this channel ran at all, so an empty result is distinguishable from a skipped one. */
  readonly ran: boolean;
  readonly note: string | null;
  readonly duration_ms: number;
}

interface BuildResult {
  readonly where: string;
  readonly params: unknown[];
}

const EMPTY_SCOPE = "00000000-0000-0000-0000-000000000000";

function scopeArray(query: ChannelQuery): string[] {
  return query.authorized_scopes.length > 0
    ? query.authorized_scopes.map((scope) => scope.scope_id)
    : [EMPTY_SCOPE];
}

/**
 * SQL that computes the caller's reachable scope set.
 *
 * Because the containment rule is a directional predicate rather than a
 * transitive closure (see migration 0007), "everything this caller can reach" is
 * expressible as a single set-returning subquery: the caller's own scopes, plus
 * every scope those reach. For a project-scoped caller in a project with three
 * hundred user scopes that is three hundred and one ids, computed by the database
 * and tested with an array operator — a GIN-indexable predicate, and far cheaper
 * than calling a containment function once per candidate row on the read path.
 *
 * The dimension rule mirrors `veritymem.scope_contains` exactly. It is repeated in
 * SQL rather than called per row because the retrieval path cannot afford a
 * function call per candidate; the migration's self-check is what keeps the two
 * definitions honest.
 */
function reachableScopeIdsExpression(): string {
  // `rs.tenant_id = $1::uuid` rather than `= c.tenant_id`, and the difference is the
  // whole cost of the read path at scale.
  //
  // `c` is the *outer* claims table, so referencing it here made this expression
  // correlated: PostgreSQL re-evaluated the aggregate once per candidate row. Every
  // channel builds its WHERE clause from this expression, so every channel paid it.
  // Measured on a 1,190,477-claim corpus with the argument bound to the request's own
  // tenant:
  //
  //     rs.tenant_id = c.tenant_id   -> 13,862 ms   (loops=1000001)
  //     rs.tenant_id = $1::uuid      ->     286 ms
  //
  // It is also *equivalent*: the outer clauses already assert `c.tenant_id = $1::uuid`
  // (see `channelWhere`), so scopes belonging to any other tenant could never match.
  // `$1` is bound by `channelWhere` and is always the request's tenant.
  //
  // `$2` was already a parameter, which is why the reach set itself was cheap and the
  // correlation was invisible: the subquery looks parameterised, and the one reference
  // that made it per-row is a single column name.
  return `(
    SELECT array_agg(rs.scope_id)
      FROM scopes rs
     WHERE rs.tenant_id = $1::uuid
       AND EXISTS (
         SELECT 1
           FROM unnest($2::uuid[]) AS owned(scope_id)
           JOIN scopes os ON os.scope_id = owned.scope_id
          WHERE os.tenant_id = rs.tenant_id
            AND (os.project    IS NULL OR rs.project    IS NULL OR os.project    = rs.project)
            AND (os.user_id    IS NULL OR rs.user_id    IS NULL OR os.user_id    = rs.user_id)
            AND (os.agent_id   IS NULL OR rs.agent_id   IS NULL OR os.agent_id   = rs.agent_id)
            AND (os.session_id IS NULL OR rs.session_id IS NULL OR os.session_id = rs.session_id)
       )
  )`;
}

function channelWhere(query: ChannelQuery): BuildResult {
  // Parameters are appended positionally as each clause is added, so no channel
  // has to know how many placeholders another clause consumed. That is the whole
  // reason this builder exists rather than each channel assembling its own SQL: a
  // channel that miscounts a placeholder fails loudly, but a channel that forgets
  // the authorization clause fails silently and leaks.
  const params: unknown[] = [query.tenant_id, scopeArray(query), [...query.purposes]];
  const clauses: string[] = [
    "c.tenant_id = $1::uuid",
    // Authorization, applied as a set membership test against the caller's
    // containment closure. This runs *before* any relevance ranking, and the
    // channels never see a candidate outside it.
    `c.scope_id = ANY(${reachableScopeIdsExpression()}::uuid[])`,
    "s.purpose && $3::text[]",
    buildTimeClause(query.time, params),
  ];

  if (query.kinds && query.kinds.length > 0) {
    params.push([...query.kinds]);
    clauses.push(`c.kind = ANY($${params.length}::claim_kind[])`);
  }
  if (query.subjects && query.subjects.length > 0) {
    params.push([...query.subjects]);
    clauses.push(`c.subject = ANY($${params.length}::text[])`);
  }

  return { where: clauses.join(" AND "), params };
}

function buildTimeClause(time: TimeSpec, params: unknown[]): string {
  switch (time.mode) {
    case "current":
      return "c.valid_to IS NULL AND c.status = 'accepted'";
    case "as_of":
      params.push(time.as_of);
      return `c.recorded_at <= $${params.length}::timestamptz
              AND (c.valid_to IS NULL OR c.valid_to > $${params.length}::timestamptz)
              AND c.status IN ('accepted','superseded','expired')`;
    case "during":
      params.push(time.from);
      const fromIndex = params.length;
      params.push(time.to);
      const toIndex = params.length;
      return `c.valid_range && tstzrange($${fromIndex}::timestamptz, $${toIndex}::timestamptz, '[)')`;
    default: {
      const exhaustive: never = time;
      throw new Error(`unhandled time mode: ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Lexical
// ---------------------------------------------------------------------------

/**
 * Full-text search over the trigger-maintained `search_tsv`.
 *
 * `websearch_to_tsquery` is used rather than `to_tsquery` because it accepts
 * human input without raising on a stray operator, and a memory query is
 * human-authored text.
 */
export async function lexicalChannel(
  executor: QueryExecutor,
  query: ChannelQuery,
): Promise<ChannelResult> {
  const started = performance.now();
  const { where, params } = channelWhere(query);
  params.push(query.text);
  const textIndex = params.length;
  params.push(query.limit);
  const limitIndex = params.length;

  const result = await executor.query<{ claim_id: string; score: number }>(
    `SELECT c.claim_id, ts_rank(c.search_tsv, websearch_to_tsquery('english', $${textIndex})) AS score
       FROM claims c
       JOIN scopes s ON s.scope_id = c.scope_id
      WHERE ${where}
        AND c.search_tsv @@ websearch_to_tsquery('english', $${textIndex})
      ORDER BY score DESC, c.claim_id ASC
      LIMIT $${limitIndex}`,
    params,
  );

  return {
    channel: "lexical",
    hits: result.rows.map((row) => ({ claim_id: row.claim_id, score: Number(row.score), channel: "lexical" })),
    ran: true,
    note: null,
    duration_ms: round(performance.now() - started),
  };
}

// ---------------------------------------------------------------------------
// Dense
// ---------------------------------------------------------------------------

/**
 * pgvector ANN over the claim embedding projection.
 *
 * The embedding is computed for the query at read time, which is the one model
 * call the default path is allowed to make *if* a hosted embedder is configured.
 * The hashing embedder is local, so the default configuration makes zero network
 * calls; `isModelCall` on the backend is what the packet reports.
 *
 * **The read side and the write side must agree on one `model_id`, or this channel
 * returns nothing with no error.** The filter below is `e.model_id = $n`, so a reader
 * whose backend reports a different id than the writer's matches zero rows — and a
 * channel that ran and found nothing is indistinguishable, to the caller, from an
 * authorization denial. There is no warning, because from the database's point of view
 * nothing is wrong: it is being asked for rows that do not exist.
 *
 * This is not hypothetical. `HashEmbeddingBackend` appends its dimension count to the
 * default id, so `new HashEmbeddingBackend({ modelId: "hash-ngram-v1" })` and
 * `new HashEmbeddingBackend({ modelId: "hash-ngram-v1", dimensions: 1024 })` are two
 * different models and two disjoint halves of one corpus. Both applications in this
 * repository therefore construct the backend once and share the instance.
 *
 * The check is deliberate rather than incidental, and it is the right trade: an
 * embedding from a different model is not a worse vector, it is a vector in a different
 * space, and comparing across spaces produces confident nonsense. When a model changes,
 * `/v1/replay` reports the digest move and the projection is rebuilt under the new id —
 * that path is what makes this constraint a migration rather than a corruption.
 */
export async function denseChannel(
  executor: QueryExecutor,
  query: ChannelQuery,
  embeddings: EmbeddingBackend,
): Promise<ChannelResult> {
  const started = performance.now();
  const [vector] = await embeddings.embed([query.text]);
  if (!vector) {
    return {
      channel: "dense",
      hits: [],
      ran: false,
      note: "embedding backend returned no vector",
      duration_ms: round(performance.now() - started),
    };
  }

  // Check the projection's model before querying it, and report a mismatch as a skipped
  // channel with a reason rather than as an empty result.
  //
  // This is the difference between a configuration fault and a memory-quality complaint.
  // The filter below is `e.model_id = $n`, so a reader whose backend reports a different id
  // than the writer's matches zero rows — with no error, because from the database's point
  // of view nothing is wrong: it is being asked for rows that do not exist. The caller sees
  // an empty dense channel, which looks exactly like an authorization denial or like a
  // corpus that has nothing relevant in it.
  //
  // `HashEmbeddingBackend` appends its dimension count to the default id, so this is one
  // constructor argument away from happening silently. `packages/ledger`'s
  // `projection_versions` table records the model that wrote the projection; if it
  // disagrees with the configured reader, the channel says so and does not run.
  const projection = await executor.query<{ model_version: string | null; ledger_watermark: number }>(
    `SELECT model_version, ledger_watermark FROM projection_versions WHERE projection = 'dense'`,
  );
  const projectedModel = projection.rows[0]?.model_version ?? null;
  if (projectedModel !== null && projectedModel !== embeddings.model_id) {
    return {
      channel: "dense",
      hits: [],
      ran: false,
      note:
        `the dense projection was written by embedding model '${projectedModel}' but this ` +
        `reader is configured with '${embeddings.model_id}'. The channel did not run, because ` +
        `querying it would return zero rows and look like an authorization denial. Rebuild the ` +
        `projection with the configured model (POST /v1/replay), or configure the reader with ` +
        `the model that wrote it.`,
      duration_ms: round(performance.now() - started),
    };
  }

  const { where, params } = channelWhere(query);
  params.push(toVectorLiteral(vector));
  const vectorIndex = params.length;
  params.push(embeddings.model_id);
  const modelIndex = params.length;
  params.push(query.limit);
  const limitIndex = params.length;

  const result = await executor.query<{ claim_id: string; score: number }>(
    `SELECT c.claim_id, 1 - (e.embedding <=> $${vectorIndex}::vector) AS score
       FROM claims c
       JOIN scopes s ON s.scope_id = c.scope_id
       JOIN claim_embeddings e ON e.claim_id = c.claim_id
      WHERE ${where}
        AND e.model_id = $${modelIndex}
      ORDER BY e.embedding <=> $${vectorIndex}::vector ASC, c.claim_id ASC
      LIMIT $${limitIndex}`,
    params,
  );

  return {
    channel: "dense",
    hits: result.rows.map((row) => ({ claim_id: row.claim_id, score: Number(row.score), channel: "dense" })),
    ran: true,
    note: null,
    duration_ms: round(performance.now() - started),
  };
}

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

/**
 * Entity alias resolution.
 *
 * Aliases are per-tenant and never merged across tenants: a resolver that joined
 * `alice@acme` to `alice@rival` would be a cross-tenant correlation channel,
 * which is a worse failure than the ambiguity aliases exist to reduce.
 */
export async function entityChannel(
  executor: QueryExecutor,
  query: ChannelQuery,
): Promise<ChannelResult> {
  const started = performance.now();
  const terms = query.entity_terms.length > 0 ? [...query.entity_terms] : extractEntityTerms(query.text);
  if (terms.length === 0) {
    return {
      channel: "entity",
      hits: [],
      ran: false,
      note: "no candidate entity terms in the query",
      duration_ms: round(performance.now() - started),
    };
  }

  const { where, params } = channelWhere(query);
  params.push(terms);
  const termsIndex = params.length;
  params.push(query.limit);
  const limitIndex = params.length;

  const result = await executor.query<{ claim_id: string; score: number }>(
    `SELECT c.claim_id, count(DISTINCT a.alias)::float8 AS score
       FROM claims c
       JOIN scopes s ON s.scope_id = c.scope_id
       JOIN entity_aliases a ON a.tenant_id = c.tenant_id
      WHERE ${where}
        AND (a.alias = ANY($${termsIndex}::text[]) AND (a.canonical = c.subject OR a.canonical = lower(c.object::text)))
      GROUP BY c.claim_id
      ORDER BY score DESC, c.claim_id ASC
      LIMIT $${limitIndex}`,
    params,
  );

  return {
    channel: "entity",
    hits: result.rows.map((row) => ({ claim_id: row.claim_id, score: Number(row.score), channel: "entity" })),
    ran: true,
    note: null,
    duration_ms: round(performance.now() - started),
  };
}

/**
 * Candidate entity terms from a query.
 *
 * Lowercased whole tokens, filtered for stop words and for tokens that are pure
 * numbers: an alias table keyed on `2026` would match every claim that mentions a
 * year, which is noise dressed as an entity signal.
 */
export function extractEntityTerms(text: string): string[] {
  const stop = new Set([
    "what", "which", "who", "when", "where", "why", "how", "did", "does",
    "the", "and", "for", "was", "were", "is", "are", "has", "have", "had",
    "that", "this", "with", "from", "into", "about", "tell", "show", "give",
  ]);
  const terms = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}._:@/-]+/u)) {
    const token = raw.replace(/^[._:@/-]+|[._:@/-]+$/g, "");
    if (token.length < 3) continue;
    if (stop.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    terms.add(token);
  }
  return [...terms].slice(0, 24);
}

// ---------------------------------------------------------------------------
// Temporal
// ---------------------------------------------------------------------------

/**
 * Temporal proximity within the requested window.
 *
 * This is a *range* channel rather than a similarity channel: it returns claims
 * whose validity interval overlaps the query window, scored by how much of the
 * window they cover. Without a declared window it does not run, because "most
 * recent" is not a temporal query — it is a recency bias, and recency bias is one
 * of the failure modes the design exists to prevent.
 */
export async function temporalChannel(
  executor: QueryExecutor,
  query: ChannelQuery,
): Promise<ChannelResult> {
  const started = performance.now();
  if (query.time.mode !== "during") {
    return {
      channel: "temporal",
      hits: [],
      ran: false,
      note: `temporal channel requires a during window; time mode is ${query.time.mode}`,
      duration_ms: round(performance.now() - started),
    };
  }

  const { where, params } = channelWhere(query);
  params.push(query.limit);
  const limitIndex = params.length;
  const fromIndex = params.length + 1;
  const toIndex = params.length + 2;
  params.push(query.time.from, query.time.to);

  const result = await executor.query<{ claim_id: string; score: number }>(
    `SELECT c.claim_id,
            EXTRACT(EPOCH FROM (
              least(COALESCE(c.valid_to, $${toIndex}::timestamptz), $${toIndex}::timestamptz)
              - greatest(c.valid_from, $${fromIndex}::timestamptz)
            ))::float8 AS score
       FROM claims c
       JOIN scopes s ON s.scope_id = c.scope_id
      WHERE ${where}
        AND c.valid_range && tstzrange($${fromIndex}::timestamptz, $${toIndex}::timestamptz, '[)')
      ORDER BY score DESC NULLS LAST, c.claim_id ASC
      LIMIT $${limitIndex}`,
    params,
  );

  return {
    channel: "temporal",
    hits: result.rows.map((row) => ({ claim_id: row.claim_id, score: Number(row.score), channel: "temporal" })),
    ran: true,
    note: null,
    duration_ms: round(performance.now() - started),
  };
}

// ---------------------------------------------------------------------------
// Relation
// ---------------------------------------------------------------------------

/**
 * Bounded relation traversal from an explicitly named subject.
 *
 * Bounded to one hop and to the authorized scope set. An unbounded traversal is a
 * graph query, and the design keeps the relation table as a projection precisely
 * so that it cannot become the source of truth.
 */
export async function relationChannel(
  executor: QueryExecutor,
  query: ChannelQuery,
): Promise<ChannelResult> {
  const started = performance.now();
  if (!query.subjects || query.subjects.length === 0) {
    return {
      channel: "relation",
      hits: [],
      ran: false,
      note: "relation channel requires at least one explicit subject",
      duration_ms: round(performance.now() - started),
    };
  }

  const { where, params } = channelWhere(query);
  params.push(query.limit);
  const limitIndex = params.length;

  const result = await executor.query<{ claim_id: string; score: number }>(
    `SELECT c.claim_id, 1.0::float8 AS score
       FROM claims c
       JOIN scopes s ON s.scope_id = c.scope_id
      WHERE ${where}
        AND EXISTS (
          SELECT 1 FROM claim_relations r
           WHERE r.to_claim = c.claim_id OR r.from_claim = c.claim_id
        )
      ORDER BY c.claim_id ASC
      LIMIT $${limitIndex}`,
    params,
  );

  return {
    channel: "relation",
    hits: result.rows.map((row) => ({ claim_id: row.claim_id, score: Number(row.score), channel: "relation" })),
    ran: true,
    note: null,
    duration_ms: round(performance.now() - started),
  };
}

// ---------------------------------------------------------------------------
// Fusion
// ---------------------------------------------------------------------------

export interface FusedCandidate {
  readonly claim_id: string;
  readonly fuse_score: number;
  readonly channels: readonly string[];
  readonly signals: {
    readonly lexical: number | null;
    readonly dense: number | null;
    readonly entity: number | null;
    readonly temporal: number | null;
    readonly relation: number | null;
  };
}

/**
 * Reciprocal rank fusion.
 *
 * Ranks, not scores. The channels produce scores on incomparable scales — a
 * `ts_rank` of 0.06 and a cosine similarity of 0.62 are not the same kind of
 * number — so normalising them against each other would invent a common scale
 * that does not exist and then treat it as meaningful. RRF only uses the ordering
 * each channel produced, which is the part each channel is actually good at.
 *
 * `fuse_score` is a relevance ordinal. It is not truth, not confidence, and not
 * comparable across queries; the packet labels it accordingly.
 */
export function fuseResults(
  results: readonly ChannelResult[],
  options: { readonly k?: number; readonly limit?: number } = {},
): FusedCandidate[] {
  const k = options.k ?? 60;
  const byClaim = new Map<string, { fuse: number; channels: string[]; signals: Record<string, number | null> }>();

  for (const result of results) {
    if (!result.ran) continue;
    let rank = 0;
    for (const hit of result.hits) {
      rank += 1;
      const entry = byClaim.get(hit.claim_id) ?? {
        fuse: 0,
        channels: [],
        signals: { lexical: null, dense: null, entity: null, temporal: null, relation: null },
      };
      entry.fuse += 1 / (k + rank);
      entry.channels.push(result.channel);
      entry.signals[result.channel] = hit.score;
      byClaim.set(hit.claim_id, entry);
    }
  }

  const fused = [...byClaim.entries()].map(([claim_id, entry]) => ({
    claim_id,
    fuse_score: Number(entry.fuse.toFixed(8)),
    channels: [...new Set(entry.channels)].sort(),
    signals: {
      lexical: entry.signals["lexical"] ?? null,
      dense: entry.signals["dense"] ?? null,
      entity: entry.signals["entity"] ?? null,
      temporal: entry.signals["temporal"] ?? null,
      relation: entry.signals["relation"] ?? null,
    },
  }));

  fused.sort((left, right) =>
    right.fuse_score === left.fuse_score
      ? left.claim_id.localeCompare(right.claim_id)
      : right.fuse_score - left.fuse_score,
  );

  return options.limit ? fused.slice(0, options.limit) : fused;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
