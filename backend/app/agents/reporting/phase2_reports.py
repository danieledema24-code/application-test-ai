"""Phase 2 reports (P2-09): Requirements Specification, Test Strategy and Test Plan.

Content is computed from rows (same numbers as the API). A report is "approved" only when the latest approval of
its gate has exactly the snapshot the report was generated from. Rendered to JSON, HTML (Jinja2 autoescape) and PDF
(offline Chromium, no JavaScript), stored as `report_render` evidence like the discovery report.
"""

from __future__ import annotations

import hashlib
import html
import json
import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.reporting.discovery_report import _env
from app.context import AppContext
from app.db.models import Project, QaReport, ReadinessCriterion, Risk, SourceDocument
from app.domain.enums import DocumentStatus, EvidenceKind, GateKey, GeneratedBy, ReportStatus, ReportType, StageKey
from app.services import gates
from app.services import serialize_p2 as out
from app.services.evidence import write_evidence

log = logging.getLogger(__name__)

TITLES = {
    ReportType.requirements_spec: "Requirements Specification",
    ReportType.test_strategy: "Test Strategy",
    ReportType.test_plan: "Test Plan",
}
REPORT_STAGE = {
    ReportType.requirements_spec: StageKey.requirements,
    ReportType.test_strategy: StageKey.test_strategy,
    ReportType.test_plan: StageKey.test_strategy,
}
GATE_OF = {
    ReportType.requirements_spec: GateKey.G3,
    ReportType.test_strategy: GateKey.G4,
    ReportType.test_plan: GateKey.G4,
}
REQ_DISCLAIMER = "Provisional requirements derived from the observable user interface; backend behaviour not verified."
APPROVALS_NOTE = "Security, performance and load testing need separate approval; G4 does not authorise them."
LEGEND = {
    "observed": "Seen directly in the application, with evidence",
    "inferred": "Concluded from what was seen (or a document matched to the UI); not directly observed",
    "assumed": "Added or assumed without evidence; confirm with the product owner",
    "unverified": "Stated or suggested but not confirmed in the application",
}


async def source_snapshot(
    s: AsyncSession, project_id: Any, report_type: ReportType
) -> tuple[str | None, dict[str, Any]]:
    gate = GATE_OF[report_type]
    items, versions = await gates.snapshot_for(s, project_id, gate)
    return (gates.snapshot_hash(items) if items else None), versions


async def approval(s: AsyncSession, report: QaReport) -> dict[str, Any]:
    gate = GATE_OF[report.report_type]
    d = await gates.last_approval(s, report.project_id, gate)
    stamped = (report.source_versions or {}).get("snapshot_hash")
    if d is not None and stamped and d.snapshot_hash == stamped:
        us = await out.users(s, [d.decided_by])
        return {
            "gate": gate.value,
            "status": "approved",
            "decided_by": out.user_dict(us.get(d.decided_by)) if d.decided_by else None,
            "decided_at": d.created_at.isoformat(),
        }
    return {"gate": gate.value, "status": "draft", "decided_by": None, "decided_at": None}


async def is_latest_source(s: AsyncSession, report: QaReport) -> bool:
    current, _ = await source_snapshot(s, report.project_id, report.report_type)
    if report.report_type == ReportType.test_plan:
        from app.services.plan import current_plan

        plan = await current_plan(s, report.project_id)
        return plan is not None and (report.source_versions or {}).get("plan_version") == plan.version
    return current == (report.source_versions or {}).get("snapshot_hash")


async def build(ctx: AppContext, s: AsyncSession, project: Project, report: QaReport) -> dict[str, Any]:
    base = {
        "report_type": report.report_type.value,
        "title": TITLES[report.report_type],
        "project": {"id": str(project.id), "name": project.name},
        "generated_at": datetime.now(UTC).isoformat(),
        "version": report.version,
    }
    if report.report_type == ReportType.requirements_spec:
        return {**base, **await _requirements(ctx, s, project)}
    if report.report_type == ReportType.test_strategy:
        return {**base, **await _strategy(s, project)}
    return {**base, **await _plan(s, project)}


