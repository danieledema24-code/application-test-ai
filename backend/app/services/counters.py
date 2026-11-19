"""Per-project human keys (SCAN-0001, EV-0001, FEAT-0001…) from `project_counters` via an atomic increment."""

from __future__ import annotations

import uuid

from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ProjectCounter

PREFIXES = {
    "scan": "SCAN",
    "evidence": "EV",
    "feature": "FEAT",
    "journey": "JRN",
    "report": "RPT",
    "approval": "APR",  # P4-05
    "run": "RUN",  # P4-06
    "defect": "DEF",  # P4-09
    "a11y_scan": "A11Y",  # P5-02 (findings: A11Y-0001-01)
    "security_scan": "SEC",  # P5-03 (findings: SEC-0001-01)
    "perf_profile": "PRF",  # P5-01b
    "perf_run": "PERF",  # P5-01b
    "change_set": "CHG",  # P6-01
    "exploratory_session": "EXP",  # P6-03a (findings: EXP-0001-01)
    "heal": "HEAL",  # P6-04
    "release_assessment": "REL",  # P6-05a
}
# Key widths per api-contracts.md (REQ-0001, AC-0001, DOR-01, RISK-001, TS-001, TP-001, DOC-001, PROP-0001).
WIDTHS = {"DOR": 2, "DOD": 2, "RISK": 3, "TS": 3, "TP": 3, "DOC": 3, "PRF": 2}


async def next_number(session: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, kind: str) -> int:
    for _ in range(3):
        res = await session.execute(
            update(ProjectCounter)
            .where(ProjectCounter.project_id == project_id, ProjectCounter.kind == kind)
            .values(next_value=ProjectCounter.next_value + 1)
            .returning(ProjectCounter.next_value)
        )
        row = res.first()
        if row is not None:
            return int(row[0]) - 1
        try:
            async with session.begin_nested():
                session.add(ProjectCounter(organisation_id=org_id, project_id=project_id, kind=kind, next_value=2))
            return 1
        except IntegrityError:
            continue
    raise RuntimeError("Could not allocate a project counter value")


def format_key(kind: str, n: int) -> str:
    prefix = PREFIXES.get(kind, kind.upper())
    return f"{prefix}-{n:0{WIDTHS.get(prefix, 4)}d}"


async def next_key(session: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, kind: str) -> tuple[int, str]:
    n = await next_number(session, org_id, project_id, kind)
    return n, format_key(kind, n)
