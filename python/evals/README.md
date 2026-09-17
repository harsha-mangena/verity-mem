# VerityMem evaluation harness (offline)

Python 3.12+, managed with `uv`. **This package is never on the online path.**

```bash
cd python/evals
uv run pytest
uv run veritymem-eval-report run.json --json report.json
```

## Why offline, and why that is not a limitation

The online path is TypeScript by design, for reasons the specification gives: the
agent ecosystem that matters is TypeScript, and a memory layer must not put a second
runtime on the write path. That decision would be undermined by evaluating the system
through a different code path from the one that serves traffic, so this package reads
JSON and writes a report. It never opens a database connection and never calls a
model.

## What it reads

- **A LedgerBench run** emitted by `packages/ledgerbench`, containing a manifest, the
  eleven stage results, and the v0.1 exit target measurements.
- **Externally produced benchmark results**, if you have them, as
  `{"results": [...]}`. See `src/veritymem_evals/external.py`.

## What it refuses to do

- **Report an unimplemented stage as zero.** A zero is indistinguishable from a real
  failure, and it becomes a number someone quotes. Unimplemented stages are labelled
  `not_implemented`, and the summary names them.
- **Omit an unmeasured target.** Every v0.1 target appears in the table. An
  unmeasured one is a failure with the reason attached, so a partial run cannot look
  complete.
- **Call a run citable without provenance.** Dataset version, code version, policy
  version, gate backend, and the model hash when an ONNX gate is in use. A run
  missing any of them is flagged at the top of the report, and the CLI exits
  non-zero.
- **Compare against a competitor's headline score.** Six external benchmarks are
  named in the specification and all six have contested numbers. `external.py`
  imports a result only together with the model, dataset revision, retrieval budget
  and judge that make it comparable, and it marks a result as citable only once it
  has been reproduced locally and carries a source URL.

That last refusal is the point of the module. A benchmark table containing
incomparable rows is a marketing artefact, and the only defence against producing one
is to make missing provenance a hard error rather than a blank cell.

## The targets the report measures

The v0.1 exit targets are held in `report.py`, verbatim from the specification, so a
run cannot quietly redefine the bar it is measured against. Two of them cannot be
satisfied by any in-house run and the report says so:

- *0 cross-tenant or revoked-grant retrievals* must be measured by an **external red
  team**. A self-graded isolation claim is worthless, which the specification states
  in those words.
- *p95 non-LLM query under 250 ms at one million accepted claims* requires a
  published reference machine and a dataset that size.
