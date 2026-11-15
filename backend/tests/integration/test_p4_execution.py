"""Phase 4 execution, analysis and defects against the local fixture site with AI off (P4-06, P4-08, P4-09):
a member requests a run (nothing touches the site), G7 by an approver, the empty-Message case fails on both
attempts once the fixture's contact form has the demo's bug, the analysis calls it a likely application bug and
drafts a defect, G8 confirms it, a repeat failure adds an occurrence, a fix is verified only after a passing
re-run, saved credentials never leak, and tenants are isolated. The tests share one project but not an order: each
sets up what it needs through the helpers below (G3 → G6 runs once) and puts back what it changes."""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import select, text

from app.context import build_context
from app.db.models import Evidence
from app.db.tenant import BYPASS
from app.domain.enums import Role
from app.llm.base import DisabledLLM
from tests.conftest import client_for, make_settings, register
from tests.fixtures.site import running_site
from tests.integration.test_p4_automation import API, Flow, _user

pytestmark = pytest.mark.skipif(
    not (Path(__file__).resolve().parents[3] / "automation" / "node_modules" / "@playwright" / "test").is_dir(),
    reason="the automation toolkit's dependencies are not installed",
)
USERNAME, PASSWORD = "runner@fixture.example.com", "Fixture-Pass-9137"


@pytest.fixture(scope="module")
async def flow(tmp_path_factory: pytest.TempPathFactory, template_db: Path) -> AsyncIterator[Flow]:
    import shutil

    tmp = tmp_path_factory.mktemp("p4exec")
    shutil.copy(template_db, tmp / "qa.db")
    ctx = build_context(make_settings(tmp, allow_private_targets=True), llm=DisabledLLM())
    with running_site() as (base_url, site):
        async with client_for(ctx) as client:
            owner = await register(client, "owner@p4x.example.com", org="P4X Org")
            other = await register(client, "other@p4x.example.com", org="Other X Org")
            member = await _user(ctx, client, owner.org_id, "member@p4x.example.com", Role.member)
            approver = await _user(ctx, client, owner.org_id, "approver@p4x.example.com", Role.member, True)
            viewer = await _user(ctx, client, owner.org_id, "viewer@p4x.example.com", Role.viewer)
            r = await client.post(
                f"{API}/projects",
                headers=owner.headers,
                json={
                    "url": base_url,
                    "name": "Fixture shop",
                    "start": True,
                    "authorisation": {"attested": True, "statement": "Local fixture site owned by the test suite."},
                    "scan": {"max_pages": 30, "max_depth": 3},
                },
            )
            assert r.status_code == 201, r.text
            f = Flow(ctx, client, site, owner, member, approver, viewer, other, r.json()["id"])
            f.state["base"] = base_url
            await f.idle()
            yield f
    await ctx.close()


async def _through_g6(flow: Flow) -> None:
    reqs = (await flow.get(f"/projects/{flow.pid}/requirements?limit=100")).json()["items"]
    drafts = [r["id"] for r in reqs if r["status"] == "draft" and r["classification"] in ("observed", "inferred")]
    assert (
        await flow.post(f"/projects/{flow.pid}/requirements/bulk-status", {"ids": drafts, "status": "approved"})
    ).status_code == 200
    assert (await flow.gate("G3")).status_code == 200
    await flow.idle()
    assert (await flow.gate("G4")).status_code == 200
    await flow.idle()
    for c in await flow.cases():
        if c["expected_result_status"] == "open_question":
            d = (await flow.get(f"/projects/{flow.pid}/test-cases/by-key/{c['key']}")).json()
            r = await flow.client.patch(
                f"{API}/test-cases/{d['id']}",
                headers=flow.owner.headers,
                json={
                    "version": d["version"],
                    "change_reason": "Decided by the PO",
                    "expected_result": "The form is sent and a confirmation is shown",
                },
            )
            assert r.status_code == 200, r.text
    cases = await flow.cases()
    assert (
        await flow.post(
            f"/projects/{flow.pid}/test-cases/bulk-status",
            {"ids": [c["id"] for c in cases if c["status"] == "draft"], "status": "approved"},
        )
    ).status_code == 200
    assert (await flow.gate("G5", flow.approver)).status_code == 200
    await flow.idle()
    auto = await flow.automation()
    assert auto["g6"]["state"] == "passed_automatically", auto["g6"]
    scripts = {x["case_key"]: x for x in auto["bundle"]["scripts"]}
    empty = next(
        x
        for x in scripts.values()
        if x["case_title"] in ("Message left empty: rejected", "Send the contact form with an empty Message")
    )
    flow.state.update(scripts=scripts, empty=empty["case_key"])


async def _ready(flow: Flow) -> None:
    """Once per module, for whichever test comes first: approved cases, a passed G6 and a first run in which the
    empty-Message case fails and drafts its defect. No test makes that case pass, so its history holds failures only
    and later failures read as a likely bug, not "flaky"."""
    if "scripts" not in flow.state:
        await _through_g6(flow)
        flow.state["failed"] = await _failing_run(flow)
        flow.state["failed_stage"] = (await flow.stage("execution"))["status"]


async def _run(flow: Flow, keys: list[str], who: dict[str, str], **extra: Any) -> dict[str, Any]:
    r = await flow.post(f"/projects/{flow.pid}/execution-runs", {"selection": {"case_keys": keys}, **extra}, who)
    assert r.status_code == 201, r.text
    return dict(r.json())


async def _authorise(flow: Flow, run: dict[str, Any]) -> dict[str, Any]:
    r = await flow.post(f"/execution-runs/{run['id']}/authorise", {"decision": "approve"}, flow.approver)
    assert r.status_code == 200, r.text
    await flow.idle()
    return dict((await flow.get(f"/execution-runs/{run['id']}")).json())


