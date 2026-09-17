/**
 * A LangGraph store over the claim store.
 *
 * LangGraph's `BaseStore` is namespaced key-value with search. VerityMem is not a
 * key-value store, and pretending otherwise is how this adapter would become
 * dangerous, so the mapping is stated once, here, and enforced in code:
 *
 *   * **A namespace is a scope, not a prefix of a key.** It is decoded into the six
 *     explicit dimensions; a namespace that cannot be decoded is refused.
 *   * **A write is a proposal.** `put` appends an *event* — untrusted, origin
 *     `agent` — to the canonical ledger. Only the commit gate can turn it into a
 *     belief, and this class has no code path that can call a decision route.
 *     Consequently `put` followed by `get` is deliberately not the identity.
 *   * **A read is a belief.** `get` and `search` return accepted claims with their
 *     provenance, their use decision and their evidence intact.
 *   * **Deletion and enumeration are refused, not stubbed.** Claims are deleted by a
 *     retention job whose residual scan must return zero, and every claim
 *     enumeration is an existence oracle. Neither is something an agent-facing
 *     store may fake.
 *
 * A checkpoint says where execution stopped; a claim says what is believed to be
 * true. This store holds the second and must never be used for the first.
 */
import type {
  ClaimKind,
  ClaimRecord,
  MemoryPacket,
  PacketClaim,
  QueryRequest,
  ActionRisk,
  TimeSpec,
} from "@veritymem/contracts";
import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";
import { hashValue } from "./hash.ts";
import {
  BOUND_DIMENSIONS,
  createNamespaceCodec,
  type NamespaceCodec,
  type ScopeDimension,
  type StoreScope,
  type StoreScopePrefix,
} from "./namespace.ts";
import { StoreOperationRefusedError, isClaimUnreachable, ScopeViolationError } from "./errors.ts";
import type { VerityApiClient } from "./client.ts";

/** The value shape a store item carries: a belief plus everything needed to audit it. */
export type StoreClaimValue = {
  readonly claim_id: string;
  readonly kind: string;
  readonly statement: {
    readonly subject: string;
    readonly predicate: string;
    readonly object: unknown;
  };
  readonly status: string;
  /** The six dimensions stay separate; there is no merged confidence field. */
  readonly authority: string;
  /** `null` when the read path has not evaluated a use policy for this claim. */
  readonly use: string | null;
  readonly use_reason_codes: readonly string[];
  readonly valid_time: { readonly from: string; readonly to: string | null };
  readonly freshness: { readonly age_days: number; readonly stale: boolean };
  readonly conflicts: readonly unknown[];
  readonly evidence: readonly unknown[];
  readonly scope: Readonly<Record<string, unknown>>;
  /** Where this value came from. Never stripped: a value without provenance is a rumour. */
  readonly provenance: Readonly<Record<string, unknown>>;
};

