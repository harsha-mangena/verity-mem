/**
 * The authentication and audience plugin.
 *
 * One `onRequest` hook resolves the bearer token to an identity and attaches it to
 * the request. Routes then declare *what they need* — a tool from the profile's
 * allowlist, and an audience for the administrative surface — and the checks in
 * this module are the only place either is enforced.
 *
 * The hook never rejects on its own. A request with no token reaches the route and
 * the route's `requireIdentity` produces the 401; a request with a valid token
 * reaches the route and the audience check produces the 403. Doing the rejection in
 * the hook would make an unauthenticated request and a wrong-audience request
 * indistinguishable at the point where the distinction has to be made, because the
 * hook cannot know what the route needs.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ToolName } from "@veritymem/contracts";
import { audienceMismatch, ApiError, profileInsufficient } from "./errors.ts";
import { type Audience, type Identity, type TokenConfig, profileAllows, resolveIdentity } from "./identity.ts";

export interface AuthPluginOptions {
  readonly tokens: TokenConfig;
}

/**
 * Resolve the caller, or throw the one error shape.
 *
 * `absent`, `malformed` and `unknown` all produce the same 401 body on purpose. A
 * message distinguishing "no Authorization header" from "that token is not
 * recognised" tells an unauthenticated prober which half of the problem it has,
 * and the operator gains nothing: both mean "present a valid credential".
 */
export function requireIdentity(request: FastifyRequest): Identity {
  const identity = request.identity;
  if (!identity) {
    throw new ApiError("unauthorized", "a valid bearer credential is required", 401);
  }
  return identity;
}

/**
 * Enforce the tool allowlist for a profile.
 *
 * Returns the identity so that a handler can be written as
 * `const caller = requireTool(request, "memory.record")` — the authorization and
 * the value it authorizes are the same expression, and a handler cannot obtain the
 * caller without having passed the check.
 */
export function requireTool(request: FastifyRequest, tool: ToolName): Identity {
  const identity = requireIdentity(request);
  if (!profileAllows(identity.profile, tool)) {
    throw profileInsufficient(tool, identity.profile);
  }
  return identity;
}

/**
 * Enforce the audience for an administrative route.
 *
 * This is the check that makes an agent token on `/v1/grants` a 403. The token is
 * valid and the tool may even be held by the profile; the credential is simply not
 * part of this audience, and saying so is what makes the failure diagnosable.
 */
export function requireAudience(request: FastifyRequest, audience: Audience): Identity {
  const identity = requireIdentity(request);
  if (!identity.audiences.includes(audience)) {
    throw audienceMismatch(audience);
  }
  return identity;
}

/** Both checks, for an admin route: audience first, then the specific tool. */
export function requireAdminTool(request: FastifyRequest, tool: ToolName): Identity {
  const identity = requireAudience(request, "admin");
  if (!profileAllows(identity.profile, tool)) {
    throw profileInsufficient(tool, identity.profile);
  }
  return identity;
}

/** The Fastify plugin that attaches the resolved identity to every request. */
export function authPlugin(options: AuthPluginOptions): FastifyPluginAsync {
  return async function register(app: FastifyInstance): Promise<void> {
    app.addHook("onRequest", async (request) => {
      const resolved = resolveIdentity(request.headers.authorization, options.tokens);
      // `undefined` rather than deleting the property: a request that presented a
      // credential it cannot have is indistinguishable from one that presented
      // none, which is the point.
      if (resolved.ok) request.identity = resolved.identity;
    });
  };
}
