"""P6-06 traceability, Definition of Done and AI QA Analyst v5 after a real rescan, AI off.

The P6-02 flow on the backend fixture site (G3 → G6 on release 1, a failing run with its defect confirmed at G8, then
release 2 with the Message label renamed and a rescan that writes CHG-0001), then:

- traceability: the three change gap lists (`scripts_outdated` with the locator reason, `impacted_not_rerun`,
  `new_pages_without_requirements`) with coverage counts equal to the lists; the matrix's `impacted` cells; chains for
  CHG- and HEAL- keys (any role; other organisations 404);
- DoD: an item about regression is "Not evaluable: no change set yet" before the rescan, "Not met" while impacted tests
  aren't re-run, and decided from the re-run afterwards;
- assistant (AI off, rule answers): "What changed?" cites CHG-0001 and ends with the fixed change statement; the
  regression proposal is withheld while must-run scripts are outdated, and once repaired, accepting it creates a run
  waiting for Gate 7 with nothing sent to the site; the exploration proposal starts nothing until accepted, then only
  one session at a time; CHG/HEAL/EXP keys resolve only inside the project's organisation.
"""

from __future__ import annotations

import shutil
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import update

from app.agents.readiness.rules import NO_CHANGE_SET, evaluate, text_rule_for
from app.context import build_context
from app.db.models import AutomationScript
from app.db.tenant import BYPASS, bind_scope, system_scope
from app.domain.change.diff import CHANGE_STATEMENT
from app.domain.enums import ReadinessKind, Role, ScriptStatus
from app.llm.base import DisabledLLM
from app.services import assistant as asst
from app.services import assistant_p6
from app.services.readiness import load_facts
from tests.conftest import client_for, make_settings, register
from tests.fixtures.site import running_site
from tests.integration.test_p4_automation import API, Flow, _user
from tests.integration.test_p4_execution import _authorise
from tests.integration.test_p6_impact import _rec, _release_2

pytestmark = pytest.mark.skipif(
    not (Path(__file__).resolve().parents[3] / "automation" / "node_modules" / "@playwright" / "test").is_dir(),
    reason="the automation toolkit's dependencies are not installed",
)

DOD_TEXT = "Impacted tests are re-run after changes (regression)"


@pytest.fixture(scope="module")
async def flow(tmp_path_factory: pytest.TempPathFactory, template_db: Path) -> AsyncIterator[Flow]:
    tmp = tmp_path_factory.mktemp("p6trace")
    shutil.copy(template_db, tmp / "qa.db")
    ctx = build_context(make_settings(tmp, allow_private_targets=True), llm=DisabledLLM())
    with running_site() as (base_url, site):
        async with client_for(ctx) as client:
            owner = await register(client, "owner@p6t.example.com", org="P6T Org")
            other = await register(client, "other@p6t.example.com", org="Other P6T Org")
            member = await _user(ctx, client, owner.org_id, "member@p6t.example.com", Role.member)
            approver = await _user(ctx, client, owner.org_id, "approver@p6t.example.com", Role.member, True)
            viewer = await _user(ctx, client, owner.org_id, "viewer@p6t.example.com", Role.viewer)
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


async def _ask(flow: Flow, body: dict[str, Any], h: dict[str, str] | None = None) -> dict[str, Any]:
    h = h or flow.owner.headers
    key = "thread_" + str(id(h))
    if key not in flow.state:
        r = await flow.client.post(f"{API}/projects/{flow.pid}/assistant/threads", json={}, headers=h)
        assert r.status_code == 201, r.text
        flow.state[key] = r.json()["id"]
    r = await flow.client.post(f"{API}/assistant/threads/{flow.state[key]}/messages", json=body, headers=h)
    assert r.status_code in (200, 201), r.text
    return dict(r.json()["reply"])


async def _accept(flow: Flow, prop: dict[str, Any], h: dict[str, str] | None = None) -> Any:
    return await flow.client.post(
        f"{API}/assistant/proposals/{prop['id']}/accept", json={}, headers=h or flow.owner.headers
    )


async def _regression_dod(flow: Flow) -> dict[str, Any]:
    async with flow.ctx.session_factory() as s:
        bind_scope(s, system_scope(flow.owner.org_id))
        facts = await load_facts(s, uuid.UUID(flow.pid))
    assert text_rule_for(ReadinessKind.dod, DOD_TEXT) == "dod.regression"
    result = evaluate("dod.regression", facts)
    assert result is not None
    flow.state["regression_facts"] = facts.regression
    return result


