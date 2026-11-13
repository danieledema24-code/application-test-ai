"""Phase 2 requirements intelligence: entity revisions, requirements, acceptance criteria, readiness criteria."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    Column,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Table,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, declared_attr, mapped_column

from app.db.base import Base, CreatedMixin, IdMixin, TenantMixin, TimestampMixin
from app.db.types import json_default_list, str_enum
from app.domain.enums import (
    AcKind,
    BehaviourScope,
    GeneratedBy,
    ItemStatus,
    Provenance,
    ReadinessKind,
    ReadinessScope,
    ReadinessStatus,
    RequirementSource,
    RequirementStatus,
    RequirementType,
)


class EntityRevision(IdMixin, TenantMixin, CreatedMixin, Base):
    """Append-only edit history, read by lineage so it survives regeneration (database-schema.md, P2-00)."""

    __tablename__ = "entity_revisions"
    __table_args__ = (
        UniqueConstraint("entity_type", "lineage_id", "version"),
        Index(
            "ix_entity_revisions_org_project_type_lineage", "organisation_id", "project_id", "entity_type", "lineage_id"
        ),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))
    entity_type: Mapped[str] = mapped_column(String(32))
    entity_id: Mapped[uuid.UUID]
    lineage_id: Mapped[uuid.UUID]
    version: Mapped[int] = mapped_column(Integer)
    snapshot: Mapped[dict[str, Any]]
    changes: Mapped[dict[str, Any]]
    source: Mapped[str] = mapped_column(String(32))
    proposal_id: Mapped[uuid.UUID | None] = mapped_column(default=None)
    changed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    change_reason: Mapped[str | None] = mapped_column(Text, default=None)


class RegenerableMixin:
    """Columns shared by every regenerable artefact (database-schema.md "RegenerableMixin")."""

    @declared_attr
    def project_id(cls) -> Mapped[uuid.UUID]:
        return mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))

    @declared_attr
    def stage_run_id(cls) -> Mapped[uuid.UUID]:
        return mapped_column(ForeignKey("stage_runs.id", ondelete="RESTRICT"), index=True)

    lineage_id: Mapped[uuid.UUID] = mapped_column(default=uuid.uuid4)
    key: Mapped[str] = mapped_column(String(32))
    match_key: Mapped[str] = mapped_column(String(400))
    carried_from_id: Mapped[uuid.UUID | None] = mapped_column(default=None)

    @declared_attr
    def provenance(cls) -> Mapped[Provenance]:
        return mapped_column(str_enum(Provenance, f"{cls.__tablename__}_provenance"))  # type: ignore[attr-defined]

    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    evidence_refs: Mapped[list[Any]] = mapped_column(default=json_default_list)

    @declared_attr
    def generated_by(cls) -> Mapped[GeneratedBy]:
        return mapped_column(str_enum(GeneratedBy, f"{cls.__tablename__}_generated_by"))  # type: ignore[attr-defined]

    rule_id: Mapped[str | None] = mapped_column(String(64), default=None)
    locked: Mapped[bool] = mapped_column(default=False)
    human_edited: Mapped[bool] = mapped_column(default=False)
    version: Mapped[int] = mapped_column(Integer, default=1)

    @declared_attr
    def updated_by(cls) -> Mapped[uuid.UUID | None]:
        return mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)

    suggested_change: Mapped[dict[str, Any] | None] = mapped_column(default=None)


class Requirement(IdMixin, TenantMixin, TimestampMixin, RegenerableMixin, Base):
    __tablename__ = "requirements"
    __table_args__ = (
        UniqueConstraint("project_id", "stage_run_id", "key"),
        UniqueConstraint("stage_run_id", "lineage_id"),
        Index("ix_requirements_org_project_run_status", "organisation_id", "project_id", "stage_run_id", "status"),
        Index("ix_requirements_project_match_key", "project_id", "match_key"),
        # DB backstop for the code rule: backend/mixed behaviour can never be "observed".
        CheckConstraint("NOT (provenance = 'observed' AND behaviour_scope <> 'ui')", name="observed_ui_only"),
    )

    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    type: Mapped[RequirementType] = mapped_column(str_enum(RequirementType, "requirement_type"))
    category: Mapped[str] = mapped_column(String(32))
    behaviour_scope: Mapped[BehaviourScope] = mapped_column(str_enum(BehaviourScope, "requirement_behaviour_scope"))
    source: Mapped[RequirementSource] = mapped_column(str_enum(RequirementSource, "requirement_source"))
    source_refs: Mapped[dict[str, Any]] = mapped_column(default=dict)
    assumptions: Mapped[list[Any]] = mapped_column(default=json_default_list)
    status: Mapped[RequirementStatus] = mapped_column(
        str_enum(RequirementStatus, "requirement_status"), default=RequirementStatus.draft
    )
    status_comment: Mapped[str | None] = mapped_column(Text, default=None)
    status_changed_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), default=None
    )
    status_changed_at: Mapped[datetime | None] = mapped_column(default=None)
    risk_level: Mapped[str | None] = mapped_column(String(16), default=None)
    validation_issues: Mapped[list[Any]] = mapped_column(default=json_default_list)
    # Denormalised feature ids (also in requirement_features) so carried rows can be compared cheaply.
    feature_ids: Mapped[list[Any]] = mapped_column(default=json_default_list)


requirement_features = Table(
    "requirement_features",
    Base.metadata,
    Column("requirement_id", ForeignKey("requirements.id", ondelete="CASCADE"), primary_key=True),
    Column("feature_id", ForeignKey("application_features.id", ondelete="RESTRICT"), primary_key=True, index=True),
)


class AcceptanceCriterion(IdMixin, TenantMixin, TimestampMixin, RegenerableMixin, Base):
    __tablename__ = "acceptance_criteria"
    __table_args__ = (
        UniqueConstraint("project_id", "stage_run_id", "key"),
        Index("ix_acceptance_criteria_requirement_sort", "requirement_id", "sort_order"),
    )

    requirement_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("requirements.id", ondelete="CASCADE"))
    kind: Mapped[AcKind] = mapped_column(str_enum(AcKind, "ac_kind"))
    given_text: Mapped[str] = mapped_column(Text)
    when_text: Mapped[str] = mapped_column(Text)
    then_text: Mapped[str] = mapped_column(Text)
    status: Mapped[ItemStatus] = mapped_column(str_enum(ItemStatus, "ac_status"), default=ItemStatus.draft)
    test_values: Mapped[list[Any] | None] = mapped_column(default=None)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    # True when the behaviour in Then was exercised during discovery (navigation); only then can it be observed.
    exercised: Mapped[bool] = mapped_column(default=False)


class ReadinessCriterion(IdMixin, TenantMixin, TimestampMixin, RegenerableMixin, Base):
    __tablename__ = "readiness_criteria"
    __table_args__ = (
        UniqueConstraint("project_id", "stage_run_id", "key"),
        Index("ix_readiness_criteria_project_run_kind", "project_id", "stage_run_id", "kind"),
    )

    kind: Mapped[ReadinessKind] = mapped_column(str_enum(ReadinessKind, "readiness_kind"))
    scope: Mapped[ReadinessScope] = mapped_column(str_enum(ReadinessScope, "readiness_scope"))
    text: Mapped[str] = mapped_column(Text)
    status: Mapped[ReadinessStatus] = mapped_column(
        str_enum(ReadinessStatus, "readiness_status"), default=ReadinessStatus.active
    )
    check_rule_id: Mapped[str | None] = mapped_column(String(64), default=None)
    evaluable_from_phase: Mapped[int | None] = mapped_column(Integer, default=None)
    evaluation: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
