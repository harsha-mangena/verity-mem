/**
 * Capability tokens, the four shipped profiles, and the server-side authorization
 * check that every tool call goes through.
 *
 * Two facts drive the design:
 *
 *  1. **Tool visibility is not a security boundary.** Whether a client is *told*
 *     about `memory_forget` has no bearing on whether it can send
 *     `tools/call {"name":"memory_forget"}`. The SDK's advertised list is a
 *     usability surface; {@link authorizeToolCall} is the control, and it runs on
 *     the server for every call.
 *
 *  2. **A profile is a ceiling, not a grant.** The profile bounds which tools
 *     exist for a session; the token bounds which tenant, scope and purpose that
 *     session may touch. A `reviewer` token scoped to `project:payments` cannot
 *     decide a candidate in `project:hr`, and a call whose scope is *wider* than
 *     the token is refused rather than narrowed silently — silent narrowing is
 *     how a caller comes to believe it wrote something it did not.
 */
import type { ScopeSelector, ToolProfile } from "@veritymem/contracts";

/** The five default agent tools from the specification's MCP section. */
export const AGENT_TOOLS = [
  "memory_query",
  "memory_explain",
  "memory_record_event",
  "memory_propose",
  "memory_feedback",
] as const;

/**
 * The privileged supervisor tools.
 *
 * "Never registered in an ordinary agent session" — see
 * {@link toolsForProfile}, which is the only place registration is decided.
 */
export const PRIVILEGED_TOOLS = ["memory_decide", "memory_share", "memory_forget"] as const;

export type AgentToolName = (typeof AGENT_TOOLS)[number];
export type PrivilegedToolName = (typeof PRIVILEGED_TOOLS)[number];
export type ToolName = AgentToolName | PrivilegedToolName;

/**
 * Profile ceilings.
 *
 * The specification fixes `reader`, `contributor` and the default; it names three
 * privileged tools without saying which profile owns them. The split chosen here
 * keeps the two supervisor roles disjoint, because a reviewer who can also erase
 * a subject's memory is a single compromised token away from destroying the audit
 * trail they are reviewing:
 *
 *   - `reader`        — query, explain.
 *   - `contributor`   — + record, propose, feedback. **The default.**
 *   - `reviewer`      — + decide. The human answering `needs_review`/`quarantine`.
 *   - `privacy-admin` — + share, forget. The human answering a data-subject request.
 */
export const PROFILE_TOOLS: Readonly<Record<ToolProfile, readonly ToolName[]>> = {
  reader: ["memory_query", "memory_explain"],
  contributor: ["memory_query", "memory_explain", "memory_record_event", "memory_propose", "memory_feedback"],
  reviewer: [
    "memory_query",
    "memory_explain",
    "memory_record_event",
    "memory_propose",
    "memory_feedback",
    "memory_decide",
  ],
  "privacy-admin": [
    "memory_query",
    "memory_explain",
    "memory_record_event",
    "memory_propose",
    "memory_feedback",
    "memory_share",
    "memory_forget",
  ],
} as const;

/** The default profile. "Nothing else" is the specification's wording. */
export const DEFAULT_PROFILE: ToolProfile = "contributor";

/**
 * A capability token: the claims a session makes about itself.
 *
 * It is **unsigned on purpose**, and that is a deliberate v0.1 limitation rather
 * than an oversight. Signing it would push verification into this package, which
 * does not terminate TLS and cannot know the issuer's key; the server, which
 * authenticates the bearer credential, is the only place that can. So the token
 * is treated as *untrusted input*: {@link decodeCapabilityToken} validates every
 * field, {@link authorizeToolCall} enforces the profile ceiling before consulting
 * it, and a deployment that wants token integrity verifies the same JSON as a
 * signed envelope at its own edge. Tools never widen access on the strength of a
 * token field alone.
 */
export interface CapabilityToken {
  readonly tenant: string;
  readonly subject: string;
  readonly profile: ToolProfile;
  /** Bounds on every scope this session may name. Absent dimensions are wildcards. */
  readonly scope?: ScopeSelector;
  /** Purposes this session may read and write for. */
  readonly purposes: readonly string[];
  /** Narrows the profile's tool set. It can never widen it. */
  readonly tools?: readonly ToolName[];
  readonly expires_at?: string;
  readonly issued_at?: string;
}