async def _gaps(flow: Flow, h: dict[str, str] | None = None) -> dict[str, Any]:
    r = await flow.get(f"/projects/{flow.pid}/traceability/gaps", h)
    assert r.status_code == 200, r.text
    return dict(r.json())


async def test_before_any_rescan(flow: Flow) -> None:
    ans = await _ask(flow, {"content": "What changed?"})
    assert ans["intent"] == "what_changed"
    assert ans["content"].startswith(assistant_p6.NO_CHANGE_SET) and ans["content"].endswith(CHANGE_STATEMENT)
    assert (await _regression_dod(flow)) == {"status": "unknown", "detail": NO_CHANGE_SET, "evidence": []}
    caps = (await flow.get(f"/projects/{flow.pid}/assistant/capabilities")).json()
    labels = [x["label"] for x in caps["later_phase_tasks"]]
    assert labels == [
        "Hosted deployment (Postgres, Redis, file storage, container sandbox)",
        "API testing",
        "Word (DOCX) reports",
    ]
    ours = {i["intent"]: i for i in caps["intents"]}
    for intent in ("what_changed", "impact_summary", "propose_regression_run", "explain_heal",
                   "propose_exploration", "release_readiness_summary"):  # fmt: skip
        assert ours[intent]["available"] and not ours[intent]["needs_ai"], intent


async def test_traceability_gap_lists_and_matrix_after_the_rescan(flow: Flow) -> None:
    chg = await _release_2(flow)
    empty = flow.state["empty"]
    gaps = await _gaps(flow)
    cov = (await flow.get(f"/projects/{flow.pid}/traceability/coverage")).json()
    assert cov["changes"] == {k: len(gaps[k]) for k in
                              ("scripts_outdated", "impacted_not_rerun", "new_pages_without_requirements")}  # fmt: skip
    # Scripts that are outdated (spec §12): the Contact scripts, with the locator reason.
    outdated = gaps["scripts_outdated"]
    assert outdated and empty in [x["case"]["key"] for x in outdated]
    assert all("getByLabel('Message') not found after CHG-0001" in x["reason"] for x in outdated), outdated
    assert {x["case"]["key"] for x in outdated} == {x["case"]["key"] for x in gaps["outdated_automation_scripts"]}
    assert all(x["change_set"]["key"] == "CHG-0001" for x in outdated)
    heals = [h for x in outdated for h in x["heal_suggestions"]]
    assert all(h["key"].startswith("HEAL-") and "tab=repairs" in h["path"] for h in heals)
    flow.state["heal"] = heals[0]["key"] if heals else None
    # Impacted tests not re-run: the direct case, with its change set.
    nr = {x["case"]["key"]: x for x in gaps["impacted_not_rerun"]}
    assert nr[empty]["level"] == "direct" and nr[empty]["change_set"]["key"] == chg["key"]
    # New pages without requirements: the page release 2 added.
    pages = {x["page"]: x for x in gaps["new_pages_without_requirements"]}
    assert pages["/new-arrivals"]["label"] == "/new-arrivals (added in CHG-0001)"
    # The matrix: the case's Change cell and the script's reason.
    rows = (await flow.get(f"/projects/{flow.pid}/traceability?limit=200")).json()["items"]
    cell = next(t for r in rows for t in r["test_cases"] if t["case"]["key"] == empty)
    assert cell["impacted"] == {"change_set": "CHG-0001", "level": "direct", "status": "open", "action": "rerun"}
    assert cell["script"]["state"] == "outdated" and "getByLabel('Message')" in cell["script"]["outdated_reason"]
    assert any(r["impacted"] for r in rows), "a Contact requirement is impacted"
    back = (await flow.get(f"/projects/{flow.pid}/traceability?view=backward&limit=200")).json()["items"]
    assert next(r for r in back if r["test_case"]["key"] == empty)["impacted"]["level"] == "direct"


