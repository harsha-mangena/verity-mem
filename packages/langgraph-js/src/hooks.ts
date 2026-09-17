/**
 * The four adapter hooks, as plain functions.
 *
 * The specification's adapter contract is explicit that interception of an LLM
 * client is the wrong design — it destroys origin information and makes failure
 * attribution impossible — and that four named hooks are the right one. They live
 * here as ordinary async functions so that an application with no LangGraph graph at
 * all can still use the enforcement point; `nodes.ts` wraps them for graph use and
 * adds nothing but state plumbing.
 *
 * What each hook guarantees, in one line each:
 *
 *   * `beforeRun` attaches a *packet* — beliefs with provenance, conflicts, freshness
 *     and use decisions — never free-form snippets.
 *   * `afterTool` records a tool observation with tool identity, input and output
 *     hashes, and side-effect status, as an untrusted event.
 *   * `afterRun` records the transcript and *proposes*; it has no code path that can
 *     accept, promote or decide anything.
 *   * `beforeAction` verifies that every referenced claim still carries an allowed use
 *     decision and current evidence, and *raises* when it does not.
 */
import type {
  ActionGateRequest,
  ActionGateVerdict,
  ActionRisk,
  ClaimKind,
  EventAppendRequest,
  ExtractionState,
  Instant,
  MemoryPacket,
  QueryRequest,
  Sensitivity,
  TimeSpec,
} from "@veritymem/contracts";
import { REASON_CODES } from "@veritymem/contracts";
import type { VerityApiClient } from "./client.ts";
import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";
import { ActionDeniedError, ScopeViolationError } from "./errors.ts";
import { formatMemoryContext, type FormattedMemoryContext } from "./context.ts";
import { canonicalJson, hashValue, sha256Hex } from "./hash.ts";
import type { StoreScope } from "./namespace.ts";
import { namespaceFromScope } from "./namespace.ts";
import { writeScopeOf } from "./store.ts";

export interface HookDependencies {
  readonly client: VerityApiClient;
  /** Injected so recorded timestamps are reproducible in a replay. */
  readonly clock?: Clock;
}

// ---------------------------------------------------------------------------
// beforeRun
// ---------------------------------------------------------------------------

export interface BeforeRunInput {
  /** The question this run needs memory for, in the caller's own words. */
  readonly query: string;
  /** Explicit scope dimensions. Purpose lives here as well as in `purpose` below. */
  readonly scope: StoreScope;
  /** The single purpose this read is authorized for. Must be one of `scope.purpose`. */
  readonly purpose: string;
  readonly time?: TimeSpec;
  /** Declared risk of the action this memory will inform; the use policy reads it. */
  readonly action_risk?: ActionRisk;
  readonly limit?: number;
  readonly kinds?: readonly ClaimKind[];
  readonly subjects?: readonly string[];
}

export interface BeforeRunResult {
  readonly packet: MemoryPacket;
  /** The fenced, escaped rendering. Place it in the user channel; see `context.ts`. */
  readonly context: FormattedMemoryContext;
  /** The namespace the read used, so later writes and gates address the same scope. */
  readonly namespace: string[];
}

/**
 * Query memory and attach the packet.
 *
 * Returns the packet *and* its safe rendering, because a caller handed only a
 * rendering will eventually build its own, and a caller handed only a packet will
 * eventually splice it into a prompt.
 */
export async function beforeRun(
  dependencies: HookDependencies,
  input: BeforeRunInput,
): Promise<BeforeRunResult> {
  assertPurposeReachable(input.scope, input.purpose);
  if (input.query.trim() === "") {
    throw new ScopeViolationError("empty_purpose", "beforeRun requires a non-empty query; an empty query is not a broad query");
  }

  const request: QueryRequest = {
    query: input.query,
    scope: selectorOf(input.scope),
    purpose: input.purpose,
    ...(input.time === undefined ? {} : { time: input.time }),
    ...(input.action_risk === undefined ? {} : { action_risk: input.action_risk }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.kinds === undefined ? {} : { kinds: [...input.kinds] }),
    ...(input.subjects === undefined ? {} : { subjects: [...input.subjects] }),
  };

  const packet = await dependencies.client.query(request);
  return {
    packet,
    context: formatMemoryContext(packet),
    namespace: namespaceFromScope(input.scope),
  };
}

