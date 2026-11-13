"""Test strategy, risk register (P2-06) and test plan (P2-07)."""

from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app.agents.strategy.rules import SECTIONS
from app.api.deps import Ctx, CurrentPrincipal, MemberPrincipal, ScopedSession
from app.api.errors import Conflict, GateBlocked, NotFound, ValidationFailed
from app.api.pagination import clamp_limit, decode_cursor, encode_cursor
from app.api.routers import p2common as c
from app.context import AppContext
from app.db.models import GateDecision, Project, Requirement, Risk, StageRun, TestPlan, TestStrategy, risk_requirements
from app.db.types import utcnow
from app.domain.enums import (
    GateKey,
    GeneratedBy,
    PlanSource,
    Provenance,
    ReviewStatus,
    RiskCategory,
    RiskStatus,
    StageKey,
    StageStatus,
)
from app.domain.risk import requires_approval, risk_level, risk_score
from app.orchestrator.orchestrator import Orchestrator
from app.services import gates, revisions
from app.services import plan as plan_svc
from app.services import serialize_p2 as out
from app.services.adapters import RISK_SNAPSHOT, snapshot
from app.services.audit import audit
from app.services.counters import next_key

router = APIRouter(tags=["strategy"])

TestType = Literal[
    "functional",
    "smoke",
    "sanity",
    "regression",
    "exploratory",
    "usability",
    "accessibility",
    "compatibility",
    "security",
    "performance",
    "load",
    "stress",
    "spike",
    "endurance",
]
Technique = Literal[
    "equivalence_partitioning",
    "boundary_value_analysis",
    "decision_table",
    "state_transition",
    "use_case",
    "error_guessing",
    "exploratory",
]


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Mitigation(Body):
    test_types: list[TestType] = []
    techniques: list[Technique] = []
    notes: str | None = Field(None, max_length=1000)


class RiskCreate(Body):
    title: str = Field(min_length=5, max_length=160)
    description: str = Field("", max_length=2000)
    category: Literal["product", "project"] = "product"
    requirement_ids: list[uuid.UUID] = []
    feature_ids: list[uuid.UUID] = []
    likelihood: int = Field(ge=1, le=5)
    impact: int = Field(ge=1, le=5)
    likelihood_rationale: str = Field(max_length=1000)
    impact_rationale: str = Field(max_length=1000)
    mitigation: Mitigation


class RiskPatch(Body):
    version: int
    title: str | None = Field(None, min_length=5, max_length=160)
    description: str | None = Field(None, max_length=2000)
    category: Literal["product", "project"] | None = None
    requirement_ids: list[uuid.UUID] | None = None
    feature_ids: list[uuid.UUID] | None = None
    likelihood: int | None = Field(None, ge=1, le=5)
    impact: int | None = Field(None, ge=1, le=5)
    likelihood_rationale: str | None = Field(None, max_length=1000)
    impact_rationale: str | None = Field(None, max_length=1000)
    mitigation: Mitigation | None = None
    status: Literal["open", "mitigated", "accepted"] | None = None
    comment: str | None = Field(None, max_length=2000)
    change_reason: str | None = Field(None, max_length=500)


class LockBody(Body):
    version: int
    locked: bool


class StrategyPatch(Body):
    version: int
    sections: dict[str, Any]
    locked_sections: list[str] | None = None
    change_reason: str | None = Field(None, max_length=500)


class PlanPatch(Body):
    version: int
    sections: dict[str, Any]
    note: str | None = Field(None, max_length=200)


class Guidance(Body):
    guidance: str | None = Field(None, max_length=1000)


class ApplyBody(Body):
    decisions: dict[str, Literal["accept", "keep", "skip", "mark_rejected"]] = {}
    comment: str | None = Field(None, max_length=2000)


class DiscardBody(Body):
    comment: str | None = Field(None, max_length=2000)


# ---------------------------------------------------------------- strategy


async def _strategy_rows(s: ScopedSession, project_id: uuid.UUID) -> list[tuple[TestStrategy, StageRun]]:
    rows = (
        await s.execute(
            select(TestStrategy, StageRun)
            .join(StageRun, StageRun.id == TestStrategy.stage_run_id)
            .where(TestStrategy.project_id == project_id)
            .order_by(TestStrategy.version.desc(), StageRun.version.desc())
        )
    ).all()
    return [(t, r) for t, r in rows]


