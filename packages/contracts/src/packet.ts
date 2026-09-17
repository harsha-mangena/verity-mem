/**
 * The read path returns a MemoryPacket, never a list of snippets.
 *
 * A packet answers, in one call: what is believed, what it rests on, what
 * contradicts it, how old it is, and whether the caller may act on it.
 */
import { type Static, Type } from "@sinclair/typebox";
import {
  ACTION_RISKS,
  ActionRiskSchema,
  AuthorityClassSchema,
  ClaimIdSchema,
  ClaimKindSchema,
  ClaimStatusSchema,
  EntailmentResultSchema,
  InstantSchema,
  RelationKindSchema,
  TraceIdSchema,
  UseDecisionSchema,
} from "./primitives.ts";
import { ScopeSelectorSchema, TenantIdSchema, WriteScopeSchema } from "./scope.ts";

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export const TimeSpecSchema = Type.Union(
  [
    Type.Object({ mode: Type.Literal("current") }, { additionalProperties: false }),
    Type.Object(
      { mode: Type.Literal("as_of"), as_of: InstantSchema },
      { additionalProperties: false },
    ),
    Type.Object(
      { mode: Type.Literal("during"), from: InstantSchema, to: InstantSchema },
      { additionalProperties: false },
    ),
  ],
  { $id: "TimeSpec" },
);
export type TimeSpec = Static<typeof TimeSpecSchema>;

export const QueryRequestSchema = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 4096 }),
    scope: ScopeSelectorSchema,
    purpose: Type.String({ minLength: 1, maxLength: 128 }),
    time: Type.Optional(TimeSpecSchema),
    action_risk: Type.Optional(ActionRiskSchema),
    kinds: Type.Optional(Type.Array(ClaimKindSchema)),
    subjects: Type.Optional(Type.Array(Type.String())),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 12 })),
    /**
     * Opt-in only. The default path makes zero model calls, so latency, cost and
     * reproducibility never depend on an opaque model.
     */
    rerank: Type.Optional(
      Type.Object({ enabled: Type.Boolean({ default: false }) }, { additionalProperties: false }),
    ),
  },
  { $id: "QueryRequest", additionalProperties: false },
);
export type QueryRequest = Static<typeof QueryRequestSchema>;

// ---------------------------------------------------------------------------
// Packet
// ---------------------------------------------------------------------------

export const PacketEvidenceSchema = Type.Object(
  {
    event_id: Type.String(),
    span_id: Type.String(),
    start: Type.Integer({ minimum: 0 }),
    end: Type.Integer({ minimum: 1 }),
    /** Null when the source was redacted, so a citation can never point at nothing silently. */
    quote: Type.Union([Type.String(), Type.Null()]),
    digest: Type.String(),
    digest_ok: Type.Boolean(),
    entailment: EntailmentResultSchema,
    entailment_score: Type.Union([Type.Number(), Type.Null()]),
  },
  { $id: "PacketEvidence", additionalProperties: false },
);
export type PacketEvidence = Static<typeof PacketEvidenceSchema>;

