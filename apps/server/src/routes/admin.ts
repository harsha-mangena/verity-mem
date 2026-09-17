/**
 * Administrative routes: grants, forgetting, replay, evaluation.
 *
 * Every route in this file is behind two independent checks, and the order matters.
 * The *audience* check runs first: the credential must be part of the `admin`
 * audience. Then the *tool* check: the profile must hold the operation. An agent
 * token reaching `/v1/grants` therefore fails the audience check and receives 403 —
 * the token is valid, the audience is wrong — which is the distinction an operator
 * needs, because a 401 sends them looking for a missing credential and the actual
 * problem is that the credential was never meant to be here.
 *
 * The tenant is always derived from the credential. `/v1/forget` is the case that
 * makes this concrete: a body naming a different tenant would otherwise let an
 * administrator of one tenant erase another tenant's data, and the erase would run
 * under `withSystemContext` — the one binding that reaches every row in its tenant.
 * A tenant mismatch is refused before that binding is ever taken.
 */
import type { FastifyInstance } from "fastify";
import {
  ForgetRequestSchema,
  ForgetResponseSchema,
  GrantCreateRequestSchema,
  GrantCreateResponseSchema,
  GrantDeleteResponseSchema,
  ReplayRequestSchema,
  ReplayResultResponseSchema,
  RetentionJobSchema,
  EvaluationRunRequestSchema,
  EvaluationRunResultSchema,
  type EvaluationRunRequest,
  type ForgetRequest,
  type Grant,
  type GrantCreateRequest,
  type GrantDeleteResponse,
  type ReplayRequest,
  type RetentionJob,
} from "@veritymem/contracts";
import {
  digestLexicalProjection,
  forget,
  readRetentionJob,
  rebuildProjections,
  type ForgetManifest,
} from "@veritymem/retrieval";
import { requireAdminTool } from "../auth.ts";
import { resolveCallerTenant, tenantFromCredential, withWriteContext } from "../context.ts";
import type { ServerDeps } from "../config.ts";
import { ApiError, notFound } from "../errors.ts";
import { requireId, stripPrefix } from "../views.ts";

const GrantIdParamsSchema = {
  type: "object",
  required: ["grant_id"],
  additionalProperties: false,
  properties: { grant_id: { type: "string", minLength: 1, maxLength: 128 } },
} as const;

const JobIdParamsSchema = {
  type: "object",
  required: ["job_id"],
  additionalProperties: false,
  properties: { job_id: { type: "string", minLength: 1, maxLength: 128 } },
} as const;

export interface AdminRouteOptions {
  readonly deps: ServerDeps;
}

