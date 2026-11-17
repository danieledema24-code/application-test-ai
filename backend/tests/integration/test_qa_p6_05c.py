"""QA (independent) for P6-05c: Test Completion and Release Readiness reports (D34).

Probes beyond the developer's tests: Gate 9 reject and approve each freeze a new Release Readiness Report and leave the
older one out of date; a superseded assessment's report generated again carries the "replaced" band in HTML, PDF text,
CSV and XLSX; the formula guard on person names, confirmation reasons and defect summaries in CSV and XLSX; HTML
escaping of override reasons, lessons learned and test titles; no email in any format (PDF text included) even when a
person has no name; every result status counted as the coverage API counts it; the lessons-suggestion endpoint's
roles, tenants and key/number rules; bad bodies are 422, never 500.
"""

from __future__ import annotations

import csv
import io
import re
import uuid
import zipfile
from typing import Any

import pytest
from openpyxl import load_workbook
from pypdf import PdfReader
from sqlalchemy import select, update

from app.db.models import ExecutionResult, ExecutionRun, GateDecision, TestCase, User
from app.db.tenant import BYPASS
from app.domain.enums import CaseStatus, GateKey, GeneratedBy, Provenance
from app.llm.base import FakeLLM
from tests.conftest import CtxFactory, client_for, public_resolver, site_transport, worker_for
from tests.integration.test_p6_release import EXIT, Team, _team, assess, fixture_project, team  # noqa: F401

EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
XSS = "<script>alert('x')</script><img src=x onerror=alert(1)>"


async def _ready(t: Team, pid: uuid.UUID, rtype: str, key: str | None = None) -> list[dict[str, Any]]:
    await worker_for(t.ctx).run_until_idle(timeout=120)
    rows = (await t.get(f"/projects/{pid}/reports")).json()
    mine = sorted((r for r in rows if r["report_type"] == rtype and (key is None or r["run_key"] == key)),
                  key=lambda r: -r["version"])  # fmt: skip
    assert all(r["status"] == "ready" for r in mine), [(r["version"], r["status"], r["error"]) for r in mine]
    return mine


async def _files(t: Team, rid: str) -> dict[str, bytes]:
    out = {}
    for fmt in ("json", "html", "pdf", "csv", "xlsx"):
        r = await t.client.get(f"/api/v1/reports/{rid}/download?format={fmt}", headers=t.owner.headers,
                               follow_redirects=True)  # fmt: skip
        assert r.status_code == 200, (fmt, r.text)
        out[fmt] = r.content
    return out


def _pdf_text(data: bytes) -> str:
    return "\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(data)).pages)


