"""Row adapters for the regeneration review and revisions: which fields make up an item's reviewable content."""

from __future__ import annotations

from typing import Any

from app.db.models import AcceptanceCriterion, ReadinessCriterion, Requirement, Risk, TestCase, TestCondition, TestData
from app.domain.enums import CaseStatus, ItemStatus, ReadinessStatus, RequirementStatus, RiskStatus, TestDataStatus
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
TEST_CONDITION = RowAdapter(
    "test_condition",
    TestCondition,
    (
        ("title", "title"),
        ("description", "description"),
        ("technique", "technique"),
        ("test_type", "test_type"),
        ("design_basis", "design_basis"),
        ("coverage_items", "coverage_items"),
        ("notes", "notes"),
        ("classification", "provenance"),
        ("requirement_lineage_ids", "requirement_lineage_ids"),
    ),
)
TEST_CASE = RowAdapter(
    "test_case",
    TestCase,
    (
        ("title", "title"),
        ("objective", "objective"),
        ("preconditions", "preconditions"),
        ("steps", "steps"),
        ("expected_result", "expected_result"),
        ("expected_result_status", "expected_result_status"),
        ("technique", "technique"),
        ("test_type", "test_type"),
        ("test_level", "test_level"),
        ("suites", "suites"),
        ("side_effects", "side_effects"),
        ("classification", "provenance"),
        ("requirement_lineage_ids", "requirement_lineage_ids"),
        ("ac_lineage_ids", "ac_lineage_ids"),
    ),
    user_source_attr="source",
)
# Revisions and review content never use a key the redactor would mask ("secret"): the reference is a name only.
TEST_DATA = RowAdapter(
    "test_data",
    TestData,
    (
        ("name", "name"),
        ("field_label", "field_label"),
        ("kind", "kind"),
        ("value_type", "value_type"),
        ("value", "value"),
        ("account_ref", "secret_ref"),
        ("length", "length"),
    ),
    rejected_value="retired",
    approved_value=None,
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


TEST_CONDITION_SNAPSHOT = (
    "title",
    "description",
    "technique",
    "test_type",
    "design_basis",
    "coverage_items",
    "notes",
    "provenance",
    "confidence",
    "status",
    "status_comment",
    "locked",
    "requirement_lineage_ids",
    "ac_lineage_ids",
)
TEST_CASE_SNAPSHOT = (
    "title",
    "objective",
    "preconditions",
    "steps",
    "expected_result",
    "expected_result_status",
    "open_question_ref",
    "technique",
    "test_type",
    "test_level",
    "suites",
    "side_effects",
    "provenance",
    "confidence",
    "status",
    "status_comment",
    "locked",
    "priority_override",
    "priority_override_reason",
    "requirement_lineage_ids",
    "ac_lineage_ids",
    "data_lineage_ids",
    "condition_lineage_id",
)
TEST_DATA_SNAPSHOT = ("name", "field_label", "kind", "value_type", "value", "length", "status", "locked")


def data_snapshot(row: TestData) -> dict[str, Any]:
    """Revision snapshot of a test data item; the credentials reference is stored under a non-masked key."""
    return {**snapshot(row, TEST_DATA_SNAPSHOT), "account_ref": row.secret_ref}


def reject_case(row: TestCase, note: str) -> None:
    row.status = CaseStatus.rejected
    row.status_comment = note


def reject_condition(row: TestCondition, note: str) -> None:
    row.status = ItemStatus.rejected
    row.status_comment = note


def retire_data(row: TestData, note: str) -> None:
    row.status = TestDataStatus.retired
