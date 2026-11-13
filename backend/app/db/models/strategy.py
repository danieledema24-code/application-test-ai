"""Phase 2 test strategy, risk register and test plan versions."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import CheckConstraint, Column, ForeignKey, Index, Integer, String, Table, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TenantMixin, TimestampMixin
from app.db.models.requirements import RegenerableMixin
from app.db.types import json_default_dict, json_default_list, str_enum
from app.domain.enums import (
    GeneratedBy,
    PlanSource,
    ReviewStatus,
    RiskCategory,
    RiskLevel,
    RiskStatus,
    StrategyStatus,
)


class TestStrategy(IdMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "test_strategies"
    __table_args__ = (
        UniqueConstraint("project_id", "stage_run_id"),
        Index("ix_test_strategies_org_project_status", "organisation_id", "project_id", "status"),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))
    stage_run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stage_runs.id", ondelete="RESTRICT"))
    key: Mapped[str] = mapped_column(String(32))
    version: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[StrategyStatus] = mapped_column(
        str_enum(StrategyStatus, "strategy_status"), default=StrategyStatus.draft
    )
    generated_by: Mapped[GeneratedBy] = mapped_column(str_enum(GeneratedBy, "strategy_generated_by"))
    content: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    approved_input: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    human_edited_sections: Mapped[list[Any]] = mapped_column(default=json_default_list)
    locked_sections: Mapped[list[Any]] = mapped_column(default=json_default_list)
    suggested_changes: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    validation_issues: Mapped[list[Any]] = mapped_column(default=json_default_list)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)


class Risk(IdMixin, TenantMixin, TimestampMixin, RegenerableMixin, Base):
    __tablename__ = "risks"
    __table_args__ = (
        UniqueConstraint("project_id", "stage_run_id", "key"),
        Index("ix_risks_project_run_level", "project_id", "stage_run_id", "level"),
        CheckConstraint(
            "likelihood BETWEEN 1 AND 5 AND impact BETWEEN 1 AND 5 AND score = likelihood * impact",
            name="score_is_l_times_i",
        ),
    )

    strategy_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("test_strategies.id", ondelete="RESTRICT"))
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    category: Mapped[RiskCategory] = mapped_column(str_enum(RiskCategory, "risk_category"))
    likelihood: Mapped[int] = mapped_column(Integer)
    impact: Mapped[int] = mapped_column(Integer)
    score: Mapped[int] = mapped_column(Integer)
    level: Mapped[RiskLevel] = mapped_column(str_enum(RiskLevel, "risk_level"))
    factors: Mapped[list[Any]] = mapped_column(default=json_default_list)
    likelihood_rationale: Mapped[str] = mapped_column(Text, default="")
    impact_rationale: Mapped[str] = mapped_column(Text, default="")
    mitigation: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    requires_approval: Mapped[bool] = mapped_column(default=False)
    status: Mapped[RiskStatus] = mapped_column(str_enum(RiskStatus, "risk_status"), default=RiskStatus.open)
    status_comment: Mapped[str | None] = mapped_column(Text, default=None)
    source: Mapped[str] = mapped_column(String(16), default="discovery")
    # Denormalised copies of the link tables (carried rows are compared cheaply).
    requirement_lineage_ids: Mapped[list[Any]] = mapped_column(default=json_default_list)
    feature_ids: Mapped[list[Any]] = mapped_column(default=json_default_list)


risk_requirements = Table(
    "risk_requirements",
    Base.metadata,
    Column("risk_id", ForeignKey("risks.id", ondelete="CASCADE"), primary_key=True),
    Column("requirement_lineage_id", Uuid(), primary_key=True, index=True),
)

risk_features = Table(
    "risk_features",
    Base.metadata,
    Column("risk_id", ForeignKey("risks.id", ondelete="CASCADE"), primary_key=True),
    Column("feature_id", ForeignKey("application_features.id", ondelete="RESTRICT"), primary_key=True),
)


class TestPlan(IdMixin, TenantMixin, TimestampMixin, Base):
    """One row per plan version (each save is a new version)."""

    __tablename__ = "test_plans"
    __table_args__ = (
        UniqueConstraint("project_id", "version"),
        Index("ix_test_plans_org_project_current", "organisation_id", "project_id", "is_current"),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))
    strategy_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("test_strategies.id", ondelete="RESTRICT"))
    stage_run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stage_runs.id", ondelete="RESTRICT"))
    key: Mapped[str] = mapped_column(String(32))
    version: Mapped[int] = mapped_column(Integer)
    strategy_version: Mapped[int] = mapped_column(Integer)
    source: Mapped[PlanSource] = mapped_column(str_enum(PlanSource, "plan_source"))
    review_status: Mapped[ReviewStatus] = mapped_column(
        str_enum(ReviewStatus, "plan_review_status"), default=ReviewStatus.not_required
    )
    is_current: Mapped[bool] = mapped_column(default=False)
    generated_by: Mapped[GeneratedBy] = mapped_column(str_enum(GeneratedBy, "plan_generated_by"))
    content: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    human_edited_sections: Mapped[list[Any]] = mapped_column(default=json_default_list)
    rules_template_sections: Mapped[list[Any]] = mapped_column(default=json_default_list)
    suggested_changes: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    review: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    note: Mapped[str | None] = mapped_column(Text, default=None)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
