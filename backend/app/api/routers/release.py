"""Release readiness and Gate 9 (P6-05a; decisions D32, D33; design P6 §10).

`POST /projects/{id}/release-assessments` (member) queues the `release_readiness` stage; it needs at least one
finished execution run (409 "Run the tests first…", P6-00). The worker stores the assessment (REL-0001) and the stage
waits for G9. Reads are open to viewers. A member can record a result for a criterion the platform can't check; Gate 9
(approve, reject, override with a reason of at least 20 characters) needs `can_approve` (403 otherwise). A stale or
replaced assessment can't be decided (409). Other organisations get 404.
"""

from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app.api.deps import Ctx, CurrentPrincipal, MemberPrincipal, Principal, ScopedSession
from app.api.errors import Conflict, Forbidden, NotFound
from app.api.routers import p2common as c
from app.db.models import ReleaseAssessment, WorkflowStage
from app.domain.enums import Role, StageKey, StageStatus
from app.domain.release.criteria import RELEASE_STATEMENT, VERDICT_LABEL
from app.orchestrator.orchestrator import Orchestrator
from app.services import release as svc
from app.services import serialize_p2 as out

router = APIRouter(tags=["release-readiness"])
ASSESSING = "Assessing: reading results, defects, risks, changes and exploration…"
NO_G9 = "Deciding Gate 9 needs approval permission"


def _member(p: Principal) -> bool:
    return p.membership.role != Role.viewer


def _approver(p: Principal) -> bool:
    return _member(p) and bool(p.scope.can_approve)


async def _detail(s: Any, p: Principal, a: ReleaseAssessment) -> dict[str, Any]:
    return await svc.assessment_dict(
        s, a, see_email=out.sees_email(p.membership.role), can_assess=_member(p), can_decide=_approver(p)
    )


async def _overview(s: Any, p: Principal, project_id: uuid.UUID) -> dict[str, Any]:
    project = await c.project_of(s, project_id)
    st = (
        await s.execute(
            select(WorkflowStage)
            .where(WorkflowStage.project_id == project_id, WorkflowStage.stage_key == StageKey.release_readiness)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    reason: str | None = None
    try:
        await Orchestrator.check_release_ready(s, project)
    except Conflict as exc:
        reason = exc.message
    rows = await svc.history(s, project_id)
    people = await out.users(s, [r.decided_by for r in rows])
    assessing = st.status in (StageStatus.queued, StageStatus.running)
    see = out.sees_email(p.membership.role)
    return {
        "available": reason is None,
        "reason": reason,
        "assessing": assessing,
        "assessing_text": ASSESSING if assessing else None,
        "stage": {"status": st.status.value, "stale_reason": st.stale_reason},
        "latest": await _detail(s, p, rows[0]) if rows else None,
        "history": [svc.summary_dict(r, people, see_email=see) for r in rows],
        "statement_template": RELEASE_STATEMENT,
        "permissions": {
            "can_assess": _member(p) and reason is None and not assessing,
            "can_decide": _approver(p),
        },
    }


@router.post("/projects/{project_id}/release-assessments", status_code=202)
async def create_assessment(project_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: MemberPrincipal) -> dict[str, Any]:
    await c.project_of(s, project_id)
    await Orchestrator(ctx).request_run(p.scope, project_id, StageKey.release_readiness, parameters=None, reason=None)
    return await _overview(s, p, project_id)


@router.get("/projects/{project_id}/release-readiness")
async def readiness(project_id: uuid.UUID, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    return await _overview(s, p, project_id)


@router.get("/projects/{project_id}/release-assessments")
async def list_assessments(project_id: uuid.UUID, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    await c.project_of(s, project_id)
    rows = await svc.history(s, project_id)
    people = await out.users(s, [r.decided_by for r in rows])
    see = out.sees_email(p.membership.role)
    return {"items": [svc.summary_dict(r, people, see_email=see) for r in rows]}


@router.get("/projects/{project_id}/release-assessments/by-key/{key}")
async def get_by_key(project_id: uuid.UUID, key: str, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    await c.project_of(s, project_id)
    a = (
        await s.execute(
            select(ReleaseAssessment).where(ReleaseAssessment.project_id == project_id, ReleaseAssessment.key == key)
        )
    ).scalar_one_or_none()
    if a is None:
        raise NotFound("Release assessment not found")
    return await _detail(s, p, a)


@router.get("/release-assessments/{assessment_id}")
async def get_assessment(assessment_id: uuid.UUID, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    return await _detail(s, p, await svc.load(s, assessment_id))


class ConfirmInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["met", "not_met"] | None = None
    reason: str | None = Field(default=None, max_length=1000)


@router.post("/release-assessments/{assessment_id}/criteria/{criterion_id}/confirm")
async def confirm_criterion(
    assessment_id: uuid.UUID, criterion_id: str, body: ConfirmInput, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    a = await svc.load(s, assessment_id)
    old, new = await svc.confirm(s, a, criterion_id, p.user, status=body.status, reason=body.reason)
    await s.commit()
    await s.refresh(a)
    project = await c.project_of(s, a.project_id)
    name = p.user.full_name or "someone"
    changed = f"; recommended {VERDICT_LABEL[old]} → {VERDICT_LABEL[new]}" if old != new else ""
    await ctx.events.emit(
        org_id=project.organisation_id,
        project_id=project.id,
        type="release.criterion_confirmed",
        message=f"{a.key}: a criterion was confirmed by {name}{changed}",
        stage_key=StageKey.release_readiness.value,
        agent_key=svc.AGENT,
        data={"kind": "result", "assessment_key": a.key, "recommendation": new},
    )
    return {
        "assessment": await _detail(s, p, a),
        "message": f"Criterion confirmed. The recommendation is now {VERDICT_LABEL[new]}.",
        "verdict_changed": old != new,
    }


class DecisionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["approve", "reject", "override"]
    final_verdict: Literal["go", "conditional", "no_go"] | None = None
    reason: str | None = Field(default=None, max_length=2000)


@router.post("/release-assessments/{assessment_id}/decision")
async def decide(
    assessment_id: uuid.UUID, body: DecisionInput, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal
) -> dict[str, Any]:
    a = await svc.load(s, assessment_id)
    if not _approver(p):
        raise Forbidden(NO_G9)
    reason = svc.validate_decision(a, body.decision, body.final_verdict, body.reason)
    await svc.decide(s, a, p.user, decision=body.decision, final_verdict=body.final_verdict, reason=reason)
    await s.commit()
    await s.refresh(a)
    project = await c.project_of(s, a.project_id)
    name = p.user.full_name or "someone"
    final = VERDICT_LABEL[(a.final_verdict or a.recommendation).value]
    feed = {
        "approve": f"{a.key} decided by {name}: {final} (final)",
        "override": f"{a.key} overridden by {name}: {final}",
        "reject": f"{a.key} rejected by {name}",
    }[body.decision]
    await ctx.events.emit(
        org_id=project.organisation_id,
        project_id=project.id,
        type="release.decided",
        message=feed,
        stage_key=StageKey.release_readiness.value,
        agent_key=svc.AGENT,
        data={
            "kind": "gate",
            "gate": "G9",
            "assessment_key": a.key,
            "decision": body.decision,
            "final_verdict": a.final_verdict.value if a.final_verdict else None,
        },
    )
    return {"assessment": await _detail(s, p, a), "message": svc.decided_message(a)}
