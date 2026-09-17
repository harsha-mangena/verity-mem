/**
 * Shared primitives for every VerityMem schema.
 *
 * Two rules are enforced here rather than left to callers:
 *
 *  1. Timestamps are RFC 3339 with an explicit UTC offset. Naive local times are
 *     rejected at the edge, because a bitemporal store that accepts an ambiguous
 *     timestamp has already lost the argument about when something was believed.
 *  2. Identifiers are opaque, prefixed strings. `clm_...` and `evt_...` are
 *     distinguishable in a log line without a join.
 */
import { type Static, Type } from "@sinclair/typebox";

/** RFC 3339 instant, UTC offset required. */
export const InstantSchema = Type.String({
  format: "date-time",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?(Z|[+-]\\d{2}:\\d{2})$",
  description: "RFC 3339 instant with an explicit UTC offset.",
});
export type Instant = Static<typeof InstantSchema>;

export const UuidSchema = Type.String({ format: "uuid" });
export type Uuid = Static<typeof UuidSchema>;

const prefixedId = (prefix: string, description: string) =>
  Type.String({
    pattern: `^${prefix}_[0-9a-zA-Z]{8,64}$`,
    description,
  });

export const EventIdSchema = prefixedId("evt", "Ledger event identifier.");
export const SpanIdSchema = prefixedId("spn", "Evidence span identifier.");
export const CandidateIdSchema = prefixedId("cnd", "Claim candidate identifier.");
export const ClaimIdSchema = prefixedId("clm", "Claim identifier.");
export const DecisionIdSchema = prefixedId("dec", "Decision identifier.");
export const TraceIdSchema = prefixedId("qry", "Query trace identifier.");
export const GrantIdSchema = prefixedId("grt", "Grant identifier.");
export const RetentionJobIdSchema = prefixedId("ret", "Retention job identifier.");
export const EvaluationRunIdSchema = prefixedId("evr", "Evaluation run identifier.");

// ---------------------------------------------------------------------------
// Closed vocabularies. These mirror the Postgres enum types one-for-one; a
// divergence between a TypeScript union and a database enum is a runtime error
// waiting for the least convenient moment.
// ---------------------------------------------------------------------------

/**
 * Build a closed enum schema from a readonly tuple of strings.
 *
 * The return type is deliberately *inferred* rather than annotated. Annotating it
 * widens the static side to `string`, which silently destroys the closed
 * vocabulary — a value like `origin: "documentt"` would then typecheck and only
 * fail at the database. Inference keeps `Static<typeof OriginKindSchema>` an exact
 * string-literal union, which is what makes the TypeScript union and the Postgres
 * enum provably the same set.
 *
 * `schema_vocabulary` in the contract test asserts the inferred union matches the
 * tuple element for element, so the two cannot drift.
 */
const literals = <const T extends readonly string[]>(values: T) =>
  Type.Union(values.map((value) => Type.Literal(value)));

// ---------------------------------------------------------------------------
// Closed vocabularies
//
// These mirror the Postgres enum types one for one. A divergence between a
// TypeScript union and a database enum is a runtime error waiting for the least
// convenient moment, so `vocabulary.test.ts` asserts the database's enum labels
// and these unions are the same set.
//
// Each schema is written out explicitly rather than produced by a generic helper.
// A generic helper widens `Static<typeof XSchema>` to `string`, which leaves the
// vocabulary closed at runtime and open at compile time — the worst of both,
// because the compiler then stops catching exactly the mistakes the type exists
// to catch.
// ---------------------------------------------------------------------------

export const ORIGIN_KINDS = ["user", "agent", "tool", "document", "database", "model_inference"] as const;

/** Origin kinds, mirroring the `origin_kind` enum. Determines trust zone and default authority. */
export const OriginKindSchema = Type.Union([Type.Literal("user"), Type.Literal("agent"), Type.Literal("tool"), Type.Literal("document"), Type.Literal("database"), Type.Literal("model_inference")]);
export type OriginKind = Static<typeof OriginKindSchema>;

export const AUTHORITY_CLASSES = ["verified_record", "observation", "user_self_report", "hearsay", "inference"] as const;

/** Authority classes, mirroring the `authority_cls` enum. Never derived from retrieval relevance. */
export const AuthorityClassSchema = Type.Union([Type.Literal("verified_record"), Type.Literal("observation"), Type.Literal("user_self_report"), Type.Literal("hearsay"), Type.Literal("inference")]);
export type AuthorityClass = Static<typeof AuthorityClassSchema>;

export const CLAIM_STATUSES = ["proposed", "accepted", "disputed", "superseded", "rejected", "revoked", "expired"] as const;

/** Claim lifecycle states, mirroring the `claim_status` enum. The legal transitions live in migration 0002. */
export const ClaimStatusSchema = Type.Union([Type.Literal("proposed"), Type.Literal("accepted"), Type.Literal("disputed"), Type.Literal("superseded"), Type.Literal("rejected"), Type.Literal("revoked"), Type.Literal("expired")]);
export type ClaimStatus = Static<typeof ClaimStatusSchema>;

export const CLAIM_KINDS = ["observation", "user_self_report", "preference", "event", "decision", "plan", "hypothesis", "procedure", "permission", "derived_summary"] as const;

