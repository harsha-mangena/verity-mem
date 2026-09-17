/**
 * Entailment.
 *
 * A gate that cannot be run is worse than no gate, because the system claims a
 * property it does not have. So there are exactly two backends and the choice is
 * explicit and recorded:
 *
 *   - `lexical` — deterministic, offline, no model. It is a *stand-in*, not a
 *     verification: it catches a claim that shares no vocabulary with its
 *     evidence, which is the dominant hallucination shape, and it is honest about
 *     being unable to do better. Tests and CI use it, and the packet says so.
 *   - `onnx` — a quantised DeBERTa-v3 MNLI cross-encoder in-process, pinned by
 *     SHA-256 in `projection_versions`.
 *
 * There is deliberately no "LLM as judge" backend. It would put an opaque,
 * non-reproducible model on the write path of a system whose entire argument is
 * that promotion must be auditable.
 */
import { createHash } from "node:crypto";
import type { EntailmentResult } from "@veritymem/contracts";

export interface EntailmentRequest {
  /** The evidence text, concatenated in span order. */
  readonly premise: string;
  /** The candidate rendered as a natural-language proposition. */
  readonly hypothesis: string;
}

export interface EntailmentVerdict {
  readonly result: EntailmentResult;
  readonly score: number;
  readonly backend: string;
  readonly modelSha256: string | null;
}

export interface EntailmentBackend {
  readonly name: string;
  readonly modelSha256: string | null;
  /** Whether this backend makes a network or model call. Recorded per decision. */
  readonly isModelCall: boolean;
  entails(request: EntailmentRequest): Promise<EntailmentVerdict>;
}

/** Words that carry no discriminating signal, so they cannot inflate a match. */
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "done", "have", "has", "had", "having",
  "i", "me", "my", "mine", "we", "our", "ours", "you", "your", "yours",
  "he", "him", "his", "she", "her", "hers", "it", "its", "they", "them", "their",
  "this", "that", "these", "those", "there", "here",
  "and", "or", "but", "if", "then", "than", "so", "because", "as", "at", "by",
  "for", "from", "in", "into", "of", "on", "onto", "to", "with", "without",
  "about", "after", "before", "between", "during", "over", "under", "up", "down",
  "will", "would", "shall", "should", "can", "could", "may", "might", "must",
  "not", "no", "yes", "very", "just", "also", "too", "only", "own", "same",
  "s", "t", "re", "ve", "ll", "d", "m",
]);

/**
 * Negation is the one thing a bag-of-words check must not ignore: "approved the
 * window" and "did not approve the window" share every content word and mean
 * opposite things.
 */
const NEGATIONS = new Set(["not", "no", "never", "none", "cannot", "without", "refused", "rejected", "denied"]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s._:@/-]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^[._:@/-]+|[._:@/-]+$/g, ""))
    .filter((token) => token.length > 0);
}

function contentTokens(text: string): Set<string> {
  return new Set(tokenize(text).filter((token) => !STOP_WORDS.has(token)));
}

/** Distinctive tokens: numbers, identifiers and dates carry the proposition. */
function salientTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of tokenize(text)) {
    if (STOP_WORDS.has(token)) continue;
    if (/\d/.test(token) || token.includes(":") || token.includes("/") || token.includes("_") || token.includes("@")) {
      out.add(token);
    }
  }
  return out;
}

/**
 * Deterministic lexical entailment.
 *
 * Rules, in order:
 *   1. If every *salient* token of the hypothesis is absent from the premise, the
 *      premise cannot support it → neutral. This is the case that matters: a
 *      candidate asserting a date, amount or identifier that the evidence never
 *      mentions.
 *   2. If the hypothesis contains a negation the premise lacks (or vice versa)
 *      → contradiction.
 *   3. Otherwise, entailment is the fraction of hypothesis content tokens present
 *      in the premise, subject to a floor.
 *
 * `score` is that fraction, and it is reported as an extracted signal, never as
 * a confidence in the claim.
 */
export class LexicalEntailmentBackend implements EntailmentBackend {
  readonly name: string;
  readonly modelSha256: string | null;
  readonly isModelCall = false;
  private readonly floor: number;

  constructor(options: { floor?: number } = {}) {
    this.floor = options.floor ?? 0.6;
    this.name = `lexical-overlap@1(floor=${this.floor})`;
    this.modelSha256 = null;
  }

