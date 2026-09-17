/**
 * Runtime discovery of the LangGraph store base class.
 *
 * LangGraph's own store is namespaced (`batch`/`get`/`put`/`delete`/`search`),
 * `ClaimBackedStore` already implements that shape structurally, and LangGraph reads
 * a store by calling those methods — so the adapter works with no peer installed at
 * all. This module exists for the two cases where a caller needs more than structural
 * compatibility: they want `instanceof BaseStore` to hold, or they want the peer's own
 * convenience wrappers (`mget`/`mset`/`yieldKeys`) to be inherited rather than
 * reimplemented.
 *
 * The peer is loaded through a *variable* specifier on purpose. A static import of a
 * package that may not be installed is a compile error for every consumer of this
 * package, which would make an optional peer mandatory in practice. The cost is that
 * the base class is untyped at runtime; the benefit is that `pnpm typecheck` and the
 * test suite pass in a workspace where LangGraph was never installed.
 */
import type { Clock } from "./clock.ts";
import type { VerityApiClient } from "./client.ts";
import type { ScopeDimension } from "./namespace.ts";
import {
  ClaimBackedStore,
  type SearchOptions,
  type StoreItem,
  type StoreOperation,
  type StoreOperationResults,
  type StorePutReceipt,
} from "./store.ts";

/** The methods LangGraph's store API calls. A structural description, not an import. */
export interface NamespacedStore {
  batch<Ops extends readonly StoreOperation[]>(operations: Ops): Promise<StoreOperationResults<Ops>>;
  abatch<Ops extends readonly StoreOperation[]>(operations: Ops): Promise<StoreOperationResults<Ops>>;
  get(namespace: string[], key: string): Promise<unknown>;
  put(namespace: string[], key: string, value: Record<string, unknown>): Promise<unknown>;
  delete(namespace: string[], key: string): Promise<void>;
  search(namespacePrefix: string[], options?: Record<string, unknown>): Promise<unknown[]>;
  listNamespaces(options?: Record<string, unknown>): Promise<string[][]>;
}

export interface LangGraphPeerReport {
  /** Every specifier probed, in order, with the outcome. */
  readonly probes: readonly {
    readonly specifier: string;
    readonly found: boolean;
    readonly namespaced: boolean;
    readonly detail: string;
  }[];
  /** The first specifier that exported a usable base class, or `null`. */
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
 * Exported because "the adapter silently used the structural fallback" is exactly the
 * kind of unstated difference that makes an integration report untrustworthy, so the
 * caller can ask, log, and fail loudly if the answer matters.
 */
export async function probeLangGraphPeer(): Promise<LangGraphPeerReport> {
  const probes: LangGraphPeerReport["probes"] = [];
  let baseStore: string | null = null;

  for (const specifier of PEER_CANDIDATES) {
    const result = await probeSpecifier(specifier);
    probes.push(result);
    if (result.namespaced && baseStore === null) baseStore = specifier;
  }

  return { probes, base_store: baseStore };
}

async function probeSpecifier(specifier: string): Promise<LangGraphPeerReport["probes"][number]> {
  try {
    // Variable specifier: see the module comment. TypeScript must not resolve this.
    const imported = (await import(specifier)) as Record<string, unknown>;
    const candidate = imported["BaseStore"];
    if (typeof candidate !== "function") {
      return { specifier, found: true, namespaced: false, detail: "module resolved but exports no BaseStore class" };
    }
    const prototype = (candidate as { prototype?: Record<string, unknown> }).prototype;
    const namespaced = typeof prototype?.["batch"] === "function" && typeof prototype?.["search"] === "function";
    return {
      specifier,
      found: true,
      namespaced,
      detail: namespaced
        ? "exports a namespaced BaseStore (batch + search)"
        : "exports a BaseStore without batch/search; its interface is string-keyed, use langchain-core.ts instead",
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
 * Returns an instance of the peer's namespaced `BaseStore` when one is installed —
 * built at runtime as a subclass that delegates to `ClaimBackedStore`, so the
 * semantics do not fork — and the structural implementation otherwise. With
 * `require_peer`, the absence is reported instead of papered over.
 */
export async function createLangGraphStore(options: NamespacedStoreOptions): Promise<NamespacedStore> {
  const core = new ClaimBackedStore({
    client: options.client,
    ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions }),
    ...(options.actor_id === undefined ? {} : { actor_id: options.actor_id }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.default_limit === undefined ? {} : { default_limit: options.default_limit }),
  });

  const report = await probeLangGraphPeer();
  if (report.base_store === null) {
    if (options.require_peer === true) {
      throw new Error(
        `require_peer was set but no namespaced LangGraph BaseStore is installed. Probed: ` +
          report.probes.map((probe) => `${probe.specifier} (${probe.detail})`).join("; "),
      );
    }
    return core as NamespacedStore;
  }

  const imported = (await import(/* @vite-ignore */ report.base_store)) as { BaseStore?: unknown };
  const Base = imported.BaseStore as new () => object;
  return new (class PeerBackedStore extends Base implements NamespacedStore {
    batch<Ops extends readonly StoreOperation[]>(operations: Ops): Promise<StoreOperationResults<Ops>> {
      return core.batch(operations);
    }
    abatch<Ops extends readonly StoreOperation[]>(operations: Ops): Promise<StoreOperationResults<Ops>> {
      return core.abatch(operations);
    }
    get(namespace: string[], key: string): Promise<unknown> {
      return core.get(namespace, key);
    }
    async put(namespace: string[], key: string, value: Record<string, unknown>): Promise<void> {
      await core.put(namespace, key, value);
    }
    async delete(namespace: string[], key: string): Promise<void> {
      await core.delete(namespace, key);
    }
    search(namespacePrefix: string[], searchOptions?: Record<string, unknown>): Promise<unknown[]> {
      // Rebuilt field by field rather than cast: an option object that arrives from a
      // peer's own call path is not evidence that it has the shape this store expects.
      const filter = searchOptions?.["filter"];
      const limit = searchOptions?.["limit"];
      const offset = searchOptions?.["offset"];
      const options: SearchOptions = {
        ...(typeof filter === "object" && filter !== null
          ? { filter: filter as Readonly<Record<string, unknown>> }
          : {}),
        ...(typeof limit === "number" ? { limit } : {}),
        ...(typeof offset === "number" ? { offset } : {}),
      };
      return core.search(namespacePrefix, options);
    }
    listNamespaces(): Promise<string[][]> {
      return core.listNamespaces();
    }
  })();
}

/** Re-exported so a caller of this module does not need a second import for the receipt type. */
export type { StoreItem, StorePutReceipt };
