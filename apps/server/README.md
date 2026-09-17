# VerityMem HTTP server

The Fastify surface for VerityMem: the append-only evidence ledger, the commit gate,
the policy-first read path, `/explain`, and the administrative operations.

It is one process with one database. It does not extract with a model (that is the
worker) and it does not serve MCP (that is `packages/mcp-server`). Everything it does
is listed under [Routes](#routes), and the interactive OpenAPI document is at `/docs`.

## Start it

```bash
# from the repository root
pnpm db:up        # Postgres 17 + pgvector on 127.0.0.1:55432
pnpm migrate      # apply migrations 0001..N
cp .env.example .env   # then set AGENT_TOKEN and ADMIN_TOKEN to two different values

pnpm dev:server   # node --watch, restarts on change
# or, without the watcher:
node --experimental-strip-types apps/server/src/main.ts
```

The server reads `.env` and `.env.local` through `loadEnv()` from
`@veritymem/ledger`, so the server and the worker cannot end up on two different
databases. `pnpm dev:server` prints a JSON line with the live gate backend, the live
embedding backend and the `/docs` URL on startup — read it, because a deployment
running the lexical entailment stand-in and one running ONNX are different systems
and the log is where that is visible.

### Required configuration

| Variable | Default | Why it matters |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://veritymem_app:…@127.0.0.1:55432/veritymem` | The RLS-bound application role. The server never connects as the owner. |
| `AGENT_TOKEN` | `dev-agent-token` | The `agent` audience credential. **Change it.** |
| `ADMIN_TOKEN` | `dev-admin-token` | The `admin` audience credential. Must differ from `AGENT_TOKEN`; the server refuses to start if the two are equal, because audience separation is unenforceable when both audiences share a secret. |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Listener. |
| `GATE_ENTAILMENT_BACKEND` | `lexical` | `lexical` builds `LexicalEntailmentBackend` with `lexicalEntailmentFloor` from the policy; `onnx` builds `createOnnxEntailmentBackend(GATE_MODEL_PATH)`, which returns an `UnavailableEntailmentBackend` when the model is absent. That is correct: the gate then refuses to auto-accept and the candidate lands in `needs_review` rather than being accepted ungated. |
| `EMBEDDING_BACKEND` | `hash` | `hash` is a deterministic local embedder and makes a rebuild byte-identical. `openai` uses `OPENAI_BASE_URL` + `OPENAI_MODEL` and is refused at startup if either is missing, rather than silently falling back — a silent fallback would make `claim_embeddings.model_id` disagree with the configuration. |
| `RETENTION_LEDGER_MODE` | `redact` | Default mode for `/v1/forget`. |

`GATE_CONFIDENCE_THRESHOLD` bounds auto-acceptance: a backend that says `entailed`
below its own floor does not establish entailment, and the candidate goes to review.
`EMBEDDING_MODEL_ID` is recorded per projected row and in `projection_versions`, so
changing it is a recorded rebuild rather than a silent quality change.

### Credentials are opaque in v0.1 — and that is a placeholder

Tokens are shared secrets read from configuration. There is no issuance, no expiry,
no per-tenant registry and no rotation.

A token may carry a tenant binding:

```
AGENT_TOKEN=tenant:acme:s3cret
```

which binds that credential to the tenant slug `acme`. The tenant a request acts on
comes from the credential; a body naming a different tenant is refused with `403
tenant_mismatch`. A credential with no binding may still act, but only on a tenant it
names explicitly, and the by-id routes (an event, a claim, a candidate, a trace) are
unusable without a binding because there is no tenant in the body to check.

The replacement is a capability token carrying tenant, scope, purpose, tool
allowlist and expiry. Everything downstream already treats a resolved identity as an
input, so the replacement is a change to `resolveIdentity()` in `src/identity.ts` and
to nothing else.

### Profiles and audiences

Two independent checks are applied to every request, and keeping them separate is the
point:

* **Audience** — which class of credential is presented. `admin` covers `/v1/grants`,
  `/v1/forget`, `/v1/replay` and `/v1/evaluations/runs`. An agent token reaching one
  of those is a **403, not a 401**: the token is valid, the audience is wrong, and the
  distinction sends an operator to the profile rather than to a missing credential.
* **Profile** — which tools the caller holds. Four profiles, `contributor` by default.

| Profile | Adds over the one above |
| --- | --- |
| `reader` | query, compose, explain, trace, and the object reads. |
| `contributor` (default) | `POST /v1/events`, `/extract`, `/v1/feedback`, `/v1/actions/gate`. |
| `reviewer` | `/v1/candidates/{id}/decisions`, `/v1/claims/{id}/relations`, `/reverify`. |
| `privacy-admin` | grants, forget, replay, evaluations — and the `admin` audience. |

A reviewer holds no admin audience, and an admin audience implies nothing about
profiles. `GET /v1/whoami` returns the resolved principal, tenant, profile, audiences
and tool list, which is the fastest way to answer "why did I get a 403".

## Routes

`$BASE=http://127.0.0.1:8787`, `$AGENT_TOKEN` and `$ADMIN_TOKEN` as configured. Every
response body quoted below is real output from a local run.

### Events

```bash
# Append. Durability is acknowledged before extraction, so the response reports the
# extraction *state*, not its result.
curl -sS -X POST "$BASE/v1/events" \
  -H "authorization: Bearer $AGENT_TOKEN" -H 'content-type: application/json' \
  -d '{"stream_id":"thread:9","idempotency_key":"turn-14","origin":"user",
       "actor_id":"user:alice",
       "scope":{"tenant":"acme","project":"payments","user":"alice","purpose":["release_planning"]},
       "occurred_at":"2026-09-10T09:14:00Z",
       "content":"I approved the Sunday 02:00 UTC deploy window."}'
# 202
# {"event_id":"evt_1ed7457703c83139c13a000000000001","seq":1,
#  "recorded_at":"2026-09-17T12:00:00.000Z","extraction":"queued","deduplicated":false,
#  "content_hash":"10f3dea92bf930c8ed4afc018a5abba42e46b0426132e05ef4efa228b4d704a1",
#  "prev_hash":null}
# Replaying the same idempotency_key with the same bytes returns the same event and
# "deduplicated": true. The same key with different bytes is 409 conflict.

# Read a stored event. `content` is null exactly when `redacted_at` is set, so the
# system can still testify the event existed and when.
curl -sS "$BASE/v1/events/evt_1ed7457703c83139c13a000000000001" \
  -H "authorization: Bearer $AGENT_TOKEN"

# Re-run extraction for an event, synchronously.
curl -sS -X POST "$BASE/v1/events/evt_1ed7457703c83139c13a000000000001/extract" \
  -H "authorization: Bearer $AGENT_TOKEN"
# 200
# {"event_id":"evt_1ed7457703c83139c13a000000000001","model_calls":0,
#  "extractor_versions":["tool-result@1","preference-form@1","decision-statement@1",
#                        "repo-metadata@1","procedure-statement@1"],
#  "admission":{"trust_zone":"internal","instruction_like":false,"sensitive":false,"reason_codes":[]},
#  "candidates":["cnd_1ed7457703c83139c13a000000000003"],
#  "claims":["clm_1ed7457703c83139c13a000000000004"],
#  "decisions":[{"decision_id":"dec_…","candidate_id":"cnd_…","outcome":"accept",
#                "claim_id":"clm_…","policy_version":"commit-v3",
#                "reason_codes":["scope.within_event_scope","entailment.entailed",
#                                 "authority.strong","conflict.none",
#                                 "gate.auto_accept_eligible","extractor.deterministic"]}],
#  "notes":["no model extractor configured; deterministic extraction only"],
#  "extracted":true}
```

`POST /v1/events` is the **only** place the ledger is written. The re-extract route
runs the deterministic extractors and the commit gate in the origin event's own scope
and projects accepted claims in the same transaction, so its result is immediately
queryable. It runs no model call — see [What this server does not
do](#what-this-server-does-not-do).

### Candidates

```bash
# A candidate with its evidence spans and every decision already recorded against it.
curl -sS "$BASE/v1/candidates/cnd_1ed7457703c83139c13a000000000003" \
  -H "authorization: Bearer $AGENT_TOKEN"

# A reviewer decision. `reviewer` profile or above.
curl -sS -X POST "$BASE/v1/candidates/cnd_1ed7457703c83139c13a000000000003/decisions" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"outcome":"reject","reason":"superseded by an explicit approval","approver":"ops:reviewer"}'
# 200
# {"candidate_id":"cnd_…","decision_id":"dec_…","claim_id":null,"outcome":"reject",
#  "reason_codes":[],"approver":"ops:reviewer","policy_version":"review:commit-v3",
#  "decided_at":"2026-09-17T12:00:00.000Z","claim_created":false}
```

A **rejected candidate is a 200, not an error.** A refusal is the system working;
returning 4xx would make a review queue unreadable in an access log and would invite a
client to retry it. `accept` creates the claim; `reject`, `quarantine` and
`needs_review` are recorded without one. The claim's authority class comes from the
gate's own origin mapping, never from the reviewer's confidence: a reviewer approves a
proposition, they do not upgrade hearsay into a verified record.

### Claims

```bash
curl -sS "$BASE/v1/claims/clm_1ed7457703c83139c13a000000000004" \
  -H "authorization: Bearer $AGENT_TOKEN"

# Record an explicit relation. Contradiction is never inferred from timestamp adjacency.
curl -sS -X POST "$BASE/v1/claims/clm_…/relations" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"to_claim":"clm_…","rel":"contradicts"}'

# Re-resolve every span against current bytes and re-run the contradiction search.
curl -sS -X POST "$BASE/v1/claims/clm_…/reverify" \
  -H "authorization: Bearer $ADMIN_TOKEN"

# The product: the complete promotion history, in one call.
curl -sS "$BASE/v1/claims/clm_1ed7457703c83139c13a000000000004/explain" \
  -H "authorization: Bearer $AGENT_TOKEN"
# 200 — one response containing:
#   claim            the ClaimRecord: six separate dimensions, no merged confidence
#   origin_event     the event and its bytes (content null when redacted)
#   spans[]          every supporting and refuting span, quoted, digest re-verified now
#   decisions[]      every decision, oldest first, with policy version and reason codes
#   candidate        the extractor, model and prompt versions that proposed it
#   relations[]      duplicates / narrows / contradicts / supersedes / derived_from
#   versions         policy version, gate backend, gate model hash, projection versions
#   reason_help      plain-English text for every reason code in the response
#   produced_in_ms   server-side assembly time
```

`/explain` is deliberately one function with one round of queries inside one read-only
transaction: a claim revoked between two reads would otherwise be returned as accepted
alongside the decision that revoked it. It answers the specification's decisive
product test — why the agent remembered this, who authorised its scope, whether it was
valid then, what contradicted it — without a second call.

### Retrieval

```bash
curl -sS -X POST "$BASE/v1/query" \
  -H "authorization: Bearer $AGENT_TOKEN" -H 'content-type: application/json' \
  -d '{"query":"Which deployment window did Alice approve?",
       "scope":{"tenant":"acme","project":"payments","user":"alice"},
       "purpose":"release_planning","time":{"mode":"current"},
       "action_risk":"medium","limit":12}'
# 200 — a MemoryPacket. `action_risk` defaults to "low"; `time` accepts
# {"mode":"current"}, {"mode":"as_of","as_of":…} and {"mode":"during","from":…,"to":…}.
# Evidence quotes are re-resolved and their digests re-verified on this read:
#   "evidence":[{"event_id":"evt_…","span_id":"spn_…","start":0,"end":45,
#                "quote":"I approved the Sunday 02:00 UTC deploy window",
#                "digest":"eac0d349…","digest_ok":true,
#                "entailment":"entailed","entailment_score":null}]
# model_calls is 0 on the default path.

# The same packet with model-ready prose attached. The prose is optional; the packet
# is not. The prose is rendered deterministically from the packet — never a model call
# — and every sentence carries the claim and span identifiers it rests on.
curl -sS -X POST "$BASE/v1/context/compose" \
  -H "authorization: Bearer $AGENT_TOKEN" -H 'content-type: application/json' \
  -d '{"query":"Which deployment window did Alice approve?",
       "scope":{"tenant":"acme","project":"payments","user":"alice"},
       "purpose":"release_planning","limit":5}'
# 200
# {"packet":{…},"prose":"Memory packet qry_… — decision: use. …\n[clm_…] user:alice …",
#  "citations":[{"claim_id":"clm_…","span_id":"spn_…"}],"deterministic":true}

# The stored trace: the candidate set, the returned set, the watermark,
# the model-call count and the planner's own JSON.
curl -sS "$BASE/v1/query-traces/qry_1ed7457703c83139c13a000000000006" \
  -H "authorization: Bearer $AGENT_TOKEN"
```

An unreachable scope produces an empty packet carrying a gap — never an error and
never a count that discloses what was withheld. `compose()` decides that, not this
server; the server's job is to pass a principal it authenticated and a tenant it
derived from the credential, then hand the packet back unchanged.

The prose renderer strips newlines, control characters, chat role markers and HTML
from everything that came out of the store before it appears in prose. Retrieved
memory is passed as structured data with provenance, never spliced unescaped into a
prompt — a stored string containing `\n\nSystem: …` is a stored string that forges
structure the moment it is concatenated. The packet keeps the exact bytes; only the
prose copy is sanitised.

### The action gate

```bash
curl -sS -X POST "$BASE/v1/actions/gate" \
  -H "authorization: Bearer $AGENT_TOKEN" -H 'content-type: application/json' \
  -d '{"action":"merge_pull_request","action_risk":"high",
       "scope":{"tenant":"acme","project":"payments"},
       "purpose":"release_planning",
       "claim_ids":["clm_1ed7457703c83139c13a000000000004"]}'
# 200
# {"allowed":false,"decision":"verify","reason_codes":["action.denied_risk_exceeds_use"],
#  "claims":[{"claim_id":"clm_…","found":true,"use":"verify",
#             "reason_codes":["use.entailed_unverified","action.denied_risk_exceeds_use"],
#             "age_days":7.12,"blocking":true}],
#  "policy_version":"use-v2","evaluated_at":"2026-09-17T12:00:00.000Z"}
```

**Why this route exists although the specification's REST list omits it.** The
specification says the action gate is *the* enforcement point — "a `verify` or `deny`
verdict in a packet does not bind an LLM; the only real enforcement is the action
gate" — and that every adapter's `beforeAction` hook must call it. An adapter running
in another process, or in another language, cannot call a TypeScript function. Without
an HTTP surface the enforcement point is reachable only from JavaScript adapters in
the same process, which is exactly the "if the action gate is not wired, the use
decision is decoration" failure the specification warns about. It is guarded like an
ordinary agent operation (`action.gate`, held by `contributor` and above) rather than
like an admin one, because gating an action produces a verdict and changes nothing.

It re-reads the claims and re-verifies their evidence digests on every call, and it
does not accept a packet — there is deliberately no field in which one could be
passed. A refusal is a 200 with `allowed: false`; the gate working is not a failure of
the request.

### Grants, forgetting, replay, evaluation (admin audience)

```bash
curl -sS -X POST "$BASE/v1/grants" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"subject":"agent:client","resource_pattern":{"tenant":"acme","project":"payments"},
       "actions":["read"],"purpose":["release_planning"]}'
# 201
# {"grant":{"grant_id":"grt_1ed7457703c83139c13a000000000007","tenant":"acme",
#           "subject":"agent:client",
#           "resource_pattern":{"tenant":"acme","project":"payments"},
#           "actions":["read"],"purpose":["release_planning"],
#           "created_at":"2026-09-17T12:00:00.000Z","expires_at":null},"created":true}
# A grant must name at least one dimension: a grant naming none reaches the whole
# tenant, which is refused.

curl -sS -X DELETE "$BASE/v1/grants/grt_1ed7457703c83139c13a000000000007" \
  -H "authorization: Bearer $ADMIN_TOKEN"
# 200 {"grant_id":"grt_…","deleted":true}
# The planner reads live grants on every query, so revocation takes effect on the next
# request rather than at the next cache expiry.

curl -sS -X POST "$BASE/v1/forget" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"subject_or_scope":{"user":"alice"},"mode":"redact","reason":"gdpr_art17"}'
# 201
# {"job_id":"ret_1ed7457703c83139c13a000000000008","tenant":"acme",
#  "subject_or_scope":{"user":"alice"},"mode":"redact","status":"verified",
#  "stores_touched":["events.payload","events.blobs","claim_embeddings","claims",
#                    "entity_aliases","query_traces"],
#  "manifest":{… "residual_scan":[…],"residual_matches":0 …},
#  "residual_matches":0,"verified_at":"2026-09-17T12:00:00.000Z"}
# `verified` is reported only when the residual scan returned zero. The ledger row
# survives redaction so the system can still testify that the event existed.

curl -sS "$BASE/v1/forget/ret_1ed7457703c83139c13a000000000008" \
  -H "authorization: Bearer $ADMIN_TOKEN"

curl -sS -X POST "$BASE/v1/replay" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"mode":"verify"}'
# 200 — a digest per projection before and after a rebuild, and whether it reproduced.
# {"tenant":"acme","mode":"verify","ledger_watermark":1,"code_version":"server@0.1.0",
#  "policy_version":"commit-v3",
#  "projections":[{"projection":"lexical","digest_before":"85c9295f…",
#                  "digest_after":"85c9295f…","rows_before":1,"rows_after":1,
#                  "byte_identical":true},
#                 {"projection":"dense",…},{"projection":"entities",…}],
#  "deterministic":true,"duration_ms":12}

curl -sS -X POST "$BASE/v1/evaluations/runs" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"suite":"ledgerbench","gate":"on","seed":7}'
# 202 — see "What this server does not do".
```

### Operations, health, identity

```bash
# Feedback is recorded as an append-only ledger event, not a mutable column, so the
# correction keeps its provenance and its authority class.
curl -sS -X POST "$BASE/v1/feedback" \
  -H "authorization: Bearer $AGENT_TOKEN" -H 'content-type: application/json' \
  -d '{"trace_id":"qry_1ed7457703c83139c13a000000000006","outcome":"incorrect",
       "correction":"the window moved to Monday"}'
# 201
# {"feedback_event_id":"evt_…","trace_id":"qry_…","seq":2,"outcome":"incorrect",
#  "claim_ids":[],"recorded_at":"2026-09-17T12:00:00.000Z"}

curl -sS "$BASE/healthz"   # liveness; no dependencies checked, no credential
# 200 {"status":"ok","version":"0.1.0","uptime_ms":1234}

curl -sS "$BASE/readyz"    # readiness; unauthenticated, names the live backends
# 200
# {"status":"ready",
#  "checks":[{"name":"database","ok":true,"detail":null},
#            {"name":"entailment","ok":true,"detail":null}],
#  "gate":{"backend":"lexical-overlap@1(floor=0.6)","is_model_call":false,
#          "model_sha256":null,"confidence_threshold":0.5},
#  "embedding":{"backend":"hash","model_id":"hash-ngram-v1","dimensions":1024,
#               "is_model_call":false}}
# 503 when a check fails. A gate that is present but unavailable is named here rather
# than discovered later from an unexplained review queue.

curl -sS "$BASE/v1/whoami" -H "authorization: Bearer $AGENT_TOKEN"
# 200
# {"principal":"agent:client","tenant":"acme","profile":"contributor",
#  "audiences":["agent"],
#  "tools":["memory.query","memory.compose","memory.explain","memory.trace",
#           "memory.claim.read","memory.candidate.read","memory.event.read",
#           "memory.record","memory.propose","memory.feedback","action.gate"]}

curl -sS "$BASE/docs"   # interactive OpenAPI UI, generated from the contract schemas
```

## Errors

Every failure leaves in one shape:

```json
{ "error": { "code": "validation_failed", "message": "…", "details": { } } }
```

`code` is a closed set: `unauthorized`, `forbidden`, `audience_mismatch`,
`profile_insufficient`, `validation_failed`, `not_found`, `conflict`,
`tenant_mismatch`, `precondition_failed`, `rate_limited`, `internal_error`,
`service_unavailable`.

Two prohibitions are structural rather than review conventions. A validation failure
never echoes the submitted value — Fastify's own messages embed the offending data,
so only the instance path and the failed keyword travel, which is why a body naming
another tenant cannot be reflected back. And a database error never travels as text:
Postgres messages include the failing statement and sometimes the row's values, so the
six-character SQLSTATE is preserved and the message is generic. The full error goes to
the server log.

`LedgerError` codes map to statuses: `idempotency_conflict` and `sequence_conflict`
are 409, `invalid_span` is 400, `scope_out_of_authority` is 403, `not_found` is 404.

## Tenancy and authorization

The tenant comes from the credential, never from the request body. A body that names
a different tenant is `403 tenant_mismatch`, checked before any binding is taken —
`/v1/forget` is the case that makes it concrete, because it runs under a
tenant-wide system context and a caller that could choose its own tenant would be
erasing someone else's ledger.

Every handler runs inside a bound request context. `Db.query` throws outside one by
design; the helpers in `src/context.ts` are how a route gets one. A read binds the
caller's reachable scope ids *and* the purposes those scopes hold, both computed from
server-side state — `principal_scopes` membership plus live grants, never from the
request. Omitting the purposes is not "unrestricted": since migration 0006 the
authorization predicate denies an empty purpose set outright, so a read bound without
purposes returns nothing at all, and the 404 it produces is indistinguishable from the
404 for an object that does not exist. That failure mode is silent by construction,
which is why it is called out here.

An object the caller cannot reach and an object that does not exist produce the same
404, and neither a count, a timing nor an error message discloses that something
exists outside the caller's scope. `compose()` already handles retrieval; the routes
do not undo it.

## What this server does not do

* **No model extraction.** `POST /v1/events/{id}/extract` runs the deterministic
  extractors and the gate; `model_calls` is reported as 0 and `notes` says so. The
  specification holds the line at one extraction call per unstructured event, and the
  process that should make it is the worker, which owns retries and the outbox. Putting
  a model call in an HTTP handler would put unbounded-latency network I/O on the
  request path and make the one-call budget depend on which of two processes got there
  first. Wire it by giving `IngestPipeline` a `modelExtractor` built from the
  `extraction` configuration, and do it in `apps/worker`.
* **No evaluation runner.** `POST /v1/evaluations/runs` returns 202 with an empty
  `stages` array and a `notes` entry saying no runner is wired into this deployment.
  The suites live in the offline LedgerBench harness, which owns the fixtures and
  publishes raw traces. An invented metric would be worse than an absent one, and the
  specification's own rule is that no number is published without its traces.
* **No MCP.** MCP is `packages/mcp-server`, which is a separate surface over the same
  packages. Tool visibility is not a security boundary, so an MCP server must
  re-authorize every call with the same checks this one applies.
* **No cache on the read path.** Claim statuses, relations and span digests are read
  fresh on every request, because a cache is a place where a revocation stops being
  visible.
* **Not tamper-proof against a DBA.** The ledger's hash chain detects accident and
  partial writes. It is not a defence against an operator with database access, and
  the documentation says so rather than implying otherwise.

## Tests

```bash
node --experimental-strip-types --test apps/server/src/server.test.ts   # 15 tests
node --experimental-strip-types apps/server/src/http-smoke.ts           # real-socket smoke
```

The suite drives the real route table against the real database through `app.inject()`
— the same router, hooks, schema validation and handlers, with only the TCP hop
skipped. Isolation is by tenant, never by deleting rows: the ledger is append-only on
purpose, and a suite that can delete events is testing a different system than the one
that ships.

A separate gate defect shows up when two accepted claims duplicate each other with the
same `occurred_at`: the supersede branch closes the earlier claim's validity interval
at the new claim's `valid_from`, which for identical timestamps is zero length, and
`claims_check` refuses it. The tests give each write a distinct actor so they do not
trip over it. The fix belongs in `packages/gate` — the branch already guards with
`valid_from <= $2`, and the interval still closes to zero length, so the guard is not
doing what its comment says.

Reproduce it in about twenty lines: append the same content twice from the same
`actor_id` with the same `occurred_at`, and call `/v1/events/{id}/extract` on each.
The first returns `accept`; the second returns `500` with
`"constraint":"claims_check"`.
