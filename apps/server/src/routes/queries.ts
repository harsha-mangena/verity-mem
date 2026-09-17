/**
 * Retrieval routes: `POST /v1/query`, `POST /v1/context/compose`, and the trace read.
 *
 * Almost nothing is decided in this file, and that is the design. `compose()` already
 * runs the sequence that matters — plan, bind the authorized scope set, retrieve
 * inside it, fuse, hydrate with re-verified evidence, evaluate the use policy, write
 * the trace — and every one of those steps is a place where a route handler could
 * quietly undo it. So this module's whole job is to hand `compose()` a tenant it
 * derived from the credential and a principal it authenticated, and to pass the
 * packet back unchanged.
 *
 * The two routes that share a composer differ in exactly one way, which is the
 * specification's own distinction: `/v1/query` returns the packet, and
 * `/v1/context/compose` returns the same packet *plus* optional model-ready prose.
 * The packet is never replaced by the prose, and the prose is rendered from the
 * packet rather than from a second read, so a citation in the prose cannot refer to
 * evidence the packet does not contain.
 */
import type { FastifyInstance } from "fastify";
import {
  ContextComposeRequestSchema,
  ContextComposeResponseSchema,
  DEFAULT_ACTION_POLICY_VERSION,
  DEFAULT_USE_POLICY_VERSION,
  MemoryPacketSchema,
  QueryRequestSchema,
  QueryTraceResponseSchema,
  type QueryRequest,
} from "@veritymem/contracts";
import { compose, type RetrievalDependencies } from "@veritymem/retrieval";
import { requireTool } from "../auth.ts";
import { resolveCallerTenant, tenantFromCredential, withReadContext } from "../context.ts";
import type { ServerDeps } from "../config.ts";
import { notFound } from "../errors.ts";
import { renderMemoryPacket } from "../prose.ts";
import { formatUuid, requireId, stripPrefix } from "../views.ts";

const TraceIdParamsSchema = {
  type: "object",
  required: ["trace_id"],
  additionalProperties: false,
  properties: { trace_id: { type: "string", minLength: 1, maxLength: 128 } },
} as const;

/**
 * The dependency object `compose()` and `evaluateAction()` take.
 *
 * `policyVersion` is the *use* policy version, not the commit policy version, even
 * though the field name suggests otherwise. The commit policy governs how a claim
 * becomes believed and is recorded on the decision row; the use policy governs
 * whether a believed claim may inform an action and is recorded in the packet and the
 * trace. Passing the commit version here would stamp `commit-v3` on a packet that was
 * judged under `use-v2`, and a later question about which read policy produced a
 * verdict would have no correct answer.
 */
export function retrievalDeps(deps: ServerDeps): RetrievalDependencies {
  return {
    db: deps.db,
    ledger: deps.ledger,
    embeddings: deps.embeddings,
    ids: deps.ids,
    clock: deps.clock,
    policyVersion: DEFAULT_USE_POLICY_VERSION,
    gateBackend: deps.entailment.name,
  };
}

/** The action policy version, surfaced so `/readyz` and the gate agree on one value. */
export const ACTION_POLICY_VERSION = DEFAULT_ACTION_POLICY_VERSION;

export interface QueryRouteOptions {
  readonly deps: ServerDeps;
}

export function registerQueryRoutes(app: FastifyInstance, options: QueryRouteOptions): void {
  const { deps } = options;

  app.post(
    "/v1/query",
    {
      schema: {
        tags: ["retrieval"],
        summary: "Answer a query with a MemoryPacket",
        description:
          "Authorization runs before retrieval. An unreachable scope produces an empty packet with a gap, never an error and never a count that discloses what was withheld.",
        body: QueryRequestSchema,
        response: { 200: MemoryPacketSchema },
      },
    },
    async (request, reply) => {
      const caller = requireTool(request, "memory.query");
      const body = request.body as QueryRequest;
      const context = resolveCallerTenant({
        identity: caller,
        requestTenant: body.scope.tenant,
        what: "POST /v1/query",
      });

      const result = await compose(
        retrievalDeps(deps),
        { ...body, tenant_id: context.tenantId, scope: { ...body.scope, tenant: context.tenant } },
        { principal: context.principal },
      );

      await reply.code(200).send(result.packet);
    },
  );

  app.post(
    "/v1/context/compose",
    {
      schema: {
        tags: ["retrieval"],
        summary: "Compose a packet with optional model-ready prose",
        description:
          "The packet is the same object POST /v1/query returns and is always present. The prose is rendered deterministically from that packet — it is never a model call, and every sentence carries the claim and span identifiers it rests on. Structured data with provenance, never text spliced into a prompt.",
        body: ContextComposeRequestSchema,
        response: { 200: ContextComposeResponseSchema },
      },
    },
    async (request, reply) => {
      const caller = requireTool(request, "memory.compose");
      const body = request.body as QueryRequest;
      const context = resolveCallerTenant({
        identity: caller,
        requestTenant: body.scope.tenant,
        what: "POST /v1/context/compose",
      });

      const result = await compose(
        retrievalDeps(deps),
        { ...body, tenant_id: context.tenantId, scope: { ...body.scope, tenant: context.tenant } },
        { principal: context.principal },
      );

      const rendered = renderMemoryPacket(result.packet);
      await reply.code(200).send({
        packet: result.packet,
        prose: rendered.prose,
        citations: rendered.citations,
        deterministic: true,
      });
    },
  );

  app.get(
    "/v1/query-traces/:trace_id",
    {
      schema: {
        tags: ["retrieval"],
        summary: "Read a stored query trace",
        description:
          "The trace records the candidate set and the returned set, which is what makes 'why did the system return this' answerable after the fact rather than by re-running the query.",
        params: TraceIdParamsSchema,
        response: { 200: QueryTraceResponseSchema },
      },
    },
    async (request, reply) => {
      const caller = requireTool(request, "memory.trace");
      const params = request.params as { trace_id: string };
      requireId(params.trace_id, "qry", "trace_id");
      const context = tenantFromCredential({ identity: caller, what: "GET /v1/query-traces/{id}" });

      const trace = await withReadContext(deps, context, async (executor) => {
        const result = await executor.query<{
          trace_id: string;
          tenant_id: string;
          caller: string;
          query: unknown;
          policy_version: string;
          resolved_scope_ids: string[];
          candidates: unknown;
          returned: unknown;
          projection_watermark: number;
          model_calls: number;
          latency_ms: number | null;
          created_at: Date | string;
        }>(
          `SELECT trace_id, tenant_id, caller, query, policy_version, resolved_scope_ids,
                  candidates, returned, projection_watermark, model_calls, latency_ms, created_at
             FROM query_traces
            WHERE trace_id = $1::uuid`,
          [stripPrefix(params.trace_id)],
        );
        return result.rows[0] ?? null;
      });

      if (!trace) throw notFound("query trace");
      await reply.code(200).send({
        trace_id: params.trace_id,
        tenant: context.tenant,
        caller: trace.caller,
        query: trace.query,
        policy_version: trace.policy_version,
        resolved_scope_ids: trace.resolved_scope_ids.map((id) => formatUuid(id)),
        candidates: trace.candidates,
        returned: trace.returned,
        projection_watermark: Number(trace.projection_watermark),
        model_calls: Number(trace.model_calls),
        latency_ms: trace.latency_ms === null ? null : Number(trace.latency_ms),
        created_at:
          trace.created_at instanceof Date ? trace.created_at.toISOString() : new Date(trace.created_at).toISOString(),
      });
    },
  );
}
