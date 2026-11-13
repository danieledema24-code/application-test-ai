"""Project test credentials (P2-01): metadata only on read; writes need can_approve (owner/admin)."""

from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi import APIRouter, Response
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from sqlalchemy import select

from app.api.deps import Ctx, CurrentPrincipal, MemberPrincipal, ScopedSession
from app.api.errors import Forbidden, GateBlocked, NotFound, RateLimited, ValidationFailed
from app.api.routers import p2common as c
from app.db.models import AgentTask, ProjectSecret, ProjectUrl
from app.db.types import utcnow
from app.domain.enums import AuthorisationStatus, SecretKind, TaskStatus, UrlRole
from app.security.ssrf import UrlRejected, host_matches, normalise_url
from app.services import serialize_p2 as out
from app.services.audit import audit
from app.services.secrets import CREDENTIALS_SECRET, link_primary_url, metadata_for

router = APIRouter(prefix="/projects/{project_id}/secrets", tags=["secrets"])


class ScanCredentialsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    login_url: str = Field(max_length=2048)
    username: str = Field(min_length=1, max_length=200)
    password: SecretStr = Field(min_length=1, max_length=200)


def _require_admin(p: MemberPrincipal) -> None:
    if not p.scope.can_approve:
        raise Forbidden("Only owners and admins can manage test credentials")


async def _meta(s: ScopedSession, row: ProjectSecret) -> dict[str, Any]:
    us = await out.users(s, [row.created_by])
    meta = row.meta or {}
    return {
        "id": row.id,
        "name": row.name,
        "kind": row.kind.value,
        "login_url": meta.get("login_url"),
        "username_hint": meta.get("username_hint"),
        "version": row.version,
        "created_by": out.user_dict(us.get(row.created_by)),
        "created_at": row.created_at,
        "rotated_at": row.rotated_at,
        "last_used_at": row.last_used_at,
        "last_result": row.last_result.value if row.last_result else None,
        "last_reason_code": row.last_reason_code,
        "last_used_scan_number": meta.get("last_used_scan_number"),
    }


async def _primary(s: ScopedSession, project_id: uuid.UUID) -> ProjectUrl:
    url = (
        await s.execute(
            select(ProjectUrl).where(ProjectUrl.project_id == project_id, ProjectUrl.role == UrlRole.primary)
        )
    ).scalar_one_or_none()
    if url is None:
        raise NotFound("Project URL not found")
    return url


@router.get("")
async def list_secrets(project_id: uuid.UUID, s: ScopedSession, _p: CurrentPrincipal) -> list[dict[str, Any]]:
    await c.project_of(s, project_id)
    rows = (await s.execute(select(ProjectSecret).where(ProjectSecret.project_id == project_id))).scalars()
    return [await _meta(s, r) for r in rows]


@router.put("/scan_credentials")
async def put_credentials(
    project_id: uuid.UUID,
    body: ScanCredentialsInput,
    response: Response,
    ctx: Ctx,
    s: ScopedSession,
    p: MemberPrincipal,
) -> dict[str, Any]:
    _require_admin(p)
    project = await c.project_of(s, project_id)
    url = await _primary(s, project_id)
    try:
        login = normalise_url(body.login_url.strip())
    except UrlRejected as exc:
        raise ValidationFailed(
            "Invalid sign-in page URL", details=[{"field": "login_url", "message": exc.reason}]
        ) from exc
    hosts = list(url.allowed_hosts or []) or [normalise_url((url.last_check or {}).get("final_url") or url.url).host]
    if not host_matches(login.host, hosts):
        raise ValidationFailed(
            f"The sign-in page must be on {', '.join(hosts)}.",
            details=[{"field": "login_url", "message": f"The sign-in page must be on {', '.join(hosts)}."}],
        )
    creds = {"login_url": login.url, "username": body.username.strip(), "password": body.password.get_secret_value()}
    row = (
        await s.execute(
            select(ProjectSecret).where(
                ProjectSecret.project_id == project_id, ProjectSecret.name == CREDENTIALS_SECRET
            )
        )
    ).scalar_one_or_none()
    created = row is None
    if row is None:
        row = ProjectSecret(
            organisation_id=project.organisation_id,
            project_id=project_id,
            name=CREDENTIALS_SECRET,
            kind=SecretKind.login_credentials,
            ciphertext=ctx.encryptor.encrypt(json.dumps(creds)),
            created_by=p.user.id,
            meta=metadata_for(creds),
            version=1,
        )
        s.add(row)
    else:
        row.ciphertext = ctx.encryptor.encrypt(json.dumps(creds))
        row.meta = metadata_for(creds)
        row.version += 1
        row.rotated_at = utcnow()
        row.last_result = None
        row.last_reason_code = None
        row.last_result_at = None
    await s.flush()
    await link_primary_url(s, project_id, row.id)
    audit(s, org_id=project.organisation_id, action="secret.created" if created else "secret.rotated",
          target_type="secret", target_id=row.id, actor_user_id=p.user.id, project_id=project_id,
          metadata={"name": row.name, "version": row.version})  # fmt: skip
    await s.commit()
    response.status_code = 201 if created else 200
    return await _meta(s, row)


@router.delete("/{secret_id}", status_code=204)
async def delete_secret(project_id: uuid.UUID, secret_id: uuid.UUID, s: ScopedSession, p: MemberPrincipal) -> Response:
    _require_admin(p)
    project = await c.project_of(s, project_id)
    row = (
        await s.execute(
            select(ProjectSecret).where(ProjectSecret.id == secret_id, ProjectSecret.project_id == project_id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise NotFound("Secret not found")
    urls = (await s.execute(select(ProjectUrl).where(ProjectUrl.credentials_secret_id == row.id))).scalars()
    for u in urls:
        u.credentials_secret_id = None
    audit(s, org_id=project.organisation_id, action="secret.deleted", target_type="secret", target_id=row.id,
          actor_user_id=p.user.id, project_id=project_id, metadata={"name": row.name})  # fmt: skip
    await s.flush()
    await s.delete(row)
    await s.commit()
    return Response(status_code=204)


@router.post("/scan_credentials/test", status_code=202)
async def test_sign_in(project_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: MemberPrincipal) -> dict[str, Any]:
    _require_admin(p)
    project = await c.project_of(s, project_id)
    url = await _primary(s, project_id)
    if url.authorisation_status != AuthorisationStatus.attested:
        raise GateBlocked("The project URL must be authorised (Gate 1) first")
    row = (
        await s.execute(
            select(ProjectSecret).where(
                ProjectSecret.project_id == project_id, ProjectSecret.name == CREDENTIALS_SECRET
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise NotFound("No test credentials saved")
    retry = ctx.rate_limiter.hit(f"signin:{project_id}", 5, 600)
    if retry is not None:
        raise RateLimited("Too many sign-in tests for this project; try again later", retry)
    task = AgentTask(
        organisation_id=project.organisation_id,
        project_id=project_id,
        agent_key="discovery",
        status=TaskStatus.queued,
        input={"purpose": "signin_test", "secret_id": str(row.id)},
    )
    s.add(task)
    await s.flush()
    audit(s, org_id=project.organisation_id, action="secret.test_requested", target_type="secret", target_id=row.id,
          actor_user_id=p.user.id, project_id=project_id)  # fmt: skip
    await s.commit()
    await ctx.queue.enqueue(
        "signin_test", {"task_id": str(task.id)}, org_id=project.organisation_id, project_id=project_id,
        dedupe_key=f"signin:{task.id}",
    )  # fmt: skip
    return {"task_id": task.id}
