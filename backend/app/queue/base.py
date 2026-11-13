"""Job queue interface. `SqlJobQueue` now; Celery/arq + Redis later behind the same protocol."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Protocol

from app.db.models import Job


class JobQueue(Protocol):
    async def enqueue(
        self,
        kind: str,
        payload: dict[str, Any],
        *,
        org_id: uuid.UUID,
        project_id: uuid.UUID | None = None,
        dedupe_key: str | None = None,
        concurrency_group: str | None = None,
        run_after: datetime | None = None,
        max_attempts: int = 3,
    ) -> uuid.UUID: ...

    async def claim(self, worker_id: str, group_limits: dict[str, int]) -> Job | None: ...
    async def heartbeat(self, job_id: uuid.UUID, worker_id: str) -> bool: ...
    async def complete(self, job_id: uuid.UUID) -> None: ...
    async def fail(self, job_id: uuid.UUID, error: str, *, retry: bool = False) -> None: ...
    async def cancel(self, job_id: uuid.UUID) -> None: ...
    async def depth(self) -> int: ...