export function registerAdminRoutes(app: FastifyInstance, options: AdminRouteOptions): void {
  const { deps } = options;

  // -------------------------------------------------------------------------
  // Grants
  // -------------------------------------------------------------------------

  app.post(
    "/v1/grants",
    {
      schema: {
        tags: ["admin"],
        summary: "Create a grant",
        description:
          "A grant is the mechanism for reaching a scope the subject does not participate in. Its resource pattern is parsed into a dimension matrix at write time, because grant matching is per-dimension and a concatenated namespace is how purpose and tenant boundaries get lost.",
        body: GrantCreateRequestSchema,
        response: { 201: GrantCreateResponseSchema },
      },
    },
    async (request, reply) => {
      const caller = requireAdminTool(request, "memory.share");
      const body = request.body as GrantCreateRequest;
      const context = resolveCallerTenant({
        identity: caller,
        requestTenant: body.resource_pattern.tenant,
        what: "POST /v1/grants",
      });

      // A grant may only name dimensions and purposes, not a tenant: the tenant is the
      // credential's, and `ScopeSelectorSchema` requires one only because a selector
      // must always be unambiguous about which tenant it selects within.
      const matrix = {
        ...(body.resource_pattern.project !== undefined ? { project: body.resource_pattern.project } : {}),
        ...(body.resource_pattern.user !== undefined ? { user: body.resource_pattern.user } : {}),
        ...(body.resource_pattern.agent !== undefined ? { agent: body.resource_pattern.agent } : {}),
        ...(body.resource_pattern.session !== undefined ? { session: body.resource_pattern.session } : {}),
      };
      if (Object.keys(matrix).length === 0) {
        throw new ApiError(
          "validation_failed",
          "a grant must name at least one of project, user, agent or session; a grant that names none reaches the whole tenant",
          400,
        );
      }

      const grantId = deps.ids.next("grt");
      const createdAt = deps.clock.now().toISOString();
      const row = await deps.db.withRequest(
        {
          tenant: context.tenantId,
          principal: context.principal,
          scopeIds: [],
          purposes: body.purpose,
          action: "grant:create",
        },
        async (executor) => {
          await executor.query(
            `INSERT INTO grants (
               grant_id, tenant_id, subject, resource_pattern, actions, purpose, matrix, created_at, expires_at
             ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::text[], $6::text[], $7::jsonb, $8::timestamptz, $9::timestamptz)
             ON CONFLICT (grant_id) DO NOTHING`,
            [
              stripPrefix(grantId),
              context.tenantId,
              body.subject,
              JSON.stringify(body.resource_pattern),
              [...body.actions],
              [...body.purpose],
              JSON.stringify(matrix),
              createdAt,
              body.expires_at ?? null,
            ],
          );
          const found = await executor.query<GrantRow>(
            `SELECT grant_id, subject, resource_pattern, actions, purpose, created_at, expires_at
               FROM grants WHERE grant_id = $1::uuid`,
            [stripPrefix(grantId)],
          );
          return found.rows[0] ?? null;
        },
      );
      if (!row) throw notFound("grant");

      const grant: Grant = {
        grant_id: `grt_${stripPrefix(row.grant_id).replace(/-/g, "")}`,
        tenant: context.tenant,
        subject: row.subject,
        resource_pattern: parseResourcePattern(row.resource_pattern, context.tenant),
        actions: [...row.actions],
        purpose: [...row.purpose],
        created_at: toIso(row.created_at),
        expires_at: row.expires_at === null ? null : toIso(row.expires_at),
      };
      await reply.code(201).send({ grant, created: true });
    },
  );

  app.delete(
    "/v1/grants/:grant_id",
    {
      schema: {
        tags: ["admin"],
        summary: "Revoke a grant",
        description:
          "Deletion is immediate and total: the planner reads live grants on every query, so a revoked grant stops reaching scopes on the next request rather than at the next cache expiry.",
        params: GrantIdParamsSchema,
        response: { 200: GrantDeleteResponseSchema },
      },
    },
    async (request, reply) => {
      const caller = requireAdminTool(request, "memory.share");
      const params = request.params as { grant_id: string };
      requireId(params.grant_id, "grt", "grant_id");
      const context = tenantFromCredential({ identity: caller, what: "DELETE /v1/grants" });

      const deleted = await deps.db.withRequest(
        {
          tenant: context.tenantId,
          principal: context.principal,
          scopeIds: [],
          purposes: [],
          action: "grant:revoke",
        },
        async (executor) => {
          const result = await executor.query(
            `DELETE FROM grants WHERE grant_id = $1::uuid`,
            [stripPrefix(params.grant_id)],
          );
          return (result.rowCount ?? 0) > 0;
        },
      );

      const response: GrantDeleteResponse = { grant_id: params.grant_id, deleted };
      await reply.code(200).send(response);
    },
  );

  // -------------------------------------------------------------------------
  // Forgetting
  // -------------------------------------------------------------------------

  app.post(
    "/v1/forget",
    {
      schema: {
        tags: ["admin"],
        summary: "Erase or redact a subject's data, with a verified manifest",
        description:
          "Runs the scrub and then the residual scan. The job reports `verified` only when the scan returns zero; the ledger row survives redaction so the system can still testify the event existed.",
        body: ForgetRequestSchema,
        response: { 201: ForgetResponseSchema },
      },
    },
    async (request, reply) => {
      const caller = requireAdminTool(request, "memory.forget");
      const body = request.body as ForgetRequest;
      const context = resolveCallerTenant({
        identity: caller,
        requestTenant: body.subject_or_scope.tenant,
        what: "POST /v1/forget",
      });

      const request1 = {
        tenant_id: context.tenantId,
        tenant_slug: context.tenant,
        subject_or_scope: {
          ...(body.subject_or_scope.project !== undefined ? { project: body.subject_or_scope.project } : {}),
          ...(body.subject_or_scope.user !== undefined ? { user: body.subject_or_scope.user } : {}),
          ...(body.subject_or_scope.agent !== undefined ? { agent: body.subject_or_scope.agent } : {}),
          ...(body.subject_or_scope.session !== undefined ? { session: body.subject_or_scope.session } : {}),
          ...(body.subject_or_scope.actor_id !== undefined ? { actor_id: body.subject_or_scope.actor_id } : {}),
          ...(body.subject_or_scope.subject !== undefined ? { subject: body.subject_or_scope.subject } : {}),
        },
        reason: body.reason,
        ...(body.mode !== undefined ? { mode: body.mode } : {}),
      };

      const outcome = await forget({ db: deps.db, ledger: deps.ledger, ids: deps.ids, clock: deps.clock }, request1);
      const job = await readRetentionJob(
        { db: deps.db, ledger: deps.ledger, ids: deps.ids, clock: deps.clock },
        context.tenantId,
        outcome.job_id,
      );

      // The contract's `tenant` is the slug the API addresses tenants by. `forget()`
      // and `readRetentionJob()` work in UUIDs, so the slug is restored here rather
      // than at each call: a client should never see a UUID in a field that takes a
      // slug everywhere else.
      await reply.code(201).send(
        job
          ? { ...job, tenant: context.tenant }
          : manifestToJob(outcome.manifest, outcome.job_id, context.tenant, body),
      );
    },
  );

  app.get(
    "/v1/forget/:job_id",
    {
      schema: {
        tags: ["admin"],
        summary: "Poll a retention job",
        description:
          "`residual_matches` must be 0 before the job reports `verified`. Null means the scan has not run, which is not the same claim as zero.",
        params: JobIdParamsSchema,
        response: { 200: ForgetResponseSchema },
      },
    },
    async (request, reply) => {
      const caller = requireAdminTool(request, "memory.forget");
      const params = request.params as { job_id: string };
      requireId(params.job_id, "ret", "job_id");
      const context = tenantFromCredential({ identity: caller, what: "GET /v1/forget" });

      const job = await readRetentionJob(
        { db: deps.db, ledger: deps.ledger, ids: deps.ids, clock: deps.clock },
        context.tenantId,
        params.job_id,
      );
      if (!job) throw notFound("retention job");
      await reply.code(200).send({ ...job, tenant: context.tenant });
    },
  );

  // -------------------------------------------------------------------------
  // Replay
  // -------------------------------------------------------------------------

  app.post(
    "/v1/replay",
    {
      schema: {
        tags: ["admin"],
        summary: "Verify or rebuild the disposable projections",
        description:
          "`verify` computes a digest of the projections as they stand and reports whether a rebuild reproduces it; `rebuild` performs the rebuild and reports whether the result is byte-identical. Deterministic given a fixed ledger, code version, model id and policy version — which is the whole reason the projections are disposable.",
        body: ReplayRequestSchema,
        response: { 200: ReplayResultResponseSchema },
      },
    },
    async (request, reply) => {
      const caller = requireAdminTool(request, "memory.replay");
      const body = request.body as ReplayRequest;
      const context = tenantFromCredential({ identity: caller, what: "POST /v1/replay" });

      const started = Date.now();
      const mode = body.mode ?? "verify";
      // Annotated because the fallback array would otherwise widen to `string[]`, and
      // the `has` checks below would stop being checked against the closed set of
      // projection names.
      //
      // The names are the contract's, and the contract was changed to match the
      // implementation rather than the other way round.
      //
      // This route previously spoke `search` / `embeddings` while the request schema,
      // `@veritymem/retrieval` and the evaluation harness all spoke `lexical` / `dense`.
      // The intent was that the API would name the *store* and the code the *channel*,
      // which sounds principled and cost a real defect: `ReplayRequestSchema` validated
      // against one vocabulary while the route matched against another, so a request
      // naming a projection that exists was refused by a route that had never heard of
      // it. Two names for one concept need a translation layer, and a translation layer
      // is a second place for the mapping to be wrong.
      const wanted = new Set<"dense" | "lexical" | "entities">(
        body.projections ?? ["dense", "lexical", "entities"],
      );

      // Bound to the administrator's reach rather than taken as a system context, and
      // this is the difference between a replay that proves something and one that
      // proves nothing. `withSystemContext` sets an empty purpose array, and since
      // migration 0006 the authorization predicate denies an empty purpose set outright
      // — so a "rebuild" under it would rebuild from zero rows, produce a digest of the
      // empty set, and report the projections byte-identical. A replay oracle that can
      // only ever see nothing always passes.
      const outcome = await withWriteContext(deps, context, "replay", async (executor) => {
        const lexicalBefore = wanted.has("lexical")
          ? await digestLexicalProjection(executor, context.tenantId)
          : null;
        // The dense digest is taken by reading the projected rows without truncating, so
        // the "before" measurement is the real current state rather than the state a
        // rebuild would produce — otherwise `byte_identical` would be true by
        // construction and would prove nothing.
        const denseBefore = wanted.has("dense")
          ? await rebuildProjections(executor, { db: deps.db, embeddings: deps.embeddings }, {
              tenantId: context.tenantId,
              truncate: false,
            })
          : null;
        const entityCountBefore = wanted.has("entities")
          ? await countEntityAliases(executor, context.tenantId)
          : null;

        const results: ProjectionDigestRow[] = [];
        // Only the projections whose digest is comparable in both directions count toward
        // determinism. The entity projection is excluded on purpose: aliases are never
        // deleted on a claim's revocation, so a rebuild adds rows and a "byte-identical"
        // assertion over it would be false forever. Reporting that as non-determinism
        // would hide a real replay failure behind a known one.
        let deterministic = true;

        if (lexicalBefore) {
          const lexicalAfter = await digestLexicalProjection(executor, context.tenantId);
          results.push({
            projection: "lexical",
            digest_before: lexicalBefore.digest,
            digest_after: lexicalAfter.digest,
            rows_before: lexicalBefore.rows,
            rows_after: lexicalAfter.rows,
            byte_identical: lexicalBefore.digest === lexicalAfter.digest,
          });
          deterministic &&= lexicalBefore.digest === lexicalAfter.digest;
        }

        if (denseBefore) {
          const denseAfter = await rebuildProjections(executor, { db: deps.db, embeddings: deps.embeddings }, {
            tenantId: context.tenantId,
          });
          results.push({
            projection: "dense",
            digest_before: denseBefore.digest,
            digest_after: denseAfter.digest,
            rows_before: denseBefore.rows,
            rows_after: denseAfter.rows,
            byte_identical: denseBefore.digest === denseAfter.digest,
          });
          deterministic &&= denseBefore.digest === denseAfter.digest;
        }

        if (entityCountBefore !== null) {
          const entityAfter = await countEntityAliases(executor, context.tenantId);
          results.push({
            projection: "entities",
            digest_before: null,
            digest_after: String(entityAfter),
            rows_before: entityCountBefore,
            rows_after: entityAfter,
            // Entity aliases are inserted with `ON CONFLICT DO NOTHING` and are never
            // deleted on a claim's revocation, by design: an alias is many-to-many and
            // deleting it would break the other claims that rely on it. So the honest
            // assertion here is that a rebuild does not *lose* aliases, not that the row
            // count is unchanged.
            byte_identical: entityAfter >= entityCountBefore,
          });
        }

        const watermark = await executor.query<{ watermark: number }>(
          `SELECT COALESCE(max(seq), 0)::int AS watermark FROM events WHERE tenant_id = $1::uuid`,
          [context.tenantId],
        );

        return {
          results,
          deterministic,
          watermark: Number(watermark.rows[0]?.watermark ?? 0),
        };
      });

      await reply.code(200).send({
        tenant: context.tenant,
        mode,
        ledger_watermark: outcome.watermark,
        code_version: "server@0.1.0",
        policy_version: deps.policy.version,
        projections: outcome.results,
        deterministic: outcome.deterministic,
        duration_ms: Date.now() - started,
      });
    },
  );

  // -------------------------------------------------------------------------
  // Evaluations
  // -------------------------------------------------------------------------

  app.post(
    "/v1/evaluations/runs",
    {
      schema: {
        tags: ["admin"],
        summary: "Run an evaluation suite",
        description:
          "The suite itself — LedgerBench, the poisoning fixtures, the deletion fixtures — lives in the offline harness and is not part of this server. This route reports an honest 'not wired here' rather than an invented metric; see the README.",
        body: EvaluationRunRequestSchema,
        response: { 202: EvaluationRunResultSchema },
      },
    },
    async (request, reply) => {
      const caller = requireAdminTool(request, "memory.evaluate");
      const body = request.body as EvaluationRunRequest;
      const context = tenantFromCredential({ identity: caller, what: "POST /v1/evaluations/runs" });

      const startedAt = deps.clock.now().toISOString();
      const runId = deps.ids.next("evr");
      const fixturesDir = body.fixtures_dir ?? `${deps.config.env.repoRoot}/fixtures`;
      const suite = body.suite ?? "ledgerbench";

      await reply.code(202).send({
        run_id: runId,
        suite,
        gate: body.gate ?? "on",
        seed: body.seed ?? 1,
        policy_version: deps.policy.version,
        gate_backend: deps.entailment.name,
        stages: [],
        targets: [],
        duration_ms: 0,
        started_at: startedAt,
        notes: [
          `no evaluation runner is wired into this deployment, so no stage ran and no metric is reported`,
          `suite '${suite}' is executed by the offline LedgerBench harness, which owns the fixtures and publishes the raw traces`,
          `expected fixtures directory: ${fixturesDir}`,
          `gate backend in force: ${deps.entailment.name}; a run reported without this value would be unattributable`,
        ],
      });
    },
  );
}

