/**
 * Execution and composition.
 *
 * The order here is the invariant, stated once in code so it cannot be reordered
 * by accident:
 *
 *   1. plan (no retrieval yet),
 *   2. bind the request context from the plan's authorized scope set,
 *   3. run channels *inside* that boundary,
 *   4. fuse by rank,
 *   5. hydrate claims with evidence, conflicts and per-span digests,
 *   6. evaluate the use policy,
 *   7. compose the packet and write the trace.
 *
 * Step 2 before step 3 is why a denied claim cannot influence a count or a
 * latency. Step 5 re-verifying digests on every read is why a claim whose evidence
 * has drifted cannot be returned as though it were intact.
 *
 * The default path makes no model call: the embedder is a local hash function, so
 * `model_calls` is 0 unless a hosted embedder is configured, and reranking is
 * opt-in through the request.
 */
import { performance } from "node:perf_hooks";
import type {
  EvidenceRole,
  MemoryPacket,
  PacketClaim,
  PacketEvidence,
  QueryRequest,
  UseDecision,
} from "@veritymem/contracts";
import { DEFAULT_USE_POLICY_VERSION, REASON_CODES } from "@veritymem/contracts";
import type { Clock, Db, IdGenerator, Ledger, QueryExecutor, SpanRecord } from "@veritymem/ledger";
import { toPublicId } from "@veritymem/ledger";
import {
  ageInDays,
  evaluateUse,
  readClaims,
  readRelations,
  render,
  toIso,
  type ClaimRowShape,
  type UseVerdict,
} from "@veritymem/claims";
import {
  denseChannel,
  entityChannel,
  fuseResults,
  lexicalChannel,
  relationChannel,
  temporalChannel,
  type ChannelQuery,
  type ChannelResult,
  type FusedCandidate,
} from "./channels.ts";
import type { EmbeddingBackend } from "./embeddings.ts";
import { extractEntityTerms } from "./channels.ts";
import { planQuery, type QueryPlan } from "./planner.ts";
import { stage, type QueryObserver } from "./query-observer.ts";

export interface RetrievalDependencies {
  readonly db: Db;
  readonly ledger: Ledger;
  readonly embeddings: EmbeddingBackend;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly policyVersion?: string;
  readonly gateBackend?: string;
}

export interface ComposeOptions {
  readonly principal: string;
  /**
   * Whether the caller has asked for reranking. The default path never reranks:
   * reranking is an opt-in that trades reproducibility for ordering quality, and
   * it is recorded on the trace when it happens.
   */
  readonly rerank?: (candidates: readonly FusedCandidate[], plan: QueryPlan) => Promise<readonly FusedCandidate[]>;
  /**
   * An optional read-path observer, used by the plan-capture profiler.
   *
   * This is the entirety of `compose`'s knowledge of plan capture: when present, the
   * executors it builds are wrapped so the profiler sees each statement and its plan.
   * The observer cannot change what `compose` returns — it is handed rows that have
   * already been fetched — and every stage below is tagged so the profiler does not have
   * to guess which query is which from its text. See `query-observer.ts`.
   *
   * Absent on every production path, which is why the wrapper is applied conditionally
   * rather than always: an observation seam that costs a wrapper per query on every read
   * would be a tax on the thing it measures.
   */
  readonly observer?: QueryObserver;
  /**
   * Builds the observing executor from a raw one. Supplied alongside `observer`, because
   * `packages/retrieval` has no database driver of its own and must not acquire one just
   * to explain a query.
   */
  readonly makeExplainingExecutor?: (
    executor: QueryExecutor,
    observer: QueryObserver,
  ) => QueryExecutor;
}

export interface ComposeResult {
  readonly packet: MemoryPacket;
  readonly plan: QueryPlan;
  readonly channels: readonly ChannelResult[];
  readonly fused: readonly FusedCandidate[];
  /** Candidate ids that were denied by authorization, reported as a count only. */
  readonly candidates_denied_by_authz: number;
}

