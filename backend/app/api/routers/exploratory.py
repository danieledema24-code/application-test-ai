"""Exploratory testing (P6-03a, decisions D29, D30): the rule-based safe explorer's sessions.

Reads are open to every member of the organisation (viewers included). Starting an anonymous session needs a member;
a signed-in session is created waiting for its `exploratory_session` approval, decided by `can_approve` with the host
typed (`POST /approvals/{id}/decision`, or `approve: true` with `confirm_text` when an approver starts it). Stop now
(`POST /quality-scans/{id}/cancel`) needs the requester or `can_approve`; withdrawing a request needs the requester.
Findings, triage, Raise defect and evidence use the shared quality-scan endpoints. `POST /stages/exploratory/run` is
refused (RUN_DRIVEN_STAGES). Other organisations get 404.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app.api.deps import Ctx, CurrentPrincipal, MemberPrincipal, Principal, ScopedSession
from app.api.errors import AppError, Conflict, Forbidden, GateBlocked
from app.api.routers import p2common as c
from app.db.models import Approval, Project, QualityScan
from app.domain.enums import QualityScanStatus, Role, StageKey
from app.domain.exploratory import limits as lim
from app.orchestrator.orchestrator import Orchestrator
from app.services import exploratory as esvc
from app.services import serialize_p2 as out

router = APIRouter(tags=["exploratory"])


def _approver(p: Principal) -> bool:
    return p.membership.role != Role.viewer and bool(p.scope.can_approve)


def _member(p: Principal) -> bool:
    return p.membership.role != Role.viewer


async def _emit(ctx: Ctx, project: Project, type_: str, message: str, data: dict[str, Any]) -> None:
    await ctx.events.emit(
        org_id=project.organisation_id,
        project_id=project.id,
        type=type_,
        message=message,
        stage_key=StageKey.exploratory.value,
        agent_key="exploratory",
        data=data,
    )


async def session_view(s: Any, p: Principal, scan: QualityScan, *, full: bool = True) -> dict[str, Any]:
    if await esvc.expire(s, scan):
        await s.commit()
    return await esvc.session_dict(
        s,
        scan,
        viewer=p.user,
        approver=_approver(p),
        member=_member(p),
        see_email=out.sees_email(p.membership.role),
        full=full,
    )


class BudgetInput(BaseModel):
    """Values are taken as sent (no coercion of "5", 1.0 or true): anything but a whole number ≥ 1 gets the design's
    422 "Enter a whole number of actions (1 or more)." from `budget_violations`."""

    model_config = ConfigDict(extra="forbid")
    actions: Any = None
    minutes: Any = None


class ExploratoryInput(BaseModel):
    """`charter`: change_set | open_defects | all | chosen (default: the latest change set's pages when one exists,
    else all discovered pages; `pages` alone means chosen)."""

    model_config = ConfigDict(extra="forbid")
    charter: str | None = Field(default=None, max_length=40)
    pages: list[uuid.UUID] | None = Field(default=None, max_length=500)
    change_set_id: uuid.UUID | None = None
    budget: BudgetInput | None = None
    signed_in: bool = False
    approve: bool = False  # an approver starting a signed-in session approves it in the same request
    confirm_text: str | None = Field(default=None, max_length=300)


async def _queued(ctx: Ctx, p: Principal, project: Project, scan: QualityScan) -> None:
    await esvc.enqueue(ctx, scan)
    await Orchestrator(ctx)._enqueue_pending(p.scope, project.id)


@router.post("/projects/{project_id}/exploratory-sessions", status_code=201)
async def start_session(
    project_id: uuid.UUID, body: ExploratoryInput, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    project = await c.project_of(s, project_id)
    if body.approve and not _approver(p):
        raise Forbidden("Approving signed-in exploration needs approval permission")
    budget = {k: v for k, v in (body.budget.model_dump() if body.budget else {}).items() if v is not None}
    scan, a = await esvc.create_session(
        ctx,
        s,
        project,
        p.user,
        charter=body.charter,
        page_ids=body.pages,
        change_set_id=body.change_set_id,
        budget=budget,
        signed_in=body.signed_in,
    )
    if body.approve and a is not None:
        try:
            await esvc.decide(ctx, s, a, p.user, decision="approve", comment=None, confirm_text=body.confirm_text)
        except AppError:
            await s.rollback()
            raise
    await s.commit()
    name = p.user.full_name or p.user.email
    if scan.status == QualityScanStatus.queued:
        await _queued(ctx, p, project, scan)
        message = f"{scan.key} requested and approved by {name}." if body.signed_in else f"{scan.key} started."
    else:
        message = f"{scan.key} requested. Someone who can approve must approve it."
    label = (scan.config or {}).get("charter_label")
    waiting = "" if scan.status == QualityScanStatus.queued else " · waiting for approval"
    await _emit(ctx, project, "quality.scan_status", f"{scan.key} requested by {name}: {label}{waiting}",
                {"kind": "status", "scan_key": scan.key, "status": scan.status.value})  # fmt: skip
    return {"message": message, **(await session_view(s, p, scan))}


@router.get("/projects/{project_id}/exploratory-sessions")
async def list_sessions(
    project_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal, limit: int = Query(default=50, ge=1, le=200)
) -> dict[str, Any]:
    """The Exploratory tab (design §9.1) and what the start dialog offers (§9.2) in one read."""
    project = await c.project_of(s, project_id)
    rows = list(
        (
            await s.execute(
                select(QualityScan)
                .where(QualityScan.project_id == project_id, QualityScan.kind == esvc.KIND)
                .order_by(QualityScan.created_at.desc())
                .limit(limit)
            )
        ).scalars()
    )
    changed = [await esvc.expire(s, x) for x in rows]
    if any(changed):
        await s.commit()
    gate: dict[str, Any] = {"ok": True, "message": None}
    try:
        await Orchestrator(ctx).check_optional_upstream(s, project, StageKey.exploratory)
    except GateBlocked:
        gate = {"ok": False, "message": "Exploration uses the pages discovery found. Approve Gate 2 first."}
    items = [await session_view(s, p, x, full=False) for x in rows]
    running = next((x.key for x in rows if x.status in esvc.ACTIVE), None)
    perf = await esvc.perf_running(s, project_id)
    return {
        "items": items,
        "gate": gate,
        "running": running,
        "running_line": f"{running} is running. One session at a time per project." if running else None,
        "waiting": [x.key for x in rows if x.status == QualityScanStatus.awaiting_approval],
        "performance_running": perf,
        "queued_note": f"{perf} is running on this project. Exploration waits until it finishes." if perf else None,
        "options": await esvc.options(ctx, s, project) if gate["ok"] else None,
        "limits": await esvc.limits(ctx, s, project.organisation_id),
        "browser_available": await ctx.browser_pool.available(),
        "statement": lim.SHORT_STATEMENT,
        "permissions": {
            "can_start": _member(p),
            "can_approve": _approver(p),
            "can_edit_limits": p.membership.role in (Role.owner, Role.admin),
        },
    }


@router.get("/quality-scans/{scan_id}/steps")
async def list_steps(
    scan_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal, outcome: str | None = None
) -> dict[str, Any]:
    """The step log (design §9.5/9.6), oldest first; `outcome` filters (comma-separated)."""
    scan = await esvc.get_session(s, scan_id)
    return {"items": await esvc.steps(s, scan, outcome=outcome)}


@router.post("/quality-scans/{scan_id}/withdraw")
async def withdraw(scan_id: uuid.UUID, s: ScopedSession, p: MemberPrincipal) -> dict[str, Any]:
    scan = await esvc.get_session(s, scan_id)
    await esvc.withdraw(s, scan, p.user)
    await s.commit()
    return {"message": f"Request withdrawn. {esvc.NOTHING_SENT}", **(await session_view(s, p, scan))}


async def stop_session(ctx: Ctx, s: Any, p: Principal, scan: QualityScan) -> dict[str, Any]:
    """`POST /quality-scans/{id}/cancel` for an exploratory session: the requester or any approver (called by the
    shared route)."""
    project = await c.project_of(s, scan.project_id)
    message = await esvc.stop(ctx, s, project, scan, p.user, approver=_approver(p))
    await s.commit()
    await _emit(ctx, project, "quality.scan_status", f"Stop requested for {scan.key} by {p.user.full_name or p.user.email}",
                {"kind": "status", "scan_key": scan.key, "status": scan.status.value})  # fmt: skip
    return {"message": message, "scan": await session_view(s, p, scan)}


async def decide_session(
    ctx: Ctx, s: Any, p: Principal, a: Approval, *, decision: str, comment: str | None, confirm_text: str | None
) -> dict[str, Any]:
    """`POST /approvals/{id}/decision` for an `exploratory_session` approval (called by the approvals route)."""
    try:
        scan = await esvc.decide(ctx, s, a, p.user, decision=decision, comment=comment, confirm_text=confirm_text)
    except Conflict:
        await s.commit()  # keep an `expired` transition
        raise
    await s.commit()
    project = await c.project_of(s, scan.project_id)
    name = p.user.full_name or p.user.email
    if scan.status == QualityScanStatus.queued:
        await _queued(ctx, p, project, scan)
        self_ = a.requested_by == p.user.id
        await _emit(ctx, project, "exploration.approved",
                    f"{scan.key} {'requested and approved' if self_ else 'approved'} by {name} (host typed)",
                    {"kind": "approval", "scan_key": scan.key})  # fmt: skip
    else:
        await _emit(ctx, project, "exploration.rejected", f"{scan.key} not approved by {name}",
                    {"kind": "approval", "scan_key": scan.key, "decision": "reject"})  # fmt: skip
    return await session_view(s, p, scan)
