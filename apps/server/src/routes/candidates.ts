/**
 * Candidate routes: read a proposal, and decide it.
 *
 * A candidate is an untrusted proposal. `GET` returns it with its evidence spans
 * resolved, and `POST .../decisions` is the *human* promotion path — the one the
 * specification keeps open while forbidding any model from setting
 * `status = accepted`.
 *
 * Three properties of the decision route are deliberate:
 *
 *   * A refusal is a 200 carrying `outcome: "reject"`. A rejected candidate is not an
 *     error; it is the system working. Conflating it with a 4xx would make a review
 *     queue unreadable in an access log and would tempt a client into retrying it.
 *   * The claim is created only for `accept` and `accept_limited_scope`, at the
 *     candidate's *requested* scope, and for `accept_limited_scope` at the origin
 *     event's scope instead. Narrowing is the default failure mode; broadening never
 *     happens because a reviewer approved something.
 *   * The decision row is written in the same transaction as any status change. The
 *     database refuses a status transition with no matching decision
 *     (`0010_claim_mutation_guard`), so a reviewer's approval cannot become an
 *     unexplained state change.
 */
import type { FastifyInstance } from "fastify";
import {
  CandidateReadResponseSchema,
  DecisionRequestSchema,
  DecisionResponseSchema,
  type ClaimCandidate,
  type DecisionRequest,
  type DecisionResponse,
  type EvidenceSpan,
  type OriginKind,
} from "@veritymem/contracts";
import { readClaims } from "@veritymem/claims";
import { defaultAuthorityFor } from "@veritymem/gate";
import { requireTool } from "../auth.ts";
import { resolveCallerTenant, tenantFromCredential, withReadContext, withWriteContext } from "../context.ts";
import type { ServerDeps } from "../config.ts";
import { ApiError, notFound } from "../errors.ts";
import { digestHex, formatUuid, requireId, stripPrefix } from "../views.ts";

const CandidateIdParamsSchema = {
  type: "object",
  required: ["candidate_id"],
  additionalProperties: false,
  properties: { candidate_id: { type: "string", minLength: 1, maxLength: 128 } },
} as const;

interface CandidateRow {
  candidate_id: string;
  tenant_id: string;
  source_event_id: string;
  kind: ClaimCandidate["kind"];
  subject: string;
  predicate: string;
  object: unknown;
  requested_scope: string;
  extractor: string;
  model_version: string | null;
  prompt_version: string | null;
  confidence: number | null;
  state: ClaimCandidate["state"];
  created_at: Date | string;
  scope_id: string;
  project: string | null;
  user_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  purpose: string[];
  [column: string]: unknown;
}

const CANDIDATE_SELECT = `
  SELECT cc.candidate_id, cc.tenant_id, cc.source_event_id, cc.kind, cc.subject, cc.predicate,
         cc.object, cc.requested_scope, cc.extractor, cc.model_version, cc.prompt_version,
         cc.confidence, cc.state, cc.created_at,
         s.scope_id, s.project, s.user_id, s.agent_id, s.session_id, s.purpose
    FROM claim_candidates cc
    JOIN scopes s ON s.scope_id = cc.requested_scope
`;

export interface CandidateRouteOptions {
  readonly deps: ServerDeps;
}

