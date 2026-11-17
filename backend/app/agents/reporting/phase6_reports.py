"""Phase 6 reports (P6-05c, decision D34): the Release Readiness Report (one per release assessment) and the Test
Completion Report (ISO/IEC/IEEE 29119-3 structure), as JSON, HTML, PDF, CSV and XLSX on the Phase 2–5 pipeline
(`phase2_reports.render`). There is no DOCX.

The Release Readiness Report is the assessment exactly as `GET /release-assessments/{id}` returns it (the same
serializer, `release.assessment_dict`), with the fixed statement first and a DRAFT band until Gate 9 makes it final.
One is created when an assessment is made, and again when it is decided or a criterion is confirmed, so the latest
report of an assessment always matches it; a stale or replaced assessment's report says so in the API
(`is_latest_source` false) and can be generated again.

The Test Completion Report is generated on request from an assessment (its exit criteria, conditions and residual risk)
or from current data (the same rules, worked out at generation, nothing stored), and is frozen when generated. Its
measures are computed in code from the same sources the API reads: the latest result per approved test case
(`traceability` approved basis, as `GET /traceability/coverage?basis=approved`) and each run's stored totals (as
`GET /execution-runs/{id}`). Lessons learned are a person's text, or AI text the person kept, labelled as such.
People appear by name only. Every CSV and XLSX cell goes through the formula guard.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.reporting.phase3_reports import safe_cell
from app.agents.reporting.phase4_reports import SOURCE_GROUP
from app.context import AppContext
from app.db.models import (
    ChangeSet,
    Defect,
    ExecutionRun,
    PerformanceProfile,
    Project,
    QaReport,
    QualityFinding,
    QualityScan,
    ReleaseAssessment,
    User,
)
from app.db.tenant import TenantScope, bind_scope
from app.domain.enums import (
    AssessmentDecision,
    AssessmentStatus,
    ChangeSetStatus,
    QualityScanKind,
    ReportStatus,
    ReportType,
)
from app.domain.release import criteria as rc
from app.services import exploratory as esvc

PHASE6 = frozenset({ReportType.completion, ReportType.release_readiness})
NOT_AVAILABLE = "Not available yet: assess release readiness first"
NO_DOCX = "No Word (DOCX) export."
SLUG = {ReportType.completion: "test-completion", ReportType.release_readiness: "release-readiness"}
# design P6 §3.8 (P6-03 owns the session view; the report uses the same words).
EXPLORE_STATEMENT = (
    "This session tried {n} actions on {m} pages within its budget. Exploration is a sample, not a complete test, "
    "and it never submits forms or sends data."
)
NO_EXPLORATION = "No exploratory session has run."
STATE_WORD = {"recommended": "Recommended", "final": "Final", "not_decided": "Not decided"}
STATUS_LABEL = {rc.MET: "Met", rc.NOT_MET: "Not met", rc.NOT_EVALUABLE: "Not evaluable"}
RESULT_KEYS = ("passed", "failed", "flaky", "error", "blocked", "skipped")
RAN = ("passed", "failed", "flaky", "error")
OPEN_DEFECT = ("confirmed", "fixed")
SOURCES = ("functional", "accessibility", "security", "performance", "api")


# ------------------------------------------------------------------ sources


async def has_source(s: AsyncSession, project_id: Any) -> bool:
    """Both reports need a release assessment (design P6 §11.1 "Assess release readiness first")."""
    q = select(ReleaseAssessment.id).where(ReleaseAssessment.project_id == project_id).limit(1)
    return (await s.execute(q)).first() is not None


async def find(s: AsyncSession, project_id: Any, key: str | None) -> ReleaseAssessment | None:
    """The assessment with `key`, or the latest one."""
    q = select(ReleaseAssessment).where(ReleaseAssessment.project_id == project_id)
    if key:
        q = q.where(ReleaseAssessment.key == key)
    else:
        q = q.order_by(ReleaseAssessment.created_at.desc(), ReleaseAssessment.key.desc()).limit(1)
    return (await s.execute(q)).scalars().first()


async def _assessment(s: AsyncSession, report: QaReport) -> ReleaseAssessment | None:
    aid = (report.source_versions or {}).get("assessment_id")
    if not aid:
        return None
    return (
        await s.execute(select(ReleaseAssessment).where(ReleaseAssessment.id == uuid.UUID(str(aid))))
    ).scalar_one_or_none()


def state_of(a: ReleaseAssessment) -> str:
    """Everything a Release Readiness Report shows that can change on an assessment: status, decision, verdict,
    criteria results (a confirmed criterion), staleness and replacement."""
    body = [
        a.status.value,
        a.decision.value if a.decision else None,
        a.recommendation.value,
        a.final_verdict.value if a.final_verdict else None,
        a.decided_at.isoformat() if a.decided_at else None,
        a.override_reason,
        a.stale_reason,
        (a.scope or {}).get("superseded_by"),
        [(c.get("id"), c.get("status"), c.get("detail")) for c in a.criteria or []],
    ]
    return hashlib.sha256(json.dumps(body, default=str).encode()).hexdigest()


def band_for(a: ReleaseAssessment) -> str | None:
    """design P6 §11.2: the DRAFT band while the assessment isn't final."""
    if a.status == AssessmentStatus.final:
        return None
    if a.status == AssessmentStatus.stale:
        return f"DRAFT: {a.key} is out of date and can't be decided."
    if a.status == AssessmentStatus.superseded:
        by = (a.scope or {}).get("superseded_by")
        return f"DRAFT: {a.key} was replaced by {by} and can't be decided." if by else f"DRAFT: {a.key} was replaced."
    return f"DRAFT: Gate 9 not decided for {a.key}."


