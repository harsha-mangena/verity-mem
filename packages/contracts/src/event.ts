/**
 * Events are the canonical record. Everything else in VerityMem is derived from
 * them and can be thrown away and rebuilt.
 *
 * An append is acknowledged durably *before* extraction. That ordering is the
 * reason a model outage degrades the system to "unextracted" rather than
 * "lost", and it is why `EventAppendResponse` reports extraction state rather
 * than awaiting it.
 */
import { type Static, Type } from "@sinclair/typebox";
import {
  EventIdSchema,
  InstantSchema,
  OriginKindSchema,
  SensitivitySchema,
  SpanIdSchema,
  UuidSchema,
} from "./primitives.ts";
import { WriteScopeSchema } from "./scope.ts";

export const EventAppendRequestSchema = Type.Object(
  {
    stream_id: Type.String({
      minLength: 1,
      maxLength: 256,
      description: "Logical source of a totally ordered sequence, e.g. thread:9 or repo:acme/payments.",
    }),
    idempotency_key: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 256,
        description: "Unique per tenant. A replay returns the original event instead of appending a second one.",
      }),
    ),
    origin: OriginKindSchema,
    actor_id: Type.String({ minLength: 1, maxLength: 256 }),
    scope: WriteScopeSchema,
    occurred_at: InstantSchema,
    content: Type.String({ minLength: 1 }),
    media_type: Type.Optional(Type.String({ default: "text/plain" })),
    sensitivity: Type.Optional(SensitivitySchema),
    /** Per-stream sequence assertions from an upstream producer, if it has them. */
    expected_seq: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { $id: "EventAppendRequest", additionalProperties: false },
);
export type EventAppendRequest = Static<typeof EventAppendRequestSchema>;

export const ExtractionStateSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("skipped"),
  Type.Literal("unsupported"),
]);
export type ExtractionState = Static<typeof ExtractionStateSchema>;

export const EventAppendResponseSchema = Type.Object(
  {
    event_id: EventIdSchema,
    seq: Type.Integer({ minimum: 1 }),
    recorded_at: InstantSchema,
    extraction: ExtractionStateSchema,
    /** True when the idempotency key matched an existing event; nothing was appended. */
    deduplicated: Type.Boolean(),
    content_hash: Type.String({ description: "Lowercase hex SHA-256 of the exact payload bytes." }),
    prev_hash: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: "EventAppendResponse", additionalProperties: false },
);
export type EventAppendResponse = Static<typeof EventAppendResponseSchema>;

/**
 * A stored event as returned by GET /v1/events/{id}.
 *
 * `content` is null exactly when `redacted_at` is set: retention removes the bytes
 * while keeping the row, so the system can still testify the event existed and
 * when. Deletion is proven by residual scan, never assumed.
 */
export const EventRecordSchema = Type.Object(
  {
    event_id: EventIdSchema,
    stream_id: Type.String(),
    seq: Type.Integer({ minimum: 1 }),
    tenant: Type.String(),
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
    origin: OriginKindSchema,
    actor_id: Type.String(),
    occurred_at: InstantSchema,
    recorded_at: InstantSchema,
    content: Type.Union([Type.String(), Type.Null()]),
    payload_ref: Type.Union([Type.String(), Type.Null()]),
    content_hash: Type.String(),
    prev_hash: Type.Union([Type.String(), Type.Null()]),
    chained: Type.Boolean(),
    sensitivity: SensitivitySchema,
    media_type: Type.String(),
    byte_length: Type.Integer({ minimum: 0 }),
    redacted_at: Type.Union([InstantSchema, Type.Null()]),
    idempotency_key: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: "EventRecord", additionalProperties: false },
);
export type EventRecord = Static<typeof EventRecordSchema>;

/**
 * The exact bytes supporting a claim.
 *
 * `digest` is SHA-256 over the payload slice [start, end). It is checked on every
 * read, so a span cannot silently come to mean something else after a payload is
 * rewritten, migrated, or re-encoded.
 */
export const EvidenceSpanSchema = Type.Object(
  {
    span_id: SpanIdSchema,
    event_id: EventIdSchema,
    start: Type.Integer({ minimum: 0 }),
    end: Type.Integer({ minimum: 1 }),
    selector: Type.Optional(Type.String({ description: "For structured or DOM payloads." })),
    digest: Type.String({ description: "Lowercase hex SHA-256 of the span bytes." }),
    quote: Type.String(),
  },
  { $id: "EvidenceSpan", additionalProperties: false },
);
export type EvidenceSpan = Static<typeof EvidenceSpanSchema>;