async def _failing_run(flow: Flow) -> tuple[dict[str, Any], dict[str, Any]]:
    """A member asks for the empty-Message case with the demo's bug switched on and an approver authorises it, so
    it fails (and drafts a defect or adds an occurrence to the open one). Returns the finished run and its result."""
    await _ready(flow)
    bug, flow.site.contact_bug = flow.site.contact_bug, True
    try:
        run = await _authorise(flow, await _run(flow, [flow.state["empty"]], flow.member))
    finally:
        flow.site.contact_bug = bug
    res = (await flow.get(f"/execution-results/{run['tests_rows'][0]['id']}")).json()
    return run, dict(res)


async def _failed(flow: Flow) -> tuple[dict[str, Any], dict[str, Any]]:
    """The module's first run (the empty-Message case failing) and its result, as they were when it finished."""
    await _ready(flow)
    run, res = flow.state["failed"]
    return dict(run), dict(res)


async def _draft(flow: Flow) -> dict[str, Any]:
    """A draft defect of the empty-Message case: the one its first failure drafted or, once that has been decided,
    one a person raises from the same failure."""
    res = (await _failed(flow))[1]
    d = dict((await flow.get(f"/defects/{res['defect']['id']}")).json())
    if d["status"] != "draft":
        r = await flow.post(f"/projects/{flow.pid}/defects", {"from_result_id": res["id"]}, flow.member)
        assert r.status_code == 201, r.text
        d = dict(r.json())
    assert d["status"] == "draft", d["status"]
    return d


async def test_run_responses_show_names_not_emails_to_members_and_viewers(flow: Flow) -> None:
    """QA P4-BUG-05: requested_by and authorisation.by follow the P3-07 rule (email for owners and admins only)."""
    run = (await _failed(flow))[0]
    for who in (flow.member, flow.viewer):
        d = (await flow.get(f"/execution-runs/{run['id']}", who)).json()
        for person in (d["requested_by"], d["authorisation"]["by"]):
            assert person["full_name"] and person["email"] is None, person
        listed = (await flow.get(f"/projects/{flow.pid}/execution-runs", who)).json()
        items = listed["items"] if isinstance(listed, dict) else listed
        assert all((x["requested_by"] or {}).get("email") is None for x in items)
        assert "@p4x.example.com" not in json.dumps(d, default=str), "an email address reached a member or viewer"
    owner = (await flow.get(f"/execution-runs/{run['id']}")).json()
    assert owner["requested_by"]["email"] == "member@p4x.example.com"


async def test_request_waits_for_g7_and_touches_nothing(flow: Flow) -> None:
    await _ready(flow)
    key = flow.state["empty"]
    seen = len(flow.site.requests)
    assert (
        await flow.post(f"/projects/{flow.pid}/execution-runs", {"selection": {"case_keys": [key]}}, flow.viewer)
    ).status_code == 403
    run = await _run(flow, [key], flow.member, notes="Before the release meeting")
    assert run["status"] == "awaiting_authorisation" and re.fullmatch(r"RUN-\d{4}", run["key"])
    assert run["tests"] == 1 and run["tests_rows"][0]["status"] == "waiting"
    assert (
        run["scope"]["side_effects"][0]["text"] == "May submit the Contact form (if the application does not block it)"
    )
    assert run["permissions"]["can_authorise"] is False and run["permissions"]["is_requester"] is True
    await flow.idle()
    assert len(flow.site.requests) == seen, "a run request never contacts the site"
    # G7: members can't authorise; rejecting needs a comment; an unknown case is a 422, an invalid script a 409.
    assert (
        await flow.post(f"/execution-runs/{run['id']}/authorise", {"decision": "approve"}, flow.member)
    ).status_code == 403
    no = await flow.post(f"/execution-runs/{run['id']}/authorise", {"decision": "reject"}, flow.approver)
    assert no.status_code == 422 and no.json()["error"]["message"] == "Say why this run shouldn't go ahead."
    assert (
        await flow.post(f"/projects/{flow.pid}/execution-runs", {"selection": {"case_keys": ["TC-9999"]}}, flow.member)
    ).status_code == 422
    w = await flow.post(f"/execution-runs/{run['id']}/cancel", {}, flow.member)
    assert w.status_code == 200 and len(flow.site.requests) == seen


async def test_authorised_run_fails_the_empty_message_case_with_evidence(flow: Flow) -> None:
    run, res = await _failed(flow)
    assert run["status"] == "failed", run
    assert run["authorisation"]["decision"] == "approve" and run["authorisation"]["self_authorised"] is False
    assert flow.site.contact_posts, "the buggy form was really submitted"
    row = run["tests_rows"][0]
    assert row["status"] == "failed" and row["attempts"] == 2, row  # D9: one retry
    assert res["id"] == row["id"]
    assert res["error"].startswith("QA_ASSERTION:"), res["error"]
    assert "Thank you" in res["actual_result"] and res["actual_result"].startswith("Step '")
    assert res["failed_step"]["title"] == "Press Send message"
    assert len(res["attempt_details"]) == 2 and all(a["status"] == "failed" for a in res["attempt_details"])
    kinds = {e["kind"] for e in res["evidence"]}
    assert {"screenshot", "video", "console_log", "network_log"} <= kinds, kinds
    shot = next(e for e in res["evidence"] if e["kind"] == "screenshot")
    img = await flow.client.get("/" + shot["content_url"].split("://", 1)[1].split("/", 1)[1])
    assert img.status_code == 200 and img.headers["content-type"] == "image/png"
    assert res["page_state"]["browser"].startswith("Chromium ")
    # Events carry keys and counts only.
    events = await flow.events()
    mine = f"{run['key']} finished"
    finished = [e for e in events if e["type"] == "execution.run_status" and e["message"].startswith(mine)]
    assert finished and finished[-1]["message"].startswith(f"{mine}: 0 passed · 1 failed")
    for e in events:
        if e["type"].startswith("execution."):
            assert "Thank you" not in e["message"] and "QA_ASSERTION" not in str(e.get("data"))
    assert flow.state["failed_stage"] == "completed"


