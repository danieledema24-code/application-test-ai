"""Phase 3 test design: test conditions, test cases, synthetic test data and their lineage links.

Links to Phase 2 artefacts (requirements, acceptance criteria) and between Phase 3 rows use **lineage ids**, so
editing or regenerating never breaks traceability. The JSON lineage columns are denormalised copies of the link
tables (carried rows are compared and cloned cheaply); `services/testdesign.link_*` keeps both in sync.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, Column, ForeignKey, Index, Integer, String, Table, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TenantMixin, TimestampMixin
from app.db.models.requirements import RegenerableMixin
from app.db.types import UTCDateTime, json_default_dict, json_default_list, str_enum
from app.domain.enums import (
    AutomationSuitability,
    CaseSource,
    CaseStatus,
    ExecutionStatus,
    ExpectedResultStatus,
    ItemStatus,
    Priority,
    TestDataKind,
    TestDataStatus,
    TestDataValueType,
)

# Stored instead of NULL in the AC part of the link tables' primary keys.
NO_AC = uuid.UUID(int=0)


class TestCondition(IdMixin, TenantMixin, TimestampMixin, RegenerableMixin, Base):
    __tablename__ = "test_conditions"
    __test__ = False  # not a pytest class
    __table_args__ = (
        UniqueConstraint("project_id", "stage_run_id", "key"),
        UniqueConstraint("stage_run_id", "lineage_id"),
        Index(
            "ix_test_conditions_org_project_run_technique", "organisation_id", "project_id", "stage_run_id", "technique"
        ),
    )

    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    technique: Mapped[str] = mapped_column(String(32))
    test_type: Mapped[str] = mapped_column(String(32))
    feature_lineage_id: Mapped[uuid.UUID | None] = mapped_column(default=None)
    design_basis: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    coverage_items: Mapped[list[Any]] = mapped_column(default=json_default_list)
    notes: Mapped[list[Any]] = mapped_column(default=json_default_list)
    status: Mapped[ItemStatus] = mapped_column(str_enum(ItemStatus, "test_condition_status"), default=ItemStatus.draft)
    status_comment: Mapped[str | None] = mapped_column(Text, default=None)
    requirement_lineage_ids: Mapped[list[Any]] = mapped_column(default=json_default_list)
    ac_lineage_ids: Mapped[list[Any]] = mapped_column(default=json_default_list)


condition_requirements = Table(
    "condition_requirements",
    Base.metadata,
    Column("test_condition_id", ForeignKey("test_conditions.id", ondelete="CASCADE"), primary_key=True),
    Column("requirement_lineage_id", Uuid(), primary_key=True, index=True),
    Column("acceptance_criterion_lineage_id", Uuid(), primary_key=True),
)


class TestCase(IdMixin, TenantMixin, TimestampMixin, RegenerableMixin, Base):
    __tablename__ = "test_cases"
    __test__ = False
    __table_args__ = (
        UniqueConstraint("project_id", "stage_run_id", "key"),
        UniqueConstraint("stage_run_id", "lineage_id"),
        Index("ix_test_cases_org_project_run_status", "organisation_id", "project_id", "stage_run_id", "status"),
        Index("ix_test_cases_project_run_priority", "project_id", "stage_run_id", "derived_priority"),
        CheckConstraint(
            "priority_override IS NULL OR priority_override_reason IS NOT NULL", name="override_needs_reason"
        ),
    )

    # The condition is referenced by lineage (resolved within the same stage run) so cloned runs stay consistent.
    condition_lineage_id: Mapped[uuid.UUID | None] = mapped_column(default=None, index=True)
    title: Mapped[str] = mapped_column(String(200))
    objective: Mapped[str] = mapped_column(Text, default="")
    preconditions: Mapped[list[Any]] = mapped_column(default=json_default_list)
    steps: Mapped[list[Any]] = mapped_column(default=json_default_list)
    expected_result: Mapped[str] = mapped_column(Text, default="")
    expected_result_status: Mapped[ExpectedResultStatus] = mapped_column(
        str_enum(ExpectedResultStatus, "test_case_expected_result_status"), default=ExpectedResultStatus.defined
    )
    open_question_ref: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    test_type: Mapped[str] = mapped_column(String(32))
    test_level: Mapped[str] = mapped_column(String(32))
    technique: Mapped[str] = mapped_column(String(32))
    suites: Mapped[list[Any]] = mapped_column(default=json_default_list)
    side_effects: Mapped[list[Any]] = mapped_column(default=json_default_list)
    design_basis_ref: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    automation_suitability: Mapped[AutomationSuitability] = mapped_column(
        str_enum(AutomationSuitability, "test_case_automation_suitability"), default=AutomationSuitability.suitable
    )
    automation_reason: Mapped[str] = mapped_column(Text, default="")
    automation_assessed: Mapped[str] = mapped_column(String(16), default="preliminary")
    execution_status: Mapped[ExecutionStatus] = mapped_column(
        str_enum(ExecutionStatus, "test_case_execution_status"), default=ExecutionStatus.not_run
    )
    status: Mapped[CaseStatus] = mapped_column(str_enum(CaseStatus, "test_case_status"), default=CaseStatus.draft)
    status_comment: Mapped[str | None] = mapped_column(Text, default=None)
    status_changed_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), default=None
    )
    status_changed_at: Mapped[datetime | None] = mapped_column(default=None)
    source: Mapped[CaseSource] = mapped_column(str_enum(CaseSource, "test_case_source"), default=CaseSource.design)
    # P3-05: derived from linked risks (no version bump when they change) plus a versioned human override.
    risk_level: Mapped[str | None] = mapped_column(String(16), default=None)
    risk_score: Mapped[int | None] = mapped_column(Integer, default=None)
    risk_lineage_id: Mapped[uuid.UUID | None] = mapped_column(default=None)
    derived_priority: Mapped[Priority] = mapped_column(
        str_enum(Priority, "test_case_derived_priority"), default=Priority.low
    )
    priority_override: Mapped[Priority | None] = mapped_column(
        str_enum(Priority, "test_case_priority_override"), default=None
    )
    priority_override_reason: Mapped[str | None] = mapped_column(Text, default=None)
    priority_overridden_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), default=None
    )
    priority_overridden_at: Mapped[datetime | None] = mapped_column(UTCDateTime(timezone=True), default=None)
    lint: Mapped[list[Any]] = mapped_column(default=json_default_list)
    lint_rules_version: Mapped[int] = mapped_column(Integer, default=0)
    requirement_lineage_ids: Mapped[list[Any]] = mapped_column(default=json_default_list)
    ac_lineage_ids: Mapped[list[Any]] = mapped_column(default=json_default_list)
    data_lineage_ids: Mapped[list[Any]] = mapped_column(default=json_default_list)


test_case_requirements = Table(
    "test_case_requirements",
    Base.metadata,
    Column("test_case_id", ForeignKey("test_cases.id", ondelete="CASCADE"), primary_key=True),
    Column("requirement_lineage_id", Uuid(), primary_key=True, index=True),
    Column("acceptance_criterion_lineage_id", Uuid(), primary_key=True),
)


class TestData(IdMixin, TenantMixin, TimestampMixin, RegenerableMixin, Base):
    __tablename__ = "test_data"
    __test__ = False
    __table_args__ = (
        UniqueConstraint("project_id", "stage_run_id", "key"),
        UniqueConstraint("stage_run_id", "lineage_id"),
        Index("ix_test_data_org_project_run_field", "organisation_id", "project_id", "stage_run_id", "field_label"),
        CheckConstraint("(kind = 'secret_ref') = (secret_ref IS NOT NULL AND value IS NULL)", name="secret_ref_only"),
    )

    name: Mapped[str] = mapped_column(String(200))
    feature_lineage_id: Mapped[uuid.UUID | None] = mapped_column(default=None)
    form_ref: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    field_label: Mapped[str] = mapped_column(String(200))
    field_selector: Mapped[str] = mapped_column(String(400), default="")
    kind: Mapped[TestDataKind] = mapped_column(str_enum(TestDataKind, "test_data_kind"))
    value_type: Mapped[TestDataValueType] = mapped_column(str_enum(TestDataValueType, "test_data_value_type"))
    value: Mapped[str | None] = mapped_column(Text, default=None)
    secret_ref: Mapped[str | None] = mapped_column(String(120), default=None)
    length: Mapped[int | None] = mapped_column(Integer, default=None)
    boundary_ref: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    generator: Mapped[str | None] = mapped_column(String(120), default=None)
    synthetic: Mapped[bool] = mapped_column(default=True)
    status: Mapped[TestDataStatus] = mapped_column(
        str_enum(TestDataStatus, "test_data_status"), default=TestDataStatus.active
    )


test_case_data = Table(
    "test_case_data",
    Base.metadata,
    Column("test_case_id", ForeignKey("test_cases.id", ondelete="CASCADE"), primary_key=True),
    Column("test_data_lineage_id", Uuid(), primary_key=True, index=True),
)
