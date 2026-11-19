"""P4-14a manual runs and results through the API (decisions D38, D39, D40), AI off.

The fixture project of test_p6_release.py (REQ-0001 with TC-0001, a high risk, RUN-0001 passed, G5) gets REQ-0002
with three more approved cases that have no script (TC-0002 to TC-0004: "manual only"), approved at a new G5.

Covers: a manual run starts in `recording` with no G7, approvals or stage run and counts as soon as a result is saved
(the requirement leaves "manual only", execution coverage, `executed`); blocked isn't evidence (gap list, DoD); the
latest result wins across manual and automated runs; no analysis and no automatic defect draft, and a defect raised
`from_result_id` is prefilled; "What happened" required; uploads (PNG, JPEG, PDF by content, 10 MB, 5 per result,
never the uploaded name); recorder-only edits until finish, 409 after; finish with unrecorded cases and the run's
frozen Test Execution Report; cancel only with nothing recorded; a recording run doesn't block an automated run or a
load test; authorise, re-run, live, frames, causes and fix suggestions are 409; a waiting release assessment goes
stale; the D37 endpoint keeps its contract and writes a manual result (legacy rows still count until replaced); the
assistant; viewers 403 on writes, other organisations 404 on run, result, evidence and report ids; the saved test
account never reaches a report; migration 0022 up/down/up.
"""

from __future__ import annotations

import io
import json
import uuid
from typing import Any

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.db.migrate import downgrade, upgrade
from app.db.models import (
    Approval,
    AuditLog,
    ChangeSet,
    Defect,
    Evidence,
    ExecutionResult,
    ExecutionRun,
    GateDecision,
    ManualRetest,
    PerformanceProfile,
    PerformanceRun,
    QaReport,
    Requirement,
    StageRun,
    TestCase,
)
from app.db.tenant import BYPASS, bind_scope, system_scope
from app.db.types import utcnow
from app.domain.enums import (
    BehaviourScope,
    CaseStatus,
    GateDecisionKind,
    GateKey,
    GeneratedBy,
    ManualRetestStatus,
    PerfRunStatus,
    Provenance,
    RequirementSource,
    RequirementStatus,
    RequirementType,
    RunMode,
    RunStatus,
    StageKey,
)
from app.services import approvals as apr
from app.services.counters import next_key
from tests.conftest import worker_for
from tests.integration.test_p6_release import Team, _audit, _current_run, assess, fixture_project, team
from tests.integration.test_p6_release_retests import _change_set

__all__ = ["team"]  # the module-level fixture from test_p6_release.py

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
PDF = b"%PDF-1.4\n%fake\n"
HTML_PNG = b"<!doctype html><html><body>not an image</body></html>"
WHAT = "Opened the sign-in page with the browser's tools: the form posts to https://shop.example.com/login"


async def _project(t: Team) -> uuid.UUID:
    """The fixture project plus REQ-0002 with TC-0002..TC-0004 (no script), all approved at a new G5."""
    pid = await fixture_project(t)
    owner = t.owner
    async with t.ctx.session_factory() as s:
        bind_scope(s, system_scope(owner.org_id))
        common = {"organisation_id": owner.org_id, "project_id": pid}
        req_run = await _current_run(s, pid, StageKey.requirements)
        design_run = await _current_run(s, pid, StageKey.test_design)
        req = Requirement(**common, stage_run_id=req_run, key="REQ-0002", match_key="req-0002",
                          title="Sign-in form posts over HTTPS", type=RequirementType.functional,
                          category="authentication", behaviour_scope=BehaviourScope.ui,
                          source=RequirementSource.discovery, status=RequirementStatus.approved,
                          provenance=Provenance.observed, generated_by=GeneratedBy.rules)  # fmt: skip
        s.add(req)
        await s.flush()
        for n, title in ((2, "Inspect the sign-in form's action address"), (3, "Read the sign-in page with a screen "
                         "reader"), (4, "Check the sign-in error wording")):  # fmt: skip
            s.add(TestCase(**common, stage_run_id=design_run, key=f"TC-000{n}", match_key=f"tc-000{n}", title=title,
                           test_type="functional", test_level="system", technique="use_case",
                           provenance=Provenance.inferred, generated_by=GeneratedBy.rules, status=CaseStatus.approved,
                           requirement_lineage_ids=[str(req.lineage_id)],
                           expected_result="The form posts to an https:// address"))  # fmt: skip
        await s.flush()
        cases = (await s.execute(select(TestCase).where(TestCase.project_id == pid))).scalars()
        s.add(GateDecision(**common, gate_key=GateKey.G5, stage_run_id=design_run, decision=GateDecisionKind.approve,
                           decided_by=owner.user_id, snapshot_hash="i" * 64,
                           artefact_snapshot={"items": [{"type": "test_case", "id": str(c.id), "version": 1}
                                                        for c in cases]},
                           stage_run_versions={"test_design": 1}))  # fmt: skip
        await s.commit()
    return pid


async def _start(t: Team, pid: uuid.UUID, keys: list[str], h: dict[str, str] | None = None) -> dict[str, Any]:
    r = await t.post(f"/projects/{pid}/execution-runs", {"mode": "manual", "case_keys": keys}, h or t.member)
    assert r.status_code == 201, r.text
    return dict(r.json())


async def _put(t: Team, run_id: str, case: str, body: dict[str, Any], h: dict[str, str] | None = None) -> Any:
    return await t.client.put(f"/api/v1/execution-runs/{run_id}/results/{case}", json=body,
                              headers=h or t.member)  # fmt: skip


