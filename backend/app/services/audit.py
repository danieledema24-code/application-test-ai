"""Append-only audit log (threat T9). Insert/list only; metadata is redacted."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AuditLog
from app.domain.enums import ActorType
from app.logging import request_id_var
from app.security.redact import redact_deep


def audit(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    action: str,
    target_type: str,
    target_id: uuid.UUID | str | None = None,
    actor_user_id: uuid.UUID | None = None,
    actor_type: ActorType = ActorType.user,
    project_id: uuid.UUID | None = None,
    ip: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> AuditLog:
    row = AuditLog(
        organisation_id=org_id,
        actor_type=actor_type if actor_user_id or actor_type != ActorType.user else ActorType.system,
        actor_user_id=actor_user_id,
        action=action,
        target_type=target_type,
        target_id=str(target_id) if target_id is not None else None,
        project_id=project_id,
        ip=ip,
        request_id=request_id_var.get(),
        meta=redact_deep(metadata or {}),
    )
    session.add(row)
    return row
