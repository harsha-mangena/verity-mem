/**
 * The production entailment verifier, and the four failure classes the assessment names.
 *
 * These tests load the real DeBERTa-v3 MNLI model through the real tokenizer. That is the
 * only way to make the claims the block asks for — a tokenizer that matches the model, a
 * label order that is right, and measured behaviour on paraphrase, invented specifics,
 * cross-sentence coreference and wrong-entity attribution. A mocked model would verify
 * that the mock agrees with itself.
 *
 * **When the model is absent the suite reports that loudly rather than passing.** The
 * weights are 233 MB and are not committed, so CI does not have them. A silent skip is how
 * a release ends up claiming measurement it never took, so the tests here print a
 * diagnostic naming the missing asset and the script that fetches it.
 *
 *     node scripts/fetch-model.mjs        # then re-run this file
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import {
  ONNX_LABEL_ORDER,
  OnnxEntailmentBackend,
  EntailmentUnavailableError,
} from "./onnx-entailment.ts";

const MODEL_DIR = process.env["GATE_MODEL_DIR"] ?? ".veritymem/models/nli-deberta-v3-base";
const MODEL_PATH = `${MODEL_DIR}/model_qint8_arm64.onnx`;
const TOKENIZER_PATH = `${MODEL_DIR}/tokenizer.json`;

const assetsPresent = existsSync(MODEL_PATH) && existsSync(TOKENIZER_PATH);

if (!assetsPresent) {
  // Printed, not swallowed. `node --test` has no "skipped loudly" concept that survives a
  // summary line, so the message is the report.
  process.stderr.write(
    `\n[onnx-entailment] MODEL ASSETS ABSENT — these tests did NOT run.\n` +
      `  expected: ${MODEL_PATH}\n` +
      `  expected: ${TOKENIZER_PATH}\n` +
      `  fetch with: node scripts/fetch-model.mjs\n` +
      `  The production entailment verifier is therefore UNVERIFIED in this environment.\n\n`,
  );
}

/**
 * The sentence *pair*, asserted without the model.
 *
 * `EntailmentRequest` carries both `proposition` and `hypothesis` and documents why they
 * are different strings; the model must be asked about the proposition. An earlier
 * revision encoded `hypothesis`, which put the subject key and predicate namespace into
 * the sequence as if the evidence had to state them.
 *
 * This is deliberately outside the model-assets guard. It is precisely the defect class a
 * full-model test localises badly and a skipped test hides completely, so it must run on
 * every machine — including CI, which never has the 233 MB weights.
 */
describe("onnx entailment sentence pair", () => {
  const options = {
    modelPath: "unused.onnx",
    tokenizerPath: "unused.json",
    entailmentThreshold: 0.5,
    contradictionThreshold: 0.5,
  };
  const assets = { modelSha256: "a".repeat(64), tokenizerSha256: "b".repeat(64), normalizerSha256: null };

  /**
   * A tokenizer that records what it was asked to encode, keyed by text.
   *
   * The special ids are this checkpoint's declared values (see
   * `tokenizer.json`'s `added_tokens`), not the BERT-style 101/102 that a
   * different family of checkpoint uses.
   */
  const SPECIAL_IDS: Record<string, number> = { "[CLS]": 1, "[SEP]": 2 };
  function recordingTokenizer(idsFor: (text: string) => number[]) {
    const encoded: string[] = [];
    const stub = {
      encode(text: string) {
        encoded.push(text);
        // Special tokens get their real ids so the sequence layout is checkable; the test
        // bodies only ever encode ordinary text through `idsFor`.
        return { ids: SPECIAL_IDS[text] === undefined ? idsFor(text) : [SPECIAL_IDS[text]!] };
      },
      sourceSha256: "b".repeat(64),
      normalizerSha256: null,
    };
    return { stub, encoded };
  }

  /** A session that returns the given logits and records the ids it was fed. */
  function recordingSession(logits: number[]) {
    const feeds: Array<{ input_ids: number[]; attention_mask: number[] }> = [];
    const stub = {
      inputNames: ["input_ids", "attention_mask"],
      async run(input: Record<string, { data: BigInt64Array }>) {
        feeds.push({
          input_ids: Array.from(input["input_ids"]!.data, Number),
          attention_mask: Array.from(input["attention_mask"]!.data, Number),
        });
        return { logits: { data: logits } };
      },
    };
    return { stub, feeds };
  }

  function backendOver(logits: number[]) {
    const { stub: tokenizer, encoded } = recordingTokenizer((text) => [text.length]);
    const { stub: session, feeds } = recordingSession(logits);
    const ort = {
      InferenceSession: { create: async () => session },
      // No parameter properties: `--experimental-strip-types` strips types without
      // transforming syntax, and a parameter property is syntax a transform would have to
      // generate code for. Written out longhand so the file runs under strip-only mode.
      Tensor: class {
        readonly data: BigInt64Array;
        readonly dims: number[];
        constructor(_type: string, data: BigInt64Array, dims: number[]) {
          this.data = data;
          this.dims = dims;
        }
      },
    };
    const backend = OnnxEntailmentBackend.overComponents(
      ort as never,
      session as never,
      tokenizer as never,
      options,
      assets,
    );
    return { backend, encoded, feeds };
  }

  it("encodes the proposition, not the hypothesis", async () => {
    const { backend, encoded } = backendOver([0, 5, 0]);

    await backend.entails({
      premise: "My employee id is E-1042",
      proposition: "employee_id E-1042",
      hypothesis: "user:alice employee_id E-1042",
    });

    assert.ok(
      encoded.includes("employee_id E-1042"),
      `the proposition was not encoded; encoded instead: ${JSON.stringify(encoded)}`,
    );
    assert.ok(
      !encoded.includes("user:alice employee_id E-1042"),
      "the hypothesis was encoded as the sentence pair's second half; the model must be " +
        "asked whether the evidence entails the proposition, not whether it states the " +
        "extractor's key",
    );
  });

  it("places premise and proposition in one [CLS] … [SEP] … [SEP] sequence", async () => {
    // The order is part of the checkpoint's contract, and the sequence layout is what a
    // cross-encoder scores. Asserting it here catches a future edit that silently
    // concatenates the documents into one segment.
    const { backend, feeds } = backendOver([0, 5, 0]);

    await backend.entails({
      premise: "ab",
      proposition: "cde",
      hypothesis: "unused-hypothesis",
    });

    assert.equal(feeds.length, 1);
    const ids = feeds[0]!.input_ids;
    assert.equal(ids.length, feeds[0]!.attention_mask.length, "attention span must match the sequence");
    assert.ok(feeds[0]!.attention_mask.every((m) => m === 1), "no padding is introduced");
    // The stub tokenizer encodes each text as its own length, so the ids identify which
    // text landed where: premise "ab" -> 2, proposition "cde" -> 3.
    assert.deepEqual(ids.slice(0, 3), [1, 2, 2], "CLS, premise, SEP");
    assert.deepEqual(ids.slice(3), [3, 2], "proposition, SEP");
  });
});

