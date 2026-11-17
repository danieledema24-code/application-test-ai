"""P6-05c Test Completion and Release Readiness reports (decision D34) through the API, AI off unless stated.

Uses the P6-05a fixture project (test_p6_release.py): the assessment runs for real, the reports render for real (JSON,
HTML, PDF, CSV, XLSX). The demo chain's reports (no-go then conditional on demo-shop release 2) are checked at the end
of test_p6_release_demo.py.

Covers: 409 "Not available yet: assess release readiness first" before any assessment; the Release Readiness Report is
created with the assessment, carries the DRAFT band (HTML, PDF header, CSV first line, XLSX Summary first line) until
Gate 9, and a new one without the band names the decider and the override when decided; its verdict, criteria,
conditions and counts equal `GET /release-assessments/{id}`; the statement comes first; the Test Completion Report's
measures equal the coverage and execution APIs, deviations list the approved case never executed, lessons learned are
shown with their author; current-data reports; file names; the formula guard; no email and no saved credentials in any
file; no DOCX (422); viewers read and download, members generate, other organisations get 404 (403 on a signed link);
the `report.generated` audit; AI lessons learned (FakeLLM): labelled, refused when they write a number or an unknown key.
"""

from __future__ import annotations

import csv
import io
import uuid
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import pytest
from markupsafe import escape
from openpyxl import load_workbook
from sqlalchemy import select

from app.db.models import ExecutionRun, GateDecision, TestCase
from app.db.tenant import BYPASS, bind_scope, system_scope
from app.domain.enums import CaseStatus, GateKey, GeneratedBy, Provenance
from app.llm.base import FakeLLM
from app.services import execution as xsvc
from tests.conftest import CtxFactory, client_for, public_resolver, site_transport, worker_for
from tests.integration.test_p6_release import EXIT, Team, _audit, _team, assess, crit, fixture_project, team  # noqa: F401

NOT_AVAILABLE = "Not available yet: assess release readiness first"
FORMULA = '=HYPERLINK("http://evil.example/x","Click")'
PASSWORD = "s3cret-Report-Pass!"


async def _ready(t: Team, pid: uuid.UUID, rtype: str, key: str | None = None) -> list[dict[str, Any]]:
    """Reports of a type (newest first), all rendered."""
    await worker_for(t.ctx).run_until_idle(timeout=120)
    rows = (await t.get(f"/projects/{pid}/reports")).json()
    mine = sorted((r for r in rows if r["report_type"] == rtype and (key is None or r["run_key"] == key)),
                  key=lambda r: -r["version"])  # fmt: skip
    assert all(r["status"] == "ready" for r in mine), [(r["version"], r["status"], r["error"]) for r in mine]
    return mine


async def _detail(t: Team, rid: str, h: dict[str, str] | None = None) -> dict[str, Any]:
    r = await t.get(f"/reports/{rid}", h)
    assert r.status_code == 200, r.text
    return dict(r.json())


async def _files(t: Team, rid: str, h: dict[str, str] | None = None) -> dict[str, bytes]:
    out = {}
    for fmt in ("json", "html", "pdf", "csv", "xlsx"):
        r = await t.client.get(f"/api/v1/reports/{rid}/download?format={fmt}", headers=h or t.owner.headers,
                               follow_redirects=True)  # fmt: skip
        assert r.status_code == 200, (fmt, r.text)
        out[fmt] = r.content
    return out


def _text(files: dict[str, bytes]) -> str:
    return "".join(v.decode("utf-8", errors="replace") for k, v in files.items() if k not in ("pdf", "xlsx"))


def _csv_rows(data: bytes) -> list[list[str]]:
    return list(csv.reader(io.StringIO(data.decode("utf-8").lstrip("﻿"))))


async def _host(t: Team, pid: uuid.UUID) -> str:
    url = (await t.get(f"/projects/{pid}")).json()["primary_url"]
    return str(urlsplit(url).hostname)


