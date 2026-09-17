"""Tests for the external-results importer.

The behaviour under test is refusal. A module that will happily print a competitor's
headline number next to ours is the failure mode the specification warns about, so
each missing provenance field must be independently disqualifying.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from veritymem_evals.external import (
    ExternalReport,
    ExternalResult,
    KNOWN_BENCHMARKS,
    load_external_results,
    render_external,
)


def complete(**overrides: object) -> ExternalResult:
    base = dict(
        benchmark="LongMemEval",
        subject="some-system",
        metric="accuracy",
        value=0.71,
        model="gpt-x",
        dataset_revision="2026-01",
        retrieval_budget="top-10",
        judge="human",
        source_url="https://example.invalid/paper",
        reproduced_locally=True,
    )
    base.update(overrides)
    return ExternalResult(**base)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "field_name",
    ["model", "dataset_revision", "retrieval_budget", "judge"],
)
def test_each_missing_comparability_field_disqualifies_the_result(field_name: str) -> None:
    result = complete(**{field_name: ""})
    assert result.comparable is False
    assert field_name in result.missing_for_comparability

    report = ExternalReport(results=[result])
    assert report.usable() == []
    (_, reasons) = report.unusable()[0]
    assert any(field_name in reason for reason in reasons)


def test_a_result_not_reproduced_locally_cannot_be_cited() -> None:
    """The spec requires reproducing before citing, so this is stricter than comparable."""
    result = complete(reproduced_locally=False)
    assert result.comparable is True
    assert result.citable is False
    assert ExternalReport(results=[result]).usable() == []


def test_a_result_without_a_source_url_cannot_be_cited() -> None:
    result = complete(source_url="")
    assert result.citable is False


def test_a_fully_provenanced_reproduced_result_is_usable() -> None:
    result = complete()
    assert result.citable is True
    assert ExternalReport(results=[result]).usable() == [result]


def test_unknown_benchmarks_are_reported_not_silently_accepted() -> None:
    report = ExternalReport(results=[complete(benchmark="MyInternalSuite")])
    assert report.unknown_benchmarks() == ["MyInternalSuite"]
    assert "MyInternalSuite" not in KNOWN_BENCHMARKS


def test_the_rendering_marks_unusable_rows_and_explains_why() -> None:
    report = ExternalReport(results=[complete(model=""), complete(benchmark="LoCoMo")])
    text = render_external(report)
    assert "Not citable:" in text
    assert "missing model" in text
    assert "yes" in text  # the complete row is usable


def test_loading_rejects_an_entry_without_a_metric(tmp_path: Path) -> None:
    path = tmp_path / "results.json"
    path.write_text(json.dumps({"results": [{"benchmark": "LoCoMo", "value": 1.0}]}), encoding="utf-8")
    with pytest.raises(ValueError, match="metric"):
        load_external_results(path)


def test_loading_accepts_a_bare_list_and_a_wrapped_object(tmp_path: Path) -> None:
    entry = {
        "benchmark": "LoCoMo",
        "metric": "recall@10",
        "value": 0.5,
        "model": "m",
        "dataset_revision": "r",
        "retrieval_budget": "b",
        "judge": "human",
        "source_url": "https://example.invalid",
        "reproduced_locally": True,
    }
    bare = tmp_path / "bare.json"
    bare.write_text(json.dumps([entry]), encoding="utf-8")
    wrapped = tmp_path / "wrapped.json"
    wrapped.write_text(json.dumps({"results": [entry]}), encoding="utf-8")

    assert load_external_results(bare).usable()[0].metric == "recall@10"
    assert load_external_results(wrapped).usable()[0].metric == "recall@10"


def test_an_empty_report_says_what_importing_requires() -> None:
    text = render_external(ExternalReport())
    assert "none imported" in text
    assert "retrieval budget" in text