async def stamp(
    s: AsyncSession, project_id: Any, report_type: ReportType, run_key: str | None, basis: str | None
) -> dict[str, Any]:
    """What the report is built from: an assessment (both types) or current data (completion only)."""
    if report_type == ReportType.completion and basis == "current":
        return {"run_key": None, "basis": "current"}
    a = await find(s, project_id, run_key)
    if a is None:
        raise ValueError(NOT_AVAILABLE)
    out: dict[str, Any] = {"run_key": a.key, "assessment_id": str(a.id), "basis": "assessment"}
    if report_type == ReportType.release_readiness:
        out["state"] = state_of(a)
    return out


async def is_latest_source(s: AsyncSession, report: QaReport) -> bool:
    """A Release Readiness Report is current while its assessment hasn't changed since; a completion report is a frozen
    record of when it was generated."""
    if report.report_type != ReportType.release_readiness:
        return True
    a = await _assessment(s, report)
    return a is not None and (report.source_versions or {}).get("state") == state_of(a)


async def approval(s: AsyncSession, report: QaReport) -> dict[str, Any]:
    """Gate 9 for the Release Readiness Report (draft until the assessment is final); the completion report has no
    gate of its own."""
    if report.report_type != ReportType.release_readiness:
        return {"gate": None, "status": "approved", "decided_by": None, "decided_at": None}
    a = await _assessment(s, report)
    if a is None:
        return {"gate": "G9", "status": "draft", "decided_by": None, "decided_at": None, "band": None}
    who = await s.get(User, a.decided_by) if a.decided_by else None
    final = a.status == AssessmentStatus.final
    return {
        "gate": "G9",
        "status": "approved" if final else "draft",
        "decided_by": {"full_name": who.full_name} if who is not None and final else None,
        "decided_at": a.decided_at.isoformat() if a.decided_at and final else None,
        "band": band_for(a),
    }


def file_name(host: str, content: dict[str, Any], fmt: str) -> str:
    """`{host}-release-readiness-REL-0002-{yyyy-mm-dd}.{ext}`, `{host}-test-completion-REL-0002-…` and
    `{host}-test-completion-current-…` (design P6 §11.3)."""
    day = str(content.get("generated_at", ""))[:10]
    slug = SLUG[ReportType(content["report_type"])]
    return f"{host}-{slug}-{content.get('source_key') or 'current'}-{day}.{fmt}"


# ------------------------------------------------------------------ creating


async def create(
    s: AsyncSession,
    project: Project,
    report_type: ReportType,
    *,
    user_id: Any,
    run_key: str | None = None,
    basis: str | None = None,
    lessons: dict[str, Any] | None = None,
) -> QaReport:
    """Adds a `rendering` report (the caller commits and queues `report_render`). Reports are frozen when rendered."""
    from app.agents.reporting.discovery_report import next_report_version

    report = QaReport(
        organisation_id=project.organisation_id,
        project_id=project.id,
        report_type=report_type,
        version=await next_report_version(s, project.id, report_type),
        status=ReportStatus.rendering,
        created_by=user_id,
        content={"frozen": True, **({"lessons": lessons} if lessons else {})},
        source_versions=await stamp(s, project.id, report_type, run_key, basis),
    )
    s.add(report)
    await s.flush()
    return report


