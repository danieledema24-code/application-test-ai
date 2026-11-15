"""Phase 5 reports (P5-04a): the Performance Report (one per load test), the Accessibility Report and the Security
Report (one per check), as JSON, HTML, PDF and CSV on the Phase 2–4 pipeline (`phase2_reports.render`).

Content is computed with the same serializers the API uses (`performance.run_dict`, `quality.scan_dict` /
`finding_dict`), so the numbers equal `GET /performance-runs/{id}` and `GET /quality-scans/{id}`. People appear by
name only. Reports freeze when their run or check finishes (`freeze_for`); charts are server-side SVG with their data
tables beside them (no JavaScript in the PDF path).
"""

from __future__ import annotations

import csv
import io
import json
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.reporting.phase3_reports import safe_cell
from app.context import AppContext
from app.db.models import PerformanceRun, Project, QaReport, QualityFinding, QualityScan, User
from app.db.tenant import TenantScope, bind_scope
from app.domain.enums import PerfRunStatus, QualityScanKind, QualityScanStatus, ReportStatus, ReportType
from app.domain.performance import profile as rules
from app.services import serialize_p2 as out

PHASE5 = frozenset({ReportType.performance, ReportType.accessibility, ReportType.security})
KIND = {ReportType.accessibility: QualityScanKind.accessibility, ReportType.security: QualityScanKind.security}
# Runs and checks that have results to report on (design §11.1).
RUN_DONE = (PerfRunStatus.passed, PerfRunStatus.failed, PerfRunStatus.stopped, PerfRunStatus.aborted)
SCAN_DONE = (QualityScanStatus.completed, QualityScanStatus.partial, QualityScanStatus.cancelled)
NOT_AVAILABLE = {
    ReportType.performance: "Not available yet: run a performance test first",
    ReportType.accessibility: "Not available yet: check accessibility first",
    ReportType.security: "Not available yet: run a security check first",
}
PERF_LIMITATIONS = [
    "Load is generated from the platform host, not from your users' locations.",
    "No container sandbox: memory limits aren't enforced on macOS.",
    "Browser rendering time (Core Web Vitals) isn't measured.",
    "Only GET requests to public pages are sent; nothing is submitted and no one is signed in.",
]
SEVERITY_ORDER = {"critical": 0, "serious": 1, "high": 1, "moderate": 2, "medium": 2, "minor": 3, "low": 3, "info": 4}
SLUG = {
    ReportType.performance: "performance",
    ReportType.accessibility: "accessibility",
    ReportType.security: "security",
}


async def _run_by_key(s: AsyncSession, project_id: Any, key: str | None) -> PerformanceRun | None:
    q = select(PerformanceRun).where(PerformanceRun.project_id == project_id, PerformanceRun.status.in_(RUN_DONE))
    q = q.where(PerformanceRun.key == key) if key else q.order_by(PerformanceRun.finished_at.desc()).limit(1)
    return (await s.execute(q)).scalars().first()


async def _scan_by_key(s: AsyncSession, project_id: Any, rtype: ReportType, key: str | None) -> QualityScan | None:
    q = select(QualityScan).where(
        QualityScan.project_id == project_id, QualityScan.kind == KIND[rtype], QualityScan.status.in_(SCAN_DONE)
    )
    q = q.where(QualityScan.key == key) if key else q.order_by(QualityScan.finished_at.desc()).limit(1)
    return (await s.execute(q)).scalars().first()


async def source(s: AsyncSession, project_id: Any, rtype: ReportType, key: str | None) -> str | None:
    """The key of the finished run or check a report covers (the latest when no key is given), or None."""
    if rtype == ReportType.performance:
        run = await _run_by_key(s, project_id, key)
        return run.key if run else None
    scan = await _scan_by_key(s, project_id, rtype, key)
    return scan.key if scan else None


async def has_source(s: AsyncSession, project_id: Any, rtype: ReportType) -> bool:
    return await source(s, project_id, rtype, None) is not None


async def approval(s: AsyncSession, report: QaReport) -> dict[str, Any]:
    return approval_of(report.content or {})


