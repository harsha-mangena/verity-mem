/**
 * The module that extends LangGraph's own store class.
 *
 * `@langchain/langgraph-checkpoint`'s `BaseStore` is the namespaced store LangGraph
 * actually reads: `batch` is its one abstract method, and `get`, `search`, `put`,
 * `delete` and `listNamespaces` are concrete wrappers that funnel into `batch`. So
 * this class overrides `batch` and nothing else — every other operation keeps the
 * peer's own argument validation and result shape, and the VerityMem semantics live in
 * exactly one place (`ClaimBackedStore`).
 *
 * Nothing in `index.ts` imports this file and nothing imports it transitively. It is
 * reachable only through the `@veritymem/langgraph/langgraph` subpath, which is what
 * makes "imported only when the peer is present" a structural property rather than a
 * promise.
 *
 * Two consequences of delegating to the peer's wrappers are worth stating, because
 * they are observable:
 *
 *   * The peer validates a namespace before it batches: labels may not be empty and
 *     may not contain a period. `createNamespaceCodec` applies the same rule up front,
 *     so the failure names the dimension instead of surfacing as a peer error.
 *   * The peer's `delete` is expressed as a `put` with a `null` value. That is mapped
 *     to the same refusal `ClaimBackedStore.delete` gives: an agent-facing store may
 *     not erase evidence, and deletion is proven by a retention job's residual scan.
 */
import {
  BaseStore,
  type Item,
  type Operation,
  type OperationResults,
  type SearchItem,
} from "@langchain/langgraph-checkpoint";
import type { Clock } from "./clock.ts";
import type { VerityApiClient } from "./client.ts";
import { StoreOperationRefusedError } from "./errors.ts";
import type { ScopeDimension } from "./namespace.ts";
import { ClaimBackedStore, type ClaimBackedStoreOptions, type StoreItem } from "./store.ts";

/** How the peer-backed store is wired. See `ClaimBackedStoreOptions` for `dimensions`. */
export interface VerityMemStoreOptions {
  readonly client: VerityApiClient;
  readonly dimensions?: readonly ScopeDimension[];
  readonly actor_id?: string;
  readonly clock?: Clock;
  readonly default_limit?: number;
}

/**
 * A LangGraph store whose writes are proposals and whose reads are beliefs.
 *
 * Registering it gives a graph the store API LangGraph expects while keeping the
 * VerityMem distinction intact: `put` appends an untrusted event, `get` and `search`
 * return accepted claims with their provenance, and `delete` is refused. It must never
 * be used as a checkpointer — a checkpoint says where execution stopped; a claim says
 * what is believed to be true.
 */
export class VerityMemStore extends BaseStore {
  private readonly core: ClaimBackedStore;

  constructor(options: VerityMemStoreOptions) {
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

  /** The underlying store, for the receipts this interface discards. */
  get claimStore(): ClaimBackedStore {
    return this.core;
  }

  /**
   * The one abstract method: dispatch each operation to the claim store.
   *
   * Sequential, and a failure is reported rather than dropped. The peer's wrappers
   * pass exactly one operation, so batching is where a caller's multi-operation call
   * lands, and a partially applied batch that reported success would be a silent
   * half-write.
   */
  override async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const results: unknown[] = [];
    const failures: { readonly index: number; readonly error: unknown }[] = [];

    for (const [index, operation] of operations.entries()) {
      try {
        results.push(await this.dispatch(operation));
      } catch (error) {
        failures.push({ index, error });
        results.push(undefined);
      }
    }

    if (failures.length > 0) {
      // The peer's own wrappers send exactly one operation, so a single-operation
      // failure is rethrown as itself: wrapping it would replace a typed refusal with
      // an untyped envelope on every `search`, `get` and `delete` call.
      const first = failures[0];
      if (failures.length === 1 && operations.length === 1 && first !== undefined) {
        throw first.error;
      }
      const detail = failures
        .map((failure) => `#${failure.index}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`)
        .join("; ");
      throw new AggregateError(
        failures.map((failure) => failure.error),
        `store batch failed: ${failures.length} of ${operations.length} operation(s) rejected — ${detail}. ` +
          `${operations.length - failures.length} operation(s) were applied and are not rolled back`,
      );
    }
    return results as OperationResults<Op>;
  }