interface ComposePhaseTimings {
  readonly planning_ms: number;
  readonly channel_wall_ms: number;
  readonly fusion_ms: number;
  readonly hydration_ms: number;
}

/**
 * Answer a query.
 *
 * Returns the packet plus the plan and channel results, because a caller writing
 * a trace or debugging an ordering needs all three and reconstructing them from
 * the packet alone is impossible.
 */
export async function compose(
  dependencies: RetrievalDependencies,
  request: { readonly tenant_id: string } & QueryRequest,
  options: ComposeOptions,
): Promise<ComposeResult> {
  const started = performance.now();
  const now = dependencies.clock.now().toISOString();
  const query: QueryRequest = request;
  const observer = options.observer;
  /**
   * Wrap an executor for observation, or return it unchanged when nobody is watching.
   *
   * Conditional rather than unconditional so an ordinary read pays nothing for the
   * existence of the profiler: no wrapper object, no per-query branch, no allocation.
   * `makeExplainingExecutor` is supplied by the caller because only it knows how to
   * reach PostgreSQL for `EXPLAIN`; this module just applies it.
   */
  const observe = (executor: QueryExecutor): QueryExecutor =>
    observer === undefined || options.makeExplainingExecutor === undefined
      ? executor
      : options.makeExplainingExecutor(executor, observer);

  // ---- 1. Plan -----------------------------------------------------------
  const entityTerms = extractEntityTerms(query.query);
  const planningStarted = performance.now();
  const planned = await dependencies.db.withRequest(
    {
      tenant: request.tenant_id,
      principal: options.principal,
      // The planning transaction deliberately binds NO scopes: it must be able to
      // read `grants` but must not be able to read tenant claim data. Planning is
      // authorization, and authorization that can already read the data it is
      // authorizing is not a boundary.
      scopeIds: [],
      purposes: [query.purpose],
      action: "query:plan",
    },
    async (executor) => planQuery(executor, { tenant_id: request.tenant_id, principal: options.principal, query }, { entitySubjects: entityTerms }),
  );
  const planningMs = round(performance.now() - planningStarted);

  if (planned.authorized_scope_ids.length === 0) {
    // Nothing is reachable. The packet is empty and says so, and the reason is a
    // gap rather than an error: "you cannot see anything here" and "nothing
    // exists here" must not be distinguishable in the response, or a count
    // becomes an oracle.
    const traceId = dependencies.ids.next("qry");
    const latency = round(performance.now() - started);
    const packet = emptyPacket(planned, traceId, latency, dependencies);
    await writeTrace(dependencies, request.tenant_id, options.principal, planned, [], [], packet, latency, {
      planning_ms: planningMs,
      channel_wall_ms: 0,
      fusion_ms: 0,
      hydration_ms: 0,
    });
    return { packet, plan: planned, channels: [], fused: [], candidates_denied_by_authz: 0 };
  }

  // ---- 2 and 3. Bind the boundary, then retrieve inside it ---------------
  const channelQuery: ChannelQuery = {
    tenant_id: request.tenant_id,
    text: query.query,
    authorized_scopes: planned.authorized_scopes,
    purposes: [query.purpose],
    time: planned.time,
    kinds: planned.kinds,
    subjects: planned.subjects,
    entity_terms: planned.entity_terms,
    limit: Math.max(planned.limit * 4, 24),
    now,
  };

  const channelsStarted = performance.now();
  const channels = await runChannels(dependencies, planned, channelQuery, options.principal, {
    observe,
    observer,
  });
  const channelWallMs = round(performance.now() - channelsStarted);
  const candidateCount = new Set(
    channels.flatMap((result) => result.hits.map((hit) => hit.claim_id)),
  ).size;
  const deniedCount = 0;

  // ---- 4. Fuse -----------------------------------------------------------
  const fusionStarted = performance.now();
  let fused = fuseResults(channels, { limit: planned.limit * 3 });
  if (options.rerank) {
    fused = [...(await options.rerank(fused, planned))];
  }
  const fusionMs = round(performance.now() - fusionStarted);

  // ---- 5–7. Hydrate, evaluate, compose and persist the trace -------------
  // Hydration and the trace share one request transaction. The previous shape
  // committed the read, checked out another connection, rebound the identical
  // RLS context, and opened a fifth transaction just to insert one trace row.
  const packet = await dependencies.db.withRequest(
    {
      tenant: request.tenant_id,
      principal: options.principal,
      scopeIds: planned.authorized_scope_ids,
      purposes: [query.purpose],
      action: "query:compose",
    },
    async (rawExecutor) => {
      const executor = observe(rawExecutor);
      const hydrationStarted = performance.now();
      const packetClaims = await hydrate(dependencies, executor, planned, fused, query, now, observer);
      // This is projection progress, not ledger progress. Reading max(events.seq)
      // made a stale projection look current and paid for a separate privileged
      // transaction on every query.
      const watermark = await stage(observer, "projection_watermark", () =>
        readProjectionWatermark(executor, request.tenant_id),
      );
      const hydrationMs = round(performance.now() - hydrationStarted);
      const returned = packetClaims.slice(0, planned.limit);
      const decision = combineDecisions(returned.map((claim) => claim.use));
      const latency = round(performance.now() - started);
      const traceId = dependencies.ids.next("qry");

      const composed: MemoryPacket = {
        trace_id: traceId,
        decision,
        decision_reason_codes: [...new Set(returned.flatMap((claim) => claim.use_reason_codes))],
        claims: returned,
        missing: describeGaps(returned, planned, candidateCount),
        coverage: {
          channels_used: channels.filter((result) => result.ran).map((result) => result.channel),
          candidates_considered: candidateCount,
          candidates_after_authz: candidateCount,
          candidates_returned: returned.length,
          candidates_denied_by_authz: deniedCount,
          time_mode: planned.time.mode,
        },
        projection_watermark: watermark,
        policy_version: planned.policy_version,
        gate_backend: dependencies.gateBackend ?? "unknown",
        model_calls: dependencies.embeddings.isModelCall ? 1 : 0,
        latency_ms: latency,
      };

      await insertTrace(
        executor,
        request.tenant_id,
        options.principal,
        planned,
        channels,
        fused,
        composed,
        latency,
        {
          planning_ms: planningMs,
          channel_wall_ms: channelWallMs,
          fusion_ms: fusionMs,
          hydration_ms: hydrationMs,
        },
      );
      return composed;
    },
  );

  return { packet, plan: planned, channels, fused, candidates_denied_by_authz: deniedCount };
}

