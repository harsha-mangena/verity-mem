/**
 * Projections: the disposable half of the system.
 *
 * Three of them, all rebuildable from the ledger and the claim store:
 *
 *   search   — the full-text projection. The `search_tsv` column is maintained by
 *              a database trigger so it cannot drift from the row it describes.
 *   dense    — pgvector embeddings, written only in this module.
 *   entities — alias resolution built from claim subjects and objects.
 *
 * The rule this module enforces: **only accepted claims are projected.** A
 * quarantined or proposed claim is not indexed and then filtered at query time —
 * it is never indexed at all. Filtering after retrieval leaks through counts,
 * timings and summaries, which is a different bug with the same root cause.
 */
import { REASON_CODES } from "@veritymem/contracts";
import type { OutboxMessage, OutboxProcessor, QueryExecutor, Db } from "@veritymem/ledger";
import { canonicalize } from "@veritymem/ledger";
import { toVectorLiteral, type EmbeddingBackend } from "./embeddings.ts";

export const PROJECTION_CODE_VERSION = "projections@1";

export interface ProjectionDependencies {
  readonly db: Db;
  readonly embeddings: EmbeddingBackend;
}

export interface ClaimProjectionRow {
  readonly claim_id: string;
  readonly tenant_id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: unknown;
  readonly status: string;
  readonly [column: string]: unknown;
}

/**
 * Project one claim into the dense and entity projections.
 *
 * Idempotent: writing the same claim twice produces the same rows and the same
 * vectors, which is what makes a rebuild byte-identical. The lexical projection is
 * handled by the `claims_search_tsv` trigger rather than here, so this function
 * does not touch `search_tsv` at all.
 */
export async function projectClaim(
  executor: QueryExecutor,
  dependencies: ProjectionDependencies,
  claimId: string,
): Promise<{ projected: boolean; reason: string; entities: number }> {
  const result = await executor.query<ClaimProjectionRow>(
    `SELECT claim_id, tenant_id, subject, predicate, object, status
       FROM claims WHERE claim_id = $1::uuid`,
    [stripPrefix(claimId)],
  );
  const claim = result.rows[0];
  if (!claim) {
    return { projected: false, reason: "claim not found", entities: 0 };
  }
  if (claim.status !== "accepted" && claim.status !== "disputed") {
    // Deliberately also remove any prior projection: a claim that was accepted and
    // has since been revoked must stop being a retrieval candidate, and leaving a
    // stale vector in place would make revocation cosmetic.
    await deindexClaim(executor, toPublicId("clm", claim.claim_id));
    return { projected: false, reason: `status ${claim.status} is not projected`, entities: 0 };
  }

  const internalId = stripPrefix(claimId);
  const text = projectionText(claim);
  const [vector] = await dependencies.embeddings.embed([text]);
  if (!vector) {
    return { projected: false, reason: "embedding backend returned no vector", entities: 0 };
  }

  await executor.query(
    `INSERT INTO claim_embeddings (claim_id, tenant_id, embedding, model_id)
     VALUES ($1::uuid, $2::uuid, $3::vector, $4)
     ON CONFLICT (claim_id) DO UPDATE
       SET embedding = EXCLUDED.embedding,
           model_id = EXCLUDED.model_id,
           tenant_id = EXCLUDED.tenant_id`,
    [internalId, claim.tenant_id, toVectorLiteral(vector), dependencies.embeddings.model_id],
  );

  const entities = await projectEntities(executor, claim);

  await executor.query(
    `INSERT INTO projection_versions (projection, code_version, model_version, ledger_watermark, updated_at)
     VALUES ($1, $2, $3, COALESCE((SELECT COALESCE(max(seq), 0) FROM events WHERE tenant_id = $4::uuid), 0), now())
     ON CONFLICT (projection) DO UPDATE
       SET code_version = EXCLUDED.code_version,
           model_version = EXCLUDED.model_version,
           ledger_watermark = GREATEST(projection_versions.ledger_watermark, EXCLUDED.ledger_watermark),
           updated_at = now()`,
    ["dense", PROJECTION_CODE_VERSION, dependencies.embeddings.model_id, claim.tenant_id],
  );

  return { projected: true, reason: "projected", entities };
}

