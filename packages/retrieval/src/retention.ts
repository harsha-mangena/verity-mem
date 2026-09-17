/**
 * Correction and forgetting.
 *
 * The specification's rule for deletion is the one that shapes this module:
 * deletion is *proven* by a residual-match scan, never assumed. So a forget
 * operation produces a manifest naming every store it touched, scrubs those
 * stores, then scans them again for any surviving copy of the subject. The job
 * only reports `verified` when the scan returns zero.
 *
 * The ledger row survives redaction. That is deliberate and it is the part that
 * looks wrong until you need it: after erasure, the system must still be able to
 * testify that the event existed, when it arrived, and who sent it, without
 * holding the content. A ledger with holes in it cannot answer "was anything ever
 * recorded about this subject", which is precisely the question a regulator asks.
 */
import { REASON_CODES, type RetentionJob, type RetentionMode } from "@veritymem/contracts";
import type { BlobStore, Clock, Db, IdGenerator, Ledger, QueryExecutor } from "@veritymem/ledger";
import { toPublicId } from "@veritymem/ledger";
import { deindexClaim } from "./projections.ts";

export interface ForgetRequest {
  readonly tenant_id: string;
  readonly tenant_slug: string;
  readonly subject_or_scope: {
    readonly project?: string | undefined;
    readonly user?: string | undefined;
    readonly agent?: string | undefined;
    readonly session?: string | undefined;
    readonly actor_id?: string | undefined;
    readonly subject?: string | undefined;
  };
  readonly mode?: RetentionMode;
  readonly reason: string;
}

