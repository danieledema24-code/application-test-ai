"""Loads the facts the Definition of Ready / Done checks need and evaluates criteria (P2-05)."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.readiness.rules import Facts, evaluate, stamp, text_rule_for
from app.db.models import (
    AcceptanceCriterion,
    ProjectSecret,
    ProjectUrl,
    QaReport,
    ReadinessCriterion,
    Risk,
    ScanSession,
)
from app.domain.enums import ItemStatus, ReportStatus, UrlRole
from app.services import gates


async def load_facts(s: AsyncSession, project_id: uuid.UUID) -> Facts:
    _run, reqs = await gates.current_requirements(s, project_id)
    acs = (
        list(
            (
                await s.execute(
                    select(AcceptanceCriterion).where(AcceptanceCriterion.requirement_id.in_([r.id for r in reqs]))
                )
            ).scalars()
        )
        if reqs
        else []
    )
    approved_ac = {a.requirement_id for a in acs if a.status == ItemStatus.approved}
    with_values = {a.requirement_id for a in acs if a.test_values and a.status != ItemStatus.rejected}
    facts = Facts(
        requirements=[
            {
                "id": str(r.id),
                "key": r.key,
                "status": r.status.value,
                "category": r.category,
                "ac_approved": r.id in approved_ac,
                "ac_with_values": r.id in with_values,
            }
            for r in reqs
            if r.status.value != "rejected"
        ]
    )
    url = (
        await s.execute(
            select(ProjectUrl).where(ProjectUrl.project_id == project_id, ProjectUrl.role == UrlRole.primary)
        )
    ).scalar_one_or_none()
    if url is not None and url.last_check:
        facts.reachable = bool(url.last_check.get("reachable"))
        facts.url_checked_at = url.last_check.get("checked_at")
    scan = (
        await s.execute(
            select(ScanSession)
            .where(ScanSession.project_id == project_id)
            .order_by(ScanSession.sequence.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    facts.auth_boundary = bool(scan and scan.auth_boundaries) or any(
        r.category == "authentication" and r.status.value != "rejected" for r in reqs
    )
    secret = (
        await s.execute(select(ProjectSecret).where(ProjectSecret.project_id == project_id).limit(1))
    ).scalar_one_or_none()
    facts.credentials = secret is not None
    facts.credentials_result = secret.last_result.value if secret is not None and secret.last_result else None
    srun, _strat = await gates.current_strategy(s, project_id)
    if srun is not None:
        facts.risks = len(list((await s.execute(select(Risk.id).where(Risk.stage_run_id == srun.id))).scalars()))
    facts.reports_ready = [
        r.value
        for r in (
            await s.execute(
                select(QaReport.report_type).where(
                    QaReport.project_id == project_id, QaReport.status == ReportStatus.ready
                )
            )
        ).scalars()
    ]
    await _phase3_facts(s, project_id, reqs, acs, facts)
    await _nf_facts(s, project_id, facts)
    await _regression_facts(s, project_id, facts)
    return facts


async def _regression_facts(s: AsyncSession, project_id: uuid.UUID, facts: Facts) -> None:
    """P6-06: the latest rescan change set's must-run tests and whether each has a result from a run created after the
    change (or, for a manual test, a recorded re-test; D37). The same rule as `rr.impacted_rerun`."""
    from app.db.models import ExecutionResult, ExecutionRun
    from app.services import impact as impact_svc
    from app.services import release as rsvc
    from app.services.execution import NOT_RESULTS
    from app.services.traceability import rescan_sets

    sets = await rescan_sets(s, project_id)
    if not sets:
        return
    cs = sets[-1]
    rec = await impact_svc.recommendation_view(s, cs, can_request=False)
    data: dict[str, Any] = {"change_set": cs.key, "reason": None, "must": [], "pending": [], "manual_pending": [],
                            "runs": []}  # fmt: skip
    facts.regression = data
    if not rec.get("available"):
        data["reason"] = str(rec.get("reason") or "the comparison has no recommendation yet")
        return
    musts = list(rec.get("must") or [])
    data["must"] = [str(p["key"]) for p in musts]
    lineages = [uuid.UUID(str(p["case_lineage_id"])) for p in musts]
    ran: dict[str, set[str]] = {}
    if lineages:
        rows = (
            await s.execute(
                select(ExecutionResult.case_lineage_id, ExecutionResult.status, ExecutionResult.error, ExecutionRun.key)
                .join(ExecutionRun, ExecutionRun.id == ExecutionResult.execution_run_id)
                .where(
                    ExecutionResult.project_id == project_id,
                    ExecutionResult.case_lineage_id.in_(lineages),
                    ExecutionRun.created_at >= cs.created_at,
                )
            )
        ).all()
        for row_lin, st, err, run_key in rows:
            if st in rsvc.RAN_STATUSES and (err or "") not in NOT_RESULTS:
                ran.setdefault(str(row_lin), set()).add(str(run_key))
    by_hand = {str(k) for k in (await rsvc.latest_manual_retests(s, cs.id))}
    runs: set[str] = set()
    for p in musts:
        must_lin = str(p["case_lineage_id"])
        if must_lin in ran:
            runs |= ran[must_lin]
        elif p.get("not_runnable_reason") == impact_svc.MUST_MANUAL:
            if must_lin not in by_hand:
                data["manual_pending"].append(str(p["key"]))
        else:
            data["pending"].append(str(p["key"]))
    data["runs"] = sorted(runs)


async def _nf_facts(s: AsyncSession, project_id: uuid.UUID, facts: Facts) -> None:
    """Latest accessibility and security checks and the latest judged load test (P5-07)."""
    from app.db.models import Approval, User
    from app.services import nf_evidence as nfe

    st = await nfe.load(s, project_id)
    names = {
        u.id: (u.full_name or "someone")
        for u in (
            await s.execute(select(User).where(User.id.in_([f.status_by for f in st.a11y + st.sec if f.status_by])))
        ).scalars()
    }
    for kind, scan, rows in (("accessibility", st.a11y_scan, st.a11y), ("security", st.sec_scan, st.sec)):
        if scan is None:
            facts.nf[kind] = None
            continue
        counted = [f for f in rows if nfe.counted(f)]
        facts.nf[kind] = {
            "scan_key": scan.key,
            "open": [(f.key, f.severity.value) for f in counted if f.status.value == "open"],
            "accepted": [
                (f.key, names.get(f.status_by, "someone") if f.status_by else "someone", f.status_reason or "")
                for f in counted
                if f.status.value == "accepted_risk"
            ],
        }
    if st.run is None:
        facts.nf["performance"] = None
        return
    apr = (
        await s.execute(select(Approval).where(Approval.performance_run_id == st.run.id).limit(1))
    ).scalar_one_or_none()
    missed = []
    for t in st.missed():
        where = t.get("path") or "All requests"
        if t.get("metric") == "error_rate":
            missed.append(
                f"{where} errors {float(t.get('measured') or 0) * 100:.1f} % (threshold {float(t['value']) * 100:g} %)"
            )
        else:
            from app.domain.performance.profile import ms_text

            missed.append(
                f"{where} {t.get('metric')} {ms_text(t.get('measured'))} (threshold {ms_text(t.get('value'))})"
            )
    facts.nf["performance"] = {
        "run_key": st.run.key,
        "approved_at": apr.decided_at.strftime("%-d %b") if apr is not None and apr.decided_at else None,
        "missed": missed,
        "thresholds": len(st.run.threshold_results or []),
    }


async def _phase3_facts(
    s: AsyncSession, project_id: uuid.UUID, reqs: list[Any], acs: list[AcceptanceCriterion], facts: Facts
) -> None:
    """Test data per form field, AC coverage and traceability, from the current test design (P3-03, P3-04)."""
    from app.domain.enums import CaseStatus, StageStatus, TestDataStatus
    from app.services import testdesign as tds
    from app.services import traceability as trace

    run = await tds.current_run(s, project_id)
    if run is None:
        return
    cases = [c for c in await tds.cases_of(s, run.id) if c.status in tds.ACTIVE_CASE]
    data = {str(d.lineage_id): d for d in await tds.data_of(s, run.id) if d.status == TestDataStatus.active}
    facts.test_data = {}
    for r in reqs:
        mine = [c for c in cases if str(r.lineage_id) in {str(x) for x in c.requirement_lineage_ids or []}]
        fields: dict[str, str] = {}
        for c in mine:
            for lin in c.data_lineage_ids or []:
                d = data.get(str(lin))
                if d is not None:
                    fields.setdefault(d.field_label, "data")
        for c in mine:
            label = (c.open_question_ref or {}).get("field") if c.status != CaseStatus.rejected else None
            if c.expected_result_status.value == "open_question" and label:
                fields[str(label)] = "open_question"
        facts.test_data[str(r.id)] = fields
    covered = {str(x) for c in cases for x in c.ac_lineage_ids or []}
    facts.ac_coverage = {}
    for r in reqs:
        approved = sorted(
            (a for a in acs if a.requirement_id == r.id and a.status == ItemStatus.approved), key=lambda a: a.key
        )
        facts.ac_coverage[str(r.id)] = (
            [a.key for a in approved],
            [a.key for a in approved if str(a.lineage_id) in covered],
        )
    t = await trace.load(s, project_id)
    g = await trace.gaps(s, t)
    st = await tds.design_stage(s, project_id)
    facts.traceability = {
        "stale": st.status == StageStatus.stale,
        "without_case": [str(x["key"]) for x in g["requirements_without_test_cases"]["none"]],
        "orphans": [str(x["key"]) for x in g["test_cases_without_requirements"]],
    }
    # Phase 4 (P4-12): latest results per requirement and the open defects.
    if t.executed:
        facts.executed = {}
        for r in reqs:
            views = [v for v in t.cases if v.status == "approved" and str(r.lineage_id) in v.requirement_lineages]
            facts.executed[str(r.id)] = [str((t.result(v) or {}).get("status")) for v in views if t.result(v)]
    if t.executed or t.all_defects:
        facts.open_defects = [
            (str(d["key"]), str(d["severity"])) for d in t.all_defects if d["status"] in trace.OPEN_DEFECT
        ]


def evaluate_row(row: ReadinessCriterion, facts: Facts, *, requirement_id: str | None = None) -> dict[str, Any] | None:
    # P5-07: a DoD item about accessibility, security or performance is evaluated from the latest checks even
    # without a coded rule (a person wrote it, or a template mentions it). P6-06: so is one about regression.
    rule = row.check_rule_id
    if rule is None:
        rule = text_rule_for(row.kind, row.text)
    return stamp(evaluate(rule, facts, requirement_id=requirement_id), row.key)
