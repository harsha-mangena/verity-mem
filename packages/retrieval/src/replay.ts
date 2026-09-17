/**
 * The replay oracle.
 *
 * The specification's commitment is narrow and testable: *deterministic projection
 * equality for identical ledger, code version, model hash and policy version*. This
 * module is what makes that claim checkable rather than aspirational, and it is the
 * instrument that localises a wrong answer to a stage: if a rebuild of the same
 * ledger produces different bytes, something in the extraction, gate or projection
 * path is not a function of its recorded inputs.
 *
 * Two things it deliberately does not do:
 *
 *   - It does not re-run extraction or re-evaluate the gate. Those are recorded
 *     decisions, and re-deciding them under today's policy is a different operation
 *     with a different answer. A replay of decisions would be a re-evaluation, which
 *     the policy cookbook describes separately.
 *   - It does not report `deterministic: true` when a projection was not compared.
 *     A digest of nothing matches a digest of nothing, and calling that
 *     determinism is the kind of unearned green tick this project exists to
 *     criticise. Skipped projections are named as skipped.
 */
import { performance } from "node:perf_hooks";
import type { ProjectionDigest, ReplayRequest, ReplayResponse } from "@veritymem/contracts";
import { DEFAULT_COMMIT_POLICY } from "@veritymem/contracts";
import type { Clock, Db, QueryExecutor } from "@veritymem/ledger";
import { canonicalize } from "@veritymem/ledger";
import type { EmbeddingBackend } from "./embeddings.ts";
import {
  PROJECTION_CODE_VERSION,
  digestLexicalProjection,
  rebuildProjections,
} from "./projections.ts";

export type ReplayableProjection = "dense" | "lexical" | "entities";

export const REPLAYABLE_PROJECTIONS: readonly ReplayableProjection[] = ["dense", "lexical", "entities"];

export interface ReplayDependencies {
  readonly db: Db;
  readonly embeddings: EmbeddingBackend;
  readonly clock: Clock;
  readonly policyVersion?: string;
  readonly codeVersion?: string;
}

export interface ReplayOptions {
  readonly tenantId: string;
  readonly actor: string;
}

/**
 * Compare — and optionally rebuild — the disposable projections for one tenant.
 *
 * `verify` mode reads the projections, rebuilds them, reads again and compares. The
 * rebuild is the operation under test: if it is a pure function of the claim store
 * and the configured embedding backend, the digests match. `rebuild` mode performs
 * the rebuild without asserting anything, for an operator who has deliberately
 * changed the code or model version and expects the digest to move.
 */
export async function replay(
  dependencies: ReplayDependencies,
  request: ReplayRequest,
  options: ReplayOptions,
): Promise<ReplayResponse> {
  const started = performance.now();
  const mode = request.mode ?? "verify";
  const requested = request.projections && request.projections.length > 0
    ? request.projections
    : REPLAYABLE_PROJECTIONS;

  const codeVersion = dependencies.codeVersion ?? PROJECTION_CODE_VERSION;
  const policyVersion = dependencies.policyVersion ?? DEFAULT_COMMIT_POLICY.version;

  // One system context for the whole operation: a replay spans every scope in the
  // tenant, and binding any single scope would silently compare a subset. The
  // watermark is read inside the same context so it describes the same instant.
  return dependencies.db.withSystemContext(
    { tenant: options.tenantId, actor: options.actor },
    async (executor) => {
      const watermark = await readWatermark(executor, options.tenantId);

      const before = await readDigests(executor, dependencies, options.tenantId, requested);

      // Drop embeddings written by any other model before rebuilding. Without this
      // a model change leaves two generations in the table, the digest depends on
      // which run wrote last, and "a model upgrade is a rebuild, not a migration"
      // stops being true.
      await executor.query(
        `DELETE FROM claim_embeddings
          WHERE tenant_id = $1::uuid AND model_id <> $2`,
        [options.tenantId, dependencies.embeddings.model_id],
      );

      if (mode === "rebuild" && requested.includes("dense")) {
        await rebuildProjections(
          executor,
          { db: dependencies.db, embeddings: dependencies.embeddings },
          { tenantId: options.tenantId, truncate: true },
        );
      } else if (mode === "rebuild") {
        // Entities are rebuilt as a side effect of the dense rebuild, because
        // `projectClaim` writes both. Rebuilding one without the other would leave
        // the entity projection describing a claim set that no longer exists.
        await rebuildProjections(
          executor,
          { db: dependencies.db, embeddings: dependencies.embeddings },
          { tenantId: options.tenantId, truncate: false },
        );
      } else {
        // Verify mode rebuilds too, which is the entire point: comparing a
        // projection with itself proves nothing.
        await rebuildProjections(
          executor,
          { db: dependencies.db, embeddings: dependencies.embeddings },
          { tenantId: options.tenantId, truncate: true },
        );
      }

      const after = await readDigests(executor, dependencies, options.tenantId, requested);

      const projections = requested.map((projection) => {
        const beforeDigest = before.get(projection) ?? null;
        const afterDigest = after.get(projection);
        if (!afterDigest) {
          throw new Error(`replay: projection ${projection} produced no digest after the rebuild`);
        }
        return {
          projection,
          before: beforeDigest,
          after: afterDigest,
          // Three ways a projection fails to count as stable, and all three matter:
          //   * no prior digest — it has been shown to exist, not to be stable;
          //   * zero rows — the digest of nothing equals the digest of nothing, so an
          //     empty projection would compare "equal" forever and report a clean
          //     replay of a projection that never held anything;
          //   * genuinely different digests.
          byte_identical:
            beforeDigest !== null &&
            beforeDigest.rows > 0 &&
            afterDigest.rows > 0 &&
            beforeDigest.digest === afterDigest.digest,
          rebuilt_rows: afterDigest.rows,
        };
      });

      const compared = projections.filter((projection) => projection.before !== null);
      const deterministic = compared.length > 0 && compared.every((projection) => projection.byte_identical);

      return {
        ledger_watermark: request.up_to_seq ?? watermark,
        code_version: codeVersion,
        policy_version: policyVersion,
        projections,
        // Empty comparisons report `false`. "We compared nothing and found no
        // differences" is not determinism, and saying it were would be the most
        // comfortable lie available to this function.
        deterministic,
        duration_ms: Math.round((performance.now() - started) * 1000) / 1000,
      };
    },
  );
}

