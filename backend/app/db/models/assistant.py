"""Phase 2 AI QA Analyst assistant (P2-10) and source documents (P2-08)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedMixin, IdMixin, TenantMixin, TimestampMixin
from app.db.types import json_default_dict, json_default_list, str_enum, utcnow
from app.domain.enums import DocumentStatus, GeneratedBy, MessageRole, ProposalStatus


class AssistantThread(IdMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "assistant_threads"
    __table_args__ = (
        Index(
            "ix_assistant_threads_org_project_user_last", "organisation_id", "project_id", "user_id", "last_message_at"
        ),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    title: Mapped[str] = mapped_column(String(120))
    archived_at: Mapped[datetime | None] = mapped_column(default=None)
    last_message_at: Mapped[datetime] = mapped_column(default=utcnow)


class AssistantMessage(IdMixin, TenantMixin, CreatedMixin, Base):
    """Append-only."""

    __tablename__ = "assistant_messages"
    __table_args__ = (Index("ix_assistant_messages_thread_created", "thread_id", "created_at"),)

    thread_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("assistant_threads.id", ondelete="CASCADE"))
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))
    role: Mapped[MessageRole] = mapped_column(str_enum(MessageRole, "assistant_message_role"))
    content: Mapped[str] = mapped_column(Text)
    intent: Mapped[str | None] = mapped_column(String(48), default=None)
    params: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    context_ref: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    answered_by: Mapped[str | None] = mapped_column(String(16), default=None)
    generated_by: Mapped[str | None] = mapped_column(String(16), default=None)
    citations: Mapped[list[Any]] = mapped_column(default=json_default_list)
    notices: Mapped[list[Any]] = mapped_column(default=json_default_list)
    llm: Mapped[dict[str, Any] | None] = mapped_column(default=None)


class AssistantProposal(IdMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "assistant_proposals"
    __table_args__ = (
        UniqueConstraint("project_id", "key"),
        Index("ix_assistant_proposals_org_project_status", "organisation_id", "project_id", "status"),
        Index("ix_assistant_proposals_target", "target_type", "target_id"),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))
    thread_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("assistant_threads.id", ondelete="CASCADE"))
    message_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("assistant_messages.id", ondelete="CASCADE"))
    key: Mapped[str] = mapped_column(String(32))
    kind: Mapped[str] = mapped_column(String(32))
    target_type: Mapped[str | None] = mapped_column(String(32), default=None)
    target_id: Mapped[uuid.UUID | None] = mapped_column(default=None)
    target_lineage_id: Mapped[uuid.UUID | None] = mapped_column(default=None)
    summary: Mapped[str] = mapped_column(Text)
    payload: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    preview: Mapped[list[Any] | None] = mapped_column(default=None)
    base_versions: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    status: Mapped[ProposalStatus] = mapped_column(
        str_enum(ProposalStatus, "proposal_status"), default=ProposalStatus.pending
    )
    generated_by: Mapped[GeneratedBy] = mapped_column(str_enum(GeneratedBy, "proposal_generated_by"))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    decided_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    decided_at: Mapped[datetime | None] = mapped_column(default=None)
    decision_comment: Mapped[str | None] = mapped_column(Text, default=None)
    result: Mapped[dict[str, Any] | None] = mapped_column(default=None)


class SourceDocument(IdMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "source_documents"
    __table_args__ = (
        UniqueConstraint("project_id", "key"),
        Index("ix_source_documents_org_project_status", "organisation_id", "project_id", "status"),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))
    key: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(String(160))
    filename: Mapped[str] = mapped_column(String(255))
    mime: Mapped[str] = mapped_column(String(100))
    size: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64))
    status: Mapped[DocumentStatus] = mapped_column(
        str_enum(DocumentStatus, "document_status"), default=DocumentStatus.extracting
    )
    pages: Mapped[int | None] = mapped_column(Integer, default=None)
    chars: Mapped[int | None] = mapped_column(Integer, default=None)
    outline: Mapped[list[Any]] = mapped_column(default=json_default_list)
    statements: Mapped[list[Any]] = mapped_column(default=json_default_list)
    injection_flags: Mapped[list[Any]] = mapped_column(default=json_default_list)
    file_evidence_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("evidence.id", ondelete="RESTRICT"))
    text_evidence_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("evidence.id", ondelete="RESTRICT"), default=None
    )
    error: Mapped[str | None] = mapped_column(Text, default=None)
    uploaded_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    withdrawn_at: Mapped[datetime | None] = mapped_column(default=None)
    withdrawn_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    withdraw_reason: Mapped[str | None] = mapped_column(Text, default=None)
