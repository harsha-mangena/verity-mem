/**
 * The action gate over HTTP.
 *
 * This route is not in the specification's REST list, and it is here on purpose. The
 * specification states that the action gate is *the* enforcement point — "a `verify`
 * or `deny` verdict in a packet does not bind an LLM; the only real enforcement is
 * the action gate" — and that every adapter's `beforeAction` hook must call it. But
 * an adapter that runs in another process, or in another language, cannot call a
 * TypeScript function. Without an HTTP surface the enforcement point is reachable
 * only from JavaScript adapters embedded in the same process, which is precisely the
 * "if the action gate is not wired, the use decision is decoration" failure the
 * specification warns about.
 *
 * So the route exists to make the enforcement point reachable from anywhere, and it
 * is guarded like an ordinary agent operation (`action.gate` is held by the
 * `contributor` profile and above) rather than like an admin one: gating an action is
 * a read that produces a verdict, not a change to what the system holds.
 *
 * Two properties are inherited from `evaluateAction` and must not be re-implemented
 * here:
 *
 *   * It re-reads the claims and re-verifies their evidence digests on every call. It
 *     does not accept a packet, and this route deliberately has no field in which one
 *     could be passed.
 *   * A refusal is a 200 with `allowed: false`. A blocked action is the gate working;
 *     returning 403 would conflate a policy verdict with an authorization failure and
 *     would make an adapter's retry logic wrong.
 */
import type { FastifyInstance } from "fastify";
import {
  ActionGateHTTPResponseSchema,
  ActionGateRequestSchema,
  type ActionGateRequest,
} from "@veritymem/contracts";
import { evaluateAction } from "@veritymem/retrieval";
import { requireTool } from "../auth.ts";
import { resolveCallerTenant } from "../context.ts";
import type { ServerDeps } from "../config.ts";
import { retrievalDeps } from "./queries.ts";

export interface ActionRouteOptions {
  readonly deps: ServerDeps;
}

export function registerActionRoutes(app: FastifyInstance, options: ActionRouteOptions): void {
  const { deps } = options;

  app.post(
    "/v1/actions/gate",
    {
      schema: {
        tags: ["actions"],
        summary: "Decide whether a side effect may proceed on the claims it depends on",
        description:
          "The enforcement point named by the specification: before a medium- or high-risk side effect, verify that every referenced claim carries an allowed use decision and current evidence. Re-reads the claims and re-verifies digests; it does not trust a packet. A refusal is a 200 with allowed: false.",
        body: ActionGateRequestSchema,
        response: { 200: ActionGateHTTPResponseSchema },
      },
    },
    async (request, reply) => {
      const caller = requireTool(request, "action.gate");
      const body = request.body as ActionGateRequest;
      const context = resolveCallerTenant({
        identity: caller,
        requestTenant: body.scope.tenant,
        what: "POST /v1/actions/gate",
      });

      const verdict = await evaluateAction(
        // The action gate reads claims and evidence; it does not embed. Passing the
        // same dependency object the read path uses keeps one definition of the
        // policy version and one embedder, which is what makes a packet verdict and
        // an action verdict comparable.
        retrievalDeps(deps),
        { ...body, scope: { ...body.scope, tenant: context.tenant } },
        { principal: context.principal },
      );

      await reply.code(200).send(verdict);
    },
  );
}
