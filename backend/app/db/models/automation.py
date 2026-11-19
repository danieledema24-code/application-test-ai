"""Phase 4 automation, execution and defects (database-schema.md "Automation, execution, defects (Phase 4)").

Migration `0016_automation_execution` creates every table and column the Phase 4 stories use, up front (P4-00).
Links to Phase 3 artefacts use the case **lineage id** plus the version that was used, so regenerating the design
never breaks a script, result or defect link.
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
    ApprovalKind,
    ApprovalStatus,
    AssetKind,
    AutomationSuitability,
    DefectSeverity,
    DefectSource,
    DefectStatus,
    FailureClass,
    Priority,
    ResultStatus,
    RunMode,
    RunStatus,
    ScriptGeneratedBy,
    ScriptStatus,
)


class _ProjectMixin:
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))


class AutomationAssessment(IdMixin, TenantMixin, TimestampMixin, _ProjectMixin, Base):
    """P4-02: suitability and step model of one approved case, per assessment stage run."""

    __tablename__ = "automation_assessments"
    __table_args__ = (UniqueConstraint("stage_run_id", "case_lineage_id"),)

    stage_run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stage_runs.id", ondelete="RESTRICT"), index=True)
    test_case_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("test_cases.id", ondelete="RESTRICT"))
    case_lineage_id: Mapped[uuid.UUID]
    case_version: Mapped[int] = mapped_column(Integer)
    suitability: Mapped[AutomationSuitability] = mapped_column(
        str_enum(AutomationSuitability, "automation_assessment_suitability")
    )
    reasons: Mapped[list[Any]] = mapped_column(default=json_default_list)
    blockers: Mapped[list[Any]] = mapped_column(default=json_default_list)
    step_model: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)


class AutomationAsset(IdMixin, TenantMixin, TimestampMixin, _ProjectMixin, Base):
    """P4-03a: a non-spec file of an automation bundle (the bundle version is its `automation` stage run)."""

    __tablename__ = "automation_assets"
    __table_args__ = (UniqueConstraint("stage_run_id", "path"),)

    stage_run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stage_runs.id", ondelete="RESTRICT"), index=True)
    kind: Mapped[AssetKind] = mapped_column(str_enum(AssetKind, "automation_asset_kind"))
    path: Mapped[str] = mapped_column(String(300))
    code: Mapped[str] = mapped_column(Text)
    sha256: Mapped[str] = mapped_column(String(64))
    version: Mapped[int] = mapped_column(Integer, default=1)
    generated_by: Mapped[ScriptGeneratedBy] = mapped_column(
        str_enum(ScriptGeneratedBy, "automation_asset_generated_by")
    )


class AutomationScript(IdMixin, TenantMixin, TimestampMixin, _ProjectMixin, Base):
    """P4-03a/b, P4-04: one spec per automated case, keyed by case lineage within a bundle version."""

    __tablename__ = "automation_scripts"
    __table_args__ = (
        UniqueConstraint("stage_run_id", "case_lineage_id"),
        Index("ix_automation_scripts_project_status", "project_id", "status"),
    )

    stage_run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stage_runs.id", ondelete="RESTRICT"), index=True)
    test_case_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("test_cases.id", ondelete="RESTRICT"))
    case_lineage_id: Mapped[uuid.UUID]
    case_version: Mapped[int] = mapped_column(Integer)
    # Script lineage = case lineage: a script keeps its identity across bundle versions.
    lineage_id: Mapped[uuid.UUID]
    version: Mapped[int] = mapped_column(Integer, default=1)
    path: Mapped[str] = mapped_column(String(300))
    code: Mapped[str] = mapped_column(Text)
    sha256: Mapped[str] = mapped_column(String(64))
    assertion_map: Mapped[list[Any]] = mapped_column(default=json_default_list)
    status: Mapped[ScriptStatus] = mapped_column(
        str_enum(ScriptStatus, "automation_script_status"), default=ScriptStatus.draft
    )
    # {guard|tsc|eslint|secret_scan|tags|locators: {ok, messages: [{line, message}]}}
    validation: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    generated_by: Mapped[ScriptGeneratedBy] = mapped_column(
        str_enum(ScriptGeneratedBy, "automation_script_generated_by")
    )
    # AI-written scripts only (decision D10): {decision, by, at, comment}.
    review: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    # Phase 6 (P6-02): why the script became `outdated` after a change ("getByLabel('Message') not found after CHG-0001").
    outdated_reason: Mapped[str | None] = mapped_column(Text, default=None)


class ExecutionRun(IdMixin, TenantMixin, TimestampMixin, _ProjectMixin, Base):
    """P4-06: one requested run (RUN-0001). Immutable scope once requested; G7 authorises exactly this scope."""

    __tablename__ = "execution_runs"
    __table_args__ = (
        UniqueConstraint("project_id", "key"),
        Index("ix_execution_runs_project_created", "project_id", "created_at"),
        Index("ix_execution_runs_project_status", "project_id", "status"),
    )

    key: Mapped[str] = mapped_column(String(32))
    # The `execution` stage run of this run (created when the run is queued; each run is its own version).
    stage_run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("stage_runs.id", ondelete="RESTRICT"), default=None, index=True
    )
    mode: Mapped[RunMode] = mapped_column(str_enum(RunMode, "execution_run_mode"), default=RunMode.automated)
    selection: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    scope: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    scope_hash: Mapped[str | None] = mapped_column(String(64), default=None)
    config: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    bundle_version: Mapped[int | None] = mapped_column(Integer, default=None)
    g7_decision_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("gate_decisions.id", ondelete="RESTRICT"), default=None
    )
    status: Mapped[RunStatus] = mapped_column(
        str_enum(RunStatus, "execution_run_status"), default=RunStatus.awaiting_authorisation
    )
    totals: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    requested_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    started_at: Mapped[datetime | None] = mapped_column(default=None)
    finished_at: Mapped[datetime | None] = mapped_column(default=None)
    error: Mapped[str | None] = mapped_column(Text, default=None)


class ExecutionResult(IdMixin, TenantMixin, TimestampMixin, _ProjectMixin, Base):
    """P4-06, P4-08: one case × browser × viewport result. Status comes only from Playwright's JSON reporter."""

    __tablename__ = "execution_results"
    __table_args__ = (
        UniqueConstraint("execution_run_id", "key"),
        Index("ix_execution_results_project_case_created", "project_id", "case_lineage_id", "created_at"),
    )

    execution_run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("execution_runs.id", ondelete="RESTRICT"), index=True
    )
    key: Mapped[str] = mapped_column(String(40))
    test_case_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("test_cases.id", ondelete="RESTRICT"), default=None
    )
    case_lineage_id: Mapped[uuid.UUID]
    automation_script_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("automation_scripts.id", ondelete="RESTRICT"), default=None
    )
    script_version: Mapped[int | None] = mapped_column(Integer, default=None)
    browser: Mapped[str] = mapped_column(String(32), default="chromium")
    viewport: Mapped[str] = mapped_column(String(32), default="1440x900")
    status: Mapped[ResultStatus] = mapped_column(str_enum(ResultStatus, "execution_result_status"))
    attempts: Mapped[int] = mapped_column(Integer, default=1)
    duration_ms: Mapped[int | None] = mapped_column(Integer, default=None)
    steps: Mapped[list[Any]] = mapped_column(default=json_default_list)
    failed_step: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    error: Mapped[str | None] = mapped_column(Text, default=None)  # redacted, <= 8 KB
    page_state: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    actual_result: Mapped[str] = mapped_column(Text, default="")
    classification: Mapped[FailureClass | None] = mapped_column(
        str_enum(FailureClass, "execution_result_classification"), default=None
    )
    analysis: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    heal_suggestions: Mapped[list[Any]] = mapped_column(default=json_default_list)


