# Installing and running VerityMem

Three supported paths. Pick the one that matches what you are doing, and note what each one
does **not** give you — the difference matters more than the instructions.

| Path | Use it for | What it does not give you |
| --- | --- | --- |
| **Reference deployment** (container) | Running the API and worker against your own database | Nothing extra; see the model note below |
| **Source checkout** | Developing, running the acceptance check, reproducing the benchmarks | Requires pnpm, Node 22+, Docker and `uv` |
| **Client packages** (SDK, MCP, LangGraph) | Calling a running server from your own agent | The packages are **not on a registry** yet |

## 1. Reference deployment

Requires Docker. From a checkout of the commit you want:

```bash
WORKER_TENANT_SLUGS=my-tenant \
  docker compose -f deploy/compose/docker-compose.app.yml up -d --build
```

That brings up PostgreSQL 17 with pgvector 0.8.6, the server on `http://127.0.0.1:8787` with
its OpenAPI document at `/docs`, and a worker. The server image applies migrations before it
listens. This file is self-contained — it does **not** layer on top of `docker-compose.yml`,
which is the backing services a developer needs for `pnpm test`.

`WORKER_TENANT_SLUGS` is required and has no default, deliberately. Two alternatives were tried
and both are worse:

- **Defaulting to one tenant** means the worker polls a tenant nobody writes to. The queue
  grows, and the only symptom is that queries return nothing — indistinguishable from a
  memory-quality problem. Verified by doing it: one event appended for `container-probe`, one
  message pending, and a worker logging `claimed: 0` indefinitely.
- **Claiming from every tenant** means picking up another deployment's queue, and a backlog in
  one tenant starving every other tenant behind it in queue order. `OutboxWorker` rejects an
  empty list for the same reason.

Set it to the tenants this worker serves, comma-separated. The worker logs the list at startup.

### The entailment verifier

The production verifier is a quantised DeBERTa-v3 MNLI model. **Its weights are 233 MB and are
not in the image or the repository.** Fetch them into the mounted directory:

```bash
node scripts/fetch-model.mjs          # writes .veritymem/models/ and a digest lock file
```

Then set `GATE_ENTAILMENT_BACKEND=onnx` and restart. With that set and the assets missing or
not matching `GATE_MODEL_SHA256`, **the server and worker refuse to start**. That is
deliberate: a deployment that asked for evidence-backed entailment should stop rather than
quietly weaken to token overlap, and "the gate is down" is a better failure than "the gate is
running and accepting things it should not". `GET /readyz` reports which backend is live.

Until it is provisioned, every decision records `entailment.backend = lexical-overlap@1`, so a
claim's promotion history says which verifier judged it.

## 2. Source checkout

Requires Node 22.6+, pnpm 9.15, Docker, and `uv` for the Python harness.

```bash
pnpm install --frozen-lockfile -r
pnpm db:up
pnpm migrate
bash scripts/verify.sh
```

`scripts/verify.sh` is the acceptance check and the only command this project asks you to
trust. It pins and asserts every version it runs against, runs 280 TypeScript tests plus the
offline Python harness, exercises the reference workload end to end, drives the HTTP surface
over a real socket, and writes `reports/` with a summary naming the exact commit. **A missing
tool is a failure, not a skip**, and the benchmark's exit code is the gate — a partial pass
that looks like a pass is worse than no check.

The end-to-end demonstration of the whole thesis is:

```bash
pnpm demo                    # nine steps, printed as they happen
```

## 3. Client packages

`packages/sdk-ts`, `packages/mcp-server` and `packages/langgraph-js` are **private and
versioned 0.1.0 in lockstep**. Nothing is published to a registry yet, so "install" currently
means one of:

```bash
# Inside this workspace: a workspace dependency, which is how the adapters consume them.
#   "dependencies": { "@veritymem/sdk-ts": "workspace:*" }

# Outside it: a git dependency pinned to a commit, which is honest about what it is.
pnpm add github:harsha-mengena/verity-mem#<commit> --filter @veritymem/sdk-ts
```

Publishing to a registry is a v0.2 item. The packages are private on purpose rather than by
oversight: a pre-release that nobody can pin to a commit is worse than one that everybody
builds from source, because the lockfile is then the only thing tying an artifact to the code
that produced it.

### MCP server

```bash
# stdio, one process per client — the transport the MCP ecosystem uses for local tooling
VERITYMEM_API_URL=http://127.0.0.1:8787 \
VERITYMEM_TENANT=my-tenant \
VERITYMEM_PURPOSE=agent_memory \
node --experimental-strip-types packages/mcp-server/src/stdio.ts
```

A privileged tool (`memory_decide`, `memory_share`, `memory_forget`) is **never registered in
an ordinary session**, and the default profile is `contributor`. The server re-authorizes
every call as well, because tool visibility is not a security boundary.

## Onboarding a principal that must approve before it has written anything

Reach is computed from state the server owns:

```
reach(principal) = scopes the principal participates in  ∪  live grants naming it
```

Participation is recorded when a principal **writes** in a scope, and grants are explicit. So
a principal that has never written anywhere can read nothing and the action gate will refuse
any claim it cites — with `action.denied_missing_participation`, which is deliberately a
different code from `action.denied_unknown_claim`. Those two have different remedies and
conflating them leaves an operator unable to tell a typo from an onboarding problem.

This is fail-closed and correct, and it is still a cliff: a release manager who has only ever
written inside their own user scope cannot authorise an action citing a project-scope CI
claim. There are two supported remedies.

**Grant reach explicitly.** This is the right one, because it is time-bounded, purpose-scoped
and revocable:

```bash
curl -s -X POST http://127.0.0.1:8787/v1/grants \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{
        "subject": "user:dana",
        "resource_pattern": { "tenant": "acme", "project": "payments" },
        "actions": ["read"],
        "purpose": ["release_planning"],
        "expires_at": "2026-12-31T00:00:00Z"
      }' | jq
```

The grant lands in the same reach computation the query planner and the action gate both use,
so one call fixes both. `GET /readyz` reports whether a named principal holds any membership
or grant at all, and the `authority.no_reach` finding carries this instruction.

**Record administrative participation.** For a principal that genuinely belongs in a scope
rather than being granted into it:

```sql
SELECT veritymem.record_participation(
  '00000000-0000-0000-0000-000000000000'::uuid,  -- tenant id
  'user:dana',
  '<scope uuid>'::uuid
);
```

The row is labelled `admin`, so an operator reading the table can tell an administrative act
from organic participation — which matters because participation is *evidence* (the principal
wrote here, with a timestamp) while a grant is an *assertion*. ADR 0011 records why the
authorization model keeps that distinction rather than adding a role table.

**What not to do.** Do not widen the principal's token or bypass the gate to make the refusal
go away. The refusal is the control working; the remedy is a grant, and a grant is auditable.

## Verifying an installation

```bash
curl -s http://127.0.0.1:8787/readyz | jq
```

Reports, at minimum: whether the database is reachable, which entailment backend is live,
whether the configured embedding model matches the one that wrote the dense projection, and —
for a principal you name — whether it holds any scope membership at all. That last one exists
because a principal with no membership can read nothing and approve nothing, which is correct
and fail-closed, and is also the state every new principal starts in.

## What the installation does not include

- **No telemetry.** Nothing phones home. Logs are JSON lines on stdout.
- **No trained or hosted component.** Extraction, gating and retrieval all run in-process; the
  only network dependency is the database, plus an optional model endpoint you configure.
- **No deletion across backups.** Retention verifies the live stores this deployment declares.
  Backups, replicas and snapshots are outside the manifest, which is why envelope encryption
  is deferred to v0.5.
