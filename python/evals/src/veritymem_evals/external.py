"""Importing externally produced benchmark results, with their provenance attached.

The specification names six external benchmarks — LongMemEval, LoCoMo, HaluMem,
MemoryAgentBench, PASB, MemSecBench — and says of all six: *"reproduce before
citing, and never quote a competitor's headline score without matching model,
dataset revision, retrieval budget, and judge."*

That instruction rules out the obvious implementation. This module does not run any
of them, and it does not compare a VerityMem number to a number someone else
published. It *imports* a result together with the four facts that make it
comparable, and it refuses to treat the result as comparable when any of them is
missing.

Refusing is the feature. A benchmark table with incomparable rows in it is a
marketing artefact, and the only defence against producing one is to make the
missing provenance a hard error rather than a blank cell.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

# The four facts the specification requires before a score may be compared.
REQUIRED_COMPARABILITY_FIELDS: tuple[str, ...] = (
    "model",
    "dataset_revision",
    "retrieval_budget",
    "judge",
)

KNOWN_BENCHMARKS: tuple[str, ...] = (
    "LongMemEval",
    "LoCoMo",
    "HaluMem",
    "MemoryAgentBench",
    "PASB",
    "MemSecBench",
)


@dataclass(frozen=True)
class ExternalResult:
    """One externally produced number, with everything needed to judge comparability."""

    benchmark: str
    subject: str
    metric: str
    value: float
    model: str = ""
    dataset_revision: str = ""
    retrieval_budget: str = ""
    judge: str = ""
    source_url: str = ""
    reproduced_locally: bool = False
    notes: str = ""

    @property
    def missing_for_comparability(self) -> list[str]:
        return [name for name in REQUIRED_COMPARABILITY_FIELDS if not getattr(self, name)]

    @property
    def comparable(self) -> bool:
        """Whether this result may appear in a comparison table at all."""
        return not self.missing_for_comparability

    @property
    def citable(self) -> bool:
        """Whether this result may be cited in prose.

        Stricter than comparability: a result also has to be reproducible, and the
        specification requires reproducing before citing.
        """
        return self.comparable and self.reproduced_locally and bool(self.source_url)


@dataclass
class ExternalReport:
    """A set of imported results, with the ones that cannot be used kept visible."""

    results: list[ExternalResult] = field(default_factory=list)

    def usable(self) -> list[ExternalResult]:
        return [result for result in self.results if result.citable]

    def unusable(self) -> list[tuple[ExternalResult, list[str]]]:
        """Results that must not be cited, each with the reason it must not be."""
        out: list[tuple[ExternalResult, list[str]]] = []
        for result in self.results:
            reasons: list[str] = []
            missing = result.missing_for_comparability
            if missing:
                reasons.append(f"missing {', '.join(missing)}")
            if not result.reproduced_locally:
                reasons.append("not reproduced locally")
            if not result.source_url:
                reasons.append("no source url")
            if reasons:
                out.append((result, reasons))
        return out

    def unknown_benchmarks(self) -> list[str]:
        """Benchmark names outside the six the specification names.

        Reported rather than rejected: an internal suite is a legitimate thing to
        track, and pretending otherwise would push people to mislabel it.
        """
        return sorted({result.benchmark for result in self.results if result.benchmark not in KNOWN_BENCHMARKS})


def load_external_results(path: Path) -> ExternalReport:
    """Read a results file, rejecting any entry that cannot be evaluated."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    entries = payload.get("results") if isinstance(payload, dict) else payload
    if not isinstance(entries, list):
        raise ValueError(f"{path}: expected a list of results or an object with a `results` list")

    report = ExternalReport()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ValueError(f"{path}: result {index} is not an object")
        for required in ("benchmark", "metric", "value"):
            if required not in entry:
                raise ValueError(f"{path}: result {index} is missing `{required}`")
        report.results.append(
            ExternalResult(
                benchmark=str(entry["benchmark"]),
                subject=str(entry.get("subject", "")),
                metric=str(entry["metric"]),
                value=float(entry["value"]),
                model=str(entry.get("model", "")),
                dataset_revision=str(entry.get("dataset_revision", "")),
                retrieval_budget=str(entry.get("retrieval_budget", "")),
                judge=str(entry.get("judge", "")),
                source_url=str(entry.get("source_url", "")),
                reproduced_locally=bool(entry.get("reproduced_locally", False)),
                notes=str(entry.get("notes", "")),
            )
        )
    return report


def render_external(report: ExternalReport) -> str:
    """A table that cannot be mistaken for a leaderboard."""
    lines = ["External benchmark results", ""]
    if not report.results:
        lines.append("  none imported")
        lines.append("")
        lines.append("  Importing a result requires model, dataset revision, retrieval budget and judge.")
        lines.append("  Citing one additionally requires local reproduction and a source url.")
        return "\n".join(lines)

    lines.append(f"  {'benchmark':16} {'metric':22} {'value':>8}  citable")
    for result in report.results:
        lines.append(
            f"  {result.benchmark:16} {result.metric:22} {result.value:>8.4f}  "
            f"{'yes' if result.citable else 'NO'}"
        )

    unusable = report.unusable()
    if unusable:
        lines.append("")
        lines.append("  Not citable:")
        for result, reasons in unusable:
            lines.append(f"    {result.benchmark} {result.metric}: {'; '.join(reasons)}")

    unknown = report.unknown_benchmarks()
    if unknown:
        lines.append("")
        lines.append(f"  Not one of the six named benchmarks: {', '.join(unknown)}")
        lines.append("  Tracked, but not comparable against published figures for those six.")

    return "\n".join(lines)