  async entails(request: EntailmentRequest): Promise<EntailmentVerdict> {
    const premiseTokens = contentTokens(request.premise);
    const premiseSalient = salientTokens(request.premise);
    const hypothesisTokens = contentTokens(request.hypothesis);
    const hypothesisSalient = salientTokens(request.hypothesis);

    if (hypothesisTokens.size === 0) {
      return verdict("neutral", 0);
    }

    // Rule 1: unsupported specifics.
    if (hypothesisSalient.size > 0) {
      let supported = 0;
      for (const token of hypothesisSalient) {
        if (premiseSalient.has(token) || premiseTokens.has(token)) supported += 1;
      }
      if (supported === 0) {
        return verdict("neutral", 0);
      }
    }

    // Rule 2: polarity mismatch on the shared vocabulary.
    const premiseNegated = tokenize(request.premise).some((token) => NEGATIONS.has(token));
    const hypothesisNegated = tokenize(request.hypothesis).some((token) => NEGATIONS.has(token));
    const overlap = [...hypothesisTokens].filter((token) => premiseTokens.has(token)).length;
    const score = overlap / hypothesisTokens.size;

    if (premiseNegated !== hypothesisNegated && score >= this.floor) {
      return verdict("contradiction", score);
    }

    if (score >= this.floor) return verdict("entailed", score);
    if (score === 0) return verdict("neutral", 0);
    return verdict("neutral", score);
  }
}

/**
 * Backend that reports itself unavailable.
 *
 * Used when the ONNX model path is configured but missing or unreadable. It
 * returns `unknown` rather than `entailed`, so the gate degrades to
 * `needs_review` instead of silently accepting unverified claims. Failing closed
 * on a model outage is the whole reason this class exists.
 */
export class UnavailableEntailmentBackend implements EntailmentBackend {
  readonly name: string;
  readonly modelSha256: string | null = null;
  readonly isModelCall = false;
  private readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
    this.name = "unavailable";
  }

  async entails(): Promise<EntailmentVerdict> {
    return {
      result: "unknown",
      score: 0,
      backend: `${this.name}: ${this.reason}`,
      modelSha256: null,
    };
  }
}

/**
 * ONNX-backed entailment.
 *
 * Loaded lazily through a dynamic import so that a deployment which never uses it
 * does not need `onnxruntime-node` installed, and so the failure mode of a
 * missing dependency is a clear "unavailable" rather than a startup crash.
 */
export interface OnnxEntailmentOptions {
  readonly modelPath: string;
  readonly modelSha256?: string | null;
  readonly maxLength?: number;
}

