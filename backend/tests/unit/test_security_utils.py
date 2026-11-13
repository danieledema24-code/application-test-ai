"""T7/T8/T17: redaction, credential encryption, signed URLs, rate limiter, passwords, log redaction, storage keys."""

from __future__ import annotations

import io
import logging
import uuid

import pytest

from app.logging import ContextRedactFilter, JsonFormatter
from app.security.crypto import Encryptor
from app.security.passwords import hash_password, verify_password
from app.security.ratelimit import RateLimiter
from app.security.redact import redact_deep, redact_headers, redact_text, redact_url_tokens, register_secret
from app.security.signing import UrlSigner
from app.storage.local import InvalidStorageKey, LocalStorage


def test_redaction_text_headers_nested() -> None:
    assert redact_text("token=supersecret123 ok", ["supersecret123"]) == "token=[REDACTED] ok"
    assert "Bearer [REDACTED]" in redact_text("Authorization: Bearer abcdefghijklmnop")
    assert "[REDACTED]" in redact_text("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz")
    assert redact_headers({"Authorization": "Bearer x", "accept": "json"}) == {
        "Authorization": "[REDACTED]",
        "accept": "json",
    }
    assert redact_deep({"user": {"password": "p4ss", "name": "a"}}) == {"user": {"password": "[REDACTED]", "name": "a"}}
    assert redact_url_tokens("/reset?token=abc&x=1") == "/reset?token=[REDACTED]&x=1"


def test_registered_secrets_are_redacted_without_pattern() -> None:
    register_secret("hunter2-registered-value")
    assert "hunter2" not in redact_text("leaked hunter2-registered-value here")


def test_log_records_are_redacted() -> None:
    register_secret("platform-secret-xyz")
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.addFilter(ContextRedactFilter())
    handler.setFormatter(JsonFormatter())
    logger = logging.getLogger("test.redaction")
    logger.addHandler(handler)
    logger.propagate = False
    try:
        logger.warning("calling with %s and Bearer abcdefghijklmnopqrst", "platform-secret-xyz")
        try:
            raise RuntimeError("boom platform-secret-xyz")
        except RuntimeError:
            logger.exception("failed")
    finally:
        logger.removeHandler(handler)
    out = stream.getvalue()
    assert "platform-secret-xyz" not in out
    assert "abcdefghijklmnopqrst" not in out
    assert "[REDACTED]" in out


def test_encryption_round_trip_non_deterministic_and_key_bound() -> None:
    enc = Encryptor({"k1": b"\x07" * 32}, "k1")
    a, b = enc.encrypt("secret"), enc.encrypt("secret")
    assert a != b and a.startswith("k1:") and "secret" not in a
    assert enc.decrypt(a) == "secret"
    other = Encryptor({"k1": b"\x08" * 32}, "k1")
    with pytest.raises(Exception):  # noqa: B017 - any authentication failure
        other.decrypt(a)
    tampered = a[:-4] + ("AAAA" if not a.endswith("AAAA") else "BBBB")
    with pytest.raises(Exception):  # noqa: B017
        enc.decrypt(tampered)


def test_signed_urls_expiry_tamper_and_cross_org() -> None:
    signer = UrlSigner(b"k" * 32, ttl_s=900)
    rid, org, other_org = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    exp, sig = signer.sign(rid, org, now=1000)
    assert signer.verify(rid, org, exp, sig, now=1500)
    assert not signer.verify(rid, org, exp, sig, now=exp + 1)  # expired
    assert not signer.verify(rid, other_org, exp, sig, now=1500)  # cross-org
    assert not signer.verify(uuid.uuid4(), org, exp, sig, now=1500)  # other resource
    assert not signer.verify(rid, org, exp + 100, sig, now=1500)  # extended expiry
    assert not signer.verify(rid, org, exp, sig[:-1] + ("0" if sig[-1] != "0" else "1"), now=1500)


def test_rate_limiter_window() -> None:
    rl = RateLimiter()
    for i in range(3):
        assert rl.hit("k", 3, 60, now=100 + i) is None
    retry = rl.hit("k", 3, 60, now=103)
    assert retry is not None and 0 < retry <= 60
    assert rl.hit("k", 3, 60, now=161) is None  # window slid
    rl.reset("k")
    assert rl.check("k", 3, 60, now=161) is None


def test_password_hashing() -> None:
    h = hash_password("correct-horse-battery")
    assert h.startswith("$argon2id$")
    assert verify_password(h, "correct-horse-battery")
    assert not verify_password(h, "wrong-password-123")
    assert not verify_password(None, "anything-at-all")


@pytest.mark.parametrize("key", ["../etc/passwd", "/abs/path", "a/../../b", "", "a\x00b"])
def test_storage_rejects_traversal(tmp_path, key: str) -> None:  # type: ignore[no-untyped-def]
    store = LocalStorage(tmp_path)
    with pytest.raises(InvalidStorageKey):
        store.resolve(key)


async def test_storage_round_trip(tmp_path) -> None:  # type: ignore[no-untyped-def]
    store = LocalStorage(tmp_path)
    await store.put("org/proj/ev.png", b"data")
    assert await store.exists("org/proj/ev.png")
    assert await store.get("org/proj/ev.png") == b"data"
    await store.delete("org/proj/ev.png")
    assert not await store.exists("org/proj/ev.png")