async def _requirements(ctx: AppContext, s: AsyncSession, project: Project) -> dict[str, Any]:
    from app.api.routers.requirements import requirement_stats

    run, reqs = await gates.current_requirements(s, project.id)
    if run is None:
        raise ValueError("Generate the requirements first")
    from app.agents.reporting.discovery_report import _strip_links

    by_cat: dict[str, list[dict[str, Any]]] = {}
    rejected: list[dict[str, Any]] = []
    for r in reqs:
        if r.status.value == "rejected":
            rejected.append(
                {
                    "key": r.key,
                    "title": r.title,
                    "reason": r.status_comment or "No reason recorded",
                    "rejected_at": r.status_changed_at.isoformat() if r.status_changed_at else None,
                }
            )
            continue
        d = await out.requirement_detail(ctx, s, r)
        d["evidence_ids"] = [str(e["id"]) for e in d.get("evidence", [])]
        d["evidence_keys"] = [e.get("key") or str(e["id"])[:8] for e in d.get("evidence", [])]
        # Signed links expire: the stored JSON keeps the evidence with an empty URL; it is re-signed on read.
        by_cat.setdefault(r.category, []).append({"requirement": json.loads(json.dumps(_strip_links(d), default=str))})
    rst = await gates._stage(s, project.id, StageKey.readiness_criteria)
    crit = (
        list(
            (
                await s.execute(
                    select(ReadinessCriterion)
                    .where(ReadinessCriterion.stage_run_id == rst.current_stage_run_id)
                    .order_by(ReadinessCriterion.sort_order)
                )
            ).scalars()
        )
        if rst.current_stage_run_id
        else []
    )
    docs = list(
        (
            await s.execute(
                select(SourceDocument).where(
                    SourceDocument.project_id == project.id, SourceDocument.status == DocumentStatus.ready
                )
            )
        ).scalars()
    )
    open_q = [
        out.artefact_ref(project.id, "requirement", r.id, r.key, r.title)
        for r in reqs
        if r.status.value == "needs_info" or (r.provenance.value == "unverified" and r.status.value != "rejected")
    ]
    stats = await requirement_stats(project.id, s, None)  # type: ignore[arg-type]
    approved = stats["by_status"].get("approved", 0)
    summary = (
        f"{stats['total']} provisional requirements were derived for {project.name}: {approved} approved, "
        f"{stats['by_classification'].get('observed', 0)} observed in the application and "
        f"{stats['by_classification'].get('unverified', 0)} still unverified. "
        f"{stats['acceptance_criteria']['approved']} acceptance criteria are approved."
    )
    return {
        "scope_and_method": [
            "Requirements were derived from the discovered pages, forms, navigation and journeys of the application.",
            "Each requirement carries a classification (see legend) and cites its evidence.",
            "Backend behaviour can't be observed from the browser and is never classified as observed.",
        ],
        "classification_legend": LEGEND,
        "counts": json.loads(json.dumps(stats, default=str)),
        "requirements_by_category": by_cat,
        "readiness": {
            "definition_of_ready": [
                {"key": c.key, "text": c.text, "status": c.status.value} for c in crit if c.kind.value == "dor"
            ],
            "definition_of_done": [
                {"key": c.key, "text": c.text, "status": c.status.value} for c in crit if c.kind.value == "dod"
            ],
        },
        "open_questions": open_q,
        "appendix_rejected": rejected,
        "source_documents": [{"key": d.key, "title": d.title, "filename": d.filename} for d in docs],
        "limitations": [REQ_DISCLAIMER],
        "summary": summary,
        "summary_generated_by": "rules",
        "disclaimer": REQ_DISCLAIMER,
        "stage_run_version": run.version,
    }