// ---------------------------------------------------------------------------
// afterTool
// ---------------------------------------------------------------------------

export const SIDE_EFFECT_STATUSES = ["none", "performed", "attempted", "unknown"] as const;

/**
 * What the tool did to the world.
 *
 * Recorded because "we read a value" and "we changed a value" are different facts
 * about a run, and an agent that later reasons from a tool observation needs to know
 * which one it has. `unknown` is a real answer for a tool that cannot be certain.
 */
export type SideEffectStatus = (typeof SIDE_EFFECT_STATUSES)[number];

export interface ToolObservationInput {
  /** Tool identity, e.g. `github.create_release`. Part of the actor id, so it is not optional. */
  readonly tool: string;
  readonly tool_version?: string;
  /** Caller-stable identity for this call. Two calls with the same id are one observation. */
  readonly call_id: string;
  readonly scope: StoreScope;
  readonly input: unknown;
  readonly output: unknown;
  readonly side_effect: SideEffectStatus;
  readonly side_effect_detail?: string;
  readonly occurred_at?: Instant;
  readonly actor_id?: string;
  readonly stream_id?: string;
  /**
   * Which payloads to store as text, in characters. Defaults to the output only,
   * bounded: an observation stored as hashes alone produces no citable span, so
   * extraction can derive nothing from it, while an observation that stores an input
   * verbatim puts whatever the tool was handed into the ledger forever.
   */
  readonly excerpt?: { readonly input?: number | false; readonly output?: number | false };
  readonly sensitivity?: Sensitivity;
}

export interface ObservationReceipt {
  readonly event_id: string;
  readonly seq: number;
  readonly recorded_at: string;
  readonly deduplicated: boolean;
  readonly extraction: ExtractionState;
  readonly tool: string;
  readonly call_id: string;
  readonly input_sha256: string;
  readonly output_sha256: string;
  readonly side_effect: SideEffectStatus;
}

const DEFAULT_OUTPUT_EXCERPT_CHARS = 4096;

/**
 * Record one tool observation.
 *
 * The hashes are over the *complete* canonicalized values, so an observation stays
 * replayable and tamper-evident even when the stored excerpt is bounded; the excerpt
 * is what the extractor can cite. The event is written with origin `tool`, which is
 * what makes every downstream claim's authority a property of the evidence rather
 * than of the agent's description of it.
 */
export async function afterTool(
  dependencies: HookDependencies,
  input: ToolObservationInput,
): Promise<ObservationReceipt> {
  if (input.tool.trim() === "") {
    throw new ScopeViolationError("empty_purpose", "afterTool requires a tool identity; an anonymous observation cannot be attributed");
  }
  if (input.call_id.trim() === "") {
    throw new ScopeViolationError("empty_purpose", "afterTool requires a call_id; without one, a retried node appends duplicate observations");
  }
  assertScopeBindsPurpose(input.scope);

  const clock = dependencies.clock ?? systemClock;
  const occurredAt = input.occurred_at ?? clock.now().toISOString();
  const inputHash = hashValue(input.input);
  const outputHash = hashValue(input.output);
  const inputExcerpt = excerptOf(input.input, input.excerpt?.input ?? false);
  const outputExcerpt = excerptOf(input.output, input.excerpt?.output ?? DEFAULT_OUTPUT_EXCERPT_CHARS);

  const envelope = {
    veritymem: { kind: "tool_observation", version: 1 },
    tool: {
      name: input.tool,
      ...(input.tool_version === undefined ? {} : { version: input.tool_version }),
    },
    call_id: input.call_id,
    side_effect: {
      status: input.side_effect,
      ...(input.side_effect_detail === undefined ? {} : { detail: input.side_effect_detail }),
    },
    observed_at: occurredAt,
    input_sha256: inputHash,
    output_sha256: outputHash,
    input_chars: canonicalJson(input.input).length,
    output_chars: canonicalJson(input.output).length,
    ...(outputExcerpt === null ? {} : { output_excerpt: outputExcerpt }),
    ...(inputExcerpt === null ? {} : { input_excerpt: inputExcerpt }),
  };

  const receipt = await dependencies.client.appendEvent({
    stream_id: input.stream_id ?? `store:tool:${input.tool}`,
    // The call id makes a retried tool wrapper idempotent; the output hash makes a
    // second *different* result for the same call a distinct observation rather than
    // a silently dropped duplicate.
    idempotency_key: `tool:${input.call_id}:${outputHash.slice(0, 16)}`,
    origin: "tool",
    actor_id: input.actor_id ?? `tool:${input.tool}`,
    scope: writeScopeOf(input.scope),
    occurred_at: occurredAt,
    content: canonicalJson(envelope),
    media_type: "application/json",
    ...(input.sensitivity === undefined ? {} : { sensitivity: input.sensitivity }),
  });

  return {
    event_id: receipt.event_id,
    seq: receipt.seq,
    recorded_at: receipt.recorded_at,
    deduplicated: receipt.deduplicated,
    extraction: receipt.extraction,
    tool: input.tool,
    call_id: input.call_id,
    input_sha256: inputHash,
    output_sha256: outputHash,
    side_effect: input.side_effect,
  };
}

