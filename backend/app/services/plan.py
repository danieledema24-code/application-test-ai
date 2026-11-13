"""Test plan (P2-07): written from the G4-approved strategy; plan-owned sections are editable, strategy-derived
sections are copied from the approved strategy so the two documents can't disagree. The agent never sets dates."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import GateDecision, Project, Requirement, Risk, StageRun, TestPlan, TestStrategy
from app.domain.enums import GateDecisionKind, GateKey, GeneratedBy, PlanSource, RequirementStatus, ReviewStatus
from app.services import gates
from app.services.counters import next_key

PLAN_OWNED = (
    "introduction",
    "test_items",
    "suspension_criteria",
    "resumption_requirements",
    "deliverables",
    "roles",
    "schedule",
    "risks_and_contingencies",
)
DERIVED = ("scope", "approach", "environments_and_test_data", "entry_exit_criteria")
TEMPLATE_SECTIONS = ["introduction", "suspension_criteria", "resumption_requirements", "roles"]
DELIVERABLES = [
    ("Application Discovery Report", 1),
    ("Requirements Specification", 2),
    ("Test Strategy", 2),
    ("Test Plan", 2),
    ("Test Case Specification", 3),
    ("Requirements Traceability Matrix", 3),
    ("Automated test scripts", 4),
    ("Test Execution Report", 4),
    ("Defect reports", 4),
    ("Test Completion Report", 5),
]
SCHEDULE = [
    ("Requirements approved (Gate 3)", "requirements"),
    ("Test strategy approved (Gate 4)", "test_strategy"),
    ("Test cases approved (Gate 5)", "test_design"),
    ("Scripts validated (Gate 6)", "automation"),
    ("Execution authorised (Gate 7)", "execution"),
    ("Defects reviewed (Gate 8)", "defects_summary"),
]


async def approved_strategy(s: AsyncSession, project_id: uuid.UUID) -> TestStrategy | None:
    """The strategy version of the latest G4 approval."""
    d = await gates.last_approval(s, project_id, GateKey.G4)
    if d is None:
        return None
    return (
        await s.execute(select(TestStrategy).where(TestStrategy.stage_run_id == d.stage_run_id))
    ).scalar_one_or_none()


def derived_sections(strategy: TestStrategy) -> dict[str, Any]:
    c = strategy.content or {}
    return {
        "scope": {"in": c.get("scope_in", []), "out": c.get("scope_out", [])},
        "approach": {
            "test_levels": c.get("test_levels", []),
            "test_types": c.get("test_types", []),
            "techniques_by_feature": c.get("techniques_by_feature", []),
            "risk_based_approach": c.get("risk_based_approach", []),
        },
        "environments_and_test_data": {
            "environments": c.get("environments", []),
            "test_data_approach": c.get("test_data_approach", []),
        },
        "entry_exit_criteria": {"entry": c.get("entry_criteria", []), "exit": c.get("exit_criteria", [])},
    }


async def build_content(s: AsyncSession, project: Project, strategy: TestStrategy) -> dict[str, Any]:
    req_run, reqs = await gates.current_requirements(s, project.id)
    approved = [r for r in reqs if r.status == RequirementStatus.approved]
    risks = list(
        (await s.execute(select(Risk).where(Risk.stage_run_id == strategy.stage_run_id).order_by(Risk.key))).scalars()
    )
    from app.services.serialize_p2 import artefact_ref

    def req_ref(r: Requirement) -> dict[str, Any]:
        return artefact_ref(project.id, "requirement", r.id, r.key, r.title)

    from app.db.models import QaReport

    reports = {
        t.value
        for t in (await s.execute(select(QaReport.report_type).where(QaReport.project_id == project.id))).scalars()
    }
    exists = {
        "Application Discovery Report": "discovery" in reports,
        "Requirements Specification": "requirements_spec" in reports,
        "Test Strategy": True,
        "Test Plan": True,
    }
    return {
        "introduction": (
            f"This plan describes how {project.name} will be tested. It follows the approved test strategy "
            f"(version {strategy.version}) and the approved requirements, and records who does what, the "
            "deliverables and when testing stops and resumes."
        ),
        "test_items": [req_ref(r) for r in approved],
        **derived_sections(strategy),
        "suspension_criteria": [
            "The test environment is unreachable or unstable for more than one hour",
            "A blocking defect prevents more than 30% of the planned tests from running",
            "The application under test changes without a new build being announced",
        ],
        "resumption_requirements": [
            "The environment is reachable again and a smoke check passes",
            "The blocking defect is fixed and its retest passes",
        ],
        "deliverables": [
            {"name": n, "available_from_phase": ph, "exists": bool(exists.get(n, False))} for n, ph in DELIVERABLES
        ],
        "roles": [
            {"role": "QA lead", "responsibility": "Owns the plan and approves the quality gates", "assignee": None},
            {"role": "Test analyst", "responsibility": "Reviews requirements and designs test cases", "assignee": None},
            {
                "role": "Product owner",
                "responsibility": "Confirms assumed and unverified requirements",
                "assignee": None,
            },
            {"role": "Developer", "responsibility": "Fixes defects and supports test environments", "assignee": None},
        ],
        "schedule": [{"milestone": m, "after_stage": st, "target_date": None} for m, st in SCHEDULE],
        "risks_and_contingencies": [
            {
                "risk": artefact_ref(project.id, "risk", r.id, r.key, r.title),
                "contingency": "Test first and more deeply: " + ", ".join(r.mitigation.get("test_types", []))
                if r.mitigation.get("test_types")
                else "Accept and monitor",
            }
            for r in risks
            if r.level.value in ("high", "very_high")
        ],
        "_requirements_version": req_run.version if req_run else None,
    }


async def current_plan(s: AsyncSession, project_id: uuid.UUID) -> TestPlan | None:
    return (
        await s.execute(
            select(TestPlan).where(TestPlan.project_id == project_id, TestPlan.is_current.is_(True)).limit(1)
        )
    ).scalar_one_or_none()


async def _next_version(s: AsyncSession, project_id: uuid.UUID) -> int:
    return (
        int(
            (
                await s.execute(
                    select(func.coalesce(func.max(TestPlan.version), 0)).where(TestPlan.project_id == project_id)
                )
            ).scalar_one()
        )
        + 1
    )


async def write_plan(
    s: AsyncSession,
    project: Project,
    strategy: TestStrategy,
    *,
    source: PlanSource,
    content: dict[str, Any],
    user_id: uuid.UUID | None,
    note: str | None = None,
    candidate: bool = False,
    human_edited: list[str] | None = None,
    generated_by: GeneratedBy = GeneratedBy.rules,
    review: dict[str, Any] | None = None,
) -> TestPlan:
    prev = await current_plan(s, project.id)
    edited_sections = list(human_edited or (prev.human_edited_sections if prev else []))
    key = prev.key if prev else (await next_key(s, project.organisation_id, project.id, "TP"))[1]
    if not candidate:
        await s.execute(update(TestPlan).where(TestPlan.project_id == project.id).values(is_current=False))
    row = TestPlan(
        organisation_id=project.organisation_id,
        project_id=project.id,
        strategy_id=strategy.id,
        stage_run_id=strategy.stage_run_id,
        key=key,
        version=await _next_version(s, project.id),
        strategy_version=strategy.version,
        source=source,
        review_status=ReviewStatus.pending_review if candidate else ReviewStatus.not_required,
        is_current=not candidate,
        generated_by=generated_by,
        content={k: v for k, v in content.items() if not k.startswith("_")},
        human_edited_sections=edited_sections,
        rules_template_sections=[x for x in TEMPLATE_SECTIONS if x not in edited_sections],
        review=review,
        note=note,
        created_by=user_id,
    )
    s.add(row)
    await s.flush()
    return row


async def ensure_plan_after_g4(s: AsyncSession, project: Project) -> TestPlan | None:
    """First G4 approval writes plan v1. Later approvals leave the plan as is (it shows as out of date)."""
    if await current_plan(s, project.id) is not None:
        return None
    strategy = await approved_strategy(s, project.id)
    if strategy is None:
        return None
    content = await build_content(s, project, strategy)
    return await write_plan(s, project, strategy, source=PlanSource.derived, content=content, user_id=None)


def section_items(cur: TestPlan, proposed: dict[str, Any]) -> list[dict[str, Any]]:
    items = []
    for name in (*PLAN_OWNED, *DERIVED):
        a, b = cur.content.get(name), proposed.get(name)
        if a == b:
            continue
        protected = name in cur.human_edited_sections and name in PLAN_OWNED
        items.append(
            {
                "lineage_id": name,
                "key": name,
                "type": "plan_section",
                "change": "protected_with_proposal" if protected else "changed",
                "protected_reason": "human_edited" if protected else None,
                "current": {name: a},
                "proposed": {name: b},
                "field_diff": [{"field": name, "from": a, "to": b}],
                "default_action": "keep" if protected else "accept",
                "allowed_actions": ["accept"] if name in DERIVED else ["accept", "keep"],
                "note": "From the approved Test Strategy" if name in DERIVED else None,
            }
        )
    return items


async def plan_approvals(s: AsyncSession, project_id: uuid.UUID) -> list[dict[str, Any]]:
    from app.services.serialize_p2 import user_dict, users

    out = []
    for g in (GateKey.G3, GateKey.G4):
        d = (
            await s.execute(
                select(GateDecision)
                .where(GateDecision.project_id == project_id, GateDecision.gate_key == g)
                .order_by(GateDecision.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        us = await users(s, [d.decided_by] if d else [])
        out.append(
            {
                "gate": g.value,
                "status": ("approved" if d.decision == GateDecisionKind.approve else d.decision.value)
                if d
                else "pending",
                "decided_by": user_dict(us.get(d.decided_by)) if d and d.decided_by else None,
                "decided_at": d.created_at if d else None,
            }
        )
    return out


async def strategy_run_version(s: AsyncSession, strategy: TestStrategy) -> int:
    run = await s.get(StageRun, strategy.stage_run_id)
    return run.version if run else 0
