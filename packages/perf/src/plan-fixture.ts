/**
 * The plan-capture test tenant, provisioned deterministically.
 *
 * ## Why this is a module rather than setup inside the test file
 *
 * The tests need a tenant that exercises **every** retrieval stage, and a fixture that only
 * mostly works produces exactly the failure this task exists to remove: a capture that looks
 * complete while a stage is silently absent. So the fixture is built here, with an assertion
 * on each thing a stage needs, and both the test file and any manual run use it.
 *
 * ## What it reuses
 *
 * The corpus comes from `loadCorpus` — the production bulk loader the benchmark uses —
 * rather than from hand-written inserts. It already writes events, spans, claim evidence,
 * embeddings, the dense projection version and contradiction relations, which is most of
 * what the stages need. The entity tables come from `projectClaim`, the same production
 * projection the outbox worker calls, so `entity_aliases` and `claim_entities` are filled by
 * the code under test rather than by a copy of it.
 *
 * **No channel SQL is written here.** The fixture never restates a retrieval query; it only
 * creates rows for retrieval queries to find.
 *
 * ## Two operational rules, both learned the hard way
 *
 * **`indexStrategy` is `maintain`, never `defer`.** `defer` drops
 * `claim_embeddings_hnsw_idx` and rebuilds it once at the end. That index is global, not per
 * tenant, so deferring it on a shared database removes it from every other tenant for the
 * duration — and an interrupted run leaves it gone. The first version of this module used
 * `defer`, was interrupted, and left a 2.4-million-row database with no HNSW index and a
 * rebuild that had to be run by hand.
 *
 * **Both connection URLs carry `max_parallel_workers_per_gather=0`.** Parallel workers
 * allocate dynamic shared memory, and a containerised PostgreSQL with a small `/dev/shm`
 * fails on a parallel plan over a corpus with
 * `dsm_impl_posix: could not resize shared memory segment`. It is a connection *option*
 * rather than a `SET` because `loadCorpus` builds its own pool from the URL, so a `SET` on
 * this module's pool would leave the loader unconstrained. It is confined to provisioning:
 * the capture itself must record whatever topology PostgreSQL chooses.
 */
import { resolve } from "node:path";
import { Db, loadEnv, resolveTenantId } from "@veritymem/ledger";
import { HashEmbeddingBackend, projectClaim } from "@veritymem/retrieval";
import { BENCH_PRINCIPAL, generateClaim } from "./corpus.ts";
import { loadCorpus } from "./load.ts";

/** The fixed label the slug and the fixture's identity derive from. */
export const FIXTURE_LABEL = "vm-a3-plan-capture-fixture";

/** The corpus seed, so the fixture's rows are reproducible between runs. */
export const FIXTURE_CORPUS_SEED = "veritymem-perf-v1";

/** How many claims the fixture holds. Small: this measures plan shape, not throughput. */
export const FIXTURE_CLAIMS = 400;

/**
 * The corpus anchor. Fixed rather than "now", because the anchor defines every validity
 * interval and therefore which claims a `during` window can find.
 */
export const FIXTURE_ANCHOR = new Date("2026-09-17T12:00:00.000Z");

/** A `during` window the fixture is asserted to have accepted claims inside. */
export const FIXTURE_FROM = "2026-09-01T00:00:00.000Z";
export const FIXTURE_TO = "2026-10-01T00:00:00.000Z";

/** The query text. Drawn from the corpus vocabulary so it matches rows. */
export const FIXTURE_QUERY = "deployment window";

/** Row counts, one per stage requirement. */
export interface FixtureCounts {
  readonly claims: number;
  readonly accepted: number;
  readonly events: number;
  readonly spans: number;
  readonly claim_evidence: number;
  readonly claim_embeddings: number;
  readonly claim_relations: number;
  readonly entity_aliases: number;
  readonly claim_entities: number;
  readonly projection_versions: number;
  readonly accepted_in_window: number;
}

export interface Fixture {
  readonly tenantSlug: string;
  readonly tenantId: string;
  readonly principal: string;
  readonly subject: string;
  readonly claims: number;
  readonly counts: FixtureCounts;
  /** True when the corpus was already present and nothing was loaded. */
  readonly reused: boolean;
}

/**
 * Each requirement, paired with the stage that would be silently absent without it.
 *
 * A bare "count must be positive" check tells a caller a number was zero; naming the
 * consequence tells them which stage they were about to record as passing over an empty
 * table.
 */
const REQUIREMENTS: ReadonlyArray<readonly [keyof FixtureCounts, string]> = [
  ["claims", "no claim can be returned, and every channel's plan would be over an empty table"],
  ["accepted", "hydration would have nothing to read"],
  ["events", "span_verification would not run"],
  ["spans", "claim_evidence_read would return nothing"],
  ["claim_evidence", "claim_hydration would return an empty packet"],
  ["claim_embeddings", "the dense vector search would scan nothing"],
  ["claim_relations", "relation_channel would match nothing"],
  ["entity_aliases", "entity_channel would join an empty dictionary"],
  ["claim_entities", "entity_channel would join an empty projection"],
  ["projection_versions", "dense_model_version would find no row"],
  ["accepted_in_window", "temporal_channel would find no claim in the during window"],
];

