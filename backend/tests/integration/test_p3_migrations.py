"""Phase 3 migrations (0013 test design, 0014 invitations): up -> down to Phase 2 (0012) -> up keeps Phase 2 data;
the G5 startup step (decision D1) switches stored `recommended` to `required` unless G5 was set explicitly."""

from __future__ import annotations

import shutil
from pathlib import Path

from sqlalchemy import select, text

from app.context import AppContext, build_context
from app.db.migrate import downgrade, upgrade
from app.db.models import Project
from app.db.tenant import BYPASS
from app.llm.base import DisabledLLM
from app.services.projects import require_g5_signoff
from tests.conftest import client_for, create_project, make_settings, public_resolver, register, site_transport

P3_TABLES = {"test_conditions", "condition_requirements", "test_cases", "test_case_requirements", "test_data",
             "test_case_data", "invitations"}  # fmt: skip


def _ctx(tmp_path: Path) -> AppContext:
    ctx = build_context(make_settings(tmp_path), llm=DisabledLLM())
    ctx.resolver = public_resolver()
    ctx.http_transport = site_transport()
    return ctx


async def _tables(ctx: object) -> set[str]:
    async with ctx.engine.connect() as conn:  # type: ignore[attr-defined]
        return {r[0] for r in await conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))}


async def test_up_down_up_keeps_phase2_data(tmp_path: Path, template_db: Path) -> None:
    shutil.copy(template_db, tmp_path / "qa.db")
    ctx = _ctx(tmp_path)
    async with client_for(ctx) as client:
        owner = await register(client, "mig3@example.com", org="Mig3 Org")
        await create_project(client, owner)
    assert await _tables(ctx) >= P3_TABLES
    async with ctx.engine.connect() as conn:
        before = int((await conn.execute(text("SELECT COUNT(*) FROM projects"))).scalar_one())
        cols = {r[1] for r in await conn.execute(text("PRAGMA table_info(memberships)"))}
        assert {"invited_by", "joined_at"} <= cols
    await downgrade(ctx.engine, "0012")
    assert not (P3_TABLES & await _tables(ctx))
    async with ctx.engine.connect() as conn:
        cols = {r[1] for r in await conn.execute(text("PRAGMA table_info(memberships)"))}
        assert "invited_by" not in cols and "joined_at" not in cols
        assert int((await conn.execute(text("SELECT COUNT(*) FROM projects"))).scalar_one()) == before
        assert int((await conn.execute(text("SELECT COUNT(*) FROM memberships"))).scalar_one()) == 1
    await upgrade(ctx.engine)
    assert await _tables(ctx) >= P3_TABLES
    async with ctx.engine.connect() as conn:
        assert int((await conn.execute(text("SELECT COUNT(*) FROM projects"))).scalar_one()) == before
    await ctx.close()


async def test_g5_startup_step_respects_explicit_choices(tmp_path: Path, template_db: Path) -> None:
    shutil.copy(template_db, tmp_path / "qa.db")
    ctx = _ctx(tmp_path)
    async with client_for(ctx) as client:
        owner = await register(client, "g5@example.com", org="G5 Org")
        legacy = await create_project(client, owner, "https://legacy.example.com")
        chosen = await create_project(client, owner, "https://chosen.example.com")
        fresh = await create_project(client, owner, "https://fresh.example.com")
        assert fresh["approval_policy"]["G5"] == "required"  # new projects default to required
        r = await client.patch(f"/api/v1/projects/{chosen['id']}", headers=owner.headers,
                               json={"version": chosen["version"], "approval_policy": {"G5": "recommended"}})  # fmt: skip
        assert r.status_code == 200, r.text
    async with ctx.session_factory() as s:  # a Phase 2 project still storing the old default
        row = (
            await s.execute(select(Project).where(Project.name == legacy["name"]).execution_options(**BYPASS))
        ).scalar_one()
        row.approval_policy = {**row.approval_policy, "G5": "recommended"}
        await s.commit()
    assert await require_g5_signoff(ctx) == 1
    assert await require_g5_signoff(ctx) == 0  # idempotent
    async with ctx.session_factory() as s:
        rows = (await s.execute(select(Project).execution_options(**BYPASS))).scalars().all()
        policy = {str(p.id): p.approval_policy["G5"] for p in rows}
    assert policy[legacy["id"]] == "required" and policy[chosen["id"]] == "recommended"
    await ctx.close()