async def test_analysis_calls_it_a_likely_bug_and_drafts_a_defect(flow: Flow) -> None:
    run, first = await _failed(flow)
    res = (await flow.get(f"/execution-results/{first['id']}")).json()
    a = res["analysis"]
    assert a["classification"] == "application_defect" and a["confidence"] in ("medium", "high"), a
    assert a["hypothesis"] is True and a["generated_by"] == "rules" and a["label"] == "Likely bug in the application"
    codes = {s["code"] for s in a["signals"]}
    assert {"assertion_failed_after_actions", "failed_every_attempt"} <= codes, codes
    assert {r["kind"] for r in a["evidence_refs"]} >= {"screenshot", "video"}
    assert res["status"] == "failed", "analysis never changes the status"
    d = res["defect"]
    assert re.fullmatch(r"DEF-\d{4}", d["key"]), d
    run = (await flow.get(f"/execution-runs/{run['id']}")).json()
    assert run["analysis"]["output"]["by_classification"] == {"application_defect": 1}
    defect = (await flow.get(f"/defects/{d['id']}")).json()
    assert defect["summary"] in (
        "Contact form accepts an empty Message",
        "Message left empty: rejected: the expected result didn't happen",
    )
    assert "Thank you" in defect["actual"] and defect["expected"]
    assert defect["environment"]["url"].startswith("http://127.0.0.1:") and defect["environment"]["browser"].startswith(
        "Chromium"
    )
    assert defect["reproducibility"]["text"] == "2 of 2 attempts (always)"
    assert defect["severity"] == "major" and defect["severity_reason"] == "a blocked submission failed"
    assert defect["priority_reason"] == f"from {flow.state['empty']}"
    assert defect["root_cause_hypothesis"].startswith("Likely bug in the application")
    assert defect["cases"] == [flow.state["empty"]] and defect["steps"] and defect["evidence"]
    if defect["status"] == "draft":
        assert (await flow.stage("defects_summary"))["status"] == "awaiting_approval"


async def test_g8_confirm_roles_and_no_delete(flow: Flow) -> None:
    draft = await _draft(flow)
    did = draft["id"]
    assert (await flow.post(f"/defects/{did}/status", {"action": "confirm"}, flow.member)).status_code == 403
    assert (await flow.post(f"/defects/{did}/status", {"action": "confirm"}, flow.viewer)).status_code == 403
    assert (await flow.client.delete(f"{API}/defects/{did}", headers=flow.owner.headers)).status_code == 405
    bad = await flow.client.patch(
        f"{API}/defects/{did}",
        headers=flow.member,
        json={"version": draft["version"], "classification": "flaky"},
    )
    assert bad.status_code == 422
    ok = await flow.post(f"/defects/{did}/status", {"action": "confirm"}, flow.approver)
    assert ok.status_code == 200 and ok.json()["message"] == f"{draft['key']} confirmed."
    d = ok.json()["defect"]
    assert d["status"] == "confirmed" and d["g8"]["decision"] == "approve"
    assert (await flow.stage("defects_summary"))["status"] == "completed"
    # QA P4-BUG-05 (P3-07 rule): members and viewers see the decider's name, never their email; owners see both.
    for who in (flow.member, flow.viewer):
        g8 = (await flow.get(f"/defects/{did}", who)).json()["g8"]["by"]
        assert g8["full_name"] and g8["email"] is None, g8
        revs = (await flow.get(f"/defects/{did}/revisions", who)).json()
        assert all(r["changed_by"] is None or r["changed_by"]["email"] is None for r in revs)
    assert (await flow.get(f"/defects/{did}")).json()["g8"]["by"]["email"] == "approver@p4x.example.com"
    early = await flow.post(f"/defects/{did}/status", {"action": "verified"}, flow.approver)
    assert early.status_code == 409  # confirmed, not fixed yet


async def test_repeat_failure_adds_an_occurrence(flow: Flow) -> None:
    await _ready(flow)
    listing = (await flow.get(f"/projects/{flow.pid}/defects?status=all")).json()["items"]
    seen = {x["id"]: len((await flow.get(f"/defects/{x['id']}")).json()["occurrences"]) for x in listing}
    flow.site.contact_bug = True
    try:
        run = await _run(flow, [flow.state["empty"]], flow.approver, authorise=True)
        assert run["status"] == "queued" and run["authorisation"]["self_authorised"] is True
        await flow.idle()
    finally:
        flow.site.contact_bug = False
    row = (await flow.get(f"/execution-runs/{run['id']}")).json()["tests_rows"][0]
    res = (await flow.get(f"/execution-results/{row['id']}")).json()
    assert res["analysis"]["classification"] == "application_defect", res["analysis"]
    did = res["defect"]["id"]
    assert did in seen, "the open defect gains an occurrence"
    d = (await flow.get(f"/defects/{did}")).json()
    assert len(d["occurrences"]) == seen[did] + 1 and d["reproducibility"]["occurrences"] == seen[did] + 1
    after = (await flow.get(f"/projects/{flow.pid}/defects?status=all")).json()["items"]
    assert [x["key"] for x in after] == [x["key"] for x in listing], "no new defect"


async def test_fix_is_verified_only_after_a_passing_rerun(flow: Flow) -> None:
    # Its own case and defect, so the empty-Message case is never made to pass: a test that fails while the site is
    # down, raised as a defect by a person and confirmed at G8.
    key = (await _quiet_keys(flow))[-1]
    flow.site.down = True
    try:
        failed_run = await _run(flow, [key], flow.approver, authorise=True)
        await flow.idle()
    finally:
        flow.site.down = False
    row = (await flow.get(f"/execution-runs/{failed_run['id']}")).json()["tests_rows"][0]
    assert row["status"] in ("failed", "error"), row
    body = {"from_result_id": row["id"], "summary": "The site doesn't respond"}
    raised = await flow.post(f"/projects/{flow.pid}/defects", body, flow.member)
    assert raised.status_code == 201, raised.text
    did, dkey = raised.json()["id"], raised.json()["key"]
    assert (await flow.post(f"/defects/{did}/status", {"action": "confirm"}, flow.approver)).status_code == 200
    fixed = await flow.post(f"/defects/{did}/status", {"action": "fixed"}, flow.member)
    assert fixed.status_code == 200 and fixed.json()["message"].startswith(f"{dkey} marked fixed. Re-run ")
    early = await flow.post(f"/defects/{did}/status", {"action": "verified"}, flow.approver)
    assert early.status_code == 409 and early.json()["error"]["message"].startswith("No passing re-run yet")
    rerun = await flow.post(f"/execution-runs/{failed_run['id']}/rerun", {"only": "failed"}, flow.member)
    assert rerun.status_code == 201 and rerun.json()["status"] == "awaiting_authorisation"
    done = await _authorise(flow, rerun.json())
    assert done["status"] == "passed" and done["tests_rows"][0]["status"] == "passed", done["tests_rows"]
    ok = await flow.post(f"/defects/{did}/status", {"action": "verified"}, flow.approver)
    assert ok.status_code == 200 and ok.json()["defect"]["status"] == "verified"
    assert (await flow.post(f"/defects/{did}/status", {"action": "closed"}, flow.member)).status_code == 200


