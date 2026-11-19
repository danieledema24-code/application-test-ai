"""P6-04 repair suggestions (D31) on the backend fixture site, real browser, AI off unless stated: G3 → G6 on release
1, the empty-Message case fails and its defect is confirmed at G8, then release 2 (the Message label renamed "Your
message", the "Opening hours" button split in two, the contact confirmation reworded) and a rescan writes CHG-0001.

Checks: one suggestion per broken locator, from the change set (before any test failed): `getByLabel('Your message')`
first, High, with the signal "Same field, renamed (CHG-0001)", exactly one verified match and an outlined screenshot;
nothing contacts the site but page loads. The ambiguous rename offers no High candidate and says why. A failed text
check (the reworded confirmation) is an "Expected result may be out of date" review that links the case and can't be
accepted; the case's expected result is unchanged. Viewers can't decide (403), other organisations get 404, there is
no batch accept, and a reject needs a reason. With AI (FakeLLM) the model may only reorder verified candidates: an
unverified expression or an edited expected result is rejected and logged. Rejecting the repair lifts the regression
block (OQ3): the must-run tests stay listed but not runnable, with the reason, and the same repair isn't offered again.
"""

from __future__ import annotations

import re
import shutil
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import select

from app.context import build_context
from app.db.models import AuditLog, AutomationScript, ExecutionResult, Project
from app.db.tenant import BYPASS, bind_scope, system_scope
from app.domain.change import heal as hd
from app.domain.enums import ResultStatus, Role
from app.llm.base import DisabledLLM, FakeLLM
from app.services import repairs
from tests.conftest import client_for, make_settings, register
from tests.fixtures.site import running_site
from tests.integration.test_p4_automation import API, Flow, _user
from tests.integration.test_p4_execution import _failing_run, _through_g6

pytestmark = pytest.mark.skipif(
    not (Path(__file__).resolve().parents[3] / "automation" / "node_modules" / "@playwright" / "test").is_dir(),
    reason="the automation toolkit's dependencies are not installed",
)


@pytest.fixture(scope="module")
async def flow(tmp_path_factory: pytest.TempPathFactory, template_db: Path) -> AsyncIterator[Flow]:
    tmp = tmp_path_factory.mktemp("p6repairs")
    shutil.copy(template_db, tmp / "qa.db")
    ctx = build_context(make_settings(tmp, allow_private_targets=True), llm=DisabledLLM())
    with running_site() as (base_url, site):
        async with client_for(ctx) as client:
            owner = await register(client, "owner@p6r.example.com", org="P6R Org")
            other = await register(client, "other@p6r.example.com", org="Other P6R Org")
            member = await _user(ctx, client, owner.org_id, "member@p6r.example.com", Role.member)
            approver = await _user(ctx, client, owner.org_id, "approver@p6r.example.com", Role.member, True)
            viewer = await _user(ctx, client, owner.org_id, "viewer@p6r.example.com", Role.viewer)
            r = await client.post(f"{API}/projects", headers=owner.headers, json={
                "url": base_url, "name": "Fixture shop", "start": True,
                "authorisation": {"attested": True, "statement": "Local fixture site owned by the test suite."},
                "scan": {"max_pages": 30, "max_depth": 3},
            })  # fmt: skip
            assert r.status_code == 201, r.text
            f = Flow(ctx, client, site, owner, member, approver, viewer, other, r.json()["id"])
            f.state["base"] = base_url
            await f.idle()
            yield f
    await ctx.close()


