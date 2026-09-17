/**
 * Capability profiles.
 *
 * The specification ships four profiles and says plainly that tool visibility is
 * not a security boundary — the server re-authorizes every call. This module is
 * the *server-side* half of that statement: it is the allowlist the route handlers
 * consult, so hiding a tool from a client and refusing it at the server are the
 * same fact recorded once.
 *
 * Two rules the shape encodes:
 *
 *  1. `contributor` is the default. Everything privileged is an explicit
 *     addition, because a default that grants is a default that leaks.
 *  2. The allowlist is over *tools*, not over profiles, and each tool is named
 *     after the operation rather than the path. A profile that may read an event
 *     and a profile that may append one are different capabilities even though
 *     both are "event" routes, and naming the tool after the route would collapse
 *     them the first time a route gained a second verb.
 *
 * This module lives in the contract package rather than the server because the MCP
 * server and the SDK must agree on the same vocabulary. Two allowlists that
 * describe the same profile is how "the MCP server exposed it but the REST server
 * refused it" becomes a bug report instead of an impossibility.
 */
import { type Static, Type } from "@sinclair/typebox";
import { TOOL_PROFILES, ToolProfileSchema } from "./primitives.ts";

/** Every operation a profile can be granted. Closed set, like the other vocabularies. */
export const TOOL_NAMES = [
  "memory.query",
  "memory.compose",
  "memory.explain",
  "memory.trace",
  "memory.claim.read",
  "memory.candidate.read",
  "memory.event.read",
  "memory.record",
  "memory.propose",
  "memory.feedback",
  "memory.decide",
  "memory.relate",
  "memory.reverify",
  "action.gate",
  "memory.share",
  "memory.forget",
  "memory.replay",
  "memory.evaluate",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * Which tools each profile holds.
 *
 * Read this as the authorization matrix. The ordering of the profiles is
 * increasing privilege: each list is a superset of the one above it, and
 * `profiles.ts` is the only place that relationship is expressed.
 */
export const PROFILE_TOOLS: Readonly<Record<(typeof TOOL_PROFILES)[number], readonly ToolName[]>> = {
  /**
   * Read-only. query, compose, explain, trace and the object reads.
   *
   * `action.gate` is deliberately absent: the action gate re-reads claims and
   * re-verifies evidence, but it is the enforcement point in front of a side
   * effect, and a caller that only reads has no side effect to gate.
   */
  reader: [
    "memory.query",
    "memory.compose",
    "memory.explain",
    "memory.trace",
    "memory.claim.read",
    "memory.candidate.read",
    "memory.event.read",
  ],
  /**
   * The default. Everything a reader may do, plus recording evidence, proposing
   * candidates from it, and reporting feedback about a packet.
   *
   * Note that `memory.decide` is absent. Proposing is not deciding: an agent that
   * can append evidence must not also be able to promote its own conclusion, or
   * the commit gate is a formality.
   */
  contributor: [
    "memory.query",
    "memory.compose",
    "memory.explain",
    "memory.trace",
    "memory.claim.read",
    "memory.candidate.read",
    "memory.event.read",
    "memory.record",
    "memory.propose",
    "memory.feedback",
    "action.gate",
  ],
  /**
   * A human or supervisory session. Adds the decisions that a human is permitted
   * to make and the corrections that follow from them.
   */
  reviewer: [
    "memory.query",
    "memory.compose",
    "memory.explain",
    "memory.trace",
    "memory.claim.read",
    "memory.candidate.read",
    "memory.event.read",
    "memory.record",
    "memory.propose",
    "memory.feedback",
    "action.gate",
    "memory.decide",
    "memory.relate",
    "memory.reverify",
  ],
  /**
   * The privacy administrator. Adds sharing, forgetting, replay and evaluation.
   *
   * These four are a separate audience as well as a separate profile, because
   * they are the operations that change or prove what the system still holds. An
   * agent token reaching any of them is a design failure, not a misconfiguration.
   */
  "privacy-admin": [
    "memory.query",
    "memory.compose",
    "memory.explain",
    "memory.trace",
    "memory.claim.read",
    "memory.candidate.read",
    "memory.event.read",
    "memory.record",
    "memory.propose",
    "memory.feedback",
    "action.gate",
    "memory.decide",
    "memory.relate",
    "memory.reverify",
    "memory.share",
    "memory.forget",
    "memory.replay",
    "memory.evaluate",
  ],
};

/** The default profile. The specification fixes this; it is not a deployment choice. */
export const DEFAULT_TOOL_PROFILE = "contributor" as const;

export const ProfileNameSchema = ToolProfileSchema;

/**
 * A profile with its allowlist, as returned by `GET /v1/whoami`.
 *
 * The `tools` array is drawn from `TOOL_NAMES` rather than `Type.String()`: a
 * caller writing a capability check against this document should be unable to
 * misspell a tool into a permanent `false`.
 */
export const ToolProfileConfigSchema = Type.Object(
  {
    profile: ToolProfileSchema,
    tools: Type.Array(Type.Union(TOOL_NAMES.map((tool) => Type.Literal(tool)))),
    default_tool: Type.Union(TOOL_NAMES.map((tool) => Type.Literal(tool))),
    privileged: Type.Boolean({
      description: "True for profiles that are never registered in an ordinary agent session.",
    }),
  },
  { $id: "ToolProfileConfig", additionalProperties: false },
);
export type ToolProfileConfig = Static<typeof ToolProfileConfigSchema>;

/**
 * Does this profile hold this tool?
 *
 * A function rather than an `includes` at each call site so that a tool added to
 * `TOOL_NAMES` without being added to any profile is a refusal everywhere rather
 * than an accidental grant in the one route that forgot to check.
 */
export function profileAllows(profile: (typeof TOOL_PROFILES)[number], tool: ToolName): boolean {
  return PROFILE_TOOLS[profile].includes(tool);
}