/** One item in a namespace. Field names and shapes follow LangGraph's store items. */
export interface StoreItem {
  readonly namespace: string[];
  readonly key: string;
  readonly value: StoreClaimValue;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a `put` actually did, in ledger terms. */
export interface StorePutReceipt {
  readonly event_id: string;
  readonly seq: number;
  readonly deduplicated: boolean;
  readonly extraction: string;
  readonly namespace: string[];
  readonly key: string;
}

export type StoreOperation =
  | { readonly type: "get"; readonly namespace: readonly string[]; readonly key: string }
  | {
      readonly type: "put";
      readonly namespace: readonly string[];
      readonly key: string;
      readonly value: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "delete"; readonly namespace: readonly string[]; readonly key: string }
  | {
      readonly type: "search";
      readonly namespacePrefix: readonly string[];
      readonly filter?: Readonly<Record<string, unknown>>;
      readonly limit?: number;
      readonly offset?: number;
    }
  | { readonly type: "list_namespaces" };

export type StoreOperationResult<Op> = Op extends { readonly type: "get" }
  ? StoreItem | undefined
  : Op extends { readonly type: "put" }
    ? StorePutReceipt
    : Op extends { readonly type: "delete" }
      ? void
      : Op extends { readonly type: "search" }
        ? StoreItem[]
        : Op extends { readonly type: "list_namespaces" }
          ? string[][]
          : never;

export type StoreOperationResults<Ops extends readonly StoreOperation[]> = {
  -readonly [K in keyof Ops]: StoreOperationResult<Ops[K]>;
};

/** Filters a search accepts. Anything else is refused rather than ignored. */
export const STORE_SEARCH_FILTERS = [
  "query",
  "subjects",
  "kinds",
  "time",
  "action_risk",
  "limit",
  "offset",
] as const;

export interface SearchOptions {
  readonly filter?: Readonly<Record<string, unknown>>;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ClaimBackedStoreOptions {
  readonly client: VerityApiClient;
  /**
   * Positional dimension order accepted for bare namespaces. Defaults to the full
   * canonical order; pass exactly the order your graph writes if you use bare
   * namespaces, because a different order must not silently address other data.
   */
  readonly dimensions?: readonly ScopeDimension[];
  /** Principal recorded as the actor on store writes. */
  readonly actor_id?: string;
  /** Injected so recorded timestamps are reproducible. */
  readonly clock?: Clock;
  /** Default search limit. The API caps a single query at 100. */
  readonly default_limit?: number;
}

const CLAIM_ID_PATTERN = /^clm_[0-9a-zA-Z]{8,64}$/;
const MAX_QUERY_LIMIT = 100;

/**
 * The store implementation.
 *
 * Implements the namespaced LangGraph store interface structurally — `get`, `put`,
 * `delete`, `search`, `listNamespaces`, `mget`, `mset`, `mdelete`, `yieldKeys`,
 * `batch`, `abatch` — with no import of `@langchain/core`, so the semantics are
 * testable whether or not the peer is installed. `peer.ts` wraps it in a class that
 * extends the peer's `BaseStore` when one is present.
 */
export class ClaimBackedStore {
  private readonly client: VerityApiClient;
  private readonly codec: NamespaceCodec;
  private readonly actorId: string;
  private readonly clock: Clock;
  private readonly defaultLimit: number;

  constructor(options: ClaimBackedStoreOptions) {
    this.client = options.client;
    this.codec = createNamespaceCodec(
      options.dimensions === undefined ? {} : { dimensions: options.dimensions },
    );
    this.actorId = options.actor_id ?? "agent:langgraph-store";
    this.clock = options.clock ?? systemClock;
    this.defaultLimit = options.default_limit ?? 12;
  }

  /** The codec in force, exported so callers can build namespaces with the same rules. */
  get namespaceCodec(): NamespaceCodec {
    return this.codec;
  }

  /**
   * Read one believed claim by its claim id.
   *
   * The key is the claim id (`clm_...`) because that is the only stable handle on a
   * belief. A key that was merely *written* names a proposal, not a belief, and
   * resolving it here would mean inventing an identity the gate has not granted.
   */
  async get(namespace: readonly string[], key: string): Promise<StoreItem | undefined> {
    const scope = this.codec.toScope(namespace);
    if (!CLAIM_ID_PATTERN.test(key)) {
      throw new StoreOperationRefusedError(
        "resolve_proposal_key",
        `key ${JSON.stringify(key)} is not a claim id. A value written with put() is a proposal until the commit ` +
          "gate accepts a claim derived from it, so it has no readable address yet. Read beliefs by the claim id " +
          "returned from search(), and read the promotion history with GET /v1/claims/{id}/explain",
        { key },
      );
    }

    let claim: ClaimRecord;
    try {
      claim = await this.client.getClaim(key);
    } catch (error) {
      // "Does not exist" and "not visible to you" are the same answer, because the
      // store must not become an existence oracle for claims the caller cannot read.
      if (isClaimUnreachable(error)) return undefined;
      throw error;
    }

    if (!claimWithinScope(claim, scope)) return undefined;
    return itemFromClaim(claim, this.codec, scope.tenant);
  }