async def test_chains_accept_change_and_repair_keys(flow: Flow) -> None:
    await _release_2(flow)
    empty = flow.state["empty"]
    r = await flow.get(f"/projects/{flow.pid}/traceability/chain?key=chg-0001", flow.viewer)
    assert r.status_code == 200, r.text
    c = r.json()
    assert c["root"]["key"] == "CHG-0001" and c["root"]["type"] == "change_set"
    types = [lv["type"] for lv in c["downstream"]]
    assert types[:4] == ["change_item", "impact_item", "requirement", "test_case"]
    assert "automation_script" in types and "execution_result" in types
    levels = {lv["type"]: lv["items"] for lv in c["downstream"]}
    assert empty in [x["key"] for x in levels["test_case"]] and levels["change_item"] and levels["impact_item"]
    assert (await flow.get(f"/projects/{flow.pid}/traceability/chain?key=CHG-9999")).status_code == 404
    other = await flow.get(f"/projects/{flow.pid}/traceability/chain?key=CHG-0001", flow.other.headers)
    assert other.status_code == 404
    heal = flow.state.get("heal")
    if heal:
        h = (await flow.get(f"/projects/{flow.pid}/traceability/chain?key={heal}")).json()
        assert h["root"]["key"] == heal and h["downstream"][0]["type"] == "page_object"
        assert [lv["type"] for lv in h["downstream"]][-2:] == ["test_case", "requirement"]
        assert h["upstream"][0]["items"][0]["key"] == "CHG-0001"


async def test_dod_regression_item_is_not_met_until_re_run(flow: Flow) -> None:
    await _release_2(flow)
    res = await _regression_dod(flow)
    assert res["status"] == "not_met", res
    assert res["detail"].startswith("Not met: ") and "not re-run since CHG-0001" in res["detail"]
    pending = flow.state["regression_facts"]["pending"]
    assert flow.state["empty"] in pending and f"Not met: {len(pending)} impacted tests" in res["detail"]


async def test_assistant_answers_what_changed_and_impact_without_ai(flow: Flow) -> None:
    await _release_2(flow)
    ans = await _ask(flow, {"content": "What changed since the last scan?"})
    assert ans["intent"] == "what_changed" and ans["answered_by"] == "intent" and ans["generated_by"] == "rules"
    assert ans["content"].startswith("CHG-0001 found ") and "between Scan 1" in ans["content"]
    assert ans["content"].endswith(CHANGE_STATEMENT)
    assert "CHG-0001" in {c["key"] for c in ans["citations"]}
    assert "built_in_answer" in {n["code"] for n in ans["notices"]}
    imp = await _ask(flow, {"intent": "impact_summary"})
    assert imp["content"].startswith("CHG-0001 affects ") and "Regression: " in imp["content"]
    heal = flow.state.get("heal")
    if heal:
        ex = await _ask(flow, {"content": f"Explain {heal.lower()}"})
        assert ex["intent"] == "explain_heal" and ex["content"].endswith(
            "Only this locator changes; the test's checks stay the same."
        )
        assert "the assistant can't accept repairs" in ex["content"] and not ex["proposals"]
    # While a must-run script is outdated, no run can be proposed: the reason replaces the proposal (OQ3).
    blocked = await _ask(flow, {"content": "Propose a regression run"})
    assert blocked["intent"] == "propose_regression_run" and not blocked["proposals"]
    assert "Accept or reject their repair suggestions first." in blocked["content"]