/** Claim kinds, mirroring the `claim_kind` enum. `procedure` and `permission` are quarantined by policy. */
export const ClaimKindSchema = Type.Union([Type.Literal("observation"), Type.Literal("user_self_report"), Type.Literal("preference"), Type.Literal("event"), Type.Literal("decision"), Type.Literal("plan"), Type.Literal("hypothesis"), Type.Literal("procedure"), Type.Literal("permission"), Type.Literal("derived_summary")]);
export type ClaimKind = Static<typeof ClaimKindSchema>;

export const DECISION_OUTCOMES = ["accept", "accept_limited_scope", "needs_review", "quarantine", "reject", "revoke"] as const;

/** Commit gate outcomes, mirroring the `decision_outcome` enum. */
export const DecisionOutcomeSchema = Type.Union([Type.Literal("accept"), Type.Literal("accept_limited_scope"), Type.Literal("needs_review"), Type.Literal("quarantine"), Type.Literal("reject"), Type.Literal("revoke")]);
export type DecisionOutcome = Static<typeof DecisionOutcomeSchema>;

export const RELATION_KINDS = ["duplicates", "narrows", "contradicts", "supersedes", "derived_from"] as const;

/** Explicit claim relations, mirroring the `relation_kind` enum. Contradiction is never inferred from adjacency. */
export const RelationKindSchema = Type.Union([Type.Literal("duplicates"), Type.Literal("narrows"), Type.Literal("contradicts"), Type.Literal("supersedes"), Type.Literal("derived_from")]);
export type RelationKind = Static<typeof RelationKindSchema>;

export const EVIDENCE_ROLES = ["supports", "refutes"] as const;

/** Whether a span supports or refutes the claim it is attached to. */
export const EvidenceRoleSchema = Type.Union([Type.Literal("supports"), Type.Literal("refutes")]);
export type EvidenceRole = Static<typeof EvidenceRoleSchema>;

export const CANDIDATE_STATES = ["pending", "extracted", "validated", "gated", "failed"] as const;

/** Candidate pipeline states, mirroring the `candidate_state` enum. */
export const CandidateStateSchema = Type.Union([Type.Literal("pending"), Type.Literal("extracted"), Type.Literal("validated"), Type.Literal("gated"), Type.Literal("failed")]);
export type CandidateState = Static<typeof CandidateStateSchema>;

export const RETENTION_MODES = ["erase", "redact", "export_then_erase"] as const;

/** Retention modes, mirroring the `retention_mode` enum. */
export const RetentionModeSchema = Type.Union([Type.Literal("erase"), Type.Literal("redact"), Type.Literal("export_then_erase")]);
export type RetentionMode = Static<typeof RetentionModeSchema>;

export const RETENTION_STATES = ["pending", "running", "scanning", "verified", "failed"] as const;

/** Retention job states, mirroring the `retention_state` enum. */
export const RetentionStateSchema = Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("scanning"), Type.Literal("verified"), Type.Literal("failed")]);
export type RetentionState = Static<typeof RetentionStateSchema>;

export const SENSITIVITIES = ["normal", "private", "high"] as const;

/** Sensitivity labels. `high` forces quarantine regardless of evidence strength. */
export const SensitivitySchema = Type.Union([Type.Literal("normal"), Type.Literal("private"), Type.Literal("high")]);
export type Sensitivity = Static<typeof SensitivitySchema>;

export const TIME_MODES = ["current", "as_of", "during"] as const;

/** The three bitemporal read modes. */
export const TimeModeSchema = Type.Union([Type.Literal("current"), Type.Literal("as_of"), Type.Literal("during")]);
export type TimeMode = Static<typeof TimeModeSchema>;

export const ACTION_RISKS = ["low", "medium", "high"] as const;

/** Action risk levels, used by the use policy and the action gate. */
export const ActionRiskSchema = Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]);
export type ActionRisk = Static<typeof ActionRiskSchema>;

export const USE_DECISIONS = ["use", "verify", "clarify", "deny"] as const;

/** The verdict a packet attaches to a claim. Advisory to a model, binding at the action gate. */
export const UseDecisionSchema = Type.Union([Type.Literal("use"), Type.Literal("verify"), Type.Literal("clarify"), Type.Literal("deny")]);
export type UseDecision = Static<typeof UseDecisionSchema>;

export const ENTAILMENT_RESULTS = ["entailed", "neutral", "contradiction", "unknown"] as const;

/** Outcome of the entailment check. `unknown` means the check could not run, and never authorises acceptance. */
export const EntailmentResultSchema = Type.Union([Type.Literal("entailed"), Type.Literal("neutral"), Type.Literal("contradiction"), Type.Literal("unknown")]);
export type EntailmentResult = Static<typeof EntailmentResultSchema>;

export const TOOL_PROFILES = ["reader", "contributor", "reviewer", "privacy-admin"] as const;

/** Capability profiles. The default is `contributor`; privileged tools are never registered in an ordinary session. */
export const ToolProfileSchema = Type.Union([Type.Literal("reader"), Type.Literal("contributor"), Type.Literal("reviewer"), Type.Literal("privacy-admin")]);
export type ToolProfile = Static<typeof ToolProfileSchema>;

