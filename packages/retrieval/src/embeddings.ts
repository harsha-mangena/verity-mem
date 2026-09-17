/**
 * Embedding backends.
 *
 * The default is a deterministic hashing embedder with no model and no network.
 * That is not a placeholder for a "real" embedder — it is the correct default for
 * a system whose architecture says the dense channel is a disposable projection.
 * A hash embedder gives a stable, rebuildable, zero-dependency similarity signal
 * whose quality is honestly described as lexical-similarity-with-extra-steps, and
 * it makes the replay oracle meaningful because a rebuild under the same code
 * version produces byte-identical vectors.
 *
 * Swapping in a hosted embedder is a configuration change, and because the model
 * id is recorded per row and in `projection_versions`, it is also a recorded,
 * replayable rebuild rather than a silent quality change.
 */
import { createHash } from "node:crypto";

export interface EmbeddingBackend {
  readonly model_id: string;
  readonly dimensions: number;
  /** Whether this backend reaches a network or model. */
  readonly isModelCall: boolean;
  embed(texts: readonly string[]): Promise<number[][]>;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "and", "or", "but", "if", "then", "of", "to", "in", "on", "for", "with",
  "i", "we", "you", "it", "they", "he", "she", "this", "that", "these", "those",
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s._:@/-]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

/**
 * Deterministic hashing embedder: token unigrams and bigrams, signed hashing,
 * L2-normalised.
 *
 * Signed hashing (rather than plain bucketing) keeps the expected inner product
 * of two unrelated vectors near zero instead of strictly positive, which is what
 * makes a cosine threshold meaningful at all.
 */
export class HashEmbeddingBackend implements EmbeddingBackend {
  readonly model_id: string;
  readonly dimensions: number;
  readonly isModelCall = false;

  constructor(options: { dimensions?: number; modelId?: string } = {}) {
    this.dimensions = options.dimensions ?? 1024;
    this.model_id = options.modelId ?? `hash-ngram-v1-${this.dimensions}`;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  embedOne(text: string): number[] {
    const vector = new Float64Array(this.dimensions);
    const parts = tokens(text);

    for (let index = 0; index < parts.length; index += 1) {
      const token = parts[index];
      if (token === undefined) continue;
      addFeature(vector, token, 1);
      const next = parts[index + 1];
      if (next !== undefined) addFeature(vector, `${token}_${next}`, 0.6);
      // A coarse character trigram signature gives the embedder some robustness to
      // inflection and typos without a vocabulary.
      if (token.length >= 5) {
        for (let offset = 0; offset + 3 <= token.length; offset += 3) {
          addFeature(vector, `#${token.slice(offset, offset + 3)}`, 0.25);
        }
      }
    }

    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm === 0) return Array.from(vector);
    return Array.from(vector, (value) => value / norm);
  }
}

function addFeature(vector: Float64Array, feature: string, weight: number): void {
  const digest = createHash("sha256").update(feature, "utf8").digest();
  const bucket = digest.readUInt32BE(0) % vector.length;
  const sign = (digest[4]! & 1) === 0 ? 1 : -1;
  vector[bucket] = (vector[bucket] ?? 0) + sign * weight;
}

/**
 * Hosted embedder over an OpenAI-compatible endpoint.
 *
 * Batched, because a per-claim request would make a rebuild of a million claims a
 * million HTTP calls. Used only when explicitly configured.
 */
export interface HostedEmbeddingOptions {
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly model: string;
  readonly dimensions: number;
  readonly batchSize?: number;
  readonly fetchImpl?: typeof fetch;
}

export class HostedEmbeddingBackend implements EmbeddingBackend {
  readonly model_id: string;
  readonly dimensions: number;
  readonly isModelCall = true;
  private readonly options: HostedEmbeddingOptions;

  constructor(options: HostedEmbeddingOptions) {
    this.options = options;
    this.dimensions = options.dimensions;
    this.model_id = `hosted:${options.model}`;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    const batchSize = this.options.batchSize ?? 64;
    const out: number[][] = [];
    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = texts.slice(start, start + batchSize);
      const doFetch = this.options.fetchImpl ?? fetch;
      const response = await doFetch(`${this.options.baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.options.model, input: batch, dimensions: this.dimensions }),
      });
      if (!response.ok) {
        throw new Error(`embedding endpoint returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      const body = (await response.json()) as { data?: { embedding: number[] }[] };
      for (const item of body.data ?? []) out.push(item.embedding);
    }
    return out;
  }
}

/** Cosine similarity for two already-normalised vectors, which is a dot product. */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += (left[index] ?? 0) * (right[index] ?? 0);
  return sum;
}

/** Serialise a vector for pgvector's text input format. */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => (Number.isFinite(value) ? value.toFixed(8) : "0")).join(",")}]`;
}