async def _release_2(flow: Flow) -> dict[str, Any]:
    if "chg" in flow.state:
        return dict(flow.state["chg"])
    await _through_g6(flow)
    _run, res = await _failing_run(flow)
    ok = await flow.post(f"/defects/{res['defect']['id']}/status", {"action": "confirm"}, flow.approver)
    assert ok.status_code == 200, ok.text
    flow.state["failed_result"] = res
    scan1 = (await flow.get(f"/projects/{flow.pid}/discovery")).json()["id"]
    flow.site.version, flow.site.message_label = 2, "Your message"
    before = len(flow.site.requests)
    r = await flow.post(f"/projects/{flow.pid}/rescans", {"compare_with": scan1}, flow.member)
    assert r.status_code == 202, r.text
    await flow.idle()
    flow.state["rescan_requests"] = flow.site.requests[before:]
    sets = (await flow.get(f"/projects/{flow.pid}/changes")).json()["items"]
    chg = next(x for x in sets if x["key"] == "CHG-0001")
    assert chg["status"] == "completed", chg
    flow.state["chg"] = chg
    return dict(chg)


async def _list(flow: Flow, query: str = "", h: dict[str, str] | None = None) -> dict[str, Any]:
    r = await flow.get(f"/projects/{flow.pid}/heal-suggestions{query}", h)
    assert r.status_code == 200, r.text
    return dict(r.json())


async def _message(flow: Flow) -> dict[str, Any]:
    items = (await _list(flow, f"?change_set={(await _release_2(flow))['id']}&status=all"))["items"]
    return next(i for i in items if i["kind"] == "locator" and i["old_expression"] == "getByLabel('Message')")


async def test_change_set_suggests_the_renamed_label_verified_on_the_live_page(flow: Flow) -> None:
    chg = await _release_2(flow)
    body = await _list(flow, f"?change_set={chg['id']}")
    assert body["permissions"]["can_decide"] is True
    locators = [i for i in body["items"] if i["kind"] == "locator"]
    # One per broken locator, never two for the same getter.
    assert len({(i["file"], i["getter"]) for i in locators}) == len(locators)
    sug = await _message(flow)
    assert sug["key"].startswith("HEAL-") and sug["source"] == "change" and sug["status"] == "open"
    assert sug["change_set"] == {"id": chg["id"], "key": "CHG-0001"} and sug["execution_result"] is None
    assert sug["file_name"] == "ContactPage.ts" and sug["page"] == "/contact"
    assert sug["generated_by"] == "rules" and sug["order"] == "rules" and sug["explanation"] is None
    first = sug["candidates"][0]
    assert first["expression"] == "getByLabel('Your message')", sug["candidates"]
    assert first["level"] == "high" and first["offered"] is True and first["match_count"] == 1
    signals = [s["text"] for s in first["signals"]]
    assert signals[0] == "Same field, renamed (CHG-0001)" and "Same role (text box)" in signals, signals
    assert "In the same form" in signals, signals
    assert first["evidence"] and first["evidence"]["kind"] == "screenshot"
    img = await flow.client.get(first["evidence"]["content_url"])
    assert img.status_code == 200 and img.content[:3] == b"\xff\xd8\xff"  # the outlined JPEG
    assert 1 <= sug["offered"] <= 3 and all(c["match_count"] == 1 for c in sug["candidates"] if c["offered"])
    assert {u["case_key"] for u in sug["used_by"]} >= {flow.state["empty"]}
    assert sug["can_accept"] is True and sug["can_reject"] is True
    # The same card by id; the scripts are still outdated (nothing applied automatically).
    one = (await flow.get(f"/heal-suggestions/{sug['id']}")).json()
    assert one["key"] == sug["key"] and one["status"] == "open"
    assert all(u["state"] == "outdated" for u in one["used_by"])
    # The rescan and the checks only loaded pages: nothing was posted to the site.
    assert all(m in ("GET", "HEAD") for m, *_rest in flow.state["rescan_requests"]), flow.state["rescan_requests"]
    # The impact tab and the regression list name the suggestion.
    rec = (await flow.get(f"/change-sets/{chg['id']}/regression-recommendation")).json()
    must = {p["key"]: p for p in rec["must"]}
    assert sug["key"] in [h["key"] for h in must[flow.state["empty"]]["script"]["heal_suggestions"]]
    assert rec["blocked"] and flow.state["empty"] in rec["blocked"]["case_keys"]
    one_set = (await flow.get(f"/change-sets/{chg['id']}")).json()
    assert one_set["repairs"]["open"] >= 1


