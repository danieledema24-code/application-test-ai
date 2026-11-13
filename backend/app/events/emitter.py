"""Writes user-visible agent events. `agent_events` rows are the event bus; SSE tails them by id."""

from __future__ import annotations

import logging
import uuid
from typing import Any

from app.db.models import AgentEvent
from app.db.session import SessionFactory
from app.db.tenant import bind_scope, system_scope
from app.domain.enums import EventLevel
from app.security.redact import redact_deep, redact_text

log = logging.getLogger(__name__)


class EventEmitter:
    def __init__(self, session_factory: SessionFactory) -> None:
        self._sf = session_factory

    async def emit(
        self,
        *,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        type: str,
        message: str,
        level: EventLevel = EventLevel.info,
        stage_key: str | None = None,
        agent_key: str | None = None,
        task_id: uuid.UUID | None = None,
        data: dict[str, Any] | None = None,
    ) -> int:
        async with self._sf() as session:
            bind_scope(session, system_scope(org_id))
            ev = AgentEvent(
                organisation_id=org_id,
                project_id=project_id,
                agent_task_id=task_id,
                stage_key=stage_key,
                agent_key=agent_key,
                type=type,
                level=level,
                message=redact_text(message)[:2000],
                data=redact_deep(data or {}),
            )
            session.add(ev)
            await session.commit()
            return ev.id
