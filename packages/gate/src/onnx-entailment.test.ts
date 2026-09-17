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
import { existsSync } from "node:fs";
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
