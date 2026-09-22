/**
 * `eval:perf explain` — capture real execution plans for every retrieval stage.
 *
 * ## What it does, in order
 *
 * 1. **Preflight against the database, not against assumptions.** The tenant must exist,
 *    it must hold claims, the application role must not bypass row-level security, and
 *    every migration must be applied. Each is a refusal with a specific message, because a
 *    capture run that proceeds on a misconfigured database produces a well-formed artifact
 *    describing the wrong thing — the most expensive kind of wrong.
 * 2. **Build the read path the server would build**, through `compose` from
 *    `@veritymem/retrieval`, with a `QueryExecutor` that observes. No channel SQL is
 *    written here; see `query-observer.ts` in that package for why.
 * 3. **Capture the scope binding explicitly.** `set_request_context` is invoked by
 *    `Db.withRequest`, below the executor seam, so it is explained directly — as the
 *    application role, inside a transaction, with the arguments the planner produces.
 * 4. **Assemble one artifact** and refuse to overwrite an existing one without `--force`.
 *
 * ## Roles
 *
 * Every retrieval plan is captured as `veritymem_app` with a transaction-bound request
 * context. The migration/owner connection is used for exactly two things: preflight
 * metadata, and reading versions. It never captures a retrieval plan, because a plan
 * captured as the owner would not contain the row-level-security predicate — and the
 * predicate is one of the things this artifact exists to record.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  Db,
  loadEnv,
  FilesystemBlobStore,
  Ledger,
  systemClock,
  systemIds,
  type QueryExecutor,
} from "@veritymem/ledger";
import {
  HashEmbeddingBackend,
  compose,
  looksReadOnly,
  withObservation,
  type ObservedQuery,
  type QueryObserver,
  type RetrievalStage,
} from "@veritymem/retrieval";
import { planCounters, planOutline, planTimings, structuralDigest } from "./plan-digest.ts";

/** Bumped when the artifact's shape changes in a way a reader would have to handle. */
export const PLAN_SCHEMA_VERSION = "vm-a3.plan-capture.1";

/** The stages the artifact must contain, in the order they are captured. */
export const REQUIRED_STAGES: readonly RetrievalStage[] = [
  "scope_binding",
  "lexical_channel",
  "entity_channel",
  "temporal_channel",
  "relation_channel",
  "dense_model_version",
  "dense_vector_search",
  "claim_hydration",
  // Hydration issues several statements against different tables; naming them keeps the
  // artifact legible instead of reducing four plans to one stage and three `unlabeled`.
  "claim_relations_read",
  "claim_evidence_read",
  "span_verification",
  "projection_watermark",
];

export interface PlanCaptureOptions {
  readonly tenant: string;
  readonly query: string;
  readonly limit: number;
  readonly output: string;
  readonly databaseUrl: string | null;
  readonly migrationUrl: string | null;
  readonly force: boolean;
  readonly purpose: string;
  /**
   * The caller to capture as, or null to discover one.
   *
   * A principal that participates in no scope authorizes nothing, and every captured plan
   * is then an empty one — eight well-formed entries that look like passing evidence. So a
   * principal is never invented: either the caller names one, and preflight checks it
   * actually participates, or one is discovered from `principal_scopes` for this tenant.
   */
  readonly principal: string | null;
  /**
   * Subjects to declare on the query. Repeatable.
   *
   * The relation channel is planned only for caller-declared subjects — terms mined from
   * the query text deliberately do not narrow the query — so a capture that declares none
   * reports `relation_channel` as missing. That is the honest outcome: the stage did not
   * run, and a fabricated entry for it would claim a plan nobody executed.
   */
  readonly subjects: readonly string[];
  /**
   * The query's time mode. `current` by default; `during` is what makes the temporal
   * channel issue a statement at all.
   */
  readonly timeMode: "current" | "as_of" | "during";
  readonly log: (message: string) => void;
}