async def freeze_for_assessment(
    ctx: AppContext, scope: TenantScope, project_id: uuid.UUID, assessment_id: uuid.UUID, user_id: Any = None
) -> None:
    """Creates the Release Readiness Report of an assessment as it is now (once per state) and queues its rendering:
    when it is made, decided at Gate 9 or a criterion is confirmed (design P6 §10.3 "loses its DRAFT band")."""
    async with ctx.session_factory() as s:
        bind_scope(s, scope)
        a = await s.get(ReleaseAssessment, assessment_id)
        if a is None:
            return
        state = state_of(a)
        existing = (
            await s.execute(
                select(QaReport).where(
                    QaReport.project_id == project_id, QaReport.report_type == ReportType.release_readiness
                )
            )
        ).scalars()
        if any(
            (r.source_versions or {}).get("assessment_id") == str(a.id)
            and (r.source_versions or {}).get("state") == state
            for r in existing
        ):
            return
        project = await s.get(Project, project_id)
        assert project is not None
        report = await create(s, project, ReportType.release_readiness, user_id=user_id, run_key=a.key)
        await s.commit()
        rid, org = report.id, project.organisation_id
    await ctx.queue.enqueue(
        "report_render", {"report_id": str(rid)}, org_id=org, project_id=project_id, dedupe_key=f"report:{rid}"
    )


# ------------------------------------------------------------------ wording shared by both reports


def _when(value: Any) -> str:
    from app.services.release import _when as parse
    from app.services.release import when_text

    at = parse(value)
    return when_text(at) if at else "—"


def verdict_text(d: dict[str, Any]) -> str:
    """ "Conditional · Recommended": the verdict is never shown alone (design P6 §3.7)."""
    return f"{rc.VERDICT_LABEL[d['verdict']]} · {STATE_WORD[d['verdict_state']]}"


def decision_line(d: dict[str, Any]) -> str:
    """The Gate 9 line (design P6 §11.2): the decider and the time, or why nothing is decided."""
    by = (d.get("decided_by") or {}).get("full_name") or "someone"
    status = d["status"]
    if status == AssessmentStatus.final.value:
        return f"Decided by {by}, {_when(d.get('decided_at'))}"
    if status == AssessmentStatus.rejected.value:
        return (
            f"Rejected by {by}, {_when(d.get('decided_at'))}: '{d.get('override_reason') or ''}'. Nothing is decided."
        )
    if status == AssessmentStatus.stale.value:
        return (
            f"Gate 9: not decided. Evidence changed after this assessment ({d.get('stale_reason') or 'new evidence'})."
        )
    if status == AssessmentStatus.superseded.value:
        return f"Gate 9: not decided. Replaced by {d.get('superseded_by') or 'a newer assessment'}."
    return "Gate 9: waiting for a decision by someone who can approve."


def override_text(d: dict[str, Any]) -> str | None:
    if d.get("decision") != AssessmentDecision.override.value:
        return None
    by = (d.get("decided_by") or {}).get("full_name") or "someone"
    return (
        f"Overridden by {by}: '{d.get('override_reason') or ''}' (recommended: {rc.VERDICT_LABEL[d['recommendation']]})"
    )


def _keys(refs: list[dict[str, Any]] | None) -> str:
    return ", ".join(str(r.get("key")) for r in refs or [] if r.get("key"))


def criterion_rows(criteria: list[dict[str, Any]], strategy: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Criteria as both reports print them: status and blocking as words, evidence keys, a person's confirmation."""
    from app.services.release import _source_label

    rows = []
    for c in criteria:
        who = (c.get("confirmed_by") or {}).get("full_name") if c.get("manual") else None
        rows.append({
            "id": c.get("id"),
            "text": c.get("text"),
            "blocking": bool(c.get("blocking")),
            "blocking_text": "Blocking" if c.get("blocking") else "Not blocking",
            "status": c.get("status"),
            "status_text": STATUS_LABEL.get(str(c.get("status")), str(c.get("status"))),
            "source_label": c.get("source_label") or _source_label(c, strategy),
            "evidence": _keys(c.get("evidence_refs")),
            "detail": c.get("detail") or "",
            "confirmed": f"Confirmed by {who or 'someone'}: '{c.get('confirm_reason') or ''}'" if c.get("manual") else None,
            "confirmed_by": who,
            "confirm_reason": c.get("confirm_reason") if c.get("manual") else None,
        })  # fmt: skip
    return rows


def condition_rows(conds: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {"text": x.get("text"), "blocking": bool(x.get("blocking")), "evidence": _keys(x.get("evidence_refs"))}
        for x in conds
    ]


def residual_rows(residual: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "key": (r.get("risk") or {}).get("key"),
            "title": r.get("title"),
            "initial": rc.LEVEL_LABEL.get(str(r.get("initial")), str(r.get("initial"))),
            "residual": rc.LEVEL_LABEL.get(str(r.get("residual")), str(r.get("residual"))),
            "line": r.get("line"),
            "tests": r.get("tests") or {},
        }
        for r in residual
    ]


