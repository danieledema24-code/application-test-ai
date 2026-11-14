"""Lead QA Orchestrator: deterministic stage state machine (architecture.md §2, §4).

Code decides stage order, gate enforcement, dedupe, pause/resume and stale propagation. Agents only produce
validated artefacts; no LLM output can change workflow state.
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.discovery.agent import DiscoveryAgent, empty_stats
from app.agents.phase2 import StageOutcome
from app.agents.reporting.discovery_report import next_report_version, render_report
from app.api.errors import Conflict, Forbidden, GateBlocked, NotFound, ValidationFailed
from app.context import AppContext
from app.db.models import (
    AgentTask,
    GateDecision,
    Job,
    Project,
    ProjectUrl,
    QaReport,
    ScanSession,
    StageRun,
    WorkflowStage,
)
from app.db.tenant import TenantScope, bind_scope, system_scope
from app.db.touch import touch_project
from app.db.types import utcnow
from app.domain.enums import (
    ActorType,
    EventLevel,
    GateDecisionKind,
    GateKey,
    GatePolicy,
    GateStatus,
    GeneratedBy,
    ProjectStatus,
    ReportStatus,
    ReportType,
    ReviewStatus,
    ScanStatus,
    StageKey,
    StageStatus,
    TaskStatus,
    UrlRole,
)
from app.domain.stages import (
    ACTIVE_STATUSES,
    DERIVED_STAGES,
    EXECUTION_STAGE_STATUS,
    GATE_STAGE,
    GATE_TITLES,
    OUTPUT_STATUSES,
    REGENERABLE_STAGES,
    RUN_DRIVEN_STAGES,
    RUNNABLE_IN_PHASE,
    STAGE_BY_KEY,
    STAGES,
    SUBJECT_GATES,
    downstream_of,
    merged_policy,
)
from app.services import gates as gate_rules
from app.services.audit import audit
from app.services.counters import next_key

log = logging.getLogger(__name__)
ORCH = "orchestrator"
SCAN_GROUP = "scan"
# Run statuses that mean "this version produced a usable output" (a regeneration of it is a candidate).
APPLIED_RUN_STATUSES = frozenset(
    {StageStatus.completed, StageStatus.awaiting_approval, StageStatus.approved, StageStatus.changes_requested}
)


def _summary(output: dict[str, Any]) -> dict[str, Any]:
    review = output.get("review") or {}
    return {"summary": review.get("summary", {})}


def g6_unchecked(output: dict[str, Any] | None) -> str | None:
    """Why the scripts of a bundle haven't been checked yet, or None once validation finished (QA P4-BUG-04): Gate 6
    is not announced as waiting while its checks never ran."""
    v = (output or {}).get("validation") or {}
    if v.get("status") != "done":
        return "the script checks haven't finished"
    problem = v.get("toolkit")
    if problem and (v.get("counts") or {}).get("not_checked"):
        return str(problem)
    return None


async def _g6_wait_event(orch: Any, project: Project, reason: str) -> None:
    await orch._emit(
        project,
        "automation.validation_incomplete",
        f"Gate 6 waits until the scripts are checked: {reason}. Use Validate again on Automation.",
        stage=StageKey.automation,
        level=EventLevel.warn,
        data={"kind": "warning", "gate": GateKey.G6.value},
    )


def _phase2_agents() -> dict[StageKey, Any]:
    from app.agents.readiness.agent import ReadinessAgent
    from app.agents.requirements.agent import RequirementsAgent
    from app.agents.strategy.agent import StrategyAgent
    from app.agents.testdesign.agent import TestDesignAgent

    return {
        StageKey.requirements: RequirementsAgent,
        StageKey.readiness_criteria: ReadinessAgent,
        StageKey.test_strategy: StrategyAgent,
        StageKey.test_design: TestDesignAgent,
    }


class _LazyAgents(dict[StageKey, Any]):
    """Stage -> generator class, imported on first use (agents import services that import this module)."""

    def _load(self) -> None:
        if not super().__len__():
            self.update(_phase2_agents())

    def __contains__(self, key: object) -> bool:
        self._load()
        return super().__contains__(key)

    def __getitem__(self, key: StageKey) -> Any:
        self._load()
        return super().__getitem__(key)


PHASE2_AGENTS = _LazyAgents()


class StageNotAvailable(RuntimeError):
    """Raised by a registry stub when its stage's story has not landed yet."""


class NotAvailableYet:
    """Stage-handler registry stub (P4-00). Real handlers take the Phase 2 agent signature and return a StageOutcome.

    `advance()` never queues a stage whose handler is a stub, and `POST /stages/{stage}/run` answers 422, so no
    project ends up with a failed stage before the story lands.
    """

    implemented = False
    story = ""

    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        pass

    async def run(self) -> StageOutcome:
        raise StageNotAvailable(f"This stage is not available yet ({self.story})")


def _stub(story: str) -> type[NotAvailableYet]:
    return type(f"NotAvailableYet_{story.replace('-', '_')}", (NotAvailableYet,), {"story": story})


class _LazyHandler:
    """A real stage handler, imported on first use (agents import services that import this module)."""

    implemented = True

    def __init__(self, module: str, name: str) -> None:
        self.module, self.name = module, name

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        import importlib

        return getattr(importlib.import_module(self.module), self.name)(*args, **kwargs)


# Phase 4 stage handlers (P4-00). Each story replaces its stub: P4-02 the assessment, P4-03a the bundle, P4-06 the
# execution engine, P4-08 the failure analysis.
PHASE4_HANDLERS: dict[StageKey, Any] = {
    StageKey.automation_assessment: _LazyHandler("app.agents.automation.assessment", "AssessmentAgent"),
    StageKey.automation: _LazyHandler("app.agents.automation.engineer", "AutomationAgent"),
    # Runs are started from Test Execution (job `execution_run`), never as a stage task (RUN_DRIVEN_STAGES).
    StageKey.execution: type("RunDriven_P4_06", (NotAvailableYet,), {"story": "P4-06", "implemented": True}),
    StageKey.failure_analysis: _LazyHandler("app.agents.defects.analysis", "FailureAnalysisAgent"),
}


def handler_ready(key: StageKey) -> bool:
    """False while the stage's registry entry is still a stub."""
    handler = PHASE4_HANDLERS.get(key)
    return handler is None or bool(getattr(handler, "implemented", True))


# Message when a stage's upstream gate blocks it, where the gate title alone would not say what to do.
_GATE_BLOCK_NAMES: dict[GateKey, str] = {GateKey.G5: "Test design approval"}
# Why a downstream stage is out of date after its gate input was re-approved with different content.
_STALE_REASONS: dict[tuple[GateKey, StageKey], str] = {
    (GateKey.G3, StageKey.test_strategy): "Requirements changed after this strategy was written",
    (GateKey.G3, StageKey.test_design): "Requirements changed after these test cases were designed",
    (GateKey.G4, StageKey.test_design): "Strategy changed after these test cases were designed",
    (GateKey.G5, StageKey.automation_assessment): "Test cases changed after this assessment",
    (GateKey.G5, StageKey.automation): "Test cases changed after these scripts were written",
}


