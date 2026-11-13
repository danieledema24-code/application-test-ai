"""RevisionService (P2-00): append-only entity history keyed by lineage, so it survives regeneration."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import EntityRevision
from app.security.redact import redact_deep

REVISION_SOURCES = ("user", "assistant_proposal", "regeneration_review", "system")


def jsonable(value: Any) -> Any:
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [jsonable(v) for v in value]
    if hasattr(value, "value") and isinstance(getattr(value, "value", None), str):
        return value.value
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def diff(before: dict[str, Any], after: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Field diff `{field: {from, to}}` between two snapshots."""
    out: dict[str, dict[str, Any]] = {}
    for k in sorted(set(before) | set(after)):
        if before.get(k) != after.get(k):
            out[k] = {"from": before.get(k), "to": after.get(k)}
    return out


async def record(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    entity_type: str,
    entity_id: uuid.UUID,
    lineage_id: uuid.UUID,
    version: int,
    snapshot: dict[str, Any],
    changes: dict[str, Any],
    source: str = "user",
    changed_by: uuid.UUID | None = None,
    change_reason: str | None = None,
    proposal_id: uuid.UUID | None = None,
) -> EntityRevision:
    """Writes the state of `entity` at `version`. A second write for the same (type, lineage, version) replaces
    nothing: the version is bumped past the latest recorded one so history stays append-only."""
    latest = (
        await session.execute(
            select(func.max(EntityRevision.version)).where(
                EntityRevision.entity_type == entity_type, EntityRevision.lineage_id == lineage_id
            )
        )
    ).scalar_one_or_none()
    if latest is not None and version <= int(latest):
        version = int(latest) + 1
    rev = EntityRevision(
        organisation_id=org_id,
        project_id=project_id,
        entity_type=entity_type,
        entity_id=entity_id,
        lineage_id=lineage_id,
        version=version,
        snapshot=redact_deep(jsonable(snapshot)),
        changes=redact_deep(jsonable(changes)),
        source=source,
        changed_by=changed_by,
        change_reason=change_reason,
        proposal_id=proposal_id,
    )
    session.add(rev)
    return rev


async def history(session: AsyncSession, entity_type: str, lineage_id: uuid.UUID) -> list[EntityRevision]:
    return list(
        (
            await session.execute(
                select(EntityRevision)
                .where(EntityRevision.entity_type == entity_type, EntityRevision.lineage_id == lineage_id)
                .order_by(EntityRevision.version.desc())
            )
        )
        .scalars()
        .all()
    )