export interface RetentionDependencies {
  readonly db: Db;
  readonly ledger: Ledger;
  readonly blobs: BlobStore;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/** Stores a retention operation is expected to touch, named explicitly. */
export const RETENTION_STORES = [
  "events.payload",
  "events.blobs",
  "claims",
  "claim_evidence",
  "claim_embeddings",
  "entity_aliases",
  "query_traces",
] as const;

export interface StoreOutcome {
  readonly store: string;
  readonly rows_affected: number;
  readonly method: string;
}

/**
 * What happened to the out-of-line blob objects, in three separate counts.
 *
 * The assessment's requirement is exact: "Separate references removed, blob objects
 * deleted and blob objects retained in the manifest," and "The manifest never counts a
 * detached reference as a deleted blob object."
 *
 * The distinction is not bookkeeping. A content-addressed store deduplicates, so clearing
 * one event's `payload_ref` removes a reference while the object stays live for whoever
 * else shares those exact bytes. Reporting that as a deletion would be a false claim of
 * erasure, and deleting the object would be silent data loss for the other holder. Both
 * are avoided only by counting the three things separately.
 */
export interface BlobOutcome {
  /** Refs cleared from events by this job. Each was one row's pointer to an object. */
  readonly references_removed: number;
  /** Objects verified absent from the physical store after the job. */
  readonly objects_deleted: number;
  /** Objects still present because another live row references the same bytes. */
  readonly objects_retained_shared: number;
  /** Objects still present for any other reason, which is a failure to report. */
  readonly objects_retained_other: number;
  /** False when the configured store cannot physically delete. */
  readonly store_supports_deletion: boolean;
  readonly refs_deleted: readonly string[];
  readonly refs_retained_shared: readonly string[];
}

export interface ForgetManifest {
  readonly job_id: string;
  readonly mode: RetentionMode;
  readonly reason: string;
  readonly stores: readonly StoreOutcome[];
  readonly blobs: BlobOutcome;
  readonly claims_affected: number;
  readonly events_redacted: number;
  readonly started_at: string;
  readonly completed_at: string;
  readonly residual_scan: readonly { readonly store: string; readonly matches: number }[];
  readonly residual_matches: number;
  readonly notes: readonly string[];
}

/**
 * Execute a forget operation.
 *
 * Two phases, and the second is the one that matters. Phase one scrubs. Phase two
 * scans every declared store for surviving copies of the subject and records the
 * count. A non-zero residual count is reported as a failure rather than rounded
 * away, because "we deleted it" without a scan is the claim this project exists
 * to replace.
 */
export async function forget(
  dependencies: RetentionDependencies,
  request: ForgetRequest,
): Promise<{ job_id: string; status: RetentionJob["status"]; manifest: ForgetManifest }> {
  const startedAt = dependencies.clock.now().toISOString();
  const jobId = dependencies.ids.next("ret");
  const mode: RetentionMode = request.mode ?? "redact";

  // Retention operates on a tenant, not on a caller's scopes, so it needs a
  // tenant-wide context. It must not be given an empty scope array: every policy
  // denies an empty purpose set, so the scrub would match nothing, the residual
  // scan would match nothing, and the job would report `verified` — a deletion
  // feature whose proof of deletion is a scan that could not see anything. The
  // system context is explicit, auditable, and still confined to one tenant.
  const outcome = await dependencies.db.withSystemContext(
    { tenant: request.tenant_id, actor: `retention:${request.reason}` },
    async (executor) => runForget(dependencies, executor, request, mode, jobId, startedAt),
  );

  const job: RetentionJob = {
    job_id: jobId,
    tenant: request.tenant_slug,
    subject_or_scope: request.subject_or_scope,
    mode,
    reason: request.reason,
    status: outcome.residual_matches === 0 ? "verified" : "failed",
    stores_touched: outcome.stores.map((store) => store.store),
    manifest: outcome,
    residual_matches: outcome.residual_matches,
    created_at: startedAt,
    updated_at: outcome.completed_at,
    verified_at: outcome.residual_matches === 0 ? outcome.completed_at : null,
  };

  await recordJob(dependencies, request.tenant_id, job, outcome);

  return { job_id: jobId, status: job.status, manifest: outcome };
}

async function runForget(
  dependencies: RetentionDependencies,
  executor: QueryExecutor,
  request: ForgetRequest,
  mode: RetentionMode,
  jobId: string,
  startedAt: string,
): Promise<ForgetManifest> {
  const selector = request.subject_or_scope;
  const notes: string[] = [];
  const stores: StoreOutcome[] = [];
  const tenantId = request.tenant_id;

  /** Content-addressed refs the erased events pointed at, captured before they are cleared. */
  let affectedRefs: { rows: { payload_ref: string }[] } = { rows: [] };

  const scopeFilter = {
    project: selector.project ?? null,
    user: selector.user ?? null,
    agent: selector.agent ?? null,
    session: selector.session ?? null,
  };

  // ---- Identify the affected events and claims ---------------------------
  const affectedEvents = await executor.query<{ event_id: string; has_payload: boolean }>(
    `SELECT e.event_id,
            (e.payload IS NOT NULL OR e.payload_ref IS NOT NULL) AS has_payload
       FROM events e
       JOIN scopes s ON s.scope_id = e.scope_id
      WHERE e.tenant_id = $1::uuid
        AND ($2::text IS NULL OR s.project    = $2)
        AND ($3::text IS NULL OR s.user_id    = $3)
        AND ($4::text IS NULL OR s.agent_id   = $4)
        AND ($5::text IS NULL OR s.session_id = $5)
        AND ($6::text IS NULL OR e.actor_id   = $6)`,
    [
      tenantId,
      scopeFilter.project,
      scopeFilter.user,
      scopeFilter.agent,
      scopeFilter.session,
      selector.actor_id ?? null,
    ],
  );

  const affectedClaims = await executor.query<{ claim_id: string }>(
    `SELECT c.claim_id
       FROM claims c
       JOIN scopes s ON s.scope_id = c.scope_id
      WHERE c.tenant_id = $1::uuid
        AND ($2::text IS NULL OR s.project    = $2)
        AND ($3::text IS NULL OR s.user_id    = $3)
        AND ($4::text IS NULL OR s.agent_id   = $4)
        AND ($5::text IS NULL OR s.session_id = $5)
        AND ($6::text IS NULL OR c.subject    = $6)`,
    [
      tenantId,
      scopeFilter.project,
      scopeFilter.user,
      scopeFilter.agent,
      scopeFilter.session,
      selector.subject ?? null,
    ],
  );

  if (affectedEvents.rows.length === 0 && affectedClaims.rows.length === 0) {
    notes.push("nothing in scope matched this retention request; nothing was changed");
  }

  // ---- Phase 1: scrub ----------------------------------------------------
  if (mode === "erase" || mode === "redact" || mode === "export_then_erase") {
    // Captured *before* the UPDATE below, which is the only moment these refs exist. An
    // earlier version read them afterwards and always got an empty list, so the reclamation
    // step had nothing to reclaim and the manifest reported zero references removed while
    // the objects sat on disk.
    affectedRefs = await executor.query<{ payload_ref: string }>(
      `SELECT DISTINCT payload_ref
         FROM events
        WHERE event_id = ANY($1::uuid[]) AND payload_ref IS NOT NULL`,
      [affectedEvents.rows.map((row) => row.event_id)],
    );

    const redacted = await executor.query(
      `UPDATE events
          SET payload = NULL,
              payload_ref = NULL,
              redacted_at = COALESCE(redacted_at, now())
        WHERE event_id = ANY($1::uuid[])
          AND (payload IS NOT NULL OR payload_ref IS NOT NULL)`,
      [affectedEvents.rows.map((row) => row.event_id)],
    );
    stores.push({
      store: "events.payload",
      rows_affected: redacted.rowCount ?? 0,
      method: "payload and payload_ref cleared, redacted_at set; row and hash chain preserved",
    });
  }

  // Claims resting on redacted evidence stop being retrieval candidates.
  const deindexed = await executor.query<{ claim_id: string }>(
    `SELECT DISTINCT c.claim_id
       FROM claims c
       JOIN claim_evidence ce ON ce.claim_id = c.claim_id
       JOIN evidence_spans s ON s.span_id = ce.span_id
      WHERE c.tenant_id = $1::uuid AND s.event_id = ANY($2::uuid[])`,
    [tenantId, affectedEvents.rows.map((row) => row.event_id)],
  );
  for (const row of deindexed.rows) {
    await deindexClaim(executor, toPublicId("clm", row.claim_id));
  }
  stores.push({
    store: "claim_embeddings",
    rows_affected: deindexed.rows.length,
    method: "dense projection rows deleted; the projection is rebuildable so this is not a data loss",
  });

  // Each revocation is written with its own decision row: erasure is an authorised
  // act, so it belongs in the audit trail, and `veritymem.guard_claim_mutation`
  // refuses a status change that has no decision behind it. One decision per claim
  // rather than one for the batch, because the question "why is this claim revoked"
  // must be answerable per claim.
  const revokedClaimIds = affectedClaims.rows.map((row) => row.claim_id);
  let revokedCount = 0;
  for (const claimId of revokedClaimIds) {
    const decisionId = dependencies.ids.next("dec");
    const inserted = await executor.query(
      `INSERT INTO decisions (decision_id, tenant_id, claim_id, policy_version, outcome, reason_codes, approver)
       SELECT $1::uuid, c.tenant_id, c.claim_id, $2, 'revoke', $3::text[], $4
         FROM claims c WHERE c.claim_id = $5::uuid AND c.status <> 'revoked'`,
      [
        stripPrefix(decisionId),
        "retention-v1",
        [REASON_CODES.RETENTION_LEDGER_PRESERVED, REASON_CODES.USE_REVOKED],
        `retention:${request.reason}`,
        claimId,
      ],
    );
    if ((inserted.rowCount ?? 0) === 0) continue;
    const updated = await executor.query(
      `UPDATE claims
          SET status = 'revoked', valid_to = COALESCE(valid_to, now())
        WHERE claim_id = $1::uuid AND status <> 'revoked'`,
      [claimId],
    );
    revokedCount += updated.rowCount ?? 0;
  }
  stores.push({
    store: "claims",
    rows_affected: revokedCount,
    method:
      "status set to revoked with valid_to closed, each with a decision row recording the retention reason; claims are never deleted, because a hole in the claim store cannot be audited",
  });

  const aliases = await executor.query(
    `DELETE FROM entity_aliases
      WHERE tenant_id = $1::uuid
        AND ($2::text IS NULL OR alias = lower($2))`,
    [tenantId, selector.user ?? selector.subject ?? null],
  );
  stores.push({
    store: "entity_aliases",
    rows_affected: aliases.rowCount ?? 0,
    method: "alias rows deleted; unlike claim projections these carry the subject string itself",
  });

  const traces = await executor.query(
    `UPDATE query_traces
        SET candidates = '[]'::jsonb,
            returned = '[]'::jsonb
      WHERE tenant_id = $1::uuid
        AND created_at >= now() - interval '365 days'`,
    [tenantId],
  );
  stores.push({
    store: "query_traces",
    rows_affected: traces.rowCount ?? 0,
    method:
      "candidate and returned sets cleared for the tenant window; the trace row and its policy version " +
      "survive so an audit can still see that a query happened",
  });

  // ---- Blob reclamation --------------------------------------------------
  //
  // Reference-counted, and the count is taken *after* the UPDATE above cleared the
  // erased events' pointers. So an object is deleted only when no live row still
  // references those exact bytes — which is the difference between erasing one subject's
  // data and destroying another's.
  const blobOutcome = await reclaimBlobs(dependencies.blobs, executor, affectedRefs.rows.map((r) => r.payload_ref));

  stores.push({
    store: "events.blobs",
    rows_affected: blobOutcome.references_removed,
    method:
      `references cleared, then ${blobOutcome.objects_deleted} object(s) deleted and ` +
      `${blobOutcome.objects_retained_shared} retained as still referenced by another live row; ` +
      `each deletion verified absent in the physical store rather than assumed`,
  });

  // ---- Phase 2: scan -----------------------------------------------------
  const residualScan: { store: string; matches: number }[] = [];
  let residualMatches = 0;

  const scan = async (store: string, sql: string, params: readonly unknown[]): Promise<void> => {
    const result = await executor.query<{ matches: number }>(sql, params);
    const matches = Number(result.rows[0]?.matches ?? 0);
    residualScan.push({ store, matches });
    residualMatches += matches;
  };

  await scan(
    "events.payload",
    `SELECT count(*)::int AS matches
       FROM events e
       JOIN scopes s ON s.scope_id = e.scope_id
      WHERE e.tenant_id = $1::uuid
        AND (e.payload IS NOT NULL OR e.payload_ref IS NOT NULL)
        AND ($2::text IS NULL OR s.user_id = $2)
        AND ($3::text IS NULL OR e.actor_id = $3)`,
    [tenantId, scopeFilter.user, selector.actor_id ?? null],
  );

  await scan(
    "claims.content",
    `SELECT count(*)::int AS matches
       FROM claims c
       JOIN scopes s ON s.scope_id = c.scope_id
      WHERE c.tenant_id = $1::uuid
        AND c.status <> 'revoked'
        AND ($2::text IS NULL OR s.user_id = $2)`,
    [tenantId, scopeFilter.user],
  );

  await scan(
    "claim_embeddings",
    `SELECT count(*)::int AS matches
       FROM claim_embeddings e
       JOIN claims c ON c.claim_id = e.claim_id
       JOIN scopes s ON s.scope_id = c.scope_id
      WHERE e.tenant_id = $1::uuid
        AND ($2::text IS NULL OR s.user_id = $2)`,
    [tenantId, scopeFilter.user],
  );

  await scan(
    "entity_aliases",
    `SELECT count(*)::int AS matches
       FROM entity_aliases
      WHERE tenant_id = $1::uuid
        AND ($2::text IS NULL OR alias = lower($2))`,
    [tenantId, selector.user ?? selector.subject ?? null],
  );

  // The physical store is scanned by asking it what it holds, not by asking the database
  // whether it still points at anything. An earlier version of this job scanned only
  // database references, which proves the database was updated and says nothing about the
  // disk.
  if (dependencies.blobs.supportsDeletion) {
    const present = new Set(await dependencies.blobs.sweep());
    const survivors = [...blobOutcome.refs_deleted].filter((ref) => present.has(ref));
    residualScan.push({ store: "blobs.physical", matches: survivors.length });
    residualMatches += survivors.length;
  } else {
    // A store that cannot delete cannot be verified. Reported as residual rather than
    // skipped, because "we could not check" and "we checked and found nothing" must never
    // render the same way.
    residualScan.push({
      store: "blobs.physical",
      matches: blobOutcome.references_removed,
    });
    residualMatches += blobOutcome.references_removed;
    notes.push(
      "the configured blob store cannot physically delete, so its objects are counted as " +
        "residual. A verified erase is not possible against an append-only store.",
    );
  }

  await scan(
    "query_traces",
    `SELECT count(*)::int AS matches
       FROM query_traces
      WHERE tenant_id = $1::uuid
        AND (jsonb_array_length(candidates) > 0 OR jsonb_array_length(returned) > 0)
        AND created_at >= now() - interval '365 days'`,
    [tenantId],
  );

  const completedAt = dependencies.clock.now().toISOString();
  notes.push(REASON_CODES.RETENTION_LEDGER_PRESERVED);
  if (residualMatches > 0) {
    notes.push(REASON_CODES.RETENTION_RESIDUAL_MATCHES);
    notes.push(
      "a non-zero residual count means the job is not verified; the surviving rows are named per store " +
        "and must be addressed before the deletion can be reported as complete",
    );
  } else {
    notes.push(REASON_CODES.RETENTION_VERIFIED);
  }

  return {
    job_id: jobId,
    mode,
    reason: request.reason,
    stores,
    blobs: blobOutcome,
    claims_affected: revokedCount,
    events_redacted: affectedEvents.rows.length,
    started_at: startedAt,
    completed_at: completedAt,
    residual_scan: residualScan,
    residual_matches: residualMatches,
    notes,
  };
}

async function recordJob(
  dependencies: RetentionDependencies,
  tenantId: string,
  job: RetentionJob,
  manifest: ForgetManifest,
): Promise<void> {
  await dependencies.db.withSystemContext(
    { tenant: tenantId, actor: "retention:record" },
    async (executor) => {
      await executor.query(
        `INSERT INTO retention_jobs (
           job_id, tenant_id, subject_or_scope, mode, reason, status,
           stores_touched, manifest, residual_matches, created_at, updated_at, verified_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::jsonb, $4::retention_mode, $5, $6::retention_state,
           $7::text[], $8::jsonb, $9, $10::timestamptz, $11::timestamptz, $12::timestamptz
         )`,
        [
          stripPrefix(job.job_id),
          tenantId,
          JSON.stringify(job.subject_or_scope),
          job.mode,
          job.reason,
          job.status,
          job.stores_touched,
          JSON.stringify(manifest),
          job.residual_matches,
          job.created_at,
          job.updated_at,
          job.verified_at,
        ],
      );
    },
  );
}

export async function readRetentionJob(
  dependencies: RetentionDependencies,
  tenantId: string,
  jobId: string,
): Promise<RetentionJob | null> {
  return dependencies.db.withSystemContext(
    { tenant: tenantId, actor: "retention:read" },
    async (executor) => {
      const result = await executor.query<{
        job_id: string;
        subject_or_scope: unknown;
        mode: RetentionMode;
        reason: string;
        status: RetentionJob["status"];
        stores_touched: string[];
        manifest: unknown;
        residual_matches: number | null;
        created_at: Date | string;
        updated_at: Date | string;
        verified_at: Date | string | null;
      }>(`SELECT * FROM retention_jobs WHERE job_id = $1::uuid`, [stripPrefix(jobId)]);
      const row = result.rows[0];
      if (!row) return null;
      return {
        job_id: toPublicId("ret", row.job_id),
        tenant: tenantId,
        subject_or_scope: row.subject_or_scope,
        mode: row.mode,
        reason: row.reason,
        status: row.status,
        stores_touched: row.stores_touched,
        manifest: row.manifest,
        residual_matches: row.residual_matches,
        created_at: toIso(row.created_at),
        updated_at: toIso(row.updated_at),
        verified_at: row.verified_at === null ? null : toIso(row.verified_at),
      };
    },
  );
}

/**
 * Corrections.
 *
 * A correction never overwrites. It appends a relation and closes the validity
 * interval, so the history remains readable and the earlier belief stays
 * inspectable. Destructive correction would destroy exactly the evidence an
 * operator needs to answer "why did the agent believe that in March".
 */
export async function correctClaim(
  dependencies: RetentionDependencies,
  input: {
    readonly tenant_id: string;
    readonly principal: string;
    readonly claim_id: string;
    readonly rel: "supersedes" | "contradicts" | "narrows";
    readonly new_valid_to?: string | null;
    readonly reason_codes: readonly string[];
  },
): Promise<void> {
  await dependencies.db.withSystemContext(
    { tenant: input.tenant_id, actor: input.principal },
    async (executor) => {
      const internal = stripPrefix(input.claim_id);
      await executor.query(
        `UPDATE claims
            SET status = CASE WHEN $2::text = 'contradicts' THEN 'disputed'::claim_status ELSE 'superseded'::claim_status END,
                valid_to = COALESCE($3::timestamptz, now())
          WHERE claim_id = $1::uuid AND valid_to IS NULL`,
        [internal, input.rel, input.new_valid_to ?? null],
      );
      await executor.query(
        `INSERT INTO decisions (decision_id, tenant_id, claim_id, policy_version, outcome, reason_codes, approver)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'revoke', $5::text[], $6)`,
        [
          stripPrefix(dependencies.ids.next("dec")),
          input.tenant_id,
          internal,
          "correction-v1",
          [...input.reason_codes],
          input.principal,
        ],
      );
      await deindexClaim(executor, input.claim_id);
    },
  );
}

function stripPrefix(id: string): string {
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

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export { REASON_CODES };

/**
 * Delete the blob objects an erasure detached, but only those nothing else references.
 *
 * The reference count is a query against `events` taken *after* the erased rows' pointers
 * were cleared, so a ref still appearing in that result is live for somebody else. That is
 * the whole safety property: a content-addressed store deduplicates, so two events with
 * identical payloads share one object, and deleting on the first detach would destroy the
 * second event's evidence while reporting a successful erasure.
 *
 * Deletion is verified rather than issued: `BlobStore.delete` returns whether the object is
 * absent afterwards, and only a `true` is counted as deleted. An object that survives a
 * delete call is `retained_other`, which is a failure the manifest reports instead of
 * rounding away — because the one thing an erasure job must never do is claim success it
 * cannot demonstrate.
 */
export async function reclaimBlobs(
  blobs: BlobStore,
  executor: QueryExecutor,
  refs: readonly string[],
): Promise<BlobOutcome> {
  const unique = [...new Set(refs)];
  if (unique.length === 0) {
    return {
      references_removed: 0,
      objects_deleted: 0,
      objects_retained_shared: 0,
      objects_retained_other: 0,
      store_supports_deletion: blobs.supportsDeletion,
      refs_deleted: [],
      refs_retained_shared: [],
    };
  }

  if (!blobs.supportsDeletion) {
    return {
      references_removed: unique.length,
      objects_deleted: 0,
      objects_retained_shared: 0,
      objects_retained_other: unique.length,
      store_supports_deletion: false,
      refs_deleted: [],
      refs_retained_shared: [],
    };
  }

  // Live references, counted after the payload clear. `payload_ref` is unindexed, so this
  // is a scan; it runs once per erasure rather than once per ref.
  const live = await executor.query<{ payload_ref: string }>(
    `SELECT DISTINCT payload_ref FROM events WHERE payload_ref = ANY($1::text[])`,
    [unique],
  );
  const stillReferenced = new Set(live.rows.map((row) => row.payload_ref));

  const deleted: string[] = [];
  const retainedShared: string[] = [];
  let retainedOther = 0;

  for (const ref of unique) {
    if (stillReferenced.has(ref)) {
      retainedShared.push(ref);
      continue;
    }
    if (await blobs.delete(ref)) {
      deleted.push(ref);
    } else {
      retainedOther += 1;
    }
  }

  return {
    references_removed: unique.length,
    objects_deleted: deleted.length,
    objects_retained_shared: retainedShared.length,
    objects_retained_other: retainedOther,
    store_supports_deletion: true,
    refs_deleted: deleted,
    refs_retained_shared: retainedShared,
  };
}
