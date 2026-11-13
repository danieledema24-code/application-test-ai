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

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.discovery.agent import DiscoveryAgent, empty_stats
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
    ScanStatus,
    StageKey,
    StageStatus,
    TaskStatus,
    UrlRole,
)
from app.domain.stages import (
    ACTIVE_STATUSES,
    GATE_STAGE,
    GATE_TITLES,
    OUTPUT_STATUSES,
    STAGE_BY_KEY,
    STAGES,
    downstream_of,
    merged_policy,
)
from app.services.audit import audit
from app.services.counters import next_key

log = logging.getLogger(__name__)
ORCH = "orchestrator"
SCAN_GROUP = "scan"
RUNNABLE_IN_PHASE = frozenset({StageKey.discovery, StageKey.discovery_report})


class Orchestrator:
    def __init__(self, ctx: AppContext) -> None:
        self.ctx = ctx
        # Status-change events to emit once the stage rows are committed.
        self._pending_events: list[tuple[Project, StageKey, StageStatus, StageStatus, int]] = []

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

    async def advance(
        self, scope: TenantScope, project_id: uuid.UUID, *, triggered_by: uuid.UUID | None = None
    ) -> list[StageKey]:
        """Queues every runnable Phase 1 stage. Idempotent."""
        queued: list[StageKey] = []
        async with self.ctx.session_factory() as s:
            bind_scope(s, scope)
            project = (await s.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
            if project is None or project.status != ProjectStatus.active:
                return queued
            discovery = await self.stage(s, project.id, StageKey.discovery)
            report = await self.stage(s, project.id, StageKey.discovery_report)
            if discovery.status == StageStatus.not_started:
                await self._queue_stage(s, project, discovery, triggered_by=triggered_by, parameters=None)
                queued.append(StageKey.discovery)
            elif discovery.status in OUTPUT_STATUSES:
                drun = await self.current_run(s, discovery)
                rrun = await self.current_run(s, report)
                has_pages = drun is not None and int((drun.output or {}).get("pages", 0)) > 0
                upstream_v = (rrun.upstream_versions or {}).get("discovery") if rrun else None
                if (
                    has_pages
                    and report.status not in ACTIVE_STATUSES
                    and (
                        rrun is None
                        or report.status in (StageStatus.stale, StageStatus.not_started)
                        or (drun is not None and upstream_v != drun.version)
                    )
                ):
                    await self._queue_stage(s, project, report, triggered_by=triggered_by, parameters=None)
                    queued.append(StageKey.discovery_report)
            await s.commit()
        await self._enqueue_pending(scope, project_id)
        return queued

    async def _queue_stage(
        self,
        s: AsyncSession,
        project: Project,
        st: WorkflowStage,
        *,
        triggered_by: uuid.UUID | None,
        parameters: dict[str, Any] | None,
    ) -> StageRun:
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
        params = parameters or {}
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
                k: settings[k] for k in ("max_pages", "max_depth", "include_mobile", "respect_robots") if k in settings
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
        st.current_stage_run_id = run.id
        st.stale_reason = None
        st.gate_status = GateStatus.none
        st.updated_by = triggered_by
        await s.flush()
        self._pending_events.append((project, st.stage_key, old, StageStatus.queued, version))
        return run

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
            for u in d.upstream:
                ust = await self.stage(s, project.id, u)
                if ust.status not in OUTPUT_STATUSES:
                    raise GateBlocked(f"{STAGE_BY_KEY[u].title} must finish first")
                if u == StageKey.discovery:
                    urun = await self.current_run(s, ust)
                    if urun is None or int((urun.output or {}).get("pages", 0)) == 0:
                        raise GateBlocked("Discovery has no results to report on")
            prev = await self.current_run(s, st)
            try:
                run = await self._queue_stage(s, project, st, triggered_by=scope.user_id, parameters=parameters)
            except IntegrityError as exc:
                raise Conflict(f"{d.title} is already queued or running") from exc
            stale: list[StageKey] = []
            for dk in downstream_of(stage_key):
                dst = await self.stage(s, project.id, dk)
                if dst.status in OUTPUT_STATUSES or dst.status in (StageStatus.failed, StageStatus.changes_requested):
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
                    "parameters": parameters or {},
                },
            )
            project.updated_at = utcnow()
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
                run = await self.current_run(s, st)
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
                run = await self.current_run(s, st)
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
            run = await self.current_run(s, st)
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
            version = run.version
        if immediate:
            await self._status_event(project, stage_key, old, StageStatus.cancelled, version)
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
                    agent_recommendation=(run.output or {}).get("recommendation"),
                )
            )
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
            project.updated_at = utcnow()
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
            if report is not None and report.status == ReportStatus.ready:
                report.status = ReportStatus.rendering
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
        if report_id is not None:
            await self.ctx.queue.enqueue(
                "report_render",
                {"report_id": str(report_id)},
                org_id=project.organisation_id,
                project_id=project.id,
                dedupe_key=f"report:{report_id}",
            )

    # ------------------------------------------------------------------ worker side

    async def run_job(self, job: Job) -> None:
        scope = system_scope(job.organisation_id)
        if job.kind == "agent_task":
            await self.run_task(scope, uuid.UUID(job.payload["task_id"]), job)
        elif job.kind == "report_render":
            await self.render_report_job(scope, uuid.UUID(job.payload["report_id"]))
        else:
            raise ValueError(f"Unknown job kind {job.kind}")

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
            if st.current_stage_run_id != run.id:
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
            else:
                raise ValueError(f"Stage {stage_key.value} is not implemented in this phase")
        except Exception as exc:
            log.exception("stage %s failed", stage_key.value)
            await self._fail(scope, project, task_id, run.id, f"Unexpected error: {str(exc).splitlines()[0][:200]}")
            return
        await self.advance(scope, project.id)

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
            proj.updated_at = utcnow()
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
            ok, version = report.status == ReportStatus.ready, report.version
        if ok:
            await self._emit(
                project,
                "report.ready",
                f"Application Discovery Report version {version} is ready",
                stage=StageKey.discovery_report,
                agent="reporting",
                data={"kind": "finding", "report_id": str(report_id), "version": version},
            )
