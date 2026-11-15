"""P5-01b Performance Testing Agent against the Phase 5 fixture site (real built-in load generator, AI off).

Covers: drafting a profile (G4 first; requirement thresholds can only be tightened; limits 422 naming the limit);
a request sends nothing to the site; only approvers decide, with the host typed exactly, and the approval is used
once; a run that misses a requirement threshold fails and drafts one defect (D20), and a second run adds an
occurrence instead; the kill switch aborts a run on errors without drafting; "Stop now" ends a run within about two
seconds with thresholds "Not measured"; a run found `running` after a restart becomes `error`; other organisations
get 404; the k6 export is labelled as not run by the platform.
"""

from __future__ import annotations

import asyncio
import contextvars
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.dml import UpdateBase

from app.agents.performance.runner import WORKER_STOPPED, LoadTestJob
from app.automation.loadgen import LoadGenerator
from app.context import AppContext
from app.db.models import Approval, Defect, Evidence, Membership, PerformanceRun
from app.db.tenant import BYPASS, system_scope
from app.domain.enums import ApprovalStatus, DefectSource, EvidenceKind, PerfRunStatus, Role, StageKey, StageStatus
from app.domain.performance.profile import ms_text
from tests.conftest import Account, CtxFactory, client_for, public_resolver, register, site_transport, worker_for
from tests.fixtures.p5_site import P5Site, running_p5_site
from tests.integration.p5_helpers import API, seed_site, stage_run

REQ = "The slow page loads in under 200 ms for every visitor"
SHORT = [{"duration_s": 3, "target_vus": 2}]


@pytest.fixture
async def env(
    make_ctx: CtxFactory,
) -> AsyncIterator[tuple[AppContext, httpx.AsyncClient, Account, Account, str, P5Site]]:
    ctx = await make_ctx(resolver=public_resolver(), transport=site_transport(), allow_private_targets=True)
    with running_p5_site() as (base, site):
        async with client_for(ctx) as c:
            owner = await register(c, "owner@p5p.example.com", org="P5 Perf")
            other = await register(c, "other@p5p.example.com", org="Other Org")
            yield ctx, c, owner, other, base, site


