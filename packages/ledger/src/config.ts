/**
 * Configuration.
 *
 * Defaults are development defaults, and every one of them is safe: the gate
 * falls back to a deterministic offline entailment check rather than to "no
 * gate", and telemetry is off. A missing environment variable must never be the
 * reason a security control is absent.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export interface Env {
  readonly databaseUrl: string;
  readonly migrationDatabaseUrl: string | null;
  readonly migrationsDir: string;
  readonly s3: {
    readonly endpoint: string | null;
    readonly region: string;
    readonly accessKeyId: string | null;
    readonly secretAccessKey: string | null;
    readonly bucket: string;
  };
  readonly ledgerInlinePayloadLimit: number;
  readonly port: number;
  readonly host: string;
  readonly agentToken: string;
  readonly adminToken: string;
  readonly extraction: {
    readonly baseUrl: string | null;
    readonly apiKey: string | null;
    readonly model: string | null;
    readonly ollamaBaseUrl: string | null;
    readonly ollamaModel: string | null;
    readonly anthropicApiKey: string | null;
    readonly anthropicModel: string | null;
    readonly anthropicBaseUrl: string;
  };
  readonly gate: {
    readonly backend: "lexical" | "onnx";
    readonly modelPath: string | null;
    readonly tokenizerPath: string | null;
    readonly modelSha256: string | null;
    /**
     * Threshold on the entailment probability, per backend.
     *
     * One number cannot serve both backends: the lexical stand-in reports a token-overlap
     * fraction and the ONNX model reports a softmax probability. Sharing a threshold
     * between them is how a calibrated gate silently becomes an uncalibrated one.
     */
    readonly entailmentThreshold: number;
    readonly contradictionThreshold: number;
  };
  readonly embedding: {
    readonly backend: "hash" | "openai";
    readonly dimensions: number;
    readonly modelId: string;
  };
  readonly retention: {
    readonly ledgerMode: "redact" | "erase";
  };
  readonly repoRoot: string;
}

/** Minimal .env parser. No dependency, no surprises about quoting rules. */
export function parseDotEnv(contents: string): Record<string, string> {
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

function loadDotEnvFiles(repoRoot: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const name of [".env", ".env.local"]) {
    const path = resolve(repoRoot, name);
    if (!existsSync(path)) continue;
    Object.assign(merged, parseDotEnv(readFileSync(path, "utf8")));
  }
  return merged;
}

function pick(
  fileValues: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: string | undefined,
): string | undefined {
  const fromProcess = process.env[key];
  if (fromProcess !== undefined && fromProcess !== "") return fromProcess;
  const fromFile = fileValues[key];
  if (fromFile !== undefined && fromFile !== "") return fromFile;
  return fallback;
}

export function loadEnv(overrides: Partial<Record<string, string>> = {}): Env {
  const repoRoot = resolve(here, "../../..");
  const fileValues = { ...loadDotEnvFiles(repoRoot), ...overrides };
  const get = (key: string, fallback?: string): string | undefined => pick(fileValues, key, fallback);

  const databaseUrl =
    get("DATABASE_URL") ?? "postgres://veritymem_app:veritymem_app@127.0.0.1:55432/veritymem";

  return {
    databaseUrl,
    migrationDatabaseUrl:
      get("MIGRATION_DATABASE_URL") ?? "postgres://verity:verity@127.0.0.1:55432/veritymem",
    migrationsDir: get("MIGRATIONS_DIR") ?? resolve(repoRoot, "migrations"),
    s3: {
      endpoint: get("S3_ENDPOINT") ?? null,
      region: get("S3_REGION") ?? "us-east-1",
      accessKeyId: get("S3_ACCESS_KEY_ID") ?? null,
      secretAccessKey: get("S3_SECRET_ACCESS_KEY") ?? null,
      bucket: get("S3_BUCKET") ?? "veritymem-blobs",
    },
    ledgerInlinePayloadLimit: Number.parseInt(get("LEDGER_INLINE_PAYLOAD_LIMIT") ?? "8192", 10),
    port: Number.parseInt(get("PORT") ?? "8787", 10),
    host: get("HOST") ?? "127.0.0.1",
    agentToken: get("AGENT_TOKEN") ?? "dev-agent-token",
    adminToken: get("ADMIN_TOKEN") ?? "dev-admin-token",
    extraction: {
      baseUrl: get("OPENAI_BASE_URL") ?? null,
      apiKey: get("OPENAI_API_KEY") ?? null,
      model: get("OPENAI_MODEL") ?? null,
      ollamaBaseUrl: get("OLLAMA_BASE_URL") ?? null,
      ollamaModel: get("OLLAMA_MODEL") ?? null,
      anthropicApiKey: get("ANTHROPIC_API_KEY") ?? null,
      anthropicModel: get("ANTHROPIC_MODEL") ?? null,
      anthropicBaseUrl: get("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com",
    },
    gate: {
      backend: (get("GATE_ENTAILMENT_BACKEND") ?? "lexical") === "onnx" ? "onnx" : "lexical",
      modelPath: get("GATE_MODEL_PATH") ?? null,
      tokenizerPath: get("GATE_TOKENIZER_PATH") ?? null,
      modelSha256: get("GATE_MODEL_SHA256") ?? null,
      entailmentThreshold: Number.parseFloat(get("GATE_ENTAILMENT_THRESHOLD") ?? get("GATE_CONFIDENCE_THRESHOLD") ?? "0.5"),
      contradictionThreshold: Number.parseFloat(get("GATE_CONTRADICTION_THRESHOLD") ?? "0.5"),
    },
    embedding: {
      backend: (get("EMBEDDING_BACKEND") ?? "hash") === "openai" ? "openai" : "hash",
      dimensions: Number.parseInt(get("EMBEDDING_DIMENSIONS") ?? "1024", 10),
      modelId: get("EMBEDDING_MODEL_ID") ?? "hash-ngram-v1",
    },
    retention: {
      ledgerMode: (get("RETENTION_LEDGER_MODE") ?? "redact") === "erase" ? "erase" : "redact",
    },
    repoRoot,
  };
}

export function requireDatabaseUrl(env: Env): string {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return env.databaseUrl;
}