async def test_cancel_a_queued_run_and_withdraw_a_request(flow: Flow) -> None:
    await _ready(flow)
    run = await _run(flow, [flow.state["empty"]], flow.member)
    assert (await flow.post(f"/execution-runs/{run['id']}/cancel", {}, flow.viewer)).status_code == 403
    w = await flow.post(f"/execution-runs/{run['id']}/cancel", {}, flow.member)
    assert w.status_code == 200 and w.json()["message"] == "Request withdrawn. Nothing ran."
    run = await _run(flow, [flow.state["empty"]], flow.approver, authorise=True)
    c = await flow.post(f"/execution-runs/{run['id']}/cancel", {}, flow.approver)
    assert c.status_code == 200 and c.json()["run"]["status"] == "cancelled"
    await flow.idle()
    rows = (await flow.get(f"/execution-runs/{run['id']}/results")).json()
    assert [r["status"] for r in rows] == ["error"] and rows[0]["error_reason"] == "Run cancelled"


async def test_credentials_never_leak_from_a_signed_in_run(flow: Flow) -> None:
    await _ready(flow)
    base = flow.state["base"]
    r = await flow.client.put(
        f"{API}/projects/{flow.pid}/secrets/scan_credentials",
        headers=flow.owner.headers,
        json={"login_url": f"{base.rstrip('/')}/login", "username": USERNAME, "password": PASSWORD},
    )
    assert r.status_code in (200, 201), r.text
    try:
        await _check_signed_in_run(flow)
    finally:
        await flow.client.delete(f"{API}/projects/{flow.pid}/secrets/{r.json()['id']}", headers=flow.owner.headers)


async def _check_signed_in_run(flow: Flow) -> None:
    scope = (await flow.post(f"/projects/{flow.pid}/execution-runs/preview", {})).json()
    signing = [c["key"] for c in scope["cases"] if c["signs_in"]]
    if not signing:
        pytest.skip("no automated case signs in on this fixture")
    run = await _run(flow, signing[:1], flow.approver, authorise=True)
    await flow.idle()
    run = (await flow.get(f"/execution-runs/{run['id']}")).json()
    assert run["status"] in ("passed", "failed"), run
    res = (await flow.get(f"/execution-results/{run['tests_rows'][0]['id']}")).json()
    assert not any(e["kind"] == "trace" for e in res["evidence"]), "no trace for tests that sign in"
    # Search every table and every stored evidence file for the username and password.
    async with flow.ctx.session_factory() as s:
        names = [t for (t,) in (await s.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))).all()]
        for table in names:
            for row in (await s.execute(text(f'SELECT * FROM "{table}"'))).all():  # noqa: S608 - test-only dump
                blob = " ".join(str(v) for v in row)
                assert PASSWORD not in blob, table
                if table not in ("project_secrets", "audit_logs"):
                    assert USERNAME not in blob or table == "project_secrets", table
        evs = list((await s.execute(select(Evidence).execution_options(**BYPASS))).scalars())
    for ev in evs:
        data = await flow.ctx.storage.get(ev.storage_key)
        assert PASSWORD.encode() not in data and USERNAME.encode() not in data, ev.kind
    for e in await flow.events():
        assert PASSWORD not in str(e) and USERNAME not in str(e)


async def test_tenant_isolation(flow: Flow) -> None:
    run, res = await _failed(flow)
    o = flow.other.headers
    assert (await flow.get(f"/execution-runs/{run['id']}", o)).status_code == 404
    assert (await flow.get(f"/execution-results/{res['id']}", o)).status_code == 404
    assert (await flow.get(f"/defects/{res['defect']['id']}", o)).status_code == 404
    assert (await flow.post(f"/execution-runs/{run['id']}/cancel", {}, o)).status_code == 404
    # A signed evidence URL can't be re-signed for another organisation.
    shot = next(e for e in res["evidence"] if e["kind"] == "screenshot")
    path = "/" + shot["content_url"].split("://", 1)[1].split("/", 1)[1]
    forged = path.rsplit("&sig=", 1)[0] + "&sig=" + "0" * 64
    assert (await flow.client.get(forged)).status_code == 403


async def _all_keys(flow: Flow) -> list[str]:
    await _ready(flow)
    return sorted(flow.state["scripts"])


async def _fills_message(flow: Flow, key: str) -> bool:
    code = (await flow.get(f"/automation-scripts/{flow.state['scripts'][key]['id']}")).json()["code"]
    return re.search(r"\.message\w*\.fill\(", code, re.I) is not None


async def _quiet_keys(flow: Flow) -> list[str]:
    """Scripts that never touch Message and pass on the fixture: the site-down tests take one each (first and last),
    so each starts with no failures and the flaky-history rule (checked first) doesn't apply. The console-error check
    is left out: the run policy blocks off-site requests, which the browser logs as console errors."""
    keys = [
        k
        for k in await _all_keys(flow)
        if k != flow.state["empty"]
        and "console" not in flow.state["scripts"][k]["case_title"]
        and not await _fills_message(flow, k)
    ]
    assert len(keys) >= 2, keys
    return keys


