"""Secret scan for generated scripts and page objects (P4-04 check 4).

Rejects the project's saved username and password, bearer tokens, JWTs and API-key patterns, and any literal typed
into a password field. Messages name the line and what was found, never the value itself.
"""

from __future__ import annotations

import re
from typing import Any

_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*"), "a bearer token"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), "a JSON web token"),
    (re.compile(r"\b(sk|pk|rk)[-_](live|test|ant)[-_A-Za-z0-9]{12,}"), "an API key"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "a cloud access key"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"), "an access token"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "a private key"),
]
# `<password field getter>.fill("literal")` or `.fill('literal')`: a literal typed into a password field.
_PASSWORD_FILL = re.compile(
    r"\b(password\w*|\w*Password)\s*\.\s*(fill|type|pressSequentially)\(\s*([\"'`])(?!\3)", re.I
)


def scan(code: str, *, username: str | None = None, password: str | None = None) -> dict[str, Any]:
    """`{ok, messages: [{line, message}]}`; values never appear in the result."""
    messages: list[dict[str, Any]] = []
    secrets = [(v, what) for v, what in ((password, "the saved test password"), (username, "the saved test username"))
               if v and len(v) >= 3]  # fmt: skip
    for n, line in enumerate(code.splitlines(), start=1):
        for value, what in secrets:
            if value in line:
                messages.append({"line": n, "message": f"Line {n}: {what} appears in the script"})
        for pattern, what in _PATTERNS:
            if pattern.search(line):
                messages.append({"line": n, "message": f"Line {n}: {what} appears in the script"})
        if _PASSWORD_FILL.search(line):
            messages.append({"line": n, "message": f"Line {n}: a password field is filled with a literal value"})
    return {"ok": not messages, "messages": messages}
