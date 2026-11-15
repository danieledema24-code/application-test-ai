"""Phase 4 reports (P4-11): the Test Execution Report (one per run, frozen when the run finishes, or "latest result
per test case") and the Defect Report, as JSON, HTML, PDF and CSV.

Causes are hypotheses unless a person confirmed them; the Defect Report carries a DRAFT band while any defect is
undecided at Gate 8. Error text and values never leave the result detail beyond what the API already shows.
"""

from __future__ import annotations

import csv
import io
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.reporting.phase3_reports import safe_cell
from app.context import AppContext
from app.db.models import (
    AutomationAssessment,
    Defect,
    DefectLink,
    DefectOccurrence,
    ExecutionResult,
    ExecutionRun,
    Project,
    ProjectUrl,
    QaReport,
    TestCase,
    User,
)
from app.db.tenant import TenantScope, bind_scope
from app.domain.enums import (
    AutomationSuitability,
    DefectStatus,
    ReportStatus,
    ReportType,
    RunStatus,
    StageKey,
    UrlRole,
)
from app.services import serialize_p2 as out

PHASE4 = frozenset({ReportType.execution, ReportType.defect})
# P5-04a: the Defect Report's counts split by source (functional covers drafts from analysis and raised by people).
SOURCE_GROUP = {"analysis": "functional", "user": "functional", "accessibility": "accessibility",
                "security": "security", "performance": "performance", "api": "api"}  # fmt: skip
HYPOTHESIS_NOTE = "Causes are hypotheses unless a person confirmed them."
NO_RUN = "Needs a test run"
FINISHED = (RunStatus.passed, RunStatus.failed, RunStatus.error, RunStatus.cancelled)
_SIZE = {"390x844": "Mobile 390 × 844"}
_VIEWPORT = {"desktop": "Desktop 1440 × 900", "mobile": "Mobile 390 × 844"}


async def has_source(s: AsyncSession, project_id: Any, report_type: ReportType) -> bool:
    if report_type == ReportType.execution:
        return await latest_finished_run(s, project_id) is not None
    return (await s.execute(select(Defect.id).where(Defect.project_id == project_id).limit(1))).first() is not None


