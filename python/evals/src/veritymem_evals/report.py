"""Turn a raw run into the published report.

Three rules shape this module, and each exists because of a specific way evaluation
reporting goes wrong:

  * An unimplemented stage is reported as unimplemented, never as zero. A zero is
    indistinguishable from a real failure, and it quietly becomes a number someone
    quotes.
  * A target that was not measured is `passes: false` with a stated reason, not
    omitted. Omitting it makes a partial run look complete.
  * A run whose manifest is incomplete is flagged as not citable, at the top of the
    report. The specification requires dataset version, prompts, model versions,
    seeds and costs with every number.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Iterable, Sequence
from pathlib import Path

from .models import BenchmarkRun, StageResult, TargetResult

# The eleven stages from the specification's metric table, in order. Declared here so
# a missing stage is visible as a gap rather than simply absent from a table.
EXPECTED_STAGES: tuple[str, ...] = (
    "Admission",
    "Extraction",
    "Attribution",
    "Commit",
    "Conflict",
    "Retrieval",
    "Composition",
    "Abstention",
    "Action gate",
    "Forgetting",
    "Replay",
)

# The v0.1 exit targets, verbatim from the specification. Held here rather than in
# the run so that a run cannot quietly redefine the bar it is measured against.
#
# The names are the ones the runner publishes under `published_targets`, and the
# runner now emits one name per specification bullet rather than one per runnable
# check: "at most one extraction model call per event; zero on default reads" is two
# properties and is published as two targets, because a single name would let one of
# them pass while the other went unmeasured. Any name here that the run does not
# publish is rendered as not measured and not passing, so adding a name is safe and
# removing one would hide a target.
V01_TARGETS: tuple[tuple[str, str], ...] = (
    ("evidence_coverage", "100% of returned claims carry at least one resolvable evidence reference"),
    ("cross_tenant_retrievals", "0 cross-tenant or revoked-grant retrievals, measured by an external red team"),
    ("unsupported_auto_commit", "Under 1% unsupported-claim auto-commit on LedgerBench"),
    ("contradiction_detection", "At least 95% contradiction detection on templated and human-authored updates"),
    ("gold_evidence_recall_at_10", "At least 90% gold-evidence recall@10 with under 2% stale-current leakage"),
    ("selective_repair", "At least 95% selective repair: the targeted claim is removed and benign claims survive"),
    ("deterministic_projection", "Deterministic projection equality for identical ledger, code, model hash and policy"),
    ("p95_query_ms", "p95 non-LLM query under 250 ms at one million accepted claims on a reference machine"),
    ("extraction_model_calls_per_event", "At most one extraction model call per unstructured event"),
    ("read_path_model_calls", "Zero model calls on default reads"),
    ("action_safety", "Measured action gate: no unsafe allows and unnecessary blocks within the agreed threshold"),
    ("review_burden", "Review burden under 2% of writes on the reference workload"),
    ("human_audit_set", "At least 500 stratified, double-labelled candidate, decision and query traces"),
    ("external_isolation", "0 cross-tenant or revoked-grant retrievals, measured by an independent red team"),
    ("external_user_workload", "One external user completes the published reference workload"),
)


def stage_table(stages: Sequence[StageResult]) -> list[dict[str, object]]:
    """One row per expected stage, including the ones the run did not report."""
    # Matched case- and separator-insensitively. The runner publishes the
    # specification's capitalisation ("Action gate") while its internal id is a
    # slug ("action_gate"); matching exactly would render every stage as missing,
    # which reads as a catastrophic run rather than a naming mismatch.
    def normalise(value: str) -> str:
        return value.strip().lower().replace("_", " ").replace("-", " ")

    by_name = {normalise(stage.stage): stage for stage in stages}
    rows: list[dict[str, object]] = []
    for name in EXPECTED_STAGES:
        stage = by_name.get(normalise(name))
        if stage is None:
            rows.append(
                {
                    "stage": name,
                    "status": "missing",
                    "failure_isolated": "",
                    "cases": 0,
                    "metrics": {},
                    "note": "the run reported no result for this stage",
                }
            )
            continue
        rows.append(
            {
                "stage": name,
                "status": stage.status,
                "failure_isolated": stage.failure_isolated,
                "cases": stage.cases,
                "metrics": dict(sorted(stage.metrics.items())),
                "note": "" if stage.measured else "not measured by this build",
            }
        )
    return rows


def target_table(run: BenchmarkRun) -> list[dict[str, object]]:
    """Every v0.1 target, with unmeasured ones shown as failures carrying a reason."""
    observed = {target.name: target for target in run.targets}
    rows: list[dict[str, object]] = []
    for name, description in V01_TARGETS:
        target = observed.get(name)
        if target is None:
            rows.append(
                {
                    "name": name,
                    "target": description,
                    "observed": None,
                    "passes": False,
                    "measured": False,
                    "note": "not measured by this run; treated as not passing",
                }
            )
            continue
        rows.append(
            {
                "name": name,
                "target": description,
                "observed": target.observed,
                "passes": target.passes,
                "measured": True,
                "note": target.note,
            }
        )
    return rows


def summarise(run: BenchmarkRun) -> dict[str, object]:
    """The report, as a JSON-serialisable dict."""
    stages = stage_table(run.stages)
    targets = target_table(run)
    measured_targets = [row for row in targets if row["measured"]]
    passing = [row for row in measured_targets if row["passes"]]
    unmeasured_stages = [row["stage"] for row in stages if row["status"] != "measured"]

    return {
        "run": {
            "run_id": run.manifest.run_id,
            "suite": run.manifest.suite,
            "seed": run.manifest.seed,
            "gate": run.manifest.gate,
            "started_at": run.manifest.started_at,
            "duration_ms": run.manifest.duration_ms,
        },
        # Stated before any number, because a reader who skims the table will not
        # scroll back up for a caveat.
        "citable": not run.citability_problems,
        "citability_problems": run.citability_problems,
        "provenance": {
            "dataset_version": run.manifest.dataset_version,
            "fixture_version": run.manifest.fixture_version,
            "code_version": run.manifest.code_version,
            "policy_version": run.manifest.policy_version,
            "gate_backend": run.manifest.gate_backend,
            "gate_model_sha256": run.manifest.gate_model_sha256,
            "embedding_backend": run.manifest.embedding_backend,
            "embedding_model_id": run.manifest.embedding_model_id,
        },
        "stages": stages,
        "targets": targets,
        "unmeasured": list(run.unmeasured),
        "summary": {
            "stages_measured": len(EXPECTED_STAGES) - len(unmeasured_stages),
            "stages_unmeasured": unmeasured_stages,
            "targets_measured": len(measured_targets),
            "targets_passing": len(passing),
            "targets_total": len(V01_TARGETS),
            "release_ready": len(passing) == len(V01_TARGETS) and not unmeasured_stages,
        },
        # Echoed so the report cannot be read as a claim about the world beyond what
        # was actually run.
        "caveats": [
            "This report describes one run against one deployment. It is not a claim about any other system.",
            "Unmeasured targets are reported as failures rather than omitted, so a partial run cannot look complete.",
            "Cross-tenant isolation requires an external red team; an in-house fixture run is not evidence for that target.",
        ],
    }


def render_text(report: dict[str, object]) -> str:
    """A human-readable rendering, because the first reader is a person."""
    lines: list[str] = []
    run = report["run"]
    assert isinstance(run, dict)
    lines.append(f"VerityMem evaluation — {run['suite']} run {run['run_id']}")
    lines.append(f"  seed {run['seed']} · gate {run['gate']} · {run['duration_ms']} ms")

    if not report["citable"]:
        lines.append("")
        lines.append("  NOT CITABLE:")
        for problem in report["citability_problems"]:  # type: ignore[union-attr]
            lines.append(f"    - {problem}")

    lines.append("")
    lines.append("  Provenance")
    provenance = report["provenance"]
    assert isinstance(provenance, dict)
    for key, value in provenance.items():
        lines.append(f"    {key:24} {value}")

    lines.append("")
    lines.append("  Stages")
    for row in report["stages"]:  # type: ignore[union-attr]
        assert isinstance(row, dict)
        status = row["status"]
        marker = "ok " if status == "measured" else "-- "
        metrics = row["metrics"]
        rendered = " ".join(f"{k}={v}" for k, v in metrics.items()) if isinstance(metrics, dict) else ""
        lines.append(f"    {marker}{row['stage']:14} {status:16} {rendered}")
        if row["note"]:
            lines.append(f"        note: {row['note']}")

    lines.append("")
    lines.append("  v0.1 exit targets")
    for row in report["targets"]:  # type: ignore[union-attr]
        assert isinstance(row, dict)
        marker = "PASS" if row["passes"] else "----"
        observed = row["observed"] if row["observed"] is not None else "not measured"
        lines.append(f"    {marker} {row['name']:32} observed={observed}")
        if row["note"]:
            lines.append(f"         {row['note']}")

    summary = report["summary"]
    assert isinstance(summary, dict)
    lines.append("")
    lines.append(
        f"  {summary['targets_passing']}/{summary['targets_total']} targets passing · "
        f"{summary['stages_measured']}/{len(EXPECTED_STAGES)} stages measured · "
        f"release_ready={summary['release_ready']}"
    )
    if summary["stages_unmeasured"]:
        lines.append(f"  unmeasured stages: {', '.join(summary['stages_unmeasured'])}")  # type: ignore[arg-type]

    lines.append("")
    lines.append("  Caveats")
    for caveat in report["caveats"]:  # type: ignore[union-attr]
        lines.append(f"    - {caveat}")
    return "\n".join(lines)


def load_run(payload: dict[str, object]) -> BenchmarkRun:
    """Build a run from the JSON the TypeScript runner emits."""
    from .models import RunManifest

    manifest_raw = payload.get("manifest")
    if not isinstance(manifest_raw, dict):
        raise ValueError("run payload has no `manifest`; a run without provenance is not a result")
    manifest = RunManifest(
        run_id=str(manifest_raw.get("run_id", "")),
        suite=str(manifest_raw.get("suite", "")),
        seed=int(manifest_raw.get("seed", 0)),
        dataset_version=str(manifest_raw.get("dataset_version", "")),
        fixture_version=str(manifest_raw.get("fixture_version", "")),
        code_version=str(manifest_raw.get("code_version", "")),
        policy_version=str(manifest_raw.get("policy_version", "")),
        gate_backend=str(manifest_raw.get("gate_backend", "")),
        gate_model_sha256=manifest_raw.get("gate_model_sha256"),  # type: ignore[arg-type]
        embedding_backend=str(manifest_raw.get("embedding_backend", "")),
        embedding_model_id=str(manifest_raw.get("embedding_model_id", "")),
        started_at=str(manifest_raw.get("started_at", "")),
        duration_ms=float(manifest_raw.get("duration_ms", 0)),
        gate=str(manifest_raw.get("gate", "on")),
    )

    stages: list[StageResult] = []
    for raw in payload.get("stages", []) or []:  # type: ignore[union-attr]
        assert isinstance(raw, dict)
        stages.append(
            StageResult(
                stage=str(raw.get("stage", "")),
                metrics={str(k): float(v) for k, v in (raw.get("metrics") or {}).items()},  # type: ignore[union-attr]
                failure_isolated=str(raw.get("failure_isolated", "")),
                cases=int(raw.get("cases", 0)),
                status=str(raw.get("status", "measured")),
            )
        )

    # Two arrangements for the targets, and the file's own shape decides which it is.
    # The runner publishes a flat `published_targets` list for exactly this consumer
    # and keeps the richer `targets.checks` for callers that need the stage each
    # target is measured through. Deciding by presence rather than by filename means
    # a future rename cannot silently produce a report with no targets in it.
    targets_raw = payload.get("published_targets")
    if targets_raw is None:
        nested = payload.get("targets")
        if isinstance(nested, dict):
            targets_raw = nested.get("checks") or nested.get("published") or []
        else:
            targets_raw = nested or []

    targets: list[TargetResult] = []
    for raw in targets_raw:  # type: ignore[union-attr]
        assert isinstance(raw, dict)
        targets.append(
            TargetResult(
                name=str(raw.get("name", "")),
                target=str(raw.get("target", "")),
                observed=raw.get("observed"),
                passes=bool(raw.get("passes", False)),
                note=str(raw.get("note", "")),
            )
        )

    unmeasured = [str(item) for item in (payload.get("unmeasured") or [])]  # type: ignore[union-attr]
    return BenchmarkRun(manifest=manifest, stages=stages, targets=targets, unmeasured=unmeasured)


def main(argv: Sequence[str] | None = None) -> int:
    """Read a run JSON file, print the report, optionally write it as JSON."""
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        print("usage: veritymem-eval-report <run.json> [--json <out.json>]", file=sys.stderr)
        return 2

    source = Path(args[0])
    payload = json.loads(source.read_text(encoding="utf-8"))
    report = summarise(load_run(payload))
    print(render_text(report))

    if "--json" in args:
        index = args.index("--json")
        destination = Path(args[index + 1]) if index + 1 < len(args) else Path("report.json")
        destination.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"\nwrote {destination}")

    return 0 if report["citable"] else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
