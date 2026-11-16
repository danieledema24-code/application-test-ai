"""P6-02 change impact and the regression recommendation (D27, D28) on the backend fixture site, real browser:
G3 → G6 on release 1, the empty-Message case fails with the contact bug on and its defect is confirmed at G8, then the
site switches to release 2 with the Message label renamed to "Your message" and a rescan writes CHG-0001.

Checks (AI off): the Contact requirement and the cases that use Message are direct, with reasons; the scripts that find
Message are outdated, named by their locator, and the automation stage keeps its status (D27); the defect is to
re-test; the gaps; must-run is the direct cases plus the defect's case, and "Request this run" is refused (422) while a
must-run script is outdated (lead decision on OQ3). Repair, then validate: the repair items close themselves. The
request then waits for G7 and touches nothing; once authorised and run, the re-run items close with that run. Closing:
re-run and repair items can't be closed by hand (OQ4), "No action needed" needs a reason, viewers get 403 and other
organisations 404. AI on (FakeLLM): a valid order of the should-run tests is kept with its explanation; an answer that
drops a must-run test or names a test that isn't listed is rejected and the rule order stays.
"""

from __future__ import annotations

import json
import shutil
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import select, update

from app.context import build_context
from app.db.models import AutomationScript, ChangeSet
from app.db.tenant import BYPASS, system_scope
from app.domain.enums import Role, ScriptStatus
from app.llm.base import DisabledLLM, FakeLLM
from app.services import impact as impact_svc
from tests.conftest import client_for, make_settings, register
from tests.fixtures.site import running_site
from tests.integration.test_p4_automation import API, Flow, _user
from tests.integration.test_p4_execution import _authorise, _failing_run, _through_g6

pytestmark = pytest.mark.skipif(
    not (Path(__file__).resolve().parents[3] / "automation" / "node_modules" / "@playwright" / "test").is_dir(),
    reason="the automation toolkit's dependencies are not installed",
)


@pytest.fixture(scope="module")
async def flow(tmp_path_factory: pytest.TempPathFactory, template_db: Path) -> AsyncIterator[Flow]:
    tmp = tmp_path_factory.mktemp("p6impact")
    shutil.copy(template_db, tmp / "qa.db")
    ctx = build_context(make_settings(tmp, allow_private_targets=True), llm=DisabledLLM())
    with running_site() as (base_url, site):
        async with client_for(ctx) as client:
            owner = await register(client, "owner@p6i.example.com", org="P6I Org")
            other = await register(client, "other@p6i.example.com", org="Other P6I Org")
            member = await _user(ctx, client, owner.org_id, "member@p6i.example.com", Role.member)
            approver = await _user(ctx, client, owner.org_id, "approver@p6i.example.com", Role.member, True)
            viewer = await _user(ctx, client, owner.org_id, "viewer@p6i.example.com", Role.viewer)
            r = await client.post(f"{API}/projects", headers=owner.headers, json={
                "url": base_url, "name": "Fixture shop", "start": True,
                "authorisation": {"attested": True, "statement": "Local fixture site owned by the test suite."},
                "scan": {"max_pages": 30, "max_depth": 3},
            })  # fmt: skip
            assert r.status_code == 201, r.text
            f = Flow(ctx, client, site, owner, member, approver, viewer, other, r.json()["id"])
            await f.idle()
            yield f
    await ctx.close()


async def _scripts(flow: Flow) -> dict[str, AutomationScript]:
    async with flow.ctx.session_factory() as s:
        rows = (
            await s.execute(
                select(AutomationScript)
                .where(AutomationScript.project_id == uuid.UUID(flow.pid))
                .execution_options(**BYPASS)
            )
        ).scalars()
        return {str(r.case_lineage_id): r for r in rows}


async def _impact(flow: Flow, cs_id: str, query: str = "", h: dict[str, str] | None = None) -> dict[str, Any]:
    r = await flow.get(f"/change-sets/{cs_id}/impact{query}", h)
    assert r.status_code == 200, r.text
    return dict(r.json())


async def _rec(flow: Flow, cs_id: str, h: dict[str, str] | None = None) -> dict[str, Any]:
    r = await flow.get(f"/change-sets/{cs_id}/regression-recommendation", h)
    assert r.status_code == 200, r.text
    return dict(r.json())


async def _patch(flow: Flow, item_id: str, body: dict[str, Any], h: dict[str, str] | None = None) -> Any:
    return await flow.client.patch(f"{API}/impact-items/{item_id}", json=body, headers=h or flow.owner.headers)


