"""Per-project human keys (SCAN-0001, EV-0001, FEAT-0001…) from `project_counters` via an atomic increment."""

from __future__ import annotations

import uuid

from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ProjectCounter

PREFIXES = {"scan": "SCAN", "evidence": "EV", "feature": "FEAT", "journey": "JRN", "report": "RPT"}


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
    return f"{PREFIXES.get(kind, kind.upper())}-{n:04d}"


async def next_key(session: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, kind: str) -> tuple[int, str]:
    n = await next_number(session, org_id, project_id, kind)
    return n, format_key(kind, n)
