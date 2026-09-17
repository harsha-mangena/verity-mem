# Known limitations

This file exists so that the gaps in v0.1 are readable in one place rather than
discovered by a reader who trusted a number. Every entry names something the code
does **not** do, or a claim it cannot support. Several are the reason the release is
labelled a preview rather than a finished v0.1.

Nothing here is a defect report against future work; each item is a statement about
the code as it exists at this commit. Where a limitation has a test that pins it, the
test is named, because a documented-but-unpinned limitation drifts.

## The ONNX verifier is correct but not calibrated

`packages/gate/src/onnx-entailment.ts` is the production entailment verifier the
deployment is meant to use. Two defects in it were fixed at `d6c1259`:

- the sentence pair's second half was the claim *hypothesis* rather than the
  *proposition*, so the model was asked whether the evidence stated the extractor's
  own subject key (`user:frank`) and predicate namespace;
- `encode("[CLS]")` returned `[507, 1]` instead of the id `tokenizer.json` declares
  (`1`), because the `special` tokens are also in the Unigram vocabulary and the
  Viterbi walk segmented their characters as ordinary pieces. Every sequence this
  backend built therefore contained no separator token at all.

With both fixed, the gate is scored against the LedgerBench corpus in
`reports/onnx-both-fixes.json`. All ten conformance traces pass. **Seven fixture
assertions still fail**, and every one of them is the gate *refusing* a claim the
fixture expected to be accepted:

```
ledgerbench/11_retrieval_scope_and_staleness:e2   expect_claim
poisoning/P02_unsupported_specifics:e2            expect_claim
poisoning/P04_scope_broadening:e1                 expect_scope_narrowed
poisoning/P04_scope_broadening:e1                 expect_reason
deletion/D01_erase_subject_zero_residual:e1       expect_claim
deletion/D02_redacted_span_unverifiable:e1        expect_claim
deletion/D02_redacted_span_unverifiable:d1        expect_unverifiable_claim
```

The direction matters: `unsafe_auto_accept_rate` is `0.0%` and
`contradiction_recall` is `100%`, so the residual is lost recall, not lost safety.
The honest reading is that **this checkpoint's notion of entailment is not the
corpus's**, and swapping it in for the lexical stand-in is not yet a drop-in
replacement. Reasons a reader should expect, none of which is established here:

- a general MNLI checkpoint is not a fact-verification model, and the corpus asserts
  things like `works_in Leeds office` against prose written by a different process;
- the thresholds (`GATE_ENTAILMENT_THRESHOLD`, `GATE_CONTRADICTION_THRESHOLD`) were
  neither tuned on a held-out split nor shipped with a calibration record, and tuning
  them against the same fixtures that score them would be fitting the test;
- the fixture corpus was authored against the lexical backend's behaviour.

**Therefore the lexical backend remains the default** (`GATE_ENTAILMENT_BACKEND`
unset), and `bash scripts/verify.sh` runs without the production verifier. A run that
does provision the model and does not use it prints a warning naming that fact, so a
published number cannot silently describe the stand-in. Closing this is calibration
work on a held-out corpus, not a code change, and it is not done.

## Measurements that do not exist

- **p95 query latency at the declared reference scale.** `packages/perf` can drive a
  one-million-claim corpus, but there is no published reference machine, so the
  target is `not_measured` and the run exits non-zero. A laptop number is recorded as
  evidence about the laptop.
- **Human audit set.** LedgerBench makes machine-checked assertions; none of them is a
  human label. An LLM judge is not a substitute and would have to publish its
  disagreement rate beside the number.
- **External isolation.** The isolation corpus in
  `packages/retrieval/src/isolation-corpus.test.ts` and the nine in-house cases are
  self-graded, which the specification correctly calls worthless as an external claim.
  An independent red team has not run. `docs/isolation-assessment.md` states the plan
  and the block stays open.
- **Contradiction detection on human-authored updates.** Templated recall is 100%;
  the specification's target also asks for human-authored cases and the corpus has
  none.
- **External user workload.** No external user has run this against a commit.

## Projections and the ledger

- **No projection rebuild is compared to its source.** `projections_compared` is `0`,
  so the `deterministic_projections` target fails even though replay equality is 100%.
  Replay equality is a proxy and is published as one, not as the target.
- **The hash chain is tamper-evident against accident, not tamper-proof against an
  operator with database access.** A DBA can rewrite history and recompute the chain.
- **Retention verifies live stores only.** Backups, replicas and point-in-time
  archives are out of scope; `forget()`'s `verified` status does not mean a deleted
  subject is gone from a snapshot.
- **`claims.expires_at` is always NULL**, so the `use.expired` decision path is
  unreachable in practice. The predicate exists and is tested; nothing sets it.

## Policy and gate judgement calls

- **The action gate refuses high-risk actions on `tool` observations as well as
  `user_self_report`.** Only `verified_record` passes at `high`. This is deliberate and
  stricter than strictly necessary; the test asserts the refusal rather than widening
  the policy.
- **The conflict classifier is conservative.** Two differing scalar values for the
  same subject and predicate produce `contradicts` and therefore review. That is what
  keeps `unsafe_auto_accept_rate` at zero and it is also part of why review burden
  exceeds its ceiling.
- **Review burden is above its ceiling.** 6.5% of non-adversarial writes need review
  against a 2% ceiling on the fixture corpus. Neither number is a production workload,
  and the target fails.
- **`reviewBurdenCeiling` has no reader in library code.** It is configuration that
  documents an intent no code enforces.
- **`origin` and `actor_id` are caller-supplied.** A caller that misreports its own
  origin is not detected, which bounds every authority judgement that reads them.

## Tokenisation

- **The normaliser is NFKC, not the checkpoint's precompiled character map.** The map
  is hashed and recorded on every decision (`normalizerSha256`) so the gap is
  auditable, but it is not executed. SentencePiece also strips control characters and
  applies a few mappings that are not NFKC; on those inputs this tokeniser can differ
  from the reference and reach a different verdict.
- **The full-text projection keys a claim on subject/predicate/object**, so
  `deploy.window` is one token and a query for "deploy window" matches nothing. See
  `fixtures/README.md` §2a.

## Environment

- **The acceptance workflow has not been executed on GitHub.** `.github/workflows/acceptance.yml`
  was rewritten to bring up the database from `deploy/compose/docker-compose.yml`,
  because a `services:` block cannot pass postmaster arguments and `scripts/verify.sh`
  asserts against the Compose-managed container by name. That workflow has still never
  run on a runner. The commands inside it are the ones `scripts/verify.sh` runs locally,
  and each step was validated by hand against a real Compose stack — but "the CI job is
  green" is not a claim this repository can make yet.
