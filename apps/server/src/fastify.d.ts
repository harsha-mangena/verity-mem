/**
 * Fastify type augmentation for the identity the auth plugin attaches.
 *
 * A `declare module` in its own file, rather than inside the plugin, because the
 * augmentation is global: putting it in the plugin module would make every file
 * that touches `request.identity` depend on importing the plugin, and the route
 * modules should depend on the *type* of a resolved caller, not on the machinery
 * that produced it.
 *
 * `identity` is optional in the type because a request that never reached the auth
 * plugin genuinely has none — a route registered outside the authenticated scope,
 * or a hook that runs first. The `requireIdentity` accessor in `auth.ts` is the
 * only sanctioned way to read it, and it turns absence into a 401 rather than a
 * crash.
 */
import type { Identity } from "./identity.ts";

declare module "fastify" {
  interface FastifyRequest {
    identity?: Identity;
  }
}
