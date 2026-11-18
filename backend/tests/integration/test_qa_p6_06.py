"""QA probes for P6-06 (traceability chains, DoD regression rule, AI QA Analyst v5) through the API.

"Can we release?" on stale / rejected / superseded / undecided-Go assessments, numbers equal the API, proposals
(other member, viewer, other organisation, accept twice), chains across projects of the same organisation, the
regression DoD keyword rule on borderline wording, free-text routing, and free-form AI questions about releasing.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy import func, select

from app.agents.readiness.rules import Facts, evaluate, text_rule_for
from app.db.models import ReleaseAssessment
from app.db.tenant import BYPASS, bind_scope, system_scope
from app.domain.enums import ReadinessKind
from app.llm.base import FakeLLM
from app.services import assistant_p6
from app.services.assistant import route
from tests.conftest import CtxFactory, worker_for
from tests.integration.test_p6_release import (  # noqa: F401
    STATEMENT_START,
    Team,
    _ai_team,
    _team,
    assess,
    fixture_project,
    team,
)


async def _thread(t: Team, pid: uuid.UUID, h: dict[str, str]) -> str:
    r = await t.post(f"/projects/{pid}/assistant/threads", {}, h)
    assert r.status_code == 201, r.text
    return str(r.json()["id"])


async def _ask(t: Team, pid: uuid.UUID, body: dict[str, Any], h: dict[str, str]) -> dict[str, Any]:
    tid = await _thread(t, pid, h)
    r = await t.post(f"/assistant/threads/{tid}/messages", body, h)
    assert r.status_code in (200, 201), r.text
    return dict(r.json()["reply"])


def _last(content: str) -> str:
    return content.rstrip().splitlines()[-1]


async def _count_assessments(t: Team, pid: uuid.UUID) -> int:
    async with t.ctx.session_factory() as s:
        q = select(func.count()).select_from(ReleaseAssessment).where(ReleaseAssessment.project_id == pid)
        return int((await s.execute(q.execution_options(**BYPASS))).scalar_one())


async def _set_status(t: Team, aid: str, status: str) -> None:
    async with t.ctx.session_factory() as s:
        row = (
            await s.execute(
                select(ReleaseAssessment).where(ReleaseAssessment.id == uuid.UUID(aid)).execution_options(**BYPASS)
            )
        ).scalar_one()
        row.status = status  # type: ignore[assignment]
        await s.commit()


# ---------------------------------------------------------------- "Can we release?" states


async def test_release_answer_undecided_go_never_says_ready_and_numbers_equal_api(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t)
    a = await assess(t, pid)
    assert a["recommendation"] == "go"
    ans = await _ask(t, pid, {"content": "Can we release?"}, t.viewer)
    assert ans["intent"] == "release_readiness_summary"
    assert ans["content"].startswith(f"{a['key']}: Go · Recommended.")
    low = ans["content"].lower()
    assert "ready to release" not in low and "approved at gate 9" not in low
    assert _last(ans["content"]).startswith(STATEMENT_START)
    assert not ans["proposals"]
    # Numbers equal the API.
    api = (await t.get(f"/release-assessments/{a['id']}")).json()
    statuses = [c["status"] for c in api["criteria"]]
    line = next(x for x in ans["content"].splitlines() if x.startswith("Criteria: "))
    expect = (
        f"Criteria: {statuses.count('met')} met, {statuses.count('not_met')} not met, "
        f"{statuses.count('not_evaluable')} not evaluable"
    )
    assert line.startswith(expect), (line, expect)
    n_cond = len(api.get("conditions_list") or api.get("conditions") or [])
    assert f"({n_cond} condition" in line, (line, n_cond)


async def test_release_answer_stale_rejected_and_superseded(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t, major_defect=True)
    first = await assess(t, pid)
    # Stale: the answer starts with the out-of-date line, then still says Not decided (never Final).
    await _set_status(t, first["id"], "stale")
    ans = await _ask(t, pid, {"content": "Can we release?"}, t.member)
    lines = ans["content"].splitlines()
    assert lines[0] == f"{first['key']} is out of date: evidence changed after it."
    assert "Final" not in lines[1]
    assert _last(ans["content"]).startswith(STATEMENT_START)
    # Assess again: the newer assessment is the one cited, the stale one isn't.
    second = await assess(t, pid)
    assert second["key"] != first["key"]
    ans2 = await _ask(t, pid, {"intent": "release_readiness_summary"}, t.member)
    assert ans2["content"].startswith(f"{second['key']}: No-go · Recommended."), ans2["content"]
    assert first["key"] not in ans2["content"]
    # Rejected at Gate 9.
    r = await t.post(f"/release-assessments/{second['id']}/decision",
                     {"decision": "reject", "reason": "We need more evidence before deciding."}, t.approver)  # fmt: skip
    assert r.status_code == 200, r.text
    ans3 = await _ask(t, pid, {"intent": "release_readiness_summary"}, t.member)
    assert "rejected at Gate 9" in ans3["content"], ans3["content"]
    assert "ready to release" not in ans3["content"].lower()
    assert _last(ans3["content"]).startswith(STATEMENT_START)


# ---------------------------------------------------------------- proposals: who can accept, never twice


async def test_assess_proposal_permissions_and_accept_twice(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t)
    ans = await _ask(t, pid, {"content": "Can we release?"}, t.member)
    [prop] = ans["proposals"]
    assert prop["kind"] == "assess_release"
    assert await _count_assessments(t, pid) == 0  # asking starts nothing
    url = f"/assistant/proposals/{prop['id']}/accept"
    for who in (t.approver, t.viewer, t.owner.headers, t.other.headers):
        r = await t.post(url, {}, who)
        assert r.status_code in (403, 404), (r.status_code, r.text)
    await worker_for(t.ctx).run_until_idle(timeout=120)
    assert await _count_assessments(t, pid) == 0
    r = await t.post(url, {}, t.member)
    assert r.status_code == 200, r.text
    again = await t.post(url, {}, t.member)
    assert again.status_code == 409, again.text
    await worker_for(t.ctx).run_until_idle(timeout=120)
    assert await _count_assessments(t, pid) == 1


async def test_other_org_cannot_ask_or_read_chains(team: Team) -> None:  # noqa: F811
    t = team
    pid = await fixture_project(t)
    await assess(t, pid)
    r = await t.post(f"/projects/{pid}/assistant/threads", {}, t.other.headers)
    assert r.status_code == 404, r.text
    for key in ("REL-0001", "CHG-0001", "HEAL-0001", "EXP-0001"):
        r = await t.get(f"/projects/{pid}/traceability/chain?key={key}", t.other.headers)
        assert r.status_code == 404, (key, r.text)


async def test_chain_keys_are_scoped_to_the_project(team: Team) -> None:  # noqa: F811
    t = team
    pid_a = await fixture_project(t)
    a = await assess(t, pid_a)
    pid_b = await fixture_project(t)
    ok = await t.get(f"/projects/{pid_a}/traceability/chain?key={a['key']}", t.viewer)
    assert ok.status_code == 200, ok.text
    lower = await t.get(f"/projects/{pid_a}/traceability/chain?key={a['key'].lower()}", t.viewer)
    assert lower.status_code == 200, lower.text
    # Same organisation, other project with no assessment: 404, never project A's assessment.
    other = await t.get(f"/projects/{pid_b}/traceability/chain?key={a['key']}", t.viewer)
    assert other.status_code == 404, other.text
    for bad in ("REL-", "CHG-9999", "EXP-0001-01", "HEAL-x"):
        r = await t.get(f"/projects/{pid_a}/traceability/chain?key={bad}")
        assert r.status_code in (404, 422), (bad, r.status_code, r.text)
    # The citation guard does not resolve another project's key.
    async with t.ctx.session_factory() as s:
        bind_scope(s, system_scope(t.owner.org_id))
        found = await assistant_p6.resolve(s, pid_b, {a["key"]})
    assert found == {}


# ---------------------------------------------------------------- AI on: free-form release questions


async def test_free_form_release_question_cannot_get_a_model_verdict(make_ctx: CtxFactory) -> None:
    claim = {"answer": "Yes: Go. The site is ready to release, everything passed.", "cited_keys": [],
             "follow_up_intents": []}  # fmt: skip
    llm = FakeLLM([{"narrative": "Fine."}, claim, claim, claim])
    ctx, client = await _ai_team(make_ctx, llm, "qa606")
    async with client:
        t = await _team(ctx, client, f"qa606{uuid.uuid4().hex[:6]}")
        pid = await fixture_project(t, major_defect=True)
        a = await assess(t, pid)
        assert a["recommendation"] == "no_go"
        ans = await _ask(t, pid, {"content": "Is it safe to ship?"}, t.member)
        assert "ready to release" not in ans["content"].lower(), ans
        assert _last(ans["content"]).startswith(STATEMENT_START), ans["content"]


# ---------------------------------------------------------------- routing and the DoD keyword rule


@pytest.mark.parametrize(
    ("text", "intent"),
    [
        ("Can we release?", "release_readiness_summary"),
        ("Are we ready to release?", "release_readiness_summary"),
        ("Should we ship this build?", "release_readiness_summary"),
        ("What changed?", "what_changed"),
        ("What does the change affect?", "impact_summary"),
        ("Explain HEAL-0001", "explain_heal"),
        ("Explore the new and changed pages", "propose_exploration"),
        ("Propose a regression run", "propose_regression_run"),
        ("Decide Gate 9 as go", "refuse_gate"),
        # Earlier-phase routes must not be captured by the Phase 6 router.
        ("Propose a regression suite for the high risks", "propose_regression_suite"),
        ("What is the impact of DEF-0003?", "analyse_defect"),
        ("What changed in REQ-0001?", "explain_requirement"),
    ],
)
def test_free_text_routing(text: str, intent: str) -> None:
    got = route(text)
    assert got is not None and got[0] == intent, (text, got)


@pytest.mark.parametrize(
    ("text", "rule"),
    [
        ("Impacted tests are re-run after changes (regression)", "dod.regression"),
        ("Regression tests have been executed", "dod.regression"),
        ("Changed areas are retested", "dod.regression"),
        ("Must-run tests are re-tested", "dod.regression"),
        ("Tests are rerun", "dod.regression"),
        ("Tests pass after the change", "dod.regression"),
        ("No performance regression against the thresholds", "dod.nf.performance"),
        ("All acceptance criteria have a test case", None),
    ],
)
def test_regression_dod_keyword_rule(text: str, rule: str | None) -> None:
    assert text_rule_for(ReadinessKind.dod, text) == rule, text
    # DoR items are never mapped to the regression rule.
    assert text_rule_for(ReadinessKind.dor, "Regression tests have been executed") != "dod.regression"


def test_regression_rule_never_met_without_evidence() -> None:
    base: dict[str, Any] = {"change_set": "CHG-0001", "reason": None, "must": [], "pending": [],
                            "manual_pending": [], "runs": []}  # fmt: skip
    f = Facts.__new__(Facts)
    f.regression = None
    assert evaluate("dod.regression", f)["status"] == "unknown"  # type: ignore[index]
    f.regression = {**base, "reason": "The comparison has no recommendation yet"}
    assert evaluate("dod.regression", f)["status"] == "unknown"  # type: ignore[index]
    f.regression = {**base, "must": ["TC-0001"], "manual_pending": ["TC-0001"]}
    assert evaluate("dod.regression", f)["status"] == "unknown"  # type: ignore[index]
    f.regression = {**base, "must": ["TC-0001", "TC-0002"], "pending": ["TC-0002"]}
    r = evaluate("dod.regression", f)
    assert r is not None and r["status"] == "not_met" and "1 impacted test not re-run since CHG-0001" in r["detail"]
    f.regression = {**base, "must": ["TC-0001"], "runs": ["RUN-0005"]}
    r = evaluate("dod.regression", f)
    assert r is not None and r["status"] == "met" and "RUN-0005" in r["detail"]
