"""Project test credentials (P2-01). Values are write-only: encrypted at rest, decrypted only by a task that
needs them (audited as `secret.used`), registered with the redactor, and never returned, logged or stored."""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.context import AppContext
from app.db.models import ProjectSecret, ProjectUrl
from app.db.tenant import BYPASS
from app.domain.enums import ActorType, SecretKind, UrlRole
from app.security.redact import register_secret
from app.services.audit import audit

log = logging.getLogger(__name__)
CREDENTIALS_SECRET = "scan_credentials"  # noqa: S105 - secret name, not a value


def username_hint(username: str) -> str:
    """Masked hint: first two characters, an ellipsis and the email domain (if any)."""
    u = username.strip()
    if "@" in u:
        local, domain = u.split("@", 1)
        return f"{local[:2]}…@{domain}"
    return f"{u[:2]}…" if len(u) > 2 else "…"


def metadata_for(creds: dict[str, str]) -> dict[str, Any]:
    return {"login_url": creds.get("login_url"), "username_hint": username_hint(creds.get("username", ""))}


async def credentials_secret(s: AsyncSession, project_id: uuid.UUID) -> ProjectSecret | None:
    return (
        await s.execute(
            select(ProjectSecret).where(
                ProjectSecret.project_id == project_id, ProjectSecret.name == CREDENTIALS_SECRET
            )
        )
    ).scalar_one_or_none()


async def use_credentials(
    ctx: AppContext,
    s: AsyncSession,
    secret: ProjectSecret,
    *,
    purpose: str,
    task_id: uuid.UUID | None,
) -> dict[str, str]:
    """Decrypts for a task: audited, and both values are registered with the redactor before they are returned."""
    creds: dict[str, str] = json.loads(ctx.encryptor.decrypt(secret.ciphertext))
    register_secret(creds.get("password"))
    register_secret(creds.get("username"))
    audit(
        s,
        org_id=secret.organisation_id,
        action="secret.used",
        target_type="secret",
        target_id=secret.id,
        actor_type=ActorType.system,
        project_id=secret.project_id,
        metadata={"purpose": purpose, "task_id": str(task_id) if task_id else None, "name": secret.name},
    )
    return creds


async def backfill(ctx: AppContext) -> int:
    """Startup data step (database-schema.md): Phase 1 `scan_credentials` rows get kind + non-secret metadata.

    Runs across organisations (system task, tenant filter bypassed), only touches rows without metadata, so it is
    idempotent. The decrypted values never leave this function.
    """
    n = 0
    async with ctx.session_factory() as s:
        rows = (
            await s.execute(select(ProjectSecret).where(ProjectSecret.meta.is_(None)).execution_options(**BYPASS))
        ).scalars()
        for row in rows:
            try:
                creds = json.loads(ctx.encryptor.decrypt(row.ciphertext))
            except Exception:  # noqa: BLE001 - undecryptable (key rotated away): leave it for an admin to replace
                log.warning("secret %s could not be decrypted during backfill", row.id)
                continue
            row.kind = SecretKind.login_credentials
            row.meta = metadata_for(creds)
            n += 1
        if n:
            await s.commit()
    return n


async def link_primary_url(s: AsyncSession, project_id: uuid.UUID, secret_id: uuid.UUID | None) -> None:
    url = (
        await s.execute(
            select(ProjectUrl).where(ProjectUrl.project_id == project_id, ProjectUrl.role == UrlRole.primary)
        )
    ).scalar_one_or_none()
    if url is not None:
        url.credentials_secret_id = secret_id