interface GrantRow {
  grant_id: string;
  subject: string;
  resource_pattern: string;
  actions: string[];
  purpose: string[];
  created_at: Date | string;
  expires_at: Date | string | null;
  [column: string]: unknown;
}

interface ProjectionDigestRow {
  projection: string;
  digest_before: string | null;
  digest_after: string;
  rows_before: number | null;
  rows_after: number;
  byte_identical: boolean;
}

/**
 * Parse the stored resource pattern back into a selector.
 *
 * The tenant is supplied by the caller context rather than read from the stored JSON:
 * a grant belongs to the tenant that created it, and trusting a tenant embedded in a
 * JSON blob written at an earlier time is how a grant survives a rename into the
 * wrong tenant.
 */
function parseResourcePattern(stored: string, tenant: string): Grant["resource_pattern"] {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(stored) as unknown;
    if (value !== null && typeof value === "object") parsed = value as Record<string, unknown>;
  } catch {
    // A pattern that will not parse reaches nothing rather than everything. The
    // planner matches by dimension, and an empty matrix has no clause to match on.
    parsed = {};
  }
  return {
    tenant,
    ...(typeof parsed["project"] === "string" ? { project: parsed["project"] } : {}),
    ...(typeof parsed["user"] === "string" ? { user: parsed["user"] } : {}),
    ...(typeof parsed["agent"] === "string" ? { agent: parsed["agent"] } : {}),
    ...(typeof parsed["session"] === "string" ? { session: parsed["session"] } : {}),
  };
}

async function countEntityAliases(
  executor: Parameters<typeof digestLexicalProjection>[0],
  tenantId: string,
): Promise<number> {
  const result = await executor.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM entity_aliases WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * The job row shaped like the contract, for the case where `retention_jobs` has not
 * been written yet.
 *
 * Only reachable if the insert inside `forget()` failed after its scrub committed,
 * which the implementation makes impossible by construction — but a response handler
 * that assumed it could not happen would return `undefined` and crash the request,
 * turning a storage wobble into a 500 on the one route where the operator most needs
 * an answer.
 */
function manifestToJob(
  manifest: ForgetManifest,
  jobId: string,
  tenant: string,
  body: ForgetRequest,
): RetentionJob {
  return {
    job_id: jobId,
    tenant,
    subject_or_scope: body.subject_or_scope,
    mode: manifest.mode,
    reason: manifest.reason,
    status: manifest.residual_matches === 0 ? "verified" : "failed",
    stores_touched: manifest.stores.map((store) => store.store),
    manifest,
    residual_matches: manifest.residual_matches,
    created_at: manifest.started_at,
    updated_at: manifest.completed_at,
    verified_at: manifest.residual_matches === 0 ? manifest.completed_at : null,
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