def changes_parts(c: dict[str, Any]) -> list[str]:
    """ "What changed since the last assessment" as a text list (the web's `changesSinceParts`)."""
    if not c.get("previous"):
        return []
    words = {"draft": "drafted", "confirmed": "confirmed", "fixed": "Fixed", "verified": "Verified",
             "closed": "Closed", "rejected": "rejected", "reopened": "reopened"}  # fmt: skip
    r = c.get("recommendation") or {}
    out = [
        f"Recommendation {rc.VERDICT_LABEL[r['from']]} → {rc.VERDICT_LABEL[r['to']]}"
        if r and r.get("from") != r.get("to")
        else f"Recommendation unchanged ({rc.VERDICT_LABEL[c['previous']['recommendation']]})"
    ]
    out += [str(x) for x in (c.get("change_sets") or []) + (c.get("runs") or [])]
    for d in c.get("defects") or []:
        to = words.get(d["to"], d["to"])
        out.append(f"{d['key']} {words.get(d['from'], d['from'])} → {to}" if d.get("from") else f"{d['key']} {to}")
    out += [str(x) for x in c.get("exploratory_sessions") or []]
    for x in c.get("criteria") or []:
        out.append(f"{x['text']}: {STATUS_LABEL.get(x['from'], x['from'])} → {STATUS_LABEL.get(x['to'], x['to'])}")
    return out


# ------------------------------------------------------------------ build


async def build(ctx: AppContext, s: AsyncSession, project: Project, report: QaReport) -> dict[str, Any]:
    if report.report_type == ReportType.release_readiness:
        return await _readiness(s, report)
    return await _completion(ctx, s, project, report)


async def _assessment_out(s: AsyncSession, a: ReleaseAssessment) -> dict[str, Any]:
    from app.services import release as svc

    d = await svc.assessment_dict(s, a, see_email=False, can_assess=False, can_decide=False)
    d = json.loads(json.dumps(d, default=str))
    for k in ("permissions", "decidable", "is_latest"):
        d.pop(k, None)
    return dict(d)


async def _readiness(s: AsyncSession, report: QaReport) -> dict[str, Any]:
    a = await _assessment(s, report)
    if a is None:
        raise ValueError(NOT_AVAILABLE)
    d = await _assessment_out(s, a)
    narrative = (d.get("ai_sections") or {}).get("narrative")
    vt = verdict_text(d)
    return {
        "source_key": a.key,
        "statement": d["statement"],
        "band": band_for(a),
        "assessment": d,
        "verdict_text": vt,
        "reason": d.get("reason"),
        "decision_line": decision_line(d),
        "override_text": override_text(d),
        "criteria": criterion_rows(d.get("criteria") or [], (a.scope or {}).get("strategy")),
        "conditions": condition_rows(d.get("conditions_list") or []),
        "residual": residual_rows(d.get("residual_risks") or []),
        "overall_residual": rc.LEVEL_LABEL.get(str(d.get("overall_residual")), None),
        "changes": {
            "previous": (d.get("changes_since") or {}).get("previous"),
            "parts": changes_parts(d.get("changes_since") or {}),
            "text": (d.get("changes_since") or {}).get("text"),
        },
        "narrative": narrative,
        "limitations": [
            "The recommendation covers only the tests the platform ran and the evidence recorded (see the statement).",
            NO_DOCX,
        ],
        "summary": f"{a.key}: {vt}. {d.get('reason') or ''}".strip(),
        "summary_generated_by": "rules",
        "stage_run_version": None,
    }


def _bucket() -> dict[str, int]:
    return {"approved": 0, "executed": 0, **dict.fromkeys(RESULT_KEYS, 0), "not_run": 0}


def _count(b: dict[str, int], status: str | None) -> None:
    b["approved"] += 1
    if status in RAN:
        b["executed"] += 1
    if status in RESULT_KEYS:
        b[str(status)] += 1
    else:
        b["not_run"] += 1