async function readDigests(
  executor: QueryExecutor,
  dependencies: ReplayDependencies,
  tenantId: string,
  projections: readonly ReplayableProjection[],
): Promise<Map<ReplayableProjection, ProjectionDigest>> {
  const out = new Map<ReplayableProjection, ProjectionDigest>();

  for (const projection of projections) {
    switch (projection) {
      case "dense": {
        const rows = await executor.query<{ claim_id: string; model_id: string; subject: string; predicate: string; object: unknown }>(
          `SELECT e.claim_id, e.model_id, c.subject, c.predicate, c.object
             FROM claim_embeddings e
             JOIN claims c ON c.claim_id = e.claim_id
            WHERE e.tenant_id = $1::uuid
            ORDER BY e.claim_id ASC`,
          [tenantId],
        );
        out.set(
          "dense",
          await digestRows(
            rows.rows.map((row) => ({
              claim_id: publicId("clm", row.claim_id),
              model_id: row.model_id,
              text: `${row.subject} ${row.predicate} ${typeof row.object === "string" ? row.object : canonicalize(row.object ?? null)}`.replace(/\s+/g, " ").trim(),
            })),
          ),
        );
        break;
      }
      case "lexical": {
        const lexical = await digestLexicalProjection(executor, tenantId);
        out.set("lexical", {
          projection: "lexical",
          digest: lexical.digest,
          rows: lexical.rows,
          ledger_watermark: await readWatermark(executor, tenantId),
        });
        break;
      }
      case "entities": {
        const rows = await executor.query<{ alias: string; canonical: string; source: string }>(
          `SELECT alias, canonical, source
             FROM entity_aliases
            WHERE tenant_id = $1::uuid
            ORDER BY alias ASC, canonical ASC, source ASC`,
          [tenantId],
        );
        out.set("entities", await digestRows(rows.rows));
        break;
      }
      default: {
        const exhaustive: never = projection;
        throw new Error(`replay: unhandled projection ${String(exhaustive)}`);
      }
    }
  }
  return out;
}

async function readWatermark(executor: QueryExecutor, tenantId: string): Promise<number> {
  const result = await executor.query<{ watermark: number }>(
    `SELECT COALESCE(max(seq), 0)::int AS watermark FROM events WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  return Number(result.rows[0]?.watermark ?? 0);
}

async function digestRows(rows: readonly unknown[]): Promise<ProjectionDigest> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(canonicalize(row), "utf8");
    hash.update("\n");
  }
  return { projection: "dense", digest: hash.digest("hex"), rows: rows.length, ledger_watermark: 0 };
}

function publicId(prefix: string, value: string): string {
  const hex = value.includes("-") ? value.replace(/-/g, "") : value;
  return `${prefix}_${hex}`;
}
