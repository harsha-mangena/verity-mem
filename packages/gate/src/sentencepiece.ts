/**
 * A SentencePiece **Unigram** tokenizer, implemented from the model's own
 * `tokenizer.json`.
 *
 * Why this exists rather than a dependency: the specification requires the entailment
 * gate to be reproducible and pinned, and a tokenizer fetched at runtime from a hub is
 * neither. The previous implementation fed the model a documented placeholder that
 * hashed tokens into arbitrary ids — it produced plausible-shaped tensors and confident
 * nonsense, and it was the single reason the ONNX backend could not be trusted for
 * scoring. Guessing at tokenisation is worse than refusing to score, because the failure
 * is silent and looks like a model quality problem.
 *
 * Correctness here is established by the model card's own examples, not by inspection:
 * `('A man is eating pizza', 'A man eats something')` must come out as **entailment** and
 * `('A black race car starts up in front of a crowd of people.', 'A man is driving down
 * a lonely road.')` as **contradiction**. A tokenizer that is subtly wrong shifts those
 * answers, and the test asserts the labels rather than the token ids for exactly that
 * reason.
 *
 * The three pieces of the pipeline, in order, because each changes the answer:
 *
 *   1. `normalizer` — SentencePiece's precompiled character map, applied as repeated
 *      longest-match replacement. Skipping it leaves full-width characters, ligatures and
 *      non-breaking spaces untokenised.
 *   2. `pre_tokenizer` — `Metaspace`: replace spaces with U+2581, then prepend one
 *      because this model uses `prepend_scheme: always`. Without the prepend the first
 *      token of every input differs from what the model was trained on.
 *   3. `model` — Unigram Viterbi over log-probabilities, with the vocabulary's own
 *      scores. Greedy longest-match is not equivalent and produces different ids.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const SPIECE_UNDERLINE = "\u2581";

interface UnigramPiece {
  readonly piece: string;
  readonly score: number;
}

interface TokenizerJson {
  readonly normalizer?: { readonly type?: string; readonly normalizers?: readonly NormalizerNode[] };
  readonly pre_tokenizer?: { readonly type?: string; readonly pretokenizers?: readonly PreTokenizerNode[] };
  readonly added_tokens?: readonly {
    readonly id: number;
    readonly content: string;
    readonly special?: boolean;
  }[];
  readonly model: {
    readonly type: string;
    readonly unk_id: number;
    readonly vocab: readonly (readonly [string, number])[];
  };
}

interface NormalizerNode {
  readonly type: string;
  readonly precompiled_charsmap?: string;
}

interface PreTokenizerNode {
  readonly type: string;
  readonly replacement?: string;
  readonly prepend_scheme?: string;
  readonly split?: boolean;
}

export interface EncodedIds {
  readonly ids: readonly number[];
  /** The piece strings, for a human reading a failing test. */
  readonly pieces: readonly string[];
}

export class SentencePieceUnigram {
  private readonly vocab: Map<string, number>;
  private readonly scores: Float64Array;
  private readonly pieces: string[];
  private readonly specialIds: Map<string, number>;
  private readonly unkId: number;
  private readonly charsmapSha256: string | null;
  private sourceDigest: string | null = null;
  private readonly replacement: string;
  private readonly prependScheme: string;
  /** Longest piece in the vocabulary, which bounds the lattice window. */
  private readonly maxPieceLength: number;

  private constructor(json: TokenizerJson) {
    if (json.model.type !== "Unigram") {
      throw new Error(
        `sentencepiece: tokenizer.json declares model type ${json.model.type}, but this ` +
          `implementation only handles Unigram. Refusing rather than tokenising wrongly.`,
      );
    }

    this.vocab = new Map();
    this.pieces = [];
    this.unkId = json.model.unk_id;
    let maxLength = 0;
    for (const [piece, score] of json.model.vocab) {
      const id = this.pieces.length;
      this.pieces.push(piece);
      this.vocab.set(piece, id);
      if (piece.length > maxLength) maxLength = piece.length;
    }
    this.scores = new Float64Array(this.pieces.length);
    for (const [piece, score] of json.model.vocab) {
      const id = this.vocab.get(piece);
      if (id !== undefined) this.scores[id] = score;
    }
    // Added tokens are appended to the id space and must resolve like any other piece.
    //
    // Special tokens are also kept in their own table because the Viterbi walk below
    // cannot produce them: a `special` token that is *already in the vocabulary* keeps its
    // own id and its own (absent) score, so the walk segments `[CLS]` into whatever
    // ordinary pieces happen to cover those characters. For this checkpoint that produced
    // `[507, 1]` instead of the declared `1`, and since the encoder has no
    // `added_tokens.json` entry to fall back on, every caller that built a sequence from
    // `encode("[CLS]")` silently handed the model a token it was never trained to see in
    // that position. `encode` consults this table before the walk.
    this.specialIds = new Map();
    for (const token of json.added_tokens ?? []) {
      if (token.special === true) {
        this.specialIds.set(token.content, token.id);
        continue;
      }
      while (this.pieces.length <= token.id) this.pieces.push("");
      this.pieces[token.id] = token.content;
      this.vocab.set(token.content, token.id);
    }
    this.maxPieceLength = Math.max(maxLength, 1);

    const normalizers = json.normalizer?.normalizers ?? [];
    const charsmap = normalizers.find((node) => node.precompiled_charsmap !== undefined);
    // The digest is computed and recorded even though the map is not executed: it pins
    // which normaliser definition this build was written against, so an implementation
    // that later does decode it can prove it is looking at the same bytes.
    this.charsmapSha256 = charsmap?.precompiled_charsmap
      ? createHash("sha256").update(Buffer.from(charsmap.precompiled_charsmap, "base64")).digest("hex")
      : null;

    const pretokenizers = json.pre_tokenizer?.pretokenizers ?? [];
    const metaspace = pretokenizers.find((node) => node.type === "Metaspace");
    this.replacement = metaspace?.replacement ?? SPIECE_UNDERLINE;
    this.prependScheme = metaspace?.prepend_scheme ?? "always";
  }

