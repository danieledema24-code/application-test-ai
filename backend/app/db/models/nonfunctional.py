"""Phase 5 non-functional testing (database-schema.md "Non-functional testing (Phase 5)").

Migration `0017_nonfunctional` creates every table and column P5-01b, P5-02, P5-03 and P5-07 use, up front (P5-00).
Accessibility and security scans share `quality_scans`/`quality_findings`; performance has profiles (editable,
versioned) and runs (an immutable snapshot of the profile that a `load_test` approval authorises).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TenantMixin, TimestampMixin
from app.db.types import json_default_dict, json_default_list, str_enum
from app.domain.enums import (
    FindingSeverity,
    FindingStatus,
    GeneratedBy,
    PerfProfileStatus,
    PerfProfileType,
    PerfRunStatus,
    QualityScanKind,
    QualityScanStatus,
)


class _ProjectMixin:
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))


class QualityScan(IdMixin, TenantMixin, TimestampMixin, _ProjectMixin, Base):
    """P5-02/P5-03: one accessibility (A11Y-0001) or passive security (SEC-0001) scan; its own stage run."""

    __tablename__ = "quality_scans"
    __table_args__ = (
        UniqueConstraint("project_id", "key"),
        Index("ix_quality_scans_project_kind_created", "project_id", "kind", "created_at"),
    )

    key: Mapped[str] = mapped_column(String(32))
    kind: Mapped[QualityScanKind] = mapped_column(str_enum(QualityScanKind, "quality_scan_kind"))
    stage_run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("stage_runs.id", ondelete="RESTRICT"), default=None, index=True
    )
    # Pages, viewports, keyboard pass on/off, signed-in pages.
    config: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    status: Mapped[QualityScanStatus] = mapped_column(
        str_enum(QualityScanStatus, "quality_scan_status"), default=QualityScanStatus.queued
    )
    summary: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)  # computed counts
    not_checked: Mapped[list[Any]] = mapped_column(default=json_default_list)  # [{item, reason}]
    tool_versions: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    requested_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    started_at: Mapped[datetime | None] = mapped_column(default=None)
    finished_at: Mapped[datetime | None] = mapped_column(default=None)
    error: Mapped[str | None] = mapped_column(Text, default=None)


class QualityFinding(IdMixin, TenantMixin, TimestampMixin, _ProjectMixin, Base):
    """P5-02/P5-03: one rule result on one page (A11Y-0001-01…). Facts are stored as observed; triage is a person's."""

    __tablename__ = "quality_findings"
    __table_args__ = (
        UniqueConstraint("scan_id", "key"),
        Index("ix_quality_findings_project_kind_status", "project_id", "kind", "status"),
        Index("ix_quality_findings_project_fingerprint", "project_id", "fingerprint"),
    )

    key: Mapped[str] = mapped_column(String(40))
    scan_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("quality_scans.id", ondelete="RESTRICT"), index=True)
    kind: Mapped[QualityScanKind] = mapped_column(str_enum(QualityScanKind, "quality_finding_kind"))
    rule_id: Mapped[str] = mapped_column(String(120))
    severity: Mapped[FindingSeverity] = mapped_column(str_enum(FindingSeverity, "quality_finding_severity"))
    title: Mapped[str] = mapped_column(String(300))
    page_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("discovered_pages.id", ondelete="RESTRICT"), default=None, index=True
    )
    url: Mapped[str] = mapped_column(String(2048))
    viewport: Mapped[str | None] = mapped_column(String(32), default=None)
    # <= 20 per rule per page: {target, html (redacted, <= 500 chars), summary}.
    nodes: Mapped[list[Any]] = mapped_column(default=json_default_list)
    references: Mapped[list[Any]] = mapped_column(default=json_default_list)  # WCAG criteria, OWASP references
    # rule + normalised URL path + target: dedupe and "Seen before" across scans.
    fingerprint: Mapped[str] = mapped_column(String(64))
    status: Mapped[FindingStatus] = mapped_column(
        str_enum(FindingStatus, "quality_finding_status"), default=FindingStatus.open
    )
    status_reason: Mapped[str | None] = mapped_column(Text, default=None)
    status_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    defect_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("defects.id", ondelete="RESTRICT"), default=None, index=True
    )
    evidence_refs: Mapped[list[Any]] = mapped_column(default=json_default_list)
    # Feature, requirement and test case lineages the page maps to.
    mapped: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)


