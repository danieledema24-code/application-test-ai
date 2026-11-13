"""Workflow definition: gate policy rules and dependency graph."""

from __future__ import annotations

from app.domain.enums import GateKey, GatePolicy, StageKey
from app.domain.stages import LOCKED_GATES, STAGES, downstream_of, merged_policy, policy_violations


def test_fifteen_stages_phase_one_available() -> None:
    assert len(STAGES) == 15
    available = [s.key for s in STAGES if s.available]
    assert available == [StageKey.intake, StageKey.discovery, StageKey.discovery_report]


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
