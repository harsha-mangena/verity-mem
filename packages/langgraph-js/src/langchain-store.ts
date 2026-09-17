/**
 * The module that touches the optional peer.
 *
 * Nothing in `index.ts` imports this file, and nothing imports it transitively. It
 * exists so that an application which *has* `@langchain/core` installed can hand a
 * `BaseStore` instance to code that checks for one, while an application that does
 * not install the peer still gets the namespace mapping, the store semantics and the
 * four hooks. The subpath export (`@veritymem/langgraph/langchain-core`) is the only
 * way in, which is what makes "only imported when the peer is present" a structural
 * property rather than a promise.
 *
 * Two interfaces are in circulation and this class covers both, deliberately:
 *
 *   * `@langchain/core`'s `BaseStore<K, V>` is string-keyed (`mget`/`mset`/`mdelete`/
 *     `yieldKeys`). Its keys are encoded with `encodeStoreKey`, which names every
 *     scope dimension and refuses a key that does not (`decodeStoreKey`). That is a
 *     transport encoding for an interface that only speaks strings — not a licence to
 *     concatenate a tenant and a purpose into one opaque key.
 *   * LangGraph's store API is namespaced (`get`/`put`/`delete`/`search`/
 *     `listNamespaces`/`batch`). Those methods are implemented here too, so the same
 *     object can be registered where a namespaced store is expected.
 *
 * `ClaimBackedStore` remains the implementation; this class is a thin adapter over it.
 */
import { BaseStore } from "@langchain/core/stores";
import type { Clock } from "./clock.ts";
import type { VerityApiClient } from "./client.ts";
import { decodeStoreKey, encodeStoreKey, type NamespaceCodec, type ScopeDimension } from "./namespace.ts";
import {
  ClaimBackedStore,
  type ClaimBackedStoreOptions,
  type SearchOptions,
  type StoreClaimValue,
  type StoreItem,
  type StoreOperation,
  type StoreOperationResults,
  type StorePutReceipt,
} from "./store.ts";

/** How the string-keyed store is wired. See `ClaimBackedStoreOptions` for `dimensions`. */
export interface VerityMemLangChainStoreOptions {
  readonly client: VerityApiClient;
  readonly dimensions?: readonly ScopeDimension[];
  readonly actor_id?: string;
  readonly clock?: Clock;
  readonly default_limit?: number;
}

/**
 * A `BaseStore` over the claim store.
 *
 * Extends the peer's class so `instanceof BaseStore` holds, and delegates every
 * operation to `ClaimBackedStore`, so the semantics — proposals on write, beliefs on
 * read, refusals on delete and enumerate — are defined in exactly one place.
 */
export class VerityMemLangChainStore extends BaseStore<string, StoreClaimValue> {
  /** Required by the peer's `Serializable` base. A path to the module this class lives in. */
  override lc_namespace = ["veritymem", "langgraph", "store"];

  private readonly core: ClaimBackedStore;

