/**
 * Health and readiness.
 *
 * Two endpoints, and the difference between them is the point.
 *
 * `/healthz` answers "is this process alive" and is deliberately unauthenticated and
 * dependency-free: a liveness probe that checked the database would restart a healthy
 * server during a database blip, which is the opposite of what liveness is for.
 *
 * `/readyz` answers "should traffic be sent here", and it checks the two things that
 * change the *meaning* of a response rather than merely its availability: the
 * database, and which entailment backend is live. A deployment whose ONNX model is
 * missing still serves traffic — correctly, degrading to `needs_review` — but an
 * operator needs to be able to see that from outside the process, because the failure
 * mode of a silently-unavailable gate is a review queue that nobody can explain.
 */
import type { FastifyInstance } from "fastify";
import {
  HealthResponseSchema,
  ReadyResponseSchema,
  WhoAmIResponseSchema,
} from "@veritymem/contracts";
import { requireIdentity } from "../auth.ts";
import { toolsFor } from "../identity.ts";
import type { ServerDeps } from "../config.ts";

const started = Date.now();

export interface HealthRouteOptions {
  readonly deps: ServerDeps;
  readonly version: string;
}

export function registerHealthRoutes(app: FastifyInstance, options: HealthRouteOptions): void {
  const { deps, version } = options;

  app.get(
    "/healthz",
    {
      schema: {
        tags: ["health"],
        summary: "Liveness",
        description: "No dependencies are checked: a liveness probe that queried the database would restart a healthy process during a database outage.",
        response: { 200: HealthResponseSchema },
      },
    },
    async (_request, reply) => {
      await reply.code(200).send({ status: "ok", version, uptime_ms: Date.now() - started });
    },
  );

  app.get(
    "/readyz",
    {
      schema: {
        tags: ["health"],
        summary: "Readiness",
        description:
          "Checks the database and reports which entailment and embedding backends are live. A gate that is present but unavailable is named here rather than discovered from a review queue.",
        response: { 200: ReadyResponseSchema, 503: ReadyResponseSchema },
      },
    },
    async (_request, reply) => {
      const checks: { name: string; ok: boolean; detail: string | null }[] = [];

      try {
        await deps.db.systemQuery("SELECT 1");
        checks.push({ name: "database", ok: true, detail: null });
      } catch (error) {
        // The message is the driver's, and this endpoint is unauthenticated. Naming
        // the host and the failure class helps an operator and discloses nothing that
        // a connection refusal would not disclose anyway.
        checks.push({
          name: "database",
          ok: false,
          detail: error instanceof Error ? error.name : "unknown error",
        });
      }

      const gateOk = deps.entailment.name !== "unavailable";
      checks.push({
        name: "entailment",
        ok: gateOk,
        detail: gateOk
          ? null
          : "the configured entailment backend is unavailable; the gate degrades to needs_review rather than to ungated",
      });

      // The embedding projection is reported because a reader/writer model mismatch makes the
      // dense channel return zero rows with no error — indistinguishable, to a caller, from an
      // authorization denial. An operator should learn it here rather than from a support
      // ticket about "memory quality".
      let projection: unknown = null;
      try {
        const { projectionSummary } = await import("@veritymem/retrieval");
        projection = await projectionSummary({
          db: deps.db,
          embeddings: {
            model_id: deps.embeddings.model_id,
            dimensions: deps.embeddings.dimensions,
            isModelCall: deps.embeddings.isModelCall,
          },
        });
        const summary = projection as { compatible: boolean; detail: string };
        checks.push({
          name: "embedding_projection",
          ok: summary.compatible,
          detail: summary.compatible ? null : summary.detail,
        });
      } catch (error) {
        checks.push({
          name: "embedding_projection",
          ok: false,
          detail: error instanceof Error ? error.message : "projection summary unavailable",
        });
      }

      const ready = checks.every((check) => check.ok);
      await reply.code(ready ? 200 : 503).send({
        status: ready ? "ready" : "not_ready",
        checks,
        embedding_projection: projection,
        gate: {
          backend: deps.entailment.name,
          is_model_call: deps.entailment.isModelCall,
          model_sha256: deps.entailment.modelSha256,
          confidence_threshold: deps.policy.thresholds.entailmentFloor,
        },
        embedding: {
          backend: deps.embeddings.model_id.startsWith("hosted:") ? "openai" : "hash",
          model_id: deps.embeddings.model_id,
          dimensions: deps.embeddings.dimensions,
          is_model_call: deps.embeddings.isModelCall,
        },
      });
    },
  );

  app.get(
    "/v1/whoami",
    {
      schema: {
        tags: ["auth"],
        summary: "The resolved caller",
        description:
          "Returns the principal, tenant, profile, audiences and tool allowlist a credential resolves to. This is the endpoint that answers 'why did I get a 403' without reading the server's configuration.",
        response: { 200: WhoAmIResponseSchema },
      },
    },
    async (request, reply) => {
      const identity = requireIdentity(request);
      await reply.code(200).send({
        principal: identity.principal,
        tenant: identity.tenant ?? "",
        profile: identity.profile,
        audiences: [...identity.audiences],
        tools: [...toolsFor(identity.profile)],
      });
    },
  );
}