async def _completion(ctx: AppContext, s: AsyncSession, project: Project, report: QaReport) -> dict[str, Any]:
    from app.agents.reporting.phase4_reports import _not_automated
    from app.api.errors import NotFound
    from app.services import execution as xsvc
    from app.services import gates, readiness
    from app.services import release as svc
    from app.services import traceability as trace

    sv = report.source_versions or {}
    basis = sv.get("basis") or "assessment"
    a = await _assessment(s, report) if basis == "assessment" else None
    if basis == "assessment" and a is None:
        raise ValueError(NOT_AVAILABLE)

    # Exit criteria, conditions and residual risk: the assessment's, or worked out now by the same rules.
    release: dict[str, Any]
    if a is not None:
        latest = await find(s, project.id, None)
        d = await _assessment_out(s, a)
        criteria, residual = d.get("criteria") or [], d.get("residual_risks") or []
        conds = d.get("conditions_list") or []
        strategy = (a.scope or {}).get("strategy")
        release = {
            "key": a.key,
            "status": a.status.value,
            "verdict_text": verdict_text(d),
            "reason": d.get("reason"),
            "decision_line": decision_line(d),
            "override_text": override_text(d),
            "statement": d["statement"],
            "is_latest": latest is not None and latest.id == a.id,
        }
        overall = d.get("overall_residual")
    else:
        snap, scope = await svc.build_snapshot(s, project.id)
        criteria = rc.evaluate(snap)
        conds = rc.conditions(criteria)
        residual, overall = rc.residual(snap)
        strategy = scope.get("strategy")
        release = {
            "key": None,
            "status": None,
            "text": "Not tied to a release assessment. The exit criteria and residual risk were worked out by the "
            "same rules when this report was generated; no verdict is recorded.",
        }

    # Measures: the latest result per approved test case (the traceability approved basis, as the coverage API).
    try:
        t = await trace.load(s, project.id, "approved")
    except NotFound:
        t = await trace.load(s, project.id)
    cov = json.loads(json.dumps(trace.coverage(t), default=str))
    manual = {c["case_key"] for c in await _not_automated(s, project.id)}
    results: list[dict[str, Any]] = []
    total = _bucket()
    by_type: dict[str, dict[str, int]] = {}
    by_level: dict[str, dict[str, int]] = {}
    for v in t.cases:
        if v.status != "approved":
            continue
        res = t.result(v) or {}
        status = res.get("status")
        sc = t.script(v) or {}
        results.append({
            "case_key": v.key, "title": v.title, "type": v.row.test_type, "level": v.row.test_level,
            "status": status or "not_run", "run_key": res.get("run_key"), "script": sc.get("state"),
            "manual": v.key in manual,
        })  # fmt: skip
        _count(total, status)
        _count(by_type.setdefault(v.row.test_type, _bucket()), status)
        _count(by_level.setdefault(v.row.test_level, _bucket()), status)

    never = [r for r in results if r["status"] == "not_run"]
    stopped = [r for r in results if r["status"] in ("blocked", "skipped")]
    deviations = [
        {
            "case_key": r["case_key"],
            "title": r["title"],
            "deviation": "Approved but never executed",
            "reason": "Manual test: no recorded result" if r["manual"] else "Not selected in any finished run",
        }
        for r in never
    ] + [
        {
            "case_key": r["case_key"],
            "title": r["title"],
            "deviation": f"{r['status'].capitalize()} in its latest run ({r['run_key']})",
            "reason": "Didn't run to a result",
        }
        for r in stopped
    ]
    never_line = (
        "Approved but never executed: "
        + ", ".join(f"{r['case_key']}{' (manual)' if r['manual'] else ''}" for r in never)
        if never
        else "Every approved test case was executed at least once."
    )

    # Defects by severity, status and source.
    defects = list(
        (await s.execute(select(Defect).where(Defect.project_id == project.id).order_by(Defect.key))).scalars()
    )
    by_sev: dict[str, int] = {}
    by_status: dict[str, int] = {}
    by_source: dict[str, int] = {}
    for dx in defects:
        by_sev[dx.severity.value] = by_sev.get(dx.severity.value, 0) + 1
        by_status[dx.status.value] = by_status.get(dx.status.value, 0) + 1
        src = SOURCE_GROUP.get(dx.source.value, "functional")
        by_source[src] = by_source.get(src, 0) + 1
    defect_rows = [
        {
            "key": x.key,
            "summary": x.summary,
            "severity": x.severity.value,
            "status": x.status.value,
            "source": SOURCE_GROUP.get(x.source.value, "functional"),
        }
        for x in defects
    ]

    # Runs (their stored totals, as the execution API), regression runs and change sets.
    runs = list(
        (
            await s.execute(
                select(ExecutionRun)
                .where(ExecutionRun.project_id == project.id, ExecutionRun.finished_at.is_not(None),
                       ExecutionRun.started_at.is_not(None))
                .order_by(ExecutionRun.created_at)
            )
        ).scalars()
    )  # fmt: skip
    run_rows = [
        {
            "key": r.key,
            "status": r.status.value,
            "selection": xsvc.selection_label(r.selection or {}),
            "change_set": (r.selection or {}).get("change_set_key"),
            "totals": {k: v for k, v in (r.totals or {}).items() if k != "live"},
            "finished_at": r.finished_at.isoformat() if r.finished_at else None,
        }
        for r in runs
    ]
    sets = list(
        (
            await s.execute(
                select(ChangeSet)
                .where(ChangeSet.project_id == project.id, ChangeSet.stage_run_id.is_not(None),
                       ChangeSet.status == ChangeSetStatus.completed)
                .order_by(ChangeSet.created_at)
            )
        ).scalars()
    )  # fmt: skip
    change_rows = [
        {
            "key": cs.key,
            "created_at": cs.created_at.isoformat() if cs.created_at else None,
            "total": int((cs.summary or {}).get("total") or 0),
            "by_significance": (cs.summary or {}).get("by_significance") or {},
            "regression_runs": [r["key"] for r in run_rows if r["change_set"] == cs.key],
        }
        for cs in sets
    ]

    # Exploratory sessions (P6-03): actions, pages and findings as recorded; none yet is said plainly.
    scans = list(
        (
            await s.execute(
                select(QualityScan)
                .where(QualityScan.project_id == project.id, QualityScan.kind == QualityScanKind.exploratory)
                .order_by(QualityScan.created_at)
            )
        ).scalars()
    )
    sessions = []
    for sx in scans:
        found = list((await s.execute(select(QualityFinding).where(QualityFinding.scan_id == sx.id))).scalars())
        sm: dict[str, Any] = dict(sx.summary or {})
        # Only a session that ran gets actions and the honesty statement; a request that was refused, withdrawn,
        # expired or is still waiting shows its status ("Not approved", …) and never "tried 0 actions".
        ran = sx.started_at is not None
        n, m = (sm.get("actions"), sm.get("pages")) if ran else (None, None)
        sessions.append({
            "key": sx.key, "status": sx.status.value, "status_label": esvc.status_label(sx, {}), "ran": ran,
            "actions": n, "pages": m, "findings": len(found),
            "open_high_medium": sum(1 for f in found if f.status.value == "open"
                                    and f.severity.value in ("high", "medium")),
            "statement": EXPLORE_STATEMENT.format(n=n, m=m) if isinstance(n, int) and isinstance(m, int) else None,
        })  # fmt: skip

    # Non-functional summary (the latest checks and load test, as the readiness facts read them).
    facts = await readiness.load_facts(s, project.id)
    nf = []
    for kind, label, none in (("accessibility", "Accessibility", "No accessibility check has run."),
                              ("security", "Security", "No security check has run.")):  # fmt: skip
        got: dict[str, Any] | None = facts.nf.get(kind)
        if not got:
            nf.append({"type": label, "source": None, "text": none})
            continue
        opened = got.get("open") or []
        sev: dict[str, int] = {}
        for _k, level in opened:
            sev[level] = sev.get(level, 0) + 1
        parts = ", ".join(f"{v} {k}" for k, v in sorted(sev.items()))
        accepted = len(got.get("accepted") or [])
        text = f"{len(opened)} open finding{'s' if len(opened) != 1 else ''}" + (f" ({parts})" if parts else "")
        nf.append({"type": label, "source": got.get("scan_key"),
                   "text": text + (f"; {accepted} accepted" if accepted else "")})  # fmt: skip
    perf = facts.nf.get("performance")
    if not perf:
        nf.append({"type": "Performance", "source": None, "text": "No load test has run."})
    else:
        missed = perf.get("missed") or []
        nf.append({"type": "Performance", "source": perf.get("run_key"),
                   "text": "Missed: " + "; ".join(missed) if missed else
                   f"Every threshold met ({perf.get('thresholds', 0)} thresholds)"})  # fmt: skip

    # Reusable assets: the current scripts and the load-test profiles.
    scripts = sorted(
        ({"path": v["path"], "version": v["version"], "state": v["state"]} for v in t.scripts.values()),
        key=lambda x: str(x["path"]),
    )
    profiles = [
        {"key": p.key, "name": p.name}
        for p in (
            await s.execute(
                select(PerformanceProfile)
                .where(PerformanceProfile.project_id == project.id)
                .order_by(PerformanceProfile.key)
            )
        ).scalars()
    ]

    limitations = [
        "Measures count the latest result of each approved test case when this report was generated; earlier "
        "results of the same test case aren't counted.",
        "Automated checks can't judge wording, look and feel, or emails and other effects outside the browser.",
    ]
    if not any(x["ran"] for x in sessions):
        limitations.append("No exploratory session has run, so nothing beyond the scripted tests was explored.")
    if a is not None and a.status in (AssessmentStatus.stale, AssessmentStatus.superseded):
        limitations.append(
            f"{a.key} is out of date: evidence recorded after it is in the measures but not in its exit criteria "
            "or residual risk."
        )
    limitations.append(NO_DOCX)

    lessons = (report.content or {}).get("lessons")
    open_defects = sum(by_status.get(k, 0) for k in OPEN_DEFECT)
    summary = (
        f"{total['approved']} approved test case{'s' if total['approved'] != 1 else ''}: {total['executed']} executed "
        f"({total['passed']} passed, {total['failed']} failed), {len(never)} never executed. "
        f"{len(defects)} defect{'s' if len(defects) != 1 else ''} recorded, {open_defects} open."
    )
    if a is not None:
        summary += f" Release: {release['verdict_text']} ({a.key})."
    _srun, strat = await gates.current_strategy(s, project.id)
    in_types = [str(x.get("type")) for x in ((strat.content or {}) if strat else {}).get("test_types") or []
                if x.get("in_scope")]  # fmt: skip
    return {
        "source_key": a.key if a is not None else "current",
        "basis": basis,
        "band": None,
        "release": release,
        "summary": summary,
        "summary_generated_by": "rules",
        "scope": {
            "requirements": cov["requirements"]["approved"],
            "acceptance_criteria": cov["acceptance_criteria"]["approved"],
            "test_cases": total["approved"],
            "test_types": in_types,
            "design_version": cov.get("design_version"),
        },
        "not_tested": [{"item": d["case_key"], "reason": d["reason"]} for d in deviations[: len(never)]]
        + [{"item": x["type"], "reason": x["text"]} for x in nf if x["source"] is None],
        "deviations": deviations,
        "deviations_line": never_line,
        "measures": {
            "total": total,
            "by_type": dict(sorted(by_type.items())),
            "by_level": dict(sorted(by_level.items())),
            "groups": [
                {"group": "All approved test cases", **total},
                *({"group": f"Type: {k}", **v} for k, v in sorted(by_type.items())),
                *({"group": f"Level: {k}", **v} for k, v in sorted(by_level.items())),
            ],
            "coverage": {
                "requirements": cov["requirements"],
                "acceptance_criteria": cov["acceptance_criteria"],
                "execution": cov["execution"],
            },
            "defects": {
                "total": len(defects),
                "by_severity": by_sev,
                "by_status": by_status,
                "by_source": {k: by_source.get(k, 0) for k in SOURCES},
            },
        },
        "results": results,
        "defects": defect_rows,
        "runs": run_rows,
        "change_sets": change_rows,
        "exploratory": {"sessions": sessions, "empty": NO_EXPLORATION if not sessions else None},
        "non_functional": nf,
        "criteria": criterion_rows(criteria, strategy),
        "conditions": condition_rows(conds),
        "residual": residual_rows(residual),
        "overall_residual": rc.LEVEL_LABEL.get(str(overall), None),
        "assets": {"scripts": scripts, "profiles": profiles},
        "limitations": limitations,
        "lessons": lessons,
        "stage_run_version": None,
    }


