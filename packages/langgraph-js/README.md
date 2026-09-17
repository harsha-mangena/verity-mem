# @veritymem/langgraph

A LangGraph integration for VerityMem in which **writes are proposals and reads are
beliefs**. It supplies a store over the claim store and the four adapter hooks the
integration plan names: `beforeRun`, `afterTool`, `afterRun`, `beforeAction`.

This document implements the integration contract. It does not restate the
specification; where a decision here follows from a rule in it, the rule is cited, not
paraphrased.

## A checkpoint says where execution stopped. A claim says what is believed to be true.

They are different stores, with different retention and different authorization, and
this package holds only the second.

| | Checkpoint | Claim |
| --- | --- | --- |
| Answers | where execution stopped | what is believed to be true |
| Written by | the graph runtime, on every step | the commit gate, from evidence |
| Truth value | none — it is a position, not a belief | assigned by a versioned policy |
| Retention | deleted with the thread | revoked, superseded or expired, never overwritten |
| Authorization | the thread's owner | scope × purpose × principal, re-checked before use |

So this store must **never** be used as a checkpointer. `put()` does not place a value
where `get()` will find it, and that is deliberate: a `put` appends an untrusted event
to the canonical ledger, and only the commit gate can turn what it says into something
the system believes. If you need checkpointing, use `@langchain/langgraph-checkpoint`'s
`MemorySaver` or a database saver; register this store alongside it for cross-thread
facts, not instead of it.

## Entry points

| Import | Needs a peer | Use when |
| --- | --- | --- |
| `@veritymem/langgraph` | no | always — the four hooks, the namespace codec, the store semantics, the graph nodes |
| `@veritymem/langgraph/langgraph` | `@langchain/langgraph-checkpoint` | your code does `instanceof BaseStore`, or wants the peer's convenience wrappers inherited |
| `@veritymem/langgraph/langchain-core` | `@langchain/core` | you have the older string-keyed `BaseStore` (`mget`/`mset`/`mdelete`/`yieldKeys`) |
| `@veritymem/langgraph/peer` | no | you want to *ask* which peer is installed instead of assuming |

The main entry point statically imports neither peer, and `langgraph.test.ts` asserts
that by reading the sources. Two things follow: the package typechecks and its tests run
in a workspace where LangGraph was never installed, and the namespace mapping and the
four hooks — the parts that decide whether a tenant boundary holds and whether a side
effect is gated — are reviewable without a peer.

`probeLangGraphPeer()` returns the truth as data rather than a comment:

```ts
const report = await probeLangGraphPeer();
// { probes: [ { specifier: "@langchain/langgraph-checkpoint", found: true,
//               namespaced: true, detail: "..." }, ... ],
//   base_store: "@langchain/langgraph-checkpoint" }
```

`createLangGraphStore({ client })` returns the structural implementation, which is what
a graph calls. LangGraph invokes `batch`, `get`, `search` and `delete` on whatever store
it is handed; it does not require `instanceof`. Pass `require_peer: true` to turn a
missing peer into an error instead of a fallback.

## A namespace is a scope, never a string

LangGraph addresses data with `string[]`. VerityMem's ownership boundary is six
independent dimensions — tenant, project, user, agent, session, purpose — and the
integration plan is explicit that concatenating them into one opaque namespace is how
purpose and tenant boundaries get lost. So the store never concatenates:

```ts
// Explicit, order-free, self-describing. This is the form to prefer.
["tenant:acme", "project:payments", "user:alice", "purpose:release_planning"]

// Positional, and only because the caller declared the order up front.
createNamespaceCodec({ dimensions: ["tenant", "project", "purpose"] })
  .toScope(["acme", "payments", "release_planning"])
```

A namespace that cannot be read as explicit dimensions throws
`NamespaceMappingError` — there is no fallback to a string key, because the fallback is
the bug. Refused, with the reason in the message: an empty namespace, a segment that
does not name a known dimension (`tenent:acme`), a mix of named and bare segments, a
positional tuple whose length does not match the declared dimensions
(`["acme_payments_alice_release_planning"]`), a missing tenant, a missing purpose, a
scope that binds none of project/user/agent/session (migration 0001's rule, applied
client-side), a value containing `/` or `|` (the characters a concatenated namespace
would use), and a value containing `.` (LangGraph's own store rejects a namespace label
with a period, so the codec refuses it up front rather than letting the peer report it
without naming the dimension).

For the string-keyed peer, `encodeStoreKey` produces `tenant:acme|project:payments|…|key=deploy-window`,
and `decodeStoreKey` rejects anything that does not name its dimensions. It is a wire
format for an interface that only speaks strings, not a licence to concatenate scopes.