async def _release_2(flow: Flow) -> dict[str, Any]:
    """Once per module: G3 → G6, a failing run of the empty-Message case and its defect confirmed at G8, then
    release 2 with the Message label renamed, and a rescan. Returns CHG-0001."""
    if "chg" in flow.state:
        return dict(flow.state["chg"])
    await _through_g6(flow)
    _run, res = await _failing_run(flow)
    did = res["defect"]["id"]
    ok = await flow.post(f"/defects/{did}/status", {"action": "confirm"}, flow.approver)
    assert ok.status_code == 200, ok.text
    flow.state["defect"] = ok.json()["defect"]["key"]
    flow.state["auto_stage"] = (await flow.stage("automation"))["status"]
    scan1 = (await flow.get(f"/projects/{flow.pid}/discovery")).json()["id"]
    flow.site.version, flow.site.message_label = 2, "Your message"
    r = await flow.post(f"/projects/{flow.pid}/rescans", {"compare_with": scan1}, flow.member)
    assert r.status_code == 202, r.text
    await flow.idle()
    sets = (await flow.get(f"/projects/{flow.pid}/changes")).json()["items"]
    chg = next(x for x in sets if x["key"] == "CHG-0001")
    assert chg["status"] == "completed", chg
    flow.state["chg"] = chg
    return dict(chg)


async def test_release_2_impact_is_labelled_with_reasons(flow: Flow) -> None:
    chg = await _release_2(flow)
    empty = flow.state["empty"]
    view = await _impact(flow, chg["id"])
    assert view["available"] is True and view["generated_by"] == "rules"
    items = view["items"]
    by_kind: dict[str, list[dict[str, Any]]] = {}
    for i in items:
        by_kind.setdefault(i["target_kind"], []).append(i)
    # The empty-Message case: direct, re-run, the reason names the renamed field.
    tc = next(i for i in by_kind["test_case"] if i["target"]["key"] == empty)
    assert (tc["level"], tc["action"], tc["status"]) == ("direct", "rerun", "open")
    assert tc["reason"].startswith("Directly affected: ") and 'field "Message" changed' in tc["reason"], tc
    assert tc["group"] == "requirements" and tc["can_close"] is False
    assert any(c["subject"].startswith("Field changed: Message → Your message") for c in tc["changes"]), tc["changes"]
    # A Contact requirement is direct, to regenerate.
    contact = [i for i in by_kind["requirement"] if i["level"] == "direct"]
    assert contact and all(i["action"] == "regenerate" and "/contact" in i["reason"] for i in contact), contact
    # The confirmed defect is to re-test with its case.
    [defect] = by_kind["defect"]
    assert defect["target"]["key"] == flow.state["defect"] and defect["action"] == "rerun"
    assert defect["reason"] == f"May be fixed or changed by CHG-0001: re-test. Re-tested by {empty}."
    # The new page is a gap.
    gaps = [i for i in items if i["level"] == "gap"]
    assert "Not covered by any requirement: page /new-arrivals added" in [g["reason"] for g in gaps], gaps
    assert all(g["action"] == "write_requirement" and g["group"] == "gaps" for g in gaps)
    # Cosmetic changes (About heading, the moved button, the price) affect nothing.
    assert not [i for i in items if i["page"] == "/about"]
    # Filters.
    direct = await _impact(flow, chg["id"], "?level=direct&target_kind=test_case")
    assert direct["items"] and all(i["level"] == "direct" and i["target_kind"] == "test_case" for i in direct["items"])
    assert view["counts"]["by_level"]["gap"] == len(gaps)
    # The change set says what is affected.
    one = (await flow.get(f"/change-sets/{chg['id']}")).json()
    assert one["impact"]["test_cases"] >= 1 and one["regression"]["must"] >= 1, one


async def test_scripts_that_find_message_are_outdated_and_the_stage_keeps_its_status(flow: Flow) -> None:
    chg = await _release_2(flow)
    scripts = await _scripts(flow)
    outdated = {k: s for k, s in scripts.items() if s.status == ScriptStatus.outdated}
    assert outdated, "the scripts that find Message"
    assert all("getByLabel('Message') not found after CHG-0001" in (s.outdated_reason or "") for s in outdated.values())
    empty_lineage = next(k for k, s in scripts.items() if s.path.endswith(f"/{flow.state['empty']}.spec.ts"))
    assert empty_lineage in outdated
    assert (await flow.stage("automation"))["status"] == flow.state["auto_stage"]  # D27
    heals = (await _impact(flow, chg["id"], "?target_kind=automation_script"))["items"]
    assert {i["target_ref"] for i in heals} == set(outdated)
    assert all(i["action"] == "heal" and i["level"] == "direct" and i["can_close"] is False for i in heals)
    assert all(i["target"]["outdated_reason"] for i in heals), heals
    check = (await _set(flow)).summary["locator_check"]  # stored for the repair step (P6-04)
    assert check["broken"][empty_lineage][0]["expression"] == "getByLabel('Message')"
    assert "/contact" in check["pages"]


