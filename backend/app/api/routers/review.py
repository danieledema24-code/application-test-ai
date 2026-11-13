"""Regeneration change review (P2-00): GET review, apply, discard."""

from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Path
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import Ctx, CurrentPrincipal, MemberPrincipal, ScopedSession
from app.api.errors import NotFound
from app.api.routers import p2common as c
from app.domain.enums import StageKey, StageStatus
from app.orchestrator.orchestrator import Orchestrator
from app.schemas import api
from app.services import regeneration as regen
from app.services import serialize as ser

router = APIRouter(prefix="/projects/{project_id}/stages/{stage}/runs/{version}/review", tags=["review"])


class ApplyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decisions: dict[str, Literal["accept", "keep", "skip", "mark_rejected"]] = {}
    comment: str | None = Field(None, max_length=2000)


class DiscardBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    comment: str | None = Field(None, max_length=2000)


def _stage(stage: str) -> StageKey:
    try:
        key = StageKey(stage)
    except ValueError as exc:
        raise NotFound("Unknown stage") from exc
    if key not in regen.REVIEW_STAGES:
        raise NotFound("This stage has no change review")
    return key


async def _state(s: ScopedSession, project_id: uuid.UUID, key: StageKey) -> api.StageState:
    project = await c.project_of(s, project_id)
    return next(x for x in await ser.stage_states(s, project) if x.key == key.value)


@router.get("")
async def get_review(
    project_id: uuid.UUID,
    version: int,
    s: ScopedSession,
    _p: CurrentPrincipal,
    stage: str = Path(),
    include_unchanged: bool = False,
) -> dict[str, Any]:
    key = _stage(stage)
    await c.project_of(s, project_id)
    st = await c.stage(s, project_id, key)
    run = await regen.candidate_run(s, st, version)
    return await regen.change_review(s, st, run, include_unchanged)


@router.post("/apply", response_model=api.StageState)
async def apply_review(
    project_id: uuid.UUID,
    version: int,
    body: ApplyBody,
    ctx: Ctx,
    s: ScopedSession,
    p: MemberPrincipal,
    stage: str = Path(),
) -> api.StageState:
    key = _stage(stage)
    project = await c.project_of(s, project_id)
    st = await c.stage(s, project_id, key)
    run = await regen.candidate_run(s, st, version)
    _diff, changed = await regen.apply(
        s, project, st, run, decisions=dict(body.decisions), user_id=p.user.id, comment=body.comment
    )
    orch = Orchestrator(ctx)
    reopened = False
    if changed:
        gate = regen.GATE_FOR_STAGE[key]
        reopened = await orch.reopen_gate(s, project, gate, reason=regen.reopen_reason(key), user_id=p.user.id)
    if key == StageKey.requirements and changed:
        # Ready/Done follows the requirements version automatically (advance queues it).
        rst = await c.stage(s, project_id, StageKey.readiness_criteria)
        if rst.status in (StageStatus.completed, StageStatus.failed):
            rst.stale_reason = "Requirements changed"
    await s.commit()
    if reopened:
        await orch.emit_reopened(project_id)
    await orch.advance(p.scope, project_id, triggered_by=p.user.id)
    s.expire_all()
    return await _state(s, project_id, key)


@router.post("/discard", response_model=api.StageState)
async def discard_review(
    project_id: uuid.UUID,
    version: int,
    body: DiscardBody,
    s: ScopedSession,
    p: MemberPrincipal,
    stage: str = Path(),
) -> api.StageState:
    key = _stage(stage)
    project = await c.project_of(s, project_id)
    st = await c.stage(s, project_id, key)
    run = await regen.candidate_run(s, st, version)
    await regen.discard(s, project, st, run, user_id=p.user.id, comment=body.comment)
    await s.commit()
    s.expire_all()
    return await _state(s, project_id, key)
