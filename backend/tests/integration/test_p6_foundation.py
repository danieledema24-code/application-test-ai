"""P6-00 Phase 6 foundation: the rescan staleness rule (decision D27), the new `change_analysis` (automatic after a
rescan only) and `exploratory` (optional, after G2, never through the stage endpoint) stages, `release_readiness`
on request once a test run has finished, G9 per assessment, migration 0019 on a database with Phase 5 data (up, down,
up; the default exploration ceiling; the startup step that adds the new stage rows), the backend fixture site's
release 2, and tenant isolation for the new stage keys and endpoints.

Projects are put at "G2 approved" (and further) directly in the database, as in test_p5_foundation.py.
"""

from __future__ import annotations

import json
import os
import shutil
import uuid
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import select, text

from app.context import AppContext
from app.db.migrate import downgrade, upgrade
from app.db.models import (
    ChangeSet,
    Defect,
    ExecutionResult,
    ExecutionRun,
    Membership,
    Organisation,
    PerformanceProfile,
    PerformanceRun,
    QualityFinding,
    QualityScan,
    ScanSession,
    StageRun,
    WorkflowStage,
)
from app.db.tenant import BYPASS, system_scope
from app.db.types import utcnow
from app.domain.enums import (
    ChangeSetStatus,
    DefectSource,
    FindingSeverity,
    PerfRunStatus,
    QualityScanKind,
    QualityScanStatus,
    Role,
    RunStatus,
    StageKey,
    StageStatus,
)
from app.domain.stages import STAGE_BY_KEY
from app.orchestrator import orchestrator as orch_mod
from app.orchestrator.orchestrator import Orchestrator
from app.services.projects import ensure_stage_rows
from tests.conftest import Account, client_for, create_project, register
from tests.fixtures.site import running_site
from tests.integration.test_p4_migrations import _ctx, _tables
from tests.integration.test_p5_foundation import _at_g2, _new, _phase4_rows, _set_stage, _stage, _tasks

API = "/api/v1"
P6_STAGES = ("change_analysis", "exploratory")
P6_TABLES = {"change_sets", "change_items", "impact_items", "heal_suggestions", "exploratory_steps",
             "release_assessments"}  # fmt: skip
# Approved through G2…G6 before a rescan: none of these may go stale or move (D27).
KEPT = (StageKey.requirements, StageKey.readiness_criteria, StageKey.test_strategy, StageKey.test_design,
        StageKey.automation_assessment, StageKey.automation)  # fmt: skip
RELEASE_409 = "Run the tests first: release readiness needs execution results"


@pytest.fixture
async def setup(api_ctx: AppContext) -> Any:
    async with client_for(api_ctx) as c:
        owner = await register(c, "owner@p6.example.com", org="P6 Org")
        other = await register(c, "other@p6.example.com", org="Other P6 Org")
        yield api_ctx, c, owner, other


async def _through_automation(ctx: AppContext, client: httpx.AsyncClient, owner: Account) -> uuid.UUID:
    """A project past G2 with approved requirements, strategy, cases and scripts, and finished a11y/security checks."""
    pid = await _at_g2(ctx, client, owner)
    for key in KEPT:
        gated = key in (StageKey.requirements, StageKey.test_strategy, StageKey.test_design, StageKey.automation)
        run_id = await _set_stage(ctx, owner, pid, key, StageStatus.approved if gated else StageStatus.completed, {})
        async with ctx.session_factory() as s:  # built from version 1 of each upstream, as real runs record
            run = (
                await s.execute(select(StageRun).where(StageRun.id == run_id).execution_options(**BYPASS))
            ).scalar_one()
            run.upstream_versions = {u.value: 1 for u in STAGE_BY_KEY[key].upstream}
            await s.commit()
    for key in (StageKey.accessibility, StageKey.security_assessment):
        await _set_stage(ctx, owner, pid, key, StageStatus.completed, {"scan": key.value})
    return pid


async def _states(ctx: AppContext, pid: uuid.UUID) -> dict[StageKey, tuple[StageStatus, uuid.UUID | None, str | None]]:
    async with ctx.session_factory() as s:
        rows = (
            await s.execute(select(WorkflowStage).where(WorkflowStage.project_id == pid).execution_options(**BYPASS))
        ).scalars()
        return {r.stage_key: (r.status, r.current_stage_run_id, r.stale_reason) for r in rows}


