"""Non-functional testing: accessibility and passive security checks (P5-02, P5-03) and load tests (P5-01b).

Reads are open to every member of the organisation (viewers included). Starting and cancelling checks, triage,
raising defects, editing profiles and requesting load tests need a member; deciding a `load_test` approval needs
`can_approve` (typed host, decision D18) and goes through `POST /approvals/{id}/decision`. Stopping a load test needs
the requester or `can_approve`. Organisation load limits need owner/admin. Other organisations get 404.
"""

from __future__ import annotations

import tempfile
import uuid
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Query
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from app.api.deps import Ctx, CurrentPrincipal, MemberPrincipal, Principal, ScopedSession
from app.api.errors import AppError, Conflict, Forbidden, NotFound
from app.api.routers import p2common as c
from app.automation.axe import load_axe
from app.automation.loadgen import LoadGenerator, LoadGeneratorError, LoadRefused
from app.db.models import (
    Approval,
    Organisation,
    PerformanceProfile,
    PerformanceRun,
    Project,
    QualityFinding,
    QualityScan,
    WorkflowStage,
)
from app.domain.enums import (
    FindingStatus,
    PerfProfileStatus,
    PerfProfileType,
    PerfRunStatus,
    QualityScanKind,
    Role,
    StageKey,
)
from app.domain.nonfunctional import accessibility as a11y
from app.domain.performance import profile as rules
from app.domain.performance.limits import DEFAULT_CEILING
from app.orchestrator.orchestrator import Orchestrator
from app.security import passive_rules as sec
from app.services import approvals as apr
from app.services import performance as psvc
from app.services import quality as qsvc
from app.services import serialize_p2 as out
from app.services.secrets import credentials_secret

router = APIRouter(tags=["non-functional"])
K6_LABEL = "Not run by the platform. Run it yourself with k6 if you use it."


def _approver(p: Principal) -> bool:
    return p.membership.role != Role.viewer and bool(p.scope.can_approve)


def _member(p: Principal) -> bool:
    return p.membership.role != Role.viewer


def _admin(p: Principal) -> bool:
    return p.membership.role in (Role.owner, Role.admin)


async def _emit(ctx: Ctx, project: Project, stage: StageKey, type_: str, message: str, data: dict[str, Any]) -> None:
    await ctx.events.emit(
        org_id=project.organisation_id,
        project_id=project.id,
        type=type_,
        message=message,
        stage_key=stage.value,
        agent_key=stage.value,
        data=data,
    )


# ------------------------------------------------------------------ overview


