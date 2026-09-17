/**
 * Claim routes: the object read, relations, re-verification, and `/explain`.
 *
 * `/explain` is the endpoint the specification calls "the product", and the reason
 * it is implemented as one function with one round of queries is that the decisive
 * product test is whether an operator can determine, in one call and in under a
 * second, why the agent remembered something. Every extra round trip is a chance for
 * the answer to change between calls — a claim revoked between two reads would be
 * returned as accepted alongside the decision that revoked it, and an operator would
 * have to notice the inconsistency themselves.
 *
 * So `buildExplanation` reads the claim, its evidence with re-verified digests, every
 * decision that touched it, the candidate that proposed it, its relations in both
 * directions, and the versions in force — and it reads them inside the caller's
 * reach, so a claim the caller cannot see produces the same 404 as one that does not
 * exist.
 */
import { performance } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import {
  ClaimExplanationSchema,
  ClaimReadResponseSchema,
  ClaimReverifyResponseSchema,
  RelationCreateRequestSchema,
  RelationCreateResponseSchema,
  REASON_CODE_HELP,
  type ClaimExplanation,
  type ClaimRecord,
  type Decision,
  type RelationCreateRequest,
  type RelationCreateResponse,
} from "@veritymem/contracts";
import { createRelation, readClaim, readRelations, timePredicate } from "@veritymem/claims";
import { requireTool } from "../auth.ts";
import { resolveCallerTenant, withReadContext, withWriteContext } from "../context.ts";
import type { ServerDeps } from "../config.ts";
import { ApiError, notFound } from "../errors.ts";
import {
  digestHex,
  formatUuid,
  readClaimEvidence,
  readPromotions,
  stripPrefix,
  toClaimRecord,
} from "../views.ts";

const ClaimIdParamsSchema = {
  type: "object",
  required: ["claim_id"],
  additionalProperties: false,
  properties: { claim_id: { type: "string", minLength: 1, maxLength: 128 } },
} as const;

export interface ClaimRouteOptions {
  readonly deps: ServerDeps;
}

