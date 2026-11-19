"""QA P6-01: independent API/state-machine probes beyond the developer's test_p6_changes_api.py.

Covers: a cancelled rescan (design P6 §5 "cancel a rescan: finished pages kept; no change set", §20 OQ2), concurrent
comparisons of the same pair (no duplicate), a stuck rescan set and retrying the same pair, a member comparing, a
rescan while a scan is running, compare_with from another project, unauthenticated access, and the viewer's
read-only access to every read endpoint.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import pytest
from sqlalchemy import select

from app.context import AppContext
from app.db.models import AgentTask, ChangeSet, DiscoveredPage, Project, ScanSession, StageRun, WorkflowStage
from app.db.tenant import BYPASS, bind_scope, system_scope
from app.db.types import utcnow
from app.domain.enums import ChangeSetStatus, Role, ScanStatus, StageKey, StageStatus
from app.orchestrator.orchestrator import Orchestrator
from app.services import changes as svc
from tests.conftest import client_for, register, worker_for
from tests.integration.test_p5_foundation import _stage
from tests.integration.test_p6_changes_api import (
    CONTACT_V1,
    CONTACT_V2,
    _as_role,
    _page,
    _project,
    _scan,
    _two_scans,
)

API = "/api/v1"


@pytest.fixture
async def setup(api_ctx: AppContext) -> Any:
    async with client_for(api_ctx) as c:
        owner = await register(c, "owner@qa-p6-01.example.com", org="QA P6-01 Org")
        other = await register(c, "other@qa-p6-01.example.com", org="QA P6-01 Other")
        yield api_ctx, c, owner, other


async def _finish_rescan(ctx: AppContext, pid: uuid.UUID, scan_id: str, pages: list[dict[str, Any]], owner: Any,
                         *, scan_status: ScanStatus, stage_status: StageStatus) -> None:  # fmt: skip
    async with ctx.session_factory() as s:
        scan = (await s.execute(select(ScanSession).where(ScanSession.id == uuid.UUID(scan_id))
                                .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        scan.status = scan_status
        for i, p in enumerate(pages):
            s.add(DiscoveredPage(organisation_id=owner.org_id, project_id=pid, scan_session_id=scan.id, sequence=i + 1,
                                 title="x", **p))  # fmt: skip
        st = (await s.execute(select(WorkflowStage).where(WorkflowStage.project_id == pid,
              WorkflowStage.stage_key == StageKey.discovery).execution_options(**BYPASS))).scalar_one()  # fmt: skip
        run = (await s.execute(select(StageRun).where(StageRun.id == st.current_stage_run_id)
                               .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        run.status, run.output = stage_status, {"pages": len(pages)}
        run.started_at = run.finished_at = utcnow()
        st.status = stage_status
        await s.commit()


async def test_qa_cancelled_rescan_produces_no_change_set_and_no_false_removals(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid, base = await _project(client, owner)
    v1 = [_page(base, "/"), _page(base, "/contact", **CONTACT_V1), _page(base, "/about", headings=["About"])]
    await _scan(ctx, owner, pid, v1, g2=True)
    r = await client.post(f"{API}/projects/{pid}/rescans", json={}, headers=owner.headers)
    assert r.status_code == 202, r.text
    # The person cancels after the first page: Scan 2 is `cancelled` with one page.
    await _finish_rescan(ctx, pid, r.json()["scan"]["id"], [_page(base, "/")], owner,
                         scan_status=ScanStatus.cancelled, stage_status=StageStatus.cancelled)  # fmt: skip
    await Orchestrator(ctx).advance(system_scope(owner.org_id), pid)
    async with ctx.session_factory() as s:
        tasks = list((await s.execute(select(AgentTask).where(AgentTask.project_id == pid, AgentTask.agent_key == "change")
                                      .execution_options(**BYPASS))).scalars())  # fmt: skip
    for t in tasks:
        await Orchestrator(ctx).run_task(system_scope(owner.org_id), t.id, None)
    sets = (await client.get(f"{API}/projects/{pid}/changes", headers=owner.headers)).json()["items"]
    removed: list[str] = []
    for cs in sets:
        items = (await client.get(f"{API}/change-sets/{cs['id']}/items", headers=owner.headers)).json()["items"]
        removed += [i["subject"] for i in items if i["kind"] == "page_removed"]
    assert removed == [], f"cancelled rescan reported {removed} as removed (sets: {[s['key'] for s in sets]})"
    assert sets == [], "design P6 §5: cancelling a rescan keeps its pages but makes no change set"


async def test_qa_concurrent_compare_of_the_same_pair_makes_one_set(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid, _, s1, s2 = await _two_scans(ctx, client, owner)
    body = {"from_scan_id": str(s1.id), "to_scan_id": str(s2.id)}
    rs = await asyncio.gather(*[client.post(f"{API}/projects/{pid}/changes", json=body, headers=owner.headers)
                                for _ in range(4)])  # fmt: skip
    assert all(r.status_code in (200, 202) for r in rs), [r.text for r in rs]
    async with ctx.session_factory() as s:
        n = len(list((await s.execute(select(ChangeSet).where(ChangeSet.project_id == pid)
                                      .execution_options(**BYPASS))).scalars()))  # fmt: skip
    assert n == 1, f"{n} change sets for one pair"


async def test_qa_stuck_set_blocks_comparing_the_same_pair_again(setup: Any) -> None:
    """Documents the developer's known gap: a set left `running` (interrupted stage task) is returned forever."""
    ctx, client, owner, _ = setup
    pid, _, s1, s2 = await _two_scans(ctx, client, owner)
    body = {"from_scan_id": str(s1.id), "to_scan_id": str(s2.id)}
    r = await client.post(f"{API}/projects/{pid}/changes", json=body, headers=owner.headers)
    async with ctx.session_factory() as s:
        cs = (await s.execute(select(ChangeSet).where(ChangeSet.id == uuid.UUID(r.json()["change_set"]["id"]))
                              .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        cs.status = ChangeSetStatus.running  # as if a worker died mid-compare
        await s.commit()
    again = await client.post(f"{API}/projects/{pid}/changes", json=body, headers=owner.headers)
    assert again.status_code == 200 and again.json()["change_set"]["status"] == "running"


async def test_qa_member_compares_viewer_reads_everything(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid, _, s1, s2 = await _two_scans(ctx, client, owner)
    member = await _as_role(ctx, client, owner, "m@qa-p6-01.example.com", Role.member)
    viewer = await _as_role(ctx, client, owner, "v@qa-p6-01.example.com", Role.viewer)
    body = {"from_scan_id": str(s1.id), "to_scan_id": str(s2.id)}
    r = await client.post(f"{API}/projects/{pid}/changes", json=body, headers=member)
    assert r.status_code == 202, r.text
    await worker_for(ctx).run_until_idle(timeout=60)
    cs = r.json()["change_set"]
    for path in (f"/projects/{pid}/scans", f"/projects/{pid}/changes", f"/change-sets/{cs['id']}",
                 f"/change-sets/{cs['id']}/items", f"/projects/{pid}/change-sets/{cs['key']}"):  # fmt: skip
        assert (await client.get(f"{API}{path}", headers=viewer)).status_code == 200, path
        assert (await client.get(f"{API}{path}")).status_code == 401, path
    assert (await client.post(f"{API}/projects/{pid}/changes", json=body)).status_code == 401
    assert (await client.post(f"{API}/projects/{pid}/rescans", json={})).status_code == 401


async def test_qa_same_scan_twice_and_cancelled_scans_are_422(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid, base, s1, _ = await _two_scans(ctx, client, owner)
    same = {"from_scan_id": str(s1.id), "to_scan_id": str(s1.id)}
    assert (await client.post(f"{API}/projects/{pid}/changes", json=same, headers=owner.headers)).status_code == 422
    cancelled = await _scan(ctx, owner, pid, [_page(base, "/")], status=ScanStatus.cancelled)
    body = {"from_scan_id": str(s1.id), "to_scan_id": str(cancelled.id)}
    assert (await client.post(f"{API}/projects/{pid}/changes", json=body, headers=owner.headers)).status_code == 422


async def test_qa_compare_with_from_another_project_is_404_and_starts_nothing(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid, base = await _project(client, owner)
    await _scan(ctx, owner, pid, [_page(base, "/")], g2=True)
    pid2, base2 = await _project(client, owner)
    foreign = await _scan(ctx, owner, pid2, [_page(base2, "/")], g2=True)
    r = await client.post(f"{API}/projects/{pid}/rescans", json={"compare_with": str(foreign.id)},
                          headers=owner.headers)  # fmt: skip
    assert r.status_code == 404, r.text
    # And a change set key of project 2 is not readable under project 1.
    s1 = await _scan(ctx, owner, pid2, [_page(base2, "/"), _page(base2, "/contact", **CONTACT_V2)])
    body = {"from_scan_id": str(foreign.id), "to_scan_id": str(s1.id)}
    assert (await client.post(f"{API}/projects/{pid2}/changes", json=body, headers=owner.headers)).status_code == 202
    assert (await client.get(f"{API}/projects/{pid}/change-sets/CHG-0001", headers=owner.headers)).status_code == 404


async def test_qa_second_rescan_while_one_runs_is_409(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid, base = await _project(client, owner)
    await _scan(ctx, owner, pid, [_page(base, "/")], g2=True)
    assert (await client.post(f"{API}/projects/{pid}/rescans", json={}, headers=owner.headers)).status_code == 202
    r = await client.post(f"{API}/projects/{pid}/rescans", json={}, headers=owner.headers)
    assert r.status_code == 409, r.text
    async with ctx.session_factory() as s:
        n = len(list((await s.execute(select(ScanSession).where(ScanSession.project_id == pid)
                                      .execution_options(**BYPASS))).scalars()))  # fmt: skip
    assert n == 2


# ------------------------------------------------------------------ round 2: the real reaper path (QA #7)


async def test_qa_reaper_marks_interrupted_rescan_set_failed_and_the_pair_can_be_compared_again(setup: Any) -> None:
    """A worker dies while `change_analysis` computes: the queue's reaper (Worker.reap_once → on_job_interrupted) fails
    the task, the stage and the set; comparing the same pair afterwards creates a new set instead of returning the
    stuck one."""
    from datetime import timedelta

    from app.db.models import Job
    from app.domain.enums import JobStatus

    ctx, client, owner, _ = setup
    pid, base = await _project(client, owner)
    v1 = [_page(base, "/"), _page(base, "/contact", **CONTACT_V1)]
    first = await _scan(ctx, owner, pid, v1, g2=True)
    r = await client.post(f"{API}/projects/{pid}/rescans", json={}, headers=owner.headers)
    assert r.status_code == 202, r.text
    scan_id = r.json()["scan"]["id"]
    await _finish_rescan(ctx, pid, scan_id, [_page(base, "/"), _page(base, "/contact", **CONTACT_V2)], owner,
                         scan_status=ScanStatus.completed, stage_status=StageStatus.completed)  # fmt: skip
    assert StageKey.change_analysis in await Orchestrator(ctx).advance(system_scope(owner.org_id), pid)
    async with ctx.session_factory() as s:
        task = (await s.execute(select(AgentTask).where(AgentTask.project_id == pid, AgentTask.agent_key == "change")
                                .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        job = (await s.execute(select(Job).where(Job.payload["task_id"].as_string() == str(task.id))
                               .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        # The worker claimed it on its last attempt and started the set, then the process died.
        job.status, job.attempts, job.max_attempts = JobStatus.running, 1, 1
        job.heartbeat_at = utcnow() - timedelta(hours=1)
        job.locked_by = "dead-worker"
        project = (await s.execute(select(Project).where(Project.id == pid).execution_options(**BYPASS))).scalar_one()
        await s.commit()
    async with ctx.session_factory() as s:
        bind_scope(s, system_scope(owner.org_id))
        project = (await s.execute(select(Project).where(Project.id == pid))).scalar_one()
        target = (await s.execute(select(ScanSession).where(ScanSession.id == uuid.UUID(scan_id)))).scalar_one()
        base_scan = (await s.execute(select(ScanSession).where(ScanSession.id == first.id))).scalar_one()
        cs = await svc.create_set(s, project, base_scan, target, stage_run_id=task.stage_run_id)
        cs.status = ChangeSetStatus.running
        await s.commit()
        stuck_id = cs.id
    await worker_for(ctx).reap_once()
    async with ctx.session_factory() as s:
        cs = (
            await s.execute(select(ChangeSet).where(ChangeSet.id == stuck_id).execution_options(**BYPASS))
        ).scalar_one()
        assert cs.status == ChangeSetStatus.failed and cs.error == "interrupted"
    assert (await _stage(ctx, pid, StageKey.change_analysis)).status == StageStatus.failed
    body = {"from_scan_id": str(first.id), "to_scan_id": scan_id}
    again = await client.post(f"{API}/projects/{pid}/changes", json=body, headers=owner.headers)
    assert again.status_code == 202 and again.json()["created"] is True, again.text
    await worker_for(ctx).run_until_idle(timeout=60)
    new = (await client.get(f"{API}/change-sets/{again.json()['change_set']['id']}", headers=owner.headers)).json()
    assert new["status"] == "completed" and new["key"] == "CHG-0002" and new["summary"]["total"] >= 2
    old = (await client.get(f"{API}/change-sets/{stuck_id}", headers=owner.headers)).json()
    assert old["status"] == "failed"  # history kept
