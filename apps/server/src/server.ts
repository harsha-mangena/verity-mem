/**
 * Application assembly.
 *
 * `createServer` is deliberately a factory that takes its database rather than
 * opening one: a test boots the real routes against a real database it controls and
 * closes, and the process entry point (`main.ts`) is the only place that constructs a
 * pool from configuration. A factory that read `process.env` and opened a socket
 * would be untestable without a network and would make the test suite's isolation
 * story depend on ambient state.
 *
 * OpenAPI is generated from the same TypeBox schemas the routes validate against. That
 * is the reason schemas live in `@veritymem/contracts` and not inline: an inline
 * `Type.Object` would still validate, and would silently be absent from the generated
 * document, so a generated client would be missing the endpoint rather than wrong
 * about it — the harder failure to notice.
 */
import Fastify, { type FastifyInstance } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { ServerDeps } from "./config.ts";
import { assertDistinctTokens } from "./identity.ts";
import { authPlugin } from "./auth.ts";
import { installErrorHandler } from "./errors.ts";
import { registerHealthRoutes } from "./routes/health.ts";
import { createPipeline, registerEventRoutes } from "./routes/events.ts";
import { registerCandidateRoutes } from "./routes/candidates.ts";
import { registerClaimRoutes } from "./routes/claims.ts";
import { registerQueryRoutes } from "./routes/queries.ts";
import { registerActionRoutes } from "./routes/actions.ts";
import { registerFeedbackRoutes } from "./routes/operations.ts";
import { registerAdminRoutes } from "./routes/admin.ts";

export const SERVER_VERSION = "0.1.0";

export interface CreateServerOptions {
  readonly deps: ServerDeps;
  /** Turn off the interactive document in a deployment that should not expose it. */
  readonly swaggerUi?: boolean;
  readonly logger?: boolean;
}

/**
 * Build the Fastify application.
 *
 * The order of registration is the request lifecycle and is not arbitrary:
 * error handler, then swagger, then auth, then routes. The error handler goes first so
 * that a throw inside any later plugin still leaves in the single error shape; the
 * auth hook goes before the routes so that no route can be added without an identity
 * being resolved for it. A route registered before the auth plugin would silently
 * accept anonymous requests, and nothing about the route would look wrong.
 */
export async function createServer(options: CreateServerOptions): Promise<FastifyInstance> {
  const { deps } = options;
  assertDistinctTokens({ agentToken: deps.config.agentToken, adminToken: deps.config.adminToken });

  const app = Fastify({
    logger: options.logger === true,
    // The API is JSON only. A body parser that also accepted form encodings would be a
    // second input surface for no benefit.
    bodyLimit: 4 * 1024 * 1024,
    ajv: {
      customOptions: {
        // The contract schemas use `additionalProperties: false` deliberately, and
        // `removeAdditional` would strip an unknown field instead of refusing it — which
        // is how a caller's typo becomes a silently ignored parameter.
        removeAdditional: false,
        coerceTypes: false,
        allErrors: true,
      },
    },
  });

  installErrorHandler(app, {
    log: (error, request) => {
      app.log.error({ err: error, url: request.url, method: request.method }, "unhandled request failure");
    },
  });

  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "VerityMem API",
        version: SERVER_VERSION,
        description:
          "A proof-carrying memory layer for AI agents. Evidence is canonical; extracted memory is a disposable projection.\n\n" +
          "Audience separation is enforced: the agent-facing API and the administrative surface (`/v1/grants`, `/v1/forget`, `/v1/replay`, `/v1/evaluations/runs`) require different credentials. " +
          "An agent credential presented to an admin route receives 403, not 401 — the token is valid and the audience is wrong.",
        license: { name: "Apache-2.0" },
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", description: "Opaque bearer token in v0.1; see the server README." },
        },
      },
      security: [{ bearerAuth: [] }],
      tags: [
        { name: "events", description: "The canonical evidence ledger." },
        { name: "candidates", description: "Untrusted proposals and the reviewer decisions on them." },
        { name: "claims", description: "Believed state, relations, re-verification and /explain." },
        { name: "retrieval", description: "The read path: planner, composer, traces." },
        { name: "actions", description: "The action gate — the enforcement point behind every side effect." },
        { name: "operations", description: "Feedback and operational reads." },
        { name: "admin", description: "Sharing, correction, forgetting, replay, evaluation. Separate audience." },
        { name: "health", description: "Liveness and readiness." },
        { name: "auth", description: "Caller identity." },
      ],
    },
  });

  if (options.swaggerUi !== false) {
    await app.register(fastifySwaggerUi, { routePrefix: "/docs", uiConfig: { docExpansion: "list" } });
  }

  await app.register(authPlugin({ tokens: { agentToken: deps.config.agentToken, adminToken: deps.config.adminToken } }));

  const pipeline = createPipeline(deps);
  registerHealthRoutes(app, { deps, version: SERVER_VERSION });
  registerEventRoutes(app, { deps, pipeline });
  registerCandidateRoutes(app, { deps });
  registerClaimRoutes(app, { deps });
  registerQueryRoutes(app, { deps });
  registerActionRoutes(app, { deps });
  registerFeedbackRoutes(app, { deps });
  registerAdminRoutes(app, { deps });

  await app.ready();
  return app;
}
