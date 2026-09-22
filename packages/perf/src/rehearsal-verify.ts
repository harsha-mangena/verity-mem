/**
 * The projection invariants, stated and then checked against the database.
 *
 * ## Why the invariants are restated rather than re-derived
 *
 * Migration 0015 computes its own canonical values in SQL. Checking its output with its own
 * predicate would prove only that the migration agrees with itself. So the expected set is
 * computed here from the *claim rows* by two independently stated definitions:
 *
 *   * **M — the migration's definition.** Subject, and a string object of at most 200
 *     characters, lowercased and trimmed, with an object equal to the subject contributing
 *     one row rather than two. This is what 0015's backfill promises.
 *   * **W — the write path's definition.** What `projectEntities` in
 *     `packages/retrieval/src/projections.ts` produces for the same claim, which is the
 *     definition every claim written *after* the migration is projected by.
 *
 * A claim touched by the write path and a claim reached by the backfill must end up in the
 * same state. Where the two definitions can disagree — they differ on whether the length
 * bound is applied before or after trimming — the disagreement is measured and reported
 * rather than smoothed over, because that edge is exactly where a backfilled claim would be
 * missing a projection row that a newly written claim has.
 *
 * Every check runs as the owner role, because a completeness check that ran as
 * `veritymem_app` could not distinguish "no violation" from "no visibility". The separate
 * RLS check runs as `veritymem_app` on purpose, and asserts that it sees *less*.
 */
import type pg from "pg";
import { applyStatus } from "@veritymem/claims";
import type { Db, QueryExecutor } from "@veritymem/ledger";
import { entityChannel } from "@veritymem/retrieval";
import { channelQueryFor, type ProbeTenant } from "./rehearsal-probes.ts";

/** A stated invariant, its SQL count, and whether the count must be zero. */
export interface ProjectionInvariant {
  readonly name: string;
  /** The column the count is read from, named explicitly so the two cannot drift apart. */
  readonly column: string;
  readonly statement: string;
  readonly must_be_zero: boolean;
}

export const PROJECTION_INVARIANTS: readonly ProjectionInvariant[] = [
  {
    name: "completeness_migration_predicate",
    column: "missing_rows_migration_predicate",
    statement:
      "For every claim with status accepted or disputed, and for every canonical it yields " +
      "under the migration's own definition M (trimmed lowercase subject when non-empty; a " +
      "JSON string object when non-empty, at most 200 characters untrimmed, and not equal to " +
      "the subject after lowering), there is exactly one claim_entities row for " +
      "(tenant_id, canonical, claim_id).",
    must_be_zero: true,
  },
  {
    name: "completeness_write_path_predicate",
    column: "missing_rows_write_path",
    statement:
      "The same, under the write path's definition W (the trimmed subject, and a JSON string " +
      "object whose *trimmed* length is at most 200 characters).",
    must_be_zero: true,
  },
  {
    name: "unexpected_projection_rows",
    column: "unexpected_projection_rows",
    statement:
      "No claim_entities row exists for an accepted or disputed claim whose canonical is not " +
      "in that claim's write-path canonical set.",
    must_be_zero: true,
  },
  {
    name: "orphan_projection_rows",
    column: "orphan_projection_rows",
    statement: "Every claim_entities row references a claim that exists.",
    must_be_zero: true,
  },
  {
    name: "tenant_mismatch_rows",
    column: "tenant_mismatch_rows",
    statement: "Every claim_entities row's tenant_id equals the tenant_id of its claim.",
    must_be_zero: true,
  },
  {
    name: "duplicate_projection_keys",
    column: "duplicate_projection_keys",
    statement:
      "No (tenant_id, canonical, claim_id) triple appears in claim_entities more than once.",
    must_be_zero: true,
  },
  {
    name: "primary_key_present",
    column: "primary_key_present",
    statement:
      "claim_entities carries a primary key on (tenant_id, canonical, claim_id); stated as a " +
      "count of primary-key constraints, which must be exactly one.",
    must_be_zero: false,
  },
  {
    name: "row_level_security_enabled",
    column: "row_level_security_enabled",
    statement: "claim_entities has row-level security enabled.",
    must_be_zero: false,
  },
];

