/**
 * The append-only ledger.
 *
 * Everything else in VerityMem is derived from this module's output and can be
 * deleted and rebuilt. Three properties are load-bearing:
 *
 *   - an append is durable before extraction is attempted, so a model outage
 *     degrades the system to "unextracted" rather than "lost";
 *   - a span points at exact bytes and carries a digest checked on every read,
 *     so evidence cannot silently come to mean something else;
 *   - the ledger is append-only at the database level, not by convention.
 */
import { createHash } from "node:crypto";
import type { ClaimKind, EventAppendRequest, OriginKind } from "@veritymem/contracts";
import { type BlobStore, sha256Bytes, sha256Hex } from "./blobs.ts";
import { canonicalize } from "./canonical.ts";
import type { Db, QueryExecutor } from "./db.ts";
import type { Clock, IdGenerator } from "./ids.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedScope {
  readonly scope_id: string;
  readonly tenant_id: string;
  readonly project: string | null;
  readonly user: string | null;
  readonly agent: string | null;
  readonly session: string | null;
  readonly purpose: readonly string[];
}

export interface LedgerReceipt {
  readonly event_id: string;
  readonly seq: number;
  readonly recorded_at: string;
  readonly scope: ResolvedScope;
  readonly content_hash: string;
  readonly prev_hash: string | null;
  readonly deduplicated: boolean;
  readonly extraction_queued: boolean;
}

export interface LedgerEvent {
  readonly event_id: string;
  readonly stream_id: string;
  readonly seq: number;
  readonly tenant_id: string;
  readonly scope: ResolvedScope;
  readonly origin: OriginKind;
  readonly actor_id: string;
  readonly occurred_at: string;
  readonly recorded_at: string;
  readonly content: string | null;
  readonly payload_ref: string | null;
  readonly content_hash: string;
  readonly prev_hash: string | null;
  readonly chained: boolean;
  readonly sensitivity: string;
  readonly media_type: string;
  readonly byte_length: number;
  readonly redacted_at: string | null;
  readonly idempotency_key: string | null;
}

export interface SpanRecord {
  readonly span_id: string;
  readonly event_id: string;
  readonly start: number;
  readonly end: number;
  readonly selector: string | null;
  readonly digest: string;
  readonly quote: string;
}

export type SpanVerification =
  | { readonly status: "ok"; readonly quote: string; readonly span: SpanRecord; readonly event: LedgerEvent }
  | { readonly status: "missing"; readonly reason: "span_not_found" | "event_not_found" }
  | { readonly status: "redacted"; readonly span: SpanRecord; readonly event: LedgerEvent }
  | { readonly status: "digest_mismatch"; readonly span: SpanRecord; readonly expected: string; readonly actual: string }
  | { readonly status: "out_of_bounds"; readonly span: SpanRecord; readonly payload_length: number };

export interface ProposalSpanInput {
  readonly start: number;
  readonly end: number;
  readonly role?: "supports" | "refutes" | undefined;
  readonly selector?: string | undefined;
}

export interface CandidateInput {
  readonly kind: ClaimKind;
  readonly subject: string;
  readonly predicate: string;
  readonly object: unknown;
  readonly spans: readonly ProposalSpanInput[];
  readonly requested_scope?: {
    readonly project?: string;
    readonly user?: string;
    readonly agent?: string;
    readonly session?: string;
    readonly purpose?: readonly string[];
  };
  readonly confidence?: number;
}

export class LedgerError extends Error {
  readonly code:
    | "idempotency_conflict"
    | "scope_out_of_authority"
    | "invalid_span"
    | "sequence_conflict"
    | "not_found";
  readonly statusCode: number;