async def test_must_run_and_the_outdated_script_block(flow: Flow) -> None:
    chg = await _release_2(flow)
    empty = flow.state["empty"]
    rec = await _rec(flow, chg["id"])
    assert rec["available"] is True and rec["order"] == "rules" and rec["explanation"] is None
    must = {p["key"]: p for p in rec["must"]}
    assert empty in must, list(must)
    assert f"Re-tests {flow.state['defect']}" in must[empty]["reasons"]
    assert must[empty]["script"]["state"] == "outdated" and must[empty]["runnable"] is False
    assert not {p["key"] for p in rec["should"]} & set(must)
    # The estimate counts the must-run tests that can't run until repaired, from their earlier timings (QA P6-02).
    est = rec["estimate"]
    assert est["must_tests"] == sum(1 for p in rec["must"] if p["script"]) and est["must_seconds"], est
    assert empty not in est["no_history"] and est["from_run_key"], est
    blocked = rec["blocked"]
    assert (
        blocked
        and empty in blocked["case_keys"]
        and blocked["message"].endswith("Accept or reject their repair suggestions first.")
    )
    assert rec["permissions"]["can_request"] is True
    assert (await _rec(flow, chg["id"], flow.viewer))["permissions"]["can_request"] is False
    before = list(flow.site.requests)
    r = await flow.post(f"/change-sets/{chg['id']}/regression-run", {}, flow.member)
    assert r.status_code == 422, r.text
    assert empty in r.text and flow.site.requests == before
    assert (await flow.post(f"/change-sets/{chg['id']}/regression-run", {}, flow.viewer)).status_code == 403


async def test_closing_rules(flow: Flow) -> None:
    chg = await _release_2(flow)
    items = (await _impact(flow, chg["id"]))["items"]
    rerun = next(i for i in items if i["action"] == "rerun")
    heal = next(i for i in items if i["action"] == "heal")
    regen = next(i for i in items if i["action"] == "regenerate")
    gap = next(i for i in items if i["action"] == "write_requirement")
    for i in (rerun, heal):  # OQ4: they close themselves
        r = await _patch(flow, i["id"], {"status": "no_action", "reason": "Not needed"})
        assert r.status_code == 422, r.text
        assert (await _patch(flow, i["id"], {"status": "resolved"})).status_code == 422
    no_reason = await _patch(flow, gap["id"], {"status": "no_action", "reason": "  "})
    assert no_reason.status_code == 422 and "Say why no action is needed." in no_reason.text
    assert (await _patch(flow, gap["id"], {"status": "no_action", "reason": "x"}, flow.viewer)).status_code == 403
    other = await _patch(flow, gap["id"], {"status": "no_action", "reason": "x"}, flow.other.headers)
    assert other.status_code == 404
    ok = await _patch(flow, gap["id"], {"status": "no_action", "reason": "Internal page, not tested"}, flow.member)
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["message"] == "Gap impact item closed."
    assert body["item"]["status"] == "no_action" and body["item"]["status_reason"] == "Internal page, not tested"
    assert body["item"]["resolved_by"]  # a name, never an email to members
    assert "@" not in json.dumps(body["item"]["resolved_by"])
    assert (await _patch(flow, gap["id"], {"status": "resolved"}, flow.member)).status_code == 409
    done = await _patch(flow, regen["id"], {"status": "resolved"}, flow.member)
    assert done.status_code == 200 and done.json()["item"]["status"] == "resolved"
    assert done.json()["message"] == f"{regen['target']['key']} impact item closed."
    assert (await _impact(flow, chg["id"], "?status=open"))["items"]
    assert [i["id"] for i in (await _impact(flow, chg["id"], "?status=resolved"))["items"]] == [regen["id"]]
    assert [i["id"] for i in (await _impact(flow, chg["id"], "?status=no_action"))["items"]] == [gap["id"]]


async def test_other_organisations_get_404(flow: Flow) -> None:
    chg = await _release_2(flow)
    h = flow.other.headers
    assert (await flow.get(f"/change-sets/{chg['id']}/impact", h)).status_code == 404
    assert (await flow.get(f"/change-sets/{chg['id']}/regression-recommendation", h)).status_code == 404
    assert (await flow.post(f"/change-sets/{chg['id']}/regression-run", {}, h)).status_code == 404