@router.get("/projects/{project_id}/non-functional")
async def overview(project_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    """Everything the Non-functional section needs at once: gates, tools, latest checks and load tests, limits."""
    from app.api.errors import GateBlocked

    project = await c.project_of(s, project_id)
    orch = Orchestrator(ctx)
    gates: dict[str, Any] = {}
    for key, stage in (("g2", StageKey.accessibility), ("g4", StageKey.performance)):
        try:
            await orch.check_optional_upstream(s, project, stage)
            gates[key] = True
        except GateBlocked:
            gates[key] = False
    see = out.sees_email(p.membership.role)
    latest: dict[str, Any] = {}
    for kind in QualityScanKind:
        scan = (
            await s.execute(
                select(QualityScan)
                .where(QualityScan.project_id == project_id, QualityScan.kind == kind)
                .order_by(QualityScan.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        open_n = (
            int(
                (
                    await s.execute(
                        select(func.count())
                        .select_from(QualityFinding)
                        .where(QualityFinding.scan_id == scan.id, QualityFinding.status == FindingStatus.open)
                    )
                ).scalar_one()
            )
            if scan
            else 0
        )
        latest[kind.value] = (
            {**(await qsvc.scan_dict(s, scan, see_email=see)), "open_findings": open_n} if scan else None
        )
    runs = list(
        (
            await s.execute(
                select(PerformanceRun)
                .where(PerformanceRun.project_id == project_id)
                .order_by(PerformanceRun.created_at.desc())
                .limit(50)
            )
        ).scalars()
    )
    for r in runs:
        await psvc.expire(s, r)
    await s.commit()
    last_perf = next((r for r in runs if r.status not in (PerfRunStatus.awaiting_approval,)), None)
    stages = {
        st.stage_key.value: {"status": st.status.value, "stale_reason": st.stale_reason}
        for st in (
            await s.execute(
                select(WorkflowStage).where(
                    WorkflowStage.project_id == project_id,
                    WorkflowStage.stage_key.in_(
                        [StageKey.accessibility, StageKey.security_assessment, StageKey.performance]
                    ),
                )
            )
        ).scalars()
    }
    _disc, pages = await qsvc.discovered_pages(s, project_id)
    tk = await ctx.toolkit.version()
    axe = load_axe(ctx.settings.automation_dir)
    return {
        "gates": gates,
        "stages": stages,
        "accessibility": latest["accessibility"],
        "security": latest["security"],
        "performance": {
            "latest": await psvc.run_dict(
                ctx, s, last_perf, viewer=p.user, approver=_approver(p), member=_member(p), see_email=see
            )
            if last_perf
            else None,
            "waiting": [r.key for r in runs if r.status == PerfRunStatus.awaiting_approval],
            "running": next((r.key for r in runs if r.status in psvc.ACTIVE), None),
        },
        "pages": {
            "public": sum(1 for x in pages if not x.requires_auth),
            "signed_in": sum(1 for x in pages if x.requires_auth),
        },
        "credentials_saved": await credentials_secret(s, project_id) is not None,
        "limits": await psvc.limits(ctx, s, project.organisation_id),
        "tools": {
            "axe": axe.version if axe else None,
            "loadgen": tk.loadgen if tk else None,
            "browser": await ctx.browser_pool.available(),
        },
        "statements": {
            "security": sec.STATEMENT,
            "accessibility": a11y.STATEMENT,
            "performance": psvc.LOCATION,
        },
        "permissions": {"can_start": _member(p), "can_approve": _approver(p), "can_admin_limits": _admin(p)},
    }


# ------------------------------------------------------------------ checks (P5-02, P5-03)


class A11yInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pages: list[uuid.UUID] | None = Field(default=None, max_length=500)
    viewports: list[Literal["desktop", "mobile"]] = Field(
        default_factory=lambda: list[Literal["desktop", "mobile"]](["desktop"]), min_length=1
    )
    keyboard: bool = True
    signed_in: bool = False


class SecurityInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pages: list[uuid.UUID] | None = Field(default=None, max_length=500)
    signed_in: bool = False


async def _start_check(
    ctx: Ctx, s: Any, p: Principal, project_id: uuid.UUID, kind: QualityScanKind, **kw: Any
) -> dict[str, Any]:
    project = await c.project_of(s, project_id)
    scan = await qsvc.create_scan(ctx, s, project, p.user, kind, **kw)
    await s.commit()
    await qsvc.enqueue(ctx, scan)
    await Orchestrator(ctx)._enqueue_pending(p.scope, project.id)
    name = p.user.full_name or p.user.email
    npages = len((scan.config or {}).get("pages") or [])
    await _emit(
        ctx,
        project,
        qsvc.STAGE[kind],
        "quality.scan_status",
        f"{scan.key} started by {name}: {npages} pages, {', '.join((scan.config or {}).get('viewports') or [])}",
        {"kind": "status", "scan_key": scan.key, "status": "queued"},
    )
    return await qsvc.scan_dict(s, scan, see_email=out.sees_email(p.membership.role), full=True)


@router.post("/projects/{project_id}/accessibility-scans", status_code=201)
async def start_a11y(
    project_id: uuid.UUID, body: A11yInput, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    return await _start_check(
        ctx,
        s,
        p,
        project_id,
        QualityScanKind.accessibility,
        page_ids=body.pages,
        viewports=list(dict.fromkeys(body.viewports)),
        keyboard=body.keyboard,
        signed_in=body.signed_in,
    )


@router.post("/projects/{project_id}/security-assessments", status_code=201)
async def start_security(
    project_id: uuid.UUID, body: SecurityInput, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    return await _start_check(
        ctx,
        s,
        p,
        project_id,
        QualityScanKind.security,
        page_ids=body.pages,
        viewports=["desktop"],
        keyboard=False,
        signed_in=body.signed_in,
    )


async def _list_scans(s: Any, p: Principal, project_id: uuid.UUID, kind: QualityScanKind) -> dict[str, Any]:
    await c.project_of(s, project_id)
    rows = (
        await s.execute(
            select(QualityScan)
            .where(QualityScan.project_id == project_id, QualityScan.kind == kind)
            .order_by(QualityScan.created_at.desc())
            .limit(50)
        )
    ).scalars()
    see = out.sees_email(p.membership.role)
    return {"items": [await qsvc.scan_dict(s, x, see_email=see) for x in rows]}


@router.get("/projects/{project_id}/accessibility-scans")
async def list_a11y(project_id: uuid.UUID, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    return await _list_scans(s, p, project_id, QualityScanKind.accessibility)


@router.get("/projects/{project_id}/security-assessments")
async def list_security(project_id: uuid.UUID, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    return await _list_scans(s, p, project_id, QualityScanKind.security)


async def _scan_detail(s: Any, p: Principal, scan: QualityScan) -> dict[str, Any]:
    d = await qsvc.scan_dict(s, scan, see_email=out.sees_email(p.membership.role), full=True)
    d["permissions"] = {"can_start": _member(p), "can_triage": _member(p), "can_cancel": _member(p)}
    return d


@router.get("/quality-scans/{scan_id}")
async def get_scan(scan_id: uuid.UUID, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    return await _scan_detail(s, p, await qsvc.get_scan(s, scan_id))


@router.get("/projects/{project_id}/quality-scans/by-key/{key}")
async def get_scan_by_key(project_id: uuid.UUID, key: str, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    scan = (
        await s.execute(select(QualityScan).where(QualityScan.project_id == project_id, QualityScan.key == key))
    ).scalar_one_or_none()
    if scan is None:
        raise NotFound(f"We couldn't find {key} in this project.")
    return await _scan_detail(s, p, scan)


@router.post("/quality-scans/{scan_id}/cancel")
async def cancel_scan(scan_id: uuid.UUID, s: ScopedSession, p: MemberPrincipal) -> dict[str, Any]:
    scan = await qsvc.get_scan(s, scan_id)
    message = await qsvc.cancel(s, scan, p.user)
    await s.commit()
    return {"message": message, "scan": await _scan_detail(s, p, scan)}


@router.get("/quality-scans/{scan_id}/findings")
async def list_findings(
    scan_id: uuid.UUID,
    s: ScopedSession,
    p: CurrentPrincipal,
    severity: str | None = None,
    page: str | None = None,
    rule: str | None = None,
    status: str | None = None,
) -> dict[str, Any]:
    scan = await qsvc.get_scan(s, scan_id)
    stmt = select(QualityFinding).where(QualityFinding.scan_id == scan.id)
    if severity:
        stmt = stmt.where(QualityFinding.severity.in_([x for x in severity.split(",") if x]))
    if status:
        stmt = stmt.where(QualityFinding.status.in_([x for x in status.split(",") if x]))
    if rule:
        stmt = stmt.where(QualityFinding.rule_id == rule)
    rows = list((await s.execute(stmt.order_by(QualityFinding.key))).scalars())
    if page:
        rows = [f for f in rows if a11y.path_of(f.url) == page or str(f.page_id) == page]
    users = await out.users(s, [f.status_by for f in rows if f.status_by])
    see = out.sees_email(p.membership.role)
    return {"items": [await qsvc.finding_dict(s, f, users, see_email=see, scan_key=scan.key) for f in rows]}


async def _finding(s: Any, finding_id: uuid.UUID) -> QualityFinding:
    f: QualityFinding = await c.load(s, QualityFinding, finding_id, "Finding")
    return f


@router.get("/quality-findings/{finding_id}")
async def get_finding(finding_id: uuid.UUID, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    f = await _finding(s, finding_id)
    users = await out.users(s, [f.status_by] if f.status_by else [])
    return await qsvc.finding_dict(s, f, users, see_email=out.sees_email(p.membership.role))


class TriageInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: str | None = None
    reason: str | None = Field(default=None, max_length=2000)


@router.post("/quality-findings/{finding_id}/triage")
async def triage(finding_id: uuid.UUID, body: TriageInput, s: ScopedSession, p: MemberPrincipal) -> dict[str, Any]:
    f = await _finding(s, finding_id)
    message = await qsvc.triage(s, f, p.user, status=body.status or "", reason=body.reason)
    await s.commit()
    users = await out.users(s, [f.status_by] if f.status_by else [])
    return {
        "message": message,
        "finding": await qsvc.finding_dict(s, f, users, see_email=out.sees_email(p.membership.role)),
    }


class RaiseInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    group: bool | None = None  # default: security groups the rule across pages (design open question 3)


@router.post("/quality-findings/{finding_id}/raise-defect", status_code=201)
async def raise_defect(
    finding_id: uuid.UUID, body: RaiseInput, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    f = await _finding(s, finding_id)
    project = await c.project_of(s, f.project_id)
    group = body.group if body.group is not None else f.kind == QualityScanKind.security
    d = await qsvc.raise_defect(s, project, f, p.user, group=group)
    await s.commit()
    await ctx.events.emit(
        org_id=project.organisation_id,
        project_id=project.id,
        type="defect.drafted",
        message=f"{d.key} raised by {p.user.full_name or p.user.email}: {d.summary}",
        stage_key=StageKey.defects_summary.value,
        data={"kind": "result", "defect_key": d.key},
    )
    return {"message": f"{d.key} created as a draft.", "defect": {"id": d.id, "key": d.key, "summary": d.summary}}


# ------------------------------------------------------------------ load profiles (P5-01b)


async def _profile(s: Any, profile_id: uuid.UUID) -> PerformanceProfile:
    pr: PerformanceProfile = await c.load(s, PerformanceProfile, profile_id, "Profile")
    return pr


@router.get("/projects/{project_id}/performance-profiles")
async def list_profiles(project_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    await c.project_of(s, project_id)
    rows = (
        await s.execute(
            select(PerformanceProfile)
            .where(PerformanceProfile.project_id == project_id)
            .order_by(PerformanceProfile.key)
        )
    ).scalars()
    see = out.sees_email(p.membership.role)
    return {
        "items": [await psvc.profile_dict(ctx, s, x, see_email=see) for x in rows],
        "permissions": {"can_edit": _member(p), "can_request": _member(p), "can_approve": _approver(p)},
    }


class DraftInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: PerfProfileType = PerfProfileType.load


@router.post("/projects/{project_id}/performance-profiles", status_code=201)
async def draft_profile(
    project_id: uuid.UUID, body: DraftInput, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    project = await c.project_of(s, project_id)
    pr = await psvc.draft_profile(ctx, s, project, p.user, kind=body.type)
    await s.commit()
    await _emit(
        ctx,
        project,
        StageKey.performance,
        "performance.profile_drafted",
        f"{pr.key} drafted (rules): {len(pr.targets or [])} pages, up to {rules.numbers(psvc.snapshot(pr))[0]} "
        "virtual users",
        {"kind": "result", "profile_key": pr.key},
    )
    return await psvc.profile_dict(ctx, s, pr, see_email=out.sees_email(p.membership.role))


@router.get("/projects/{project_id}/performance-profiles/eligible-pages")
async def eligible_pages(project_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> dict[str, Any]:
    project = await c.project_of(s, project_id)
    return {"items": await psvc.eligible_pages(s, project)}


@router.get("/projects/{project_id}/performance-profiles/by-key/{key}")
async def profile_by_key(
    project_id: uuid.UUID, key: str, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal, v: int | None = None
) -> dict[str, Any]:
    pr = (
        await s.execute(
            select(PerformanceProfile).where(PerformanceProfile.project_id == project_id, PerformanceProfile.key == key)
        )
    ).scalar_one_or_none()
    if pr is None:
        raise NotFound(f"We couldn't find {key} in this project.")
    return await _profile_view(ctx, s, p, pr, v)


async def _profile_view(ctx: Ctx, s: Any, p: Principal, pr: PerformanceProfile, v: int | None) -> dict[str, Any]:
    d = await psvc.profile_dict(ctx, s, pr, see_email=out.sees_email(p.membership.role))
    if v is not None and v != pr.version:
        old = await psvc.old_version(s, pr, v)
        if old is None:
            raise NotFound(f"Version {v} of {pr.key} doesn't exist")
        d.update({k: old.get(k) for k in ("name", "stages", "max_rps", "think_time_ms", "targets", "thresholds")})
        d.update({"version": v, "read_only": True, "violations": []})
    project = await c.project_of(s, pr.project_id)
    d["limits"] = await psvc.limits(ctx, s, project.organisation_id)
    d["permissions"] = {
        "can_edit": _member(p) and pr.status != PerfProfileStatus.retired,
        "can_request": _member(p),
        "can_approve": _approver(p),
        "can_admin_limits": _admin(p),
    }
    return d


@router.get("/performance-profiles/{profile_id}")
async def get_profile(
    profile_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal, v: int | None = None
) -> dict[str, Any]:
    return await _profile_view(ctx, s, p, await _profile(s, profile_id), v)


class ProfilePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int
    name: str | None = Field(default=None, min_length=1, max_length=160)
    stages: list[dict[str, int]] | None = Field(default=None, max_length=10)
    max_rps: int | None = Field(default=None, ge=1, le=1000)
    think_time_ms: dict[str, int] | None = None
    targets: list[dict[str, Any]] | None = Field(default=None, max_length=50)
    thresholds: list[dict[str, Any]] | None = Field(default=None, max_length=60)


@router.patch("/performance-profiles/{profile_id}")
async def patch_profile(
    profile_id: uuid.UUID, body: ProfilePatch, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    pr = await _profile(s, profile_id)
    data = body.model_dump(exclude={"version"}, exclude_none=True)
    if "targets" in data:
        data["targets"] = [{"path": str(t.get("path")), "weight": int(t.get("weight") or 1)} for t in data["targets"]]
    await psvc.update_profile(ctx, s, pr, p.user, data, body.version)
    await s.commit()
    d = await _profile_view(ctx, s, p, pr, None)
    d["message"] = f"{pr.key} version {pr.version} saved."
    return d


@router.post("/performance-profiles/{profile_id}/{action}")
async def profile_action(
    profile_id: uuid.UUID, action: Literal["ready", "retire"], ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    pr = await _profile(s, profile_id)
    await psvc.set_profile_status(ctx, s, pr, p.user, "ready" if action == "ready" else "retired")
    await s.commit()
    return await _profile_view(ctx, s, p, pr, None)


async def _k6(ctx: Ctx, s: Any, snap: dict[str, Any], key: str) -> Response:
    origin = snap.get("origin")
    host = snap.get("host")
    if not origin or not host:
        origin, host = await apr.target(s, snap["project_id"])
    config = rules.generator_config(
        snap, origin=str(origin), host=str(host), allow_private=ctx.settings.allow_private_targets
    )
    gen = LoadGenerator(ctx.toolkit, ctx.settings.load_hard_cap)
    with tempfile.TemporaryDirectory(prefix="k6-") as tmp:
        try:
            script = await gen.export_k6(config, Path(tmp))
        except (LoadRefused, LoadGeneratorError) as exc:
            raise Conflict(f"Couldn't export the k6 script: {exc}") from exc
    return Response(
        content=script,
        media_type="application/javascript",
        headers={"Content-Disposition": f'attachment; filename="{key}-k6.js"', "X-Not-Run-By-Platform": "true"},
    )


@router.get("/performance-profiles/{profile_id}/k6-script")
async def profile_k6(profile_id: uuid.UUID, ctx: Ctx, s: ScopedSession, _p: MemberPrincipal) -> Response:
    pr = await _profile(s, profile_id)
    snap = {**psvc.snapshot(pr), "project_id": pr.project_id}
    return await _k6(ctx, s, snap, f"{pr.key}-v{pr.version}")


# ------------------------------------------------------------------ load tests (runs)


class RunInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    profile_id: uuid.UUID
    note: str | None = Field(default=None, max_length=500)
    approve: bool = False
    confirm_text: str | None = Field(default=None, max_length=300)


async def _run(s: Any, run_id: uuid.UUID) -> PerformanceRun:
    r: PerformanceRun = await c.load(s, PerformanceRun, run_id, "Load test")
    return r


async def _run_view(ctx: Ctx, s: Any, p: Principal, run: PerformanceRun) -> dict[str, Any]:
    if await psvc.expire(s, run):
        await s.commit()
    return await psvc.run_dict(
        ctx,
        s,
        run,
        viewer=p.user,
        approver=_approver(p),
        member=_member(p),
        see_email=out.sees_email(p.membership.role),
        full=True,
    )


async def _queued(
    ctx: Ctx, p: Principal, project: Project, run: PerformanceRun, approver_name: str, self_: bool
) -> None:
    await psvc.enqueue(ctx, run)
    await Orchestrator(ctx)._enqueue_pending(p.scope, project.id)
    await _emit(
        ctx,
        project,
        StageKey.performance,
        "performance.run_approved",
        f"{run.key} {'requested and approved' if self_ else 'approved'} by {approver_name} (host typed)",
        {"kind": "approval", "run_key": run.key},
    )


@router.post("/projects/{project_id}/performance-runs", status_code=201)
async def request_run(
    project_id: uuid.UUID, body: RunInput, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    """A load test request (waiting for its `load_test` approval). An approver may approve it in the same request
    with `approve: true` and the typed host (design open question 1: approving your own request is allowed)."""
    project = await c.project_of(s, project_id)
    pr = await _profile(s, body.profile_id)
    if pr.project_id != project.id:
        raise NotFound("Profile not found")
    if body.approve and not _approver(p):
        raise Forbidden("Approving load tests needs approval permission")
    run, a = await psvc.request_run(ctx, s, project, p.user, pr, note=body.note)
    if body.approve:
        try:
            await psvc.decide(ctx, s, a, p.user, decision="approve", comment=None, confirm_text=body.confirm_text)
        except AppError:
            await s.rollback()
            raise
    await s.commit()
    name = p.user.full_name or p.user.email
    await _emit(
        ctx,
        project,
        StageKey.performance,
        "performance.run_requested",
        f"{run.key} requested by {name} · " + ("approved" if body.approve else "waiting for approval"),
        {"kind": "request", "run_key": run.key},
    )
    if run.status == PerfRunStatus.queued:
        await _queued(ctx, p, project, run, name, True)
    return await _run_view(ctx, s, p, run)


@router.get("/projects/{project_id}/performance-runs")
async def list_runs(
    project_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal, limit: int = Query(default=50, ge=1, le=200)
) -> dict[str, Any]:
    await c.project_of(s, project_id)
    runs = list(
        (
            await s.execute(
                select(PerformanceRun)
                .where(PerformanceRun.project_id == project_id)
                .order_by(PerformanceRun.created_at.desc())
                .limit(limit)
            )
        ).scalars()
    )
    changed = [await psvc.expire(s, r) for r in runs]
    if any(changed):
        await s.commit()
    see = out.sees_email(p.membership.role)
    items = [
        await psvc.run_dict(ctx, s, r, viewer=p.user, approver=_approver(p), member=_member(p), see_email=see)
        for r in runs
    ]
    return {"items": items, "permissions": {"can_request": _member(p), "can_approve": _approver(p)}}


@router.get("/performance-runs/{run_id}")
async def get_run(run_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    return await _run_view(ctx, s, p, await _run(s, run_id))


@router.get("/projects/{project_id}/performance-runs/by-key/{key}")
async def run_by_key(
    project_id: uuid.UUID, key: str, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal
) -> dict[str, Any]:
    run = (
        await s.execute(
            select(PerformanceRun).where(PerformanceRun.project_id == project_id, PerformanceRun.key == key)
        )
    ).scalar_one_or_none()
    if run is None:
        raise NotFound(f"We couldn't find {key} in this project.")
    return await _run_view(ctx, s, p, run)


@router.post("/performance-runs/{run_id}/stop")
async def stop_run(run_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: MemberPrincipal) -> dict[str, Any]:
    run = await _run(s, run_id)
    project = await c.project_of(s, run.project_id)
    message = await psvc.stop(ctx, s, project, run, p.user, approver=_approver(p))
    await s.commit()
    await Orchestrator(ctx)._enqueue_pending(p.scope, project.id)
    await _emit(
        ctx,
        project,
        StageKey.performance,
        "performance.stop_requested",
        f"Stop requested for {run.key} by {p.user.full_name or p.user.email}",
        {"kind": "status", "run_key": run.key},
    )
    return {"message": message, "run": await _run_view(ctx, s, p, run)}


@router.post("/performance-runs/{run_id}/withdraw")
async def withdraw_run(run_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: MemberPrincipal) -> dict[str, Any]:
    run = await _run(s, run_id)
    await psvc.withdraw(s, run, p.user)
    await s.commit()
    return {"message": "Request withdrawn. Nothing was sent to the site.", "run": await _run_view(ctx, s, p, run)}


@router.get("/performance-runs/{run_id}/k6-script")
async def run_k6(run_id: uuid.UUID, ctx: Ctx, s: ScopedSession, _p: MemberPrincipal) -> Response:
    run = await _run(s, run_id)
    snap = {**(run.profile_snapshot or {}), "project_id": run.project_id}
    return await _k6(ctx, s, snap, run.key)


async def decide_load_test(
    ctx: Ctx, s: Any, p: Principal, a: Approval, *, decision: str, comment: str | None, confirm_text: str | None
) -> dict[str, Any]:
    """`POST /approvals/{id}/decision` for a `load_test` approval (called by the approvals route)."""
    try:
        run = await psvc.decide(ctx, s, a, p.user, decision=decision, comment=comment, confirm_text=confirm_text)
    except Conflict:
        await s.commit()  # keep an `expired` transition
        raise
    await s.commit()
    project = await c.project_of(s, run.project_id)
    name = p.user.full_name or p.user.email
    if run.status == PerfRunStatus.queued:
        await _queued(ctx, p, project, run, name, run.requested_by == p.user.id)
    else:
        await _emit(
            ctx,
            project,
            StageKey.performance,
            "performance.run_rejected",
            f"{run.key} not approved by {name}",
            {"kind": "approval", "run_key": run.key, "decision": "reject"},
        )
    return await _run_view(ctx, s, p, run)


# ------------------------------------------------------------------ organisation load limits


@router.get("/organisations/{org_id}/settings")
async def org_settings(org_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    if org_id != p.organisation.id:
        raise NotFound("Organisation not found")
    lim = await psvc.limits(ctx, s, org_id)
    org = await s.get(Organisation, org_id)
    stored = ((org.settings if org else None) or {}).get("load_ceiling") or DEFAULT_CEILING.as_dict()
    return {
        "load_ceiling": stored,
        "effective_ceiling": lim["organisation"],
        "hard_cap": lim["server"],
        "can_edit": _admin(p),
    }


class SettingsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    load_ceiling: dict[str, int]


@router.patch("/organisations/{org_id}/settings")
async def patch_org_settings(
    org_id: uuid.UUID, body: SettingsInput, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal
) -> dict[str, Any]:
    if org_id != p.organisation.id:
        raise NotFound("Organisation not found")
    if not _admin(p):
        raise Forbidden("Only owners and admins can change load limits.")
    org = await s.get(Organisation, org_id)
    assert org is not None
    await psvc.save_ceiling(ctx, s, org, p.user, body.load_ceiling)
    await s.commit()
    d = await org_settings(org_id, ctx, s, p)
    d["message"] = "Load limits saved."
    return d