/** What `runChannels` needs in order to report the stages it runs. */
interface ChannelObservation {
  readonly observe: (executor: QueryExecutor) => QueryExecutor;
  readonly observer: QueryObserver | undefined;
}

async function runChannels(
  dependencies: RetrievalDependencies,
  plan: QueryPlan,
  query: ChannelQuery,
  principal: string,
  observation: ChannelObservation,
): Promise<ChannelResult[]> {
  const { observe, observer } = observation;
  const binding = {
    tenant: query.tenant_id,
    principal,
    scopeIds: plan.authorized_scope_ids,
    purposes: [plan.purpose],
    action: "query:read",
  } as const;

  // Two independently RLS-bound lanes. A single `pg` connection cannot execute
  // concurrent statements, but that does not require every channel to be serial:
  // each lane has its own transaction and binds the same database-validated scope
  // closure before it sees a candidate. The dense lane is separated because it is
  // normally the expensive branch; lexical/entity/temporal/relation stay together
  // to cap one request at two connections instead of one connection per channel.
  //
  // Start embedding before checking out the dense connection. A hosted embedder may
  // take hundreds of milliseconds, and holding an idle database transaction across
  // that network call turns model latency into pool starvation.
  const denseStarted = performance.now();
  const vectorPromise = plan.channels.includes("dense")
    ? dependencies.embeddings.embed([query.text])
    : Promise.resolve([] as number[][]);

  const ordinaryLane = dependencies.db.withRequest(
    binding,
    async (rawExecutor) => {
      const executor = observe(rawExecutor);
      const results: ChannelResult[] = [];
      // Each channel is tagged immediately before it runs, so the profiler pairs a
      // statement with its stage by position and never by parsing the SQL. A channel
      // that is not planned is not tagged, and its statement is therefore not captured.
      if (plan.channels.includes("lexical")) {
        results.push(await stage(observer, "lexical_channel", () => lexicalChannel(executor, query)));
      }
      if (plan.channels.includes("entity")) {
        results.push(await stage(observer, "entity_channel", () => entityChannel(executor, query)));
      }
      if (plan.channels.includes("temporal")) {
        results.push(await stage(observer, "temporal_channel", () => temporalChannel(executor, query)));
      }
      if (plan.channels.includes("relation")) {
        results.push(await stage(observer, "relation_channel", () => relationChannel(executor, query)));
      }
      return results;
    },
    { readOnly: true },
  );

  const denseLane = (async (): Promise<ChannelResult | null> => {
    if (!plan.channels.includes("dense")) return null;
    const [vector] = await vectorPromise;
    if (!vector) {
      return {
        channel: "dense",
        hits: [],
        ran: false,
        note: "embedding backend returned no vector",
        duration_ms: round(performance.now() - denseStarted),
      };
    }
    const result = await dependencies.db.withRequest(
      binding,
      // `denseChannel` issues two statements — the projection model-version lookup and
      // the vector search — and the profiler has to report them separately, because they
      // are different kinds of query against different tables: the first is a
      // `projection_versions` read that must not be confused with the second's index
      // choice. Tagging the channel as a whole would merge them into one stage, so the
      // two tags are declared here in the order the channel issues them. This is the one
      // place where a stage label is not attached to the call that makes the statement,
      // and it is deliberate: `denseChannel` cannot tag its own internals without
      // depending on the profiler.
      async (rawExecutor) => {
        const executor = observe(rawExecutor);
        observer?.aboutToRun("dense_model_version");
        observer?.aboutToRun("dense_vector_search");
        return denseChannel(executor, query, dependencies.embeddings, vector);
      },
      { readOnly: true },
    );
    return {
      ...result,
      duration_ms: round(performance.now() - denseStarted),
    };
  })();

  // Wait for both lanes even when one fails. `Promise.all` would reject as soon as
  // (for example) a hosted embedding call failed while leaving the ordinary lane's
  // database transaction running in the background, which turns repeated upstream
  // failures into unexplained pool pressure.
  const [ordinaryOutcome, denseOutcome] = await Promise.allSettled([ordinaryLane, denseLane]);
  if (ordinaryOutcome.status === "rejected") throw ordinaryOutcome.reason;
  if (denseOutcome.status === "rejected") throw denseOutcome.reason;
  const ordinary = ordinaryOutcome.value;
  const dense = denseOutcome.value;
  const byChannel = new Map(ordinary.map((result) => [result.channel, result]));
  if (dense) byChannel.set(dense.channel, dense);
  return plan.channels.flatMap((channel) => {
    const result = byChannel.get(channel);
    return result ? [result] : [];
  });
}

