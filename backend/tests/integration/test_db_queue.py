"""Migrations, the tenant safety net (T10) and the durable job queue (T20)."""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import func, inspect, select, update

from app.context import AppContext
from app.db.migrate import downgrade, upgrade
from app.db.models import Job, Membership, Organisation, Project, User
from app.db.session import create_engine
from app.db.tenant import BYPASS, TenantRepository, TenantScope, TenantScopeMissing, bind_scope
from app.db.types import utcnow
from app.domain.enums import JobStatus, ProjectStatus, Role


async def test_migrations_upgrade_downgrade_upgrade(tmp_path: Path) -> None:
    engine = create_engine(f"sqlite+aiosqlite:///{tmp_path / 'm.db'}")
    try:
        await upgrade(engine)
        async with engine.connect() as c:
            tables = set(await c.run_sync(lambda s: inspect(s).get_table_names()))
        assert {"organisations", "projects", "discovered_pages", "agent_events", "jobs", "qa_reports"} <= tables
        await downgrade(engine, "base")
        async with engine.connect() as c:
            assert set(await c.run_sync(lambda s: inspect(s).get_table_names())) <= {"alembic_version"}
        await upgrade(engine)
    finally:
        await engine.dispose()


async def _org(ctx: AppContext, name: str) -> tuple[uuid.UUID, uuid.UUID]:
    async with ctx.session_factory() as s:
        org = Organisation(name=name, slug=f"{name}-{uuid.uuid4().hex[:6]}")
        user = User(email=f"{uuid.uuid4().hex[:8]}@example.com", full_name=name, password_hash="x")
        s.add_all([org, user])
        await s.flush()
        s.add(Membership(organisation_id=org.id, user_id=user.id, role=Role.owner, can_approve=True))
        await s.commit()
        return org.id, user.id


async def _project(ctx: AppContext, org_id: uuid.UUID, user_id: uuid.UUID, name: str) -> uuid.UUID:
    async with ctx.session_factory() as s:
        bind_scope(s, TenantScope(org_id=org_id, user_id=user_id))
        p = Project(name=name, status=ProjectStatus.active, created_by=user_id, settings={}, approval_policy={})
        s.add(p)
        await s.commit()
        return p.id


async def test_tenant_queries_without_scope_raise(ctx: AppContext) -> None:
    async with ctx.session_factory() as s:
        with pytest.raises(TenantScopeMissing):
            await s.execute(select(Project))
        with pytest.raises(TenantScopeMissing):
            await s.execute(update(Project).values(name="x"))
        # Explicit, greppable bypass for system code paths.
        assert (await s.execute(select(Project).execution_options(**BYPASS))).all() == []


async def test_tenant_criteria_and_repository_isolate_orgs(ctx: AppContext) -> None:
    org_a, user_a = await _org(ctx, "a")
    org_b, user_b = await _org(ctx, "b")
    pa = await _project(ctx, org_a, user_a, "A project")
    pb = await _project(ctx, org_b, user_b, "B project")
    async with ctx.session_factory() as s:
        bind_scope(s, TenantScope(org_id=org_a, user_id=user_a))
        assert [p.id for p in (await s.execute(select(Project))).scalars()] == [pa]
        repo = TenantRepository(s, Project)
        assert await repo.get(pb) is None
        assert (await repo.get(pa)) is not None
        assert [p.id for p in await repo.list()] == [pa]
        # Writes into another organisation are refused.
        s.add(
            Project(
                organisation_id=org_b,
                name="sneaky",
                status=ProjectStatus.active,
                created_by=user_a,
                settings={},
                approval_policy={},
            )
        )
        with pytest.raises(TenantScopeMissing):
            await s.flush()


async def test_aggregate_queries_are_tenant_scoped_or_refused(ctx: AppContext) -> None:
    """QA (P1-16 verification): `select(func.count()).select_from(Project)` has no tenant entity in its columns, so the
    do_orm_execute safety net skipped it: no criteria and no TenantScopeMissing (app/db/tenant.py, all_mappers check)."""
    org_a, user_a = await _org(ctx, "agg-a")
    org_b, user_b = await _org(ctx, "agg-b")
    await _project(ctx, org_a, user_a, "A project")
    await _project(ctx, org_a, user_a, "A project 2")
    count = select(func.count()).select_from(Project)
    async with ctx.session_factory() as s:
        bind_scope(s, TenantScope(org_id=org_b, user_id=user_b))
        assert (await s.execute(count)).scalar_one() == 0
    async with ctx.session_factory() as s:
        with pytest.raises(TenantScopeMissing):
            await s.execute(count)


async def test_claim_is_atomic_across_workers(ctx: AppContext) -> None:
    org, _ = await _org(ctx, "q")
    for i in range(6):
        await ctx.queue.enqueue("noop", {"i": i}, org_id=org)

    async def drain(worker: str) -> list[uuid.UUID]:
        got: list[uuid.UUID] = []
        while (job := await ctx.queue.claim(worker, {})) is not None:
            got.append(job.id)
        return got

    a, b = await asyncio.gather(drain("w1"), drain("w2"))
    assert len(a) + len(b) == 6 and not set(a) & set(b)


async def test_dedupe_and_per_org_scan_limit(ctx: AppContext) -> None:
    org, _ = await _org(ctx, "lim")
    other, _ = await _org(ctx, "other")
    j1 = await ctx.queue.enqueue("agent_task", {}, org_id=org, dedupe_key="task:1", concurrency_group="scan")
    assert await ctx.queue.enqueue("agent_task", {}, org_id=org, dedupe_key="task:1", concurrency_group="scan") == j1
    for i in range(2, 4):
        await ctx.queue.enqueue("agent_task", {}, org_id=org, dedupe_key=f"task:{i}", concurrency_group="scan")
    await ctx.queue.enqueue("agent_task", {}, org_id=other, dedupe_key="task:o", concurrency_group="scan")
    claimed = [await ctx.queue.claim("w", {"scan": 2}) for _ in range(4)]
    got = [j for j in claimed if j is not None]
    per_org = {o: sum(1 for j in got if j.organisation_id == o) for o in (org, other)}
    assert per_org == {org: 2, other: 1}  # third scan of `org` waits for a free slot
    await ctx.queue.complete(got[0].id)
    nxt = await ctx.queue.claim("w", {"scan": 2})
    assert nxt is not None and nxt.organisation_id == org


async def test_reaper_requeues_then_fails_stale_jobs(ctx: AppContext) -> None:
    org, _ = await _org(ctx, "reap")
    jid = await ctx.queue.enqueue("noop", {}, org_id=org, max_attempts=2)
    for expected_requeue in (True, False):
        job = await ctx.queue.claim("dead-worker", {})
        assert job is not None and job.id == jid
        async with ctx.session_factory() as s:
            await s.execute(update(Job).where(Job.id == jid).values(heartbeat_at=utcnow() - timedelta(minutes=5)))
            await s.commit()
        reaped = await ctx.queue.reap(60)
        assert [(j.id, r) for j, r in reaped] == [(jid, expected_requeue)]
    async with ctx.session_factory() as s:
        job_row = (await s.execute(select(Job).where(Job.id == jid))).scalar_one()
        assert job_row.status == JobStatus.failed and job_row.last_error == "interrupted"
