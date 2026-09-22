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
import { createHash, randomBytes } from "node:crypto";
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
import type { TimeSpec } from "@veritymem/contracts";
import { planCounters, planOutline, planTimings, structuralDigest } from "./plan-digest.ts";
import { findLeaks, findMarkers, redactUuids, sanitizePlan, type SecretProbe } from "./plan-sanitize.ts";

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
   * The complete `TimeSpec`, as the contract defines it.
   *
   * Passed through to `compose` unchanged. It is the contract's own union rather than a
   * mode plus optional fields, so a request cannot express "during with no window" and
   * this module never has to decide what such a request would mean. The CLI is responsible
   * for rejecting bad input; see `buildTimeSpec`.
   */
  readonly time: TimeSpec;
  readonly log: (message: string) => void;
}

export interface StageCapture {
  readonly stage: RetrievalStage;
  readonly success: boolean;
  readonly structural_plan_digest: string | null;
  /**
   * The plan with every bound value replaced.
   *
   * Named `sanitized_plan`, not `raw_plan`. `EXPLAIN (FORMAT JSON)` rewrites the statement
   * with its parameter values substituted, so the raw document carries tenant UUIDs, query
   * text and declared subjects in fields such as `Filter` and `Index Cond`. Calling a
   * sanitized document "raw" would be a false claim about what a reader is looking at.
   */
  readonly sanitized_plan: readonly unknown[] | null;
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


