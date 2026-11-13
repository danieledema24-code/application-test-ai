"""Project use cases: URL check, creation with Gate 1 attestation, duplicate detection, credentials storage."""

from __future__ import annotations

import json
import uuid
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import Principal
from app.api.errors import DuplicateProject, RateLimited, UrlBlocked, UrlUnreachable, ValidationFailed
from app.context import AppContext
from app.db.models import Job, Project, ProjectSecret, ProjectUrl, WorkflowStage
from app.db.tenant import bind_scope
from app.db.types import utcnow
from app.domain.enums import (
    AuthorisationStatus,
    EventLevel,
    GateStatus,
    JobStatus,
    ProjectStatus,
    StageStatus,
    UrlRole,
)
from app.domain.stages import DEFAULT_APPROVAL_POLICY
from app.orchestrator.orchestrator import Orchestrator
from app.schemas import api
from app.security.ssrf import UrlRejected, normalise_url
from app.services.audit import audit
from app.services.url_check import check_url, is_startable

CREDENTIALS_SECRET = "scan_credentials"  # noqa: S105 - secret name, not a value


async def find_duplicate(s: AsyncSession, urls: list[str]) -> Project | None:
    wanted = [u for u in urls if u]
    if not wanted:
        return None
    row = (
        await s.execute(
            select(Project)
            .join(ProjectUrl, ProjectUrl.project_id == Project.id)
            .where(Project.archived_at.is_(None), ProjectUrl.url.in_(wanted))
            .order_by(Project.created_at)
            .limit(1)
        )
    ).scalar_one_or_none()
    if row is not None:
        return row
    # Also match the final URL of a previous check (e.g. example.com -> www.example.com).
    candidates = (
        await s.execute(
            select(Project, ProjectUrl)
            .join(ProjectUrl, ProjectUrl.project_id == Project.id)
            .where(Project.archived_at.is_(None))
        )
    ).all()
    for project, pu in candidates:
        if (pu.last_check or {}).get("final_url") in wanted:
            return project
    return None


async def url_check(ctx: AppContext, s: AsyncSession, principal: Principal, url: str) -> api.UrlCheckResult:
    retry = ctx.rate_limiter.hit(f"urlcheck:{principal.user.id}", ctx.settings.rl_url_check_per_min, 60)
    if retry is not None:
        raise RateLimited("Too many URL checks. Try again in a minute.", retry)
    result = await check_url(ctx, url)
    dup = await find_duplicate(s, [result["normalised_url"], result.get("final_url") or ""])
    if dup is not None:
        result["existing_project"] = {"id": str(dup.id), "name": dup.name}
    return api.UrlCheckResult.model_validate(result)


def _validate_credentials(creds: api.CredentialsInput | None, scope_host: str) -> dict[str, str] | None:
    if creds is None:
        return None
    values = {
        "login_url": (creds.login_url or "").strip(),
        "username": (creds.username or "").strip(),
        "password": creds.password or "",
    }
    filled = [k for k, v in values.items() if v]
    if not filled:
        return None
    if len(filled) != 3:
        missing = [k for k in values if k not in filled]
        raise ValidationFailed(
            "Enter a sign-in page URL, username and password, or leave all three empty.",
            details=[
                {
                    "field": f"credentials.{k}",
                    "message": "Enter a sign-in page URL, username and password, or leave all three empty.",
                }
                for k in missing
            ],
        )
    try:
        login = normalise_url(values["login_url"])
    except UrlRejected as exc:
        raise ValidationFailed(
            "Invalid sign-in page URL", details=[{"field": "credentials.login_url", "message": exc.reason}]
        ) from exc
    if login.host != scope_host:
        raise ValidationFailed(
            f"The sign-in page must be on {scope_host}.",
            details=[{"field": "credentials.login_url", "message": f"The sign-in page must be on {scope_host}."}],
        )
    values["login_url"] = login.url
    return values