## The store

```ts
const store = new ClaimBackedStore({ client, actor_id: "agent:planner" });
// or, for LangGraph's own class and its inherited convenience wrappers:
const peerStore = new VerityMemStore({ client }); // @veritymem/langgraph/langgraph
```

| Operation | What it does |
| --- | --- |
| `put(namespace, key, value)` | appends an untrusted event (origin `agent`); returns a receipt, not a claim |
| `get(namespace, key)` | reads a believed claim by claim id, if it is within the namespace |
| `search(prefix, { filter })` | one authorized retrieval; needs `filter.query` or `filter.subjects` |
| `mget` / `mset` | loops over the above, results positionally aligned |
| `batch` / `abatch` | sequential; failures are reported, never dropped |
| `delete`, `listNamespaces`, `yieldKeys` | **refused** — see below |

`put` is a proposal. An identical rewrite is deduplicated, which is what makes it safe
under a retried graph node; a *changed* value appends a new event, because the ledger is
append-only and a correction is a new observation rather than an overwrite. Nothing in
this package can call a decision route, so `put` followed by `get` is deliberately not
the identity — the claim id returned by `search` is the address of a belief.

`get` returns `undefined` for a claim the caller cannot see, and for one that does not
exist: `403` and `404` are collapsed, because distinguishing them would make any read an
existence oracle. (Through the peer subclass it is `null`, the peer's `Item | null`
shape.) A non-claim key throws rather than returning an empty result, because a written
key names a proposal and pretending otherwise would read as data loss.

Matching is per dimension, and a dimension the namespace does not name is a wildcard —
the rule `ScopeSelector` already documents. Getting that backwards would make
`get(prefix, item.key)` fail for an item `search(prefix)` just returned.

### What is refused, and why

- **`delete` / `mdelete` / the peer's `put(…, null)`.** Claims and events are removed by
  `POST /v1/forget`, on the admin audience, and deletion is *proven* only when a
  residual scan returns zero. An agent-facing store must not be able to erase evidence,
  and this adapter will not report a deletion it did not perform.
- **`listNamespaces` / `yieldKeys`.** Listing a namespace without a query enumerates
  claims. Authorization before retrieval means an unauthorized claim must not appear in
  counts, timings or summaries; an enumeration is that, with extra steps. Use
  `search(namespace, { filter: { query } })`.
- **A search with no query**, and a search filter the store would ignore. A filter that
  is silently dropped is a query that returns more than the caller asked for.
- **A per-item `index` configuration** on the peer's `put`. Search indexes here are
  disposable projections rebuilt from the ledger; an index attached to one write would be
  lost at the next rebuild while appearing to have been honoured.

Batch failures are not dropped: a multi-operation batch rejects with an
`AggregateError` naming the failing indices and how many operations were already applied
(and were not rolled back). A single-operation batch rethrows the operation's own error,
so the peer's `search`/`get`/`delete` wrappers keep typed failures.

## The four hooks

All four are plain async functions in `hooks.ts`; `nodes.ts` wraps them as graph nodes.
Each node is `(state, dependencies) => Promise<state>` — the *whole* state, so it is
callable directly in a test — and `createMemoryNodes(dependencies)` binds them for
`graph.addNode`.

### `beforeRun` → `recall_memory`

Queries memory with a declared purpose and scope and attaches the **packet**: claims
with evidence, conflicts, freshness, authority and a use decision, plus the projection
watermark and policy version. Never free-form snippets. The scope must name the purpose
the read is authorized for; reading for a purpose the scope was not admitted for throws
`ScopeViolationError` before any request is made.

### `afterTool` → `record_observations`

Records a structured observation as an untrusted event: tool identity and version, a
caller-stable call id, SHA-256 over the *complete* canonicalized input and output, and
the side-effect status (`none` / `performed` / `attempted` / `unknown`). The output is
stored as citable text (bounded, 4096 chars by default) because an observation stored as
hashes alone produces no span the extractor can cite; the input is not stored by
default, because an input verbatim puts whatever the tool was handed into the ledger
forever. Both are configurable per call.

### `afterRun` → `propose_claims`

Records the transcript and appends one event per conclusion, each with its own
idempotency key, so a candidate can cite the agent's exact sentence. It **proposes**:
the return type carries `promotion_attempted: false` as a literal, the conclusion
envelope has no `authority` and no `status` field, and the test suite asserts that every
request the hook makes is `POST /v1/events` — never `/decisions`, `/reverify`, `/grants`,
`/forget`, `/replay` or `/evaluations`.

### `beforeAction` → `gate_action`