  /**
   * Record a value as an untrusted event.
   *
   * Returns a receipt rather than `void`, because the caller's next question is
   * always "what did that become", and the honest answer is an event id, not a
   * claim id: nothing is believed yet. An identical rewrite is deduplicated, which
   * is what makes the call safe under a retried graph node; a *changed* value
   * appends a new event, because the ledger is append-only and a correction is a new
   * observation rather than an overwrite.
   */
  async put(
    namespace: readonly string[],
    key: string,
    value: Readonly<Record<string, unknown>>,
    options: {
      readonly occurred_at?: string;
      readonly actor_id?: string;
      readonly sensitivity?: "normal" | "private" | "high";
    } = {},
  ): Promise<StorePutReceipt> {
    const scope = this.codec.toScope(namespace);
    const occurredAt = options.occurred_at ?? this.clock.now().toISOString();
    const envelope = {
      veritymem: { kind: "langgraph_store_put", version: 1 },
      store: {
        namespace: [...namespace],
        key,
        written_at: occurredAt,
        value,
      },
    };
    const receipt = await this.client.appendEvent({
      stream_id: `store:langgraph:${scope.tenant}`,
      // The value hash is part of the key so that a retry deduplicates while a
      // correction still appends. A key-based idempotency key alone would silently
      // drop the second write, which is the failure mode this store exists to avoid.
      idempotency_key: `store:put:${hashValue({ namespace: [...namespace], key, value })}`,
      origin: "agent",
      actor_id: options.actor_id ?? this.actorId,
      scope: writeScopeOf(scope),
      occurred_at: occurredAt,
      content: JSON.stringify(envelope),
      media_type: "application/json",
      ...(options.sensitivity === undefined ? {} : { sensitivity: options.sensitivity }),
    });

    return {
      event_id: receipt.event_id,
      seq: receipt.seq,
      deduplicated: receipt.deduplicated,
      extraction: receipt.extraction,
      namespace: [...namespace],
      key,
    };
  }

  /**
   * Refuses. Deletion in VerityMem is a retention job on the admin audience, and it
   * is only *proven* when a residual scan returns zero.
   */
  async delete(namespace: readonly string[], key: string): Promise<never> {
    this.codec.toScope(namespace);
    throw new StoreOperationRefusedError(
      "delete",
      `refusing to delete ${JSON.stringify(key)}: claims and events are removed only by POST /v1/forget, which ` +
        "runs on the admin audience and reports verified only after a residual scan returns zero. An " +
        "agent-facing store must not be able to erase evidence, and this adapter will not report a deletion " +
        "it did not perform",
      { key },
    );
  }

  /**
   * Retrieve believed claims in a namespace prefix.
   *
   * A VerityMem search is a retrieval, not a scan, so it needs a query: either
   * `filter.query` or `filter.subjects`. Listing a namespace without one would be an
   * enumeration of everything the caller can reach, which is the existence oracle
   * the authorization model is built to deny.
   */
  async search(namespacePrefix: readonly string[], options: SearchOptions = {}): Promise<StoreItem[]> {
    const { packet, scope } = await this.searchPacket(namespacePrefix, options);
    return packet.claims.map((claim) => itemFromPacketClaim(claim, this.codec, scope.tenant));
  }

