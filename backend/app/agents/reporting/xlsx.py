"""XLSX for table reports (P5-04b, decision D21): the same rows as the CSV, one sheet per table, plus a Summary sheet.

Built from the report's CSV bytes so the row counts are equal by construction. Every cell is written as a value,
never a formula: cells already carry the CSV formula guard (`safe_cell`), and string cells are forced to the text
type so a leading "=" can't become a formula. Each table sheet has a header row with filters and a frozen header.
"""

from __future__ import annotations

import csv
import io
import re
from typing import Any

from openpyxl import Workbook
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter

NUMBER = re.compile(r"^\d{1,15}(\.\d{1,6})?$")
MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
DOCUMENT_ONLY = "XLSX is available for table reports"


def band_text(content: dict[str, Any]) -> str | None:
    """Line 1 of the Summary sheet: the same band text as the HTML (design P5 §11.3)."""
    t = content.get("report_type")
    if t == "defect":
        return content.get("draft_note") or None
    if t in ("test_case_spec", "rtm"):
        ap = content.get("approval") or {}
        return None if ap.get("status") == "approved" else f"DRAFT: not the approved version ({ap.get('gate') or 'G5'})"
    return None


def _rows(data: bytes) -> list[list[str]]:
    return list(csv.reader(io.StringIO(data.decode("utf-8").lstrip("﻿"))))


def _value(text: str) -> Any:
    if NUMBER.match(text):
        return float(text) if "." in text else int(text)
    return text


def _sheet(wb: Workbook, title: str, rows: list[list[str]]) -> None:
    ws = wb.create_sheet(title[:31])
    for r in rows:
        ws.append([_value(v) for v in r])
    for row in ws.iter_rows():
        for cell in row:
            if isinstance(cell.value, str):
                cell.data_type = "s"  # never a formula, whatever the text starts with
    if rows:
        for cell in ws[1]:
            cell.font = Font(bold=True)
        last = get_column_letter(max(len(r) for r in rows))
        ws.auto_filter.ref = f"A1:{last}{len(rows)}"
        ws.freeze_panes = "A2"
        for i in range(1, max(len(r) for r in rows) + 1):
            ws.column_dimensions[get_column_letter(i)].width = 22


def to_xlsx(content: dict[str, Any], tables: list[tuple[str, bytes]]) -> bytes:
    """`tables`: (sheet name, CSV bytes) in order. Returns the workbook bytes."""
    wb = Workbook()
    summary = wb.active
    assert summary is not None
    summary.title = "Summary"
    band = band_text(content)
    lines: list[list[str]] = []
    if band:
        lines.append([band])
    project = content.get("project") or {}
    lines += [
        ["Report", str(content.get("title") or "")],
        ["Project", str(project.get("name") or "")],
        ["Generated", str(content.get("generated_at") or "")],
    ]
    if content.get("source_key"):
        lines.append(["Source", str(content["source_key"])])
    lines.append(["Sheets", ", ".join(name for name, _ in tables)])
    lines.append(["Note", "Values only: this workbook contains no formulas."])
    for ln in lines:
        summary.append(ln)
    for row in summary.iter_rows():
        for cell in row:
            if isinstance(cell.value, str):
                cell.data_type = "s"
    summary["A1"].font = Font(bold=True)
    summary.column_dimensions["A"].width = 18
    summary.column_dimensions["B"].width = 80
    for name, data in tables:
        _sheet(wb, name, _rows(data))
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


SHEET_NAMES = {
    "test_case_spec": "Test cases",
    "rtm": "Traceability",
    "execution": "Results",
    "defect": "Defects",
    "performance": "Pages",
    "accessibility": "Findings",
    "security": "Rules",
}
