"""Application Discovery Report (stage `discovery_report`, agent I in Phase 1).

Structured JSON content is the source of truth (every number read from stored scan rows); HTML is rendered with
Jinja2 (autoescape, strict CSP, no external resources) and printed to PDF by an offline Chromium context.
"""

from __future__ import annotations

import base64
import hashlib
import html
import json
import logging
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from jinja2 import Environment, FileSystemLoader, select_autoescape
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.discovery.heuristics import UI_ONLY_LIMITATION, responsive_observations
from app.context import AppContext
from app.db.models import (
    ApplicationFeature,
    DiscoveredPage,
    Evidence,
    GateDecision,
    Organisation,
    Project,
    ProjectUrl,
    QaReport,
    ScanSession,
    StageRun,
    User,
    UserJourney,
)
from app.db.types import utcnow
from app.domain.enums import EvidenceKind, GateDecisionKind, GateKey, GeneratedBy, PageStatus, ReportStatus, ReportType
from app.services import serialize as ser
from app.services.evidence import write_evidence

log = logging.getLogger(__name__)
TEMPLATES = Path(__file__).resolve().parent.parent.parent / "reports" / "templates"
DISCLAIMER = "Based on publicly reachable pages only; not a security audit; backend behaviour not verified."
_env = Environment(loader=FileSystemLoader(TEMPLATES), autoescape=select_autoescape(["html"], default=True))
GLOSSARY = [
    {"term": "Observed", "definition": "Seen directly in the browser during this scan, with evidence."},
    {
        "term": "Inferred",
        "definition": "Concluded from what was seen; not verified (for example, a form that was not submitted).",
    },
    {
        "term": "Unverified",
        "definition": "A claim without supporting evidence; shown for transparency, not to be relied on.",
    },
    {
        "term": "Access gap",
        "definition": "Functionality that could not be observed (needs credentials, data, approval or a higher page limit).",
    },
    {
        "term": "Auth boundary",
        "definition": "Where the application requires signing in: a sign-in form, HTTP 401/403, or a redirect to sign-in.",
    },
    {
        "term": "User journey",
        "definition": "A likely sequence of steps a user takes to reach a goal across discovered pages.",
    },
    {
        "term": "Test basis (ISTQB)",
        "definition": "The body of knowledge used as the basis for test analysis and design; this report is part of it.",
    },
    {
        "term": "Exploratory discovery (ISTQB)",
        "definition": "Simultaneous learning about the test object while exploring it; here performed read-only.",
    },
]


def _display(dt: datetime | None) -> str:
    return dt.strftime("%d %b %Y %H:%M UTC") if dt else "—"


async def next_report_version(session: AsyncSession, project_id: uuid.UUID, report_type: ReportType) -> int:
    v = (
        await session.execute(
            select(func.max(QaReport.version)).where(
                QaReport.project_id == project_id, QaReport.report_type == report_type
            )
        )
    ).scalar_one_or_none()
    return int(v or 0) + 1