export interface StageCapture {
  readonly stage: RetrievalStage;
  readonly success: boolean;
  readonly structural_plan_digest: string | null;
  readonly raw_plan: readonly unknown[] | null;
  readonly plan_outline: readonly string[];
  readonly planning_time_ms: number | null;
  readonly execution_time_ms: number | null;
  readonly buffers: ReturnType<typeof planCounters> | null;
  readonly parameter_types: readonly string[];
  /** The `Settings` block PostgreSQL reports for this plan, reduced to what matters. */
  readonly selected_settings: Record<string, string>;
  readonly sanitized_sql: string;
  readonly error: string | null;
}

/** A refusal: an answer about the environment, not a crash. Printed without a stack. */
export class PlanCaptureRefusal extends Error {}

/** Settings copied into the artifact, because a plan's interpretation depends on them. */
const REPORTED_SETTINGS = [
  "server_version",
  "shared_buffers",
  "work_mem",
  "maintenance_work_mem",
  "effective_cache_size",
  "max_connections",
  "random_page_cost",
  "seq_page_cost",
  "enable_seqscan",
  "enable_indexscan",
  "enable_bitmapscan",
  "hnsw.ef_search",
  "statement_timeout",
];

/**
 * Replace every literal in a statement with `?`.
 *
 * Two purposes at once. Values are the part that can leak — a claim's text, a principal,
 * a token — and they are also the part that differs between two captures of the same
 * plan, which would make the SQL un-diffable. Replacing them means the statements in an
 * artifact are stable across runs, so a diff of two artifacts is a diff of shapes.
 *
 * Single-quoted literals are handled before dollar-quoted ones, because a `$$` inside a
 * string is not a dollar quote. Quoted *identifiers* are kept: they are structure.
 */
export function sanitizeSql(sql: string): string {
  let out = "";
  let index = 0;
  while (index < sql.length) {
    const rest = sql.slice(index);

    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const close = rest.indexOf(tag, tag.length);
      if (close !== -1) {
        out += "?";
        index += close + tag.length;
        continue;
      }
    }

    const char = sql[index]!;
    if (char === "'") {
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === "'" && sql[cursor + 1] === "'") cursor += 2;
        else if (sql[cursor] === "'") break;
        else cursor += 1;
      }
      out += "?";
      index = Math.min(cursor + 1, sql.length);
      continue;
    }

    if (char === '"') {
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === '"' && sql[cursor + 1] === '"') cursor += 2;
        else if (sql[cursor] === '"') break;
        else cursor += 1;
      }
      out += sql.slice(index, Math.min(cursor + 1, sql.length));
      index = Math.min(cursor + 1, sql.length);
      continue;
    }

    if (/[0-9]/.test(char)) {
      const before = out.at(-1) ?? " ";
      if (!/[A-Za-z0-9_$]/.test(before)) {
        let cursor = index;
        while (cursor < sql.length && /[0-9.]/.test(sql[cursor]!)) cursor += 1;
        out += "?";
        index = cursor;
        continue;
      }
    }

    out += char;
    index += 1;
  }
  return out;
}

/** A stable, non-reversible handle for a tenant, safe to put in an artifact. */
export function tenantDigest(tenantId: string): string {
  return createHash("sha256").update(tenantId).digest("hex").slice(0, 16);
}

