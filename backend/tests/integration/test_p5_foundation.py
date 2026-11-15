"""P5-00 Phase 5 workflow foundation: the optional `accessibility`, `security_assessment` and `performance` stages
(never queued by advance, G2 needed, performance only from its own endpoint), stale checks after a discovery re-run,
stale performance profiles after a changed G4 approval, migration 0017 on a database with Phase 4 data (up, down,
up; the default load ceiling; the startup step that adds the new stage rows), `/health.tools`, and tenant isolation
for the new stage keys.

Projects are put at "G2 approved" directly in the database (discovery itself is covered in test_discovery_e2e.py).
"""

from __future__ import annotations

import json
import shutil
import uuid
from collections.abc import AsyncIterator
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import func, select, text

from app.context import AppContext
from app.db.migrate import downgrade, upgrade
from app.db.models import (
    AgentTask,
    Approval,
    Defect,
    Evidence,
    ExecutionResult,
    ExecutionRun,
    GateDecision,
    Organisation,
    PerformanceProfile,
    QaReport,
    QualityScan,
    StageRun,
    WorkflowStage,
)
from app.db.tenant import BYPASS, system_scope
from app.db.types import utcnow
from app.domain.enums import (
    ApprovalKind,
    DefectSeverity,
    EvidenceKind,
    GateDecisionKind,
    GateKey,
    GateStatus,
    GeneratedBy,
    PerfProfileStatus,
    Priority,
    QualityScanKind,
    QualityScanStatus,
    ReportType,
    ResultStatus,
    StageKey,
    StageStatus,
)
from app.domain.performance.limits import DEFAULT_CEILING
from app.orchestrator.orchestrator import Orchestrator
from app.services.projects import ensure_stage_rows
from tests.conftest import Account, client_for, create_project, register
from tests.integration.test_p4_migrations import _ctx, _tables

API = "/api/v1"
P5_STAGES = ("accessibility", "security_assessment", "performance")
P5_TABLES = {"quality_scans", "quality_findings", "performance_profiles", "performance_runs"}


@pytest.fixture
async def setup(api_ctx: AppContext) -> AsyncIterator[tuple[AppContext, httpx.AsyncClient, Account, Account]]:
    async with client_for(api_ctx) as c:
        owner = await register(c, "owner@p5.example.com", org="P5 Org")
        other = await register(c, "other@p5.example.com", org="Other P5 Org")
        yield api_ctx, c, owner, other


async def _stage(ctx: AppContext, pid: uuid.UUID, key: StageKey) -> WorkflowStage:
    async with ctx.session_factory() as s:
        return (
            await s.execute(
                select(WorkflowStage)
                .where(WorkflowStage.project_id == pid, WorkflowStage.stage_key == key)
                .execution_options(**BYPASS)
            )
        ).scalar_one()


async def _set_stage(
    ctx: AppContext, owner: Account, pid: uuid.UUID, key: StageKey, status: StageStatus, output: dict[str, Any]
) -> uuid.UUID:
    async with ctx.session_factory() as s:
        st = (
            await s.execute(
                select(WorkflowStage)
                .where(WorkflowStage.project_id == pid, WorkflowStage.stage_key == key)
                .execution_options(**BYPASS)
            )
        ).scalar_one()
        version = int(
            (
                await s.execute(
                    select(func.count())
                    .select_from(StageRun)
                    .where(StageRun.workflow_stage_id == st.id)
                    .execution_options(**BYPASS)
                )
            ).scalar_one()
        )
        run = StageRun(
            organisation_id=owner.org_id,
            workflow_stage_id=st.id,
            project_id=pid,
            stage_key=key,
            version=version + 1,
            status=status,
            output=output,
            generated_by=GeneratedBy.rules,
            started_at=utcnow(),
            finished_at=utcnow(),
        )
        s.add(run)
        await s.flush()
        st.current_stage_run_id = run.id
        st.status = status
        if st.gate_key is not None and status == StageStatus.approved:
            st.gate_status = GateStatus.approved
        await s.commit()
        return run.id


async def _new(client: httpx.AsyncClient, owner: Account) -> uuid.UUID:
    return uuid.UUID((await create_project(client, owner, f"https://shop-{uuid.uuid4().hex[:8]}.example.com"))["id"])


