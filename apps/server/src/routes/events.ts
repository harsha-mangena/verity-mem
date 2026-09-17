/**
 * Event routes: append, read, and re-extract.
 *
 * `POST /v1/events` is the only place the ledger is written, and its ordering is the
 * specification's: authenticate, authorize, validate, append durably, acknowledge
 * *before* extraction. The acknowledgement therefore reports an extraction state
 * rather than a result — a 202 whose body described extracted claims would be a
 * synchronous extraction wearing an async status code.
 *
 * The re-extract route does run extraction inline, and says so. It exists because
 * the specification names "re-run extraction at a new version" as an operation, and
 * because a deployment whose worker is down must still be able to answer "what would
 * this event yield today". It runs in the origin event's own scope, with the origin
 * event's purposes, so it cannot produce a candidate the original write could not
 * have produced.
 */
import type { FastifyInstance } from "fastify";
import {
  EventAppendRequestSchema,
  EventAppendResponseSchema,
  EventExtractResponseSchema,
  EventRecordSchema,
  type EventAppendRequest,
  type EventExtractResponse,
  type EventRecord,
} from "@veritymem/contracts";
import { CommitGate } from "@veritymem/gate";
import { DETERMINISTIC_EXTRACTORS, IngestPipeline } from "@veritymem/model-adapters";
import { projectClaim } from "@veritymem/retrieval";
import { requireTool } from "../auth.ts";
import { resolveCallerTenant, tenantFromCredential, withBoundContext } from "../context.ts";
import type { ServerDeps } from "../config.ts";
import { notFound } from "../errors.ts";
import { formatUuid } from "../views.ts";

const EventIdParamsSchema = {
  type: "object",
  required: ["event_id"],
  additionalProperties: false,
  properties: { event_id: { type: "string", minLength: 1, maxLength: 128 } },
} as const;

/**
 * Build the ingest pipeline once per process.
 *
 * The pipeline holds the gate, and the gate holds the entailment backend — the
 * object `/readyz` reports. Rebuilding it per request would let two requests be gated
 * by two different backends, and the decision rows would then disagree about which
 * model promoted a claim with no way to tell which was which.
 *
 * `modelExtractor` is null and that is a stated limitation, not a default: the
 * server has no model extraction path in v0.1. The specification holds the line at
 * one extraction call per unstructured event, and the process that should make it is
 * the worker, which owns retries and the outbox. Wiring a model call into an HTTP
 * handler would put an unbounded-latency network call on the request path and make
 * the one-call budget depend on which of two processes got there first.
 */
export function createPipeline(deps: ServerDeps): IngestPipeline {
  const gate = new CommitGate({
    db: deps.db,
    ledger: deps.ledger,
    ids: deps.ids,
    clock: deps.clock,
    entailment: deps.entailment,
    policy: deps.policy,
  });
  return new IngestPipeline({
    db: deps.db,
    ledger: deps.ledger,
    gate,
    ids: deps.ids,
    clock: deps.clock,
    deterministicExtractors: DETERMINISTIC_EXTRACTORS,
    modelExtractor: null,
  });
}

export interface EventRouteOptions {
  readonly deps: ServerDeps;
  readonly pipeline: IngestPipeline;
}