def _xlsx_cells(data: bytes) -> dict[str, list[list[Any]]]:
    book = load_workbook(io.BytesIO(data))
    return {ws.title: [[c.value for c in row] for row in ws.iter_rows()] for ws in book.worksheets}


# ---------------------------------------------------------------- Release Readiness Report


async def test_release_readiness_report_follows_the_assessment(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t, major_defect=True)
    for rtype in ("release_readiness", "completion"):
        r = await t.post(f"/projects/{pid}/reports", {"report_type": rtype}, t.member)
        assert r.status_code == 409 and r.json()["error"]["message"] == NOT_AVAILABLE, r.text
    a = await assess(t, pid)
    assert a["recommendation"] == "no_go" and a["status"] == "awaiting_approval"

    # Created with the assessment: a draft, with the DRAFT band in every format.
    [rep] = await _ready(t, pid, "release_readiness")
    assert rep["run_key"] == "REL-0001" and rep["is_latest_source"] is True and rep["frozen"] is True
    assert rep["approval"]["status"] == "draft" and rep["approval"]["band"] == "DRAFT: Gate 9 not decided for REL-0001."
    d = await _detail(t, rep["id"])
    c = d["content"]
    api = (await t.get(f"/release-assessments/{a['id']}")).json()
    # Numbers equal the API: verdict, criteria statuses, conditions, counts.
    assert c["assessment"]["recommendation"] == api["recommendation"] and c["assessment"]["counts"] == api["counts"]
    assert [(x["id"], x["status"]) for x in c["assessment"]["criteria"]] == [(x["id"], x["status"])
                                                                          for x in api["criteria"]]  # fmt: skip
    assert [x["text"] for x in c["conditions"]] == [x["text"] for x in api["conditions_list"]]
    assert c["verdict_text"] == "No-go · Recommended" and c["reason"] == api["reason"]
    assert c["decision_line"] == "Gate 9: waiting for a decision by someone who can approve."
    assert c["band"] == "DRAFT: Gate 9 not decided for REL-0001." and c["statement"] == api["statement"]
    row = next(x for x in c["criteria"] if x["id"] == "exit.no_open_high_defects")
    assert (row["blocking_text"], row["status_text"], row["evidence"]) == ("Blocking", "Not met", "DEF-0001")
    files = await _files(t, rep["id"])
    body = files["html"].decode().split("<body>", 1)[1]
    assert str(escape(c["band"])) in body and body.index(str(escape(c["statement"]))) < body.index("<h2>")
    assert "default-src 'none'" in files["html"].decode()
    assert files["pdf"][:4] == b"%PDF"
    rows = _csv_rows(files["csv"])
    assert rows[0] == ["DRAFT: Gate 9 not decided for REL-0001."]
    sheets = _xlsx_cells(files["xlsx"])
    assert list(sheets) == ["Summary", "Criteria", "Conditions", "Residual risk"]
    assert sheets["Summary"][0][0] == "DRAFT: Gate 9 not decided for REL-0001."
    assert len(sheets["Criteria"]) == 1 + len(api["criteria"]) and len(sheets["Conditions"]) == 1 + api["conditions"]
    assert "Criteria" in [r[0] for r in rows if r] and len(rows) > len(api["criteria"])
    host = await _host(t, pid)
    day = c["generated_at"][:10]
    assert {f["filename"] for f in d["files"]} == {f"{host}-release-readiness-REL-0001-{day}.{x}"
                                                   for x in ("json", "html", "pdf", "csv", "xlsx")}  # fmt: skip
    assert "@p6rel.example.com" not in _text(files)
    r = await t.client.get(f"/api/v1/reports/{rep['id']}/download?format=docx", headers=t.owner.headers)
    assert r.status_code == 422 and r.json()["error"]["message"] == "DOCX is not available"

    # Gate 9: an override; a new report loses the band and names the decider and the override.
    reason = "DEF-0001 only affects an internal page; the PO accepted it for this release."
    ok = await t.post(f"/release-assessments/{a['id']}/decision",
                      {"decision": "override", "final_verdict": "go", "reason": reason}, t.approver)  # fmt: skip
    assert ok.status_code == 200, ok.text
    new, old = await _ready(t, pid, "release_readiness", "REL-0001")
    assert new["approval"]["status"] == "approved" and new["approval"]["band"] is None
    assert new["approval"]["decided_by"] == {"full_name": "Team Mate"}
    assert old["is_latest_source"] is False and new["is_latest_source"] is True
    nc = (await _detail(t, new["id"]))["content"]
    assert nc["band"] is None and nc["verdict_text"] == "Go · Final"
    assert nc["override_text"] == f"Overridden by Team Mate: '{reason}' (recommended: No-go)"
    assert nc["decision_line"].startswith("Decided by Team Mate, ") and nc["decision_line"].endswith("UTC")
    nfiles = await _files(t, new["id"])
    assert "DRAFT" not in nfiles["html"].decode() and str(escape(nc["override_text"])) in nfiles["html"].decode()
    # No band once final: the Summary sheet starts with the verdict, the Gate 9 line and the override.
    summary = _xlsx_cells(nfiles["xlsx"])["Summary"]
    assert [r[:2] for r in summary[:5]] == [["Assessment", nc["source_key"]], ["Verdict", "Go · Final"],
                                            ["Reason", nc["reason"]], ["Gate 9", nc["decision_line"]],
                                            ["Override", nc["override_text"]]]  # fmt: skip
    # A decided assessment's report isn't created twice for the same state.
    from app.agents.reporting.phase6_reports import freeze_for_assessment

    await freeze_for_assessment(t.ctx, system_scope(t.owner.org_id), pid, uuid.UUID(a["id"]))
    assert len(await _ready(t, pid, "release_readiness")) == 2

    # Roles and tenants: viewers read and download, can't generate; other organisations get 404, and a signed link
    # whose signature doesn't match is refused.
    assert (await t.get(f"/reports/{new['id']}", t.viewer)).status_code == 200
    viewer_files = await _files(t, new["id"], t.viewer)
    assert viewer_files["json"] == nfiles["json"]
    r = await t.post(f"/projects/{pid}/reports", {"report_type": "release_readiness"}, t.viewer)
    assert r.status_code == 403
    o = t.other.headers
    assert (await t.get(f"/reports/{new['id']}", o)).status_code == 404
    assert (await t.client.get(f"/api/v1/reports/{new['id']}/download?format=pdf", headers=o)).status_code == 404
    assert (await t.post(f"/projects/{pid}/reports", {"report_type": "completion"}, o)).status_code == 404
    loc = (await t.client.get(f"/api/v1/reports/{new['id']}/download?format=csv", headers=t.owner.headers)).headers[
        "location"
    ]
    parts = urlsplit(loc)
    q = {k: v[0] for k, v in parse_qs(parts.query).items()}
    q["sig"] = "0" * len(q["sig"])
    forged = await t.client.get(f"{parts.path}?{urlencode(q)}")
    assert forged.status_code == 403

    # On request for a given assessment (a member), audited; an unknown key is 404.
    r = await t.post(f"/projects/{pid}/reports", {"report_type": "release_readiness", "run_key": "REL-0001"}, t.member)
    assert r.status_code == 202, r.text
    assert r.json()["run_key"] == "REL-0001"
    r = await t.post(f"/projects/{pid}/reports", {"report_type": "release_readiness", "run_key": "REL-0009"}, t.member)
    assert r.status_code == 404
    r = await t.post(f"/projects/{pid}/reports", {"report_type": "release_readiness", "basis": "current"}, t.member)
    assert r.status_code == 422
    [log] = await _audit(t.ctx, pid, "report.generated")
    assert log.meta["report_type"] == "release_readiness" and log.meta["source"] == "REL-0001"


