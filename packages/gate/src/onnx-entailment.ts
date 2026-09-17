/**
 * The production entailment verifier: DeBERTa-v3 MNLI, in process, via ONNX Runtime.
 *
 * This replaces an earlier implementation that produced correctly-shaped tensors from a
 * placeholder tokenizer. That version could not be trusted for scoring and was
 * documented as such, which meant the deployment's default verifier was a lexical proxy
 * — the exact gap the missing-blocks assessment names as P0. Three defects are fixed
 * here, and each was independently sufficient to make the backend useless:
 *
 *   1. **Tokenisation.** The model's own `tokenizer.json` is loaded and its Unigram
 *      vocabulary is used. See `sentencepiece.ts` for the normaliser's one documented
 *      approximation.
 *   2. **Label order.** `config.json` declares `{0: contradiction, 1: entailment,
 *      2: neutral}` and the model card agrees. The previous code read
 *      `[contradiction, neutral, entailment]`, which swaps *neutral* and *entailment* —
 *      so every neutral verdict was returned as entailed. That is the worst possible
 *      direction for this system: it promotes unsupported claims. Confirmed against the
 *      model card's own two examples, which are asserted in `tokenizer.test.ts`.
 *   3. **Input names.** This export takes `input_ids` and `attention_mask` only. The
 *      previous code fed a `token_type_ids` tensor the session does not declare, which
 *      ORT rejects.
 *
 * Reproducibility is a first-class property rather than a hope: the model file, the
 * tokenizer file and the normaliser's character map are each hashed at load, and all
 * three are recorded on every decision through the gate's `detail`.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { EntailmentResult } from "@veritymem/contracts";
import { SentencePieceUnigram } from "./sentencepiece.ts";
import type { EntailmentBackend, EntailmentRequest, EntailmentVerdict } from "./entailment.ts";

export const ONNX_BACKEND_NAME = "onnx-deberta-v3-mnli";

/**
 * Label order, taken from the model's `config.json` rather than assumed.
 *
 * Kept as a literal because the mapping is a property of *this* checkpoint, and a
 * checkpoint with a different order needs a different backend name so a decision record
 * cannot be misread across the two.
 */
export const ONNX_LABEL_ORDER: readonly EntailmentResult[] = ["contradiction", "entailed", "neutral"];

export interface OnnxEntailmentOptions {
  readonly modelPath: string;
  readonly tokenizerPath: string;
  /**
   * Threshold on the *entailment* probability, calibrated for this backend.
   *
   * Deliberately a separate knob from the lexical backend's token-overlap floor: the two
   * produce numbers on different scales and sharing one threshold between them is how a
   * calibrated gate silently becomes an uncalibrated one.
   */
  readonly entailmentThreshold: number;
  /** Threshold on the contradiction probability, above which the verdict is a refutation. */
  readonly contradictionThreshold: number;
  readonly maxLength?: number;
  /** Expected SHA-256 of the model file. A mismatch refuses to load. */
  readonly modelSha256?: string | undefined;
}

export interface OnnxAssets {
  readonly modelSha256: string;
  readonly tokenizerSha256: string;
  readonly normalizerSha256: string | null;
}

export class EntailmentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntailmentUnavailableError";
  }
}

