"""Opaque offset cursors (`?limit=&cursor=`). Max limit 100."""

from __future__ import annotations

import base64

from app.api.errors import BadRequest


def decode_cursor(cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        raw = base64.urlsafe_b64decode(cursor.encode() + b"==").decode()
        if not raw.startswith("o:"):
            raise ValueError
        return max(0, int(raw[2:]))
    except (ValueError, UnicodeDecodeError) as exc:
        raise BadRequest("Invalid cursor") from exc


def encode_cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(f"o:{offset}".encode()).decode().rstrip("=")


def clamp_limit(limit: int | None, default: int = 20) -> int:
    return max(1, min(100, limit or default))