// ---------------------------------------------------------------------------
// afterRun
// ---------------------------------------------------------------------------

export interface TranscriptEntry {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly name?: string;
  readonly at?: Instant;
}

/**
 * A conclusion the agent reached, offered as a proposal.
 *
 * There is deliberately no `authority` and no `status` field. An agent that could
 * declare its own authority class would be choosing how much its own conclusion is
 * trusted, and the gate derives authority from the origin and the evidence instead.
 */
export interface AgentConclusion {
  readonly kind: ClaimKind;
  readonly subject: string;
  readonly predicate: string;
  readonly object: unknown;
  /** The agent's own justification. Stored as untrusted text; it is not evidence. */
  readonly rationale?: string;
}

export interface AfterRunInput {
  /** The run this transcript belongs to. Idempotency key for the transcript event. */
  readonly run_id: string;
  readonly scope: StoreScope;
  readonly transcript: readonly TranscriptEntry[];
  readonly conclusions?: readonly AgentConclusion[];
  /** The agent principal, e.g. `agent:planner`. */
  readonly actor_id: string;
  readonly occurred_at?: Instant;
  readonly stream_id?: string;
  readonly sensitivity?: Sensitivity;
}

export interface ProposalReceipt {
  readonly index: number;
  readonly event_id: string;
  readonly seq: number;
  readonly deduplicated: boolean;
  readonly extraction: ExtractionState;
}

export interface AfterRunResult {
  readonly transcript_event_id: string;
  readonly transcript_seq: number;
  readonly transcript_deduplicated: boolean;
  readonly proposals: readonly ProposalReceipt[];
  /**
   * `false`, as a literal type.
   *
   * The guarantee this hook exists to provide is that an agent's conclusions are
   * proposed and never accepted. Stating it in the return type means a graph reading
   * the result cannot accidentally depend on a promotion having happened — and the
   * test suite asserts the wiring by recording every route the hook calls.
   */
  readonly promotion_attempted: false;
}

/**
 * Record the transcript and propose the agent's conclusions.
 *
 * Each conclusion is appended as its own event so that a candidate extracted from it
 * can cite a span inside that event, which is what makes `/v1/claims/{id}/explain`
 * able to show the agent's exact sentence rather than a paraphrase. Nothing here
 * calls a decision route: only the commit gate promotes, and a model's summary of its
 * own work is the least trustworthy input the system will ever receive.
 */
