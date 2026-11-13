"""In-memory sliding-window rate limiter (per process). Redis-backed later (api-contracts.md)."""

from __future__ import annotations

import math
import threading
import time
from collections import defaultdict, deque


class RateLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def _prune(self, key: str, window_s: float, now: float) -> deque[float]:
        q = self._hits[key]
        while q and q[0] <= now - window_s:
            q.popleft()
        return q

    def check(self, key: str, limit: int, window_s: float, *, now: float | None = None) -> float | None:
        """Returns None if under the limit, else seconds until the next slot frees up. Does not record a hit."""
        t = now if now is not None else time.monotonic()
        with self._lock:
            q = self._prune(key, window_s, t)
            if len(q) >= limit:
                return max(1.0, math.ceil(q[0] + window_s - t))
            return None

    def hit(self, key: str, limit: int, window_s: float, *, now: float | None = None) -> float | None:
        """Records a hit if allowed. Returns None when allowed, else retry-after seconds."""
        t = now if now is not None else time.monotonic()
        with self._lock:
            q = self._prune(key, window_s, t)
            if len(q) >= limit:
                return max(1.0, math.ceil(q[0] + window_s - t))
            q.append(t)
            return None

    def record(self, key: str, *, now: float | None = None) -> None:
        with self._lock:
            self._hits[key].append(now if now is not None else time.monotonic())

    def reset(self, key: str) -> None:
        with self._lock:
            self._hits.pop(key, None)