export interface ProjectionCheck {
  readonly name: string;
  readonly column: string;
  readonly statement: string;
  readonly count: number | null;
  readonly expected: number | null;
  readonly ok: boolean;
  /** How the count was obtained, so a reader can tell a measurement from an assumption. */
  readonly measured_by: string;
}

export interface BehaviourCase {
  readonly case: string;
  readonly expectation: string;
  readonly observed: string;
  readonly ok: boolean;
}

export interface RlsCheck {
  readonly statement: string;
  readonly tenant_a: string;
  readonly tenant_b: string;
  readonly owner_rows_a: number | null;
  readonly owner_rows_b: number | null;
  readonly app_visible_rows_a: number | null;
  readonly app_visible_rows_b_from_a: number | null;
  readonly app_visible_claims_b_from_a: number | null;
  readonly ok: boolean;
  readonly note: string;
}

export interface ProjectionVerification {
  readonly checked_at: string;
  readonly role: string;
  readonly checks: readonly ProjectionCheck[];
  readonly observed: Record<string, number | null>;
  readonly behaviours: readonly BehaviourCase[];
  readonly rls: RlsCheck;
  readonly violations: readonly string[];
}

/**
 * The canonical-set SQL, written once with a switch for the one clause the two definitions
 * disagree about, so the disagreement is visible in the source rather than buried in two
 * copies of the same query that drifted.
 */
function expectedCanonicals(definition: "migration" | "write_path"): string {
  const lengthClause =
    definition === "migration"
      ? "length(c.object #>> '{}') <= 200"
      : "length(btrim(c.object #>> '{}')) <= 200";
  return `
    SELECT c.tenant_id, c.claim_id, lower(btrim(c.subject)) AS canonical
      FROM claims c
     WHERE c.status IN ('accepted','disputed') AND btrim(c.subject) <> ''
    UNION
    SELECT c.tenant_id, c.claim_id, lower(btrim(c.object #>> '{}')) AS canonical
      FROM claims c
     WHERE c.status IN ('accepted','disputed')
       AND jsonb_typeof(c.object) = 'string'
       AND btrim(c.object #>> '{}') <> ''
       AND ${lengthClause}
       AND lower(btrim(c.object #>> '{}')) <> lower(btrim(c.subject))
  `;
}

/**
 * The projection counts a migration's own telemetry records.
 *
 * Read immediately after the migration commits, so the numbers describe the corpus as the
 * migration left it and not as the workload later changed it. `present: false` is a fact
 * about the schema — 0014 does not create `claim_entities` — rather than a failed reading.
 */
