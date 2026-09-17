/**
 * Candidates are untrusted proposals. Claims are believed state. The distance
 * between the two is the commit gate, and it is the only path from one to the
 * other.
 */
import { type Static, Type } from "@sinclair/typebox";
import {
  AUTHORITY_CLASSES,
  AuthorityClassSchema,
  CandidateIdSchema,
  CandidateStateSchema,
  CLAIM_KINDS,
  ClaimIdSchema,
  ClaimKindSchema,
  ClaimStatusSchema,
  DecisionIdSchema,
  DecisionOutcomeSchema,
  EntailmentResultSchema,
  EventIdSchema,
  EvidenceRoleSchema,
  InstantSchema,
  RelationKindSchema,
  SpanIdSchema,
  UuidSchema,
} from "./primitives.ts";
import { EvidenceSpanSchema } from "./event.ts";

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export const ClaimCandidateSchema = Type.Object(
  {
    candidate_id: CandidateIdSchema,
    tenant: Type.String(),
    source_event_id: EventIdSchema,
    kind: ClaimKindSchema,
    subject: Type.String(),
    predicate: Type.String(),
    object: Type.Unknown(),
    requested_scope: Type.Object(
      {
        scope_id: UuidSchema,
        project: Type.Union([Type.String(), Type.Null()]),
        user: Type.Union([Type.String(), Type.Null()]),
        agent: Type.Union([Type.String(), Type.Null()]),
        session: Type.Union([Type.String(), Type.Null()]),
        purpose: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
    extractor: Type.String({ description: "name@version" }),
    model_version: Type.Union([Type.String(), Type.Null()]),
    prompt_version: Type.Union([Type.String(), Type.Null()]),
    confidence: Type.Union([
      Type.Number(),
      Type.Null(),
    ], { description: "Extractor confidence. Never merged with authority, freshness or conflict state." }),
    state: CandidateStateSchema,
    created_at: InstantSchema,
    evidence: Type.Array(
      Type.Object(
        { span_id: SpanIdSchema, role: EvidenceRoleSchema, span: Type.Optional(EvidenceSpanSchema) },
        { additionalProperties: false },
      ),
    ),
  },
  { $id: "ClaimCandidate", additionalProperties: false },
);
export type ClaimCandidate = Static<typeof ClaimCandidateSchema>;

/** A candidate as proposed by an extractor, before it is stored. */
export const CandidateProposalSchema = Type.Object(
  {
    kind: ClaimKindSchema,
    subject: Type.String({ minLength: 1 }),
    predicate: Type.String({ minLength: 1 }),
    object: Type.Unknown(),
    spans: Type.Array(
      Type.Object(
        {
          start: Type.Integer({ minimum: 0 }),
          end: Type.Integer({ minimum: 1 }),
          role: Type.Optional(EvidenceRoleSchema),
          selector: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    authority: Type.Optional(AuthorityClassSchema),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    requested_scope: Type.Optional(
      Type.Object(
        {
          project: Type.Optional(Type.String()),
          user: Type.Optional(Type.String()),
          agent: Type.Optional(Type.String()),
          session: Type.Optional(Type.String()),
          purpose: Type.Optional(Type.Array(Type.String())),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { $id: "CandidateProposal", additionalProperties: false },
);
export type CandidateProposal = Static<typeof CandidateProposalSchema>;

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export const ClaimEvidenceRefSchema = Type.Object(
  {
    span_id: SpanIdSchema,
    role: EvidenceRoleSchema,
    event_id: EventIdSchema,
    start: Type.Integer({ minimum: 0 }),
    end: Type.Integer({ minimum: 1 }),
    /** Null when the source event was redacted under retention. */
    quote: Type.Union([Type.String(), Type.Null()]),
    digest: Type.String(),
    /** Recomputed on this read, not cached. */
    digest_ok: Type.Boolean(),
    entailment: EntailmentResultSchema,
    entailment_score: Type.Union([Type.Number(), Type.Null()]),
    extractor: Type.Union([Type.String(), Type.Null()]),
    model_version: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: "ClaimEvidenceRef", additionalProperties: false },
);
export type ClaimEvidenceRef = Static<typeof ClaimEvidenceRefSchema>;

/**
 * Every returned claim carries six separate dimensions. There is no `confidence`
 * field on this object and there never will be: averaging them destroys
 * interpretability and invites unsafe thresholding. Hard API rule, not taste.
 */
export const ClaimRecordSchema = Type.Object(
  {
    claim_id: ClaimIdSchema,
    tenant: Type.String(),
    kind: ClaimKindSchema,
    subject: Type.String(),
    predicate: Type.String(),
    object: Type.Unknown(),
    /** Convenience rendering only; consumers must read subject/predicate/object. */
    statement: Type.String(),
    status: ClaimStatusSchema,
    authority: AuthorityClassSchema,
    scope: Type.Object(
      {
        scope_id: UuidSchema,
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
    recorded_at: InstantSchema,
    expires_at: Type.Union([InstantSchema, Type.Null()]),
    freshness: Type.Object(
      {
        age_days: Type.Number(),
        stale: Type.Boolean(),
        staleness_horizon_days: Type.Number(),
      },
      { additionalProperties: false },
    ),
    evidence: Type.Array(ClaimEvidenceRefSchema),
    conflicts: Type.Array(
      Type.Object(
        {
          claim_id: ClaimIdSchema,
          rel: RelationKindSchema,
          direction: Type.Union([Type.Literal("outgoing"), Type.Literal("incoming")]),
          statement: Type.Optional(Type.String()),
          status: Type.Optional(ClaimStatusSchema),
        },
        { additionalProperties: false },
      ),
    ),
    promotion: Type.Object(
      {
        decided_by: Type.Union([Type.String(), Type.Null()]),
        policy_version: Type.Union([Type.String(), Type.Null()]),
        outcome: Type.Union([DecisionOutcomeSchema, Type.Null()]),
        reason_codes: Type.Array(Type.String()),
        decided_at: Type.Union([InstantSchema, Type.Null()]),
      },
      { additionalProperties: false },
    ),
  },
  { $id: "ClaimRecord", additionalProperties: false },
);
export type ClaimRecord = Static<typeof ClaimRecordSchema>;

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export const DecisionSchema = Type.Object(
  {
    decision_id: DecisionIdSchema,
    candidate_id: Type.Union([CandidateIdSchema, Type.Null()]),
    claim_id: Type.Union([ClaimIdSchema, Type.Null()]),
    policy_version: Type.String(),
    outcome: DecisionOutcomeSchema,
    reason_codes: Type.Array(Type.String()),
    approver: Type.Union([Type.String(), Type.Null()]),
    detail: Type.Unknown(),
    decided_at: InstantSchema,
  },
  { $id: "Decision", additionalProperties: false },
);
export type Decision = Static<typeof DecisionSchema>;

export const DecisionRequestSchema = Type.Object(
  {
    outcome: DecisionOutcomeSchema,
    reason: Type.String({ minLength: 1, maxLength: 1024 }),
    reason_codes: Type.Optional(Type.Array(Type.String())),
    approver: Type.Optional(Type.String()),
  },
  { $id: "DecisionRequest", additionalProperties: false },
);
export type DecisionRequest = Static<typeof DecisionRequestSchema>;

export const RelationCreateRequestSchema = Type.Object(
  {
    to_claim: ClaimIdSchema,
    rel: RelationKindSchema,
  },
  { $id: "RelationCreateRequest", additionalProperties: false },
);
export type RelationCreateRequest = Static<typeof RelationCreateRequestSchema>;

// ---------------------------------------------------------------------------
// Explain — the product endpoint
// ---------------------------------------------------------------------------

/**
 * The full promotion history of a claim. If this endpoint is slow or incomplete,
 * nothing else about VerityMem matters.
 */
export const ClaimExplanationSchema = Type.Object(
  {
    claim_id: ClaimIdSchema,
    claim: ClaimRecordSchema,
    origin_event: Type.Object(
      {
        event_id: EventIdSchema,
        stream_id: Type.String(),
        seq: Type.Integer({ minimum: 1 }),
        actor_id: Type.String(),
        origin: Type.String(),
        occurred_at: InstantSchema,
        recorded_at: InstantSchema,
        content: Type.Union([Type.String(), Type.Null()]),
        redacted_at: Type.Union([InstantSchema, Type.Null()]),
      },
      { additionalProperties: false },
    ),
    /** Every span that ever supported or refuted this claim, with its quoted text. */
    spans: Type.Array(
      Type.Object(
        {
          span_id: SpanIdSchema,
          role: EvidenceRoleSchema,
          event_id: EventIdSchema,
          start: Type.Integer(),
          end: Type.Integer(),
          quote: Type.Union([Type.String(), Type.Null()]),
          digest: Type.String(),
          digest_ok: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    /** Every decision that touched this claim, oldest first. */
    decisions: Type.Array(DecisionSchema),
    candidate: Type.Union([ClaimCandidateSchema, Type.Null()]),
    relations: Type.Array(
      Type.Object(
        {
          from_claim: ClaimIdSchema,
          to_claim: ClaimIdSchema,
          rel: RelationKindSchema,
          direction: Type.Union([Type.Literal("outgoing"), Type.Literal("incoming")]),
          recorded_at: InstantSchema,
        },
        { additionalProperties: false },
      ),
    ),
    /** Versions in force when this explanation was produced. */
    versions: Type.Object(
      {
        policy_version: Type.String(),
        gate_backend: Type.String(),
        gate_model_sha256: Type.Union([Type.String(), Type.Null()]),
        projections: Type.Array(
          Type.Object(
            {
              projection: Type.String(),
              code_version: Type.String(),
              model_version: Type.Union([Type.String(), Type.Null()]),
              model_sha256: Type.Union([Type.String(), Type.Null()]),
              ledger_watermark: Type.Integer(),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    reason_help: Type.Record(Type.String(), Type.String()),
    produced_in_ms: Type.Number(),
  },
  { $id: "ClaimExplanation", additionalProperties: false },
);
export type ClaimExplanation = Static<typeof ClaimExplanationSchema>;

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export const ProjectionDigestSchema = Type.Object(
  {
    projection: Type.String(),
    digest: Type.String({ description: "Lowercase hex SHA-256 over the canonical serialization." }),
    rows: Type.Integer({ minimum: 0 }),
    ledger_watermark: Type.Integer(),
  },
  { additionalProperties: false },
);
export type ProjectionDigest = Static<typeof ProjectionDigestSchema>;

export const ReplayRequestSchema = Type.Object(
  {
    /** Rebuild instead of only comparing digests. */
    mode: Type.Optional(
      Type.Union([Type.Literal("verify"), Type.Literal("rebuild")], { default: "verify" }),
    ),
    /** Truncate the ledger at this sequence for a deterministic partial rebuild. */
    up_to_seq: Type.Optional(Type.Integer({ minimum: 1 })),
    /**
     * Which projections to compare. Names match the implementation rather than an
     * earlier draft of this schema: `dense` is the pgvector embedding projection,
     * `lexical` is the trigger-maintained full-text projection, `entities` is the
     * alias table. A schema that names a projection the code does not have is a
     * request an operator can make and nothing can answer.
     */
    projections: Type.Optional(
      Type.Array(Type.Union([Type.Literal("dense"), Type.Literal("lexical"), Type.Literal("entities")])),
    ),
  },
  { $id: "ReplayRequest", additionalProperties: false },
);
export type ReplayRequest = Static<typeof ReplayRequestSchema>;

export const ReplayResponseSchema = Type.Object(
  {
    ledger_watermark: Type.Integer(),
    code_version: Type.String(),
    policy_version: Type.String(),
    projections: Type.Array(
      Type.Object(
        {
          projection: Type.String(),
          /** Digest before the operation. */
          before: Type.Union([ProjectionDigestSchema, Type.Null()]),
          /** Digest after the operation. */
          after: ProjectionDigestSchema,
          byte_identical: Type.Boolean(),
          rebuilt_rows: Type.Integer(),
        },
        { additionalProperties: false },
      ),
    ),
    deterministic: Type.Boolean(),
    duration_ms: Type.Number(),
  },
  { $id: "ReplayResponse", additionalProperties: false },
);
export type ReplayResponse = Static<typeof ReplayResponseSchema>;

// ---------------------------------------------------------------------------
// Forget
// ---------------------------------------------------------------------------

export const ForgetRequestSchema = Type.Object(
  {
    subject_or_scope: Type.Object(
      {
        tenant: Type.Optional(Type.String()),
        project: Type.Optional(Type.String()),
        user: Type.Optional(Type.String()),
        agent: Type.Optional(Type.String()),
        session: Type.Optional(Type.String()),
        actor_id: Type.Optional(Type.String()),
        subject: Type.Optional(Type.String({ description: "Claim subject, e.g. user:alice." })),
      },
      { additionalProperties: false },
    ),
    mode: Type.Optional(Type.Union([Type.Literal("erase"), Type.Literal("redact"), Type.Literal("export_then_erase")])),
    reason: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { $id: "ForgetRequest", additionalProperties: false },
);
export type ForgetRequest = Static<typeof ForgetRequestSchema>;

export const RetentionJobSchema = Type.Object(
  {
    job_id: Type.String(),
    tenant: Type.String(),
    subject_or_scope: Type.Unknown(),
    mode: Type.Union([Type.Literal("erase"), Type.Literal("redact"), Type.Literal("export_then_erase")]),
    reason: Type.String(),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("running"),
      Type.Literal("scanning"),
      Type.Literal("verified"),
      Type.Literal("failed"),
    ]),
    stores_touched: Type.Array(Type.String()),
    manifest: Type.Unknown(),
    residual_matches: Type.Union([Type.Integer(), Type.Null()]),
    created_at: InstantSchema,
    updated_at: InstantSchema,
    verified_at: Type.Union([InstantSchema, Type.Null()]),
  },
  { $id: "RetentionJob", additionalProperties: false },
);
export type RetentionJob = Static<typeof RetentionJobSchema>;

export { AUTHORITY_CLASSES, CLAIM_KINDS };