export function registerEventRoutes(app: FastifyInstance, options: EventRouteOptions): void {
  const { deps, pipeline } = options;

  app.post(
    "/v1/events",
    {
      schema: {
        tags: ["events"],
        summary: "Append an event to the ledger",
        description:
          "Durability is acknowledged before extraction, so the response reports an extraction state rather than a result.",
        body: EventAppendRequestSchema,
        response: { 202: EventAppendResponseSchema },
      },
    },
    async (request, reply) => {
      const caller = requireTool(request, "memory.record");
      const body = request.body as EventAppendRequest;
      const context = resolveCallerTenant({
        identity: caller,
        requestTenant: body.scope.tenant,
        what: "POST /v1/events",
      });

      const receipt = await deps.ledger.append(
        { ...body, scope: { ...body.scope, tenant: context.tenant } },
        { principal: context.principal },
      );

      await reply.code(202).send({
        event_id: receipt.event_id,
        seq: receipt.seq,
        recorded_at: receipt.recorded_at,
        extraction: receipt.extraction_queued ? "queued" : "skipped",
        deduplicated: receipt.deduplicated,
        content_hash: receipt.content_hash,
        prev_hash: receipt.prev_hash,
      });
    },
  );

  app.get(
    "/v1/events/:event_id",
    {
      schema: {
        tags: ["events"],
        summary: "Read a stored event",
        params: EventIdParamsSchema,
        response: { 200: EventRecordSchema },
      },
    },
    async (request, reply) => {
      const caller = requireTool(request, "memory.event.read");
      const params = request.params as { event_id: string };
      const context = tenantFromCredential({ identity: caller, what: "GET /v1/events" });

      const event = await withBoundContext(
        deps,
        {
          tenantId: context.tenantId,
          principal: context.principal,
          scopeIds: [],
          purposes: [],
          action: "event:read",
          readOnly: true,
        },
        async (executor) => deps.ledger.readEvent(executor, params.event_id),
      );

      if (!event) throw notFound("event");
      await reply.code(200).send(toEventRecord(event, context.tenant));
    },
  );

  app.post(
    "/v1/events/:event_id/extract",
    {
      schema: {
        tags: ["events"],
        summary: "Re-run extraction for an event, synchronously",
        description:
          "Runs the deterministic extractors and the commit gate in the origin event's own scope. Claims the gate accepts are projected in the same transaction, so the result is immediately queryable rather than waiting on the outbox worker.",
        params: EventIdParamsSchema,
        response: { 200: EventExtractResponseSchema },
      },
    },
    async (request, reply) => {
      const caller = requireTool(request, "memory.propose");
      const params = request.params as { event_id: string };
      const context = tenantFromCredential({ identity: caller, what: "POST /v1/events/{id}/extract" });

      // Read the event first, unbound by scope but bound by tenant, to learn which
      // scope and purposes the extraction belongs to. Binding the caller's own reach
      // instead would let a caller with a broad grant extract an event into a scope it
      // does not participate in, which would change the evidence's ownership.
      const event = await withBoundContext(
        deps,
        {
          tenantId: context.tenantId,
          principal: context.principal,
          scopeIds: [],
          purposes: [],
          action: "event:extract:read",
          readOnly: true,
        },
        async (executor) => deps.ledger.readEvent(executor, params.event_id),
      );
      if (!event) throw notFound("event");

      const result = await withBoundContext(
        deps,
        {
          tenantId: context.tenantId,
          // The extraction is attributed to whoever the ledger recorded as the actor,
          // not to the caller who asked for the re-run. The candidate rows carry the
          // original provenance, and a re-run must not be able to rewrite who said it.
          principal: event.actor_id,
          scopeIds: [event.scope.scope_id],
          purposes: event.scope.purpose,
          action: "event:extract",
        },
        async (executor) => {
          const ingested = await pipeline.ingest(executor, event);
          for (const decision of ingested.decisions) {
            if (decision.claim_id === null) continue;
            // Projected here rather than left to the outbox because this route's
            // contract is "re-run extraction and show me the result". A caller that
            // had to poll the worker to see it would be reading a different
            // operation's outcome.
            await projectClaim(executor, { db: deps.db, embeddings: deps.embeddings }, decision.claim_id);
          }
          return ingested;
        },
      );

      const body: EventExtractResponse = {
        event_id: event.event_id,
        model_calls: result.model_calls,
        extractor_versions: [...result.extractor_versions],
        admission: {
          trust_zone: result.admission.trust_zone,
          instruction_like: result.admission.instruction_like,
          sensitive: result.admission.sensitive,
          reason_codes: [...result.admission.reason_codes],
        },
        candidates: result.candidates.map((candidate) => candidate.candidate_id),
        claims: result.decisions
          .map((decision) => decision.claim_id)
          .filter((claimId): claimId is string => claimId !== null),
        decisions: result.decisions.map((decision) => ({
          decision_id: decision.decision_id,
          candidate_id: decision.candidate_id,
          outcome: decision.outcome,
          claim_id: decision.claim_id,
          policy_version: decision.policy_version,
          reason_codes: [...decision.reason_codes],
        })),
        notes: [...result.notes],
        // A redacted payload cannot be re-extracted, and the response says so rather
        // than returning an empty candidate list that reads as "nothing found here".
        extracted: event.redacted_at === null && event.content !== null,
      };
      await reply.code(200).send(body);
    },
  );
}

/**
 * Project a `LedgerEvent` onto the stored-event contract.
 *
 * `tenant` is the slug the caller presented, never the resolved UUID: the mapping is
 * a pure function, so publishing the UUID gains a client nothing and hands it a
 * stable cross-deployment correlation key.
 */
export function toEventRecord(
  event: {
    readonly event_id: string;
    readonly stream_id: string;
    readonly seq: number;
    readonly scope: {
      readonly scope_id: string;
      readonly project: string | null;
      readonly user: string | null;
      readonly agent: string | null;
      readonly session: string | null;
      readonly purpose: readonly string[];
    };
    readonly origin: EventRecord["origin"];
    readonly actor_id: string;
    readonly occurred_at: string;
    readonly recorded_at: string;
    readonly content: string | null;
    readonly payload_ref: string | null;
    readonly content_hash: string;
    readonly prev_hash: string | null;
    readonly chained: boolean;
    /**
     * Widened to `string` rather than the contract's union on purpose: the ledger
     * types this column as `string` because the database owns the vocabulary, and
     * narrowing it here would be a cast pretending to be a type. The one place that
     * matters is the response body, where the schema validator refuses an unlisted
     * value before it leaves the process.
     */
    readonly sensitivity: string;
    readonly media_type: string;
    readonly byte_length: number;
    readonly redacted_at: string | null;
    readonly idempotency_key: string | null;
  },
  tenantSlug: string,
): EventRecord {
  return {
    event_id: event.event_id,
    stream_id: event.stream_id,
    seq: event.seq,
    tenant: tenantSlug,
    scope: {
      scope_id: formatUuid(event.scope.scope_id),
      project: event.scope.project,
      user: event.scope.user,
      agent: event.scope.agent,
      session: event.scope.session,
      purpose: [...event.scope.purpose],
    },
    origin: event.origin,
    actor_id: event.actor_id,
    occurred_at: event.occurred_at,
    recorded_at: event.recorded_at,
    content: event.content,
    payload_ref: event.payload_ref,
    content_hash: event.content_hash,
    prev_hash: event.prev_hash,
    chained: event.chained,
    // The column is typed `string` by the ledger because the database owns the
    // vocabulary. The response schema refuses an unlisted label, so a value the
    // contract does not know leaves as a 500 rather than as a silently novel label.
    sensitivity: event.sensitivity as EventRecord["sensitivity"],
    media_type: event.media_type,
    byte_length: event.byte_length,
    redacted_at: event.redacted_at,
    idempotency_key: event.idempotency_key,
  };
}
