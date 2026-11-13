"""Discovery: scan sessions, pages, features, journeys, evidence, knowledge items, reports."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, Column, Float, ForeignKey, Index, Integer, String, Table, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, CreatedMixin, IdMixin, TenantMixin, TimestampMixin
from app.db.types import json_default_dict, json_default_list, str_enum
from app.domain.enums import (
    EvidenceKind,
    FeatureCategory,
    GeneratedBy,
    KnowledgeKind,
    KnowledgeStatus,
    PageStatus,
    PageType,
    Provenance,
    ReportStatus,
    ReportType,
    ScanStatus,
)


class ScanSession(IdMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "scan_sessions"
    __table_args__ = (
        UniqueConstraint("project_id", "key"),
        Index("ix_scan_sessions_project_created", "project_id", "created_at"),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))
    stage_run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stage_runs.id", ondelete="RESTRICT"), index=True)
    key: Mapped[str] = mapped_column(String(32))
    sequence: Mapped[int] = mapped_column(Integer)
    start_url: Mapped[str] = mapped_column(String(2048))
    status: Mapped[ScanStatus] = mapped_column(str_enum(ScanStatus, "scan_status"), default=ScanStatus.queued)
    limits: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    frontier: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    stats: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    completeness: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    limitations: Mapped[list[Any]] = mapped_column(default=json_default_list)
    blocked_requests: Mapped[list[Any]] = mapped_column(default=json_default_list)
    robots: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    auth_boundaries: Mapped[list[Any]] = mapped_column(default=json_default_list)
    access_gaps: Mapped[list[Any]] = mapped_column(default=json_default_list)
    external_links: Mapped[list[Any]] = mapped_column(default=json_default_list)
    skipped_links: Mapped[list[Any]] = mapped_column(default=json_default_list)
    injection_flags: Mapped[list[Any]] = mapped_column(default=json_default_list)
    current: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    # Cooperative control requested by the API ("pause" | "cancel"); the crawler checks it between pages.
    control: Mapped[str | None] = mapped_column(String(16), default=None)
    summary: Mapped[str | None] = mapped_column(Text, default=None)
    summary_generated_by: Mapped[GeneratedBy | None] = mapped_column(
        str_enum(GeneratedBy, "scan_summary_generated_by"), default=None
    )
    started_at: Mapped[datetime | None] = mapped_column(default=None)
    finished_at: Mapped[datetime | None] = mapped_column(default=None)
    error: Mapped[str | None] = mapped_column(Text, default=None)


class DiscoveredPage(IdMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "discovered_pages"
    __table_args__ = (
        UniqueConstraint("scan_session_id", "url_hash"),
        Index("ix_discovered_pages_project_url_hash", "project_id", "url_hash"),
    )

    scan_session_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scan_sessions.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))
    url: Mapped[str] = mapped_column(String(2048))
    url_hash: Mapped[str] = mapped_column(String(64))
    canonical_url: Mapped[str | None] = mapped_column(String(2048), default=None)
    final_url: Mapped[str | None] = mapped_column(String(2048), default=None)
    title: Mapped[str] = mapped_column(String(500), default="")
    http_status: Mapped[int | None] = mapped_column(Integer, default=None)
    status: Mapped[PageStatus] = mapped_column(str_enum(PageStatus, "page_status"), default=PageStatus.visited)
    failure_reason: Mapped[str | None] = mapped_column(Text, default=None)
    depth: Mapped[int] = mapped_column(Integer, default=0)
    sequence: Mapped[int] = mapped_column(Integer, default=0)
    parent_page_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("discovered_pages.id", ondelete="SET NULL"), default=None
    )
    found_via: Mapped[str | None] = mapped_column(String(32), default=None)
    # Visited pages: the URL that redirected here. Failed pages: see final_url (redirect target).
    redirected_from: Mapped[str | None] = mapped_column(String(2048), default=None)
    page_type: Mapped[PageType] = mapped_column(str_enum(PageType, "page_type"), default=PageType.other)
    requires_auth: Mapped[bool] = mapped_column(default=False)
    headings: Mapped[list[Any]] = mapped_column(default=json_default_list)
    nav_links: Mapped[list[Any]] = mapped_column(default=json_default_list)
    links: Mapped[list[Any]] = mapped_column(default=json_default_list)
    forms: Mapped[list[Any]] = mapped_column(default=json_default_list)
    components: Mapped[list[Any]] = mapped_column(default=json_default_list)
    counts: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    responsive: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    console_issues: Mapped[list[Any]] = mapped_column(default=json_default_list)
    network_issues: Mapped[list[Any]] = mapped_column(default=json_default_list)
    screenshot_evidence_id: Mapped[uuid.UUID | None] = mapped_column(default=None)
    load_ms: Mapped[int | None] = mapped_column(Integer, default=None)
    structure_hash: Mapped[str | None] = mapped_column(String(64), default=None)


feature_pages = Table(
    "feature_pages",
    Base.metadata,
    Column("feature_id", ForeignKey("application_features.id", ondelete="CASCADE"), primary_key=True),
    Column("page_id", ForeignKey("discovered_pages.id", ondelete="CASCADE"), primary_key=True),
)


class ApplicationFeature(IdMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "application_features"
    __table_args__ = (Index("ix_application_features_project_run", "project_id", "stage_run_id"),)

    scan_session_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scan_sessions.id", ondelete="CASCADE"), index=True)
    stage_run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stage_runs.id", ondelete="RESTRICT"))
    lineage_id: Mapped[uuid.UUID] = mapped_column(default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))
    key: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    category: Mapped[FeatureCategory] = mapped_column(str_enum(FeatureCategory, "feature_category"))
    provenance: Mapped[Provenance] = mapped_column(str_enum(Provenance, "feature_provenance"))
    confidence: Mapped[float] = mapped_column(Float)
    evidence_refs: Mapped[list[Any]] = mapped_column(default=json_default_list)
    generated_by: Mapped[GeneratedBy] = mapped_column(str_enum(GeneratedBy, "feature_generated_by"))
    page_ids: Mapped[list[Any]] = mapped_column(default=json_default_list)  # denormalised copy of feature_pages
    reason: Mapped[str | None] = mapped_column(Text, default=None)


class UserJourney(IdMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "user_journeys"
    __table_args__ = (Index("ix_user_journeys_project_run", "project_id", "stage_run_id"),)

    scan_session_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scan_sessions.id", ondelete="CASCADE"), index=True)
    stage_run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stage_runs.id", ondelete="RESTRICT"))
    lineage_id: Mapped[uuid.UUID] = mapped_column(default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))
    key: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(200))
    steps: Mapped[list[Any]] = mapped_column(default=json_default_list)
    provenance: Mapped[Provenance] = mapped_column(str_enum(Provenance, "journey_provenance"))
    confidence: Mapped[float] = mapped_column(Float)
    evidence_refs: Mapped[list[Any]] = mapped_column(default=json_default_list)
    generated_by: Mapped[GeneratedBy] = mapped_column(str_enum(GeneratedBy, "journey_generated_by"))
    reason: Mapped[str | None] = mapped_column(Text, default=None)


class Evidence(IdMixin, TenantMixin, CreatedMixin, Base):
    """Immutable captured artefact. Never deleted by workflow code."""

    __tablename__ = "evidence"
    __table_args__ = (Index("ix_evidence_project_kind", "project_id", "kind"),)

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))
    key: Mapped[str | None] = mapped_column(String(32), default=None)
    kind: Mapped[EvidenceKind] = mapped_column(str_enum(EvidenceKind, "evidence_kind"))
    storage_key: Mapped[str] = mapped_column(String(512))
    mime: Mapped[str] = mapped_column(String(100))
    size: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64))
    source_url: Mapped[str | None] = mapped_column(String(2048), default=None)
    viewport: Mapped[str | None] = mapped_column(String(32), default=None)
    scan_session_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("scan_sessions.id", ondelete="RESTRICT"), default=None, index=True
    )
    page_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("discovered_pages.id", ondelete="RESTRICT"), default=None, index=True
    )
    execution_result_id: Mapped[uuid.UUID | None] = mapped_column(default=None)
    performance_run_id: Mapped[uuid.UUID | None] = mapped_column(default=None)
    captured_at: Mapped[datetime]
    meta: Mapped[dict[str, Any]] = mapped_column("metadata", default=json_default_dict)


class KnowledgeItem(IdMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "knowledge_items"
    __table_args__ = (Index("ix_knowledge_items_project_kind_status", "project_id", "kind", "status"),)

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))
    kind: Mapped[KnowledgeKind] = mapped_column(str_enum(KnowledgeKind, "knowledge_kind"))
    title: Mapped[str] = mapped_column(String(300))
    content: Mapped[str] = mapped_column(Text)
    provenance: Mapped[Provenance] = mapped_column(str_enum(Provenance, "knowledge_provenance"))
    evidence_refs: Mapped[list[Any]] = mapped_column(default=json_default_list)
    source: Mapped[str] = mapped_column(String(64))
    status: Mapped[KnowledgeStatus] = mapped_column(str_enum(KnowledgeStatus, "knowledge_status"))
    version: Mapped[int] = mapped_column(Integer, default=1)
    superseded_by: Mapped[uuid.UUID | None] = mapped_column(default=None)
    scan_session_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("scan_sessions.id", ondelete="RESTRICT"), default=None
    )


class QaReport(IdMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "qa_reports"
    __table_args__ = (Index("ix_qa_reports_project_type_version", "project_id", "report_type", "version"),)

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))
    report_type: Mapped[ReportType] = mapped_column(str_enum(ReportType, "report_type"))
    version: Mapped[int] = mapped_column(Integer)
    status: Mapped[ReportStatus] = mapped_column(
        str_enum(ReportStatus, "report_status"), default=ReportStatus.rendering
    )
    stage_run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("stage_runs.id", ondelete="RESTRICT"), default=None
    )
    scan_session_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("scan_sessions.id", ondelete="RESTRICT"), default=None
    )
    source_versions: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    content: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    files: Mapped[list[Any]] = mapped_column(default=json_default_list)
    ai_sections: Mapped[list[Any]] = mapped_column(default=json_default_list)
    generated_by: Mapped[GeneratedBy] = mapped_column(
        str_enum(GeneratedBy, "report_generated_by"), default=GeneratedBy.rules
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    error: Mapped[str | None] = mapped_column(Text, default=None)