class Approval(IdMixin, TenantMixin, TimestampMixin, _ProjectMixin, Base):
    """P4-05: separate approval for a risky action (spec §19), single use, expires after 24 h."""

    __tablename__ = "approvals"
    __table_args__ = (
        UniqueConstraint("project_id", "key"),
        Index("ix_approvals_project_kind_status", "project_id", "kind", "status"),
    )

    key: Mapped[str] = mapped_column(String(32))
    kind: Mapped[ApprovalKind] = mapped_column(str_enum(ApprovalKind, "approval_kind"))
    execution_run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("execution_runs.id", ondelete="RESTRICT"), default=None, index=True
    )
    # Phase 5 (P5-00, migration 0017): the performance run a `load_test` approval authorises (decision D18).
    performance_run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("performance_runs.id", ondelete="RESTRICT"), default=None, index=True
    )
    # Phase 6 (P6-00, migration 0019): the signed-in exploratory session an `exploratory_session` approval authorises
    # (decision D30).
    quality_scan_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("quality_scans.id", ondelete="RESTRICT"), default=None, index=True
    )
    scope: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    requested_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    decided_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    decided_at: Mapped[datetime | None] = mapped_column(default=None)
    status: Mapped[ApprovalStatus] = mapped_column(
        str_enum(ApprovalStatus, "approval_status"), default=ApprovalStatus.pending
    )
    comment: Mapped[str | None] = mapped_column(Text, default=None)
    expires_at: Mapped[datetime]


