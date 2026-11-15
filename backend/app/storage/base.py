"""Object storage interface. Local FS now, S3-compatible later."""

from __future__ import annotations

import re
import uuid
from typing import Protocol

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


class ObjectStorage(Protocol):
    async def put(self, key: str, data: bytes) -> None: ...
    async def get(self, key: str) -> bytes: ...
    async def exists(self, key: str) -> bool: ...
    async def delete(self, key: str) -> None: ...
    async def delete_prefix(self, prefix: str) -> None: ...


def object_key(org_id: uuid.UUID, project_id: uuid.UUID, kind: str, owner_id: uuid.UUID | str, name: str) -> str:
    """`{org_id}/{project_id}/{kind}/{owner_id}/{name}` with every segment sanitised."""
    safe = _SAFE_NAME.sub("_", name).strip("._") or "file"
    kind_safe = _SAFE_NAME.sub("_", kind)
    return f"{org_id}/{project_id}/{kind_safe}/{owner_id}/{safe[:150]}"