/**
 * Turn fused candidates into packet claims.
 *
 * Hydration resolves every evidence span and re-verifies its digest on this read.
 * A cached verification would be exactly the silent drift the design exists to
 * prevent, so it is done again here even though the gate already did it at
 * promotion time.
 */
async function hydrate(
  dependencies: RetrievalDependencies,
  executor: QueryExecutor,
  plan: QueryPlan,
  fused: readonly FusedCandidate[],
  query: QueryRequest,
  now: string,
  observer: QueryObserver | undefined,
): Promise<PacketClaim[]> {
  if (fused.length === 0) return [];

  // Each hydration sub-query is tagged where it is issued. An earlier version tagged the
  // whole of `hydrate` with one name, which meant only its first statement was labelled and
  // the evidence, event and watermark reads arrived as `unlabeled` — the artifact could not
  // say what they were.
  const ids = fused.map((candidate) => toPublicId("clm", candidate.claim_id));
  const claimMap = await stage(observer, "claim_hydration", () => readClaims(executor, ids));
  const relations = await stage(observer, "claim_relations_read", () =>
    readRelations(executor, ids),
  );
  const evidenceByClaim = await stage(observer, "claim_evidence_read", () =>
    readEvidence(dependencies.ledger, executor, [...claimMap.values()]),
  );
  const out: PacketClaim[] = [];

  for (const candidate of fused) {
    const publicId = toPublicId("clm", candidate.claim_id);
    const claim = claimMap.get(publicId);
    if (!claim) continue;

    const evidence = evidenceByClaim.get(publicId) ?? [];
    const digestOk = evidence.length > 0 && evidence.every((entry) => entry.digest_ok);
    const claimRelations = relations.get(publicId) ?? [];
    const conflicted = claimRelations.some(
      (relation) => relation.rel === "contradicts" && relation.other_status === "accepted",
    );

    const verdict: UseVerdict = evaluateUse({
      status: claim.status,
      kind: claim.kind,
      authority: claim.authority,
      valid_to: claim.valid_to === null ? null : toIso(claim.valid_to),
      expires_at: claim.expires_at === null ? null : toIso(claim.expires_at),
      has_conflicts: conflicted,
      digest_ok: digestOk,
      span_count: evidence.length,
      age_days: ageInDays(claim.valid_from, now),
      action_risk: query.action_risk ?? "low",
      query_purpose_matches: true,
      now,
    });

    out.push({
      claim_id: publicId,
      kind: claim.kind,
      statement: { subject: claim.subject, predicate: claim.predicate, object: claim.object },
      status: claim.status,
      authority: claim.authority,
      use: verdict.use,
      use_reason_codes: [...verdict.reason_codes],
      scope: {
        project: claim.project,
        user: claim.user_id,
        agent: claim.agent_id,
        session: claim.session_id,
        purpose: [...claim.purpose],
      },
      valid_time: {
        from: toIso(claim.valid_from),
        to: claim.valid_to === null ? null : toIso(claim.valid_to),
      },
      freshness: {
        age_days: verdict.age_days,
        stale: verdict.age_days > verdict.staleness_horizon_days,
        expires_at: claim.expires_at === null ? null : toIso(claim.expires_at),
      },
      evidence,
      conflicts: claimRelations.map((relation) => ({
        claim_id: relation.direction === "outgoing" ? relation.to_claim : relation.from_claim,
        rel: relation.rel,
        direction: relation.direction,
        ...(relation.other_statement !== undefined ? { statement: relation.other_statement } : {}),
      })),
      signals: candidate.signals,
      fuse_score: candidate.fuse_score,
      channels: [...candidate.channels],
    });
  }

  return out;
}

