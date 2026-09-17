"""Offline evaluation harness for VerityMem.

This package is deliberately, structurally offline. It reads JSON produced by the
TypeScript runner and by external benchmark harnesses, and it writes a report. It
never talks to the database, never calls a model, and never runs on the request
path.

The reason is in the specification: the online path must not have Python on it, and
an evaluation number that was produced by a different code path from the one that
serves traffic is not evidence about the system that serves traffic.

What this package will not do, and says so in its output rather than in a footnote:
it will not reproduce an external benchmark on your behalf. Six benchmarks are named
in the specification as candidates — LongMemEval, LoCoMo, HaluMem,
MemoryAgentBench, PASB and MemSecBench — and all six have contested numbers. A
competitor's headline score must never be quoted without matching model, dataset
revision, retrieval budget and judge, so the harness *imports* externally produced
results and records their provenance instead of manufacturing a comparison.
"""

__all__ = ["report", "external"]