async def _strategy_status(s: ScopedSession, project_id: uuid.UUID, strat: TestStrategy) -> str:
    st = await c.stage(s, project_id, StageKey.test_strategy)
    if st.current_stage_run_id != strat.stage_run_id:
        approved = await gates.last_approval(s, project_id, GateKey.G4)
        return "approved" if approved and approved.stage_run_id == strat.stage_run_id else "draft"
    return {
        StageStatus.approved: "approved",
        StageStatus.awaiting_approval: "awaiting_approval",
        StageStatus.stale: "stale",
    }.get(st.status, "draft")


async def _strategy_out(s: ScopedSession, strat: TestStrategy, run: StageRun) -> dict[str, Any]:
    us = await out.users(s, [strat.updated_by])
    plan = await plan_svc.current_plan(s, strat.project_id)
    approved = await plan_svc.approved_strategy(s, strat.project_id)
    plan_status = (
        "not_started"
        if plan is None
        else "out_of_date"
        if approved is not None and plan.strategy_version < approved.version
        else "current"
    )
    return {
        "id": strat.id,
        "key": strat.key,
        "version": strat.version,
        "stage_run_version": run.version,
        "status": await _strategy_status(s, strat.project_id, strat),
        "generated_by": strat.generated_by.value,
        "sections": strat.content,
        "human_edited_sections": list(strat.human_edited_sections),
        "locked_sections": list(strat.locked_sections),
        "suggested_changes": strat.suggested_changes,
        "approved_input": strat.approved_input,
        "plan_status": plan_status,
        "validation_issues": list(strat.validation_issues or []),
        "updated_at": strat.updated_at,
        "updated_by": out.user_dict(us.get(strat.updated_by)) if strat.updated_by else None,
    }


async def _current_strategy(s: ScopedSession, project_id: uuid.UUID) -> tuple[TestStrategy, StageRun]:
    run, strat = await gates.current_strategy(s, project_id)
    if run is None or strat is None:
        raise NotFound("No test strategy yet")
    return strat, run


@router.get("/projects/{project_id}/test-strategy")
async def get_strategy(
    project_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal, version: int | None = None
) -> dict[str, Any]:
    await c.project_of(s, project_id)
    if version is None:
        strat, run = await _current_strategy(s, project_id)
    else:
        match = [(t, r) for t, r in await _strategy_rows(s, project_id) if t.version == version]
        if not match:
            raise NotFound("Strategy version not found")
        strat, run = match[0]
    return await _strategy_out(s, strat, run)