async def _rescan(ctx: AppContext, owner: Account, pid: uuid.UUID, *, rescan: bool) -> None:
    # P6-01 adds POST /rescans; the orchestrator rule is what P6-00 delivers (`parameters.rescan`).
    params = {"rescan": True} if rescan else None
    await Orchestrator(ctx).request_run(system_scope(owner.org_id), pid, StageKey.discovery, parameters=params,
                                        reason=None)  # fmt: skip


async def _finish_discovery(ctx: AppContext, pid: uuid.UUID) -> None:
    """Marks the queued discovery run finished with pages (no browser: the scan itself is covered elsewhere)."""
    async with ctx.session_factory() as s:
        st = (
            await s.execute(
                select(WorkflowStage)
                .where(WorkflowStage.project_id == pid, WorkflowStage.stage_key == StageKey.discovery)
                .execution_options(**BYPASS)
            )
        ).scalar_one()
        run = (await s.execute(select(StageRun).where(StageRun.id == st.current_stage_run_id).execution_options(
            **BYPASS))).scalar_one()  # fmt: skip
        run.status = StageStatus.completed
        run.output = {"pages": 4}
        run.started_at = run.finished_at = utcnow()
        st.status = StageStatus.completed
        await s.commit()


# ------------------------------------------------------------------ D27: the rescan staleness rule


