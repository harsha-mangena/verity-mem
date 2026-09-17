/**
 * Server configuration and backend construction.
 *
 * Everything the server needs is read through `loadEnv()` from `@veritymem/ledger`,
 * because two processes reading the same `.env` with two parsers is how the server
 * and the worker end up on different databases. What this module adds is the part
 * `loadEnv()` deliberately does not do: turning configuration into *constructed
 * backends*.
 *
 * That distinction is the actual point of this file. An audit found that
 * `GATE_ENTAILMENT_BACKEND`, `GATE_CONFIDENCE_THRESHOLD`, `EMBEDDING_BACKEND` and
 * `EMBEDDING_MODEL_ID` were parsed and then ignored — the gate always ran the
 * lexical stand-in and the embedder was always the hash n-gram. A parsed-but-inert
 * setting is worse than an absent one: the operator believes the deployment is
 * running a model, and the audit trail in `projection_versions` records the value
 * they configured rather than the one the process used.
 *
 * Two failure modes are chosen deliberately here:
 *
 *   * `GATE_ENTAILMENT_BACKEND=onnx` with a missing model yields
 *     `UnavailableEntailmentBackend`, whose verdict is `unknown`. The gate then
 *     degrades to `needs_review` rather than to ungated. Failing open on a model
 *     outage is the one degradation this system must never have, so the wrong
 *     model path is a review queue, not an accept.
 *   * `EMBEDDING_BACKEND=openai` with no endpoint is refused at load time rather
 *     than silently falling back to hashing. A silent fallback would make the dense
 *     channel's `model_id` disagree with the configured one, and the projection
 *     would then be un-rebuildable without anyone noticing.
 */
import { resolve } from "node:path";
import {
  DEFAULT_COMMIT_POLICY,
  type CommitPolicy,
} from "@veritymem/contracts";
import {
  FilesystemBlobStore,
  type BlobStore,
  type Clock,
  type Db,
  type Env,
  type IdGenerator,
  type Ledger,
  loadEnv,
  resolveTenantId,
  systemClock,
  systemIds,
} from "@veritymem/ledger";
import {
  type EntailmentBackend,
  LexicalEntailmentBackend,
  UnavailableEntailmentBackend,
  createOnnxEntailmentBackend,
} from "@veritymem/gate";
import {
  HashEmbeddingBackend,
  HostedEmbeddingBackend,
  type EmbeddingBackend,
} from "@veritymem/retrieval";

export interface ServerConfig {
  readonly env: Env;
  readonly host: string;
  readonly port: number;
  readonly agentToken: string;
  readonly adminToken: string;
  readonly blobDir: string;
  readonly commitPolicy: CommitPolicy;
  readonly gate: Env["gate"];
  readonly embedding: Env["embedding"];
  readonly extraction: Env["extraction"];
  readonly retention: Env["retention"];
}

/**
 * Read configuration. Pure: it constructs no connections, so a test can call it
 * with overrides without opening a database it will not use.
 */
export function loadServerConfig(overrides: Partial<Record<string, string>> = {}): ServerConfig {
  const env = loadEnv(overrides);
  return {
    env,
    host: overrides["HOST"] ?? env.host,
    port: env.port,
    agentToken: env.agentToken,
    adminToken: env.adminToken,
    blobDir: overrides["LEDGER_BLOB_DIR"] ?? resolve(env.repoRoot, ".veritymem/blobs"),
    // The policy document is data with a version; the engine that applies it is
    // code. Handing the object through rather than letting each caller reach for
    // the default is what keeps the version on the decision row and the version in
    // force the same value.
    commitPolicy: DEFAULT_COMMIT_POLICY,
    gate: env.gate,
    embedding: env.embedding,
    extraction: env.extraction,
    retention: env.retention,
  };
}

/**
 * Build the entailment backend the gate will use.
 *
 * Async because the ONNX backend loads its model lazily and reports absence rather
 * than throwing. The returned backend's `name` and `modelSha256` are what `/readyz`
 * and `/explain` report, so an operator can see which one is live without reading
 * the environment of a running process.
 */
