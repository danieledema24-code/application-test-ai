from __future__ import annotations

import uuid

from fastapi import APIRouter, Query
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.reporting import phase2_reports
from app.agents.reporting import phase5_reports as p5
from app.agents.reporting.discovery_report import approval_for_run, next_report_version, refresh_links
from app.api.deps import Ctx, CurrentPrincipal, MemberPrincipal, ScopedSession
from app.api.errors import Conflict, GateBlocked, Gone, NotFound, ValidationFailed
from app.api.routers.projects import load_project
from app.context import AppContext
from app.db.models import Evidence, QaReport, ScanSession, WorkflowStage
from app.domain.enums import ReportStatus, ReportType, StageKey
from app.schemas import api
from app.services import serialize as ser
from app.services.hardening import removed_text

router = APIRouter(tags=["reports"])


async def _summary(ctx: AppContext, s: AsyncSession, r: QaReport, latest_scan: uuid.UUID | None) -> api.ReportSummary:
    scan = (
        (await s.execute(select(ScanSession).where(ScanSession.id == r.scan_session_id))).scalar_one_or_none()
        if r.scan_session_id
        else None
    )
    p2: dict[str, object] = {}
    if r.report_type != ReportType.discovery:
        p2approval = await phase2_reports.approval(s, r)
        approval = {"status": p2approval["status"]}
        p2 = {
            "approval": p2approval,
            "is_latest_source": await phase2_reports.is_latest_source(s, r),
            "frozen": bool((r.content or {}).get("frozen")),
            "run_key": (r.source_versions or {}).get("run_key"),
        }
    else:
        approval = await approval_for_run(s, r.stage_run_id) if r.stage_run_id else {"status": "draft"}
    return api.ReportSummary(
        id=r.id,
        report_type=r.report_type.value,
        version=r.version,
        status=r.status.value,
        formats=[f["format"] for f in r.files or []],
        generated_by=r.generated_by.value,
        created_at=r.created_at,
        scan_id=scan.id if scan else None,
        scan_key=scan.key if scan else None,
        scan_number=scan.sequence if scan else None,
        is_latest_scan=scan is None or scan.id == latest_scan,
        approval_status=approval["status"],
        partial=bool((r.content or {}).get("partial")),
        error=r.error,
        **p2,
    )


async def _load(s: AsyncSession, report_id: uuid.UUID) -> QaReport:
    r = (await s.execute(select(QaReport).where(QaReport.id == report_id))).scalar_one_or_none()
    if r is None:
        raise NotFound("Report not found")
    return r


@router.get("/projects/{project_id}/reports", response_model=list[api.ReportSummary])
async def list_reports(
    project_id: uuid.UUID, ctx: Ctx, s: ScopedSession, _p: CurrentPrincipal
) -> list[api.ReportSummary]:
    await load_project(s, project_id)
    rows = (
        (
            await s.execute(
                select(QaReport)
                .where(QaReport.project_id == project_id)
                .order_by(QaReport.report_type, QaReport.version.desc())
            )
        )
        .scalars()
        .all()
    )
    latest = await ser.latest_scan_id(s, project_id)
    return [await _summary(ctx, s, r, latest) for r in rows]