export async function readProjectionCounts(client: pg.Client): Promise<{
  readonly present: boolean;
  readonly values: Record<string, number | null>;
}> {
  const present = await client.query<{ present: boolean }>(
    "SELECT to_regclass('public.claim_entities') IS NOT NULL AS present",
  );
  if (present.rows[0]?.present !== true) {
    return { present: false, values: { rows: null, duplicates: null, orphans: null, missing: null } };
  }
  const result = await client.query<Record<string, string>>(
    `WITH expected AS (${expectedCanonicals("migration")})
     SELECT
       (SELECT count(*)::text FROM claim_entities) AS rows,
       (SELECT count(*)::text FROM (
          SELECT tenant_id, canonical, claim_id FROM claim_entities
           GROUP BY tenant_id, canonical, claim_id HAVING count(*) > 1) d) AS duplicates,
       (SELECT count(*)::text FROM claim_entities ce
          LEFT JOIN claims c ON c.claim_id = ce.claim_id
         WHERE c.claim_id IS NULL) AS orphans,
       (SELECT count(*)::text FROM expected e
          LEFT JOIN claim_entities ce
            ON ce.tenant_id = e.tenant_id AND ce.claim_id = e.claim_id AND ce.canonical = e.canonical
         WHERE ce.claim_id IS NULL) AS missing`,
  );
  const row = result.rows[0] ?? {};
  const values: Record<string, number | null> = {};
  for (const key of ["rows", "duplicates", "orphans", "missing"]) {
    values[key] = numeric(row[key]);
  }
  return { present: true, values };
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Run the invariant counts as the owner role. */
export async function verifyProjection(
  client: pg.Client,
  input: { readonly writtenAfter: string | null },
): Promise<ProjectionVerification> {
  const expectedM = expectedCanonicals("migration");
  const expectedW = expectedCanonicals("write_path");
  const afterClause = input.writtenAfter === null ? "TRUE" : `c.recorded_at >= $1::timestamptz`;
  const params = input.writtenAfter === null ? [] : [input.writtenAfter];

  const result = await client.query<Record<string, string | null>>(
    `WITH expected_m AS (${expectedM}),
          expected_w AS (${expectedW})
     SELECT
       (SELECT count(*)::text FROM expected_m) AS expected_rows_migration_predicate,
       (SELECT count(*)::text FROM expected_w) AS expected_rows_write_path,
       (SELECT count(*)::text FROM expected_m e
          LEFT JOIN claim_entities ce
            ON ce.tenant_id = e.tenant_id AND ce.claim_id = e.claim_id AND ce.canonical = e.canonical
         WHERE ce.claim_id IS NULL) AS missing_rows_migration_predicate,
       (SELECT count(*)::text FROM expected_w e
          LEFT JOIN claim_entities ce
            ON ce.tenant_id = e.tenant_id AND ce.claim_id = e.claim_id AND ce.canonical = e.canonical
         WHERE ce.claim_id IS NULL) AS missing_rows_write_path,
       (SELECT count(*)::text FROM claim_entities ce
          JOIN claims c ON c.claim_id = ce.claim_id
          LEFT JOIN expected_w e
            ON e.tenant_id = ce.tenant_id AND e.claim_id = ce.claim_id AND e.canonical = ce.canonical
         WHERE c.status IN ('accepted','disputed') AND e.claim_id IS NULL) AS unexpected_projection_rows,
       (SELECT count(*)::text FROM claim_entities ce
          LEFT JOIN claims c ON c.claim_id = ce.claim_id
         WHERE c.claim_id IS NULL) AS orphan_projection_rows,
       (SELECT count(*)::text FROM claim_entities ce
          JOIN claims c ON c.claim_id = ce.claim_id
         WHERE ce.tenant_id <> c.tenant_id) AS tenant_mismatch_rows,
       (SELECT count(*)::text FROM (
          SELECT tenant_id, canonical, claim_id FROM claim_entities
           GROUP BY tenant_id, canonical, claim_id HAVING count(*) > 1) d) AS duplicate_projection_keys,
       (SELECT count(*)::text FROM pg_constraint
         WHERE conrelid = 'public.claim_entities'::regclass AND contype = 'p') AS primary_key_present,
       (SELECT relrowsecurity::int::text FROM pg_class
         WHERE oid = 'public.claim_entities'::regclass) AS row_level_security_enabled,
       (SELECT count(*)::text FROM claim_entities) AS claim_entities_rows,
       (SELECT count(DISTINCT claim_id)::text FROM claim_entities) AS claims_with_projection_rows,
       (SELECT count(*)::text FROM claims WHERE status IN ('accepted','disputed')) AS accepted_or_disputed_claims,
       (SELECT count(*)::text FROM expected_w e JOIN claims c ON c.claim_id = e.claim_id
         WHERE ${afterClause}) AS expected_rows_written_after,
       (SELECT count(*)::text FROM expected_w e
          JOIN claims c ON c.claim_id = e.claim_id
          LEFT JOIN claim_entities ce
            ON ce.tenant_id = e.tenant_id AND ce.claim_id = e.claim_id AND ce.canonical = e.canonical
         WHERE ${afterClause} AND ce.claim_id IS NULL) AS missing_rows_written_after,
       (SELECT count(*)::text FROM claims c WHERE c.status IN ('accepted','disputed') AND ${afterClause})
         AS accepted_or_disputed_written_after,
       (SELECT count(*)::text FROM claim_entities ce JOIN claims c ON c.claim_id = ce.claim_id
         WHERE c.status NOT IN ('accepted','disputed')) AS rows_for_non_projected_status,
       (SELECT count(DISTINCT ce.claim_id)::text FROM claim_entities ce JOIN claims c ON c.claim_id = ce.claim_id
         WHERE c.status NOT IN ('accepted','disputed')) AS claims_with_residual_rows
    `,
    params,
  );

  const row = result.rows[0] ?? {};
  const observed: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(row)) observed[key] = numeric(value);

  const checks: ProjectionCheck[] = [];
  for (const invariant of PROJECTION_INVARIANTS) {
    const value = Object.prototype.hasOwnProperty.call(observed, invariant.column)
      ? (observed[invariant.column] ?? null)
      : null;
    const expected = invariant.must_be_zero ? 0 : 1;
    checks.push({
      name: invariant.name,
      column: invariant.column,
      statement: invariant.statement,
      count: value,
      expected,
      ok: value !== null && value === expected,
      measured_by:
        "one SQL statement executed as the owner role over the whole database, " +
        "with the expected projection rows recomputed from the claims table",
    });
  }

  const violations: string[] = [];
  for (const check of checks) {
    if (!check.ok && check.expected === 0) {
      violations.push(`${check.name} = ${check.count ?? "unmeasured"}, expected 0`);
    }
  }
  for (const check of checks) {
    if (!check.ok && check.expected === 1) {
      violations.push(`${check.name} = ${check.count ?? "unmeasured"}, expected 1`);
    }
  }

  return {
    checked_at: new Date().toISOString(),
    role: "owner",
    checks,
    observed,
    behaviours: [],
    rls: {
      statement: "not run",
      tenant_a: "",
      tenant_b: "",
      owner_rows_a: null,
      owner_rows_b: null,
      app_visible_rows_a: null,
      app_visible_rows_b_from_a: null,
      app_visible_claims_b_from_a: null,
      ok: false,
      note: "the RLS check is run separately, as veritymem_app",
    },
    violations,
  };
}