async def _record(t: Team, run_id: str, case: str, status: str, h: dict[str, str] | None = None) -> dict[str, Any]:
    r = await _put(t, run_id, case, {"status": status, "actual_result": WHAT, "notes": "Checked twice"}, h)
    assert r.status_code == 200, r.text
    return dict(r.json())


async def _upload(t: Team, result_id: str, data: bytes, name: str, h: dict[str, str] | None = None) -> Any:
    files = {"file": (name, io.BytesIO(data), "image/png")}
    return await t.client.post(f"/api/v1/execution-results/{result_id}/evidence", files=files, headers=h or t.member)


async def _gaps(t: Team, pid: uuid.UUID) -> dict[str, Any]:
    return dict((await t.get(f"/projects/{pid}/traceability/gaps")).json())


def _manual_only(g: dict[str, Any]) -> list[str]:
    return [x["key"] for x in g["requirements_without_execution_evidence"]["manual_only"]]


async def _dod(t: Team, pid: uuid.UUID) -> dict[str, Any]:
    from app.agents.readiness.rules import evaluate
    from app.services.readiness import load_facts

    async with t.ctx.session_factory() as s:
        bind_scope(s, system_scope(t.owner.org_id))
        result = evaluate("dod.tests_executed", await load_facts(s, pid))
    assert result is not None
    return result


# ---------------------------------------------------------------- start, record, counts on save