interface EvidenceRow {
  claim_id: string;
  span_id: string;
  event_id: string;
  start_off: number;
  end_off: number;
  span_digest: Buffer;
  role: EvidenceRole;
  [column: string]: unknown;
}

async function readEvidence(
  ledger: Ledger,
  executor: QueryExecutor,
  claims: readonly ClaimRowShape[],
): Promise<Map<string, PacketEvidence[]>> {
  const out = new Map<string, PacketEvidence[]>();
  if (claims.length === 0) return out;

  const rows = await executor.query<EvidenceRow>(
    `SELECT ce.claim_id, s.span_id, s.event_id, s.start_off, s.end_off, s.span_digest, ce.role
       FROM claim_evidence ce
       JOIN evidence_spans s ON s.span_id = ce.span_id
      WHERE ce.claim_id = ANY($1::uuid[])
      ORDER BY s.start_off ASC`,
    [claims.map((claim) => claim.claim_id)],
  );

  const spanRecords: SpanRecord[] = rows.rows.map((row): SpanRecord => ({
    span_id: toPublicId("spn", row.span_id),
    event_id: toPublicId("evt", row.event_id),
    start: Number(row.start_off),
    end: Number(row.end_off),
    selector: null,
    digest: row.span_digest.toString("hex"),
    quote: "",
  }));

  const verifications = await ledger.verifySpans(executor, spanRecords);

  for (const row of rows.rows) {
    const claimId = toPublicId("clm", row.claim_id);
    const spanId = toPublicId("spn", row.span_id);
    const verification = verifications.get(spanId);
    const list = out.get(claimId) ?? [];

    const digestOk = verification?.status === "ok";
    list.push({
      event_id: toPublicId("evt", row.event_id),
      span_id: spanId,
      start: Number(row.start_off),
      end: Number(row.end_off),
      quote:
        verification && verification.status === "ok"
          ? verification.quote
          : verification && verification.status === "redacted"
            ? null
            : null,
      digest: row.span_digest.toString("hex"),
      digest_ok: digestOk,
      entailment: digestOk ? "entailed" : "unknown",
      entailment_score: null,
    });
    out.set(claimId, list);
  }
  return out;
}