async def _at_g2(ctx: AppContext, client: httpx.AsyncClient, owner: Account, *, approved: bool = True) -> uuid.UUID:
    pid = await _new(client, owner)
    status = StageStatus.approved if approved else StageStatus.awaiting_approval
    await _set_stage(ctx, owner, pid, StageKey.discovery, status, {"pages": 3})
    if not approved:
        async with ctx.session_factory() as s:
            st = (
                await s.execute(
                    select(WorkflowStage)
                    .where(WorkflowStage.project_id == pid, WorkflowStage.stage_key == StageKey.discovery)
                    .execution_options(**BYPASS)
                )
            ).scalar_one()
            st.gate_status = GateStatus.pending
            # G2 is `recommended` by default; a required G2 makes "before G2" block, as an owner may choose.
            from app.db.models import Project

            p = (await s.execute(select(Project).where(Project.id == pid).execution_options(**BYPASS))).scalar_one()
            p.approval_policy = {**p.approval_policy, "G2": "required"}
            await s.commit()
    return pid


async def _tasks(ctx: AppContext, pid: uuid.UUID) -> list[str]:
    async with ctx.session_factory() as s:
        rows = (
            await s.execute(select(AgentTask.agent_key).where(AgentTask.project_id == pid).execution_options(**BYPASS))
        ).all()
    return [r[0] for r in rows]