# ------------------------------------------------------------------ CSV and XLSX


def tables(content: dict[str, Any]) -> list[tuple[str, list[str], list[list[Any]]]]:
    """(sheet name, header, rows) per table: one CSV section and one XLSX sheet each (design P6 §11.3)."""
    crit = (
        "Exit criteria" if content["report_type"] == ReportType.completion.value else "Criteria",
        ["Criterion", "Blocking", "Status", "Source", "Evidence", "Detail", "Confirmed by", "Confirmation reason"],
        [[c["text"], c["blocking_text"], c["status_text"], c["source_label"], c["evidence"], c["detail"],
          c.get("confirmed_by") or "", c.get("confirm_reason") or ""] for c in content.get("criteria") or []],
    )  # fmt: skip
    conds = (
        "Conditions",
        ["#", "Condition", "Blocking", "Evidence"],
        [[i, x["text"], "Blocking" if x["blocking"] else "Not blocking", x["evidence"]]
         for i, x in enumerate(content.get("conditions") or [], 1)],
    )  # fmt: skip
    risk = (
        "Residual risk",
        ["Risk", "Title", "Before testing", "Now", "Why", "Passed", "Failed", "Not tested"],
        [[r["key"], r["title"], r["initial"], r["residual"], r["line"], ", ".join(r["tests"].get("passed") or []),
          ", ".join(r["tests"].get("failed") or []), ", ".join(r["tests"].get("not_tested") or [])]
         for r in content.get("residual") or []],
    )  # fmt: skip
    if content["report_type"] == ReportType.release_readiness.value:
        return [crit, conds, risk]
    groups = content["measures"]["groups"]
    return [
        (
            "Results",
            ["Test case", "Title", "Type", "Level", "Latest result", "Run", "Script", "Manual"],
            [[r["case_key"], r["title"], r["type"], r["level"], r["status"].replace("_", " "), r["run_key"] or "",
              r["script"] or "", "yes" if r["manual"] else ""] for r in content.get("results") or []],
        ),
        (
            "Measures",
            ["Group", "Approved", "Executed", "Passed", "Failed", "Flaky", "Error", "Blocked", "Skipped", "Not run"],
            [[b["group"], b["approved"], b["executed"], b["passed"], b["failed"], b["flaky"], b["error"],
              b["blocked"], b["skipped"], b["not_run"]] for b in groups],
        ),
        (
            "Runs",
            ["Run", "Status", "Selection", "Change set", "Tests", "Passed", "Failed", "Flaky", "Error", "Blocked",
             "Skipped", "Finished"],
            [[r["key"], r["status"], r["selection"], r["change_set"] or "", r["totals"].get("tests", ""),
              *[r["totals"].get(k, "") for k in RESULT_KEYS], r["finished_at"] or ""] for r in content.get("runs") or []],
        ),
        (
            "Deviations",
            ["Test case", "Title", "Deviation", "Reason"],
            [[d["case_key"], d["title"], d["deviation"], d["reason"]] for d in content.get("deviations") or []],
        ),
        (
            "Defects",
            ["Defect", "Summary", "Severity", "Status", "Source"],
            [[d["key"], d["summary"], d["severity"], d["status"], d["source"]] for d in content.get("defects") or []],
        ),
        crit,
        conds,
        risk,
    ]  # fmt: skip