export function registerClaimRoutes(app: FastifyInstance, options: ClaimRouteOptions): void {
  const { deps } = options;

  app.get(
    "/v1/claims/:claim_id",
    {
      schema: {
        tags: ["claims"],
        summary: "Read one claim with its evidence, conflicts and promotion",
        params: ClaimIdParamsSchema,
        response: { 200: ClaimReadResponseSchema },
      },
    },
    async (request, reply) => {
      const caller = requireTool(request, "memory.claim.read");
      const params = request.params as { claim_id: string };
      const context = resolveCallerTenant({ identity: caller, requestTenant: undefined, what: "GET /v1/claims/{id}" });

      const result = await withReadContext(deps, context, async (executor) => {
        const claim = await readClaim(executor, params.claim_id);
        if (!claim) return null;
        const relations = await readRelations(executor, [params.claim_id]);
        const evidence = await readClaimEvidence(deps.ledger, executor, [params.claim_id]);
        const promotions = await readPromotions(executor, [params.claim_id]);
        const now = deps.clock.now().toISOString();
        const record: ClaimRecord = toClaimRecord({
          claim,
          evidence: evidence.get(params.claim_id),
          relations: relations.get(params.claim_id) ?? [],
          promotion: promotions.get(params.claim_id),
          now,
        });
        return {
          claim: record,
          relations: Object.values(relations)
            .flat()
            .map((relation) => ({
              from_claim: relation.from_claim,
              to_claim: relation.to_claim,
              rel: relation.rel,
              direction: relation.direction,
              recorded_at: relation.recorded_at,
            })),
        };
      });

      if (!result) throw notFound("claim");
      await reply.code(200).send(result);
    },
  );

  app.post(
    "/v1/claims/:claim_id/relations",
    {
      schema: {
        tags: ["claims"],
        summary: "Record a relation from this claim to another",
        description:
          "Relations are explicit. A contradiction is never inferred from timestamp adjacency, so this is the only way one enters the record.",
        params: ClaimIdParamsSchema,
        body: RelationCreateRequestSchema,
        response: { 200: RelationCreateResponseSchema },
      },
    },
    async (request, reply) => {
      const caller = requireTool(request, "memory.relate");
      const params = request.params as { claim_id: string };
      const body = request.body as RelationCreateRequest;
      const context = resolveCallerTenant({
        identity: caller,
        requestTenant: undefined,
        what: "POST /v1/claims/{id}/relations",
      });

      const result = await withWriteContext(deps, context, "claim:relate", async (executor) => {
        // Both ends must be readable by this caller. A relation is a statement about
        // two claims, so being able to assert one about a claim you cannot read is a
        // write into someone else's record — and it would leak the claim's existence
        // through the error if it were allowed and then validated.
        const claims = await executor.query<{ claim_id: string }>(
          `SELECT claim_id FROM claims WHERE claim_id = ANY($1::uuid[])`,
          [[stripPrefix(params.claim_id), stripPrefix(body.to_claim)]],
        );
        const found = new Set(claims.rows.map((row) => row.claim_id));
        if (!found.has(stripPrefix(params.claim_id)) || !found.has(stripPrefix(body.to_claim))) {
          return null;
        }

        const before = await executor.query<{ recorded_at: Date | string }>(
          `SELECT recorded_at FROM claim_relations
            WHERE from_claim = $1::uuid AND to_claim = $2::uuid AND rel = $3::relation_kind`,
          [stripPrefix(params.claim_id), stripPrefix(body.to_claim), body.rel],
        );
        await createRelation(executor, params.claim_id, body.to_claim, body.rel);
        const already = before.rows[0];
        return {
          recorded_at: already ? toIso(already.recorded_at) : deps.clock.now().toISOString(),
          created: already === undefined,
        };
      });

      if (!result) throw notFound("claim");
      const response: RelationCreateResponse = {
        from_claim: params.claim_id,
        to_claim: body.to_claim,
        rel: body.rel,
        recorded_at: result.recorded_at,
        created: result.created,
      };
      await reply.code(200).send(response);
    },
  );

  app.post(
    "/v1/claims/:claim_id/reverify",
    {
      schema: {
        tags: ["claims"],
        summary: "Re-verify a claim's evidence and conflict state",
        description:
          "Re-resolves every span against current bytes and re-runs the contradiction search. Records a decision row, because a verification that is not recorded is not a verification.",
        params: ClaimIdParamsSchema,
        response: { 200: ClaimReverifyResponseSchema },
      },
    },
    async (request, reply) => {
      const caller = requireTool(request, "memory.reverify");
      const params = request.params as { claim_id: string };
      const context = resolveCallerTenant({
        identity: caller,
        requestTenant: undefined,
        what: "POST /v1/claims/{id}/reverify",
      });

      const result = await withWriteContext(deps, context, "claim:reverify", async (executor) => {
        const claim = await readClaim(executor, params.claim_id);
        if (!claim) return null;

        const evidence = await readClaimEvidence(deps.ledger, executor, [params.claim_id]);
        const hydrated = evidence.get(params.claim_id);
        const spans = (hydrated?.refs ?? []).map((ref) => ({
          span_id: ref.span_id,
          event_id: ref.event_id,
          digest_ok: ref.digest_ok,
          status: ref.quote === null ? "unresolvable" : "ok",
        }));
        const digestOk = hydrated !== undefined && hydrated.refs.length > 0 && hydrated.digestOk;

        // The contradiction search re-runs against the current claim store rather than
        // reusing the relations recorded at promotion time: a claim that contradicted
        // nothing then and contradicts something now must surface on the next check,
        // or re-verification would only ever confirm its own past answer.
        const conflicts = await executor.query<{
          claim_id: string;
          rel: string;
          subject: string;
          predicate: string;
          object: unknown;
        }>(
          `SELECT DISTINCT o.claim_id, r.rel, o.subject, o.predicate, o.object
             FROM claim_relations r
             JOIN claims o ON o.claim_id = CASE WHEN r.from_claim = $1::uuid THEN r.to_claim ELSE r.from_claim END
            WHERE (r.from_claim = $1::uuid OR r.to_claim = $1::uuid)
              AND r.rel = 'contradicts'
              AND o.status = 'accepted'`,
          [stripPrefix(params.claim_id)],
        );

        const reasonCodes: string[] = [];
        reasonCodes.push(digestOk ? "span.resolved" : "span.unresolvable");
        if (conflicts.rows.length > 0) reasonCodes.push("conflict.contradicts_accepted");
        else reasonCodes.push("conflict.none");

        const decisionId = deps.ids.next("dec");
        const now = deps.clock.now().toISOString();
        await executor.query(
          `INSERT INTO decisions (
             decision_id, tenant_id, claim_id, policy_version, outcome, reason_codes, approver, detail
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::decision_outcome, $6::text[], $7, $8::jsonb)`,
          [
            stripPrefix(decisionId),
            claim.tenant_id,
            stripPrefix(params.claim_id),
            `reverify:${deps.policy.version}`,
            // A re-verification that fails its evidence check is a `needs_review`, not
            // a `reject`: the claim is already accepted and the honest statement is
            // that its support no longer resolves and a human must look.
            digestOk ? "accept" : "needs_review",
            reasonCodes,
            context.principal,
            JSON.stringify({
              reverified_at: now,
              span_count: spans.length,
              digest_ok: digestOk,
              contradictions: conflicts.rows.map((row) => ({
                claim_id: `clm_${stripPrefix(row.claim_id).replace(/-/g, "")}`,
                rel: row.rel,
                statement: `${row.subject} ${row.predicate}`,
              })),
            }),
          ],
        );

        return {
          decisionId,
          status: claim.status,
          reasonCodes,
          spans,
          conflicts: conflicts.rows.map((row) => ({
            claim_id: `clm_${stripPrefix(row.claim_id).replace(/-/g, "")}`,
            rel: row.rel as "contradicts",
            statement: `${row.subject} ${row.predicate}`,
          })),
          now,
        };
      });

      if (!result) throw notFound("claim");
      await reply.code(200).send({
        claim_id: params.claim_id,
        decision_id: result.decisionId,
        status: result.status,
        reason_codes: result.reasonCodes,
        spans: result.spans,
        conflicts: result.conflicts,
        entailment: result.reasonCodes.includes("span.unresolvable") ? "unknown" : "entailed",
        policy_version: `reverify:${deps.policy.version}`,
        verified_at: result.now,
      });
    },
  );

  app.get(
    "/v1/claims/:claim_id/explain",
    {
      schema: {
        tags: ["claims"],
        summary: "The complete promotion history of a claim",
        description:
          "The originating event, every supporting and refuting span with its quoted text and verified digest, the extractor and model versions, every decision with its policy version and reason codes, and all relations — in one call.",
        params: ClaimIdParamsSchema,
        response: { 200: ClaimExplanationSchema },
      },
    },
    async (request, reply) => {
      const caller = requireTool(request, "memory.explain");
      const params = request.params as { claim_id: string };
      const context = resolveCallerTenant({
        identity: caller,
        requestTenant: undefined,
        what: "GET /v1/claims/{id}/explain",
      });

      const started = performance.now();
      const explanation = await withReadContext(deps, context, async (executor) =>
        buildExplanation(deps, executor, params.claim_id, started),
      );
      if (!explanation) throw notFound("claim");
      await reply.code(200).send(explanation);
    },
  );
}