export const PacketClaimSchema = Type.Object(
  {
    claim_id: ClaimIdSchema,
    kind: ClaimKindSchema,
    statement: Type.Object(
      { subject: Type.String(), predicate: Type.String(), object: Type.Unknown() },
      { additionalProperties: false },
    ),
    status: ClaimStatusSchema,
    authority: AuthorityClassSchema,
    use: UseDecisionSchema,
    use_reason_codes: Type.Array(Type.String()),
    scope: Type.Object(
      {
        project: Type.Union([Type.String(), Type.Null()]),
        user: Type.Union([Type.String(), Type.Null()]),
        agent: Type.Union([Type.String(), Type.Null()]),
        session: Type.Union([Type.String(), Type.Null()]),
        purpose: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
    valid_time: Type.Object(
      { from: InstantSchema, to: Type.Union([InstantSchema, Type.Null()]) },
      { additionalProperties: false },
    ),
    freshness: Type.Object(
      {
        age_days: Type.Number(),
        stale: Type.Boolean(),
        expires_at: Type.Union([InstantSchema, Type.Null()]),
      },
      { additionalProperties: false },
    ),
    evidence: Type.Array(PacketEvidenceSchema),
    conflicts: Type.Array(
      Type.Object(
        {
          claim_id: ClaimIdSchema,
          rel: RelationKindSchema,
          direction: Type.Union([Type.Literal("outgoing"), Type.Literal("incoming")]),
          statement: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    /** Independent per-channel signals. Never collapsed into one relevance number. */
    signals: Type.Object(
      {
        lexical: Type.Union([Type.Number(), Type.Null()]),
        dense: Type.Union([Type.Number(), Type.Null()]),
        entity: Type.Union([Type.Number(), Type.Null()]),
        temporal: Type.Union([Type.Number(), Type.Null()]),
        relation: Type.Union([Type.Number(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    fuse_score: Type.Number({
      description: "Rank fusion output. Relevance only — never a truth or confidence score.",
    }),
    channels: Type.Array(Type.String()),
  },
  { $id: "PacketClaim", additionalProperties: false },
);
export type PacketClaim = Static<typeof PacketClaimSchema>;

export const MemoryPacketSchema = Type.Object(
  {
    trace_id: TraceIdSchema,
    decision: UseDecisionSchema,
    decision_reason_codes: Type.Array(Type.String()),
    claims: Type.Array(PacketClaimSchema),
    /** What the system knows it does not know. */
    missing: Type.Array(Type.String()),
    coverage: Type.Object(
      {
        channels_used: Type.Array(Type.String()),
        candidates_considered: Type.Integer({ minimum: 0 }),
        candidates_after_authz: Type.Integer({ minimum: 0 }),
        candidates_returned: Type.Integer({ minimum: 0 }),
        /** Claims dropped because the caller cannot reach them. Never enumerated. */
        candidates_denied_by_authz: Type.Integer({ minimum: 0 }),
        time_mode: Type.String(),
      },
      { additionalProperties: false },
    ),
    projection_watermark: Type.Integer({ minimum: 0 }),
    policy_version: Type.String(),
    gate_backend: Type.String(),
    model_calls: Type.Integer({ minimum: 0 }),
    latency_ms: Type.Number(),
  },
  { $id: "MemoryPacket", additionalProperties: false },
);
export type MemoryPacket = Static<typeof MemoryPacketSchema>;

// ---------------------------------------------------------------------------
// Action gate
// ---------------------------------------------------------------------------

/**
 * The action gate is the enforcement point. A `verify` verdict in a packet binds
 * nothing; this call is what actually prevents a medium- or high-risk side
 * effect from being taken on memory that is stale, unusable or unreachable.
 */
export const ActionGateRequestSchema = Type.Object(
  {
    action: Type.String({ minLength: 1, maxLength: 256 }),
    action_risk: ActionRiskSchema,
    scope: ScopeSelectorSchema,
    purpose: Type.String({ minLength: 1 }),
    claim_ids: Type.Array(ClaimIdSchema, { minItems: 1, maxItems: 64 }),
    trace_id: Type.Optional(TraceIdSchema),
  },
  { $id: "ActionGateRequest", additionalProperties: false },
);
export type ActionGateRequest = Static<typeof ActionGateRequestSchema>;

export const ActionGateVerdictSchema = Type.Object(
  {
    allowed: Type.Boolean(),
    decision: UseDecisionSchema,
    reason_codes: Type.Array(Type.String()),
    /** Per-claim outcome, so a blocked action names exactly which claim blocked it. */
    claims: Type.Array(
      Type.Object(
        {
          claim_id: ClaimIdSchema,
          found: Type.Boolean(),
          use: Type.Union([UseDecisionSchema, Type.Null()]),
          reason_codes: Type.Array(Type.String()),
          age_days: Type.Union([Type.Number(), Type.Null()]),
          blocking: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    policy_version: Type.String(),
    evaluated_at: InstantSchema,
  },
  { $id: "ActionGateVerdict", additionalProperties: false },
);
export type ActionGateVerdict = Static<typeof ActionGateVerdictSchema>;

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export const FeedbackRequestSchema = Type.Object(
  {
    trace_id: TraceIdSchema,
    outcome: Type.Union([
      Type.Literal("correct"),
      Type.Literal("incorrect"),
      Type.Literal("incomplete"),
      Type.Literal("harmful"),
    ]),
    correction: Type.Optional(Type.String({ maxLength: 4096 })),
    claim_ids: Type.Optional(Type.Array(ClaimIdSchema)),
    /**
     * Where the feedback is admitted. Optional because the trace it comments on
     * already resolved a set of scopes, and the server falls back to those rather
     * than inventing one — a scope that binds nothing is a tenant-wide scope in
     * disguise, and migration 0001 refuses to create one.
     */
    scope: Type.Optional(WriteScopeSchema),
  },
  { $id: "FeedbackRequest", additionalProperties: false },
);
export type FeedbackRequest = Static<typeof FeedbackRequestSchema>;

// ---------------------------------------------------------------------------
// Evaluation runs
// ---------------------------------------------------------------------------

export const EvaluationRunRequestSchema = Type.Object(
  {
    suite: Type.Union([Type.Literal("ledgerbench"), Type.Literal("poisoning"), Type.Literal("deletion")]),
    gate: Type.Optional(Type.Union([Type.Literal("on"), Type.Literal("off")], { default: "on" })),
    seed: Type.Optional(Type.Integer({ default: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    fixtures_dir: Type.Optional(Type.String()),
  },
  { $id: "EvaluationRunRequest", additionalProperties: false },
);
export type EvaluationRunRequest = Static<typeof EvaluationRunRequestSchema>;

export const EvaluationStageResultSchema = Type.Object(
  {
    stage: Type.String(),
    metrics: Type.Record(Type.String(), Type.Number()),
    failure_isolated: Type.String(),
    cases: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type EvaluationStageResult = Static<typeof EvaluationStageResultSchema>;

export const EvaluationRunResponseSchema = Type.Object(
  {
    run_id: Type.String(),
    suite: Type.String(),
    gate: Type.Union([Type.Literal("on"), Type.Literal("off")]),
    seed: Type.Integer(),
    policy_version: Type.String(),
    gate_backend: Type.String(),
    stages: Type.Array(EvaluationStageResultSchema),
    targets: Type.Array(
      Type.Object(
        {
          name: Type.String(),
          target: Type.String(),
          observed: Type.Union([Type.Number(), Type.String(), Type.Boolean()]),
          passes: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    duration_ms: Type.Number(),
    started_at: InstantSchema,
  },
  { $id: "EvaluationRunResponse", additionalProperties: false },
);
export type EvaluationRunResponse = Static<typeof EvaluationRunResponseSchema>;

export { ACTION_RISKS };
