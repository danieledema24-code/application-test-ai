"""Workflow definition: gate policy rules and dependency graph."""

from __future__ import annotations

from app.domain.enums import GateKey, GatePolicy, RunStatus, StageKey, StageStatus
from app.domain.stages import (
    DERIVED_STAGES,
    EXECUTION_STAGE_STATUS,
    LOCKED_GATES,
    REGENERABLE_STAGES,
    RUN_DRIVEN_STAGES,
    RUNNABLE_IN_PHASE,
    STAGES,
    SUBJECT_GATES,
    downstream_of,
    merged_policy,
    policy_violations,
)


def test_nineteen_stages_all_available_in_phase_six() -> None:
    # P5-00 added the optional accessibility and security branches; P6-00 adds change analysis and exploratory
    # testing, and release readiness becomes available.
    assert len(STAGES) == 19
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
        StageKey.automation_assessment,
        StageKey.automation,
        StageKey.execution,
        StageKey.failure_analysis,
        StageKey.defects_summary,
        StageKey.release_readiness,
        StageKey.performance,
        StageKey.accessibility,
        StageKey.security_assessment,
        StageKey.change_analysis,
        StageKey.exploratory,
    ]


def test_phase_four_stage_rules() -> None:
    # P4-00: assessment and automation run through /stages; execution and failure analysis never do.
    assert {StageKey.automation_assessment, StageKey.automation} <= RUNNABLE_IN_PHASE
    assert not ({StageKey.execution, StageKey.failure_analysis} & RUNNABLE_IN_PHASE)
    assert RUN_DRIVEN_STAGES[StageKey.execution] == "Start a test run from Test Execution"
    assert DERIVED_STAGES[StageKey.defects_summary] == StageKey.failure_analysis
    # G7 per run, G8 per defect and (P6-00) G9 per release assessment: locked to required and never decided
    # through /gates.
    assert set(SUBJECT_GATES) == {GateKey.G7, GateKey.G8, GateKey.G9} <= set(LOCKED_GATES)
    for gate in ("G7", "G8"):
        assert policy_violations({gate: "recommended"}) and policy_violations({gate: "auto"})


def test_g6_default_is_the_d10_hybrid() -> None:
    # Decision D10: static validation always blocks (P4-04); no human sign-off for rule-written scripts by default.
    assert merged_policy(None)[GateKey.G6] == GatePolicy.recommended
    assert policy_violations({"G6": "required"}) == []


def test_execution_stage_mirrors_runs() -> None:
    assert EXECUTION_STAGE_STATUS[RunStatus.failed] == StageStatus.completed
    assert EXECUTION_STAGE_STATUS[RunStatus.error] == StageStatus.failed
    assert RunStatus.awaiting_authorisation not in EXECUTION_STAGE_STATUS


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
