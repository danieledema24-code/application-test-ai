"""Removes secrets from anything that may be logged, stored as evidence text or sent to an AI provider.

Ported from `api/src/lib/redact.ts` (same patterns), plus a process-wide registry of known secret values.
"""

from __future__ import annotations

import re
import threading
from collections.abc import Iterable
from typing import Any

REDACTED = "[REDACTED]"

SENSITIVE_HEADER = re.compile(
    r"^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$", re.IGNORECASE
)
SENSITIVE_KEY = re.compile(
    r"pass(word)?|secret|token|api[-_]?key|authorization|credential|private[-_]?key", re.IGNORECASE
)
_BEARER = re.compile(r"(bearer\s+)[a-z0-9._~+/=-]{8,}", re.IGNORECASE)
_JWT = re.compile(r"eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{5,}")
_ANTHROPIC_KEY = re.compile(r"sk-ant-[a-zA-Z0-9_-]{10,}")
_URL_TOKENS = re.compile(r"([?&](?:token|access_token|api[-_]?key|key|sig|signature)=)[^&#\s]*", re.IGNORECASE)

_known_secrets: set[str] = set()
_lock = threading.Lock()


def register_secret(value: str | None) -> None:
    """Registers a secret value (e.g. the API key) so it is redacted everywhere, even without a pattern match."""
    if value and len(value) >= 4:
        with _lock:
            _known_secrets.add(value)


def redact_text(text: str, secrets: Iterable[str] = ()) -> str:
    out = text
    for s in [*secrets, *_known_secrets]:
        if s and len(s) >= 4 and s in out:
            out = out.replace(s, REDACTED)
    out = _BEARER.sub(lambda m: m.group(1) + REDACTED, out)
    out = _JWT.sub(REDACTED, out)
    out = _ANTHROPIC_KEY.sub(REDACTED, out)
    return out


def redact_url_tokens(url: str) -> str:
    """Masks token-like query parameters (?token=, &access_token=, ?sig=…) in a URL or path."""
    return _URL_TOKENS.sub(lambda m: m.group(1) + REDACTED, url)


def redact_headers(headers: dict[str, str], secrets: Iterable[str] = ()) -> dict[str, str]:
    secret_list = list(secrets)
    return {
        k: (REDACTED if SENSITIVE_HEADER.match(k) else redact_text(str(v), secret_list)) for k, v in headers.items()
    }


def redact_deep(value: Any, secrets: Iterable[str] = ()) -> Any:
    secret_list = list(secrets)
    if isinstance(value, str):
        return redact_text(value, secret_list)
    if isinstance(value, list | tuple):
        return [redact_deep(v, secret_list) for v in value]
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            if isinstance(k, str) and SENSITIVE_KEY.search(k) and isinstance(v, str):
                out[k] = REDACTED
            else:
                out[k] = redact_deep(v, secret_list)
        return out
    return value