async def _join(
    ctx: AppContext, client: httpx.AsyncClient, owner: Account, role: Role, can_approve: bool
) -> dict[str, str]:
    """A second person in the owner's organisation; returns their auth headers."""
    acc = await register(client, f"{role.value}-{uuid.uuid4().hex[:6]}@p5p.example.com", org="Spare Org")
    async with ctx.session_factory() as s:
        m = (await s.execute(select(Membership).where(Membership.user_id == acc.user_id)
                             .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        m.organisation_id, m.role, m.can_approve = owner.org_id, role, can_approve
        await s.commit()
    login = await client.post(f"{API}/auth/login", json={"email": acc.email, "password": "correct-horse-battery"})
    return {"Authorization": f"Bearer {login.json()['token']}"}


async def _ready_profile(client: httpx.AsyncClient, owner: Account, pid: str, *, stages: list[dict[str, int]],
                         paths: list[str] | None = None) -> dict[str, Any]:  # fmt: skip
    r = await client.post(f"{API}/projects/{pid}/performance-profiles", json={"type": "load"}, headers=owner.headers)
    assert r.status_code == 201, r.text
    prof = r.json()
    patch: dict[str, Any] = {"version": prof["version"], "stages": stages, "think_time_ms": {"min": 50, "max": 100}}
    if paths is not None:
        patch["targets"] = [{"path": p, "weight": 1} for p in paths]
    r = await client.patch(f"{API}/performance-profiles/{prof['id']}", json=patch, headers=owner.headers)
    assert r.status_code == 200, r.text
    r = await client.post(f"{API}/performance-profiles/{prof['id']}/ready", headers=owner.headers)
    assert r.status_code == 200, r.text
    return dict(r.json())


async def _approved_run(
    client: httpx.AsyncClient, owner: Account, pid: str, profile_id: str, host: str
) -> dict[str, Any]:
    r = await client.post(f"{API}/projects/{pid}/performance-runs",
                          json={"profile_id": profile_id, "approve": True, "confirm_text": host},
                          headers=owner.headers)  # fmt: skip
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "queued"
    return dict(r.json())


async def test_profile_draft_needs_g4_and_respects_requirement_and_limits(env: Any) -> None:
    ctx, client, owner, _other, base, _site = env
    project = await seed_site(ctx, client, owner, base, ["/", "/perf/slow"], requirement=(REQ, ["/perf/slow"]))
    r = await client.post(f"{API}/projects/{project['id']}/performance-profiles", json={}, headers=owner.headers)
    assert r.status_code == 409
    assert r.json()["error"]["message"] == "Load profiles use the approved Test Strategy. Approve Gate 4 first."
    await stage_run(ctx, owner.org_id, uuid.UUID(project["id"]), StageKey.test_strategy, StageStatus.approved, {})
    r = await client.post(f"{API}/projects/{project['id']}/performance-profiles", json={}, headers=owner.headers)
    assert r.status_code == 201, r.text
    prof = r.json()
    assert prof["key"] == "PRF-01" and prof["status"] == "draft" and prof["generated_by"] == "rules"
    assert {t["path"] for t in prof["targets"]} == {"/", "/perf/slow"}
    slow = next(t for t in prof["thresholds"] if t.get("path") == "/perf/slow")
    assert slow["value"] == 200 and slow["source"]["key"] == "REQ-0012"
    assert any(t["metric"] == "error_rate" and t["value"] == 0.01 for t in prof["thresholds"])
    # A requirement threshold can be tightened, never loosened.
    loosened = [dict(t, value=500) if t is slow or t.get("path") == "/perf/slow" else t for t in prof["thresholds"]]
    r = await client.patch(f"{API}/performance-profiles/{prof['id']}",
                           json={"version": prof["version"], "thresholds": loosened}, headers=owner.headers)  # fmt: skip
    assert r.status_code == 422
    assert r.json()["error"]["message"] == "This threshold comes from REQ-0012. Change the requirement to change it."
    # Over the organisation ceiling: 422 naming the limit; the ceiling itself stays within the server cap.
    r = await client.patch(f"{API}/performance-profiles/{prof['id']}",
                           json={"version": prof["version"], "stages": [{"duration_s": 30, "target_vus": 10_000}]},
                           headers=owner.headers)  # fmt: skip
    assert r.status_code == 422 and "users" in r.json()["error"]["message"]
    hard = ctx.settings.load_hard_cap
    r = await client.patch(f"{API}/organisations/{owner.org_id}/settings",
                           json={"load_ceiling": {"vus": hard.vus + 1, "rps": 5, "duration_s": 60}},
                           headers=owner.headers)  # fmt: skip
    assert r.status_code == 422 and r.json()["error"]["message"] == f"This server allows up to {hard.vus}."
    # Version history: the old version is readable.
    r = await client.patch(f"{API}/performance-profiles/{prof['id']}",
                           json={"version": prof["version"], "stages": SHORT}, headers=owner.headers)  # fmt: skip
    assert r.status_code == 200 and r.json()["version"] > prof["version"]
    old = await client.get(f"{API}/performance-profiles/{prof['id']}?v={prof['version']}", headers=owner.headers)
    assert old.json()["read_only"] is True and old.json()["stages"] == prof["stages"]


async def test_approval_rules_and_a_failed_run_drafts_one_defect(env: Any) -> None:
    ctx, client, owner, other, base, site = env
    project = await seed_site(ctx, client, owner, base, ["/", "/perf/slow"], g4=True, requirement=(REQ, ["/perf/slow"]))
    pid, host = project["id"], "127.0.0.1"
    prof = await _ready_profile(client, owner, pid, stages=SHORT, paths=["/perf/slow"])
    # Thresholds follow the targets: "/" was removed, so its p95 threshold went with it.
    assert {t.get("path") for t in prof["thresholds"]} == {"/perf/slow", None}
    member = await _join(ctx, client, owner, Role.member, False)
    site.requests.clear()
    r = await client.post(f"{API}/projects/{pid}/performance-runs", json={"profile_id": prof["id"]}, headers=member)
    assert r.status_code == 201, r.text
    run = r.json()
    assert run["status"] == "awaiting_approval" and run["approval"]["status"] == "pending"
    assert run["summary"].startswith("Up to 2 virtual users")
    assert prof["request_preview"]["summary"] == run["summary"]  # the dialog shows what the request will say
    assert run["permissions"]["can_approve"] is False and run["permissions"]["can_withdraw"] is True
    await worker_for(ctx).run_until_idle(timeout=30)
    assert site.requests == []  # nothing was sent to the site while waiting for approval
    aid = run["approval"]["id"]
    r = await client.post(f"{API}/approvals/{aid}/decision", json={"decision": "approve", "confirm_text": host},
                          headers=member)  # fmt: skip
    assert r.status_code == 403
    r = await client.post(f"{API}/approvals/{aid}/decision", json={"decision": "approve", "confirm_text": "localhost"},
                          headers=owner.headers)  # fmt: skip
    assert r.status_code == 422 and r.json()["error"]["message"] == f"Type {host} exactly to approve."
    r = await client.post(f"{API}/approvals/{aid}/decision", json={"decision": "reject"}, headers=owner.headers)
    assert r.status_code == 422 and r.json()["error"]["message"] == "Say why this load test shouldn't run."
    r = await client.post(f"{API}/approvals/{aid}/decision", json={"decision": "approve", "confirm_text": host},
                          headers=owner.headers)  # fmt: skip
    assert r.status_code == 200 and r.json()["status"] == "queued" and r.json()["approval"]["host_typed"] is True
    # Other organisations see nothing.
    assert (await client.get(f"{API}/performance-runs/{run['id']}", headers=other.headers)).status_code == 404
    assert (await client.get(f"{API}/performance-profiles/{prof['id']}", headers=other.headers)).status_code == 404
    await worker_for(ctx).run_until_idle(timeout=120)
    done = (await client.get(f"{API}/performance-runs/{run['id']}", headers=owner.headers)).json()
    assert done["status"] == "failed", (done["error"], done["aborted_reason"])
    assert done["approval"]["status"] == "used"
    assert done["engine"]["version"]
    slow = next(t for t in done["threshold_results"] if t.get("path") == "/perf/slow")
    assert slow["result"] == "missed" and slow["measured"] >= 200
    assert {m for m, _ in site.requests} == {"GET"} and {p for _, p in site.requests} == {"/perf/slow"}
    assert [d["status"] for d in done["defects"]] == ["draft"]
    async with ctx.session_factory() as s:
        drafts = (await s.execute(select(Defect).where(Defect.source == DefectSource.performance)
                                  .execution_options(**BYPASS))).scalars().all()  # fmt: skip
        assert len(drafts) == 1 and drafts[0].environment["threshold_key"] == "p95|/perf/slow"
        kinds = {e.kind for e in (await s.execute(select(Evidence).where(
            Evidence.performance_run_id == uuid.UUID(run["id"])).execution_options(**BYPASS))).scalars()}  # fmt: skip
        assert kinds == {EvidenceKind.perf_summary, EvidenceKind.perf_timeseries}
    # The approval was used once: deciding it again is refused.
    r = await client.post(f"{API}/approvals/{aid}/decision", json={"decision": "approve", "confirm_text": host},
                          headers=owner.headers)  # fmt: skip
    assert r.status_code == 409
    # A second run missing the same threshold adds an occurrence to the open draft.
    second = await _approved_run(client, owner, pid, prof["id"], host)
    await worker_for(ctx).run_until_idle(timeout=120)
    async with ctx.session_factory() as s:
        drafts = (await s.execute(select(Defect).where(Defect.source == DefectSource.performance)
                                  .execution_options(**BYPASS))).scalars().all()  # fmt: skip
        assert len(drafts) == 1 and len(drafts[0].environment["occurrences"]) == 2
        latest = drafts[0].environment["occurrences"][-1]["measured"]
    # P5-BUG-06: the second run links the defect it added to, and the summary carries the latest measurement.
    again = (await client.get(f"{API}/performance-runs/{second['id']}", headers=owner.headers)).json()
    assert [(d["key"], d["link"]) for d in again["defects"]] == [(drafts[0].key, "occurrence_added")]
    assert ms_text(latest) in drafts[0].summary and ms_text(latest) in drafts[0].actual
    first = (await client.get(f"{API}/performance-runs/{run['id']}", headers=owner.headers)).json()
    assert [d["link"] for d in first["defects"]] == ["drafted"]
    # The k6 export says it isn't run by the platform.
    r = await client.get(f"{API}/performance-runs/{run['id']}/k6-script", headers=owner.headers)
    assert r.status_code == 200 and r.headers["X-Not-Run-By-Platform"] == "true"
    assert "/perf/slow" in r.text


async def test_errors_abort_the_run_without_a_draft(make_ctx: CtxFactory) -> None:
    ctx = await make_ctx(resolver=public_resolver(), transport=site_transport(), allow_private_targets=True)
    with running_p5_site(errors=True) as (base, _site):
        async with client_for(ctx) as client:
            owner = await register(client, "owner@p5e.example.com", org="P5 Errors")
            project = await seed_site(ctx, client, owner, base, ["/"], g4=True)
            prof = await _ready_profile(client, owner, project["id"], stages=[{"duration_s": 40, "target_vus": 2}])
            run = await _approved_run(client, owner, project["id"], prof["id"], "127.0.0.1")
            t0 = time.monotonic()
            await worker_for(ctx).run_until_idle(timeout=120)
            assert time.monotonic() - t0 < 30  # the kill switch fired after its warm-up, long before 40 s
            done = (await client.get(f"{API}/performance-runs/{run['id']}", headers=owner.headers)).json()
    assert done["status"] == "aborted", done
    assert done["aborted_reason"].startswith("Stopped automatically:")  # no successful response, or too many errors
    assert done["defects"] == []
    assert all(t["result"] == "not_measured" for t in done["threshold_results"])


async def test_stop_now_ends_the_run_within_two_seconds(env: Any) -> None:
    ctx, client, owner, _other, base, _site = env
    project = await seed_site(ctx, client, owner, base, ["/"], g4=True)
    prof = await _ready_profile(client, owner, project["id"], stages=[{"duration_s": 60, "target_vus": 2}])
    run = await _approved_run(client, owner, project["id"], prof["id"], "127.0.0.1")
    worker = asyncio.create_task(worker_for(ctx).run_until_idle(timeout=120))
    for _ in range(100):
        cur = (await client.get(f"{API}/performance-runs/{run['id']}", headers=owner.headers)).json()
        if cur["status"] == "running" and cur["live"]:
            break
        await asyncio.sleep(0.2)
    assert cur["status"] == "running", cur
    t0 = time.monotonic()
    r = await client.post(f"{API}/performance-runs/{run['id']}/stop", headers=owner.headers)
    assert r.status_code == 200, r.text
    await worker
    assert time.monotonic() - t0 < 4  # 0.5 s poll + the generator's 2 s stop, plus storing the results
    done = (await client.get(f"{API}/performance-runs/{run['id']}", headers=owner.headers)).json()
    assert done["status"] == "stopped" and done["stopped_by"] is not None
    assert all(t["result"] == "not_measured" for t in done["threshold_results"])
    assert done["defects"] == []


async def test_a_stop_landing_inside_a_progress_write_is_never_lost(env: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """R3-BUG-01: "Stop now" commits after a progress write has started and before it writes; the stop still wins."""
    ctx, client, owner, _other, base, _site = env
    project = await seed_site(ctx, client, owner, base, ["/"], g4=True)
    prof = await _ready_profile(client, owner, project["id"], stages=[{"duration_s": 60, "target_vus": 2}])
    run = await _approved_run(client, owner, project["id"], prof["id"], "127.0.0.1")
    in_progress: contextvars.ContextVar[bool] = contextvars.ContextVar("in_progress", default=False)
    fired: list[httpx.Response] = []

    async def stop_now() -> None:  # once, from inside the first progress write, before it writes anything
        if in_progress.get() and not fired:
            token = in_progress.set(False)  # the API's own session isn't the progress write
            try:
                fired.append(await client.post(f"{API}/performance-runs/{run['id']}/stop", headers=owner.headers))
            finally:
                in_progress.reset(token)

    real_execute, real_commit, real_progress = AsyncSession.execute, AsyncSession.commit, LoadTestJob._progress

    async def execute(self: AsyncSession, statement: Any, *a: Any, **kw: Any) -> Any:
        if isinstance(statement, UpdateBase):
            await stop_now()
        return await real_execute(self, statement, *a, **kw)

    async def commit(self: AsyncSession) -> None:  # an ORM read-modify-write would flush here
        await stop_now()
        await real_commit(self)

    async def progress(self: LoadTestJob, *a: Any) -> None:
        token = in_progress.set(True)
        try:
            await real_progress(self, *a)
        finally:
            in_progress.reset(token)

    seen: dict[str, Any] = {}
    real_run = LoadGenerator.run

    async def gen_run(self: Any, config: Any, workdir: Any, **kw: Any) -> Any:
        result = await real_run(self, config, workdir, **kw)
        seen.update(stop_set=kw["stop"].is_set(), status=result.status)
        return result

    monkeypatch.setattr(AsyncSession, "execute", execute)
    monkeypatch.setattr(AsyncSession, "commit", commit)
    monkeypatch.setattr(LoadTestJob, "_progress", progress)
    monkeypatch.setattr(LoadGenerator, "run", gen_run)
    t0 = time.monotonic()
    await asyncio.wait_for(LoadTestJob(ctx, system_scope(owner.org_id), uuid.UUID(run["id"])).run(), timeout=30)
    assert fired, "the stop never landed inside a progress write"
    assert fired[0].status_code == 200, fired[0].text
    assert time.monotonic() - t0 < 15  # the 60 s profile was cut short
    done = (await client.get(f"{API}/performance-runs/{run['id']}", headers=owner.headers)).json()
    assert seen == {"stop_set": True, "status": "stopped"}, done["error"]  # the generator got the stop
    assert done["status"] == "stopped", done
    assert done["status_label"] == "Stopped by Ada Tester"
    assert done["error"] is None and done["stopped_by"] is not None
    assert done["live"] is not None  # the progress write still landed beside the stop


async def test_a_run_left_running_by_a_restart_becomes_error(env: Any) -> None:
    ctx, client, owner, _other, base, site = env
    project = await seed_site(ctx, client, owner, base, ["/"], g4=True)
    prof = await _ready_profile(client, owner, project["id"], stages=SHORT)
    run = await _approved_run(client, owner, project["id"], prof["id"], "127.0.0.1")
    async with ctx.session_factory() as s:
        row = (await s.execute(select(PerformanceRun).where(PerformanceRun.id == uuid.UUID(run["id"]))
                               .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        row.status = PerfRunStatus.running
        a = (await s.execute(select(Approval).where(Approval.performance_run_id == row.id)
                             .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        a.status = ApprovalStatus.used
        await s.commit()
    site.requests.clear()
    await LoadTestJob(ctx, system_scope(owner.org_id), uuid.UUID(run["id"])).run()
    done = (await client.get(f"{API}/performance-runs/{run['id']}", headers=owner.headers)).json()
    assert done["status"] == "error" and done["error"] == WORKER_STOPPED
    assert site.requests == []
