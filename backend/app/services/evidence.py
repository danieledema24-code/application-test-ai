"""Evidence writer: stores the blob, hashes it and records an immutable `evidence` row."""

from __future__ import annotations

import hashlib
import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Evidence
from app.db.types import utcnow
from app.domain.enums import EvidenceKind
from app.services.counters import next_key
from app.storage.base import ObjectStorage, object_key


async def write_evidence(
    session: AsyncSession,
    storage: ObjectStorage,
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    kind: EvidenceKind,
    data: bytes,
    mime: str,
    name: str,
    owner_id: uuid.UUID,
    scan_session_id: uuid.UUID | None = None,
    page_id: uuid.UUID | None = None,
    source_url: str | None = None,
    viewport: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> Evidence:
    ev_id = uuid.uuid4()
    _, key = await next_key(session, org_id, project_id, "evidence")
    storage_key = object_key(org_id, project_id, kind.value, owner_id, f"{key}-{name}")
    await storage.put(storage_key, data)
    ev = Evidence(
        id=ev_id,
        organisation_id=org_id,
        project_id=project_id,
        key=key,
        kind=kind,
        storage_key=storage_key,
        mime=mime,
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        source_url=source_url,
        viewport=viewport,
        scan_session_id=scan_session_id,
        page_id=page_id,
        captured_at=utcnow(),
        meta={"filename": name, **(metadata or {})},
    )
    session.add(ev)
    return ev