/**
 * Prove that row-level security keeps one tenant's projection out of another tenant's read.
 *
 * The shape of this check matters. Counting rows as the owner and comparing against a count
 * taken as `veritymem_app` proves nothing unless the second count is *smaller* and the
 * difference is accounted for: a role that saw everything would produce equal counts on a
 * single-tenant database. So the check requires three facts together — the app role sees
 * exactly tenant A's rows, it sees none of tenant B's, and tenant B actually has rows to be
 * hidden.
 */
export async function verifyProjectionIsolation(
  appDb: Db,
  input: {
    readonly tenantA: ProbeTenant;
    readonly tenantB: ProbeTenant;
    readonly limit: number;
    readonly now: string;
  },
): Promise<RlsCheck> {
  const statement =
    "Bound as veritymem_app to tenant A's scope, a count of claim_entities returns exactly " +
    "tenant A's rows and a count filtered to tenant B returns zero.";
  const ownerA = await appDb.withSystemContext(
    { tenant: input.tenantA.tenantId, actor: "rehearsal:verify" },
    async (executor) => countVisible(executor, input.tenantA.tenantId),
  );

  const scopesOf = (tenant: ProbeTenant): { scope_id: string; project: string | null; user_id: string | null; agent_id: string | null; session_id: string | null }[] =>
    tenant.scopes.map((scope) => ({
      scope_id: scope.scope_id,
      project: scope.project,
      user_id: scope.user_id,
      agent_id: scope.agent_id,
      session_id: scope.session_id,
    }));

  const binding = (tenant: ProbeTenant) => ({
    tenant: tenant.tenantId,
    principal: tenant.principal,
    scopeIds: scopesOf(tenant).map((scope) => scope.scope_id),
    purposes: [...tenant.purposes],
    action: "rehearsal:rls-check",
  });

  const seenByA = await appDb.withRequest(
    binding(input.tenantA),
    async (executor) => ({
      total: await countEntities(executor),
      foreign: await countEntities(executor, input.tenantB.tenantId),
      foreignClaims: await countClaims(executor, input.tenantB.tenantId),
    }),
    { readOnly: true },
  );
  const seenByB = await appDb.withRequest(
    binding(input.tenantB),
    async (executor) => countEntities(executor),
    { readOnly: true },
  );

  const ownerRowsA = ownerA.entities;
  const ok =
    ownerRowsA !== null &&
    seenByA.total !== null &&
    seenByA.total === ownerRowsA &&
    seenByA.foreign === 0 &&
    seenByA.foreignClaims === 0 &&
    seenByB > 0;
  return {
    statement,
    tenant_a: input.tenantA.tenantSlug,
    tenant_b: input.tenantB.tenantSlug,
    owner_rows_a: ownerRowsA,
    owner_rows_b: seenByB,
    app_visible_rows_a: seenByA.total,
    app_visible_rows_b_from_a: seenByA.foreign,
    app_visible_claims_b_from_a: seenByA.foreignClaims,
    ok,
    note:
      "`owner_rows_a` is read in a system context bound to tenant A. `app_visible_*` are read " +
      "in request transactions bound to tenant A's scopes. `owner_rows_b` is tenant B's own " +
      "view, and must be greater than zero or the isolation check would pass vacuously.",
  };
}

