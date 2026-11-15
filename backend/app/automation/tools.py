"""External tool detection for `GET /health.tools` (P5-00): read only, never installs anything.

`k6` and `docker` are found with `shutil.which` and asked for `--version` (5 s timeout, scrubbed environment); the
answer is cached for 5 minutes. A missing tool is `None`, shown as "Not available on this server"; nothing falls
back to a different engine silently.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import re
import shutil
import time

VERSION_TTL_S = 300.0
_VERSION_RE = re.compile(r"v?(\d+\.\d+(?:\.\d+)?)")
_cache: dict[str, tuple[float, str | None]] = {}


async def tool_version(name: str, *, timeout_s: float = 5.0) -> str | None:
    """`k6` -> "1.2.3" (or None when it isn't on PATH or doesn't answer)."""
    now = time.monotonic()
    hit = _cache.get(name)
    if hit is not None and now - hit[0] < VERSION_TTL_S:
        return hit[1]
    value: str | None = None
    path = shutil.which(name)
    if path is not None:
        with contextlib.suppress(OSError, TimeoutError):
            proc = await asyncio.create_subprocess_exec(
                path,
                "--version",
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/")},
            )
            try:
                out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()
                raise
            match = _VERSION_RE.search(out.decode("utf-8", "replace"))
            value = match.group(1) if proc.returncode == 0 and match else None
    _cache[name] = (now, value)
    return value