/**
 * The packet-level decision is the weakest claim-level decision, not an average.
 *
 * If one returned claim is `deny`, the packet is `deny`: a caller that acts on the
 * packet as a whole must not be able to proceed because the majority of the
 * contents were usable. Averaging use decisions would be the same category of
 * mistake as averaging the six confidence dimensions.
 */
export function combineDecisions(decisions: readonly UseDecision[]): UseDecision {
  if (decisions.length === 0) return "clarify";
  const order: readonly UseDecision[] = ["deny", "clarify", "verify", "use"];
  for (const decision of order) {
    if (decisions.includes(decision)) return decision;
  }
  return "clarify";
}

/**
 * What the system knows it does not know.
 *
 * A packet that returns three claims and no gaps invites the reader to assume
 * three is all there is. These strings are deliberately descriptive rather than
 * reassuring.
 */
export function describeGaps(
  claims: readonly PacketClaim[],
  plan: QueryPlan,
  considered: number,
): string[] {
  const missing: string[] = [];
  if (claims.length === 0) {
    missing.push(
      considered === 0
        ? "No claim in the reachable scope matched this query."
        : "Candidates were found but none survived evidence verification and the use policy.",
    );
  }
  if (plan.denied_dimensions.length > 0) {
    // The dimension is named but not what was in it: naming the scope teaches the
    // caller that something exists there, which is the leak this design avoids.
    missing.push(
      `The requested scope (${plan.denied_dimensions.join(", ")}) is not within the caller's authorization; results are limited to reachable scopes.`,
    );
  }
  const conflicted = claims.filter((claim) => claim.conflicts.some((c) => c.rel === "contradicts"));
  if (conflicted.length > 0) {
    missing.push(
      `${conflicted.length} returned claim(s) have an unresolved contradiction; the packet does not choose a winner.`,
    );
  }
  const stale = claims.filter((claim) => claim.freshness.stale);
  if (stale.length > 0) {
    missing.push(`${stale.length} returned claim(s) are older than the staleness horizon for their kind.`);
  }
  const unusable = claims.filter((claim) => claim.use === "deny" || claim.use === "verify");
  if (unusable.length > 0) {
    missing.push(
      `${unusable.length} returned claim(s) carry a use decision below "use"; they are reported for inspection, not for action.`,
    );
  }
  return missing;
}