async def test_the_ambiguous_rename_offers_no_high_candidate(flow: Flow) -> None:
    chg = await _release_2(flow)
    items = (await _list(flow, f"?change_set={chg['id']}&status=all"))["items"]
    hours = [i for i in items if "Opening hours" in (i["old_expression"] or "")]
    if hours:  # a script presses the button: its suggestion says why nothing is offered
        cands = hours[0]["candidates"]
    else:  # no script uses it: check the same locator on the live page directly
        from app.db.models import ChangeItem
        from app.services.impact import change_in

        async with flow.ctx.session_factory() as s:
            rows = (
                await s.execute(
                    select(ChangeItem)
                    .where(ChangeItem.change_set_id == uuid.UUID(chg["id"]))
                    .execution_options(**BYPASS)
                )
            ).scalars()
            changes = [change_in(r) for r in rows]
            project = (
                await s.execute(select(Project).where(Project.id == uuid.UUID(flow.pid)).execution_options(**BYPASS))
            ).scalar_one()
        spec = {"getter": "openingHours", "element": "Opening hours", "by": "role", "role": "button",
                "name": "Opening hours", "exact": False}  # fmt: skip
        job = repairs.Job("pages/ContactPage.ts", "openingHours", "/contact", spec, [])
        from app.domain.change import impact as im

        li = im.LocatorIn(file=job.file, getter=job.getter, page="/contact", by="role", name="Opening hours",
                          role="button", element="Opening hours")  # fmt: skip
        job.match, job.ambiguous = hd.diff_match(li, changes, "CHG-0001"), hd.ambiguous_renames(li, changes)
        assert job.match is None and sorted(job.ambiguous) == ["Opening days", "Opening times"]
        checked = await repairs.check_live(flow.ctx, system_scope(flow.owner.org_id), project, [job])
        cands = [c.as_dict() for c in checked[(job.file, job.getter)].candidates]
    assert cands, "the two new buttons are listed"
    assert not [c for c in cands if c["offered"] and c["level"] == "high"], cands
    ambiguous = [c for c in cands if c["not_offered_reason"] == hd.AMBIGUOUS]
    assert ambiguous and all(not c["offered"] and c["match_count"] >= 2 for c in ambiguous), cands


async def test_a_changed_confirmation_text_is_a_review_without_accept(flow: Flow) -> None:
    import httpx

    chg = await _release_2(flow)
    res = flow.state["failed_result"]
    # The fixture's release 2 confirmation, as the site serves it now.
    bug, flow.site.contact_bug = flow.site.contact_bug, True  # the fixture answers contact posts with its bug on
    try:
        page = httpx.post(f"{flow.state['base']}/contact", data={"msg": ""}).text
    finally:
        flow.site.contact_bug = bug
    found = re.search(r'<p class="success">([^<]+)</p>', page)
    assert found is not None, page
    text = found.group(1)
    assert text == "Thanks, we got your message"
    async with flow.ctx.session_factory() as s:
        r = (
            await s.execute(
                select(ExecutionResult).where(ExecutionResult.id == uuid.UUID(res["id"])).execution_options(**BYPASS)
            )
        ).scalar_one()
        # What a script that checks "Message sent" reports on release 2 (the toolkit's error and page state).
        r.status, r.error = ResultStatus.failed, 'Expected the text "Message sent" to be shown'
        r.page_state = {"url": "/contact", "heading": "Thank you", "messages": [text]}
        await s.commit()
    case_before = (await flow.get(f"/test-cases/{res['case']['id']}")).json()
    row = await repairs.propose_from_failure(
        flow.ctx, system_scope(flow.owner.org_id), uuid.UUID(flow.pid), uuid.UUID(res["id"]), r.error or ""
    )
    assert row is not None
    review = (await flow.get(f"/heal-suggestions/{row.id}")).json()
    assert review["kind"] == "expected_result_review" and review["source"] == "failure"
    assert review["status"] == "open" and review["can_accept"] is False and review["can_reject"] is False
    assert review["review"]["message"] == (
        f"The text changed from 'Message sent' to '{text}' on /contact ({res['key']}). {res['case_key']} checks this "
        f"text. Expected results are never changed automatically. Review {res['case_key']}."
    )
    assert [u["case_key"] for u in review["used_by"]] == [res["case_key"]]
    assert review["execution_result"]["key"] == res["key"]
    no = await flow.post(f"/heal-suggestions/{row.id}/accept", {"index": 0}, flow.member)
    assert no.status_code == 409 and "never changed automatically" in no.text, no.text
    assert (await flow.post(f"/heal-suggestions/{row.id}/reject", {"reason": "x"}, flow.member)).status_code == 409
    case_after = (await flow.get(f"/test-cases/{res['case']['id']}")).json()
    assert case_after["expected_result"] == case_before["expected_result"]
    assert case_after["version"] == case_before["version"]
    # The result page lists it with the result's repairs.
    detail = (await flow.get(f"/execution-results/{res['id']}")).json()
    assert row.key in [x["key"] for x in detail["repairs"]]
    assert chg["key"] == "CHG-0001"