async def approval_for_run(session: AsyncSession, stage_run_id: uuid.UUID) -> dict[str, Any]:
    d = (
        await session.execute(
            select(GateDecision)
            .where(GateDecision.stage_run_id == stage_run_id, GateDecision.gate_key == GateKey.G2)
            .order_by(GateDecision.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if d is None:
        return {"status": "draft", "decided_by": None, "decided_at": None, "comment": None}
    user = (
        (await session.execute(select(User).where(User.id == d.decided_by))).scalar_one_or_none()
        if d.decided_by
        else None
    )
    return {
        "status": "approved" if d.decision == GateDecisionKind.approve else "changes_requested",
        "decided_by": user.full_name if user else "system",
        "decided_at": d.created_at.isoformat(),
        "comment": d.comment or None,
    }


async def build_content(ctx: AppContext, session: AsyncSession, project: Project, scan: ScanSession) -> dict[str, Any]:
    run = (await session.execute(select(StageRun).where(StageRun.id == scan.stage_run_id))).scalar_one()
    org = (await session.execute(select(Organisation).where(Organisation.id == project.organisation_id))).scalar_one()
    pages = list(
        (
            await session.execute(
                select(DiscoveredPage)
                .where(DiscoveredPage.scan_session_id == scan.id)
                .order_by(DiscoveredPage.sequence)
            )
        )
        .scalars()
        .all()
    )
    features = list(
        (
            await session.execute(
                select(ApplicationFeature)
                .where(ApplicationFeature.scan_session_id == scan.id)
                .order_by(ApplicationFeature.key)
            )
        )
        .scalars()
        .all()
    )
    journeys = list(
        (
            await session.execute(
                select(UserJourney).where(UserJourney.scan_session_id == scan.id).order_by(UserJourney.key)
            )
        )
        .scalars()
        .all()
    )
    evidence = list(
        (
            await session.execute(
                select(Evidence).where(Evidence.scan_session_id == scan.id).order_by(Evidence.captured_at)
            )
        )
        .scalars()
        .all()
    )
    ev_by_id = {e.id: e for e in evidence}
    urls = list((await session.execute(select(ProjectUrl).where(ProjectUrl.project_id == project.id))).scalars().all())
    pu = ser.primary_url(urls)
    gate1_user = None
    if pu and pu.authorised_by:
        gate1_user = (await session.execute(select(User).where(User.id == pu.authorised_by))).scalar_one_or_none()
    stats = scan.stats or {}
    visited = [p for p in pages if p.status == PageStatus.visited]
    host = urlsplit(scan.start_url).hostname or scan.start_url
    page_by_id = {p.id: p for p in pages}
    forms_inventory = [
        {"page_url": p.url, "form": ser.form_out(f).model_dump(mode="json")} for p in visited for f in (p.forms or [])
    ]
    issues: list[dict[str, Any]] = []
    for p in visited:
        for c in p.console_issues or []:
            issues.append(
                {
                    "page_url": p.url,
                    "page_path": ser.path_of(p.url),
                    "type": f"console {c.get('level')}",
                    "detail": c.get("text", "")[:300],
                }
            )
        for n in p.network_issues or []:
            detail = f"{n.get('url', '')[:200]} → {n.get('status') or n.get('failure')}"
            issues.append({"page_url": p.url, "page_path": ser.path_of(p.url), "type": "network", "detail": detail})
    resp_obs = responsive_observations([{"path": ser.path_of(p.url), "responsive": p.responsive} for p in visited])
    approval = await approval_for_run(session, run.id)
    latest_id = await ser.latest_scan_id(session, project.id)
    completeness = scan.completeness or {"score": 0, "rating": "limited", "reasons": [], "checks": []}
    duration = None
    if scan.started_at and scan.finished_at:
        duration = int((scan.finished_at - scan.started_at).total_seconds())
    limits = scan.limits or {}
    partial_notice = None
    if scan.status in ("cancelled", "partial", "failed") and visited:
        word = "cancelled" if scan.status == "cancelled" else "stopped"
        partial_notice = f"Partial results: discovery was {word} after {len(visited)} pages."
    limitations = list(scan.limitations or [])
    if UI_ONLY_LIMITATION not in limitations:
        limitations.insert(0, UI_ONLY_LIMITATION)
    observations = []
    for f in features[:6]:
        observations.append(
            {
                "text": f"{f.name}: {f.description}",
                "label": f.provenance.value,
                "evidence_ids": [r.get("evidence_id") for r in (f.evidence_refs or [])][:3],
            }
        )
    content: dict[str, Any] = {
        "report_type": "discovery",
        "summary": scan.summary or "",
        "summary_generated_by": (scan.summary_generated_by or GeneratedBy.rules).value
        if (scan.summary_generated_by or GeneratedBy.rules).value in ("ai", "rules")
        else "rules",
        "scope_and_method": [
            f"Start URL: {scan.start_url}",
            f"Scope: pages on {host} only. Links to other sites are listed, not visited.",
            f"Maximum pages: {limits.get('max_pages')}, maximum depth: {limits.get('max_depth')}.",
            "Viewports: Desktop 1440 × 900"
            + (" and Mobile 390 × 844." if limits.get("include_mobile", True) else " only."),
            f"robots.txt {'respected' if limits.get('respect_robots', True) else 'not applied (user setting)'}.",
            f"Credentials used: {'stored, not used in Phase 1' if pu and pu.credentials_secret_id else 'no'} (values are never shown).",
            f"Started {_display(scan.started_at)}, finished {_display(scan.finished_at)}"
            + (f" ({duration // 60} min {duration % 60} s)." if duration is not None else "."),
            "Browser: isolated Chromium (Playwright), fresh incognito context, downloads and service workers disabled.",
            "Approach: read-only exploration by following links. No forms that send, create, change or delete data were submitted; no buttons were clicked.",
        ],
        "sitemap": ser.build_sitemap(
            pages,
            list((scan.frontier or {}).get("not_visited", [])),
            list(scan.external_links or []),
            scan.start_url,
            ser.not_visited_reason(scan),
        ).model_dump(mode="json"),
        "functionality_map": [ser.feature_out(f).model_dump(mode="json") for f in features],
        "pages": [ser.page_summary(ctx, p, ev_by_id).model_dump(mode="json") for p in pages],
        "forms_inventory": forms_inventory,
        "interactive_components": {
            k: int(stats.get(k, 0))
            for k in (
                "forms",
                "inputs",
                "buttons",
                "links",
                "dropdowns",
                "search",
                "filters",
                "tables",
                "modals",
                "tabs",
                "pagination",
                "components",
            )
        },
        "journeys": [ser.journey_out(j).model_dump(mode="json") for j in journeys],
        "auth_boundaries": list(scan.auth_boundaries or []),
        "access_gaps": list(scan.access_gaps or []),
        "responsive_observations": resp_obs,
        "console_and_network_issues": issues,
        "injection_flags": [
            {k: v for k, v in f.items() if k in ("page_url", "excerpt", "evidence_refs")}
            for f in scan.injection_flags or []
        ],
        "completeness": completeness,
        "recommendation": (run.output or {}).get("recommendation"),
        "limitations": limitations,
        "evidence_index": [
            {
                **ser.evidence_link(ctx, e).model_dump(mode="json"),
                "page_path": ser.path_of(page_by_id[e.page_id].url) if e.page_id in page_by_id else None,
            }
            for e in evidence
        ],
        "disclaimer": DISCLAIMER,
        # Additive context for rendering the document:
        "site": {
            "host": host,
            "start_url": scan.start_url,
            "final_url": (pu.last_check or {}).get("final_url") if pu else None,
        },
        "organisation": {"id": str(org.id), "name": org.name},
        "project": {"id": str(project.id), "name": project.name},
        "scan": {
            "id": str(scan.id),
            "key": scan.key,
            "number": scan.sequence,
            "status": scan.status.value,
            "started_at": scan.started_at.isoformat() if scan.started_at else None,
            "finished_at": scan.finished_at.isoformat() if scan.finished_at else None,
            "duration_s": duration,
            "stage_run_version": run.version,
            "is_latest": latest_id == scan.id,
        },
        "gate1": {
            "by": gate1_user.full_name if gate1_user else None,
            "at": pu.authorised_at.isoformat() if pu and pu.authorised_at else None,
            "statement": pu.authorisation_statement if pu else None,
        }
        if pu
        else None,
        "approval": approval,
        "counts": {
            "pages": len(visited),
            "pages_failed": len(pages) - len(visited),
            "forms": int(stats.get("forms", 0)),
            "journeys": len(journeys),
            "features": len(features),
            "access_gaps": len(scan.access_gaps or []),
            "evidence": len(evidence),
        },
        "key_observations": observations,
        "partial": bool(ser.scan_is_partial(scan)),
        "partial_notice": partial_notice,
        "mobile_included": bool(limits.get("include_mobile", True)),
        "generated_at": utcnow().isoformat(),
        "glossary": GLOSSARY,
    }
    return content


def refresh_links(ctx: AppContext, value: Any, org_id: uuid.UUID) -> Any:
    """Re-signs every EvidenceLink inside stored content (signed URLs expire after 15 minutes)."""
    if isinstance(value, dict):
        if {"id", "kind", "mime", "content_url"} <= value.keys():
            return {**value, "content_url": ctx.evidence_url(uuid.UUID(str(value["id"])), org_id)}
        return {k: refresh_links(ctx, v, org_id) for k, v in value.items()}
    if isinstance(value, list):
        return [refresh_links(ctx, v, org_id) for v in value]
    return value


def _strip_links(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: ("" if k == "content_url" else _strip_links(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [_strip_links(v) for v in value]
    return value


async def render_html(ctx: AppContext, content: dict[str, Any], *, embed_screenshots: bool = True) -> str:
    ev_keys = {e["id"]: e.get("key") or e["id"][:8] for e in content.get("evidence_index", [])}

    def keys(refs: list[dict[str, Any]] | None) -> list[str]:
        out: list[str] = []
        for r in refs or []:
            k = ev_keys.get(str(r.get("evidence_id")))
            if k and k not in out:
                out.append(k)
        return out

    pages_render: list[dict[str, Any]] = []
    for p in content.get("pages", []):
        thumb = None
        shot = p.get("screenshot")
        if embed_screenshots and shot and p.get("status") == "visited" and len(pages_render) < 60:
            ev = await _evidence_bytes(ctx, shot.get("id"))
            if ev is not None:
                thumb = "data:image/jpeg;base64," + base64.b64encode(ev).decode("ascii")
        counts = p.get("counts") or {}
        text = ", ".join(f"{v} {_count_noun(k, v)}" for k, v in counts.items() if v and k != "links")
        page_forms = [f["form"] for f in content.get("forms_inventory", []) if f["page_url"] == p["url"]]
        pages_render.append(
            {
                **p,
                "thumb": thumb,
                "screenshot_key": ev_keys.get(str((shot or {}).get("id")), ""),
                "counts_text": text,
                "forms": page_forms,
            }
        )
    for o in content.get("key_observations", []):
        o["evidence"] = [ev_keys.get(str(e), "") for e in o.get("evidence_ids", []) if e]
    approval = dict(content.get("approval") or {})
    approval["decided_at_display"] = (
        _display(datetime.fromisoformat(approval["decided_at"])) if approval.get("decided_at") else "—"
    )
    gate1 = content.get("gate1")
    if gate1:
        gate1 = {
            **gate1,
            "by": gate1.get("by") or "—",
            "at_display": _display(datetime.fromisoformat(gate1["at"])) if gate1.get("at") else "—",
        }
    rating = (content.get("completeness") or {}).get("rating", "limited")
    ctx_vars = {
        **content,
        "pages_render": pages_render,
        "approval": approval,
        "gate1": gate1,
        "ev_keys": keys,
        "assessment": {"good": "Complete", "partial": "Partially complete", "limited": "Insufficient"}.get(
            rating, rating
        ),
        "generated_at_display": _display(datetime.fromisoformat(content["generated_at"])),
        "evidence_index": [
            {**e, "captured_display": _display(datetime.fromisoformat(e["captured_at"]))}
            for e in content.get("evidence_index", [])
        ],
    }
    return _env.get_template("discovery_report.html").render(c=ctx_vars)


def _count_noun(key: str, n: int) -> str:
    """'forms' -> 'form' when n == 1; keys are plural nouns from page_counts()."""
    if n != 1:
        return key
    if key.endswith("ies"):
        return key[:-3] + "y"
    if key.endswith("es") and key[:-2].endswith(("ch", "sh", "x", "ss")):
        return key[:-2]
    return key[:-1] if key.endswith("s") else key


async def _evidence_bytes(ctx: AppContext, evidence_id: Any) -> bytes | None:
    if not evidence_id:
        return None
    async with ctx.session_factory() as s:
        from app.db.tenant import BYPASS

        ev = (
            await s.execute(
                select(Evidence).where(Evidence.id == uuid.UUID(str(evidence_id))).execution_options(**BYPASS)
            )
        ).scalar_one_or_none()
    if ev is None or ev.kind != EvidenceKind.screenshot:
        return None
    try:
        return await ctx.storage.get(ev.storage_key)
    except OSError:
        return None


async def render_pdf(ctx: AppContext, html_doc: str, content: dict[str, Any]) -> bytes:
    host = html.escape(content["site"]["host"])
    draft = (content.get("approval") or {}).get("status") != "approved"
    band = (
        (
            '<span style="background:#FFFAEB;color:#B54708;border:1px solid #FEDF89;padding:1px 6px;border-radius:4px;'
            'font-weight:600;margin-left:8px">DRAFT — awaiting Gate 2 approval</span>'
        )
        if draft
        else ""
    )
    header = (
        f'<div style="font-family:Helvetica,Arial,sans-serif;font-size:8px;color:#535D70;width:100%;padding:0 20mm;">'
        f"Application Discovery Report · {host}{band}</div>"
    )
    gen = html.escape(_display(datetime.fromisoformat(content["generated_at"])))
    footer = (
        f'<div style="font-family:Helvetica,Arial,sans-serif;font-size:8px;color:#535D70;width:100%;padding:0 20mm;">'
        f'Scan {content["scan"]["number"]} · Generated {gen} · Page <span class="pageNumber"></span> of '
        f'<span class="totalPages"></span></div>'
    )
    async with ctx.browser_pool.isolated_context(None, java_script=False, offline=True) as context:
        page = await context.new_page()
        await page.set_content(html_doc, wait_until="load")
        pdf = await page.pdf(
            format="A4",
            margin={"top": "20mm", "bottom": "20mm", "left": "20mm", "right": "20mm"},
            display_header_footer=True,
            header_template=header,
            footer_template=footer,
            print_background=True,
            tagged=True,
            outline=True,
        )
        return pdf


def file_name(content: dict[str, Any], ext: str) -> str:
    host = content["site"]["host"].replace(":", "_")
    date = content["generated_at"][:10]
    return f"{host}-discovery-report-scan{content['scan']['number']}-{date}.{ext}"


async def render_report(ctx: AppContext, session: AsyncSession, report: QaReport) -> QaReport:
    """Builds content and renders JSON + HTML + PDF files for `report` (status -> ready / failed)."""
    if report.report_type != ReportType.discovery:
        from app.agents.reporting import phase2_reports

        return await phase2_reports.render(ctx, session, report)
    project = (await session.execute(select(Project).where(Project.id == report.project_id))).scalar_one()
    scan = (await session.execute(select(ScanSession).where(ScanSession.id == report.scan_session_id))).scalar_one()
    try:
        content = await build_content(ctx, session, project, scan)
        stored = _strip_links(content)
        html_doc = await render_html(ctx, content)
        pdf = await render_pdf(ctx, html_doc, content)
        files = []
        for fmt, data, mime in (
            ("json", json.dumps(stored, indent=2, default=str).encode("utf-8"), "application/json"),
            ("html", html_doc.encode("utf-8"), "text/html; charset=utf-8"),
            ("pdf", pdf, "application/pdf"),
        ):
            name = file_name(content, fmt)
            ev = await write_evidence(
                session,
                ctx.storage,
                org_id=project.organisation_id,
                project_id=project.id,
                kind=EvidenceKind.report_render,
                data=data,
                mime=mime,
                name=name,
                owner_id=report.id,
                scan_session_id=scan.id,
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
        report.content = stored
        report.files = files
        report.generated_by = GeneratedBy.ai if content["summary_generated_by"] == "ai" else GeneratedBy.rules
        report.ai_sections = [{"section": "summary", "generated_by": content["summary_generated_by"]}]
        report.source_versions = {"discovery": content["scan"]["stage_run_version"], "scan": scan.key}
        report.status = ReportStatus.ready
        report.error = None
    except Exception as exc:
        log.exception("report rendering failed")
        report.status = ReportStatus.failed
        report.error = f"Couldn't create the report ({str(exc).splitlines()[0][:200]})."
    return report
