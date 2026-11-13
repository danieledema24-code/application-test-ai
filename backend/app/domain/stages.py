"""Stage registry (architecture.md §4) and gate policy rules."""

from __future__ import annotations

from dataclasses import dataclass

from app.domain.enums import GateKey, GatePolicy, StageKey, StageStatus

CURRENT_PHASE = 2


@dataclass(frozen=True)
class StageDef:
    key: StageKey
    title: str
    phase: int
    gate: GateKey | None
    upstream: tuple[StageKey, ...]
    agent_key: str | None

    @property
    def available(self) -> bool:
        return self.phase <= CURRENT_PHASE


STAGES: tuple[StageDef, ...] = (
    StageDef(StageKey.intake, "URL validation and project creation", 1, GateKey.G1, (), "orchestrator"),
    StageDef(StageKey.discovery, "Application discovery", 1, GateKey.G2, (StageKey.intake,), "discovery"),
    StageDef(StageKey.discovery_report, "Application Discovery Report", 1, None, (StageKey.discovery,), "reporting"),
    StageDef(StageKey.requirements, "Provisional requirements", 2, GateKey.G3, (StageKey.discovery,), "requirements"),
    StageDef(
        StageKey.readiness_criteria, "Definition of Ready and Done", 2, None, (StageKey.requirements,), "requirements"
    ),
    StageDef(
        StageKey.test_strategy, "Test strategy and test plan", 2, GateKey.G4, (StageKey.requirements,), "strategy"
    ),
    StageDef(
        StageKey.test_design, "Test conditions and test cases", 3, GateKey.G5, (StageKey.test_strategy,), "design"
    ),
    StageDef(StageKey.traceability, "Traceability matrix", 3, None, (StageKey.test_design,), None),
    StageDef(StageKey.automation_assessment, "Automation suitability", 4, None, (StageKey.test_design,), "design"),
    StageDef(
        StageKey.automation, "Automated test scripts", 4, GateKey.G6, (StageKey.automation_assessment,), "automation"
    ),
    StageDef(StageKey.execution, "Test execution", 4, GateKey.G7, (StageKey.automation,), "execution"),
    StageDef(StageKey.failure_analysis, "Failure analysis", 4, None, (StageKey.execution,), "defects"),
    StageDef(
        StageKey.defects_summary,
        "Defect reports and QA summary",
        4,
        GateKey.G8,
        (StageKey.failure_analysis,),
        "defects",
    ),
    StageDef(
        StageKey.release_readiness,
        "Release readiness assessment",
        6,
        GateKey.G9,
        (StageKey.defects_summary,),
        "reporting",
    ),
    StageDef(StageKey.performance, "Performance testing", 5, None, (StageKey.test_strategy,), "performance"),
)
STAGE_BY_KEY: dict[StageKey, StageDef] = {s.key: s for s in STAGES}
STAGE_ORDER: dict[StageKey, int] = {s.key: i for i, s in enumerate(STAGES)}
GATE_STAGE: dict[GateKey, StageKey] = {s.gate: s.key for s in STAGES if s.gate is not None}

GATE_TITLES: dict[GateKey, str] = {
    GateKey.G1: "URL validation and authorisation",
    GateKey.G2: "Discovery completeness",
    GateKey.G3: "Requirements review",
    GateKey.G4: "Test strategy approval",
    GateKey.G5: "Test case quality",
    GateKey.G6: "Script validation",
    GateKey.G7: "Execution authorisation",
    GateKey.G8: "Defect review",
    GateKey.G9: "Release readiness",
}

DEFAULT_APPROVAL_POLICY: dict[GateKey, GatePolicy] = {
    GateKey.G1: GatePolicy.required,
    GateKey.G2: GatePolicy.recommended,
    GateKey.G3: GatePolicy.required,
    GateKey.G4: GatePolicy.required,
    GateKey.G5: GatePolicy.recommended,
    GateKey.G6: GatePolicy.required,
    GateKey.G7: GatePolicy.required,
    GateKey.G8: GatePolicy.required,
    GateKey.G9: GatePolicy.required,
}
# Gates that can never be relaxed below "required" (architecture.md §4 quality gates).
LOCKED_GATES: tuple[GateKey, ...] = (GateKey.G1, GateKey.G7, GateKey.G8, GateKey.G9)

# Stage statuses meaning "this stage has a usable output version".
OUTPUT_STATUSES = frozenset(
    {StageStatus.completed, StageStatus.awaiting_approval, StageStatus.approved, StageStatus.cancelled}
)
ACTIVE_STATUSES = frozenset({StageStatus.queued, StageStatus.running})

# Phase 2 stages whose re-runs produce a candidate version that is reviewed before it is applied (P2-00).
REGENERABLE_STAGES = frozenset({StageKey.requirements, StageKey.readiness_criteria, StageKey.test_strategy})
# Stages queued again automatically when their upstream produces a new version ("auto_rerun").
AUTO_RERUN_STAGES = frozenset({StageKey.discovery_report})
# Stages a user can start with POST /stages/{stage}/run in the current phase.
RUNNABLE_IN_PHASE = frozenset(
    {
        StageKey.discovery,
        StageKey.discovery_report,
        StageKey.requirements,
        StageKey.readiness_criteria,
        StageKey.test_strategy,
    }
)


def downstream_of(stage: StageKey) -> list[StageKey]:
    """All stages that (transitively) depend on `stage`, in canonical order."""
    found: set[StageKey] = set()
    changed = True
    while changed:
        changed = False
        for s in STAGES:
            if s.key not in found and any(u == stage or u in found for u in s.upstream):
                found.add(s.key)
                changed = True
    return [s.key for s in STAGES if s.key in found]


def merged_policy(raw: dict[str, str] | None) -> dict[GateKey, GatePolicy]:
    policy = dict(DEFAULT_APPROVAL_POLICY)
    for k, v in (raw or {}).items():
        if k in GateKey.__members__ and v in GatePolicy.__members__:
            policy[GateKey(k)] = GatePolicy(v)
    for g in LOCKED_GATES:
        policy[g] = GatePolicy.required
    return policy


def policy_violations(requested: dict[str, str]) -> list[str]:
    """Returns a message per gate that may not be set to the requested value."""
    issues: list[str] = []
    for k, v in requested.items():
        if k not in GateKey.__members__:
            issues.append(f"Unknown gate {k}")
        elif v not in GatePolicy.__members__:
            issues.append(f"Unknown policy {v!r} for {k}")
        elif GateKey(k) in LOCKED_GATES and v != GatePolicy.required:
            issues.append(f"{k} ({GATE_TITLES[GateKey(k)]}) is locked to 'required' and cannot be relaxed")
    return issues