class Orchestrator:
    def __init__(self, ctx: AppContext) -> None:
        self.ctx = ctx
        # Status-change events to emit once the stage rows are committed.
        self._pending_events: list[tuple[Project, StageKey, StageStatus, StageStatus, int]] = []
        self._reopened: list[tuple[Project, GateKey, str]] = []

    # ------------------------------------------------------------------ helpers

    async def _emit(
        self,
        project: Project,
        type_: str,
        message: str,
        *,
        stage: StageKey | None = None,
        level: EventLevel = EventLevel.info,
        data: dict[str, Any] | None = None,
        task_id: uuid.UUID | None = None,
        agent: str = ORCH,
    ) -> None:
        await self.ctx.events.emit(
            org_id=project.organisation_id,
            project_id=project.id,
            type=type_,
            message=message,
            level=level,
            stage_key=stage.value if stage else None,
            agent_key=agent,
            task_id=task_id,
            data=data,
        )

    async def _status_event(
        self,
        project: Project,
        stage: StageKey,
        old: StageStatus,
        new: StageStatus,
        version: int | None,
        message: str | None = None,
    ) -> None:
        if old == new:
            return
        title = STAGE_BY_KEY[stage].title
        default = {
            StageStatus.queued: f"Queued {title}",
            StageStatus.running: f"Started {title}",
            StageStatus.paused: f"{title} paused",
            StageStatus.completed: f"{title} completed",
            StageStatus.awaiting_approval: f"{title} is waiting for approval",
            StageStatus.approved: f"{title} approved",
            StageStatus.changes_requested: f"Changes requested for {title}",
            StageStatus.failed: f"{title} failed",
            StageStatus.cancelled: f"{title} cancelled",
            StageStatus.stale: f"{title} is out of date",
        }.get(new, f"{title}: {new.value}")
        await self._emit(
            project,
            "stage.status_changed",
            message or default,
            stage=stage,
            level=EventLevel.error if new == StageStatus.failed else EventLevel.info,
            data={"kind": "status", "stage_key": stage.value, "from": old.value, "to": new.value, "version": version},
        )

    @staticmethod
    async def stage(session: AsyncSession, project_id: uuid.UUID, key: StageKey) -> WorkflowStage:
        st = (
            await session.execute(
                select(WorkflowStage).where(WorkflowStage.project_id == project_id, WorkflowStage.stage_key == key)
            )
        ).scalar_one_or_none()
        if st is None:
            raise NotFound("Stage not found")
        return st

    @staticmethod
    async def current_run(session: AsyncSession, st: WorkflowStage) -> StageRun | None:
        if st.current_stage_run_id is None:
            return None
        return (
            await session.execute(select(StageRun).where(StageRun.id == st.current_stage_run_id))
        ).scalar_one_or_none()

    # ------------------------------------------------------------------ project bootstrap (Gate 1)

    async def init_stages(
        self, session: AsyncSession, project: Project, *, user_id: uuid.UUID, check: dict[str, Any], statement: str
    ) -> None:
        """Creates every stage row; records intake v1 and the G1 approval by the attesting user."""
        intake_run: StageRun | None = None
        for d in STAGES:
            st = WorkflowStage(
                organisation_id=project.organisation_id,
                project_id=project.id,
                stage_key=d.key,
                gate_key=d.gate,
                gate_status=GateStatus.none,
                status=StageStatus.not_started,
            )
            session.add(st)
            await session.flush()
            if d.key == StageKey.intake:
                intake_run = StageRun(
                    organisation_id=project.organisation_id,
                    workflow_stage_id=st.id,
                    project_id=project.id,
                    stage_key=StageKey.intake,
                    version=1,
                    status=StageStatus.approved,
                    input_hash=hashlib.sha256(json.dumps(check, sort_keys=True, default=str).encode()).hexdigest(),
                    output={"url_check": check, "authorisation_statement": statement},
                    generated_by=GeneratedBy.rules,
                    started_at=utcnow(),
                    finished_at=utcnow(),
                    triggered_by=user_id,
                )
                session.add(intake_run)
                await session.flush()
                st.current_stage_run_id = intake_run.id
                st.status = StageStatus.approved
                st.gate_status = GateStatus.approved
                st.updated_by = user_id
        assert intake_run is not None
        session.add(
            GateDecision(
                organisation_id=project.organisation_id,
                project_id=project.id,
                gate_key=GateKey.G1,
                stage_run_id=intake_run.id,
                decision=GateDecisionKind.approve,
                comment=statement,
                decided_by=user_id,
                agent_recommendation={
                    "automated_check": {
                        k: check.get(k) for k in ("allowed", "reachable", "http_status", "final_url", "blocked_reason")
                    }
                },
            )
        )
        audit(
            session,
            org_id=project.organisation_id,
            action="gate.approved",
            target_type="gate",
            target_id="G1",
            actor_user_id=user_id,
            project_id=project.id,
            metadata={
                "gate": "G1",
                "statement": statement,
                "check": {k: check.get(k) for k in ("normalised_url", "final_url", "http_status")},
            },
        )

    # ------------------------------------------------------------------ advance

    @staticmethod
    async def latest_run(session: AsyncSession, st: WorkflowStage) -> StageRun | None:
        """The newest run of a stage (a candidate regeneration can be newer than the current version)."""
        return (
            await session.execute(
                select(StageRun).where(StageRun.workflow_stage_id == st.id).order_by(StageRun.version.desc()).limit(1)
            )
        ).scalar_one_or_none()

    @staticmethod
    async def pending_candidate(session: AsyncSession, st: WorkflowStage) -> StageRun | None:
        """A finished regeneration waiting for review (P2-00)."""
        return (
            await session.execute(
                select(StageRun)
                .where(StageRun.workflow_stage_id == st.id, StageRun.review_status == ReviewStatus.pending_review)
                .order_by(StageRun.version.desc())
                .limit(1)
            )
        ).scalar_one_or_none()

    async def _active_run(self, session: AsyncSession, st: WorkflowStage) -> StageRun | None:
        """The run the stage's activity status refers to: the candidate while one is generating, else current."""
        latest = await self.latest_run(session, st)
        if latest is not None and latest.review_status == ReviewStatus.pending_review and latest.finished_at is None:
            return latest
        return await self.current_run(session, st)

    # ------------------------------------------------------------------ advance

    async def advance(
        self, scope: TenantScope, project_id: uuid.UUID, *, triggered_by: uuid.UUID | None = None
    ) -> list[StageKey]:
        """Queues every stage whose upstream is gate-satisfied and that runs automatically. Idempotent.

        Automatic runs (architecture.md §4): discovery once the project exists; the discovery report whenever
        discovery has a new version; provisional requirements once discovery has results; Definition of Ready/Done
        whenever the requirements version changes; the test strategy once G3 is approved; test design once G4 is
        approved (P3-00). Traceability is derived on read and never queued.
        """
        queued: list[StageKey] = []
        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            project = (await s.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
            if project is None or project.status != ProjectStatus.active:
                return queued
            stages = {
                st.stage_key: st
                for st in (
                    await s.execute(select(WorkflowStage).where(WorkflowStage.project_id == project.id))
                ).scalars()
            }
            for d in STAGES:
                if d.key not in RUNNABLE_IN_PHASE or not handler_ready(d.key):
                    continue
                st = stages[d.key]
                if st.status in ACTIVE_STATUSES or st.status == StageStatus.paused:
                    continue
                if await self.pending_candidate(s, st) is not None:
                    continue
                if not await self._wants_auto_run(s, project, st, stages):
                    continue
                params = {"auto_apply": True} if d.key == StageKey.readiness_criteria else None
                await self._queue_stage(s, project, st, triggered_by=triggered_by, parameters=params)
                queued.append(d.key)
            if await self._queue_failure_analysis(s, project, stages[StageKey.failure_analysis], triggered_by):
                queued.append(StageKey.failure_analysis)
            await s.commit()
        await self._enqueue_pending(scope, project_id)
        return queued

    async def _wants_auto_run(
        self, s: AsyncSession, project: Project, st: WorkflowStage, stages: dict[StageKey, WorkflowStage]
    ) -> bool:
        key = st.stage_key
        if key == StageKey.discovery:
            return st.status == StageStatus.not_started
        upstream = [stages[u] for u in STAGE_BY_KEY[key].upstream]
        if key in (StageKey.readiness_criteria, StageKey.discovery_report):
            # Exempt from the upstream gate: the report documents discovery for G2 and Ready/Done is part of G3.
            if any(u.status not in OUTPUT_STATUSES for u in upstream):
                return False
        elif not all([await gate_rules.gate_satisfied(s, project, u) for u in upstream]):
            return False
        run = await self.current_run(s, st)
        urun = await self.current_run(s, upstream[0])
        if urun is None:
            return False
        if key in (StageKey.discovery_report, StageKey.requirements) and int((urun.output or {}).get("pages", 0)) == 0:
            return False
        if key == StageKey.discovery_report:
            upstream_v = (run.upstream_versions or {}).get("discovery") if run else None
            return (
                run is None or st.status in (StageStatus.stale, StageStatus.not_started) or upstream_v != urun.version
            )
        if key == StageKey.requirements:
            # First generation automatically; after a new discovery version, a regeneration candidate for review.
            if st.status == StageStatus.not_started:
                return True
            return (
                st.status == StageStatus.stale
                and run is not None
                and run.status in APPLIED_RUN_STATUSES
                and (run.upstream_versions or {}).get("discovery") != urun.version
            )
        if key == StageKey.readiness_criteria:
            if st.status == StageStatus.not_started or run is None:
                return True
            return (run.upstream_versions or {}).get("requirements") != urun.version
        if key in (StageKey.test_strategy, StageKey.test_design):
            return st.status == StageStatus.not_started
        if key == StageKey.automation_assessment:
            # P4-00: after G5 approval, and again when a G5 re-approval with a different snapshot made it stale.
            return st.status in (StageStatus.not_started, StageStatus.stale)
        if key == StageKey.automation:
            # Once the assessment has output; again after a newer assessment version replaced the one it used.
            if st.status == StageStatus.not_started:
                return True
            return (
                st.status == StageStatus.stale
                and run is not None
                and (run.upstream_versions or {}).get(StageKey.automation_assessment.value) != urun.version
            )
        return False

    async def _queue_failure_analysis(
        self, s: AsyncSession, project: Project, st: WorkflowStage, triggered_by: uuid.UUID | None
    ) -> bool:
        """P4-00: one failure_analysis run per finished execution run with >=1 failed or errored result. A cancelled
        run is analysed too when it has real failures; tests stopped by the cancel are not results (QA P4-BUG-06).

        Queued by code only, one at a time (the next one is queued when the current one finishes and `advance`
        runs again). The analysed run is recorded in the stage run's parameters.
        """
        from app.db.models import ExecutionResult, ExecutionRun
        from app.domain.enums import ResultStatus, RunStatus
        from app.services.execution import NOT_RESULTS

        if not handler_ready(StageKey.failure_analysis) or st.status in ACTIVE_STATUSES:
            return False
        if st.status == StageStatus.paused:
            return False
        finished = (
            (
                await s.execute(
                    select(ExecutionRun.id)
                    .where(
                        ExecutionRun.project_id == project.id,
                        ExecutionRun.status.in_(
                            [RunStatus.passed, RunStatus.failed, RunStatus.error, RunStatus.cancelled]
                        ),
                        ExecutionRun.finished_at.is_not(None),
                    )
                    .order_by(ExecutionRun.created_at)
                )
            )
            .scalars()
            .all()
        )
        if not finished:
            return False
        cancelled = set(
            (
                await s.execute(
                    select(ExecutionRun.id).where(
                        ExecutionRun.id.in_(finished), ExecutionRun.status == RunStatus.cancelled
                    )
                )
            ).scalars()
        )
        with_failures = {
            run_id
            for run_id, status, error in (
                await s.execute(
                    select(ExecutionResult.execution_run_id, ExecutionResult.status, ExecutionResult.error).where(
                        ExecutionResult.execution_run_id.in_(finished),
                        # Flaky results are analysed too (classified `flaky`, never a defect; D9).
                        ExecutionResult.status.in_([ResultStatus.failed, ResultStatus.error, ResultStatus.flaky]),
                    )
                )
            ).all()
            if run_id not in cancelled or not (status == ResultStatus.error and (error or "") in NOT_RESULTS)
        }
        analysed = {
            str((p or {}).get("execution_run_id"))
            for p in (await s.execute(select(StageRun.parameters).where(StageRun.workflow_stage_id == st.id))).scalars()
        }
        todo = next((rid for rid in finished if rid in with_failures and str(rid) not in analysed), None)
        if todo is None:
            return False
        await self._queue_stage(s, project, st, triggered_by=triggered_by, parameters={"execution_run_id": str(todo)})
        return True

    async def _queue_stage(
        self,
        s: AsyncSession,
        project: Project,
        st: WorkflowStage,
        *,
        triggered_by: uuid.UUID | None,
        parameters: dict[str, Any] | None,
    ) -> StageRun:
        """Creates the next run of a stage and its agent task.

        A regeneration of a regenerable stage that already has an applied version is a *candidate*: the current
        version stays in place (and usable downstream) until a person applies the reviewed changes (P2-00).
        Automatic Ready/Done runs (`auto_apply`) apply directly with the carry-forward defaults.
        """
        prev = await self.current_run(s, st)
        candidate = (
            st.stage_key in REGENERABLE_STAGES
            and prev is not None
            and prev.status in APPLIED_RUN_STATUSES
            and prev.finished_at is not None
            and not (parameters or {}).get("auto_apply")
        )
        version = (
            int(
                (
                    await s.execute(
                        select(func.coalesce(func.max(StageRun.version), 0)).where(StageRun.workflow_stage_id == st.id)
                    )
                ).scalar_one()
            )
            + 1
        )
        upstream: dict[str, int] = {}
        for u in STAGE_BY_KEY[st.stage_key].upstream:
            ust = await self.stage(s, project.id, u)
            urun = await self.current_run(s, ust)
            if urun is not None:
                upstream[u.value] = urun.version
        params = {k: v for k, v in (parameters or {}).items() if k != "guidance"}
        if prev is not None and prev.finished_at is not None and prev.status in APPLIED_RUN_STATUSES:
            params["previous_run_id"] = str(prev.id)
        approved_input: dict[str, Any] | None = None
        if st.stage_key == StageKey.test_strategy:
            items, versions = await gate_rules.g3_snapshot(s, project.id)
            approved_input = {"g3_hash": gate_rules.snapshot_hash(items), "versions": versions}
        elif st.stage_key == StageKey.test_design:
            # P3-00: the design is built from exactly these G3/G4 approvals (G5 checks the G4 one still holds).
            g3_items, g3_versions = await gate_rules.g3_snapshot(s, project.id)
            g4_items, g4_versions = await gate_rules.g4_snapshot(s, project.id)
            approved_input = {
                "requirements_snapshot_hash": gate_rules.snapshot_hash(g3_items),
                "strategy_snapshot_hash": gate_rules.snapshot_hash(g4_items),
                "versions": {**g3_versions, **g4_versions},
            }
        elif st.stage_key in (StageKey.automation_assessment, StageKey.automation):
            # P4-00: built from the cases frozen in the last G5 approval (stays the input while G5 is reopened).
            g5 = await gate_rules.last_approval(s, project.id, GateKey.G5)
            if g5 is not None:
                approved_input = {"g5_hash": g5.snapshot_hash, "versions": dict(g5.stage_run_versions or {})}
        run = StageRun(
            organisation_id=project.organisation_id,
            workflow_stage_id=st.id,
            project_id=project.id,
            stage_key=st.stage_key,
            version=version,
            status=StageStatus.queued,
            upstream_versions=upstream,
            parameters=params,
            input_hash=hashlib.sha256(
                json.dumps({"upstream": upstream, "params": params}, sort_keys=True).encode()
            ).hexdigest(),
            triggered_by=triggered_by,
            review_status=ReviewStatus.pending_review if candidate else ReviewStatus.not_required,
            review_decisions={"prior_status": st.status.value} if candidate else None,
            guidance=(parameters or {}).get("guidance"),
            approved_input=approved_input,
        )
        s.add(run)
        await s.flush()
        task_input: dict[str, Any] = {"stage_run_id": str(run.id)}
        if st.stage_key == StageKey.discovery:
            urls = (await s.execute(select(ProjectUrl).where(ProjectUrl.project_id == project.id))).scalars().all()
            pu = next((u for u in urls if u.role == UrlRole.primary), None)
            if pu is None:
                raise Conflict("Project has no target URL")
            start = (pu.last_check or {}).get("final_url") or pu.url
            n, key = await next_key(s, project.organisation_id, project.id, "scan")
            settings = {**(project.settings or {}), **params}
            limits = {
                k: settings[k]
                for k in ("max_pages", "max_depth", "include_mobile", "respect_robots", "use_credentials")
                if k in settings
            }
            scan = ScanSession(
                organisation_id=project.organisation_id,
                project_id=project.id,
                stage_run_id=run.id,
                key=key,
                sequence=n,
                start_url=start,
                status=ScanStatus.queued,
                limits=limits,
                stats=empty_stats(),
            )
            s.add(scan)
            await s.flush()
            task_input["scan_session_id"] = str(scan.id)
        task = AgentTask(
            organisation_id=project.organisation_id,
            project_id=project.id,
            stage_run_id=run.id,
            agent_key=STAGE_BY_KEY[st.stage_key].agent_key or ORCH,
            status=TaskStatus.queued,
            input=task_input,
            dedupe_key=f"{project.id}:{st.stage_key.value}:v{version}",
        )
        s.add(task)
        await s.flush()
        run.agent_task_id = task.id
        old = st.status
        st.status = StageStatus.queued
        if not candidate:
            st.current_stage_run_id = run.id
            st.stale_reason = None
            st.gate_status = GateStatus.none
        st.updated_by = triggered_by
        await s.flush()
        self._pending_events.append((project, st.stage_key, old, StageStatus.queued, version))
        return run

    async def mirror_execution_run(self, s: AsyncSession, project: Project, run: Any) -> StageStatus | None:
        """P4-00: the `execution` stage mirrors the latest execution run, and each run is its own stage run.

        Called inside the caller's transaction whenever an `ExecutionRun` changes status (P4-06). The first call for a
        run that has left `awaiting_authorisation` creates its stage run (version n) and makes it current; later calls
        update it. Runs awaiting or refused authorisation never move the stage. Emit with `_enqueue_pending`-style
        events after commit (the status event is queued on `self`).
        """
        new = EXECUTION_STAGE_STATUS.get(run.status)
        if new is None:
            return None
        st = await self.stage(s, project.id, StageKey.execution)
        srun = (
            (await s.execute(select(StageRun).where(StageRun.id == run.stage_run_id))).scalar_one_or_none()
            if run.stage_run_id is not None
            else None
        )
        if srun is None:
            version = (
                int(
                    (
                        await s.execute(
                            select(func.coalesce(func.max(StageRun.version), 0)).where(
                                StageRun.workflow_stage_id == st.id
                            )
                        )
                    ).scalar_one()
                )
                + 1
            )
            auto = await self.stage(s, project.id, StageKey.automation)
            arun = await self.current_run(s, auto)
            srun = StageRun(
                organisation_id=project.organisation_id,
                workflow_stage_id=st.id,
                project_id=project.id,
                stage_key=StageKey.execution,
                version=version,
                status=new,
                upstream_versions={StageKey.automation.value: arun.version} if arun is not None else {},
                parameters={"execution_run_id": str(run.id), "run_key": run.key},
                generated_by=GeneratedBy.rules,
                triggered_by=run.requested_by,
            )
            s.add(srun)
            await s.flush()
            run.stage_run_id = srun.id
            st.current_stage_run_id = srun.id
        srun.status = new
        if new == StageStatus.running and srun.started_at is None:
            srun.started_at = run.started_at or utcnow()
        if new not in ACTIVE_STATUSES:
            srun.finished_at = run.finished_at or utcnow()
            srun.output = {"execution_run_id": str(run.id), "run_key": run.key, "totals": dict(run.totals or {})}
            srun.error = run.error
        if st.current_stage_run_id != srun.id:
            return None  # a newer run owns the stage; this one only updates its own history row
        old = st.status
        st.status = new
        st.stale_reason = None
        if old != new:
            self._pending_events.append((project, StageKey.execution, old, new, srun.version))
        return new

    async def _enqueue_pending(self, scope: TenantScope, project_id: uuid.UUID) -> None:
        """Enqueues jobs for queued tasks without a job (after the stage rows are committed) and emits events."""
        events, self._pending_events = (
            [e for e in self._pending_events if e[0].id == project_id],
            [e for e in self._pending_events if e[0].id != project_id],
        )
        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            tasks = (
                (
                    await s.execute(
                        select(AgentTask).where(
                            AgentTask.project_id == project_id, AgentTask.status == TaskStatus.queued
                        )
                    )
                )
                .scalars()
                .all()
            )
            for t in tasks:
                if (t.output_ref or {}).get("job_id"):
                    continue
                job_id = await self.ctx.queue.enqueue(
                    "agent_task",
                    {"task_id": str(t.id)},
                    org_id=t.organisation_id,
                    project_id=t.project_id,
                    dedupe_key=f"task:{t.id}",
                    concurrency_group=SCAN_GROUP if t.agent_key == "discovery" else None,
                )
                t.output_ref = {"job_id": str(job_id)}
            await s.commit()
        for project, stage, old, new, version in events:
            await self._status_event(project, stage, old, new, version)

    # ------------------------------------------------------------------ commands from the API

    async def request_run(
        self,
        scope: TenantScope,
        project_id: uuid.UUID,
        stage_key: StageKey,
        *,
        parameters: dict[str, Any] | None,
        reason: str | None,
    ) -> None:
        d = STAGE_BY_KEY[stage_key]
        if stage_key in DERIVED_STAGES:
            what = "Traceability" if stage_key == StageKey.traceability else d.title
            raise ValidationFailed(
                f"{what} is computed automatically",
                details=[{"field": "stage", "message": f"{what} is computed automatically"}],
            )
        if stage_key in RUN_DRIVEN_STAGES and d.available:
            raise ValidationFailed(
                RUN_DRIVEN_STAGES[stage_key], details=[{"field": "stage", "message": RUN_DRIVEN_STAGES[stage_key]}]
            )
        if not d.available or stage_key not in RUNNABLE_IN_PHASE:
            raise ValidationFailed(
                f"The stage '{stage_key.value}' is not available in this phase",
                details=[
                    {
                        "field": "stage",
                        "message": f"Available from Phase {d.phase}"
                        if not d.available
                        else "This stage runs automatically",
                    }
                ],
            )
        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            project = (await s.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
            if project is None:
                raise NotFound("Project not found")
            if project.status != ProjectStatus.active:
                raise Conflict(f"The project is {project.status.value}; resume it first")
            st = await self.stage(s, project.id, stage_key)
            if st.status in (StageStatus.queued, StageStatus.running, StageStatus.paused):
                raise Conflict(f"{d.title} is already {st.status.value}")
            if await self.pending_candidate(s, st) is not None:
                raise Conflict(f"A regenerated version of {d.title} is waiting for review; apply or discard it first")
            for u in d.upstream:
                ust = await self.stage(s, project.id, u)
                await self._check_upstream(s, project, stage_key, ust)
            if not handler_ready(stage_key):
                raise ValidationFailed(
                    f"{d.title} is not available yet",
                    details=[{"field": "stage", "message": f"{d.title} is not available yet"}],
                )
            prev = await self.current_run(s, st)
            try:
                run = await self._queue_stage(s, project, st, triggered_by=scope.user_id, parameters=parameters)
            except IntegrityError as exc:
                raise Conflict(f"{d.title} is already queued or running") from exc
            stale: list[StageKey] = []
            if run.review_status != ReviewStatus.pending_review:
                # A candidate changes nothing until it is applied; a direct re-run supersedes downstream outputs.
                for dk in downstream_of(stage_key):
                    if dk in DERIVED_STAGES or dk in RUN_DRIVEN_STAGES:
                        continue  # derived on read, or mirrors execution runs (never re-run as a stage)
                    dst = await self.stage(s, project.id, dk)
                    if dst.status in OUTPUT_STATUSES or dst.status in (
                        StageStatus.failed,
                        StageStatus.changes_requested,
                    ):
                        dst.status = StageStatus.stale
                        dst.stale_reason = f"{d.title} was re-run (version {run.version})"
                        stale.append(dk)
            audit(
                s,
                org_id=project.organisation_id,
                action="stage.run_requested",
                target_type="stage",
                target_id=stage_key.value,
                actor_user_id=scope.user_id,
                project_id=project.id,
                metadata={
                    "version": run.version,
                    "previous_version": prev.version if prev else None,
                    "reason": reason,
                    "parameters": {k: v for k, v in (parameters or {}).items() if k != "guidance"},
                    "candidate": run.review_status == ReviewStatus.pending_review,
                },
            )
            await touch_project(s, project)
            await s.commit()
        await self._enqueue_pending(scope, project_id)
        for dk in stale:
            await self._emit(
                project,
                "stage.status_changed",
                f"{STAGE_BY_KEY[dk].title} is out of date",
                stage=dk,
                data={"kind": "status", "stage_key": dk.value, "from": "completed", "to": "stale", "version": None},
            )

    async def _check_upstream(self, s: AsyncSession, project: Project, stage_key: StageKey, ust: WorkflowStage) -> None:
        """Raises 409 gate_blocked unless `ust` is gate-satisfied for running `stage_key`."""
        title = STAGE_BY_KEY[ust.stage_key].title
        if ust.status not in OUTPUT_STATUSES:
            if ust.gate_key not in (None, GateKey.G1) and ust.status in (
                StageStatus.changes_requested,
                StageStatus.stale,
            ):
                assert ust.gate_key is not None
                name = _GATE_BLOCK_NAMES.get(ust.gate_key, GATE_TITLES[ust.gate_key])
                raise GateBlocked(f"{name} ({ust.gate_key.value}) must be approved first")
            raise GateBlocked(f"{title} must finish first")
        exempt = stage_key in (StageKey.discovery_report, StageKey.readiness_criteria)
        if not exempt and not await gate_rules.gate_satisfied(s, project, ust):
            assert ust.gate_key is not None
            name = _GATE_BLOCK_NAMES.get(ust.gate_key, GATE_TITLES[ust.gate_key])
            raise GateBlocked(f"{name} ({ust.gate_key.value}) must be approved first")
        if ust.stage_key == StageKey.discovery:
            urun = await self.current_run(s, ust)
            if urun is None or int((urun.output or {}).get("pages", 0)) == 0:
                raise GateBlocked("Discovery has no results to report on")

    async def pause(self, scope: TenantScope, project_id: uuid.UUID) -> None:
        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            project = (await s.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
            if project is None:
                raise NotFound("Project not found")
            if project.status == ProjectStatus.archived:
                raise Conflict("Archived projects cannot be paused")
            if project.status == ProjectStatus.paused:
                return
            project.status = ProjectStatus.paused
            changed: list[tuple[StageKey, StageStatus, int | None]] = []
            for st in (await s.execute(select(WorkflowStage).where(WorkflowStage.project_id == project.id))).scalars():
                run = await self._active_run(s, st)
                if st.status == StageStatus.running and st.stage_key == StageKey.discovery and run is not None:
                    scan = (await s.execute(select(ScanSession).where(ScanSession.stage_run_id == run.id))).scalar_one()
                    scan.control = "pause"  # cooperative: the crawler stops after the current page
                elif st.status == StageStatus.queued and run is not None:
                    task = (
                        await s.execute(select(AgentTask).where(AgentTask.id == run.agent_task_id))
                    ).scalar_one_or_none()
                    if task is not None and (task.output_ref or {}).get("job_id"):
                        await self.ctx.queue.cancel(uuid.UUID(task.output_ref["job_id"]))  # type: ignore[index]
                        task.status = TaskStatus.paused
                        task.output_ref = {}
                    st.status = StageStatus.paused
                    run.status = StageStatus.paused
                    if st.stage_key == StageKey.discovery:
                        scan = (
                            await s.execute(select(ScanSession).where(ScanSession.stage_run_id == run.id))
                        ).scalar_one()
                        scan.status = ScanStatus.paused
                    changed.append((st.stage_key, StageStatus.queued, run.version))
            audit(
                s,
                org_id=project.organisation_id,
                action="workflow.paused",
                target_type="project",
                target_id=project.id,
                actor_user_id=scope.user_id,
                project_id=project.id,
            )
            await s.commit()
        await self._emit(
            project, "log", "Pause requested: the analysis pauses after the current page.", data={"kind": "status"}
        )
        for key, old, version in changed:
            await self._status_event(project, key, old, StageStatus.paused, version)

    async def resume(self, scope: TenantScope, project_id: uuid.UUID) -> None:
        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            project = (await s.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
            if project is None:
                raise NotFound("Project not found")
            if project.status == ProjectStatus.archived:
                raise Conflict("Archived projects cannot be resumed")
            project.status = ProjectStatus.active
            resumed: list[tuple[StageKey, int]] = []
            for st in (await s.execute(select(WorkflowStage).where(WorkflowStage.project_id == project.id))).scalars():
                run = await self._active_run(s, st)
                if run is None:
                    continue
                if st.status == StageStatus.running and st.stage_key == StageKey.discovery:
                    # Pause requested but not yet reached: cancel the request.
                    scan = (await s.execute(select(ScanSession).where(ScanSession.stage_run_id == run.id))).scalar_one()
                    if scan.control == "pause":
                        scan.control = None
                if st.status == StageStatus.paused:
                    task = (await s.execute(select(AgentTask).where(AgentTask.id == run.agent_task_id))).scalar_one()
                    task.status = TaskStatus.queued
                    task.output_ref = {}
                    st.status = StageStatus.queued
                    run.status = StageStatus.queued
                    if st.stage_key == StageKey.discovery:
                        scan = (
                            await s.execute(select(ScanSession).where(ScanSession.stage_run_id == run.id))
                        ).scalar_one()
                        scan.status = ScanStatus.queued
                        scan.control = None
                    resumed.append((st.stage_key, run.version))
            audit(
                s,
                org_id=project.organisation_id,
                action="workflow.resumed",
                target_type="project",
                target_id=project.id,
                actor_user_id=scope.user_id,
                project_id=project.id,
            )
            await s.commit()
        await self._emit(project, "log", "Analysis resumed.", data={"kind": "status"})
        await self._enqueue_pending(scope, project_id)
        for key, version in resumed:
            await self._status_event(project, key, StageStatus.paused, StageStatus.queued, version)
        await self.advance(scope, project_id, triggered_by=scope.user_id)

    async def cancel(self, scope: TenantScope, project_id: uuid.UUID, stage_key: StageKey) -> None:
        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            project = (await s.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
            if project is None:
                raise NotFound("Project not found")
            st = await self.stage(s, project.id, stage_key)
            run = await self._active_run(s, st)
            if st.status not in (StageStatus.queued, StageStatus.running, StageStatus.paused) or run is None:
                raise Conflict(f"{STAGE_BY_KEY[stage_key].title} is not running")
            immediate = st.status != StageStatus.running
            task = (await s.execute(select(AgentTask).where(AgentTask.id == run.agent_task_id))).scalar_one_or_none()
            scan = None
            if stage_key == StageKey.discovery:
                scan = (await s.execute(select(ScanSession).where(ScanSession.stage_run_id == run.id))).scalar_one()
            if immediate:
                if task is not None:
                    if (task.output_ref or {}).get("job_id"):
                        await self.ctx.queue.cancel(uuid.UUID(task.output_ref["job_id"]))  # type: ignore[index]
                    task.status = TaskStatus.cancelled
                    task.finished_at = utcnow()
                pages = int((scan.stats or {}).get("pages", 0)) if scan else 0
                old = st.status
                if run.review_status == ReviewStatus.pending_review:
                    # Cancelling a regeneration leaves the current version exactly as it was.
                    st.status = StageStatus((run.review_decisions or {}).get("prior_status", "completed"))
                    run.review_status = ReviewStatus.discarded
                else:
                    st.status = StageStatus.cancelled
                run.status = StageStatus.cancelled
                run.partial = True
                run.finished_at = utcnow()
                run.output = {**(run.output or {}), "pages": pages}
                if scan is not None:
                    scan.status = ScanStatus.cancelled
                    scan.finished_at = utcnow()
                    scan.control = None
                    scan.current = None
            else:
                old = st.status
                if scan is not None:
                    scan.control = "cancel"
                if task is not None and (task.output_ref or {}).get("job_id"):
                    await self.ctx.queue.cancel(uuid.UUID(task.output_ref["job_id"]))  # type: ignore[index]
            audit(
                s,
                org_id=project.organisation_id,
                action="stage.cancelled",
                target_type="stage",
                target_id=stage_key.value,
                actor_user_id=scope.user_id,
                project_id=project.id,
                metadata={"version": run.version},
            )
            await s.commit()
            version, new_status = run.version, st.status
        if immediate:
            await self._status_event(project, stage_key, old, new_status, version)
        else:
            await self._emit(
                project,
                "log",
                "Cancel requested: discovery stops after the current page.",
                stage=stage_key,
                data={"kind": "status"},
            )

    async def decide_gate(
        self,
        scope: TenantScope,
        project_id: uuid.UUID,
        gate: GateKey,
        *,
        decision: GateDecisionKind,
        comment: str,
        stage_run_version: int,
    ) -> None:
        if not scope.can_approve:
            raise Forbidden("You don't have permission to approve quality gates")
        if decision != GateDecisionKind.approve and not comment.strip():
            raise ValidationFailed(
                "A comment is required when rejecting or requesting changes",
                details=[{"field": "comment", "message": "Explain what needs to change."}],
            )
        stage_key = GATE_STAGE[gate]
        if gate == GateKey.G1:
            raise Conflict("Gate 1 is recorded when the project is created")
        if gate in SUBJECT_GATES and STAGE_BY_KEY[stage_key].available:
            # P4-00: G7 is decided per execution run, G8 per defect (decisions D8, D11).
            raise ValidationFailed(
                f"{gate.value} is decided per {'test run' if gate == GateKey.G7 else 'defect'}",
                details=[{"field": "gate", "message": SUBJECT_GATES[gate]}],
            )
        if not STAGE_BY_KEY[stage_key].available:
            raise ValidationFailed(f"{gate.value} is not available in this phase")
        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            project = (await s.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
            if project is None:
                raise NotFound("Project not found")
            st = await self.stage(s, project.id, stage_key)
            run = await self.current_run(s, st)
            if run is None or run.version != stage_run_version:
                raise Conflict("This decision refers to an older version of the stage; reload and try again")
            decidable = st.status in (StageStatus.awaiting_approval, StageStatus.completed, StageStatus.cancelled)
            if not decidable or st.gate_status not in (GateStatus.pending, GateStatus.recommended):
                raise Conflict(f"{gate.value} is not waiting for a decision")
            # Claim the decision (QA P4-BUG-09): of two requests that both read "waiting", only the first records a
            # decision; the second waits for its write lock, then matches no row and gets the 409 above.
            claimed = await s.execute(
                update(WorkflowStage)
                .where(
                    WorkflowStage.id == st.id,
                    WorkflowStage.gate_status.in_([GateStatus.pending, GateStatus.recommended]),
                )
                .values(updated_by=scope.user_id)
                .execution_options(synchronize_session=False)
            )
            if getattr(claimed, "rowcount", 1) != 1:
                raise Conflict(f"{gate.value} is not waiting for a decision")
            recommendation = (run.output or {}).get("recommendation")
            items: list[dict[str, Any]] = []
            versions: dict[str, int] = {}
            if gate in (GateKey.G3, GateKey.G4, GateKey.G5, GateKey.G6):
                if decision == GateDecisionKind.approve:
                    blocking = gate_rules.blockers(await gate_rules.preconditions(s, project, gate))
                    if blocking:
                        raise GateBlocked(
                            f"{GATE_TITLES[gate]} can't be approved yet",
                            details=[{"field": "gate", "code": p.code, "message": p.message} for p in blocking],
                        )
                recommendation = await gate_rules.recommendation(s, project, gate)
                items, versions = await gate_rules.snapshot_for(s, project.id, gate)
            digest = gate_rules.snapshot_hash(items) if items else None
            previous = await gate_rules.last_approval(s, project.id, gate)
            old = st.status
            s.add(
                GateDecision(
                    organisation_id=project.organisation_id,
                    project_id=project.id,
                    gate_key=gate,
                    stage_run_id=run.id,
                    decision=decision,
                    comment=comment.strip(),
                    decided_by=scope.user_id,
                    agent_recommendation=recommendation,
                    artefact_snapshot={"items": items} if items else None,
                    snapshot_hash=digest,
                    stage_run_versions=versions or None,
                )
            )
            stale: list[StageKey] = []
            if decision == GateDecisionKind.approve and digest is not None:
                stale = await self._mark_changed_downstream(s, project, stage_key, digest, previous)
            if decision == GateDecisionKind.approve:
                st.gate_status = GateStatus.approved
                st.status = StageStatus.approved
                run.status = StageStatus.approved
            else:
                st.gate_status = GateStatus.rejected
                st.status = StageStatus.changes_requested
                run.status = StageStatus.changes_requested
            st.updated_by = scope.user_id
            audit(
                s,
                org_id=project.organisation_id,
                action="gate.approved" if decision == GateDecisionKind.approve else "gate.rejected",
                target_type="gate",
                target_id=gate.value,
                actor_user_id=scope.user_id,
                project_id=project.id,
                metadata={"decision": decision.value, "comment": comment.strip(), "stage_run_version": run.version},
            )
            await touch_project(s, project)
            # Re-render the latest report of this scan so its status (Draft/Approved) matches the decision.
            report = (
                await s.execute(
                    select(QaReport).where(QaReport.stage_run_id == run.id).order_by(QaReport.version.desc()).limit(1)
                )
            ).scalar_one_or_none()
            if report is None:
                scan = (
                    await s.execute(select(ScanSession).where(ScanSession.stage_run_id == run.id))
                ).scalar_one_or_none()
                if scan is not None:
                    report = (
                        await s.execute(
                            select(QaReport)
                            .where(QaReport.scan_session_id == scan.id)
                            .order_by(QaReport.version.desc())
                            .limit(1)
                        )
                    ).scalar_one_or_none()
            if report is not None and report.status == ReportStatus.ready and gate == GateKey.G2:
                report.status = ReportStatus.rendering
            else:
                report = None
            if decision == GateDecisionKind.approve and gate in (GateKey.G3, GateKey.G4):
                # Frozen approved version (P2-09): stamped with exactly the snapshot just approved.
                from app.agents.reporting import phase2_reports

                rtype = ReportType.requirements_spec if gate == GateKey.G3 else ReportType.test_strategy
                if await phase2_reports.has_source(s, project.id, rtype):
                    report = await phase2_reports.create(s, project, rtype, user_id=scope.user_id, frozen=True)
            extra_reports: list[uuid.UUID] = []
            if decision == GateDecisionKind.approve and gate == GateKey.G5:
                # P3-08: frozen Test Case Specification and RTM for exactly the approved snapshot.
                from app.agents.reporting import phase2_reports

                for rtype in (ReportType.test_case_spec, ReportType.rtm):
                    if await phase2_reports.has_source(s, project.id, rtype):
                        rep_row = await phase2_reports.create(s, project, rtype, user_id=scope.user_id, frozen=True)
                        extra_reports.append(rep_row.id)
            if decision == GateDecisionKind.approve and gate == GateKey.G4:
                # P3-05: risk-derived priorities follow the approved register (derived: no version bump).
                from app.services import testdesign as tds

                updated = await tds.recompute_priorities(s, project.id)
            else:
                updated = 0
            await s.commit()
            report_id = report.id if report is not None else None
        word = "approved" if decision == GateDecisionKind.approve else "returned with requested changes"
        await self._emit(
            project,
            "gate.decided",
            f"Gate {gate.value[1:]}: {GATE_TITLES[gate]} {word}",
            stage=stage_key,
            data={"kind": "gate", "gate": gate.value, "decision": decision.value, "version": stage_run_version},
        )
        await self._status_event(
            project,
            stage_key,
            old,
            StageStatus.approved if decision == GateDecisionKind.approve else StageStatus.changes_requested,
            stage_run_version,
        )
        for dk in stale:
            await self._emit(
                project,
                "stage.status_changed",
                f"{STAGE_BY_KEY[dk].title} is out of date",
                stage=dk,
                data={"kind": "status", "stage_key": dk.value, "from": "approved", "to": "stale", "version": None},
            )
        for rid in [*([report_id] if report_id is not None else []), *extra_reports]:
            await self.ctx.queue.enqueue(
                "report_render",
                {"report_id": str(rid)},
                org_id=project.organisation_id,
                project_id=project.id,
                dedupe_key=f"report:{rid}",
            )
        if updated:
            await self._emit(
                project,
                "test_cases.priorities_updated",
                f"Risk-based priority changed on {updated} test case(s)",
                stage=StageKey.test_design,
                data={"kind": "result", "count": updated},
            )
        if decision == GateDecisionKind.approve and gate == GateKey.G4:
            await self.ctx.queue.enqueue(
                "test_plan",
                {"project_id": str(project_id)},
                org_id=project.organisation_id,
                project_id=project.id,
                dedupe_key=f"plan:{project_id}:{stage_run_version}",
            )
        if decision == GateDecisionKind.approve:
            await self.advance(scope, project_id, triggered_by=scope.user_id)

    async def _mark_changed_downstream(
        self, s: AsyncSession, project: Project, stage_key: StageKey, digest: str, previous: GateDecision | None
    ) -> list[StageKey]:
        """On re-approval with different content, downstream outputs built from the old approval become stale.

        Each downstream run records the approval it was built from in `approved_input` (G3 hash for the strategy;
        G3 and G4 hashes for the test design); a stage built from another approval goes stale. Its current output
        stays in use until it is regenerated and reviewed.
        """
        if previous is None or previous.snapshot_hash == digest:
            return []
        out: list[StageKey] = []
        keys = {
            GateKey.G3: ("g3_hash", "requirements_snapshot_hash"),
            GateKey.G4: ("strategy_snapshot_hash",),
            GateKey.G5: ("g5_hash",),
        }
        gate = STAGE_BY_KEY[stage_key].gate
        for dk in downstream_of(stage_key):
            if dk == StageKey.readiness_criteria or dk in DERIVED_STAGES or gate not in keys:
                continue
            dst = await self.stage(s, project.id, dk)
            drun = await self.current_run(s, dst)
            if drun is None or dst.status not in OUTPUT_STATUSES:
                continue
            built = drun.approved_input or {}
            used = next((built[k] for k in keys[gate] if built.get(k)), None)
            if used is not None and used != digest and gate is not None:
                dst.status = StageStatus.stale
                dst.stale_reason = _STALE_REASONS.get((gate, dk), f"{GATE_TITLES[gate]} was approved with changes")
                out.append(dk)
        return out

    async def reopen_gate(
        self,
        s: AsyncSession,
        project: Project,
        gate: GateKey,
        *,
        reason: str,
        user_id: uuid.UUID | None,
    ) -> bool:
        """A change to an approved artefact puts its gate back to waiting (downstream keeps the approved version).

        Call inside the caller's transaction; emit the returned events with `emit_reopened` after commit.
        """
        st = await self.stage(s, project.id, GATE_STAGE[gate])
        if st.status != StageStatus.approved:
            return False
        run = await self.current_run(s, st)
        policy = merged_policy(project.approval_policy)[gate]
        st.status = StageStatus.awaiting_approval if policy == GatePolicy.required else StageStatus.completed
        st.gate_status = GateStatus.pending if policy == GatePolicy.required else GateStatus.recommended
        if run is not None:
            run.status = st.status
        st.updated_by = user_id
        audit(
            s,
            org_id=project.organisation_id,
            action="gate.reopened",
            target_type="gate",
            target_id=gate.value,
            actor_user_id=user_id,
            actor_type=ActorType.user if user_id else ActorType.system,
            project_id=project.id,
            metadata={"gate": gate.value, "reason": reason},
        )
        self._reopened.append((project, gate, reason))
        return True

    async def emit_reopened(self, project_id: uuid.UUID) -> None:
        events = [e for e in self._reopened if e[0].id == project_id]
        self._reopened = [e for e in self._reopened if e[0].id != project_id]
        for project, gate, reason in events:
            stage = GATE_STAGE[gate]
            await self._emit(
                project,
                "gate.reopened",
                f"Gate {gate.value[1:]}: {GATE_TITLES[gate]} needs approval again ({reason})",
                stage=stage,
                data={"kind": "gate", "gate": gate.value, "reason": reason},
            )
            await self._status_event(
                project, stage, StageStatus.approved, StageStatus.awaiting_approval, None, message=None
            )

    # ------------------------------------------------------------------ worker side

    async def run_job(self, job: Job) -> None:
        scope = system_scope(job.organisation_id)
        if job.kind == "agent_task":
            await self.run_task(scope, uuid.UUID(job.payload["task_id"]), job)
        elif job.kind == "report_render":
            await self.render_report_job(scope, uuid.UUID(job.payload["report_id"]))
        elif job.kind == "test_plan":
            await self.plan_job(scope, uuid.UUID(job.payload["project_id"]))
        elif job.kind == "document_extract":
            await self.document_job(scope, uuid.UUID(job.payload["document_id"]))
        elif job.kind == "signin_test":
            await self.signin_test_job(scope, uuid.UUID(job.payload["task_id"]))
        elif job.kind == "automation_validate":
            await self.automation_validate_job(scope, job)
        elif job.kind == "execution_run":
            from app.agents.execution.engine import execute_run

            await execute_run(self.ctx, scope, uuid.UUID(job.payload["run_id"]), job)
        else:
            raise ValueError(f"Unknown job kind {job.kind}")

    async def automation_validate_job(self, scope: TenantScope, job: Job) -> None:
        """P4-04: re-checks a bundle's scripts (all of them, or `script_ids`), then moves G6 to its D10 state."""
        from app.agents.automation.validation import validate_bundle

        project_id = uuid.UUID(job.payload["project_id"])
        run_id = uuid.UUID(job.payload["stage_run_id"])
        only = {uuid.UUID(x) for x in job.payload.get("script_ids") or []} or None
        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            project = (await s.execute(select(Project).where(Project.id == project_id))).scalar_one()
        try:
            output, summary = await validate_bundle(self.ctx, scope, project_id, run_id, only_scripts=only)
        except Exception as exc:
            log.exception("script validation failed")
            async with self.ctx.session_factory() as s:
                bind_scope(s, scope)
                run = (await s.execute(select(StageRun).where(StageRun.id == run_id))).scalar_one()
                out = dict(run.output or {})
                out["validation"] = {**(out.get("validation") or {}), "status": "failed"}
                run.output = out
                await s.commit()
            await self._emit(
                project,
                "automation.validation_failed",
                f"Checking the scripts failed: {str(exc).splitlines()[0][:200]}",
                stage=StageKey.automation,
                level=EventLevel.error,
                data={"kind": "error"},
            )
            return
        await self._emit(
            project,
            "automation.validated",
            summary,
            stage=StageKey.automation,
            agent=STAGE_BY_KEY[StageKey.automation].agent_key or ORCH,
            data={"kind": "result", **((output.get("validation") or {}).get("counts") or {})},
        )
        await self.finalise_g6(scope, project_id, run_id=run_id)

    async def finalise_g6(self, scope: TenantScope, project_id: uuid.UUID, *, run_id: uuid.UUID | None = None) -> None:
        """Moves the automation stage to its D10 state after validation or a script review, with the events."""
        from app.services import automation as automation_svc

        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            proj = (await s.execute(select(Project).where(Project.id == project_id))).scalar_one()
            st = await automation_svc.stage(s, project_id, StageKey.automation)
            old, new, version = (st.status, st.status, None)
            if run_id is None or st.current_stage_run_id == run_id:
                old, new, version = await automation_svc.apply_g6(s, proj)
            current = await s.get(StageRun, st.current_stage_run_id) if st.current_stage_run_id else None
            output = dict(current.output or {}) if current is not None else {}
            await s.commit()
        if version is None or old == new:
            return
        await self._status_event(proj, StageKey.automation, old, new, version)
        if new == StageStatus.completed:
            await self._emit(
                proj,
                "gate.passed_automatically",
                f"Gate 6: {GATE_TITLES[GateKey.G6]} passed automatically",
                stage=StageKey.automation,
                data={"kind": "gate", "gate": GateKey.G6.value},
            )
        elif new == StageStatus.awaiting_approval and (reason := g6_unchecked(output)) is not None:
            await _g6_wait_event(self, proj, reason)
        elif new == StageStatus.awaiting_approval:
            await self._emit(
                proj,
                "gate.awaiting_approval",
                f"Gate 6: {GATE_TITLES[GateKey.G6]} is waiting for approval",
                stage=StageKey.automation,
                data={"kind": "gate", "gate": GateKey.G6.value, "policy": "required"},
            )
        await self.advance(scope, project_id)

    async def run_task(self, scope: TenantScope, task_id: uuid.UUID, job: Job | None) -> None:
        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            task = (await s.execute(select(AgentTask).where(AgentTask.id == task_id))).scalar_one_or_none()
            if task is None or task.status in (
                TaskStatus.cancelled,
                TaskStatus.succeeded,
                TaskStatus.failed,
                TaskStatus.paused,
            ):
                return
            run = (await s.execute(select(StageRun).where(StageRun.id == task.stage_run_id))).scalar_one()
            st = (await s.execute(select(WorkflowStage).where(WorkflowStage.id == run.workflow_stage_id))).scalar_one()
            project = (await s.execute(select(Project).where(Project.id == task.project_id))).scalar_one()
            superseded = st.current_stage_run_id != run.id and not (
                run.review_status == ReviewStatus.pending_review and run.finished_at is None
            )
            if superseded:
                task.status = TaskStatus.cancelled
                await s.commit()
                return
            old = st.status
            task.status = TaskStatus.running
            task.attempt += 1
            task.started_at = task.started_at or utcnow()
            task.heartbeat_at = utcnow()
            run.status = StageStatus.running
            run.started_at = run.started_at or utcnow()
            st.status = StageStatus.running
            await s.commit()
            stage_key = st.stage_key
            version = run.version
        await self._status_event(project, stage_key, old, StageStatus.running, version)
        try:
            if stage_key == StageKey.discovery:
                await self._run_discovery(scope, project, task_id, run.id, job)
            elif stage_key == StageKey.discovery_report:
                await self._run_report_stage(scope, project, task_id, run.id)
            elif stage_key in PHASE2_AGENTS or stage_key in PHASE4_HANDLERS:
                await self._run_phase2(scope, project, task_id, run.id, stage_key)
            else:
                raise ValueError(f"Stage {stage_key.value} is not implemented in this phase")
        except Exception as exc:
            log.exception("stage %s failed", stage_key.value)
            await self._fail(scope, project, task_id, run.id, f"Unexpected error: {str(exc).splitlines()[0][:200]}")
            return
        await self.advance(scope, project.id)

    async def _run_phase2(
        self, scope: TenantScope, project: Project, task_id: uuid.UUID, run_id: uuid.UUID, stage_key: StageKey
    ) -> None:
        """Runs a Phase 2 generator and finalises its stage: gate status for a first version, review for a candidate."""
        agent_cls = PHASE4_HANDLERS[stage_key] if stage_key in PHASE4_HANDLERS else PHASE2_AGENTS[stage_key]
        outcome: StageOutcome = await agent_cls(
            self.ctx, scope, project_id=project.id, run_id=run_id, task_id=task_id
        ).run()
        gate_event: dict[str, Any] | None = None
        g6_auto = False
        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            task = (await s.execute(select(AgentTask).where(AgentTask.id == task_id))).scalar_one()
            run = (await s.execute(select(StageRun).where(StageRun.id == run_id))).scalar_one()
            st = (await s.execute(select(WorkflowStage).where(WorkflowStage.id == run.workflow_stage_id))).scalar_one()
            proj = (await s.execute(select(Project).where(Project.id == project.id))).scalar_one()
            old = st.status
            task.status = TaskStatus.succeeded
            task.finished_at = utcnow()
            task.llm = outcome.llm
            task.output_ref = {"stage_run_id": str(run.id)}
            run.output = outcome.output
            run.generated_by = outcome.generated_by
            run.validation_issues = outcome.validation_issues
            run.partial = outcome.partial
            run.finished_at = utcnow()
            run.status = StageStatus.completed
            if run.review_status == ReviewStatus.pending_review:
                st.status = StageStatus((run.review_decisions or {}).get("prior_status", "completed"))
                new = st.status
                review_message = f"A regenerated {STAGE_BY_KEY[stage_key].title.lower()} version is ready for review"
            else:
                review_message = None
                gate = st.gate_key
                if gate is None:
                    new = StageStatus.completed
                else:
                    policy = merged_policy(proj.approval_policy)[gate]
                    if gate == GateKey.G6:
                        # Decision D10: no person needed unless something blocks (or the policy is `required`).
                        from app.services import automation as automation_svc

                        await s.flush()
                        new, st.gate_status = await automation_svc.g6_state(s, proj)
                        if st.gate_status == GateStatus.approved:
                            g6_auto = True
                    elif policy == GatePolicy.required:
                        new, st.gate_status = StageStatus.awaiting_approval, GateStatus.pending
                    elif policy == GatePolicy.recommended:
                        new, st.gate_status = StageStatus.completed, GateStatus.recommended
                    else:
                        new, st.gate_status = StageStatus.completed, GateStatus.approved
                        s.add(
                            GateDecision(
                                organisation_id=proj.organisation_id,
                                project_id=proj.id,
                                gate_key=gate,
                                stage_run_id=run.id,
                                decision=GateDecisionKind.approve,
                                comment="Approved automatically (policy: auto)",
                                decided_by=None,
                            )
                        )
                        audit(
                            s,
                            org_id=proj.organisation_id,
                            action="gate.approved",
                            target_type="gate",
                            target_id=gate.value,
                            actor_type=ActorType.system,
                            project_id=proj.id,
                            metadata={"policy": "auto"},
                        )
                    if st.gate_status in (GateStatus.pending, GateStatus.recommended):
                        gate_event = {"gate": gate.value, "policy": policy.value}
                run.status = new
                st.status = new
            await touch_project(s, proj)
            await s.commit()
            version = run.version
        for type_, message, data in outcome.events:
            await self._emit(
                project,
                type_,
                message,
                stage=stage_key,
                agent=STAGE_BY_KEY[stage_key].agent_key or ORCH,
                task_id=task_id,
                level=EventLevel.warn if data.get("kind") == "warning" else EventLevel.info,
                data=data,
            )
        await self._status_event(project, stage_key, old, new, version)
        if review_message is not None:
            await self._emit(
                project,
                "review.ready",
                review_message,
                stage=stage_key,
                data={"kind": "review", "stage_key": stage_key.value, "version": version, **_summary(outcome.output)},
            )
        if (
            gate_event is not None
            and gate_event["gate"] == GateKey.G6.value
            and (unchecked := g6_unchecked(outcome.output))
        ):
            await _g6_wait_event(self, project, unchecked)
        elif gate_event is not None:
            g = GateKey(gate_event["gate"])
            await self._emit(
                project,
                "gate.awaiting_approval",
                f"Gate {g.value[1:]}: {GATE_TITLES[g]} is waiting for approval"
                if gate_event["policy"] == "required" or g == GateKey.G6
                else f"Gate {g.value[1:]}: {GATE_TITLES[g]} is ready for review (approval recommended)",
                stage=stage_key,
                data={"kind": "gate", **gate_event},
            )
        if g6_auto:
            await self._emit(
                project,
                "gate.passed_automatically",
                f"Gate 6: {GATE_TITLES[GateKey.G6]} passed automatically",
                stage=stage_key,
                data={"kind": "gate", "gate": GateKey.G6.value},
            )

    async def _fail(
        self, scope: TenantScope, project: Project, task_id: uuid.UUID, run_id: uuid.UUID, reason: str
    ) -> None:
        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            task = (await s.execute(select(AgentTask).where(AgentTask.id == task_id))).scalar_one()
            run = (await s.execute(select(StageRun).where(StageRun.id == run_id))).scalar_one()
            st = (await s.execute(select(WorkflowStage).where(WorkflowStage.id == run.workflow_stage_id))).scalar_one()
            task.status = TaskStatus.failed
            task.error = {"reason": reason}
            task.finished_at = utcnow()
            run.status = StageStatus.failed
            run.error = reason
            run.finished_at = utcnow()
            old = st.status
            if st.current_stage_run_id == run.id:
                st.status = StageStatus.failed
            scan = (await s.execute(select(ScanSession).where(ScanSession.stage_run_id == run.id))).scalar_one_or_none()
            if scan is not None and scan.status in (ScanStatus.queued, ScanStatus.running):
                scan.status = ScanStatus.failed
                scan.error = reason
                scan.finished_at = utcnow()
                scan.current = None
            await s.commit()
            stage_key, version = st.stage_key, run.version
        await self._emit(
            project,
            "task.failed",
            f"{STAGE_BY_KEY[stage_key].title} failed: {reason}",
            stage=stage_key,
            level=EventLevel.error,
            task_id=task_id,
            data={"kind": "error", "reason": reason},
        )
        await self._status_event(project, stage_key, old, StageStatus.failed, version)

    async def on_job_interrupted(self, job: Job) -> None:
        """Called when the reaper gives up on a job (attempts exhausted)."""
        if job.kind == "execution_run":
            await self._execution_interrupted(job)
            return
        if job.kind != "agent_task":
            return
        scope = system_scope(job.organisation_id)
        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            task = (
                await s.execute(select(AgentTask).where(AgentTask.id == uuid.UUID(job.payload["task_id"])))
            ).scalar_one_or_none()
            if task is None or task.stage_run_id is None:
                return
            project = (await s.execute(select(Project).where(Project.id == task.project_id))).scalar_one()
            stage_run_id = task.stage_run_id
        await self._fail(scope, project, task.id, stage_run_id, "interrupted")

    async def _execution_interrupted(self, job: Job) -> None:
        """P4-06 restart safety: a run whose worker stopped is `error`; stored results stay, the rest are errors."""
        from app.db.models import ExecutionRun
        from app.domain.enums import RunStatus
        from app.services import execution as xsvc

        scope = system_scope(job.organisation_id)
        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            run = await s.get(ExecutionRun, uuid.UUID(job.payload["run_id"]))
            if run is None or run.status not in (RunStatus.running, RunStatus.queued):
                return
            project = (await s.execute(select(Project).where(Project.id == run.project_id))).scalar_one()
            await xsvc.write_unfinished(s, run, xsvc.WORKER_STOPPED)
            run.error = xsvc.WORKER_STOPPED
            run.finished_at = utcnow()
            run.status = RunStatus.error
            await self.mirror_execution_run(s, project, run)
            await s.commit()
        await self._enqueue_pending(scope, project.id)
        await self._emit(project, "execution.run_status", f"{run.key} didn't complete", stage=StageKey.execution,
                         level=EventLevel.error, data={"kind": "error", "run_key": run.key, "status": "error"})  # fmt: skip

    async def _run_discovery(
        self, scope: TenantScope, project: Project, task_id: uuid.UUID, run_id: uuid.UUID, job: Job | None
    ) -> None:
        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            scan = (await s.execute(select(ScanSession).where(ScanSession.stage_run_id == run_id))).scalar_one()
            scan_id = scan.id
        agent = DiscoveryAgent(
            self.ctx,
            scope,
            project_id=project.id,
            scan_id=scan_id,
            stage_run_id=run_id,
            task_id=task_id,
            job_id=job.id if job else None,
        )
        outcome = await agent.run()
        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            task = (await s.execute(select(AgentTask).where(AgentTask.id == task_id))).scalar_one()
            run = (await s.execute(select(StageRun).where(StageRun.id == run_id))).scalar_one()
            st = (await s.execute(select(WorkflowStage).where(WorkflowStage.id == run.workflow_stage_id))).scalar_one()
            proj = (await s.execute(select(Project).where(Project.id == project.id))).scalar_one()
            old = st.status
            task.heartbeat_at = utcnow()
            gate_event: dict[str, Any] | None = None
            if outcome.paused:
                task.status = TaskStatus.paused
                task.output_ref = {}
                run.status = StageStatus.paused
                st.status = StageStatus.paused
                new = StageStatus.paused
            elif outcome.scan_status == ScanStatus.failed:
                task.status = TaskStatus.failed
                task.error = {"reason": outcome.error}
                task.finished_at = utcnow()
                run.status = StageStatus.failed
                run.error = outcome.error
                run.finished_at = utcnow()
                run.output = outcome.output
                run.validation_issues = outcome.validation_issues
                run.generated_by = outcome.generated_by
                st.status = StageStatus.failed
                new = StageStatus.failed
            else:
                task.status = (
                    TaskStatus.cancelled if outcome.scan_status == ScanStatus.cancelled else TaskStatus.succeeded
                )
                task.finished_at = utcnow()
                task.output_ref = {"scan_session_id": str(scan_id)}
                task.llm = outcome.llm_usage
                rec = outcome.recommendation.model_dump() if outcome.recommendation else None
                run.output = {**outcome.output, "recommendation": rec}
                run.validation_issues = outcome.validation_issues
                run.generated_by = outcome.generated_by
                run.partial = outcome.partial
                run.finished_at = utcnow()
                policy = merged_policy(proj.approval_policy)[GateKey.G2]
                if outcome.scan_status == ScanStatus.cancelled:
                    new = StageStatus.cancelled
                    st.gate_status = GateStatus.pending if policy == GatePolicy.required else GateStatus.recommended
                elif policy == GatePolicy.required:
                    new = StageStatus.awaiting_approval
                    st.gate_status = GateStatus.pending
                elif policy == GatePolicy.recommended:
                    new = StageStatus.completed
                    st.gate_status = GateStatus.recommended
                else:
                    new = StageStatus.completed
                    st.gate_status = GateStatus.approved
                    s.add(
                        GateDecision(
                            organisation_id=proj.organisation_id,
                            project_id=proj.id,
                            gate_key=GateKey.G2,
                            stage_run_id=run.id,
                            decision=GateDecisionKind.approve,
                            comment="Approved automatically (policy: auto)",
                            decided_by=None,
                            agent_recommendation=rec,
                        )
                    )
                    audit(
                        s,
                        org_id=proj.organisation_id,
                        action="gate.approved",
                        target_type="gate",
                        target_id="G2",
                        actor_type=ActorType.system,
                        project_id=proj.id,
                        metadata={"policy": "auto"},
                    )
                run.status = new
                st.status = new
                if st.gate_status in (GateStatus.pending, GateStatus.recommended):
                    gate_event = {"gate": "G2", "policy": policy.value, "recommendation": rec}
            await touch_project(s, proj)
            await s.commit()
            version = run.version
        await self._status_event(project, StageKey.discovery, old, new, version)
        if gate_event is not None:
            required = gate_event["policy"] == "required"
            await self._emit(
                project,
                "gate.awaiting_approval",
                "Gate 2: Discovery completeness is waiting for your approval"
                if required
                else "Gate 2: Discovery completeness is ready for review (approval recommended)",
                stage=StageKey.discovery,
                level=EventLevel.info,
                data={"kind": "gate", **gate_event},
            )

    async def _run_report_stage(
        self, scope: TenantScope, project: Project, task_id: uuid.UUID, run_id: uuid.UUID
    ) -> None:
        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            run = (await s.execute(select(StageRun).where(StageRun.id == run_id))).scalar_one()
            disc = await self.stage(s, project.id, StageKey.discovery)
            drun = await self.current_run(s, disc)
            if drun is None:
                raise GateBlocked("Discovery has no results")
            scan = (await s.execute(select(ScanSession).where(ScanSession.stage_run_id == drun.id))).scalar_one()
            report = QaReport(
                organisation_id=project.organisation_id,
                project_id=project.id,
                report_type=ReportType.discovery,
                version=await next_report_version(s, project.id, ReportType.discovery),
                status=ReportStatus.rendering,
                stage_run_id=drun.id,
                scan_session_id=scan.id,
                created_by=run.triggered_by,
            )
            s.add(report)
            # Commit before emitting: the emitter writes through its own session and SQLite allows one writer.
            await s.commit()
            await self._emit(
                project,
                "log",
                "Generating Application Discovery Report",
                stage=StageKey.discovery_report,
                agent="reporting",
                task_id=task_id,
                data={"kind": "action"},
            )
            await render_report(self.ctx, s, report)
            task = (await s.execute(select(AgentTask).where(AgentTask.id == task_id))).scalar_one()
            st = (await s.execute(select(WorkflowStage).where(WorkflowStage.id == run.workflow_stage_id))).scalar_one()
            old = st.status
            ok = report.status == ReportStatus.ready
            task.status = TaskStatus.succeeded if ok else TaskStatus.failed
            task.finished_at = utcnow()
            task.output_ref = {"report_id": str(report.id)}
            run.status = StageStatus.completed if ok else StageStatus.failed
            run.output = {
                "report_id": str(report.id),
                "report_version": report.version,
                "scan_session_id": str(scan.id),
            }
            run.generated_by = report.generated_by
            run.partial = bool((report.content or {}).get("partial"))
            run.error = report.error
            run.finished_at = utcnow()
            st.status = run.status
            await s.commit()
            new, version, report_id, report_version, error = (
                st.status,
                run.version,
                report.id,
                report.version,
                report.error,
            )
        await self._status_event(project, StageKey.discovery_report, old, new, version)
        if new == StageStatus.completed:
            await self._emit(
                project,
                "report.ready",
                f"Generated Application Discovery Report (version {report_version}, draft)",
                stage=StageKey.discovery_report,
                agent="reporting",
                data={"kind": "finding", "report_id": str(report_id), "version": report_version},
            )
        else:
            await self._emit(
                project,
                "task.failed",
                error or "Report generation failed",
                stage=StageKey.discovery_report,
                level=EventLevel.error,
                agent="reporting",
                data={"kind": "error", "reason": error},
            )

    async def signin_test_job(self, scope: TenantScope, task_id: uuid.UUID) -> None:
        """P2-01 "Test sign-in": one sign-in attempt, no crawl. Values never reach events, logs or the task row."""
        from app.agents.discovery.signin import sign_in
        from app.browser.network_policy import NetworkPolicy
        from app.security.ssrf import normalise_url
        from app.services.secrets import credentials_secret, use_credentials

        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            task = (await s.execute(select(AgentTask).where(AgentTask.id == task_id))).scalar_one_or_none()
            if task is None or task.status != TaskStatus.queued:
                return
            project = (await s.execute(select(Project).where(Project.id == task.project_id))).scalar_one()
            secret = await credentials_secret(s, project.id)
            url = (
                await s.execute(
                    select(ProjectUrl).where(ProjectUrl.project_id == project.id, ProjectUrl.role == UrlRole.primary)
                )
            ).scalar_one()
            task.status = TaskStatus.running
            task.started_at = utcnow()
            if secret is None:
                task.status = TaskStatus.failed
                task.error = {"reason": "No test credentials saved"}
                await s.commit()
                return
            creds = await use_credentials(self.ctx, s, secret, purpose="signin_test", task_id=task_id)
            await s.commit()
            start = normalise_url((url.last_check or {}).get("final_url") or url.url)
            hosts = list(url.allowed_hosts or []) or [start.host]
        login_url = creds["login_url"]
        await self._emit(
            project,
            "auth.signin_started",
            "Testing sign-in with the saved credentials",
            agent="discovery",
            task_id=task_id,
            data={"kind": "action", "login_url": login_url},
        )
        policy = NetworkPolicy(
            approved_origins={start.origin, normalise_url(login_url).origin},
            allowed_hosts=hosts,
            allow_private_targets=self.ctx.settings.allow_private_targets,
            resolver=self.ctx.resolver,
            fetch_timeout_ms=self.ctx.settings.scan_page_timeout_s * 1000,
        )
        try:
            async with self.ctx.browser_pool.isolated_context(policy) as context:
                outcome = await sign_in(context, policy, login_url, creds["username"], creds["password"])
        except Exception:  # noqa: BLE001 - report as a failed attempt, never retry
            log.warning("sign-in test could not start the browser")
            from app.agents.discovery.signin import SignInOutcome

            outcome = SignInOutcome("failed", "timeout")
        del creds
        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            task = (await s.execute(select(AgentTask).where(AgentTask.id == task_id))).scalar_one()
            row = await credentials_secret(s, project.id)
            if row is not None:
                from app.domain.enums import SignInResult

                row.last_used_at = utcnow()
                row.last_result = SignInResult(outcome.result)
                row.last_reason_code = outcome.reason_code
                row.last_result_at = utcnow()
            task.status = TaskStatus.succeeded
            task.finished_at = utcnow()
            task.output_ref = {"result": outcome.result, "reason_code": outcome.reason_code}
            audit(
                s,
                org_id=project.organisation_id,
                action="secret.tested",
                target_type="secret",
                target_id=row.id if row else None,
                actor_type=ActorType.system,
                project_id=project.id,
                metadata={"result": outcome.result, "reason_code": outcome.reason_code},
            )
            await s.commit()
        if outcome.result == "succeeded":
            from urllib.parse import urlsplit

            await self._emit(
                project,
                "auth.signin_succeeded",
                "Sign-in test succeeded",
                agent="discovery",
                task_id=task_id,
                data={
                    "kind": "finding",
                    "login_url": login_url,
                    "landing_path": urlsplit(outcome.landing_url or "").path or "/",
                },
            )
        else:
            await self._emit(
                project,
                "auth.signin_failed",
                f"Sign-in test failed ({outcome.reason_code})",
                agent="discovery",
                task_id=task_id,
                level=EventLevel.warn,
                data={"kind": "warning", "login_url": login_url, "reason_code": outcome.reason_code},
            )

    async def document_job(self, scope: TenantScope, document_id: uuid.UUID) -> None:
        """P2-08 extraction: bounded (60 s, 200 pages, 500k chars, 20 MB decompressed DOCX) in a worker thread."""
        import asyncio

        from app.db.models import Evidence, SourceDocument
        from app.domain.enums import DocumentStatus, EvidenceKind
        from app.services import documents as docs
        from app.services.evidence import write_evidence

        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            doc = (await s.execute(select(SourceDocument).where(SourceDocument.id == document_id))).scalar_one_or_none()
            if doc is None or doc.status != DocumentStatus.extracting:
                return
            ev = (await s.execute(select(Evidence).where(Evidence.id == doc.file_evidence_id))).scalar_one()
            data = await self.ctx.storage.get(ev.storage_key)
            project = (await s.execute(select(Project).where(Project.id == doc.project_id))).scalar_one()
            try:
                result = await asyncio.wait_for(asyncio.to_thread(docs.extract, data, doc.mime), timeout=60)
                error = None
            except docs.DocumentError as exc:
                result, error = None, str(exc)
            except TimeoutError:
                result, error = None, "Extraction took longer than 60 seconds"
            if result is None:
                doc.status = DocumentStatus.failed
                doc.error = error
            else:
                text_ev = await write_evidence(
                    s,
                    self.ctx.storage,
                    org_id=doc.organisation_id,
                    project_id=doc.project_id,
                    kind=EvidenceKind.document_text,
                    data=result.text.encode(),
                    mime="text/plain",
                    name=f"{doc.key}.txt",
                    owner_id=doc.id,
                    metadata={
                        "filename": f"{doc.key}.txt",
                        "document_key": doc.key,
                        "outline": [o.__dict__ for o in result.outline],
                    },
                )
                await s.flush()
                text_ev.source_document_id = doc.id
                doc.text_evidence_id = text_ev.id
                doc.status = DocumentStatus.ready
                doc.pages = result.pages
                doc.chars = len(result.text)
                doc.outline = [o.__dict__ for o in result.outline]
                doc.statements = result.statements
                doc.injection_flags = result.injection
            await s.commit()
            key, ok, chars, found = doc.key, doc.status == DocumentStatus.ready, doc.chars, len(doc.statements or [])
        if ok:
            await self._emit(
                project,
                "document.extracted",
                f"Read {key}: {found} requirement-like statement(s)",
                stage=StageKey.requirements,
                agent="requirements",
                data={
                    "kind": "finding",
                    "document_id": str(document_id),
                    "key": key,
                    "chars": chars,
                    "statements_found": found,
                },
            )
        else:
            await self._emit(
                project,
                "document.failed",
                f"Could not read {key}: {error}",
                stage=StageKey.requirements,
                agent="requirements",
                level=EventLevel.warn,
                data={"kind": "warning", "document_id": str(document_id), "key": key, "reason": error},
            )

    async def plan_job(self, scope: TenantScope, project_id: uuid.UUID) -> None:
        """Writes the test plan after G4 approval (P2-07): a job inside the test_strategy stage."""
        from app.services import plan as plan_svc

        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            project = (await s.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
            if project is None:
                return
            row = await plan_svc.ensure_plan_after_g4(s, project)
            report_id = None
            if row is not None:
                from app.agents.reporting import phase2_reports

                await s.flush()
                frozen = await phase2_reports.create(s, project, ReportType.test_plan, user_id=None, frozen=True)
                report_id = frozen.id
            await s.commit()
            version = row.version if row else None
        if report_id is not None:
            await self.ctx.queue.enqueue(
                "report_render",
                {"report_id": str(report_id)},
                org_id=project.organisation_id,
                project_id=project.id,
                dedupe_key=f"report:{report_id}",
            )
        if version is not None:
            await self._emit(
                project,
                "plan.ready",
                f"Test plan version {version} written from the approved test strategy",
                stage=StageKey.test_strategy,
                agent="strategy",
                data={"kind": "finding", "version": version},
            )

    async def render_report_job(self, scope: TenantScope, report_id: uuid.UUID) -> None:
        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            report = (await s.execute(select(QaReport).where(QaReport.id == report_id))).scalar_one_or_none()
            if report is None:
                return
            project = (await s.execute(select(Project).where(Project.id == report.project_id))).scalar_one()
            report.status = ReportStatus.rendering
            await render_report(self.ctx, s, report)
            await s.commit()
            ok, version, rtype = report.status == ReportStatus.ready, report.version, report.report_type
        if ok:
            from app.agents.reporting.phase2_reports import REPORT_STAGE, TITLES

            title = TITLES.get(rtype, "Application Discovery Report")
            await self._emit(
                project,
                "report.ready",
                f"{title} version {version} is ready",
                stage=REPORT_STAGE.get(rtype, StageKey.discovery_report),
                agent="reporting",
                data={
                    "kind": "finding",
                    "report_id": str(report_id),
                    "version": version,
                    "report_type": rtype.value,
                },
            )