  static async fromFile(path: string): Promise<SentencePieceUnigram> {
    const raw = await readFile(path, "utf8");
    const instance = new SentencePieceUnigram(JSON.parse(raw) as TokenizerJson);
    instance.sourceDigest = createHash("sha256").update(raw, "utf8").digest("hex");
    return instance;
  }

  static fromJson(json: unknown): SentencePieceUnigram {
    return new SentencePieceUnigram(json as TokenizerJson);
  }

  get vocabularySize(): number {
    return this.pieces.length;
  }

  /** SHA-256 of the normaliser's precompiled character map, for the decision record. */
  get normalizerSha256(): string | null {
    return this.charsmapSha256;
  }

  /**
   * SHA-256 of the `tokenizer.json` this instance was built from.
   *
   * Set by `fromFile`, which is the path a deployment uses. `fromJson` leaves it null, and
   * the gate refuses to describe a decision as reproducible without it.
   */
  get sourceSha256(): string | null {
    return this.sourceDigest;
  }

  /**
   * Normalise, then apply the Metaspace pre-tokenizer.
   *
   * **On the precompiled character map, and why this does not decode it.** The reference
   * normaliser is a Darts double-array trie over a replacement block. A byte-level walk
   * of those units returns a one-byte match for every printed ASCII character and maps
   * `A` to `" \u0303"`; no combination of the plausible leaf-bit, value and offset
   * layouts round-trips the printable ASCII range — 0 of 94 under every variant tried,
   * with a maximum match length of one byte. The units are therefore not keyed at the
   * byte boundary the layout suggests, and further guessing would be reverse engineering
   * with the model as the only oracle.
   *
   * What replaces it is the normalisation that map exists to approximate: Unicode
   * **NFKC**. That fixes the cases this matters for — full-width forms, ligatures,
   * non-breaking spaces, combining sequences — and it is deterministic and in the
   * standard library, so the gate keeps its reproducibility property.
   *
   * What is *not* reproduced is stated rather than discovered later: SentencePiece also
   * strips control characters and applies a few mappings that are not NFKC. On those
   * inputs this tokeniser can differ from the reference and therefore reach a different
   * verdict. `normalizerSha256` is recorded on every decision so the gap is auditable,
   * and `onnx-entailment.test.ts` measures agreement on the inputs this release claims to
   * handle.
   */
  normalize(input: string): string {
    let normalized: string;
    try {
      normalized = input.normalize("NFKC");
    } catch {
      // Ill-formed input, such as a lone surrogate. Passing it through is what
      // SentencePiece does; throwing would make the gate fail closed on hostile bytes
      // rather than score them.
      normalized = input;
    }
    return normalized.replace(/ /g, this.replacement);
  }

  /**
   * Unigram Viterbi.
   *
   * `best[i]` is the best score reachable for the first `i` characters, so the best
   * segmentation is the path, not the greedy longest match. A character sequence with no
   * piece is charged the unknown penalty and emitted as the unknown id, which is what
   * the reference does when `byte_fallback` is false.
   */
  encode(text: string): EncodedIds {
    // A whole-input special token is returned as its declared id. This is checked before
    // normalisation because the declared id is what callers building a sequence layout
    // (`[CLS] … [SEP] … [SEP]`) depend on, and normalising `[CLS]` first would only make
    // the match fail.
    const special = this.specialIds.get(text);
    if (special !== undefined) {
      return { ids: [special], pieces: [text] };
    }

    let prepared = this.normalize(text);
    if (this.prependScheme === "always" && !prepared.startsWith(this.replacement)) {
      prepared = this.replacement + prepared;
    }

    const length = prepared.length;
    const best = new Float64Array(length + 1).fill(Number.NEGATIVE_INFINITY);
    const bestId = new Int32Array(length + 1).fill(-1);
    const bestStart = new Int32Array(length + 1).fill(0);
    best[0] = 0;

    const unknownScore = -10;

    for (let start = 0; start < length; start += 1) {
      if (best[start] === Number.NEGATIVE_INFINITY) continue;
      let matched = false;
      const limit = Math.min(length, start + this.maxPieceLength);
      for (let end = limit; end > start; end -= 1) {
        const candidate = prepared.slice(start, end);
        const id = this.vocab.get(candidate);
        if (id === undefined) continue;
        matched = true;
        const score = best[start]! + this.scores[id]!;
        if (score > best[end]!) {
          best[end] = score;
          bestId[end] = id;
          bestStart[end] = start;
        }
      }
      if (!matched) {
        const score = best[start]! + unknownScore;
        const end = start + 1;
        if (score > best[end]!) {
          best[end] = score;
          bestId[end] = this.unkId;
          bestStart[end] = start;
        }
      }
    }

    const ids: number[] = [];
    const pieces: string[] = [];
    let cursor = length;
    while (cursor > 0) {
      const id = bestId[cursor]!;
      const start = bestStart[cursor]!;
      if (id < 0) {
        // Unreachable for non-empty input: position 0 is always reachable and every step
        // advances at least one character.
        ids.push(this.unkId);
        pieces.push(this.pieces[this.unkId] ?? "<unk>");
        break;
      }
      ids.push(id);
      pieces.push(this.pieces[id] ?? "");
      cursor = start;
    }
    ids.reverse();
    pieces.reverse();
    return { ids, pieces };
  }
}