/** A stable, non-reversible handle for any other identifier. */
export function redact(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

/** The Git commit, or a stated absence rather than a guess. */
function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

interface PreflightFacts {
  readonly tenantId: string;
  readonly principal: string;
  readonly claims: number;
  readonly appRole: string;
  readonly appBypassRls: boolean;
  readonly appSuperuser: boolean;
  readonly pgVersion: string;
  readonly pgvectorVersion: string | null;
  readonly appliedMigrations: number;
  readonly latestMigration: string | null;
  readonly settings: Record<string, string>;
}

/** The settings in force, read as the owner because they are cluster metadata. */
async function readSettings(admin: Db): Promise<Record<string, string>> {
  const settings: Record<string, string> = {};
  for (const name of REPORTED_SETTINGS) {
    const row = await admin.systemQuery<{ value: string | null }>(
      "SELECT current_setting($1, true) AS value",
      [name],
    );
    const value = row.rows[0]?.value;
    if (value !== null && value !== undefined && value !== "") settings[name] = value;
  }
  return settings;
}

/**
 * Refuse to produce an artifact that would describe the wrong database.
 *
 * Each check answers a question the artifact cannot answer for itself. A capture on a
 * tenant with no claims yields eight empty plans that look like passing evidence; a
 * capture as a role that bypasses RLS yields plans with no policy predicate, so the
 * artifact would silently certify that the boundary does not exist.
 */
async function preflight(admin: Db, app: Db, options: PlanCaptureOptions): Promise<PreflightFacts> {
  const env = loadEnv();
  if (env.migrationsDir === null) {
    throw new PlanCaptureRefusal("the migrations directory could not be located, so completeness cannot be checked");
  }
  const applied = await admin.systemQuery<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
  const onDisk = readdirSync(env.migrationsDir).filter((file) => file.endsWith(".sql")).length;
  if (applied.rows.length !== onDisk) {
    throw new PlanCaptureRefusal(
      `required migrations are missing: ${applied.rows.length} applied but ${onDisk} exist on disk. ` +
        `Run 'pnpm migrate' before capturing plans.`,
    );
  }

  const tenant = await admin.systemQuery<{ tenant_id: string }>(
    "SELECT tenant_id FROM tenants WHERE slug = $1",
    [options.tenant],
  );
  const tenantId = tenant.rows[0]?.tenant_id;
  if (tenantId === undefined) {
    throw new PlanCaptureRefusal(
      `tenant '${options.tenant}' does not exist. Create it, or pass the slug of a tenant that does.`,
    );
  }

  const claims = await admin.systemQuery<{ n: string }>(
    "SELECT count(*)::text AS n FROM claims WHERE tenant_id = $1::uuid",
    [tenantId],
  );
  const claimCount = Number(claims.rows[0]?.n ?? "0");
  if (claimCount === 0) {
    throw new PlanCaptureRefusal(
      `tenant '${options.tenant}' holds no claims, so every captured plan would be empty. ` +
        `Load a corpus first (pnpm eval:perf load --tenant ${options.tenant}).`,
    );
  }

  // A principal that participates in nothing produces eight empty plans that look like
  // passing evidence, so this is checked before anything is captured. When the caller did
  // not name one, the first participant in the tenant is used and reported.
  const participants = await admin.systemQuery<{ principal_id: string }>(
    "SELECT DISTINCT principal_id FROM principal_scopes WHERE tenant_id = $1::uuid ORDER BY principal_id",
    [tenantId],
  );
  if (participants.rows.length === 0) {
    throw new PlanCaptureRefusal(
      `no principal participates in tenant '${options.tenant}', so every captured plan would ` +
        `authorize nothing and read zero rows. Load a corpus that records participation first.`,
    );
  }
  const requested = options.principal;
  if (requested !== null && !participants.rows.some((row) => row.principal_id === requested)) {
    throw new PlanCaptureRefusal(
      `principal '${requested}' does not participate in tenant '${options.tenant}', so every ` +
        `captured plan would authorize nothing. Participants: ${participants.rows
          .map((row) => row.principal_id)
          .join(", ")}`,
    );
  }
  const principal = requested ?? participants.rows[0]!.principal_id;

  // The application role is the whole point of capturing here. `Db.withRequest` supplies a
  // real transaction-bound context, which is where `current_user` is meaningful.
  const identity = await app.withRequest(
    {
      tenant: tenantId,
      principal,
      scopeIds: [],
      purposes: [options.purpose],
      action: "capture:identify",
    },
    async (executor) =>
      (
        await executor.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        )
      ).rows[0],
  );
  if (identity === undefined) throw new PlanCaptureRefusal("the application role could not be identified");
  if (identity.rolbypassrls) {
    throw new PlanCaptureRefusal(
      `the application role '${identity.rolname}' has BYPASSRLS, so captured plans would omit the ` +
        `row-level-security predicate and this artifact would certify that the boundary does not ` +
        `exist. Capture with a role that does not bypass RLS.`,
    );
  }
  if (identity.rolsuper) {
    throw new PlanCaptureRefusal(
      `the application role '${identity.rolname}' is a superuser, so captured plans would omit the ` +
        `row-level-security predicate.`,
    );
  }

  const version = await admin.systemQuery<{ server_version: string; vector: string | null }>(
    `SELECT current_setting('server_version') AS server_version,
            (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector`,
  );

  return {
    tenantId,
    principal,
    claims: claimCount,
    appRole: identity.rolname,
    appBypassRls: identity.rolbypassrls,
    appSuperuser: identity.rolsuper,
    pgVersion: version.rows[0]?.server_version ?? "unknown",
    pgvectorVersion: version.rows[0]?.vector ?? null,
    appliedMigrations: applied.rows.length,
    latestMigration: applied.rows.at(-1)?.name ?? null,
    settings: await readSettings(admin),
  };
}