describe("onnx entailment verifier", { skip: !assetsPresent ? "model assets absent — see the diagnostic above" : false }, () => {
  let backend: OnnxEntailmentBackend;

  before(async () => {
    backend = await OnnxEntailmentBackend.load({
      modelPath: MODEL_PATH,
      tokenizerPath: TOKENIZER_PATH,
      // Calibrated for this backend, not inherited from the lexical floor. See the
      // threshold note in the docstring: the two produce numbers on different scales.
      entailmentThreshold: 0.5,
      contradictionThreshold: 0.5,
    });
  });

  it("pins the model, tokenizer and normaliser by digest", () => {
    assert.match(backend.assets.modelSha256, /^[0-9a-f]{64}$/);
    assert.match(backend.assets.tokenizerSha256, /^[0-9a-f]{64}$/);
    assert.equal(backend.modelSha256, backend.assets.modelSha256);
    // The normaliser's character map is pinned even though this build does not decode it,
    // so a future implementation can prove it is looking at the same bytes.
    assert.ok(backend.assets.normalizerSha256 === null || /^[0-9a-f]{64}$/.test(backend.assets.normalizerSha256));
  });

  it("declares the label order the checkpoint actually uses", () => {
    // {0: contradiction, 1: entailment, 2: neutral} from config.json and the model card.
    // The previous implementation read [contradiction, neutral, entailment], which
    // returned every neutral verdict as entailed — the worst possible direction.
    assert.deepEqual(ONNX_LABEL_ORDER, ["contradiction", "entailed", "neutral"]);
  });

  it("encodes the sequence separators as the ids the tokenizer file declares", () => {
    // The defect this pins: `added_tokens` marks `[CLS]`/`[SEP]` as `special` at ids 1 and
    // 2, but the Viterbi walk segmented those bracketed characters as ordinary pieces and
    // produced `[507, 1]` and `[507, 2]`. The model was therefore never shown a separator
    // at all, and every verdict was computed over a malformed sequence. The ids are read
    // from `tokenizer.json` and compared against the file, so a checkpoint whose ids
    // differ is caught rather than assumed to be BERT-style 101/102.
    const declared = JSON.parse(
      readFileSync(TOKENIZER_PATH, "utf8"),
    ) as { added_tokens?: Array<{ id: number; content: string; special?: boolean }> };
    const expected = new Map(
      (declared.added_tokens ?? []).filter((t) => t.special === true).map((t) => [t.content, t.id]),
    );

    for (const [token, id] of expected) {
      assert.deepEqual(
        backend.tokenizer().encode(token).ids,
        [id],
        `${token} must encode to its declared id ${id}, not to a segmentation of its characters`,
      );
    }
    assert.equal(expected.get("[CLS]"), 1, "this checkpoint declares [CLS] = 1");
    assert.equal(expected.get("[SEP]"), 2, "this checkpoint declares [SEP] = 2");
  });

  it("reproduces the model card's own two examples", async () => {
    const entailed = await backend.entails({
      premise: "A man is eating pizza",
      hypothesis: "A man eats something",
      proposition: "A man eats something",
    });
    assert.equal(entailed.result, "entailed", "the model card gives entailment for this pair");

    const contradicted = await backend.entails({
      premise: "A black race car starts up in front of a crowd of people.",
      hypothesis: "A man is driving down a lonely road.",
      proposition: "A man is driving down a lonely road.",
    });
    assert.equal(contradicted.result, "contradiction", "the model card gives contradiction for this pair");
  });

  describe("the four failure classes the assessment names", () => {
    it("accepts a paraphrase that shares little vocabulary with its evidence", async () => {
      // The lexical stand-in scores this near zero: almost no content words are shared.
      // A real NLI model is supposed to see through that, and this asserts it does —
      // otherwise there is no reason to prefer it to the stand-in.
      const verdict = await backend.entails({
        premise: "Alice gave the go-ahead for the Sunday 02:00 UTC deploy window.",
        hypothesis: "The deployment window was approved.",
        proposition: "The deployment window was approved.",
      });
      assert.equal(verdict.result, "entailed", `paraphrase was scored ${verdict.result} at ${verdict.score}`);
    });

    it("refuses an invented specific that appears nowhere in the evidence", async () => {
      // The dominant hallucination shape: a date the source never states.
      const verdict = await backend.entails({
        premise: "I approved the deployment window.",
        hypothesis: "I approved the deployment window for 03:00 UTC.",
        proposition: "I approved the deployment window for 03:00 UTC.",
      });
      assert.notEqual(verdict.result, "entailed", "an invented time must not be entailed by its evidence");
    });

    it("measures cross-sentence coreference, the documented false-negative class", async () => {
      // The referent of "she" is in the previous sentence, which the span does not include.
      // This is a known limitation published in the threat model rather than a bug to fix
      // here: the assertion records what the model actually does so the limitation has a
      // measured number behind it instead of a disclaimer.
      const verdict = await backend.entails({
        premise: "Alice reviewed the release notes.",
        hypothesis: "She approved the deploy window.",
        proposition: "She approved the deploy window.",
      });
      assert.ok(
        ["neutral", "contradiction", "entailed"].includes(verdict.result),
        "the verdict must be one of the three known outcomes",
      );
      process.stderr.write(
        `[onnx-entailment] coreference probe: ${verdict.result} at ${verdict.score.toFixed(3)} — ` +
          `a false negative here is the documented coreference limitation.\n`,
      );
    });

    it("measures wrong-entity attribution, the documented false-positive class", async () => {
      // Entailed by the span, but the span is about a different entity. A model that
      // cannot see the entity binding will call this entailed, which is why the gate
      // checks entity bindings deterministically *before* entailment.
      const verdict = await backend.entails({
        premise: "Bob approved the Sunday 02:00 UTC deploy window.",
        hypothesis: "Alice approved the Sunday 02:00 UTC deploy window.",
        proposition: "Alice approved the Sunday 02:00 UTC deploy window.",
      });
      process.stderr.write(
        `[onnx-entailment] wrong-entity probe: ${verdict.result} at ${verdict.score.toFixed(3)} — ` +
          `entailed here is the documented entity-attribution limitation.\n`,
      );
      assert.ok(["entailed", "contradiction", "neutral"].includes(verdict.result));
    });
  });

  describe("unavailability is a refusal, not a silent downgrade", () => {
    it("throws a typed error when the model is absent", async () => {
      // The block's requirement: an unavailable configured verifier must be a startup
      // failure rather than a silently weakened gate.
      await assert.rejects(
        () =>
          OnnxEntailmentBackend.load({
            modelPath: "/nonexistent/model.onnx",
            tokenizerPath: TOKENIZER_PATH,
            entailmentThreshold: 0.5,
            contradictionThreshold: 0.5,
          }),
        (error: unknown) =>
          error instanceof EntailmentUnavailableError &&
          /GATE_ENTAILMENT_BACKEND=lexical/.test((error as Error).message),
      );
    });

    it("throws when the model does not match the configured digest", async () => {
      await assert.rejects(
        () =>
          OnnxEntailmentBackend.load({
            modelPath: MODEL_PATH,
            tokenizerPath: TOKENIZER_PATH,
            entailmentThreshold: 0.5,
            contradictionThreshold: 0.5,
            modelSha256: "0".repeat(64),
          }),
        (error: unknown) =>
          error instanceof EntailmentUnavailableError && /Refusing to score with an unpinned model/.test((error as Error).message),
      );
    });
  });
});
