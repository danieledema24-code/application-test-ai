"""QA Phase 4 round 1: run requests through the authorise endpoint (open question 3, resolved): a request waiting
for authorisation expires after 7 days, and any change to one of its scripts invalidates it. Both answer 409 with
the request_problem text, store no G7 decision and leave the run waiting. Reuses the P4-06 module fixture."""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select

from app.db.models import AutomationScript, ExecutionRun, GateDecision
from app.db.tenant import bind_scope, system_scope
from tests.integration.test_p4_execution import _ready, _run, flow, pytestmark

__all__ = ["flow", "pytestmark"]


async def _db(flow, fn):  # type: ignore[no-untyped-def]
    async with flow.ctx.session_factory() as s:
        bind_scope(s, system_scope(uuid.UUID(str(flow.owner.org_id))))
        out = await fn(s)
        await s.commit()
        return out


@pytest.mark.asyncio
async def test_request_older_than_7_days_cannot_be_authorised(flow) -> None:  # type: ignore[no-untyped-def]
    await _ready(flow)
    run = await _run(flow, [flow.state["empty"]], flow.member)
    rid = uuid.UUID(run["id"])

    async def age(s):  # type: ignore[no-untyped-def]
        row = (await s.execute(select(ExecutionRun).where(ExecutionRun.id == rid))).scalar_one()
        row.created_at = row.created_at - timedelta(days=8)

    await _db(flow, age)
    detail = (await flow.get(f"/execution-runs/{rid}")).json()
    assert detail["request_problem"] == "This request expired after 7 days. Request it again."
    r = await flow.post(f"/execution-runs/{rid}/authorise", {"decision": "approve"}, flow.approver)
    assert r.status_code == 409, r.text
    assert "expired after 7 days" in r.json()["error"]["message"]

    async def g7(s):  # type: ignore[no-untyped-def]
        return list((await s.execute(select(GateDecision).where(GateDecision.subject_id == rid))).scalars())

    assert await _db(flow, g7) == []
    assert (await flow.get(f"/execution-runs/{rid}")).json()["status"] == "awaiting_authorisation"
    # Clean up: withdraw it so later tests see no waiting request.
    assert (await flow.post(f"/execution-runs/{rid}/cancel", {}, flow.member)).status_code == 200


@pytest.mark.asyncio
async def test_script_change_invalidates_a_waiting_request(flow) -> None:  # type: ignore[no-untyped-def]
    await _ready(flow)
    run = await _run(flow, [flow.state["empty"]], flow.member)
    rid = uuid.UUID(run["id"])
    sid = uuid.UUID(run["scope"]["cases"][0]["script_id"])
    old: dict[str, str] = {}

    async def change(s):  # type: ignore[no-untyped-def]
        row = (await s.execute(select(AutomationScript).where(AutomationScript.id == sid))).scalar_one()
        old["sha"] = row.sha256
        row.sha256 = "0" * 64

    async def restore(s):  # type: ignore[no-untyped-def]
        row = (await s.execute(select(AutomationScript).where(AutomationScript.id == sid))).scalar_one()
        row.sha256 = old["sha"]

    await _db(flow, change)
    try:
        r = await flow.post(f"/execution-runs/{rid}/authorise", {"decision": "approve"}, flow.approver)
        assert r.status_code == 409, r.text
        msg = r.json()["error"]["message"]
        assert "script changed after this request" in msg and "Request it again." in msg
        assert (await flow.get(f"/execution-runs/{rid}")).json()["status"] == "awaiting_authorisation"
    finally:
        await _db(flow, restore)
        await flow.post(f"/execution-runs/{rid}/cancel", {}, flow.member)