/**
 * Collect observed statements into stage entries.
 *
 * A stage may issue more than one statement; every observation is kept, so nothing is
 * silently dropped, and `stageReport` names which stages appeared more than once.
 */
class Collector implements QueryObserver {
  private readonly entries: StageCapture[] = [];
  private readonly types = new Map<string, readonly string[]>();


  observed(entry: ObservedQuery): void {
    const plan = entry.plan;
    this.entries.push({
      stage: entry.stage,
      success: entry.error === null && plan !== null,
      structural_plan_digest: plan === null ? null : structuralDigest(plan),
      raw_plan: plan,
      plan_outline: plan === null ? [] : planOutline(plan),
      planning_time_ms: plan === null ? null : planTimings(plan).planning_time_ms,
      execution_time_ms: plan === null ? null : planTimings(plan).execution_time_ms,
      buffers: plan === null ? null : planCounters(plan),
      parameter_types: this.types.get(`${entry.stage}:${entry.sql.length}`) ?? [],
      selected_settings: plan === null ? {} : planSettings(plan),
      // Values are dropped: the artifact carries the statement's shape, not its inputs.
      sanitized_sql: sanitizeSql(entry.sql),
      error: entry.error,
    });
  }

  /** Record the parameter types PostgreSQL inferred, keyed by stage and statement length. */
  attachParameterTypes(stage: RetrievalStage, sql: string, types: readonly string[]): void {
    this.types.set(`${stage}:${sql.length}`, types);
  }

  /** An entry recorded by the caller rather than by the executor seam. */
  push(entry: StageCapture): void {
    this.entries.push(entry);
  }

  all(): readonly StageCapture[] {
    return this.entries;
  }

  stageReport(): { readonly seen: readonly string[]; readonly duplicates: readonly string[] } {
    const counts = new Map<string, number>();
    for (const entry of this.entries) counts.set(entry.stage, (counts.get(entry.stage) ?? 0) + 1);
    return {
      seen: [...counts.keys()],
      duplicates: [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name),
    };
  }
}

/**
 * `EXPLAIN (ANALYZE, …)` one statement and return the parsed plan.
 *
 * This *executes* the statement, so it is only used where a second execution is safe and
 * wanted. The statements the channels run are observed by `withObservation`, which
 * executes them once and explains them afterwards.
 */
