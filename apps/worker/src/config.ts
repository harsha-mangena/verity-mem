/**
 * Worker configuration.
 *
 * The worker deliberately does not reuse `loadEnv()`'s server fields. A worker
 * that read `PORT` or `AGENT_TOKEN` would imply it serves traffic, and the two
 * processes have genuinely different operational surface: the server listens, the
 * worker claims. Sharing one config object makes it possible to start the worker
 * with server-only settings and have it appear healthy.
 *
 * Two variables exist here that the server does not have, and both exist because
 * of a constraint rather than a preference:
 *
 *   - `WORKER_BATCH_SIZE` / `WORKER_POLL_INTERVAL_MS` control the claim loop.
 *   - `WORKER_TENANT_SLUGS` lists the tenants this worker claims for.
 *
 * The tenant list is required, and that is a defect being worked around rather
 * than a design. `outbox` has row-level security with a tenant-keyed policy
 * (migration 0009), and `OutboxWorker.claim()` issues its `UPDATE ... FOR UPDATE
 * SKIP LOCKED` through `Db.systemQuery`, which by definition has no request
 * context bound — so the policy denies every row, the claim returns nothing, and
 * the worker reports a clean, empty, permanently stalled queue. The worker here
 * binds a tenant system context around each `runOnce` call so the claim is
 * authorized, and that requires knowing which tenants to bind. See README.md and the port
 * notice in `claim-loop.ts`. The fix belongs in `packages/ledger`.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_COMMIT_POLICY } from "@veritymem/contracts";

export interface WorkerConfig {
  readonly databaseUrl: string;
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  /** Tenants this worker claims for. Empty means the loop starts but claims nothing. */
  readonly tenantSlugs: readonly string[];
  readonly blobDir: string;
  readonly gate: {
    readonly backend: "lexical" | "onnx";
    readonly modelPath: string | null;
    readonly modelSha256: string | null;
    readonly confidenceThreshold: number;
  };
  readonly entailmentFloor: number;
  readonly embedding: {
    readonly backend: "hash" | "openai";
    readonly dimensions: number;
    readonly modelId: string;
  };
  readonly extraction: {
    readonly baseUrl: string | null;
    readonly apiKey: string | null;
    readonly model: string | null;
    readonly ollamaBaseUrl: string | null;
  };
}

/**
 * Minimal `.env` reader.
 *
 * Duplicated from the ledger package rather than imported because the ledger's
 * version is not exported from its public surface as a standalone loader and the
 * parsing rules are eight lines. If the two ever disagree, the ledger's wins: the
 * worker must read the same `DATABASE_URL` the server wrote.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Load `.env` then `.env.local` from a directory, later files winning. */
export function loadEnvFiles(repoRoot: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const name of [".env", ".env.local"]) {
    const path = resolve(repoRoot, name);
    if (!existsSync(path)) continue;
    Object.assign(merged, parseEnvFile(readFileSync(path, "utf8")));
  }
  return merged;
}

function parseTenantSlugs(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * Resolve the worker's configuration.
 *
 * `env` is passed in rather than read from `process.env` so the demo and the test
 * suite can construct a worker against the same database without mutating global
 * process state — a test that sets `DATABASE_URL` for the whole process leaks that
 * choice into every other test in the run.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const repoRoot = resolve(import.meta.dirname, "../../..");
  const fileValues = loadEnvFiles(repoRoot);

  const pick = (key: string, fallback?: string): string | undefined => {
    const fromProcess = env[key];
    if (fromProcess !== undefined && fromProcess !== "") return fromProcess;
    const fromFile = fileValues[key];
    if (fromFile !== undefined && fromFile !== "") return fromFile;
    return fallback;
  };

  const backend = pick("GATE_ENTAILMENT_BACKEND") ?? "lexical";
  const embeddingBackend = pick("EMBEDDING_BACKEND") ?? "hash";

  return {
    databaseUrl:
      pick("DATABASE_URL") ?? "postgres://veritymem_app:veritymem_app@127.0.0.1:55432/veritymem",
    batchSize: Number.parseInt(pick("WORKER_BATCH_SIZE") ?? "25", 10),
    pollIntervalMs: Number.parseInt(pick("WORKER_POLL_INTERVAL_MS") ?? "1000", 10),
    tenantSlugs: parseTenantSlugs(pick("WORKER_TENANT_SLUGS")),
    blobDir: pick("LEDGER_BLOB_DIR") ?? resolve(repoRoot, ".veritymem/blobs"),
    gate: {
      backend: backend === "onnx" ? "onnx" : "lexical",
      modelPath: pick("GATE_MODEL_PATH") ?? null,
      modelSha256: pick("GATE_MODEL_SHA256") ?? null,
      confidenceThreshold: Number.parseFloat(pick("GATE_CONFIDENCE_THRESHOLD") ?? "0.5"),
    },
    // Not configurable through the environment on purpose: the entailment floor is
    // part of the versioned policy document, and a worker-local override would let
    // a deployment run a gate that no `decisions.policy_version` row describes.
    entailmentFloor: DEFAULT_COMMIT_POLICY.thresholds.lexicalEntailmentFloor,
    embedding: {
      backend: embeddingBackend === "openai" ? "openai" : "hash",
      dimensions: Number.parseInt(pick("EMBEDDING_DIMENSIONS") ?? "1024", 10),
      modelId: pick("EMBEDDING_MODEL_ID") ?? "hash-ngram-v1",
    },
    extraction: {
      baseUrl: pick("OPENAI_BASE_URL") ?? null,
      apiKey: pick("OPENAI_API_KEY") ?? null,
      model: pick("OPENAI_MODEL") ?? null,
      ollamaBaseUrl: pick("OLLAMA_BASE_URL") ?? null,
    },
  };
}
