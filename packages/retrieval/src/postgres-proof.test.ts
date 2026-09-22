/**
 * VM-A1: the merged latency hardening proved against a real PostgreSQL database.
 *
 * Migrations 0014 and 0015 changed two things that a unit test cannot check, because both
 * are properties of PostgreSQL rather than of TypeScript:
 *
 *   * **0014** replaced a correlated, per-row reach computation with a closure computed
 *     once when the request context is bound, stored in a transaction-local GUC, and read
 *     back by the RLS predicate as an array membership test. "Same answer, less work" is a
 *     claim about a *rule*, so it has to be checked against the previous rule on the same
 *     data — not asserted in a comment.
 *   * **0015** replaced the entity channel's dictionary join, which matched
 *     `canonical = subject OR canonical = lower(object::text)` and could drive a
 *     tenant-wide scan, with a `claim_entities` projection keyed
 *     `(tenant_id, canonical, claim_id)`. "Same authorized claim ids" is again a claim
 *     about data, and `jsonb::text` and `object #>> '{}'` do not agree on non-strings.
 *
 * Everything here runs against the real database. The authorization cases run as
 * **`veritymem_app`**, the non-superuser, non-BYPASSRLS role a deployment uses, because an
 * RLS property proved as the owner proves nothing: the owner is exempt from the policies
 * being tested.
 *
 * ## The one place the two rules deliberately disagree
 *
 * The previous reach expression asked whether *either* side left a dimension unbound:
 *
 *     (outer.project IS NULL OR inner.project IS NULL OR outer.project = inner.project)
 *
 * `scope_contains`, the rule the RLS policy has always used, asks whether the **caller**
 * left it unbound:
 *
 *     (outer.project IS NULL OR outer.project = inner.project)
 *
 * The difference is the case "caller bound, row unbound": the old expression reached it,
 * the directional rule does not. That is not a regression to be smoothed over — it is the
 * widening bug this repository has fixed once before, where a caller bound to one user
 * could reach a record that binds no user at all. The divergence is asserted explicitly in
 * "the precomputed closure follows the directional rule, not the old two-sided one" so that
 * the next reader cannot mistake it for an oversight.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { resolveTenantId } from "@veritymem/ledger";
import { env } from "@veritymem/testkit";
import { entityChannel, type ChannelQuery } from "./channels.ts";

const { Client } = pg;

const REASON = "release_planning";
const OTHER_REASON = "hr_review";
const PURPOSE = ["release_planning"];

/** The migration/owner connection. Setup and privileged assertions only. */
function ownerUrl(): string {
  const url = env.migrationDatabaseUrl;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is required for the VM-A1 proof");
  return url;
}

interface ScopeIds {
  readonly tenant: string;
  readonly tenantSlug: string;
  readonly project: string;
  readonly alice: string;
  readonly bob: string;
  readonly foreignTenant: string;
  readonly foreignTenantSlug: string;
  readonly foreignScope: string;
  /**
   * The claim in tenant B that carries the same alias as tenant A's claims.
   *
   * Stored explicitly rather than looked up later, because the case that matters is "each
   * tenant sees its own row and not the other's". A negative-only assertion — tenant A does
   * not see B's claim — passes just as well when *neither* tenant can see anything, so both
   * directions are asserted and both ids have to be known.
   */
  readonly foreignClaim: string;
  /** A claim carrying the same alias but closed by supersession, not revoked. */
  readonly supersededClaim: string;
  readonly otherPurposeScope: string;
  /**
   * A scope that binds a user but no project.
   *
   * It exists to reach the one case where the old and new reach rules deliberately
   * disagree. `scopes_must_bind_something` forbids a scope that binds *nothing*, so the
   * divergence cannot be demonstrated with an entirely unbound row; a row that leaves the
   * *project* unbound while the caller binds one exercises the same branch.
   */
  readonly userOnly: string;
  /** A claim id known to exist in this tenant, for targeted unbound-read probes. */
  readonly knownClaim: string;
}

let ids: ScopeIds;

async function connect(url: string): Promise<pg.Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

/**
 * Bind a request context, exactly as `Db.withRequest` does.
 *
 * `set_request_context` computes the reachable closure and writes it to a
 * transaction-local GUC, which is the behaviour under test; calling it here rather than
 * going through `Db.withRequest` keeps the assertion about the *function* rather than
 * about the pool.
 */
async function bind(
  client: pg.Client,
  binding: { tenant: string; principal: string; scopes: readonly string[]; purposes: readonly string[]; action?: string },
): Promise<void> {
  await client.query("BEGIN");
  // Arrays go over as JavaScript arrays and are cast by the statement, exactly as
  // `Db.withRequest` does it. Hand-formatting a `{a,b}` literal made PostgreSQL resolve
  // an untyped string against the wrong placeholder use.
  await client.query("SELECT veritymem.set_request_context($1::uuid,$2,$3::uuid[],$4::text[],$5)", [
    binding.tenant,
    binding.principal,
    [...binding.scopes],
    [...binding.purposes],
    binding.action ?? "read",
  ]);
}

async function unbind(client: pg.Client): Promise<void> {
  await client.query("ROLLBACK");
}

/**
 * Seed the golden corpus: four scopes, and claims covering every object shape the two
 * entity queries treat differently.
 *
 * Written directly rather than through the commit gate. The gate's job is to decide what
 * becomes a claim, and it is already covered elsewhere; what these cases need is a *fixed*
 * population so the two queries can be compared on known data. `status` is set explicitly
 * because the difference between `accepted` and `revoked` is one of the cases.
 */