class Defect(IdMixin, TenantMixin, TimestampMixin, _ProjectMixin, Base):
    """P4-08/P4-09: a defect report with every spec §11 field. Never deleted; G8 confirms or rejects drafts."""

    __tablename__ = "defects"
    __table_args__ = (
        UniqueConstraint("project_id", "key"),
        Index("ix_defects_project_status", "project_id", "status"),
        Index("ix_defects_project_severity", "project_id", "severity"),
    )

    key: Mapped[str] = mapped_column(String(32))
    summary: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text, default="")
    environment: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    preconditions: Mapped[list[Any]] = mapped_column(default=json_default_list)
    steps: Mapped[list[Any]] = mapped_column(default=json_default_list)
    expected: Mapped[str] = mapped_column(Text, default="")
    actual: Mapped[str] = mapped_column(Text, default="")
    severity: Mapped[DefectSeverity] = mapped_column(str_enum(DefectSeverity, "defect_severity"))
    severity_derived: Mapped[DefectSeverity] = mapped_column(str_enum(DefectSeverity, "defect_severity_derived"))
    severity_reason: Mapped[str | None] = mapped_column(Text, default=None)
    priority: Mapped[Priority] = mapped_column(str_enum(Priority, "defect_priority"))
    priority_derived: Mapped[Priority] = mapped_column(str_enum(Priority, "defect_priority_derived"))
    priority_reason: Mapped[str | None] = mapped_column(Text, default=None)
    # {attempts_failed, attempts, kind: always|intermittent}
    reproducibility: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    root_cause_hypothesis: Mapped[str | None] = mapped_column(Text, default=None)
    evidence_refs: Mapped[list[Any]] = mapped_column(default=json_default_list)
    status: Mapped[DefectStatus] = mapped_column(str_enum(DefectStatus, "defect_status"), default=DefectStatus.draft)
    status_reason: Mapped[str | None] = mapped_column(Text, default=None)
    status_comment: Mapped[str | None] = mapped_column(Text, default=None)
    confirmed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    confirmed_at: Mapped[datetime | None] = mapped_column(default=None)
    source: Mapped[DefectSource] = mapped_column(str_enum(DefectSource, "defect_source"), default=DefectSource.analysis)
    execution_result_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("execution_results.id", ondelete="RESTRICT"), default=None, index=True
    )
    version: Mapped[int] = mapped_column(Integer, default=1)


class DefectLink(IdMixin, TenantMixin, TimestampMixin, _ProjectMixin, Base):
    __tablename__ = "defect_links"

    defect_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("defects.id", ondelete="RESTRICT"), index=True)
    requirement_lineage_id: Mapped[uuid.UUID | None] = mapped_column(default=None, index=True)
    test_case_lineage_id: Mapped[uuid.UUID | None] = mapped_column(default=None, index=True)


class DefectOccurrence(IdMixin, TenantMixin, TimestampMixin, _ProjectMixin, Base):
    """A repeat failure of the same case and step adds an occurrence to the open defect instead of a new draft."""

    __tablename__ = "defect_occurrences"
    __table_args__ = (UniqueConstraint("defect_id", "execution_result_id"),)

    defect_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("defects.id", ondelete="RESTRICT"))
    execution_result_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("execution_results.id", ondelete="RESTRICT"), index=True
    )
    seen_at: Mapped[datetime]