@router.post("/projects/{project_id}/reports", response_model=api.ReportSummary, status_code=202)
async def create_report(
    project_id: uuid.UUID, body: dict[str, object], ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> api.ReportSummary:
    if body.get("report_type") not in api.ReportCreate.allowed_types():
        raise ValidationFailed(
            "Unknown report type",
            details=[
                {
                    "field": "report_type",
                    "message": "Use discovery, requirements_spec, test_strategy, test_plan, test_case_spec, rtm, "
                    "execution, defect, performance, accessibility or security.",
                }
            ],
        )
    req = api.ReportCreate.model_validate(body)
    project = await load_project(s, project_id)
    if req.report_type != "discovery":
        rtype = ReportType(req.report_type)
        if rtype in p5.PHASE5:
            if req.run_key and await p5.source(s, project_id, rtype, req.run_key) is None:
                raise NotFound(f"We couldn't find a finished {req.run_key} in this project")
            if not await p5.has_source(s, project_id, rtype):
                raise GateBlocked(p5.NOT_AVAILABLE[rtype])
        if not await phase2_reports.has_source(s, project_id, rtype):
            if rtype == ReportType.execution:
                raise GateBlocked("Not available yet: needs a test run")
            if rtype == ReportType.defect:
                raise GateBlocked("Not available yet: no defects have been found")
            if rtype in phase2_reports.PHASE3:
                raise GateBlocked("Design test cases first")
            raise GateBlocked(f"Generate the {phase2_reports.TITLES[rtype].lower()} first")
        if rtype == ReportType.execution and req.run_key:
            from app.db.models import ExecutionRun

            run = (
                await s.execute(
                    select(ExecutionRun).where(ExecutionRun.project_id == project_id, ExecutionRun.key == req.run_key)
                )
            ).scalar_one_or_none()
            if run is None:
                raise NotFound(f"We couldn't find {req.run_key} in this project")
            if run.finished_at is None or run.started_at is None:
                raise GateBlocked(f"{run.key} hasn't finished")
        if req.stage_run_version is not None and rtype not in (ReportType.execution, ReportType.defect, *p5.PHASE5):
            source_key = {ReportType.requirements_spec: "requirements"}.get(
                rtype, "test_design" if rtype in phase2_reports.PHASE3 else "test_strategy"
            )
            current = (await phase2_reports.stamp(s, project_id, rtype)).get(source_key)
            if current is not None and current != req.stage_run_version:
                raise Conflict("Reports are generated from the current version; reload and try again")
        p2report = await phase2_reports.create(s, project, rtype, user_id=p.user.id, run_key=req.run_key)
        await s.commit()
        await ctx.queue.enqueue(
            "report_render",
            {"report_id": str(p2report.id)},
            org_id=project.organisation_id,
            project_id=project_id,
            dedupe_key=f"report:{p2report.id}",
        )
        return await _summary(ctx, s, p2report, await ser.latest_scan_id(s, project_id))
    if req.scan_id is not None:
        scan = (
            await s.execute(
                select(ScanSession).where(ScanSession.id == req.scan_id, ScanSession.project_id == project_id)
            )
        ).scalar_one_or_none()
    else:
        st = (
            await s.execute(
                select(WorkflowStage).where(
                    WorkflowStage.project_id == project_id, WorkflowStage.stage_key == StageKey.discovery
                )
            )
        ).scalar_one()
        scan = (
            await s.execute(select(ScanSession).where(ScanSession.stage_run_id == st.current_stage_run_id))
        ).scalar_one_or_none()
    if scan is None:
        raise NotFound("Scan not found")
    if scan.status in ("queued", "running", "paused"):
        raise GateBlocked("The report is generated when discovery finishes")
    if int((scan.stats or {}).get("pages", 0)) == 0:
        raise GateBlocked("Discovery has no results to report on")
    report = QaReport(
        organisation_id=project.organisation_id,
        project_id=project_id,
        report_type=ReportType.discovery,
        version=await next_report_version(s, project_id, ReportType.discovery),
        status=ReportStatus.rendering,
        stage_run_id=scan.stage_run_id,
        scan_session_id=scan.id,
        created_by=p.user.id,
    )
    s.add(report)
    await s.commit()
    await ctx.queue.enqueue(
        "report_render",
        {"report_id": str(report.id)},
        org_id=project.organisation_id,
        project_id=project_id,
        dedupe_key=f"report:{report.id}",
    )
    return await _summary(ctx, s, report, await ser.latest_scan_id(s, project_id))


@router.get("/reports/{report_id}", response_model=api.ReportDetail)
async def get_report(report_id: uuid.UUID, ctx: Ctx, s: ScopedSession, _p: CurrentPrincipal) -> api.ReportDetail:
    r = await _load(s, report_id)
    summary = await _summary(ctx, s, r, await ser.latest_scan_id(s, r.project_id))
    files = [
        api.ReportFile(
            format=f["format"],
            size=f["size"],
            sha256=f["sha256"],
            filename=f["filename"],
            content_url=ctx.evidence_url(uuid.UUID(f["evidence_id"]), r.organisation_id),
        )
        for f in r.files or []
    ]
    content = refresh_links(ctx, r.content or {}, r.organisation_id)
    if content and r.report_type != ReportType.discovery:
        content["approval"] = summary.approval
    elif content:
        approval = await approval_for_run(s, r.stage_run_id) if r.stage_run_id else None
        if approval:
            content["approval"] = approval
    return api.ReportDetail(**summary.model_dump(), content=content, files=files, ai_sections=list(r.ai_sections or []))


@router.get("/reports/{report_id}/download")
async def download(
    report_id: uuid.UUID,
    ctx: Ctx,
    s: ScopedSession,
    _p: CurrentPrincipal,
    format: str = Query("pdf", pattern="^(pdf|html|json|csv|csv_timeseries|xlsx)$"),
) -> RedirectResponse:
    r = await _load(s, report_id)
    tables = (*phase2_reports.PHASE3, ReportType.execution, ReportType.defect, *p5.PHASE5)
    if format == "csv" and r.report_type not in tables:
        raise ValidationFailed(
            "CSV is available for the Test Case Specification, RTM, Test Execution, Defect, Performance, "
            "Accessibility and Security reports only",
            details=[{"field": "format", "message": "Use pdf, html or json for this report."}],
        )
    if format == "xlsx" and r.report_type not in tables:  # P5-04b: document reports have no tables
        raise ValidationFailed(
            "XLSX is available for table reports",
            details=[{"field": "format", "message": "Use pdf or html for this report."}],
        )
    if format == "csv_timeseries" and r.report_type != ReportType.performance:
        raise ValidationFailed(
            "The time-series CSV is available for the Performance Report only",
            details=[{"field": "format", "message": "Use csv for this report."}],
        )
    if r.status == ReportStatus.rendering:
        raise Conflict("The report is still being generated")
    f = next((x for x in r.files or [] if x["format"] == format), None)
    if r.status == ReportStatus.failed or f is None:
        raise NotFound("This report file is not available")
    ev = await s.get(Evidence, uuid.UUID(f["evidence_id"]))
    if ev is not None and ev.purged_at is not None:  # P5-05c: the time-series CSV goes with the run's series
        raise Gone(removed_text(ev.purged_at))
    return RedirectResponse(ctx.evidence_url(uuid.UUID(f["evidence_id"]), r.organisation_id), status_code=302)
