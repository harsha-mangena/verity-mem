/**
 * HTTP response contracts.
 *
 * These live in the contract package rather than inline in the routes for one
 * reason: the contract is the single source of truth for the API surface, and a
 * response shape declared next to its handler is a shape no other consumer — the
 * SDK, the MCP server, a generated client — can see or be checked against. The
 * OpenAPI document is derived from these schemas, so an inline `Type.Object` would
 * silently drop the endpoint from the generated client.
 *
 * Two conventions are used throughout and neither is cosmetic:
 *
 *  1. A nullable field is written `Type.Union([X, Type.Null()])`, never
 *     `Type.Optional`. "Absent" and "present but empty" are different facts, and a
 *     client that cannot tell them apart will eventually treat a redacted quote as
 *     a missing one.
 *  2. Every response that confirms a refusal or a review carries the policy
 *     versions and reason codes that produced it. A refusal without its reasons is
 *     indistinguishable from a bug.
 */
import { type Static, Type } from "@sinclair/typebox";
import { ClaimCandidateSchema, ClaimRecordSchema, DecisionSchema, RetentionJobSchema } from "./claim.ts";
import { EvidenceSpanSchema } from "./event.ts";
import { ActionGateVerdictSchema, MemoryPacketSchema } from "./packet.ts";
import {
  CandidateIdSchema,
  ClaimIdSchema,
  DecisionIdSchema,
  DecisionOutcomeSchema,
  GrantIdSchema,
  InstantSchema,
  RelationKindSchema,
  SpanIdSchema,
  TraceIdSchema,
  UuidSchema,
} from "./primitives.ts";
import { GrantSchema, TenantIdSchema } from "./scope.ts";

// ---------------------------------------------------------------------------
// Shared acknowledgement
// ---------------------------------------------------------------------------

/**
 * The shape of every 202/200 acknowledgement.
 *
 * `recorded` is a boolean rather than an assumption because several VerityMem
 * operations are idempotent, and a caller that retries must be able to see that
 * nothing new was written without diffing state it may not be able to read.
 */
