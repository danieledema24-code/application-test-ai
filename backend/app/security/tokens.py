"""Opaque random tokens; only their SHA-256 is stored."""

from __future__ import annotations

import secrets

from app.security.crypto import sha256_hex


def new_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def token_hash(token: str) -> str:
    return sha256_hex(token)
