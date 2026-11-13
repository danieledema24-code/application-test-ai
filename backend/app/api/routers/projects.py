from __future__ import annotations

import uuid

from fastapi import APIRouter, Query, Request, Response
from sqlalchemy import func, select

from app.api.deps import Ctx, CurrentPrincipal, MemberPrincipal, ScopedSession, client_ip
from app.api.errors import Conflict, NotFound, ValidationFailed
from app.api.pagination import clamp_limit, decode_cursor, encode_cursor
from app.db.models import Project, WorkflowStage
from app.db.types import utcnow
from app.domain.enums import ProjectStatus, StageStatus
from app.domain.stages import policy_violations
from app.schemas import api
from app.services import projects as svc
from app.services import serialize as ser
from app.services.audit import audit

router = APIRouter(prefix="/projects", tags=["projects"])


async def load_project(s: ScopedSession, project_id: uuid.UUID) -> Project:
    p = (await s.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    if p is None:
        raise NotFound("Project not found")
    return p


@router.post("/url-check", response_model=api.UrlCheckResult)
async def url_check(body: api.UrlCheckRequest, ctx: Ctx, p: CurrentPrincipal, s: ScopedSession) -> api.UrlCheckResult:
    return await svc.url_check(ctx, s, p, body.url)


@router.post("", response_model=api.ProjectDetail, status_code=201)
async def create_project(
    body: api.ProjectCreate, request: Request, ctx: Ctx, p: MemberPrincipal, s: ScopedSession
) -> api.ProjectDetail:
    project_id = await svc.create_project(ctx, p, body, client_ip(request))
    return await ser.project_detail(s, await load_project(s, project_id))


@router.get("", response_model=api.Page[api.ProjectSummary])
async def list_projects(
    s: ScopedSession,
    _p: CurrentPrincipal,
    status: str | None = Query(None, pattern="^(active|archived|paused|running|awaiting_approval|all)$"),
    q: str | None = Query(None, max_length=200),
    limit: int | None = Query(None, ge=1, le=100),
    cursor: str | None = None,
) -> api.Page[api.ProjectSummary]:
    lim = clamp_limit(limit)
    off = decode_cursor(cursor)
    stmt = select(Project).where(*svc.list_filter(status or "active"))
    if q:
        stmt = stmt.where(func.lower(Project.name).contains(q.lower()))
    rows = list(
        (await s.execute(stmt.order_by(Project.updated_at.desc(), Project.id).offset(off).limit(lim + 1)))
        .scalars()
        .all()
    )
    items = [await ser.project_summary(s, r) for r in rows[:lim]]
    return api.Page[api.ProjectSummary](items=items, next_cursor=encode_cursor(off + lim) if len(rows) > lim else None)


@router.get("/{project_id}", response_model=api.ProjectDetail)
async def get_project(project_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> api.ProjectDetail:
    return await ser.project_detail(s, await load_project(s, project_id))


@router.patch("/{project_id}", response_model=api.ProjectDetail)
async def patch_project(
    project_id: uuid.UUID, body: api.ProjectPatch, request: Request, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> api.ProjectDetail:
    project = await load_project(s, project_id)
    if body.version != project.version:
        raise Conflict(
            "This project was changed by someone else; reload and try again",
            details=[{"field": "version", "message": f"Current version is {project.version}"}],
        )
    changes: dict[str, object] = {}
    if body.approval_policy is not None:
        issues = policy_violations(body.approval_policy)
        if issues:
            raise ValidationFailed(
                "Approval policy is not allowed", details=[{"field": "approval_policy", "message": m} for m in issues]
            )
        project.approval_policy = {**(project.approval_policy or {}), **body.approval_policy}
        changes["approval_policy"] = body.approval_policy
    if body.settings is not None:
        cap = int((p.organisation.limits or {}).get("max_pages_cap", ctx.settings.scan_max_pages_cap))
        if body.settings.max_pages > cap:
            raise ValidationFailed(
                f"Maximum pages is {cap}", details=[{"field": "settings.max_pages", "message": f"Enter 1–{cap}."}]
            )
        project.settings = {**(project.settings or {}), **body.settings.model_dump()}
        changes["settings"] = body.settings.model_dump()
    if body.name is not None:
        project.name = body.name.strip()
        changes["name"] = project.name
    if body.description is not None:
        project.description = body.description
        changes["description"] = True
    project.updated_at = utcnow()
    audit(
        s,
        org_id=project.organisation_id,
        action="project.updated",
        target_type="project",
        target_id=project.id,
        actor_user_id=p.user.id,
        project_id=project.id,
        ip=client_ip(request),
        metadata=changes,
    )
    await s.commit()
    return await ser.project_detail(s, project)


async def _set_archived(
    s: ScopedSession, project_id: uuid.UUID, p: MemberPrincipal, request: Request, archived: bool
) -> None:
    project = await load_project(s, project_id)
    if archived:
        busy = (
            await s.execute(
                select(WorkflowStage.id).where(
                    WorkflowStage.project_id == project.id,
                    WorkflowStage.status.in_([StageStatus.queued, StageStatus.running]),
                )
            )
        ).first()
        if busy is not None:
            raise Conflict("Pause or cancel the running analysis before archiving the project")
        project.archived_at = utcnow()
        project.status = ProjectStatus.archived
    else:
        project.archived_at = None
        project.status = ProjectStatus.active
    project.updated_at = utcnow()
    audit(
        s,
        org_id=project.organisation_id,
        action="project.archived" if archived else "project.unarchived",
        target_type="project",
        target_id=project.id,
        actor_user_id=p.user.id,
        project_id=project.id,
        ip=client_ip(request),
    )
    await s.commit()


@router.post("/{project_id}/archive", status_code=204)
async def archive(project_id: uuid.UUID, request: Request, s: ScopedSession, p: MemberPrincipal) -> Response:
    await _set_archived(s, project_id, p, request, True)
    return Response(status_code=204)


@router.post("/{project_id}/unarchive", status_code=204)
async def unarchive(project_id: uuid.UUID, request: Request, s: ScopedSession, p: MemberPrincipal) -> Response:
    await _set_archived(s, project_id, p, request, False)
    return Response(status_code=204)
