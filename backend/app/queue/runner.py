"""Worker loop: claims jobs, runs them with a heartbeat, reaps jobs of dead workers. Runs inline in the API
process (WORKER_MODE=inline) or as `python -m app.worker` (WORKER_MODE=separate); same code either way."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from collections.abc import Awaitable, Callable

from sqlalchemy import select

from app.context import AppContext
from app.db.models import Job, WorkerHeartbeat
from app.db.types import utcnow
from app.logging import job_id_var, org_id_var, project_id_var

log = logging.getLogger(__name__)
JobHandler = Callable[[Job], Awaitable[None]]
InterruptHandler = Callable[[Job], Awaitable[None]]


class Worker:
    def __init__(
        self,
        ctx: AppContext,
        handler: JobHandler,
        *,
        on_interrupted: InterruptHandler | None = None,
        concurrency: int | None = None,
        worker_id: str | None = None,
        mode: str = "inline",
        heartbeat_s: float = 5.0,
        reap_every_s: float = 15.0,
    ) -> None:
        self.ctx = ctx
        self.handler = handler
        self.on_interrupted = on_interrupted
        self.concurrency = concurrency or ctx.settings.worker_concurrency
        self.worker_id = worker_id or f"{ctx.worker_id}-{uuid.uuid4().hex[:4]}"
        self.mode = mode
        self.heartbeat_s = heartbeat_s
        self.reap_every_s = reap_every_s
        self._running: set[asyncio.Task[None]] = set()
        self._stop = asyncio.Event()
        self._loop_task: asyncio.Task[None] | None = None

    @property
    def group_limits(self) -> dict[str, int]:
        return {"scan": self.ctx.settings.max_concurrent_scans_per_org}

    async def start(self) -> None:
        self._stop.clear()
        self._loop_task = asyncio.create_task(self._loop(), name=f"worker-{self.worker_id}")

    async def stop(self, timeout: float = 10.0) -> None:
        self._stop.set()
        if self._loop_task is not None:
            with contextlib.suppress(asyncio.CancelledError, TimeoutError):
                await asyncio.wait_for(self._loop_task, timeout)
        for t in list(self._running):
            t.cancel()
        if self._running:
            await asyncio.gather(*self._running, return_exceptions=True)

    async def reap_once(self) -> None:
        for job, requeued in await self.ctx.queue.reap(self.ctx.settings.job_heartbeat_timeout_s):
            log.warning("reaped job %s (%s): %s", job.id, job.kind, "requeued" if requeued else "failed (interrupted)")
            if not requeued and self.on_interrupted is not None:
                try:
                    await self.on_interrupted(job)
                except Exception:
                    log.exception("interrupt handler failed")

    async def run_until_idle(self, timeout: float = 120.0) -> None:
        """Test helper: process jobs until none are queued or running."""
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            claimed = await self._fill()
            if self._running:
                await asyncio.wait(self._running, timeout=0.5, return_when=asyncio.FIRST_COMPLETED)
                continue
            if not claimed:
                return
        raise TimeoutError("worker did not become idle")

    async def _fill(self) -> bool:
        claimed = False
        while len(self._running) < self.concurrency:
            job = await self.ctx.queue.claim(self.worker_id, self.group_limits)
            if job is None:
                break
            claimed = True
            t = asyncio.create_task(self._run(job), name=f"job-{job.id}")
            self._running.add(t)
            t.add_done_callback(self._running.discard)
        return claimed

    async def _loop(self) -> None:
        last_reap = 0.0
        last_beat = 0.0
        loop = asyncio.get_running_loop()
        while not self._stop.is_set():
            now = loop.time()
            try:
                if now - last_beat >= self.heartbeat_s:
                    await self._beat()
                    last_beat = now
                if now - last_reap >= self.reap_every_s:
                    await self.reap_once()
                    last_reap = now
                await self._fill()
            except Exception:
                log.exception("worker loop error")
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), self.ctx.settings.worker_poll_interval_s)

    async def _beat(self) -> None:
        async with self.ctx.session_factory() as s:
            row = (
                await s.execute(select(WorkerHeartbeat).where(WorkerHeartbeat.worker_id == self.worker_id))
            ).scalar_one_or_none()
            if row is None:
                s.add(WorkerHeartbeat(worker_id=self.worker_id, mode=self.mode, heartbeat_at=utcnow()))
            else:
                row.heartbeat_at = utcnow()
            await s.commit()

    async def _job_heartbeat(self, job_id: uuid.UUID) -> None:
        while True:
            await asyncio.sleep(self.heartbeat_s)
            with contextlib.suppress(Exception):
                await self.ctx.queue.heartbeat(job_id, self.worker_id)

    async def _run(self, job: Job) -> None:
        job_id_var.set(str(job.id))
        org_id_var.set(str(job.organisation_id))
        project_id_var.set(str(job.project_id) if job.project_id else None)
        beat = asyncio.create_task(self._job_heartbeat(job.id))
        try:
            await self.handler(job)
            await self.ctx.queue.complete(job.id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.exception("job %s failed", job.id)
            await self.ctx.queue.fail(job.id, f"{type(exc).__name__}: {str(exc)[:500]}", retry=False)
        finally:
            beat.cancel()