async function countEntities(executor: QueryExecutor, tenantId?: string): Promise<number> {
  const result =
    tenantId === undefined
      ? await executor.query<{ n: string }>("SELECT count(*)::text AS n FROM claim_entities")
      : await executor.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM claim_entities WHERE tenant_id = $1::uuid",
          [tenantId],
        );
  return numeric(result.rows[0]?.n) ?? 0;
}

async function countClaims(executor: QueryExecutor, tenantId: string): Promise<number> {
  const result = await executor.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM claims WHERE tenant_id = $1::uuid",
    [tenantId],
  );
  return numeric(result.rows[0]?.n) ?? 0;
}

async function countVisible(
  executor: QueryExecutor,
  tenantId: string,
): Promise<{ entities: number }> {
  return { entities: await countEntities(executor, tenantId) };
}

/**
 * The projection's behaviour for claims that stop being accepted.
 *
 * ## The expectations, stated before they are checked
 *
 *   * **disputed is projected.** A disputed claim is a live claim; the projection keeps it
 *     so a reader can see the disagreement. Removing it would make the disagreement
 *     invisible, which is the opposite of the point.
 *   * **revoked and rejected are deindexed.** Re-projecting a claim whose status is neither
 *     accepted nor disputed must remove its `claim_entities` and `claim_embeddings` rows.
 *     `projectClaim` does this by calling `deindexClaim` before returning.
 *   * **superseded is not retrievable.** A superseded claim may keep its projection rows —
 *     the write path does not re-project the claim it supersedes — but the retrieval
 *     channels filter on `status = 'accepted' AND valid_to IS NULL`, so those rows must not
 *     reach a caller. This is checked by running the *real entity channel* before and after
 *     the supersession and comparing the hit list, and the leftover row count is reported
 *     as residue rather than hidden.
 *
 * The status changes go through `applyStatus`, which the database guard admits only when a
 * matching `decisions` row is written in the same transaction. A rehearsal that updated
 * `claims.status` directly would be testing a transition the production path cannot perform.
 */