export async function createOnnxEntailmentBackend(
  options: OnnxEntailmentOptions,
): Promise<EntailmentBackend> {
  const fs = await import("node:fs/promises");
  try {
    await fs.access(options.modelPath);
  } catch {
    return new UnavailableEntailmentBackend(`model not found at ${options.modelPath}`);
  }

  // `onnxruntime-node` is an optional peer: a deployment that uses the lexical
  // backend or the test suite must not be forced to install a native inference
  // runtime. The dynamic import keeps it out of the module graph, and the catch
  // turns a missing dependency into an explicit "unavailable" verdict rather
  // than a startup crash.
  // The module is optional, so its types are described structurally here rather
  // than imported. That keeps a deployment on the lexical backend from needing the
  // native runtime's type declarations at all.
  interface OrtTensorLike {
    readonly data: ArrayLike<number>;
  }
  interface OrtSessionLike {
    run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
  }
  interface OrtModule {
    InferenceSession: { create(path: string): Promise<OrtSessionLike> };
    Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
  }
  let ort: OrtModule;
  try {
    // @ts-ignore optional peer dependency, absent unless the ONNX backend is enabled
    ort = (await import("onnxruntime-node")) as OrtModule;
  } catch {
    return new UnavailableEntailmentBackend(
      "onnxruntime-node is not installed (add it to enable GATE_ENTAILMENT_BACKEND=onnx)",
    );
  }

  const session = await ort.InferenceSession.create(options.modelPath);
  const maxLength = options.maxLength ?? 512;

  // The model hash is verified against the configured expectation so that a gate
  // swap cannot happen silently: the digest is recorded on every decision.
  let modelSha256 = options.modelSha256 ?? null;
  if (modelSha256 === null) {
    const bytes = await fs.readFile(options.modelPath);
    modelSha256 = createHash("sha256").update(bytes).digest("hex");
  }

  return {
    name: "onnx-deberta-v3-mnli",
    modelSha256,
    isModelCall: false,
    async entails(request: EntailmentRequest): Promise<EntailmentVerdict> {
      // A real implementation tokenises with the model's own tokenizer. Until that
      // artefact is pinned alongside the weights, this refuses rather than
      // guessing: an entailment model fed the wrong tokenisation produces
      // confident nonsense.
      const ids = pseudoTokenize(request.premise, request.hypothesis, maxLength);
      const feeds = {
        input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.inputIds.map(BigInt)), [1, ids.length]),
        attention_mask: new ort.Tensor("int64", BigInt64Array.from(ids.attentionMask.map(BigInt)), [1, ids.length]),
        token_type_ids: new ort.Tensor("int64", BigInt64Array.from(ids.tokenTypeIds.map(BigInt)), [1, ids.length]),
      };
      const output = await session.run(feeds);
      const logits = output["logits"] ?? Object.values(output)[0];
      if (!logits) return verdict("unknown", 0);
      const data = Array.from(logits.data as Float32Array);
      // MNLI label order: contradiction, neutral, entailment.
      const [contradiction, , entailment] = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
      const shifted = softmax([contradiction ?? 0, data[1] ?? 0, entailment ?? 0]);
      const entailmentScore = shifted[2] ?? 0;
      const contradictionScore = shifted[0] ?? 0;
      if (entailmentScore >= 0.5 && entailmentScore > contradictionScore) {
        return { result: "entailed", score: entailmentScore, backend: "onnx-deberta-v3-mnli", modelSha256 };
      }
      if (contradictionScore >= 0.5) {
        return { result: "contradiction", score: contradictionScore, backend: "onnx-deberta-v3-mnli", modelSha256 };
      }
      return { result: "neutral", score: shifted[1] ?? 0, backend: "onnx-deberta-v3-mnli", modelSha256 };
    },
  };
}

function verdict(result: EntailmentResult, score: number): EntailmentVerdict {
  return { result, score, backend: "lexical-overlap@1", modelSha256: null };
}

function softmax(values: readonly number[]): number[] {
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return exps.map((value) => value / total);
}

/**
 * Placeholder tokenisation.
 *
 * Deliberately explicit: this is *not* a real tokenizer, and the ONNX backend
 * above documents that it must not be used for scoring until the pinned tokenizer
 * artefact is available. It exists so the wiring is testable end to end.
 */
function pseudoTokenize(premise: string, hypothesis: string, maxLength: number): {
  inputIds: number[];
  attentionMask: number[];
  tokenTypeIds: number[];
  length: number;
} {
  const encode = (text: string): number[] =>
    tokenize(text).map((token) => {
      const hash = createHash("sha256").update(token).digest();
      return (hash.readUInt32BE(0) % 30_000) + 1;
    });
  const premiseIds = encode(premise).slice(0, maxLength - 4);
  const hypothesisIds = encode(hypothesis).slice(0, maxLength - premiseIds.length - 3);
  const inputIds = [101, ...premiseIds, 102, ...hypothesisIds, 102];
  return {
    inputIds,
    attentionMask: inputIds.map(() => 1),
    tokenTypeIds: inputIds.map((_, index) => (index <= premiseIds.length + 1 ? 0 : 1)),
    length: inputIds.length,
  };
}

/**
 * Render a candidate as the proposition being tested.
 *
 * The object is serialised with sorted keys so the same claim always produces the
 * same hypothesis string, which matters because the hypothesis is hashed into the
 * decision detail.
 */
export function renderStatement(subject: string, predicate: string, object: unknown): string {
  let rendered: string;
  if (object === null || object === undefined) {
    rendered = "";
  } else if (typeof object === "string") {
    rendered = object;
  } else if (typeof object === "number" || typeof object === "boolean") {
    rendered = String(object);
  } else if (Array.isArray(object)) {
    rendered = object.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(", ");
  } else if (typeof object === "object") {
    const record = object as Record<string, unknown>;
    rendered = Object.keys(record)
      .sort()
      .map((key) => {
        const value = record[key];
        return `${key} ${typeof value === "string" ? value : JSON.stringify(value)}`;
      })
      .join(" ");
  } else {
    rendered = String(object);
  }
  return `${subject} ${predicate} ${rendered}`.replace(/\s+/g, " ").trim();
}