@router.get("/projects/{project_id}/test-strategy/versions")
async def strategy_versions(project_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> list[dict[str, Any]]:
    await c.project_of(s, project_id)
    approvals = {
        d.stage_run_id
        for d in (
            await s.execute(
                select(GateDecision).where(
                    GateDecision.project_id == project_id,
                    GateDecision.gate_key == GateKey.G4,
                    GateDecision.decision == "approve",
                )
            )
        ).scalars()
    }
    return [
        {
            "version": t.version,
            "stage_run_version": r.version,
            "status": await _strategy_status(s, project_id, t),
            "review_status": r.review_status.value,
            "generated_by": t.generated_by.value,
            "created_at": t.created_at,
            "approved": r.id in approvals,
        }
        for t, r in await _strategy_rows(s, project_id)
    ]


@router.patch("/projects/{project_id}/test-strategy")
async def patch_strategy(
    project_id: uuid.UUID, body: StrategyPatch, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    project = await c.project_of(s, project_id)
    strat, run = await _current_strategy(s, project_id)
    if strat.version != body.version:
        raise Conflict("The strategy was changed by someone else; reload to continue")
    unknown = sorted(set(body.sections) - set(SECTIONS))
    if unknown:
        raise ValidationFailed(
            "Unknown strategy section",
            details=[{"field": f"sections.{k}", "message": "Unknown section"} for k in unknown],
        )
    locked = [k for k in body.sections if k in strat.locked_sections]
    if locked:
        raise Conflict(f"Unlock to edit: {', '.join(locked)}")
    _validate_sections(body.sections)
    before = {k: strat.content.get(k) for k in body.sections}
    changed = {k: v for k, v in body.sections.items() if strat.content.get(k) != v}
    lock_change = body.locked_sections is not None and sorted(body.locked_sections) != sorted(strat.locked_sections)
    if not changed and not lock_change:
        return await _strategy_out(s, strat, run)
    strat.content = {**strat.content, **changed}
    strat.human_edited_sections = sorted({*strat.human_edited_sections, *changed})
    if body.locked_sections is not None:
        strat.locked_sections = sorted(set(body.locked_sections) & set(SECTIONS))
    strat.version += 1
    strat.updated_by = p.user.id
    strat.updated_at = utcnow()
    await revisions.record(
        s,
        org_id=strat.organisation_id,
        project_id=project_id,
        entity_type="test_strategy",
        entity_id=strat.id,
        lineage_id=uuid.uuid5(uuid.NAMESPACE_URL, f"strategy:{project_id}"),
        version=strat.version,
        snapshot={"sections": strat.content, "locked_sections": strat.locked_sections},
        changes=revisions.diff(before, {k: strat.content.get(k) for k in body.sections}),
        source="user",
        changed_by=p.user.id,
        change_reason=body.change_reason,
    )
    audit(
        s,
        org_id=strat.organisation_id,
        action="strategy.updated",
        target_type="test_strategy",
        target_id=strat.id,
        actor_user_id=p.user.id,
        project_id=project_id,
        metadata={"sections": sorted(changed)},
    )
    orch = (
        await c.reopen_if_approved(ctx, s, project, GateKey.G4, "the test strategy was edited", p.user.id)
        if changed
        else None
    )
    await s.commit()
    await c.after_commit(orch, p.scope, project_id)
    return await _strategy_out(s, strat, run)


def _validate_sections(sections: dict[str, Any]) -> None:
    for name in ("test_levels", "test_types"):
        if name in sections:
            rows = sections[name]
            if not isinstance(rows, list) or not all(isinstance(r, dict) and "in_scope" in r for r in rows):
                raise ValidationFailed(
                    f"Invalid {name}", details=[{"field": f"sections.{name}", "message": "Each entry needs in_scope"}]
                )
    for name in ("entry_criteria", "exit_criteria"):
        if name in sections and not isinstance(sections[name], list):
            raise ValidationFailed(
                f"Invalid {name}", details=[{"field": f"sections.{name}", "message": "Must be a list"}]
            )
    if "test_types" in sections:  # code owns the approval flag
        from app.domain.risk import APPROVAL_TEST_TYPES

        for t in sections["test_types"]:
            t["requires_approval"] = t.get("type") in APPROVAL_TEST_TYPES


@router.get("/projects/{project_id}/test-strategy/revisions")
async def strategy_revisions(project_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> list[dict[str, Any]]:
    await c.project_of(s, project_id)
    revs = await revisions.history(s, "test_strategy", uuid.uuid5(uuid.NAMESPACE_URL, f"strategy:{project_id}"))
    us = await out.users(s, [r.changed_by for r in revs])
    return [out.revision_out(r, us) for r in revs]


# ---------------------------------------------------------------- risks


@router.get("/projects/{project_id}/risks")
async def list_risks(
    project_id: uuid.UUID,
    s: ScopedSession,
    _p: CurrentPrincipal,
    level: str | None = None,
    status: str | None = None,
    requirement_id: uuid.UUID | None = None,
    uncovered: bool | None = None,
    limit: int | None = None,
    cursor: str | None = None,
) -> dict[str, Any]:
    from app.services import traceability as trace

    await c.project_of(s, project_id)
    run, _ = await gates.current_strategy(s, project_id)
    if run is None:
        return {"items": [], "next_cursor": None}
    stmt = select(Risk).where(Risk.stage_run_id == run.id)
    if level:
        stmt = stmt.where(Risk.level.in_(level.split(",")))
    if status:
        stmt = stmt.where(Risk.status.in_(status.split(",")))
    if requirement_id is not None:
        req = await c.load(s, Requirement, requirement_id, "Requirement")
        stmt = stmt.where(
            Risk.id.in_(
                select(risk_requirements.c.risk_id).where(risk_requirements.c.requirement_lineage_id == req.lineage_id)
            )
        )
    rows = list((await s.execute(stmt.order_by(Risk.score.desc(), Risk.key))).scalars())
    tr = await trace.load(s, project_id)
    cov = {r.id: trace.risk_coverage(tr, r) for r in rows}
    if uncovered is not None:
        rows = [r for r in rows if bool(cov[r.id]["uncovered_requirement_keys"]) == uncovered]
    off, lim = decode_cursor(cursor), clamp_limit(limit, 50)
    us = await out.users(s, [r.updated_by for r in rows[off : off + lim]])
    return {
        "items": [{**await out.risk_out(s, r, us), "coverage": cov[r.id]} for r in rows[off : off + lim]],
        "next_cursor": encode_cursor(off + lim) if off + lim < len(rows) else None,
    }


@router.get("/projects/{project_id}/risks/matrix")
async def risk_matrix(project_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> dict[str, Any]:
    await c.project_of(s, project_id)
    run, _ = await gates.current_strategy(s, project_id)
    rows = list((await s.execute(select(Risk).where(Risk.stage_run_id == run.id))).scalars()) if run else []
    cells = []
    for li in range(1, 6):
        for im in range(1, 6):
            keys = sorted(r.key for r in rows if r.likelihood == li and r.impact == im)
            cells.append(
                {
                    "likelihood": li,
                    "impact": im,
                    "count": len(keys),
                    "risk_keys": keys,
                    "level": risk_level(risk_score(li, im)).value,
                }
            )
    totals = {lv: sum(1 for r in rows if r.level.value == lv) for lv in ("low", "medium", "high", "very_high")}
    return {"cells": cells, "totals": totals}


async def _lineages(s: ScopedSession, project_id: uuid.UUID, ids: list[uuid.UUID]) -> list[str]:
    if not ids:
        return []
    rows = list(
        (
            await s.execute(select(Requirement).where(Requirement.project_id == project_id, Requirement.id.in_(ids)))
        ).scalars()
    )
    if len(rows) != len(set(ids)):
        raise ValidationFailed(
            "Requirement not found", details=[{"field": "requirement_ids", "message": "Unknown requirement"}]
        )
    return sorted({str(r.lineage_id) for r in rows})


async def _features(s: ScopedSession, project_id: uuid.UUID, ids: list[uuid.UUID]) -> list[str]:
    from app.db.models import ApplicationFeature

    if not ids:
        return []
    found = set(
        (
            await s.execute(
                select(ApplicationFeature.id).where(
                    ApplicationFeature.project_id == project_id, ApplicationFeature.id.in_(ids)
                )
            )
        ).scalars()
    )
    if len(found) != len(set(ids)):
        raise ValidationFailed("Feature not found", details=[{"field": "feature_ids", "message": "Unknown feature"}])
    return [str(i) for i in ids]


async def _risk_ctx(s: ScopedSession, risk_id: uuid.UUID) -> Risk:
    row: Risk = await c.load(s, Risk, risk_id, "Risk")
    await c.ensure_current(s, row, StageKey.test_strategy)
    return row


async def _risk_detail(s: ScopedSession, row: Risk) -> dict[str, Any]:
    from app.services import traceability as trace

    us = await out.users(s, [row.updated_by])
    return {**await out.risk_out(s, row, us), "coverage": trace.risk_coverage(await trace.load(s, row.project_id), row)}


async def _recompute(s: ScopedSession, project_id: uuid.UUID) -> int:
    """P3-05: risk writes recompute the derived risk/priority of current test cases (no version bump, no reopen)."""
    from app.services import testdesign as tds

    return await tds.recompute_priorities(s, project_id)


async def _priorities_event(ctx: AppContext, project: Project, count: int) -> None:
    if count:
        await Orchestrator(ctx)._emit(
            project,
            "test_cases.priorities_updated",
            f"Risk-based priority changed on {count} test case(s)",
            stage=StageKey.test_design,
            data={"kind": "result", "count": count},
        )


@router.post("/projects/{project_id}/risks", status_code=201)
async def create_risk(
    project_id: uuid.UUID, body: RiskCreate, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    from app.agents.strategy.agent import link_risk

    project = await c.project_of(s, project_id)
    strat, run = await _current_strategy(s, project_id)
    score = risk_score(body.likelihood, body.impact)
    row = Risk(
        organisation_id=project.organisation_id,
        project_id=project_id,
        stage_run_id=run.id,
        strategy_id=strat.id,
        key=(await next_key(s, project.organisation_id, project_id, "RISK"))[1],
        match_key=f"user:{uuid.uuid4()}",
        title=body.title.strip(),
        description=body.description.strip(),
        category=RiskCategory(body.category),
        likelihood=body.likelihood,
        impact=body.impact,
        score=score,
        level=risk_level(score),
        factors=[],
        likelihood_rationale=body.likelihood_rationale,
        impact_rationale=body.impact_rationale,
        mitigation=body.mitigation.model_dump(),
        requires_approval=requires_approval(list(body.mitigation.test_types)),
        status=RiskStatus.open,
        source="user",
        requirement_lineage_ids=await _lineages(s, project_id, body.requirement_ids),
        feature_ids=await _features(s, project_id, body.feature_ids),
        provenance=Provenance.assumed,
        confidence=0.4,
        generated_by=GeneratedBy.human,
        human_edited=True,
        updated_by=p.user.id,
    )
    s.add(row)
    await s.flush()
    await link_risk(s, row)
    await c.revise(
        s, entity_type="risk", row=row, fields=RISK_SNAPSHOT, before=None, user_id=p.user.id, reason="Created"
    )
    audit(
        s,
        org_id=project.organisation_id,
        action="risk.created",
        target_type="risk",
        target_id=row.id,
        actor_user_id=p.user.id,
        project_id=project_id,
        metadata={"key": row.key},
    )
    orch = await c.reopen_if_approved(ctx, s, project, GateKey.G4, f"{row.key} was added", p.user.id)
    updated = await _recompute(s, project_id)
    await s.commit()
    await c.after_commit(orch, p.scope, project_id)
    await _priorities_event(ctx, project, updated)
    return await _risk_detail(s, row)


@router.get("/risks/{risk_id}")
async def get_risk(risk_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> dict[str, Any]:
    return await _risk_detail(s, await c.load(s, Risk, risk_id, "Risk"))


@router.patch("/risks/{risk_id}")
async def patch_risk(
    risk_id: uuid.UUID, body: RiskPatch, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    from app.agents.strategy.agent import link_risk

    row = await _risk_ctx(s, risk_id)
    c.check_version(row, body.version)
    fields = body.model_dump(exclude_unset=True, exclude={"version", "change_reason", "comment", "status"})
    if fields:
        c.check_unlocked(row)
    if body.status == "accepted" and not (body.comment or "").strip():
        raise ValidationFailed(
            "A comment is required to accept a risk",
            details=[{"field": "comment", "message": "Say why the risk is accepted."}],
        )
    project = await c.project_of(s, row.project_id)
    before = snapshot(row, RISK_SNAPSHOT)
    for k in ("title", "description", "likelihood_rationale", "impact_rationale", "likelihood", "impact"):
        if fields.get(k) is not None:
            setattr(row, k, fields[k])
    if body.category is not None:
        row.category = RiskCategory(body.category)
    if body.mitigation is not None:
        row.mitigation = body.mitigation.model_dump()
    if body.requirement_ids is not None:
        row.requirement_lineage_ids = await _lineages(s, row.project_id, body.requirement_ids)
    if body.feature_ids is not None:
        row.feature_ids = await _features(s, row.project_id, body.feature_ids)
    row.score = risk_score(row.likelihood, row.impact)
    row.level = risk_level(row.score)
    row.requires_approval = requires_approval(list((row.mitigation or {}).get("test_types", [])))
    if body.status is not None:
        row.status = RiskStatus(body.status)
        row.status_comment = (body.comment or "").strip() or None
    if snapshot(row, RISK_SNAPSHOT) == before:
        return await _risk_detail(s, row)
    if fields:
        row.human_edited = True
    row.version += 1
    row.updated_by = p.user.id
    row.updated_at = utcnow()
    await link_risk(s, row)
    await c.revise(
        s,
        entity_type="risk",
        row=row,
        fields=RISK_SNAPSHOT,
        before=before,
        user_id=p.user.id,
        reason=body.change_reason or body.comment,
    )
    audit(
        s,
        org_id=row.organisation_id,
        action="risk.updated",
        target_type="risk",
        target_id=row.id,
        actor_user_id=p.user.id,
        project_id=row.project_id,
        metadata={"key": row.key, "fields": sorted(fields)},
    )
    orch = await c.reopen_if_approved(ctx, s, project, GateKey.G4, f"{row.key} was changed", p.user.id)
    updated = await _recompute(s, row.project_id)
    await s.commit()
    await c.after_commit(orch, p.scope, row.project_id)
    await _priorities_event(ctx, project, updated)
    return await _risk_detail(s, row)


@router.post("/risks/{risk_id}/lock")
async def lock_risk(risk_id: uuid.UUID, body: LockBody, s: ScopedSession, p: MemberPrincipal) -> dict[str, Any]:
    row = await _risk_ctx(s, risk_id)
    c.check_version(row, body.version)
    if row.locked != body.locked:
        before = {"locked": row.locked}
        row.locked = body.locked
        row.version += 1
        row.updated_by = p.user.id
        await c.revise(
            s,
            entity_type="risk",
            row=row,
            fields=RISK_SNAPSHOT,
            before=before,
            user_id=p.user.id,
            reason="Locked" if body.locked else "Unlocked",
        )
        await s.commit()
    return await _risk_detail(s, row)


@router.get("/risks/{risk_id}/revisions")
async def risk_revisions(risk_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> list[dict[str, Any]]:
    row = await c.load(s, Risk, risk_id, "Risk")
    revs = await revisions.history(s, "risk", row.lineage_id)
    us = await out.users(s, [r.changed_by for r in revs])
    return [out.revision_out(r, us) for r in revs]


# ---------------------------------------------------------------- test plan


async def _plan_out(s: ScopedSession, plan: TestPlan) -> dict[str, Any]:
    strat = await s.get(TestStrategy, plan.strategy_id)
    approved = await plan_svc.approved_strategy(s, plan.project_id)
    us = await out.users(s, [plan.created_by])
    return {
        "id": plan.id,
        "key": plan.key,
        "version": plan.version,
        "strategy_version": plan.strategy_version,
        "stage_run_version": await plan_svc.strategy_run_version(s, strat) if strat else None,
        "status": "out_of_date" if approved is not None and plan.strategy_version < approved.version else "current",
        "latest_approved_strategy_version": approved.version if approved else None,
        "generated_by": plan.generated_by.value,
        "source": plan.source.value,
        "sections": plan.content,
        "approvals": await plan_svc.plan_approvals(s, plan.project_id),
        "human_edited_sections": list(plan.human_edited_sections),
        "rules_template_sections": list(plan.rules_template_sections),
        "note": plan.note,
        "updated_at": plan.updated_at,
        "updated_by": out.user_dict(us.get(plan.created_by)) if plan.created_by else None,
    }


async def _plan_versions(s: ScopedSession, project_id: uuid.UUID) -> list[TestPlan]:
    return list(
        (
            await s.execute(
                select(TestPlan)
                .where(TestPlan.project_id == project_id, TestPlan.review_status != ReviewStatus.pending_review)
                .order_by(TestPlan.version.desc())
            )
        ).scalars()
    )


@router.get("/projects/{project_id}/test-plan")
async def get_plan(
    project_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal, version: int | None = None
) -> dict[str, Any]:
    await c.project_of(s, project_id)
    if version is None:
        plan = await plan_svc.current_plan(s, project_id)
    else:
        plan = (
            await s.execute(select(TestPlan).where(TestPlan.project_id == project_id, TestPlan.version == version))
        ).scalar_one_or_none()
    if plan is None:
        raise NotFound("Approve Gate 4 first" if version is None else "Plan version not found")
    return await _plan_out(s, plan)


@router.get("/projects/{project_id}/test-plan/versions")
async def plan_versions(project_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> list[dict[str, Any]]:
    await c.project_of(s, project_id)
    rows = await _plan_versions(s, project_id)
    us = await out.users(s, [r.created_by for r in rows])
    return [
        {
            "version": r.version,
            "strategy_version": r.strategy_version,
            "source": r.source.value,
            "note": r.note,
            "created_by": out.user_dict(us.get(r.created_by)) if r.created_by else None,
            "created_at": r.created_at,
            "is_current": r.is_current,
        }
        for r in rows
    ]


@router.patch("/projects/{project_id}/test-plan")
async def patch_plan(project_id: uuid.UUID, body: PlanPatch, s: ScopedSession, p: MemberPrincipal) -> dict[str, Any]:
    project = await c.project_of(s, project_id)
    cur = await plan_svc.current_plan(s, project_id)
    if cur is None:
        raise NotFound("Approve Gate 4 first")
    if cur.version != body.version:
        raise Conflict("The plan was changed by someone else; reload to continue")
    derived = [k for k in body.sections if k in plan_svc.DERIVED]
    if derived:
        raise ValidationFailed(
            "Edit this in the Test Strategy",
            details=[{"field": f"sections.{k}", "message": "Edit this in the Test Strategy"} for k in derived],
        )
    unknown = [k for k in body.sections if k not in plan_svc.PLAN_OWNED]
    if unknown:
        raise ValidationFailed(
            "Unknown plan section", details=[{"field": f"sections.{k}", "message": "Unknown section"} for k in unknown]
        )
    for row in body.sections.get("schedule") or []:
        if not isinstance(row, dict):
            raise ValidationFailed(
                "Invalid schedule", details=[{"field": "sections.schedule", "message": "Invalid entry"}]
            )
    changed = {k: v for k, v in body.sections.items() if cur.content.get(k) != v}
    if not changed:
        return await _plan_out(s, cur)
    strat = await s.get(TestStrategy, cur.strategy_id)
    assert strat is not None
    edited = sorted({*cur.human_edited_sections, *changed})
    row = await plan_svc.write_plan(
        s,
        project,
        strat,
        source=PlanSource.edited,
        content={**cur.content, **changed},
        user_id=p.user.id,
        note=body.note,
        human_edited=edited,
        generated_by=cur.generated_by,
    )
    row.strategy_version = cur.strategy_version
    audit(
        s,
        org_id=project.organisation_id,
        action="plan.updated",
        target_type="test_plan",
        target_id=row.id,
        actor_user_id=p.user.id,
        project_id=project_id,
        metadata={"version": row.version, "sections": sorted(changed)},
    )
    await s.commit()
    return await _plan_out(s, row)


@router.post("/projects/{project_id}/test-plan/regenerate", status_code=202)
async def regenerate_plan(
    project_id: uuid.UUID, body: Guidance, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    project = await c.project_of(s, project_id)
    strat = await plan_svc.approved_strategy(s, project_id)
    if strat is None:
        raise GateBlocked("Test strategy approval (G4) must be approved first")
    cur = await plan_svc.current_plan(s, project_id)
    if cur is None:
        row = await plan_svc.write_plan(
            s,
            project,
            strat,
            source=PlanSource.derived,
            content=await plan_svc.build_content(s, project, strat),
            user_id=p.user.id,
        )
        await s.commit()
        return {"candidate_version": row.version}
    pending = (
        await s.execute(
            select(TestPlan.id).where(
                TestPlan.project_id == project_id, TestPlan.review_status == ReviewStatus.pending_review
            )
        )
    ).first()
    if pending is not None:
        raise Conflict("A regenerated plan is waiting for review; apply or discard it first")
    proposed = await plan_svc.build_content(s, project, strat)
    items = plan_svc.section_items(cur, proposed)
    content = {
        **{k: v for k, v in proposed.items() if not k.startswith("_")},
        **{k: cur.content.get(k) for k in cur.human_edited_sections if k in plan_svc.PLAN_OWNED},
    }
    row = await plan_svc.write_plan(
        s,
        project,
        strat,
        source=PlanSource.regenerated,
        content=content,
        user_id=p.user.id,
        candidate=True,
        human_edited=list(cur.human_edited_sections),
        review={
            "items": items,
            "proposed": {k: v for k, v in proposed.items() if not k.startswith("_")},
            "guidance": body.guidance,
            "base_version": cur.version,
        },
    )
    await s.commit()
    return {"candidate_version": row.version}


async def _candidate(s: ScopedSession, project_id: uuid.UUID, version: int) -> TestPlan:
    await c.project_of(s, project_id)
    row = (
        await s.execute(select(TestPlan).where(TestPlan.project_id == project_id, TestPlan.version == version))
    ).scalar_one_or_none()
    if row is None or row.review is None:
        raise NotFound("No change review for this version")
    return row


@router.get("/projects/{project_id}/test-plan/changes/{version}")
async def plan_changes(
    project_id: uuid.UUID, version: int, s: ScopedSession, _p: CurrentPrincipal, include_unchanged: bool = False
) -> dict[str, Any]:
    row = await _candidate(s, project_id, version)
    items = list((row.review or {}).get("items", []))
    cur = await plan_svc.current_plan(s, project_id)
    return {
        "stage_key": "test_strategy",
        "artefact": "test_plan",
        "current_version": cur.version if cur else None,
        "candidate_version": row.version,
        "review_status": row.review_status.value,
        "guidance": (row.review or {}).get("guidance"),
        "summary": {
            k: sum(1 for i in items if i["change"] == k)
            for k in (
                "added",
                "changed",
                "protected_with_proposal",
                "no_longer_found",
                "unchanged",
                "suppressed_rejected",
            )
        },
        "items": items,
        "gate_effect": None,
    }


@router.post("/projects/{project_id}/test-plan/changes/{version}/apply")
async def apply_plan_changes(
    project_id: uuid.UUID, version: int, body: ApplyBody, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    row = await _candidate(s, project_id, version)
    if row.review_status != ReviewStatus.pending_review:
        raise Conflict("This version is not waiting for review")
    cur = await plan_svc.current_plan(s, project_id)
    proposed = (row.review or {}).get("proposed", {})
    content = dict(row.content)
    edited = set(row.human_edited_sections)
    for it in (row.review or {}).get("items", []):
        name = it["key"]
        action = body.decisions.get(name)
        action = action if action in it["allowed_actions"] else it["default_action"]
        if action == "accept":
            content[name] = proposed.get(name)
            edited.discard(name)
        elif cur is not None:
            content[name] = cur.content.get(name)
    if cur is not None:  # edits saved after the candidate was generated are kept
        for name in cur.human_edited_sections:
            if name not in body.decisions or body.decisions.get(name) != "accept":
                content[name] = cur.content.get(name)
                edited.add(name)
        cur.is_current = False
    row.content = content
    row.human_edited_sections = sorted(edited)
    row.rules_template_sections = [x for x in plan_svc.TEMPLATE_SECTIONS if x not in edited]
    row.review_status = ReviewStatus.applied
    row.is_current = True
    row.note = body.comment or row.note
    audit(
        s,
        org_id=row.organisation_id,
        action="plan.review_applied",
        target_type="test_plan",
        target_id=row.id,
        actor_user_id=p.user.id,
        project_id=project_id,
        metadata={"version": row.version},
    )
    await s.commit()
    return await _plan_out(s, row)


@router.post("/projects/{project_id}/test-plan/changes/{version}/discard")
async def discard_plan_changes(
    project_id: uuid.UUID, version: int, body: DiscardBody, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    row = await _candidate(s, project_id, version)
    if row.review_status != ReviewStatus.pending_review:
        raise Conflict("This version is not waiting for review")
    row.review_status = ReviewStatus.discarded
    row.note = body.comment
    audit(
        s,
        org_id=row.organisation_id,
        action="plan.review_discarded",
        target_type="test_plan",
        target_id=row.id,
        actor_user_id=p.user.id,
        project_id=project_id,
        metadata={"version": row.version},
    )
    await s.commit()
    cur = await plan_svc.current_plan(s, project_id)
    return await _plan_out(s, cur) if cur else {}


@router.get("/projects/{project_id}/test-plan/compare")
async def compare_plans(
    project_id: uuid.UUID,
    s: ScopedSession,
    _p: CurrentPrincipal,
    from_: int = Query(alias="from"),
    to: int = Query(),
) -> dict[str, Any]:
    await c.project_of(s, project_id)
    rows = {
        r.version: r
        for r in (
            await s.execute(
                select(TestPlan).where(TestPlan.project_id == project_id, TestPlan.version.in_([from_, to]))
            )
        ).scalars()
    }
    if from_ not in rows or to not in rows:
        raise NotFound("Plan version not found")
    a, b = rows[from_].content, rows[to].content
    return {
        "sections": [
            {"section": k, "field_diff": [{"field": k, "from": a.get(k), "to": b.get(k)}]}
            for k in (*plan_svc.PLAN_OWNED, *plan_svc.DERIVED)
            if a.get(k) != b.get(k)
        ]
    }
