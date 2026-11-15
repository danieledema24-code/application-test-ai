"""Phase 5 hardening endpoints (P5-05b/c): audit log and export, retention, project archive rights and deletion
scheduling. Owners and admins read the audit log and set retention; only the owner schedules a permanent deletion
(design open question 4). Deletion itself is scheduled 24 hours ahead and can be cancelled until then.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import Ctx, CurrentPrincipal, Principal, ScopedSession, client_ip
from app.api.errors import Conflict, Forbidden, NotFound, ValidationFailed
from app.api.pagination import decode_cursor, encode_cursor
from app.db.models import Organisation, Project
from app.db.types import utcnow
from app.domain.enums import Role
from app.services import hardening as hsvc
from app.services.audit import audit

router = APIRouter(tags=["hardening"])
PAGE = 50
Since = Annotated[datetime | None, Query(alias="from")]
Until = Annotated[datetime | None, Query(alias="to")]


def _admin(p: Principal) -> bool:
    return p.membership.role in (Role.owner, Role.admin)


def _org(org_id: uuid.UUID, p: Principal, what: str) -> None:
    if org_id != p.organisation.id:
        raise NotFound("Organisation not found")
    if not _admin(p):
        raise Forbidden(f"Only owners and admins can see {what}.")


# ------------------------------------------------------------------ audit log


@router.get("/organisations/{org_id}/audit-log")
async def audit_log(
    org_id: uuid.UUID,
    s: ScopedSession,
    p: CurrentPrincipal,
    actor: uuid.UUID | None = None,
    group: str | None = Query(None, max_length=60),
    action: str | None = Query(None, max_length=64),
    project: uuid.UUID | None = None,
    since: Since = None,
    until: Until = None,
    cursor: str | None = None,
    limit: int = Query(PAGE, ge=1, le=100),
) -> dict[str, Any]:
    _org(org_id, p, "the audit log")
    q = hsvc.audit_query(org_id, actor=actor, group=group, action=action, project=project, since=since, until=until)
    total = await hsvc.count(s, q)
    offset = decode_cursor(cursor)
    from app.db.models import AuditLog

    rows = list((await s.execute(q.order_by(AuditLog.created_at.desc()).offset(offset).limit(limit))).scalars())
    return {
        "items": await hsvc.rows_out(s, rows, see_email=True),
        "total": total,
        "next_cursor": encode_cursor(offset + limit) if offset + limit < total else None,
        "groups": list(hsvc.ACTION_GROUPS),
        "export_limit": hsvc.EXPORT_LIMIT,
    }


@router.get("/organisations/{org_id}/audit-log/export")
async def export_audit_log(
    org_id: uuid.UUID,
    request: Request,
    s: ScopedSession,
    p: CurrentPrincipal,
    format: Literal["csv", "json"] = "csv",
    actor: uuid.UUID | None = None,
    group: str | None = Query(None, max_length=60),
    action: str | None = Query(None, max_length=64),
    project: uuid.UUID | None = None,
    since: Since = None,
    until: Until = None,
) -> Response:
    """The filtered set as CSV or JSON. The export itself is recorded in the audit log."""
    _org(org_id, p, "the audit log")
    q = hsvc.audit_query(org_id, actor=actor, group=group, action=action, project=project, since=since, until=until)
    total = await hsvc.count(s, q)
    if total > hsvc.EXPORT_LIMIT:
        raise ValidationFailed("Exports are limited to 100,000 entries. Narrow the dates.")
    from app.db.models import AuditLog

    rows = list((await s.execute(q.order_by(AuditLog.created_at.desc()))).scalars())
    data = hsvc.export_bytes(await hsvc.rows_out(s, rows, see_email=True), format)
    audit(
        s,
        org_id=org_id,
        action="audit_log.exported",
        target_type="organisation",
        target_id=org_id,
        actor_user_id=p.user.id,
        ip=client_ip(request),
        metadata={"entries": total, "format": format},
    )
    await s.commit()
    name = f"audit-log-{utcnow():%Y-%m-%d}.{format}"
    return Response(
        content=data,
        media_type="application/json" if format == "json" else "text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{name}"', "X-Entries": str(total)},
    )


# ------------------------------------------------------------------ retention


class RetentionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    videos_traces_days: int = Field(ge=0, le=36500)
    screenshots_days: int = Field(ge=0, le=36500)
    timeseries_days: int = Field(ge=0, le=36500)


async def _retention_view(s: ScopedSession, p: Principal) -> dict[str, Any]:
    org = await s.get(Organisation, p.organisation.id)
    assert org is not None
    days, saved = hsvc.retention_of(org)
    return {**days, "saved": saved, "can_edit": _admin(p)}


@router.get("/organisations/{org_id}/retention")
async def get_retention(org_id: uuid.UUID, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    _org(org_id, p, "retention")
    return await _retention_view(s, p)


@router.put("/organisations/{org_id}/retention")
async def put_retention(
    org_id: uuid.UUID, body: RetentionInput, request: Request, s: ScopedSession, p: CurrentPrincipal
) -> dict[str, Any]:
    _org(org_id, p, "retention")
    org = await s.get(Organisation, org_id)
    assert org is not None
    before, saved = hsvc.retention_of(org)
    new = body.model_dump()
    org.settings = {**(org.settings or {}), "retention": new}
    changes = hsvc.retention_changes(before, new)
    if changes or not saved:  # the first save records the policy even when it keeps the suggested numbers
        audit(
            s,
            org_id=org_id,
            action="retention.changed",
            target_type="organisation",
            target_id=org_id,
            actor_user_id=p.user.id,
            ip=client_ip(request),
            metadata={"from": before, "to": new, "changes": changes or "policy saved: " + hsvc.retention_text(new)},
        )
    await s.commit()
    return {**await _retention_view(s, p), "message": "Retention saved."}


@router.post("/organisations/{org_id}/retention/apply")
async def run_retention(org_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    """Runs the clean-up now (the daily job does the same)."""
    _org(org_id, p, "retention")
    n = await hsvc.apply_retention(ctx, org_id, actor=p.user.id)
    return {"removed": n, "message": f"{n} file{'' if n == 1 else 's'} removed."}


# ------------------------------------------------------------------ permanent deletion (scheduled)


class PurgeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirm_name: str = Field(max_length=200)


async def _project(s: ScopedSession, project_id: uuid.UUID) -> Project:
    from app.api.routers.projects import load_project

    return await load_project(s, project_id)


def _purge_view(project: Project) -> dict[str, Any]:
    return {
        "purge_scheduled_at": project.purge_scheduled_at,
        "archived": project.archived_at is not None,
    }


@router.post("/projects/{project_id}/purge")
async def schedule_purge(
    project_id: uuid.UUID, body: PurgeInput, request: Request, s: ScopedSession, p: CurrentPrincipal
) -> dict[str, Any]:
    project = await _project(s, project_id)
    if p.membership.role != Role.owner:
        raise Forbidden("Only the organisation owner can delete a project permanently.")
    if project.archived_at is None:
        raise Conflict("Archive the project first.")
    if body.confirm_name.strip() != project.name:
        raise ValidationFailed(
            "Type the project name exactly to confirm.",
            details=[{"field": "confirm_name", "message": "Type the project name exactly to confirm."}],
        )
    if project.purge_scheduled_at is None:
        project.purge_scheduled_at = utcnow() + hsvc.PURGE_DELAY
        project.purge_requested_by = p.user.id
        audit(
            s,
            org_id=project.organisation_id,
            action="project.purge_scheduled",
            target_type="project",
            target_id=project.id,
            actor_user_id=p.user.id,
            project_id=project.id,
            ip=client_ip(request),
            metadata={"name": project.name, "at": project.purge_scheduled_at.isoformat()},
        )
        await s.commit()
    when = project.purge_scheduled_at
    assert when is not None
    return {
        **_purge_view(project),
        # The UI words this in the viewer's local time from `purge_scheduled_at`; the API names its zone.
        "message": f"{project.name} will be deleted on {when.day} {when:%b} at {when:%H:%M} UTC.",
    }


@router.delete("/projects/{project_id}/purge")
async def cancel_purge(
    project_id: uuid.UUID, request: Request, s: ScopedSession, p: CurrentPrincipal
) -> dict[str, Any]:
    project = await _project(s, project_id)
    if p.membership.role != Role.owner:
        raise Forbidden("Only the organisation owner can cancel a deletion.")
    if project.purge_scheduled_at is not None:
        project.purge_scheduled_at = None
        project.purge_requested_by = None
        audit(
            s,
            org_id=project.organisation_id,
            action="project.purge_cancelled",
            target_type="project",
            target_id=project.id,
            actor_user_id=p.user.id,
            project_id=project.id,
            ip=client_ip(request),
        )
        await s.commit()
    return {**_purge_view(project), "message": "Deletion cancelled. Nothing was removed."}
