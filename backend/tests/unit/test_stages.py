"""Workflow definition: gate policy rules and dependency graph."""

from __future__ import annotations

from app.domain.enums import GateKey, GatePolicy, StageKey
from app.domain.stages import (
    DERIVED_STAGES,
    LOCKED_GATES,
    REGENERABLE_STAGES,
    RUNNABLE_IN_PHASE,
    STAGES,
    downstream_of,
    merged_policy,
    policy_violations,
)


def test_fifteen_stages_phase_three_available() -> None:
    assert len(STAGES) == 15
    available = [s.key for s in STAGES if s.available]
    assert available == [
        StageKey.intake,
        StageKey.discovery,
        StageKey.discovery_report,
        StageKey.requirements,
        StageKey.readiness_criteria,
        StageKey.test_strategy,
        StageKey.test_design,
        StageKey.traceability,
    ]


def test_g5_is_required_by_default_but_not_locked() -> None:
    # Decision D1: G5 is a required sign-off, but a project may still relax it through approval_policy.
    assert merged_policy(None)[GateKey.G5] == GatePolicy.required
    assert GateKey.G5 not in LOCKED_GATES
    assert policy_violations({"G5": "recommended"}) == []
    assert merged_policy({"G5": "auto"})[GateKey.G5] == GatePolicy.auto


def test_test_design_is_runnable_and_regenerable_traceability_is_derived() -> None:
    assert StageKey.test_design in RUNNABLE_IN_PHASE and StageKey.test_design in REGENERABLE_STAGES
    assert StageKey.traceability not in RUNNABLE_IN_PHASE
    assert DERIVED_STAGES[StageKey.traceability] == StageKey.test_design


def test_locked_gates_cannot_be_relaxed() -> None:
    assert {GateKey.G1, GateKey.G7, GateKey.G8, GateKey.G9} <= set(LOCKED_GATES)
    assert policy_violations({"G1": "auto"})
    assert policy_violations({"G7": "recommended"})
    assert policy_violations({"G2": "auto"}) == []
    assert policy_violations({"G99": "auto"}) and policy_violations({"G2": "sometimes"})
    merged = merged_policy({"G1": "auto", "G2": "required"})
    assert merged[GateKey.G1] == GatePolicy.required and merged[GateKey.G2] == GatePolicy.required


def test_default_g2_policy_is_recommended() -> None:
    assert merged_policy(None)[GateKey.G2] == GatePolicy.recommended


def test_downstream_of_discovery_includes_report() -> None:
    down = downstream_of(StageKey.discovery)
    assert StageKey.discovery_report in down and StageKey.intake not in down