/** Append a connection option, preserving any already in the URL. */
function withNoParallelWorkers(url: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}options=${encodeURIComponent("-c max_parallel_workers_per_gather=0")}`;
}

/** The URLs the fixture uses, with parallelism constrained. */
function fixtureUrls(): { readonly admin: string; readonly app: string } {
  const env = loadEnv();
  if (!env.migrationDatabaseUrl) {
    throw new Error("MIGRATION_DATABASE_URL is required to provision the plan-capture fixture");
  }
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is required to provision the plan-capture fixture");
  }
  return {
    admin: withNoParallelWorkers(env.migrationDatabaseUrl),
    app: withNoParallelWorkers(env.databaseUrl),
  };
}

/** A fixed principal, so the artifact's principal digest is stable between runs. */
export function fixturePrincipal(): string {
  return BENCH_PRINCIPAL;
}

/** The subject of claim index 0, which is the one the capture declares. */
export function fixtureSubject(): string {
  return generateClaim(0, {
    seed: FIXTURE_CORPUS_SEED,
    tenantId: resolveTenantId(FIXTURE_LABEL),
    anchor: FIXTURE_ANCHOR,
  }).subject;
}

/** Read the fixture's row counts. Returns null when the tenant does not exist. */
export async function countFixture(): Promise<FixtureCounts | null> {
  const { admin } = fixtureUrls();
  const tenantId = resolveTenantId(FIXTURE_LABEL);
  const db = new Db({ connectionString: admin, max: 2 });
  try {
    const exists = await db.systemQuery<{ n: string }>(
      "SELECT count(*)::text AS n FROM tenants WHERE tenant_id = $1::uuid",
      [tenantId],
    );
    if (exists.rows[0]?.n === "0") return null;
    const row = (
      await db.systemQuery<Record<string, string>>(
        `SELECT
           (SELECT count(*)::text FROM claims WHERE tenant_id = $1::uuid) AS claims,
           (SELECT count(*)::text FROM claims WHERE tenant_id = $1::uuid AND status = 'accepted') AS accepted,
           (SELECT count(*)::text FROM events WHERE tenant_id = $1::uuid) AS events,
           (SELECT count(*)::text FROM evidence_spans s JOIN events e ON e.event_id = s.event_id
             WHERE e.tenant_id = $1::uuid) AS spans,
           (SELECT count(*)::text FROM claim_evidence ce JOIN claims c ON c.claim_id = ce.claim_id
             WHERE c.tenant_id = $1::uuid) AS claim_evidence,
           (SELECT count(*)::text FROM claim_embeddings WHERE tenant_id = $1::uuid) AS claim_embeddings,
           (SELECT count(*)::text FROM claim_relations r JOIN claims c ON c.claim_id = r.from_claim
             WHERE c.tenant_id = $1::uuid) AS claim_relations,
           (SELECT count(*)::text FROM entity_aliases WHERE tenant_id = $1::uuid) AS entity_aliases,
           (SELECT count(*)::text FROM claim_entities WHERE tenant_id = $1::uuid) AS claim_entities,
           (SELECT count(*)::text FROM projection_versions WHERE tenant_id = $1::uuid) AS projection_versions,
           (SELECT count(*)::text FROM claims
             WHERE tenant_id = $1::uuid AND status = 'accepted'
               AND valid_range && tstzrange($2::timestamptz, $3::timestamptz, '[)')) AS accepted_in_window`,
        [tenantId, FIXTURE_FROM, FIXTURE_TO],
      )
    ).rows[0];
    if (row === undefined) return null;
    const out: Record<string, number> = {};
    for (const key of Object.keys(row)) out[key] = Number(row[key]);
    return out as unknown as FixtureCounts;
  } finally {
    await db.close();
  }
}

/** Throw when the fixture is not complete, naming the stage each gap would break. */
export async function assertFixtureComplete(counts?: FixtureCounts | null): Promise<FixtureCounts> {
  const resolved = counts ?? (await countFixture());
  if (resolved === null) {
    throw new Error(
      `the plan-capture fixture tenant '${FIXTURE_LABEL}' does not exist. ` +
        `Provision it with 'pnpm eval:perf fixture'.`,
    );
  }
  for (const [field, consequence] of REQUIREMENTS) {
    if (resolved[field] < 1) {
      throw new Error(
        `the plan-capture fixture is incomplete: ${field} is ${resolved[field]}, so ${consequence}. ` +
          `Fixture tenant: ${FIXTURE_LABEL}. Re-provision with 'pnpm eval:perf fixture --force'.`,
      );
    }
  }
  return resolved;
}

/**
 * Provision the fixture, or return it unchanged when it is already complete.
 *
 * Throws on anything that would make a stage silently absent. That is deliberate: a caller
 * that cannot tell an incomplete fixture from a complete one will produce a capture that
 * looks successful and is not.
 */
export async function provisionFixture(
  options: { readonly log?: (message: string) => void; readonly force?: boolean } = {},
): Promise<Fixture> {
  const log = options.log ?? ((): void => undefined);
  const tenantSlug = FIXTURE_LABEL;
  const tenantId = resolveTenantId(tenantSlug);
  const principal = fixturePrincipal();
  const subject = fixtureSubject();
  const { admin: adminUrl, app: appUrl } = fixtureUrls();

  // ---- fast path: an already-provisioned fixture costs nothing ------------
  //
  // Idempotency is not only "does not duplicate rows". It is also "does not spend minutes
  // regenerating a corpus that is already present", which matters because the test file
  // calls this on every run. Presence is decided from the row counts themselves.
  if (options.force !== true) {
    const existing = await countFixture();
    if (existing !== null && existing.claims >= FIXTURE_CLAIMS && existing.accepted_in_window > 0) {
      try {
        const complete = await assertFixtureComplete(existing);
        log(`fixture already provisioned (${complete.claims} claims)`);
        return {
          tenantSlug,
          tenantId,
          principal,
          subject,
          claims: complete.claims,
          counts: complete,
          reused: true,
        };
      } catch {
        // Incomplete: fall through and finish the job rather than failing here, so a
        // half-provisioned fixture heals on the next call.
        log("fixture exists but is incomplete; completing it");
      }
    }
  }

  // ---- the corpus, through the production loader --------------------------
  const env = loadEnv();
  const loaded = await loadCorpus({
    migrationUrl: adminUrl,
    tenantId,
    tenantSlug,
    claims: FIXTURE_CLAIMS,
    corpusSeed: FIXTURE_CORPUS_SEED,
    anchor: FIXTURE_ANCHOR,
    embeddingModelId: env.embedding.modelId,
    embeddingDimensions: env.embedding.dimensions,
    statePath: resolve(".veritymem/perf", `${tenantSlug}.load-state.json`),
    /**
     * `maintain`, never `defer`. `defer` drops the global `claim_embeddings_hnsw_idx` and
     * rebuilds it at the end; on a shared database that removes the index from every other
     * tenant, and an interrupted run leaves it gone.
     */
    indexStrategy: "maintain",
    onProgress: (progress) => {
      if (progress.done >= progress.total) log(`  ${progress.phase.padEnd(16)} ${progress.total}`);
    },
  });
  log(`corpus loaded in ${(loaded.elapsed_ms / 1000).toFixed(1)} s`);

  // ---- the entity projection, through the production projection -----------
  //
  // `loadCorpus` writes the dense and relational projections but not the entity one,
  // because the entity projection belongs to the write path rather than to the corpus.
  // Driving `projectClaim` here means the fixture's entity rows come from the code the
  // entity channel's tests are about.
  const admin = new Db({ connectionString: adminUrl, max: 4, applicationName: "veritymem-fixture-admin" });
  const app = new Db({ connectionString: appUrl, max: 4, applicationName: "veritymem-fixture-app" });
  try {
    const embeddings = new HashEmbeddingBackend({
      dimensions: env.embedding.dimensions,
      modelId: env.embedding.modelId,
    });
    const claimRows = await admin.systemQuery<{ claim_id: string }>(
      `SELECT claim_id FROM claims
        WHERE tenant_id = $1::uuid AND status IN ('accepted','disputed')
        ORDER BY claim_id`,
      [tenantId],
    );
    let projected = 0;
    for (const claim of claimRows.rows) {
      const outcome = await admin.withSystemContext({ tenant: tenantId, actor: "vm-a3-fixture" }, (executor) =>
        projectClaim(executor, { db: admin, embeddings }, claim.claim_id),
      );
      if (outcome.projected) projected += 1;
    }
    log(`entity projection: ${projected} claim(s) projected`);

    const counts = await assertFixtureComplete();

    // The subject the capture declares must exist as an alias, or the entity channel's join
    // matches nothing and the capture records an empty entity plan that looks successful.
    const alias = await admin.systemQuery<{ n: string }>(
      "SELECT count(*)::text AS n FROM entity_aliases WHERE tenant_id = $1::uuid AND alias = $2",
      [tenantId, subject.toLowerCase()],
    );
    if (alias.rows[0]?.n === "0") {
      throw new Error(
        `the fixture's declared subject '${subject}' has no alias row, so the entity channel would ` +
          `match nothing. Fixture tenant: ${tenantSlug}.`,
      );
    }

    return { tenantSlug, tenantId, principal, subject, claims: counts.claims, counts, reused: false };
  } finally {
    await app.close();
    await admin.close();
  }
}