export async function afterRun(
  dependencies: HookDependencies,
  input: AfterRunInput,
): Promise<AfterRunResult> {
  if (input.run_id.trim() === "") {
    throw new ScopeViolationError(
      "empty_purpose",
      "afterRun requires a run_id: it is the idempotency key for the transcript event, and a run that can be " +
        "retried without one appends its transcript twice",
    );
  }
  if (input.actor_id.trim() === "") {
    throw new ScopeViolationError("empty_purpose", "afterRun requires the agent principal as actor_id");
  }
  assertScopeBindsPurpose(input.scope);

  const clock = dependencies.clock ?? systemClock;
  const occurredAt = input.occurred_at ?? clock.now().toISOString();
  const streamId = input.stream_id ?? `thread:${input.run_id}`;

  const transcriptEvent = await dependencies.client.appendEvent({
    stream_id: streamId,
    idempotency_key: `run:${input.run_id}:transcript`,
    origin: "agent",
    actor_id: input.actor_id,
    scope: writeScopeOf(input.scope),
    occurred_at: occurredAt,
    content: canonicalJson({
      veritymem: { kind: "agent_transcript", version: 1 },
      run_id: input.run_id,
      recorded_at: occurredAt,
      entries: input.transcript.map((entry) => ({
        role: entry.role,
        content: entry.content,
        ...(entry.name === undefined ? {} : { name: entry.name }),
        ...(entry.at === undefined ? {} : { at: entry.at }),
      })),
    }),
    media_type: "application/json",
    ...(input.sensitivity === undefined ? {} : { sensitivity: input.sensitivity }),
  });

  const proposals: ProposalReceipt[] = [];
  let index = 0;
  for (const conclusion of input.conclusions ?? []) {
    const receipt = await dependencies.client.appendEvent(conclusionEvent(input, conclusion, occurredAt, index));
    proposals.push({
      index,
      event_id: receipt.event_id,
      seq: receipt.seq,
      deduplicated: receipt.deduplicated,
      extraction: receipt.extraction,
    });
    index += 1;
  }

  return {
    transcript_event_id: transcriptEvent.event_id,
    transcript_seq: transcriptEvent.seq,
    transcript_deduplicated: transcriptEvent.deduplicated,
    proposals,
    promotion_attempted: false,
  };
}

function conclusionEvent(
  input: AfterRunInput,
  conclusion: AgentConclusion,
  occurredAt: Instant,
  index: number,
): EventAppendRequest {
  return {
    stream_id: input.stream_id ?? `thread:${input.run_id}`,
    idempotency_key: `run:${input.run_id}:proposal:${index}`,
    origin: "agent",
    actor_id: input.actor_id,
    scope: writeScopeOf(input.scope),
    occurred_at: occurredAt,
    content: canonicalJson({
      veritymem: { kind: "agent_conclusion", version: 1 },
      run_id: input.run_id,
      proposed_at: occurredAt,
      // The envelope carries no authority class and no status: authority is derived
      // from origin and evidence by the gate, and status is set by nothing here.
      conclusion: {
        kind: conclusion.kind,
        subject: conclusion.subject,
        predicate: conclusion.predicate,
        object: conclusion.object,
        ...(conclusion.rationale === undefined ? {} : { rationale: conclusion.rationale }),
      },
    }),
    media_type: "application/json",
    ...(input.sensitivity === undefined ? {} : { sensitivity: input.sensitivity }),
  };
}

// ---------------------------------------------------------------------------
// beforeAction — the enforcement point
// ---------------------------------------------------------------------------

export interface BeforeActionInput {
  /** The side effect about to happen, e.g. `github.create_release`. */
  readonly action: string;
  readonly action_risk: ActionRisk;
  readonly scope: StoreScope;
  readonly purpose: string;
  /** Every claim the action depends on. An empty set is refused: it verifies nothing. */
  readonly claim_ids: readonly string[];
  /** Ties the check to the packet that informed it, when there was one. */
  readonly trace_id?: string;
}

export interface ActionGateCheck {
  readonly verdict: ActionGateVerdict;
  readonly action: string;
  readonly action_risk: ActionRisk;
  readonly claim_ids: readonly string[];
}

/**
 * The enforcement point. Call it before every medium- or high-risk side effect.
 *
 * This is exported standalone — it needs no graph, no node and no store — because
 * the specification's claim is blunt: if the action gate is not wired, the use
 * decision is decoration. The failure mode it protects against is not a wrong answer,
 * it is a correct answer acted on after the claim was revoked, expired or erased, so
 * the check re-reads the claims on the server rather than trusting anything the
 * caller already holds.
 *
 * Returns only on an allowed action. A denial is an `ActionDeniedError` carrying the
 * blocking claim ids and reason codes.
 */