  observed(entry: ObservedQuery): void {
    const plan = entry.plan;
    this.entries.push({
      stage: entry.stage,
      success: entry.error === null && plan !== null,
      structural_plan_digest: plan === null ? null : structuralDigest(plan),
      sanitized_plan: plan === null ? null : sanitizePlan(plan),
      plan_outline: plan === null ? [] : planOutline(plan),
      planning_time_ms: plan === null ? null : planTimings(plan).planning_time_ms,
      execution_time_ms: plan === null ? null : planTimings(plan).execution_time_ms,
      buffers: plan === null ? null : planCounters(plan),
      /**
       * Types come from the observation itself.
       *
       * The first version keyed them by `stage:sql.length`, which is wrong twice over: two
       * different statements can have the same length, and a statement whose text changed by
       * one character would silently inherit the previous statement's types.
       */
      parameter_types: entry.parameterTypes,
      selected_settings: plan === null ? {} : planSettings(plan),
      // Values are dropped: the artifact carries the statement's shape, not its inputs.
      sanitized_sql: sanitizeSql(entry.sql),
      error: entry.error,
    });
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
  /**
   * A unique name per call.
   *
   * A fixed name collides: the dense channel's model-version lookup and its vector search are
   * issued from two executors on the same connection, and the ordinary lane runs concurrently
   * on another. A `PREPARE` under a name already in use is an error in PostgreSQL, so a fixed
   * name would make one of the two statements report no types — silently, because the catch
   * below turns any failure into an empty list.
   */
  const name = `vm_a3_probe_${randomBytes(8).toString("hex")}`;
  try {
    await executor.query(`PREPARE ${name} AS ${sql}`);
    const row = await executor.query<{ parameter_types: string[] }>(
      "SELECT parameter_types FROM pg_prepared_statements WHERE name = $1",
      [name],
    );
    return row.rows[0]?.parameter_types ?? [];
  } catch (cause) {
    /**
     * Recorded rather than swallowed.
     *
     * An empty list is a legitimate answer — a statement with no placeholders has no types —
     * so a caller cannot distinguish "no parameters" from "the probe failed" by looking at
     * the value. The failure is therefore reported on stderr, which keeps it visible without
     * making a diagnostic gap fail an otherwise-successful capture.
     */
    process.stderr.write(
      `plan capture: could not determine parameter types for one statement ` +
        `(${redactUuids((cause as Error).message)}); recording an empty list\n`,
    );
    return [];
  } finally {
    // Always, including on the failure path: a prepared statement left behind would keep a
    // plan pinned for the life of the session and could collide with a later probe.
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
): Promise<{ artifact: unknown; output: string; completion: StageCompletion }> {
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
        let types: readonly string[] = [];
        try {
          // Explained on its own, before the surrounding `withRequest` binding is reused:
          // the resulting plan is of a statement whose settings are the transaction's, and
          // the real call below is what the later stages inherit.
          plan = await explainVia(executor, sql, params);
          types = await parameterTypes(executor, sql, params);
        } catch (cause) {
          // Sanitized, because a PostgreSQL error repeats the offending value and the values
          // here are the tenant UUID and the principal.
          error = redactUuids((cause as Error).message);
        }
        collector.observed({ stage: "scope_binding", sql, params, plan, error, parameterTypes: types });
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
        // The contract's TimeSpec, not a cast: `compose` receives exactly what the caller
        // asked for, and the union means there is no invalid shape to express.
        time: options.time,
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
            // Read on the same connection as the statement, so the prepared statement it
            // creates is scoped to this session and cannot collide with a concurrent lane's.
            parameterTypes: (sql, params) => parameterTypes(executor, sql, params),
            shouldCapture: looksReadOnly,
          }),
      },
    );
    options.log(`channels    ${result.channels.map((channel) => channel.channel).join(", ")}`);

    const entries = collector.all();
    const report = collector.stageReport();
    const completion = assessCompletion(entries, {
      timeMode: options.time.mode,
      declaredSubjects: options.subjects.length,
    });
    const missing = completion.missing;
    for (const name of missing) {
      const conditional =
        !completion.unexpected_missing.includes(name) ? " (not selected by this request)" : "";
      options.log(`WARNING     stage '${name}' produced no statement${conditional}`);
    }
    for (const reason of completion.reasons) options.log(`INCOMPLETE  ${reason}`);

    const artifact = buildArtifact({
      options,
      facts,
      entries,
      missing,
      completion,
      wallMs: Date.now() - started,
      heldScopes: scopeIds.length,
      embeddings: {
        model_id: embeddings.model_id,
        dimensions: embeddings.dimensions,
        is_model_call: embeddings.isModelCall,
      },
    });

    /**
     * Refuse to write an artifact that carries a secret.
     *
     * This runs on the assembled object rather than trusting the sanitizer, because the
     * sanitizer's coverage is a claim about which fields PostgreSQL fills with values, and a
     * claim is not a proof. The probes are the values this specific run actually handled, so a
     * leak of any one of them is caught even if it arrived through a field nobody anticipated.
     */
    const probes: SecretProbe[] = [
      { label: "tenant id", value: facts.tenantId },
      { label: "tenant slug", value: options.tenant },
      { label: "principal", value: facts.principal },
      { label: "query text", value: options.query },
      ...scopeIds.map((scope, i) => ({ label: `held scope ${i}`, value: scope })),
      ...options.subjects.map((subject, i) => ({ label: `declared subject ${i}`, value: subject })),
      ...(databaseUrl === null ? [] : [{ label: "database url", value: databaseUrl }]),
      ...(migrationUrl === null ? [] : [{ label: "migration url", value: migrationUrl }]),
    ];
    const leaked = findLeaks(artifact, probes);
    if (leaked.length > 0) {
      throw new Error(
        `refusing to write ${output}: the artifact contains ${leaked
          .map((probe) => probe.label)
          .join(", ")}. This is a sanitization defect, not an input problem — the plan fields ` +
          `carry bound values and one has survived. Nothing was written.`,
      );
    }
    const markers = findMarkers(artifact, ["postgres://", "postgresql://", "password", "bearer "]);
    if (markers.length > 0) {
      throw new Error(
        `refusing to write ${output}: the artifact contains ${markers.join(", ")}, which is a ` +
          `credential or a connection string. Nothing was written.`,
      );
    }

    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    return { artifact, output, completion };
  } finally {
    await app.close();
    await admin.close();
  }
}

/**
 * Why a stage may legitimately be absent, or absent only under a condition.
 *
 * The point of writing this down is that "the stage is missing" and "the request did not
 * select the stage" are different outcomes with different responses, and an artifact that
 * cannot distinguish them is not evidence. Each entry states the condition under which
 * absence is acceptable; anything else is a failure.
 */
export interface StageCompletion {
  readonly complete: boolean;
  readonly missing: readonly RetrievalStage[];
  readonly unexpected_missing: readonly RetrievalStage[];
  readonly failed: readonly RetrievalStage[];
  readonly duplicated: readonly RetrievalStage[];
  readonly unlabeled: number;
  readonly reasons: readonly string[];
}