async def test_regression_proposal_waits_for_gate_7(flow: Flow) -> None:
    chg = await _release_2(flow)
    empty = flow.state["empty"]
    # Repair the scripts as test_p6_impact.py does: validation finds them valid again.
    flow.site.message_label = "Message"
    async with flow.ctx.session_factory() as s:
        await s.execute(
            update(AutomationScript)
            .where(AutomationScript.project_id == uuid.UUID(flow.pid), AutomationScript.status == ScriptStatus.outdated)
            .values(status=ScriptStatus.draft)
            .execution_options(**BYPASS)
        )
        await s.commit()
    assert (await flow.post(f"/projects/{flow.pid}/automation/validate", {})).status_code == 202
    await flow.idle()
    assert (await _gaps(flow))["scripts_outdated"] == []
    # Viewers read, but get no proposal.
    viewer = await _ask(flow, {"intent": "propose_regression_run"}, flow.viewer)
    assert viewer["content"] == assistant_p6.VIEWERS and not viewer["proposals"]
    ans = await _ask(flow, {"intent": "propose_regression_run"})
    [prop] = ans["proposals"]
    assert prop["kind"] == "request_regression_run" and prop["status"] == "pending"
    rec = await _rec(flow, chg["id"])
    n = sum(1 for x in rec["must"] if x["runnable"]) + sum(1 for x in rec["should"] if x["runnable"])
    assert ans["content"].startswith(f"Re-run {n} test") and "recommended after CHG-0001" in ans["content"]
    assert ans["content"].endswith(assistant_p6.REGRESSION_FOOTER)
    # Nothing exists until accepted; accepting creates a run waiting for Gate 7 and sends nothing to the site.
    assert rec["requested_runs"] == []
    before = list(flow.site.requests)
    r = await _accept(flow, prop)
    assert r.status_code == 200, r.text
    [applied] = r.json()["result"]["applied"]
    run = (await flow.get(f"/execution-runs/{applied['id']}")).json()
    assert run["status"] == "awaiting_authorisation" and flow.site.requests == before
    assert [x["key"] for x in (await _rec(flow, chg["id"]))["requested_runs"]] == [applied["key"]]
    assert empty in [x["case"]["key"] for x in (await _gaps(flow))["impacted_not_rerun"]]
    # Once authorised (G7) and run, the re-run items close and the DoD item is decided from the re-run.
    finished = await _authorise(flow, run)
    assert finished["status"] in ("passed", "failed"), finished["status"]
    assert empty not in [x["case"]["key"] for x in (await _gaps(flow))["impacted_not_rerun"]]
    res = await _regression_dod(flow)
    manual = [x["key"] for x in (await _rec(flow, chg["id"]))["must"] if not x["runnable"]]
    if manual:
        assert res["status"] == "unknown" and "without a recorded re-test" in res["detail"], res
    else:
        assert res == {"status": "met", "detail": f"Met: every must-run test from CHG-0001 has a result "
                       f"({applied['key']})", "evidence": []}  # fmt: skip


async def test_exploration_proposal_starts_nothing_until_accepted(flow: Flow) -> None:
    await _release_2(flow)
    sessions = f"/projects/{flow.pid}/exploratory-sessions"
    assert (await flow.get(sessions)).json()["items"] == []
    ans = await _ask(flow, {"content": "Explore the new and changed pages"})
    assert ans["intent"] == "propose_exploration"
    [prop] = ans["proposals"]
    assert prop["kind"] == "start_exploration" and prop["payload"]["signed_in"] is False
    assert ans["content"].startswith("Explore ") and "from CHG-0001" in ans["content"]
    assert "not signed in." in ans["content"] and assistant_p6.EXPLORE_FOOTER in ans["content"]
    assert (await flow.get(sessions)).json()["items"] == []  # nothing started by the answer
    # Only the person who asked can accept it (others don't even see it).
    assert (await _accept(flow, prop, flow.member)).status_code == 404
    r = await _accept(flow, prop)
    assert r.status_code == 200, r.text
    [applied] = r.json()["result"]["applied"]
    assert applied["key"].startswith("EXP-")
    items = (await flow.get(sessions)).json()["items"]
    assert [x["key"] for x in items] == [applied["key"]] and items[0]["status"] == "queued"
    # One session at a time: the next proposal says so and offers nothing.
    again = await _ask(flow, {"content": "Explore the pages again"})
    assert not again["proposals"]
    assert again["content"] == f"{applied['key']} is already running on this project. One session at a time."
    # Stop it before it runs (the stop path is P6-03a's), so nothing is sent to the site.
    stop = await flow.post(f"/quality-scans/{items[0]['id']}/cancel", {})
    assert stop.status_code == 200, stop.text
    await flow.idle()
    chain = await flow.get(f"/projects/{flow.pid}/traceability/chain?key={applied['key']}")
    assert chain.status_code == 200 and chain.json()["root"]["type"] == "exploratory_session"


async def test_keys_resolve_only_inside_the_organisation(flow: Flow) -> None:
    await _release_2(flow)
    keys = {"CHG-0001", "CHG-0999"}
    async with flow.ctx.session_factory() as s:
        bind_scope(s, system_scope(flow.owner.org_id))
        mine = await asst.resolve_keys(s, uuid.UUID(flow.pid), keys)
    async with flow.ctx.session_factory() as s:
        bind_scope(s, system_scope(flow.other.org_id))
        theirs = await asst.resolve_keys(s, uuid.UUID(flow.pid), keys)
        ans = asst.Answer("CHG-0001 changed the contact page.", "what_changed")
        await asst.citation_guard(s, uuid.UUID(flow.pid), ans)
    assert set(mine) == {"CHG-0001"} and mine["CHG-0001"]["path"].endswith("/discovery/changes/CHG-0001")
    assert theirs == {}
    assert ans.content == "[unknown reference] changed the contact page."
