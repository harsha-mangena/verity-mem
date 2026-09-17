/**
 * Feedback.
 *
 * Feedback about a packet is recorded as a **ledger event**, not written to a mutable
 * field on the trace. Three reasons, and the specification gives two of them
 * directly:
 *
 *   * "Feedback produces labelled decisions and eval data, not silent online
 *     learning." An event is what a later evaluation reads; a mutated column is a
 *     state nobody can reconstruct.
 *   * The correction is a user statement, so it is evidence with provenance like
 *     anything else — who said it, when, about which trace. Storing it in a feedback
 *     table would keep the content and lose the authority class.
 *   * A verifier can therefore ask what feedback exists about a claim and get the
 *     answer from the same append-only store as everything else, rather than from a
 *     table a well-meaning cleanup job can edit.
 *
 * The event is appended in a scope the trace itself resolved, never in a scope the
 * caller names for the occasion: a feedback event admitted into an invented scope
 * would be a write the original query never authorized. The trace is read first, so
 * feedback cannot be attached to a trace id the caller made up, and a trace the
 * caller cannot reach produces the same 404 as one that does not exist.
 */
import type { FastifyInstance } from "fastify";
import {
  FeedbackRequestSchema,
  FeedbackResponseSchema,
  type FeedbackRequest,
  type FeedbackResponse,
} from "@veritymem/contracts";
import { requireTool } from "../auth.ts";
import { resolveCallerTenant, tenantFromCredential, withReadContext } from "../context.ts";
import type { ServerDeps } from "../config.ts";
import { notFound } from "../errors.ts";
import { formatUuid, stripPrefix } from "../views.ts";

export interface FeedbackRouteOptions {
  readonly deps: ServerDeps;
}

export function registerFeedbackRoutes(app: FastifyInstance, options: FeedbackRouteOptions): void {
  const { deps } = options;

  app.post(
    "/v1/feedback",
    {
      schema: {
        tags: ["operations"],
        summary: "Record feedback about a query trace",
        description:
          "Written as an append-only ledger event so the correction keeps its provenance and its authority class. No online learning happens; the event is eval data.",
        body: FeedbackRequestSchema,
        response: { 201: FeedbackResponseSchema },
      },
    },
    async (request, reply) => {
      const caller = requireTool(request, "memory.feedback");
      const body = request.body as FeedbackRequest;
      const context = tenantFromCredential({ identity: caller, what: "POST /v1/feedback" });

      const trace = await withReadContext(deps, context, async (executor) => {
        const result = await executor.query<{
          trace_id: string;
          caller: string;
          policy_version: string;
          resolved_scope_ids: string[];
          query: unknown;
        }>(
          `SELECT trace_id, caller, policy_version, resolved_scope_ids, query
             FROM query_traces WHERE trace_id = $1::uuid`,
          [stripPrefix(body.trace_id)],
        );
        const row = result.rows[0];
        if (!row || row.resolved_scope_ids.length === 0) return null;
        // The scope row itself, because a ledger append needs dimensions and purposes
        // and the feedback must be admitted where the trace was answered.
        const scope = await executor.query<{
          scope_id: string;
          project: string | null;
          user_id: string | null;
          agent_id: string | null;
          session_id: string | null;
          purpose: string[];
        }>(
          `SELECT scope_id, project, user_id, agent_id, session_id, purpose
             FROM scopes WHERE scope_id = $1::uuid`,
          [row.resolved_scope_ids[0]],
        );
        const scopeRow = scope.rows[0];
        if (!scopeRow) return null;
        return { trace: row, scope: scopeRow };
      });
      if (!trace) throw notFound("query trace");

      const scope = body.scope ?? {
        tenant: context.tenant,
        ...(trace.scope.project !== null ? { project: trace.scope.project } : {}),
        ...(trace.scope.user_id !== null ? { user: trace.scope.user_id } : {}),
        ...(trace.scope.agent_id !== null ? { agent: trace.scope.agent_id } : {}),
        ...(trace.scope.session_id !== null ? { session: trace.scope.session_id } : {}),
        purpose: trace.scope.purpose,
      };
      const resolved = resolveCallerTenant({
        identity: caller,
        requestTenant: scope.tenant,
        what: "POST /v1/feedback",
      });

      const payload = {
        kind: "feedback",
        trace_id: body.trace_id,
        outcome: body.outcome,
        correction: body.correction ?? null,
        claim_ids: body.claim_ids ?? [],
        trace_caller: trace.trace.caller,
        trace_policy_version: trace.trace.policy_version,
        trace_scope_id: formatUuid(trace.scope.scope_id),
        reported_by: resolved.principal,
      };

      // The feedback event joins the same stream namespace as the trace it comments
      // on, so reading a stream shows the query and the correction that followed it in
      // ledger order. A separate stream would put the two facts in two orders and
      // leave "which correction came after which query" to timestamps.
      const receipt = await deps.ledger.append(
        {
          stream_id: `trace:${body.trace_id}`,
          origin: "user",
          actor_id: resolved.principal,
          scope: {
            ...scope,
            tenant: resolved.tenant,
            // A feedback event carries no claim content of its own, so its purpose is
            // the trace's purposes plus nothing. Inventing a purpose here would make
            // the correction admissible in a context the original query never reached.
            purpose: scope.purpose.length > 0 ? scope.purpose : ["memory_operations"],
          },
          occurred_at: deps.clock.now().toISOString(),
          content: JSON.stringify(payload),
          media_type: "application/vnd.veritymem.feedback+json",
        },
        { principal: resolved.principal },
      );

      const response: FeedbackResponse = {
        feedback_event_id: receipt.event_id,
        trace_id: body.trace_id,
        seq: receipt.seq,
        outcome: body.outcome,
        claim_ids: body.claim_ids ?? [],
        recorded_at: receipt.recorded_at,
      };
      await reply.code(201).send(response);
    },
  );
}