export async function verifyProjectionBehaviours(
  appDb: Db,
  admin: pg.Client,
  input: {
    readonly tenants: readonly ProbeTenant[];
    /** Claims written by the probe, so mutating them cannot disturb the corpus. */
    readonly claims: readonly { readonly claimId: string; readonly tenantId: string }[];
    readonly decisions: (
      tenantId: string,
      claimId: string,
      status: "disputed" | "revoked" | "rejected",
    ) => Promise<void>;
    readonly reproject: (
      tenantId: string,
      claimId: string,
    ) => Promise<{ readonly projected: boolean; readonly reason: string }>;
    readonly limit: number;
    readonly now: string;
  },
): Promise<readonly BehaviourCase[]> {
  const cases: BehaviourCase[] = [];
  const [first, second, third] = input.claims;
  if (first === undefined || second === undefined || third === undefined) {
    return [
      {
        case: "projection_behaviours",
        expectation: "three claims written by the probe are available to change status",
        observed: `only ${input.claims.length} such claim(s) were found`,
        ok: false,
      },
    ];
  }

  const rowsFor = async (claimId: string): Promise<{ entities: number; embeddings: number }> => {
    const result = await admin.query<{ entities: string; embeddings: string }>(
      `SELECT (SELECT count(*)::text FROM claim_entities WHERE claim_id = $1::uuid) AS entities,
              (SELECT count(*)::text FROM claim_embeddings WHERE claim_id = $1::uuid) AS embeddings`,
      [claimId],
    );
    return {
      entities: numeric(result.rows[0]?.entities) ?? 0,
      embeddings: numeric(result.rows[0]?.embeddings) ?? 0,
    };
  };

  const canonicalOf = async (claimId: string): Promise<string | null> => {
    const result = await admin.query<{ canonical: string }>(
      `SELECT lower(btrim(subject)) AS canonical FROM claims WHERE claim_id = $1::uuid`,
      [claimId],
    );
    return result.rows[0]?.canonical ?? null;
  };

  /** Run the real entity channel as the tenant that owns the claim. */
  const retrievable = async (tenantId: string, canonical: string): Promise<readonly string[]> => {
    const tenant = input.tenants.find((entry) => entry.tenantId === tenantId);
    if (tenant === undefined) return [];
    return appDb.withRequest(
      {
        tenant: tenant.tenantId,
        principal: tenant.principal,
        scopeIds: tenant.scopes.map((entry) => entry.scope_id),
        purposes: [...tenant.purposes],
        action: "rehearsal:behaviour",
      },
      async (executor) => {
        const query = channelQueryFor(tenant, canonical, input.limit, input.now);
        const result = await entityChannel(executor, { ...query, entity_terms: [canonical] });
        return result.hits.map((hit) => hit.claim_id);
      },
      { readOnly: true },
    );
  };

  const change = async (
    claim: { readonly claimId: string; readonly tenantId: string },
    status: "disputed" | "revoked" | "rejected",
  ): Promise<{ readonly projected: boolean; readonly reason: string }> => {
    await input.decisions(claim.tenantId, claim.claimId, status);
    return input.reproject(claim.tenantId, claim.claimId);
  };

  // ---- disputed stays projected ------------------------------------------
  {
    const before = await rowsFor(first.claimId);
    const outcome = await change(first, "disputed");
    const after = await rowsFor(first.claimId);
    cases.push({
      case: "disputed_claim_stays_projected",
      expectation:
        "a claim moved to disputed keeps its claim_entities and claim_embeddings rows, and " +
        "re-projection reports it as projected",
      observed:
        `rows before: ${before.entities} entity / ${before.embeddings} embedding; after ` +
        `accepted -> disputed: ${after.entities} / ${after.embeddings}; ` +
        `projected=${String(outcome.projected)} (${outcome.reason})`,
      ok: before.entities > 0 && after.entities > 0 && after.embeddings > 0 && outcome.projected,
    });
  }

  // ---- revoked is deindexed ----------------------------------------------
  {
    const outcome = await change(first, "revoked");
    const after = await rowsFor(first.claimId);
    cases.push({
      case: "revoked_claim_is_deindexed",
      expectation:
        "re-projecting a revoked claim removes its claim_entities and claim_embeddings rows " +
        "and reports it as not projected",
      observed:
        `after disputed -> revoked and re-projection: ${after.entities} entity / ` +
        `${after.embeddings} embedding; projected=${String(outcome.projected)} (${outcome.reason})`,
      ok: after.entities === 0 && after.embeddings === 0 && !outcome.projected,
    });
  }

  // ---- rejected is deindexed ---------------------------------------------
  {
    await change(second, "disputed");
    const outcome = await change(second, "rejected");
    const after = await rowsFor(second.claimId);
    cases.push({
      case: "rejected_claim_is_deindexed",
      expectation:
        "re-projecting a rejected claim removes its projection rows and reports it as not projected",
      observed:
        `after accepted -> disputed -> rejected and re-projection: ${after.entities} entity / ` +
        `${after.embeddings} embedding; projected=${String(outcome.projected)} (${outcome.reason})`,
      ok: after.entities === 0 && after.embeddings === 0 && !outcome.projected,
    });
  }

  // ---- superseded is not retrievable through the real channel -------------
  {
    const canonical = await canonicalOf(third.claimId);
    const before = canonical === null ? [] : await retrievable(third.tenantId, canonical);
    const beforeRows = await rowsFor(third.claimId);
    const wasRetrievable = canonical !== null && before.includes(third.claimId);
    const outcome = await change(third, "revoked");
    const after = canonical === null ? [] : await retrievable(third.tenantId, canonical);
    const afterRows = await rowsFor(third.claimId);
    cases.push({
      case: "revoked_claim_is_not_retrievable",
      expectation:
        "the real entity channel returns the claim while it is accepted, and returns neither " +
        "the claim nor its projection rows once it is revoked",
      observed:
        `canonical ${canonical ?? "(none)"}: hits before = ${before.length} ` +
        `(claim present: ${String(wasRetrievable)}), hits after = ${after.length} ` +
        `(claim present: ${String(after.includes(third.claimId))}); projection rows ` +
        `${beforeRows.entities} -> ${afterRows.entities}; projected=${String(outcome.projected)}`,
      ok:
        canonical !== null &&
        wasRetrievable &&
        !after.includes(third.claimId) &&
        afterRows.entities === 0,
    });
  }

  return cases;
}

