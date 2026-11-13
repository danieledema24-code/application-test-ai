"""Identity and tenancy: organisations, users, memberships, sessions, reset tokens, audit log."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedMixin, IdMixin, TenantMixin, TimestampMixin
from app.db.types import json_default_dict, str_enum
from app.domain.enums import ActorType, Role


class Organisation(IdMixin, TimestampMixin, Base):
    __tablename__ = "organisations"

    name: Mapped[str] = mapped_column(String(120))
    slug: Mapped[str] = mapped_column(String(140), unique=True)
    plan: Mapped[str] = mapped_column(String(32), default="free")
    limits: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)


class User(IdMixin, TimestampMixin, Base):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(320), unique=True)
    full_name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(default=True)
    last_login_at: Mapped[datetime | None] = mapped_column(default=None)


class Membership(IdMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("organisation_id", "user_id"),)

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True)
    role: Mapped[Role] = mapped_column(str_enum(Role, "membership_role"))
    can_approve: Mapped[bool] = mapped_column(default=False)
    # P3-07: null for Phase 1/2 rows (owners who registered, or members inserted before invitations existed).
    invited_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    joined_at: Mapped[datetime | None] = mapped_column(default=None)


class UserSession(IdMixin, TimestampMixin, Base):
    __tablename__ = "sessions"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    organisation_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organisations.id", ondelete="CASCADE"))
    expires_at: Mapped[datetime]
    revoked_at: Mapped[datetime | None] = mapped_column(default=None)
    last_refreshed_at: Mapped[datetime | None] = mapped_column(default=None)
    ip: Mapped[str | None] = mapped_column(String(64), default=None)
    user_agent: Mapped[str | None] = mapped_column(String(400), default=None)


class PasswordResetToken(IdMixin, CreatedMixin, Base):
    __tablename__ = "password_reset_tokens"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime]
    used_at: Mapped[datetime | None] = mapped_column(default=None)


class AuditLog(IdMixin, TenantMixin, CreatedMixin, Base):
    """Append-only. The service exposes insert/list only."""

    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_logs_org_created", "organisation_id", "created_at"),
        Index("ix_audit_logs_org_target", "organisation_id", "target_type", "target_id"),
    )

    actor_type: Mapped[ActorType] = mapped_column(str_enum(ActorType, "audit_actor_type"))
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    action: Mapped[str] = mapped_column(String(64))
    target_type: Mapped[str] = mapped_column(String(64))
    target_id: Mapped[str | None] = mapped_column(String(64), default=None)
    # No FK: audit rows outlive any purge of the project they mention.
    project_id: Mapped[uuid.UUID | None] = mapped_column(default=None, index=True)
    ip: Mapped[str | None] = mapped_column(String(64), default=None)
    request_id: Mapped[str | None] = mapped_column(String(64), default=None)
    meta: Mapped[dict[str, Any]] = mapped_column("metadata", default=json_default_dict)


class Invitation(IdMixin, TenantMixin, TimestampMixin, Base):
    """A one-time workspace invitation link (P3-07, decision D5). Only the token's SHA-256 is stored."""

    __tablename__ = "invitations"
    __table_args__ = (
        Index("ix_invitations_org_email", "organisation_id", "email"),
        Index("ix_invitations_org_expires", "organisation_id", "expires_at"),
    )

    email: Mapped[str] = mapped_column(String(320))
    role: Mapped[str] = mapped_column(String(16))
    can_approve: Mapped[bool] = mapped_column(default=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    invited_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    expires_at: Mapped[datetime]
    accepted_at: Mapped[datetime | None] = mapped_column(default=None)
    accepted_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), default=None
    )
    revoked_at: Mapped[datetime | None] = mapped_column(default=None)
    revoked_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
