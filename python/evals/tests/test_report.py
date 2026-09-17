"""Tests for the reporting logic, over synthetic input.

The assertions that matter here are the refusals: an unimplemented stage is not a
zero, an unmeasured target is not omitted, and a run without provenance is not
citable. Those are the ways an evaluation report lies, and each is asserted directly.
"""

from __future__ import annotations

from veritymem_evals.models import BenchmarkRun, RunManifest, StageResult, TargetResult
from veritymem_evals.report import (
    EXPECTED_STAGES,
    V01_TARGETS,
    load_run,
    render_text,
    stage_table,
    summarise,
    target_table,
)


def manifest(**overrides: object) -> RunManifest:
    base = dict(
        run_id="run-1",
        suite="ledgerbench",
        seed=1,
        dataset_version="ledgerbench-2026.09.1",
        fixture_version="1.0.0",
        code_version="contracts@1",
        policy_version="commit-v3",
        gate_backend="lexical-overlap@1",
        gate_model_sha256=None,
        embedding_backend="hash",
        embedding_model_id="hash-ngram-v1-1024",
        started_at="2026-09-17T12:00:00.000Z",
        duration_ms=1234.5,
    )
    base.update(overrides)
    return RunManifest(**base)  # type: ignore[arg-type]


def test_unimplemented_stage_is_not_reported_as_zero() -> None:
    """A stage that did not run must be labelled, never scored."""
    stages = [
        StageResult(stage="Commit", metrics={"unsafe_auto_accept_rate": 0.0}, failure_isolated="policy", cases=10),
        StageResult(
            stage="Retrieval",
            metrics={},
            failure_isolated="search and authorization",
            cases=0,
            status="not_implemented",
        ),
    ]
    rows = stage_table(stages)
    retrieval = next(row for row in rows if row["stage"] == "Retrieval")
    assert retrieval["status"] == "not_implemented"
    assert retrieval["metrics"] == {}
    assert "not measured" in str(retrieval["note"])


def test_every_expected_stage_appears_even_when_absent() -> None:
    """A missing stage is a visible gap, not a silently shorter table."""
    rows = stage_table([StageResult(stage="Commit", metrics={"x": 1.0}, failure_isolated="f", cases=1)])
    assert [row["stage"] for row in rows] == list(EXPECTED_STAGES)
    missing = [row for row in rows if row["status"] == "missing"]
    assert len(missing) == len(EXPECTED_STAGES) - 1


def test_unmeasured_target_fails_with_a_reason_rather_than_being_omitted() -> None:
    run = BenchmarkRun(manifest=manifest(), targets=[
        TargetResult(name="review_burden", target="under 2%", observed=0.01, passes=True),
    ])
    rows = target_table(run)
    assert len(rows) == len(V01_TARGETS)
    review = next(row for row in rows if row["name"] == "review_burden")
    assert review["passes"] is True
    red_team = next(row for row in rows if row["name"] == "cross_tenant_retrievals")
    assert red_team["measured"] is False
    assert red_team["passes"] is False
    assert "not measured" in str(red_team["note"])


def test_release_readiness_requires_every_target_and_every_stage() -> None:
    complete_stages = [
        StageResult(stage=name, metrics={"m": 1.0}, failure_isolated="f", cases=1) for name in EXPECTED_STAGES
    ]
    all_targets = [
        TargetResult(name=name, target=description, observed=1.0, passes=True)
        for name, description in V01_TARGETS
    ]
    run = BenchmarkRun(manifest=manifest(), stages=complete_stages, targets=all_targets)
    report = summarise(run)
    summary = report["summary"]
    assert isinstance(summary, dict)
    assert summary["release_ready"] is True

    # Drop one target: no longer release ready, and the gap is named.
    partial = BenchmarkRun(manifest=manifest(), stages=complete_stages, targets=all_targets[:-1])
    partial_summary = summarise(partial)["summary"]
    assert isinstance(partial_summary, dict)
    assert partial_summary["release_ready"] is False
    assert partial_summary["targets_passing"] == len(V01_TARGETS) - 1


def test_a_run_without_provenance_is_flagged_not_citable() -> None:
    run = BenchmarkRun(manifest=manifest(dataset_version="", code_version=""))
    report = summarise(run)
    assert report["citable"] is False
    problems = report["citability_problems"]
    assert isinstance(problems, list)
    assert any("dataset_version" in problem for problem in problems)
    assert any("code_version" in problem for problem in problems)


def test_an_onnx_gate_without_a_model_hash_is_not_citable() -> None:
    """A gate whose model cannot be named cannot be reproduced."""
    run = BenchmarkRun(manifest=manifest(gate_backend="onnx-deberta-v3-mnli", gate_model_sha256=None))
    assert run.citability_problems
    assert any("model hash" in problem for problem in run.citability_problems)


def test_the_rendered_report_states_its_caveats() -> None:
    run = BenchmarkRun(manifest=manifest(), stages=[], targets=[])
    text = render_text(summarise(run))
    assert "Caveats" in text
    assert "external red team" in text
    assert "NOT CITABLE" not in text  # this run's manifest is complete


def test_load_run_rejects_a_payload_with_no_manifest() -> None:
    """A run without provenance is not a result, so it is rejected rather than defaulted."""
    try:
        load_run({"stages": []})
    except ValueError as error:
        assert "manifest" in str(error)
    else:  # pragma: no cover
        raise AssertionError("expected a payload without a manifest to be rejected")


def test_load_run_round_trips_a_complete_payload() -> None:
    payload = {
        "manifest": {
            "run_id": "r",
            "suite": "ledgerbench",
            "seed": 7,
            "dataset_version": "d",
            "fixture_version": "f",
            "code_version": "c",
            "policy_version": "p",
            "gate_backend": "lexical-overlap@1",
            "gate_model_sha256": None,
            "embedding_backend": "hash",
            "embedding_model_id": "m",
            "started_at": "2026-09-17T12:00:00.000Z",
            "duration_ms": 10.0,
            "gate": "on",
        },
        "stages": [{"stage": "Commit", "metrics": {"a": 1}, "failure_isolated": "f", "cases": 3}],
        "targets": [{"name": "review_burden", "target": "t", "observed": 0.01, "passes": True}],
    }
    run = load_run(payload)
    assert run.manifest.seed == 7
    assert run.stages[0].metrics == {"a": 1.0}
    assert run.targets[0].passes is True
