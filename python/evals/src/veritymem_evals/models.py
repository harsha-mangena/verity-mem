"""The shapes this harness reads and writes.

Typed with dataclasses rather than dictionaries because every field here ends up in
a published number, and a typo in a dict key produces a report with a silently
missing metric — the failure mode that makes a benchmark worse than none.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class StageResult:
    """One of the eleven evaluation stages."""

    stage: str
    metrics: dict[str, float]
    failure_isolated: str
    cases: int
    # A stage that is not implemented yet reports `not_implemented` rather than a
    # fabricated zero. A benchmark that quietly reports 0% for an unimplemented
    # stage is worse than no benchmark, because the zero is indistinguishable from
    # a real failure.
    status: str = "measured"

    @property
    def measured(self) -> bool:
        return self.status == "measured"


@dataclass(frozen=True)
class TargetResult:
    """One v0.1 exit target, as declared by the specification."""

    name: str
    target: str
    observed: Any
    passes: bool
    note: str = ""


@dataclass(frozen=True)
class RunManifest:
    """Provenance for a run.

    The specification requires that raw traces, dataset version, prompts, model
    versions, seeds and costs are published with every number. A number without this
    manifest is not a result, it is an anecdote.
    """

    run_id: str
    suite: str
    seed: int
    dataset_version: str
    fixture_version: str
    code_version: str
    policy_version: str
    gate_backend: str
    gate_model_sha256: str | None
    embedding_backend: str
    embedding_model_id: str
    started_at: str
    duration_ms: float
    gate: str = "on"
    # True when pinned production model assets are present on the machine that produced
    # the artifact. Recorded beside the backend name because "there is no production
    # verifier here" and "there is one and this run did not use it" are different claims,
    # and only the second is a configuration mistake worth escalating.
    gate_production_verifier_available: bool = False
    code_commit: str | None = None
    code_worktree_dirty: bool | None = None
    gate_backend_kind: str = "lexical"

    def missing_fields(self) -> list[str]:
        """Fields a reader needs and cannot infer. Empty means the manifest is citable."""
        required = {
            "run_id": self.run_id,
            "suite": self.suite,
            "dataset_version": self.dataset_version,
            "code_version": self.code_version,
            "policy_version": self.policy_version,
            "gate_backend": self.gate_backend,
            "started_at": self.started_at,
        }
        return [name for name, value in required.items() if not value]


@dataclass(frozen=True)
class BenchmarkRun:
    """A complete run: what was executed, what it produced, and where it came from."""

    manifest: RunManifest
    stages: list[StageResult] = field(default_factory=list)
    targets: list[TargetResult] = field(default_factory=list)
    # Anything the run could not measure, carried through to the report so a gap is
    # visible at the top level rather than only in the stage table.
    unmeasured: list[str] = field(default_factory=list)

    @property
    def citability_problems(self) -> list[str]:
        """Reasons this run must not be published as-is."""
        problems: list[str] = []
        missing = self.manifest.missing_fields()
        if missing:
            problems.append(f"run manifest is missing: {', '.join(missing)}")
        if self.manifest.gate_model_sha256 is None and self.manifest.gate_backend.startswith("onnx"):
            problems.append("an ONNX gate backend must record the model hash it ran")
        if self.manifest.gate_production_verifier_available and self.manifest.gate_backend_kind == "lexical":
            problems.append(
                "this run scored the lexical stand-in while production model assets are present: "
                "the numbers describe the stand-in, not the intended verifier"
            )
        return problems