/**
 * Remove a claim from every projection.
 *
 * Separate from projection because revocation and retention both need it, and
 * because "the claim is no longer accepted" and "the claim is no longer indexed"
 * must be the same event or the index becomes a leak of revoked material.
 *
 * Entity aliases are *not* deleted here on purpose. An alias is many-to-many: the
 * same string is written by every claim that mentions it, so deleting on one
 * claim's revocation would silently break the other claims that still rely on it.
 * Alias garbage collection is a rebuild-time concern with a reference count, and
 * pretending otherwise here would trade a leak for a missing-alias bug.
 */
export async function deindexClaim(executor: QueryExecutor, claimId: string): Promise<void> {
  await executor.query(`DELETE FROM claim_embeddings WHERE claim_id = $1::uuid`, [stripPrefix(claimId)]);
}

/** Text that represents the claim in the dense channel. Subject and key first. */
export function projectionText(claim: { subject: string; predicate: string; object: unknown }): string {
  const objectText =
    typeof claim.object === "string" ? claim.object : canonicalize(claim.object ?? null);
  return `${claim.subject} ${claim.predicate} ${objectText}`.replace(/\s+/g, " ").trim();
}

/**
 * Build entity aliases from a claim.
 *
 * Aliases are recorded per tenant and are never merged across tenants: an alias
 * table that resolved `alice@acme` to `alice@rival` would be a cross-tenant
 * correlation channel, which is a worse problem than the retrieval ambiguity the
 * table exists to solve.
 */
export async function projectEntities(
  executor: QueryExecutor,
  claim: ClaimProjectionRow,
): Promise<number> {
  const candidates = new Set<string>();
  const subject = claim.subject.trim();
  if (subject.length > 0) candidates.add(subject.toLowerCase());

  if (typeof claim.object === "string") {
    const value = claim.object.trim();
    if (value.length > 0 && value.length <= 200) candidates.add(value.toLowerCase());
  }

  let written = 0;
  for (const alias of candidates) {
    // The canonical form is the alias itself; a real resolver would cluster these,
    // and saying so here is better than pretending this is entity resolution.
    const result = await executor.query(
      `INSERT INTO entity_aliases (tenant_id, alias, canonical, source, confidence)
       VALUES ($1::uuid, $2, $2, $3, $4)
       ON CONFLICT (tenant_id, alias, canonical) DO NOTHING`,
      [claim.tenant_id, alias, "claim_projection", 1.0],
    );
    written += result.rowCount ?? 0;
  }
  return written;
}

/**
 * The outbox processor for `project.claim`.
 *
 * Runs inside a request transaction bound to the message's tenant, so the
 * projection write is subject to the same row-level security as any other write.
 */
export function createProjectionProcessor(dependencies: ProjectionDependencies): OutboxProcessor {
  return {
    kind: "project.claim",
    async handle(message: OutboxMessage): Promise<void> {
      const claimId = typeof message.payload["claim_id"] === "string" ? message.payload["claim_id"] : null;
      if (!claimId) {
        throw new Error(`project.claim message ${message.outbox_id} has no claim_id`);
      }
      // The worker wraps this handler in a request transaction bound to the
      // message's tenant, so `db.query` resolves to that transaction and the
      // projection write inherits the caller's row-level security context.
      const outcome = await projectClaim(dependencies.db, dependencies, claimId);
      if (!outcome.projected) {
        // Not an error: a claim that is not accepted is simply not projected, and
        // retrying would not change that. The processor returns normally so the
        // message completes; the reason is visible on the claim's own status.
        return;
      }
    },
  };
}

export interface RebuildReport {
  readonly projection: string;
  readonly claims_seen: number;
  readonly claims_projected: number;
  readonly claims_skipped: number;
  readonly entities_written: number;
  readonly digest: string;
  readonly rows: number;
}

/**
 * Rebuild every projection from the claim store.
 *
 * Deterministic given a fixed claim set, code version, model id and embedding
 * backend: the digest of the rebuilt rows is what `/v1/replay` compares.
 */
