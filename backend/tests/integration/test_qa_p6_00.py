"""QA P6-00: independent checks on the Phase 6 foundation, beyond the developer's test_p6_foundation.py.

Covers: downgrade of 0019 with realistic Phase 6 rows (a change analysis stage run with its agent task), the
"finished run" rule (cancelled and errored runs don't count, passed does), advance() never queuing release
readiness even once its handler is ready, change analysis queued once per rescan and before G2 is decided,
member/viewer/unauthenticated access to the new endpoints, and cross-tenant 404 on reads of the new stages and G9.
"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import select, text

from app.context import AppContext
from app.db.migrate import downgrade, upgrade
from app.db.models import AgentTask, ChangeSet, ExecutionRun, Membership, ScanSession, WorkflowStage
from app.db.tenant import BYPASS, system_scope
from app.db.types import utcnow
from app.domain.enums import ChangeSetStatus, GateStatus, Role, RunStatus, StageKey, StageStatus
from app.orchestrator import orchestrator as orch_mod
from app.orchestrator.orchestrator import Orchestrator
from app.services.projects import ensure_stage_rows
from tests.conftest import Account, client_for, create_project, register
from tests.integration.test_p4_migrations import _ctx
from tests.integration.test_p5_foundation import _at_g2, _set_stage, _stage, _tasks
from tests.integration.test_p6_foundation import KEPT, _finish_discovery, _rescan, _states, _through_automation

API = "/api/v1"
RELEASE_409 = "Run the tests first: release readiness needs execution results"


@pytest.fixture
async def setup(api_ctx: AppContext) -> Any:
    async with client_for(api_ctx) as c:
        owner = await register(c, "owner@qa-p6.example.com", org="QA P6 Org")
        other = await register(c, "other@qa-p6.example.com", org="QA P6 Other")
        yield api_ctx, c, owner, other


async def _as_role(
    ctx: AppContext, client: httpx.AsyncClient, owner: Account, email: str, role: Role
) -> dict[str, str]:
    acct = await register(client, email, org=f"tmp {email}")
    async with ctx.session_factory() as s:
        m = (
            await s.execute(select(Membership).where(Membership.user_id == acct.user_id).execution_options(**BYPASS))
        ).scalar_one()
        m.organisation_id, m.role = owner.org_id, role
        await s.commit()
    login = await client.post(f"{API}/auth/login", json={"email": acct.email, "password": "correct-horse-battery"})
    return {"Authorization": f"Bearer {login.json()['token']}"}


async def _add_run(ctx: AppContext, owner: Account, pid: uuid.UUID, key: str, status: RunStatus) -> None:
    async with ctx.session_factory() as s:
        s.add(
            ExecutionRun(
                organisation_id=owner.org_id,
                project_id=pid,
                key=key,
                status=status,
                finished_at=utcnow() if status not in (RunStatus.awaiting_authorisation, RunStatus.queued) else None,
            )
        )
        await s.commit()


# ------------------------------------------------------------------ release readiness: what counts as finished


async def test_qa_cancelled_and_errored_runs_do_not_count_passed_does(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid = await _through_automation(ctx, client, owner)
    for i, st in enumerate((RunStatus.cancelled, RunStatus.error, RunStatus.rejected, RunStatus.running), start=1):
        await _add_run(ctx, owner, pid, f"RUN-000{i}", st)
    r = await client.post(f"{API}/projects/{pid}/release-assessments", headers=owner.headers)
    assert r.status_code == 409 and r.json()["error"]["message"] == RELEASE_409
    await _add_run(ctx, owner, pid, "RUN-0009", RunStatus.passed)
    r = await client.post(f"{API}/projects/{pid}/release-assessments", headers=owner.headers)
    assert r.status_code == 422, r.text
    assert (await _stage(ctx, pid, StageKey.release_readiness)).status == StageStatus.not_started


async def test_qa_member_reaches_release_check_viewer_and_anonymous_do_not(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid = await _through_automation(ctx, client, owner)
    member = await _as_role(ctx, client, owner, "member@qa-p6.example.com", Role.member)
    viewer = await _as_role(ctx, client, owner, "viewer@qa-p6.example.com", Role.viewer)
    r = await client.post(f"{API}/projects/{pid}/release-assessments", headers=member)
    assert r.status_code == 409 and r.json()["error"]["message"] == RELEASE_409  # a member may create assessments
    r = await client.post(f"{API}/projects/{pid}/exploratory-sessions", json={}, headers=member)
    assert r.status_code == 422  # member may start anonymous sessions (stub until P6-03a)
    for path in ("stages/release_readiness/run", "stages/change_analysis/run", "stages/exploratory/run"):
        r = await client.post(f"{API}/projects/{pid}/{path}", json={}, headers=viewer)
        assert r.status_code == 403, (path, r.text)
    for path in ("release-assessments", "exploratory-sessions", "stages/release_readiness/run"):
        r = await client.post(f"{API}/projects/{pid}/{path}", json={})
        assert r.status_code == 401, (path, r.text)


async def test_qa_advance_never_queues_release_readiness_even_when_ready(
    setup: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    ctx, client, owner, _ = setup
    pid = await _through_automation(ctx, client, owner)
    await _add_run(ctx, owner, pid, "RUN-0001", RunStatus.passed)
    ready = type("Release", (orch_mod.NotAvailableYet,), {"story": "P6-05a", "implemented": True})
    monkeypatch.setitem(orch_mod.PHASE4_HANDLERS, StageKey.release_readiness, ready)
    for _ in range(2):
        assert StageKey.release_readiness not in await Orchestrator(ctx).advance(system_scope(owner.org_id), pid)
    assert "release" not in " ".join(await _tasks(ctx, pid))
    # With the handler ready, the endpoint queues it on request.
    r = await client.post(f"{API}/projects/{pid}/stages/release_readiness/run", json={}, headers=owner.headers)
    assert r.status_code == 202, r.text


# ------------------------------------------------------------------ change analysis: once per rescan, before G2


async def test_qa_change_analysis_queued_once_per_rescan_before_g2(setup: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    ctx, client, owner, _ = setup
    ready = type("ChangeAnalysis", (orch_mod.NotAvailableYet,), {"story": "P6-01", "implemented": True})
    monkeypatch.setitem(orch_mod.PHASE4_HANDLERS, StageKey.change_analysis, ready)
    pid = await _through_automation(ctx, client, owner)
    await _rescan(ctx, owner, pid, rescan=True)
    await _finish_discovery(ctx, pid)
    # The rescan's G2 is not decided yet: change analysis still runs (its change set is reviewed at G2).
    async with ctx.session_factory() as s:
        st = (
            await s.execute(
                select(WorkflowStage)
                .where(WorkflowStage.project_id == pid, WorkflowStage.stage_key == StageKey.discovery)
                .execution_options(**BYPASS)
            )
        ).scalar_one()
        st.status, st.gate_status = StageStatus.awaiting_approval, GateStatus.pending
        from app.db.models import Project

        proj = (await s.execute(select(Project).where(Project.id == pid).execution_options(**BYPASS))).scalar_one()
        proj.approval_policy = {**proj.approval_policy, "G2": "required"}
        await s.commit()
    first = await Orchestrator(ctx).advance(system_scope(owner.org_id), pid)
    assert first.count(StageKey.change_analysis) == 1
    assert not set(KEPT) & set(first)
    # Mark it done, then advance again: not queued a second time for the same rescan.
    await _set_stage(ctx, owner, pid, StageKey.change_analysis, StageStatus.completed, {})
    async with ctx.session_factory() as s:
        disc = (
            await s.execute(
                select(WorkflowStage)
                .where(WorkflowStage.project_id == pid, WorkflowStage.stage_key == StageKey.discovery)
                .execution_options(**BYPASS)
            )
        ).scalar_one()
        from app.db.models import StageRun

        cur = (
            (
                await s.execute(
                    select(StageRun)
                    .where(
                        StageRun.workflow_stage_id.in_(
                            select(WorkflowStage.id).where(
                                WorkflowStage.project_id == pid, WorkflowStage.stage_key == StageKey.change_analysis
                            )
                        )
                    )
                    .order_by(StageRun.version.desc())
                    .execution_options(**BYPASS)
                )
            )
            .scalars()
            .first()
        )
        assert cur is not None
        drun = (await s.execute(select(StageRun).where(StageRun.id == disc.current_stage_run_id)
                                .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        cur.upstream_versions = {"discovery": drun.version}
        await s.commit()
    assert StageKey.change_analysis not in await Orchestrator(ctx).advance(system_scope(owner.org_id), pid)


async def test_qa_two_rescans_in_a_row_keep_approved_work(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid = await _through_automation(ctx, client, owner)
    before = await _states(ctx, pid)
    for _ in range(2):
        await _rescan(ctx, owner, pid, rescan=True)
        await _finish_discovery(ctx, pid)
        await Orchestrator(ctx).advance(system_scope(owner.org_id), pid)
    after = await _states(ctx, pid)
    assert all(after[k] == before[k] for k in KEPT)
    async with ctx.session_factory() as s:
        scans = (
            (await s.execute(select(ScanSession).where(ScanSession.project_id == pid).execution_options(**BYPASS)))
            .scalars()
            .all()
        )
    assert len(scans) == 2 and all(x.is_rescan for x in scans)  # earlier sessions are kept


# ------------------------------------------------------------------ tenant isolation on reads of the new stages


async def test_qa_other_org_gets_404_on_reads_and_g9(setup: Any) -> None:
    ctx, client, owner, other = setup
    pid = await _through_automation(ctx, client, owner)
    for key in ("change_analysis", "exploratory", "release_readiness"):
        r = await client.get(f"{API}/projects/{pid}/stages/{key}/runs", headers=other.headers)
        assert r.status_code == 404, (key, r.text)
        r = await client.get(f"{API}/projects/{pid}/stages/{key}/runs/1", headers=other.headers)
        assert r.status_code == 404, (key, r.text)
    r = await client.post(
        f"{API}/projects/{pid}/gates/G9/decision",
        json={"decision": "approve", "comment": "", "stage_run_version": 1},
        headers=other.headers,
    )
    assert r.status_code == 404, r.text
    r = await client.post(f"{API}/projects/{uuid.uuid4()}/release-assessments", headers=owner.headers)
    assert r.status_code == 404


# ------------------------------------------------------------------ 0019 downgrade with Phase 6 rows


async def test_qa_downgrade_with_a_change_analysis_task(tmp_path: Path, template_db: Path) -> None:
    """A real change analysis run has an agent task (and its change set points at the stage run). Downgrade must
    not leave dangling foreign keys."""
    shutil.copy(template_db, tmp_path / "qa.db")
    ctx = _ctx(tmp_path)
    async with client_for(ctx) as client:
        owner = await register(client, "qa-mig6@example.com", org="QA Mig6 Org")
        pid = uuid.UUID((await create_project(client, owner))["id"])
    disc = await _set_stage(ctx, owner, pid, StageKey.discovery, StageStatus.approved, {"pages": 3})
    await ensure_stage_rows(ctx)
    ca = await _set_stage(ctx, owner, pid, StageKey.change_analysis, StageStatus.completed, {})
    async with ctx.session_factory() as s:
        common = {"organisation_id": owner.org_id, "project_id": pid}
        base = ScanSession(**common, stage_run_id=disc, key="SCAN-0001", sequence=1, start_url="https://x.test/")
        s.add(base)
        await s.flush()
        target = ScanSession(**common, stage_run_id=disc, key="SCAN-0002", sequence=2, start_url="https://x.test/",
                             is_rescan=True, baseline_scan_session_id=base.id)  # fmt: skip
        s.add(target)
        await s.flush()
        s.add(ChangeSet(**common, key="CHG-0001", stage_run_id=ca, base_scan_session_id=base.id,
                        target_scan_session_id=target.id, status=ChangeSetStatus.completed))  # fmt: skip
        s.add(AgentTask(**common, stage_run_id=ca, agent_key="change"))
        await s.commit()
    await downgrade(ctx.engine, "0018")  # raises "Migration left n dangling foreign key(s)" if the task is left
    async with ctx.engine.connect() as conn:
        keys = {r[0] for r in await conn.execute(text("SELECT stage_key FROM stage_runs"))}
    assert "change_analysis" not in keys
    await upgrade(ctx.engine)
    await ctx.close()


async def test_qa_unknown_and_new_stage_keys_on_workflow(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid = await _at_g2(ctx, client, owner)
    wf = (await client.get(f"{API}/projects/{pid}/workflow", headers=owner.headers)).json()
    keys = [s["key"] for s in wf["stages"]]
    assert keys.count("change_analysis") == 1 and keys.count("exploratory") == 1
    stages = {s["key"]: s for s in wf["stages"]}
    assert stages["change_analysis"]["gate"] is None and stages["exploratory"]["gate"] is None
    print("G9 gate:", stages["release_readiness"]["gate"])
    assert stages["release_readiness"]["gate"]["key"] == "G9"


async def test_qa_plain_rerun_after_a_change_analysis(setup: Any) -> None:
    """Observation: a plain discovery re-run marks a finished change analysis stale (nothing re-queues it)."""
    ctx, client, owner, _ = setup
    pid = await _through_automation(ctx, client, owner)
    await _set_stage(ctx, owner, pid, StageKey.change_analysis, StageStatus.completed, {})
    await _rescan(ctx, owner, pid, rescan=True)
    assert (await _stage(ctx, pid, StageKey.change_analysis)).status == StageStatus.completed
    await _finish_discovery(ctx, pid)
    await _rescan(ctx, owner, pid, rescan=False)
    st = await _stage(ctx, pid, StageKey.change_analysis)
    print("change_analysis after plain re-run:", st.status, st.stale_reason)