async def test_rescan_keeps_approved_artefacts_and_marks_checks_stale(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid = await _through_automation(ctx, client, owner)
    before = await _states(ctx, pid)
    await _rescan(ctx, owner, pid, rescan=True)
    after = await _states(ctx, pid)
    for key in KEPT:
        assert after[key] == before[key], key  # same status, same current version, no stale reason
    for key in (StageKey.accessibility, StageKey.security_assessment):
        status, run_id, reason = after[key]
        assert status == StageStatus.stale and reason == "Pages changed after this check"
        assert run_id == before[key][1]  # the check itself stays readable
    assert after[StageKey.discovery][0] == StageStatus.queued
    async with ctx.session_factory() as s:
        scans = (await s.execute(select(ScanSession).where(ScanSession.project_id == pid).execution_options(
            **BYPASS))).scalars().all()  # fmt: skip
    assert [x.is_rescan for x in scans] == [True]
    # When the rescan finishes, advance() regenerates nothing that was approved (impact items say what is affected).
    await _finish_discovery(ctx, pid)
    queued = await Orchestrator(ctx).advance(system_scope(owner.org_id), pid)
    assert not set(KEPT) & set(queued)
    final = await _states(ctx, pid)
    assert all(final[k] == before[k] for k in KEPT)


async def test_plain_discovery_rerun_keeps_todays_staleness(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid = await _through_automation(ctx, client, owner)
    await _rescan(ctx, owner, pid, rescan=False)
    after = await _states(ctx, pid)
    for key in KEPT:
        assert after[key][0] == StageStatus.stale, key
        assert after[key][2] == "Application discovery was re-run (version 2)"
    for key in (StageKey.accessibility, StageKey.security_assessment):
        assert after[key][0] == StageStatus.stale and after[key][2] == "Pages changed after this check"
    async with ctx.session_factory() as s:
        scan = (await s.execute(select(ScanSession).where(ScanSession.project_id == pid).execution_options(
            **BYPASS))).scalar_one()  # fmt: skip
    assert scan.is_rescan is False and scan.baseline_scan_session_id is None


async def test_change_analysis_follows_rescans_only(setup: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    ctx, client, owner, _ = setup
    # With a stub handler (as before P6-01), nothing is queued even after a rescan.
    monkeypatch.setitem(orch_mod.PHASE4_HANDLERS, StageKey.change_analysis, orch_mod._stub("P6-01"))
    pid = await _through_automation(ctx, client, owner)
    await _rescan(ctx, owner, pid, rescan=True)
    await _finish_discovery(ctx, pid)
    assert StageKey.change_analysis not in await Orchestrator(ctx).advance(system_scope(owner.org_id), pid)
    assert (await _stage(ctx, pid, StageKey.change_analysis)).status == StageStatus.not_started
    r = await client.post(f"{API}/projects/{pid}/stages/change_analysis/run", json={}, headers=owner.headers)
    assert r.status_code == 422 and r.json()["error"]["message"] == "Change analysis is not available yet"
    # With a real handler registered (as P6-01 will), a finished rescan queues it once; a plain re-run never does.
    ready = type("ChangeAnalysis", (orch_mod.NotAvailableYet,), {"story": "P6-01", "implemented": True})
    monkeypatch.setitem(orch_mod.PHASE4_HANDLERS, StageKey.change_analysis, ready)
    queued = await Orchestrator(ctx).advance(system_scope(owner.org_id), pid)
    assert queued.count(StageKey.change_analysis) == 1
    assert "change" in await _tasks(ctx, pid)
    plain = await _through_automation(ctx, client, owner)
    await _rescan(ctx, owner, plain, rescan=False)
    await _finish_discovery(ctx, plain)
    assert StageKey.change_analysis not in await Orchestrator(ctx).advance(system_scope(owner.org_id), plain)


# ------------------------------------------------------------------ the new stages and their endpoints


async def test_workflow_lists_the_phase6_stages(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid = await _at_g2(ctx, client, owner)
    queued = await Orchestrator(ctx).advance(system_scope(owner.org_id), pid)
    assert not {StageKey.change_analysis, StageKey.exploratory, StageKey.release_readiness} & set(queued)
    wf = (await client.get(f"{API}/projects/{pid}/workflow", headers=owner.headers)).json()
    p6 = {s["key"]: s for s in wf["stages"] if s["phase"] == 6}
    assert set(p6) == {*P6_STAGES, "release_readiness"}
    assert all(s["available"] and s["status"] == "not_started" for s in p6.values())
    assert p6["release_readiness"]["gate"]["key"] == "G9"


async def test_exploratory_needs_g2_and_never_runs_as_a_stage(setup: Any) -> None:
    ctx, client, owner, _ = setup
    fresh = await _new(client, owner)  # discovery has not finished
    waiting = await _at_g2(ctx, client, owner, approved=False)  # finished, G2 required and not decided
    for pid in (fresh, waiting):
        r = await client.post(f"{API}/projects/{pid}/exploratory-sessions", json={}, headers=owner.headers)
        assert r.status_code == 409, r.text
        assert r.json()["error"]["code"] == "gate_blocked"
        assert r.json()["error"]["message"] == "Discovery completeness (G2) must be satisfied first"
    ready = await _at_g2(ctx, client, owner)
    for pid in (fresh, ready):
        r = await client.post(f"{API}/projects/{pid}/stages/exploratory/run", json={}, headers=owner.headers)
        assert r.status_code == 422, r.text
        assert r.json()["error"]["message"] == "Start an exploratory session from Test Execution"
    # After G2 the endpoint exists but the explorer is P6-03a's: 422, and nothing is queued.
    r = await client.post(
        f"{API}/projects/{ready}/exploratory-sessions", json={"charter": "All discovered pages"}, headers=owner.headers
    )
    assert r.status_code == 422 and r.json()["error"]["message"] == "Exploratory testing is not available yet"
    bad = await client.post(f"{API}/projects/{ready}/exploratory-sessions", json={"x": 1}, headers=owner.headers)
    assert bad.status_code == 422
    assert "exploratory" not in await _tasks(ctx, ready)
    assert (await _stage(ctx, ready, StageKey.exploratory)).status == StageStatus.not_started


async def test_release_readiness_needs_a_finished_run(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid = await _through_automation(ctx, client, owner)
    paths = (f"{API}/projects/{pid}/release-assessments", f"{API}/projects/{pid}/stages/release_readiness/run")
    for path in paths:
        r = await client.post(path, json={}, headers=owner.headers)
        assert r.status_code == 409, r.text
        assert r.json()["error"]["message"] == RELEASE_409
    async with ctx.session_factory() as s:
        common = {"organisation_id": owner.org_id, "project_id": pid}
        s.add(ExecutionRun(**common, key="RUN-0001", status=RunStatus.awaiting_authorisation))
        s.add(ExecutionRun(**common, key="RUN-0002", status=RunStatus.error))
        await s.commit()
    for path in paths:  # waiting for G7 or errored as a whole: no results yet
        assert (await client.post(path, json={}, headers=owner.headers)).status_code == 409
    async with ctx.session_factory() as s:
        s.add(ExecutionRun(**common, key="RUN-0003", status=RunStatus.failed, finished_at=utcnow()))
        await s.commit()
    for path in paths:  # P6-05a lands the assessment; until then nothing is queued
        r = await client.post(path, json={}, headers=owner.headers)
        assert r.status_code == 422, r.text
        assert r.json()["error"]["message"] == "Release readiness assessment is not available yet"
    assert StageKey.release_readiness not in await Orchestrator(ctx).advance(system_scope(owner.org_id), pid)
    assert (await _stage(ctx, pid, StageKey.release_readiness)).status == StageStatus.not_started
    # G9 is decided per release assessment (P6-05a), never through /gates.
    r = await client.post(
        f"{API}/projects/{pid}/gates/G9/decision",
        json={"decision": "approve", "comment": "", "stage_run_version": 1},
        headers=owner.headers,
    )
    assert r.status_code == 422 and r.json()["error"]["message"] == "G9 is decided per release assessment"


async def test_viewers_cannot_start_phase6_work(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid = await _through_automation(ctx, client, owner)
    viewer = await register(client, "viewer@p6.example.com", org="Viewer Org")
    async with ctx.session_factory() as s:
        m = (await s.execute(select(Membership).where(Membership.user_id == viewer.user_id)
                             .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        m.organisation_id, m.role = owner.org_id, Role.viewer
        await s.commit()
    login = await client.post(f"{API}/auth/login", json={"email": viewer.email, "password": "correct-horse-battery"})
    vh = {"Authorization": f"Bearer {login.json()['token']}"}
    for path in ("exploratory-sessions", "release-assessments"):
        r = await client.post(f"{API}/projects/{pid}/{path}", json={}, headers=vh)
        assert r.status_code == 403, (path, r.text)


async def test_new_stages_and_endpoints_are_404_for_another_organisation(setup: Any) -> None:
    ctx, client, owner, other = setup
    pid = await _through_automation(ctx, client, owner)
    for key in (*P6_STAGES, "release_readiness"):
        for action in ("run", "cancel"):
            r = await client.post(f"{API}/projects/{pid}/stages/{key}/{action}", json={}, headers=other.headers)
            assert r.status_code == 404, (key, action, r.text)
    for path in ("exploratory-sessions", "release-assessments"):
        r = await client.post(f"{API}/projects/{pid}/{path}", json={}, headers=other.headers)
        assert r.status_code == 404, (path, r.text)


async def test_new_organisations_get_both_ceilings(setup: Any) -> None:
    ctx, _client, owner, _ = setup
    async with ctx.session_factory() as s:
        org = (await s.execute(select(Organisation).where(Organisation.id == owner.org_id))).scalar_one()
    assert org.settings["exploration_ceiling"] == {"actions": 60, "minutes": 10}
    assert org.settings["load_ceiling"] == {"vus": 20, "rps": 20, "duration_s": 300}


# ------------------------------------------------------------------ backend fixture site, release 2


def test_fixture_site_release_two_covers_the_cases_the_demo_does_not() -> None:
    with running_site() as (url, site):
        v1 = {p: httpx.get(f"{url}{p}").text for p in ("/", "/products/1", "/contact", "/about", "/new-arrivals")}
        site.version = 2  # the test-only switch, read on every request
        v2 = {p: httpx.get(f"{url}{p}").text for p in v1}
        assert httpx.get(f"{url}/new-arrivals").status_code == 200
        site.version = 1
        assert httpx.get(f"{url}/new-arrivals").status_code == 404
    assert "New arrivals" not in v1["/"] and '<a href="/new-arrivals">New arrivals</a>' in v2["/"]
    # Moved: same name and role, new selector.
    assert '<button type="button">Add to basket</button>' in v1["/products/1"]
    assert '<div class="buy"><button type="button" id="add-to-basket">Add to basket</button></div>' in v2["/products/1"]
    # Ambiguous rename: one button becomes two candidates.
    assert ">Opening hours</button>" in v1["/contact"] and ">Opening hours<" not in v2["/contact"]
    assert ">Opening times</button>" in v2["/contact"] and ">Opening days</button>" in v2["/contact"]
    # Cosmetic heading change, and an all-new page.
    assert "<h1>About</h1>" in v1["/about"] and "<h1>About us</h1>" in v2["/about"]
    assert "Nothing here." in v1["/new-arrivals"] and "<h1>New arrivals</h1>" in v2["/new-arrivals"]
    # Changed asserted text (the confirmation after a contact post with the Phase 4 bug on).
    with running_site(version=2) as (url, site):
        site.contact_bug = True
        assert "Thanks, we got your message" in httpx.post(f"{url}/contact", data={"msg": ""}).text
        site.version = 1
        assert '<p class="success">Message sent</p>' in httpx.post(f"{url}/contact", data={"msg": ""}).text


# ------------------------------------------------------------------ migration 0019 on a database with Phase 5 data

P5_DATA_TABLES = ("organisations", "projects", "workflow_stages", "stage_runs", "gate_decisions", "scan_sessions",
                  "execution_runs", "execution_results", "approvals", "defects", "evidence", "qa_reports",
                  "audit_logs", "quality_scans", "quality_findings", "performance_profiles", "performance_runs")  # fmt: skip


async def _phase5_rows(ctx: AppContext, owner: Account, pid: uuid.UUID) -> None:
    await _phase4_rows(ctx, owner, pid)  # a run, a failed result, an approval, DEF-0001, evidence and a report
    await _set_stage(ctx, owner, pid, StageKey.discovery, StageStatus.approved, {"pages": 3})
    async with ctx.session_factory() as s:
        common = {"organisation_id": owner.org_id, "project_id": pid}
        disc = (await s.execute(select(StageRun).where(StageRun.project_id == pid,
                                                       StageRun.stage_key == StageKey.discovery)
                                .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        s.add(ScanSession(**common, stage_run_id=disc.id, key="SCAN-0001", sequence=1, start_url="https://x.test/"))
        result = (await s.execute(select(ExecutionResult).execution_options(**BYPASS))).scalar_one()
        result.heal_suggestions = [{"expression": "getByLabel('Message')", "score": 0.8}]  # Phase 4 heal JSON
        scan = QualityScan(**common, key="A11Y-0001", kind=QualityScanKind.accessibility,
                           status=QualityScanStatus.completed, summary={"findings": 1})  # fmt: skip
        s.add(scan)
        await s.flush()
        s.add(QualityFinding(**common, key="A11Y-0001-01", scan_id=scan.id, kind=QualityScanKind.accessibility,
                             rule_id="image-alt", severity=FindingSeverity.critical, title="Image without alt",
                             url="https://x.test/products/1", fingerprint="f" * 64))  # fmt: skip
        prof = PerformanceProfile(**common, key="PRF-01", name="Load", stages=[{"duration_s": 30, "target_vus": 5}],
                                  max_rps=10, targets=[{"path": "/", "weight": 1}])  # fmt: skip
        s.add(prof)
        await s.flush()
        s.add(PerformanceRun(**common, key="PERF-0001", profile_id=prof.id, profile_hash="a" * 64,
                             status=PerfRunStatus.failed, metrics={"p95": 900}))  # fmt: skip
        s.add(Defect(**common, key="DEF-0002", summary="Image without alt", severity_derived="minor",
                     priority_derived="low", severity="minor", priority="low", source=DefectSource.accessibility))  # fmt: skip
        await s.commit()


async def _columns(ctx: AppContext) -> dict[str, list[str]]:
    async with ctx.engine.connect() as conn:
        return {t: [r[1] for r in await conn.execute(text(f"PRAGMA table_info({t})"))] for t in P5_DATA_TABLES}


async def _snapshot(ctx: AppContext, columns: dict[str, list[str]]) -> dict[str, list[tuple[Any, ...]]]:
    """Every row of the Phase 5 tables, on the Phase 5 columns. `organisations.settings` gains a key in 0019, so it is
    compared without it."""
    async with ctx.engine.connect() as conn:
        out = {}
        for t, cols in columns.items():
            quoted = ", ".join(f'"{c}"' for c in cols)
            rows = (await conn.execute(text(f"SELECT {quoted} FROM {t}"))).mappings().all()  # noqa: S608
            if t == "organisations":
                rows = [{**r, "settings": {k: v for k, v in json.loads(r["settings"]).items()
                                           if k != "exploration_ceiling"}} for r in rows]  # fmt: skip
            out[t] = sorted(repr(sorted(dict(r).items())) for r in rows)
        return out


async def test_migration_keeps_phase5_data_and_sets_the_ceiling(tmp_path: Path, template_db: Path) -> None:
    shutil.copy(template_db, tmp_path / "qa.db")
    ctx = _ctx(tmp_path)
    async with client_for(ctx) as client:
        owner = await register(client, "mig6@example.com", org="Mig6 Org")
        pid = uuid.UUID((await create_project(client, owner))["id"])
    await _phase5_rows(ctx, owner, pid)
    assert await _tables(ctx) >= P6_TABLES
    await downgrade(ctx.engine, "0018")  # now a Phase 5 database with data
    assert not (P6_TABLES & await _tables(ctx))
    async with ctx.engine.connect() as conn:
        keys = {r[0] for r in await conn.execute(text("SELECT stage_key FROM workflow_stages"))}
        settings = [json.loads(r[0]) for r in await conn.execute(text("SELECT settings FROM organisations"))]
    assert not set(P6_STAGES) & keys and all("exploration_ceiling" not in x for x in settings)
    columns = await _columns(ctx)
    assert "is_rescan" not in columns["scan_sessions"] and "quality_scan_id" not in columns["approvals"]
    before = await _snapshot(ctx, columns)
    assert [t for t in P5_DATA_TABLES if not before[t]] == []
    await upgrade(ctx.engine)
    assert await _tables(ctx) >= P6_TABLES
    assert await _snapshot(ctx, columns) == before  # scans, runs, results (with heal JSON), findings, defects, ...
    async with ctx.engine.connect() as conn:
        settings = [json.loads(r[0]) for r in await conn.execute(text("SELECT settings FROM organisations"))]
        heal = (await conn.execute(text("SELECT heal_suggestions FROM execution_results"))).scalar_one()
        rescan = {r[0] for r in await conn.execute(text("SELECT is_rescan FROM scan_sessions"))}
        sql = {
            t: str((await conn.execute(text("SELECT sql FROM sqlite_master WHERE name = :t"), {"t": t})).scalar_one())
            for t in ("quality_scans", "defects", "approvals", "gate_decisions", "stage_runs")
        }
    assert settings and all(x["exploration_ceiling"] == {"actions": 60, "minutes": 10} for x in settings)
    assert all(x["load_ceiling"] == {"vus": 20, "rps": 20, "duration_s": 300} for x in settings)
    assert json.loads(heal) == [{"expression": "getByLabel('Message')", "score": 0.8}]
    assert rescan == {0}
    assert "'exploratory'" in sql["quality_scans"] and "ck_quality_scans_quality_scan_status" in sql["quality_scans"]
    assert "'exploratory'" in sql["defects"] and "'exploratory_session'" in sql["approvals"]
    assert "'release_assessment'" in sql["gate_decisions"] and "'change_analysis'" in sql["stage_runs"]
    assert "fk_approvals_quality_scan_id_quality_scans" in sql["approvals"]
    # The app's startup data step adds the two new stage rows (httpx's ASGI transport doesn't run lifespan).
    assert await ensure_stage_rows(ctx) == 2
    async with client_for(ctx) as client:
        login = await client.post(f"{API}/auth/login", json={"email": owner.email, "password": "correct-horse-battery"})
        headers = {"Authorization": f"Bearer {login.json()['token']}"}
        wf = (await client.get(f"{API}/projects/{pid}/workflow", headers=headers)).json()
        assert {s["key"]: s["status"] for s in wf["stages"] if s["key"] in P6_STAGES} == dict.fromkeys(
            P6_STAGES, "not_started"
        )
        r = await client.get(f"{API}/projects/{pid}/execution-runs", headers=headers)
        assert r.status_code == 200 and [x["key"] for x in r.json()["items"]] == ["RUN-0001"]
    assert await ensure_stage_rows(ctx) == 0  # idempotent
    await downgrade(ctx.engine, "base")
    await upgrade(ctx.engine)
    assert await _tables(ctx) >= P6_TABLES
    await ctx.close()


async def test_downgrade_removes_phase6_rows(tmp_path: Path, template_db: Path) -> None:
    shutil.copy(template_db, tmp_path / "qa.db")
    ctx = _ctx(tmp_path)
    async with client_for(ctx) as client:
        owner = await register(client, "mig6b@example.com", org="Mig6b Org")
        pid = uuid.UUID((await create_project(client, owner))["id"])
    run_id = await _set_stage(ctx, owner, pid, StageKey.discovery, StageStatus.approved, {"pages": 3})
    await ensure_stage_rows(ctx)
    await _set_stage(ctx, owner, pid, StageKey.exploratory, StageStatus.completed, {})
    async with ctx.session_factory() as s:
        common = {"organisation_id": owner.org_id, "project_id": pid}
        base = ScanSession(**common, stage_run_id=run_id, key="SCAN-0001", sequence=1, start_url="https://x.test/")
        s.add(base)
        await s.flush()
        target = ScanSession(**common, stage_run_id=run_id, key="SCAN-0002", sequence=2, start_url="https://x.test/",
                             is_rescan=True, baseline_scan_session_id=base.id)  # fmt: skip
        s.add(target)
        await s.flush()
        s.add(ChangeSet(**common, key="CHG-0001", base_scan_session_id=base.id, target_scan_session_id=target.id,
                        status=ChangeSetStatus.completed))  # fmt: skip
        s.add(QualityScan(**common, key="EXP-0001", kind=QualityScanKind.exploratory))
        await s.commit()
    await downgrade(ctx.engine, "0018")
    async with ctx.engine.connect() as conn:
        assert int((await conn.execute(text("SELECT COUNT(*) FROM quality_scans"))).scalar_one()) == 0
        assert int((await conn.execute(text("SELECT COUNT(*) FROM scan_sessions"))).scalar_one()) == 2
        keys = {r[0] for r in await conn.execute(text("SELECT stage_key FROM stage_runs"))}
    assert "exploratory" not in keys and "discovery" in keys
    await upgrade(ctx.engine)
    await ctx.close()


@pytest.mark.skipif(not os.environ.get("PHASE5_DB"), reason="set PHASE5_DB to a copy of a Phase 5 database")
async def test_migration_on_a_real_phase5_database(tmp_path: Path) -> None:
    """Opt-in: `PHASE5_DB=<a Phase 5 qa.db>` upgrades a copy (the file itself is never touched), down and up again,
    and checks every Phase 5 table keeps its row count."""
    shutil.copy(os.environ["PHASE5_DB"], tmp_path / "qa.db")
    ctx = _ctx(tmp_path)
    tables = [t for t in P5_DATA_TABLES if t != "organisations"]
    async with ctx.engine.connect() as conn:
        assert (await conn.execute(text("SELECT version_num FROM alembic_version"))).scalar_one() == "0018"
        counts = {t: int((await conn.execute(text(f"SELECT COUNT(*) FROM {t}"))).scalar_one()) for t in tables}  # noqa: S608
    await upgrade(ctx.engine)
    await downgrade(ctx.engine, "0018")
    await upgrade(ctx.engine)
    async with ctx.engine.connect() as conn:
        after = {t: int((await conn.execute(text(f"SELECT COUNT(*) FROM {t}"))).scalar_one()) for t in tables}  # noqa: S608
        settings = [json.loads(r[0]) for r in await conn.execute(text("SELECT settings FROM organisations"))]
    assert after == counts
    assert all(x["exploration_ceiling"] == {"actions": 60, "minutes": 10} for x in settings)
    assert await ensure_stage_rows(ctx) >= 0
    await ctx.close()