  constructor(code: LedgerError["code"], message: string, statusCode = 409) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface LedgerOptions {
  readonly db: Db;
  readonly blobs: BlobStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly inlinePayloadLimit?: number;
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

export interface ScopeInput {
  readonly tenant: string;
  readonly project?: string | undefined;
  readonly user?: string | undefined;
  readonly agent?: string | undefined;
  readonly session?: string | undefined;
  readonly purpose: readonly string[];
}

/**
 * Resolve a scope to a stored row, creating it if necessary.
 *
 * Purpose order is normalised rather than preserved: two writes that differ only
 * in the order of their purpose list are the same scope, and treating them as
 * different would silently fragment the ownership boundary.
 */
export async function ensureScope(
  executor: QueryExecutor,
  input: ScopeInput,
): Promise<ResolvedScope> {
  const purposes = [...new Set(input.purpose)].sort();
  const existing = await executor.query<{
    scope_id: string;
    tenant_id: string;
    project: string | null;
    user_id: string | null;
    agent_id: string | null;
    session_id: string | null;
    purpose: string[];
  }>(
    `SELECT scope_id, tenant_id, project, user_id, agent_id, session_id, purpose
       FROM scopes
      WHERE tenant_id = $1::uuid
        AND project    IS NOT DISTINCT FROM $2
        AND user_id    IS NOT DISTINCT FROM $3
        AND agent_id   IS NOT DISTINCT FROM $4
        AND session_id IS NOT DISTINCT FROM $5
        AND purpose = $6::text[]
      LIMIT 1`,
    [
      input.tenant,
      input.project ?? null,
      input.user ?? null,
      input.agent ?? null,
      input.session ?? null,
      purposes,
    ],
  );
  const found = existing.rows[0];
  if (found) {
    return {
      scope_id: found.scope_id,
      tenant_id: found.tenant_id,
      project: found.project,
      user: found.user_id,
      agent: found.agent_id,
      session: found.session_id,
      purpose: found.purpose,
    };
  }

  // The application role cannot INSERT into `scopes` under its own RLS context
  // (scopes has no policy of its own), so scope creation is a SECURITY DEFINER
  // function: it is the one place where "create the ownership boundary" is
  // allowed to happen, and it is idempotent against concurrent creators.
  const created = await executor.query<{
    scope_id: string;
    tenant_id: string;
    project: string | null;
    user_id: string | null;
    agent_id: string | null;
    session_id: string | null;
    purpose: string[];
  }>(
    `SELECT scope_id, tenant_id, project, user_id, agent_id, session_id, purpose
       FROM veritymem.ensure_scope($1::uuid, $2, $3, $4, $5, $6::text[])`,
    [
      input.tenant,
      input.project ?? null,
      input.user ?? null,
      input.agent ?? null,
      input.session ?? null,
      purposes,
    ],
  );
  const row = created.rows[0];
  if (!row) {
    throw new LedgerError("not_found", "scope could not be resolved or created", 500);
  }
  return {
    scope_id: row.scope_id,
    tenant_id: row.tenant_id,
    project: row.project,
    user: row.user_id,
    agent: row.agent_id,
    session: row.session_id,
    purpose: row.purpose,
  };
}

/** Does `candidate` fit inside `authority`? Used to make scope narrowing the default failure mode. */
export function scopeContainedBy(candidate: ResolvedScope, authority: ResolvedScope): boolean {
  const dims: (keyof ResolvedScope)[] = ["project", "user", "agent", "session"];
  for (const dim of dims) {
    const c = candidate[dim] as string | null;
    const a = authority[dim] as string | null;
    if (c === null) continue; // candidate is wider or equal on this dimension
    if (a !== null && a !== c) return false; // different value entirely
    if (a === null) return false; // candidate narrows to something authority does not name
  }
  return true;
}

/** Purposes present in the candidate that the authority scope was not admitted for. */
export function scopeBroadenedPurposes(
  candidatePurposes: readonly string[],
  authorityPurposes: readonly string[],
): string[] {
  if (authorityPurposes.length === 0) return [...candidatePurposes];
  return candidatePurposes.filter((p) => !authorityPurposes.includes(p));
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export class Ledger {
  private readonly db: Db;
  private readonly blobs: BlobStore;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly inlinePayloadLimit: number;

  constructor(options: LedgerOptions) {
    this.db = options.db;
    this.blobs = options.blobs;
    this.clock = options.clock;
    this.ids = options.ids;
    this.inlinePayloadLimit = options.inlinePayloadLimit ?? 8192;
  }

  /**
   * Append an event.
   *
   * Steps that matter: resolve the tenant, resolve or create the scope, check the
   * idempotency key, allocate the per-stream sequence under a row lock, compute
   * the content hash and the chain link, then write. Extraction is enqueued to
   * the outbox in the same transaction, so "acknowledged" and "will be extracted"
   * cannot diverge.
   */
  async append(request: EventAppendRequest, options: { principal?: string } = {}): Promise<LedgerReceipt> {
    const tenantId = resolveTenantId(request.scope.tenant);
    const principal = options.principal ?? request.actor_id;
    const bytes = Buffer.from(request.content, "utf8");
    const contentHash = sha256Hex(bytes);
    const origin = request.origin;
    const mediaType = request.media_type ?? "text/plain";
    const sensitivity = request.sensitivity ?? "normal";

    if (bytes.byteLength === 0) {
      throw new LedgerError("invalid_span", "event content must not be empty", 400);
    }

    const result = await this.db.withRequest(
      { tenant: tenantId, principal, scopeIds: [], purposes: [], action: "event:append" },
      async (executor) => {
        // Register the tenant on first use. Cheap, idempotent, and it keeps the
        // tenants table a truthful index of who has ever written here.
        await executor.query(`SELECT veritymem.ensure_tenant($1::uuid, $2)`, [
          tenantId,
          request.scope.tenant,
        ]);

        const scope = await ensureScope(executor, {
          tenant: tenantId,
          ...(request.scope.project !== undefined ? { project: request.scope.project } : {}),
          ...(request.scope.user !== undefined ? { user: request.scope.user } : {}),
          ...(request.scope.agent !== undefined ? { agent: request.scope.agent } : {}),
          ...(request.scope.session !== undefined ? { session: request.scope.session } : {}),
          purpose: request.scope.purpose,
        });

        // Now that the scope exists, bind it so RLS admits this write. The write
        // path is authorized by the caller's own scope: an ingress request cannot
        // write outside the scope it declared.
        await executor.query(
          `SELECT veritymem.set_request_context($1::uuid, $2, $3::uuid[], $4::text[], $5)`,
          [tenantId, principal, [scope.scope_id], scope.purpose, "event:append"],
        );

        if (request.idempotency_key) {
          const replay = await this.findByIdempotencyKey(executor, tenantId, request.idempotency_key);
          if (replay) {
            if (replay.content_hash !== contentHash) {
              throw new LedgerError(
                "idempotency_conflict",
                `idempotency key ${request.idempotency_key} was already used for different content`,
                409,
              );
            }
            return { ...replay, deduplicated: true, extraction_queued: true };
          }
        }

        // Allocate the sequence under a row lock. A stream's order is the whole
        // point of a stream, so this cannot be a permissive upsert race.
        const seqRow = await executor.query<{ last_seq: number }>(
          `INSERT INTO streams (tenant_id, stream_id, last_seq)
                VALUES ($1::uuid, $2, 1)
           ON CONFLICT (tenant_id, stream_id)
           DO UPDATE SET last_seq = streams.last_seq + 1
             RETURNING last_seq`,
          [tenantId, request.stream_id],
        );
        const seq = Number(seqRow.rows[0]?.last_seq ?? 0);
        if (seq <= 0) {
          throw new LedgerError("sequence_conflict", "could not allocate a stream sequence", 500);
        }

        if (request.expected_seq !== undefined && request.expected_seq !== seq) {
          throw new LedgerError(
            "sequence_conflict",
            `expected_seq ${request.expected_seq} does not match allocated seq ${seq}`,
            409,
          );
        }

        const prev = await executor.query<{ content_hash: Buffer }>(
          `SELECT content_hash FROM events
            WHERE tenant_id = $1::uuid AND stream_id = $2 AND seq = $3`,
          [tenantId, request.stream_id, seq - 1],
        );
        const prevHashBuffer = prev.rows[0]?.content_hash ?? null;
        const prevHash = prevHashBuffer ? prevHashBuffer.toString("hex") : null;

        const inline = bytes.byteLength <= this.inlinePayloadLimit;
        const payloadRef = inline ? null : await this.blobs.put(bytes);

        // The chain commits to the event's identity and its content, so a
        // reordering *or* a wholesale rewrite inside a stream is detectable.
        const chained = true;
        const chainInput = chained
          ? canonicalize({
              stream_id: request.stream_id,
              seq,
              content_hash: contentHash,
              prev_hash: prevHash,
              actor_id: request.actor_id,
              occurred_at: normalizeInstant(request.occurred_at),
            })
          : null;
        const linkHash = chainInput === null ? null : sha256Bytes(chainInput);

        const eventId = this.ids.next("evt");
        const recordedAt = this.clock.now().toISOString();

        const inserted = await executor.query<{ event_id: string }>(
          `INSERT INTO events (
             event_id, stream_id, seq, tenant_id, scope_id, origin, actor_id,
             occurred_at, recorded_at, payload, payload_ref, content_hash, prev_hash, link_hash,
             chained, sensitivity, idempotency_key, media_type, byte_length
           ) VALUES (
             $1::uuid, $2, $3, $4::uuid, $5::uuid, $6::origin_kind, $7,
             $8::timestamptz, $9::timestamptz, $10, $11, $12, $13, $14,
             $15, $16, $17, $18, $19
           )
           ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
           RETURNING event_id`,
          [
            stripPrefix(eventId),
            request.stream_id,
            seq,
            tenantId,
            scope.scope_id,
            origin,
            request.actor_id,
            normalizeInstant(request.occurred_at),
            recordedAt,
            inline ? request.content : null,
            payloadRef,
            Buffer.from(contentHash, "hex"),
            prevHashBuffer,
            linkHash,
            chained,
            sensitivity,
            request.idempotency_key ?? null,
            mediaType,
            bytes.byteLength,
          ],
        );

        if (inserted.rows.length === 0) {
          // Lost an idempotency race. The other writer's event is the answer.
          const winner = request.idempotency_key
            ? await this.findByIdempotencyKey(executor, tenantId, request.idempotency_key)
            : null;
          if (!winner) {
            throw new LedgerError("idempotency_conflict", "concurrent append could not be resolved", 409);
          }
          if (winner.content_hash !== contentHash) {
            throw new LedgerError(
              "idempotency_conflict",
              `idempotency key ${request.idempotency_key} was already used for different content`,
              409,
            );
          }
          return { ...winner, deduplicated: true, extraction_queued: false };
        }

        // Record that this principal participates in this scope. Membership is a
        // server-side fact established at the moment the server has authenticated
        // the principal and bound the scope — not something a later read request
        // can assert about itself. The read planner computes reach from this table
        // plus grants, so a caller cannot widen its own read scope by asking.
        await executor.query(`SELECT veritymem.record_participation($1::uuid, $2, $3::uuid)`, [
          tenantId,
          principal,
          scope.scope_id,
        ]);

        await executor.query(
          `INSERT INTO outbox (tenant_id, kind, payload)
           VALUES ($1::uuid, 'extract.event', $2::jsonb)`,
          [
            tenantId,
            JSON.stringify({
              event_id: eventId,
              tenant: request.scope.tenant,
              tenant_id: tenantId,
              scope_id: scope.scope_id,
              // The worker needs these to bind a request context. Omitting them is
              // what made the projection worker silently read nothing: an empty
              // scope array with an empty purpose set is denied by every policy.
              scope_ids: [scope.scope_id],
              purposes: scope.purpose,
            }),
          ],
        );

        return {
          event_id: eventId,
          seq,
          recorded_at: recordedAt,
          scope,
          content_hash: contentHash,
          prev_hash: prevHash,
          deduplicated: false,
          // Extraction is enqueued to the outbox in this same transaction, so the
          // acknowledgement and the commitment to extract cannot diverge.
          extraction_queued: true,
        };
      },
    );

    return result;
  }

  private async findByIdempotencyKey(
    executor: QueryExecutor,
    tenantId: string,
    key: string,
  ): Promise<Omit<LedgerReceipt, "deduplicated"> | null> {
    const found = await executor.query<{
      event_id: string;
      seq: number;
      recorded_at: Date | string;
      content_hash: Buffer;
      prev_hash: Buffer | null;
      scope_id: string;
      tenant_id: string;
      project: string | null;
      user_id: string | null;
      agent_id: string | null;
      session_id: string | null;
      purpose: string[];
    }>(
      `SELECT e.event_id, e.seq, e.recorded_at, e.content_hash, e.prev_hash,
              s.scope_id, s.tenant_id, s.project, s.user_id, s.agent_id, s.session_id, s.purpose
         FROM events e
         JOIN scopes s ON s.scope_id = e.scope_id
        WHERE e.tenant_id = $1::uuid AND e.idempotency_key = $2
        LIMIT 1`,
      [tenantId, key],
    );
    const row = found.rows[0];
    if (!row) return null;
    return {
      event_id: toPublicId("evt", row.event_id),
      seq: Number(row.seq),
      recorded_at: toIso(row.recorded_at),
      content_hash: row.content_hash.toString("hex"),
      prev_hash: row.prev_hash ? row.prev_hash.toString("hex") : null,
      // A stored event's extraction was enqueued in the transaction that wrote
      // it, so a replay reports the same commitment as the original append.
      extraction_queued: true,
      scope: {
        scope_id: formatUuid(row.scope_id),
        tenant_id: formatUuid(row.tenant_id),
        project: row.project,
        user: row.user_id,
        agent: row.agent_id,
        session: row.session_id,
        purpose: row.purpose,
      },
    };
  }

  /** Read an event, verifying span digests when requested. */
  async readEvent(executor: QueryExecutor, eventId: string): Promise<LedgerEvent | null> {
    const found = await executor.query<Record<string, unknown>>(
      `${EVENT_SELECT} WHERE e.event_id = $1::uuid`,
      [stripPrefix(eventId)],
    );
    const row = found.rows[0];
    if (!row) return null;
    return this.hydrateEvent(row);
  }

  /** Load many events at once — the retrieval path must not issue one query per claim. */
  async readEvents(executor: QueryExecutor, eventIds: readonly string[]): Promise<Map<string, LedgerEvent>> {
    const unique = [...new Set(eventIds)];
    if (unique.length === 0) return new Map();
    const found = await executor.query<Record<string, unknown>>(
      `${EVENT_SELECT} WHERE e.event_id = ANY($1::uuid[])`,
      [unique.map(stripPrefix)],
    );
    const out = new Map<string, LedgerEvent>();
    for (const row of found.rows) {
      const event = await this.hydrateEvent(row);
      out.set(event.event_id, event);
    }
    return out;
  }

  /**
   * Write spans for an event.
   *
   * Span creation is where "exact bytes" is established: the digest is computed
   * over the payload slice, not over a re-derived string, so a later payload
   * rewrite is detectable rather than invisible.
   */
  async writeSpans(
    executor: QueryExecutor,
    event: LedgerEvent,
    spans: readonly ProposalSpanInput[],
  ): Promise<SpanRecord[]> {
    const payload = Buffer.from(event.content ?? "", "utf8");
    const out: SpanRecord[] = [];
    for (const span of spans) {
      const record = await this.writeSpan(executor, event, payload, span);
      out.push(record);
    }
    return out;
  }

  private async writeSpan(
    executor: QueryExecutor,
    event: LedgerEvent,
    payload: Buffer,
    span: ProposalSpanInput,
  ): Promise<SpanRecord> {
    if (event.content === null) {
      throw new LedgerError(
        "invalid_span",
        `event ${event.event_id} has been redacted; no new span may reference it`,
        400,
      );
    }
    if (span.start < 0 || span.end <= span.start || span.end > payload.byteLength) {
      throw new LedgerError(
        "invalid_span",
        `span [${span.start}, ${span.end}) is outside payload of ${payload.byteLength} bytes`,
        400,
      );
    }
    const slice = payload.subarray(span.start, span.end);
    const digestHex = sha256Hex(slice);
    const selector = span.selector ?? null;
    const quote = slice.toString("utf8");

    const existing = await executor.query<{ span_id: string }>(
      `SELECT span_id FROM evidence_spans
        WHERE event_id = $1::uuid AND start_off = $2 AND end_off = $3
          AND COALESCE(selector, '') = COALESCE($4, '')`,
      [stripPrefix(event.event_id), span.start, span.end, selector],
    );
    const existingId = existing.rows[0]?.span_id;
    if (existingId) {
      return {
        span_id: toPublicId("spn", existingId),
        event_id: event.event_id,
        start: span.start,
        end: span.end,
        selector,
        digest: digestHex,
        quote,
      };
    }

    const spanId = this.ids.next("spn");
    await executor.query(
      `INSERT INTO evidence_spans (span_id, event_id, start_off, end_off, selector, span_digest, quote)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
       ON CONFLICT (event_id, start_off, end_off, COALESCE(selector, '')) DO NOTHING`,
      [stripPrefix(spanId), stripPrefix(event.event_id), span.start, span.end, selector, Buffer.from(digestHex, "hex"), quote],
    );
    const settled = await executor.query<{ span_id: string }>(
      `SELECT span_id FROM evidence_spans
        WHERE event_id = $1::uuid AND start_off = $2 AND end_off = $3
          AND COALESCE(selector, '') = COALESCE($4, '')`,
      [stripPrefix(event.event_id), span.start, span.end, selector],
    );
    const settledId = settled.rows[0]?.span_id ?? stripPrefix(spanId);
    return {
      span_id: toPublicId("spn", settledId),
      event_id: event.event_id,
      start: span.start,
      end: span.end,
      selector,
      digest: digestHex,
      quote,
    };
  }

  async readSpan(executor: QueryExecutor, spanId: string): Promise<SpanRecord | null> {
    const found = await executor.query<{
      span_id: string;
      event_id: string;
      start_off: number;
      end_off: number;
      selector: string | null;
      span_digest: Buffer;
      quote: string;
    }>(
      `SELECT span_id, event_id, start_off, end_off, selector, span_digest, quote
         FROM evidence_spans WHERE span_id = $1::uuid`,
      [stripPrefix(spanId)],
    );
    const row = found.rows[0];
    if (!row) return null;
    return {
      span_id: toPublicId("spn", row.span_id),
      event_id: toPublicId("evt", row.event_id),
      start: Number(row.start_off),
      end: Number(row.end_off),
      selector: row.selector,
      digest: row.span_digest.toString("hex"),
      quote: row.quote,
    };
  }

  /**
   * Resolve and verify a span against current payload bytes.
   *
   * This runs on every read that returns a claim. A cached verification would be
   * exactly the silent drift the design exists to prevent.
   */
  verifySpan(span: SpanRecord, event: LedgerEvent | undefined): SpanVerification {
    if (!event) return { status: "missing", reason: "event_not_found" };
    if (event.redacted_at !== null || event.content === null) {
      return { status: "redacted", span, event };
    }
    const payload = Buffer.from(event.content, "utf8");
    if (span.end > payload.byteLength) {
      return { status: "out_of_bounds", span, payload_length: payload.byteLength };
    }
    const actual = sha256Hex(payload.subarray(span.start, span.end));
    if (actual !== span.digest) {
      return { status: "digest_mismatch", span, expected: span.digest, actual };
    }
    return { status: "ok", quote: payload.subarray(span.start, span.end).toString("utf8"), span, event };
  }

  /** Verify a batch of spans with one event fetch per distinct event. */
  async verifySpans(
    executor: QueryExecutor,
    spans: readonly SpanRecord[],
  ): Promise<Map<string, SpanVerification>> {
    const events = await this.readEvents(
      executor,
      spans.map((s) => s.event_id),
    );
    const out = new Map<string, SpanVerification>();
    for (const span of spans) {
      out.set(span.span_id, this.verifySpan(span, events.get(span.event_id)));
    }
    return out;
  }

  /**
   * Walk a stream's chain and report the first link that does not hold.
   *
   * Two checks per event: `link_hash` must recompute from the event's own fields
   * (so a content substitution is caught), and `prev_hash` must equal the
   * preceding event's `content_hash` (so a reordering or a splice is caught).
   *
   * This detects accident and partial writes. It is not tamper-proof against an
   * operator with database access, and the documentation says so plainly.
   */
  async verifyChain(
    executor: QueryExecutor,
    stream: { tenant: string; streamId: string; fromSeq?: number; toSeq?: number },
  ): Promise<{ ok: boolean; checked: number; brokenAtSeq: number | null; reason: string | null }> {
    const rows = await executor.query<{
      seq: number;
      actor_id: string;
      occurred_at: Date | string;
      content_hash: Buffer;
      prev_hash: Buffer | null;
      link_hash: Buffer | null;
      chained: boolean;
      stream_id: string;
    }>(
      `SELECT seq, stream_id, actor_id, occurred_at, content_hash, prev_hash, link_hash, chained
         FROM events
        WHERE tenant_id = $1::uuid AND stream_id = $2
          AND seq >= $3 AND ($4::bigint IS NULL OR seq <= $4::bigint)
        ORDER BY seq ASC`,
      [stream.tenant, stream.streamId, stream.fromSeq ?? 1, stream.toSeq ?? null],
    );

    let checked = 0;
    let expectedPrev: Buffer | null = null;
    let first = true;
    for (const row of rows.rows) {
      checked += 1;
      if (first && (stream.fromSeq ?? 1) > 1) {
        expectedPrev = row.prev_hash;
        first = false;
        continue;
      }
      first = false;

      if (!row.chained) {
        expectedPrev = row.content_hash;
        continue;
      }

      const contentHashHex = row.content_hash.toString("hex");
      const prevHashHex = row.prev_hash ? row.prev_hash.toString("hex") : null;
      const recomputed = sha256Bytes(
        canonicalize({
          stream_id: row.stream_id,
          seq: Number(row.seq),
          content_hash: contentHashHex,
          prev_hash: prevHashHex,
          actor_id: row.actor_id,
          occurred_at: toIso(row.occurred_at),
        }),
      );
      if (row.link_hash === null || !recomputed.equals(row.link_hash)) {
        return {
          ok: false,
          checked,
          brokenAtSeq: Number(row.seq),
          reason: "link_hash does not recompute from the event's own fields",
        };
      }

      const prevMatches =
        (expectedPrev === null && row.prev_hash === null) ||
        (expectedPrev !== null && row.prev_hash !== null && expectedPrev.equals(row.prev_hash));
      if (!prevMatches) {
        return {
          ok: false,
          checked,
          brokenAtSeq: Number(row.seq),
          reason: "prev_hash does not match the preceding event's content_hash",
        };
      }
      expectedPrev = row.content_hash;
    }
    return { ok: true, checked, brokenAtSeq: null, reason: null };
  }

  /** Every event for a tenant in ledger order, for a full rebuild. */
  async *readAll(
    executor: QueryExecutor,
    options: { tenant: string; upToSeq?: number; batchSize?: number } = { tenant: "" },
  ): AsyncGenerator<LedgerEvent> {
    const batchSize = options.batchSize ?? 500;
    let lastStream = "";
    let lastSeq = 0;
    for (;;) {
      const rows = await executor.query<Record<string, unknown>>(
        `${EVENT_SELECT}
          WHERE e.tenant_id = $1::uuid
            AND ($2::bigint IS NULL OR e.seq <= $2::bigint)
            AND (e.stream_id, e.seq) > ($3, $4::bigint)
          ORDER BY e.stream_id ASC, e.seq ASC
          LIMIT $5`,
        [options.tenant, options.upToSeq ?? null, lastStream, lastSeq, batchSize],
      );
      if (rows.rows.length === 0) return;
      for (const row of rows.rows) {
        const event = await this.hydrateEvent(row);
        lastStream = event.stream_id;
        lastSeq = event.seq;
        yield event;
      }
      if (rows.rows.length < batchSize) return;
    }
  }

  private async hydrateEvent(row: Record<string, unknown>): Promise<LedgerEvent> {
    const payload = row["payload"] as string | null;
    const payloadRef = row["payload_ref"] as string | null;
    const redactedAt = row["redacted_at"] as Date | string | null;
    let content: string | null = payload;
    if (content === null && payloadRef !== null && redactedAt === null) {
      const bytes = await this.blobs.get(payloadRef);
      content = bytes ? bytes.toString("utf8") : null;
    }
    return {
      event_id: toPublicId("evt", String(row["event_id"])),
      stream_id: String(row["stream_id"]),
      seq: Number(row["seq"]),
      tenant_id: formatUuid(String(row["tenant_id"])),
      scope: {
        scope_id: formatUuid(String(row["scope_id"])),
        tenant_id: formatUuid(String(row["tenant_id"])),
        project: (row["project"] as string | null) ?? null,
        user: (row["user_id"] as string | null) ?? null,
        agent: (row["agent_id"] as string | null) ?? null,
        session: (row["session_id"] as string | null) ?? null,
        purpose: (row["purpose"] as string[] | null) ?? [],
      },
      origin: row["origin"] as OriginKind,
      actor_id: String(row["actor_id"]),
      occurred_at: toIso(row["occurred_at"] as Date | string),
      recorded_at: toIso(row["recorded_at"] as Date | string),
      content,
      payload_ref: payloadRef,
      content_hash: (row["content_hash"] as Buffer).toString("hex"),
      prev_hash: row["prev_hash"] ? (row["prev_hash"] as Buffer).toString("hex") : null,
      chained: Boolean(row["chained"]),
      sensitivity: String(row["sensitivity"]),
      media_type: String(row["media_type"]),
      byte_length: Number(row["byte_length"]),
      redacted_at: redactedAt ? toIso(redactedAt) : null,
      idempotency_key: (row["idempotency_key"] as string | null) ?? null,
    };
  }

  /** Content digest of an event payload, exposed for tests and the replay oracle. */
  static digest(content: string): string {
    return sha256Hex(Buffer.from(content, "utf8"));
  }

  static digestBytes(content: string): Buffer {
    return sha256Bytes(Buffer.from(content, "utf8"));
  }
}

const EVENT_SELECT = `
  SELECT e.event_id, e.stream_id, e.seq, e.tenant_id, e.scope_id, e.origin, e.actor_id,
         e.occurred_at, e.recorded_at, e.payload, e.payload_ref, e.content_hash, e.prev_hash,
         e.chained, e.sensitivity, e.idempotency_key, e.media_type, e.byte_length, e.redacted_at,
         s.project, s.user_id, s.agent_id, s.session_id, s.purpose
    FROM events e
    JOIN scopes s ON s.scope_id = e.scope_id
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a stable tenant UUID from a slug.
 *
 * Tenants are addressed by slug in the API and by UUID in the schema, and the
 * mapping is a pure function rather than a lookup. That keeps the write path free
 * of a round trip and makes a mis-scoped query impossible to hide behind a
 * tenant-name join.
 */
export function resolveTenantId(slug: string): string {
  const hash = createHash("sha256").update(`veritymem:tenant:${slug}`, "utf8").digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // Version 5 (name-based, SHA-1 in the RFC; SHA-256 here) and RFC 4122 variant.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return formatUuid(bytes);
}

/**
 * Identifier form used everywhere ids cross the API boundary: `evt_<32 hex>`.
 *
 * It matches the format the id generator produces, and it matches the pattern the
 * contracts declare. The raw UUID goes to Postgres, where it is the column type —
 * a prefixed form is never handed back to a caller, and a raw UUID is never
 * returned in its place. One form, or the two drift and an idempotent replay
 * silently returns a different-looking id for the same event.
 */
export function toPublicId(prefix: string, value: string | Buffer): string {
  return `${prefix}_${uuidToHex(value)}`;
}

function uuidToHex(value: string | Buffer): string {
  if (typeof value === "string") return value.includes("-") ? value.replace(/-/g, "") : value;
  return value.toString("hex");
}

export function formatUuid(value: string | Buffer): string {
  const hex = uuidToHex(value);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export function stripPrefix(id: string): string {
  const underscore = id.indexOf("_");
  const body = underscore >= 0 ? id.slice(underscore + 1) : id;
  if (body.includes("-")) return body;
  if (body.length !== 32) return body;
  return [
    body.slice(0, 8),
    body.slice(8, 12),
    body.slice(12, 16),
    body.slice(16, 20),
    body.slice(20, 32),
  ].join("-");
}

export function normalizeInstant(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new LedgerError("invalid_span", `invalid timestamp: ${String(value)}`, 400);
  }
  return date.toISOString();
}

export function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
