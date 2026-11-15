"""QA round 2 (P5-BUG-01): the purge pass skips an archived, due project while one of its jobs is queued or running,
and deletes it on a later pass once the job has finished. Another organisation's due project is not affected by the
skip, and only the due project is removed."""

from __future__ import annotations

import uuid
from datetime import timedelta

import httpx
from sqlalchemy import select

from app.context import AppContext
from app.db.models import Job, Project
from app.db.tenant import BYPASS
from app.db.types import utcnow
from app.domain.enums import JobStatus
from app.services.hardening import purge_due
from tests.conftest import Account, CtxFactory, client_for, create_project, public_resolver, register, site_transport

API = "/api/v1"


async def _schedule(ctx: AppContext, c: httpx.AsyncClient, owner: Account, project: dict[str, str]) -> None:
    pid = project["id"]
    # Stop whatever creating the project queued, so archiving is allowed.
    async with ctx.session_factory() as s:
        for j in (
            await s.execute(select(Job).where(Job.project_id == uuid.UUID(pid)).execution_options(**BYPASS))
        ).scalars():
            j.status = JobStatus.succeeded
        await s.commit()
    r = await c.post(f"{API}/projects/{pid}/archive", headers=owner.headers)
    assert r.status_code == 204, r.text
    r = await c.post(f"{API}/projects/{pid}/purge", json={"confirm_name": project["name"]}, headers=owner.headers)
    assert r.status_code == 200, r.text


async def test_purge_waits_for_a_queued_or_running_job(make_ctx: CtxFactory) -> None:
    ctx = await make_ctx(resolver=public_resolver(), transport=site_transport(), allow_private_targets=True)
    async with client_for(ctx) as c:
        owner = await register(c, "owner@qa-purge-busy.example.com", org="QA Purge Busy")
        busy = await create_project(c, owner, url="https://busy.example.com", start=False)
        idle = await create_project(c, owner, url="https://idle.example.com", start=False)
        keep = await create_project(c, owner, url="https://keep.example.com", start=False)
        await _schedule(ctx, c, owner, busy)
        await _schedule(ctx, c, owner, idle)
        busy_id = uuid.UUID(busy["id"])
        async with ctx.session_factory() as s:
            job = Job(kind="report", organisation_id=owner.org_id, project_id=busy_id, status=JobStatus.running)
            s.add(job)
            await s.commit()
            job_id = job.id
        later = utcnow() + timedelta(hours=25)

        assert await purge_due(ctx, now=later) == 1  # only the idle one
        assert (await c.get(f"{API}/projects/{idle['id']}", headers=owner.headers)).status_code == 404
        assert (await c.get(f"{API}/projects/{busy['id']}", headers=owner.headers)).status_code == 200
        assert (await c.get(f"{API}/projects/{keep['id']}", headers=owner.headers)).status_code == 200

        async with ctx.session_factory() as s:
            j = (await s.execute(select(Job).where(Job.id == job_id).execution_options(**BYPASS))).scalar_one()
            j.status = JobStatus.queued
            await s.commit()
        assert await purge_due(ctx, now=later) == 0  # a queued job also holds it
        assert (await c.get(f"{API}/projects/{busy['id']}", headers=owner.headers)).status_code == 200

        async with ctx.session_factory() as s:
            j = (await s.execute(select(Job).where(Job.id == job_id).execution_options(**BYPASS))).scalar_one()
            j.status = JobStatus.succeeded
            await s.commit()
        assert await purge_due(ctx, now=later) == 1
        assert (await c.get(f"{API}/projects/{busy['id']}", headers=owner.headers)).status_code == 404
        async with ctx.session_factory() as s:
            left = (
                await s.execute(select(Project.id).where(Project.id == busy_id).execution_options(**BYPASS))
            ).first()
            assert left is None
        assert (await c.get(f"{API}/projects/{keep['id']}", headers=owner.headers)).status_code == 200
