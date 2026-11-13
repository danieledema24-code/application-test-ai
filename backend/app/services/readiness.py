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
    return facts


def evaluate_row(row: ReadinessCriterion, facts: Facts, *, requirement_id: str | None = None) -> dict[str, Any] | None:
    return stamp(evaluate(row.check_rule_id, facts, requirement_id=requirement_id), row.key)
