"""The `performance_run` job (P5-01b): one approved load test with the built-in load generator (P5-01a).

Starts only from `queued` (an approved `load_test` approval, which becomes `used` here), one per organisation (job
group `performance`) and never beside a test run on the same project. Progress is stored as numbers only
(`metrics.live`, events `performance.progress`); the summary and the one-second time series become evidence;
thresholds are judged in code. "Stop now" is polled every 0.5 s and stops the generator within 2 s. A run whose
worker stopped is `error`, and the generator stops itself when its parent dies.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import shutil
import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import cast, func, literal_column, select, update
from sqlalchemy.dialects.postgresql import JSONB

from app.automation.loadgen import LoadGenerator, LoadGeneratorError, LoadRefused, LoadResult
from app.context import AppContext
from app.db.models import Approval, Defect, ExecutionRun, Job, PerformanceRun, Project
from app.db.tenant import TenantScope, bind_scope, system_scope
from app.db.types import utcnow
from app.domain.enums import (
    ActorType,
    ApprovalStatus,
    DefectSeverity,
    DefectSource,
    EventLevel,
    EvidenceKind,
    PerfRunStatus,
    Priority,
    RunStatus,
    StageKey,
)
from app.domain.performance import profile as rules
from app.domain.stages import PERF_RUN_STAGE_STATUS
from app.services import defects as dsvc
from app.services import performance as psvc
from app.services.audit import audit
from app.services.evidence import write_evidence

log = logging.getLogger(__name__)
AGENT = "performance"
WORKER_STOPPED = "The worker stopped; the run did not complete"
POLL_S = 0.5
NO_DRAFT_ABORTED = (
    "No defect drafted: a load test stopped this way may be caused by the environment. Raise one if the site itself "
    "is at fault."
)


class LoadTestJob:
    def __init__(self, ctx: AppContext, scope: TenantScope, run_id: uuid.UUID) -> None:
        from app.orchestrator.orchestrator import Orchestrator

        self.ctx, self.scope, self.run_id = ctx, scope, run_id
        self.orch = Orchestrator(ctx)
        self.stop = asyncio.Event()
        self._series: list[dict[str, Any]] = []  # the live series lives here; the row gets a copy each second

    async def _emit(
        self, project: Project, type_: str, message: str, data: dict[str, Any], level: EventLevel = EventLevel.info
    ) -> None:
        await self.ctx.events.emit(
            org_id=project.organisation_id,
            project_id=project.id,
            type=type_,
            message=message,
            level=level,
            stage_key=StageKey.performance.value,
            agent_key=AGENT,
            data=data,
        )

    async def _set(self, s: Any, project: Project, run: PerformanceRun, status: PerfRunStatus) -> None:
        run.status = status
        await self.orch.mirror_nonfunctional(s, project, StageKey.performance, run, PERF_RUN_STAGE_STATUS.get(status))

    async def run(self) -> None:
        async with self.ctx.session_factory() as s:
            bind_scope(s, self.scope)
            run = await s.get(PerformanceRun, self.run_id)
            if run is None:
                return
            project = (await s.execute(select(Project).where(Project.id == run.project_id))).scalar_one()
            if run.status == PerfRunStatus.running:
                await self._finish_error(s, project, run, WORKER_STOPPED)  # started again after its worker died
                return
            if run.status != PerfRunStatus.queued:
                return
            busy = (
                await s.execute(
                    select(ExecutionRun.key).where(
                        ExecutionRun.project_id == run.project_id, ExecutionRun.status == RunStatus.running
                    )
                )
            ).first()
            if busy is not None:  # never beside a test run on the same project: wait for it
                await self.ctx.queue.enqueue(
                    "performance_run",
                    {"run_id": str(run.id)},
                    org_id=run.organisation_id,
                    project_id=run.project_id,
                    concurrency_group=psvc.PERF_GROUP,
                    run_after=utcnow() + timedelta(seconds=5),
                    max_attempts=1,
                )
                return
            a = (await s.execute(select(Approval).where(Approval.performance_run_id == run.id))).scalar_one_or_none()
            if a is None or a.status != ApprovalStatus.approved:
                await self._finish_error(s, project, run, "The load test has no approval to use")
                return
            # D18: the limits are checked once more when the load would start.
            issues = psvc.check_profile(self.ctx, await psvc.org_ceiling(s, run.organisation_id), run.profile_snapshot)
            if issues:
                await self._finish_error(s, project, run, f"The load test is over a limit now: {issues[0].message}")
                return
            a.status = ApprovalStatus.used
            audit(
                s,
                org_id=a.organisation_id,
                action="approval.used",
                target_type="approval",
                target_id=a.id,
                project_id=a.project_id,
                actor_type=ActorType.system,
                metadata={"key": a.key, "run": run.key},
            )
            tk = await self.ctx.toolkit.version()
            run.engine = {"name": "ata-loadgen", "version": tk.loadgen if tk else None}
            run.started_at = utcnow()
            await self._set(s, project, run, PerfRunStatus.running)
            audit(
                s,
                org_id=run.organisation_id,
                action="performance_run.started",
                target_type="performance_run",
                target_id=run.id,
                project_id=run.project_id,
                actor_type=ActorType.system,
                metadata={"key": run.key},
            )
            await s.commit()
            snap = dict(run.profile_snapshot or {})
            key = run.key
        await self.orch._enqueue_pending(self.scope, project.id)
        vus, _rps, duration, _ntargets = rules.numbers(snap)
        await self._emit(
            project,
            "performance.run_status",
            f"{key} started: up to {vus} virtual users for {rules.ms_text(duration * 1000)}",
            {"kind": "status", "run_key": key, "status": "running"},
        )
        config = rules.generator_config(
            snap, origin=snap["origin"], host=snap["host"], allow_private=self.ctx.settings.allow_private_targets
        )
        workdir = self.ctx.settings.automation_dir / ".runs" / f"perf-{self.run_id}"
        gen = LoadGenerator(self.ctx.toolkit, self.ctx.settings.load_hard_cap)
        poller = asyncio.create_task(self._poll_stop())
        result: LoadResult | None = None
        failure: str | None = None
        try:
            result = await gen.run(
                config, workdir, on_progress=lambda line: self._progress(project, key, duration, line), stop=self.stop
            )
        except (LoadRefused, LoadGeneratorError) as exc:
            failure = f"The load generator refused the run: {exc}"
        except Exception as exc:
            log.exception("load test failed")
            failure = (
                f"The load test didn't complete: {str(exc).splitlines()[0][:200] if str(exc) else type(exc).__name__}"
            )
        finally:
            poller.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await poller
            await asyncio.to_thread(shutil.rmtree, workdir, True)
        await self._finish(project, result, failure)

    async def _poll_stop(self) -> None:
        # The stop signal is `stopped_by`, a column only "Stop now" writes, so a progress write can never erase it.
        while not self.stop.is_set():
            await asyncio.sleep(POLL_S)
            try:
                async with self.ctx.session_factory() as s:
                    bind_scope(s, self.scope)
                    row = (
                        await s.execute(select(PerformanceRun.stopped_by).where(PerformanceRun.id == self.run_id))
                    ).first()
            except Exception:  # a busy database must not end the poller, or later stops would be ignored
                log.warning("stop poll failed; retrying", exc_info=True)
                continue
            if row is None or row.stopped_by is not None:
                self.stop.set()

    async def _progress(self, project: Project, key: str, duration: int, line: dict[str, Any]) -> None:
        live = {
            k: line.get(k)
            for k in ("t", "users", "rps", "p95_ms", "errors", "requests", "requests_total", "errors_total")
        }
        self._series = [*self._series[-600:], live]
        try:
            async with self.ctx.session_factory() as s:
                bind_scope(s, self.scope)
                await self._write_live(s, live, self._series)
                await s.commit()
        except Exception:  # live progress is best-effort: a failed write must not end (or un-stop) the load test
            log.warning("live progress write failed; continuing", exc_info=True)
            return
        await self._emit(
            project,
            "performance.progress",
            f"{key}: {line.get('users')} users",
            {"kind": "progress", "run_key": key, **{k: live[k] for k in ("t", "users", "rps", "p95_ms", "errors")}},
        )

    async def _write_live(self, s: Any, live: dict[str, Any], series: list[dict[str, Any]]) -> None:
        """Sets only `metrics.live` and `metrics.live_series`, in one statement: nothing written beside it is lost."""
        col = PerformanceRun.metrics
        if s.get_bind().dialect.name == "postgresql":
            value: Any = func.coalesce(col, cast({}, JSONB)).op("||")(
                func.jsonb_build_object("live", cast(live, JSONB), "live_series", cast(series, JSONB))
            )
        else:
            value = func.json_set(
                func.ifnull(col, literal_column("'{}'")),
                "$.live",
                func.json(json.dumps(live)),
                "$.live_series",
                func.json(json.dumps(series)),
            )
        await s.execute(
            update(PerformanceRun)
            .where(PerformanceRun.id == self.run_id)
            .values(metrics=value)
            .execution_options(synchronize_session=False)
        )

    async def _finish_error(self, s: Any, project: Project, run: PerformanceRun, reason: str) -> None:
        run.error = reason
        run.finished_at = utcnow()
        await self._set(s, project, run, PerfRunStatus.error)
        await s.commit()
        await self.orch._enqueue_pending(self.scope, project.id)
        await self._emit(
            project,
            "performance.run_status",
            f"{run.key} didn't complete",
            {"kind": "error", "run_key": run.key, "status": "error"},
            EventLevel.error,
        )

    async def _finish(self, project: Project, result: LoadResult | None, failure: str | None) -> None:
        drafted: list[str] = []
        async with self.ctx.session_factory() as s:
            bind_scope(s, self.scope)
            run = await s.get(PerformanceRun, self.run_id)
            assert run is not None
            summary = (result.summary if result else None) or {}
            if summary:
                await self._evidence(s, project, run, summary)
                series = summary.get("timeseries") or (run.metrics or {}).get("live_series") or []
                run.metrics = {
                    **(run.metrics or {}),
                    "overall": summary.get("overall"),
                    "targets": summary.get("targets"),
                    "duration_s": summary.get("duration_s"),
                    "generator_location": summary.get("generator_location"),
                    "timeseries": series[-1800:],
                }
                if summary.get("engine"):
                    run.engine = {"name": summary["engine"].get("name"), "version": summary["engine"].get("version")}
            stopped_by_person = run.stopped_by is not None
            run.finished_at = utcnow()
            snap = run.profile_snapshot or {}
            status: PerfRunStatus
            if failure is not None or result is None:
                run.error = failure or "The load test didn't complete"
                status = PerfRunStatus.error
            elif result.status == "completed":
                run.threshold_results = rules.evaluate(snap.get("thresholds") or [], summary, judged=True)
                missed = [r for r in run.threshold_results if r["result"] == "missed"]
                status = PerfRunStatus.failed if missed else PerfRunStatus.passed
            elif result.status == "stopped" and stopped_by_person:
                run.threshold_results = rules.evaluate(snap.get("thresholds") or [], summary, judged=False)
                status = PerfRunStatus.stopped
            elif result.status == "aborted":
                run.threshold_results = rules.evaluate(snap.get("thresholds") or [], summary, judged=False)
                run.aborted_reason = result.reason or "Stopped automatically"
                status = PerfRunStatus.aborted
            else:
                run.threshold_results = rules.evaluate(snap.get("thresholds") or [], summary, judged=False)
                run.error = (
                    (result.reason or "The load test didn't complete") if result.status != "stopped" else WORKER_STOPPED
                )
                status = PerfRunStatus.error
            await self._set(s, project, run, status)
            if status == PerfRunStatus.failed:
                drafted = await self._drafts(s, project, run)
            audit(
                s,
                org_id=run.organisation_id,
                action={
                    PerfRunStatus.stopped: "performance_run.stopped",
                    PerfRunStatus.aborted: "performance_run.aborted",
                }.get(status, "performance_run.finished"),
                target_type="performance_run",
                target_id=run.id,
                project_id=run.project_id,
                actor_type=ActorType.system,
                metadata={"key": run.key, "status": status.value, "drafted": drafted},
            )
            if status in (PerfRunStatus.passed, PerfRunStatus.failed):
                # P6-05a: a judged load test is new evidence for an assessment waiting for G9.
                from app.services.release import mark_stale

                await mark_stale(s, run.project_id, f"{run.key} finished")
            await s.commit()
            message = self._message(run)
            key = run.key
        await self.orch._enqueue_pending(self.scope, project.id)
        if status in (PerfRunStatus.passed, PerfRunStatus.failed, PerfRunStatus.stopped, PerfRunStatus.aborted):
            # P5-04a: the load test's report freezes when it finishes.
            from app.agents.reporting.phase5_reports import freeze_for
            from app.domain.enums import ReportType

            await freeze_for(self.ctx, self.scope, project.id, ReportType.performance, key)
        level = (
            EventLevel.warn
            if status == PerfRunStatus.aborted
            else (EventLevel.error if status == PerfRunStatus.error else EventLevel.info)
        )
        await self._emit(
            project,
            "performance.run_status",
            message,
            {"kind": "status", "run_key": key, "status": status.value},
            level,
        )
        for d in drafted:
            await self.ctx.events.emit(
                org_id=project.organisation_id,
                project_id=project.id,
                type="defect.drafted",
                message=f"Drafted {d} from {key}",
                stage_key=StageKey.performance.value,
                agent_key=AGENT,
                data={"kind": "result", "defect_key": d},
            )

    def _message(self, run: PerformanceRun) -> str:
        tr = run.threshold_results or []
        met = sum(1 for r in tr if r["result"] == "met")
        if run.status in (PerfRunStatus.passed, PerfRunStatus.failed):
            return f"{run.key} finished: {met} of {len(tr)} thresholds met"
        if run.status == PerfRunStatus.aborted:
            return f"{run.key} {(run.aborted_reason or 'stopped automatically').replace('Stopped', 'stopped', 1)}"
        if run.status == PerfRunStatus.stopped:
            return f"{run.key} stopped"
        return f"{run.key} didn't complete"

    async def _evidence(self, s: Any, project: Project, run: PerformanceRun, summary: dict[str, Any]) -> None:
        series = summary.get("timeseries") or []
        body = {k: v for k, v in summary.items() if k != "timeseries"}
        for kind, data, name in (
            (EvidenceKind.perf_summary, body, "perf-summary.json"),
            (EvidenceKind.perf_timeseries, {"run": run.key, "timeseries": series}, "perf-timeseries.json"),
        ):
            ev = await write_evidence(
                s,
                self.ctx.storage,
                org_id=project.organisation_id,
                project_id=project.id,
                kind=kind,
                data=json.dumps(data, default=str).encode(),
                mime="application/json",
                name=name,
                owner_id=run.id,
                source_url=(run.profile_snapshot or {}).get("origin"),
                metadata={"run_key": run.key},
            )
            ev.performance_run_id = run.id

    async def _drafts(self, s: Any, project: Project, run: PerformanceRun) -> list[str]:
        """D20: one draft per missed threshold, or an occurrence on the open draft/defect for the same threshold."""
        snap = run.profile_snapshot or {}
        users = rules.numbers(snap)[0]
        titles = {t["path"]: t.get("title") or "" for t in snap.get("targets") or []}
        if not all(titles.values()):  # targets edited through the API may carry no title: use discovery's
            for p in await psvc.page_infos(s, run.project_id):
                path = rules.path_of(p.url)
                if not titles.get(path) and p.title:
                    titles[path] = p.title
        out: list[str] = []
        open_defects = list(
            (
                await s.execute(
                    select(Defect).where(
                        Defect.project_id == run.project_id,
                        Defect.source == DefectSource.performance,
                        Defect.status.in_(dsvc.OPEN),
                    )
                )
            ).scalars()
        )
        for th in run.threshold_results or []:
            if th["result"] != "missed":
                continue
            tkey = f"{th['metric']}|{th.get('path') or 'all'}"
            existing = next((d for d in open_defects if (d.environment or {}).get("threshold_key") == tkey), None)
            if existing is not None:
                env = dict(existing.environment or {})
                env["occurrences"] = [
                    *(env.get("occurrences") or []),
                    {"run_key": run.key, "measured": th["measured"], "at": utcnow().isoformat()},
                ]
                # The summary and the measured line follow the latest measurement; earlier ones stay in occurrences.
                summary, _expected, actual = rules.defect_text(th, users=users, page_title=titles.get(th.get("path")))
                existing.summary = summary
                existing.actual = actual
                env["threshold"] = th
                existing.environment = env
                continue
            summary, expected, actual = rules.defect_text(th, users=users, page_title=titles.get(th.get("path")))
            src = th.get("source") or {}
            fields = {
                "summary": summary,
                "description": f"Measured during {run.key} ({snap.get('profile_key')} v{snap.get('profile_version')}, "
                f"up to {users} virtual users).",
                "environment": {
                    "url": snap.get("origin"),
                    "engine": f"Built-in load generator {(run.engine or {}).get('version') or ''}".strip(),
                    "profile": f"{snap.get('profile_key')} v{snap.get('profile_version')}",
                    "run_key": run.key,
                    "virtual_users": users,
                    "threshold_key": tkey,
                    "threshold": th,
                    "occurrences": [{"run_key": run.key, "measured": th["measured"], "at": utcnow().isoformat()}],
                },
                "preconditions": [],
                "steps": [
                    f"Run {snap.get('profile_key')} v{snap.get('profile_version')} ({snap.get('summary')}), or the "
                    "exported k6 script.",
                    f"Watch {th.get('path') or 'all requests'}.",
                ],
                "expected": expected,
                "actual": actual,
                "severity": DefectSeverity.major if src.get("type") == "requirement" else DefectSeverity.minor,
                "severity_derived": DefectSeverity.major if src.get("type") == "requirement" else DefectSeverity.minor,
                "severity_reason": "threshold from a requirement"
                if src.get("type") == "requirement"
                else "default threshold",
                "priority": Priority.medium,
                "priority_derived": Priority.medium,
                "priority_reason": "default for performance drafts",
                "reproducibility": {"kind": "always"},
                "root_cause_hypothesis": "Not analysed. Automated checks measure what happens, not why.",
                "evidence_refs": [],
            }
            d = await dsvc.create_defect(
                s, project, fields, source=DefectSource.performance, result=None, case=None, user_id=None
            )
            if src.get("type") == "requirement":
                from app.db.models import DefectLink

                s.add(
                    DefectLink(
                        organisation_id=project.organisation_id,
                        project_id=project.id,
                        defect_id=d.id,
                        requirement_lineage_id=uuid.UUID(src["lineage_id"]),
                    )
                )
            out.append(d.key)
            open_defects.append(d)
        return out


async def run_load_test(ctx: AppContext, scope: TenantScope, run_id: uuid.UUID, job: Job | None) -> None:
    await LoadTestJob(ctx, scope, run_id).run()


async def run_interrupted(ctx: AppContext, job: Job) -> None:
    """The reaper gave up on the job: a running or queued load test is `error`; partial metrics are kept."""
    scope = system_scope(job.organisation_id)
    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        run = await s.get(PerformanceRun, uuid.UUID(job.payload["run_id"]))
        if run is None or run.status not in psvc.ACTIVE:
            return
        project = (await s.execute(select(Project).where(Project.id == run.project_id))).scalar_one()
        await LoadTestJob(ctx, scope, run.id)._finish_error(s, project, run, WORKER_STOPPED)