async function explainVia(
  executor: QueryExecutor,
  sql: string,
  params: readonly unknown[],
): Promise<readonly unknown[]> {
  const explained = await executor.query<{ "QUERY PLAN": readonly unknown[] }>(
    `EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON) ${sql}`,
    params,
  );
  // `pg` decodes a `json` column for us, so this is already the top-level array
  // `EXPLAIN (FORMAT JSON)` produces: one element, holding `Plan` beside the volatile
  // timing fields. Mapping over `rows` and taking the field again — which the first
  // version did — wrapped it one level too deep, so every plan reduced to `[null]`, every
  // digest became the hash of `null`, and all eight stages reported the same value. A
  // run in which every digest is identical is a run where nothing is being compared.
  return explained.rows[0]?.["QUERY PLAN"] ?? [];
}

/**
 * The parameter types PostgreSQL inferred for a statement.
 *
 * Asked of the database rather than guessed from the JavaScript values, so the artifact
 * records what PostgreSQL decided a `$1` was. `pg_prepared_statements` is consulted
 * because it is the only way to ask; the prepared statement is scoped to this session and
 * deallocated immediately.
 */
async function parameterTypes(
  executor: QueryExecutor,
  sql: string,
  params: readonly unknown[],
): Promise<readonly string[]> {
  const name = "vm_a3_probe";
  try {
    await executor.query(`PREPARE ${name} AS ${sql}`);
    const row = await executor.query<{ parameter_types: string[] }>(
      "SELECT parameter_types FROM pg_prepared_statements WHERE name = $1",
      [name],
    );
    return row.rows[0]?.parameter_types ?? [];
  } catch {
    // A statement that cannot be prepared reports no types rather than failing a capture.
    return [];
  } finally {
    await executor.query(`DEALLOCATE ${name}`).catch(() => undefined);
  }
}

/**
 * The `Settings` block PostgreSQL attaches to a plan under `EXPLAIN (SETTINGS)`.
 *
 * Recorded per stage because a plan is only interpretable next to the settings that
 * produced it: the same query plans differently under a different `work_mem` or
 * `enable_seqscan`, and a shape change caused by a configuration change is not a code
 * regression. Reduced to the settings a planner decision depends on, so the artifact does
 * not carry several hundred unchanged defaults per stage.
 */
const PLAN_SETTINGS_OF_INTEREST = new Set([
  "enable_seqscan",
  "enable_indexscan",
  "enable_bitmapscan",
  "enable_hashjoin",
  "enable_mergejoin",
  "enable_nestloop",
  "work_mem",
  "shared_buffers",
  "effective_cache_size",
  "random_page_cost",
  "seq_page_cost",
  "hnsw.ef_search",
]);

function planSettings(explainRows: readonly unknown[]): Record<string, string> {
  const document = (explainRows[0] ?? {}) as Record<string, unknown>;
  const raw = document["Settings"];
  if (raw === null || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (PLAN_SETTINGS_OF_INTEREST.has(key) && typeof value === "string") out[key] = value;
  }
  return out;
}