export async function rebuildProjections(
  executor: QueryExecutor,
  dependencies: ProjectionDependencies,
  options: { tenantId: string; truncate?: boolean } = { tenantId: "" },
): Promise<RebuildReport> {
  const claims = await executor.query<ClaimProjectionRow>(
    `SELECT claim_id, tenant_id, subject, predicate, object, status
       FROM claims
      WHERE tenant_id = $1::uuid
        AND status IN ('accepted','disputed')
      ORDER BY claim_id ASC`,
    [options.tenantId],
  );

  if (options.truncate !== false) {
    await executor.query(
      `DELETE FROM claim_embeddings WHERE tenant_id = $1::uuid`,
      [options.tenantId],
    );
  }

  let projected = 0;
  let skipped = 0;
  let entities = 0;
  for (const claim of claims.rows) {
    const outcome = await projectClaim(executor, dependencies, toPublicId("clm", claim.claim_id));
    if (outcome.projected) projected += 1;
    else skipped += 1;
    entities += outcome.entities;
  }

  const rows = await executor.query<{ claim_id: string; model_id: string; subject: string; predicate: string; object: unknown }>(
    `SELECT e.claim_id, e.model_id, c.subject, c.predicate, c.object
       FROM claim_embeddings e
       JOIN claims c ON c.claim_id = e.claim_id
      WHERE e.tenant_id = $1::uuid
      ORDER BY e.claim_id ASC`,
    [options.tenantId],
  );

  const digest = await digestRows(
    rows.rows.map((row) => ({
      claim_id: toPublicId("clm", row.claim_id),
      model_id: row.model_id,
      text: projectionText(row),
    })),
  );

  return {
    projection: "dense+entities",
    claims_seen: claims.rows.length,
    claims_projected: projected,
    claims_skipped: skipped,
    entities_written: entities,
    digest: digest.digest,
    rows: digest.rows,
  };
}

/** Digest of the lexical projection, read back from the trigger-maintained column. */
export async function digestLexicalProjection(
  executor: QueryExecutor,
  tenantId: string,
): Promise<{ digest: string; rows: number }> {
  const rows = await executor.query<{ claim_id: string; search_tsv: string | null }>(
    `SELECT claim_id, search_tsv::text AS search_tsv
       FROM claims
      WHERE tenant_id = $1::uuid AND status IN ('accepted','disputed')
      ORDER BY claim_id ASC`,
    [tenantId],
  );
  return digestRows(
    rows.rows.map((row) => ({ claim_id: toPublicId("clm", row.claim_id), tsv: row.search_tsv ?? "" })),
  );
}

async function digestRows(rows: readonly unknown[]): Promise<{ digest: string; rows: number }> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(canonicalize(row), "utf8");
    hash.update("\n");
  }
  return { digest: hash.digest("hex"), rows: rows.length };
}

/**
 * A claim whose evidence has been redacted is no longer citable.
 *
 * Called by retention: when an event payload is erased, every claim resting on a
 * span inside it loses its support, so it must stop being retrieved rather than
 * continuing to be returned with a null quote.
 */
export async function deindexClaimsWithRedactedEvidence(
  executor: QueryExecutor,
  tenantId: string,
): Promise<number> {
  const affected = await executor.query<{ claim_id: string }>(
    `SELECT DISTINCT c.claim_id
       FROM claims c
       JOIN claim_evidence ce ON ce.claim_id = c.claim_id
       JOIN evidence_spans s ON s.span_id = ce.span_id
       JOIN events e ON e.event_id = s.event_id
      WHERE c.tenant_id = $1::uuid AND e.redacted_at IS NOT NULL`,
    [tenantId],
  );
  for (const row of affected.rows) {
    await deindexClaim(executor, toPublicId("clm", row.claim_id));
  }
  return affected.rows.length;
}

export { REASON_CODES };

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

function toPublicId(prefix: string, value: string): string {
  const hex = value.includes("-") ? value.replace(/-/g, "") : value;
  return `${prefix}_${hex}`;
}