class PerformanceProfile(IdMixin, TenantMixin, TimestampMixin, _ProjectMixin, Base):
    """P5-01b: a load profile (PRF-01). Editing creates a new version; G4 re-approval marks it stale."""

    __tablename__ = "performance_profiles"
    __table_args__ = (
        UniqueConstraint("project_id", "key"),
        Index("ix_performance_profiles_project_status", "project_id", "status"),
    )

    key: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(160))
    type: Mapped[PerfProfileType] = mapped_column(
        str_enum(PerfProfileType, "performance_profile_type"), default=PerfProfileType.load
    )
    stages: Mapped[list[Any]] = mapped_column(default=json_default_list)  # [{duration_s, target_vus}]
    max_rps: Mapped[int] = mapped_column(Integer)
    think_time_ms: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)  # {min, max}
    targets: Mapped[list[Any]] = mapped_column(default=json_default_list)  # [{path, weight, page_id?}]
    # [{metric: p95|p99|error_rate, scope: all|path, path?, op, value, source: requirement_lineage_id|default}]
    thresholds: Mapped[list[Any]] = mapped_column(default=json_default_list)
    status: Mapped[PerfProfileStatus] = mapped_column(
        str_enum(PerfProfileStatus, "performance_profile_status"), default=PerfProfileStatus.draft
    )
    stale_reason: Mapped[str | None] = mapped_column(Text, default=None)
    generated_by: Mapped[GeneratedBy] = mapped_column(
        str_enum(GeneratedBy, "performance_profile_generated_by"), default=GeneratedBy.rules
    )
    rationale: Mapped[str | None] = mapped_column(Text, default=None)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    version: Mapped[int] = mapped_column(Integer, default=1)

    __mapper_args__ = {"version_id_col": version}  # noqa: RUF012 - SQLAlchemy declarative attribute


class PerformanceRun(IdMixin, TenantMixin, TimestampMixin, _ProjectMixin, Base):
    """P5-01b: one requested load test (PERF-0001) of a profile snapshot; starts only with a used `load_test`
    approval (decision D18)."""

    __tablename__ = "performance_runs"
    __table_args__ = (
        UniqueConstraint("project_id", "key"),
        Index("ix_performance_runs_project_created", "project_id", "created_at"),
        Index("ix_performance_runs_project_status", "project_id", "status"),
    )

    key: Mapped[str] = mapped_column(String(32))
    profile_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("performance_profiles.id", ondelete="RESTRICT"), index=True
    )
    profile_snapshot: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    profile_hash: Mapped[str] = mapped_column(String(64))
    # The `performance` stage run of this run (created when the run is first mirrored; each run is its own version).
    stage_run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("stage_runs.id", ondelete="RESTRICT"), default=None, index=True
    )
    # No FK: approvals.performance_run_id references this table (the pair is kept consistent by the service).
    approval_id: Mapped[uuid.UUID | None] = mapped_column(default=None)
    engine: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)  # {name, version}
    status: Mapped[PerfRunStatus] = mapped_column(
        str_enum(PerfRunStatus, "performance_run_status"), default=PerfRunStatus.awaiting_approval
    )
    # Overall and per target: count, rps, error_rate, p50/p90/p95/p99/max, status codes; `live` while running.
    metrics: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    threshold_results: Mapped[list[Any]] = mapped_column(default=json_default_list)
    aborted_reason: Mapped[str | None] = mapped_column(Text, default=None)
    stopped_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    requested_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    started_at: Mapped[datetime | None] = mapped_column(default=None)
    finished_at: Mapped[datetime | None] = mapped_column(default=None)
    error: Mapped[str | None] = mapped_column(Text, default=None)