/** Capture the artifact. Throws `PlanCaptureRefusal` for a refusal. */
export async function capturePlans(
  options: PlanCaptureOptions,
): Promise<{ artifact: unknown; output: string }> {
  const env = loadEnv();
  const databaseUrl = options.databaseUrl ?? env.databaseUrl;
  const migrationUrl = options.migrationUrl ?? env.migrationDatabaseUrl;
  if (!databaseUrl) throw new PlanCaptureRefusal("DATABASE_URL is not set and --database-url was not given");
  if (!migrationUrl) {
    throw new PlanCaptureRefusal("MIGRATION_DATABASE_URL is not set and --migration-url was not given");
  }

  const output = resolve(options.output);
  if (existsSync(output) && !options.force) {
    throw new PlanCaptureRefusal(
      `the output path ${output} already exists. Pass --force to overwrite it, so an existing ` +
        `artifact cannot be replaced without the caller saying so.`,
    );
  }

  const admin = new Db({
    connectionString: migrationUrl,
    max: 4,
    applicationName: "veritymem-plan-capture-admin",
  });
  const app = new Db({ connectionString: databaseUrl, max: 4, applicationName: "veritymem-plan-capture-app" });
  const ledger = new Ledger({
    db: app,
    // The same store the benchmark uses; hydration re-verifies span digests through it.
    blobs: new FilesystemBlobStore(resolve(".veritymem/blobs")),
    clock: systemClock,
    ids: systemIds,
  });

  const collector = new Collector();
  const started = Date.now();

  try {
    const facts = await preflight(admin, app, options);
    options.log(`tenant      ${options.tenant} (digest ${tenantDigest(facts.tenantId)})`);
    options.log(`claims      ${facts.claims.toLocaleString("en-US")}`);
    options.log(
      `app role    ${facts.appRole} (bypassrls=${facts.appBypassRls}, superuser=${facts.appSuperuser})`,
    );
    options.log(`migrations  ${facts.appliedMigrations} applied, latest ${facts.latestMigration}`);
    options.log(`principal   ${redact(facts.principal)}`);

    // The local deterministic embedder. Prepared before any transaction is opened, which
    // is what the dense lane does in production so an embedder's latency cannot hold a
    // transaction open. `isModelCall` is false: no hosted model is reachable from here.
    const embeddings = new HashEmbeddingBackend({
      dimensions: env.embedding.dimensions,
      modelId: env.embedding.modelId,
    });
    const [vector] = await embeddings.embed([options.query]);
    if (vector === undefined) {
      throw new PlanCaptureRefusal("the embedding backend returned no vector for the query");
    }

    // --- stage: scope binding ---------------------------------------------
    // Captured first, as the application role, in a transaction of its own. The scope set
    // is read from the same membership table the planner reads, so the closure the other
    // stages run under is the one this stage explains.
    const memberships = await app.withRequest(
      {
        tenant: facts.tenantId,
        principal: facts.principal,
        scopeIds: [],
        purposes: [options.purpose],
        action: "query:plan",
      },
      async (executor) =>
        (
          await executor.query<{ scope_id: string }>(
            "SELECT scope_id FROM principal_scopes WHERE tenant_id = $1::uuid AND principal_id = $2",
            [facts.tenantId, facts.principal],
          )
        ).rows.map((row) => row.scope_id),
    );
    const scopeIds = memberships;

    await app.withRequest(
      {
        tenant: facts.tenantId,
        principal: facts.principal,
        scopeIds,
        purposes: [options.purpose],
        action: "query:read",
      },
      async (executor) => {
        const sql =
          "SELECT veritymem.set_request_context($1::uuid, $2, $3::uuid[], $4::text[], $5)";
        const params = [facts.tenantId, facts.principal, scopeIds, [options.purpose], "query:read"];
        let plan: readonly unknown[] | null = null;
        let error: string | null = null;
        try {
          // Explained on its own, before the surrounding `withRequest` binding is reused:
          // the resulting plan is of a statement whose settings are the transaction's, and
          // the real call below is what the later stages inherit.
          plan = await explainVia(executor, sql, params);
          collector.attachParameterTypes("scope_binding", sql, await parameterTypes(executor, sql, params));
        } catch (cause) {
          error = (cause as Error).message;
        }
        collector.observed({ stage: "scope_binding", sql, params, plan, error });
      },
    );

    options.log(`scopes      ${scopeIds.length} held`);

    // --- the channels and hydration, through the production read path -------
    const result = await compose(
      { db: app, ledger, embeddings, ids: systemIds, clock: systemClock } as never,
      {
        tenant_id: facts.tenantId,
        query: options.query,
        scope: { tenant: options.tenant },
        purpose: options.purpose,
        limit: options.limit,
        time: { mode: options.timeMode },
        ...(options.subjects.length > 0 ? { subjects: [...options.subjects] } : {}),
      } as never,
      {
        principal: facts.principal,
        observer: collector,
        makeExplainingExecutor: (executor, observer, stageName) =>
          withObservation(executor, {
            observer,
            stageName,
            explain: (sql, params) => explainVia(executor, sql, params),
            shouldCapture: looksReadOnly,
          }),
      },
    );
    options.log(`channels    ${result.channels.map((channel) => channel.channel).join(", ")}`);

    const entries = collector.all();
    const report = collector.stageReport();
    const missing = REQUIRED_STAGES.filter((name) => !report.seen.includes(name));
    for (const name of missing) {
      options.log(`WARNING     stage '${name}' produced no statement; recorded as missing`);
    }

    const artifact = buildArtifact({
      options,
      facts,
      entries,
      missing,
      duplicates: report.duplicates,
      wallMs: Date.now() - started,
      heldScopes: scopeIds.length,
      embeddings: {
        model_id: embeddings.model_id,
        dimensions: embeddings.dimensions,
        is_model_call: embeddings.isModelCall,
      },
    });

    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    return { artifact, output };
  } finally {
    await app.close();
    await admin.close();
  }
}