def summary_rows(content: dict[str, Any]) -> list[list[str]]:
    """The verdict, its reason, the Gate 9 decision and the override: the CSV's leading lines and the XLSX Summary
    sheet's lines after the band, formula-guarded."""
    if content["report_type"] == ReportType.release_readiness.value:
        src = content
        rows = [["Assessment", content.get("source_key") or ""]]
    else:
        src = content.get("release") or {}
        if not src.get("key"):
            return [["Based on", safe_cell(src.get("text") or "Current data, not tied to an assessment")]]
        rows = [["Assessment", src["key"]]]
    rows += [["Verdict", src.get("verdict_text") or ""], ["Reason", src.get("reason") or ""],
             ["Gate 9", src.get("decision_line") or ""]]  # fmt: skip
    if src.get("override_text"):
        rows.append(["Override", src["override_text"]])
    return [[safe_cell(v) for v in r] for r in rows]


def _table_csv(header: list[str], rows: list[list[Any]]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(header)
    for r in rows:
        w.writerow([safe_cell(v) for v in r])
    return ("﻿" + buf.getvalue()).encode("utf-8")


def to_csv(content: dict[str, Any]) -> bytes:
    """One file, one section per table: the table's name, its header and its rows, then a blank line. The DRAFT band
    (if any) is the first line, then a Summary section (verdict, reason, Gate 9 decision, override)."""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    if content.get("band"):
        w.writerow([safe_cell(content["band"])])
        w.writerow([])
    w.writerow(["Summary"])
    for line in summary_rows(content):
        w.writerow([safe_cell(v) for v in line])
    w.writerow([])
    for i, (name, header, rows) in enumerate(tables(content)):
        if i:
            w.writerow([])
        w.writerow([name])
        w.writerow(header)
        for r in rows:
            w.writerow([safe_cell(v) for v in r])
    return ("﻿" + buf.getvalue()).encode("utf-8")


def xlsx_tables(content: dict[str, Any]) -> list[tuple[str, bytes]]:
    return [(name, _table_csv(header, rows)) for name, header, rows in tables(content)]


# ------------------------------------------------------------------ AI lessons learned (labelled; no numbers)

_KEY = re.compile(r"\b[A-Z][A-Z0-9]*-\d+(?:-\d+)?\b")


def check_lessons(text: str, allowed_keys: set[str]) -> str | None:
    """Why an AI suggestion can't be used, or None. The model may name items from the data by key, but never writes a
    number of its own (counts and percentages are the report's, computed in code)."""
    for k in _KEY.findall(text):
        if k not in allowed_keys:
            return f"it names {k}, which isn't in the data"
    if re.search(r"\d", _KEY.sub("", text)):
        return "it writes a number"
    return None


def lessons_data(content_like: dict[str, Any]) -> tuple[str, set[str]]:
    """The facts given to the model (inside an untrusted block) and the keys it may name."""
    release = content_like.get("release") or {}
    lines = [f"- Release assessment: {release['key']}"] if release.get("key") else []
    lines += [f"- Condition: {c['text']}" for c in content_like.get("conditions") or []]
    lines += [f"- Criterion not met: {c['text']} ({c['detail']})" for c in content_like.get("criteria") or []
              if c["status"] != rc.MET]  # fmt: skip
    lines += [f"- Deviation: {d['case_key']} {d['deviation']}" for d in content_like.get("deviations") or []]
    lines += [f"- Residual risk: {r['key']} {r['title']}: {r['line']}" for r in content_like.get("residual") or []]
    text = "\n".join(lines) or "- No open conditions, deviations or residual risks."
    return text, set(_KEY.findall(text))