async def test_cancel_a_running_run_keeps_finished_results(flow: Flow) -> None:
    import asyncio

    # Every script but the empty-Message one, which only ever fails in this module.
    keys = [k for k in await _all_keys(flow) if k != flow.state["empty"]]
    run = await _run(flow, keys, flow.approver, authorise=True)
    worker = asyncio.create_task(flow.idle())
    try:
        # P5-00: cancel only once a test has passed and another is running, so "finished results are kept" is about
        # a real finished test even under load (the cancel could land before any test had finished: QA note 2).
        for _ in range(1200):
            cur = (await flow.get(f"/execution-runs/{run['id']}")).json()
            passed = int(((cur.get("totals") or {}).get("progress") or {}).get("passed") or 0)
            if cur["status"] == "running" and passed and any(r["status"] == "running" for r in cur["tests_rows"]):
                break
            await asyncio.sleep(0.1)
        assert cur["status"] == "running", cur["status"]
        c = await flow.post(f"/execution-runs/{run['id']}/cancel", {}, flow.approver)
        assert c.status_code == 200 and c.json()["message"] == f"{run['key']} cancelled."
    finally:
        await asyncio.wait_for(worker, 300)
    done = (await flow.get(f"/execution-runs/{run['id']}")).json()
    assert done["status"] == "cancelled", done["status"]
    assert "live" not in done["totals"], done["totals"]  # QA P4-BUG-11: no "running" rows after the end
    rows = done["tests_rows"]
    assert all(r["status"] not in ("running", "waiting") for r in rows), rows
    unfinished = [r for r in rows if r["status"] == "error" and r["error_reason"] == "Run cancelled"]
    assert unfinished, "unfinished tests read 'Error: Run cancelled'"
    assert not [r for r in rows if r["classification"] is not None and r["error_reason"] == "Run cancelled"], (
        "cancelled tests are not analysed"
    )
    # QA P4-BUG-06: every error row says why; tests that were running read "Stopped: run cancelled".
    errors = [r for r in rows if r["status"] == "error"]
    assert all(r["error_reason"] in ("Run cancelled", "Stopped: run cancelled") for r in errors), errors
    assert all(r["classification"] is None for r in errors)
    assert any(r["error_reason"] == "Stopped: run cancelled" for r in errors), errors  # cancelled while one ran
    # Real failures in a cancelled run are still analysed. When none happened before the cancel, one is made.
    if not [r for r in rows if r["status"] in ("failed", "flaky")]:
        # Under load the cancel can land before any test passed; then any row will do, since it is rewritten as failed.
        target = next((r for r in rows if r["status"] == "passed"), rows[0])
        await _fail_result(flow, target["id"])
        from app.db.tenant import system_scope
        from app.orchestrator.orchestrator import Orchestrator

        await Orchestrator(flow.ctx).advance(system_scope(uuid.UUID(str(flow.owner.org_id))), uuid.UUID(flow.pid))
        await flow.idle()
    rows = (await flow.get(f"/execution-runs/{run['id']}")).json()["tests_rows"]
    failed = [r for r in rows if r["status"] in ("failed", "flaky")]
    assert failed and all(r["classification"] is not None for r in failed), failed


async def _fail_result(flow: Flow, result_id: str) -> None:
    """Turns a passed result into a failed one, as if its assertion had failed before the run was cancelled."""
    from app.db.models import ExecutionResult
    from app.domain.enums import ResultStatus

    async with flow.ctx.session_factory() as s:
        r = (
            await s.execute(
                select(ExecutionResult).where(ExecutionResult.id == uuid.UUID(result_id)).execution_options(**BYPASS)
            )
        ).scalar_one()
        r.status = ResultStatus.failed
        r.error = "QA_ASSERTION: Expected the Contact us form to be shown, but it is not on the page"
        await s.commit()


async def test_site_unreachable_is_classified_and_drafts_nothing(flow: Flow) -> None:
    flow.site.down = True
    try:
        before = (await flow.get(f"/projects/{flow.pid}/defects?status=all")).json()["items"]
        key = (await _quiet_keys(flow))[0]
        run = await _run(flow, [key], flow.approver, authorise=True)
        await flow.idle()
    finally:
        flow.site.down = False
    row = (await flow.get(f"/execution-runs/{run['id']}")).json()["tests_rows"][0]
    assert row["status"] in ("failed", "error"), row
    res = (await flow.get(f"/execution-results/{row['id']}")).json()
    assert res["analysis"]["classification"] == "network_failure", res["analysis"]
    assert res["analysis"]["label"] == "Site unreachable" and res["defect"] is None
    assert res["analysis"]["no_defect"] == "not_application"
    after = (await flow.get(f"/projects/{flow.pid}/defects?status=all")).json()["items"]
    assert len(after) == len(before)


async def test_renamed_label_gets_a_fix_suggestion_that_changes_only_the_locator(flow: Flow) -> None:
    # One other script that fills Message: the empty-Message one has mixed history, so it reads as flaky (checked first).
    keys = [k for k in await _all_keys(flow) if k != flow.state["empty"] and await _fills_message(flow, k)][:1]
    assert keys, "a script that fills Message"
    flow.site.message_label = "Comments"
    try:
        await _check_heal(flow, keys)
    finally:
        # Put the label back and regenerate, so every script is valid against the original page again (a heal
        # leaves its scripts "not checked").
        flow.site.message_label = "Message"
        r = await flow.post(f"/projects/{flow.pid}/stages/automation/run", {})
        assert r.status_code == 202, r.text
        await flow.idle()
    auto = await flow.automation()
    assert all(x["status"] == "valid" for x in auto["bundle"]["scripts"]), [
        (x["case_key"], x["status"]) for x in auto["bundle"]["scripts"]
    ]
    assert auto["g6"]["state"] == "passed_automatically", auto["g6"]
    flow.state["scripts"] = {x["case_key"]: x for x in auto["bundle"]["scripts"]}


