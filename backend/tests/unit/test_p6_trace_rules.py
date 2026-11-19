"""P6-06 rules without a database: keyword routing of the Phase 6 questions, which DoD items count as regression
items, and the regression DoD rule's three outcomes (design P6 §12.2)."""

from __future__ import annotations

from typing import Any

import pytest

from app.agents.readiness.rules import NO_CHANGE_SET, Facts, evaluate, text_rule_for
from app.domain.enums import ReadinessKind
from app.services.assistant import LATER_PHASE, RELEASE_CLAIM, RULES_ONLY, route


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("What changed?", ("what_changed", {})),
        ("What has changed since the last scan?", ("what_changed", {})),
        ("Summarise CHG-0001", ("what_changed", {})),
        ("What does the change affect?", ("impact_summary", {})),
        ("Can we release?", ("release_readiness_summary", {})),
        ("Is REL-0002 final?", ("release_readiness_summary", {})),
        ("Are we ready to ship?", ("release_readiness_summary", {})),
        ("Are we ready for release?", ("release_readiness_summary", {})),
        ("Propose a regression run", ("propose_regression_run", {})),
        ("Explain heal-0001", ("explain_heal", {"key": "HEAL-0001"})),
        ("Explore the new and changed pages", ("propose_exploration", {})),
        ("Explore signed in", ("propose_exploration", {"signed_in": True})),
        # Earlier routes are unchanged.
        ("Re-run the failed tests", ("propose_rerun", {"only_failed": True})),
        ("Raise the impact of RISK-001", ("risk_summary", {})),
        ("Build a regression set for the high risks", ("propose_regression_suite", {"scope": "high_risk"})),
        # QA P6-06: release questions in other wording; earlier-phase questions keep their routes.
        ("Is it safe to ship?", ("release_readiness_summary", {})),
        ("Can we go to production?", ("release_readiness_summary", {})),
        ("Is the release a go?", ("release_readiness_summary", {})),
        ("go/no-go?", ("release_readiness_summary", {})),
        ("Is it ready to go live?", ("release_readiness_summary", {})),
        ("Propose a regression suite for the high risks", ("propose_regression_suite", {"scope": "high_risk"})),
        ("What is the impact of DEF-0003?", ("analyse_defect", {"key": "DEF-0003"})),
        ("What changed in REQ-0001?", ("explain_requirement", {"key": "REQ-0001"})),
        ("What changed in CHG-0001?", ("what_changed", {})),
    ],
)
def test_routes(text: str, expected: tuple[str, dict[str, Any]] | None) -> None:
    assert route(text) == expected


def test_reading_about_exploration_is_not_a_proposal() -> None:
    got = route("What did the exploratory session find?")
    assert got is None or got[0] != "propose_exploration"


@pytest.mark.parametrize(
    ("answer", "claims"),
    [
        ("Yes: Go. The site is ready to release, everything passed.", True),
        ("It is safe to ship today.", True),
        ("The build can be released now.", True),
        ("The verdict is No-go.", True),
        ("The project has one approved requirement and one test case.", False),
        ("Go to Requirements to review REQ-0001 first", False),
    ],
)
def test_release_claims_in_model_answers(answer: str, claims: bool) -> None:
    assert bool(RELEASE_CLAIM.search(answer)) is claims


def test_release_and_change_questions_are_rules_only_and_later_phases_are_past_phase_6() -> None:
    assert {"what_changed", "release_readiness_summary"} == RULES_ONLY
    assert [x["label"] for x in LATER_PHASE] == [
        "Hosted deployment (Postgres, Redis, file storage, container sandbox)",
        "API testing",
        "Word (DOCX) reports",
    ]
    assert all("Phase 6" not in x["needs"] and x["available_from_phase"] > 6 for x in LATER_PHASE)


@pytest.mark.parametrize(
    ("kind", "text", "rule"),
    [
        (ReadinessKind.dod, "Regression tests pass", "dod.regression"),
        (ReadinessKind.dod, "Fixed defects are re-tested", None),  # the defect workflow, not a change set (QA P6-06)
        (ReadinessKind.dod, "Regression tests cover the fixed defects", "dod.regression"),
        (ReadinessKind.dod, "Tests pass after the change", "dod.regression"),
        (ReadinessKind.dod, "Post-change smoke tests pass", "dod.regression"),
        (ReadinessKind.dod, "Impacted tests are re-run after changes", "dod.regression"),
        (ReadinessKind.dod, "Every affected test is retested after changes", "dod.regression"),
        (ReadinessKind.dod, "Accessibility is checked after changes", "dod.nf.accessibility"),  # non-functional wins
        (ReadinessKind.dod, "The traceability matrix is up to date", None),
        (ReadinessKind.dor, "Regression scope agreed", None),  # only Definition of Done items
    ],
)
def test_text_rule_for(kind: ReadinessKind, text: str, rule: str | None) -> None:
    assert text_rule_for(kind, text) == rule


def _reg(**kw: Any) -> dict[str, Any]:
    return {"change_set": "CHG-0001", "reason": None, "must": [], "pending": [], "manual_pending": [], "runs": [],
            **kw}  # fmt: skip


@pytest.mark.parametrize(
    ("regression", "status", "detail"),
    [
        (None, "unknown", NO_CHANGE_SET),
        (_reg(reason="Impact is worked out when the comparison has finished"), "unknown",
         "Not evaluable: Impact is worked out when the comparison has finished"),
        (_reg(), "met", "Met: CHG-0001 has no must-run tests"),
        (_reg(must=["TC-0019", "TC-0020"], pending=["TC-0019", "TC-0020"]), "not_met",
         "Not met: 2 impacted tests not re-run since CHG-0001 (TC-0019, TC-0020)"),
        (_reg(must=["TC-0019"], pending=["TC-0019"]), "not_met",
         "Not met: 1 impacted test not re-run since CHG-0001 (TC-0019)"),
        (_reg(must=["TC-0019", "TC-0030"], manual_pending=["TC-0030"], runs=["RUN-0005"]), "unknown",
         "Not evaluable: manual must-run tests from CHG-0001 without a recorded re-test (TC-0030)"),
        (_reg(must=["TC-0019", "TC-0020"], runs=["RUN-0005"]), "met",
         "Met: every must-run test from CHG-0001 has a result (RUN-0005)"),
    ],
)  # fmt: skip
def test_regression_rule(regression: dict[str, Any] | None, status: str, detail: str) -> None:
    res = evaluate("dod.regression", Facts(regression=regression))
    assert res == {"status": status, "detail": detail, "evidence": []}
    assert status != "met" or regression is not None  # never "Met" without a change set
