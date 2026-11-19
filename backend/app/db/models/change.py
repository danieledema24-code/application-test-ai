"""Phase 6 change intelligence and release readiness (database-schema.md "Change intelligence and release readiness
(Phase 6)").

Migration `0019_change_intelligence` creates every table and column P6-01 to P6-06 use, up front (P6-00). Change sets,
impact items, heal suggestions and release assessments are append-only records with statuses (spec §13: history is
never deleted). Exploratory sessions are `quality_scans` of kind `exploratory`; their steps are here.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, Integer, String, Text, UniqueConstraint, false
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, IdMixin, TenantMixin, TimestampMixin
from app.db.types import json_default_dict, json_default_list, str_enum
from app.domain.enums import (
    AssessmentDecision,
    AssessmentStatus,
    ChangeKind,
    ChangeSetStatus,
    ChangeSignificance,
    ChosenBy,
    GeneratedBy,
    HealKind,
    HealSource,
    HealStatus,
    ImpactAction,
    ImpactLevel,
    ImpactStatus,
    ImpactTargetKind,
    ManualRetestStatus,
    StepOutcome,
    Verdict,
)


class _ProjectMixin:
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"))


class ChangeSet(IdMixin, TenantMixin, TimestampMixin, _ProjectMixin, Base):
    """P6-01: the comparison of two scan sessions (CHG-0001): the baseline and the rescan."""

    __tablename__ = "change_sets"
    __table_args__ = (
        UniqueConstraint("project_id", "key"),
        Index("ix_change_sets_project_target", "project_id", "target_scan_session_id"),
    )

    key: Mapped[str] = mapped_column(String(32))
    # The `change_analysis` stage run that computed it (null for a comparison a person asked for).
    stage_run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("stage_runs.id", ondelete="RESTRICT"), default=None, index=True
    )
    base_scan_session_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scan_sessions.id", ondelete="RESTRICT"))
    target_scan_session_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("scan_sessions.id", ondelete="RESTRICT"))
    status: Mapped[ChangeSetStatus] = mapped_column(
        str_enum(ChangeSetStatus, "change_set_status"), default=ChangeSetStatus.queued
    )
    # Computed counts by kind and significance.
    summary: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    # P6-02 (decision D28): {must, should, excluded: [{case_lineage_id, reasons[]}]}.
    rerun_recommendation: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    # More than half of the baseline's pages changed: a full re-baseline is recommended, never forced (D27).
    rebaseline_suggested: Mapped[bool] = mapped_column(default=False, server_default=false())
    generated_by: Mapped[GeneratedBy] = mapped_column(
        str_enum(GeneratedBy, "change_set_generated_by"), default=GeneratedBy.rules
    )
    ai_summary: Mapped[str | None] = mapped_column(Text, default=None)  # labelled as AI-written wherever shown
    finished_at: Mapped[datetime | None] = mapped_column(default=None)
    error: Mapped[str | None] = mapped_column(Text, default=None)


class ChangeItem(IdMixin, TenantMixin, TimestampMixin, _ProjectMixin, Base):
    """P6-01: one difference between the two scans (decision D26 matching)."""

    __tablename__ = "change_items"
    __table_args__ = (Index("ix_change_items_set_kind", "change_set_id", "kind"),)

    change_set_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("change_sets.id", ondelete="RESTRICT"))
    kind: Mapped[ChangeKind] = mapped_column(str_enum(ChangeKind, "change_item_kind"))
    significance: Mapped[ChangeSignificance] = mapped_column(str_enum(ChangeSignificance, "change_significance"))
    page_url: Mapped[str | None] = mapped_column(String(2048), default=None)
    # The compared attributes only.
    before: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    after: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    # {page_id, component fingerprint, evidence ids} in each scan.
    before_ref: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    after_ref: Mapped[dict[str, Any] | None] = mapped_column(default=None)


class ImpactItem(IdMixin, TenantMixin, TimestampMixin, _ProjectMixin, Base):
    """P6-02 (decision D27): one artefact a change set affects, and what a person (or a passing rerun) did about it."""

    __tablename__ = "impact_items"
    __table_args__ = (
        Index("ix_impact_items_project_status", "project_id", "status"),
        Index("ix_impact_items_set_target_kind", "change_set_id", "target_kind"),
    )

    change_set_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("change_sets.id", ondelete="RESTRICT"))
    change_item_ids: Mapped[list[Any]] = mapped_column(default=json_default_list)
    target_kind: Mapped[ImpactTargetKind] = mapped_column(str_enum(ImpactTargetKind, "impact_target_kind"))
    target_ref: Mapped[str] = mapped_column(String(64))  # lineage id or row id
    level: Mapped[ImpactLevel] = mapped_column(str_enum(ImpactLevel, "impact_level"))
    action: Mapped[ImpactAction] = mapped_column(str_enum(ImpactAction, "impact_action"))
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[ImpactStatus] = mapped_column(str_enum(ImpactStatus, "impact_status"), default=ImpactStatus.open)
    status_reason: Mapped[str | None] = mapped_column(Text, default=None)
    # Closed by a person, or automatically by a passing execution run (must-run items, P6-02).
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    resolved_by_run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("execution_runs.id", ondelete="RESTRICT"), default=None
    )
    resolved_at: Mapped[datetime | None] = mapped_column(default=None)


class HealSuggestion(IdMixin, TenantMixin, TimestampMixin, _ProjectMixin, Base):
    """P6-04 (decision D31): ranked, verified locator repairs (HEAL-0001), accepted one at a time by a person.

    A `locator` suggestion changes exactly one locator expression in a page object. An `expected_result_review` has
    no accept action: it links the test case whose asserted text changed (expected results are never changed)."""

    __tablename__ = "heal_suggestions"
    __table_args__ = (
        UniqueConstraint("project_id", "key"),
        Index("ix_heal_suggestions_project_status", "project_id", "status"),
    )

    key: Mapped[str] = mapped_column(String(32))
    source: Mapped[HealSource] = mapped_column(str_enum(HealSource, "heal_source"))
    change_item_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("change_items.id", ondelete="RESTRICT"), default=None, index=True
    )
    execution_result_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("execution_results.id", ondelete="RESTRICT"), default=None, index=True
    )
    automation_asset_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("automation_assets.id", ondelete="RESTRICT"), default=None
    )
    asset_version: Mapped[int | None] = mapped_column(Integer, default=None)
    file: Mapped[str | None] = mapped_column(String(300), default=None)
    getter: Mapped[str | None] = mapped_column(String(200), default=None)
    old_expression: Mapped[str | None] = mapped_column(Text, default=None)
    # [{expression, strategy, score, level high|medium|low, signals[], match_count, evidence_id}]
    candidates: Mapped[list[Any]] = mapped_column(default=json_default_list)
    kind: Mapped[HealKind] = mapped_column(str_enum(HealKind, "heal_kind"), default=HealKind.locator)
    test_case_lineage_id: Mapped[uuid.UUID | None] = mapped_column(default=None)
    status: Mapped[HealStatus] = mapped_column(str_enum(HealStatus, "heal_status"), default=HealStatus.open)
    accepted_index: Mapped[int | None] = mapped_column(Integer, default=None)
    new_asset_version: Mapped[int | None] = mapped_column(Integer, default=None)
    decided_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    decided_at: Mapped[datetime | None] = mapped_column(default=None)
    reason: Mapped[str | None] = mapped_column(Text, default=None)
    generated_by: Mapped[GeneratedBy] = mapped_column(
        str_enum(GeneratedBy, "heal_generated_by"), default=GeneratedBy.rules
    )


class ExploratoryStep(IdMixin, TenantMixin, TimestampMixin, _ProjectMixin, Base):
    """P6-03a (decisions D29, D30): one action of an exploratory session, taken from the code-computed allow-list."""

    __tablename__ = "exploratory_steps"
    __table_args__ = (UniqueConstraint("scan_id", "n"),)

    scan_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("quality_scans.id", ondelete="RESTRICT"), index=True)
    n: Mapped[int] = mapped_column(Integer)
    page_url: Mapped[str] = mapped_column(String(2048))
    # {kind, target {role, name, fingerprint}, href?}
    action: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    outcome: Mapped[StepOutcome] = mapped_column(str_enum(StepOutcome, "exploratory_step_outcome"))
    observations: Mapped[list[Any]] = mapped_column(default=json_default_list)
    evidence_ids: Mapped[list[Any]] = mapped_column(default=json_default_list)
    chosen_by: Mapped[ChosenBy] = mapped_column(str_enum(ChosenBy, "exploratory_chosen_by"), default=ChosenBy.rules)


class ReleaseAssessment(IdMixin, TenantMixin, TimestampMixin, _ProjectMixin, Base):
    """P6-05a (decisions D32, D33): a release readiness assessment (REL-0001). The recommendation is computed in code
    and stays advisory until G9; a G9 decision makes it `final`."""

    __tablename__ = "release_assessments"
    __table_args__ = (
        UniqueConstraint("project_id", "key"),
        Index("ix_release_assessments_project_status", "project_id", "status"),
    )

    key: Mapped[str] = mapped_column(String(32))
    stage_run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("stage_runs.id", ondelete="RESTRICT"), default=None, index=True
    )
    status: Mapped[AssessmentStatus] = mapped_column(
        str_enum(AssessmentStatus, "release_assessment_status"), default=AssessmentStatus.awaiting_approval
    )
    recommendation: Mapped[Verdict] = mapped_column(str_enum(Verdict, "release_recommendation"))
    # [{id, text, source exit_criterion|dod|platform, blocking, status met|not_met|not_evaluable, detail,
    #   evidence_refs, manual?}]
    criteria: Mapped[list[Any]] = mapped_column(default=json_default_list)
    conditions: Mapped[list[Any]] = mapped_column(default=json_default_list)
    residual_risks: Mapped[list[Any]] = mapped_column(default=json_default_list)
    overall_residual: Mapped[str | None] = mapped_column(String(32), default=None)
    # Source versions, run ids, change set ids, exploratory session ids, snapshot hash.
    scope: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)
    stale_reason: Mapped[str | None] = mapped_column(Text, default=None)
    decision: Mapped[AssessmentDecision | None] = mapped_column(
        str_enum(AssessmentDecision, "release_assessment_decision"), default=None
    )
    final_verdict: Mapped[Verdict | None] = mapped_column(str_enum(Verdict, "release_final_verdict"), default=None)
    override_reason: Mapped[str | None] = mapped_column(Text, default=None)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    decided_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), default=None)
    decided_at: Mapped[datetime | None] = mapped_column(default=None)
    generated_by: Mapped[GeneratedBy] = mapped_column(
        str_enum(GeneratedBy, "release_assessment_generated_by"), default=GeneratedBy.rules
    )
    ai_sections: Mapped[dict[str, Any]] = mapped_column(default=json_default_dict)


class ManualRetest(IdMixin, TenantMixin, TimestampMixin, _ProjectMixin, Base):
    """D37 (P6-05a): a person's result for an impacted manual must-run test of a change set, re-tested by hand.
    Append-only: the latest row per (change set, case) counts for `rr.impacted_rerun`. Migration 0020."""

    __tablename__ = "manual_retests"
    __table_args__ = (Index("ix_manual_retests_set_case", "change_set_id", "case_lineage_id"),)

    change_set_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("change_sets.id", ondelete="RESTRICT"))
    case_lineage_id: Mapped[uuid.UUID] = mapped_column()
    test_case_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("test_cases.id", ondelete="RESTRICT"))
    status: Mapped[ManualRetestStatus] = mapped_column(str_enum(ManualRetestStatus, "manual_retest_status"))
    note: Mapped[str] = mapped_column(Text)
    recorded_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
