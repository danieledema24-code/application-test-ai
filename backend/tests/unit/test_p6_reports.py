"""P6-05c report helpers: the DRAFT band per assessment state, the Gate 9 and override lines, file names, the CSV
sections (band first, formula guard), HTML escaping and the check on AI lessons learned (no numbers, no unknown keys)."""

from __future__ import annotations

import csv
import io
from types import SimpleNamespace
from typing import Any

import pytest
from openpyxl import load_workbook

from app.agents.reporting import phase6_reports as p6
from app.agents.reporting import xlsx
from app.agents.reporting.phase2_reports import render_html
from app.domain.enums import AssessmentStatus

HOSTILE = '=HYPERLINK("http://x")'


def _a(status: AssessmentStatus, superseded_by: str | None = None) -> Any:
    return SimpleNamespace(key="REL-0002", status=status, scope={"superseded_by": superseded_by})


@pytest.mark.parametrize(
    ("status", "band"),
    [
        (AssessmentStatus.awaiting_approval, "DRAFT: Gate 9 not decided for REL-0002."),
        (AssessmentStatus.rejected, "DRAFT: Gate 9 not decided for REL-0002."),
        (AssessmentStatus.stale, "DRAFT: REL-0002 is out of date and can't be decided."),
        (AssessmentStatus.final, None),
    ],
)
def test_band_until_final(status: AssessmentStatus, band: str | None) -> None:
    assert p6.band_for(_a(status)) == band


def test_band_of_a_replaced_assessment_names_its_successor() -> None:
    assert p6.band_for(_a(AssessmentStatus.superseded, "REL-0003")) == (
        "DRAFT: REL-0002 was replaced by REL-0003 and can't be decided."
    )


def _d(**over: Any) -> dict[str, Any]:
    d = {"status": "final", "decision": "approve", "decided_by": {"full_name": "A. Approver"},
         "decided_at": "2026-11-15T16:30:00+00:00", "recommendation": "conditional", "final_verdict": "conditional",
         "verdict": "conditional", "verdict_state": "final", "override_reason": None, "stale_reason": None,
         "superseded_by": None}  # fmt: skip
    return {**d, **over}


def test_decision_and_override_lines() -> None:
    assert p6.decision_line(_d()) == "Decided by A. Approver, 15 Nov 2026, 16:30 UTC"
    assert p6.override_text(_d()) is None
    reason = "Customer demo needs it; DEF-0007 is cosmetic"
    over = _d(decision="override", final_verdict="go", verdict="go", override_reason=reason)
    assert p6.verdict_text(over) == "Go · Final"
    assert p6.override_text(over) == f"Overridden by A. Approver: '{reason}' (recommended: Conditional)"
    waiting = _d(status="awaiting_approval", decision=None, verdict_state="recommended", decided_by=None)
    assert p6.verdict_text(waiting) == "Conditional · Recommended"
    assert p6.decision_line(waiting) == "Gate 9: waiting for a decision by someone who can approve."
    stale = _d(status="stale", decision=None, stale_reason="RUN-0006 finished at 16:20 UTC")
    assert p6.decision_line(stale) == (
        "Gate 9: not decided. Evidence changed after this assessment (RUN-0006 finished at 16:20 UTC)."
    )
    rejected = _d(status="rejected", decision="reject", override_reason="Re-test first")
    assert p6.decision_line(rejected).startswith("Rejected by A. Approver, 15 Nov 2026, 16:30 UTC: 'Re-test first'")


def test_file_names() -> None:
    rr = {"report_type": "release_readiness", "source_key": "REL-0002", "generated_at": "2026-11-15T16:00:00"}
    assert p6.file_name("shop.example.com", rr, "pdf") == "shop.example.com-release-readiness-REL-0002-2026-11-15.pdf"
    tc = {"report_type": "completion", "source_key": "current", "generated_at": "2026-11-15T16:00:00"}
    assert p6.file_name("localhost", tc, "xlsx") == "localhost-test-completion-current-2026-11-15.xlsx"