  /**
   * `put` with the ledger receipt preserved.
   *
   * The peer's `put` returns `void` by contract, so the event id that records a write
   * cannot come back through it. A caller that needs to cite the event — which is what
   * makes a later `/explain` answerable — uses this instead.
   */
  async putWithReceipt(
    namespace: string[],
    key: string,
    value: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly event_id: string; readonly seq: number; readonly deduplicated: boolean }> {
    return await this.core.put(namespace, key, value);
  }

  /** The codec in force, so callers can build namespaces with the same rules. */
  get namespaceCodec(): ClaimBackedStore["namespaceCodec"] {
    return this.core.namespaceCodec;
  }

  private async dispatch(operation: Operation): Promise<unknown> {
    const record = operation as unknown as Record<string, unknown>;

    if (Array.isArray(record["namespacePrefix"])) {
      return await this.searchOperation(record);
    }

    const namespace = record["namespace"];
    const key = record["key"];
    if (Array.isArray(namespace) && typeof key === "string") {
      if (!("value" in record)) {
        return toPeerItem(await this.core.get(namespace as string[], key));
      }
      // The peer expresses deletion as a null value; that is the same refusal.
      if (record["value"] === null || record["value"] === undefined) {
        await this.core.delete(namespace as string[], key);
        return undefined;
      }
      if (record["index"] !== undefined && record["index"] !== false) {
        throw new StoreOperationRefusedError(
          "index_config",
          "per-item field indexing is refused: VerityMem's search indexes are disposable projections rebuilt " +
            "from the ledger, so an index configuration attached to one write would be lost at the next rebuild " +
            "while appearing to have been honoured",
          { index: record["index"] },
        );
      }
      await this.core.put(namespace as string[], key, record["value"] as Record<string, unknown>);
      return undefined;
    }

    // Everything else is a ListNamespacesOperation, which this store refuses.
    return await this.core.listNamespaces();
  }

  private async searchOperation(record: Record<string, unknown>): Promise<SearchItem[]> {
    const filter = record["filter"];
    const query = record["query"];
    const limit = record["limit"];
    const offset = record["offset"];
    const items = await this.core.search(record["namespacePrefix"] as string[], {
      filter: {
        ...(typeof filter === "object" && filter !== null ? (filter as Record<string, unknown>) : {}),
        ...(typeof query === "string" ? { query } : {}),
      },
      ...(typeof limit === "number" ? { limit } : {}),
      ...(typeof offset === "number" ? { offset } : {}),
    });
    return items.map(toSearchItem);
  }
}

/**
 * Core item → peer item.
 *
 * The timestamps change representation here and only here: the API returns RFC 3339
 * strings, the peer's `Item` carries `Date`s, and converting at the boundary is what
 * keeps the claim store free of a peer-shaped type.
 */
function toPeerItem(item: StoreItem | undefined): Item | null {
  if (item === undefined) return null;
  const created = new Date(item.createdAt);
  const updated = new Date(item.updatedAt);
  return {
    namespace: item.namespace,
    key: item.key,
    value: item.value as unknown as Record<string, unknown>,
    createdAt: created,
    updatedAt: updated,
  };
}

/**
 * Core item → peer search item.
 *
 * `score` is set from the packet's rank-fusion value and nothing else. The peer calls
 * it a relevance score, which is what it is; it is never a truth or confidence score,
 * and the six dimensions that are not relevance stay in `value` where a caller can
 * still see them separately.
 */
function toSearchItem(item: StoreItem): SearchItem {
  const base = toPeerItem(item);
  if (base === null) throw new TypeError("search produced no item; a search result is never absent");
  const relevance = item.value.relevance;
  return {
    ...base,
    ...(relevance === null ? {} : { score: relevance.fuse_score }),
  };
}