async def test_optional_stages_are_never_queued_and_need_g2(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid = await _at_g2(ctx, client, owner)
    queued = await Orchestrator(ctx).advance(system_scope(owner.org_id), pid)
    assert not {StageKey.accessibility, StageKey.security_assessment, StageKey.performance} & set(queued)
    for key in P5_STAGES:
        assert (await _stage(ctx, pid, StageKey(key))).status == StageStatus.not_started
    assert not {"accessibility", "security", "performance"} & set(await _tasks(ctx, pid))
    # P5-02/P5-03: checks start from Non-functional, never through the stage endpoint, and nothing is queued.
    for key, message in (
        ("accessibility", "Start an accessibility check from Non-functional"),
        ("security_assessment", "Start a security check from Non-functional"),
    ):
        r = await client.post(f"{API}/projects/{pid}/stages/{key}/run", json={}, headers=owner.headers)
        assert r.status_code == 422, r.text
        assert r.json()["error"]["message"] == message
    wf = (await client.get(f"{API}/projects/{pid}/workflow", headers=owner.headers)).json()
    p5 = {s["key"]: s for s in wf["stages"] if s["phase"] == 5}
    assert set(p5) == set(P5_STAGES) and all(s["available"] and s["status"] == "not_started" for s in p5.values())


async def test_before_g2_accessibility_and_security_are_gate_blocked(setup: Any) -> None:
    ctx, client, owner, _ = setup
    fresh = await _new(client, owner)  # discovery has not finished
    waiting = await _at_g2(ctx, client, owner, approved=False)  # finished, G2 required and not decided
    for pid in (fresh, waiting):
        for path in ("accessibility-scans", "security-assessments"):
            r = await client.post(f"{API}/projects/{pid}/{path}", json={}, headers=owner.headers)
            assert r.status_code == 409, r.text
            assert r.json()["error"]["code"] == "gate_blocked"
            assert r.json()["error"]["message"] == "Discovery completeness (G2) must be satisfied first"


async def test_performance_is_only_started_from_performance(setup: Any) -> None:
    ctx, client, owner, _ = setup
    for pid in (await _new(client, owner), await _at_g2(ctx, client, owner)):
        r = await client.post(f"{API}/projects/{pid}/stages/performance/run", json={}, headers=owner.headers)
        assert r.status_code == 422, r.text
        assert r.json()["error"]["message"] == "Start a performance run from Performance"
    assert (await Orchestrator(ctx).advance(system_scope(owner.org_id), pid)).count(StageKey.performance) == 0


async def test_discovery_rerun_marks_checks_stale_and_keeps_the_scan(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid = await _at_g2(ctx, client, owner)
    run_id = await _set_stage(ctx, owner, pid, StageKey.accessibility, StageStatus.completed, {"scan": "A11Y-0001"})
    await _set_stage(ctx, owner, pid, StageKey.security_assessment, StageStatus.completed, {"scan": "SEC-0001"})
    async with ctx.session_factory() as s:
        s.add(
            QualityScan(
                organisation_id=owner.org_id,
                project_id=pid,
                key="A11Y-0001",
                kind=QualityScanKind.accessibility,
                stage_run_id=run_id,
                status=QualityScanStatus.completed,
                summary={"findings": 2},
            )
        )
        await s.commit()
    r = await client.post(f"{API}/projects/{pid}/stages/discovery/run", json={}, headers=owner.headers)
    assert r.status_code == 202, r.text
    for key in (StageKey.accessibility, StageKey.security_assessment):
        st = await _stage(ctx, pid, key)
        assert st.status == StageStatus.stale and st.stale_reason == "Pages changed after this check"
        assert st.current_stage_run_id is not None
    wf = (await client.get(f"{API}/projects/{pid}/workflow", headers=owner.headers)).json()
    a11y = next(s for s in wf["stages"] if s["key"] == "accessibility")
    assert a11y["status"] == "stale" and a11y["stale_reason"] == "Pages changed after this check"
    assert next(s for s in wf["stages"] if s["key"] == "performance")["status"] == "not_started"
    async with ctx.session_factory() as s:
        scan = (await s.execute(select(QualityScan).execution_options(**BYPASS))).scalar_one()
    assert scan.key == "A11Y-0001" and scan.summary == {"findings": 2}


async def test_changed_g4_approval_marks_profiles_stale(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid = await _at_g2(ctx, client, owner)
    run_id = await _set_stage(ctx, owner, pid, StageKey.test_strategy, StageStatus.approved, {})
    async with ctx.session_factory() as s:
        for key, status in (("PRF-01", PerfProfileStatus.ready), ("PRF-02", PerfProfileStatus.retired)):
            s.add(
                PerformanceProfile(
                    organisation_id=owner.org_id,
                    project_id=pid,
                    key=key,
                    name="Load",
                    stages=[{"duration_s": 30, "target_vus": 10}],
                    max_rps=20,
                    targets=[{"path": "/", "weight": 1}],
                    status=status,
                )
            )
        previous = GateDecision(
            organisation_id=owner.org_id,
            project_id=pid,
            gate_key=GateKey.G4,
            stage_run_id=run_id,
            decision=GateDecisionKind.approve,
            comment="ok",
            decided_by=owner.user_id,
            snapshot_hash="a" * 64,
        )
        s.add(previous)
        await s.commit()
    async with ctx.session_factory() as s:
        from app.db.models import Project
        from app.db.tenant import bind_scope

        bind_scope(s, system_scope(owner.org_id))
        project = (await s.execute(select(Project).where(Project.id == pid))).scalar_one()
        orch = Orchestrator(ctx)
        await orch._mark_changed_downstream(s, project, StageKey.test_strategy, "a" * 64, previous)  # same: no-op
        await s.flush()
        assert {p.status for p in (await s.execute(select(PerformanceProfile))).scalars()} == {
            PerfProfileStatus.ready,
            PerfProfileStatus.retired,
        }
        await orch._mark_changed_downstream(s, project, StageKey.test_strategy, "b" * 64, previous)
        await s.commit()
    async with ctx.session_factory() as s:
        rows = {p.key: p for p in (await s.execute(select(PerformanceProfile).execution_options(**BYPASS))).scalars()}
    assert rows["PRF-01"].status == PerfProfileStatus.stale
    assert rows["PRF-01"].stale_reason == "The test strategy changed after this profile was written"
    assert rows["PRF-02"].status == PerfProfileStatus.retired


async def test_new_stage_endpoints_are_404_for_another_organisation(setup: Any) -> None:
    ctx, client, owner, other = setup
    pid = await _at_g2(ctx, client, owner)
    for key in P5_STAGES:
        r = await client.post(f"{API}/projects/{pid}/stages/{key}/run", json={}, headers=other.headers)
        assert r.status_code == 404, (key, r.text)
        r = await client.post(f"{API}/projects/{pid}/stages/{key}/cancel", json={}, headers=other.headers)
        assert r.status_code == 404, (key, r.text)
    assert (await client.get(f"{API}/projects/{pid}/workflow", headers=other.headers)).status_code == 404


async def test_health_reports_tools(setup: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.automation import tools

    ctx, client, _owner, _ = setup
    tools._cache.clear()
    monkeypatch.setattr(tools.shutil, "which", lambda _name: None)  # this machine: no k6, no Docker
    body = (await client.get("/api/v1/health")).json()
    assert set(body["tools"]) == {"loadgen", "axe", "k6", "docker"}
    assert body["tools"]["k6"] is None and body["tools"]["docker"] is None
    # P5-02: axe-core is the version automation/package-lock.json pins, read from automation/node_modules.
    lock = json.loads((ctx.settings.automation_dir / "package-lock.json").read_text())
    assert body["tools"]["axe"] == lock["packages"]["node_modules/axe-core"]["version"]
    assert body["egress_proxy"] == "off"  # design P5 open question 5: the true state until P5-05a
    tk = await ctx.toolkit.version()
    assert body["tools"]["loadgen"] == (tk.loadgen if tk is not None else None)
    tools._cache.clear()


async def test_load_ceiling_default_for_new_organisations(setup: Any) -> None:
    ctx, _client, owner, _ = setup
    async with ctx.session_factory() as s:
        org = (await s.execute(select(Organisation).where(Organisation.id == owner.org_id))).scalar_one()
    assert (
        org.settings
        == {"load_ceiling": DEFAULT_CEILING.as_dict()}
        == {"load_ceiling": {"vus": 20, "rps": 20, "duration_s": 300}}
    )


# ------------------------------------------------------------------ migration 0017 on a database with Phase 4 data

P4_DATA_TABLES = ("projects", "workflow_stages", "stage_runs", "gate_decisions", "execution_runs",
                  "execution_results", "approvals", "defects", "evidence", "qa_reports", "audit_logs")  # fmt: skip


async def _phase4_rows(ctx: AppContext, owner: Account, pid: uuid.UUID) -> None:
    async with ctx.session_factory() as s:
        common = {"organisation_id": owner.org_id, "project_id": pid}
        run = ExecutionRun(**common, key="RUN-0001", totals={"passed": 1, "failed": 1})
        s.add(run)
        await s.flush()
        result = ExecutionResult(
            **common,
            execution_run_id=run.id,
            key="RUN-0001-01",
            case_lineage_id=uuid.uuid4(),
            status=ResultStatus.failed,
        )
        s.add(result)
        await s.flush()
        s.add(
            Approval(
                **common,
                key="APR-0001",
                kind=ApprovalKind.external_transaction,
                execution_run_id=run.id,
                expires_at=utcnow() + timedelta(hours=24),
            )
        )
        s.add(
            Defect(
                **common,
                key="DEF-0001",
                summary="Contact form accepts an empty message",
                severity=DefectSeverity.major,
                severity_derived=DefectSeverity.major,
                priority=Priority.high,
                priority_derived=Priority.high,
                execution_result_id=result.id,
            )
        )
        s.add(
            Evidence(
                **common,
                kind=EvidenceKind.screenshot,
                storage_key="x/shot.png",
                mime="image/png",
                size=3,
                sha256="0" * 64,
                captured_at=utcnow(),
                execution_result_id=result.id,
            )
        )
        s.add(QaReport(**common, report_type=ReportType.execution, version=1, content={"totals": {"failed": 1}}))
        await s.commit()


async def _columns(ctx: AppContext) -> dict[str, list[str]]:
    async with ctx.engine.connect() as conn:
        return {t: [r[1] for r in await conn.execute(text(f"PRAGMA table_info({t})"))] for t in P4_DATA_TABLES}


async def _snapshot(ctx: AppContext, columns: dict[str, list[str]]) -> dict[str, list[tuple[Any, ...]]]:
    """Every row of the Phase 4 tables, on the Phase 4 columns only (0017 adds nullable columns)."""
    async with ctx.engine.connect() as conn:
        return {
            t: sorted(tuple(r) for r in (await conn.execute(text(f"SELECT {', '.join(cols)} FROM {t}"))).all())  # noqa: S608
            for t, cols in columns.items()
        }


async def test_migration_keeps_phase4_data_and_sets_the_ceiling(tmp_path: Path, template_db: Path) -> None:
    shutil.copy(template_db, tmp_path / "qa.db")
    ctx = _ctx(tmp_path)
    async with client_for(ctx) as client:
        owner = await register(client, "mig5@example.com", org="Mig5 Org")
        pid = uuid.UUID((await create_project(client, owner))["id"])
    await _phase4_rows(ctx, owner, pid)
    assert await _tables(ctx) >= P5_TABLES
    await downgrade(ctx.engine, "0016")  # now a Phase 4 database with data
    assert not (P5_TABLES & await _tables(ctx))
    async with ctx.engine.connect() as conn:
        keys = {r[0] for r in await conn.execute(text("SELECT stage_key FROM workflow_stages"))}
        cols = {r[1] for r in await conn.execute(text("PRAGMA table_info(organisations)"))}
    assert "accessibility" not in keys and "settings" not in cols
    columns = await _columns(ctx)
    before = await _snapshot(ctx, columns)
    assert all(
        before[t] for t in ("execution_runs", "execution_results", "approvals", "defects", "evidence", "qa_reports")
    )
    await upgrade(ctx.engine)
    assert await _tables(ctx) >= P5_TABLES
    assert await _snapshot(ctx, columns) == before  # runs, results, approvals, defects, evidence, reports unchanged
    async with ctx.engine.connect() as conn:
        ev = str((await conn.execute(text("SELECT sql FROM sqlite_master WHERE name = 'evidence'"))).scalar_one())
        settings = [r[0] for r in await conn.execute(text("SELECT settings FROM organisations"))]
    assert "'perf_summary'" in ev and "ck_evidence_evidence_kind" in ev and "fk_evidence_quality_scan_id" in ev
    assert settings and all('"load_ceiling"' in s and '"vus": 20' in s for s in settings)
    # The app's startup data step (main.lifespan; httpx's ASGI transport doesn't run lifespan) adds the stage rows.
    assert await ensure_stage_rows(ctx) == 2
    async with client_for(ctx) as client:
        login = await client.post(
            "/api/v1/auth/login", json={"email": owner.email, "password": "correct-horse-battery"}
        )
        headers = {"Authorization": f"Bearer {login.json()['token']}"}
        wf = (await client.get(f"/api/v1/projects/{pid}/workflow", headers=headers)).json()
        p5 = {s["key"]: s["status"] for s in wf["stages"] if s["phase"] == 5}
        assert p5 == dict.fromkeys(P5_STAGES, "not_started")
        r = await client.get(f"/api/v1/projects/{pid}/execution-runs", headers=headers)
        assert r.status_code == 200 and [x["key"] for x in r.json()["items"]] == ["RUN-0001"]
    assert await ensure_stage_rows(ctx) == 0  # idempotent
    await downgrade(ctx.engine, "base")
    await upgrade(ctx.engine)
    assert await _tables(ctx) >= P5_TABLES
    await ctx.close()


async def test_downgrade_removes_phase5_rows(tmp_path: Path, template_db: Path) -> None:
    shutil.copy(template_db, tmp_path / "qa.db")
    ctx = _ctx(tmp_path)
    async with client_for(ctx) as client:
        owner = await register(client, "mig5b@example.com", org="Mig5b Org")
        pid = uuid.UUID((await create_project(client, owner))["id"])
    run_id = await _set_stage(ctx, owner, pid, StageKey.accessibility, StageStatus.completed, {})
    async with ctx.session_factory() as s:
        scan = QualityScan(
            organisation_id=owner.org_id, project_id=pid, key="A11Y-0001", kind=QualityScanKind.accessibility,
            stage_run_id=run_id,
        )  # fmt: skip
        s.add(scan)
        await s.flush()
        s.add(
            Evidence(
                organisation_id=owner.org_id,
                project_id=pid,
                kind=EvidenceKind.security_headers,
                storage_key="x/h.json",
                mime="application/json",
                size=2,
                sha256="0" * 64,
                captured_at=utcnow(),
                quality_scan_id=scan.id,
            )
        )
        await s.commit()
    await downgrade(ctx.engine, "0016")
    async with ctx.engine.connect() as conn:
        assert int((await conn.execute(text("SELECT COUNT(*) FROM evidence"))).scalar_one()) == 0
        keys = {r[0] for r in await conn.execute(text("SELECT stage_key FROM stage_runs"))}
    assert "accessibility" not in keys
    await upgrade(ctx.engine)
    await ctx.close()