export async function beforeAction(
  dependencies: HookDependencies,
  input: BeforeActionInput,
): Promise<ActionGateCheck> {
  assertPurposeReachable(input.scope, input.purpose);
  if (input.action.trim() === "") {
    throw new ScopeViolationError("empty_purpose", "beforeAction requires the action's name; an unnamed action cannot be audited");
  }
  const claimIds = [...new Set(input.claim_ids)];
  if (claimIds.length === 0) {
    throw new ScopeViolationError(
      "no_claims",
      "beforeAction was given no claims. An action that depends on no memory does not need the gate; calling it " +
        "with an empty claim set would verify nothing, always allow, and look like enforcement",
      { action: input.action },
    );
  }

  const request: ActionGateRequest = {
    action: input.action,
    action_risk: input.action_risk,
    scope: selectorOf(input.scope),
    purpose: input.purpose,
    claim_ids: claimIds,
    ...(input.trace_id === undefined ? {} : { trace_id: input.trace_id }),
  };

  const verdict = await dependencies.client.gateAction(request);

  // Recomputed rather than trusted. A verdict that says `allowed` while reporting a
  // blocking claim, or while omitting a claim it was asked about, is not an
  // authorization; treating it as one would let a server bug become a side effect.
  const reported = new Map(verdict.claims.map((claim) => [claim.claim_id, claim]));
  const blocking = claimIds.filter((claimId) => reported.get(claimId)?.blocking === true);
  const missing = claimIds.filter((claimId) => !reported.has(claimId));

  if (!verdict.allowed || blocking.length > 0 || missing.length > 0) {
    const reasonCodes = [...verdict.reason_codes];
    if (missing.length > 0) reasonCodes.push(REASON_CODES.ACTION_DENIED_CLAIM_NOT_USABLE);
    throw new ActionDeniedError({
      action: input.action,
      action_risk: input.action_risk,
      claim_ids: claimIds,
      blocking_claim_ids: blocking.length > 0 ? blocking : missing,
      reason_codes: [...new Set(reasonCodes)],
      decision: verdict.decision,
      policy_version: verdict.policy_version,
      verdict,
    });
  }

  return {
    verdict,
    action: input.action,
    action_risk: input.action_risk,
    claim_ids: claimIds,
  };
}

/** Whether the action gate is mandatory at this risk level. Mirrors the retrieval policy. */
export function isGateRequired(risk: ActionRisk): boolean {
  return risk === "medium" || risk === "high";
}

// ---------------------------------------------------------------------------
// shared checks
// ---------------------------------------------------------------------------

function selectorOf(scope: StoreScope): QueryRequest["scope"] {
  return {
    tenant: scope.tenant,
    ...(scope.project === undefined ? {} : { project: scope.project }),
    ...(scope.user === undefined ? {} : { user: scope.user }),
    ...(scope.agent === undefined ? {} : { agent: scope.agent }),
    ...(scope.session === undefined ? {} : { session: scope.session }),
  };
}

function assertScopeBindsPurpose(scope: StoreScope): void {
  if (scope.purpose.length === 0) {
    throw new ScopeViolationError(
      "empty_purpose",
      "write scope declares no purpose. A write with no purpose is unreachable by every later read, so it would " +
        "be recorded and then never be retrievable — a silent loss rather than a boundary",
    );
  }
}

function assertPurposeReachable(scope: StoreScope, purpose: string): void {
  assertScopeBindsPurpose(scope);
  if (purpose.trim() === "") {
    throw new ScopeViolationError("empty_purpose", "purpose is empty; an empty purpose means unreachable, not unrestricted");
  }
  if (!scope.purpose.includes(purpose)) {
    throw new ScopeViolationError(
      "purpose_not_in_scope",
      `purpose ${JSON.stringify(purpose)} is not one of the purposes this scope was admitted for ` +
        `[${scope.purpose.join(", ")}]. Reading across purposes is the scope widening the policy exists to prevent`,
      { purpose, scope_purposes: [...scope.purpose] },
    );
  }
}

/**
 * A bounded prefix of a payload's canonical text.
 *
 * Truncation is deliberate and stated: the excerpt is text for extraction and for a
 * human reading `/explain`, not a re-parsable encoding. The hashes beside it are over
 * the complete value, so an auditor can always tell that an excerpt is partial.
 */
function excerptOf(value: unknown, limit: number | false): string | null {
  if (limit === false || limit <= 0) return null;
  const text = typeof value === "string" ? value : canonicalJson(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…[truncated ${text.length - limit} chars; full value hashed as sha256]`;
}

/**
 * A stable id for a tool call, for callers that do not have one.
 *
 * Exported because the alternative at a call site is `crypto.randomUUID()`, which
 * makes a retried node append a second observation of the same call.
 */
export function deterministicCallId(tool: string, input: unknown): string {
  return `${tool}:${sha256Hex(canonicalJson(input)).slice(0, 32)}`;
}
