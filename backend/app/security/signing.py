"""Short-lived HMAC-signed URLs for evidence/report files, bound to the owning organisation.

signature = HMAC-SHA256(secret, f"{resource_id}|{exp}|{org_id}"), hex.
"""

from __future__ import annotations

import hashlib
import hmac
import time
import uuid


class UrlSigner:
    def __init__(self, secret: bytes, ttl_s: int) -> None:
        self._secret = hashlib.sha256(b"signed-urls:" + secret).digest()
        self._ttl = ttl_s

    def _sig(self, resource_id: uuid.UUID, exp: int, org_id: uuid.UUID) -> str:
        msg = f"{resource_id}|{exp}|{org_id}".encode()
        return hmac.new(self._secret, msg, hashlib.sha256).hexdigest()

    def sign(self, resource_id: uuid.UUID, org_id: uuid.UUID, *, now: float | None = None) -> tuple[int, str]:
        exp = int((now if now is not None else time.time()) + self._ttl)
        return exp, self._sig(resource_id, exp, org_id)

    def verify(
        self, resource_id: uuid.UUID, org_id: uuid.UUID, exp: int, sig: str, *, now: float | None = None
    ) -> bool:
        if exp < int(now if now is not None else time.time()):
            return False
        return hmac.compare_digest(self._sig(resource_id, exp, org_id), sig)
