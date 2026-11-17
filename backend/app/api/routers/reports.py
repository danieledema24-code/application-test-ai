from __future__ import annotations

import hashlib
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, ConfigDict, Field
from pydantic import ValidationError as PydanticValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.reporting import phase2_reports
from app.agents.reporting import phase5_reports as p5
from app.agents.reporting import phase6_reports as p6
from app.agents.reporting.discovery_report import approval_for_run, next_report_version, refresh_links
from app.api.deps import Ctx, CurrentPrincipal, MemberPrincipal, ScopedSession
from app.api.errors import Conflict, GateBlocked, Gone, NotFound, ValidationFailed
from app.api.routers.projects import load_project
from app.context import AppContext
from app.db.models import Evidence, QaReport, ScanSession, WorkflowStage
from app.domain.enums import ReportStatus, ReportType, StageKey
from app.llm.base import UntrustedBlock
from app.schemas import api
from app.services import serialize as ser
from app.services.audit import audit
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
                    "execution, defect, performance, accessibility, security, completion or release_readiness.",
                }
            ],
        )
    try:
        req = api.ReportCreate.model_validate(body)
    except PydanticValidationError as exc:  # a 422 with the field, never a 500 (e.g. lessons learned too long)
        details = [{"field": ".".join(str(x) for x in e["loc"]), "message": e["msg"]} for e in exc.errors()]
        raise ValidationFailed(details[0]["message"], details=details) from None
    project = await load_project(s, project_id)
    if req.report_type in ("completion", "release_readiness"):
        return await _create_phase6(ctx, s, p, project, ReportType(req.report_type), req)
    if (
        req.basis is not None
        or req.lessons_learned is not None
        or req.lessons_generated_by is not None
        or req.lessons_token
    ):
        raise ValidationFailed(
            "Only the Test Completion Report takes a basis and lessons learned",
            details=[{"field": "basis", "message": "Leave basis and lessons learned out for this report."}],
        )
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


async def _create_phase6(
    ctx: AppContext, s: AsyncSession, p: Any, project: Any, rtype: ReportType, req: api.ReportCreate
) -> api.ReportSummary:
    """P6-05c: a Release Readiness Report of an assessment, or a Test Completion Report from an assessment (default)
    or current data, with optional lessons learned shown as written by the person (or as AI text they kept)."""
    if not await p6.has_source(s, project.id):
        raise GateBlocked(p6.NOT_AVAILABLE)
    if rtype == ReportType.release_readiness and (req.basis == "current" or req.lessons_learned is not None):
        raise ValidationFailed(
            "The Release Readiness Report is generated from an assessment",
            details=[{"field": "basis", "message": "Leave basis and lessons learned out for this report."}],
        )
    basis = "current" if req.basis == "current" else "assessment"
    if basis == "assessment" and await p6.find(s, project.id, req.run_key) is None:
        raise NotFound(f"We couldn't find {req.run_key} in this project")
    lessons = None
    text = (req.lessons_learned or "").strip()
    if text:
        ai = req.lessons_generated_by == "ai"
        if ai:
            # The AI label only holds for a suggestion this server made for this person and project, unedited, and the
            # text still passes the checks against the data (no numbers, no keys that aren't in it).
            ok = _lessons_token_ok(ctx, project, p.user.id, text, req.lessons_token)
            _, keys = await _lessons_facts(ctx, s, project, req.run_key if basis == "assessment" else None, basis)
            if not ok or p6.check_lessons(text, keys) is not None:
                raise ValidationFailed(
                    "The AI label only applies to a suggestion the platform made that you kept unedited",
                    details=[{"field": "lessons_generated_by",
                              "message": "Suggest the lessons learned again, or send them as your own text."}],
                )  # fmt: skip
        lessons = {"text": text, "generated_by": "ai" if ai else "person", "author": p.user.full_name or None}
    report = await p6.create(
        s, project, rtype, user_id=p.user.id, run_key=req.run_key if basis == "assessment" else None, basis=basis,
        lessons=lessons,
    )  # fmt: skip
    audit(
        s,
        org_id=project.organisation_id,
        action="report.generated",
        target_type="report",
        target_id=report.id,
        actor_user_id=p.user.id,
        project_id=project.id,
        metadata={"report_type": rtype.value, "version": report.version,
                  "source": (report.source_versions or {}).get("run_key") or "current",
                  "lessons_learned": lessons["generated_by"] if lessons else None},
    )  # fmt: skip
    await s.commit()
    await ctx.queue.enqueue(
        "report_render",
        {"report_id": str(report.id)},
        org_id=project.organisation_id,
        project_id=project.id,
        dedupe_key=f"report:{report.id}",
    )
    return await _summary(ctx, s, report, await ser.latest_scan_id(s, project.id))


class LessonsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_key: str | None = Field(default=None, max_length=40)
    basis: Literal["assessment", "current"] | None = None


class AiLessons(BaseModel):
    model_config = ConfigDict(extra="forbid")
    lessons: str = Field(min_length=20, max_length=1500)


@router.post("/projects/{project_id}/reports/completion/lessons-suggestion")
async def suggest_lessons(
    project_id: uuid.UUID, body: LessonsInput, ctx: Ctx, s: ScopedSession, p: MemberPrincipal
) -> dict[str, Any]:
    """design P6 §11.1 [Suggest lessons learned] (AI on): labelled AI text the person may edit. The model only sees
    the conditions, unmet criteria, deviations and residual risks; a suggestion that writes a number, or names an item
    that isn't in that data, is refused (the report's numbers are computed in code)."""
    project = await load_project(s, project_id)
    if not ctx.llm.enabled:
        raise Conflict("AI is off: write the lessons learned yourself")
    if not await p6.has_source(s, project.id):
        raise GateBlocked(p6.NOT_AVAILABLE)
    if body.basis != "current" and await p6.find(s, project.id, body.run_key) is None:
        raise NotFound(f"We couldn't find {body.run_key} in this project")
    data, keys = await _lessons_facts(ctx, s, project, body.run_key, body.basis)
    task = (
        "Suggest two or three short lessons learned for the test completion report of this release, for a reader with "
        "no QA background: what to keep doing and what to do differently next time. Use only the facts given. You may "
        "name items by the keys in the facts, but never write a number, a count or a percentage."
    )
    res = await ctx.llm.structured(AiLessons, task, [UntrustedBlock("completion facts", data, 6000)])
    if not res.ok or res.value is None:
        raise ValidationFailed("The AI suggestion wasn't usable. Write the lessons learned yourself.")
    why = p6.check_lessons(res.value.lessons, keys)
    if why is not None:
        raise ValidationFailed(f"The AI suggestion wasn't usable ({why}). Write the lessons learned yourself.")
    text = res.value.lessons.strip()
    return {"text": text, "generated_by": "ai", "token": _lessons_token(ctx, project, p.user.id, text)}


LESSONS_TOKEN_TTL_S = 2 * 60 * 60


def _lessons_id(project: Any, user_id: uuid.UUID, text: str) -> uuid.UUID:
    digest = hashlib.sha256(text.encode()).hexdigest()
    return uuid.uuid5(uuid.NAMESPACE_URL, f"qa-lessons:{project.id}:{user_id}:{digest}")


def _lessons_token(ctx: AppContext, project: Any, user_id: uuid.UUID, text: str) -> str:
    """`{exp}.{sig}`: an HMAC over this text, person and project (the signed-URL signer, with a longer lifetime)."""
    exp, sig = ctx.signer.sign(_lessons_id(project, user_id, text), project.organisation_id, ttl_s=LESSONS_TOKEN_TTL_S)
    return f"{exp}.{sig}"


def _lessons_token_ok(ctx: AppContext, project: Any, user_id: uuid.UUID, text: str, token: str | None) -> bool:
    exp, _, sig = (token or "").partition(".")
    if not exp.isdigit() or not sig:
        return False
    return ctx.signer.verify(_lessons_id(project, user_id, text), project.organisation_id, int(exp), sig)


async def _lessons_facts(
    ctx: AppContext, s: AsyncSession, project: Any, run_key: str | None, basis: str | None
) -> tuple[str, set[str]]:
    """The facts an AI suggestion is written from and the keys it may name (the same for the suggestion and when the
    report is generated with the AI label)."""
    probe = QaReport(
        organisation_id=project.organisation_id,
        project_id=project.id,
        report_type=ReportType.completion,
        version=0,
        source_versions=await p6.stamp(s, project.id, ReportType.completion, run_key, basis),
    )
    return p6.lessons_data(await p6.build(ctx, s, project, probe))


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
    format: str = Query("pdf", pattern="^(pdf|html|json|csv|csv_timeseries|xlsx|docx)$"),
) -> RedirectResponse:
    r = await _load(s, report_id)
    if format == "docx":  # D34: Word export stays cut (P5-04c)
        raise ValidationFailed(
            "DOCX is not available", details=[{"field": "format", "message": "Use pdf, html, csv or xlsx."}]
        )
    tables = (*phase2_reports.PHASE3, ReportType.execution, ReportType.defect, *p5.PHASE5, *p6.PHASE6)
    if format == "csv" and r.report_type not in tables:
        raise ValidationFailed(
            "CSV is available for the Test Case Specification, RTM, Test Execution, Defect, Performance, "
            "Accessibility, Security, Test Completion and Release Readiness reports only",
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