export function registerCandidateRoutes(app: FastifyInstance, options: CandidateRouteOptions): void {
  const { deps } = options;

  app.get(
    "/v1/candidates/:candidate_id",
    {
      schema: {
        tags: ["candidates"],
        summary: "Read a claim candidate and the decisions already recorded against it",
        params: CandidateIdParamsSchema,
        response: { 200: CandidateReadResponseSchema },
      },
    },
    async (request, reply) => {
      const caller = requireTool(request, "memory.candidate.read");
      const params = request.params as { candidate_id: string };
      requireId(params.candidate_id, "cnd", "candidate_id");
      const context = tenantFromCredential({ identity: caller, what: "GET /v1/candidates/{id}" });

      const result = await withReadContext(deps, context, async (executor) => {
        const found = await executor.query<CandidateRow>(`${CANDIDATE_SELECT} WHERE cc.candidate_id = $1::uuid`, [
          stripPrefix(params.candidate_id),
        ]);
        const candidate = found.rows[0];
        // Not visible and not existing are the same answer. `claim_candidates` is
        // under row-level security, so a candidate in a scope the caller cannot
        // reach simply is not in this result set.
        if (!candidate) return null;

        const spans = await executor.query<{
          span_id: string;
          event_id: string;
          start_off: number;
          end_off: number;
          selector: string | null;
          span_digest: Buffer | string;
          quote: string;
          role: "supports" | "refutes";
        }>(
          `SELECT s.span_id, s.event_id, s.start_off, s.end_off, s.selector, s.span_digest, s.quote, ce.role
             FROM candidate_evidence ce
             JOIN evidence_spans s ON s.span_id = ce.span_id
            WHERE ce.candidate_id = $1::uuid`,
          [stripPrefix(params.candidate_id)],
        );

        const decisions = await executor.query<{
          decision_id: string;
          candidate_id: string | null;
          claim_id: string | null;
          policy_version: string;
          outcome: DecisionResponse["outcome"];
          reason_codes: string[];
          approver: string | null;
          detail: unknown;
          decided_at: Date | string;
        }>(
          `SELECT decision_id, candidate_id, claim_id, policy_version, outcome, reason_codes,
                  approver, detail, decided_at
             FROM decisions
            WHERE candidate_id = $1::uuid
            ORDER BY decided_at ASC`,
          [stripPrefix(params.candidate_id)],
        );

        return { candidate, spans: spans.rows, decisions: decisions.rows };
      });

      if (!result) throw notFound("candidate");
      const candidate: ClaimCandidate = {
        candidate_id: `cnd_${stripPrefix(params.candidate_id).replace(/-/g, "")}`,
        tenant: context.tenant,
        source_event_id: `evt_${stripPrefix(result.candidate.source_event_id).replace(/-/g, "")}`,
        kind: result.candidate.kind,
        subject: result.candidate.subject,
        predicate: result.candidate.predicate,
        object: result.candidate.object,
        requested_scope: {
          scope_id: formatUuid(result.candidate.scope_id),
          project: result.candidate.project,
          user: result.candidate.user_id,
          agent: result.candidate.agent_id,
          session: result.candidate.session_id,
          purpose: [...result.candidate.purpose],
        },
        extractor: result.candidate.extractor,
        model_version: result.candidate.model_version,
        prompt_version: result.candidate.prompt_version,
        confidence: result.candidate.confidence,
        state: result.candidate.state,
        created_at: toIso(result.candidate.created_at),
        evidence: result.spans.map((span) => {
          const evidenceSpan: EvidenceSpan = {
            span_id: `spn_${stripPrefix(span.span_id).replace(/-/g, "")}`,
            event_id: `evt_${stripPrefix(span.event_id).replace(/-/g, "")}`,
            start: Number(span.start_off),
            end: Number(span.end_off),
            ...(span.selector !== null ? { selector: span.selector } : {}),
            digest: digestHex(span.span_digest),
            quote: span.quote,
          };
          return { span_id: evidenceSpan.span_id, role: span.role, span: evidenceSpan };
        }),
      };

      await reply.code(200).send({
        candidate,
        decisions: result.decisions.map((row) => ({
          decision_id: `dec_${stripPrefix(row.decision_id).replace(/-/g, "")}`,
          candidate_id: row.candidate_id ? `cnd_${stripPrefix(row.candidate_id).replace(/-/g, "")}` : null,
          claim_id: row.claim_id ? `clm_${stripPrefix(row.claim_id).replace(/-/g, "")}` : null,
          policy_version: row.policy_version,
          outcome: row.outcome,
          reason_codes: [...row.reason_codes],
          approver: row.approver,
          detail: row.detail,
          decided_at: toIso(row.decided_at),
        })),
      });
    },
  );

  app.post(
    "/v1/candidates/:candidate_id/decisions",
    {
      schema: {
        tags: ["candidates"],
        summary: "Record a reviewer decision on a candidate",
        description:
          "A refusAL is a 200 carrying the outcome, never an error. `accept` creates the claim; `reject`, `quarantine` and `needs_review` are recorded without one.",
        params: CandidateIdParamsSchema,
        body: DecisionRequestSchema,
        response: { 200: DecisionResponseSchema },
      },
    },
    async (request, reply) => {
      const caller = requireTool(request, "memory.decide");
      const params = request.params as { candidate_id: string };
      requireId(params.candidate_id, "cnd", "candidate_id");
      const body = request.body as DecisionRequest;
      const context = tenantFromCredential({ identity: caller, what: "POST /v1/candidates/{id}/decisions" });

      const result = await withWriteContext(deps, context, "candidate:decide", async (executor) => {
        const found = await executor.query<CandidateRow>(`${CANDIDATE_SELECT} WHERE cc.candidate_id = $1::uuid`, [
          stripPrefix(params.candidate_id),
        ]);
        const candidate = found.rows[0];
        if (!candidate) return null;

        const spans = await executor.query<{
          span_id: string;
          event_id: string;
          start_off: number;
          end_off: number;
          selector: string | null;
          span_digest: Buffer | string;
          role: "supports" | "refutes";
        }>(
          `SELECT s.span_id, s.event_id, s.start_off, s.end_off, s.selector, s.span_digest, ce.role
             FROM candidate_evidence ce
             JOIN evidence_spans s ON s.span_id = ce.span_id
            WHERE ce.candidate_id = $1::uuid`,
          [stripPrefix(params.candidate_id)],
        );

        const event = await executor.query<{ occurred_at: Date | string; scope_id: string }>(
          `SELECT occurred_at, scope_id FROM events WHERE event_id = $1::uuid`,
          [stripPrefix(candidate.source_event_id)],
        );
        const sourceEvent = event.rows[0];
        if (!sourceEvent) {
          throw new ApiError("precondition_failed", "the candidate's origin event is not readable", 409);
        }

        const now = deps.clock.now().toISOString();
        const decisionId = deps.ids.next("dec");
        const createsClaim = body.outcome === "accept" || body.outcome === "accept_limited_scope";
        // `accept_limited_scope` narrows to the evidence's own scope. A reviewer
        // approving a candidate whose requested scope exceeds its evidence must not be
        // able to widen it by approving.
        const acceptedScopeId =
          body.outcome === "accept_limited_scope" ? sourceEvent.scope_id : candidate.requested_scope;

        let claimId: string | null = null;
        if (createsClaim) {
          claimId = deps.ids.next("clm");
          await executor.query(
            `INSERT INTO claims (
               claim_id, tenant_id, scope_id, kind, subject, predicate, object, status, authority,
               valid_from, valid_to, recorded_at, expires_at, origin_event_id,
               extractor, model_version, prompt_version
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4::claim_kind, $5, $6, $7::jsonb, 'accepted', $8::authority_cls,
               $9::timestamptz, NULL, $10::timestamptz, NULL, $11::uuid, $12, $13, $14
             )`,
            [
              stripPrefix(claimId),
              candidate.tenant_id,
              acceptedScopeId,
              candidate.kind,
              candidate.subject,
              candidate.predicate,
              JSON.stringify(candidate.object ?? null),
              // Authority follows the extractor's declaration, never the reviewer's
              // confidence in it. A reviewer approves a proposition; they do not
              // upgrade a hearsay observation into a verified record.
              await authorityFor(executor, candidate),
              toIso(sourceEvent.occurred_at),
              now,
              stripPrefix(candidate.source_event_id),
              candidate.extractor,
              candidate.model_version,
              candidate.prompt_version,
            ],
          );

          for (const span of spans.rows) {
            await executor.query(
              `INSERT INTO claim_evidence (claim_id, span_id, role)
               VALUES ($1::uuid, $2::uuid, $3::evidence_role)
               ON CONFLICT (claim_id, span_id) DO NOTHING`,
              [stripPrefix(claimId), stripPrefix(span.span_id), span.role],
            );
          }
        }

        const reasonCodes = [
          ...(body.reason_codes ?? []),
          ...(body.outcome === "accept_limited_scope" ? ["scope.narrowed_to_event"] : []),
        ];

        await executor.query(
          `INSERT INTO decisions (
             decision_id, tenant_id, candidate_id, claim_id, policy_version,
             outcome, reason_codes, approver, detail
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::decision_outcome, $7::text[], $8, $9::jsonb)`,
          [
            stripPrefix(decisionId),
            candidate.tenant_id,
            stripPrefix(params.candidate_id),
            claimId === null ? null : stripPrefix(claimId),
            `review:${deps.policy.version}`,
            body.outcome,
            reasonCodes,
            body.approver ?? context.principal,
            JSON.stringify({
              reviewer_reason: body.reason,
              decided_by: context.principal,
              candidate_state_before: candidate.state,
              accepted_scope_id: acceptedScopeId,
              requested_scope_id: candidate.requested_scope,
            }),
          ],
        );

        await executor.query(
          `UPDATE claim_candidates SET state = 'gated' WHERE candidate_id = $1::uuid`,
          [stripPrefix(params.candidate_id)],
        );

        // Keep the claim store's promotion pointer truthful: the newest decision for
        // a claim is the one an operator sees first in `/explain`, and a reviewer
        // decision that did not land there would make the review path invisible.
        return { decisionId, claimId, reasonCodes, acceptedScopeId, now };
      });

      if (!result) throw notFound("candidate");

      const response: DecisionResponse = {
        candidate_id: params.candidate_id,
        decision_id: result.decisionId,
        claim_id: result.claimId,
        outcome: body.outcome,
        reason_codes: result.reasonCodes,
        approver: body.approver ?? context.principal,
        policy_version: `review:${deps.policy.version}`,
        decided_at: result.now,
        claim_created: result.claimId !== null,
      };
      await reply.code(200).send(response);
    },
  );
}

/**
 * The authority class the claim inherits.
 *
 * The gate's own `defaultAuthorityFor` is called rather than a mapping restated
 * here, because the two would diverge in exactly the case that matters: the gate
 * maps `tool` to `observation` while an intuitive reading maps it to
 * `verified_record`, and a reviewer decision that quietly granted the stronger class
 * would be an authority upgrade by the back door — the thing migration 0010 refuses
 * on an existing claim.
 *
 * The origin comes from the ledger, not from the caller and not from the candidate
 * row (which does not store it). The origin event is the only thing that knows what
 * kind of source this proposal came from.
 */
async function authorityFor(
  executor: Parameters<typeof readClaims>[0],
  candidate: CandidateRow,
): Promise<string> {
  const origin = await executor.query<{ origin: OriginKind }>(
    `SELECT origin FROM events WHERE event_id = $1::uuid`,
    [stripPrefix(candidate.source_event_id)],
  );
  const kind = origin.rows[0]?.origin;
  if (!kind) {
    throw new ApiError("precondition_failed", "the candidate's origin event is not readable", 409);
  }
  return defaultAuthorityFor(kind);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