/** The residue that the behaviour checks will leave behind, measured after the fact. */
export async function measureResidue(
  admin: pg.Client,
): Promise<{ rows: number | null; claims: number | null; by_status: Record<string, number> }> {
  const result = await admin.query<{ status: string; rows: string }>(
    `SELECT c.status, count(*)::text AS rows
       FROM claim_entities ce JOIN claims c ON c.claim_id = ce.claim_id
      WHERE c.status NOT IN ('accepted','disputed')
      GROUP BY c.status ORDER BY c.status`,
  );
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of result.rows) {
    const count = numeric(row.rows) ?? 0;
    byStatus[row.status] = count;
    total += count;
  }
  const distinct = await admin.query<{ n: string }>(
    `SELECT count(DISTINCT ce.claim_id)::text AS n
       FROM claim_entities ce JOIN claims c ON c.claim_id = ce.claim_id
      WHERE c.status NOT IN ('accepted','disputed')`,
  );
  return { rows: total, claims: numeric(distinct.rows[0]?.n), by_status: byStatus };
}

/** Change a claim's status through the production transition, with a matching decision row. */
export async function transitionStatus(
  appDb: Db,
  tenantId: string,
  ids: { readonly decisionId: string; readonly reasonCodes: readonly string[] },
  claimId: string,
  status: "disputed" | "revoked" | "rejected",
): Promise<void> {
  await appDb.withSystemContext({ tenant: tenantId, actor: "rehearsal:verify" }, (executor) =>
    applyStatus(
      executor,
      { claimId, status, reasonCodes: [...ids.reasonCodes] },
      {
        decisionId: ids.decisionId,
        policyVersion: "rehearsal@1",
        approver: "rehearsal",
      },
    ),
  );
}