/** Minimal structural types for the ONNX Runtime surface this module uses. */
interface OrtTensor {
  readonly data: ArrayLike<number>;
}
interface OrtSession {
  readonly inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
}
interface OrtModule {
  InferenceSession: { create(path: string): Promise<OrtSession> };
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export class OnnxEntailmentBackend implements EntailmentBackend {
  readonly name = ONNX_BACKEND_NAME;
  readonly modelSha256: string;
  readonly isModelCall = false;
  readonly assets: OnnxAssets;

  private readonly session: OrtSession;
  private readonly ort: OrtModule;
  private readonly tokenizer: SentencePieceUnigram;
  private readonly options: OnnxEntailmentOptions;

  private constructor(
    ort: OrtModule,
    session: OrtSession,
    tokenizer: SentencePieceUnigram,
    options: OnnxEntailmentOptions,
    assets: OnnxAssets,
  ) {
    this.ort = ort;
    this.session = session;
    this.tokenizer = tokenizer;
    this.options = options;
    this.assets = assets;
    this.modelSha256 = assets.modelSha256;
  }

  /**
   * Load the model and tokenizer, or throw.
   *
   * **Throws rather than degrading.** A deployment that configured the ONNX backend has
   * said it wants evidence-backed entailment; silently falling back to the lexical proxy
   * would weaken the gate without telling anyone, and a gate that cannot run must stop
   * the write path rather than quietly stop checking. `apps/server` and `apps/worker`
   * turn this into a startup failure; the escape hatch is an explicit configuration
   * change back to the lexical backend, which is visible in the decision record.
   */
  static async load(options: OnnxEntailmentOptions): Promise<OnnxEntailmentBackend> {
    for (const [label, path] of [
      ["model", options.modelPath],
      ["tokenizer", options.tokenizerPath],
    ] as const) {
      try {
        await stat(path);
      } catch {
        throw new EntailmentUnavailableError(
          `the ${label} is not present at ${path}. Configure GATE_MODEL_PATH and ` +
            `GATE_TOKENIZER_PATH, or set GATE_ENTAILMENT_BACKEND=lexical to use the ` +
            `documented stand-in. A gate that cannot run must not accept claims.`,
        );
      }
    }

    let ort: OrtModule;
    try {
      // Optional peer: a deployment on the lexical backend must not be forced to install
      // a native inference runtime.
      // @ts-ignore optional peer dependency, present only when the ONNX backend is used
      ort = (await import("onnxruntime-node")) as OrtModule;
    } catch {
      throw new EntailmentUnavailableError(
        "onnxruntime-node is not installed. Add it, or set GATE_ENTAILMENT_BACKEND=lexical.",
      );
    }

    const modelSha256 = await sha256File(options.modelPath);
    if (options.modelSha256 !== undefined && options.modelSha256 !== modelSha256) {
      throw new EntailmentUnavailableError(
        `the model at ${options.modelPath} hashes to ${modelSha256}, but ` +
          `${options.modelSha256} was configured. Refusing to score with an unpinned model.`,
      );
    }

    const tokenizer = await SentencePieceUnigram.fromFile(options.tokenizerPath);
    const session = await ort.InferenceSession.create(options.modelPath);

    // Fail at load rather than at the first candidate: a backend whose inputs do not
    // match the gate's expectation is a configuration error, and finding it on the first
    // write is finding it too late.
    for (const required of ["input_ids", "attention_mask"]) {
      if (!session.inputNames.includes(required)) {
        throw new EntailmentUnavailableError(
          `the ONNX model does not declare the input '${required}' (it declares ` +
            `${session.inputNames.join(", ")}). This backend targets the ` +
            `cross-encoder/nli-deberta-v3-base export.`,
        );
      }
    }

    return new OnnxEntailmentBackend(ort, session, tokenizer, options, {
      modelSha256,
      tokenizerSha256: tokenizer.sourceSha256 ?? "unavailable",
      normalizerSha256: tokenizer.normalizerSha256,
    });
  }

  async entails(request: EntailmentRequest): Promise<EntailmentVerdict> {
    const maxLength = this.options.maxLength ?? 512;
    const cls = this.tokenizer.encode("[CLS]").ids;
    const sep = this.tokenizer.encode("[SEP]").ids;
    // Premise then hypothesis, single sequence: this is a cross-encoder over a sentence
    // *pair*, and the order is part of the checkpoint's contract.
    const premise = this.tokenizer.encode(request.premise).ids;
    const hypothesis = this.tokenizer.encode(request.hypothesis).ids;
    const ids = [...cls, ...premise, ...sep, ...hypothesis, ...sep].slice(0, maxLength);

    const mask = new Array<bigint>(ids.length).fill(1n);
    const output = await this.session.run({
      input_ids: new this.ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      attention_mask: new this.ort.Tensor("int64", BigInt64Array.from(mask), [1, ids.length]),
    });

    const logits = output["logits"];
    if (!logits) {
      return { result: "unknown", score: 0, backend: this.name, modelSha256: this.modelSha256 };
    }
    const probabilities = softmax(Array.from(logits.data as ArrayLike<number>));
    const byLabel = new Map<EntailmentResult, number>();
    // The checkpoint's label is `entailment`; the contract's vocabulary calls the outcome
    // `entailed`. Mapped once, here, with the position recorded above.
    ONNX_LABEL_ORDER.forEach((label, index) => byLabel.set(label, probabilities[index] ?? 0));

    const entailment = byLabel.get("entailed") ?? 0;
    const contradiction = byLabel.get("contradiction") ?? 0;

    if (contradiction >= this.options.contradictionThreshold && contradiction > entailment) {
      return { result: "contradiction", score: contradiction, backend: this.name, modelSha256: this.modelSha256 };
    }
    if (entailment >= this.options.entailmentThreshold) {
      return { result: "entailed", score: entailment, backend: this.name, modelSha256: this.modelSha256 };
    }
    return {
      result: "neutral",
      score: byLabel.get("neutral") ?? 0,
      backend: this.name,
      modelSha256: this.modelSha256,
    };
  }
}

function softmax(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return total === 0 ? exps : exps.map((value) => value / total);
}
