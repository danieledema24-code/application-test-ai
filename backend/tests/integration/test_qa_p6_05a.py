"""QA probes for P6-05a through the API (decisions D32, D33): concurrent G9 decisions, snapshot immutability, staleness
on evidence the hooks don't cover, override boundaries, never auto-queued, manual results per assessment, roles."""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

from sqlalchemy import select, update

from app.db.models import ExecutionResult, ExecutionRun, GateDecision, Risk, TestCase
from app.db.tenant import BYPASS
from app.db.types import utcnow
from app.domain.enums import GateKey, RunStatus
from tests.conftest import worker_for
from tests.integration.test_p6_release import EXIT, Team, assess, crit, fixture_project, team  # noqa: F401

FROZEN = ("recommendation", "criteria", "conditions_list", "residual_risks", "reason", "counts", "overall_residual")


def _frozen(a: dict[str, Any]) -> dict[str, Any]:
    return {k: a[k] for k in FROZEN}


async def test_concurrent_g9_decisions_record_one(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t)
    a = await assess(t, pid)
    url = f"/release-assessments/{a['id']}/decision"
    reason = "Approved by the release board after a review of the evidence."
    r1, r2 = await asyncio.gather(
        t.post(url, {"decision": "approve"}, t.approver),
        t.post(url, {"decision": "override", "final_verdict": "no_go", "reason": reason}, t.approver),
    )
    assert sorted([r1.status_code, r2.status_code]) == [200, 409], (r1.text, r2.text)
    async with t.ctx.session_factory() as s:
        rows = (
            await s.execute(
                select(GateDecision)
                .where(GateDecision.project_id == pid, GateDecision.gate_key == GateKey.G9)
                .execution_options(**BYPASS)
            )
        ).scalars()
        assert len(list(rows)) == 1


async def test_snapshot_does_not_change_when_evidence_changes(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t)
    a = await assess(t, pid)
    before = _frozen(a)
    # Evidence changes behind the API's back (no stale hook): a failing result and a raised risk.
    async with t.ctx.session_factory() as s:
        case = (
            await s.execute(select(TestCase).where(TestCase.project_id == pid).execution_options(**BYPASS))
        ).scalar_one()
        run = ExecutionRun(organisation_id=t.owner.org_id, project_id=pid, key="RUN-0099", status=RunStatus.failed,
                           requested_by=t.owner.user_id, started_at=utcnow(), finished_at=utcnow())  # fmt: skip
        s.add(run)
        await s.flush()
        s.add(ExecutionResult(organisation_id=t.owner.org_id, project_id=pid, execution_run_id=run.id,
                              key="RUN-0099-01", case_lineage_id=case.lineage_id, test_case_id=case.id,
                              status="failed"))  # fmt: skip
        await s.execute(update(Risk).where(Risk.project_id == pid).values(status="accepted")
                        .execution_options(**BYPASS))  # fmt: skip
        await s.commit()
    again = (await t.get(f"/release-assessments/{a['id']}")).json()
    assert _frozen(again) == before
    # Decide it; then a new defect: the final assessment keeps its content and status.
    ok = await t.post(f"/release-assessments/{a['id']}/decision", {"decision": "approve"}, t.approver)
    assert ok.status_code == 200, ok.text
    r = await t.post(f"/projects/{pid}/defects", {"summary": "Footer broken", "actual": "404"}, t.member)
    assert r.status_code == 201
    final = (await t.get(f"/release-assessments/{a['id']}")).json()
    assert final["status"] == "final" and final["final_verdict"] == "go" and _frozen(final) == before


async def test_risk_change_after_assessment_makes_it_stale(team: Team) -> None:  # noqa: F811
    """A risk raised to high after a Go assessment changes rr.high_risk_tested (blocking)."""
    t = team
    pid = await fixture_project(t)
    a = await assess(t, pid)
    assert a["recommendation"] == "go"
    async with t.ctx.session_factory() as s:
        risk = (await s.execute(select(Risk).where(Risk.project_id == pid).execution_options(**BYPASS))).scalar_one()
        rid, version = risk.id, risk.version
    r = await t.patch(f"/risks/{rid}", {"version": version, "status": "accepted", "comment": "PO accepts it"}, t.member)
    assert r.status_code == 200, r.text
    now = (await t.get(f"/release-assessments/{a['id']}")).json()
    assert now["status"] == "stale", (now["status"], now["stale_reason"])


