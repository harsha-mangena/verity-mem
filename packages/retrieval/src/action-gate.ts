/**
 * The action gate.
 *
 * The specification is blunt about this, and it is right: a `verify` or `deny`
 * verdict inside a packet does not bind an LLM. Nothing stops a model from acting
 * on memory it was told to check. The only real enforcement is a pre-side-effect
 * check in the adapter, and if that check is not wired then the use decision is
 * decoration.
 *
 * So this module answers one question, for one action, about specific claims:
 *
 *     may this side effect proceed on this memory, right now, for this caller?
 *
 * Three properties are deliberate:
 *
 *   * It re-reads the claims. It does not trust the packet the caller was handed.
 *     A packet is a snapshot; a revocation, an expiry or an erasure between the
 *     query and the action must change the answer, and the only way for that to be
 *     true is to look again.
 *   * It re-verifies the evidence digests. "Current evidence" means the bytes
 *     still hash to what the claim recorded, not that they did at promotion time.
 *   * It fails closed on anything it cannot establish: an unknown claim, an
 *     unreachable claim, an expired one. Every refusal names the claim that caused
 *     it, so a blocked action is debuggable rather than mysterious.
 */
import { performance } from "node:perf_hooks";
import type {
  ActionGateRequest,
  ActionGateVerdict,
  ActionRisk,
  UseDecision,
} from "@veritymem/contracts";
import {
  DEFAULT_ACTION_POLICY_VERSION,
  REASON_CODES,
  RISK_TO_ALLOWED_USE,
  RISK_TO_MAX_EVIDENCE_AGE_DAYS,
} from "@veritymem/contracts";
import type { Clock, Db, Ledger, QueryExecutor, SpanRecord } from "@veritymem/ledger";
import { resolveTenantId, toPublicId } from "@veritymem/ledger";
import { ageInDays, evaluateUse, readClaims, readRelations, toIso } from "@veritymem/claims";
import type { EmbeddingBackend } from "./embeddings.ts";
import { planQuery } from "./planner.ts";

export interface ActionGateDependencies {
  readonly db: Db;
  readonly ledger: Ledger;
  readonly embeddings: EmbeddingBackend;
  readonly clock: Clock;
  readonly policyVersion?: string;
}

export interface ActionGateContext {
  readonly principal: string;
}

/**
 * Evaluate an action against the claims it depends on.
 *
 * Must be cheap enough to sit in front of every medium- and high-risk side effect.
 * It is: one planning query, one claim read, one evidence read. No model call.
 */
