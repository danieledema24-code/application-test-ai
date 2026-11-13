"""Loads the facts the Definition of Ready / Done checks need and evaluates criteria (P2-05)."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.readiness.rules import Facts, evaluate, stamp
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
    return facts


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


def evaluate_row(row: ReadinessCriterion, facts: Facts, *, requirement_id: str | None = None) -> dict[str, Any] | None:
    return stamp(evaluate(row.check_rule_id, facts, requirement_id=requirement_id), row.key)