The enforcement point, and the reason this package exists. It is exported standalone: a
caller with no graph, no store and no nodes can call it. It calls
`POST /v1/actions/gate` with `ActionGateRequest` and nothing else — the gate re-reads
claims and re-verifies evidence digests on every call, so a packet, a claim body or a
cached verdict in the request would be stale state pretending to be evidence, and any
extra field is refused.

It **throws** `ActionDeniedError` on a denial, carrying the blocking claim ids, the
reason codes, the decision and the policy version. A soft flag would be ignored by
exactly the caller that most needs the check. It also fails closed when the verdict is
internally inconsistent — `allowed: true` alongside a blocking claim, or a claim the
caller asked about that the verdict never mentions — and refuses a gate call with no
referenced claims, which would verify nothing and always allow.

```ts
import { beforeAction } from "@veritymem/langgraph";

await beforeAction({ client }, {
  action: "github.create_release",
  action_risk: "high",
  scope: { tenant: "acme", project: "payments", purpose: ["release_planning"] },
  purpose: "release_planning",
  claim_ids: [claimId],
  trace_id: packet.trace_id,
}); // throws ActionDeniedError, or returns
```

## The injection rule

**Retrieved memory is passed as structured data with provenance, never spliced
unescaped into a system message.**

`formatMemoryContext(packet)` returns a fenced block for the user/context channel. Stored
text — claim objects, evidence quotes, `missing` reasons — is JSON-encoded and then has
`<`, `>`, `&`, U+2028 and U+2029 escaped. That is lossless (`JSON.parse` recovers the
original byte for byte) and it means every structural character in the block is the
formatter's own: a stored string cannot close the region, open a tag, start a line or
forge a second fence. The fence markers carry the packet's trace id, which the author of
a stored string cannot know at write time. The returned `placement` is the literal type
`"user"`; there is no system-channel variant to step off the safe path onto.

`formatMemorySummary(packet)` exists for the case where something must appear in a system
message, and contains identifiers, counts and policy versions and **no stored text**.

## Routes used

`POST /v1/events`, `GET /v1/claims/{id}`, `POST /v1/query`, `POST /v1/actions/gate`.

The first three are in the specification's REST list. **The action-gate route is not.**
The specification specifies `ActionGateRequest`/`ActionGateVerdict` as contracts and
requires the gate to be wired before any medium- or high-risk side effect, but its route
list omits a path for it; `@veritymem/sdk-ts` and this package both default to
`/v1/actions/gate` and both allow the path to be overridden
(`new HttpVerityClient({ baseUrl, routes: { actionGate: "/v1/…" } })`). Confirm against
`apps/server` before relying on it.

Nothing here calls an admin route. An agent token that can reach `/v1/grants` or
`/v1/forget` is a design failure, so this adapter has no code path that tries.

## Testing

```bash
node --experimental-strip-types --test packages/langgraph-js/src/langgraph.test.ts
```

41 tests, `node:test`, no database, no server, no peer required. The HTTP layer is a
recording stub, so the paths and bodies the adapter actually sends are asserted rather
than assumed — including that `afterRun` touches only `POST /v1/events` and that a
refusal never becomes a request. Two tests import the optional peer modules through a
variable specifier and skip with a stated reason when it is absent, so the suite passes
either way.

The adapter has also been driven end to end against the real `apps/server` routes and a
real database, through `app.inject()` (same router, same schema validation, no socket):
a tool observation appended as `evt_…`, a claim promoted to `clm_…`, `beforeRun`
returning a packet and a fenced rendering, `store.get` unwrapping the route's
`{ claim, relations }` envelope, and `beforeAction` refusing a high-risk release on a
`user_self_report` claim with `action.denied_risk_exceeds_use` and the blocking claim id.
That run is a verification, not a committed test: a test in this package that booted the
server would couple the adapter to another package's fixtures.

## Dependencies

No new runtime dependencies. The package uses `node:crypto` and the global `fetch`;
`@veritymem/contracts` supplies the frozen request and response types, and
`@veritymem/sdk-ts` is declared but **not imported** — `VerityApiClient` is a narrow
structural interface that `VerityMemClient` already satisfies, and importing a package
that another agent is still writing would make this one untestable. Wiring the default
client to the SDK is a one-line change at the call site.

`canonicalJson` and `sha256Hex` are local rather than imported from `@veritymem/ledger`,
because that package re-exports its database module and importing it would make an
adapter that needs nothing but `fetch` uninstallable without PostgreSQL. The rule is the
ledger's; `langgraph.test.ts` cross-checks the two implementations against the ledger's
`canonicalize` whenever it is resolvable.