async def test_repairs_close_and_the_regression_run_closes_reruns(flow: Flow) -> None:
    chg = await _release_2(flow)
    empty = flow.state["empty"]
    # A repair puts the scripts back to "not checked" (P4-08's heal does that); validation then finds them valid.
    flow.site.message_label = "Message"
    async with flow.ctx.session_factory() as s:
        await s.execute(
            update(AutomationScript)
            .where(AutomationScript.project_id == uuid.UUID(flow.pid), AutomationScript.status == ScriptStatus.outdated)
            .values(status=ScriptStatus.draft)
            .execution_options(**BYPASS)
        )
        await s.commit()
    r = await flow.post(f"/projects/{flow.pid}/automation/validate", {})
    assert r.status_code == 202, r.text
    await flow.idle()
    heals = (await _impact(flow, chg["id"], "?target_kind=automation_script"))["items"]
    assert heals and all(i["status"] == "resolved" for i in heals), [(i["target"], i["status"]) for i in heals]
    rec = await _rec(flow, chg["id"])
    assert rec["blocked"] is None
    # Repaired scripts are no longer counted as outdated (QA P6-02).
    one = (await flow.get(f"/change-sets/{chg['id']}")).json()
    assert one["impact"]["scripts_outdated"] == 0 and one["impact"]["open"] < one["impact"]["total"]
    # The request waits for G7 and touches nothing.
    before = list(flow.site.requests)
    r = await flow.post(f"/change-sets/{chg['id']}/regression-run", {"include_should": False}, flow.member)
    assert r.status_code == 201, r.text
    run = r.json()
    assert run["status"] == "awaiting_authorisation" and flow.site.requests == before
    assert empty in [t["case_key"] for t in run["tests_rows"]] or empty in json.dumps(run["selection"])
    assert [x["id"] for x in (await _rec(flow, chg["id"]))["requested_runs"]] == [run["id"]]
    one = (await flow.get(f"/change-sets/{chg['id']}")).json()
    assert one["regression"]["requested_run"]["id"] == run["id"]
    finished = await _authorise(flow, run)
    assert finished["status"] in ("passed", "failed"), finished["status"]
    items = (await _impact(flow, chg["id"]))["items"]
    case = next(i for i in items if i["target_kind"] == "test_case" and i["target"]["key"] == empty)
    assert case["status"] == "resolved" and case["resolved_by_run"]["id"] == run["id"], case
    defect = next(i for i in items if i["target_kind"] == "defect")
    assert defect["status"] == "resolved" and defect["resolved_by_run"]["id"] == run["id"]
    # Should-run tests were left out of this run: their items stay open.
    rerun_open = [i for i in items if i["action"] == "rerun" and i["status"] == "open"]
    rec = await _rec(flow, chg["id"])
    manual = {p["key"] for p in rec["must"] if not p["runnable"]}
    assert all(i["level"] == "indirect" or i["target"]["key"] in manual for i in rerun_open), [
        (i["target"]["key"], i["level"], [p for p in rec["must"] if p["key"] == i["target"]["key"]]) for i in rerun_open
    ]


async def _set(flow: Flow) -> ChangeSet:
    async with flow.ctx.session_factory() as s:
        return (
            await s.execute(
                select(ChangeSet).where(ChangeSet.id == uuid.UUID(flow.state["chg"]["id"])).execution_options(**BYPASS)
            )
        ).scalar_one()


async def test_ai_may_reorder_should_run_only(flow: Flow) -> None:
    chg = await _release_2(flow)
    rule = dict((await _set(flow)).rerun_recommendation or {})
    must = [p["key"] for p in rule["must"]]
    should = [p["key"] for p in rule["should"]]
    assert len(should) >= 2, should
    ctx = flow.ctx
    saved = ctx.llm
    try:
        # A must-run test dropped, then a test that isn't listed: both rejected, the rule order kept.
        ctx.llm = FakeLLM([{"must_run": must[1:], "should_run": should, "explanation": "Fewer tests."}])
        out, _usage = await impact_svc.ai_reorder(ctx, rule)
        assert out["ai"]["status"] == "rejected" and [p["key"] for p in out["should"]] == should
        assert out.get("order") == "rules"
        ctx.llm = FakeLLM([{"must_run": must, "should_run": should, "explanation": "Run TC-9999 first."}])
        out, _usage = await impact_svc.ai_reorder(ctx, rule)
        assert out["ai"] == {"status": "rejected", "issue": "The answer named a test that isn't recommended: TC-9999"}
        # A valid order: kept, with the explanation; must-run is unchanged.
        order = list(reversed(should))
        llm = FakeLLM([{"must_run": must, "should_run": order, "explanation": f"{order[0]} covers a high risk."}])
        ctx.llm = llm
        await impact_svc.analyse(ctx, system_scope(flow.owner.org_id), uuid.UUID(chg["id"]))
        assert "regression tests" in llm.captured[0]["user"] and must[0] in llm.captured[0]["user"]
    finally:
        ctx.llm = saved
    rec = await _rec(flow, chg["id"])
    assert rec["order"] == "ai" and rec["explanation"] == f"{order[0]} covers a high risk."
    assert [p["key"] for p in rec["must"]] == must
    shown = [p["key"] for p in rec["should"]]
    assert shown == [k for k in order if k in shown]  # the AI order, less any that can't run now
