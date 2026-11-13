"""Projects, target URLs, counters, workflow stages, stage runs, gate decisions, project secrets."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TenantMixin, TimestampMixin
from app.db.types import json_default_dict, json_default_list, str_enum
from app.domain.enums import (
    AuthorisationStatus,
    GateDecisionKind,
    GateKey,
    GateStatus,
    GeneratedBy,
    ProjectStatus,
    StageKey,
    StageStatus,
    UrlRole,
)


class Project(IdMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "projects"
    __table_args__ = (Index("ix_projects_org_archived_updated", "organisation_id", "archived_at", "updated_at"),)

    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[ProjectStatus] = mapped_column(
        str_enum(ProjectStatus, "project_status"), default=ProjectStatus.active
    )
    approval_policy: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    settings: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    archived_at: Mapped[datetime | None] = mapped_column(default=None)
    version: Mapped[int] = mapped_column(Integer, default=1)

    __mapper_args__ = {"version_id_col": version}  # noqa: RUF012 - SQLAlchemy declarative attribute


class ProjectSecret(IdMixin, TenantMixin, TimestampMixin, Base):
    """Write-only encrypted values (AES-256-GCM with key id). Created in Phase 1 for scan credentials."""

    __tablename__ = "secrets"
    __table_args__ = (UniqueConstraint("project_id", "name"),)

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    ciphertext: Mapped[str] = mapped_column(Text)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    rotated_at: Mapped[datetime | None] = mapped_column(default=None)


class ProjectUrl(IdMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "project_urls"
    __table_args__ = (UniqueConstraint("project_id", "url"),)

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"), index=True)
    url: Mapped[str] = mapped_column(String(2048))
    role: Mapped[UrlRole] = mapped_column(str_enum(UrlRole, "url_role"), default=UrlRole.primary)
    allowed_hosts: Mapped[list[Any]] = mapped_column(default=json_default_list)
    environment_label: Mapped[str | None] = mapped_column(String(64), default=None)
    authorisation_status: Mapped[AuthorisationStatus] = mapped_column(
        str_enum(AuthorisationStatus, "authorisation_status"), default=AuthorisationStatus.pending
    )
    authorised_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    authorised_at: Mapped[datetime | None] = mapped_column(default=None)
    authorisation_statement: Mapped[str | None] = mapped_column(Text, default=None)
    last_check: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    credentials_secret_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("secrets.id", ondelete="RESTRICT"), default=None
    )


class ProjectCounter(TenantMixin, Base):
    __tablename__ = "project_counters"

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"), primary_key=True)
    kind: Mapped[str] = mapped_column(String(32), primary_key=True)
    next_value: Mapped[int] = mapped_column(Integer, default=1)


class WorkflowStage(IdMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "workflow_stages"
    __table_args__ = (UniqueConstraint("project_id", "stage_key"),)

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"), index=True)
    stage_key: Mapped[StageKey] = mapped_column(str_enum(StageKey, "stage_key"))
    status: Mapped[StageStatus] = mapped_column(str_enum(StageStatus, "stage_status"), default=StageStatus.not_started)
    # No FK (stage_runs references this table); integrity is kept by the orchestrator.
    current_stage_run_id: Mapped[uuid.UUID | None] = mapped_column(default=None)
    gate_key: Mapped[GateKey | None] = mapped_column(str_enum(GateKey, "gate_key"), default=None)
    gate_status: Mapped[GateStatus] = mapped_column(str_enum(GateStatus, "gate_status"), default=GateStatus.none)
    stale_reason: Mapped[str | None] = mapped_column(Text, default=None)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)


class StageRun(IdMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "stage_runs"
    __table_args__ = (UniqueConstraint("workflow_stage_id", "version"),)

    workflow_stage_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workflow_stages.id", ondelete="RESTRICT"))
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"), index=True)
    stage_key: Mapped[StageKey] = mapped_column(str_enum(StageKey, "stage_run_stage_key"))
    version: Mapped[int] = mapped_column(Integer)
    status: Mapped[StageStatus] = mapped_column(str_enum(StageStatus, "stage_run_status"), default=StageStatus.queued)
    # No FK: agent_tasks is created in a later migration and references this table.
    agent_task_id: Mapped[uuid.UUID | None] = mapped_column(default=None)
    input_hash: Mapped[str | None] = mapped_column(String(64), default=None)
    upstream_versions: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    parameters: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    output: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    validation_issues: Mapped[list[Any]] = mapped_column(default=json_default_list)
    generated_by: Mapped[GeneratedBy | None] = mapped_column(
        str_enum(GeneratedBy, "stage_run_generated_by"), default=None
    )
    partial: Mapped[bool] = mapped_column(default=False)
    started_at: Mapped[datetime | None] = mapped_column(default=None)
    finished_at: Mapped[datetime | None] = mapped_column(default=None)
    triggered_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    error: Mapped[str | None] = mapped_column(Text, default=None)


class GateDecision(IdMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "gate_decisions"
    __table_args__ = (Index("ix_gate_decisions_project_gate_created", "project_id", "gate_key", "created_at"),)

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))
    gate_key: Mapped[GateKey] = mapped_column(str_enum(GateKey, "decision_gate_key"))
    stage_run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stage_runs.id", ondelete="RESTRICT"))
    decision: Mapped[GateDecisionKind] = mapped_column(str_enum(GateDecisionKind, "gate_decision"))
    comment: Mapped[str] = mapped_column(Text, default="")
    decided_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    agent_recommendation: Mapped[dict[str, Any] | None] = mapped_column(default=None)
