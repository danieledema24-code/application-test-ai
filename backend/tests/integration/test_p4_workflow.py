"""P4-00 Phase 4 workflow foundation: automatic assessment/automation after G5, execution never through /stages,
G7/G8 per subject and locked, G5 re-approval marks automation stale, failure analysis per failed run, the derived
defect review stage, the execution stage mirroring its runs, and tenant isolation for the new stage keys.

Projects are put at "G5 approved" directly in the database (the Phase 3 flow is covered end to end in
test_phase3_flow.py); the Phase 4 handlers are replaced by small fakes (the real ones are covered in test_p4_automation.py).
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from datetime import timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy import func, select

from app.agents.phase2 import StageOutcome
from app.context import AppContext
from app.db.models import (
    AgentTask,
    AutomationScript,
    Defect,
    ExecutionResult,
    ExecutionRun,
    GateDecision,
    Project,
    StageRun,
    WorkflowStage,
)
from app.db.tenant import BYPASS, bind_scope, system_scope
from app.db.types import utcnow
from app.domain.enums import (
    DefectSeverity,
    DefectStatus,
    GateDecisionKind,
    GateKey,
    GateStatus,
    GeneratedBy,
    Priority,
    ResultStatus,
    RunStatus,
    ScriptGeneratedBy,
    ScriptStatus,
    StageKey,
    StageStatus,
)
from app.orchestrator import orchestrator as orch_mod
from app.orchestrator.orchestrator import Orchestrator
from app.services import automation as automation_svc
from app.services import execution as xsvc
from app.services import gates as gate_rules
from tests.conftest import Account, client_for, create_project, register, worker_for

API = "/api/v1"
P4_STAGES = ["automation_assessment", "automation", "execution", "failure_analysis", "defects_summary"]
CASES_A = [{"type": "test_case", "id": "case-1", "version": 1}, {"type": "test_case", "id": "case-2", "version": 1}]
CASES_B = [{"type": "test_case", "id": "case-1", "version": 2}, {"type": "test_case", "id": "case-2", "version": 1}]


class _Fake:
    """A Phase 4 handler that completes immediately (counts its runs)."""

    implemented = True
    runs: dict[str, int] = {}  # noqa: RUF012 - shared test counter

    def __init__(self, ctx: Any, scope: Any, *, project_id: uuid.UUID, run_id: uuid.UUID, task_id: uuid.UUID) -> None:
        self.run_id = run_id

    async def run(self) -> StageOutcome:
        name = type(self).__name__
        _Fake.runs[name] = _Fake.runs.get(name, 0) + 1
        return StageOutcome(output={"fake": name}, generated_by=GeneratedBy.rules)


class FakeAssessment(_Fake):
    pass


class FakeAutomation(_Fake):
    pass


class FakeAnalysis(_Fake):
    pass


@pytest.fixture
def handlers(monkeypatch: pytest.MonkeyPatch) -> dict[str, int]:
    _Fake.runs = {}
    monkeypatch.setitem(orch_mod.PHASE4_HANDLERS, StageKey.automation_assessment, FakeAssessment)
    monkeypatch.setitem(orch_mod.PHASE4_HANDLERS, StageKey.automation, FakeAutomation)
    monkeypatch.setitem(orch_mod.PHASE4_HANDLERS, StageKey.failure_analysis, FakeAnalysis)

    async def no_g6_blockers(_s: Any, _project: Any) -> list[gate_rules.Precondition]:
        return []  # the fake bundle has no scripts; P4-04's checks are covered in test_p4_automation.py

    monkeypatch.setattr(automation_svc, "g6_preconditions", no_g6_blockers)
    return _Fake.runs


@pytest.fixture
async def setup(api_ctx: AppContext) -> AsyncIterator[tuple[AppContext, httpx.AsyncClient, Account, Account]]:
    async with client_for(api_ctx) as c:
        owner = await register(c, "owner@p4.example.com", org="P4 Org")
        other = await register(c, "other@p4.example.com", org="Other P4 Org")
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


async def _count(ctx: AppContext, model: Any, *where: Any) -> int:
    async with ctx.session_factory() as s:
        return int(
            (
                await s.execute(select(func.count()).select_from(model).where(*where).execution_options(**BYPASS))
            ).scalar_one()
        )


async def _at_g5(
    ctx: AppContext, client: httpx.AsyncClient, owner: Account, *, g5: StageStatus = StageStatus.approved
) -> uuid.UUID:
    """A project whose Phase 1–3 stages all have output, with test design at `g5` (approved = last G5 approval A)."""
    pid = uuid.UUID((await create_project(client, owner))["id"])
    async with ctx.session_factory() as s:
        stages = {
            st.stage_key: st
            for st in (
                await s.execute(
                    select(WorkflowStage).where(WorkflowStage.project_id == pid).execution_options(**BYPASS)
                )
            ).scalars()
        }
        plan: list[tuple[StageKey, StageStatus, dict[str, int], dict[str, Any]]] = [
            (StageKey.discovery, StageStatus.approved, {}, {"pages": 1}),
            (StageKey.discovery_report, StageStatus.completed, {"discovery": 1}, {}),
            (StageKey.requirements, StageStatus.approved, {"discovery": 1}, {}),
            (StageKey.readiness_criteria, StageStatus.completed, {"requirements": 1}, {}),
            (StageKey.test_strategy, StageStatus.approved, {"requirements": 1}, {}),
            (StageKey.test_design, g5, {"test_strategy": 1}, {}),
        ]
        for key, status, upstream, output in plan:
            st = stages[key]
            run = StageRun(
                organisation_id=owner.org_id,
                workflow_stage_id=st.id,
                project_id=pid,
                stage_key=key,
                version=1,
                status=status,
                upstream_versions=upstream,
                output=output,
                generated_by=GeneratedBy.rules,
                started_at=utcnow(),
                finished_at=utcnow(),
            )
            s.add(run)
            await s.flush()
            st.current_stage_run_id = run.id
            st.status = status
            if st.gate_key is not None:
                st.gate_status = (
                    GateStatus.approved
                    if status == StageStatus.approved
                    else GateStatus.pending
                    if status == StageStatus.awaiting_approval
                    else GateStatus.none
                )
            if key == StageKey.test_design and status == StageStatus.approved:
                s.add(
                    GateDecision(
                        organisation_id=owner.org_id,
                        project_id=pid,
                        gate_key=GateKey.G5,
                        stage_run_id=run.id,
                        decision=GateDecisionKind.approve,
                        comment="OK",
                        decided_by=owner.user_id,
                        artefact_snapshot={"items": CASES_A},
                        snapshot_hash=gate_rules.snapshot_hash(CASES_A),
                        stage_run_versions={"test_design": 1},
                    )
                )
        await s.commit()
    return pid


async def _advance(ctx: AppContext, owner: Account, pid: uuid.UUID) -> list[StageKey]:
    return await Orchestrator(ctx).advance(system_scope(owner.org_id), pid)


async def test_assessment_queued_once_after_g5_then_automation(setup: Any, handlers: dict[str, int]) -> None:
    ctx, client, owner, _ = setup
    pid = await _at_g5(ctx, client, owner)
    assert await _advance(ctx, owner, pid) == [StageKey.automation_assessment]
    assert await _advance(ctx, owner, pid) == []  # no duplicate while queued
    assert (await _stage(ctx, pid, StageKey.automation)).status == StageStatus.not_started
    await worker_for(ctx).run_until_idle(timeout=30)
    assess, auto = await _stage(ctx, pid, StageKey.automation_assessment), await _stage(ctx, pid, StageKey.automation)
    assert assess.status == StageStatus.completed
    # D10 hybrid: a rule-written bundle with nothing blocking completes without a sign-off ("Passed automatically").
    assert auto.status == StageStatus.completed and auto.gate_status == GateStatus.approved
    assert handlers == {"FakeAssessment": 1, "FakeAutomation": 1}
    assert await _advance(ctx, owner, pid) == []
    for key in (StageKey.automation_assessment, StageKey.automation):
        st = await _stage(ctx, pid, key)
        assert await _count(ctx, StageRun, StageRun.workflow_stage_id == st.id) == 1
    async with ctx.session_factory() as s:
        run = (
            await s.execute(
                select(StageRun).where(StageRun.id == auto.current_stage_run_id).execution_options(**BYPASS)
            )
        ).scalar_one()
    assert run.approved_input is not None and run.approved_input["g5_hash"] == gate_rules.snapshot_hash(CASES_A)
    assert run.upstream_versions == {"automation_assessment": 1}
    # Execution is never queued by advance, even with G6 satisfied.
    assert (await _stage(ctx, pid, StageKey.execution)).status == StageStatus.not_started
    assert await _count(ctx, ExecutionRun, ExecutionRun.project_id == pid) == 0


async def test_stubs_are_never_queued(setup: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(orch_mod.PHASE4_HANDLERS, StageKey.automation_assessment, orch_mod._stub("P4-02"))
    monkeypatch.setitem(orch_mod.PHASE4_HANDLERS, StageKey.automation, orch_mod._stub("P4-03a"))
    ctx, client, owner, _ = setup
    pid = await _at_g5(ctx, client, owner)
    assert await _advance(ctx, owner, pid) == []
    r = await client.post(f"{API}/projects/{pid}/stages/automation_assessment/run", json={}, headers=owner.headers)
    assert r.status_code == 422 and r.json()["error"]["message"] == "Automation suitability is not available yet"
    assert await _count(ctx, AgentTask, AgentTask.project_id == pid) == 0


async def test_assessment_needs_g5_approval(setup: Any, handlers: dict[str, int]) -> None:
    ctx, client, owner, _ = setup
    pid = await _at_g5(ctx, client, owner, g5=StageStatus.awaiting_approval)
    r = await client.post(f"{API}/projects/{pid}/stages/automation_assessment/run", json={}, headers=owner.headers)
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "gate_blocked"
    assert r.json()["error"]["message"] == "Test design approval (G5) must be approved first"
    assert await _count(ctx, AgentTask, AgentTask.project_id == pid) == 0
    assert await _advance(ctx, owner, pid) == []


async def test_execution_and_analysis_are_not_run_through_stages(setup: Any, handlers: dict[str, int]) -> None:
    ctx, client, owner, _ = setup
    pid = await _at_g5(ctx, client, owner)
    base = f"{API}/projects/{pid}/stages"
    r = await client.post(f"{base}/execution/run", json={}, headers=owner.headers)
    assert r.status_code == 422 and r.json()["error"]["message"] == "Start a test run from Test Execution"
    r = await client.post(f"{base}/failure_analysis/run", json={}, headers=owner.headers)
    assert r.status_code == 422 and "runs automatically" in r.json()["error"]["message"]
    r = await client.post(f"{base}/defects_summary/run", json={}, headers=owner.headers)
    assert r.status_code == 422 and "computed automatically" in r.json()["error"]["message"]
    # A manual assessment run is fine once G5 is approved.
    r = await client.post(f"{base}/automation_assessment/run", json={}, headers=owner.headers)
    assert r.status_code == 202, r.text
    await worker_for(ctx).run_until_idle(timeout=30)
    assert (await _stage(ctx, pid, StageKey.automation)).status == StageStatus.completed
    assert await _advance(ctx, owner, pid) == []
    assert await _count(ctx, AgentTask, AgentTask.project_id == pid, AgentTask.agent_key == "execution") == 0


async def test_g7_g8_are_locked_and_decided_per_subject(setup: Any) -> None:
    _ctx, client, owner, _ = setup
    project = await create_project(client, owner)
    for gate in ("G7", "G8"):
        for value in ("recommended", "auto"):
            r = await client.patch(
                f"{API}/projects/{project['id']}",
                headers=owner.headers,
                json={"version": project["version"], "approval_policy": {gate: value}},
            )
            assert r.status_code == 422, r.text
            assert gate in r.json()["error"]["details"][0]["message"]
        r = await client.post(
            f"{API}/projects/{project['id']}/gates/{gate}/decision",
            headers=owner.headers,
            json={"decision": "approve", "comment": "OK", "stage_run_version": 1},
        )
        assert r.status_code == 422, r.text
        assert r.json()["error"]["message"] == f"{gate} is decided per {'test run' if gate == 'G7' else 'defect'}"
    assert project["approval_policy"]["G6"] == "recommended"


async def test_g5_reapproval_marks_automation_stale(
    setup: Any, handlers: dict[str, int], monkeypatch: pytest.MonkeyPatch
) -> None:
    ctx, client, owner, _ = setup
    pid = await _at_g5(ctx, client, owner)
    await _advance(ctx, owner, pid)
    await worker_for(ctx).run_until_idle(timeout=30)
    auto = await _stage(ctx, pid, StageKey.automation)
    design = await _stage(ctx, pid, StageKey.test_design)
    async with ctx.session_factory() as s:  # one script in the bundle, then a case edit reopens G5
        tc_run = auto.current_stage_run_id
        assert tc_run is not None
        script = AutomationScript(
            organisation_id=owner.org_id,
            project_id=pid,
            stage_run_id=tc_run,
            test_case_id=await _a_case(s, owner, pid, design),
            case_lineage_id=uuid.uuid4(),
            case_version=1,
            lineage_id=uuid.uuid4(),
            path="tests/contact/TC-0001.spec.ts",
            code="// spec",
            sha256="0" * 64,
            status=ScriptStatus.valid,
            generated_by=ScriptGeneratedBy.rules,
        )
        s.add(script)
        st = (
            await s.execute(select(WorkflowStage).where(WorkflowStage.id == design.id).execution_options(**BYPASS))
        ).scalar_one()
        st.status, st.gate_status = StageStatus.awaiting_approval, GateStatus.pending
        await s.commit()
        script_id = script.id

    async def snapshot(_s: Any, _pid: uuid.UUID, gate: GateKey) -> tuple[list[dict[str, Any]], dict[str, int]]:
        return (CASES_B, {"test_design": 1}) if gate == GateKey.G5 else ([], {})

    async def no_blockers(_s: Any, _p: Any, _gate: GateKey) -> list[Any]:
        return []

    monkeypatch.setattr(gate_rules, "snapshot_for", snapshot)
    monkeypatch.setattr(gate_rules, "preconditions", no_blockers)
    r = await client.post(
        f"{API}/projects/{pid}/gates/G5/decision",
        headers=owner.headers,
        json={"decision": "approve", "comment": "Re-approved after the edit", "stage_run_version": 1},
    )
    assert r.status_code == 200, r.text
    auto = await _stage(ctx, pid, StageKey.automation)
    assert auto.status == StageStatus.stale
    assert auto.stale_reason == "Test cases changed after these scripts were written"
    assert (await _stage(ctx, pid, StageKey.automation_assessment)).status == StageStatus.queued  # re-queued
    wf = (await client.get(f"{API}/projects/{pid}/workflow", headers=owner.headers)).json()
    shown = next(x for x in wf["stages"] if x["key"] == "automation")
    assert shown["status"] == "stale" and shown["stale_reason"] == auto.stale_reason
    async with ctx.session_factory() as s:  # existing scripts stay readable
        assert (
            await s.execute(
                select(AutomationScript).where(AutomationScript.id == script_id).execution_options(**BYPASS)
            )
        ).scalar_one()
    await worker_for(ctx).run_until_idle(timeout=30)
    assert (await _stage(ctx, pid, StageKey.automation)).status == StageStatus.completed
    assert handlers == {"FakeAssessment": 2, "FakeAutomation": 2}


async def _a_case(s: Any, owner: Account, pid: uuid.UUID, design: WorkflowStage) -> uuid.UUID:
    from app.db.models import TestCase
    from app.domain.enums import Provenance

    case = TestCase(
        organisation_id=owner.org_id,
        project_id=pid,
        stage_run_id=design.current_stage_run_id,
        key="TC-0001",
        match_key="m",
        title="Contact form blocks an empty Message",
        test_type="functional",
        test_level="system",
        technique="equivalence_partitioning",
        provenance=Provenance.inferred,
        generated_by=GeneratedBy.rules,
    )
    s.add(case)
    await s.flush()
    return case.id


async def _finished_run(
    ctx: AppContext,
    owner: Account,
    pid: uuid.UUID,
    key: str,
    status: RunStatus,
    results: list[ResultStatus],
    error: str | None = None,
) -> uuid.UUID:
    async with ctx.session_factory() as s:
        n = int(
            (
                await s.execute(
                    select(func.count())
                    .select_from(ExecutionRun)
                    .where(ExecutionRun.project_id == pid)
                    .execution_options(**BYPASS)
                )
            ).scalar_one()
        )
        run = ExecutionRun(
            organisation_id=owner.org_id,
            project_id=pid,
            key=key,
            status=status,
            requested_by=owner.user_id,
            started_at=utcnow() - timedelta(minutes=1),
            finished_at=utcnow(),
            created_at=utcnow() + timedelta(seconds=n),
        )
        s.add(run)
        await s.flush()
        for i, r in enumerate(results, 1):
            s.add(
                ExecutionResult(
                    organisation_id=owner.org_id,
                    project_id=pid,
                    execution_run_id=run.id,
                    key=f"{key}-{i:02d}",
                    case_lineage_id=uuid.uuid4(),
                    status=r,
                    error=error,
                )
            )
        await s.commit()
        return run.id


async def test_failure_analysis_queued_once_per_failed_run(setup: Any, handlers: dict[str, int]) -> None:
    ctx, client, owner, _ = setup
    pid = await _at_g5(ctx, client, owner)
    await _advance(ctx, owner, pid)
    await worker_for(ctx).run_until_idle(timeout=30)
    await _finished_run(ctx, owner, pid, "RUN-0001", RunStatus.passed, [ResultStatus.passed])
    assert await _advance(ctx, owner, pid) == []
    first = await _finished_run(
        ctx, owner, pid, "RUN-0002", RunStatus.failed, [ResultStatus.passed, ResultStatus.failed]
    )
    second = await _finished_run(ctx, owner, pid, "RUN-0003", RunStatus.error, [ResultStatus.error])
    # Stopped by the cancel: not a result, so not analysed (a real failure in a cancelled run is; QA P4-BUG-06).
    await _finished_run(
        ctx, owner, pid, "RUN-0004", RunStatus.cancelled, [ResultStatus.error], error=xsvc.STOPPED_CANCELLED
    )
    assert await _advance(ctx, owner, pid) == [StageKey.failure_analysis]
    assert await _advance(ctx, owner, pid) == []  # one at a time
    await worker_for(ctx).run_until_idle(timeout=30)  # finishing one queues the next
    fa = await _stage(ctx, pid, StageKey.failure_analysis)
    async with ctx.session_factory() as s:
        params = [
            r.parameters.get("execution_run_id")
            for r in (
                await s.execute(
                    select(StageRun)
                    .where(StageRun.workflow_stage_id == fa.id)
                    .order_by(StageRun.version)
                    .execution_options(**BYPASS)
                )
            ).scalars()
        ]
    assert params == [str(first), str(second)] and handlers["FakeAnalysis"] == 2
    assert await _advance(ctx, owner, pid) == []


async def test_defect_review_stage_is_derived_from_drafts(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid = await _at_g5(ctx, client, owner)

    async def shown() -> str:
        wf = (await client.get(f"{API}/projects/{pid}/workflow", headers=owner.headers)).json()
        st = next(x for x in wf["stages"] if x["key"] == "defects_summary")
        assert st["available"] is True
        return str(st["status"])

    assert await shown() == "not_started"
    async with ctx.session_factory() as s:
        d = Defect(
            organisation_id=owner.org_id,
            project_id=pid,
            key="DEF-0001",
            summary="Contact form accepts an empty Message",
            severity=DefectSeverity.major,
            severity_derived=DefectSeverity.major,
            priority=Priority.high,
            priority_derived=Priority.high,
        )
        s.add(d)
        await s.commit()
        did = d.id
    assert await shown() == "awaiting_approval"
    async with ctx.session_factory() as s:
        row = (await s.execute(select(Defect).where(Defect.id == did).execution_options(**BYPASS))).scalar_one()
        row.status = DefectStatus.confirmed
        await s.commit()
    assert await shown() == "completed"


async def test_execution_stage_mirrors_the_latest_run(setup: Any) -> None:
    ctx, client, owner, _ = setup
    pid = await _at_g5(ctx, client, owner)
    orch = Orchestrator(ctx)

    async def mirror(run_id: uuid.UUID, status: RunStatus) -> StageStatus | None:
        async with ctx.session_factory() as s:
            bind_scope(s, system_scope(owner.org_id))
            run = (
                await s.execute(select(ExecutionRun).where(ExecutionRun.id == run_id).execution_options(**BYPASS))
            ).scalar_one()
            project = (
                await s.execute(select(Project).where(Project.id == pid).execution_options(**BYPASS))
            ).scalar_one()
            run.status = status
            if status not in (RunStatus.queued, RunStatus.running):
                run.finished_at = utcnow()
            out = await orch.mirror_execution_run(s, project, run)
            await s.commit()
            return out

    async def new_run(key: str) -> uuid.UUID:
        async with ctx.session_factory() as s:
            run = ExecutionRun(organisation_id=owner.org_id, project_id=pid, key=key, requested_by=owner.user_id)
            s.add(run)
            await s.commit()
            return run.id

    first = await new_run("RUN-0001")
    assert await mirror(first, RunStatus.awaiting_authorisation) is None
    assert (await _stage(ctx, pid, StageKey.execution)).status == StageStatus.not_started
    assert await mirror(first, RunStatus.queued) == StageStatus.queued
    assert await mirror(first, RunStatus.running) == StageStatus.running
    assert await mirror(first, RunStatus.failed) == StageStatus.completed
    second = await new_run("RUN-0002")
    assert await mirror(second, RunStatus.queued) == StageStatus.queued
    assert await mirror(first, RunStatus.error) is None  # an older run never moves the stage
    assert await mirror(second, RunStatus.error) == StageStatus.failed
    st = await _stage(ctx, pid, StageKey.execution)
    async with ctx.session_factory() as s:
        runs = (
            (
                await s.execute(
                    select(StageRun)
                    .where(StageRun.workflow_stage_id == st.id)
                    .order_by(StageRun.version)
                    .execution_options(**BYPASS)
                )
            )
            .scalars()
            .all()
        )
    assert [(r.version, r.parameters["run_key"]) for r in runs] == [(1, "RUN-0001"), (2, "RUN-0002")]
    assert st.current_stage_run_id == runs[1].id and st.status == StageStatus.failed


@pytest.mark.parametrize("stage", P4_STAGES)
async def test_other_organisations_get_404_on_new_stages(setup: Any, stage: str) -> None:
    ctx, client, owner, other = setup
    pid = await _at_g5(ctx, client, owner)
    h = other.headers
    assert (await client.get(f"{API}/projects/{pid}/workflow", headers=h)).status_code == 404
    assert (await client.get(f"{API}/projects/{pid}/stages/{stage}/runs", headers=h)).status_code == 404
    assert (await client.get(f"{API}/projects/{pid}/stages/{stage}/runs/1", headers=h)).status_code == 404
    assert (await client.post(f"{API}/projects/{pid}/stages/{stage}/run", json={}, headers=h)).status_code == 404
    assert (await client.post(f"{API}/projects/{pid}/stages/{stage}/cancel", headers=h)).status_code == 404


async def test_health_reports_the_automation_toolkit(setup: Any) -> None:
    ctx, client, _owner, _ = setup
    body = (await client.get(f"{API}/health")).json()
    auto = body["automation"]
    if ctx.toolkit.problem() is not None:
        assert auto == {"node": None, "toolkit": None, "playwright": None, "browsers": []}
        return
    version = await ctx.toolkit.version()
    assert version is not None
    assert auto == {"node": version.node, "toolkit": version.toolkit, "playwright": version.playwright,
                    "browsers": version.browsers}  # fmt: skip
    assert auto["playwright"].startswith("1.65.") and "chromium" in auto["browsers"]
