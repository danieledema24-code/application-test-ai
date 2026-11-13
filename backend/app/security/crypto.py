"""AES-256-GCM envelope for stored secrets (ported from `api/src/lib/crypto.ts`, plus a key-id prefix for rotation).

Format: `<key_id>:base64(iv | tag | ciphertext)`.
"""

from __future__ import annotations

import base64
import hashlib
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class Encryptor:
    def __init__(self, keys: dict[str, bytes], active_key_id: str) -> None:
        for kid, key in keys.items():
            if len(key) != 32:
                raise ValueError(f"Encryption key {kid} must be 32 bytes")
            if ":" in kid:
                raise ValueError("Key ids may not contain ':'")
        if active_key_id not in keys:
            raise ValueError("Active encryption key id is not configured")
        self._keys = keys
        self._active = active_key_id

    def encrypt(self, plain: str) -> str:
        iv = os.urandom(12)
        sealed = AESGCM(self._keys[self._active]).encrypt(iv, plain.encode("utf-8"), self._active.encode())
        ct, tag = sealed[:-16], sealed[-16:]
        return f"{self._active}:" + base64.b64encode(iv + tag + ct).decode("ascii")

    def decrypt(self, payload: str) -> str:
        kid, _, body = payload.partition(":")
        if kid not in self._keys or not body:
            raise ValueError("Unknown encryption key id")
        raw = base64.b64decode(body)
        iv, tag, ct = raw[:12], raw[12:28], raw[28:]
        return AESGCM(self._keys[kid]).decrypt(iv, ct + tag, kid.encode()).decode("utf-8")


def sha256_hex(value: str | bytes) -> str:
    data = value.encode("utf-8") if isinstance(value, str) else value
    return hashlib.sha256(data).hexdigest()