export const RecordedAckSchema = Type.Object(
  {
    id: Type.String({ description: "Identifier of the object the operation acted on." }),
    recorded: Type.Boolean(),
    detail: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: "RecordedAck", additionalProperties: false },
);
export type RecordedAck = Static<typeof RecordedAckSchema>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const EventExtractResponseSchema = Type.Object(
  {
    event_id: Type.String(),
    /** True when a model extractor ran; the deterministic pass alone reports false. */
    model_calls: Type.Integer({ minimum: 0 }),
    extractor_versions: Type.Array(Type.String()),
    admission: Type.Object(
      {
        trust_zone: Type.Union([Type.Literal("internal"), Type.Literal("external")]),
        instruction_like: Type.Boolean(),
        sensitive: Type.Boolean(),
        reason_codes: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
    candidates: Type.Array(CandidateIdSchema),
    claims: Type.Array(ClaimIdSchema),
    decisions: Type.Array(
      Type.Object(
        {
          decision_id: DecisionIdSchema,
          candidate_id: CandidateIdSchema,
          outcome: DecisionOutcomeSchema,
          claim_id: Type.Union([ClaimIdSchema, Type.Null()]),
          policy_version: Type.String(),
          reason_codes: Type.Array(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    notes: Type.Array(Type.String()),
    /** False when the event payload was redacted, so nothing could be re-extracted. */
    extracted: Type.Boolean(),
  },
  { $id: "EventExtractResponse", additionalProperties: false },
);
export type EventExtractResponse = Static<typeof EventExtractResponseSchema>;

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** A candidate plus the gate decisions already recorded against it. */
export const CandidateReadResponseSchema = Type.Object(
  {
    candidate: ClaimCandidateSchema,
    decisions: Type.Array(DecisionSchema),
  },
  { $id: "CandidateReadResponse", additionalProperties: false },
);
export type CandidateReadResponse = Static<typeof CandidateReadResponseSchema>;

/**
 * The response to a reviewer decision.
 *
 * Note that a `reject` outcome is a 200 carrying `outcome: "reject"`, not an
 * error. A refused candidate is a normal, recorded, policy-reachable result, and a
 * status code that conflated it with a malformed request would make the review
 * queue unreadable in an access log.
 */
export const DecisionResponseSchema = Type.Object(
  {
    candidate_id: CandidateIdSchema,
    decision_id: DecisionIdSchema,
    claim_id: Type.Union([ClaimIdSchema, Type.Null()]),
    outcome: DecisionOutcomeSchema,
    reason_codes: Type.Array(Type.String()),
    approver: Type.Union([Type.String(), Type.Null()]),
    policy_version: Type.String(),
    decided_at: InstantSchema,
    /** True when this call created the claim; false when it only recorded a refusal. */
    claim_created: Type.Boolean(),
  },
  { $id: "DecisionResponse", additionalProperties: false },
);
export type DecisionResponse = Static<typeof DecisionResponseSchema>;

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export const ClaimReadResponseSchema = Type.Object(
  {
    claim: ClaimRecordSchema,
    /** Outgoing and incoming relations, so a caller need not issue a second call. */
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
  },
  { $id: "ClaimReadResponse", additionalProperties: false },
);
export type ClaimReadResponse = Static<typeof ClaimReadResponseSchema>;

export const RelationCreateResponseSchema = Type.Object(
  {
    from_claim: ClaimIdSchema,
    to_claim: ClaimIdSchema,
    rel: RelationKindSchema,
    recorded_at: InstantSchema,
    /** False when the identical relation already existed; creation is idempotent. */
    created: Type.Boolean(),
  },
  { $id: "RelationCreateResponse", additionalProperties: false },
);
export type RelationCreateResponse = Static<typeof RelationCreateResponseSchema>;

/**
 * A re-verification of an accepted claim.
 *
 * Deliberately not a boolean: "re-verified" is only meaningful alongside the
 * digest results and any contradiction that appeared since promotion, and a bare
 * `{ ok: true }` would be exactly the single confidence number this project
 * refuses to emit.
 */
export const ClaimReverifyResponseSchema = Type.Object(
  {
    claim_id: ClaimIdSchema,
    decision_id: DecisionIdSchema,
    status: Type.String(),
    reason_codes: Type.Array(Type.String()),
    spans: Type.Array(
      Type.Object(
        {
          span_id: SpanIdSchema,
          event_id: Type.String(),
          digest_ok: Type.Boolean(),
          status: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    conflicts: Type.Array(
      Type.Object(
        {
          claim_id: ClaimIdSchema,
          rel: RelationKindSchema,
          statement: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    entailment: Type.String(),
    policy_version: Type.String(),
    verified_at: InstantSchema,
  },
  { $id: "ClaimReverifyResponse", additionalProperties: false },
);
export type ClaimReverifyResponse = Static<typeof ClaimReverifyResponseSchema>;

// ---------------------------------------------------------------------------
// Query traces
// ---------------------------------------------------------------------------

/**
 * A stored query trace.
 *
 * `query` is the planner's own JSON and grows over the trace's life (the action
 * gate appends its check to it), so it is typed as unknown rather than given a
 * schema that would have to be widened on every addition and would then be a lie.
 */
export const QueryTraceResponseSchema = Type.Object(
  {
    trace_id: TraceIdSchema,
    tenant: TenantIdSchema,
    caller: Type.String(),
    query: Type.Unknown(),
    policy_version: Type.String(),
    resolved_scope_ids: Type.Array(UuidSchema),
    candidates: Type.Unknown(),
    returned: Type.Unknown(),
    projection_watermark: Type.Integer(),
    model_calls: Type.Integer({ minimum: 0 }),
    latency_ms: Type.Union([Type.Integer(), Type.Null()]),
    created_at: InstantSchema,
  },
  { $id: "QueryTraceResponse", additionalProperties: false },
);
export type QueryTraceResponse = Static<typeof QueryTraceResponseSchema>;

/**
 * A packet with model-ready prose attached.
 *
 * The prose is additive and never a replacement: `packet` is the same object
 * `POST /v1/query` returns, and every sentence in `prose` carries its claim and
 * span identifiers so a consumer can always walk back to the evidence. `prose` is
 * nullable because the contract permits omitting it — the machine-readable
 * evidence is the required half.
 */
export const ContextComposeResponseSchema = Type.Object(
  {
    packet: MemoryPacketSchema,
    prose: Type.Union([Type.String(), Type.Null()]),
    /** Ids referenced by the prose, in the order the prose cites them. */
    citations: Type.Array(
      Type.Object(
        { claim_id: ClaimIdSchema, span_id: Type.Union([SpanIdSchema, Type.Null()]) },
        { additionalProperties: false },
      ),
    ),
    /** True when the text was produced by a deterministic renderer, not a model. */
    deterministic: Type.Boolean(),
  },
  { $id: "ContextComposeResponse", additionalProperties: false },
);
export type ContextComposeResponse = Static<typeof ContextComposeResponseSchema>;

// ---------------------------------------------------------------------------
// Action gate
// ---------------------------------------------------------------------------

/**
 * The action gate's verdict, re-declared with its own `$id`.
 *
 * The gate is reachable over HTTP as well as in-process, and a caller that has
 * only the OpenAPI document needs the schema to appear as a component. The
 * properties are identical to `ActionGateVerdict` by construction: this is the
 * same schema object under a second `$id`, not a copy that can drift.
 */
export const ActionGateHTTPResponseSchema = Type.Object(
  ActionGateVerdictSchema.properties,
  { $id: "ActionGateHTTPResponse", additionalProperties: false },
);
export type ActionGateHTTPResponse = Static<typeof ActionGateHTTPResponseSchema>;

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export const GrantCreateResponseSchema = Type.Object(
  {
    grant: GrantSchema,
    created: Type.Boolean(),
  },
  { $id: "GrantCreateResponse", additionalProperties: false },
);
export type GrantCreateResponse = Static<typeof GrantCreateResponseSchema>;

export const GrantDeleteResponseSchema = Type.Object(
  {
    grant_id: GrantIdSchema,
    deleted: Type.Boolean(),
  },
  { $id: "GrantDeleteResponse", additionalProperties: false },
);
export type GrantDeleteResponse = Static<typeof GrantDeleteResponseSchema>;

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

/**
 * Feedback is recorded as a ledger event, not as a mutable field.
 *
 * The specification is explicit that feedback produces labelled decisions and eval
 * data rather than silent online learning, so the acknowledgement names the ledger
 * event that now carries it: the correction is evidence with provenance, and it
 * cannot be edited afterwards.
 */
export const FeedbackResponseSchema = Type.Object(
  {
    feedback_event_id: Type.String(),
    trace_id: TraceIdSchema,
    seq: Type.Integer({ minimum: 1 }),
    outcome: Type.String(),
    claim_ids: Type.Array(ClaimIdSchema),
    recorded_at: InstantSchema,
  },
  { $id: "FeedbackResponse", additionalProperties: false },
);
export type FeedbackResponse = Static<typeof FeedbackResponseSchema>;

// ---------------------------------------------------------------------------
// Forget / replay / evaluations
// ---------------------------------------------------------------------------

/**
 * The retention job as returned by `POST /v1/forget` and `GET /v1/forget/{id}`.
 *
 * `residual_matches` is the field that matters: the job is `verified` only when
 * the residual scan returned zero. A job that has not scanned yet reports null
 * rather than 0, because 0 is a claim and null is the absence of one.
 */
export const ForgetResponseSchema = RetentionJobSchema;
export type ForgetResponse = Static<typeof ForgetResponseSchema>;

export const ReplayProjectionDigestSchema = Type.Object(
  {
    projection: Type.String(),
    /** Null before the operation, when the projection had never been built. */
    digest_before: Type.Union([Type.String(), Type.Null()]),
    digest_after: Type.String(),
    rows_before: Type.Union([Type.Integer(), Type.Null()]),
    rows_after: Type.Integer(),
    byte_identical: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const ReplayResultResponseSchema = Type.Object(
  {
    tenant: TenantIdSchema,
    mode: Type.Union([Type.Literal("verify"), Type.Literal("rebuild")]),
    ledger_watermark: Type.Integer({ minimum: 0 }),
    code_version: Type.String(),
    policy_version: Type.String(),
    projections: Type.Array(ReplayProjectionDigestSchema),
    deterministic: Type.Boolean(),
    duration_ms: Type.Number(),
  },
  { $id: "ReplayResultResponse", additionalProperties: false },
);
export type ReplayResultResponse = Static<typeof ReplayResultResponseSchema>;

/**
 * The result of an evaluation run.
 *
 * `stages` is empty and `notes` is populated when the deployment has no
 * evaluation runner wired: an honest "not run here" is preferable to an invented
 * metric, and the specification's own rule is that no number is published without
 * its traces.
 */
export const EvaluationRunResultSchema = Type.Object(
  {
    run_id: Type.String(),
    suite: Type.String(),
    gate: Type.Union([Type.Literal("on"), Type.Literal("off")]),
    seed: Type.Integer(),
    policy_version: Type.String(),
    gate_backend: Type.String(),
    stages: Type.Array(
      Type.Object(
        {
          stage: Type.String(),
          metrics: Type.Record(Type.String(), Type.Number()),
          failure_isolated: Type.String(),
          cases: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
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
    notes: Type.Array(Type.String()),
  },
  { $id: "EvaluationRunResult", additionalProperties: false },
);
export type EvaluationRunResult = Static<typeof EvaluationRunResultSchema>;

// ---------------------------------------------------------------------------
// Health and identity
// ---------------------------------------------------------------------------

export const HealthResponseSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("degraded")]),
    version: Type.String(),
    uptime_ms: Type.Number(),
  },
  { $id: "HealthResponse", additionalProperties: false },
);
export type HealthResponse = Static<typeof HealthResponseSchema>;

export const ReadyCheckSchema = Type.Object(
  {
    name: Type.String(),
    ok: Type.Boolean(),
    detail: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

export const ReadyResponseSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ready"), Type.Literal("not_ready")]),
    checks: Type.Array(ReadyCheckSchema),
    /**
     * Which gate backend is live and whether it is a model call. Readiness that
     * did not name this would let a deployment report ready while silently running
     * an entailment stand-in.
     */
    gate: Type.Object(
      {
        backend: Type.String(),
        is_model_call: Type.Boolean(),
        model_sha256: Type.Union([Type.String(), Type.Null()]),
        confidence_threshold: Type.Number(),
      },
      { additionalProperties: false },
    ),
    embedding: Type.Object(
      {
        backend: Type.String(),
        model_id: Type.String(),
        dimensions: Type.Integer(),
        is_model_call: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { $id: "ReadyResponse", additionalProperties: false },
);
export type ReadyResponse = Static<typeof ReadyResponseSchema>;

/** The resolved caller, as returned by `GET /v1/whoami`. */
export const WhoAmIResponseSchema = Type.Object(
  {
    principal: Type.String(),
    tenant: TenantIdSchema,
    profile: Type.String(),
    audiences: Type.Array(Type.String()),
    /** Tool names this profile may call. The allowlist is the authorization list. */
    tools: Type.Array(Type.String()),
  },
  { $id: "WhoAmIResponse", additionalProperties: false },
);
export type WhoAmIResponse = Static<typeof WhoAmIResponseSchema>;

export { EvidenceSpanSchema };