async def _check_heal(flow: Flow, keys: list[str]) -> None:
    run = await _run(flow, keys, flow.approver, authorise=True)
    await flow.idle()
    rows = (await flow.get(f"/execution-runs/{run['id']}")).json()["tests_rows"]
    found = [
        res
        for res in [(await flow.get(f"/execution-results/{r['id']}")).json() for r in rows if r["status"] == "failed"]
        if res["heal_suggestions"]
    ]
    assert found, [
        ((await flow.get(f"/execution-results/{r['id']}")).json()["error"], r["classification"]) for r in rows
    ]
    res = found[0]
    assert res["analysis"]["classification"] == "selector_failure", (res["analysis"], res["error"])
    assert res["defect"] is None and res["analysis"]["fix_suggestion"] is True
    groups = (await flow.get(f"/execution-runs/{run['id']}")).json()["analysis"]["output"]["groups"]
    [item] = [i for g in groups if g["classification"] == "selector_failure" for i in g["items"]]
    assert item["fix_suggestion"] is True, "the run page says 'a fix suggestion is ready'"
    [sug] = res["heal_suggestions"]
    assert sug["asset_path"].endswith("ContactPage.ts") and sug["page_path"] == "/contact"
    first = sug["candidates"][0]
    assert first["recommended"] and first["expression"] == 'getByLabel("Comments")', sug
    assert "spec" not in first
    assert res["permissions"]["can_accept_fix"] is True
    sid = flow.state["scripts"][res["case_key"]]["id"]
    script_before = (await flow.get(f"/automation-scripts/{sid}")).json()
    url = f"/execution-results/{res['id']}/heal-suggestions/0/accept"
    assert (await flow.post(url, {}, flow.viewer)).status_code == 403
    ok = await flow.post(url, {}, flow.member)
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["message"] == "ContactPage.ts version 2 created. Validate it before the next run."
    assert res["case_key"] in body["scripts_to_validate"]
    assert (await flow.post(url, {}, flow.member)).status_code == 409
    asset = (await flow.get(f"/automation-assets/{body['asset']['id']}")).json()
    assert 'getByLabel("Comments")' in asset["code"] and 'getByLabel("Message")' not in asset["code"]
    assert asset["version"] == 2 and asset["generated_by"] == "heal"
    script_after = (await flow.get(f"/automation-scripts/{sid}")).json()
    assert script_after["code"] == script_before["code"], "the spec and its assertions never change"
    assert script_after["assertion_map"] == script_before["assertion_map"]
    assert script_after["status"] == "not_checked", "must pass checks before it runs"


async def test_case_list_shows_the_last_result_and_the_dashboard_the_last_run(flow: Flow) -> None:
    await _failed(flow)
    cases = {c["key"]: c for c in await flow.cases()}
    c = cases[flow.state["empty"]]
    assert c["last_result"] is not None and c["execution_status"] == c["last_result"]["status"]
    assert c["last_result"]["run_key"].startswith("RUN-") and c["last_result"]["results"]
    assert c["last_result"]["result_key"].startswith(c["last_result"]["run_key"])
    never = [x for x in cases.values() if x["status"] == "approved" and x["last_result"] is None]
    assert all(x["execution_status"] == "not_run" for x in never)
    dash = (await flow.get("/dashboard")).json()
    [proj] = [p for p in dash["recent_projects"] if p["id"] == flow.pid]
    assert proj["last_run"]["key"].startswith("RUN-") and proj["last_run"]["tests"] >= 1


async def test_traceability_and_definition_of_done_use_real_results(flow: Flow) -> None:
    await _failing_run(flow)  # the empty-Message case's latest result is a failure
    pid = flow.pid
    cov = (await flow.get(f"/projects/{pid}/traceability/coverage")).json()["execution"]
    assert cov["executed"] is True and cov["results"]["tests"] >= 1
    assert cov["automation"]["with_valid_script"] <= cov["automation"]["approved_cases"]
    assert cov["results"]["tests"] == sum(
        cov["results"][k] for k in ("passed", "failed", "flaky", "error", "blocked", "skipped")
    )
    gaps = (await flow.get(f"/projects/{pid}/traceability/gaps")).json()
    failing = {x["case"]["key"] for x in gaps["failed_tests"]} | {x["case"]["key"] for x in gaps["flaky_tests"]}
    assert flow.state["empty"] in failing, gaps
    assert all(x["run_key"] and x["result_key"].startswith(x["run_key"]) for x in gaps["failed_tests"])
    assert not {x["case"]["key"] for x in gaps["failed_tests"]} & {x["case"]["key"] for x in gaps["flaky_tests"]}
    fwd = (await flow.get(f"/projects/{pid}/traceability?view=forward&limit=100")).json()["items"]
    cells = [tc for r in fwd for tc in r["test_cases"] if tc["case"]["key"] == flow.state["empty"]]
    assert (
        cells and cells[0]["script"]["file"].endswith(".spec.ts") and cells[0]["result"]["run_key"].startswith("RUN-")
    )
    did = (await _failed(flow))[1]["defect"]["key"]
    chain = (await flow.get(f"/projects/{pid}/traceability/chain?key={did}")).json()
    assert chain["root"]["key"] == did and chain["root"]["type"] == "defect"
    ups = {g["type"]: [x["key"] for x in g["items"]] for g in chain["upstream"]}
    assert flow.state["empty"] in ups["test_case"] and ups["requirement"] and ups["execution_result"]
    # QA P4-BUG-10: the acceptance-criterion level sits between the requirement and the test case.
    order = [g["type"] for g in chain["upstream"]]
    assert order[:3] == ["requirement", "acceptance_criterion", "test_case"], order
    case = (await flow.get(f"/projects/{pid}/test-cases/by-key/{flow.state['empty']}")).json()
    ac_keys = sorted(a["key"] for a in case.get("acceptance_criteria") or [])
    assert ups["acceptance_criterion"] == ac_keys, (ups["acceptance_criterion"], case.get("acceptance_criteria"))
    rc = (await flow.get(f"/projects/{pid}/readiness-criteria")).json()
    dod = {c["text"]: c["evaluation"] for c in rc["definition_of_done"]}
    assert dod["Tests executed with evidence"]["status"] in ("met", "not_met"), dod["Tests executed with evidence"]
    assert "Phase 4" not in dod["Tests executed with evidence"]["detail"]
    high = dod["No open critical or high defects"]
    assert high["status"] in ("met", "not_met") and "Phase 4" not in high["detail"], high


