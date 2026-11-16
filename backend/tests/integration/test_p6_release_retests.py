"""P6-05a after QA: manual re-tests (decision D37) and the further stale triggers, through the API, AI off.

The fixture project of test_p6_release.py gets a rescan's change set (CHG-0001) whose regression recommendation has
one must-run test, TC-0001, which has no script: a manual test. Until a person records its re-test,
`rr.impacted_rerun` can't be checked (conditional); a recorded result (passed or failed, with a note) counts like an
automated one, so the fixture becomes Go. Recording is audited, makes a waiting assessment stale, viewers read only and
other organisations get 404.

Stale triggers added after QA: a risk added or edited (raised to high, accepted), an impact item closed, a repair
suggestion rejected, a manual re-test recorded. (Accessibility/security checks and load tests finishing call the same
`mark_stale` in their agents; those need real Chromium or k6 and are not run here.)
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select

from app.db.models import (
    ChangeSet,
    HealSuggestion,
    ImpactItem,
    Risk,
    ScanSession,
    TestCase,
)
from app.db.tenant import BYPASS, bind_scope, system_scope
from app.db.types import utcnow
from app.domain.enums import (
    ChangeSetStatus,
    GeneratedBy,
    HealKind,
    HealSource,
    ImpactAction,
    ImpactLevel,
    ImpactTargetKind,
    ScanStatus,
    StageKey,
    StageStatus,
)
from app.services.counters import next_key
from tests.integration.test_p5_foundation import _set_stage
from tests.integration.test_p6_release import Team, _audit, assess, crit, fixture_project, team  # noqa: F401

CONDITION = "Re-test TC-0001 by hand after CHG-0001 and record the result (manual test)"


async def _change_set(t: Team, pid: uuid.UUID, *, review_item: bool = False, repair: bool = False) -> str:
    """CHG-0001 from a rescan, created after the fixture's run: TC-0001 (no script, so manual) must be re-run."""
    owner = t.owner
    run_id = await _set_stage(t.ctx, owner, pid, StageKey.discovery, StageStatus.completed, {"pages": 3})
    async with t.ctx.session_factory() as s:
        bind_scope(s, system_scope(owner.org_id))
        common = {"organisation_id": owner.org_id, "project_id": pid}
        case = (await s.execute(select(TestCase).where(TestCase.project_id == pid))).scalar_one()
        base = (await s.execute(select(ScanSession).where(ScanSession.project_id == pid))).scalar_one()  # the G2 scan
        n, key = await next_key(s, owner.org_id, pid, "scan")
        target = ScanSession(**common, stage_run_id=run_id, key=key, sequence=n, start_url=base.start_url,
                             status=ScanStatus.completed, is_rescan=True, baseline_scan_session_id=base.id,
                             finished_at=utcnow())  # fmt: skip
        s.add(target)
        await s.flush()
        pick = {"case_lineage_id": str(case.lineage_id), "key": "TC-0001", "title": case.title,
                "reasons": ['Directly affected: button "Send" renamed']}  # fmt: skip
        cs = ChangeSet(**common, key="CHG-0001", stage_run_id=run_id, base_scan_session_id=base.id,
                       target_scan_session_id=target.id, status=ChangeSetStatus.completed, finished_at=utcnow(),
                       rerun_recommendation={"must": [pick], "should": [], "excluded": []})  # fmt: skip
        s.add(cs)
        await s.flush()
        if review_item:
            s.add(ImpactItem(**common, change_set_id=cs.id, target_kind=ImpactTargetKind.test_case,
                             target_ref=str(case.lineage_id), level=ImpactLevel.indirect, action=ImpactAction.review,
                             reason="Page changed: /contact. Review TC-0001"))  # fmt: skip
        if repair:
            s.add(HealSuggestion(**common, key="HEAL-0001", source=HealSource.change, kind=HealKind.locator,
                                 file="pages/ContactPage.ts", getter="send", old_expression="getByRole('button')",
                                 generated_by=GeneratedBy.rules))  # fmt: skip
        await s.commit()
        return str(cs.id)


async def _row(t: Team, model: Any, pid: uuid.UUID) -> Any:
    async with t.ctx.session_factory() as s:
        return (await s.execute(select(model).where(model.project_id == pid).execution_options(**BYPASS))).scalar_one()