/**
 * Decide whether a capture is complete.
 *
 * A stage is *unexpectedly* missing when it is required and the request selected it. The
 * two conditional channels are the only ones whose absence is ever acceptable:
 *
 *   * `relation_channel` is planned only for caller-declared subjects;
 *   * `temporal_channel` issues no statement unless the time mode is `during`.
 *
 * Everything else — and any captured statement without a stage name, or a stage that failed
 * to plan — makes the capture incomplete. Callers treat `complete: false` as a non-zero
 * exit, because a capture with a hole in it is the failure this whole artifact exists to
 * make visible.
 */
export function assessCompletion(
  stages: readonly { readonly stage: RetrievalStage; readonly success: boolean }[],
  request: { readonly timeMode: string; readonly declaredSubjects: number },
): StageCompletion {
  const counts = new Map<string, number>();
  for (const stage of stages) counts.set(stage.stage, (counts.get(stage.stage) ?? 0) + 1);

  const conditional = new Set<string>(["relation_channel", "temporal_channel"]);
  const unconditional: readonly string[] = REQUIRED_STAGES.filter((stage) => !conditional.has(stage));
  const missing: RetrievalStage[] = REQUIRED_STAGES.filter((stage) => !counts.has(stage));
  const unexpected: RetrievalStage[] = missing.filter((stage) => unconditional.includes(stage));

  const reasons: string[] = [];
  if (request.timeMode === "during" && missing.includes("temporal_channel")) {
    unexpected.push("temporal_channel");
    reasons.push(
      "temporal_channel produced no statement for a during request, which is not a conditional absence",
    );
  }
  if (request.declaredSubjects > 0 && missing.includes("relation_channel")) {
    unexpected.push("relation_channel");
    reasons.push(
      "relation_channel produced no statement although subjects were declared, which is not a conditional absence",
    );
  }

  const failed = stages.filter((stage) => !stage.success).map((stage) => stage.stage);
  if (failed.length > 0) {
    reasons.push(`${failed.length} stage(s) failed to produce a plan: ${failed.join(", ")}`);
  }

  // Each stage is expected at most once. A repeat means two statements were attributed to
  // one stage, which would hide a statement's real name — the mislabelling defect this
  // module has already produced once.
  const duplicated: RetrievalStage[] = [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([name]) => name as RetrievalStage);
  if (duplicated.length > 0) {
    reasons.push(
      `${duplicated.length} stage(s) captured more than one statement, so at least one is ` +
        `mislabelled: ${duplicated.join(", ")}`,
    );
  }

  const unlabeled = counts.get("unlabeled") ?? 0;
  if (unlabeled > 0) {
    reasons.push(
      `${unlabeled} statement(s) were captured without a stage name, so the artifact cannot say what they are`,
    );
  }

  return {
    complete: unexpected.length === 0 && failed.length === 0 && duplicated.length === 0 && unlabeled === 0,
    missing,
    unexpected_missing: unexpected,
    failed,
    duplicated,
    unlabeled,
    reasons,
  };
}

interface BuildInput {
  readonly options: PlanCaptureOptions;
  readonly facts: PreflightFacts;
  readonly entries: readonly StageCapture[];
  readonly missing: readonly RetrievalStage[];
  readonly completion: StageCompletion;
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
      time_mode: options.time.mode,
      /** The resolved window, when the mode has one. Echoed so the artifact is self-contained. */
      time_window:
        options.time.mode === "during"
          ? { from: options.time.from, to: options.time.to }
          : options.time.mode === "as_of"
            ? { as_of: options.time.as_of }
            : null,
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
      /** Missing stages the request *did* select, which is the only kind that is a defect. */
      unexpectedly_missing_stages: input.completion.unexpected_missing,
      failed_stages: input.completion.failed,
      duplicated_stages: input.completion.duplicated,
      unlabeled_statements: input.completion.unlabeled,
      /** The single field a caller should branch on. */
      complete: input.completion.complete,
      /** Why it is not complete, in the words of the check that failed. */
      incompleteness_reasons: input.completion.reasons,
    },
    stages: entries,
  };
}
