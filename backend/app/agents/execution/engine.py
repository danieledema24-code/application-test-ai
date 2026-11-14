"""The execution engine (P4-06): runs one authorised `ExecutionRun` with the automation toolkit.

1. A fresh workspace `automation/.runs/run-<id>/` gets the platform files, the bundle's page objects and data, and
   exactly the scripts G7 authorised (by id and sha256). Guard and tsc are re-checked in place.
2. The child gets only the run's variables: the approved origin and hosts, browsers and sizes, workers, one retry
   (decision D9; none for specs that may pay or delete), no trace for specs that sign in, and the saved test
   account only when a selected case signs in.
3. The toolkit runs with resource limits, a wall clock of min(30 min, per-test × tests / workers + 2 min), its own
   process group and cancellation polling every second. A progress file feeds per-test events while it runs.
4. Results come only from the JSON reporter; evidence (masked screenshot of every test, video and trace when
   retained, console and network logs, redacted) is stored per attempt. The workspace is then deleted.

Credentials never reach the database, logs, events or evidence: every text is redacted with their values.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import shutil
import uuid
from datetime import timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import select

from app.automation.toolkit import Limits, ToolkitError
from app.context import AppContext
from app.db.models import (
    AutomationAsset,
    AutomationScript,
    ExecutionResult,
    ExecutionRun,
    Job,
    Project,
    StageRun,
    TestCase,
)
from app.db.tenant import TenantScope, bind_scope
from app.db.types import utcnow
from app.domain.enums import (
    EventLevel,
    EvidenceKind,
    ExecutionStatus,
    ResultStatus,
    RunStatus,
    StageKey,
)
from app.domain.execution import report as rep
from app.services import automation as asvc
from app.services import execution as xsvc
from app.services.evidence import write_evidence

log = logging.getLogger(__name__)
AGENT = "execution"
POLL_S = 1.0
EVIDENCE = {
    "final-state": (EvidenceKind.screenshot, "image/png", "final-screen.png"),
    "video": (EvidenceKind.video, "video/webm", "recording.webm"),
    "trace": (EvidenceKind.trace, "application/zip", "trace.zip"),
    "console": (EvidenceKind.console_log, "text/plain", "console.log"),
    "network": (EvidenceKind.network_log, "text/plain", "network.log"),
}
CASE_STATUS = {
    ResultStatus.passed: ExecutionStatus.passed,
    ResultStatus.flaky: ExecutionStatus.passed,
    ResultStatus.failed: ExecutionStatus.failed,
    ResultStatus.error: ExecutionStatus.error,
    ResultStatus.blocked: ExecutionStatus.blocked,
}


def _read_from(path: Path, offset: int) -> bytes:
    """New bytes of the progress file since `offset` (empty when it doesn't exist yet)."""
    try:
        with path.open("rb") as fh:
            fh.seek(offset)
            return fh.read()
    except OSError:
        return b""


def run_dir(ctx: AppContext, run_id: uuid.UUID) -> Path:
    return Path(ctx.settings.automation_dir).resolve() / ".runs" / f"run-{run_id.hex}"


def live_dir(ctx: AppContext, run_id: uuid.UUID) -> Path:
    return run_dir(ctx, run_id) / "live"


def _secs(ms: int | None) -> str:
    s = round((ms or 0) / 1000)
    return f"{s // 60} min {s % 60} s" if s >= 60 else f"{s} s"


def finished_message(run: ExecutionRun) -> str:
    t = run.totals or {}
    parts = [f"{t.get('passed', 0)} passed", f"{t.get('failed', 0)} failed"]
    for k, label in (("flaky", "flaky"), ("error", "errors"), ("blocked", "blocked"), ("skipped", "skipped")):
        if t.get(k):
            parts.append(f"{t[k]} {label}")
    return f"{run.key} finished: {' · '.join(parts)} ({_secs(xsvc.duration_ms(run))})"


class Engine:
    def __init__(self, ctx: AppContext, scope: TenantScope, run_id: uuid.UUID, job: Job | None) -> None:
        from app.orchestrator.orchestrator import Orchestrator

        self.ctx, self.scope, self.run_id, self.job = ctx, scope, run_id, job
        self.orch = Orchestrator(ctx)
        self.cancel = asyncio.Event()
        self.secrets: list[str] = []

    # ------------------------------------------------------------------ helpers

    async def _emit(
        self, project: Project, type_: str, message: str, data: dict[str, Any], level: EventLevel = EventLevel.info
    ) -> None:
        await self.ctx.events.emit(
            org_id=project.organisation_id,
            project_id=project.id,
            type=type_,
            message=message,
            level=level,
            stage_key=StageKey.execution.value,
            agent_key=AGENT,
            data=data,
        )

    async def _set_status(self, s: Any, project: Project, run: ExecutionRun, status: RunStatus) -> None:
        run.status = status
        await self.orch.mirror_execution_run(s, project, run)

    # ------------------------------------------------------------------ entry

    async def run(self) -> None:
        async with self.ctx.session_factory() as s:
            bind_scope(s, self.scope)
            run = await s.get(ExecutionRun, self.run_id)
            if run is None:
                return
            project = (await s.execute(select(Project).where(Project.id == run.project_id))).scalar_one()
            if run.status == RunStatus.running:
                # The job was started again after its worker died (restart safety).
                await self._abandon(s, project, run, xsvc.WORKER_STOPPED)
                return
            if run.status != RunStatus.queued:
                return
            busy = (
                await s.execute(
                    select(ExecutionRun.id).where(
                        ExecutionRun.project_id == run.project_id,
                        ExecutionRun.status == RunStatus.running,
                        ExecutionRun.id != run.id,
                    )
                )
            ).first()
            if busy is not None:
                await self.ctx.queue.enqueue(
                    "execution_run",
                    {"run_id": str(run.id)},
                    org_id=run.organisation_id,
                    project_id=run.project_id,
                    concurrency_group=xsvc.EXECUTION_GROUP,
                    run_after=utcnow() + timedelta(seconds=5),
                    max_attempts=1,
                )
                return
            run.started_at = utcnow()
            await self._set_status(s, project, run, RunStatus.running)
            await s.commit()
        await self.orch._enqueue_pending(self.scope, project.id)
        await self._emit(
            project,
            "execution.run_status",
            f"{run.key} started: {len(run.config['plan'])} tests",
            {"kind": "status", "run_key": run.key, "status": "running"},
        )
        try:
            await self._execute(project)
        except Exception as exc:
            log.exception("execution run failed")
            async with self.ctx.session_factory() as s:
                bind_scope(s, self.scope)
                run = await s.get(ExecutionRun, self.run_id)
                assert run is not None
                reason = f"The run didn't complete: {rep.redact(str(exc).splitlines()[0][:200], self.secrets)}"
                await self._abandon(s, project, run, reason)
        finally:
            shutil.rmtree(run_dir(self.ctx, self.run_id), ignore_errors=True)
        await self.orch.advance(self.scope, project.id)

    async def _abandon(self, s: Any, project: Project, run: ExecutionRun, reason: str) -> None:
        await xsvc.write_unfinished(s, run, reason)
        run.error = reason
        run.finished_at = utcnow()
        run.totals = await xsvc.totals(s, run)  # without the dead run's live rows
        await self._set_status(s, project, run, RunStatus.error)
        await s.commit()
        await self.orch._enqueue_pending(self.scope, project.id)
        await self._emit(
            project,
            "execution.run_status",
            f"{run.key} didn't complete",
            {"kind": "error", "run_key": run.key, "status": "error"},
            EventLevel.error,
        )

    # ------------------------------------------------------------------ the run

    async def _execute(self, project: Project) -> None:
        from app.services.secrets import credentials_secret, use_credentials

        async with self.ctx.session_factory() as s:
            bind_scope(s, self.scope)
            run = await s.get(ExecutionRun, self.run_id)
            assert run is not None
            plan: list[dict[str, Any]] = list(run.config.get("plan") or [])
            skipped: dict[str, str] = dict(run.config.get("skipped") or {})
            secret = await credentials_secret(s, project.id)
            creds: dict[str, str] | None = None
            if secret is not None and any(i.get("signs_in") or i.get("blocked") for i in plan):
                creds = await use_credentials(self.ctx, s, secret, purpose="test_run", task_id=None)
            self.secrets = [v for v in (creds or {}).values() if isinstance(v, str)]
            to_run: list[dict[str, Any]] = []
            for item in plan:
                if item["case_key"] in skipped:
                    self._add(
                        s,
                        run,
                        item,
                        rep.Outcome(
                            "skipped",
                            [],
                            0,
                            [],
                            None,
                            skipped[item["case_key"]],
                            None,
                            f"Not run: {skipped[item['case_key']]}.",
                            None,
                        ),
                    )
                elif item.get("blocked") and creds is None:
                    reason = "Needs saved test credentials"
                    self._add(
                        s,
                        run,
                        item,
                        rep.Outcome(
                            "blocked", [], 0, [], None, reason, None, "Not run: needs saved test credentials.", None
                        ),
                    )
                else:
                    to_run.append(item)
            script_ids = {uuid.UUID(i["script_id"]) for i in to_run}
            scripts = {
                x.id: x
                for x in (
                    await s.execute(select(AutomationScript).where(AutomationScript.id.in_(script_ids)))
                ).scalars()
            }
            bundle = (
                await s.execute(
                    select(StageRun).where(
                        StageRun.project_id == project.id,
                        StageRun.stage_key == StageKey.automation,
                        StageRun.version == run.bundle_version,
                    )
                )
            ).scalar_one_or_none()
            assets = (
                list(
                    (
                        await s.execute(select(AutomationAsset).where(AutomationAsset.stage_run_id == bundle.id))
                    ).scalars()
                )
                if bundle is not None
                else []
            )
            scope = dict(run.scope or {})
            config = dict(run.config or {})
            run.totals = await xsvc.totals(s, run)
            await s.commit()

        changed = [
            i["case_key"]
            for i in to_run
            if (x := scripts.get(uuid.UUID(i["script_id"]))) is None or x.sha256 != i.get("sha256", x.sha256)
        ]
        if changed:
            raise RuntimeError(f"{changed[0]}'s script changed after this run was authorised")
        outcomes: dict[str, rep.Outcome] = {}
        ws = asvc.workspace(self.ctx, f"run-{self.run_id.hex}")
        cancelled = timed_out = False
        failure: str | None = None
        if to_run:
            await self.ctx.toolkit.init(ws)
            files = {a.path: a.code for a in assets if a.generated_by.value != "platform"}
            for i in to_run:
                files[i["path"]] = scripts[uuid.UUID(i["script_id"])].code
            asvc.write_bundle(ws, files)
            # Re-check guard and tsc in place: a script that fails now errors on its own, the others still run.
            report = await self.ctx.toolkit.validate(ws, [i["path"] for i in to_run])
            bad = {
                p
                for p, r in (report.get("files") or {}).items()
                if not ((r.get("guard") or {}).get("ok", True) and (r.get("tsc") or {}).get("ok", True))
            }
            for i in [i for i in to_run if i["path"] in bad]:
                outcomes[i["key"]] = rep.no_result("Script not run: it failed its safety or TypeScript check again")
                (ws / i["path"]).unlink(missing_ok=True)
            runnable = [i for i in to_run if i["path"] not in bad]
            if runnable:
                cancelled, timed_out, failure = await self._playwright(
                    project, ws, scope, config, runnable, creds, outcomes
                )
        del creds
        await self._finish(project, plan, outcomes, cancelled=cancelled, timed_out=timed_out, failure=failure)

    async def _playwright(
        self,
        project: Project,
        ws: Path,
        scope: dict[str, Any],
        config: dict[str, Any],
        items: list[dict[str, Any]],
        creds: dict[str, str] | None,
        outcomes: dict[str, rep.Outcome],
    ) -> tuple[bool, bool, str | None]:
        origin, host = str(scope["target_origin"]), str(scope["target_host"])
        hosts = sorted({host})
        workers = int(config.get("workers") or xsvc.WORKERS)
        per_test = int(config.get("test_timeout_s") or xsvc.TEST_TIMEOUT_S)
        sizes = sorted({i["size"] for i in items}, key=lambda v: [i["size"] for i in items].index(v))
        env = {
            "BASE_URL": origin,
            "ATA_APPROVED_ORIGIN": origin,
            "ATA_ALLOWED_HOSTS": ",".join(hosts),
            "ATA_ALLOW_PRIVATE": "true" if self.ctx.settings.allow_private_targets else "false",
            "ATA_OUTPUT_DIR": str(ws / "test-results"),
            "ATA_BROWSERS": ",".join(sorted({i["browser"] for i in items})),
            "ATA_VIEWPORTS": ",".join(sizes),
            "ATA_VIDEO": "retain-on-failure",
            "ATA_TRACE": "retain-on-failure",
            "ATA_NO_RETRY": ",".join(sorted({i["path"] for i in items if not i.get("retried", True)})),
            "ATA_NO_TRACE": ",".join(sorted({i["path"] for i in items if i.get("signs_in")})),
            "PW_WORKERS": str(workers),
            "PW_RETRIES": str(int(config.get("retries", xsvc.RETRIES))),
            "TEST_TIMEOUT_MS": str(per_test * 1000),
        }
        if creds and any(i.get("signs_in") or i.get("blocked") for i in items):
            env["TEST_USERNAME"] = creds.get("username", "")
            env["TEST_PASSWORD"] = creds.get("password", "")
        n_tests = len(items)
        wall = min(xsvc.RUN_LIMIT_S, per_test * -(-n_tests // workers) + 120)
        report_file = ws / "report.json"
        progress = ws / "progress.jsonl"
        live = live_dir(self.ctx, self.run_id) if any(i["browser"] == "chromium" for i in items) else None
        poller = asyncio.create_task(self._poll(project, items, progress))
        failure: str | None = None
        try:
            res = await self.ctx.toolkit.run(
                ws,
                report_file,
                env=env,
                timeout_s=wall,
                live_dir=live,
                progress=progress,
                cancel=self.cancel,
                limits=Limits(cpu_s=int(wall * 4) + 60),
            )
        except ToolkitError as exc:
            res = None
            failure = rep.redact(str(exc).splitlines()[0][:300], self.secrets)
        finally:
            poller.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await poller
        cancelled = bool(res and res.cancelled) or self.cancel.is_set()
        timed_out = bool(res and res.timed_out)
        data: dict[str, Any] = {}
        if report_file.is_file():
            with contextlib.suppress(ValueError, OSError):
                data = json.loads(report_file.read_text("utf-8"))
        tests = rep.collect_tests(data) if data else []
        read = rep.safe_reader(ws)
        reason = (
            xsvc.CANCELLED
            if cancelled
            else xsvc.TIME_LIMIT
            if timed_out
            else (rep.global_errors(data, self.secrets) or failure or "No result reported by Playwright")
        )
        for i in items:
            match = next(
                (
                    t
                    for t in tests
                    if t["file"].replace("\\", "/").endswith(i["path"].split("tests/", 1)[-1])
                    and rep.project_target(t["project"]) == (i["browser"], i["size"])
                ),
                None,
            )
            if match is None or not match["results"]:
                outcomes[i["key"]] = rep.no_result(reason)
                continue
            o = rep.parse_test(match, self.secrets, read)
            if o.kind == "interrupted":
                why = xsvc.STOPPED_CANCELLED if cancelled else reason
                o = rep.Outcome(
                    **{
                        **o.__dict__,
                        "status": "error",
                        "error": why,
                        "actual_result": f"The test couldn't finish: {reason[:1].lower() + reason[1:]}.",
                    }
                )
            outcomes[i["key"]] = o
        return cancelled, timed_out, failure if not tests else None

    async def _poll(self, project: Project, items: list[dict[str, Any]], progress: Path) -> None:
        """Every second: per-test progress → live rows and events; the cancel flag → stop the run."""
        by_target = {(i["path"], i["browser"], i["size"]): i for i in items}
        offset = 0
        live: dict[str, dict[str, Any]] = {}
        while True:
            await asyncio.sleep(POLL_S)
            events: list[tuple[str, str, dict[str, Any]]] = []
            chunk = _read_from(progress, offset)
            if chunk:
                with contextlib.suppress(OSError):
                    end = chunk.rfind(b"\n") + 1
                    offset += end
                    for raw in chunk[:end].splitlines():
                        try:
                            line = json.loads(raw)
                        except ValueError:
                            continue
                        target = rep.project_target(str(line.get("project") or ""))
                        item = by_target.get((str(line.get("file") or ""), *target)) if target else None
                        if item is None:
                            continue
                        attempt = int(line.get("attempt") or 1)
                        data = {
                            "kind": "progress",
                            "result_key": item["key"],
                            "case_key": item["case_key"],
                            "browser": item["browser"],
                            "viewport": item["size"],
                            "attempt": attempt,
                        }
                        if line.get("event") == "begin":
                            live[item["key"]] = {"state": "running", "attempt": attempt}
                            events.append(("execution.test_started", f"{item['case_key']} started", data))
                        else:
                            status = str(line.get("status") or "")
                            retrying = status != "passed" and attempt <= int(line.get("retries") or 0)
                            live[item["key"]] = {
                                "state": "running" if retrying else "finished",
                                "attempt": attempt,
                                "status": status,
                            }
                            if not retrying:
                                shown = {"passed": "passed", "skipped": "skipped"}.get(status, "failed")
                                if status == "passed" and attempt > 1:
                                    shown = "flaky"
                                events.append(
                                    (
                                        "execution.test_finished",
                                        f"{item['case_key']} {shown}",
                                        {**data, "status": shown, "duration_ms": int(line.get("duration_ms") or 0)},
                                    )
                                )
            async with self.ctx.session_factory() as s:
                bind_scope(s, self.scope)
                run = await s.get(ExecutionRun, self.run_id)
                if run is None:
                    return
                if (run.config or {}).get("cancel_requested"):
                    self.cancel.set()
                if events:
                    done = [v for v in live.values() if v["state"] == "finished"]
                    run.totals = {
                        **(run.totals or {}),
                        "live": live,
                        "progress": {
                            "finished": len(done),
                            "passed": sum(1 for v in done if v.get("status") == "passed" and v["attempt"] == 1),
                            "flaky": sum(1 for v in done if v.get("status") == "passed" and v["attempt"] > 1),
                            "failed": sum(1 for v in done if v.get("status") not in ("passed", "skipped")),
                        },
                    }
                    await s.commit()
            for type_, message, data in events:
                await self._emit(project, type_, message, data)

    def _add(self, s: Any, run: ExecutionRun, item: dict[str, Any], o: rep.Outcome) -> ExecutionResult:
        r = ExecutionResult(
            organisation_id=run.organisation_id,
            project_id=run.project_id,
            execution_run_id=run.id,
            key=item["key"],
            test_case_id=uuid.UUID(item["test_case_id"]),
            case_lineage_id=uuid.UUID(item["case_lineage_id"]),
            automation_script_id=uuid.UUID(item["script_id"]),
            script_version=item["script_version"],
            browser=item["browser"],
            viewport=item["size"],
            status=ResultStatus(o.status),
            attempts=len(o.attempts),
            duration_ms=o.duration_ms or None,
            steps=[
                {
                    "attempt": a.n,
                    "status": a.status,
                    "duration_ms": a.duration_ms,
                    "steps": a.steps,
                    "error": rep.clean(a.error, self.secrets, 2000) if a.error else None,
                }
                for a in o.attempts
            ]
            if o.attempts
            else [],
            failed_step=o.failed_step,
            error=o.error,
            page_state=o.page_state,
            actual_result=o.actual_result,
        )
        s.add(r)
        return r

    async def _finish(
        self,
        project: Project,
        plan: list[dict[str, Any]],
        outcomes: dict[str, rep.Outcome],
        *,
        cancelled: bool,
        timed_out: bool,
        failure: str | None,
    ) -> None:
        async with self.ctx.session_factory() as s:
            bind_scope(s, self.scope)
            run = await s.get(ExecutionRun, self.run_id)
            assert run is not None
            have = set(
                (
                    await s.execute(select(ExecutionResult.key).where(ExecutionResult.execution_run_id == run.id))
                ).scalars()
            )
            for item in plan:
                if item["key"] in have or item["key"] not in outcomes:
                    continue
                o = outcomes[item["key"]]
                r = self._add(s, run, item, o)
                await s.flush()
                for a in o.attempts:
                    await self._evidence(s, run, r, item, a)
            if cancelled:
                await xsvc.write_unfinished(s, run, xsvc.CANCELLED)
            elif timed_out:
                await xsvc.write_unfinished(s, run, xsvc.TIME_LIMIT)
            else:
                await xsvc.write_unfinished(s, run, failure or "No result reported by Playwright")
            run.finished_at = utcnow()
            run.totals = await xsvc.totals(s, run)
            if cancelled:
                run.error = "Run cancelled"
                status = RunStatus.cancelled
            elif timed_out:
                run.error = (
                    f"The run stopped at its {xsvc.RUN_LIMIT_S // 60}-minute limit. Unfinished tests show "
                    f"'Error: {xsvc.TIME_LIMIT.lower()}'."
                )
                status = RunStatus.error
            elif failure and not any(o.attempts for o in outcomes.values()):
                run.error = f"The run didn't complete: {failure}"
                status = RunStatus.error
            else:
                status = xsvc.final_status(run.totals)
            await self._set_status(s, project, run, status)
            await self._case_status(s, run)
            await s.commit()
            message = finished_message(run) if status != RunStatus.cancelled else f"{run.key} cancelled"
            key = run.key
            totals = {k: v for k, v in (run.totals or {}).items() if isinstance(v, int)}
        await self.orch._enqueue_pending(self.scope, project.id)
        if status != RunStatus.cancelled and not (totals.get("failed") or totals.get("error")):
            # Nothing to analyse: the frozen Test Execution Report is created now (else after the analysis).
            from app.agents.reporting.phase4_reports import freeze_for_run

            await freeze_for_run(self.ctx, self.scope, project.id, self.run_id)
        await self._emit(
            project,
            "execution.run_status",
            message,
            {"kind": "result", "run_key": key, "status": status.value, **totals},
            EventLevel.info if status in (RunStatus.passed, RunStatus.failed) else EventLevel.warn,
        )

    async def _evidence(
        self, s: Any, run: ExecutionRun, r: ExecutionResult, item: dict[str, Any], a: rep.Attempt
    ) -> None:
        regions: Any = None
        for att in a.attachments:
            if att.name == "masked-regions":
                with contextlib.suppress(ValueError):
                    regions = json.loads(att.data.decode("utf-8", "replace"))
        for att in a.attachments:
            spec = EVIDENCE.get(att.name)
            if spec is None:
                continue
            kind, mime, name = spec
            data = att.data
            if kind in (EvidenceKind.console_log, EvidenceKind.network_log):
                data = rep.redact(rep.strip_ansi(data.decode("utf-8", "replace")), self.secrets).encode()
            meta: dict[str, Any] = {
                "attempt": a.n,
                "result_key": r.key,
                "case_key": item["case_key"],
                "browser": item["browser"],
            }
            if kind == EvidenceKind.screenshot and regions is not None:
                meta["masked"] = regions
            ev = await write_evidence(
                s,
                self.ctx.storage,
                org_id=run.organisation_id,
                project_id=run.project_id,
                kind=kind,
                data=data,
                mime=mime,
                name=f"{r.key}-attempt{a.n}-{name}",
                owner_id=r.id,
                viewport=r.viewport,
                metadata=meta,
            )
            ev.execution_result_id = r.id
        await s.flush()

    async def _case_status(self, s: Any, run: ExecutionRun) -> None:
        """Derived case fields (no version bump): the worst result of this run per case."""
        order = [ResultStatus.passed, ResultStatus.flaky, ResultStatus.blocked, ResultStatus.error, ResultStatus.failed]
        worst: dict[uuid.UUID, ResultStatus] = {}
        for r in (await s.execute(select(ExecutionResult).where(ExecutionResult.execution_run_id == run.id))).scalars():
            if r.status not in order:
                continue
            cur = worst.get(r.case_lineage_id)
            if cur is None or order.index(r.status) > order.index(cur):
                worst[r.case_lineage_id] = r.status
        for lineage, status in worst.items():
            for tc in (await s.execute(select(TestCase).where(TestCase.lineage_id == lineage))).scalars():
                tc.execution_status = CASE_STATUS[status]


async def execute_run(ctx: AppContext, scope: TenantScope, run_id: uuid.UUID, job: Job | None) -> None:
    await Engine(ctx, scope, run_id, job).run()
