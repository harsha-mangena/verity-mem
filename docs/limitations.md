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

- **The one-million-claim corpus that exists is incomplete.** The tenant
  `perf-bench-veritymem-perf-v1-1190477` holds 1,185,477 events, spans and claims, of
  which 995,801 are `accepted`, but only **395,000 embeddings** — 40% of the claims have
  no dense projection — and no `projection_versions` row, so the dense channel has no
  recorded model for that tenant. A latency measurement over it exercises a retrieval
  path with a partially populated vector index. The loader now refuses to report a
  corpus that did not land (see below), but this dataset predates that check and was
  produced by an interrupted load whose phases checkpoint independently. Re-running
  Re-running `pnpm eval:perf bench --skip-load` for that tenant cannot repair it: the
  loader's checkpoint for it is gone (`.veritymem/` is generated state, not committed),
  so a resume restarts from the first phase rather than filling the remainder, and
  `ON CONFLICT DO NOTHING` makes that idempotent but not cheap.

  The fix is verified to produce a complete dataset: `--claims 5000` on a fresh tenant
  yields 5,000 claims, 5,000 events, 5,000 embeddings, 100 relation edges, 170 aliases
  and a `projection_versions` row, where before the fix it yielded claims and events
  only. Producing the one-million-claim corpus again takes roughly an hour and a half of
  load on this machine; it has not been re-run at that size, so the numbers published
  for the large dataset describe the incomplete index and are labelled as such.
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
- **The review-burden target is measured on fixture writes, not a reference
  workload.** The specification's target is "under 2% of writes on the reference
  workload". On the default lexical gate the corpus's `ordinary` population — strong
  evidence, no conflict, no privileged kind, no sensitivity, no external instruction,
  which is the class the ceiling is defined over — measures **0 of 37 writes (0.0%)**,
  stable across seeds 1-3. It is tempting to report that as the target met. It is not:
  the ordinary population is fixture writes chosen to exercise the gate, not a sample of
  a deployed agent's traffic, so the number bounds the gate's behaviour on these
  fixtures and cannot establish a bound on a production workload. The target is
  therefore split in two: `review_burden` passes on its own population, and
  `reference_workload_burden` is `not_measured` for want of a reference workload. The
  suite exits non-zero either way.
- **Every review in the corpus is a control firing.** Of 48 decisions, 11 need review:
  7 adversarial, 3 contradicting, 1 high-sensitivity, and **0 ordinary**. The 22.9%
  headline rate is therefore not evidence of miscalibration, and an earlier revision
  that compared a `non_adversarial` denominator (10.0% of 40, which folds the 3
  contradicting writes in) made a correctly working gate look broken. Both numbers are
  published beside the target, and `ledgerbench.test.ts` asserts the safety limits on
  every seed so that reaching a lower rate by reviewing less fails rather than passes.
  Review burden is also computed per decision rather than per fixture: classifying it
  per fixture let a single adversarial fixture exclude that fixture's ordinary writes
  from the denominator, which reported 0.0% and was wrong.
- **`reviewBurdenCeiling` has no reader in library code.** It is configuration that
  documents an intent no code enforces.
- **A run that was scored without a pinned model digest cannot claim
  `deterministic_projections`.** The gate reports the missing pin as a second reason
  beside the absent projection rebuild, so a run cannot pass that target by running
  on a dirty tree.
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

## The performance loader derived ids from the seed, not the tenant

Fixed at the commit that adds this note, and recorded because of how it failed.

`generateClaim` derived `claim_id`, `event_id` and `span_id` from
`corpusUuid(corpusSeed, label, index)`, and `corpusUuid`'s docstring claimed the loader's
keys were `(tenant, label, index)`. Because `events.event_id` is a **global** primary key
and every corpus insert ends in `ON CONFLICT ... DO NOTHING`, the second tenant to load a
given corpus seed had **every row silently discarded**. Eleven tenants ended up sharing
event ids from one seed.

What made it expensive rather than obvious:

- the loader reported all seven phases complete, with a throughput figure for each,
  because `runPhase` commits and checkpoints after every batch — a phase reaching its
  final index means the statements were *accepted*, not that they inserted anything;
- the failure surfaced as `tenant <slug> holds no claims; run without --skip-load, or
  check that the tenant slug and corpus seed match`, which points at the corpus and the
  arguments rather than at the loader;
- the *content* was right. Only identity was wrong, so a corpus that looked correct in
  every field was written nowhere.

Three changes:

1. `CorpusOptions` now carries `tenantId` and the ids derive from it. The seed still
   determines the values, so one seed is still one corpus, and the field is required
   rather than optional so a new call site cannot forget it.
2. Relation edges used `corpusUuid(ctx.corpusSeed, ...)` for their target. Once identity
   moved to the tenant this pointed at a claim in no tenant, and the foreign key
   `claim_relations_to_claim_fkey` caught it — the one place the bug was loud.
3. `loadCorpus` now reads its own counts back and **throws** if any corpus table is
   empty for the tenant, so a load that writes nothing can no longer report success.

## Environment

- **The acceptance workflow has not been executed on GitHub.** `.github/workflows/acceptance.yml`
  brought the database up from a `services:` block until it was rewritten to use
  `deploy/compose/docker-compose.yml`: a `services:` block cannot pass postmaster
  arguments (the runner hands `options` to `docker create` ahead of the image, so
  `-c shared_preload_libraries=...` is parsed by the Docker CLI as `--cpu-shares`), and
  `scripts/verify.sh` asserts against the Compose-managed container by name.

  What *is* established: the file passes `actionlint` 1.7.12 with no findings, which is
  now step 3b of `scripts/verify.sh` rather than an ad-hoc check, and the assertion SQL
  and Compose bring-up were each executed by hand against a real stack. `actionlint`
  immediately found a defect no local run could have: `name: acceptance (node ${{
  env.NODE_VERSION }} ...)` is invalid because `env` is not an available context in a
  job's `name`, and an invalid workflow is not a job that fails — it is a workflow that
  never loads.

  What is *not* established: that a runner completes the job. Scheduling, the service
  container network, `pnpm install --frozen-lockfile` against a clean checkout and the
  artifact upload have never run anywhere. **"The CI job is green" is not a claim this
  repository can make.**