async def test_permissions_tenancy_and_no_batch_accept(flow: Flow) -> None:
    await _release_2(flow)
    sug = await _message(flow)
    url = f"/heal-suggestions/{sug['id']}"
    viewer = await _list(flow, "", flow.viewer)
    assert viewer["permissions"]["can_decide"] is False
    assert all(not i["can_accept"] and not i["can_reject"] for i in viewer["items"])
    assert (await flow.post(f"{url}/accept", {"index": 0}, flow.viewer)).status_code == 403
    assert (await flow.post(f"{url}/reject", {"reason": "no"}, flow.viewer)).status_code == 403
    h = flow.other.headers
    assert (await flow.get(f"/projects/{flow.pid}/heal-suggestions", h)).status_code == 404
    assert (await flow.get(url, h)).status_code == 404
    assert (await flow.post(f"{url}/accept", {"index": 0}, h)).status_code == 404
    assert (await flow.post(f"{url}/reject", {"reason": "x"}, h)).status_code == 404
    # No batch accept anywhere, and one index per call.
    for path in (f"/projects/{flow.pid}/heal-suggestions/accept", "/heal-suggestions/accept"):
        assert (await flow.post(path, {"ids": [sug["id"]]}, flow.member)).status_code in (404, 405)
    assert (await flow.post(f"{url}/accept", {"index": [0, 1]}, flow.member)).status_code == 422
    assert (await flow.post(f"{url}/accept", {"index": 0, "all": True}, flow.member)).status_code == 422
    not_offered = next((c["index"] for c in sug["candidates"] if not c["offered"]), 7)
    assert (await flow.post(f"{url}/accept", {"index": not_offered}, flow.member)).status_code == 422
    blank = await flow.post(f"{url}/reject", {"reason": "   "}, flow.member)
    assert blank.status_code == 422 and "Say why. The reason is kept with the suggestion." in blank.text
    assert (await flow.get(url)).json()["status"] == "open"  # nothing was decided by any of it


