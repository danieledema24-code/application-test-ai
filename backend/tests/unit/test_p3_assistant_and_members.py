"""P3-06 keyword routing and citation tokens; P3-07 email masking; P3-08 CSV formula guard."""

from __future__ import annotations

from app.agents.reporting.phase3_reports import safe_cell, to_csv
from app.api.routers.members import mask_email
from app.services.assistant import INTENTS, KEY_RE, route


def test_routes_test_design_questions() -> None:
    assert route("Generate more negative test cases for REQ-0002") == (
        "propose_negative_cases",
        {"requirement_key": "REQ-0002"},
    )
    assert route("Build regression scenarios for the high risks") == (
        "propose_regression_suite",
        {"scope": "high_risk"},
    )
    assert route("Explain TC-0004") == ("explain_test_case", {"key": "TC-0004"})
    assert route("Which tests cover REQ-0003?") == ("traceability_for", {"key": "REQ-0003"})
    assert route("Review test coverage") == ("coverage_summary", {})
    assert route("Which test cases are still in draft?") == ("list_test_cases", {"status": "draft"})
    assert route("Regenerate the test cases") == ("propose_regenerate", {"stage": "test_design"})
    assert route("Add negative criteria to REQ-0001") == ("propose_negative_criteria", {"requirement_key": "REQ-0001"})


def test_citation_tokens_include_test_design_keys() -> None:
    assert [m.group(0) for m in KEY_RE.finditer("TC-0999, TCOND-0001 and TD-0004 vs REQ-0001")] == [
        "TC-0999", "TCOND-0001", "TD-0004", "REQ-0001",
    ]  # fmt: skip
    assert INTENTS["propose_test_case_update"].requires_ai and INTENTS["propose_missing_test_cases"].requires_ai


def test_email_mask() -> None:
    assert mask_email("jane.doe@example.com") == "j***@example.com"
    assert mask_email("x@example.org") == "x***@example.org"


def test_csv_formula_guard_and_bom() -> None:
    assert safe_cell('=HYPERLINK("http://x")') == '\'=HYPERLINK("http://x")'
    for lead in ("+", "-", "@", "\t", "\r"):
        assert safe_cell(f"{lead}1") == f"'{lead}1"
    assert safe_cell("Plain") == "Plain" and safe_cell(None) == ""
    content = {
        "report_type": "rtm",
        "forward": [
            {"requirement": {"key": "REQ-0001", "label": "REQ-0001 · =cmd"}, "requirement_status": "approved",
             "risk": None, "acceptance_criteria": [], "test_cases": []},
        ],
    }  # fmt: skip
    raw = to_csv(content)
    assert raw.startswith("﻿".encode())
    text = raw.decode("utf-8-sig")
    assert "'=cmd" in text and "No test case" in text and "Not available until Phase 4" in text
