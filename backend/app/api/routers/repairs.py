"""Repair suggestions (P6-04, decision D31; design P6 §8).

- `GET /projects/{id}/heal-suggestions?status=&change_set=&source=&execution_result=`: the cards, oldest first.
- `GET /heal-suggestions/{id}`.
- `POST /heal-suggestions/{id}/accept {index}` (member): one suggestion, one candidate. A new page-object version
  with only that locator line changed; the scripts using it are checked again (G6) before they can run.
- `POST /heal-suggestions/{id}/reject {reason}` (member; a reason is required).

There is no batch accept and nothing is applied automatically. "Expected result may be out of date" reviews have no
accept or reject: a person edits the test case, which goes through G5. Reads are open to viewers; other organisations
get 404. The P4-08 accept endpoint (`/execution-results/{id}/heal-suggestions/{n}/accept`) keeps working.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.exc import IntegrityError

from app.api.deps import Ctx, CurrentPrincipal, MemberPrincipal, Principal, ScopedSession
from app.api.errors import Conflict
from app.api.routers import p2common as c
from app.db.models import HealSuggestion
from app.domain.enums import Role, StageKey
from app.services import repairs as svc
from app.services import serialize_p2 as out

router = APIRouter(tags=["repairs"])


def _member(p: Principal) -> bool:
    return p.membership.role != Role.viewer


async def _one(ctx: Ctx, s: ScopedSession, p: Principal, row: HealSuggestion) -> dict[str, Any]:
    [view] = await svc.views(ctx, s, [row], see_email=out.sees_email(p.membership.role), can_decide=_member(p))
    return view


@router.get("/projects/{project_id}/heal-suggestions")
async def list_suggestions(
    project_id: uuid.UUID,
    ctx: Ctx,
    s: ScopedSession,
    p: CurrentPrincipal,
    status: str | None = None,
    change_set: uuid.UUID | None = None,
    source: str | None = None,
    execution_result: uuid.UUID | None = None,
) -> dict[str, Any]:
    await c.project_of(s, project_id)
    rows = await svc.list_rows(s, project_id, status=status, change_set=change_set, source=source,
                               result=execution_result)  # fmt: skip
    every = await svc.list_rows(s, project_id, change_set=change_set, result=execution_result)
    items = await svc.views(ctx, s, rows, see_email=out.sees_email(p.membership.role), can_decide=_member(p))
    return {"items": items, "counts": svc.counts(every), "permissions": {"can_decide": _member(p)}}


@router.get("/heal-suggestions/{suggestion_id}")
async def get_suggestion(suggestion_id: uuid.UUID, ctx: Ctx, s: ScopedSession, p: CurrentPrincipal) -> dict[str, Any]:
    row = await c.load(s, HealSuggestion, suggestion_id, "Repair suggestion")
    return await _one(ctx, s, p, row)


class AcceptInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    index: int = Field(ge=0, le=20)


@router.post("/heal-suggestions/{suggestion_id}/accept")
async def accept_suggestion(
    suggestion_id: uuid.UUID, body: AcceptInput, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    row: HealSuggestion = await c.load(s, HealSuggestion, suggestion_id, "Repair suggestion")
    project = await c.project_of(s, row.project_id)
    # One accept per page object at a time: the second reads what the first saved (QA P6-04 race).
    async with svc.accept_lock(project.id, row.file):
        await s.commit()  # end this request's read transaction, so the reads below see the other accept's commit
        await s.refresh(row)
        asset, scripts, replaced = await svc.accept(s, project, row, body.index, p.user)
        try:
            await s.commit()
        except IntegrityError as e:  # another API process saved a repair of this file at the same moment
            await s.rollback()
            raise Conflict(
                f"Another repair of {(row.file or 'this page object').rsplit('/', 1)[-1]} was saved at the same time. "
                "Nothing was changed: reload and try again."
            ) from e
    checking = await svc.enqueue_checks(ctx, project, scripts, row.key)
    name = asset.path.rsplit("/", 1)[-1]
    who = p.user.full_name or p.user.email
    await ctx.events.emit(
        org_id=project.organisation_id,
        project_id=project.id,
        type="automation.healed",
        message=f"{row.key} accepted by {who}: {name} version {asset.version}",
        stage_key=StageKey.automation.value,
        agent_key=svc.AGENT,
        data={"kind": "result", "heal_key": row.key, "path": asset.path, "version": asset.version},
    )
    tail = " is being checked." if checking else ". Check its scripts before the next run."
    return {
        "message": f"{row.key} accepted. {name} version {asset.version}{tail}",
        "asset": {"id": str(asset.id), "path": asset.path, "version": asset.version},
        "scripts_to_validate": sorted(x.path.rsplit("/", 1)[-1].removesuffix(".spec.ts") for x in scripts),
        "checking": checking,
        "replaced": replaced,
        "suggestion": await _one(ctx, s, p, row),
    }


class RejectInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str | None = Field(default=None, max_length=1000)


@router.post("/heal-suggestions/{suggestion_id}/reject")
async def reject_suggestion(
    suggestion_id: uuid.UUID, body: RejectInput, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    row: HealSuggestion = await c.load(s, HealSuggestion, suggestion_id, "Repair suggestion")
    project = await c.project_of(s, row.project_id)
    await svc.reject(s, project, row, body.reason, p.user)
    await s.commit()
    who = p.user.full_name or p.user.email
    await ctx.events.emit(
        org_id=project.organisation_id,
        project_id=project.id,
        type="heal_suggestion.rejected",
        message=f"{row.key} rejected by {who}",
        stage_key=StageKey.automation.value,
        agent_key=svc.AGENT,
        data={"kind": "status", "heal_key": row.key},
    )
    return {"message": f"{row.key} rejected.", "suggestion": await _one(ctx, s, p, row)}