async def test_manual_retests_are_recorded_and_count_like_results(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t)
    cs = await _change_set(t, pid)
    a = await assess(t, pid)
    c = crit(a)["rr.impacted_rerun"]
    assert (c["status"], a["recommendation"]) == ("not_evaluable", "conditional"), c
    assert [x["text"] for x in a["conditions_list"]] == [CONDITION]
    url = f"/change-sets/{cs}/manual-retests"
    seen = (await t.get(url, t.viewer)).json()
    assert seen["change_set"]["key"] == "CHG-0001" and seen["permissions"] == {"can_record": False}
    [item] = seen["items"]
    assert (item["case_key"], item["latest"], item["history"]) == ("TC-0001", None, [])
    assert seen["counts"] == {"total": 1, "recorded": 0, "open": 1}
    body = {"case_key": "TC-0001", "status": "passed", "note": "Sent the form with the new button: message arrives"}
    # Viewers read only; other organisations 404; validation.
    assert (await t.post(url, body, t.viewer)).status_code == 403
    assert (await t.get(url, t.other.headers)).status_code == 404
    assert (await t.post(url, body, t.other.headers)).status_code == 404
    for bad, field, msg in (
        ({**body, "note": "  "}, "note", "Add a note: what you did and what you saw."),
        ({"case_key": "TC-0001", "note": "ok"}, "status", "Choose Passed or Failed."),
        ({**body, "case_key": "TC-0099"}, "case_key", "TC-0099 isn't a manual must-run test of CHG-0001."),
    ):
        r = await t.post(url, bad, t.member)
        assert r.status_code == 422 and r.json()["error"]["details"][0] == {"field": field, "message": msg}, r.text
    assert (await t.post(url, {**body, "status": "maybe"}, t.member)).status_code == 422
    assert not await _audit(t.ctx, pid, "manual_retest.recorded")
    # A member records it: audited, the waiting assessment goes stale.
    r = await t.post(url, body, t.member)
    assert r.status_code == 201, r.text
    assert r.json()["message"] == "Manual re-test of TC-0001 recorded: passed."
    latest = r.json()["items"][0]["latest"]
    assert (latest["status"], latest["note"], latest["recorded_by"]["full_name"]) == (
        "passed",
        body["note"],
        "Team Mate",
    )
    assert latest["recorded_by"]["email"] is None and r.json()["counts"]["recorded"] == 1
    [log] = await _audit(t.ctx, pid, "manual_retest.recorded")
    assert log.meta == {"change_set": "CHG-0001", "case": "TC-0001", "status": "passed"}
    stale = (await t.get(f"/release-assessments/{a['id']}")).json()
    assert (stale["status"], stale["stale_reason"]) == ("stale", "Manual re-test of TC-0001 recorded (passed)")
    # It counts like an automated result: Go.
    b = await assess(t, pid)
    c = crit(b)["rr.impacted_rerun"]
    assert (c["status"], b["recommendation"]) == ("met", "go"), c
    assert c["detail"] == ("Every must-run test from CHG-0001 has a result since the change: TC-0001. "
                           "Re-tested by hand: TC-0001 (passed).")  # fmt: skip
    # A later failed re-test is the latest; the history keeps both.
    r = await t.post(url, {**body, "status": "failed", "note": "Second try: no confirmation shown"}, t.approver)
    assert r.status_code == 201
    hist = r.json()["items"][0]["history"]
    assert [h["status"] for h in hist] == ["failed", "passed"]
    assert (await t.get(f"/release-assessments/{b['id']}")).json()["status"] == "stale"
    d = await assess(t, pid)
    c = crit(d)["rr.impacted_rerun"]
    assert c["status"] == "met" and "TC-0001 (failed)" in c["detail"]
    # The failed re-test is a condition naming the test and the note, not "re-run and fine".
    assert d["recommendation"] == "conditional" and crit(d)["rr.manual_retests"]["status"] == "not_met"
    assert [x["text"] for x in d["conditions_list"]] == [
        "TC-0001 failed when re-tested by hand after CHG-0001: 'Second try: no confirmation shown'. Fix it or raise a "
        "defect"
    ]


async def test_risks_impact_items_and_repairs_make_it_stale(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t)
    cs = await _change_set(t, pid, review_item=True, repair=True)

    async def stale_after(action: Any, reason: str) -> None:
        a = await assess(t, pid)
        assert a["status"] == "awaiting_approval"
        r = await action()
        assert r.status_code in (200, 201), r.text
        now = (await t.get(f"/release-assessments/{a['id']}")).json()
        assert (now["status"], now["stale_reason"]) == ("stale", reason.format(key=r.json().get("key")))

    # A risk raised to high (likelihood and impact edited).
    risk = await _row(t, Risk, pid)
    await stale_after(lambda: t.patch(f"/risks/{risk.id}", {"version": risk.version, "likelihood": 5,
                                                            "change_reason": "More users"}, t.member),
                      "RISK-001 was changed")  # fmt: skip
    # A new risk.
    new = {"title": "Checkout fails under load", "likelihood": 4, "impact": 4, "likelihood_rationale": "Peak sales",
           "impact_rationale": "Lost orders", "mitigation": {}}  # fmt: skip
    await stale_after(lambda: t.post(f"/projects/{pid}/risks", new, t.member), "{key} was added")
    # An impact item closed.
    item = await _row(t, ImpactItem, pid)
    await stale_after(lambda: t.patch(f"/impact-items/{item.id}", {"status": "resolved"}, t.member),
                      "An impact item of CHG-0001 was closed")  # fmt: skip
    # A repair suggestion rejected.
    heal = await _row(t, HealSuggestion, pid)
    await stale_after(lambda: t.post(f"/heal-suggestions/{heal.id}/reject", {"reason": "Wrong button"}, t.member),
                      "HEAL-0001 was rejected")  # fmt: skip
    _ = cs
