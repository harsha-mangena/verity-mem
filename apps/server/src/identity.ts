/**
 * Tokens, profiles and audiences.
 *
 * Two independent decisions are made about a request, and conflating them is the
 * mistake this module exists to prevent:
 *
 *   * **Audience** — which *class of credential* is being presented. The
 *     agent-facing API and the administrative surface are different audiences, so
 *     an agent token reaching `/v1/grants` is a valid credential in the wrong
 *     place. That is a 403, not a 401. The distinction is not pedantry: a 401
 *     sends an operator to look for a missing or expired token, and a 403 sends
 *     them to look at the profile and the audience, which is where the actual
 *     problem is.
 *   * **Profile** — which *tools* the caller holds within its audience. The four
 *     profiles from the specification, with `contributor` as the default.
 *
 * Tokens are opaque in v0.1 and read from configuration. This is a placeholder and
 * is described as one: a real deployment replaces `resolveIdentity` with capability
 * tokens that carry tenant, scope, purpose, tool allowlist and expiry, and the rest
 * of the server does not change because everything downstream already treats the
 * resolved identity as an input rather than as a token.
 *
 * Tenant derivation deserves its own note. The tenant comes from the token, never
 * from the request body, and this module is where that is decided. The optional
 * `tenant:<slug>:` prefix on a configured token exists so that a multi-tenant
 * deployment has *some* way to bind a credential to a tenant before capability
 * tokens exist; without it, every token is tenant-less and every write must name
 * its tenant, which is precisely the caller-chooses-its-own-tenant shape the
 * server refuses.
 */
import { DEFAULT_TOOL_PROFILE, PROFILE_TOOLS, profileAllows, type ToolName } from "@veritymem/contracts";

export type Profile = keyof typeof PROFILE_TOOLS;

/**
 * Audiences. `agent` is the ordinary API surface; `admin` is grants, forgetting,
 * replay and evaluation. A profile may hold both only if it is the privacy
 * administrator.
 */
export const AUDIENCES = ["agent", "admin"] as const;
export type Audience = (typeof AUDIENCES)[number];

export interface Identity {
  /** Who is acting. Not a secret; it appears in the ledger's `actor_id`. */
  readonly principal: string;
  /**
   * The tenant slug the credential is bound to, or null when the credential is not
   * tenant-bound. Null is not "all tenants": a tenant-less credential may only act
   * on a tenant it names explicitly, and the naming is checked against the same
   * rule as everything else.
   */
  readonly tenant: string | null;
  readonly profile: Profile;
  readonly audiences: readonly Audience[];
  /** Which configured credential was presented. Useful in logs; never returned raw. */
  readonly credential: "agent" | "admin";
}

/** Audiences implied by a profile. Not configurable: the matrix is the specification's. */
export const PROFILE_AUDIENCES: Readonly<Record<Profile, readonly Audience[]>> = {
  reader: ["agent"],
  contributor: ["agent"],
  reviewer: ["agent"],
  "privacy-admin": ["agent", "admin"],
};

/**
 * The tool that guards each administrative route.
 *
 * Held separately from `PROFILE_TOOLS` because the check has two halves that fail
 * differently: a profile can hold `memory.forget` and still present a credential
 * without the `admin` audience, and the operator needs to see which half failed.
 */
export const ADMIN_TOOLS: readonly ToolName[] = [
  "memory.share",
  "memory.forget",
  "memory.replay",
  "memory.evaluate",
];

export interface TokenConfig {
  readonly agentToken: string;
  readonly adminToken: string;
}

/**
 * Parse the optional tenant prefix from a configured token.
 *
 * `tenant:acme:s3cret` binds the credential to the tenant `acme`. The slug is
 * taken verbatim — it is a slug, not an id, and `resolveTenantId` is the only
 * place that turns one into a UUID.
 */
export function parseTokenBinding(token: string): { tenant: string | null; secret: string } {
  if (!token.startsWith("tenant:")) return { tenant: null, secret: token };
  const rest = token.slice("tenant:".length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return { tenant: null, secret: token };
  const tenant = rest.slice(0, separator);
  const secret = rest.slice(separator + 1);
  if (tenant.length === 0 || secret.length === 0) return { tenant: null, secret: token };
  return { tenant, secret };
}

/**
 * Resolve a presented token to an identity, or null when it matches nothing.
 *
 * The admin token is checked first so that a deployment which carelessly configures
 * the same secret for both cannot end up with an administrative credential being
 * downgraded to the agent profile. Refusing to share a secret would be better still,
 * and `assertDistinctTokens` does that at startup; this ordering is the belt to that
 * braces.
 *
 * Comparison is by full string equality on the configured secret, after the tenant
 * prefix is stripped. No hashing, no timing defence: an opaque shared secret
 * compared with `===` is the honest description of a v0.1 placeholder, and a
 * constant-time comparison here would imply a threat model this placeholder does
 * not have.
 */
export function resolveIdentity(
  authorizationHeader: string | undefined,
  config: TokenConfig,
): { ok: true; identity: Identity } | { ok: false; reason: "absent" | "malformed" | "unknown" } {
  if (authorizationHeader === undefined || authorizationHeader.trim() === "") {
    return { ok: false, reason: "absent" };
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match || !match[1]) return { ok: false, reason: "malformed" };
  const presented = match[1].trim();
  if (presented.length === 0) return { ok: false, reason: "malformed" };

  const admin = parseTokenBinding(config.adminToken);
  if (presented === config.adminToken || (admin.secret.length > 0 && presented === admin.secret)) {
    return {
      ok: true,
      identity: {
        principal: "admin:operator",
        tenant: admin.tenant,
        profile: "privacy-admin",
        audiences: PROFILE_AUDIENCES["privacy-admin"],
        credential: "admin",
      },
    };
  }

  const agent = parseTokenBinding(config.agentToken);
  if (presented === config.agentToken || (agent.secret.length > 0 && presented === agent.secret)) {
    return {
      ok: true,
      identity: {
        principal: "agent:client",
        tenant: agent.tenant,
        profile: DEFAULT_TOOL_PROFILE,
        audiences: PROFILE_AUDIENCES[DEFAULT_TOOL_PROFILE],
        credential: "agent",
      },
    };
  }

  return { ok: false, reason: "unknown" };
}

/**
 * Refuse to start when the two credentials are the same string.
 *
 * Audience separation is a hard requirement and two identical tokens make it
 * unobservable: every admin route would accept the agent credential and every test
 * would still pass. A startup failure is the only place this can be caught
 * cheaply.
 */
export function assertDistinctTokens(config: TokenConfig): void {
  if (config.agentToken.length === 0 || config.adminToken.length === 0) {
    throw new Error("AGENT_TOKEN and ADMIN_TOKEN must both be set; an empty credential authenticates nobody, but a default one authenticates everybody");
  }
  if (config.agentToken === config.adminToken) {
    throw new Error(
      "AGENT_TOKEN and ADMIN_TOKEN are the same value; audience separation is unenforceable when both audiences share a credential",
    );
  }
  if (parseTokenBinding(config.agentToken).secret === parseTokenBinding(config.adminToken).secret) {
    throw new Error(
      "AGENT_TOKEN and ADMIN_TOKEN differ only by their tenant prefix; the bearer secret must be distinct, not just the binding",
    );
  }
}

/** The tool names a profile holds, for `GET /v1/whoami`. */
export function toolsFor(profile: Profile): readonly ToolName[] {
  return PROFILE_TOOLS[profile];
}

export { profileAllows };