function emptyPacket(
  plan: QueryPlan,
  traceId: string,
  latency: number,
  dependencies: RetrievalDependencies,
): MemoryPacket {
  return {
    trace_id: traceId,
    decision: "clarify",
    decision_reason_codes: [REASON_CODES.USE_SCOPE_NARROWER_THAN_QUERY],
    claims: [],
    missing: describeGaps([], plan, 0),
    coverage: {
      channels_used: [],
      candidates_considered: 0,
      candidates_after_authz: 0,
      candidates_returned: 0,
      candidates_denied_by_authz: 0,
      time_mode: plan.time.mode,
    },
    projection_watermark: 0,
    policy_version: plan.policy_version,
    gate_backend: dependencies.gateBackend ?? "unknown",
    model_calls: 0,
    latency_ms: latency,
  };
}

/**
 * Persist the trace for an early empty-scope result.
 *
 * The trace records the *candidate set and the returned set*, which is what makes
 * "why did the system return this" answerable after the fact. The normal path calls
 * `insertTrace` inside its hydration transaction; this wrapper is for the early
 * authorization-deny path, which has no hydration transaction to reuse.
 */
async function writeTrace(
  dependencies: RetrievalDependencies,
  tenantId: string,
  principal: string,
  plan: QueryPlan,
  channels: readonly ChannelResult[],
  fused: readonly FusedCandidate[],
  packet: MemoryPacket,
  latency: number,
  timings: ComposePhaseTimings,
): Promise<void> {
  await dependencies.db.withRequest(
    {
      tenant: tenantId,
      principal,
      scopeIds: plan.authorized_scope_ids,
      purposes: [plan.purpose],
      action: "query:trace",
    },
    (executor) => insertTrace(executor, tenantId, principal, plan, channels, fused, packet, latency, timings),
  );
}

/** Insert a trace on an already-bound transaction. */
async function insertTrace(
  executor: QueryExecutor,
  tenantId: string,
  principal: string,
  plan: QueryPlan,
  channels: readonly ChannelResult[],
  fused: readonly FusedCandidate[],
  packet: MemoryPacket,
  latency: number,
  timings: ComposePhaseTimings,
): Promise<void> {
  await executor.query(
    `INSERT INTO query_traces (
       trace_id, tenant_id, caller, query, policy_version, resolved_scope_ids,
       candidates, returned, projection_watermark, model_calls, latency_ms
     ) VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6::uuid[], $7::jsonb, $8::jsonb, $9, $10, $11)`,
    [
      stripPrefix(packet.trace_id),
      tenantId,
      principal,
      JSON.stringify({
        text: plan.text,
        purpose: plan.purpose,
        action_risk: plan.action_risk,
        time: plan.time,
        scope_resolution: plan.scope_resolution,
        phase_timings: timings,
        channels: channels.map((result) => ({
          channel: result.channel,
          ran: result.ran,
          hits: result.hits.length,
          note: result.note,
          duration_ms: result.duration_ms,
        })),
      }),
      plan.policy_version,
      plan.authorized_scope_ids,
      JSON.stringify(
        fused.slice(0, 50).map((candidate) => ({
          claim_id: toPublicId("clm", candidate.claim_id),
          fuse_score: candidate.fuse_score,
          channels: [...candidate.channels],
        })),
      ),
      JSON.stringify(
        packet.claims.map((claim) => ({
          claim_id: claim.claim_id,
          use: claim.use,
          authority: claim.authority,
          fuse_score: claim.fuse_score,
        })),
      ),
      packet.projection_watermark,
      packet.model_calls,
      Math.round(latency),
    ],
  );
}

async function readProjectionWatermark(executor: QueryExecutor, tenantId: string): Promise<number> {
  const result = await executor.query<{ watermark: number }>(
    `SELECT COALESCE(max(ledger_watermark), 0)::int AS watermark
       FROM projection_versions
      WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  return Number(result.rows[0]?.watermark ?? 0);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
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

export { render };