/** The resolved session a transport hands to the tool layer. */
export interface AuthorizedSession {
  readonly tenant: string;
  readonly subject: string;
  readonly profile: ToolProfile;
  readonly scope: ScopeSelector;
  readonly purposes: readonly string[];
  /** Present only when the caller supplied a capability token. */
  readonly token?: CapabilityToken;
}

/** The scope a single tool call asks for, checked against the token's bound. */
export interface CallRequest {
  readonly tool: ToolName;
  readonly scope?: ScopeSelector;
  readonly purpose?: string;
}

export type AuthorizationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string; readonly message: string };

/** The tools registered for a profile, in specification order. */
export function toolsForProfile(profile: ToolProfile): readonly ToolName[] {
  return PROFILE_TOOLS[profile];
}

/** True when a tool is privileged, i.e. never registered in an ordinary session. */
export function isPrivilegedTool(tool: string): tool is PrivilegedToolName {
  return (PRIVILEGED_TOOLS as readonly string[]).includes(tool);
}

/**
 * The single authorization point for a tool call.
 *
 * Exported so it can be exercised without a transport, and called from inside
 * every handler wrapper in `tools.ts` — not from the transport, because a
 * transport-level check is bypassed the moment a second transport is added.
 * Returns a decision rather than throwing so the caller can turn a refusal into a
 * model-readable tool error instead of a protocol error.
 */
export function authorizeToolCall(session: AuthorizedSession, request: CallRequest): AuthorizationDecision {
  const granted = toolsForProfile(session.profile);
  if (!granted.includes(request.tool)) {
    return {
      allowed: false,
      code: "authz.tool_not_in_profile",
      message: `Tool ${request.tool} is not available in the ${session.profile} profile.`,
    };
  }

  // The token can only narrow the profile: an intersection, never a union.
  const tokenTools = session.token?.tools;
  if (tokenTools !== undefined && !tokenTools.includes(request.tool)) {
    return {
      allowed: false,
      code: "authz.tool_not_in_token",
      message: `Capability token does not allow ${request.tool}.`,
    };
  }

  // Expiry is checked here as well as at session construction: a long-lived stdio
  // session must stop working the moment its token expires, not at reconnect.
  const expiresAt = session.token?.expires_at;
  if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.now()) {
    return {
      allowed: false,
      code: "authz.token_expired",
      message: `Capability token expired at ${expiresAt}.`,
    };
  }

  if (request.scope !== undefined) {
    if (request.scope.tenant !== session.tenant) {
      return {
        allowed: false,
        code: "authz.tenant_mismatch",
        message: `Call names tenant "${request.scope.tenant}" but the session is bound to "${session.tenant}".`,
      };
    }
    const widened = widenedDimension(request.scope, session.scope);
    if (widened !== null) {
      return {
        allowed: false,
        code: "authz.scope_escalation",
        message: `Call widens "${widened}" beyond the session's bound scope. Ask for a narrower scope; the server will not narrow it for you.`,
      };
    }
  }

  if (request.purpose !== undefined && !session.purposes.includes(request.purpose)) {
    return {
      allowed: false,
      code: "authz.purpose_not_granted",
      message: `Purpose "${request.purpose}" is not among the session's granted purposes. A claim admitted for one purpose is not thereby available for another.`,
    };
  }

  return { allowed: true };
}

/**
 * Returns the first dimension on which `requested` is wider than `bound`, if any.
 *
 * A bound dimension that is absent means "any", so it cannot be widened. A
 * requested dimension that is absent while the bound is set means the caller is
 * asking for every project at once — the classic implicit broadening — and is
 * reported as widening.
 */
function widenedDimension(requested: ScopeSelector, bound: ScopeSelector): string | null {
  for (const dimension of ["project", "user", "agent", "session"] as const) {
    const limit = bound[dimension];
    if (limit === undefined) continue;
    const asked = requested[dimension];
    if (asked === undefined || asked !== limit) return dimension;
  }
  return null;
}