async def test_override_reason_boundaries_and_approve_with_other_verdict(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t, major_defect=True)
    a = await assess(t, pid)
    url = f"/release-assessments/{a['id']}/decision"
    for body in (
        {"decision": "override", "final_verdict": "go", "reason": "   " + "x" * 19 + "   "},
        {"decision": "override", "final_verdict": "go", "reason": "x" * 2001},
        {"decision": "approve", "final_verdict": "go"},
        {"decision": "override", "final_verdict": "GO", "reason": "x" * 30},
    ):
        r = await t.post(url, body, t.approver)
        assert r.status_code == 422, (body, r.text)
    r = await t.post(url, {"decision": "override", "final_verdict": "conditional", "reason": "y" * 20}, t.approver)
    assert r.status_code == 200, r.text
    assert r.json()["assessment"]["override_line"] == "Overridden by Team Mate: " + "y" * 20
    # Decided: confirm and decide again are refused.
    assert (await t.post(url, {"decision": "approve"}, t.approver)).status_code == 409


async def test_never_auto_queued_and_one_at_a_time(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t)
    await worker_for(t.ctx).run_until_idle(timeout=120)
    wf = (await t.get(f"/projects/{pid}/workflow")).json()
    st = next(x for x in wf["stages"] if x["key"] == "release_readiness")
    assert st["status"] not in ("queued", "running", "awaiting_approval"), st["status"]
    r1 = await t.post(f"/projects/{pid}/release-assessments", {}, t.member)
    r2 = await t.post(f"/projects/{pid}/release-assessments", {}, t.member)
    assert r1.status_code == 202 and r2.status_code == 409, (r1.text, r2.text)
    await worker_for(t.ctx).run_until_idle(timeout=120)
    # The stage endpoint is the other way in.
    r3 = await t.post(f"/projects/{pid}/stages/release_readiness/run", {}, t.member)
    assert r3.status_code == 202, r3.text
    await worker_for(t.ctx).run_until_idle(timeout=120)
    hist = (await t.get(f"/projects/{pid}/release-readiness")).json()["history"]
    assert [(h["key"], h["status"]) for h in hist] == [("REL-0002", "awaiting_approval"), ("REL-0001", "superseded")]


async def test_only_passed_or_failed_runs_count(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t)
    async with t.ctx.session_factory() as s:
        await s.execute(update(ExecutionRun).where(ExecutionRun.project_id == pid).values(status=RunStatus.cancelled)
                        .execution_options(**BYPASS))  # fmt: skip
        await s.commit()
    r = await t.post(f"/projects/{pid}/release-assessments", {}, t.member)
    assert r.status_code == 409 and "Run the tests first" in r.text, r.text


async def test_manual_result_is_per_assessment(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t, exit_criteria=[*EXIT, "Stakeholders signed off"])
    a = await assess(t, pid)
    r = await t.post(f"/release-assessments/{a['id']}/criteria/exit.text.5/confirm",
                     {"status": "met", "reason": "Signed off"}, t.member)  # fmt: skip
    assert r.status_code == 200 and r.json()["assessment"]["recommendation"] == "go"
    b = await assess(t, pid)
    c = crit(b)["exit.text.5"]
    assert (c["status"], c["manual"], b["recommendation"]) == ("not_evaluable", False, "conditional")
    assert {"id": "exit.text.5", "text": "Stakeholders signed off", "from": "met", "to": "not_evaluable"} in (
        b["changes_since"]["criteria"]
    )
    # Superseded REL-0001 can't be confirmed or decided any more.
    again = await t.post(f"/release-assessments/{a['id']}/criteria/exit.text.5/confirm",
                         {"status": "met", "reason": "again"}, t.member)  # fmt: skip
    assert again.status_code == 409
    assert (
        await t.post(f"/release-assessments/{a['id']}/decision", {"decision": "approve"}, t.approver)
    ).status_code == 409


async def test_random_ids_404(team: Team) -> None:  # noqa: F811
    t = team
    rid = uuid.uuid4()
    assert (await t.get(f"/release-assessments/{rid}")).status_code == 404
    assert (
        await t.post(f"/release-assessments/{rid}/decision", {"decision": "approve"}, t.approver)
    ).status_code == 404
    pid = await fixture_project(t)
    assert (await t.get(f"/projects/{pid}/release-assessments/by-key/REL-9999")).status_code == 404
