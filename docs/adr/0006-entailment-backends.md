# ADR 0006 — Deterministic lexical entailment stand-in by default, ONNX DeBERTa-v3 MNLI opt-in, no LLM-as-judge

**Status:** Accepted · v0.1

## Context

The commit gate's central check is *entailment*: is the proposition the candidate
asserts actually established by the bytes it cites? The gate has to answer that
question on the write path, per candidate, before `claims.status` can become
`accepted`.

Three implementations were live at design time:

1. **A Python NLI sidecar.** Natural model support, but it adds a network hop on
   the write path, a second runtime to deploy, and a failure mode where the gate
   is down and writes silently degrade to ungated.
2. **A hosted LLM as judge.** Simplest to build, worst on cost, latency and
   reproducibility — and it reintroduces on the write path exactly the opaque,
   non-reproducible model dependency the read path refuses.
3. **ONNX in-process.** A quantised DeBERTa-v3 MNLI cross-encoder under ONNX
   Runtime for Node, inside the extraction worker. No extra service, no hop,
   deterministic given a fixed model hash.

## Decision

`packages/gate/src/entailment.ts` defines an `EntailmentBackend` interface with
exactly two shipped implementations and one degraded mode:

| Backend | Class / factory | `isModelCall` | Default? |
| --- | --- | --- | --- |
| `lexical` | `LexicalEntailmentBackend` | `false` | **Yes** (`GATE_ENTAILMENT_BACKEND=lexical`) |
| `onnx` | `createOnnxEntailmentBackend()` → `onnx-deberta-v3-mnli` | `false` (in-process, no network) | Opt-in |
| unavailable | `UnavailableEntailmentBackend` | `false` | Automatic on a missing model or missing `onnxruntime-node` |

**There is no LLM-as-judge backend, and no interface member that would let one be
added without changing the interface.** The module doc says why: *"It would put an
opaque, non-reproducible model on the write path of a system whose entire argument
is that promotion must be auditable."*

### The lexical backend is a stand-in, and says so

`LexicalEntailmentBackend` is deterministic, offline and makes no model call. Its
rules, in order:

1. If every *salient* token of the hypothesis (numbers, identifiers, dates,
   anything containing a digit, `:` `/` `_` `@`) is absent from the premise →
   `neutral`. This is the case that matters: a candidate asserting a date, amount
   or identifier the evidence never mentions.
2. If the hypothesis contains a negation the premise lacks, or vice versa →
   `contradiction`. Negation is the one thing a bag-of-words check must not
   ignore; `NEGATIONS` is an explicit set.
3. Otherwise entailment score is the fraction of hypothesis content tokens present
   in the premise, subject to `floor` (default `0.6`).

It names itself honestly: `name = "lexical-overlap@1(floor=0.6)"`, and
`modelSha256` is `null` so no consumer can mistake it for a pinned model. Its
`score` is documented as *"reported as an extracted signal, never as a confidence
in the claim"*.

### The ONNX backend refuses rather than guessing

`createOnnxEntailmentBackend()` verifies the model file exists, dynamically
imports `onnxruntime-node` (an optional peer), and SHA-256s the weights if a hash
was not supplied. A missing file or missing runtime returns
`UnavailableEntailmentBackend`, whose `entails()` returns
`{ result: "unknown" }` — which drives the gate to `needs_review` rather than to
`accept`. Failing closed on a model outage is the entire reason that class exists.

The ONNX path currently **refuses to be trusted for scoring**: it feeds the model
`pseudoTokenize()`, a structural placeholder that hashes tokens into a 30 000-entry
vocabulary. The doc comment states the position plainly — *"this is not a real
tokenizer, and the ONNX backend above documents that it must not be used for
scoring until the pinned tokenizer artefact is available."* The wiring is testable
end to end; the numbers it produces are not meaningful. This is an honest
incompleteness, not a working feature.

## Consequences

- **CI and tests run the real gate code path with zero model dependency.** The
  default is not a stub that bypasses the gate; it is the gate with a weaker
  entailment check. A test that exercises `CommitGate.evaluate()` exercises the
  same ordering, the same reason codes and the same persistence.
- **Model calls are counted and recorded per decision.** `GateResult.detail`
  carries `entailment_backend`, `entailment_model_sha256`, `entailment_aggregate`,
  `entailment_score` and `model_calls`, so a packet can state which backend
  produced it. `EntailmentBackend.isModelCall` exists purely so this count is
  honest.
- **The gate's accuracy is bounded by the backend, and the system says so.** The
  lexical backend cannot detect cross-sentence coreference or entity-attribution
  error; both are named as known failure classes with their own reason codes
  (`entailment.known_coreference_failure`,
  `entailment.known_entity_attribution_failure`). Neither code is currently emitted
  by any code path — see the gap list in `docs/threat-model.md`.
- **Harder:** an operator who wants real entailment must ship a model artefact, pin
  its hash, and — before the ONNX path is worth using — pin a matching tokenizer,
  which does not exist in this repository yet.
- **Harder:** the `entailmentFloor` in `DEFAULT_COMMIT_POLICY.thresholds` (0.5) and
  the `floor` inside `LexicalEntailmentBackend` (0.6, or
  `GATE_THRESHOLDS.lexicalEntailmentFloor`) are two different numbers with two
  different meanings, and nothing currently constructs a `LexicalEntailmentBackend`
  from the configured threshold. Changing `lexicalEntailmentFloor` in
  `packages/contracts/src/policy.ts` has **no effect** unless the backend is
  constructed with it. This is a live wiring gap and is reported in
  `docs/policy-cookbook.md`.
- **Harder:** zero model calls means zero chance the gate understands paraphrase.
  "Alice approved the Sunday window" does not entail "the deploy was authorised by
  Alice" under token overlap, and that candidate will land in `needs_review`. The
  review-burden ceiling is what makes this visible.

## Alternatives rejected

**Hosted LLM as judge.** Rejected: cost, latency, non-reproducibility, and it
reintroduces on the *write* path the exact dependency the *read* path refuses. It
also makes the gate's verdict depend on a model version that cannot be pinned in
`projection_versions`.

**Python NLI sidecar.** Rejected for v0.1 as a default: a second runtime, a network
hop on the write path, and a new silent-degradation mode. The spec keeps it as the
documented fallback if a target language lacks a usable ONNX export; it is not
implemented here.

**Ship the ONNX backend as the default.** Rejected: the tokenizer artefact is not
pinned, so the default would be a model fed wrong tokenisation producing confident
nonsense. A default that is confidently wrong is worse than a default that is
honestly weak.

**No gate at all below a confidence threshold (skip entailment when unsure).**
Rejected: skipping a check is not the same as failing a check. An unavailable
entailment produces `entailment.unavailable` and `needs_review`, never `accept`.
