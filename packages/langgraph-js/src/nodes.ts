/**
 * The four graph nodes.
 *
 * Each node is a plain `(state, dependencies) => Promise<state>` function: usable as
 * a LangGraph node through `createMemoryNodes`, callable directly in a test, and
 * usable from any other graph runtime that passes a state object around. Nothing here
 * imports LangGraph, so the semantics are testable whether or not the peer package is
 * installed.
 *
 * Two properties are load-bearing and are the reason the nodes are not thinner
 * wrappers around the hooks:
 *
 *   * The returned state is the *whole* state, not a patch. LangGraph merges a
 *     partial state into its channels, and a node that returned only its own channel
 *     would silently drop the caller's other channels when called directly — which is
 *     exactly how a test and production drift apart.
 *   * `gate_action` raises. A denial never becomes a field a caller can forget to
 *     read. See `ActionDeniedError`.
 */
import type { ActionRisk, MemoryPacket } from "@veritymem/contracts";
import type { VerityApiClient } from "./client.ts";
import type { Clock } from "./clock.ts";
import { ActionDeniedError } from "./errors.ts";
import type { FormattedMemoryContext } from "./context.ts";
import {
  afterRun,
  afterTool,
  beforeAction,
  beforeRun,
  type ActionGateCheck,
  type AgentConclusion,
  type BeforeRunInput,
  type ObservationReceipt,
  type ProposalReceipt,
  type ToolObservationInput,
  type TranscriptEntry,
} from "./hooks.ts";
import { storeItemFromPacketClaim, type StoreItem } from "./store.ts";
import type { StoreScope } from "./namespace.ts";

/**
 * The channels the memory nodes read and write.
 *
 * An index signature is included so a graph can merge this with its own channels
 * without a type error; the named channels are the ones the nodes own. `query`,
 * `run_id`, `transcript`, `pending_observations` and `pending_conclusions` are inputs
 * the caller is expected to fill, which is why they are typed as plain data rather
 * than as opaque handles.
 */
export interface VerityMemoryState {
  /** The question `recall_memory` should ask. Required by that node. */
  readonly query?: string;
  /** Stable identity for the run; the idempotency key of the transcript event. */
  readonly run_id?: string;
  readonly transcript?: readonly TranscriptEntry[];
  /** Tool observations the node should record. */
  readonly pending_observations?: readonly ToolObservationInput[];
  /** The agent's conclusions, offered as proposals. */
  readonly pending_conclusions?: readonly AgentConclusion[];
  /** The action the graph is about to take, checked by `gate_action`. */
  readonly pending_action?: PendingAction;

  /** Written by `recall_memory`. */
  readonly memory?: {
    readonly packet: MemoryPacket;
    readonly context: FormattedMemoryContext;
    readonly items: readonly StoreItem[];
    readonly namespace: readonly string[];
  };
  /** Appended to by `record_observations`. */
  readonly observations?: readonly ObservationReceipt[];
  /** Appended to by `propose_claims`. */
  readonly proposals?: readonly ProposalReceipt[];
  /** Written by `gate_action` when, and only when, the action is allowed. */
  readonly action_gate?: ActionGateCheck;

  readonly [channel: string]: unknown;
}

/** The side effect a graph is about to take, and the claims it depends on. */
export interface PendingAction {
  readonly action: string;
  readonly action_risk: ActionRisk;
  readonly claim_ids: readonly string[];
  readonly trace_id?: string;
}

/** The scope and purpose every node in a graph operates under. */
export interface MemoryNodeScope {
  readonly scope: StoreScope;
  /** Exactly one purpose, for the same reason a read is authorized for exactly one. */
  readonly purpose: string;
}

/**
 * Everything a node needs that is not in the state.
 *
 * Scope and purpose are bound here rather than read from the state so that a graph cannot
 * change the scope it is authorized for by writing to a channel.
 */
export interface MemoryNodeDependencies extends MemoryNodeScope {
  readonly client: VerityApiClient;
  readonly clock?: Clock;
  /** The principal recorded on the agent's own writes, e.g. `agent:planner`. */
  readonly actor_id: string;
  /** Recall options applied when `recall_memory` runs: time semantics, risk, limits. */
  readonly recall?: Omit<BeforeRunInput, "query" | "scope" | "purpose">;
  /** Overrides the recall query instead of reading `state.query`. */
  readonly query?: string;
  /** Overrides the run id instead of reading `state.run_id`. */
  readonly run_id?: (state: VerityMemoryState) => string;
  /** Overrides the action instead of reading `state.pending_action`. */
  readonly action?: PendingAction;
}

/**
 * Query memory and attach the packet to the state.
 *
 * Items are attached alongside the packet because a graph that wants to hand a
 * specific claim to `gate_action` needs the claim ids and their provenance together,
 * and re-deriving them from the rendering would mean parsing text back into data.
 */
