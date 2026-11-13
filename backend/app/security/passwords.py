"""argon2id password hashing."""

from __future__ import annotations

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

_hasher = PasswordHasher()  # argon2id with library defaults (RFC 9106 low-memory profile)
# Verified against when the user does not exist, so timing does not reveal whether an email is registered.
_DUMMY_HASH = _hasher.hash("dummy-password-for-timing")


def hash_password(password: str) -> str:
    return str(_hasher.hash(password))


def verify_password(password_hash: str | None, password: str) -> bool:
    try:
        return bool(_hasher.verify(password_hash or _DUMMY_HASH, password)) and password_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False