async def test_ai_may_only_reorder_verified_candidates(flow: Flow) -> None:
    await _release_2(flow)
    ctx = flow.ctx
    sug = await _message(flow)
    offered = [c for c in sug["candidates"] if c["offered"]]
    cands = [
        hd.Candidate(c["expression"], c["strategy"], {}, hd.Element("textbox", "Your message"), 1, True, c["score"])
        for c in offered
    ]
    if len(cands) < 2:
        cands.append(hd.Candidate("getByRole('textbox', { name: 'Your message' })", "role", {},
                                  hd.Element("textbox", "Your message"), 1, True, 0.9))  # fmt: skip
    exprs = [c.expression for c in cands]
    job = repairs.Job("pages/ContactPage.ts", "message", "/contact", {"by": "label", "name": "Message"}, [])
    saved = ctx.llm
    try:
        async with ctx.session_factory() as s:
            project = (
                await s.execute(select(Project).where(Project.id == uuid.UUID(flow.pid)).execution_options(**BYPASS))
            ).scalar_one()
            # A valid order: kept, with its explanation.
            ctx.llm = FakeLLM([{"order": list(reversed(exprs)), "explanation": "The label is what people read."}])
            got, why = await repairs.ai_reorder(ctx, s, project, "HEAL-9001", job, cands)
            assert [c.expression for c in got][: len(exprs)] == list(reversed(exprs)) and why
            # An expression that wasn't verified: rejected, rule order kept, logged.
            ctx.llm = FakeLLM([{"order": [exprs[0], "getByLabel('Message')"], "explanation": "Keep the old one."}])
            got, why = await repairs.ai_reorder(ctx, s, project, "HEAL-9002", job, cands)
            assert [c.expression for c in got] == exprs and why is None
            # Malicious: tries to change the expected text (twice, so the one repair fails too).
            bad = {"order": exprs, "explanation": "Also update the check.", "expected_result": "Thanks!"}
            ctx.llm = FakeLLM([bad, bad])
            got, why = await repairs.ai_reorder(ctx, s, project, "HEAL-9003", job, cands)
            assert [c.expression for c in got] == exprs and why is None
            edited = {"order": [exprs[0] + "; await qa.expectText('Thanks!')", *exprs[1:]], "explanation": "Edit."}
            ctx.llm = FakeLLM([edited])
            got, why = await repairs.ai_reorder(ctx, s, project, "HEAL-9004", job, cands)
            assert why is None
            await s.commit()
            logged = (
                await s.execute(
                    select(AuditLog).where(AuditLog.action == "heal_suggestion.ai_rejected").execution_options(**BYPASS)
                )
            ).scalars()
            keys = {a.meta.get("key") for a in logged}
            assert keys == {"HEAL-9002", "HEAL-9003", "HEAL-9004"}, keys
    finally:
        ctx.llm = saved


async def test_reject_lifts_the_regression_block_and_is_not_offered_again(flow: Flow) -> None:
    chg = await _release_2(flow)
    sug = await _message(flow)
    empty = flow.state["empty"]
    r = await flow.post(f"/heal-suggestions/{sug['id']}/reject", {"reason": "The field is going away"}, flow.member)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["message"] == f"{sug['key']} rejected."
    card = body["suggestion"]
    assert card["status"] == "rejected" and card["reason"] == "The field is going away" and card["decided_by"]
    assert card["can_accept"] is False and card["can_reject"] is False
    again = await flow.post(f"/heal-suggestions/{sug['id']}/accept", {"index": 0}, flow.member)
    assert again.status_code == 409 and "already decided by" in again.text
    # Nothing changed in the page object; the scripts are still outdated.
    async with flow.ctx.session_factory() as s:
        rows = (
            await s.execute(
                select(AutomationScript)
                .where(AutomationScript.project_id == uuid.UUID(flow.pid))
                .execution_options(**BYPASS)
            )
        ).scalars()
        outdated = [x for x in rows if x.status.value == "outdated"]
    assert outdated
    # OQ3: the must-run tests stay listed, not runnable, with the reason; the request is no longer blocked.
    rec = (await flow.get(f"/change-sets/{chg['id']}/regression-recommendation")).json()
    must = {p["key"]: p for p in rec["must"]}
    assert rec["blocked"] is None, rec["blocked"]
    assert must[empty]["runnable"] is False
    assert must[empty]["not_runnable_reason"].startswith(f"Repair rejected ({sug['key']})"), must[empty]
    before = list(flow.site.requests)
    run = await flow.post(f"/change-sets/{chg['id']}/regression-run", {}, flow.member)
    if run.status_code == 201:
        made = run.json()
        assert made["status"] == "awaiting_authorisation" and flow.site.requests == before
        assert empty not in [t["case_key"] for t in made["tests_rows"]]
    else:  # nothing left that can run automatically: a plain 409, not the outdated-script block
        assert run.status_code == 409 and "outdated" not in run.text, run.text
    # The same repair isn't offered again for this locator on this page, even after another failure.
    res = flow.state["failed_result"]
    again_row = await repairs.propose_from_failure(
        flow.ctx, system_scope(flow.owner.org_id), uuid.UUID(flow.pid), uuid.UUID(res["id"]),
        "Element not found: waiting for getByLabel('Message')",
    )  # fmt: skip
    assert again_row is None
    still = (await _list(flow, "?status=open"))["items"]
    assert not [i for i in still if i["old_expression"] == "getByLabel('Message')"]


