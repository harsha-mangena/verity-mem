import ort from "onnxruntime-node";
import { SentencePieceUnigram } from "./src/sentencepiece.ts";

const DIR = ".veritymem/models/nli-deberta-v3-base";
const tok = await SentencePieceUnigram.fromFile(`${DIR}/tokenizer.json`);
console.log("vocabulary size:", tok.vocabularySize);

// Sanity: the pieces the model card's examples should produce.
for (const s of ["A man is eating pizza", "▁A▁man▁is▁eating▁pizza"]) {
  const enc = tok.encode(s);
  console.log(`encode(${JSON.stringify(s)}) -> ${enc.ids.length} ids; first 8: ${JSON.stringify(enc.ids.slice(0, 8))}`);
  console.log(`   pieces: ${JSON.stringify(enc.pieces.slice(0, 8))}`);
}

const session = await ort.InferenceSession.create(`${DIR}/model_qint8_arm64.onnx`);
const LABELS = ["contradiction", "entailment", "neutral"];

async function score(premise, hypothesis) {
  // The model takes a single sequence: [CLS] premise [SEP] hypothesis [SEP].
  const cls = tok.encode("[CLS]").ids;
  const sep = tok.encode("[SEP]").ids;
  const a = tok.encode(premise).ids;
  const b = tok.encode(hypothesis).ids;
  const ids = [...cls, ...a, ...sep, ...b, ...sep].slice(0, 512);
  const mask = new Array(ids.length).fill(1);
  const out = await session.run({
    input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    attention_mask: new ort.Tensor("int64", BigInt64Array.from(mask.map(BigInt)), [1, ids.length]),
  });
  const logits = Array.from(out.logits.data);
  const max = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - max));
  const total = exps.reduce((s, v) => s + v, 0);
  const probs = exps.map((v) => v / total);
  const argmax = probs.indexOf(Math.max(...probs));
  return { label: LABELS[argmax], probs: probs.map((p) => Number(p.toFixed(3))), tokens: ids.length };
}

// The model card's own two examples, with its own expected answers.
const cases = [
  ["A man is eating pizza", "A man eats something", "entailment"],
  ["A black race car starts up in front of a crowd of people.", "A man is driving down a lonely road.", "contradiction"],
];
let pass = 0;
for (const [premise, hypothesis, expected] of cases) {
  const r = await score(premise, hypothesis);
  const ok = r.label === expected;
  if (ok) pass += 1;
  console.log(`${ok ? "PASS" : "FAIL"} expected=${expected.padEnd(13)} got=${r.label.padEnd(13)} probs[contradiction,entailment,neutral]=${JSON.stringify(r.probs)} tokens=${r.tokens}`);
}
console.log(`\n${pass}/${cases.length} of the model card's examples reproduced`);
process.exit(pass === cases.length ? 0 : 1);