def _readiness(band: str | None, text: str) -> dict[str, Any]:
    crit = {"id": "exit.text.1", "text": text, "blocking": False, "blocking_text": "Not blocking",
            "status": "not_evaluable", "status_text": "Not evaluable", "source_label": "Exit criterion (Test Strategy v2)",
            "evidence": "", "detail": "The platform can't check this: confirm it", "confirmed": None,
            "confirmed_by": None, "confirm_reason": None}  # fmt: skip
    return {"report_type": "release_readiness", "title": "Release Readiness Report", "project": {"name": "P"},
            "version": 1, "generated_at": "2026-11-15T16:00:00", "source_key": "REL-0002", "band": band,
            "statement": "S", "assessment": {"status": "awaiting_approval", "assessed_at": None, "created_by": None},
            "verdict_text": "Conditional · Recommended", "override_text": HOSTILE if band else None, "reason": "r", "decision_line": "d",
            "narrative": None, "criteria": [crit], "conditions": [{"text": f"Confirm: {text}", "blocking": False,
                                                                   "evidence": ""}],
            "residual": [], "overall_residual": None, "changes": {"previous": None, "parts": [], "text": "first"},
            "limitations": [p6.NO_DOCX]}  # fmt: skip


def test_csv_sections_band_first_and_formula_guard() -> None:
    content = _readiness("DRAFT: Gate 9 not decided for REL-0002.", HOSTILE)
    rows = list(csv.reader(io.StringIO(p6.to_csv(content).decode("utf-8").lstrip("﻿"))))
    assert rows[0] == ["DRAFT: Gate 9 not decided for REL-0002."]
    # Then the summary: verdict, reason, the Gate 9 line and the override (formula-guarded).
    assert rows[2:8] == [["Summary"], ["Assessment", "REL-0002"], ["Verdict", "Conditional · Recommended"],
                         ["Reason", "r"], ["Gate 9", "d"], ["Override", "'" + HOSTILE]]  # fmt: skip
    assert rows[9] == ["Criteria"] and rows[10][0] == "Criterion" and rows[11][0] == "'" + HOSTILE
    assert ["Conditions"] in rows and ["Residual risk"] in rows
    assert xlsx.band_text(content) == "DRAFT: Gate 9 not decided for REL-0002."
    assert [name for name, _ in p6.xlsx_tables(content)] == ["Criteria", "Conditions", "Residual risk"]
    final = p6.to_csv(_readiness(None, "Stakeholders signed off")).decode("utf-8").lstrip("﻿")
    assert final.startswith("Summary\r\nAssessment,REL-0002\r\n")


def test_xlsx_summary_has_the_band_then_verdict_gate9_and_override() -> None:
    content = _readiness("DRAFT: Gate 9 not decided for REL-0002.", "x")
    book = load_workbook(io.BytesIO(xlsx.to_xlsx(content, p6.xlsx_tables(content), p6.summary_rows(content))))
    rows = [[c.value for c in r] for r in book["Summary"].iter_rows()]
    assert rows[0][0] == "DRAFT: Gate 9 not decided for REL-0002."
    assert rows[1:6] == [["Assessment", "REL-0002"], ["Verdict", "Conditional · Recommended"], ["Reason", "r"],
                         ["Gate 9", "d"], ["Override", "'" + HOSTILE]]  # fmt: skip


def test_completion_summary_names_its_assessment_or_current_data() -> None:
    cur = {"report_type": "completion", "release": {"key": None, "text": "Current data, not tied to an assessment."}}
    assert p6.summary_rows(cur) == [["Based on", "Current data, not tied to an assessment."]]
    rel = {"report_type": "completion", "release": {"key": "REL-0003", "verdict_text": "Go · Final", "reason": "ok",
                                                    "decision_line": "Decided by A. Approver", "override_text": None}}  # fmt: skip
    assert p6.summary_rows(rel)[:2] == [["Assessment", "REL-0003"], ["Verdict", "Go · Final"]]


def test_html_escapes_and_puts_the_statement_first() -> None:
    doc = render_html(_readiness("DRAFT: Gate 9 not decided for REL-0002.", "<script>alert(1)</script>"))
    assert "<script>alert" not in doc and "&lt;script&gt;alert(1)&lt;/script&gt;" in doc
    body = doc.split("<body>", 1)[1]
    assert body.index("DRAFT: Gate 9 not decided") < body.index('class="statement"') < body.index("<h2>")
    assert "No Word (DOCX) export." in doc


@pytest.mark.parametrize(
    ("text", "why"),
    [
        ("Fix DEF-0001 sooner and keep the contact form in every regression run.", None),
        ("Most tests passed: 97 % is good, keep it up next time around.", "it writes a number"),
        ("Three failures were found; re-run TC-0099 earlier next time.", "it names TC-0099, which isn't in the data"),
    ],
)
def test_ai_lessons_never_write_numbers_or_unknown_keys(text: str, why: str | None) -> None:
    assert p6.check_lessons(text, {"DEF-0001", "TC-0012"}) == why
