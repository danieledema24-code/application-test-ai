"""P6-04 (QA R3): a failure through a repaired element reads as test maintenance only until the case's first passed
result after the repair. Fixture site, real browser, AI off: release 2 renames the Message label, a member accepts the
repairs the empty-Message case's script needs, and G6 passes again. Until the case passes, the repairs are not proven (a
failure through them reads as test maintenance). It passes; then the shop stops flagging an empty Message (the form
stays shown, no confirmation): the failure goes through the repaired field but is an `application_defect`, drafted or
linked to a defect, with the repair listed as context.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select

from app.db.models import ExecutionResult, HealSuggestion
from app.db.tenant import BYPASS, bind_scope, system_scope
from app.services import repairs
from tests.integration.test_p4_automation import Flow
from tests.integration.test_p4_execution import _authorise, _ready, _run
from tests.integration.test_p6_repairs import _list, _release_2, flow, pytestmark  # noqa: F401 (fixture, skip mark)


async def _accept_for(flow: Flow, case_key: str) -> list[str]:  # noqa: F811 (the fixture)
    chg = await _release_2(flow)
    keys = []
    for sug in sorted((await _list(flow, f"?change_set={chg['id']}"))["items"], key=lambda i: i["key"]):
        if sug["kind"] != "locator" or sug["status"] != "open":
            continue
        if not any(u.get("case_key") == case_key for u in sug["used_by"]):
            continue
        r = await flow.post(f"/heal-suggestions/{sug['id']}/accept", {"index": 0}, flow.member)
        assert r.status_code == 200, (r.text, sug["old_expression"], sug["candidates"])
        keys.append(sug["key"])
        await flow.idle()
    return keys


async def _unflagged_run(flow: Flow, empty: str) -> dict[str, Any]:  # noqa: F811 (the fixture)
    flow.site.message_unflagged = True
    try:
        run = await _authorise(flow, await _run(flow, [empty], flow.member))
    finally:
        flow.site.message_unflagged = False
    return dict((await flow.get(f"/execution-results/{run['tests_rows'][0]['id']}")).json())


async def test_a_failure_through_a_repair_is_maintenance_only_until_the_case_passes(flow: Flow) -> None:  # noqa: F811
    await _release_2(flow)
    await _ready(flow)
    empty = flow.state["empty"]
    keys = await _accept_for(flow, empty)
    assert keys, "the empty-Message case's script should need a repair on release 2"

    # Before the case has passed with the repair, a failure through the repaired field is read as test maintenance:
    # the window is open. (Running that failure here would leave a fail-then-pass history on the same script version,
    # which the P4 flaky rule reads as flaky; the unit tests cover the script_defect classification.)
    async with flow.ctx.session_factory() as s:
        bind_scope(s, system_scope(flow.owner.org_id))
        rows = list((await s.execute(select(HealSuggestion).where(
            HealSuggestion.project_id == uuid.UUID(flow.pid), HealSuggestion.key.in_(keys)).execution_options(
            **BYPASS))).scalars())  # fmt: skip
        lineage = (await s.execute(select(ExecutionResult.case_lineage_id).where(ExecutionResult.id == uuid.UUID(
            flow.state["failed_result"]["id"])).execution_options(**BYPASS))).scalar_one()  # fmt: skip
        assert rows and await repairs.proven(s, rows, lineage) == set()

    # The case passes with the repair: the repair works.
    ok = await _authorise(flow, await _run(flow, [empty], flow.member))
    assert ok["tests_rows"][0]["status"] == "passed", ok["tests_rows"]
    async with flow.ctx.session_factory() as s:
        bind_scope(s, system_scope(flow.owner.org_id))
        assert await repairs.proven(s, rows, lineage) == {r.id for r in rows}

    # The same failure now reads like any other: an application defect, drafted or linked, the repair as context.
    res = await _unflagged_run(flow, empty)
    a = res["analysis"]
    assert a["classification"] == "application_defect" and a["confidence"] in ("medium", "high"), (res["error"], a)
    assert res["defect"] and res["defect"]["key"].startswith("DEF-"), res.get("defect")
    passed_after = [s["detail"] for s in a["signals"] if s["code"] == "repair_context"]
    assert any(d.startswith("The test passed after this repair: ") for d in passed_after), a["signals"]