interface BuildInput {
  readonly options: PlanCaptureOptions;
  readonly facts: PreflightFacts;
  readonly entries: readonly StageCapture[];
  readonly missing: readonly string[];
  readonly duplicates: readonly string[];
  readonly wallMs: number;
  readonly heldScopes: number;
  readonly embeddings: {
    readonly model_id: string;
    readonly dimensions: number;
    readonly is_model_call: boolean;
  };
}

/**
 * Assemble the artifact.
 *
 * The exclusions are the point of this function: no connection string, no credential, no
 * principal, no query text, no evidence content, no token. The tenant appears as a digest
 * so two artifacts from the same tenant are comparable without naming it.
 */
function buildArtifact(input: BuildInput): unknown {
  const { options, facts, entries } = input;
  return {
    schema_version: PLAN_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    commit: gitCommit(),
    postgres: { version: facts.pgVersion, pgvector_version: facts.pgvectorVersion },
    migrations: { applied: facts.appliedMigrations, latest: facts.latestMigration },
    settings: facts.settings,
    application_role: {
      role: facts.appRole,
      superuser: facts.appSuperuser,
      bypassrls: facts.appBypassRls,
    },
    tenant: {
      // A digest, never the id and never the slug: the slug is what a human would search for.
      digest: tenantDigest(facts.tenantId),
      corpus_claims: facts.claims,
    },
    request: {
      // The query text is deliberately absent. Its length and digest let two runs be
      // compared, or proved identical, without recording what was asked.
      query_length: options.query.length,
      query_digest: redact(options.query),
      limit: options.limit,
      purpose: options.purpose,
      /**
       * The time mode, which is why `temporal_channel` is sometimes absent: that channel
       * returns without issuing a statement unless the mode is `during`. Recording the mode
       * lets a reader tell "the stage did not run because the query did not ask for it" from
       * "the stage ran and was not captured", which are different problems.
       */
      time_mode: options.timeMode,
      /**
       * How many subjects the caller declared. `relation_channel` is planned only for
       * declared subjects, so this is the other half of reading `missing_stages` correctly.
       */
      declared_subjects: options.subjects.length,
      principal_digest: redact(input.facts.principal),
      // How many scopes the principal actually holds, which is what the closure is built
      // from. A count, not the ids: the ids are authorization state.
      held_scopes: input.heldScopes,
    },
    embeddings: input.embeddings,
    capture: {
      wall_ms: input.wallMs,
      /**
       * Stated plainly, because a reader comparing these timings with a latency
       * measurement would otherwise be misled: the plan is captured by running the
       * statement a second time, after the channel's own execution, so the pages it reads
       * are warm.
       */
      timing_note:
        "EXPLAIN ANALYZE executes the statement; this capture runs it after the channel's own " +
        "execution, so actual times and buffer counters describe a second, warm-cache run. They " +
        "are evidence about plan shape, not about latency.",
      missing_stages: input.missing,
      duplicated_stages: input.duplicates,
    },
    stages: entries,
  };
}