async function seed(): Promise<void> {
  const client = await connect(ownerUrl());
  const tenant = resolveTenantId(`vm-a1-${randomUUID().slice(0, 8)}`);
  const foreignTenant = resolveTenantId(`vm-a1-foreign-${randomUUID().slice(0, 8)}`);
  const tenantSlug = `vm-a1-${tenant.slice(0, 8)}`;
  ids = {
    tenant,
    tenantSlug,
    project: randomUUID(),
    alice: randomUUID(),
    bob: randomUUID(),
    foreignTenant,
    foreignScope: randomUUID(),
    otherPurposeScope: randomUUID(),
    userOnly: randomUUID(),
    knownClaim: randomUUID(),
    foreignTenantSlug: `${tenantSlug}-foreign`,
    foreignClaim: randomUUID(),
    supersededClaim: randomUUID(),
  };

  try {
    await client.query(
      `INSERT INTO tenants (tenant_id, slug, name) VALUES ($1::uuid,$2,$2), ($3::uuid,$4,$4)`,
      [tenant, tenantSlug, foreignTenant, `${tenantSlug}-foreign`],
    );
    // Both tenants declare the SAME alias (`acme`), which is what makes the tenant
    // predicate load-bearing rather than incidental: without it the alias matches twice.
    await client.query(
      `INSERT INTO scopes (scope_id, tenant_id, project, user_id, purpose) VALUES
         ($1::uuid,$2::uuid,'payments',NULL,      ARRAY[$3]),
         ($4::uuid,$2::uuid,'payments','alice',   ARRAY[$3]),
         ($5::uuid,$2::uuid,'payments','bob',     ARRAY[$3]),
         ($6::uuid,$2::uuid,'payments',NULL,      ARRAY[$7]),
         ($8::uuid,$2::uuid,NULL,      'alice',   ARRAY[$3]),
         ($9::uuid,$10::uuid,'payments',NULL,     ARRAY[$3])`,
      [
        ids.project,
        tenant,
        REASON,
        ids.alice,
        ids.bob,
        ids.otherPurposeScope,
        OTHER_REASON,
        ids.userOnly,
        ids.foreignScope,
        foreignTenant,
      ],
    );

    interface Row {
      readonly scope: string;
      readonly subject: string;
      readonly object: string;
      readonly status: string;
      readonly tenantId: string;
    }
    const rows: Row[] = [
      // --- entity cases -------------------------------------------------------
      // A subject string: `user:alice` lowercases and trims to the alias `user:alice`.
      { scope: ids.alice, subject: "user:alice", object: '"acme"', status: "accepted", tenantId: tenant },
      // A scalar JSON string object: `#>> '{}'` yields `acme`, `::text` yields `"acme"`.
      { scope: ids.alice, subject: "user:carol", object: '"acme"', status: "accepted", tenantId: tenant },
      // A NON-string object. `object::text` is `{"a":1}`; `#>> '{}'` is NULL. The new
      // projection deliberately carries no row for it.
      { scope: ids.alice, subject: "user:dave", object: '{"a":1}', status: "accepted", tenantId: tenant },
      // A JSON number: `::text` is `7`, `#>> '{}'` is `7`. Both agree, so this row is
      // present in neither projection's canonical set for the alias `acme`.
      { scope: ids.alice, subject: "user:erin", object: "7", status: "accepted", tenantId: tenant },
      // A revoked claim in a reachable scope. Must be excluded by the temporal clause.
      { scope: ids.alice, subject: "user:frank", object: '"acme"', status: "revoked", tenantId: tenant },
      // A superseded claim with the same alias: a different exclusion mechanism from
      // `revoked` (the temporal clause closes it) and the one the entity channel meets most
      // often in practice, since every corrected fact passes through it.
      { scope: ids.alice, subject: "user:superseded", object: '"acme"', status: "superseded", tenantId: tenant },
      // A claim in a scope this tenant may not read at all.
      { scope: ids.bob, subject: "user:grace", object: '"acme"', status: "accepted", tenantId: tenant },
      // A claim admitted for a different purpose.
      { scope: ids.otherPurposeScope, subject: "user:heidi", object: '"acme"', status: "accepted", tenantId: tenant },
      // The same alias in another tenant: proves the tenant predicate.
      { scope: ids.foreignScope, subject: "user:ivan", object: '"acme"', status: "accepted", tenantId: foreignTenant },
      // --- reach cases --------------------------------------------------------
      { scope: ids.project, subject: "user:project-wide", object: '"projectrow"', status: "accepted", tenantId: tenant },
      { scope: ids.userOnly, subject: "user:useronly", object: '"useronlyrow"', status: "accepted", tenantId: tenant },
    ];

    let firstClaim = true;
    for (const row of rows) {
      const claimId =
        firstClaim
          ? ids.knownClaim
          : row.tenantId === foreignTenant
            ? ids.foreignClaim
            : row.status === "superseded"
              ? ids.supersededClaim
              : randomUUID();
      firstClaim = false;
      // The exact positive set for the alias `acme`: accepted, in this tenant, in a scope
      // tenant A reaches, and matching the alias through either the subject or the unquoted
      // object. The scope filter excludes `ids.bob` (a sibling user scope) and the
      // other-purpose scope; the status excludes revoked and superseded; the alias match
      // excludes `useronlyrow`, whose object is a different scalar.
      //
      // Derived from the same expressions the projection uses, so the set is a statement
      // about the corpus rather than a hand-list that drifts when a row is added.
      // `valid_to` is set to a strictly later instant for a revoked claim, never to
      // `now()` in the same statement: `valid_range` is generated from the pair, and a
      // closed interval whose bounds are equal is refused by `claims_check` rather than
      // stored. This repository has been bitten by exactly that, so the fixture respects
      // the constraint instead of routing around it.
      await client.query(
        `INSERT INTO claims (claim_id, tenant_id, scope_id, kind, subject, predicate, object, status,
                             authority, valid_from, valid_to, recorded_at, extractor, model_version, prompt_version)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'observation',$4,'alias',$5::jsonb,$6::claim_status,
                 'user_self_report', now(),
                 CASE WHEN $6 = 'revoked' THEN now() + interval '1 second' ELSE NULL END,
                 now(), 'vm-a1-fixture','fixture@1','fixture@1')`,
        [claimId, row.tenantId, row.scope, row.subject, row.object, row.status],
      );
      // The alias dictionary, written explicitly rather than derived.
      //
      // `entity_aliases` is (alias -> canonical). `alias` is what a query term matches;
      // `canonical` is what the claim side is compared against. The pre-0015 channel
      // compared `canonical` to `lower(btrim(subject))` **or** `lower(btrim(object::text))`,
      // and for a JSON string `object::text` keeps its quotes — so the canonical the object
      // branch needs is `"acme"`, quotes included, while the projection (0015) stores the
      // unquoted `acme` from `object #>> '{}'`.
      //
      // That difference is the compatibility claim under test: the two queries use
      // different canonical strings and must still return the same claims. The first
      // version of this seed derived the pair through helper functions and silently wrote
      // `acme -> acme`, under which *both* queries returned nothing and the equivalence
      // assertion passed on two empty sets.
      for (const [alias, canonical] of [
        ["acme", "acme"],
        ["acme", '"acme"'],
        [row.subject.toLowerCase(), row.subject.toLowerCase()],
      ] as const) {
        await client.query(
          `INSERT INTO entity_aliases (tenant_id, alias, canonical, source, confidence)
           VALUES ($1::uuid,$2,$3,'vm_a1_fixture',1.0)
           ON CONFLICT (tenant_id, alias, canonical) DO NOTHING`,
          [row.tenantId, alias, canonical],
        );
      }

      // Mirror what migration 0015's backfill produces, from the same expression, so the
      // comparison is between the two *queries* and not between a query and a fixture.
      await client.query(
        `INSERT INTO claim_entities (tenant_id, canonical, claim_id, source, confidence)
         SELECT $2::uuid, lower(btrim(subject)), claim_id, 'vm_a1_fixture', 1.0
           FROM claims WHERE claim_id = $1::uuid AND status IN ('accepted','disputed') AND btrim(subject) <> ''`,
        [claimId, row.tenantId],
      );
      await client.query(
        `INSERT INTO claim_entities (tenant_id, canonical, claim_id, source, confidence)
         SELECT $2::uuid, lower(btrim(object #>> '{}')), claim_id, 'vm_a1_fixture', 1.0
           FROM claims
          WHERE claim_id = $1::uuid AND status IN ('accepted','disputed')
            AND jsonb_typeof(object) = 'string' AND btrim(object #>> '{}') <> ''
            AND length(object #>> '{}') <= 200
            AND lower(btrim(object #>> '{}')) <> lower(btrim(subject))`,
        [claimId, row.tenantId],
      );
    }
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// The two reach expressions, side by side
// ---------------------------------------------------------------------------

/**
 * Parameter convention for the entity query, which is the frame the reach fragments below
 * are spliced into:
 *
 *     $1 = tenant   $2 = the caller's held scopes   $3 = entity terms   $4 = purposes
 *
 * The arguments passed at the call site must come in that order. The first version of this
 * file used the channel's older convention (`$1` tenant, `$2` scopes, `$3` purposes) while
 * the SQL referenced `$3` for terms, and PostgreSQL reported it as
 * `operator does not exist: uuid = uuid[]` — a type error a thousand lines from the cause.
 */

/**
 * The reach clause migration 0014 removed: correlated on the outer claim row, and
 * two-sided on each dimension.
 *
 * Written as `IN (subquery)` rather than `= ANY((SELECT array_agg(...)))`, which is the
 * form the pre-0014 channel emitted. Those two are equivalent in intent, but the `ANY`
 * form fails on this server with `operator does not exist: uuid = uuid[]` once the
 * subquery is correlated: `ANY` expects an array *expression*, and it resolves the
 * aggregate subquery's type in a way that loses the element type. `IN` takes a set and has
 * no such ambiguity, and this file is about the reach *rule* rather than about reproducing
 * a fragile spelling of it. Recorded because the failure message points at the parameter
 * binding, which is correct, rather than at the construct, which is not.
 */
const legacyReach = (heldScopes: readonly string[]): string => `c.scope_id IN (
  SELECT rs.scope_id
    FROM scopes rs
   WHERE rs.tenant_id = c.tenant_id
     AND EXISTS (
       SELECT 1
         FROM unnest('{${heldScopes.join(",")}}'::uuid[]) AS owned(scope_id)
         JOIN scopes os ON os.scope_id = owned.scope_id
        WHERE os.tenant_id = rs.tenant_id
          AND (os.project    IS NULL OR rs.project    IS NULL OR os.project    = rs.project)
          AND (os.user_id    IS NULL OR rs.user_id    IS NULL OR os.user_id    = rs.user_id)
          AND (os.agent_id   IS NULL OR rs.agent_id   IS NULL OR os.agent_id   = rs.agent_id)
          AND (os.session_id IS NULL OR rs.session_id IS NULL OR os.session_id = rs.session_id)
     )
)`;

/** The reach clause migration 0014 installed: one closure, computed at bind time. */
const precomputedReach = (): string => `c.scope_id = ANY(veritymem.current_reachable_scope_ids())`;

/**
 * `scope_contains`, applied directly — the rule the RLS policy has always used.
 *
 * Parameterised on the *row* scope rather than on a claims alias, so the same fragment can
 * be spliced into a query over `claims` and a query over `scopes`. The first version
 * hard-coded `c.scope_id` and failed with `missing FROM-clause entry for table "c"` when
 * used over `scopes` — a reminder that a shared SQL fragment has to name its inputs.
 */
const directionalReach = (rowScope: string, heldScopes: readonly string[]): string => `EXISTS (
  SELECT 1 FROM unnest('{${heldScopes.join(",")}}'::uuid[]) AS owned(scope_id)
   WHERE veritymem.scope_contains(owned.scope_id, ${rowScope})
)`;

/**
 * The entity query, parameterised by its reach clause.
 *
 * `legacy` reproduces the pre-0015 shape: a dictionary join whose canonical comparison is
 * `subject OR lower(object::text)`. `current` is the projection join the migration
 * installed. The two differ only in the `FROM`/`WHERE` that finds candidate claims, which
 * is the whole point of the migration.
 */
function entityQuery(reach: string, variant: "legacy" | "current"): string {
  const candidate =
    variant === "legacy"
      ? `FROM entity_aliases a
           JOIN claims c ON c.tenant_id = a.tenant_id
                        AND (a.canonical = lower(btrim(c.subject))
                             OR a.canonical = lower(btrim(c.object::text)))`
      : `FROM entity_aliases a
           JOIN claim_entities ce ON ce.tenant_id = a.tenant_id AND ce.canonical = a.canonical
           JOIN claims c ON c.claim_id = ce.claim_id AND c.tenant_id = ce.tenant_id`;
  return `
    SELECT c.claim_id, count(DISTINCT a.alias)::float8 AS score
      ${candidate}
      JOIN scopes s ON s.scope_id = c.scope_id
     WHERE a.tenant_id = $1::uuid
       AND a.alias = ANY($2::text[])
       AND c.tenant_id = $1::uuid
       AND ${reach}
       AND s.purpose && $3::text[]
       AND c.valid_to IS NULL AND c.status = 'accepted'
     GROUP BY c.claim_id
     ORDER BY score DESC, c.claim_id ASC
     LIMIT 12`;
}

/**
 * A request binding, named explicitly.
 *
 * `tenant` is a parameter rather than an implicit `ids.tenant`. The two-tenant alias case
 * has to run the *same* query against tenant A and tenant B and compare, and a helper that
 * closes over one tenant cannot express that — which is exactly why the first version of
 * that case could only assert what tenant A did not see.
 */
interface EntityBinding {
  readonly tenant: string;
  readonly principal: string;
  readonly scopes: readonly string[];
  readonly purposes: readonly string[];
  readonly terms: readonly string[];
}

/** Run one query variant as the application role, inside a bound request context. */
async function runEntityQuery(
  client: pg.Client,
  binding: EntityBinding,
  reach: (heldScopes: readonly string[]) => string,
  variant: "legacy" | "current",
): Promise<string[]> {
  await bind(client, {
    tenant: binding.tenant,
    principal: binding.principal,
    scopes: binding.scopes,
    purposes: binding.purposes,
  });
  try {
    // `$1` tenant, `$2` entity terms, `$3` purposes — matching the SQL above. The caller's
    // held scopes are not a parameter: the reach fragment inlines them as a cast literal,
    // and a placeholder that nothing references is exactly what produced
    // `could not determine data type of parameter $2` while this was being written.
    const result = await client.query<{ claim_id: string }>(entityQuery(reach(binding.scopes), variant), [
      binding.tenant,
      [...binding.terms],
      [...binding.purposes],
    ]);
    return result.rows.map((row) => row.claim_id).sort();
  } finally {
    await unbind(client);
  }
}

/**
 * The channel's own answer, through the real code path.
 *
 * Tenant and principal come from the binding, so the same helper can be pointed at either
 * tenant. Nothing about the tenant is hardcoded here.
 */
async function runEntityChannel(client: pg.Client, binding: EntityBinding): Promise<string[]> {
  await bind(client, {
    tenant: binding.tenant,
    principal: binding.principal,
    scopes: binding.scopes,
    purposes: binding.purposes,
  });
  try {
    const executor = {
      async query<R>(text: string, params: readonly unknown[] = []) {
        const result = await client.query(text, params as unknown[]);
        return { rows: result.rows as R[], rowCount: result.rowCount };
      },
    };
    const query: ChannelQuery = {
      tenant_id: binding.tenant,
      text: binding.terms.join(" "),
      authorized_scopes: [],
      purposes: binding.purposes,
      time: { mode: "current" },
      kinds: null,
      subjects: null,
      entity_terms: binding.terms,
      limit: 12,
      now: "2026-09-21T00:00:00.000Z",
    };
    const result = await entityChannel(executor, query);
    return result.hits.map((hit) => hit.claim_id).sort();
  } finally {
    await unbind(client);
  }
}

/**
 * The tenant-A binding used by most entity cases.
 *
 * Holds the project scope *and* the project-unbound user scope, because those are the two
 * on which the old two-sided reach rule and the directional rule agree — so a difference in
 * the result is a difference in the entity query rather than in reach.
 */
function bindingInA(terms: readonly string[]): EntityBinding {
  return {
    tenant: ids.tenant,
    principal: "user:probe",
    scopes: [ids.project, ids.userOnly],
    purposes: PURPOSE,
    terms: [...terms],
  };
}

/** The closure the database computed for a binding, straight out of the GUC. */
async function closureFor(
  client: pg.Client,
  binding: { scopes: readonly string[]; purposes: readonly string[]; system?: boolean },
): Promise<string[]> {
  if (binding.system) {
    await client.query("BEGIN");
    await client.query("SELECT veritymem.set_system_context($1::uuid,$2)", [ids.tenant, "probe"]);
  } else {
    await bind(client, {
      tenant: ids.tenant,
      principal: "user:probe",
      scopes: binding.scopes,
      purposes: binding.purposes,
    });
  }
  try {
    const result = await client.query<{ ids: string[] }>(
      "SELECT veritymem.current_reachable_scope_ids() AS ids",
    );
    return [...(result.rows[0]?.ids ?? [])].sort();
  } finally {
    await unbind(client);
  }
}

describe("VM-A1 · precomputed scope reach (0014)", () => {
  let app: pg.Client;
  let owner: pg.Client;

  before(async () => {
    await seed();
    app = await connect(env.databaseUrl!);
    owner = await connect(ownerUrl());
  });
  after(async () => {
    await app?.end();
    await owner?.end();
  });

  it("runs every authorization case as veritymem_app, which cannot bypass RLS", async () => {
    const identity = await app.query<{ role: string; superuser: boolean; bypassrls: boolean }>(
      `SELECT current_user AS role, rolsuper AS superuser, rolbypassrls AS bypassrls
         FROM pg_roles WHERE rolname = current_user`,
    );
    assert.equal(identity.rows[0]?.role, "veritymem_app", "the cases must run as the application role");
    assert.equal(identity.rows[0]?.superuser, false, "veritymem_app must not be a superuser");
    assert.equal(identity.rows[0]?.bypassrls, false, "veritymem_app must not have BYPASSRLS");
  });

  it("lets a project scope reach the user scopes inside it", async () => {
    const closure = await closureFor(app, { scopes: [ids.project], purposes: PURPOSE });
    assert.ok(closure.includes(ids.project), "the project scope itself must be reachable");
    assert.ok(closure.includes(ids.alice), "a project scope must reach its user scopes");
    assert.ok(closure.includes(ids.bob), "a project scope must reach every user scope in the project");
  });

  it("does not let a user scope widen to its project scope", async () => {
    const closure = await closureFor(app, { scopes: [ids.alice], purposes: PURPOSE });
    assert.deepEqual(closure, [ids.alice], "a user scope must reach itself and nothing wider");
    assert.ok(!closure.includes(ids.project), "a user scope must not widen to the project scope");
    assert.ok(!closure.includes(ids.bob), "a user scope must not reach a sibling user scope");
  });

  it("denies a claim admitted for a purpose the caller did not declare", async () => {
    const closure = await closureFor(app, { scopes: [ids.project], purposes: PURPOSE });
    assert.ok(
      !closure.includes(ids.otherPurposeScope),
      "a scope admitted only for another purpose must not be reachable",
    );
    const wrongPurpose = await closureFor(app, { scopes: [ids.project], purposes: [OTHER_REASON] });
    assert.ok(
      !wrongPurpose.includes(ids.alice),
      "declaring an unrelated purpose must not preserve the project's reach",
    );
    const none = await closureFor(app, { scopes: [ids.project], purposes: [] });
    assert.deepEqual(none, [], "an empty purpose set is the absence of authority, not a wildcard");
  });

  it("denies a scope belonging to another tenant", async () => {
    const closure = await closureFor(app, { scopes: [ids.project], purposes: PURPOSE });
    assert.ok(!closure.includes(ids.foreignScope), "reach must not cross a tenant boundary");
    const foreign = await closureFor(app, { scopes: [ids.foreignScope], purposes: PURPOSE });
    assert.deepEqual(foreign, [], "a scope in another tenant must reach nothing in this one");
  });

  it("keeps system context inside its own tenant", async () => {
    // The system context is a maintenance path: it reaches every scope in its tenant and
    // nothing outside it. A tenant-less system context is refused outright rather than
    // silently becoming a global one.
    await assert.rejects(
      () => owner.query("SELECT veritymem.set_system_context(NULL, 'probe')"),
      /there is no tenant-less system scope/,
      "a system context without a tenant must raise rather than default",
    );

    // The system context is authorized by the `system_context()` branch of
    // `row_authorized`, **not** by the precomputed closure: `set_system_context` sets the
    // closure empty on purpose, because a maintenance path reaches rows through the system
    // flag rather than through a scope list. Asserting on the closure here would be
    // asserting the wrong mechanism, so the predicate is what gets asserted.
    const closure = await closureFor(app, { scopes: [], purposes: [], system: true });
    assert.deepEqual(closure, [], "a system context carries no precomputed scope list by design");

    // And the predicate agrees: a row in this tenant is authorized, a row in another is not.
    await app.query("BEGIN");
    await app.query("SELECT veritymem.set_system_context($1::uuid,$2)", [ids.tenant, "probe"]);
    try {
      const mine = await app.query("SELECT veritymem.row_authorized($1::uuid,$2::uuid) AS ok", [
        ids.tenant,
        ids.alice,
      ]);
      assert.equal(mine.rows[0]?.ok, true, "system context must authorize a row in its own tenant");
      const foreign = await app.query("SELECT veritymem.row_authorized($1::uuid,$2::uuid) AS ok", [
        ids.foreignTenant,
        ids.foreignScope,
      ]);
      assert.equal(foreign.rows[0]?.ok, false, "system context must not authorize another tenant's row");
    } finally {
      await unbind(app);
    }
  });

  it("reads zero tenant rows on a connection with no request context bound", async () => {
    // No BEGIN, no set_request_context. The application role is subject to the policies, so
    // every tenant table must expose no row rather than raising or leaking.
    //
    // The assertion asks for specific rows rather than `count(*)`. A count has to scan the
    // whole table, and this database holds millions of claims, so under RLS the count form
    // took ~19 s and eventually exceeded its timeout — a scalability defect in the test
    // rather than in the code. A targeted read returns the same answer in constant time and
    // tests the property more directly: this exact row exists (the owner proves it below)
    // and the unbound application role cannot see it.
    const probes = [
      { table: "claims", column: "claim_id", value: ids.knownClaim },
      { table: "claim_entities", column: "claim_id", value: ids.knownClaim },
      { table: "entity_aliases", column: "tenant_id", value: ids.tenant },
    ] as const;
    for (const probe of probes) {
      const result = await app.query<{ found: boolean }>(
        `SELECT true AS found FROM ${probe.table} WHERE ${probe.column} = $1::uuid LIMIT 1`,
        [probe.value],
      );
      assert.equal(result.rows.length, 0, `${probe.table} must expose no row while unbound`);
    }
    // Positive control: the same targeted reads return a row for the owner, which is
    // exempt from the policies. Without this the refusals above would also be produced by
    // a fixture that inserted nothing.
    for (const probe of probes) {
      const result = await owner.query(
        `SELECT true AS found FROM ${probe.table} WHERE ${probe.column} = $1::uuid LIMIT 1`,
        [probe.value],
      );
      assert.equal(result.rows.length, 1, `the fixture must contain the row for ${probe.table}`);
    }
  });

  it("narrows the previous reach by exactly the two-sided rule's partial bindings", async () => {
    // Deliberately NOT an equality assertion, and the difference is the point.
    //
    // The old expression matched when *either* side left a dimension unbound; the
    // directional rule matches when the **caller** does. The new reach is therefore the old
    // reach minus the scopes that leave a dimension free while the caller binds it — the
    // widening this repository has already fixed once, and which must not return.
    //
    // Both rules are evaluated **by PostgreSQL**, over the same `scopes` rows, in one
    // query. Two earlier versions re-implemented the containment logic in TypeScript to
    // decide which scopes "should" diverge; each was wrong in a different way and failed on
    // a scope that was not actually divergent. A test whose oracle is a second, hand-written
    // copy of the rule under test cannot find a bug in that rule.
    for (const [label, scopes] of [
      ["project scope", [ids.project]],
      ["user scope", [ids.alice]],
      ["project, alice and user-only", [ids.project, ids.alice, ids.userOnly]],
    ] as const) {
      await bind(owner, { tenant: ids.tenant, principal: "probe", scopes: [...scopes], purposes: PURPOSE });
      try {
        const compared = await owner.query<{ scope_id: string; two_sided: boolean; directional: boolean }>(
          `SELECT s.scope_id,
                  EXISTS (
                    SELECT 1 FROM unnest($2::uuid[]) AS h(scope_id)
                      JOIN scopes ho ON ho.scope_id = h.scope_id
                     WHERE COALESCE(array_length(s.purpose,1),0) > 0
                       AND s.purpose && $3::text[]
                       AND (ho.project    IS NULL OR s.project    IS NULL OR ho.project    = s.project)
                       AND (ho.user_id    IS NULL OR s.user_id    IS NULL OR ho.user_id    = s.user_id)
                       AND (ho.agent_id   IS NULL OR s.agent_id   IS NULL OR ho.agent_id   = s.agent_id)
                       AND (ho.session_id IS NULL OR s.session_id IS NULL OR ho.session_id = s.session_id)
                  ) AS two_sided,
                  EXISTS (
                    SELECT 1 FROM unnest($2::uuid[]) AS h(scope_id)
                     WHERE COALESCE(array_length(s.purpose,1),0) > 0
                       AND s.purpose && $3::text[]
                       AND veritymem.scope_contains(h.scope_id, s.scope_id)
                  ) AS directional
             FROM scopes s
            WHERE s.tenant_id = $1::uuid`,
          [ids.tenant, [...scopes], [...PURPOSE]],
        );

        const legacySet = compared.rows.filter((r) => r.two_sided).map((r) => r.scope_id).sort();
        const directionalSet = compared.rows.filter((r) => r.directional).map((r) => r.scope_id).sort();
        const closure = [...((await owner.query<{ ids: string[] }>("SELECT veritymem.current_reachable_scope_ids() AS ids")).rows[0]?.ids ?? [])].sort();

        // The closure is exactly the scopes `scope_contains` admits. Asserting equality with
        // the SQL-computed directional set is stronger than checking a subset, and it is the
        // property that matters: the closure must not differ from the rule RLS enforces.
        assert.deepEqual(closure, directionalSet, `the closure must equal scope_contains for the ${label}`);

        // The narrowing is exactly the two-sided rule's extra scopes, computed by the
        // database rather than listed here.
        const onlyTwoSided = legacySet.filter((scope) => !directionalSet.includes(scope));
        const onlyDirectional = directionalSet.filter((scope) => !legacySet.includes(scope));
        assert.deepEqual(
          onlyDirectional,
          [],
          `the ${label} reached scopes the previous rule did not, which would be a widening`,
        );
        assert.deepEqual(
          closure.filter((scope) => !legacySet.includes(scope)),
          [],
          `the ${label} closure admitted a scope the previous rule rejected`,
        );
        // The corpus contains a partial binding, so the narrowing is exercised rather than
        // vacuous — but only where the caller actually binds a dimension those rows leave free.
        if (label === "project scope") {
          assert.ok(
            onlyTwoSided.length > 0,
            "the project-scope case must exercise the narrowing, or this proves nothing",
          );
        }
      } finally {
        await unbind(owner);
      }
    }
  });

  it("follows the directional rule, not the old two-sided one, for a bound caller", async () => {
    // The deliberate divergence, asserted rather than glossed.
    //
    // `ids.userOnly` binds `user_id = 'alice'` and no project. A caller holding
    // `ids.alice` — which binds `project = 'payments'` and `user_id = 'alice'` — is bound
    // on the project dimension. The *old* expression reached the user-only row anyway,
    // because it accepted "row dimension unbound" as a match for any caller. The
    // directional rule does not: a caller bound to a value does not reach a row that
    // leaves that dimension free.
    //
    // This is the widening bug this repository has already fixed once — the README's
    // "naming yourself narrows rather than widens" case. The new closure must reproduce
    // the fix, not the bug.
    await bind(owner, { tenant: ids.tenant, principal: "probe", scopes: [ids.alice], purposes: PURPOSE });
    try {
      const legacy = await owner.query<{ scope_id: string }>(
        `SELECT DISTINCT c.scope_id FROM claims c WHERE c.tenant_id = $1::uuid AND ${legacyReach([ids.alice])}`,
        [ids.tenant],
      );
      const legacyScopes = legacy.rows.map((r) => r.scope_id);
      assert.ok(
        legacyScopes.includes(ids.userOnly),
        "the old expression is expected to reach a project-unbound row; if it does not, this case no longer tests the divergence",
      );

      const closure = await closureFor(app, { scopes: [ids.alice], purposes: PURPOSE });
      assert.ok(
        !closure.includes(ids.userOnly),
        "a caller bound to a project must not reach a scope that binds no project",
      );
    } finally {
      await unbind(owner);
    }
  });

  it("agrees with scope_contains row by row, which is the rule RLS enforces", async () => {
    // `scope_contains` has always been the policy's rule. The closure is only correct if it
    // is exactly the set of scopes that rule admits — checked over every scope in the
    // tenant rather than a sample.
    for (const [label, scopes] of [
      ["project scope", [ids.project]],
      ["user scope", [ids.alice]],
      ["project and user", [ids.project, ids.alice]],
    ] as const) {
      await bind(owner, { tenant: ids.tenant, principal: "probe", scopes: [...scopes], purposes: PURPOSE });
      try {
        // Purposes are inlined for the same reason the scopes are: with a gap in the
        // placeholder numbering PostgreSQL cannot determine the type of `$2`, and the
        // failure surfaces as `could not determine data type of parameter $2`.
        const directional = await owner.query<{ scope_id: string }>(
          `SELECT s.scope_id FROM scopes s
            WHERE s.tenant_id = $1::uuid
              AND COALESCE(array_length(s.purpose,1),0) > 0
              AND s.purpose && '{${PURPOSE.join(",")}}'::text[]
              AND ${directionalReach("s.scope_id", scopes)}
            ORDER BY s.scope_id`,
          [ids.tenant],
        );
        const closure = await owner.query<{ ids: string[] }>(
          "SELECT veritymem.current_reachable_scope_ids() AS ids",
        );
        assert.deepEqual(
          [...(closure.rows[0]?.ids ?? [])].sort(),
          directional.rows.map((r) => r.scope_id).sort(),
          `the precomputed closure must equal scope_contains for the ${label}`,
        );
      } finally {
        await unbind(owner);
      }
    }
  });

  it("clears the reachable closure when the transaction ends, so a pooled connection cannot leak it", async () => {
    // The GUCs are written with `set_config(..., true)` — transaction-local. A pooled
    // connection that kept the previous caller's closure would hand the next request
    // another tenant's reach, which is the worst possible bug in this file. Roll back and
    // read the closure again on the same physical connection.
    await bind(app, { tenant: ids.tenant, principal: "probe", scopes: [ids.project], purposes: PURPOSE });
    const inside = await app.query<{ ids: string[] }>("SELECT veritymem.current_reachable_scope_ids() AS ids");
    assert.ok((inside.rows[0]?.ids ?? []).length > 0, "the binding must produce a non-empty closure");
    await unbind(app);

    const after = await app.query<{ ids: string[]; tenant: string | null }>(
      `SELECT veritymem.current_reachable_scope_ids() AS ids,
              NULLIF(current_setting('veritymem.tenant_id', true), '') AS tenant`,
    );
    assert.deepEqual(after.rows[0]?.ids ?? [], [], "the closure must not survive the transaction");
    assert.equal(after.rows[0]?.tenant, null, "the tenant binding must not survive the transaction");
  });

  it("commits the closure and discards it at commit, not only at rollback", async () => {
    await bind(app, { tenant: ids.tenant, principal: "probe", scopes: [ids.project], purposes: PURPOSE });
    await app.query("COMMIT");
    const after = await app.query<{ ids: string[] }>("SELECT veritymem.current_reachable_scope_ids() AS ids");
    assert.deepEqual(after.rows[0]?.ids ?? [], [], "the closure must not survive a commit either");
  });
});

describe("VM-A1 · claim entity projection (0015)", () => {
  let app: pg.Client;
  let owner: pg.Client;

  before(async () => {
    await seed();
    app = await connect(env.databaseUrl!);
    owner = await connect(ownerUrl());
  });
  after(async () => {
    await app?.end();
    await owner?.end();
  });

  it("is populated for every existing accepted claim, with no duplicates or orphans", async () => {
    const result = await owner.query<{ claims: string; covered: string; orphans: string; dupes: string }>(
      `SELECT
         (SELECT count(*)::text FROM claims WHERE tenant_id = $1::uuid AND status IN ('accepted','disputed')) AS claims,
         (SELECT count(DISTINCT claim_id)::text FROM claim_entities WHERE tenant_id = $1::uuid) AS covered,
         (SELECT count(*)::text FROM claim_entities ce LEFT JOIN claims c ON c.claim_id = ce.claim_id
           WHERE ce.tenant_id = $1::uuid AND c.claim_id IS NULL) AS orphans,
         (SELECT count(*)::text FROM (SELECT 1 FROM claim_entities WHERE tenant_id = $1::uuid
            GROUP BY tenant_id, canonical, claim_id HAVING count(*) > 1) d) AS dupes`,
      [ids.tenant],
    );
    const row = result.rows[0];
    assert.equal(row?.orphans, "0", "no claim_entities row may reference a missing claim");
    assert.equal(row?.dupes, "0", "the primary key must admit no duplicate (tenant, canonical, claim)");
    assert.equal(row?.covered, row?.claims, "every accepted or disputed claim must carry at least one entity row");
  });

  it("returns the same authorized claim ids as the pre-migration query on the golden corpus", async () => {
    // The core equivalence claim. Both queries run on the same data, as the application
    // role, inside the same bound request context, and differ only in how they find
    // candidate claims.
    // The binding holds the project scope *and* the project-unbound user scope. Those two
    // are deliberately chosen: they are the scopes on which the old two-sided reach rule
    // and the directional rule agree, so a difference in the result is a difference in the
    // entity query rather than in reach. Where the rules disagree is asserted separately,
    // in the reach suite and in "returns nothing for a project-unbound row".
    const bindings: Array<{ label: string; binding: EntityBinding }> = [
      { label: "object alias", binding: bindingInA(["acme"]) },
      { label: "subject alias", binding: bindingInA(["user:alice"]) },
      { label: "no terms matched", binding: bindingInA(["nothing-matches-this"]) },
    ];

    for (const { label, binding } of bindings) {
      const legacy = await runEntityQuery(app, binding, legacyReach, "legacy");
      const current = await runEntityQuery(app, binding, precomputedReach, "current");
      assert.deepEqual(current, legacy, `the projection must return the same ids as the old join (${label})`);
    }
  });

  it("agrees with the real entity channel, not just with a re-implementation", async () => {
    // The previous case compares two hand-written queries. This one compares the
    // hand-written query against the code that actually runs in production, so a drift
    // between the test's SQL and `channels.ts` cannot hide.
    const binding = bindingInA(["acme"]);
    const legacy = await runEntityQuery(app, binding, legacyReach, "legacy");
    const viaChannel = await runEntityChannel(app, binding);
    assert.deepEqual(viaChannel, legacy, "the entity channel must agree with the pre-migration query");

    // Positive control: the comparison is over a non-empty set, and the alias matched.
    const ownerCount = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM claim_entities WHERE tenant_id = $1::uuid AND canonical = 'acme'",
      [ids.tenant],
    );
    assert.notEqual(ownerCount.rows[0]?.n, "0", "the golden corpus must contain the alias for this to mean anything");
    assert.ok(legacy.length > 0, "the pre-migration query must return rows on the golden corpus");
  });

  it("matches a subject string", async () => {
    const legacy = await runEntityQuery(app, bindingInA(["user:alice"]), legacyReach, "legacy");
    const current = await runEntityQuery(app, bindingInA(["user:alice"]), precomputedReach, "current");
    assert.ok(current.length > 0, "a subject string must match through the projection");
    assert.deepEqual(current, legacy);
  });

  it("matches a scalar JSON string object, and not its quoted form", async () => {
    // `lower(object::text)` for the JSON string `"acme"` is `"acme"` — with the quotes.
    // `object #>> '{}'` is `acme`. The projection uses the unquoted value, so the alias
    // `acme` matches the row and the alias `"acme"` does not.
    const unquoted = await runEntityQuery(app, bindingInA(["acme"]), precomputedReach, "current");
    assert.ok(unquoted.length > 0, "the unquoted canonical must match");
    const quoted = await runEntityQuery(app, bindingInA(['"acme"']), precomputedReach, "current");
    assert.deepEqual(quoted, [], "the quoted JSON literal must not be a canonical value");
  });

  it("does not project a non-string object, and the legacy query agrees", async () => {
    // `{"a":1}` has no scalar string value, so the projection carries no row for it. The
    // legacy query computes `lower(object::text)` = `{"a":1}` for the same row, which is
    // also not the alias, so the two agree. The case is here because "they agree" is only
    // meaningful once the shape is actually present in the corpus.
    const current = await runEntityQuery(app, bindingInA(["acme"]), precomputedReach, "current");
    const legacy = await runEntityQuery(app, bindingInA(["acme"]), legacyReach, "legacy");
    assert.deepEqual(current, legacy, "a non-string object must be treated identically by both queries");
    const rows = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM claim_entities ce JOIN claims c ON c.claim_id = ce.claim_id
        WHERE ce.tenant_id = $1::uuid AND jsonb_typeof(c.object) <> 'string' AND ce.canonical = 'acme'`,
      [ids.tenant],
    );
    assert.equal(rows.rows[0]?.n, "0", "no alias row may be projected from a non-string object");
  });

  it("excludes a revoked claim", async () => {
    const current = await runEntityQuery(app, bindingInA(["acme"]), precomputedReach, "current");
    const revoked = await owner.query<{ claim_id: string }>(
      "SELECT claim_id FROM claims WHERE tenant_id = $1::uuid AND status = 'revoked'",
      [ids.tenant],
    );
    assert.ok(revoked.rows.length > 0, "the corpus must contain a revoked claim");
    for (const row of revoked.rows) {
      assert.ok(!current.includes(row.claim_id), "a revoked claim must not be returned by the entity channel");
    }
  });

  it("keeps identical aliases in two tenants separate, in both directions", async () => {
    // Both tenants declare the alias `acme`, and the channel filters `a.tenant_id = $1::uuid`.
    //
    // The case runs the **same helper** against tenant A and tenant B and asserts both
    // directions, because a negative-only assertion is satisfied by hiding both tenants:
    // "A does not see B's claim" passes just as well when A can see nothing at all. Each
    // direction therefore carries its own positive control — the tenant's own claim must be
    // returned — and both result sets must be non-empty.
    //
    // This is what the earlier version of this case could not express: its helper closed
    // over `ids.tenant`, so it could only ever ask what tenant A saw.
    const asA = await runEntityChannel(app, bindingInA(["acme"]));
    const asB = await runEntityChannel(app, {
      tenant: ids.foreignTenant,
      principal: "user:probe",
      scopes: [ids.foreignScope],
      purposes: PURPOSE,
      terms: ["acme"],
    });

    // Positive control for tenant A, derived with the **same scope closure the channel
    // uses**.
    //
    // This is the part that took several attempts. Computing the expected set needs the
    // reachable scope set, and every hand-built version of it was wrong in a different way —
    // first a missing scope, then a wrong object filter, then an undefined scope id that
    // silently widened the query. The closure is not a second implementation of the rule
    // under test: it is `veritymem.current_reachable_scope_ids()`, the value migration 0014
    // installs and the channel reads. Using it makes this a genuine unit test of the entity
    // *query* — the projection join and its filters — rather than a comparison against a
    // replica of the whole read path, which would fail whenever the replica drifted.
    await bind(app, {
      tenant: ids.tenant,
      principal: "user:probe",
      scopes: [ids.project, ids.userOnly],
      purposes: PURPOSE,
    });
    let expectedForA: string[];
    try {
      expectedForA = (
        await app.query<{ claim_id: string }>(
          `SELECT DISTINCT ce.claim_id
             FROM entity_aliases a
             JOIN claim_entities ce ON ce.tenant_id = a.tenant_id AND ce.canonical = a.canonical
             JOIN claims c ON c.claim_id = ce.claim_id AND c.tenant_id = ce.tenant_id
            WHERE a.tenant_id = $1::uuid
              AND a.alias = 'acme'
              AND c.status = 'accepted' AND c.valid_to IS NULL
              AND c.scope_id = ANY(veritymem.current_reachable_scope_ids())`,
          [ids.tenant],
        )
      ).rows.map((row) => row.claim_id).sort();
    } finally {
      await unbind(app);
    }

    assert.deepEqual(
      asA,
      expectedForA,
      "tenant A must see exactly the alias-matching claims in the scopes it can reach",
    );
    assert.ok(asA.length > 0, "tenant A's result set must be non-empty");
    assert.deepEqual(asB, [ids.foreignClaim], "tenant B must see exactly its own claim carrying the alias");

    // And neither sees the other's.
    assert.ok(!asA.includes(ids.foreignClaim), "tenant A must not receive tenant B's claim");
    assert.ok(!asB.includes(ids.knownClaim), "tenant B must not receive tenant A's claim");

    // The ids are genuinely different rows, so the assertions above are about the boundary
    // and not about one id being compared with itself.
    assert.notEqual(ids.foreignClaim, ids.knownClaim);

    // The same claim is also directly visible to its own tenant and invisible to the other
    // through the query form, which does not go through the channel's planner.
    const foreignDirect = await runEntityQuery(
      app,
      { tenant: ids.foreignTenant, principal: "user:probe", scopes: [ids.foreignScope], purposes: PURPOSE, terms: ["acme"] },
      precomputedReach,
      "current",
    );
    assert.deepEqual(foreignDirect, [ids.foreignClaim], "tenant B's own query must return its claim");
    assert.ok(
      !foreignDirect.includes(ids.knownClaim),
      "tenant B's own query must not return tenant A's claim",
    );
  });

  it("enforces RLS on claim_entities itself, so the projection cannot be read around claims", async () => {
    // The projection is a second copy of tenant data. If it were readable unbound it would
    // be a bypass of the claim policies, so the policy on it is load-bearing and is
    // asserted directly rather than inferred from the query results above.
    const enabled = await owner.query<{ relrowsecurity: boolean }>(
      "SELECT relrowsecurity FROM pg_class WHERE relname = 'claim_entities'",
    );
    assert.equal(enabled.rows[0]?.relrowsecurity, true, "claim_entities must have RLS enabled");

    // Unbound: zero rows.
    const unbound = await app.query<{ n: string }>("SELECT count(*)::text AS n FROM claim_entities");
    assert.equal(unbound.rows[0]?.n, "0", "an unbound connection must read no claim_entities rows");

    // Bound to the tenant: rows appear, and only for claims this tenant can reach.
    await bind(app, { tenant: ids.tenant, principal: "probe", scopes: [ids.project], purposes: PURPOSE });
    try {
      const bound = await app.query<{ n: string }>("SELECT count(*)::text AS n FROM claim_entities");
      assert.notEqual(bound.rows[0]?.n, "0", "a bound connection must read its own tenant's rows");
      const foreign = await app.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM claim_entities WHERE tenant_id = $1::uuid",
        [ids.foreignTenant],
      );
      assert.equal(foreign.rows[0]?.n, "0", "claim_entities must not expose another tenant's rows");
    } finally {
      await unbind(app);
    }
  });
});