/**
 * Validates and decodes a capability token from base64url JSON.
 *
 * Every field is validated because the token is the only thing standing between a
 * profile's ceiling and a caller's claim about which tenant it belongs to.
 * Returns a refusal message rather than throwing so the stdio entry point can
 * exit with a clear diagnostic instead of a stack trace.
 */
export function decodeCapabilityToken(encoded: string): { ok: true; token: CapabilityToken } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  } catch {
    return { ok: false, reason: "capability token is not base64url-encoded JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "capability token must be a JSON object" };
  }
  const record = parsed as Record<string, unknown>;

  const tenant = record["tenant"];
  if (typeof tenant !== "string" || tenant === "") return { ok: false, reason: "capability token needs a non-empty tenant" };

  const profile = record["profile"];
  if (profile !== "reader" && profile !== "contributor" && profile !== "reviewer" && profile !== "privacy-admin") {
    return { ok: false, reason: `capability token profile must be one of reader, contributor, reviewer, privacy-admin; got ${JSON.stringify(profile)}` };
  }

  const purposes = record["purposes"];
  if (!Array.isArray(purposes) || purposes.length === 0 || !purposes.every((value) => typeof value === "string" && value !== "")) {
    return { ok: false, reason: "capability token needs at least one purpose; a token with no purpose is unreachable by design" };
  }

  const tools = record["tools"];
  if (tools !== undefined) {
    if (!Array.isArray(tools) || !tools.every((value) => isToolName(value))) {
      return { ok: false, reason: "capability token tools must be an array of known tool names" };
    }
  }

  const expiresAt = record["expires_at"];
  if (expiresAt !== undefined && (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt)))) {
    return { ok: false, reason: "capability token expires_at must be an RFC 3339 instant" };
  }

  const scope = record["scope"];
  if (scope !== undefined && !isScopeSelector(scope, tenant)) {
    return { ok: false, reason: "capability token scope must be a ScopeSelector naming the token's tenant" };
  }

  const subject = record["subject"];
  const issuedAt = record["issued_at"];

  const token: CapabilityToken = {
    tenant,
    subject: typeof subject === "string" && subject !== "" ? subject : "unattributed",
    profile,
    purposes: [...(purposes as string[])],
    ...(scope === undefined ? {} : { scope: scope as ScopeSelector }),
    ...(tools === undefined ? {} : { tools: [...(tools as ToolName[])] }),
    ...(typeof expiresAt === "string" ? { expires_at: expiresAt } : {}),
    ...(typeof issuedAt === "string" ? { issued_at: issuedAt } : {}),
  };
  return { ok: true, token };
}

/** Encodes a capability token. Used by tests and by local-first clients. */
export function encodeCapabilityToken(token: CapabilityToken): string {
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
}

/**
 * Builds the session a transport operates under.
 *
 * Without a token the session is a single-tenant, default-profile session with an
 * explicit scope: the local-first stdio case, where the operator running the
 * process is the authority. It is still subject to every authorization check,
 * which is why this is a convenience and not a bypass.
 */
export function sessionFromToken(
  token: CapabilityToken | undefined,
  fallback: { tenant: string; purposes: readonly string[]; subject?: string },
): AuthorizedSession {
  if (token === undefined) {
    return {
      tenant: fallback.tenant,
      subject: fallback.subject ?? "local-operator",
      profile: DEFAULT_PROFILE,
      scope: { tenant: fallback.tenant },
      purposes: [...fallback.purposes],
    };
  }
  return {
    tenant: token.tenant,
    subject: token.subject,
    profile: token.profile,
    scope: token.scope ?? { tenant: token.tenant },
    purposes: [...token.purposes],
    token,
  };
}

function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && ((AGENT_TOOLS as readonly string[]).includes(value) || (PRIVILEGED_TOOLS as readonly string[]).includes(value));
}

function isScopeSelector(value: unknown, tenant: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record["tenant"] !== tenant) return false;
  for (const dimension of ["project", "user", "agent", "session"] as const) {
    const bound = record[dimension];
    if (bound !== undefined && typeof bound !== "string") return false;
  }
  return true;
}