  constructor(options: VerityMemLangChainStoreOptions) {
    super();
    const coreOptions: ClaimBackedStoreOptions = {
      client: options.client,
      ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions }),
      ...(options.actor_id === undefined ? {} : { actor_id: options.actor_id }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.default_limit === undefined ? {} : { default_limit: options.default_limit }),
    };
    this.core = new ClaimBackedStore(coreOptions);
  }

  /** The underlying store, for callers that want the receipts this interface discards. */
  get claimStore(): ClaimBackedStore {
    return this.core;
  }

  /** The namespace codec in force, so callers can build encoded keys with the same rules. */
  get namespaceCodec(): NamespaceCodec {
    return this.core.namespaceCodec;
  }

  // -------------------------------------------------------------------------
  // String-keyed interface (the one `@langchain/core` declares)
  // -------------------------------------------------------------------------

  /**
   * Read several items by encoded key.
   *
   * A missing item is `undefined` in its own position, never a hole and never a
   * shorter array: the caller is matching results to inputs by index.
   */
  override async mget(keys: string[]): Promise<(StoreClaimValue | undefined)[]> {
    const out: (StoreClaimValue | undefined)[] = [];
    for (const encoded of keys) {
      const { namespace, key } = decodeStoreKey(encoded, this.core.namespaceCodec);
      const item = await this.core.get(namespace, key);
      out.push(item?.value);
    }
    return out;
  }

  /**
   * Propose several values.
   *
   * `mset` returns `void` because the peer's interface does, which means the ledger
   * receipts are discarded here. They are not lost to the system — each write is an
   * event — but a caller that needs the event id must use `putWithReceipt`, because
   * this method cannot return it.
   */
  override async mset(keyValuePairs: [string, StoreClaimValue][]): Promise<void> {
    for (const [encoded, value] of keyValuePairs) {
      const { namespace, key } = decodeStoreKey(encoded, this.core.namespaceCodec);
      await this.core.put(namespace, key, value as unknown as Readonly<Record<string, unknown>>);
    }
  }

  /** Refused: deletion is a retention job with a residual scan, not a store operation. */
  override async mdelete(keys: string[]): Promise<void> {
    const first = keys[0];
    if (first === undefined) return;
    const { namespace, key } = decodeStoreKey(first, this.core.namespaceCodec);
    await this.core.delete(namespace, key);
  }

  /** Refused: yielding keys enumerates claims without a query. Use `search`. */
  override async *yieldKeys(prefix?: string): AsyncGenerator<string> {
    void prefix;
    // Iterating, not calling, is what triggers the refusal: a generator body does not
    // run until the first `next()`, so `await this.core.yieldKeys()` alone would have
    // been a silent no-op — precisely the failure this store exists to refuse.
    for await (const keys of this.core.yieldKeys()) {
      yield keys.join("|");
    }
  }

  // -------------------------------------------------------------------------
  // Namespaced interface (the one LangGraph's store API declares)
  // -------------------------------------------------------------------------

  /** `get(namespace, key)`; the key is a claim id. See `ClaimBackedStore.get`. */
  async get(namespace: string[], key: string): Promise<StoreClaimValue | undefined> {
    return (await this.core.get(namespace, key))?.value;
  }

  /** `put(namespace, key, value)` in the peer's `void` shape; use `putWithReceipt` for the event id. */
  async put(namespace: string[], key: string, value: Record<string, unknown>): Promise<void> {
    await this.core.put(namespace, key, value);
  }

  /**
   * `put` with the ledger receipt preserved.
   *
   * Exists because the LangGraph `put` signature returns nothing, and a caller who
   * needs to cite the event that recorded a write cannot get it back afterwards.
   */
  async putWithReceipt(
    namespace: readonly string[],
    key: string,
    value: Readonly<Record<string, unknown>>,
  ): Promise<StorePutReceipt> {
    return await this.core.put(namespace, key, value);
  }

  /** `search(namespacePrefix, options)`. Needs `filter.query` or `filter.subjects`. */
  async search(
    namespacePrefix: string[],
    options?: { filter?: Record<string, unknown>; limit?: number; offset?: number },
  ): Promise<StoreItem[]> {
    const searchOptions: SearchOptions = {
      ...(options?.filter === undefined ? {} : { filter: options.filter }),
      ...(options?.limit === undefined ? {} : { limit: options.limit }),
      ...(options?.offset === undefined ? {} : { offset: options.offset }),
    };
    return await this.core.search(namespacePrefix, searchOptions);
  }

  /** Refused. See `ClaimBackedStore.listNamespaces`. */
  async listNamespaces(): Promise<string[][]> {
    return await this.core.listNamespaces();
  }

  /** Refused. See `ClaimBackedStore.delete`. */
  async delete(namespace: string[], key: string): Promise<void> {
    await this.core.delete(namespace, key);
  }

  /** The namespaced batch. Failures are reported, never dropped. */
  async batch<Ops extends readonly StoreOperation[]>(operations: Ops): Promise<StoreOperationResults<Ops>> {
    return await this.core.batch(operations);
  }

  /** The async batch LangGraph calls; same sequential implementation. */
  async abatch<Ops extends readonly StoreOperation[]>(operations: Ops): Promise<StoreOperationResults<Ops>> {
    return await this.core.abatch(operations);
  }

  /** Builds an encoded key for {@link mget}/{@link mset}. Throws on a namespace that is not explicit. */
  encodeKey(namespace: readonly string[], key: string): string {
    const encoded = encodeStoreKey(namespace, key);
    // Decoded immediately so a caller cannot build a key this store will refuse later.
    decodeStoreKey(encoded, this.core.namespaceCodec);
    return encoded;
  }
}
