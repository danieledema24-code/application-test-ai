"""P4-00 migration 0016_automation_execution: up -> down to Phase 3 (0015) -> up keeps Phase 3 data, the batch
rebuilds of evidence and gate_decisions keep their CHECK constraints, and the G6 startup step (decision D10) moves
the old `required` default to `recommended` unless G6 was chosen explicitly. Startup never queues Phase 4 work."""

from __future__ import annotations

import shutil
from pathlib import Path

from sqlalchemy import select, text

from app.context import AppContext, build_context
from app.db.migrate import downgrade, upgrade
from app.db.models import Project
from app.db.tenant import BYPASS
from app.llm.base import DisabledLLM
from app.services.projects import apply_g6_hybrid_default
from tests.conftest import client_for, create_project, make_settings, public_resolver, register, site_transport

P4_TABLES = {"automation_assessments", "automation_assets", "automation_scripts", "execution_runs",
             "execution_results", "approvals", "defects", "defect_links", "defect_occurrences"}  # fmt: skip


def _ctx(tmp_path: Path) -> AppContext:
    ctx = build_context(make_settings(tmp_path), llm=DisabledLLM())
    ctx.resolver = public_resolver()
    ctx.http_transport = site_transport()
    return ctx


async def _tables(ctx: AppContext) -> set[str]:
    async with ctx.engine.connect() as conn:
        return {r[0] for r in await conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))}


async def _sql(ctx: AppContext, table: str) -> str:
    async with ctx.engine.connect() as conn:
        return str(
            (await conn.execute(text("SELECT sql FROM sqlite_master WHERE name = :t"), {"t": table})).scalar_one()
        )


async def test_up_down_up_keeps_phase3_data(tmp_path: Path, template_db: Path) -> None:
    shutil.copy(template_db, tmp_path / "qa.db")
    ctx = _ctx(tmp_path)
    async with client_for(ctx) as client:
        owner = await register(client, "mig4@example.com", org="Mig4 Org")
        await create_project(client, owner)
        wf_before = (await client.get("/api/v1/projects", headers=owner.headers)).json()
    assert await _tables(ctx) >= P4_TABLES
    gd = await _sql(ctx, "gate_decisions")
    assert "ck_gate_decisions_decision_gate_key" in gd and "ck_gate_decisions_gate_decision_subject_type" in gd
    ev = await _sql(ctx, "evidence")
    assert "ck_evidence_evidence_kind" in ev and "fk_evidence_execution_result_id_execution_results" in ev
    async with ctx.engine.connect() as conn:
        counts = {
            t: int((await conn.execute(text(f"SELECT COUNT(*) FROM {t}"))).scalar_one())  # noqa: S608 - fixed names
            for t in ("projects", "workflow_stages", "stage_runs", "gate_decisions", "audit_logs", "memberships")
        }
    await downgrade(ctx.engine, "0015")
    assert not (P4_TABLES & await _tables(ctx))
    gd = await _sql(ctx, "gate_decisions")
    assert "subject_type" not in gd and "stage_run_id CHAR(32) NOT NULL" in gd
    assert "ck_gate_decisions_decision_gate_key" in gd and "ck_gate_decisions_gate_decision" in gd
    assert "ck_evidence_evidence_kind" in await _sql(ctx, "evidence")
    async with ctx.engine.connect() as conn:
        for t, n in counts.items():
            assert int((await conn.execute(text(f"SELECT COUNT(*) FROM {t}"))).scalar_one()) == n, t  # noqa: S608
    await upgrade(ctx.engine)
    assert await _tables(ctx) >= P4_TABLES
    async with client_for(ctx) as client:  # app startup on the upgraded database
        login = await client.post(
            "/api/v1/auth/login", json={"email": owner.email, "password": "correct-horse-battery"}
        )
        headers = {"Authorization": f"Bearer {login.json()['token']}"}
        projects = (await client.get("/api/v1/projects", headers=headers)).json()
        assert [p["id"] for p in projects["items"]] == [p["id"] for p in wf_before["items"]]
        wf = (await client.get(f"/api/v1/projects/{projects['items'][0]['id']}/workflow", headers=headers)).json()
        p4 = {s["key"]: s["status"] for s in wf["stages"] if s["phase"] == 4}
        assert set(p4.values()) == {"not_started"}, p4  # nothing is queued until advance is next triggered
    await ctx.close()


async def test_g6_startup_step_respects_explicit_choices(tmp_path: Path, template_db: Path) -> None:
    shutil.copy(template_db, tmp_path / "qa.db")
    ctx = _ctx(tmp_path)
    async with client_for(ctx) as client:
        owner = await register(client, "g6@example.com", org="G6 Org")
        legacy = await create_project(client, owner, "https://legacy.example.com")
        chosen = await create_project(client, owner, "https://chosen.example.com")
        fresh = await create_project(client, owner, "https://fresh.example.com")
        assert fresh["approval_policy"]["G6"] == "recommended"  # new projects get the D10 default
        r = await client.patch(f"/api/v1/projects/{chosen['id']}", headers=owner.headers,
                               json={"version": chosen["version"], "approval_policy": {"G6": "required"}})  # fmt: skip
        assert r.status_code == 200, r.text
    async with ctx.session_factory() as s:  # a Phase 3 project still storing the old default
        row = (
            await s.execute(select(Project).where(Project.name == legacy["name"]).execution_options(**BYPASS))
        ).scalar_one()
        row.approval_policy = {**row.approval_policy, "G6": "required"}
        await s.commit()
    assert await apply_g6_hybrid_default(ctx) == 1
    assert await apply_g6_hybrid_default(ctx) == 0  # idempotent
    async with ctx.session_factory() as s:
        rows = (await s.execute(select(Project).execution_options(**BYPASS))).scalars().all()
        policy = {str(p.id): p.approval_policy["G6"] for p in rows}
    assert policy[legacy["id"]] == "recommended" and policy[chosen["id"]] == "required"
    await ctx.close()
