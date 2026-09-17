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
cp .env.example .env
docker compose -f deploy/compose/docker-compose.yml \
               -f deploy/compose/docker-compose.app.yml up -d --build
```

That brings up PostgreSQL 17 with pgvector 0.8.6, the server on `http://127.0.0.1:8787` with
its OpenAPI document at `/docs`, and a worker. The server image applies migrations before it
listens.

`WORKER_TENANT_SLUGS` must be set, and the compose file refuses to start without it:

```bash
WORKER_TENANT_SLUGS=my-tenant docker compose ... up -d
```

That is not ceremony. A worker claiming from every tenant would pick up another deployment's
queue, and a backlog in one tenant would starve every other tenant behind it in queue order.
An empty list is rejected by `OutboxWorker` rather than silently claiming nothing.

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