async def latest_finished_run(s: AsyncSession, project_id: Any) -> ExecutionRun | None:
    return (
        await s.execute(
            select(ExecutionRun)
            .where(
                ExecutionRun.project_id == project_id,
                ExecutionRun.finished_at.is_not(None),
                ExecutionRun.started_at.is_not(None),
            )
            .order_by(ExecutionRun.finished_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()


async def stamp(s: AsyncSession, project_id: Any, report_type: ReportType, run_key: str | None) -> dict[str, Any]:
    """What the report is built from: a run (or the latest result per case), or the defect set."""
    if report_type == ReportType.execution:
        return {"run_key": run_key, "latest_per_case": run_key is None}
    rows = list((await s.execute(select(Defect.key, Defect.version).where(Defect.project_id == project_id))).all())
    return {"defects": sorted(f"{k}:{v}" for k, v in rows)}


async def is_latest_source(s: AsyncSession, report: QaReport) -> bool:
    if report.report_type == ReportType.execution:
        return True  # a run's report never goes out of date; "latest per case" is generated on request
    now = await stamp(s, report.project_id, ReportType.defect, None)
    return bool(now["defects"] == (report.source_versions or {}).get("defects"))


async def approval(s: AsyncSession, report: QaReport) -> dict[str, Any]:
    """The band: Defect Report is a DRAFT while any defect awaits Gate 8; the execution report is never a draft."""
    if report.report_type == ReportType.defect:
        drafts = int((report.content or {}).get("drafts") or 0)
        if not report.content or "drafts" not in (report.content or {}):
            drafts = len(
                list(
                    (
                        await s.execute(
                            select(Defect.id).where(
                                Defect.project_id == report.project_id, Defect.status == DefectStatus.draft
                            )
                        )
                    ).scalars()
                )
            )
        # P5-04a: the latest Gate 8 decision of the project's defects (name only, P3-07 rule).
        last = (report.content or {}).get("last_g8") or await _last_g8(s, report.project_id)
        return {
            "gate": "G8",
            "status": "draft" if drafts else "approved",
            "decided_by": last.get("decided_by") if last else None,
            "decided_at": last.get("decided_at") if last else None,
        }
    return await _g7_approval(s, report)


async def _g7_approval(s: AsyncSession, report: QaReport) -> dict[str, Any]:
    """Who authorised the run at Gate 7 and when (QA R2-BUG-02). "Latest result per case" spans runs: no one decision."""
    from app.services import execution as xsvc

    none: dict[str, Any] = {"gate": "G7", "status": "approved", "decided_by": None, "decided_at": None}
    run_key = (report.source_versions or {}).get("run_key")
    if not run_key:
        return none
    run = (
        await s.execute(
            select(ExecutionRun).where(ExecutionRun.project_id == report.project_id, ExecutionRun.key == run_key)
        )
    ).scalar_one_or_none()
    gd = await xsvc.g7_decision(s, run) if run is not None else None
    if gd is None:
        return none
    us = await out.users(s, [gd.decided_by])
    return {
        "gate": "G7",
        "status": "approved",  # only authorised runs execute, so only they have a report
        "decided_by": out.person(us.get(gd.decided_by), see_email=False) if gd.decided_by else None,
        "decided_at": gd.created_at.isoformat(),
    }


async def _last_g8(s: AsyncSession, project_id: Any) -> dict[str, Any] | None:
    from app.db.models import GateDecision
    from app.domain.enums import GateKey

    gd = (
        (
            await s.execute(
                select(GateDecision)
                .where(GateDecision.project_id == project_id, GateDecision.gate_key == GateKey.G8)
                .order_by(GateDecision.created_at.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )
    if gd is None:
        return None
    u = await s.get(User, gd.decided_by) if gd.decided_by else None
    return {"decided_by": {"full_name": _name(u)} if u else None, "decided_at": gd.created_at.isoformat()}


def _name(u: User | None) -> str | None:
    return (u.full_name or None) if u is not None else None


async def host_of(s: AsyncSession, project_id: Any) -> str:
    from urllib.parse import urlsplit

    url = (
        await s.execute(
            select(ProjectUrl).where(ProjectUrl.project_id == project_id, ProjectUrl.role == UrlRole.primary)
        )
    ).scalar_one_or_none()
    host = (urlsplit(url.url).hostname or "site") if url else "site"
    return "".join(ch if ch.isalnum() or ch in ".-" else "-" for ch in host)


def file_name(host: str, content: dict[str, Any], version: int, fmt: str) -> str:
    """`{host}-test-execution-RUN-0003-{yyyy-mm-dd}.{fmt}` and `{host}-defects-v{n}-{yyyy-mm-dd}.{fmt}` (§13)."""
    day = str(content.get("generated_at", ""))[:10]
    if content["report_type"] == ReportType.execution.value:
        which = (content.get("run") or {}).get("key") or f"latest-v{version}"
        return f"{host}-test-execution-{which}-{day}.{fmt}"
    return f"{host}-defects-v{version}-{day}.{fmt}"


# ------------------------------------------------------------------ build


async def build(s: AsyncSession, project: Project, report: QaReport) -> dict[str, Any]:
    if report.report_type == ReportType.execution:
        return await _execution(s, project, (report.source_versions or {}).get("run_key"))
    return await _defects(s, project)


def _cause(r: ExecutionResult) -> dict[str, Any] | None:
    a = r.analysis or {}
    if not a.get("classification"):
        return None
    confirmed = bool(a.get("overridden"))
    return {
        "classification": a.get("classification"),
        "label": a.get("label"),
        "confidence": a.get("confidence"),
        "hypothesis": not confirmed,
        "set_by_person": confirmed,
    }


def _row(r: ExecutionResult, case: TestCase | None, run_key: str) -> dict[str, Any]:
    return {
        "result_key": r.key,
        "run_key": run_key,
        "case_key": case.key if case else None,
        "title": case.title if case else None,
        "browser": r.browser.capitalize(),
        "size": _SIZE.get(r.viewport, "Desktop 1440 × 900"),
        "status": r.status.value,
        "attempts": r.attempts,
        "duration_ms": r.duration_ms,
        "failed_step": (r.failed_step or {}).get("title"),
        "cause": _cause(r),
        "error_reason": r.error if r.status.value == "error" else None,
        "reason": r.error if r.status.value in ("blocked", "skipped") else None,
    }


async def _execution(s: AsyncSession, project: Project, run_key: str | None) -> dict[str, Any]:
    from app.services import execution as xsvc

    run = None
    if run_key:
        run = (
            await s.execute(
                select(ExecutionRun).where(ExecutionRun.project_id == project.id, ExecutionRun.key == run_key)
            )
        ).scalar_one_or_none()
        if run is None:
            raise ValueError(f"{run_key} was not found")
        results = list(
            (
                await s.execute(
                    select(ExecutionResult)
                    .where(ExecutionResult.execution_run_id == run.id)
                    .order_by(ExecutionResult.key)
                )
            ).scalars()
        )
        keys = {run.id: run.key}
    else:
        rows = list(
            (
                await s.execute(
                    select(ExecutionResult, ExecutionRun.key)
                    .join(ExecutionRun, ExecutionRun.id == ExecutionResult.execution_run_id)
                    .where(ExecutionResult.project_id == project.id)
                    .order_by(ExecutionResult.created_at.desc())
                )
            ).all()
        )
        seen: set[tuple[str, str, str]] = set()
        results = []
        keys = {}
        for r, k in rows:
            if r.error in xsvc.NOT_RESULTS:
                continue
            ident = (str(r.case_lineage_id), r.browser, r.viewport)
            if ident in seen:
                continue
            seen.add(ident)
            results.append(r)
            keys[r.execution_run_id] = k
        results.sort(key=lambda r: r.key)
    cases = {
        c.id: c
        for c in (
            await s.execute(
                select(TestCase).where(TestCase.id.in_([r.test_case_id for r in results if r.test_case_id]))
            )
        ).scalars()
    }
    rows_out = [
        _row(r, cases.get(r.test_case_id) if r.test_case_id else None, keys[r.execution_run_id]) for r in results
    ]
    totals: dict[str, int] = {}
    for x in rows_out:
        totals[x["status"]] = totals.get(x["status"], 0) + 1
    defects, defect_of = await _defect_refs(s, project.id, [r.id for r in results])
    for r, x in zip(results, rows_out, strict=True):
        x["defect"] = defect_of.get(r.id)
    by_cause: dict[str, int] = {}
    for x in rows_out:
        if x["cause"]:
            by_cause[str(x["cause"]["label"])] = by_cause.get(str(x["cause"]["label"]), 0) + 1
    summary_parts = [f"{totals.get(k, 0)} {k}" for k in ("passed", "failed", "flaky", "error", "blocked", "skipped")]
    not_automated = await _not_automated(s, project.id)
    run_out = None
    if run is not None:
        gd = await xsvc.g7_decision(s, run)
        us = await out.users(s, [run.requested_by, gd.decided_by if gd else None])
        config = run.config or {}
        viewports = [str(v) for v in (run.scope or {}).get("viewports") or []]
        run_out = {
            "key": run.key,
            "status": run.status.value,
            "selection": xsvc.selection_label(run.selection or {}),
            "browsers": (run.scope or {}).get("browsers") or [],
            "viewports": viewports,
            "sizes": [_VIEWPORT.get(v, v) for v in viewports],
            "workers": int(config.get("workers") or xsvc.WORKERS),
            "retries": int(config.get("retries", xsvc.RETRIES)),
            # Reports are shared outside the organisation: names only, never emails (P3-07; QA R2-BUG-02).
            "requested_by": _name(us.get(run.requested_by)) if run.requested_by else None,
            "requested_at": run.created_at.isoformat() if run.created_at else None,
            "authorised_by": _name(us.get(gd.decided_by)) if gd and gd.decided_by else None,
            "authorised_at": gd.created_at.isoformat() if gd else None,
            "self_authorised": bool(gd and gd.decided_by and gd.decided_by == run.requested_by),
            "started_at": run.started_at.isoformat() if run.started_at else None,
            "finished_at": run.finished_at.isoformat() if run.finished_at else None,
            "duration_ms": xsvc.duration_ms(run),
            "authorised": gd is not None and gd.decision.value == "approve",
            "error": run.error,
        }
    return {
        "basis": "run" if run else "latest_per_case",
        "run": run_out,
        "totals": {
            **{k: totals.get(k, 0) for k in ("passed", "failed", "flaky", "error", "blocked", "skipped")},
            "tests": len(rows_out),
        },
        "results": rows_out,
        "causes": by_cause,
        "defects": defects,
        "hypothesis_note": HYPOTHESIS_NOTE,
        "flaky_note": "Flaky tests passed only on a retry. They are counted separately, never as passed.",
        "not_automated": not_automated,
        "limitations": _limitations(run, rows_out, not_automated),
        "summary": f"{len(rows_out)} test result(s): " + ", ".join(summary_parts) + ".",
        "summary_generated_by": "rules",
        "stage_run_version": None,
    }


async def _not_automated(s: AsyncSession, project_id: Any) -> list[dict[str, Any]]:
    """Approved test cases (last Gate 5) that the automation assessment left to a person, with its reasons."""
    from app.services import automation as asvc

    _decision, cases = await asvc.approved_cases(s, project_id)
    arun = await asvc.current_run(s, project_id, StageKey.automation_assessment)
    if arun is None or not cases:
        return []
    rows = {
        str(a.case_lineage_id): a
        for a in (
            await s.execute(select(AutomationAssessment).where(AutomationAssessment.stage_run_id == arun.id))
        ).scalars()
    }
    out = []
    for c in sorted(cases, key=lambda c: c.case.key):
        a = rows.get(c.case.lineage_id)
        if a is not None and a.suitability == AutomationSuitability.manual_only:
            reasons = [str(x) for x in a.reasons or []] or ["Needs a person"]
            out.append({"case_key": c.case.key, "title": c.case.title, "reasons": reasons})
    return out


def _limitations(
    run: ExecutionRun | None, rows: list[dict[str, Any]], not_automated: list[dict[str, Any]]
) -> list[str]:
    """What this report can't show (P4-11 "limitations": the sandbox, browsers and sizes not run, untested cases)."""
    if run is not None:
        browsers = {str(b) for b in (run.scope or {}).get("browsers") or []}
        sizes = {str(v) for v in (run.scope or {}).get("viewports") or []}
    else:
        browsers = {str(x["browser"]).lower() for x in rows}
        sizes = {"mobile" if str(x["size"]).startswith("Mobile") else "desktop" for x in rows}
    out = [
        "Tests ran in a separate process with a cleaned environment, resource limits and a network policy that only "
        "allows the approved site. It is not a container: memory limits aren't enforced on every server.",
    ]
    missing = [name for key, name in (("chromium", "Chromium"), ("firefox", "Firefox"), ("webkit", "WebKit"))
               if key not in browsers]  # fmt: skip
    if missing:
        out.append(
            f"Not run in {_and(missing)}, so this report says nothing about {'that browser' if len(missing) == 1 else 'those browsers'}."
        )
    if rows and "mobile" not in sizes:
        out.append("Not run at the mobile size (390 × 844).")
    if rows and "desktop" not in sizes:
        out.append("Not run at the desktop size (1440 × 900).")
    if not_automated:
        n = len(not_automated)
        out.append(
            f"{n} approved test case{'s' if n != 1 else ''} need{'s' if n == 1 else ''} a person and "
            f"{'was' if n == 1 else 'were'} not run (listed under Not automated)."
        )
    blocked = sum(1 for x in rows if x["status"] in ("blocked", "skipped"))
    if blocked:
        out.append(f"{blocked} test{'s' if blocked != 1 else ''} did not run (blocked or skipped); see their reasons.")
    out.append("Automated checks can't judge wording, look and feel, or emails and other effects outside the browser.")
    return out


def _and(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " or " + items[-1]


async def _defect_refs(
    s: AsyncSession, project_id: Any, result_ids: list[uuid.UUID]
) -> tuple[list[dict[str, Any]], dict[uuid.UUID, dict[str, Any]]]:
    """Defects these results raised or hit again (QA R2-BUG-01): a repeat failure is an occurrence of the open defect,
    not a new draft, so a Regression run that fails the known bug again lists that defect too. Returns the defect list
    and, per result, `{"key", "occurrence"}` (the n-th time the defect was seen, counting from the one that raised it).
    """
    if not result_ids:
        return [], {}
    wanted = set(result_ids)
    raised = {
        d.id: d
        for d in (
            await s.execute(
                select(Defect).where(Defect.project_id == project_id, Defect.execution_result_id.in_(result_ids))
            )
        ).scalars()
    }
    hit = set(
        (
            await s.execute(
                select(DefectOccurrence.defect_id).where(
                    DefectOccurrence.project_id == project_id, DefectOccurrence.execution_result_id.in_(result_ids)
                )
            )
        ).scalars()
    )
    ids = set(raised) | hit
    if not ids:
        return [], {}
    defects = {d.id: d for d in (await s.execute(select(Defect).where(Defect.id.in_(ids)))).scalars()}
    occurrences = list(
        (
            await s.execute(
                select(DefectOccurrence)
                .where(DefectOccurrence.defect_id.in_(ids))
                .order_by(DefectOccurrence.seen_at, DefectOccurrence.created_at)
            )
        ).scalars()
    )
    per_result: dict[uuid.UUID, dict[str, Any]] = {}
    here: dict[uuid.UUID, list[int]] = {}
    for d in defects.values():
        seq: list[uuid.UUID] = []
        if d.execution_result_id is not None:
            seq.append(d.execution_result_id)  # the result that raised it is occurrence 1
        seq += [o.execution_result_id for o in occurrences if o.defect_id == d.id and o.execution_result_id not in seq]
        for n, rid in enumerate(seq, 1):
            if rid in wanted and rid not in per_result:
                per_result[rid] = {"key": d.key, "occurrence": n}
                here.setdefault(d.id, []).append(n)
    refs = [
        {
            "key": d.key,
            "summary": d.summary,
            "status": d.status.value,
            "severity": d.severity.value,
            # Raised by these results, or an earlier defect they failed again ("seen again").
            "raised_here": d.id in raised,
            "occurrences": sorted(here.get(d.id, [])),
        }
        for d in sorted(defects.values(), key=lambda x: x.key)
    ]
    return refs, per_result


async def _defects(s: AsyncSession, project: Project) -> dict[str, Any]:
    rows = list((await s.execute(select(Defect).where(Defect.project_id == project.id).order_by(Defect.key))).scalars())
    links = list(
        (await s.execute(select(DefectLink).where(DefectLink.defect_id.in_([d.id for d in rows])))).scalars()
        if rows
        else []
    )
    case_ids = {lk.test_case_lineage_id for lk in links if lk.test_case_lineage_id}
    case_keys = {
        c.lineage_id: c.key
        for c in (
            (await s.execute(select(TestCase).where(TestCase.lineage_id.in_(case_ids)))).scalars() if case_ids else []
        )
    }
    from app.db.models import GateDecision
    from app.domain.enums import GateSubjectType

    decisions: dict[Any, GateDecision] = {}
    if rows:
        for gd in (
            await s.execute(
                select(GateDecision)
                .where(
                    GateDecision.subject_type == GateSubjectType.defect,
                    GateDecision.subject_id.in_([d.id for d in rows]),
                )
                .order_by(GateDecision.created_at)
            )
        ).scalars():
            decisions[gd.subject_id] = gd  # the latest wins
    ids = [g.decided_by for g in decisions.values() if g.decided_by]
    deciders = {u.id: u for u in (await s.execute(select(User).where(User.id.in_(ids)))).scalars()} if ids else {}
    by_status: dict[str, int] = {}
    by_source: dict[str, int] = {}
    items = []
    for d in rows:
        by_status[d.status.value] = by_status.get(d.status.value, 0) + 1
        src = SOURCE_GROUP.get(d.source.value, "functional")
        by_source[src] = by_source.get(src, 0) + 1
        last = decisions.get(d.id)
        mine = [
            case_keys.get(lk.test_case_lineage_id)
            for lk in links
            if lk.defect_id == d.id and lk.test_case_lineage_id is not None
        ]
        repro = str((d.reproducibility or {}).get("text") or "")
        items.append(
            {
                "key": d.key,
                "summary": d.summary,
                "status": d.status.value,
                "severity": d.severity.value,
                "priority": d.priority.value,
                "cases": sorted({k for k in mine if k}),
                "steps": [str(x) for x in d.steps or []],
                "expected": d.expected,
                "actual": d.actual,
                "environment": {k: v for k, v in (d.environment or {}).items() if isinstance(v, str | int)},
                "reproducibility": repro,
                "root_cause_hypothesis": d.root_cause_hypothesis,
                "status_reason": d.status_reason,
                "source": src,
                "decided_by": _name(deciders.get(last.decided_by)) if last and last.decided_by else None,
                "decided_at": last.created_at.isoformat() if last else None,
            }
        )
    drafts = by_status.get("draft", 0)
    return {
        "drafts": drafts,
        "draft_note": f"DRAFT: {drafts} defect{'s' if drafts != 1 else ''} not yet reviewed at Gate 8"
        if drafts
        else None,
        "by_status": by_status,
        "by_source": {
            k: by_source.get(k, 0) for k in ("functional", "accessibility", "security", "performance", "api")
        },
        "last_g8": await _last_g8(s, project.id),
        "defects": items,
        "hypothesis_note": HYPOTHESIS_NOTE,
        "summary": f"{len(items)} defect(s): "
        + ", ".join(
            f"{by_status.get(k, 0)} {k}" for k in ("draft", "confirmed", "fixed", "verified", "rejected", "closed")
        )
        + ".",
        "summary_generated_by": "rules",
        "stage_run_version": None,
    }


# ------------------------------------------------------------------ CSV


def _defect_text(ref: dict[str, Any] | None) -> str:
    if not ref:
        return ""
    n = int(ref.get("occurrence") or 1)
    return f"{ref['key']} (occurrence {n})" if n > 1 else str(ref["key"])


def to_csv(content: dict[str, Any]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    if content["report_type"] == ReportType.execution.value:
        w.writerow(["Result", "Run", "Test case", "Title", "Browser", "Size", "Status", "Attempts", "Failed step",
                    "Likely cause", "Cause is", "Defect"])  # fmt: skip
        for x in content["results"]:
            cause = x.get("cause") or {}
            w.writerow(
                [
                    safe_cell(v)
                    for v in (
                        x["result_key"], x["run_key"], x.get("case_key") or "", x.get("title") or "", x["browser"],
                        x["size"], x["status"], x.get("attempts") or "", x.get("failed_step") or "",
                        cause.get("label") or "",
                        ("Set by a person" if cause.get("set_by_person") else "Hypothesis") if cause else "",
                        _defect_text(x.get("defect")),
                    )
                ]
            )  # fmt: skip
    else:
        w.writerow(["Defect", "Summary", "Status", "Severity", "Priority", "Source", "Test cases", "Expected", "Actual",
                    "Reproducibility", "Decided by"])  # fmt: skip
        for d in content["defects"]:
            w.writerow(
                [
                    safe_cell(v)
                    for v in (
                        d["key"], d["summary"], d["status"], d["severity"], d["priority"], d.get("source") or "",
                        ", ".join(d["cases"]), d["expected"], d["actual"], d.get("reproducibility") or "",
                        d.get("decided_by") or "",
                    )
                ]
            )  # fmt: skip
    return ("﻿" + buf.getvalue()).encode("utf-8")


# ------------------------------------------------------------------ frozen report when a run finishes


async def freeze_for_run(ctx: AppContext, scope: TenantScope, project_id: uuid.UUID, run_id: uuid.UUID) -> None:
    """Creates the frozen Test Execution Report of a finished run (once) and queues its rendering (design §13)."""
    from app.agents.reporting.discovery_report import next_report_version

    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        run = await s.get(ExecutionRun, run_id)
        if run is None or run.started_at is None or run.finished_at is None:
            return
        existing = (
            await s.execute(
                select(QaReport).where(QaReport.project_id == project_id, QaReport.report_type == ReportType.execution)
            )
        ).scalars()
        if any(
            (r.source_versions or {}).get("run_key") == run.key and (r.content or {}).get("frozen") for r in existing
        ):
            return
        report = QaReport(
            organisation_id=run.organisation_id,
            project_id=project_id,
            report_type=ReportType.execution,
            version=await next_report_version(s, project_id, ReportType.execution),
            status=ReportStatus.rendering,
            content={"frozen": True},
            source_versions={"run_key": run.key, "latest_per_case": False},
        )
        s.add(report)
        await s.commit()
        rid, org = report.id, run.organisation_id
    await ctx.queue.enqueue(
        "report_render", {"report_id": str(rid)}, org_id=org, project_id=project_id, dedupe_key=f"report:{rid}"
    )
