"""Durable job queue on the `jobs` table. Claims are a single conditional UPDATE, so a job is claimed exactly once
even with several worker loops or processes. Concurrency groups cap running jobs per organisation (e.g. scans)."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import aliased

from app.db.models import Job
from app.db.session import SessionFactory
from app.db.types import utcnow
from app.domain.enums import JobStatus

ACTIVE = (JobStatus.queued, JobStatus.running)


class SqlJobQueue:
    def __init__(self, session_factory: SessionFactory) -> None:
        self._sf = session_factory

    async def enqueue(
        self,
        kind: str,
        payload: dict[str, Any],
        *,
        org_id: uuid.UUID,
        project_id: uuid.UUID | None = None,
        dedupe_key: str | None = None,
        concurrency_group: str | None = None,
        run_after: datetime | None = None,
        max_attempts: int = 3,
    ) -> uuid.UUID:
        async with self._sf() as s:
            job = Job(
                kind=kind,
                payload=payload,
                organisation_id=org_id,
                project_id=project_id,
                dedupe_key=dedupe_key,
                concurrency_group=concurrency_group,
                run_after=run_after or utcnow(),
                max_attempts=max_attempts,
            )
            s.add(job)
            try:
                await s.commit()
                return job.id
            except IntegrityError:
                await s.rollback()
                if dedupe_key is None:
                    raise
                existing = (await s.execute(select(Job.id).where(Job.dedupe_key == dedupe_key))).scalar_one()
                return existing

    async def claim(self, worker_id: str, group_limits: dict[str, int]) -> Job | None:
        now = utcnow()
        async with self._sf() as s:
            candidates = (
                await s.execute(
                    select(Job.id, Job.concurrency_group)
                    .where(Job.status == JobStatus.queued, Job.run_after <= now, Job.cancel_requested.is_(False))
                    .order_by(Job.created_at)
                    .limit(25)
                )
            ).all()
            for job_id, group in candidates:
                conds = [Job.id == job_id, Job.status == JobStatus.queued]
                if group and group in group_limits:
                    other = aliased(Job)
                    running = (
                        select(func.count())
                        .select_from(other)
                        .where(
                            other.organisation_id == Job.organisation_id,
                            other.concurrency_group == group,
                            other.status == JobStatus.running,
                        )
                        .scalar_subquery()
                    )
                    conds.append(running < group_limits[group])
                res = await s.execute(
                    update(Job)
                    .where(and_(*conds))
                    .values(
                        status=JobStatus.running,
                        locked_by=worker_id,
                        locked_at=now,
                        heartbeat_at=now,
                        attempts=Job.attempts + 1,
                    )
                    .execution_options(synchronize_session=False)
                )
                await s.commit()
                if res.rowcount == 1:  # type: ignore[attr-defined]
                    return (await s.execute(select(Job).where(Job.id == job_id))).scalar_one()
            return None

    async def heartbeat(self, job_id: uuid.UUID, worker_id: str) -> bool:
        async with self._sf() as s:
            res = await s.execute(
                update(Job)
                .where(Job.id == job_id, Job.locked_by == worker_id, Job.status == JobStatus.running)
                .values(heartbeat_at=utcnow())
            )
            await s.commit()
            return bool(res.rowcount)  # type: ignore[attr-defined]

    async def complete(self, job_id: uuid.UUID) -> None:
        await self._finish(job_id, JobStatus.succeeded, None)

    async def fail(self, job_id: uuid.UUID, error: str, *, retry: bool = False) -> None:
        async with self._sf() as s:
            job = (await s.execute(select(Job).where(Job.id == job_id))).scalar_one_or_none()
            if job is None:
                return
            if retry and job.attempts < job.max_attempts:
                job.status = JobStatus.queued
                job.locked_by = None
                job.last_error = error[:2000]
                job.run_after = utcnow() + timedelta(seconds=2 * job.attempts)
            else:
                job.status = JobStatus.failed
                job.last_error = error[:2000]
                job.finished_at = utcnow()
                job.dedupe_key = None
            await s.commit()

    async def _finish(self, job_id: uuid.UUID, status: JobStatus, error: str | None) -> None:
        async with self._sf() as s:
            await s.execute(
                update(Job)
                .where(Job.id == job_id)
                .values(status=status, finished_at=utcnow(), last_error=error, dedupe_key=None)
            )
            await s.commit()

    async def cancel(self, job_id: uuid.UUID) -> None:
        async with self._sf() as s:
            await s.execute(
                update(Job)
                .where(Job.id == job_id, Job.status == JobStatus.queued)
                .values(status=JobStatus.cancelled, finished_at=utcnow(), dedupe_key=None)
            )
            await s.execute(
                update(Job).where(Job.id == job_id, Job.status == JobStatus.running).values(cancel_requested=True)
            )
            await s.commit()

    async def is_cancel_requested(self, job_id: uuid.UUID) -> bool:
        async with self._sf() as s:
            v = (await s.execute(select(Job.cancel_requested).where(Job.id == job_id))).scalar_one_or_none()
            return bool(v)

    async def depth(self) -> int:
        async with self._sf() as s:
            return int(
                (
                    await s.execute(select(func.count()).select_from(Job).where(Job.status == JobStatus.queued))
                ).scalar_one()
            )

    async def reap(self, timeout_s: int) -> list[tuple[Job, bool]]:
        """Jobs whose worker stopped heart-beating go back to `queued` (attempts left) or `failed` ("interrupted").
        Returns (job, requeued) pairs."""
        cutoff = utcnow() - timedelta(seconds=timeout_s)
        out: list[tuple[Job, bool]] = []
        async with self._sf() as s:
            stale = (
                (
                    await s.execute(
                        select(Job).where(
                            Job.status == JobStatus.running,
                            or_(Job.heartbeat_at.is_(None), Job.heartbeat_at < cutoff),
                        )
                    )
                )
                .scalars()
                .all()
            )
            for job in stale:
                res = await s.execute(
                    update(Job)
                    .where(Job.id == job.id, Job.status == JobStatus.running, Job.heartbeat_at == job.heartbeat_at)
                    .values(
                        status=JobStatus.queued if job.attempts < job.max_attempts else JobStatus.failed,
                        locked_by=None,
                        last_error="interrupted",
                        finished_at=None if job.attempts < job.max_attempts else utcnow(),
                        dedupe_key=job.dedupe_key if job.attempts < job.max_attempts else None,
                    )
                    .execution_options(synchronize_session=False)
                )
                if res.rowcount == 1:  # type: ignore[attr-defined]
                    out.append((job, job.attempts < job.max_attempts))
            await s.commit()
        return out