async def test_stale_assessment_band_and_confirmed_criterion(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t, exit_criteria=[*EXIT, "Stakeholders signed off"])
    a = await assess(t, pid)
    assert a["recommendation"] == "conditional"
    path = f"/release-assessments/{a['id']}/criteria/exit.text.5/confirm"
    r = await t.post(path, {"status": "met", "reason": "Signed off in the release meeting"}, t.member)
    assert r.status_code == 200, r.text
    # Confirming changed the verdict: a new report equals the assessment again.
    latest, first = await _ready(t, pid, "release_readiness")
    assert first["is_latest_source"] is False and latest["is_latest_source"] is True
    c = (await _detail(t, latest["id"]))["content"]
    assert c["verdict_text"] == "Go · Recommended"
    row = next(x for x in c["criteria"] if x["id"] == "exit.text.5")
    assert row["confirmed"] == "Confirmed by Team Mate: 'Signed off in the release meeting'"
    # New evidence makes the assessment stale: the API's band says so; a report generated now carries it.
    d = await t.post(f"/projects/{pid}/defects", {"summary": "Footer link is broken", "actual": "404"}, t.member)
    assert d.status_code == 201, d.text
    rows = await _ready(t, pid, "release_readiness")
    assert rows[0]["is_latest_source"] is False
    assert rows[0]["approval"]["band"] == "DRAFT: REL-0001 is out of date and can't be decided."
    r = await t.post(f"/projects/{pid}/reports", {"report_type": "release_readiness"}, t.member)
    assert r.status_code == 202
    [now, *_] = await _ready(t, pid, "release_readiness")
    files = await _files(t, now["id"])
    assert _xlsx_cells(files["xlsx"])["Summary"][0][0] == "DRAFT: REL-0001 is out of date and can't be decided."


