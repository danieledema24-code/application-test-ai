"""Local filesystem storage. Rejects keys that would escape the storage root (path traversal)."""

from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path


class InvalidStorageKey(ValueError):
    pass


class LocalStorage:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def resolve(self, key: str) -> Path:
        if not key or key.startswith(("/", "\\")) or "\x00" in key or ".." in Path(key).parts:
            raise InvalidStorageKey("Invalid storage key")
        full = (self.root / key).resolve()
        if not str(full).startswith(str(self.root) + os.sep):
            raise InvalidStorageKey("Invalid storage key")
        return full

    async def put(self, key: str, data: bytes) -> None:
        path = self.resolve(key)

        def _write() -> None:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(path.suffix + ".tmp")
            tmp.write_bytes(data)
            tmp.replace(path)

        await asyncio.to_thread(_write)

    async def get(self, key: str) -> bytes:
        path = self.resolve(key)
        return await asyncio.to_thread(path.read_bytes)

    async def exists(self, key: str) -> bool:
        path = self.resolve(key)
        return await asyncio.to_thread(path.is_file)

    async def delete(self, key: str) -> None:
        path = self.resolve(key)
        await asyncio.to_thread(lambda: path.unlink(missing_ok=True))

    async def delete_prefix(self, prefix: str) -> None:
        """Removes every object under `prefix` (a directory here). Used by the project purge (P5-05c)."""
        path = self.resolve(prefix.rstrip("/"))
        await asyncio.to_thread(lambda: shutil.rmtree(path, ignore_errors=True))
