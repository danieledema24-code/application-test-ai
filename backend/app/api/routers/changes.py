"""Rescans and change detection (P6-01, decisions D25, D26, D27).

- `POST /projects/{id}/rescans {limits?, compare_with?}` (member): a discovery run started as a rescan. It needs the
  URL and allowed hosts as authorised at G1 (409 otherwise) and a scan to compare with: the last scan approved at G2
  (D25), or `compare_with`. Limits are the baseline's unless given (within the organisation cap). When it finishes,
  `change_analysis` writes the change set. Approved requirements, strategy, cases and scripts stay as they are (D27).
- `GET /projects/{id}/changes?from=&to=`: the change sets (of one pair when both are given), newest first.
- `POST /projects/{id}/changes {from_scan_id, to_scan_id}` (member): compare any two finished scans. The same pair
  returns its existing set (200); a new pair is computed by the `change_compare` job (202).
- `GET /change-sets/{id}`, `GET /projects/{id}/change-sets/{key}`, `GET /change-sets/{id}/items?kind=&significance=
  &page=`.

Reads are open to viewers; other organisations get 404. Nothing here changes or deletes a scan, page or evidence file.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Query, Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import Ctx, CurrentPrincipal, MemberPrincipal, Principal, ScopedSession
from app.api.errors import NotFound, RateLimited, ValidationFailed
from app.api.routers import p2common as c
from app.db.models import ChangeSet, ScanSession
from app.domain.enums import Role, StageKey
from app.orchestrator.orchestrator import Orchestrator
from app.schemas import api
from app.services import changes as svc
from app.services import serialize_p2 as out
from app.services.audit import audit

router = APIRouter(tags=["changes"])


class RescanInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    limits: api.ScanSettings | None = None
    compare_with: uuid.UUID | None = None


class CompareInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    from_scan_id: uuid.UUID
    to_scan_id: uuid.UUID


def _member(p: Principal) -> bool:
    return p.membership.role != Role.viewer


async def _set_out(s: AsyncSession, cs: ChangeSet, p: Principal) -> dict[str, Any]:
    return await svc.set_dict(s, cs, see_email=out.sees_email(p.membership.role), can_compare=_member(p))


async def load_set(s: AsyncSession, change_set_id: uuid.UUID) -> ChangeSet:
    cs = (await s.execute(select(ChangeSet).where(ChangeSet.id == change_set_id))).scalar_one_or_none()
    if cs is None:
        raise NotFound("Change set not found")
    return cs


@router.post("/projects/{project_id}/rescans", status_code=202)
async def rescan(
    project_id: uuid.UUID, body: RescanInput, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    project = await c.project_of(s, project_id)
    org_id = project.organisation_id
    await svc.check_g1(s, project)
    base = await svc.rescan_baseline(s, project_id, body.compare_with)
    given = body.limits.model_dump() if body.limits else None
    cap = int((p.organisation.limits or {}).get("max_pages_cap", ctx.settings.scan_max_pages_cap))
    if given and given["max_pages"] > cap:
        raise ValidationFailed(f"Maximum pages is {cap}", details=[{"field": "limits.max_pages",
                                                                     "message": f"Enter 1–{cap}."}])  # fmt: skip
    limits = svc.rescan_limits(base, given)
    limits["max_pages"] = min(int(limits.get("max_pages", 30)), cap)
    retry = ctx.rate_limiter.check(f"stagerun:{project_id}", ctx.settings.rl_stage_runs_per_hour, 3600)
    if retry is not None:
        raise RateLimited("Too many runs for this project in the last hour", retry)
    params = {**limits, "rescan": True, "baseline_scan_session_id": str(base.id)}
    await Orchestrator(ctx).request_run(p.scope, project_id, StageKey.discovery, parameters=params, reason="rescan")
    ctx.rate_limiter.record(f"stagerun:{project_id}")
    scan = (
        await s.execute(
            select(ScanSession)
            .where(ScanSession.project_id == project_id)
            .order_by(ScanSession.sequence.desc())
            .limit(1)
        )
    ).scalar_one()
    audit(
        s,
        org_id=org_id,
        action="rescan.started",
        target_type="scan_session",
        target_id=scan.id,
        actor_user_id=p.user.id,
        project_id=project_id,
        metadata={"scan": scan.key, "baseline": base.key, "limits": limits},
    )
    await s.commit()
    await s.refresh(scan)
    await s.refresh(base)
    name = p.user.full_name or p.user.email
    await ctx.events.emit(
        org_id=org_id,
        project_id=project_id,
        type="rescan.started",
        message=f"Rescan started by {name}: Scan {scan.sequence}, compared with Scan {base.sequence}",
        stage_key=StageKey.discovery.value,
        agent_key=svc.AGENT,
        data={"kind": "status", "scan_number": scan.sequence, "baseline_number": base.sequence},
    )
    g2 = await svc.g2_scan_ids(s, project_id)
    return {"scan": svc.scan_ref(scan, g2), "baseline": svc.scan_ref(base, g2)}


@router.get("/projects/{project_id}/changes")
async def list_changes(
    project_id: uuid.UUID,
    s: ScopedSession,
    p: CurrentPrincipal,
    from_scan: Annotated[uuid.UUID | None, Query(alias="from")] = None,
    to_scan: Annotated[uuid.UUID | None, Query(alias="to")] = None,
) -> dict[str, Any]:
    await c.project_of(s, project_id)
    q = select(ChangeSet).where(ChangeSet.project_id == project_id)
    if from_scan is not None:
        q = q.where(ChangeSet.base_scan_session_id == from_scan)
    if to_scan is not None:
        q = q.where(ChangeSet.target_scan_session_id == to_scan)
    rows = list((await s.execute(q.order_by(ChangeSet.created_at.desc()))).scalars())
    return {"items": [await _set_out(s, cs, p) for cs in rows], "can_compare": _member(p)}


@router.post("/projects/{project_id}/changes", status_code=202)
async def compare(
    project_id: uuid.UUID, body: CompareInput, response: Response, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    project = await c.project_of(s, project_id)
    base = await svc.scan_in_project(s, project_id, body.from_scan_id, "from_scan_id")
    target = await svc.scan_in_project(s, project_id, body.to_scan_id, "to_scan_id")
    if target.sequence <= base.sequence:
        raise ValidationFailed(svc.LATER_SCAN, details=[{"field": "to_scan_id", "message": svc.LATER_SCAN}])
    existing = await svc.existing_set(s, project_id, base.id, target.id)
    if existing is not None:
        response.status_code = 200
        return {"change_set": await _set_out(s, existing, p), "created": False}
    cs = await svc.create_set(s, project, base, target, requested_by=p.user.id)
    await s.commit()
    await ctx.queue.enqueue(
        "change_compare",
        {"change_set_id": str(cs.id)},
        org_id=project.organisation_id,
        project_id=project.id,
        dedupe_key=f"change_compare:{cs.id}",
        max_attempts=1,
    )
    await ctx.events.emit(
        org_id=project.organisation_id,
        project_id=project.id,
        type="change.status",
        message=f"{cs.key}: comparing Scan {base.sequence} with Scan {target.sequence}",
        stage_key=StageKey.change_analysis.value,
        agent_key=svc.AGENT,
        data={"kind": "status", "change_set_key": cs.key, "status": "queued"},
    )
    return {"change_set": await _set_out(s, cs, p), "created": True}


@router.get("/projects/{project_id}/change-sets/{key}")
async def change_set_by_key(project_id: uuid.UUID, key: str, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    await c.project_of(s, project_id)
    cs = (
        await s.execute(select(ChangeSet).where(ChangeSet.project_id == project_id, ChangeSet.key == key.upper()))
    ).scalar_one_or_none()
    if cs is None:
        raise NotFound("Change set not found")
    return await _set_out(s, cs, p)


@router.get("/change-sets/{change_set_id}")
async def change_set(change_set_id: uuid.UUID, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    return await _set_out(s, await load_set(s, change_set_id), p)


@router.get("/change-sets/{change_set_id}/items")
async def change_items(
    change_set_id: uuid.UUID,
    ctx: Ctx,
    s: ScopedSession,
    _p: CurrentPrincipal,
    kind: str | None = None,
    significance: str | None = None,
    page: str | None = None,
) -> dict[str, Any]:
    cs = await load_set(s, change_set_id)
    return await svc.items_list(ctx, s, cs, kind=kind, significance=significance, page=page)
