from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import func, select, text

from app.api.deps import Ctx
from app.db.models import WorkerHeartbeat
from app.db.types import utcnow
from app.schemas import api

router = APIRouter(tags=["health"])


@router.get("/health", response_model=api.Health)
async def health(ctx: Ctx) -> api.Health:
    db_ok = True
    last_beat_s: float | None = None
    depth = 0
    try:
        async with ctx.session_factory() as s:
            await s.execute(text("SELECT 1"))
            beat = (await s.execute(select(func.max(WorkerHeartbeat.heartbeat_at)))).scalar_one_or_none()
            if beat is not None:
                last_beat_s = round((utcnow() - beat).total_seconds(), 1)
        depth = await ctx.queue.depth()
    except Exception:  # noqa: BLE001 - reported as db=false
        db_ok = False
    browser_ok = await ctx.browser_pool.available()
    mode = ctx.settings.worker_mode
    worker_ok = mode == "off" or (last_beat_s is not None and last_beat_s < 60)
    return api.Health(
        status="ok" if db_ok and browser_ok and worker_ok else "degraded",
        db=db_ok,
        worker=api.WorkerHealth(mode=mode, last_heartbeat_s=last_beat_s),
        queue_depth=depth,
        ai=api.AiHealth(enabled=ctx.llm.enabled, provider=ctx.llm.provider, model=ctx.llm.model),
        browser=api.BrowserHealth(available=browser_ok),
        version=ctx.settings.app_version,
        allow_private_targets=ctx.settings.allow_private_targets and ctx.settings.env != "production",
    )