def approval_of(content: dict[str, Any]) -> dict[str, Any]:
    """Non-functional reports have no gate; a performance report records the load_test approval instead."""
    a = (content.get("run") or {}).get("approval")
    if a:
        return {
            "gate": None,
            "status": "approved",
            "decided_by": a.get("decided_by"),
            "decided_at": a.get("decided_at"),
        }
    return {"gate": None, "status": "approved", "decided_by": None, "decided_at": None}


def file_name(host: str, content: dict[str, Any], fmt: str) -> str:
    """`{host}-performance-PERF-0001-{yyyy-mm-dd}.{ext}` and the time series `…-timeseries-….csv` (design §11.3)."""
    day = str(content.get("generated_at", ""))[:10]
    key = content.get("source_key") or "latest"
    if fmt == "csv_timeseries":
        return f"{host}-performance-{key}-timeseries-{day}.csv"
    return f"{host}-{content['report_type']}-{key}-{day}.{fmt}"


# ------------------------------------------------------------------ build


async def build(ctx: AppContext, s: AsyncSession, project: Project, report: QaReport) -> dict[str, Any]:
    key = (report.source_versions or {}).get("run_key")
    if report.report_type == ReportType.performance:
        return await _performance(ctx, s, project, key)
    return await _scan(s, project, report.report_type, key)


def _name(p: dict[str, Any] | None) -> str | None:
    return (p or {}).get("full_name") or None


def _pct(rate: Any) -> str:
    if rate is None:
        return "—"
    v = float(rate) * 100
    return f"{v:.1f} %" if v and v < 10 else f"{v:.0f} %"


def _threshold_text(t: dict[str, Any]) -> dict[str, str]:
    src = t.get("source") or {}
    metric = str(t.get("metric"))
    return {
        "scope": t.get("path") or "All requests" if t.get("scope") == "path" else "All requests",
        "measure": "Errors" if metric == "error_rate" else f"{metric[1:]} % of requests faster",
        "limit": f"under {_pct(t.get('value'))}"
        if metric == "error_rate"
        else f"under {rules.ms_text(t.get('value'))}",
        "source": f"From {src['key']}" if src.get("type") == "requirement" and src.get("key") else "Default threshold",
        "measured": _pct(t.get("measured")) if metric == "error_rate" else rules.ms_text(t.get("measured")),
        "result": {"met": "✓ Met", "missed": "✗ Missed", "not_measured": "Not measured"}.get(
            str(t.get("result")), str(t.get("result") or "")
        ),
    }


def paragraph(run: dict[str, Any]) -> str:
    """The plain-language result (same wording as the web `resultParagraph`)."""
    users = int(((run.get("limits") or {}).get("test") or {}).get("vus") or 0)
    tr = run.get("threshold_results") or []
    if run["status"] in ("stopped", "aborted"):
        why = run.get("aborted_reason") or run.get("status_label")
        return f"{why}. Measurements cover the time before it stopped and aren't judged against thresholds."
    pages = [t for t in tr if t.get("scope") == "path"]
    missed = [t for t in pages if t.get("result") == "missed"]
    lead = (
        f"With up to {users} virtual user{'' if users == 1 else 's'}, {len(pages) - len(missed)} of {len(pages)} "
        f"page{'' if len(pages) == 1 else 's'} stayed within their thresholds."
    )
    if not missed:
        err = next((t for t in tr if t.get("metric") == "error_rate"), None)
        if err and err.get("result") == "missed":
            return f"{lead} Too many requests failed: {_pct(err.get('measured'))} errors, and the threshold is {_pct(err.get('value'))}."
        return lead
    titles = {
        t.get("path"): str(t.get("title") or "").split("·")[0].strip()
        for t in (run.get("profile_snapshot") or {}).get("targets") or []
    }
    w = missed[0]
    name = f"The {titles[w.get('path')]} page ({w.get('path')})" if titles.get(w.get("path")) else str(w.get("path"))
    return (
        f"{lead} {name} was slow: {str(w['metric'])[1:]} % of its requests were faster than "
        f"{rules.ms_text(w.get('measured'))}, and the threshold is {rules.ms_text(w.get('value'))}."
    )