export async function buildEntailmentBackend(config: ServerConfig): Promise<EntailmentBackend> {
  if (config.gate.backend === "onnx") {
    if (config.gate.modelPath === null || config.gate.modelPath.length === 0) {
      return new UnavailableEntailmentBackend(
        "GATE_ENTAILMENT_BACKEND=onnx but GATE_MODEL_PATH is unset; the gate degrades to needs_review rather than to ungated",
      );
    }
    return createOnnxEntailmentBackend({
      modelPath: config.gate.modelPath,
      modelSha256: config.gate.modelSha256,
    });
  }
  return new LexicalEntailmentBackend({ floor: config.commitPolicy.thresholds.lexicalEntailmentFloor });
}

/**
 * Build the embedding backend for the dense projection channel.
 *
 * The hash backend is not a placeholder: it is the default the architecture
 * actually wants, because the dense channel is a disposable projection and a
 * deterministic local embedder makes a rebuild byte-identical. `openai` requires a
 * configured endpoint and model, and refusing rather than falling back keeps
 * `claim_embeddings.model_id` truthful.
 */
export function buildEmbeddingBackend(config: ServerConfig): EmbeddingBackend {
  if (config.embedding.backend === "openai") {
    const baseUrl = config.extraction.baseUrl;
    const model = config.extraction.model;
    if (!baseUrl || !model) {
      throw new Error(
        "EMBEDDING_BACKEND=openai requires OPENAI_BASE_URL and OPENAI_MODEL; refusing to fall back to the hash embedder because claim_embeddings.model_id would then disagree with the configuration",
      );
    }
    return new HostedEmbeddingBackend({
      baseUrl,
      apiKey: config.extraction.apiKey,
      model,
      dimensions: config.embedding.dimensions,
    });
  }
  return new HashEmbeddingBackend({
    dimensions: config.embedding.dimensions,
    modelId: config.embedding.modelId,
  });
}

/** The blob store, resolved the same way the worker resolves it so both see one store. */
export function buildBlobStore(config: ServerConfig): BlobStore {
  return new FilesystemBlobStore(config.blobDir);
}

/**
 * The runtime dependencies every route reaches for.
 *
 * Grouped into one object rather than passed as six arguments so a route module
 * takes `deps` and nothing else, and so adding a backend is a change in one place.
 */
export interface ServerDeps {
  readonly config: ServerConfig;
  readonly db: Db;
  readonly ledger: Ledger;
  readonly blobs: BlobStore;
  readonly embeddings: EmbeddingBackend;
  readonly entailment: EntailmentBackend;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly policy: CommitPolicy;
}

export interface BuildDepsOptions {
  readonly db: Db;
  readonly ledger: Ledger;
  readonly blobs?: BlobStore;
  readonly embeddings?: EmbeddingBackend;
  readonly entailment?: EntailmentBackend;
  readonly ids?: IdGenerator;
  readonly clock?: Clock;
  readonly config: ServerConfig;
}

/** Assemble the dependency object, letting a test inject its own database and clock. */
export function buildDeps(options: BuildDepsOptions): ServerDeps {
  return {
    config: options.config,
    db: options.db,
    ledger: options.ledger,
    blobs: options.blobs ?? buildBlobStore(options.config),
    embeddings: options.embeddings ?? buildEmbeddingBackend(options.config),
    entailment: options.entailment ?? new LexicalEntailmentBackend({
      floor: options.config.commitPolicy.thresholds.lexicalEntailmentFloor,
    }),
    ids: options.ids ?? systemIds,
    clock: options.clock ?? systemClock,
    policy: options.config.commitPolicy,
  };
}

/**
 * The tenant a write is attributed to.
 *
 * Exported so the rule lives in exactly one place: a token-bound tenant wins, and a
 * body that names a different tenant is refused rather than merged. The `undefined`
 * case is the interesting one — a tenant-less token may still act, but only on the
 * tenant it names explicitly, and the caller of this function is responsible for
 * having rejected the request when neither is present.
 */
export function effectiveTenant(input: {
  readonly tokenTenant: string | null;
  readonly requestTenant: string | undefined;
}): { tenant: string; tenantId: string } | null {
  const tenant = input.tokenTenant ?? input.requestTenant ?? null;
  if (tenant === null || tenant.length === 0) return null;
  return { tenant, tenantId: resolveTenantId(tenant) };
}
