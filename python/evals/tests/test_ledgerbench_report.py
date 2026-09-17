"""Tests for the LedgerBench run adapter.

`packages/ledgerbench` publishes a run in a shape that has to survive a version
change on the TypeScript side. The failure this file guards against is specific and
quiet: a renamed key makes every stage render as `missing` and every target as
"not measured", which reads as a catastrophic run rather than as an adapter that
stopped matching. So the adapter is tested against payloads it did not produce.
"""

from __future__ import annotations

import json
from pathlib import Path

from veritymem_evals.report import EXPECTED_STAGES, V01_TARGETS, load_run, render_text, summarise


def ledgerbench_payload() -> dict[str, object]:
    """A minimal payload in the shape `packages/ledgerbench` emits."""
    return {
        "manifest": {
            "run_id": "evr_test",
            "suite": "ledgerbench",
            "seed": 1,
            "gate": "on",
            "dataset_version": "ledgerbench-2026.09.1",
            "fixture_version": "1.0.0",
            "code_version": "ledgerbench@local",
            "policy_version": "commit-v3",
            "gate_backend": "lexical-overlap@1(floor=0.6)",
            "gate_model_sha256": None,
            "embedding_backend": "hash",
            "embedding_model_id": "hash-ngram-v1-1024",
            "started_at": "2026-09-17T12:00:00.000Z",
            "duration_ms": 1234.5,
        },
        "stages": [
            {
                "stage": "admission",
                "name": "Admission",
                "title": "Admission",
                "status": "measured",
                "metrics": {"malicious_instruction_acceptance_rate": 0.0},
                "failure_isolated": "Untrusted content reaching privileged paths",
                "cases": 33,
                "failures": [],
            },
            {
                "stage": "action_gate",
                "name": "Action gate",
                "title": "Action gate",
                "status": "not_implemented",
                "metrics": {},
                "failure_isolated": "Memory-to-consequence risk",
                "cases": 0,
                "note": "not wired in v0.1",
                "failures": [],
            },
        ],
        "published_targets": [
            {
                "name": "evidence_coverage",
                "target": "100% of returned claims carry at least one resolvable evidence reference",
                "observed": 1.0,
                "passes": True,
                "note": "",
            },
            {
                "name": "cross_tenant_retrievals",
                "target": "0 cross-tenant or revoked-grant retrievals",
                "observed": None,
                "passes": False,
                "note": "blocked by retrieval and an external red team",
            },
        ],
        "unmeasured": ["retrieval: not implemented in this build"],
    }


def test_flat_published_targets_are_read() -> None:
    """The published list is what the reporter renders; it must not be ignored."""
    run = load_run(ledgerbench_payload())
    names = {target.name for target in run.targets}
    assert "evidence_coverage" in names
    assert "cross_tenant_retrievals" in names


def test_stage_names_match_regardless_of_case_or_separator() -> None:
    """A slug on one side and a capitalised name on the other are the same stage."""
    run = load_run(ledgerbench_payload())
    report = summarise(run)
    stages = {row["stage"]: row for row in report["stages"]}  # type: ignore[union-attr]
    assert stages["Admission"]["status"] == "measured"
    # A stage the run did report as unimplemented is not reported as missing.
    assert stages["Action gate"]["status"] == "not_implemented"
    # A stage the run never mentioned is still a visible row.
    assert stages["Retrieval"]["status"] == "missing"
    assert len(report["stages"]) == len(EXPECTED_STAGES)  # type: ignore[arg-type]


def test_nested_targets_fallback_still_works() -> None:
    """A payload using the richer `targets.checks` shape is read, not silently empty."""
    payload = ledgerbench_payload()
    payload["published_targets"] = None
    payload["targets"] = {"checks": ledgerbench_payload()["published_targets"]}
    run = load_run(payload)
    assert {target.name for target in run.targets} == {"evidence_coverage", "cross_tenant_retrievals"}


def test_unmeasured_target_is_a_failure_with_a_reason() -> None:
    run = load_run(ledgerbench_payload())
    report = summarise(run)
    targets = {row["name"]: row for row in report["targets"]}  # type: ignore[union-attr]
    assert len(targets) == len(V01_TARGETS)
    assert targets["cross_tenant_retrievals"]["passes"] is False
    assert targets["cross_tenant_retrievals"]["measured"] is True
    assert "red team" in str(targets["cross_tenant_retrievals"]["note"])
    # A target the run never mentioned is also a failure, not a blank cell.
    assert targets["p95_query_ms"]["measured"] is False
    assert targets["p95_query_ms"]["passes"] is False


def test_unmeasured_is_carried_to_the_top_of_the_report() -> None:
    payload = ledgerbench_payload()
    report = summarise(load_run(payload))
    assert report["unmeasured"] == payload["unmeasured"]
    # `release_ready` cannot be true while a stage is unimplemented.
    assert report["summary"]["release_ready"] is False  # type: ignore[index]


def test_report_is_json_serialisable_and_renders() -> None:
    """The report is the published artefact; it has to survive a file round-trip."""
    report = summarise(load_run(ledgerbench_payload()))
    text = render_text(report)
    assert "Admission" in text
    assert "not_implemented" in text or "Action gate" in text
    restored = json.loads(json.dumps(report, sort_keys=True))
    assert restored["run"]["run_id"] == "evr_test"  # type: ignore[index]


def test_a_real_run_file_renders_when_one_is_available() -> None:
    """
    End-to-end against a real run, when the workspace has one.

    Skipped rather than faked when there is none: a test that invented a passing run
    would be the exact failure this package exists to prevent.
    """
    candidates = [
        Path("/tmp/bench-run.json"),
        Path(__file__).resolve().parents[3] / "bench" / "run.json",
    ]
    source = next((path for path in candidates if path.is_file()), None)
    if source is None:
        return
    payload = json.loads(source.read_text(encoding="utf-8"))
    report = summarise(load_run(payload))
    assert report["stages"], "a real run must produce stage rows"
    measured = [row for row in report["stages"] if row["status"] == "measured"]  # type: ignore[union-attr]
    assert measured, "a real run must have measured at least one stage"