async def _strategy(s: AsyncSession, project: Project) -> dict[str, Any]:
    run, strat = await gates.current_strategy(s, project.id)
    if run is None or strat is None:
        raise ValueError("Generate the test strategy first")
    risks = list(
        (await s.execute(select(Risk).where(Risk.stage_run_id == run.id).order_by(Risk.score.desc()))).scalars()
    )
    us = await out.users(s, [])
    risk_rows = [json.loads(json.dumps(await out.risk_out(s, r, us), default=str)) for r in risks]
    totals = {lv: sum(1 for r in risks if r.level.value == lv) for lv in ("low", "medium", "high", "very_high")}
    in_types = [t["type"] for t in strat.content.get("test_types", []) if t.get("in_scope")]
    return {
        "strategy": {"version": strat.version, "sections": strat.content, "generated_by": strat.generated_by.value},
        "risks": risk_rows,
        "risk_matrix": await _matrix(s, project),
        "summary": f"{len(risks)} risks assessed ({totals['very_high']} very high, {totals['high']} high). "
        f"In scope: {', '.join(in_types)}.",
        "summary_generated_by": "rules",
        "approvals_note": APPROVALS_NOTE,
        "stage_run_version": run.version,
    }


async def _matrix(s: AsyncSession, project: Project) -> dict[str, Any]:
    from app.api.routers.strategy import risk_matrix

    return await risk_matrix(project.id, s, None)  # type: ignore[arg-type]  # same numbers as the API


def _label(value: Any) -> str:
    text = str(value or "").replace("_", " ").strip()
    return text[:1].upper() + text[1:]


def approach_readable(approach: dict[str, Any]) -> dict[str, list[str]]:
    """Plain-language lines for the plan's Approach section (no raw keys)."""
    levels = [
        f"{_label(x.get('level'))}: {'in scope' if x.get('in_scope') else 'out of scope'}"
        + (f" ({x['rationale']})" if x.get("rationale") else "")
        for x in approach.get("test_levels", [])
    ]
    types = [
        f"{_label(x.get('type'))}: {'in scope' if x.get('in_scope') else 'out of scope'}"
        + (f" ({x['rationale']})" if x.get("rationale") else "")
        + (" Needs separate approval before any test runs." if x.get("requires_approval") else "")
        for x in approach.get("test_types", [])
    ]
    techniques = []
    for t in approach.get("techniques_by_feature", []):
        names = ", ".join(_label(x.get("technique")).lower() for x in t.get("techniques", []) if x.get("technique"))
        feature = (t.get("feature") or {}).get("label") or (t.get("feature") or {}).get("key")
        if feature and names:
            techniques.append(f"{feature}: {names}")
    depth = [f"{_label(x.get('level'))} risk: {x.get('depth')}" for x in approach.get("risk_based_approach", [])]
    return {"test_levels": levels, "test_types": types, "techniques": techniques, "risk_based": depth}


async def _plan(s: AsyncSession, project: Project) -> dict[str, Any]:
    from app.services.plan import current_plan

    plan = await current_plan(s, project.id)
    if plan is None:
        raise ValueError("Generate the test plan first")
    return {
        "plan": {
            "key": plan.key,
            "version": plan.version,
            "sections": plan.content,
            "rules_template_sections": plan.rules_template_sections,
        },
        "approach_readable": approach_readable(dict((plan.content or {}).get("approach") or {})),
        "strategy_version": plan.strategy_version,
        "plan_version": plan.version,
        "summary": f"Test plan {plan.key} version {plan.version}, written from strategy version {plan.strategy_version}.",
        "summary_generated_by": "rules",
    }


def render_html(content: dict[str, Any]) -> str:
    return _env.get_template("phase2_report.html").render(c=content)


async def render_pdf(ctx: AppContext, html_doc: str, content: dict[str, Any]) -> bytes:
    draft = (content.get("approval") or {}).get("status") != "approved"
    band = " · DRAFT" if draft else ""
    title = html.escape(f"{content['title']} · {content['project']['name']}{band}")
    header = (
        '<div style="font-family:Helvetica,Arial,sans-serif;font-size:8px;color:#535D70;width:100%;padding:0 20mm;">'
        f"{title}</div>"
    )
    footer = (
        '<div style="font-family:Helvetica,Arial,sans-serif;font-size:8px;color:#535D70;width:100%;padding:0 20mm;">'
        'Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>'
    )
    async with ctx.browser_pool.isolated_context(None, java_script=False, offline=True) as context:
        page = await context.new_page()
        await page.set_content(html_doc, wait_until="load")
        return await page.pdf(
            format="A4",
            margin={"top": "20mm", "bottom": "20mm", "left": "20mm", "right": "20mm"},
            display_header_footer=True,
            header_template=header,
            footer_template=footer,
            print_background=True,
            tagged=True,
            outline=True,
        )