export async function evaluateAction(
  dependencies: ActionGateDependencies,
  request: ActionGateRequest,
  context: ActionGateContext,
): Promise<ActionGateVerdict> {
  const started = performance.now();
  const now = dependencies.clock.now().toISOString();
  const blocking: string[] = [];

  // Re-plan rather than trusting the caller's scope claim. Authorization is
  // recomputed from server-side membership and grants on every check, so a grant
  // revoked between the query and the action changes the outcome.
  const tenantId = resolveTenantId(request.scope.tenant);

  const plan = await dependencies.db.withRequest(
    {
      tenant: tenantId,
      principal: context.principal,
      scopeIds: [],
      purposes: [request.purpose],
      action: "action:plan",
    },
    async (executor) =>
      planQuery(
        executor,
        {
          tenant_id: tenantId,
          principal: context.principal,
          query: {
            query: request.action,
            scope: request.scope,
            purpose: request.purpose,
          },
        },
        { policyVersion: DEFAULT_ACTION_POLICY_VERSION },
      ),
  );

  const outcome = await dependencies.db.withRequest(
    {
      tenant: tenantId,
      principal: context.principal,
      scopeIds: plan.authorized_scope_ids,
      purposes: [request.purpose],
      action: "action:gate",
    },
    async (executor) => {
      const claimMap = await readClaims(executor, request.claim_ids);
      const relations = await readRelations(executor, request.claim_ids);
      const evidence = await readEvidence(dependencies.ledger, executor, [...claimMap.values()]);

      const perClaim: ActionGateVerdict["claims"][number][] = [];

      for (const claimId of request.claim_ids) {
        const claim = claimMap.get(claimId);
        if (!claim) {
          // Two different faults, and they need different answers. A claim that does not
          // exist is a caller's typo or a stale id; a claim that exists but sits outside
          // every scope the principal holds is an authorization or onboarding problem, and
          // its remedy is a grant rather than a correction.
          //
          // Resolving which one it is requires reading the claim outside the caller's
          // reach, which is deliberately *not* done for reads — there, the ambiguity is
          // load-bearing, because distinguishing them would make the query API an
          // existence oracle. At the action gate the caller is authenticated, is about to
          // take a side effect, and cannot debug a refusal that will not say whether the
          // claim was ever real. The trade is made in favour of the operator, and it
          // discloses only whether an id the caller already possesses exists.
          const exists = await dependencies.db.withSystemContext(
            { tenant: tenantId, actor: "action:probe" },
            async (probe) => {
              const row = await probe.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM claims WHERE claim_id = $1::uuid`,
                [stripPrefix(claimId)],
              );
              return (row.rows[0]?.n ?? 0) > 0;
            },
          );
          const code = exists
            ? REASON_CODES.ACTION_DENIED_MISSING_PARTICIPATION
            : REASON_CODES.ACTION_DENIED_UNKNOWN_CLAIM;
          blocking.push(code);
          perClaim.push({
            claim_id: claimId,
            found: false,
            use: null,
            reason_codes: [code],
            age_days: null,
            blocking: true,
          });
          continue;
        }

        const spans = evidence.get(claimId) ?? [];
        const digestOk = spans.length > 0 && spans.every((span) => span.digest_ok);
        const conflicted = (relations.get(claimId) ?? []).some(
          (relation) => relation.rel === "contradicts" && relation.other_status === "accepted",
        );
        const age = ageInDays(claim.valid_from, now);

        const use = evaluateUse({
          status: claim.status,
          kind: claim.kind,
          authority: claim.authority,
          valid_to: claim.valid_to === null ? null : toIso(claim.valid_to),
          expires_at: claim.expires_at === null ? null : toIso(claim.expires_at),
          has_conflicts: conflicted,
          digest_ok: digestOk,
          span_count: spans.length,
          age_days: age,
          action_risk: request.action_risk,
          query_purpose_matches: true,
          now,
        });

        const claimCodes = [...use.reason_codes];
        let isBlocking = false;

        // Rule 1: the risk level must be permitted by the use decision.
        const permitted: readonly string[] = RISK_TO_ALLOWED_USE[request.action_risk] ?? ["use"];
        if (!permitted.includes(use.use)) {
          claimCodes.push(REASON_CODES.ACTION_DENIED_RISK_EXCEEDS_USE);
          blocking.push(REASON_CODES.ACTION_DENIED_RISK_EXCEEDS_USE);
          isBlocking = true;
        }

        // Rule 2: evidence age is a separate ceiling from the claim's own staleness
        // horizon, because a consequential action has a shorter tolerance than a
        // retrieval.
        const maxAge = RISK_TO_MAX_EVIDENCE_AGE_DAYS[request.action_risk] ?? 365;
        if (age > maxAge) {
          claimCodes.push(REASON_CODES.ACTION_DENIED_STALE_EVIDENCE);
          blocking.push(REASON_CODES.ACTION_DENIED_STALE_EVIDENCE);
          isBlocking = true;
        }

        if (use.use === "deny") {
          claimCodes.push(REASON_CODES.ACTION_DENIED_CLAIM_NOT_USABLE);
          blocking.push(REASON_CODES.ACTION_DENIED_CLAIM_NOT_USABLE);
          isBlocking = true;
        }

        perClaim.push({
          claim_id: claimId,
          found: true,
          use: use.use,
          reason_codes: claimCodes,
          age_days: age,
          blocking: isBlocking,
        });
      }

      return perClaim;
    },
    { readOnly: true },
  );

  const decisions = outcome.map((entry) => entry.use).filter((use): use is UseDecision => use !== null);
  const allowed = !outcome.some((entry) => entry.blocking);
  const decision = allowed ? "use" : weakestDecision(decisions);

  const reasonCodes = [...new Set(blocking)];
  if (allowed) reasonCodes.push(REASON_CODES.ACTION_ALLOWED);

  // Record the check on the trace when the caller supplied one, so an action can be
  // tied back to the packet that informed it. This is what makes "why did the agent
  // do that" answerable rather than a reconstruction.
  if (request.trace_id) {
    await recordActionCheck(dependencies, tenantId, context.principal, request, plan.authorized_scope_ids, allowed, reasonCodes);
  }

  void started;
  return {
    allowed,
    decision,
    reason_codes: reasonCodes,
    claims: outcome,
    policy_version: dependencies.policyVersion ?? DEFAULT_ACTION_POLICY_VERSION,
    evaluated_at: now,
  };
}

/**
 * The packet-level decision when something is blocked.
 *
 * The weakest claim-level decision, never an average: if one referenced claim is
 * denied, the action is denied, and a majority of usable claims must not be able to
 * carry it. Averaging use decisions is the same category of mistake as averaging
 * the six confidence dimensions.
 */
function weakestDecision(decisions: readonly UseDecision[]): UseDecision {
  if (decisions.includes("deny")) return "deny";
  if (decisions.includes("clarify")) return "clarify";
  return "verify";
}

async function recordActionCheck(
  dependencies: ActionGateDependencies,
  tenantId: string,
  principal: string,
  request: ActionGateRequest,
  scopeIds: readonly string[],
  allowed: boolean,
  reasonCodes: readonly string[],
): Promise<void> {
  if (!request.trace_id) return;
  await dependencies.db.withRequest(
    {
      tenant: tenantId,
      principal,
      scopeIds,
      purposes: [request.purpose],
      action: "action:record",
    },
    async (executor) => {
      await executor.query(
        `UPDATE query_traces
            SET query = query || $2::jsonb
          WHERE trace_id = $1::uuid`,
        [
          stripPrefix(request.trace_id as string),
          JSON.stringify({
            action_gate: {
              action: request.action,
              action_risk: request.action_risk,
              allowed,
              claim_ids: request.claim_ids,
              reason_codes: [...reasonCodes],
              evaluated_at: dependencies.clock.now().toISOString(),
            },
          }),
        ],
      );
    },
  );
}

interface EvidenceRow {
  claim_id: string;
  span_id: string;
  event_id: string;
  start_off: number;
  end_off: number;
  span_digest: Buffer;
  [column: string]: unknown;
}

async function readEvidence(
  ledger: Ledger,
  executor: QueryExecutor,
  claims: readonly { claim_id: string }[],
): Promise<Map<string, { digest_ok: boolean }[]>> {
  const out = new Map<string, { digest_ok: boolean }[]>();
  if (claims.length === 0) return out;

  const rows = await executor.query<EvidenceRow>(
    `SELECT ce.claim_id, s.span_id, s.event_id, s.start_off, s.end_off, s.span_digest
       FROM claim_evidence ce
       JOIN evidence_spans s ON s.span_id = ce.span_id
      WHERE ce.claim_id = ANY($1::uuid[])`,
    [claims.map((claim) => claim.claim_id)],
  );

  const spanRecords: SpanRecord[] = rows.rows.map((row): SpanRecord => ({
    span_id: toPublicId("spn", row.span_id),
    event_id: toPublicId("evt", row.event_id),
    start: Number(row.start_off),
    end: Number(row.end_off),
    selector: null,
    digest: row.span_digest.toString("hex"),
    quote: "",
  }));

  const verifications = await ledger.verifySpans(executor, spanRecords);
  for (const row of rows.rows) {
    const claimId = toPublicId("clm", row.claim_id);
    const spanId = toPublicId("spn", row.span_id);
    const list = out.get(claimId) ?? [];
    list.push({ digest_ok: verifications.get(spanId)?.status === "ok" });
    out.set(claimId, list);
  }
  return out;
}

/** Re-exported so callers can assert the policy version an action was judged under. */
export const ACTION_POLICY_VERSION = DEFAULT_ACTION_POLICY_VERSION;

/** Risk levels this gate refuses outright, regardless of evidence. */
export function isGateRequired(risk: ActionRisk): boolean {
  return risk === "medium" || risk === "high";
}

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