async def create_project(ctx: AppContext, principal: Principal, body: api.ProjectCreate, ip: str) -> uuid.UUID:
    scope = principal.scope
    org = principal.organisation
    retry = ctx.rate_limiter.check(f"create:{org.id}", ctx.settings.rl_project_create_per_hour, 3600)
    if retry is not None:
        raise RateLimited(
            f"You've started {ctx.settings.rl_project_create_per_hour} analyses in the last hour. Try again later.",
            retry,
        )
    result = await check_url(ctx, body.url)
    if not result["allowed"]:
        raise UrlBlocked(
            result["blocked_reason"] or "This URL can't be analysed",
            details=[
                {
                    "field": "url",
                    "message": result["blocked_reason"] or "Blocked",
                    "code": result["blocked_code"],
                    "ip": result.get("blocked_ip"),
                }
            ],
        )
    if not is_startable(result):
        reason = result.get("unreachable_reason") or "The site could not be reached"
        raise UrlUnreachable(
            reason,
            details=[
                {
                    "field": "url",
                    "message": reason,
                    "code": result.get("unreachable_code"),
                    "http_status": result.get("http_status"),
                }
            ],
        )
    normalised = result["normalised_url"]
    final_url = result.get("final_url") or normalised
    final_host = normalise_url(final_url).host
    creds = _validate_credentials(body.credentials, final_host)
    limits = org.limits or {}
    cap = min(int(limits.get("max_pages_cap", ctx.settings.scan_max_pages_cap)), ctx.settings.scan_max_pages_cap)
    if body.scan.max_pages > cap:
        raise ValidationFailed(
            f"Maximum pages is {cap} for your organisation",
            details=[{"field": "scan.max_pages", "message": f"Enter a number from 1 to {cap}."}],
        )
    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        if not body.confirm_duplicate:
            dup = await find_duplicate(s, [normalised, final_url])
            if dup is not None:
                raise DuplicateProject(
                    f"You already have a project for {final_host}.",
                    details={
                        "project_id": str(dup.id),
                        "project_name": dup.name,
                        "primary_url": normalised,
                        "field": "url",
                    },
                )
        settings: dict[str, Any] = body.scan.model_dump()
        if creds:
            settings["login_url"] = creds["login_url"]
        project = Project(
            organisation_id=org.id,
            name=(body.name or "").strip() or final_host,
            description=body.description,
            status=ProjectStatus.active,
            approval_policy={k.value: v.value for k, v in DEFAULT_APPROVAL_POLICY.items()},
            settings=settings,
            created_by=principal.user.id,
        )
        s.add(project)
        await s.flush()
        secret_id = None
        if creds:
            secret = ProjectSecret(
                organisation_id=org.id,
                project_id=project.id,
                name=CREDENTIALS_SECRET,
                ciphertext=ctx.encryptor.encrypt(json.dumps(creds)),
                created_by=principal.user.id,
            )
            s.add(secret)
            await s.flush()
            secret_id = secret.id
            audit(
                s,
                org_id=org.id,
                action="secret.created",
                target_type="secret",
                target_id=secret.id,
                actor_user_id=principal.user.id,
                project_id=project.id,
                ip=ip,
                metadata={"name": CREDENTIALS_SECRET},
            )
        s.add(
            ProjectUrl(
                organisation_id=org.id,
                project_id=project.id,
                url=normalised,
                role=UrlRole.primary,
                allowed_hosts=[final_host],
                authorisation_status=AuthorisationStatus.attested,
                authorised_by=principal.user.id,
                authorised_at=utcnow(),
                authorisation_statement=body.authorisation.statement,
                last_check=result,
                credentials_secret_id=secret_id,
            )
        )
        await Orchestrator(ctx).init_stages(
            s, project, user_id=principal.user.id, check=result, statement=body.authorisation.statement
        )
        audit(
            s,
            org_id=org.id,
            action="project.created",
            target_type="project",
            target_id=project.id,
            actor_user_id=principal.user.id,
            project_id=project.id,
            ip=ip,
            metadata={
                "url": normalised,
                "final_url": final_url,
                "scan": body.scan.model_dump(),
                "credentials": bool(creds),
            },
        )
        await s.commit()
        project_id = project.id
    ctx.rate_limiter.record(f"create:{org.id}")
    await ctx.events.emit(
        org_id=org.id,
        project_id=project_id,
        type="gate.decided",
        message=f"Gate 1: authorisation confirmed by {principal.user.full_name}",
        stage_key="intake",
        agent_key="orchestrator",
        data={"kind": "gate", "gate": "G1", "decision": "approve"},
    )
    if body.start:
        await Orchestrator(ctx).advance(scope, project_id, triggered_by=principal.user.id)
        async with ctx.session_factory() as s:
            running = int(
                (
                    await s.execute(
                        select(func.count())
                        .select_from(Job)
                        .where(
                            Job.organisation_id == org.id,
                            Job.concurrency_group == "scan",
                            Job.status == JobStatus.running,
                        )
                    )
                ).scalar_one()
            )
        limit = int(limits.get("max_concurrent_scans", ctx.settings.max_concurrent_scans_per_org))
        if running >= min(limit, ctx.settings.max_concurrent_scans_per_org):
            await ctx.events.emit(
                org_id=org.id,
                project_id=project_id,
                type="log",
                level=EventLevel.warn,
                stage_key="discovery",
                agent_key="orchestrator",
                message=f"Waiting for a browser worker: your organisation already has {running} analyses running, the current limit.",
                data={"kind": "warning", "reason": "concurrency_limit", "running": running},
            )
    return project_id


def list_filter(status: str | None) -> list[Any]:
    if status == "archived":
        return [Project.archived_at.is_not(None)]
    if status == "paused":
        return [Project.archived_at.is_(None), Project.status == ProjectStatus.paused]
    if status == "active":
        return [Project.archived_at.is_(None)]
    if status == "running":
        busy = select(WorkflowStage.project_id).where(
            WorkflowStage.status.in_([StageStatus.queued, StageStatus.running])
        )
        return [Project.archived_at.is_(None), Project.id.in_(busy)]
    if status == "awaiting_approval":
        # Same rule as ProjectSummary.awaiting_approval.
        waiting = select(WorkflowStage.project_id).where(
            WorkflowStage.gate_key.is_not(None),
            WorkflowStage.status.not_in([StageStatus.queued, StageStatus.running]),
            or_(
                WorkflowStage.status == StageStatus.awaiting_approval,
                WorkflowStage.gate_status.in_([GateStatus.pending, GateStatus.recommended]),
            ),
        )
        return [Project.archived_at.is_(None), Project.id.in_(waiting)]
    return [or_(Project.archived_at.is_(None), Project.archived_at.is_not(None))]
