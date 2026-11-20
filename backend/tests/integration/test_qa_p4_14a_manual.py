"""QA for P4-14a manual runs and results (independent of the developer's tests).

Probes: latest-wins across two open manual runs when an older run's result is edited; upload boundaries (exactly
10 MB, 10 MB + 1, SVG, GIF, polyglot PNG/HTML served safely, empty file), 5-file cap under concurrency, the per-project
upload rate limit; recorder-only and finish/cancel rules; 409s for automated-only actions on manual runs; redaction of
token-like values; recorder emails absent from the manual report; migration 0022 down/up on a Phase 6 database with
data (row counts and other CHECK constraints preserved).
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from sqlalchemy import select, text

from app.db.migrate import downgrade, upgrade
from app.db.models import Evidence, ExecutionResult, ExecutionRun, QaReport
from app.db.tenant import BYPASS, bind_scope, system_scope
from app.domain.enums import RunStatus
from tests.conftest import worker_for
from tests.integration.test_p4_14_manual_results import (
    PNG,
    _project,
    _put,
    _record,
    _start,
    _upload,
)
from tests.integration.test_p6_release import Team, team
from tests.integration.test_p6_release_retests import _change_set

__all__ = ["team"]

MB10 = 10 * 1024 * 1024


async def _latest(t: Team, pid: uuid.UUID) -> dict[str, dict[str, Any]]:
    from app.services.serialize_p3 import last_results

    async with t.ctx.session_factory() as s:
        bind_scope(s, system_scope(t.owner.org_id))
        return await last_results(s, pid)


async def _case_latest(t: Team, pid: uuid.UUID, case_key: str) -> dict[str, Any]:
    from app.db.models import TestCase

    async with t.ctx.session_factory() as s:
        bind_scope(s, system_scope(t.owner.org_id))
        case = (
            await s.execute(select(TestCase).where(TestCase.project_id == pid, TestCase.key == case_key))
        ).scalar_one()
    return (await _latest(t, pid))[str(case.lineage_id)]


# ---------------------------------------------------------------- latest wins across two open manual runs


async def test_qa_latest_saved_wins_across_two_open_manual_runs(team: Team) -> None:
    """Lead decision: the same case may be in two open manual runs; the latest *saved* result wins. Editing the
    result in the older run after the newer run recorded must make the edited one the latest."""
    t = team
    pid = await _project(t)
    a = await _start(t, pid, ["TC-0002"])  # RUN-0002, member
    b = await _start(t, pid, ["TC-0002"], t.approver)  # RUN-0003, approver
    await _record(t, a["id"], "TC-0002", "passed")
    got = await _case_latest(t, pid, "TC-0002")
    assert (got["run_key"], got["status"]) == (a["key"], "passed")
    await _record(t, b["id"], "TC-0002", "failed", t.approver)
    got = await _case_latest(t, pid, "TC-0002")
    assert (got["run_key"], got["status"]) == (b["key"], "failed")
    # The member re-saves their result in the older run: it is now the latest saved result.
    r = await _put(t, a["id"], "TC-0002", {"status": "passed", "actual_result": "Checked again: it is fine"})
    assert r.status_code == 200, r.text
    got = await _case_latest(t, pid, "TC-0002")
    assert (got["run_key"], got["status"]) == (a["key"], "passed"), got


# ---------------------------------------------------------------- uploads


async def test_qa_upload_boundaries_and_types(team: Team) -> None:
    t = team
    pid = await _project(t)
    run = await _start(t, pid, ["TC-0002", "TC-0003"])
    res = (await _record(t, run["id"], "TC-0002", "failed"))["result"]
    exact = PNG + b"\x00" * (MB10 - len(PNG))
    assert len(exact) == MB10
    ok = await _upload(t, res["id"], exact, "exact.png")
    assert ok.status_code == 201, ok.text[:300]
    over = await _upload(t, res["id"], exact + b"\x00", "over.png")
    assert over.status_code == 422 and over.json()["error"]["message"] == "This file is larger than 10 MB."
    bad = "This file type isn't supported. Use PNG, JPEG or PDF."
    svg = b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    for data, name in ((svg, "x.svg"), (svg, "x.png"), (b"GIF89a" + b"\x00" * 32, "x.gif"),
                       (b"  \x89PNG\r\n\x1a\n", "lead.png"), (b"PK\x03\x04zip", "x.pdf")):  # fmt: skip
        r = await _upload(t, res["id"], data, name)
        assert r.status_code == 422 and r.json()["error"]["message"] == bad, (name, r.text)
        assert name not in r.text
    # A polyglot (PNG magic, then HTML) is accepted by content, but served as an image with nosniff and a sandbox CSP.
    poly = PNG + b"<html><script>alert(document.cookie)</script></html>"
    up = await _upload(t, res["id"], poly, "../../etc/<script>.png")
    assert up.status_code == 201, up.text
    assert "script" not in json.dumps(up.json()["evidence"]) and "etc" not in json.dumps(up.json()["evidence"])
    url = up.json()["evidence"]["content_url"].removeprefix("http://test")
    served = await t.client.get(url)
    assert served.status_code == 200 and served.headers["content-type"].startswith("image/png")
    assert served.headers["x-content-type-options"] == "nosniff" and "sandbox" in served.headers[
        "content-security-policy"]  # fmt: skip
    assert "script" not in served.headers["content-disposition"]
    # Not in the audit metadata either.
    async with t.ctx.session_factory() as s:
        rows = (await s.execute(text("SELECT * FROM audit_logs WHERE action = 'evidence.uploaded'"))).all()
    assert rows and all("etc" not in str(m) and "exact.png" not in str(m) for m in rows)


async def test_qa_empty_file_message(team: Team) -> None:
    """Contract: an empty file is 422 "Choose a file to upload."."""
    t = team
    pid = await _project(t)
    run = await _start(t, pid, ["TC-0002"])
    res = (await _record(t, run["id"], "TC-0002", "failed"))["result"]
    empty = await _upload(t, res["id"], b"", "empty.png")
    assert empty.status_code == 422 and empty.json()["error"]["message"] == "Choose a file to upload.", empty.text


async def test_qa_five_file_cap_under_concurrency(team: Team) -> None:
    t = team
    pid = await _project(t)
    run = await _start(t, pid, ["TC-0002"])
    res = (await _record(t, run["id"], "TC-0002", "failed"))["result"]
    for i in range(3):
        assert (await _upload(t, res["id"], PNG, f"{i}.png")).status_code == 201
    got = await asyncio.gather(*[_upload(t, res["id"], PNG, f"c{i}.png") for i in range(6)])
    codes = sorted(r.status_code for r in got)
    async with t.ctx.session_factory() as s:
        n = (
            await s.execute(
                select(Evidence).where(Evidence.execution_result_id == uuid.UUID(res["id"])).execution_options(**BYPASS)
            )
        ).all()
    assert len(n) <= 5, (len(n), codes)
    assert codes.count(201) == 2, codes


async def test_qa_upload_rate_limit_per_project(team: Team) -> None:
    t = team
    pid = await _project(t)
    run = await _start(t, pid, ["TC-0001", "TC-0002", "TC-0003", "TC-0004"])
    ids = [(await _record(t, run["id"], c, "failed"))["result"]["id"] for c in ("TC-0001", "TC-0002", "TC-0003",
                                                                              "TC-0004")]  # fmt: skip
    for rid in ids:
        for i in range(5):
            r = await _upload(t, rid, PNG, f"{i}.png")
            assert r.status_code == 201, r.text
    run2 = await _start(t, pid, ["TC-0001"])
    rid = (await _record(t, run2["id"], "TC-0001", "failed"))["result"]["id"]
    r = await _upload(t, rid, PNG, "21.png")
    assert r.status_code == 429, r.text


# ---------------------------------------------------------------- rules, permissions, 409s


async def test_qa_recorder_finish_cancel_and_automated_only_actions(team: Team) -> None:
    t = team
    pid = await _project(t)
    run = await _start(t, pid, ["TC-0002", "TC-0003"])
    # Another member (not the requester, not an approver) can't cancel; the owner (approver) can't once recorded.
    res = (await _record(t, run["id"], "TC-0002", "failed"))["result"]
    up = await _upload(t, res["id"], PNG, "a.png", t.approver)
    assert up.status_code == 403, up.text
    # Status outside passed/failed/blocked.
    for st in ("error", "flaky", "skipped", "not_run", "recording"):
        assert (await _put(t, run["id"], "TC-0003", {"status": st, "actual_result": "x"})).status_code == 422
    # Case keys are case-insensitive and whitespace in What happened is trimmed.
    r = await _put(t, run["id"], "tc-0003", {"status": "blocked", "actual_result": "  No test data  "})
    assert r.status_code == 200 and r.json()["result"]["actual_result"] == "No test data", r.text
    # Automated-only actions on the manual run / result.
    assert (await t.post(f"/execution-results/{res['id']}/heal-suggestions/0/accept", {}, t.member)).status_code == 409
    for path, body in (("authorise", {"decision": "reject", "comment": "no"}), ("rerun", {"only": "failed"})):
        r = await t.post(f"/execution-runs/{run['id']}/{path}", body, t.approver)
        assert r.status_code == 409, (path, r.text)
    # Finishing: a viewer can't; any member can; twice is 409; an automated run can't be finished.
    assert (await t.post(f"/execution-runs/{run['id']}/finish", {}, t.viewer)).status_code == 403
    done = await t.post(f"/execution-runs/{run['id']}/finish", {}, t.approver)
    assert done.status_code == 200 and done.json()["run"]["status"] == "failed", done.text
    again = await t.post(f"/execution-runs/{run['id']}/finish", {}, t.member)
    assert again.status_code == 409, again.text
    assert (await t.post(f"/execution-runs/{run['id']}/cancel", {}, t.owner.headers)).status_code == 409
    auto = (await t.get(f"/projects/{pid}/execution-runs/by-key/RUN-0001")).json()
    fin = await t.post(f"/execution-runs/{auto['id']}/finish", {}, t.member)
    assert (
        fin.status_code == 409 and fin.json()["error"]["message"] == "Only results of manual runs are recorded by hand."
    )
    put = await _put(t, auto["id"], "TC-0001", {"status": "passed", "actual_result": "x"})
    assert put.status_code == 409, put.text
    # After finish nobody uploads.
    assert (await _upload(t, res["id"], PNG, "late.png")).status_code == 409
    # A blocked-only + failed run is failed; a blocked-only run finishes as passed (the documented rule).
    run2 = await _start(t, pid, ["TC-0004"])
    await _put(t, run2["id"], "TC-0004", {"status": "blocked", "actual_result": "No account"})
    d = (await t.post(f"/execution-runs/{run2['id']}/finish", {}, t.member)).json()["run"]
    assert d["status"] == "passed", d["status"]


async def test_qa_change_set_key_and_cases_validation(team: Team) -> None:
    t = team
    pid = await _project(t)
    r = await t.post(f"/projects/{pid}/execution-runs",
                     {"mode": "manual", "case_keys": ["TC-0002"], "change_set_key": "CHG-0099"}, t.member)  # fmt: skip
    assert r.status_code == 422, r.text
    r = await t.post(f"/projects/{pid}/execution-runs", {"mode": "manual", "case_keys": ["  ", ""]}, t.member)
    assert r.status_code == 422, r.text
    # Duplicates collapse to one planned test.
    run = await _start(t, pid, ["TC-0002", "tc-0002", " TC-0002 "])
    assert run["manual"]["tests"] == 1
    # Automated request with the manual-only fields is refused.
    r = await t.post(f"/projects/{pid}/execution-runs", {"case_keys": ["TC-0001"]}, t.member)
    assert r.status_code == 422, r.text
    # Another organisation's project.
    r = await t.post(f"/projects/{pid}/execution-runs", {"mode": "manual", "case_keys": ["TC-0002"]}, t.other.headers)
    assert r.status_code == 404, r.text


async def test_qa_cross_tenant_cancel_and_evidence_content(team: Team) -> None:
    t = team
    pid = await _project(t)
    run = await _start(t, pid, ["TC-0002", "TC-0003"])
    res = (await _record(t, run["id"], "TC-0002", "failed"))["result"]
    o = t.other.headers
    assert (await t.post(f"/execution-runs/{run['id']}/cancel", {}, o)).status_code == 404
    assert (await t.get(f"/execution-runs/{run['id']}/results", o)).status_code == 404
    assert (await t.post(f"/projects/{pid}/defects", {"from_result_id": res["id"]}, o)).status_code == 404


# ---------------------------------------------------------------- redaction and the report


async def test_qa_token_like_values_redacted_and_no_emails_in_manual_report(team: Team) -> None:
    t = team
    pid = await _project(t)
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    run = await _start(t, pid, ["TC-0002", "TC-0003"])
    r = await _put(t, run["id"], "TC-0002", {"status": "failed", "actual_result": f"Header was Bearer {jwt}",
                                              "notes": f"cookie {jwt}"})  # fmt: skip
    assert r.status_code == 200 and jwt not in r.text, r.text
    await _record(t, run["id"], "TC-0003", "passed", t.approver)
    assert (await t.post(f"/execution-runs/{run['id']}/finish", {}, t.member)).status_code == 200
    await worker_for(t.ctx).run_until_idle(timeout=120)
    [rep] = [x for x in (await t.get(f"/projects/{pid}/reports")).json() if x.get("run_key") == run["key"]]
    async with t.ctx.session_factory() as s:
        report = (await s.execute(select(QaReport).where(QaReport.id == uuid.UUID(rep["id"]))
                                  .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        files = report.files or []
        evs = list((await s.execute(select(Evidence).where(Evidence.id.in_(
            [uuid.UUID(f["evidence_id"]) for f in files])).execution_options(**BYPASS))).scalars())  # fmt: skip
    blobs = [json.dumps(report.content).encode()] + [await t.ctx.storage.get(e.storage_key) for e in evs]
    for blob in blobs:
        assert jwt.encode() not in blob
        assert b"member@p6rel.example.com" not in blob and b"approver@p6rel.example.com" not in blob


async def test_qa_d37_note_redacted_and_history(team: Team) -> None:
    from tests.integration.test_p6_release import fixture_project

    t = team
    pid = await fixture_project(t)
    cs = await _change_set(t, pid)
    url = f"/change-sets/{cs}/manual-retests"
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
    r = await t.post(url, {"case_key": "TC-0001", "status": "passed", "note": f"token {jwt}"}, t.member)
    assert r.status_code == 201 and jwt not in r.text, r.text
    r = await t.post(url, {"case_key": "TC-0001", "status": "failed", "note": "Second try: broken"}, t.member)
    hist = r.json()["items"][0]["history"]
    # Recording again in the same run updates the result in place (D39 design): the history has one entry.
    assert [h["status"] for h in hist] == ["failed"], hist
    # A different member records in their own run: two entries, newest first.
    r = await t.post(url, {"case_key": "TC-0001", "status": "passed", "note": "Third try: fine"}, t.approver)
    hist = r.json()["items"][0]["history"]
    assert [h["status"] for h in hist] == ["passed", "failed"], hist
    assert hist[0]["run_key"] != hist[1]["run_key"]


# ---------------------------------------------------------------- migration on a Phase 6 database with data


async def test_qa_migration_0022_preserves_phase6_data_and_constraints(team: Team) -> None:
    from tests.integration.test_p6_release import assess, fixture_project

    t = team
    pid = await fixture_project(t)  # Phase 6 fixture: G5, RUN-0001, risks, scans, change set CHG-0001
    cs = await _change_set(t, pid)
    r = await t.post(f"/change-sets/{cs}/manual-retests",
                     {"case_key": "TC-0001", "status": "passed", "note": "Re-tested by hand"}, t.member)  # fmt: skip
    assert r.status_code == 201, r.text
    await assess(t, pid)
    run = await _start(t, pid, ["TC-0001"], t.approver)
    res = (await _record(t, run["id"], "TC-0001", "failed", t.approver))["result"]
    assert (await _upload(t, res["id"], PNG, "a.png", t.approver)).status_code == 201
    done = await _start(t, pid, ["TC-0001"])
    await _record(t, done["id"], "TC-0001", "passed")
    assert (await t.post(f"/execution-runs/{done['id']}/finish", {}, t.member)).status_code == 200
    engine = t.ctx.engine

    async def snapshot() -> tuple[dict[str, int], dict[str, str]]:
        async with engine.connect() as conn:
            tables = [r[0] for r in (await conn.execute(text(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' "
                "AND name != 'alembic_version'"))).all()]  # fmt: skip
            counts = {}
            for n in tables:
                q = text(f'SELECT COUNT(*) FROM "{n}"')  # noqa: S608 - table names from sqlite_master
                counts[n] = (await conn.execute(q)).scalar_one()
            ddl = {n: (await conn.execute(text("SELECT sql FROM sqlite_master WHERE name = :n"), {"n": n})).scalar_one()
                   for n in ("execution_runs", "execution_results")}  # fmt: skip
            bad = (await conn.execute(text("PRAGMA foreign_key_check"))).all()
            assert bad == [], bad
        return counts, ddl

    before, ddl_up = await snapshot()
    await downgrade(engine, "0021")
    down, ddl_down = await snapshot()
    assert down == before
    assert "recording" not in ddl_down["execution_runs"] and "recorded_by" not in ddl_down["execution_results"]
    await upgrade(engine)
    after, ddl_up2 = await snapshot()
    assert after == before
    # Every CHECK of the two tables survives the batch recreation (mode, status, results status, ...).
    for name in ("execution_runs", "execution_results"):
        assert ddl_up2[name].count("CHECK") == ddl_up[name].count("CHECK"), (ddl_up[name], ddl_up2[name])
        assert ddl_down[name].count("CHECK") == ddl_up[name].count("CHECK"), (ddl_up[name], ddl_down[name])
    assert "execution_run_mode" in ddl_up2["execution_runs"] or "'manual'" in ddl_up2["execution_runs"]
    # After down/up the recording run is cancelled (documented), its result and evidence stay.
    async with t.ctx.session_factory() as s:
        row = (await s.execute(select(ExecutionRun).where(ExecutionRun.id == uuid.UUID(run["id"]))
                               .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        assert row.status == RunStatus.cancelled
        got = (await s.execute(select(ExecutionResult).where(ExecutionResult.id == uuid.UUID(res["id"]))
                             .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        assert got.recorded_by is None  # the column was dropped and re-added: who recorded it is lost on downgrade
    # The app still works after up/down/up.
    again = await _start(t, pid, ["TC-0001"])
    assert again["status"] == "recording"
    await _record(t, again["id"], "TC-0001", "passed")


# ---------------------------------------------------------------- assistant


async def test_qa_assistant_explain_without_key_and_propose_rerun_ignore_classification(team: Team) -> None:
    from tests.integration.test_p6_assistant_release import _ask

    t = team
    pid = await _project(t)
    run = await _start(t, pid, ["TC-0002"])
    await _put(t, run["id"], "TC-0002", {"status": "failed", "actual_result": "The form posts to http://"})
    explain = await _ask(t, pid, {"content": "Explain the failed test"}, t.member)
    assert explain["intent"] == "explain_failed_test", explain
    body = explain["content"]
    assert "Recorded by a person; not analysed." in body and 'What happened: "The form posts to http://"' in body
    for word in ("application_defect", "Likely cause", "test_defect", "environment issue", "Hypothesis"):
        assert word not in body, (word, body)
    # propose_rerun reads automated runs only: RUN-0001 passed, so nothing to re-run (the manual failure is ignored).
    prop = await _ask(t, pid, {"content": "Re-run the failed tests"}, t.member)
    assert prop["intent"] == "propose_rerun", prop
    assert "TC-0002" not in prop["content"] and not prop.get("proposals"), prop
    # Numbers equal the API: the run detail's counts.
    detail = (await t.get(f"/execution-runs/{run['id']}")).json()
    ans = await _ask(t, pid, {"content": "Did the tests pass?"}, t.member)
    assert f"{detail['manual']['recorded']} recorded: 1 failed (TC-0002)" in ans["content"], ans["content"]


async def test_qa_concurrent_first_save_of_the_same_case(team: Team) -> None:
    """Two members save the same case of one run at the same moment: one wins, the other gets a clear 4xx, never 500."""
    t = team
    pid = await _project(t)
    run = await _start(t, pid, ["TC-0002"])
    body = {"status": "passed", "actual_result": "Looked fine"}
    got = await asyncio.gather(_put(t, run["id"], "TC-0002", body, t.member),
                               _put(t, run["id"], "TC-0002", body, t.approver))  # fmt: skip
    codes = sorted(r.status_code for r in got)
    assert codes[0] == 200 and codes[1] in (200, 403, 409), [(r.status_code, r.text[:200]) for r in got]


# ---------------------------------------------------------------- round 2: saved_at, reclassify, recorded_at


async def _automated(t: Team, pid: uuid.UUID, case_key: str, status: str, *, analysed: bool = False) -> str:
    """A finished automated run with one result for `case_key` (stored directly). Returns the result id."""
    from app.db.models import TestCase
    from app.db.types import utcnow
    from app.services.counters import next_key

    async with t.ctx.session_factory() as s:
        bind_scope(s, system_scope(t.owner.org_id))
        common = {"organisation_id": t.owner.org_id, "project_id": pid}
        case = (
            await s.execute(select(TestCase).where(TestCase.project_id == pid, TestCase.key == case_key))
        ).scalar_one()
        _n, key = await next_key(s, t.owner.org_id, pid, "run")
        run = ExecutionRun(**common, key=key, status=RunStatus(status), requested_by=t.owner.user_id,
                           started_at=utcnow(), finished_at=utcnow())  # fmt: skip
        s.add(run)
        await s.flush()
        analysis = {"classification": "script_defect", "label": "Script problem", "confidence": "medium"}
        r = ExecutionResult(**common, execution_run_id=run.id, key=f"{key}-01", case_lineage_id=case.lineage_id,
                            test_case_id=case.id, status=status, actual_result="x",
                            analysis=analysis if analysed else None,
                            classification="script_defect" if analysed else None)  # fmt: skip
        s.add(r)
        await s.commit()
        return str(r.id)


async def test_qa_reclassifying_an_older_automated_result_does_not_make_it_latest(team: Team) -> None:
    t = team
    pid = await _project(t)
    old = await _automated(t, pid, "TC-0002", "failed", analysed=True)
    await asyncio.sleep(0.01)
    await _automated(t, pid, "TC-0002", "passed")
    before = await _case_latest(t, pid, "TC-0002")
    assert before["status"] == "passed"
    await asyncio.sleep(0.01)
    r = await t.post(f"/execution-results/{old}/classification",
                     {"classification": "environment_failure", "reason": "The site was down"}, t.member)  # fmt: skip
    assert r.status_code == 200, r.text
    after = await _case_latest(t, pid, "TC-0002")
    assert (after["status"], after["run_key"]) == ("passed", before["run_key"]), after
    # Also against a manual result: a manual pass, then reclassifying an older automated failure.
    run = await _start(t, pid, ["TC-0003"])
    old3 = await _automated(t, pid, "TC-0003", "failed", analysed=True)
    await asyncio.sleep(0.01)
    await _record(t, run["id"], "TC-0003", "passed")
    r = await t.post(f"/execution-results/{old3}/classification",
                     {"classification": "environment_failure", "reason": "The site was down"}, t.member)  # fmt: skip
    assert r.status_code == 200, r.text
    got = await _case_latest(t, pid, "TC-0003")
    assert (got["status"], got["run_key"], got["manual"]) == ("passed", run["key"], True), got
    # And the latest-per-case Test Execution Report and the gap list agree.
    gaps = (await t.get(f"/projects/{pid}/traceability/gaps")).json()
    assert [x["case"]["key"] for x in gaps["failed_tests"]] == [], gaps["failed_tests"]


async def test_qa_older_run_edit_wins_everywhere(team: Team) -> None:
    """Bug 1 follow-up: after an edit in the older open run, last_results, the D37-independent assistant line,
    the gap list and the latest-per-case report all name the older run's result."""
    from tests.integration.test_p6_assistant_release import _ask

    t = team
    pid = await _project(t)
    a = await _start(t, pid, ["TC-0002"])
    b = await _start(t, pid, ["TC-0002"], t.approver)
    await _record(t, a["id"], "TC-0002", "failed")
    await _record(t, b["id"], "TC-0002", "passed", t.approver)
    assert (await t.get(f"/projects/{pid}/traceability/gaps")).json()["failed_tests"] == []
    r = await _put(t, a["id"], "TC-0002", {"status": "failed", "actual_result": "Still posts to http://"})
    assert r.status_code == 200 and r.json()["result"]["recorded_at"], r.text
    failed = (await t.get(f"/projects/{pid}/traceability/gaps")).json()["failed_tests"]
    assert [(x["case"]["key"], x["run_key"]) for x in failed] == [("TC-0002", a["key"])], failed
    ans = await _ask(t, pid, {"content": "What was the last result of TC-0002?"}, t.member)
    assert a["key"] in json.dumps(ans) or "failed" in ans["content"], ans
    rep = await t.post(f"/projects/{pid}/reports", {"report_type": "execution"}, t.member)
    assert rep.status_code == 202, rep.text
    await worker_for(t.ctx).run_until_idle(timeout=120)
    latest = [x for x in (await t.get(f"/projects/{pid}/reports")).json()
              if x.get("report_type") == "execution" and not x.get("run_key")]  # fmt: skip
    assert latest, (await t.get(f"/projects/{pid}/reports")).json()
    content = (await t.get(f"/reports/{latest[0]['id']}")).json()["content"]
    rows = [x for x in content["results"] if x["case_key"] == "TC-0002"]
    assert [(x["run_key"], x["status"]) for x in rows] == [(a["key"], "failed")], rows