async def test_undecided_drafts_are_not_open_defects(flow: Flow) -> None:
    """QA P4-BUG-08 (P4-12): only confirmed and fixed defects count as open, in DoD-04 and in the regression gap."""
    draft = await _draft(flow)
    pid = flow.pid
    rc = (await flow.get(f"/projects/{pid}/readiness-criteria")).json()
    high = {c["text"]: c["evaluation"] for c in rc["definition_of_done"]}["No open critical or high defects"]
    assert draft["key"] not in high["detail"], high
    listed = (await flow.get(f"/projects/{pid}/defects")).json()["items"]
    status = {d["key"]: d["status"] for d in listed}
    named = re.findall(r"DEF-\d{4}", high["detail"])
    assert all(status[k] in ("confirmed", "fixed") for k in named), (named, status)
    gaps = (await flow.get(f"/projects/{pid}/traceability/gaps")).json()
    assert all(x["defect"]["status"] != "draft" for x in gaps["defects_without_regression_coverage"]), gaps
    assert draft["key"] not in {x["defect"]["key"] for x in gaps["defects_without_regression_coverage"]}


async def test_execution_and_defect_reports(flow: Flow) -> None:
    await _failed(flow)
    pid = flow.pid
    await flow.idle()
    reports = (await flow.get(f"/projects/{pid}/reports")).json()
    frozen = [r for r in reports if r["report_type"] == "execution" and r["frozen"]]
    assert frozen and all(r["run_key"] and r["status"] == "ready" for r in frozen), frozen
    assert {"pdf", "html", "csv", "json"} <= set(frozen[0]["formats"])
    detail = (await flow.get(f"/reports/{frozen[0]['id']}")).json()
    c = detail["content"]
    assert c["hypothesis_note"] == "Causes are hypotheses unless a person confirmed them."
    assert c["run"]["key"] == frozen[0]["run_key"] and c["totals"]["tests"] == len(c["results"])
    names = {f["filename"] for f in detail["files"]}
    assert any(n.startswith("127.0.0.1-test-execution-RUN-") and n.endswith(".csv") for n in names), names
    # P4-11 (QA P4-BUG-03): the approved cases left to a person, with reasons, and a limitations section.
    assessment = (await flow.get(f"/projects/{pid}/automation/assessment")).json()["cases"]
    manual = sorted(x["key"] for x in assessment if x["suitability"] == "manual_only")
    assert manual and [x["case_key"] for x in c["not_automated"]] == manual
    assert all(x["reasons"] and all(r.strip() for r in x["reasons"]) for x in c["not_automated"])
    assert c["limitations"][0].startswith("Tests ran in a separate process") and len(c["limitations"]) >= 2
    assert "Not run in Firefox or WebKit, so this report says nothing about those browsers." in c["limitations"]
    html = await flow.client.get(
        f"{API}/reports/{frozen[0]['id']}/download?format=html", headers=flow.owner.headers, follow_redirects=True
    )
    assert html.status_code == 200, html.text
    assert "<h2>Not automated</h2>" in html.text and "<h2>Limitations</h2>" in html.text
    for x in c["not_automated"]:
        assert x["case_key"] in html.text
    # Viewers can't generate; members can, for the latest result per test case and for defects.
    assert (await flow.post(f"/projects/{pid}/reports", {"report_type": "defect"}, flow.viewer)).status_code == 403
    latest = await flow.post(f"/projects/{pid}/reports", {"report_type": "execution"}, flow.member)
    assert latest.status_code == 202, latest.text
    d = await flow.post(f"/projects/{pid}/reports", {"report_type": "defect"}, flow.member)
    assert d.status_code == 202, d.text
    await flow.idle()
    dd = (await flow.get(f"/reports/{d.json()['id']}")).json()
    drafts = dd["content"]["drafts"]
    assert dd["approval"]["status"] == ("draft" if drafts else "approved")
    if drafts:
        assert dd["content"]["draft_note"].startswith(f"DRAFT: {drafts} defect")
    csv = await flow.client.get(f"{API}/reports/{d.json()['id']}/download?format=csv", headers=flow.owner.headers)
    assert csv.status_code == 302
    ld = (await flow.get(f"/reports/{latest.json()['id']}")).json()
    assert ld["run_key"] is None and ld["content"]["basis"] == "latest_per_case"
    unknown = await flow.post(
        f"/projects/{pid}/reports", {"report_type": "execution", "run_key": "RUN-9999"}, flow.member
    )
    assert unknown.status_code == 404


async def test_execution_report_names_repeat_defects_and_who_authorised(flow: Flow) -> None:
    """QA R2-BUG-01: a run that fails a known defect again lists it (on the row, with its occurrence number), not only
    defects it raised. QA R2-BUG-02: the run block says who requested and authorised it, when, and how it ran, with
    names only (reports are shared), and the G7 approval is filled in."""
    await _failing_run(flow)  # makes sure an open defect of the empty-Message case exists
    run, res = await _failing_run(flow)  # ... so this failure is a repeat occurrence of it
    assert res["defect"], res
    d = (await flow.get(f"/defects/{res['defect']['id']}")).json()
    seen = [str(o["result_id"]) for o in sorted(d["occurrences"], key=lambda o: str(o["seen_at"]))]
    n = seen.index(str(res["id"])) + 1
    assert n > 1, "the second failure is an occurrence of the defect the first raised or hit"
    await flow.idle()
    reports = (await flow.get(f"/projects/{flow.pid}/reports")).json()
    rep = next(r for r in reports if r["report_type"] == "execution" and r["run_key"] == run["key"])
    detail = (await flow.get(f"/reports/{rep['id']}", flow.member)).json()
    c = detail["content"]
    row = next(x for x in c["results"] if x["result_key"] == res["key"])
    assert row["defect"] == {"key": d["key"], "occurrence": n}
    ref = next(x for x in c["defects"] if x["key"] == d["key"])
    assert ref["raised_here"] is False and ref["occurrences"] == [n]
    r = c["run"]
    assert r["requested_by"] == run["requested_by"]["full_name"]
    assert r["authorised_by"] == run["authorisation"]["by"]["full_name"]
    assert r["authorised_at"] and r["requested_at"] and r["self_authorised"] is False
    assert r["workers"] >= 1 and r["retries"] == 1 and r["browsers"] == ["chromium"]
    assert r["sizes"] and all(x.startswith(("Desktop", "Mobile")) for x in r["sizes"])
    approval = detail["approval"]
    assert approval["gate"] == "G7" and approval["decided_at"]
    assert approval["decided_by"]["full_name"] == r["authorised_by"] and approval["decided_by"]["email"] is None
    raw = json.dumps(detail)
    assert "approver@p4x.example.com" not in raw and "member@p4x.example.com" not in raw
    html = await flow.client.get(
        f"{API}/reports/{rep['id']}/download?format=html", headers=flow.owner.headers, follow_redirects=True
    )
    assert f"{d['key']} (occurrence {n})" in html.text and r["authorised_by"] in html.text
    assert "1 retry per failed test" in html.text and "@p4x.example.com" not in html.text
    csv = await flow.client.get(
        f"{API}/reports/{rep['id']}/download?format=csv", headers=flow.owner.headers, follow_redirects=True
    )
    assert f"{d['key']} (occurrence {n})" in csv.text


