"""QA probes for P6-02 on the backend fixture site (real browser), reusing the developer's module flow
(tests/integration/test_p6_impact.py): request validation, roles on every new endpoint, D27 for every downstream
stage, nothing created or contacted by a refused request, the approver's request still waits for G7, requesting twice,
re-run items resolved only by a run that started after the change set, and the audit rows.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select, update

from app.db.models import AuditLog, AutomationScript, ExecutionRun
from app.db.tenant import BYPASS
from app.domain.enums import ScriptStatus
from tests.integration.test_p4_automation import API, Flow
from tests.integration.test_p4_execution import _authorise
from tests.integration.test_p6_impact import _impact, _patch, _rec, _release_2, pytestmark  # noqa: F401
from tests.integration.test_p6_impact import flow as flow


async def _runs(flow: Flow) -> list[ExecutionRun]:
    async with flow.ctx.session_factory() as s:
        return list(
            (
                await s.execute(
                    select(ExecutionRun)
                    .where(ExecutionRun.project_id == uuid.UUID(flow.pid))
                    .execution_options(**BYPASS)
                )
            ).scalars()
        )


async def _audit(flow: Flow, action: str) -> list[AuditLog]:
    async with flow.ctx.session_factory() as s:
        return list(
            (
                await s.execute(
                    select(AuditLog)
                    .where(AuditLog.project_id == uuid.UUID(flow.pid), AuditLog.action == action)
                    .execution_options(**BYPASS)
                )
            ).scalars()
        )


async def test_d27_downstream_stages_keep_their_status(flow: Flow) -> None:
    before = {k: (await flow.stage(k))["status"] for k in ("requirements", "test_strategy", "test_design")}
    await _release_2(flow)
    after = {k: (await flow.stage(k))["status"] for k in ("requirements", "test_strategy", "test_design")}
    # _release_2 is cached per module: when an earlier test ran it, `before` is already post-rescan; both must be
    # approved-like, never stale.
    assert after == before or all(v != "stale" for v in after.values()), (before, after)
    assert all(v != "stale" for v in after.values()), after
    assert (await flow.stage("automation"))["status"] != "stale"


async def test_rerun_items_are_open_although_the_case_ran_before_the_change(flow: Flow) -> None:
    chg = await _release_2(flow)
    items = (await _impact(flow, chg["id"]))["items"]
    empty = flow.state["empty"]
    case = next(i for i in items if i["target_kind"] == "test_case" and (i["target"] or {}).get("key") == empty)
    assert case["status"] == "open" and case["resolved_by_run"] is None  # the failing run predates CHG-0001
    assert all(i["status"] == "open" for i in items if i["action"] == "rerun")


async def test_request_bodies_are_validated(flow: Flow) -> None:
    chg = await _release_2(flow)
    gap = next(i for i in (await _impact(flow, chg["id"]))["items"] if i["action"] == "write_requirement")
    for body in ({"status": "open"}, {"status": "resolved", "extra": 1}, {"status": "no_action", "reason": "x" * 1001}):
        r = await _patch(flow, gap["id"], body, flow.member)
        assert r.status_code == 422, (body, r.text)
    r = await flow.get(f"/change-sets/{chg['id']}/impact?status=bogus")
    assert r.status_code == 422
    r = await flow.client.patch(f"{API}/impact-items/{uuid.uuid4()}", json={"status": "resolved"},
                                headers=flow.member)  # fmt: skip
    assert r.status_code == 404


async def test_roles_on_every_new_endpoint(flow: Flow) -> None:
    chg = await _release_2(flow)
    v = await _impact(flow, chg["id"], h=flow.viewer)
    assert v["permissions"]["can_close"] is False and not any(i["can_close"] for i in v["items"])
    assert (await _rec(flow, chg["id"], flow.viewer))["permissions"]["can_request"] is False
    m = await _impact(flow, chg["id"], h=flow.member)
    assert m["permissions"]["can_close"] is True
    other = flow.other.headers
    item = v["items"][0]["id"]
    assert (await flow.get(f"/change-sets/{chg['id']}", other)).status_code == 404
    assert (await _patch(flow, item, {"status": "resolved"}, other)).status_code == 404
    assert (await flow.get(f"/change-sets/{chg['id']}/impact?level=direct", other)).status_code == 404


async def test_a_refused_request_creates_nothing(flow: Flow) -> None:
    chg = await _release_2(flow)
    runs = len(await _runs(flow))
    audits = len(await _audit(flow, "regression_run.requested"))
    before = list(flow.site.requests)
    r = await flow.post(f"/change-sets/{chg['id']}/regression-run", {"include_should": False}, flow.approver)
    assert r.status_code == 422 and "Accept or reject" in r.text
    assert len(await _runs(flow)) == runs
    assert len(await _audit(flow, "regression_run.requested")) == audits
    assert flow.site.requests == before


async def test_requests_wait_for_g7_twice_and_only_the_later_run_resolves(flow: Flow) -> None:
    chg = await _release_2(flow)
    empty = flow.state["empty"]
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
    assert heals and all(i["status"] == "resolved" for i in heals)
    assert all(i["resolved_by_run"] is None for i in heals)
    before = list(flow.site.requests)
    # An approver's request is still a request: it waits for G7 like anyone's.
    first = await flow.post(f"/change-sets/{chg['id']}/regression-run", {}, flow.approver)
    assert first.status_code == 201, first.text
    assert first.json()["status"] == "awaiting_authorisation"
    second = await flow.post(f"/change-sets/{chg['id']}/regression-run", {"include_should": False}, flow.member)
    assert second.status_code == 201, second.text
    await flow.idle()
    assert flow.site.requests == before  # nothing touched the site before G7
    rec = await _rec(flow, chg["id"])
    assert [x["id"] for x in rec["requested_runs"]] == [second.json()["id"], first.json()["id"]]
    assert {x["status"] for x in rec["requested_runs"]} == {"awaiting_authorisation"}
    assert len(await _audit(flow, "regression_run.requested")) == 2
    # Still open: no run has finished.
    items = (await _impact(flow, chg["id"]))["items"]
    assert all(i["status"] == "open" for i in items if i["action"] == "rerun")
    finished = await _authorise(flow, second.json())
    assert finished["status"] in ("passed", "failed"), finished["status"]
    items = (await _impact(flow, chg["id"]))["items"]
    case = next(i for i in items if i["target_kind"] == "test_case" and (i["target"] or {}).get("key") == empty)
    assert case["status"] == "resolved" and case["resolved_by_run"]["id"] == second.json()["id"]
    assert case["resolved_by"] is None
    # Closing a resolved re-run item by hand is still refused (OQ4).
    assert (await _patch(flow, case["id"], {"status": "resolved"}, flow.member)).status_code == 422


async def test_closing_writes_the_audit_row(flow: Flow) -> None:
    chg = await _release_2(flow)
    items = (await _impact(flow, chg["id"], "?status=open"))["items"]
    item = next((i for i in items if i["can_close"]), None)
    if item is None:
        pytest.skip("no closable item left")
    r = await _patch(flow, item["id"], {"status": "resolved", "reason": "Dealt with"}, flow.member)
    assert r.status_code == 200, r.text
    rows = [a for a in await _audit(flow, "impact_item.closed") if a.target_id == item["id"]]
    assert len(rows) == 1 and rows[0].meta["status"] == "resolved"
    assert r.json()["item"]["status_reason"] == "Dealt with"


async def test_the_request_body_is_optional(flow: Flow) -> None:
    chg = await _release_2(flow)
    r = await flow.client.post(f"{API}/change-sets/{chg['id']}/regression-run", headers=flow.member)  # no body
    assert "Field required" not in r.text, r.text
