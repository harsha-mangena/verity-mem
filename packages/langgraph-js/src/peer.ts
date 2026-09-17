/**
 * Runtime discovery of which LangGraph store packages are installed.
 *
 * `ClaimBackedStore` implements the namespaced store interface structurally, so this
 * adapter works with no peer installed at all: LangGraph calls `batch`, `get`, `search`
 * and `delete` on whatever store it was handed, and does not require `instanceof`.
 * Where `instanceof` *is* required, the subpath classes extend the peer directly —
 * `@veritymem/langgraph/langgraph` for `@langchain/langgraph-checkpoint` and
 * `@veritymem/langgraph/langchain-core` for the string-keyed store in
 * `@langchain/core` — and those modules are imported only by an application that has
 * the peer.
 *
 * This module exists so a caller can *ask* which situation they are in. "The adapter
 * silently used the structural fallback" is exactly the kind of unstated difference
 * that makes an integration report untrustworthy, so the answer is a value, not a
 * comment.
 *
 * The peer is loaded through a variable specifier on purpose: a static import of a
 * package that may not be installed is a compile error for every consumer of this
 * package, which would make an optional peer mandatory in practice.
 */
import type { Clock } from "./clock.ts";
import type { VerityApiClient } from "./client.ts";
import type { ScopeDimension } from "./namespace.ts";
import {
  ClaimBackedStore,
  type ClaimBackedStoreOptions,
  type StoreOperation,
  type StoreOperationResults,
} from "./store.ts";

/**
 * The methods LangGraph's store API calls, described structurally rather than
 * imported. It is the shape `ClaimBackedStore` satisfies and the shape the subclass
 * modules extend.
 *
 * `put` stops at three parameters here. The peer's fourth parameter is a per-item
 * index configuration, which this store refuses rather than accepts and discards, so
 * the structural interface does not offer it; the subclass modules, which speak the
 * peer's exact signature, refuse it explicitly.
 */
export interface NamespacedStore {
  batch<Ops extends readonly StoreOperation[]>(operations: Ops): Promise<StoreOperationResults<Ops>>;
  abatch<Ops extends readonly StoreOperation[]>(operations: Ops): Promise<StoreOperationResults<Ops>>;
  get(namespace: string[], key: string): Promise<unknown>;
  put(namespace: string[], key: string, value: Record<string, unknown>): Promise<unknown>;
  delete(namespace: string[], key: string): Promise<void>;
  search(
    namespacePrefix: string[],
    options?: { filter?: Record<string, unknown>; limit?: number; offset?: number; query?: string },
  ): Promise<unknown[]>;
  listNamespaces(options?: Record<string, unknown>): Promise<string[][]>;
}

/** One probe: a specifier, whether it resolved, and whether it offered a namespaced store. */
export interface PeerProbe {
  readonly specifier: string;
  readonly found: boolean;
  readonly namespaced: boolean;
  readonly detail: string;
}

export interface LangGraphPeerReport {
  /** Every specifier probed, in order, with the outcome. */
  readonly probes: readonly PeerProbe[];
  /** The first specifier that exported a namespaced base class, or `null`. */
  readonly base_store: string | null;
}

export interface NamespacedStoreOptions {
  readonly client: VerityApiClient;
  readonly dimensions?: readonly ScopeDimension[];
  readonly actor_id?: string;
  readonly clock?: Clock;
  readonly default_limit?: number;
  /**
   * When true, a missing peer is an error instead of a fallback.
   *
   * Set it when the caller's own code will do `instanceof BaseStore`; leaving it false
   * gets the structural implementation, which is what a graph actually calls.
   */
  readonly require_peer?: boolean;
}

const PEER_CANDIDATES = ["@langchain/langgraph-checkpoint", "@langchain/core"] as const;

/**
 * Report which LangGraph store base classes this installation can see.
 *
 * The structural store works either way, so this is not a health check — it is the
 * input to a decision about which of the three entry points an application should use.
 */
export async function probeLangGraphPeer(): Promise<LangGraphPeerReport> {
  const probes: PeerProbe[] = [];
  let baseStore: string | null = null;

  for (const specifier of PEER_CANDIDATES) {
    const result = await probeSpecifier(specifier);
    probes.push(result);
    if (result.namespaced && baseStore === null) baseStore = specifier;
  }

  return { probes, base_store: baseStore };
}

async function probeSpecifier(specifier: string): Promise<PeerProbe> {
  try {
    // Variable specifier: see the module comment. TypeScript must not resolve this.
    const imported = (await import(specifier)) as Record<string, unknown>;
    const candidate = imported["BaseStore"];
    if (typeof candidate !== "function") {
      return {
        specifier,
        found: true,
        namespaced: false,
        detail:
          "module resolved but does not export a BaseStore class; its namespaced store lives at a subpath, " +
          "e.g. @langchain/core/stores for the string-keyed one",
      };
    }
    const prototype = (candidate as { prototype?: Record<string, unknown> }).prototype;
    // `batch` is abstract in LangGraph's BaseStore, so it is absent from the prototype
    // at runtime; `search` and `listNamespaces` are implemented there. They are the
    // discriminator between the namespaced store and the string-keyed one.
    const namespaced =
      typeof prototype?.["search"] === "function" && typeof prototype?.["listNamespaces"] === "function";
    const stringKeyed = typeof prototype?.["mget"] === "function" && typeof prototype?.["mset"] === "function";
    return {
      specifier,
      found: true,
      namespaced,
      detail: namespaced
        ? "exports a namespaced BaseStore (get/search/put/delete/listNamespaces); use it where instanceof is required"
        : stringKeyed
          ? "exports a string-keyed BaseStore (mget/mset/mdelete/yieldKeys); use the langchain-core entry point"
          : "exports a BaseStore whose interface is neither namespaced nor string-keyed",
    };
  } catch (error) {
    return {
      specifier,
      found: false,
      namespaced: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * A store ready to register with a LangGraph graph.
 *
 * Returns the structural implementation, which is what a graph calls, and reports
 * through `require_peer` when the caller needed `instanceof` instead. There is no
 * runtime class synthesis here: a class built at runtime cannot be typechecked, and an
 * adapter whose only typed path is a convenience wrapper is one refactor away from
 * being untyped everywhere. The typed subclass lives in `langgraph-store.ts`, behind a
 * subpath, and is imported by applications that have the peer.
 */
export async function createLangGraphStore(options: NamespacedStoreOptions): Promise<NamespacedStore> {
  const coreOptions: ClaimBackedStoreOptions = {
    client: options.client,
    ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions }),
    ...(options.actor_id === undefined ? {} : { actor_id: options.actor_id }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.default_limit === undefined ? {} : { default_limit: options.default_limit }),
  };
  const core = new ClaimBackedStore(coreOptions);

  if (options.require_peer !== true) return core;

  const report = await probeLangGraphPeer();
  if (report.base_store === null) {
    throw new Error(
      "require_peer was set but no namespaced LangGraph BaseStore is installed. Probed: " +
        report.probes.map((probe) => `${probe.specifier} (${probe.detail})`).join("; "),
    );
  }
  return core;
}