export async function recallMemory(
  state: VerityMemoryState,
  dependencies: MemoryNodeDependencies,
): Promise<VerityMemoryState> {
  const query = dependencies.query ?? state.query;
  if (query === undefined || query.trim() === "") {
    throw new Error(
      "recall_memory: no query. Put the run's question on `state.query` or set `query` in the node dependencies; " +
        "an empty query would retrieve by recency, which is not a memory lookup",
    );
  }

  const result = await beforeRun(
    { client: dependencies.client, ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }) },
    {
      ...(dependencies.recall ?? {}),
      query,
      scope: dependencies.scope,
      purpose: dependencies.purpose,
    },
  );

  return {
    ...state,
    memory: {
      packet: result.packet,
      context: result.context,
      namespace: result.namespace,
      items: result.packet.claims.map((claim) =>
        storeItemFromPacketClaim(claim, dependencies.scope.tenant, {
          trace_id: result.packet.trace_id,
          policy_version: result.packet.policy_version,
          projection_watermark: result.packet.projection_watermark,
        }),
      ),
    },
  };
}

/**
 * Record structured tool observations.
 *
 * Observations are recorded, not proposed as claims: the tool's output is evidence,
 * and what may be believed from it is the commit gate's decision, made from the
 * evidence rather than from the agent's summary of it.
 */
export async function recordObservations(
  state: VerityMemoryState,
  dependencies: MemoryNodeDependencies,
): Promise<VerityMemoryState> {
  const pending = state.pending_observations ?? [];
  if (pending.length === 0) return state;

  const receipts: ObservationReceipt[] = [];
  for (const observation of pending) {
    receipts.push(
      await afterTool(
        { client: dependencies.client, ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }) },
        {
          ...observation,
          scope: dependencies.scope,
          actor_id: observation.actor_id ?? dependencies.actor_id,
        },
      ),
    );
  }

  return { ...state, observations: [...(state.observations ?? []), ...receipts] };
}

/**
 * Record the transcript and propose the agent's conclusions.
 *
 * The node returns receipts, never claims. A graph that wants a claim id has to wait
 * for the gate and read it back, which is the whole point: the agent does not get to
 * decide what is true about its own run.
 */
export async function proposeClaims(
  state: VerityMemoryState,
  dependencies: MemoryNodeDependencies,
): Promise<VerityMemoryState> {
  const runId = state.run_id ?? dependencies.run_id?.(state);
  if (runId === undefined || runId.trim() === "") {
    throw new Error(
      "propose_claims: no run id. Put a stable id on `state.run_id` or provide `run_id` in the node dependencies; " +
        "a run that can be retried without one appends its transcript twice",
    );
  }
  const conclusions = state.pending_conclusions ?? [];
  const transcript = state.transcript ?? [];
  if (conclusions.length === 0 && transcript.length === 0) return state;

  const result = await afterRun(
    { client: dependencies.client, ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }) },
    {
      run_id: runId,
      scope: dependencies.scope,
      transcript,
      conclusions,
      actor_id: dependencies.actor_id,
    },
  );

  return { ...state, proposals: [...(state.proposals ?? []), ...result.proposals] };
}

/**
 * Verify the action against the claims it depends on, or raise.
 *
 * Deliberately not a conditional edge and deliberately not a boolean field: an
 * unattended agent ignores a soft flag, and a graph author who forgets to branch on
 * one ships an ungated side effect. The exception unwinds the graph before the tool
 * call happens, which is the only ordering that enforces anything.
 */
export async function gateAction(
  state: VerityMemoryState,
  dependencies: MemoryNodeDependencies,
): Promise<VerityMemoryState> {
  const pending = dependencies.action ?? state.pending_action;
  if (pending === undefined) {
    throw new Error(
      "gate_action: no action to gate. Set `state.pending_action` or the `action` dependency; a gate that runs " +
        "with nothing to check would report success without checking anything",
    );
  }

  const traceId = pending.trace_id ?? state.memory?.packet.trace_id;
  const check = await beforeAction(
    { client: dependencies.client, ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }) },
    {
      action: pending.action,
      action_risk: pending.action_risk,
      scope: dependencies.scope,
      purpose: dependencies.purpose,
      claim_ids: pending.claim_ids,
      ...(traceId === undefined ? {} : { trace_id: traceId }),
    },
  );

  return { ...state, action_gate: check };
}

/**
 * The nodes bound to their dependencies, ready for `graph.addNode`.
 *
 * The unbound functions above are what tests and non-LangGraph callers use; this
 * factory exists so a graph does not have to repeat `(state) => recallMemory(state, deps)`
 * four times, which is where a dependency quietly gets wired to the wrong node.
 */
export function createMemoryNodes(dependencies: MemoryNodeDependencies): {
  readonly recall_memory: (state: VerityMemoryState) => Promise<VerityMemoryState>;
  readonly record_observations: (state: VerityMemoryState) => Promise<VerityMemoryState>;
  readonly propose_claims: (state: VerityMemoryState) => Promise<VerityMemoryState>;
  readonly gate_action: (state: VerityMemoryState) => Promise<VerityMemoryState>;
} {
  return {
    recall_memory: (state) => recallMemory(state, dependencies),
    record_observations: (state) => recordObservations(state, dependencies),
    propose_claims: (state) => proposeClaims(state, dependencies),
    gate_action: (state) => gateAction(state, dependencies),
  };
}

/** Re-exported so a node's failure can be caught by type rather than by message. */
export { ActionDeniedError };