async def test_a_must_run_test_following_a_link_to_a_removed_page_is_not_included_and_does_not_block(
    flow: Flow,
) -> None:
    """D28 (QA P6-04 R2): a "Test case needs review" item (a link to a removed page) has nothing to accept or reject,
    so its test moves from Must run to Not included, "review or retire", and the request isn't blocked by it."""
    from app.db.models import ChangeSet
    from app.domain.enums import HealSource

    chg = await _release_2(flow)
    rec = (await flow.get(f"/change-sets/{chg['id']}/regression-recommendation")).json()
    pick = next(p for p in rec["must"] if (p["script"] or {}).get("state") == "outdated")
    lineage = str(pick["case_lineage_id"])
    link = {"file": "pages/HomePage.ts", "getter": "gone", "expression": "locator('a[href=\"/gone\"]')"}
    async with flow.ctx.session_factory() as s:
        cs = (await s.execute(select(ChangeSet).where(ChangeSet.id == uuid.UUID(chg["id"])).execution_options(
            **BYPASS))).scalar_one()  # fmt: skip
        saved = dict(cs.summary or {})
        check = dict(saved.get("locator_check") or {})
        cs.summary = {**saved, "locator_check": {**check, "broken": {**(check.get("broken") or {}), lineage: [link]}}}
        project = (await s.execute(select(Project).where(Project.id == uuid.UUID(flow.pid)).execution_options(
            **BYPASS))).scalar_one()  # fmt: skip
        bind_scope(s, system_scope(flow.owner.org_id))
        rv = hd.TextReview(lineage, pick["key"], "/", "/gone", None, "followLink", None, "CHG-0001",
                           reason="page_removed")  # fmt: skip
        review = await repairs._write_review(s, project, rv, source=HealSource.change, change_item_id=None, result=None)
        await s.commit()
        review_id = review.id
    try:
        rec = (await flow.get(f"/change-sets/{chg['id']}/regression-recommendation")).json()
        assert pick["key"] not in [p["key"] for p in [*rec["must"], *rec["should"]]]
        moved = next(p for p in rec["excluded"] if p["key"] == pick["key"])
        assert moved["runnable"] is False and moved["was_must"] is True
        assert all(p["was_must"] is False for p in [*rec["must"], *rec["should"]])
        assert moved["not_runnable_reason"].startswith("Page removed: review or retire the case"), moved
        assert pick["key"] not in str(rec["blocked"] or "")
        card = (await flow.get(f"/heal-suggestions/{review_id}")).json()
        assert card["status"] == "open" and card["review"]["reason"] == "page_removed", card
    finally:
        async with flow.ctx.session_factory() as s:
            cs = (await s.execute(select(ChangeSet).where(ChangeSet.id == uuid.UUID(chg["id"])).execution_options(
                **BYPASS))).scalar_one()  # fmt: skip
            cs.summary = saved
            await s.commit()