async def render(ctx: AppContext, s: AsyncSession, report: QaReport) -> QaReport:
    project = (await s.execute(select(Project).where(Project.id == report.project_id))).scalar_one()
    frozen = bool((report.content or {}).get("frozen"))
    try:
        content = await build(ctx, s, project, report)
        content["frozen"] = frozen
        if not report.source_versions:
            report.source_versions = await stamp(s, project.id, report.report_type)
        content["approval"] = await approval(s, report)
        html_doc = render_html(content)
        pdf = await render_pdf(ctx, html_doc, content)
        files = []
        slug = report.report_type.value.replace("_", "-")
        for fmt, data, mime in (
            ("json", json.dumps(content, indent=2, default=str).encode("utf-8"), "application/json"),
            ("html", html_doc.encode("utf-8"), "text/html; charset=utf-8"),
            ("pdf", pdf, "application/pdf"),
        ):
            name = f"{slug}-v{report.version}-{content['generated_at'][:10]}.{fmt}"
            ev = await write_evidence(
                s,
                ctx.storage,
                org_id=project.organisation_id,
                project_id=project.id,
                kind=EvidenceKind.report_render,
                data=data,
                mime=mime,
                name=name,
                owner_id=report.id,
                metadata={"filename": name, "report_id": str(report.id), "format": fmt},
            )
            files.append(
                {
                    "format": fmt,
                    "evidence_id": str(ev.id),
                    "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "filename": name,
                }
            )
        report.content = json.loads(json.dumps(content, default=str))
        report.files = files
        report.generated_by = GeneratedBy.rules
        report.ai_sections = [{"section": "summary", "generated_by": "rules"}]
        report.status = ReportStatus.ready
        report.error = None
    except Exception as exc:
        log.exception("report rendering failed")
        report.status = ReportStatus.failed
        report.error = f"Couldn't create the report ({str(exc).splitlines()[0][:200]})."
    return report


async def stamp(s: AsyncSession, project_id: Any, report_type: ReportType) -> dict[str, Any]:
    """The source the report is generated from: the gate snapshot hash plus stage-run (and plan) versions."""
    snap, versions = await source_snapshot(s, project_id, report_type)
    stamped: dict[str, Any] = {"snapshot_hash": snap, **versions}
    if report_type == ReportType.test_plan:
        from app.services.plan import current_plan

        plan = await current_plan(s, project_id)
        stamped["plan_version"] = plan.version if plan else None
    return stamped


async def has_source(s: AsyncSession, project_id: Any, report_type: ReportType) -> bool:
    if report_type == ReportType.requirements_spec:
        run, _ = await gates.current_requirements(s, project_id)
        return run is not None
    if report_type == ReportType.test_strategy:
        _run, strat = await gates.current_strategy(s, project_id)
        return strat is not None
    from app.services.plan import current_plan

    return await current_plan(s, project_id) is not None


async def create(
    s: AsyncSession, project: Project, report_type: ReportType, *, user_id: Any, frozen: bool = False
) -> QaReport:
    """Adds a `rendering` report stamped with its current source (the caller commits and queues `report_render`).
    Frozen versions are the ones created automatically at G3/G4 approval and when the plan is written."""
    from app.agents.reporting.discovery_report import next_report_version

    stage_run_id = None
    if report_type == ReportType.requirements_spec:
        run, _ = await gates.current_requirements(s, project.id)
        stage_run_id = run.id if run else None
    else:
        run2, _strat = await gates.current_strategy(s, project.id)
        stage_run_id = run2.id if run2 else None
    report = QaReport(
        organisation_id=project.organisation_id,
        project_id=project.id,
        report_type=report_type,
        version=await next_report_version(s, project.id, report_type),
        status=ReportStatus.rendering,
        stage_run_id=stage_run_id,
        created_by=user_id,
        content={"frozen": frozen},
        source_versions=await stamp(s, project.id, report_type),
    )
    s.add(report)
    await s.flush()
    return report