def chart(
    points: list[dict[str, Any]], key: str, title: str, unit: str, threshold: float | None = None
) -> dict[str, Any]:
    """A server-side SVG line chart (coordinates only; the template draws it) plus its data rows."""
    w, h, pad = 560.0, 160.0, 36.0
    vals = [(float(p.get("t") or 0), float(p[key])) for p in points if p.get(key) is not None]
    if not vals:
        return {"title": title, "points": "", "rows": [], "max": 0, "unit": unit, "threshold_y": None}
    tmax = max(t for t, _ in vals) or 1.0
    vmax = max([v for _, v in vals] + ([threshold] if threshold else [])) or 1.0

    def xy(t: float, v: float) -> str:
        return f"{pad + (w - pad - 8) * t / tmax:.1f},{h - 20 - (h - 32) * v / vmax:.1f}"

    fmt = rules.ms_text if unit == "ms" else (lambda v: f"{v:.1f}" if unit == "rps" else str(int(v)))
    step = max(1, len(points) // 60)  # the HTML table shows at most ~60 rows; the CSV has every second
    return {
        "title": title,
        "points": " ".join(xy(t, v) for t, v in vals),
        "threshold_y": f"{h - 20 - (h - 32) * threshold / vmax:.1f}" if threshold else None,
        "threshold_text": rules.ms_text(threshold) if threshold else None,
        "max_text": fmt(vmax),
        "rows": [
            {"t": int(p.get("t") or 0), "value": fmt(float(p[key]))} for p in points[::step] if p.get(key) is not None
        ],
        "unit": unit,
    }


async def _performance(ctx: AppContext, s: AsyncSession, project: Project, key: str | None) -> dict[str, Any]:
    from app.services import performance as psvc

    run = await _run_by_key(s, project.id, key)
    if run is None:
        raise ValueError(NOT_AVAILABLE[ReportType.performance])
    viewer = await s.get(User, project.created_by)
    assert viewer is not None
    d = await psvc.run_dict(ctx, s, run, viewer=viewer, approver=False, member=False, see_email=False, full=True)
    d = json.loads(json.dumps(d, default=str))
    for k in ("permissions", "live", "problem", "stop_requested"):
        d.pop(k, None)
    a = d.get("approval") or {}
    series = d.get("timeseries") or []
    p95_limit = next(
        (float(t["value"]) for t in d.get("threshold_results") or [] if str(t.get("metric")).startswith("p")), None
    )
    requested, approved = _name(d.get("requested_by")), _name(a.get("decided_by"))
    return {
        "source_key": run.key,
        "statement": d.get("statement"),
        "paragraph": paragraph(d),
        "run": d,
        "approval_line": (
            f"Requested by {requested or 'someone'}"
            + (
                f" · approved by {approved}, {str(a.get('decided_at') or '')[:16].replace('T', ' ')} UTC"
                if approved
                else ""
            )
            + f" · host typed: {'yes' if a.get('host_typed') else 'no'}"
        ),
        "thresholds": [{**t, "text": _threshold_text(t)} for t in d.get("threshold_results") or []],
        "charts": [
            chart(series, "p95_ms", "Response time (p95)", "ms", p95_limit),
            chart(series, "rps", "Requests a second", "rps"),
            chart(series, "errors", "Errors a second", "count"),
        ],
        "limitations": PERF_LIMITATIONS,
        "summary": paragraph(d),
        "summary_generated_by": "rules",
        "stage_run_version": None,
    }


async def _scan(s: AsyncSession, project: Project, rtype: ReportType, key: str | None) -> dict[str, Any]:
    from app.services import quality as qsvc

    scan = await _scan_by_key(s, project.id, rtype, key)
    if scan is None:
        raise ValueError(NOT_AVAILABLE[rtype])
    d = json.loads(json.dumps(await qsvc.scan_dict(s, scan, see_email=False, full=True), default=str))
    d.pop("cancel_requested", None)
    rows = list(
        (
            await s.execute(
                select(QualityFinding).where(QualityFinding.scan_id == scan.id).order_by(QualityFinding.key)
            )
        ).scalars()
    )
    users = await out.users(s, [f.status_by for f in rows if f.status_by])
    findings = [
        json.loads(json.dumps(await qsvc.finding_dict(s, f, users, see_email=False, scan_key=scan.key), default=str))
        for f in rows
    ]
    for f in findings:
        f["evidence"] = []  # signed links expire; the report lists elements and observed values instead
        # Mapped requirements and test cases as keys ({key, title, lineage_id} in the API).
        f["mapped"] = {
            k: [str(x.get("key")) if isinstance(x, dict) else str(x) for x in v or []] for k, v in f["mapped"].items()
        }
    base: dict[str, Any] = {
        "source_key": scan.key,
        "statement": d["statement"],
        "scan": d,
        "findings": findings,
        "not_checked": d.get("not_checked") or [],
        "summary_generated_by": "rules",
        "stage_run_version": None,
    }
    if rtype == ReportType.security:
        rules_rows = (d.get("summary") or {}).get("rules") or []
        counts = (d.get("summary") or {}).get("counts") or {}
        return {
            **base,
            "rules": rules_rows,
            "summary": f"{counts.get('failed', 0)} failed · {counts.get('passed', 0)} passed · "
            f"{counts.get('not_applicable', 0)} not applicable · {counts.get('not_checked', 0)} not checked, "
            f"on {(d.get('summary') or {}).get('pages_checked', d.get('pages'))} pages.",
        }
    counted = [f for f in findings if not f["heuristic"] and not f["needs_review"]]
    groups: dict[str, dict[str, Any]] = {}
    for f in counted:
        g = groups.setdefault(
            f["rule_id"],
            {"rule_id": f["rule_id"], "title": f["title"], "severity": f["severity"], "wcag": [], "findings": []},
        )
        g["findings"].append(f)
        for r in f["references"]:
            if r.get("type") == "wcag" and r.get("criterion") not in g["wcag"]:
                g["wcag"].append(r.get("criterion"))
    by_wcag: dict[str, int] = {}
    for g in groups.values():
        for c in g["wcag"]:
            by_wcag[c] = by_wcag.get(c, 0) + 1
    sm = d.get("summary") or {}
    sev = sm.get("by_severity") or {}
    total = int(sm.get("pages_checked") or 0) + int(sm.get("pages_not_checked") or 0) or d.get("pages")
    line = (
        f"{sm.get('rules_failed', 0)} rule{'' if sm.get('rules_failed') == 1 else 's'} failed on "
        f"{sm.get('pages_with_problems', 0)} of {total} pages · "
        + " · ".join(f"{sev.get(k, 0)} {k}" for k in ("critical", "serious", "moderate", "minor"))
    )
    return {
        **base,
        "by_severity": sev,
        "by_wcag": dict(sorted(by_wcag.items())),
        "rules": sorted(groups.values(), key=lambda g: (SEVERITY_ORDER.get(g["severity"], 9), g["rule_id"])),
        "needs_review": [f for f in findings if f["needs_review"]],
        "keyboard": sm.get("keyboard") or [],
        "keyboard_findings": [f for f in findings if f["heuristic"]],
        "summary": line + ".",
    }


# ------------------------------------------------------------------ CSV


def _rows(w: Any, header: list[str], rows: list[list[Any]]) -> None:
    w.writerow(header)
    for r in rows:
        w.writerow([safe_cell(v) for v in r])


def csv_rows(content: dict[str, Any]) -> tuple[list[str], list[list[Any]]]:
    """Header and rows of the report's CSV (the XLSX writer uses the same rows)."""
    t = content["report_type"]
    if t == ReportType.performance.value:
        run = content["run"]
        res = {x["path"]: x for x in (run.get("result") or {}).get("targets") or []}
        th = {x.get("path"): x for x in run.get("threshold_results") or [] if x.get("scope") == "path"}
        header = ["Load test", "Page", "Requests", "Requests a second", "p50 ms", "p90 ms", "p95 ms", "p99 ms",
                  "Slowest ms", "Error rate", "Status codes", "Threshold", "Threshold source", "Result"]  # fmt: skip
        rows = []
        for path in list(dict.fromkeys([*res.keys(), *[p for p in th if p]])):
            x, tr = res.get(path) or {}, th.get(path) or {}
            lat = x.get("latency_ms") or {}
            txt = _threshold_text(tr) if tr else {}
            rows.append([
                run["key"], path, x.get("count"), x.get("rps"), lat.get("p50"), lat.get("p90"), lat.get("p95"),
                lat.get("p99"), lat.get("max"), x.get("error_rate"),
                ", ".join(f"{k}: {v}" for k, v in (x.get("status_codes") or {}).items()),
                txt.get("limit", ""), txt.get("source", ""), txt.get("result", ""),
            ])  # fmt: skip
        return header, rows
    if t == ReportType.security.value:
        header = ["Check", "Rule", "Title", "Category", "Severity", "Result", "Reason", "Pages", "Observed"]
        return header, [
            [
                content["source_key"],
                r.get("rule_id"),
                r.get("title"),
                r.get("category"),
                r.get("severity"),
                r.get("result"),
                r.get("reason"),
                r.get("page_count"),
                r.get("observed"),
            ]
            for r in content.get("rules") or []
        ]
    header = ["Finding", "Rule", "Severity", "Title", "Page", "Screen size", "Elements", "WCAG", "Status", "Reason",
              "Defect", "Requirements", "Heuristic", "Needs review"]  # fmt: skip
    return header, [
        [
            f["key"],
            f["rule_id"],
            f["severity"],
            f["title"],
            f["path"],
            f.get("viewport") or "",
            len(f["nodes"]),
            ", ".join(str(r.get("criterion")) for r in f["references"] if r.get("type") == "wcag"),
            f["status"],
            f.get("status_reason") or "",
            (f.get("defect") or {}).get("key", ""),
            ", ".join(f["mapped"].get("requirements") or []),
            "yes" if f["heuristic"] else "",
            "yes" if f["needs_review"] else "",
        ]
        for f in content.get("findings") or []
    ]


def timeseries_rows(content: dict[str, Any]) -> tuple[list[str], list[list[Any]]]:
    series = (content.get("run") or {}).get("timeseries") or []
    return ["Second", "Virtual users", "Requests a second", "Errors", "p95 ms"], [
        [p.get("t"), p.get("users"), p.get("rps"), p.get("errors"), p.get("p95_ms")] for p in series
    ]


def _csv(header: list[str], rows: list[list[Any]]) -> bytes:
    buf = io.StringIO()
    _rows(csv.writer(buf, lineterminator="\r\n"), header, rows)
    return ("﻿" + buf.getvalue()).encode("utf-8")


def to_csv(content: dict[str, Any]) -> bytes:
    return _csv(*csv_rows(content))


def to_timeseries_csv(content: dict[str, Any]) -> bytes:
    return _csv(*timeseries_rows(content))


# ------------------------------------------------------------------ frozen report when a run or check finishes


async def freeze_for(ctx: AppContext, scope: TenantScope, project_id: uuid.UUID, rtype: ReportType, key: str) -> None:
    """Creates the frozen report of a finished load test or check (once) and queues its rendering (design §11.1)."""
    from app.agents.reporting.discovery_report import next_report_version

    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        if await source(s, project_id, rtype, key) is None:
            return
        existing = (
            await s.execute(select(QaReport).where(QaReport.project_id == project_id, QaReport.report_type == rtype))
        ).scalars()
        if any((r.source_versions or {}).get("run_key") == key and (r.content or {}).get("frozen") for r in existing):
            return
        project = await s.get(Project, project_id)
        assert project is not None
        report = QaReport(
            organisation_id=project.organisation_id,
            project_id=project_id,
            report_type=rtype,
            version=await next_report_version(s, project_id, rtype),
            status=ReportStatus.rendering,
            content={"frozen": True},
            source_versions={"run_key": key},
        )
        s.add(report)
        await s.commit()
        rid, org = report.id, project.organisation_id
    await ctx.queue.enqueue(
        "report_render", {"report_id": str(rid)}, org_id=org, project_id=project_id, dedupe_key=f"report:{rid}"
    )