async def test_qa_migration_0022_recorded_at_round_trip(team: Team) -> None:
    t = team
    pid = await _project(t)
    run = await _start(t, pid, ["TC-0002"])
    await _record(t, run["id"], "TC-0002", "passed")
    engine = t.ctx.engine
    async with engine.connect() as conn:
        v = (await conn.execute(text("SELECT recorded_at FROM execution_results WHERE key = :k"),
                                {"k": f"{run['key']}-01"})).scalar_one()  # fmt: skip
        assert v is not None
    await downgrade(engine, "0021")
    async with engine.connect() as conn:
        cols = {r[1] for r in (await conn.execute(text("PRAGMA table_info(execution_results)"))).all()}
        assert not {"recorded_at", "recorded_by", "notes"} & cols
    await upgrade(engine)
    async with engine.connect() as conn:
        cols = {r[1]: r for r in (await conn.execute(text("PRAGMA table_info(execution_results)"))).all()}
        assert {"recorded_at", "recorded_by", "notes"} <= set(cols)
        assert cols["recorded_at"][3] == 0  # nullable
    again = await _start(t, pid, ["TC-0002"])
    saved = await _record(t, again["id"], "TC-0002", "failed")
    assert saved["result"]["recorded_at"]
    got = await _case_latest(t, pid, "TC-0002")
    assert (got["run_key"], got["status"]) == (again["key"], "failed")


async def test_qa_record_racing_finish_never_lands_in_a_finished_run(team: Team) -> None:
    """A save racing a finish either lands before the finish (and is counted) or is refused with 409."""
    t = team
    pid = await _project(t)
    for _ in range(5):
        run = await _start(t, pid, ["TC-0002", "TC-0003"])
        await _record(t, run["id"], "TC-0002", "passed")
        fin, rec = await asyncio.gather(
            t.post(f"/execution-runs/{run['id']}/finish", {}, t.approver),
            _put(t, run["id"], "TC-0003", {"status": "failed", "actual_result": "late"}),
        )
        assert fin.status_code == 200, fin.text
        assert rec.status_code in (200, 409), rec.text
        d = (await t.get(f"/execution-runs/{run['id']}")).json()
        recorded = sum(1 for x in d["tests_rows"] if x["status"] in ("passed", "failed"))
        assert d["totals"]["finished"] == recorded, (d["totals"], rec.status_code)
        assert d["status"] == ("failed" if recorded == 2 else "passed"), (d["status"], recorded)
