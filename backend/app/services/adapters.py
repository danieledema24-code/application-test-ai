"""Row adapters for the regeneration review and revisions: which fields make up an item's reviewable content."""

from __future__ import annotations

from typing import Any

from app.db.models import AcceptanceCriterion, ReadinessCriterion, Requirement, Risk
from app.domain.enums import ItemStatus, ReadinessStatus, RequirementStatus, RiskStatus
from app.services.review import RowAdapter

REQUIREMENT = RowAdapter(
    "requirement",
    Requirement,
    (
        ("title", "title"),
        ("description", "description"),
        ("type", "type"),
        ("category", "category"),
        ("behaviour_scope", "behaviour_scope"),
        ("classification", "provenance"),
        ("assumptions", "assumptions"),
    ),
    user_source_attr="source",
)
ACCEPTANCE_CRITERION = RowAdapter(
    "acceptance_criterion",
    AcceptanceCriterion,
    (
        ("kind", "kind"),
        ("given", "given_text"),
        ("when", "when_text"),
        ("then", "then_text"),
        ("classification", "provenance"),
        ("test_values", "test_values"),
    ),
)
READINESS = RowAdapter(
    "readiness_criterion",
    ReadinessCriterion,
    (("kind", "kind"), ("scope", "scope"), ("text", "text"), ("check_rule_id", "check_rule_id")),
    rejected_value="removed",
    approved_value=None,
)
RISK = RowAdapter(
    "risk",
    Risk,
    (
        ("title", "title"),
        ("description", "description"),
        ("category", "category"),
        ("likelihood", "likelihood"),
        ("impact", "impact"),
        ("mitigation", "mitigation"),
    ),
    rejected_value=None,
    approved_value=None,
    user_source_attr="source",
)

# Snapshot fields used for revisions (everything a user can change, plus code-owned labels).
REQUIREMENT_SNAPSHOT = (
    "title",
    "description",
    "type",
    "category",
    "behaviour_scope",
    "provenance",
    "confidence",
    "evidence_refs",
    "assumptions",
    "feature_ids",
    "status",
    "status_comment",
    "locked",
)
AC_SNAPSHOT = (
    "kind",
    "given_text",
    "when_text",
    "then_text",
    "provenance",
    "confidence",
    "evidence_refs",
    "status",
    "locked",
    "test_values",
)
READINESS_SNAPSHOT = ("kind", "scope", "text", "status", "locked", "check_rule_id")
RISK_SNAPSHOT = (
    "title",
    "description",
    "category",
    "likelihood",
    "impact",
    "score",
    "level",
    "likelihood_rationale",
    "impact_rationale",
    "mitigation",
    "status",
    "status_comment",
    "locked",
    "requirement_lineage_ids",
    "feature_ids",
)


def snapshot(row: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    from app.services.revisions import jsonable

    return {f: jsonable(getattr(row, f)) for f in fields}


def reject_requirement(row: Requirement, note: str) -> None:
    row.status = RequirementStatus.rejected
    row.status_comment = note


def reject_ac(row: AcceptanceCriterion, note: str) -> None:
    row.status = ItemStatus.rejected


def remove_readiness(row: ReadinessCriterion, note: str) -> None:
    row.status = ReadinessStatus.removed


def accept_risk(row: Risk, note: str) -> None:
    row.status = RiskStatus.accepted
    row.status_comment = note