async def test_assistant_v3_answers_from_stored_runs_ai_off(flow: Flow) -> None:
    """P4-13: explain a failed test, did the tests pass, defects, rerun proposals (a request only), viewers."""
    from app.db.tenant import bind_scope, system_scope
    from app.services.assistant import Answer, citation_guard

    async def thread(h: dict[str, str] | None = None) -> str:
        r = await flow.post(f"/projects/{flow.pid}/assistant/threads", {}, h)
        assert r.status_code == 201, r.text
        return str(r.json()["id"])

    async def ask(tid: str, body: dict[str, Any], h: dict[str, str] | None = None) -> dict[str, Any]:
        r = await flow.post(f"/assistant/threads/{tid}/messages", body, h)
        assert r.status_code in (200, 201), r.text
        return dict(r.json()["reply"])

    last_run, first = await _failed(flow)
    rkey, dkey, run_key = first["key"], first["defect"]["key"], last_run["key"]
    tid = await thread()
    ex = await ask(tid, {"content": f"Why did {rkey} fail?"})
    assert ex["intent"] == "explain_failed_test", ex
    assert "`application_defect`" in ex["content"] and "Hypothesis" in ex["content"]
    assert "Expected: " in ex["content"] and "Actual: " in ex["content"] and "Signals:" in ex["content"]
    cited = {c["key"] for c in ex["citations"]}
    assert {rkey, dkey, flow.state["empty"]} <= cited, cited
    # "Did the tests pass?": the numbers equal the latest finished run's totals from the API.
    res = await ask(tid, {"content": "Did the tests pass?"})
    assert res["intent"] == "execution_results"
    runs = (await flow.get(f"/projects/{flow.pid}/execution-runs")).json()
    items = runs["items"] if isinstance(runs, dict) else runs
    done = [x for x in items if x["status"] in ("passed", "failed", "error", "cancelled")]
    latest = (await flow.get(f"/execution-runs/{done[0]['id']}")).json()
    t = latest["totals"]
    assert res["content"].startswith(
        f"{latest['key']} ({latest['status']}): {t['passed']} passed · {t['failed']} failed"
    )
    assert latest["key"] in {c["key"] for c in res["citations"]}
    df = await ask(tid, {"content": f"Analyse {dkey}"})
    assert df["intent"] == "analyse_defect" and dkey in {c["key"] for c in df["citations"]}
    assert "Reproducibility: 2 of 2 attempts (always)." in df["content"] and "Next: " in df["content"]
    ls = await ask(tid, {"content": "Which defects are there?"})
    assert ls["intent"] == "list_defects" and dkey in ls["content"]
    # Re-run the failed tests: a proposal; accepting creates a run request waiting for G7, never a running run.
    valid = next(x["case_key"] for x in (await flow.automation())["bundle"]["scripts"] if x["status"] == "valid")
    rr = await ask(tid, {"content": f"Re-run {valid}"})
    assert rr["intent"] == "propose_rerun" and len(rr["proposals"]) == 1, rr
    prop = rr["proposals"][0]
    assert prop["kind"] == "request_run" and prop["payload"]["case_keys"] == [valid]
    acc = await flow.post(f"/assistant/proposals/{prop['id']}/accept", {})
    assert acc.status_code == 200, acc.text
    applied = acc.json()["result"]["applied"]
    run = next(x for x in (await flow.get(f"/projects/{flow.pid}/execution-runs")).json()["items"]
               if x["key"] == applied[0]["key"])  # fmt: skip
    assert run["status"] == "awaiting_authorisation"
    await flow.post(f"/execution-runs/{run['id']}/withdraw", {})
    # Viewers: read intents work; asking for a rerun gives no proposal, and accepting someone's proposal is 403.
    vt = await thread(flow.viewer)
    v = await ask(vt, {"content": f"Why did {rkey} fail?"}, flow.viewer)
    assert v["intent"] == "explain_failed_test" and dkey in v["content"]
    rr2 = await ask(tid, {"intent": "propose_rerun", "params": {"only_failed": True}})
    if rr2["proposals"]:
        r = await flow.post(f"/assistant/proposals/{rr2['proposals'][0]['id']}/accept", {}, flow.viewer)
        assert r.status_code in (403, 404)
    # Citation guard: an answer citing a defect that doesn't exist is marked, never linked.
    async with flow.ctx.session_factory() as s:
        org = (await flow.get("/auth/me")).json()["organisation"]["id"]
        bind_scope(s, system_scope(__import__("uuid").UUID(org)))
        ans = Answer(f"See DEF-0999 and {dkey} from {run_key}.", "ai")
        await citation_guard(s, __import__("uuid").UUID(flow.pid), ans)
    assert "DEF-0999" not in ans.content and "[unknown reference]" in ans.content
    assert {c["key"] for c in ans.citations} == {dkey, run_key}
    assert any(n["code"] == "unresolved_citation" for n in ans.notices)