  /**
   * The same search, plus the packet it came from.
   *
   * Exported because the packet is what a caller needs to log the trace id, the
   * projection watermark and the counts — reconstructing them from the items is
   * impossible, and a caller that cannot log them cannot explain a later decision.
   */
  async searchPacket(
    namespacePrefix: readonly string[],
    options: SearchOptions = {},
  ): Promise<{ readonly packet: MemoryPacket; readonly scope: StoreScopePrefix; readonly purpose: string }> {
    const scope = this.codec.toScopePrefix(namespacePrefix);
    const purpose = singlePurpose(scope.purpose);
    const filter = options.filter ?? {};
    const query = resolveSearchQuery(filter);
    const subjects = arrayField(filter, "subjects");
    const kinds = arrayField(filter, "kinds");
    const limit = clampLimit(options.limit ?? numberField(filter, "limit") ?? this.defaultLimit);
    const request: QueryRequest = {
      query,
      scope: selectorOf(scope),
      purpose,
      limit,
      ...(subjects === undefined ? {} : { subjects: subjects as string[] }),
      ...(kinds === undefined ? {} : { kinds: kinds as ClaimKind[] }),
      ...(filter["time"] === undefined ? {} : { time: filter["time"] as TimeSpec }),
      ...(filter["action_risk"] === undefined ? {} : { action_risk: filter["action_risk"] as ActionRisk }),
    };

    const packet = await this.client.query(request);
    const offset = Math.max(0, options.offset ?? numberField(filter, "offset") ?? 0);
    if (offset === 0) return { packet, scope, purpose };
    // The query route has no offset parameter, so paging is done over the returned
    // page. Returning the whole page when the caller asked for a later one would be
    // a silent lie about which window they are looking at.
    return { packet: { ...packet, claims: packet.claims.slice(offset) }, scope, purpose };
  }

  /**
   * Refuses. Enumerating namespaces discloses which scopes exist, which is exactly
   * the information the empty-result behaviour of `compose()` is designed to hide.
   */
  async listNamespaces(): Promise<never> {
    throw new StoreOperationRefusedError(
      "enumerate",
      "refusing to enumerate namespaces: a namespace list discloses which scopes exist, and an unauthorized " +
        "scope must not appear in counts, timings or summaries. Search within a namespace you already know " +
        "you can reach",
    );
  }

  /**
   * `mget` in the LangGraph shape: each key is `[...namespace, key]`.
   *
   * A loop, not `Promise.all`: the results are positional and a caller matching them
   * to their inputs must not have to re-derive the order after a partial failure.
   */
  async mget(keys: readonly (readonly string[])[]): Promise<(StoreItem | undefined)[]> {
    const out: (StoreItem | undefined)[] = [];
    for (const compound of keys) {
      const split = splitCompoundKey(compound);
      out.push(await this.get(split.namespace, split.key));
    }
    return out;
  }

  /** `mset` in the LangGraph shape: each entry is `[[...namespace, key], value]`. */
  async mset(entries: readonly (readonly [readonly string[], Readonly<Record<string, unknown>>])[]): Promise<StorePutReceipt[]> {
    const out: StorePutReceipt[] = [];
    for (const entry of entries) {
      const compound = entry[0];
      const value = entry[1];
      const split = splitCompoundKey(compound);
      out.push(await this.put(split.namespace, split.key, value));
    }
    return out;
  }

  /** `mdelete`: refused for the same reason `delete` is. */
  async mdelete(keys: readonly (readonly string[])[]): Promise<never> {
    const first = keys[0];
    const split = first === undefined ? { namespace: [] as string[], key: "" } : splitCompoundKey(first);
    return await this.delete(split.namespace, split.key);
  }

  /**
   * Run a batch of operations.
   *
   * Sequential on purpose: the loop keeps each result aligned with its operation,
   * and running them concurrently would make a partially applied batch impossible to
   * describe. A failure does not disappear into the successful results — the whole
   * call rejects with an `AggregateError` naming the failing indices and how many
   * operations had already been applied, because a caller who is told "the batch
   * failed" must still learn that half of it happened.
   */
  async batch<Ops extends readonly StoreOperation[]>(operations: Ops): Promise<StoreOperationResults<Ops>> {
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
      const detail = failures
        .map((failure) => `#${failure.index} (${operationKind(operations[failure.index])}): ${describe(failure.error)}`)
        .join("; ");
      throw new AggregateError(
        failures.map((failure) => failure.error),
        `store batch failed: ${failures.length} of ${operations.length} operation(s) rejected — ${detail}. ` +
          `${operations.length - failures.length} operation(s) were applied and are not rolled back`,
      );
    }
    return results as StoreOperationResults<Ops>;
  }