def _xlsx_raw(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return "".join(z.read(n).decode("utf-8", errors="replace") for n in z.namelist() if n.endswith(".xml"))


def _csv(data: bytes) -> list[list[str]]:
    return list(csv.reader(io.StringIO(data.decode("utf-8").lstrip("﻿"))))


def _sheets(data: bytes) -> dict[str, list[list[Any]]]:
    book = load_workbook(io.BytesIO(data))
    return {ws.title: [[c.value for c in row] for row in ws.iter_rows()] for ws in book.worksheets}


def _all_text(files: dict[str, bytes]) -> str:
    return (
        (files["json"] + files["html"] + files["csv"]).decode("utf-8", errors="replace")
        + _pdf_text(files["pdf"])
        + _xlsx_raw(files["xlsx"])
    )


async def _rename(t: Team, email_like: str, name: str) -> None:
    async with t.ctx.session_factory() as s:
        await s.execute(
            update(User).where(User.email.like(email_like)).values(full_name=name).execution_options(**BYPASS)
        )
        await s.commit()


async def _detail(t: Team, rid: str) -> dict[str, Any]:
    r = await t.get(f"/reports/{rid}")
    assert r.status_code == 200, r.text
    return dict(r.json()["content"])


# ---------------------------------------------------------------- Gate 9: reject, then approve


async def test_reject_freezes_a_new_report_and_the_older_one_goes_out_of_date(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t, major_defect=True)
    a = await assess(t, pid)
    [first] = await _ready(t, pid, "release_readiness")
    r = await t.post(f"/release-assessments/{a['id']}/decision", {"decision": "reject", "reason": "Re-test first"},
                     t.approver)  # fmt: skip
    assert r.status_code == 200, r.text
    rows = await _ready(t, pid, "release_readiness", "REL-0001")
    assert len(rows) == 2, rows
    new, old = rows
    assert old["id"] == first["id"] and old["is_latest_source"] is False and new["is_latest_source"] is True
    c = await _detail(t, new["id"])
    assert c["verdict_text"] == "No-go · Not decided"
    assert c["decision_line"].startswith("Rejected by Team Mate, ") and "'Re-test first'" in c["decision_line"]
    assert c["band"] is not None and c["band"].startswith("DRAFT")  # not final: still DRAFT
    assert new["approval"]["status"] == "draft"

    # Assess again and approve REL-0002: its report loses the band and names the decider.
    b = await assess(t, pid)
    assert b["key"] == "REL-0002"
    ok = await t.post(f"/release-assessments/{b['id']}/decision", {"decision": "approve"}, t.approver)
    assert ok.status_code == 200, ok.text
    r2 = await _ready(t, pid, "release_readiness", "REL-0002")
    assert len(r2) == 2 and r2[1]["is_latest_source"] is False
    c2 = await _detail(t, r2[0]["id"])
    assert c2["band"] is None and c2["verdict_text"] == "No-go · Final"
    assert c2["decision_line"].startswith("Decided by Team Mate, ")
    assert r2[0]["approval"]["decided_by"] == {"full_name": "Team Mate"}
    files = await _files(t, r2[0]["id"])
    assert "DRAFT" not in files["html"].decode() and "DRAFT" not in _pdf_text(files["pdf"])
    # No band once final: the CSV starts with the summary (verdict and Gate 9 decision).
    head = _csv(files["csv"])
    assert head[0] == ["Summary"] and head[2] == ["Verdict", "No-go · Final"] and head[4][0] == "Gate 9"
    # Versions are unique and increasing.
    allv = [x["version"] for x in await _ready(t, pid, "release_readiness")]
    assert len(set(allv)) == len(allv)


# ---------------------------------------------------------------- stale, then superseded: bands in every format


async def test_superseded_assessment_band_in_html_pdf_csv_xlsx_and_completion_limitation(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t, finding=True)
    a = await assess(t, pid)
    assert a["recommendation"] == "go"
    d = await t.post(f"/projects/{pid}/defects", {"summary": "Footer link is broken", "actual": "404"}, t.member)
    assert d.status_code == 201
    b = await assess(t, pid)
    assert b["key"] == "REL-0002"
    rel1 = await _ready(t, pid, "release_readiness", "REL-0001")
    assert rel1[0]["is_latest_source"] is False
    band = "DRAFT: REL-0001 was replaced by REL-0002 and can't be decided."
    assert rel1[0]["approval"]["band"] == band
    # Generate again for REL-0001.
    g = await t.post(f"/projects/{pid}/reports", {"report_type": "release_readiness", "run_key": "REL-0001"}, t.member)
    assert g.status_code == 202, g.text
    again = await _ready(t, pid, "release_readiness", "REL-0001")
    assert again[0]["is_latest_source"] is True
    c = await _detail(t, again[0]["id"])
    assert c["band"] == band and c["verdict_text"].endswith("· Not decided")
    assert c["decision_line"] == "Gate 9: not decided. Replaced by REL-0002."
    files = await _files(t, again[0]["id"])
    assert band.replace("'", "&#39;") in files["html"].decode()
    pdf = _pdf_text(files["pdf"])
    assert "REL-0001 was replaced by REL-0002" in pdf.replace("\n", " "), pdf[:600]
    assert _csv(files["csv"])[0] == [band]
    assert _sheets(files["xlsx"])["Summary"][0][0] == band

    # Completion from the superseded assessment: its criteria, but the limitation says it's out of date.
    g = await t.post(f"/projects/{pid}/reports", {"report_type": "completion", "run_key": "REL-0001"}, t.member)
    assert g.status_code == 202, g.text
    [comp] = await _ready(t, pid, "completion")
    cc = await _detail(t, comp["id"])
    assert cc["release"]["key"] == "REL-0001" and cc["release"]["is_latest"] is False
    assert any(x.startswith("REL-0001 is out of date") for x in cc["limitations"]), cc["limitations"]
    assert cc["band"] is None


# ---------------------------------------------------------------- formula guard, escaping, no email


async def test_formula_guard_escaping_and_no_email_anywhere(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t, exit_criteria=[*EXIT, "Stakeholders signed off"], major_defect=True)
    # A person whose name is a formula; titles and summaries with markup and formulas.
    await _rename(t, "member@%", "=cmd|' /C calc'!A0")
    await _rename(t, "approver@%", "")  # no name: shown as "someone", never the email
    async with t.ctx.session_factory() as s:
        case = (await s.execute(select(TestCase).where(TestCase.project_id == pid, TestCase.key == "TC-0001")
                                .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        case.title = "-2+3 " + XSS
        await s.commit()
    r = await t.post(f"/projects/{pid}/defects", {"summary": "@SUM(1+1) " + XSS, "actual": "x", "severity": "minor"})
    assert r.status_code == 201, r.text
    a = await assess(t, pid)
    cr = await t.post(f"/release-assessments/{a['id']}/criteria/exit.text.5/confirm",
                      {"status": "met", "reason": "+HYPERLINK(\"http://evil.example\") " + XSS}, t.member)  # fmt: skip
    assert cr.status_code == 200, cr.text
    reason = '=HYPERLINK("http://evil.example") accepted ' + XSS
    ok = await t.post(f"/release-assessments/{a['id']}/decision",
                      {"decision": "override", "final_verdict": "go", "reason": reason}, t.approver)  # fmt: skip
    assert ok.status_code == 200, ok.text
    lessons = "=1+1 next time " + XSS + "\nsecond line"
    g = await t.post(f"/projects/{pid}/reports", {"report_type": "completion", "lessons_learned": lessons}, t.member)
    assert g.status_code == 202, g.text

    [rr, *_] = await _ready(t, pid, "release_readiness")
    [comp] = await _ready(t, pid, "completion")
    for rid in (rr["id"], comp["id"]):
        files = await _files(t, rid)
        html = files["html"].decode()
        assert "<script>" not in html and "<img src=x" not in html, rid
        assert "&lt;script&gt;" in html
        text = _all_text(files)
        found = [m for m in EMAIL.findall(text) if "example" in m]
        assert not found, (rid, found)
        # CSV: no cell starts with a formula character.
        for row in _csv(files["csv"]):
            for cell in row:
                assert not cell.startswith(("=", "+", "-", "@", "\t", "\r")), (rid, cell)
        # XLSX: no formula cells, no cell starts with a formula character.
        for name, rows in _sheets(files["xlsx"]).items():
            for row in rows:
                for v in row:
                    if isinstance(v, str):
                        assert not v.startswith(("=", "+", "-", "@")), (rid, name, v)
        book = load_workbook(io.BytesIO(files["xlsx"]))
        assert not any(c.data_type == "f" for ws in book.worksheets for row in ws.iter_rows() for c in row)

    c = await _detail(t, rr["id"])
    assert c["override_text"].startswith("Overridden by someone: '=HYPERLINK")
    assert c["decision_line"].startswith("Decided by someone, ")
    row = next(x for x in c["criteria"] if x["id"] == "exit.text.5")
    assert row["confirmed_by"] == "=cmd|' /C calc'!A0"
    crit_rows = _csv((await _files(t, rr["id"]))["csv"])
    assert [x for r in crit_rows for x in r if x.endswith("calc'!A0")] == ["'=cmd|' /C calc'!A0"]
    cc = await _detail(t, comp["id"])
    assert cc["lessons"]["author"] == "=cmd|' /C calc'!A0" and cc["lessons"]["text"] == lessons.strip()


# ---------------------------------------------------------------- numbers equal the API for every status


async def test_every_result_status_equals_the_coverage_api(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t)
    async with t.ctx.session_factory() as s:
        first = (await s.execute(select(TestCase).where(TestCase.project_id == pid, TestCase.key == "TC-0001")
                                 .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        run = (await s.execute(select(ExecutionRun).where(ExecutionRun.project_id == pid)
                               .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        g5 = (await s.execute(select(GateDecision).where(GateDecision.project_id == pid,
                                                         GateDecision.gate_key == GateKey.G5)
                              .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        items = list(g5.artefact_snapshot["items"])
        for i, status in enumerate(("failed", "flaky", "error", "blocked", "skipped", None, "passed"), start=2):
            case = TestCase(organisation_id=first.organisation_id, project_id=pid, stage_run_id=first.stage_run_id,
                            key=f"TC-{i:04d}", match_key=f"tc-{i:04d}", title=f"Case {i}",
                            test_type="functional" if i % 2 else "api", test_level="system" if i < 6 else "integration",
                            technique="use_case", provenance=Provenance.inferred, generated_by=GeneratedBy.rules,
                            status=CaseStatus.approved if i < 8 else CaseStatus.draft,
                            requirement_lineage_ids=first.requirement_lineage_ids)  # fmt: skip
            s.add(case)
            await s.flush()
            if i < 8:
                items.append({"type": "test_case", "id": str(case.id), "version": 1})
            if status:
                s.add(ExecutionResult(organisation_id=first.organisation_id, project_id=pid, execution_run_id=run.id,
                                      key=f"RUN-0001-{i:02d}", case_lineage_id=case.lineage_id, test_case_id=case.id,
                                      status=status))  # fmt: skip
        g5.artefact_snapshot = {"items": items}
        await s.commit()
    await assess(t, pid)
    g = await t.post(f"/projects/{pid}/reports", {"report_type": "completion"}, t.member)
    assert g.status_code == 202, g.text
    [comp] = await _ready(t, pid, "completion")
    c = await _detail(t, comp["id"])
    cov = (await t.get(f"/projects/{pid}/traceability/coverage?basis=approved")).json()
    res = cov["execution"]["results"]
    total = c["measures"]["total"]
    for k in ("passed", "failed", "flaky", "error", "blocked", "skipped"):
        assert total[k] == res[k], (k, total, res)
    assert total["approved"] == cov["execution"]["automation"]["approved_cases"]
    assert total["approved"] - total["not_run"] == res["tests"]
    assert total["executed"] == res["passed"] + res["failed"] + res["flaky"] + res["error"]
    assert c["scope"]["requirements"] == cov["requirements"]["approved"]
    assert c["scope"]["acceptance_criteria"] == cov["acceptance_criteria"]["approved"]
    # The groups add up to the total.
    for key in ("by_type", "by_level"):
        summed = {k: sum(b[k] for b in c["measures"][key].values()) for k in total}
        assert summed == total, (key, summed, total)
    # The summary sentence uses the same numbers.
    assert c["summary"].startswith(f"{total['approved']} approved test cases: {total['executed']} executed ")
    # The draft case (never approved) isn't counted; the never-run approved one is a deviation.
    assert "TC-0009" not in {r["case_key"] for r in c["results"]}
    assert {d["case_key"] for d in c["deviations"]} == {"TC-0005", "TC-0006", "TC-0007"}


# ---------------------------------------------------------------- bad bodies: 422, never 500


@pytest.mark.parametrize(
    "body",
    [
        {"report_type": "completion", "basis": "later"},
        {"report_type": "completion", "run_key": "R" * 41},
        {"report_type": "completion", "lessons_learned": 12},
        {"report_type": "completion", "lessons_learned": ["a"]},
        {"report_type": "completion", "surprise": True},
        {"report_type": "release_readiness", "lessons_learned": "Keep doing this"},
        {"report_type": "test_plan", "lessons_learned": "Keep doing this"},
        {"report_type": "docx"},
    ],
)
async def test_bad_bodies_are_422(team: Team, body: dict[str, Any]) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t)
    await assess(t, pid)
    r = await t.post(f"/projects/{pid}/reports", body, t.member)
    assert r.status_code == 422, (body, r.status_code, r.text)


async def test_downloads_offer_no_docx_and_csv_timeseries_is_refused(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t)
    await assess(t, pid)
    [rr] = await _ready(t, pid, "release_readiness")
    for fmt, code in (("docx", 422), ("csv_timeseries", 422), ("doc", 422), ("json", 302)):
        r = await t.client.get(f"/api/v1/reports/{rr['id']}/download?format={fmt}", headers=t.owner.headers)
        assert r.status_code == code, (fmt, r.text)
    assert "docx" not in rr["formats"]
    assert set(rr["formats"]) >= {"pdf", "html", "json", "csv", "xlsx"}


async def test_whitespace_lessons_are_none_and_another_org_cant_generate_from_our_key(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t)
    await assess(t, pid)
    g = await t.post(f"/projects/{pid}/reports", {"report_type": "completion", "lessons_learned": "   \n "}, t.member)
    assert g.status_code == 202, g.text
    [comp] = await _ready(t, pid, "completion")
    assert (await _detail(t, comp["id"]))["lessons"] is None
    # The other organisation: 404 on the project and on the report, even through a list.
    o = t.other.headers
    assert (await t.post(f"/projects/{pid}/reports/completion/lessons-suggestion", {}, o)).status_code == 404
    assert (await t.get(f"/projects/{pid}/reports", o)).status_code == 404
    assert (await t.client.get(f"/api/v1/reports/{comp['id']}/download?format=json", headers=o)).status_code == 404


# ---------------------------------------------------------------- AI lessons learned


@pytest.mark.parametrize(
    ("answer", "status"),
    [
        # Keys that are in the facts are fine; the assessment key and invented keys are not in the facts.
        ("Re-test the contact form after fixing DEF-0001 and confirm RISK-001 is reduced before the release.", 200),
        ("Assess earlier: REL-0001 found the major defect late, so start re-testing the contact form sooner.", 422),
        ("Percentages like fifty % should never appear; plan 2 weeks for the contact form next time please.", 422),
        ("Close def-0001 earlier and keep re-testing the contact form after each change next time please.", 422),
    ],
)
async def test_lessons_suggestion_rules(make_ctx: CtxFactory, answer: str, status: int) -> None:
    llm = FakeLLM([{"lessons": answer}])
    ctx = await make_ctx(llm=llm, resolver=public_resolver(), transport=site_transport())
    async with client_for(ctx) as client:
        t = await _team(ctx, client, f"qa605c{uuid.uuid4().hex[:6]}")
        pid = await fixture_project(t, major_defect=True)
        # Before any assessment: 409 with the verbatim text.
        r = await t.post(f"/projects/{pid}/reports/completion/lessons-suggestion", {}, t.member)
        assert (
            r.status_code == 409 and r.json()["error"]["message"] == "Not available yet: assess release readiness first"
        )
        await assess(t, pid)
        llm.responses = [{"lessons": answer}]
        assert (await t.post(f"/projects/{pid}/reports/completion/lessons-suggestion", {}, t.viewer)).status_code == 403
        llm.responses = [{"lessons": answer}]
        r = await t.post(f"/projects/{pid}/reports/completion/lessons-suggestion", {"basis": "current"}, t.member)
        assert r.status_code == status, r.text


async def test_spelled_out_numbers_are_not_refused(make_ctx: CtxFactory) -> None:
    """Probe: the guard refuses digits only. A suggestion with spelled-out counts passes (documented in the report)."""
    answer = "Three of the four tests failed, so plan more time for the contact form in the next release."
    llm = FakeLLM([{"lessons": answer}])
    ctx = await make_ctx(llm=llm, resolver=public_resolver(), transport=site_transport())
    async with client_for(ctx) as client:
        t = await _team(ctx, client, f"qa605d{uuid.uuid4().hex[:6]}")
        pid = await fixture_project(t, major_defect=True)
        await assess(t, pid)
        llm.responses = [{"lessons": answer}]
        r = await t.post(f"/projects/{pid}/reports/completion/lessons-suggestion", {}, t.member)
        assert r.status_code == 200, r.text


async def test_client_can_label_any_text_as_ai(team: Team) -> None:  # noqa: F811
    """Fixed: the server only accepts the AI label for an unedited suggestion it issued (signed token), checked again
    against the data; a client can't label its own text (digits, unknown keys) as AI."""
    t = team
    pid = await fixture_project(t)
    await assess(t, pid)
    body = {
        "report_type": "completion",
        "lessons_generated_by": "ai",
        "lessons_learned": "97 % passed; TC-9999 was fine.",
    }
    g = await t.post(f"/projects/{pid}/reports", body, t.member)
    assert g.status_code == 422, g.text
    assert g.json()["error"]["message"] == (
        "The AI label only applies to a suggestion the platform made that you kept unedited"
    )
    forged = await t.post(f"/projects/{pid}/reports", {**body, "lessons_token": "9999999999.deadbeef"}, t.member)
    assert forged.status_code == 422
    assert await _ready(t, pid, "completion") == []
