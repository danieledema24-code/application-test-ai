from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator

from fastapi import APIRouter, Header, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from app.api.deps import Ctx, CurrentPrincipal, ScopedSession
from app.api.errors import BadRequest
from app.api.pagination import clamp_limit, decode_cursor, encode_cursor
from app.api.routers.projects import load_project
from app.context import AppContext
from app.db.models import AgentEvent, Project
from app.db.tenant import TenantScope, bind_scope
from app.schemas import api

router = APIRouter(tags=["events"])


def event_out(e: AgentEvent, ctx: AppContext) -> api.AgentEventOut:
    data = dict(e.data or {})
    shot = data.get("screenshot")
    if isinstance(shot, dict) and shot.get("id"):
        # Signed URLs expire; replayed events get a fresh one (org-bound to the event's organisation).
        try:
            data["screenshot"] = {
                **shot,
                "content_url": ctx.evidence_url(uuid.UUID(str(shot["id"])), e.organisation_id),
            }
        except ValueError:
            data["screenshot"] = None
    return api.AgentEventOut(
        id=e.id,
        project_id=e.project_id,
        stage_key=e.stage_key,
        agent_key=e.agent_key,
        task_id=e.agent_task_id,
        type=e.type,
        level=e.level.value,
        message=e.message,
        data=data,
        created_at=e.created_at,
    )


def _cursor(after: int | None, last_event_id: str | None) -> int:
    if last_event_id:
        try:
            return int(last_event_id)
        except ValueError as exc:
            raise BadRequest("Invalid Last-Event-ID") from exc
    return after or 0


@router.get("/projects/{project_id}/events", response_model=api.EventsPage)
async def list_events(
    project_id: uuid.UUID,
    ctx: Ctx,
    s: ScopedSession,
    _p: CurrentPrincipal,
    after: int = Query(0, ge=0),
    limit: int | None = Query(None, ge=1, le=100),
    before: int | None = Query(None, ge=1),
) -> api.EventsPage:
    await load_project(s, project_id)
    lim = clamp_limit(limit, 100)
    stmt = select(AgentEvent).where(AgentEvent.project_id == project_id)
    if before is not None:
        rows = list(
            (await s.execute(stmt.where(AgentEvent.id < before).order_by(AgentEvent.id.desc()).limit(lim)))
            .scalars()
            .all()
        )
        rows.reverse()
    else:
        rows = list(
            (await s.execute(stmt.where(AgentEvent.id > after).order_by(AgentEvent.id).limit(lim))).scalars().all()
        )
    return api.EventsPage(items=[event_out(e, ctx) for e in rows], next_after=rows[-1].id if rows else after)


@router.get("/projects/{project_id}/events/stream")
async def stream(
    project_id: uuid.UUID,
    request: Request,
    ctx: Ctx,
    s: ScopedSession,
    p: CurrentPrincipal,
    after: int | None = Query(None, ge=0),
    last_event_id: str | None = Header(None, alias="Last-Event-ID"),
) -> StreamingResponse:
    await load_project(s, project_id)
    cursor = _cursor(after, last_event_id)
    scope = p.scope
    settings = ctx.settings

    async def gen() -> AsyncIterator[bytes]:
        nonlocal cursor
        loop = asyncio.get_running_loop()
        started = loop.time()
        last_send = started
        yield b"retry: 3000\n\n"
        while loop.time() - started < settings.sse_max_connection_s:
            if await request.is_disconnected():
                return
            rows = await _fetch(ctx, scope, project_id, cursor)
            for e in rows:
                payload = event_out(e, ctx).model_dump(mode="json")
                payload["created_at"] = e.created_at.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
                yield f"id: {e.id}\nevent: agent_event\ndata: {json.dumps(payload, separators=(',', ':'))}\n\n".encode()
                cursor = e.id
                last_send = loop.time()
            if loop.time() - last_send >= settings.sse_keepalive_s:
                yield b": keep-alive\n\n"
                last_send = loop.time()
            if not rows:
                await asyncio.sleep(settings.sse_poll_interval_s)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


async def _fetch(ctx: Ctx, scope: TenantScope, project_id: uuid.UUID, cursor: int) -> list[AgentEvent]:
    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        return list(
            (
                await s.execute(
                    select(AgentEvent)
                    .where(AgentEvent.project_id == project_id, AgentEvent.id > cursor)
                    .order_by(AgentEvent.id)
                    .limit(200)
                )
            )
            .scalars()
            .all()
        )


@router.get("/activity", response_model=api.Page[api.ActivityItem])
async def activity(
    s: ScopedSession,
    _p: CurrentPrincipal,
    limit: int | None = Query(None, ge=1, le=100),
    cursor: str | None = None,
    milestones: bool = False,
) -> api.Page[api.ActivityItem]:
    lim, off = clamp_limit(limit), decode_cursor(cursor)
    stmt = select(AgentEvent, Project.name).join(Project, Project.id == AgentEvent.project_id)
    if milestones:
        stmt = stmt.where(AgentEvent.type.in_(MILESTONE_TYPES))
    rows = (await s.execute(stmt.order_by(AgentEvent.id.desc()).offset(off).limit(lim + 1))).all()
    items = [
        api.ActivityItem(
            id=e.id,
            project_id=e.project_id,
            project_name=name,
            type=e.type,
            message=e.message,
            level=e.level.value,
            created_at=e.created_at,
            stage_key=e.stage_key,
        )
        for e, name in rows[:lim]
    ]
    return api.Page[api.ActivityItem](items=items, next_cursor=encode_cursor(off + lim) if len(rows) > lim else None)


MILESTONE_TYPES = ("stage.status_changed", "gate.awaiting_approval", "gate.decided", "report.ready", "task.failed")