  /** LangGraph calls this on the store interface; it is the same sequential batch. */
  async abatch<Ops extends readonly StoreOperation[]>(operations: Ops): Promise<StoreOperationResults<Ops>> {
    return await this.batch(operations);
  }

  /**
   * Refuses. There is no query here, so the only thing this could yield is the set
   * of keys in a namespace — an enumeration by another name.
   */
  async *yieldKeys(_prefix?: readonly string[]): AsyncGenerator<string[]> {
    throw new StoreOperationRefusedError(
      "enumerate",
      "refusing to yield keys: yielding every key in a namespace enumerates claims without a query, which is the " +
        "enumeration this store refuses for the same reason it refuses listNamespaces",
    );
  }

  private async dispatch(operation: StoreOperation): Promise<unknown> {
    const normalized = normalizeOperation(operation);
    switch (normalized.type) {
      case "get":
        return await this.get(normalized.namespace, normalized.key);
      case "put":
        return await this.put(normalized.namespace, normalized.key, normalized.value);
      case "delete":
        return await this.delete(normalized.namespace, normalized.key);
      case "search":
        return await this.search(normalized.namespacePrefix, {
          ...(normalized.filter === undefined ? {} : { filter: normalized.filter }),
          ...(normalized.limit === undefined ? {} : { limit: normalized.limit }),
          ...(normalized.offset === undefined ? {} : { offset: normalized.offset }),
        });
      case "list_namespaces":
        return await this.listNamespaces();
    }
  }
}

/**
 * Accepts an operation in either shape.
 *
 * LangGraph's own operation objects carry no discriminant — a search is recognised
 * by its `namespacePrefix` field — while this package's typed operations do. Both
 * are accepted so a graph passing its own objects into `batch()` is not silently
 * misfiled as a `get`.
 */
export function normalizeOperation(operation: unknown): StoreOperation {
  if (typeof operation !== "object" || operation === null) {
    throw new TypeError(`store operation must be an object, received ${typeof operation}`);
  }
  const record = operation as Record<string, unknown>;
  const declared = record["type"];
  if (typeof declared === "string") {
    switch (declared) {
      case "get":
      case "put":
      case "delete":
      case "search":
      case "list_namespaces":
        return operation as StoreOperation;
      default:
        throw new TypeError(`unknown store operation type ${JSON.stringify(declared)}`);
    }
  }
  const namespacePrefix = record["namespacePrefix"] ?? record["namespace_prefix"];
  if (Array.isArray(namespacePrefix)) {
    return { type: "search", namespacePrefix: namespacePrefix as string[] };
  }
  const namespace = record["namespace"];
  const key = record["key"];
  if (Array.isArray(namespace) && typeof key === "string") {
    if ("value" in record) {
      return {
        type: "put",
        namespace: namespace as string[],
        key,
        value: (record["value"] ?? {}) as Record<string, unknown>,
      };
    }
    return { type: "get", namespace: namespace as string[], key };
  }
  return { type: "list_namespaces" };
}

function operationKind(operation: StoreOperation | undefined): string {
  return operation === undefined ? "unknown" : operation.type;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `[...namespace, key]` → the two parts. A compound key with no namespace is a mistake, not a root namespace. */
function splitCompoundKey(compound: readonly string[]): { readonly namespace: string[]; readonly key: string } {
  if (compound.length < 2) {
    throw new TypeError(
      `store key must be [...namespace, key]; received ${JSON.stringify(compound)}. VerityMem has no root ` +
        "namespace: every item belongs to a tenant-bound, purpose-bound scope",
    );
  }
  const key = compound[compound.length - 1];
  if (key === undefined) throw new TypeError("store key is empty");
  return { namespace: compound.slice(0, -1) as string[], key };
}

function singlePurpose(purposes: readonly string[] | undefined): string {
  if (purposes === undefined || purposes.length === 0) {
    throw new ScopeViolationError(
      "empty_purpose",
      "namespace names no purpose; purpose is a hard boundary and an empty purpose is unreachable rather than unrestricted",
    );
  }
  const first = purposes[0];
  if (purposes.length > 1 || first === undefined) {
    throw new ScopeViolationError(
      "ambiguous_purpose",
      `namespace names ${purposes.length} purposes [${purposes.join(", ")}]; a read is authorized for exactly one ` +
        "purpose, and retrieving under several would return their union and lose the boundary",
      { purposes: [...purposes] },
    );
  }
  return first;
}

/**
 * Resolve the query text a search needs, refusing anything it would otherwise ignore.
 *
 * Returns the text rather than only validating, so the "there is no query" case cannot
 * be checked in one place and used in another — a validation that returns nothing is
 * how a check and its use drift apart.
 */
function resolveSearchQuery(filter: Readonly<Record<string, unknown>>): string {
  const unknown = Object.keys(filter).filter(
    (key) => !(STORE_SEARCH_FILTERS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new StoreOperationRefusedError(
      "search_without_query",
      `unsupported search filter(s) [${unknown.join(", ")}]. A filter this store ignores is a query that ` +
        `silently returns more than the caller asked for; supported filters are [${STORE_SEARCH_FILTERS.join(", ")}]`,
      { filter: Object.keys(filter) },
    );
  }
  const query = queryTextOf(filter);
  if (query === undefined) {
    throw new StoreOperationRefusedError(
      "search_without_query",
      "search needs filter.query or filter.subjects. VerityMem search is an authorized retrieval, not a scan of " +
        "a namespace: without a query the only possible result is a list of everything you can reach",
      { filter: Object.keys(filter) },
    );
  }
  return query;
}

function queryTextOf(filter: Readonly<Record<string, unknown>>): string | undefined {
  const direct = filter["query"];
  if (typeof direct === "string" && direct.trim() !== "") return direct;
  const subjects = arrayField(filter, "subjects");
  if (subjects !== undefined && subjects.length > 0) return subjects.join(" ");
  return undefined;
}

function arrayField(filter: Readonly<Record<string, unknown>>, key: string): unknown[] | undefined {
  const value = filter[key];
  return Array.isArray(value) ? (value as unknown[]) : undefined;
}

function numberField(filter: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = filter[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return 1;
  return Math.min(Math.floor(limit), MAX_QUERY_LIMIT);
}

function selectorOf(scope: StoreScopePrefix): QueryRequest["scope"] {
  return {
    tenant: scope.tenant,
    ...(scope.project === undefined ? {} : { project: scope.project }),
    ...(scope.user === undefined ? {} : { user: scope.user }),
    ...(scope.agent === undefined ? {} : { agent: scope.agent }),
    ...(scope.session === undefined ? {} : { session: scope.session }),
  };
}

/** Scope → `WriteScope` for an append, with every dimension named explicitly. */
export function writeScopeOf(scope: StoreScope): {
  readonly tenant: string;
  readonly project?: string;
  readonly user?: string;
  readonly agent?: string;
  readonly session?: string;
  readonly purpose: string[];
} {
  return {
    tenant: scope.tenant,
    ...(scope.project === undefined ? {} : { project: scope.project }),
    ...(scope.user === undefined ? {} : { user: scope.user }),
    ...(scope.agent === undefined ? {} : { agent: scope.agent }),
    ...(scope.session === undefined ? {} : { session: scope.session }),
    purpose: [...scope.purpose],
  };
}

/** Whether a claim's own scope is contained by the namespace that asked for it. */
function claimWithinScope(claim: ClaimRecord, scope: StoreScope): boolean {
  for (const dimension of BOUND_DIMENSIONS) {
    const claimValue = claim.scope[dimension];
    if (claimValue === null || claimValue === undefined) continue;
    if (scope[dimension] !== claimValue) return false;
  }
  return scope.purpose.every((purpose) => claim.scope.purpose.includes(purpose));
}

function itemFromClaim(claim: ClaimRecord, codec: NamespaceCodec, tenant: string): StoreItem {
  const namespace = codec.toNamespace({
    tenant,
    ...(claim.scope.project === null ? {} : { project: claim.scope.project }),
    ...(claim.scope.user === null ? {} : { user: claim.scope.user }),
    ...(claim.scope.agent === null ? {} : { agent: claim.scope.agent }),
    ...(claim.scope.session === null ? {} : { session: claim.scope.session }),
    purpose: claim.scope.purpose,
  });
  return {
    namespace,
    key: claim.claim_id,
    value: {
      claim_id: claim.claim_id,
      kind: claim.kind,
      statement: { subject: claim.subject, predicate: claim.predicate, object: claim.object },
      status: claim.status,
      authority: claim.authority,
      // A bare claim read has no use decision: the use policy is evaluated per query,
      // per purpose and per action risk. Reporting one here would be inventing it.
      use: null,
      use_reason_codes: [],
      valid_time: claim.valid_time,
      freshness: { age_days: claim.freshness.age_days, stale: claim.freshness.stale },
      conflicts: claim.conflicts,
      evidence: claim.evidence,
      scope: claim.scope as unknown as Readonly<Record<string, unknown>>,
      provenance: {
        source: "GET /v1/claims/{claim_id}",
        tenant,
        recorded_at: claim.recorded_at,
        promotion: claim.promotion,
        statement_rendering: claim.statement,
      },
    },
    createdAt: claim.valid_time.from,
    updatedAt: claim.valid_time.to ?? claim.valid_time.from,
  };
}

/**
 * Map a packet claim to a store item.
 *
 * Exported because the recall node already holds a packet and must not issue a second
 * query just to obtain items in the store's shape — a second read would also be a
 * second authorization decision, and the packet the caller renders and the items the
 * caller gates on have to come from one read.
 */
export function storeItemFromPacketClaim(
  claim: PacketClaim,
  tenant: string,
  codec: NamespaceCodec = createNamespaceCodec(),
): StoreItem {
  return itemFromPacketClaim(claim, codec, tenant);
}

function itemFromPacketClaim(claim: PacketClaim, codec: NamespaceCodec, tenant: string): StoreItem {
  const namespace = codec.toNamespace({
    tenant,
    ...(claim.scope.project === null ? {} : { project: claim.scope.project }),
    ...(claim.scope.user === null ? {} : { user: claim.scope.user }),
    ...(claim.scope.agent === null ? {} : { agent: claim.scope.agent }),
    ...(claim.scope.session === null ? {} : { session: claim.scope.session }),
    purpose: claim.scope.purpose,
  });
  return {
    namespace,
    key: claim.claim_id,
    value: {
      claim_id: claim.claim_id,
      kind: claim.kind,
      statement: claim.statement,
      status: claim.status,
      authority: claim.authority,
      use: claim.use,
      use_reason_codes: claim.use_reason_codes,
      valid_time: claim.valid_time,
      freshness: { age_days: claim.freshness.age_days, stale: claim.freshness.stale },
      conflicts: claim.conflicts,
      evidence: claim.evidence,
      scope: claim.scope as unknown as Readonly<Record<string, unknown>>,
      provenance: {
        source: "POST /v1/query",
        tenant,
        fuse_score: claim.fuse_score,
        channels: claim.channels,
        signals: claim.signals,
      },
    },
    createdAt: claim.valid_time.from,
    updatedAt: claim.valid_time.to ?? claim.valid_time.from,
  };
}