# ---------------------------------------------------------------- Test Completion Report


async def _second_case(t: Team, pid: uuid.UUID) -> None:
    """An approved case (in the G5 snapshot) that never ran, with a title a spreadsheet would read as a formula; and the
    run's stored totals as a real run records them."""
    async with t.ctx.session_factory() as s:
        first = (await s.execute(select(TestCase).where(TestCase.project_id == pid, TestCase.key == "TC-0001")
                                 .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        case = TestCase(organisation_id=first.organisation_id, project_id=pid, stage_run_id=first.stage_run_id,
                        key="TC-0002", match_key="tc-0002", title=FORMULA, test_type="usability",
                        test_level="acceptance", technique="exploratory", provenance=Provenance.inferred,
                        generated_by=GeneratedBy.rules, status=CaseStatus.approved,
                        requirement_lineage_ids=first.requirement_lineage_ids)  # fmt: skip
        s.add(case)
        await s.flush()
        g5 = (await s.execute(select(GateDecision).where(GateDecision.project_id == pid,
                                                         GateDecision.gate_key == GateKey.G5)
                              .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        g5.artefact_snapshot = {"items": [*g5.artefact_snapshot["items"],
                                          {"type": "test_case", "id": str(case.id), "version": 1}]}  # fmt: skip
        run = (await s.execute(select(ExecutionRun).where(ExecutionRun.project_id == pid)
                               .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        bind_scope(s, system_scope(t.owner.org_id))
        run.totals = await xsvc.totals(s, run)
        await s.commit()


async def test_completion_report_measures_equal_the_api(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t)
    await _second_case(t, pid)
    host = await _host(t, pid)
    saved = await t.client.put(f"/api/v1/projects/{pid}/secrets/scan_credentials", headers=t.owner.headers,
                               json={"login_url": f"https://{host}/login", "username": "qa-user",
                                     "password": PASSWORD})  # fmt: skip
    assert saved.status_code in (200, 201), saved.text
    a = await assess(t, pid)
    lessons = "Keep the contact form in every regression run.\nDesign the usability checks earlier."
    r = await t.post(f"/projects/{pid}/reports", {"report_type": "completion", "lessons_learned": lessons}, t.member)
    assert r.status_code == 202, r.text
    assert r.json()["run_key"] == a["key"]
    [rep] = await _ready(t, pid, "completion")
    d = await _detail(t, rep["id"])
    c = d["content"]
    # Measures equal the APIs: the latest result per approved case (coverage) and each run's totals (execution).
    cov = (await t.get(f"/projects/{pid}/traceability/coverage?basis=approved")).json()
    res = cov["execution"]["results"]
    total = c["measures"]["total"]
    assert (total["approved"], total["passed"], total["failed"], total["blocked"]) == (
        cov["execution"]["automation"]["approved_cases"], res["passed"], res["failed"], res["blocked"])  # fmt: skip
    assert total["executed"] == res["passed"] + res["failed"] + res["flaky"] + res["error"]
    assert c["measures"]["coverage"]["acceptance_criteria"] == cov["acceptance_criteria"]
    assert c["measures"]["by_type"]["usability"]["not_run"] == 1 and c["measures"]["by_level"]["system"]["passed"] == 1
    runs = (await t.get(f"/projects/{pid}/execution-runs")).json()["items"]
    api_run = (await t.get(f"/execution-runs/{runs[0]['id']}")).json()
    [run] = c["runs"]
    assert run["key"] == api_run["key"] and run["totals"] == {k: v for k, v in api_run["totals"].items()
                                                             if k != "live"}  # fmt: skip
    assert run["totals"]["passed"] == 1
    # Deviations: the approved case that never ran; exit criteria and residual risk are the assessment's.
    assert c["deviations_line"] == "Approved but never executed: TC-0002"
    assert c["not_tested"][0] == {"item": "TC-0002", "reason": "Not selected in any finished run"}
    assert [(x["id"], x["status"]) for x in c["criteria"]] == [(x["id"], x["status"]) for x in crit(a).values()]
    assert c["release"]["key"] == a["key"] and c["release"]["verdict_text"].endswith("· Recommended")
    assert c["exploratory"]["sessions"][0]["key"] == "EXP-0001" and c["exploratory"]["empty"] is None
    assert "No Word (DOCX) export." in c["limitations"]
    assert c["lessons"] == {"text": lessons, "generated_by": "person", "author": "Team Mate"}
    files = await _files(t, rep["id"])
    html = files["html"].decode()
    assert "Written by Team Mate." in html and str(escape(lessons)) in html
    assert f'<p class="lessons">{escape(lessons)}</p>' in html and ".lessons { white-space: pre-line; }" in html
    # Formula guard: the title is text in the CSV and the XLSX.
    rows = _csv_rows(files["csv"])
    cells = [x for r in rows for x in r if x.endswith('"Click")')]
    assert len(cells) == 2 and set(cells) == {"'" + FORMULA}  # Results and Deviations
    sheets = _xlsx_cells(files["xlsx"])
    assert list(sheets) == ["Summary", "Results", "Measures", "Runs", "Deviations", "Defects", "Exit criteria",
                            "Conditions", "Residual risk"]  # fmt: skip
    book = load_workbook(io.BytesIO(files["xlsx"]))
    cell = next(c for row in book["Results"].iter_rows() for c in row if str(c.value).endswith('"Click")'))
    assert cell.value == "'" + FORMULA and cell.data_type == "s"
    assert len(sheets["Results"]) == 1 + total["approved"]
    # No credentials and no email in any format.
    text = _text(files)
    assert PASSWORD not in text and "qa-user" not in text and "@p6rel.example.com" not in text
    assert PASSWORD.encode() not in files["xlsx"] and PASSWORD.encode() not in files["pdf"]
    assert f"{host}-test-completion-{a['key']}-{c['generated_at'][:10]}.pdf" in {f["filename"] for f in d["files"]}

    # From current data: not tied to an assessment; file names say "current".
    r = await t.post(f"/projects/{pid}/reports", {"report_type": "completion", "basis": "current"}, t.member)
    assert r.status_code == 202 and r.json()["run_key"] is None
    cur = (await _ready(t, pid, "completion"))[0]
    cc = (await _detail(t, cur["id"]))["content"]
    assert cc["source_key"] == "current" and cc["release"]["key"] is None and cc["lessons"] is None
    assert cc["measures"]["total"] == total
    assert {x["id"] for x in cc["criteria"]} == {x["id"] for x in c["criteria"]}
    assert all(
        f["filename"].startswith(f"{host}-test-completion-current-") for f in (await _detail(t, cur["id"]))["files"]
    )
    # Wrong input.
    for body, code in (
        ({"report_type": "completion", "run_key": "REL-0042"}, 404),
        ({"report_type": "completion", "lessons_learned": "x" * 4001}, 422),
        ({"report_type": "execution", "basis": "current"}, 422),
        ({"report_type": "completion", "lessons_generated_by": "robot"}, 422),
    ):
        r = await t.post(f"/projects/{pid}/reports", body, t.member)
        assert r.status_code == code, (body, r.text)
    assert (await t.post(f"/projects/{pid}/reports", {"report_type": "completion"}, t.viewer)).status_code == 403


# ---------------------------------------------------------------- AI lessons learned (FakeLLM)


async def test_lessons_suggestion_with_ai_off_is_refused(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t)
    await assess(t, pid)
    r = await t.post(f"/projects/{pid}/reports/completion/lessons-suggestion", {}, t.member)
    assert r.status_code == 409 and r.json()["error"]["message"] == "AI is off: write the lessons learned yourself"


@pytest.mark.parametrize(
    ("answer", "status"),
    [
        ("Fix DEF-0001 earlier in the cycle and keep re-testing the contact form after each change.", 200),
        ("Assess earlier: REL-0001 found the major defect late, so start re-testing the contact form sooner.", 200),
        ("About 3 of every 4 tests passed, so plan more time for the contact form next release.", 422),
        ("Re-test TC-0099 sooner and keep the contact form in every regression run next time.", 422),
    ],
)
async def test_lessons_suggestion_is_labelled_and_never_writes_numbers(
    make_ctx: CtxFactory, answer: str, status: int
) -> None:
    llm = FakeLLM([{"lessons": answer}])
    ctx = await make_ctx(llm=llm, resolver=public_resolver(), transport=site_transport())
    async with client_for(ctx) as client:
        t = await _team(ctx, client, f"p6les{uuid.uuid4().hex[:6]}")
        pid = await fixture_project(t, major_defect=True)
        await assess(t, pid)
        llm.responses = [{"lessons": answer}]  # the assessment's narrative used the first answer
        llm.captured.clear()
        r = await t.post(f"/projects/{pid}/reports/completion/lessons-suggestion", {}, t.member)
        assert r.status_code == status, r.text
        if status == 200:
            got = r.json()
            assert {k: got[k] for k in ("text", "generated_by")} == {"text": answer, "generated_by": "ai"}
            body = {"report_type": "completion", "lessons_learned": answer, "lessons_generated_by": "ai"}
            # The AI label needs the token issued with this text, for this person; edited text can't keep it.
            assert (await t.post(f"/projects/{pid}/reports", body, t.member)).status_code == 422
            edited = {**body, "lessons_learned": answer + " Edited.", "lessons_token": got["token"]}
            assert (await t.post(f"/projects/{pid}/reports", edited, t.member)).status_code == 422
            assert (await t.post(f"/projects/{pid}/reports", {**body, "lessons_token": got["token"]},
                                 t.owner.headers)).status_code == 422  # fmt: skip
            # Kept unedited, with its token: the report labels it as AI text.
            g = await t.post(f"/projects/{pid}/reports", {**body, "lessons_token": got["token"]}, t.member)
            assert g.status_code == 202, g.text
            [rep] = await _ready(t, pid, "completion")
            html = (await _files(t, rep["id"]))["html"].decode()
            assert "Suggested by AI and kept by Team Mate; not edited." in html
        else:
            assert r.json()["error"]["message"].startswith("The AI suggestion wasn't usable (")
        assert "Website data (untrusted)" in llm.captured[0]["user"]
        assert "Fix or accept DEF-0001 (major)" in llm.captured[0]["user"]