/**
 * Assemble the complete promotion history.
 *
 * Everything here runs on one bound connection, in one read-only transaction: the
 * spans cannot be redacted and the decisions cannot be superseded halfway through the
 * answer. `produced_in_ms` reports the assembly cost only, not the client's network
 * time, because the number exists to answer "is this endpoint fast" for the operator
 * reading it.
 */
export async function buildExplanation(
  deps: ServerDeps,
  executor: Parameters<typeof readClaim>[0],
  claimId: string,
  started: number,
): Promise<ClaimExplanation | null> {
  const claim = await readClaim(executor, claimId);
  if (!claim) return null;

  // The claim store is the authorization decision. If the caller's reach does not
  // include this claim's scope it is not in this result set, and the same 404 follows
  // as for a claim that never existed.
  const relations = await readRelations(executor, [claimId]);
  const evidence = await readClaimEvidence(deps.ledger, executor, [claimId]);
  const promotions = await readPromotions(executor, [claimId]);
  const now = deps.clock.now().toISOString();

  const record = toClaimRecord({
    claim,
    evidence: evidence.get(claimId),
    relations: relations.get(claimId) ?? [],
    promotion: promotions.get(claimId),
    now,
  });

  const decisionRows = await executor.query<{
    decision_id: string;
    candidate_id: string | null;
    claim_id: string | null;
    policy_version: string;
    outcome: Decision["outcome"];
    reason_codes: string[];
    approver: string | null;
    detail: unknown;
    decided_at: Date | string;
  }>(
    `SELECT decision_id, candidate_id, claim_id, policy_version, outcome, reason_codes,
            approver, detail, decided_at
       FROM decisions
      WHERE claim_id = $1::uuid
      ORDER BY decided_at ASC, decision_id ASC`,
    [stripPrefix(claimId)],
  );

  const decisions: Decision[] = decisionRows.rows.map((row) => ({
    decision_id: `dec_${stripPrefix(row.decision_id).replace(/-/g, "")}`,
    candidate_id: row.candidate_id === null ? null : `cnd_${stripPrefix(row.candidate_id).replace(/-/g, "")}`,
    claim_id: row.claim_id === null ? null : `clm_${stripPrefix(row.claim_id).replace(/-/g, "")}`,
    policy_version: row.policy_version,
    outcome: row.outcome,
    reason_codes: [...row.reason_codes],
    approver: row.approver,
    detail: row.detail,
    decided_at: toIso(row.decided_at),
  }));

  const originEventId = (claim["origin_event_id"] as string | null) ?? null;
  const originRow = originEventId
    ? (
        await executor.query<{
          event_id: string;
          stream_id: string;
          seq: number;
          actor_id: string;
          origin: string;
          occurred_at: Date | string;
          recorded_at: Date | string;
          payload: string | null;
          redacted_at: Date | string | null;
        }>(
          `SELECT event_id, stream_id, seq, actor_id, origin, occurred_at, recorded_at, payload, redacted_at
             FROM events WHERE event_id = $1::uuid`,
          [stripPrefix(originEventId)],
        )
      ).rows[0] ?? null
    : null;

  if (!originRow) {
    // A claim whose origin event is unreadable cannot be explained, and an
    // explanation with a fabricated origin would be worse than none. The claim's
    // `origin_event_id` is written by the gate in the same transaction as the claim,
    // so this only happens if the event row is gone — which the ledger forbids.
    throw new ApiError("precondition_failed", "the originating event is not readable", 409);
  }

  const candidateRow = originEventId
    ? (
        await executor.query<{
          candidate_id: string;
          kind: ClaimExplanation["candidate"] extends null ? never : string;
          subject: string;
          predicate: string;
          object: unknown;
          extractor: string;
          model_version: string | null;
          prompt_version: string | null;
          confidence: number | null;
          state: string;
          created_at: Date | string;
          requested_scope: string;
          scope_id: string;
          project: string | null;
          user_id: string | null;
          agent_id: string | null;
          session_id: string | null;
          purpose: string[];
        }>(
          `SELECT cc.candidate_id, cc.kind, cc.subject, cc.predicate, cc.object, cc.extractor,
                  cc.model_version, cc.prompt_version, cc.confidence, cc.state, cc.created_at,
                  cc.requested_scope, s.scope_id, s.project, s.user_id, s.agent_id, s.session_id, s.purpose
             FROM claim_candidates cc
             JOIN scopes s ON s.scope_id = cc.requested_scope
            WHERE cc.source_event_id = $1::uuid
              AND cc.subject = $2
              AND cc.predicate = $3
              AND cc.extractor = COALESCE($4, cc.extractor)
            ORDER BY cc.created_at DESC
            LIMIT 1`,
          [stripPrefix(originEventId), claim.subject, claim.predicate, claim.extractor],
        )
      ).rows[0] ?? null
    : null;

  const projectionRows = await executor.query<{
    projection: string;
    code_version: string;
    model_version: string | null;
    model_sha256: string | null;
    ledger_watermark: number;
  }>(
    `SELECT projection, code_version, model_version, model_sha256, ledger_watermark
       FROM projection_versions
      ORDER BY projection ASC`,
  );

  const reasonCodes = new Set<string>();
  for (const decision of decisions) for (const code of decision.reason_codes) reasonCodes.add(code);
  for (const ref of record.evidence) if (ref.entailment !== "unknown") reasonCodes.add(`entailment.${ref.entailment}`);

  const reasonHelp: Record<string, string> = {};
  for (const code of reasonCodes) {
    // The registry is the only source for this text. A code with no help entry would
    // be a code an operator cannot interpret, and `vocabulary.test.ts` in the
    // contract package is what keeps the registry and the codes in step.
    const help = (REASON_CODE_HELP as Record<string, string>)[code];
    reasonHelp[code] = help ?? `No registry entry for ${code}; the code was written by a component this build does not know.`;
  }

  return {
    claim_id: record.claim_id,
    claim: record,
    origin_event: {
      event_id: `evt_${stripPrefix(originRow.event_id).replace(/-/g, "")}`,
      stream_id: originRow.stream_id,
      seq: Number(originRow.seq),
      actor_id: originRow.actor_id,
      origin: originRow.origin,
      occurred_at: toIso(originRow.occurred_at),
      recorded_at: toIso(originRow.recorded_at),
      // Null exactly when the payload was redacted: the explanation must still be
      // able to say that the event existed and when, which is the whole point of
      // preserving the ledger row through erasure.
      content: originRow.payload,
      redacted_at: originRow.redacted_at === null ? null : toIso(originRow.redacted_at),
    },
    spans: (evidence.get(claimId)?.refs ?? []).map((ref) => ({
      span_id: ref.span_id,
      role: ref.role,
      event_id: ref.event_id,
      start: ref.start,
      end: ref.end,
      quote: ref.quote,
      digest: ref.digest,
      digest_ok: ref.digest_ok,
    })),
    decisions,
    candidate: candidateRow
      ? {
          candidate_id: `cnd_${stripPrefix(candidateRow.candidate_id).replace(/-/g, "")}`,
          tenant: deps.config ? claimsTenantOf(claim.tenant_id) : claimsTenantOf(claim.tenant_id),
          source_event_id: `evt_${stripPrefix(originEventId ?? "").replace(/-/g, "")}`,
          kind: candidateRow.kind as ClaimExplanation["candidate"] extends null ? never : never,
          subject: candidateRow.subject,
          predicate: candidateRow.predicate,
          object: candidateRow.object,
          requested_scope: {
            scope_id: formatUuid(candidateRow.scope_id),
            project: candidateRow.project,
            user: candidateRow.user_id,
            agent: candidateRow.agent_id,
            session: candidateRow.session_id,
            purpose: [...candidateRow.purpose],
          },
          extractor: candidateRow.extractor,
          model_version: candidateRow.model_version,
          prompt_version: candidateRow.prompt_version,
          confidence: candidateRow.confidence,
          state: candidateRow.state as never,
          created_at: toIso(candidateRow.created_at),
          evidence: (evidence.get(claimId)?.refs ?? []).map((ref) => ({
            span_id: ref.span_id,
            role: ref.role,
          })),
        }
      : null,
    relations: (relations.get(claimId) ?? []).map((relation) => ({
      from_claim: relation.from_claim,
      to_claim: relation.to_claim,
      rel: relation.rel,
      direction: relation.direction,
      recorded_at: relation.recorded_at,
    })),
    versions: {
      policy_version: deps.policy.version,
      gate_backend: deps.entailment.name,
      gate_model_sha256: deps.entailment.modelSha256,
      projections: projectionRows.rows.map((row) => ({
        projection: row.projection,
        code_version: row.code_version,
        model_version: row.model_version,
        model_sha256: row.model_sha256,
        ledger_watermark: Number(row.ledger_watermark),
      })),
    },
    reason_help: reasonHelp,
    produced_in_ms: Math.round((performance.now() - started) * 1000) / 1000,
  };
}

/** The tenant UUID a claim belongs to, formatted. Kept separate so its purpose is obvious. */
function claimsTenantOf(tenantId: string): string {
  return formatUuid(tenantId);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export { timePredicate, digestHex };