async def test_manual_run_records_without_g7_and_counts_before_finish(team: Team) -> None:
    t = team
    pid = await _project(t)
    before = await _gaps(t, pid)
    assert _manual_only(before) == ["REQ-0002"]
    run = await _start(t, pid, ["tc-0002", "TC-0003"])
    assert (run["mode"], run["status"], run["selection_label"]) == ("manual", "recording", "Manual")
    assert run["key"] == "RUN-0002" and run["authorisation"] is None and run["approvals"] == []
    assert run["manual"] == {"recorded": 0, "tests": 2, "change_set_key": None}
    assert run["permissions"]["can_record"] and not run["permissions"]["can_finish"]
    assert not run["permissions"]["can_authorise"] and not run["permissions"]["can_rerun"]
    assert [(x["case_key"], x["status"], x["browser"]) for x in run["tests_rows"]] == [
        ("TC-0002", "not_recorded", "manual"), ("TC-0003", "not_recorded", "manual")]  # fmt: skip
    # Nothing was gated, approved or queued: no G7, no approval, no stage run, no job.
    async with t.ctx.session_factory() as s:
        row = (await s.execute(select(ExecutionRun).where(ExecutionRun.key == "RUN-0002", ExecutionRun.project_id == pid)
                               .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        assert row.g7_decision_id is None and row.stage_run_id is None and row.mode == RunMode.manual
        g7 = (await s.execute(select(GateDecision).where(GateDecision.project_id == pid, GateDecision.gate_key == GateKey.G7)
                              .execution_options(**BYPASS))).scalars().all()  # fmt: skip
        assert g7 == []
        assert (await s.execute(select(Approval).where(Approval.execution_run_id == row.id)
                                .execution_options(**BYPASS))).first() is None  # fmt: skip
        jobs = (await s.execute(text("SELECT COUNT(*) FROM jobs WHERE kind = 'execution_run'"))).scalar_one()
        assert jobs == 0
    [log] = await _audit(t.ctx, pid, "execution_run.manual_started")
    assert log.meta["key"] == "RUN-0002" and log.meta["tests"] == 2
    listed = (await t.get(f"/projects/{pid}/execution-runs")).json()
    assert listed["recording"] == ["RUN-0002"] and listed["running"] is None

    # A member records Passed with What happened: it counts now, before the run is finished.
    saved = await _record(t, run["id"], "TC-0002", "passed")
    assert saved["message"] == "TC-0002 saved as Passed."
    res = saved["result"]
    assert (res["status"], res["browser"], res["viewport"], res["actual_result"]) == (
        "passed",
        "manual",
        "manual",
        WHAT,
    )
    assert res["recorded_by"]["full_name"] == "Team Mate" and "email" not in res["recorded_by"]
    assert res["notes"] == "Checked twice" and res["manual"] is True
    assert res["classification"] is None and res["analysis"] is None
    assert res["not_analysed"] == "Not analysed: recorded by a person"
    assert saved["run"]["manual"]["recorded"] == 1 and saved["run"]["status"] == "recording"
    gaps = await _gaps(t, pid)
    assert _manual_only(gaps) == [] and gaps["requirements_without_execution_evidence"]["executed"] is True
    cov = (await t.get(f"/projects/{pid}/traceability/coverage")).json()["execution"]
    assert cov["requirements"] == {"approved": 2, "with_result": 2} and cov["results"]["passed"] == 2
    case = (await t.get(f"/projects/{pid}/traceability")).json()
    assert "TC-0002" in json.dumps(case)
    [rec] = await _audit(t.ctx, pid, "execution_result.recorded")
    assert rec.meta == {"key": "RUN-0002-01", "run": "RUN-0002", "case": "TC-0002", "status": "passed",
                        "previous": None}  # fmt: skip
    async with t.ctx.session_factory() as s:
        events = (
            await s.execute(text("SELECT type, message FROM agent_events WHERE type = 'execution.manual_recorded'"))
        ).all()
    assert [m for _t, m in events] == ["TC-0002 recorded by hand by Team Mate: Passed"]
    # The recorder changes it (audited with the previous status); nobody else can.
    again = await _put(t, run["id"], "TC-0002", {"status": "failed", "actual_result": "On a second look: http://"})
    assert again.status_code == 200 and again.json()["result"]["status"] == "failed"
    logs = await _audit(t.ctx, pid, "execution_result.recorded")
    assert sorted(x.meta["previous"] or "" for x in logs) == ["", "passed"]
    other = await _put(t, run["id"], "TC-0002", {"status": "passed", "actual_result": "Mine now"}, t.approver)
    assert other.status_code == 403, other.text
    assert other.json()["error"]["message"] == "Only Team Mate can change this result until RUN-0002 is finished."
    # Another member may record a different case in the same run.
    await _record(t, run["id"], "TC-0003", "passed", t.approver)


async def test_blocked_is_not_execution_evidence(team: Team) -> None:
    t = team
    pid = await _project(t)
    run = await _start(t, pid, ["TC-0002", "TC-0003", "TC-0004"])
    for case in ("TC-0002", "TC-0003", "TC-0004"):
        r = await _put(t, run["id"], case, {"status": "blocked", "actual_result": "The sign-in page didn't load"})
        assert r.status_code == 200, r.text
    assert _manual_only(await _gaps(t, pid)) == ["REQ-0002"]
    dod = await _dod(t, pid)
    assert dod["status"] == "not_met" and "REQ-0002" in dod["detail"], dod
    await _record(t, run["id"], "TC-0002", "passed")
    assert _manual_only(await _gaps(t, pid)) == []
    assert (await _dod(t, pid))["status"] == "met"


# ---------------------------------------------------------------- latest wins, no analysis, defects


async def _automated_failure(t: Team, pid: uuid.UUID, case_key: str) -> None:
    """A finished automated run in which `case_key` failed (stored directly: no browser needed)."""
    async with t.ctx.session_factory() as s:
        bind_scope(s, system_scope(t.owner.org_id))
        common = {"organisation_id": t.owner.org_id, "project_id": pid}
        case = (
            await s.execute(select(TestCase).where(TestCase.project_id == pid, TestCase.key == case_key))
        ).scalar_one()
        _n, key = await next_key(s, t.owner.org_id, pid, "run")
        run = ExecutionRun(**common, key=key, status=RunStatus.failed, requested_by=t.owner.user_id,
                           started_at=utcnow(), finished_at=utcnow())  # fmt: skip
        s.add(run)
        await s.flush()
        s.add(ExecutionResult(**common, execution_run_id=run.id, key=f"{key}-01", case_lineage_id=case.lineage_id,
                              test_case_id=case.id, status="failed", actual_result="Timed out"))  # fmt: skip
        await s.commit()


async def test_latest_result_wins_across_manual_and_automated(team: Team) -> None:
    t = team
    pid = await _project(t)
    await _automated_failure(t, pid, "TC-0001")  # RUN-0002
    failed = (await _gaps(t, pid))["failed_tests"]
    assert [(x["case"]["key"], x["run_key"], x["manual"]) for x in failed] == [("TC-0001", "RUN-0002", False)]
    run = await _start(t, pid, ["TC-0001"])  # RUN-0003
    await _record(t, run["id"], "TC-0001", "passed")
    assert (await _gaps(t, pid))["failed_tests"] == []
    matrix = (await t.get(f"/projects/{pid}/traceability")).json()["items"]
    assert "RUN-0003" in json.dumps(matrix) and "RUN-0002" not in json.dumps(matrix)
    from app.services.serialize_p3 import last_results

    async with t.ctx.session_factory() as s:
        bind_scope(s, system_scope(t.owner.org_id))
        latest = await last_results(s, pid)
    got = next(v for v in latest.values() if v["run_key"] == "RUN-0003")
    assert (got["status"], got["manual"], got["recorded_by"]) == ("passed", True, "Team Mate")


async def test_manual_failure_is_not_analysed_and_raises_a_prefilled_defect(team: Team) -> None:
    t = team
    pid = await _project(t)
    run = await _start(t, pid, ["TC-0002"])
    res = (await _record(t, run["id"], "TC-0002", "failed"))["result"]
    up = await _upload(t, res["id"], PNG, "my-screen.png")
    assert up.status_code == 201, up.text
    # Listed among failed tests without a cause; never analysed, never drafted.
    [item] = (await _gaps(t, pid))["failed_tests"]
    assert (item["case"]["key"], item["classification"], item["label"], item["manual"], item["recorded_by"]) == (
        "TC-0002", None, "Not analysed: recorded by a person", True, "Team Mate")  # fmt: skip
    finished = await t.post(f"/execution-runs/{run['id']}/finish", {}, t.member)
    assert finished.status_code == 200, finished.text
    assert finished.json()["run"]["status"] == "failed"
    await worker_for(t.ctx).run_until_idle(timeout=120)
    async with t.ctx.session_factory() as s:
        assert (
            await s.execute(select(Defect).where(Defect.project_id == pid).execution_options(**BYPASS))
        ).first() is None
        fa = (await s.execute(select(StageRun).where(StageRun.project_id == pid,
                                                      StageRun.stage_key == StageKey.failure_analysis)
                              .execution_options(**BYPASS))).scalars().all()  # fmt: skip
        assert fa == []
    assert (await t.post(f"/execution-results/{res['id']}/classification",
                         {"classification": "application_defect", "reason": "x"}, t.member)).status_code == 409  # fmt: skip
    # Raise defect: prefilled from the result.
    r = await t.post(f"/projects/{pid}/defects", {"from_result_id": res["id"]}, t.member)
    assert r.status_code == 201, r.text
    d = r.json()
    assert d["actual"] == WHAT and d["expected"] == "The form posts to an https:// address"
    assert d["environment"]["browser"] == "By hand, recorded by Team Mate", d["environment"]
    assert (d["environment"]["run_key"], d["environment"]["result_key"]) == (run["key"], res["key"])
    assert d["source"] == "user" and d["status"] == "draft"
    assert [e["id"] for e in d["evidence"]] == [up.json()["evidence"]["id"]]


# ---------------------------------------------------------------- validation, uploads, permissions


async def test_validation_messages(team: Team) -> None:
    t = team
    pid = await _project(t)
    run = await _start(t, pid, ["TC-0002"])
    for body in ({"status": "failed"}, {"status": "passed", "actual_result": "   "}):
        r = await _put(t, run["id"], "TC-0002", body)
        assert r.status_code == 422 and r.json()["error"]["message"] == "Describe what happened.", r.text
        assert r.json()["error"]["details"] == [{"field": "actual_result", "message": "Describe what happened."}]
    assert (await _put(t, run["id"], "TC-0002", {"status": "skipped", "actual_result": "x"})).status_code == 422
    assert (await _put(t, run["id"], "TC-0002", {"status": "passed", "actual_result": "x" * 2001})).status_code == 422
    assert (await _put(t, run["id"], "TC-0009", {"status": "passed", "actual_result": "x"})).status_code == 404
    bad = await t.post(f"/projects/{pid}/execution-runs", {"mode": "manual", "case_keys": ["TC-0099"]}, t.member)
    assert bad.status_code == 422 and "TC-0099" in bad.json()["error"]["message"]
    empty = await t.post(f"/projects/{pid}/execution-runs", {"mode": "manual", "case_keys": []}, t.member)
    assert empty.status_code == 422
    over = await t.post(f"/projects/{pid}/execution-runs", {"mode": "manual", "case_keys": ["TC-0002"] * 101}, t.member)
    assert over.status_code == 422
    auth = await t.post(f"/projects/{pid}/execution-runs", {"mode": "manual", "case_keys": ["TC-0002"],
                                                             "authorise": True}, t.approver)  # fmt: skip
    assert auth.status_code == 409 and auth.json()["error"]["message"] == "Manual runs don't run on the platform."


async def test_evidence_uploads(team: Team) -> None:
    t = team
    pid = await _project(t)
    run = await _start(t, pid, ["TC-0002"])
    res = (await _record(t, run["id"], "TC-0002", "failed"))["result"]
    big = await _upload(t, res["id"], PNG + b"\x00" * (12 * 1024 * 1024), "big.png")
    assert big.status_code == 422 and big.json()["error"]["message"] == "This file is larger than 10 MB.", big.text
    fake = await _upload(t, res["id"], HTML_PNG, "shot.png")
    assert fake.status_code == 422, fake.text
    assert fake.json()["error"]["message"] == "This file type isn't supported. Use PNG, JPEG or PDF."
    secret_name = "password=hunter2-screenshot.png"
    kinds = []
    for data, name in ((PNG, secret_name), (JPEG, "b.jpg"), (PDF, "c.pdf"), (PNG, "d.png"), (PNG, "e.png")):
        r = await _upload(t, res["id"], data, name)
        assert r.status_code == 201, r.text
        assert "hunter2" not in r.text and name not in r.text
        kinds.append((r.json()["evidence"]["kind"], r.json()["evidence"]["mime"]))
    assert kinds[:3] == [
        ("screenshot", "image/png"),
        ("screenshot", "image/jpeg"),
        ("document_file", "application/pdf"),
    ]
    six = await _upload(t, res["id"], PNG, "f.png")
    assert six.status_code == 409 and six.json()["error"]["message"] == "A result can have up to 5 files."
    detail = (await t.get(f"/execution-results/{res['id']}")).json()
    assert len(detail["evidence"]) == 5 and not detail["permissions"]["can_upload"]
    url = detail["evidence"][0]["content_url"].removeprefix("http://test")
    served = await t.client.get(url)
    assert served.status_code == 200 and served.content == PNG
    async with t.ctx.session_factory() as s:
        rows = (await s.execute(select(Evidence).where(Evidence.execution_result_id == uuid.UUID(res["id"]))
                                .execution_options(**BYPASS))).scalars().all()  # fmt: skip
        assert all("hunter2" not in json.dumps(e.meta) and "hunter2" not in e.storage_key for e in rows)
        assert rows[0].meta["filename"] == f"{res['key']}-1.png"
    assert len(await _audit(t.ctx, pid, "evidence.uploaded")) == 5
    # Only the recorder, only while recording; never on automated results.
    assert (await _upload(t, res["id"], PNG, "x.png", t.approver)).status_code in (403, 409)
    auto = (await t.get(f"/projects/{pid}/execution-results/by-key/RUN-0001-01")).json()
    assert (await _upload(t, auto["id"], PNG, "x.png")).status_code == 409


async def test_viewer_403_other_organisation_404(team: Team) -> None:
    t = team
    pid = await _project(t)
    run = await _start(t, pid, ["TC-0002", "TC-0003"])
    res = (await _record(t, run["id"], "TC-0002", "failed"))["result"]
    ev = (await _upload(t, res["id"], PNG, "a.png")).json()["evidence"]
    body = {"status": "passed", "actual_result": "ok"}
    # Viewers: every write 403, reads work.
    v = t.viewer
    assert (
        await t.post(f"/projects/{pid}/execution-runs", {"mode": "manual", "case_keys": ["TC-0002"]}, v)
    ).status_code == 403
    assert (await _put(t, run["id"], "TC-0003", body, v)).status_code == 403
    assert (await _upload(t, res["id"], PNG, "a.png", v)).status_code == 403
    assert (await t.post(f"/execution-runs/{run['id']}/finish", {}, v)).status_code == 403
    assert (await t.post(f"/execution-runs/{run['id']}/cancel", {}, v)).status_code == 403
    seen = (await t.get(f"/execution-runs/{run['id']}", v)).json()
    assert seen["status"] == "recording" and not seen["permissions"]["can_record"]
    assert (await t.get(f"/execution-results/{res['id']}", v)).json()["recorded_by"]["full_name"] == "Team Mate"
    # Another organisation: 404 on run, result, evidence and report ids.
    o = t.other.headers
    assert (await t.get(f"/execution-runs/{run['id']}", o)).status_code == 404
    assert (await _put(t, run["id"], "TC-0003", body, o)).status_code == 404
    assert (await t.post(f"/execution-runs/{run['id']}/finish", {}, o)).status_code == 404
    assert (await t.get(f"/execution-results/{res['id']}", o)).status_code == 404
    assert (await _upload(t, res["id"], PNG, "a.png", o)).status_code == 404
    assert (await t.get(f"/evidence/{ev['id']}", o)).status_code == 404
    assert (await t.post(f"/execution-runs/{run['id']}/finish", {}, t.member)).status_code == 200
    await worker_for(t.ctx).run_until_idle(timeout=120)
    [rep] = [x for x in (await t.get(f"/projects/{pid}/reports")).json() if x.get("run_key") == run["key"]]
    assert (await t.get(f"/reports/{rep['id']}")).status_code == 200
    assert (await t.get(f"/reports/{rep['id']}", o)).status_code == 404


# ---------------------------------------------------------------- finish, cancel, report


async def test_finish_with_unrecorded_cases_and_the_run_report(team: Team) -> None:
    t = team
    pid = await _project(t)
    origin = (await t.get(f"/projects/{pid}")).json()["urls"][0]["url"].rstrip("/")
    saved = await t.client.put(f"/api/v1/projects/{pid}/secrets/scan_credentials", headers=t.owner.headers,
                               json={"login_url": f"{origin}/login", "username": "qa-login@shop.test",
                                     "password": "Sup3r-Secret-Pass"})  # fmt: skip
    assert saved.status_code in (200, 201), saved.text
    run = await _start(t, pid, ["TC-0001", "TC-0002", "TC-0003", "TC-0004"])
    nothing = await t.post(f"/execution-runs/{run['id']}/finish", {}, t.member)
    assert nothing.status_code == 409
    assert nothing.json()["error"]["message"] == "Record at least one result before finishing, or cancel the run."
    await _record(t, run["id"], "TC-0001", "passed")
    # A person pasting the saved test account into their notes: it is redacted before it is stored.
    r = await _put(t, run["id"], "TC-0002", {"status": "failed", "actual_result": "Signed in as qa-login@shop.test",
                                              "notes": "used Sup3r-Secret-Pass"})  # fmt: skip
    assert r.status_code == 200 and "Sup3r" not in r.text and "qa-login@" not in r.text
    no_cancel = await t.post(f"/execution-runs/{run['id']}/cancel", {}, t.member)
    assert no_cancel.status_code == 409 and "Finish it instead" in no_cancel.json()["error"]["message"]
    for path in ("authorise", "rerun"):
        body = {"decision": "approve"} if path == "authorise" else {"only": "all"}
        r = await t.post(f"/execution-runs/{run['id']}/{path}", body, t.approver)
        assert r.status_code == 409 and r.json()["error"]["message"] == "Manual runs don't run on the platform.", path
    assert (await t.get(f"/execution-runs/{run['id']}/live")).status_code == 409
    # Any member finishes it (not only the person who started it).
    done = await t.post(f"/execution-runs/{run['id']}/finish", {}, t.approver)
    assert done.status_code == 200, done.text
    assert done.json()["message"] == f"{run['key']} finished: 2 recorded, 2 not run."
    d = done.json()["run"]
    assert (d["status"], d["totals"]["tests"], d["totals"]["finished"]) == ("failed", 4, 2)
    assert [x["status"] for x in d["tests_rows"]] == ["passed", "failed", "not_run", "not_run"]
    assert d["finished_at"] and not d["permissions"]["can_record"]
    # Who finished it, and when each result was saved (the "saved at" that picks the latest result).
    assert d["finished_by"]["full_name"] and d["finished_by"]["id"] != d["requested_by"]["id"], d["finished_by"]
    assert [bool(x["recorded_at"]) for x in d["tests_rows"]] == [True, True, False, False]
    one = (await t.get(f"/execution-results/{d['tests_rows'][0]['id']}")).json()
    assert one["recorded_at"] == d["tests_rows"][0]["recorded_at"]
    chain = (await t.get(f"/projects/{pid}/traceability/chain?key=TC-0001")).json()
    [res] = [lv for lv in chain["downstream"] if lv["type"] == "execution_result"]
    assert [x["label"] for x in res["items"]] == [
        f"{d['tests_rows'][0]['key']} · Passed · By hand · Recorded by Team Mate"
    ]
    late = await _put(t, run["id"], "TC-0003", {"status": "passed", "actual_result": "late"})
    assert late.status_code == 409
    assert late.json()["error"]["message"] == f"{run['key']} is finished. Start a new manual run to record again."
    [fin] = await _audit(t.ctx, pid, "execution_run.finished")
    assert fin.meta == {"key": run["key"], "status": "failed", "recorded": 2, "tests": 4}
    # The run's frozen Test Execution Report.
    await worker_for(t.ctx).run_until_idle(timeout=120)
    [rep] = [x for x in (await t.get(f"/projects/{pid}/reports")).json() if x.get("run_key") == run["key"]]
    content = (await t.get(f"/reports/{rep['id']}")).json()["content"]
    assert content["frozen"] and content["run"]["mode"] == "manual" and content["totals"]["tests"] == 2
    assert content["run"]["not_recorded"] == ["TC-0003", "TC-0004"]
    rows = content["results"]
    assert [(x["case_key"], x["status"], x["browser"], x["recorded_by"], x["cause"]) for x in rows] == [
        ("TC-0001", "passed", "By hand", "Team Mate", None), ("TC-0002", "failed", "By hand", "Team Mate", None)]  # fmt: skip
    assert rows[0]["what_happened"] == WHAT and rows[0]["notes"] == "Checked twice"
    assert any("not recorded (Not run)" in x for x in content["limitations"])
    # The saved test account appears in no format of the report.
    async with t.ctx.session_factory() as s:
        report = (await s.execute(select(QaReport).where(QaReport.id == uuid.UUID(rep["id"]))
                                  .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        files = report.files or []
        evs = {e.id: e for e in (await s.execute(select(Evidence).where(Evidence.id.in_(
            [uuid.UUID(f["evidence_id"]) for f in files])).execution_options(**BYPASS))).scalars()}  # fmt: skip
    assert {f["format"] for f in files} >= {"html", "json", "csv", "pdf"}
    blobs = [json.dumps(report.content).encode()] + [await t.ctx.storage.get(e.storage_key) for e in evs.values()]
    html_file = next(f for f in files if f["format"] == "html")
    html = await t.ctx.storage.get(evs[uuid.UUID(html_file["evidence_id"])].storage_key)
    assert b"By hand" in html and b"Recorded by" in html and b"Likely cause" not in html
    for blob in blobs:
        assert b"Sup3r-Secret-Pass" not in blob and b"qa-login@shop.test" not in blob


async def test_cancel_only_without_results(team: Team) -> None:
    t = team
    pid = await _project(t)
    run = await _start(t, pid, ["TC-0002"])
    assert run["permissions"]["can_cancel"]
    r = await t.post(f"/execution-runs/{run['id']}/cancel", {}, t.member)
    assert r.status_code == 200 and r.json()["message"] == f"{run['key']} cancelled."
    assert r.json()["run"]["status"] == "cancelled"
    late = await _put(t, run["id"], "TC-0002", {"status": "passed", "actual_result": "x"})
    assert late.status_code == 409 and "was cancelled" in late.json()["error"]["message"]
    wf = (await t.get(f"/projects/{pid}/workflow")).json()
    assert next(x for x in wf["stages"] if x["key"] == "execution")["status"] != "cancelled"


# ---------------------------------------------------------------- never blocks automated runs or load tests


async def test_recording_run_does_not_block_an_automated_run_or_a_load_test(
    team: Team,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.agents.execution.engine import Engine
    from app.agents.performance.runner import LoadTestJob

    t = team
    pid = await _project(t)
    manual = await _start(t, pid, ["TC-0002"])
    await _record(t, manual["id"], "TC-0002", "passed")
    # An automated request waiting for G7 (stored directly: its scope has no script, the engine is stubbed).
    scope: dict[str, Any] = {"cases": [], "browsers": ["chromium"], "viewports": ["desktop"], "tests": 0}
    async with t.ctx.session_factory() as s:
        bind_scope(s, system_scope(t.owner.org_id))
        _n, key = await next_key(s, t.owner.org_id, pid, "run")
        auto = ExecutionRun(organisation_id=t.owner.org_id, project_id=pid, key=key, scope=scope,
                            scope_hash=apr.scope_hash(scope), config={"plan": []}, requested_by=t.owner.user_id,
                            status=RunStatus.awaiting_authorisation)  # fmt: skip
        s.add(auto)
        await s.commit()
        auto_id = auto.id
    started: list[uuid.UUID] = []

    async def fake_execute(self: Engine, _project: Any) -> None:
        started.append(self.run_id)

    monkeypatch.setattr(Engine, "_execute", fake_execute)
    r = await t.post(f"/execution-runs/{auto_id}/authorise", {"decision": "approve"}, t.approver)
    assert r.status_code == 200 and r.json()["status"] == "queued", r.text
    await worker_for(t.ctx).run_until_idle(timeout=60)
    assert started == [auto_id]  # it started at once beside the recording manual run
    assert (await t.get(f"/execution-runs/{manual['id']}")).json()["status"] == "recording"
    # A queued load test isn't held back either: it goes on to its own checks (here: it has no approval).
    async with t.ctx.session_factory() as s:
        bind_scope(s, system_scope(t.owner.org_id))
        await s.execute(text("UPDATE execution_runs SET status = 'cancelled' WHERE id = :i"), {"i": auto_id.hex})
        prof = PerformanceProfile(organisation_id=t.owner.org_id, project_id=pid, key="PRF-02", name="Load",
                                  stages=[{"duration_s": 30, "target_vus": 5}], max_rps=10,
                                  targets=[{"path": "/", "weight": 1}])  # fmt: skip
        s.add(prof)
        await s.flush()
        perf = PerformanceRun(organisation_id=t.owner.org_id, project_id=pid, key="PERF-0002", profile_id=prof.id,
                              profile_hash="b" * 64, status=PerfRunStatus.queued)  # fmt: skip
        s.add(perf)
        await s.commit()
        perf_id = perf.id
    await LoadTestJob(t.ctx, system_scope(t.owner.org_id), perf_id).run()
    async with t.ctx.session_factory() as s:
        row = (await s.execute(select(PerformanceRun).where(PerformanceRun.id == perf_id)
                               .execution_options(**BYPASS))).scalar_one()  # fmt: skip
    assert row.status == PerfRunStatus.error and "no approval" in (row.error or ""), (row.status, row.error)


# ---------------------------------------------------------------- release readiness, D37


async def test_saving_a_result_makes_a_waiting_assessment_stale(team: Team) -> None:
    t = team
    pid = await _project(t)
    a = await assess(t, pid)
    assert a["status"] == "awaiting_approval"
    run = await _start(t, pid, ["TC-0002"])
    await _record(t, run["id"], "TC-0002", "passed")
    stale = (await t.get(f"/release-assessments/{a['id']}")).json()
    assert (stale["status"], stale["stale_reason"]) == ("stale", "TC-0002 recorded by hand (passed)")
    # D40: manual results count in the next assessment; high-risk evidence says who recorded it.
    run2 = await _start(t, pid, ["TC-0001"])
    await _record(t, run2["id"], "TC-0001", "passed")
    b = await assess(t, pid)
    hr = next(c for c in b["criteria"] if c["id"] == "rr.high_risk_tested")
    assert hr["status"] == "met" and "TC-0001 by hand, recorded by Team Mate" in hr["detail"], hr


async def test_d37_endpoint_keeps_its_contract_and_writes_manual_results(team: Team) -> None:
    t = team
    pid = await fixture_project(t)
    cs = await _change_set(t, pid)
    url = f"/change-sets/{cs}/manual-retests"
    # A legacy row (before D39) counts until a newer manual result replaces it.
    async with t.ctx.session_factory() as s:
        bind_scope(s, system_scope(t.owner.org_id))
        row = (await s.execute(select(ChangeSet).where(ChangeSet.id == uuid.UUID(cs)))).scalar_one()
        case = (await s.execute(select(TestCase).where(TestCase.project_id == pid))).scalar_one()
        s.add(ManualRetest(organisation_id=t.owner.org_id, project_id=pid, change_set_id=row.id,
                           case_lineage_id=case.lineage_id, test_case_id=case.id, status=ManualRetestStatus.failed,
                           note="Legacy: no confirmation", recorded_by=t.owner.user_id))  # fmt: skip
        await s.commit()
    seen = (await t.get(url, t.viewer)).json()
    legacy = seen["items"][0]["latest"]
    assert (legacy["status"], legacy["note"], legacy["run_key"], legacy["result_key"]) == (
        "failed", "Legacy: no confirmation", None, None)  # fmt: skip
    a = await assess(t, pid)
    assert next(c for c in a["criteria"] if c["id"] == "rr.manual_retests")["status"] == "not_met"
    body = {"case_key": "TC-0001", "status": "passed", "note": "Sent the form with the new button: message arrives"}
    r = await t.post(url, body, t.member)
    assert r.status_code == 201, r.text
    out = r.json()
    assert set(out) == {"change_set", "items", "counts", "permissions", "message"}
    assert out["message"] == "Manual re-test of TC-0001 recorded: passed."
    item = out["items"][0]
    assert set(item) == {"case_key", "title", "test_case_id", "case_lineage_id", "reasons", "latest", "history"}
    latest = item["latest"]
    assert set(latest) == {"id", "status", "note", "recorded_by", "recorded_at", "run_key", "result_key"}
    assert (latest["status"], latest["note"], latest["recorded_by"]["full_name"]) == ("passed", body["note"],
                                                                                       "Team Mate")  # fmt: skip
    assert latest["run_key"] == "RUN-0002" and latest["result_key"] == "RUN-0002-01"
    assert [h["status"] for h in item["history"]] == ["passed", "failed"]
    run = (await t.get(f"/projects/{pid}/execution-runs/by-key/RUN-0002")).json()
    assert (run["mode"], run["status"], run["manual"]["change_set_key"]) == ("manual", "recording", "CHG-0001")
    stale = (await t.get(f"/release-assessments/{a['id']}")).json()
    assert stale["stale_reason"] == "Manual re-test of TC-0001 recorded (passed)"
    b = await assess(t, pid)
    crit_b = {c["id"]: c for c in b["criteria"]}
    assert crit_b["rr.impacted_rerun"]["status"] == "met" and crit_b["rr.manual_retests"]["status"] == "met"
    # Recording again in the same run updates that result; a failed one is a condition with its note.
    r = await t.post(url, {**body, "status": "failed", "note": "No confirmation this time"}, t.member)
    assert r.status_code == 201 and r.json()["items"][0]["latest"]["result_key"] == "RUN-0002-01"
    c = await assess(t, pid)
    assert any("No confirmation this time" in x["text"] for x in c["conditions_list"])
    # The same validation and messages as before.
    r = await t.post(url, {"case_key": "TC-0001", "note": "ok"}, t.member)
    assert r.status_code == 422 and r.json()["error"]["details"][0] == {"field": "status",
                                                                        "message": "Choose Passed or Failed."}  # fmt: skip
    assert (await t.post(url, body, t.viewer)).status_code == 403
    assert (await t.post(url, body, t.other.headers)).status_code == 404


# ---------------------------------------------------------------- assistant


async def test_assistant_cites_manual_results_separately(team: Team) -> None:
    from tests.integration.test_p6_assistant_release import _ask

    t = team
    pid = await _project(t)
    run = await _start(t, pid, ["TC-0002", "TC-0003"])
    await _record(t, run["id"], "TC-0002", "failed")
    await _record(t, run["id"], "TC-0003", "passed")
    ans = await _ask(t, pid, {"content": "Did the tests pass?"}, t.member)
    assert ans["intent"] == "execution_results", ans
    lines = ans["content"].splitlines()
    assert lines[0].startswith("RUN-0001 (passed): 1 passed"), lines
    assert lines[-1] == "By hand since then: RUN-0002 (still recording), 2 recorded: 1 passed, 1 failed (TC-0002).", (
        lines
    )
    assert {"RUN-0001", "RUN-0002"} <= {c["key"] for c in ans["citations"]}
    explain = await _ask(t, pid, {"content": "Explain the failed test TC-0002"}, t.member)
    assert explain["intent"] == "explain_failed_test", explain
    text_ = explain["content"]
    assert "Recorded by a person; not analysed." in text_ and f'What happened: "{WHAT}"' in text_
    assert "Likely cause" not in text_ and "application_defect" not in text_ and "hypothesis" not in text_.lower()
    assert "Raise defect" in text_


# ---------------------------------------------------------------- migration


async def test_migration_0022_up_down_up(team: Team) -> None:
    t = team
    pid = await _project(t)
    run = await _start(t, pid, ["TC-0002"])
    await _record(t, run["id"], "TC-0002", "passed")
    engine = t.ctx.engine
    await downgrade(engine, "0021")
    async with engine.connect() as conn:
        status = (
            await conn.execute(text("SELECT status FROM execution_runs WHERE key = :k"), {"k": run["key"]})
        ).scalar_one()
        assert status == "cancelled"
        cols = {r[1] for r in (await conn.execute(text("PRAGMA table_info(execution_results)"))).all()}
        assert not {"recorded_by", "notes", "recorded_at"} & cols
        n = (await conn.execute(text("SELECT COUNT(*) FROM execution_results WHERE key = :k"),
                                {"k": f"{run['key']}-01"})).scalar_one()  # fmt: skip
        assert n == 1  # the saved result stays
    with pytest.raises(IntegrityError):
        async with engine.begin() as conn:
            await conn.execute(text("UPDATE execution_runs SET status = 'recording' WHERE key = :k"), {"k": run["key"]})
    await upgrade(engine)
    async with engine.begin() as conn:
        await conn.execute(text("UPDATE execution_runs SET status = 'recording' WHERE key = :k"), {"k": run["key"]})
        cols = {r[1] for r in (await conn.execute(text("PRAGMA table_info(execution_results)"))).all()}
        assert {"recorded_by", "notes", "recorded_at"} <= cols
        fks = (await conn.execute(text("PRAGMA foreign_key_list(execution_results)"))).all()
        assert any(f[2] == "users" and f[3] == "recorded_by" for f in fks)
    rows = await _audit(t.ctx, pid, "execution_run.manual_started")
    assert isinstance(rows[0], AuditLog)


async def test_assistant_answers_from_the_latest_manual_run_when_nothing_ran_automatically(
    team: Team,
) -> None:
    from tests.integration.test_p6_assistant_release import _ask

    t = team
    pid = await _project(t)
    async with t.ctx.session_factory() as s:  # no finished automated run: the fixture's RUN-0001 never ran
        await s.execute(text("UPDATE execution_runs SET status = 'rejected' WHERE key = 'RUN-0001'"))
        await s.commit()
    run = await _start(t, pid, ["TC-0002"])
    await _record(t, run["id"], "TC-0002", "blocked")
    ans = await _ask(t, pid, {"content": "Did the tests pass?"}, t.member)
    assert ans["content"].splitlines() == [
        "Recorded by hand: RUN-0002 (still recording), 1 recorded: 1 blocked (TC-0002).",
        "Results recorded by a person are not analysed.",
    ], ans["content"]
    assert "RUN-0002" in {c["key"] for c in ans["citations"]}


async def test_completion_report_labels_manual_runs_and_leaves_out_empty_cancelled_ones(team: Team) -> None:
    from tests.integration.test_p6_release import assess
    from tests.integration.test_p6_reports import _detail, _ready

    t = team
    pid = await _project(t)
    done = await _start(t, pid, ["TC-0002"])  # RUN-0002, finished with one result
    await _record(t, done["id"], "TC-0002", "passed")
    assert (await t.post(f"/execution-runs/{done['id']}/finish", {}, t.member)).status_code == 200
    empty = await _start(t, pid, ["TC-0003"])  # RUN-0003, cancelled before anything was recorded
    assert (await t.post(f"/execution-runs/{empty['id']}/cancel", {}, t.member)).status_code == 200
    await assess(t, pid)
    r = await t.post(f"/projects/{pid}/reports", {"report_type": "completion", "basis": "current"}, t.member)
    assert r.status_code in (200, 201, 202), r.text
    [rep] = await _ready(t, pid, "completion")
    runs = {x["key"]: x for x in (await _detail(t, rep["id"]))["content"]["runs"]}
    assert set(runs) == {"RUN-0001", "RUN-0002"}, runs
    assert runs["RUN-0002"]["selection"] == "Manual" and runs["RUN-0001"]["selection"] != "Manual"
