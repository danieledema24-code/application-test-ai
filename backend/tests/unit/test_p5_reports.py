"""P5-04a report helpers: the CSV formula guard and HTML escaping of a hostile finding title, the plain-language
performance paragraph, and server-side chart coordinates."""

from __future__ import annotations

import csv
import io
from typing import Any

from app.agents.reporting import phase5_reports as p5
from app.agents.reporting.phase2_reports import render_html

HOSTILE = '=HYPERLINK("http://x")'


def _a11y(title: str) -> dict[str, Any]:
    f = {"key": "A11Y-0001-01", "rule_id": "image-alt", "severity": "critical", "title": title, "path": "/p",
         "viewport": "desktop", "nodes": [{"target": "<img onerror=alert(1)>"}], "references": [], "status": "open",
         "status_reason": None, "status_by": None, "seen_before": None, "defect": None,
         "mapped": {"requirements": [], "test_cases": []}, "heuristic": False, "needs_review": False}  # fmt: skip
    scan = {"pages": 1, "viewports": ["desktop"], "keyboard": False, "signed_in": False, "tool_versions": {},
            "status_label": "Finished"}  # fmt: skip
    return {"report_type": "accessibility", "title": "Accessibility Report", "project": {"name": "P"}, "version": 1,
            "generated_at": "2026-11-15T10:00:00", "source_key": "A11Y-0001", "statement": "S", "scan": scan,
            "findings": [f], "not_checked": [], "summary": "x", "by_severity": {}, "by_wcag": {},
            "rules": [{"rule_id": "image-alt", "title": title, "severity": "critical", "wcag": [], "findings": [f]}],
            "needs_review": [], "keyboard": [], "keyboard_findings": []}  # fmt: skip


def test_csv_guards_formulas_and_html_escapes_markup() -> None:
    content = _a11y(HOSTILE)
    rows = list(csv.reader(io.StringIO(p5.to_csv(content).decode("utf-8").lstrip("﻿"))))
    assert rows[1][3] == "'" + HOSTILE
    doc = render_html(content)
    assert "<img onerror" not in doc and "&lt;img onerror=alert(1)&gt;" in doc
    assert "=HYPERLINK(&#34;http://x&#34;)" in doc


def test_paragraph_names_the_slow_page_and_stopped_runs_are_not_judged() -> None:
    run = {"status": "failed", "limits": {"test": {"vus": 10}},
           "threshold_results": [
               {"metric": "p95", "scope": "path", "path": "/products/2", "value": 800, "measured": 1400, "result": "missed"},
               {"metric": "p95", "scope": "path", "path": "/", "value": 800, "measured": 60, "result": "met"}],
           "profile_snapshot": {"targets": [{"path": "/products/2", "title": "Desk lamp · Demo Shop"}]}}  # fmt: skip
    assert p5.paragraph(run) == (
        "With up to 10 virtual users, 1 of 2 pages stayed within their thresholds. The Desk lamp page (/products/2) "
        "was slow: 95 % of its requests were faster than 1.4 s, and the threshold is 800 ms."
    )
    stopped = {**run, "status": "aborted", "aborted_reason": "Stopped automatically: 100 % errors over 10 s"}
    assert p5.paragraph(stopped).startswith("Stopped automatically: 100 % errors over 10 s. Measurements cover")


def test_chart_scales_points_and_threshold() -> None:
    ch = p5.chart([{"t": 1, "p95_ms": 100}, {"t": 2, "p95_ms": 400}], "p95_ms", "Response time (p95)", "ms", 800)
    assert ch["points"].count(",") == 2 and ch["threshold_text"] == "800 ms"
    assert ch["rows"] == [{"t": 1, "value": "100 ms"}, {"t": 2, "value": "400 ms"}]
    assert p5.chart([], "rps", "Requests a second", "rps")["points"] == ""


def test_xlsx_has_the_csv_rows_no_formulas_and_the_draft_band() -> None:
    """P5-04b: one sheet per table with the CSV's rows, values only, filters on the header; Summary line 1 is the
    same band text as the HTML."""
    from openpyxl import load_workbook

    from app.agents.reporting import xlsx

    content = _a11y(HOSTILE)
    data = p5.to_csv(content)
    book = load_workbook(io.BytesIO(xlsx.to_xlsx(content, [("Findings", data)])))
    assert book.sheetnames == ["Summary", "Findings"]
    sheet = book["Findings"]
    rows = list(csv.reader(io.StringIO(data.decode("utf-8").lstrip("﻿"))))
    assert sheet.max_row == len(rows) and sheet.auto_filter.ref
    cells = [c for row in sheet.iter_rows() for c in row]
    assert all(c.data_type != "f" for c in cells) and "'" + HOSTILE in [c.value for c in cells]
    assert book["Summary"]["A1"].value == "Report"  # no band: a frozen check report is never a draft
    defect = {"report_type": "defect", "title": "Defect Report", "project": {"name": "P"}, "generated_at": "x",
              "draft_note": "DRAFT: 2 defects not yet reviewed at Gate 8"}  # fmt: skip
    book = load_workbook(io.BytesIO(xlsx.to_xlsx(defect, [("Defects", b"Defect\r\n=1+1\r\n")])))
    assert book["Summary"]["A1"].value == "DRAFT: 2 defects not yet reviewed at Gate 8"
    assert book["Defects"]["A2"].data_type == "s"
