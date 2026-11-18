"""P6-06 "Can we release?" (AI QA Analyst v5) on the P6-05a fixture project, AI off and with FakeLLM.

AI off: with no assessment the answer says so and offers to create one (members; viewers read only); accepting starts
the assessment; the answer then gives the stored verdict with its state word, cites REL-0001 and its blocking
criteria and always ends with the fixed release statement; an override is shown with the decider and reason. The
REL chain lists the criteria and their evidence; other organisations get 404. With AI on (FakeLLM), "Can we release?"
and "What changed?" are still answered from the stored rows: the model is never asked, so it can't contradict the
verdict; a model answer to another question that claims a verdict is replaced by the rules answer.
"""

from __future__ import annotations

import uuid
from typing import Any

from app.domain.change.diff import CHANGE_STATEMENT
from app.llm.base import FakeLLM
from app.services import assistant_p6
from tests.conftest import CtxFactory, worker_for
from tests.integration.test_p6_release import STATEMENT_START, Team, _ai_team, _team, assess, fixture_project, team

__all__ = ["team"]  # the module-level fixture from test_p6_release.py


async def _ask(t: Team, pid: uuid.UUID, body: dict[str, Any], h: dict[str, str]) -> dict[str, Any]:
    key = f"thread-{pid}-{id(h)}"
    threads: dict[str, str] = t.__dict__.setdefault("threads", {})
    if key not in threads:
        r = await t.post(f"/projects/{pid}/assistant/threads", {}, h)
        assert r.status_code == 201, r.text
        threads[key] = r.json()["id"]
    r = await t.post(f"/assistant/threads/{threads[key]}/messages", body, h)
    assert r.status_code in (200, 201), r.text
    return dict(r.json()["reply"])


def _last_line(content: str) -> str:
    return content.rstrip().splitlines()[-1]


async def test_can_we_release_without_ai(team: Team) -> None:
    t = team
    pid = await fixture_project(t, major_defect=True)
    # No assessment yet: say so and offer to create one; viewers only read.
    viewer = await _ask(t, pid, {"content": "Can we release?"}, t.viewer)
    assert viewer["intent"] == "release_readiness_summary" and not viewer["proposals"]
    assert viewer["content"] == f"{assistant_p6.NO_ASSESSMENT} {assistant_p6.VIEWERS}"
    first = await _ask(t, pid, {"content": "Can we release?"}, t.member)
    assert first["content"].startswith(assistant_p6.NO_ASSESSMENT)
    [prop] = first["proposals"]
    assert prop["kind"] == "assess_release"
    assert (await t.get(f"/projects/{pid}/release-readiness")).json()["latest"] is None  # nothing started yet
    r = await t.post(f"/assistant/proposals/{prop['id']}/accept", {}, t.member)
    assert r.status_code == 200, r.text
    await worker_for(t.ctx).run_until_idle(timeout=120)
    latest = (await t.get(f"/projects/{pid}/release-readiness")).json()["latest"]
    assert latest["key"] == "REL-0001" and latest["recommendation"] == "no_go"
    # The stored verdict, its state word, the blocking criterion and the fixed statement last.
    ans = await _ask(t, pid, {"content": "Can we release?"}, t.member)
    lines = ans["content"].splitlines()
    assert lines[0] == "REL-0001: No-go · Recommended. Gate 9 decides; the recommendation is advisory."
    assert "1 blocking criterion isn't met: there is an open major defect (DEF-0001)." in lines
    assert "Blocking criteria not met:" in lines and any("DEF-0001" in x for x in lines)
    assert _last_line(ans["content"]).startswith(STATEMENT_START)
    assert "ready to release" not in ans["content"].lower()
    assert {"REL-0001", "DEF-0001"} <= {c["key"] for c in ans["citations"]}
    assert "built_in_answer" in {n["code"] for n in ans["notices"]}
    # An override is shown with who decided it and why.
    reason = "Business accepts the contact form risk for this release."
    d = await t.post(f"/release-assessments/{latest['id']}/decision",
                     {"decision": "override", "final_verdict": "go", "reason": reason}, t.approver)  # fmt: skip
    assert d.status_code == 200, d.text
    final = await _ask(t, pid, {"intent": "release_readiness_summary"}, t.member)
    assert final["content"].startswith("REL-0001: Go · Final (decided by ")
    assert "Overridden by " in final["content"] and reason in final["content"]
    assert _last_line(final["content"]).startswith(STATEMENT_START)
    # The REL chain: criteria, then their evidence; other organisations get 404.
    chain = await t.get(f"/projects/{pid}/traceability/chain?key=REL-0001", t.viewer)
    assert chain.status_code == 200, chain.text
    c = chain.json()
    assert c["root"]["type"] == "release_assessment" and c["root"]["label"] == "REL-0001 · Go · Final"
    assert [lv["type"] for lv in c["downstream"]] == ["release_criterion", "evidence"]
    crit = c["downstream"][0]["items"]
    assert any("Not met · Blocking" in x["label"] for x in crit)
    assert "DEF-0001" in [x["key"] for x in c["downstream"][1]["items"]]
    exp = await t.get(f"/projects/{pid}/traceability/chain?key=EXP-0001")
    assert exp.status_code == 200 and exp.json()["root"]["type"] == "exploratory_session"
    assert (await t.get(f"/projects/{pid}/traceability/chain?key=REL-0001", t.other.headers)).status_code == 404
    assert (await t.get(f"/projects/{pid}/traceability/chain?key=REL-0002")).status_code == 404


async def test_ai_can_not_answer_release_or_change_questions(make_ctx: CtxFactory) -> None:
    claim = {"answer": "Yes: Go. The site is ready to release, everything passed.", "cited_keys": [],
             "follow_up_intents": []}  # fmt: skip
    neutral = {"answer": "The project has one approved requirement and one test case.", "cited_keys": [],
               "follow_up_intents": []}  # fmt: skip
    llm = FakeLLM([{"narrative": "Everything checked out and the product is ready to release today."}, claim, neutral])
    ctx, client = await _ai_team(make_ctx, llm, "ai")
    async with client:
        t = await _team(ctx, client, f"p6as{uuid.uuid4().hex[:6]}")
        pid = await fixture_project(t, major_defect=True)
        a = await assess(t, pid)
        assert a["recommendation"] == "no_go"
        asked = len(llm.captured)
        ans = await _ask(t, pid, {"content": "Can we release?"}, t.member)
        assert ans["answered_by"] == "intent" and ans["intent"] == "release_readiness_summary"
        assert ans["content"].startswith("REL-0001: No-go · Recommended.")
        assert "ready to release" not in ans["content"].lower()
        assert _last_line(ans["content"]).startswith(STATEMENT_START)
        changed = await _ask(t, pid, {"content": "What changed?"}, t.member)
        assert changed["intent"] == "what_changed" and changed["content"].endswith(CHANGE_STATEMENT)
        assert len(llm.captured) == asked and llm.responses[0] is claim  # the model was never asked either question
        # Other questions still go to the model, but an answer that claims a release verdict is replaced by the
        # rules answer (QA P6-06); a neutral answer is kept.
        free = await _ask(t, pid, {"content": "Summarise the project for a newcomer"}, t.member)
        assert len(llm.captured) == asked + 1
        assert free["answered_by"] == "intent" and free["intent"] == "release_readiness_summary"
        assert free["content"].startswith("REL-0001: No-go · Recommended.") and claim["answer"] not in free["content"]
        assert _last_line(free["content"]).startswith(STATEMENT_START)
        assert "partial_answer" in {n["code"] for n in free["notices"]}
        plain = await _ask(t, pid, {"content": "Summarise the requirements for a newcomer"}, t.member)
        assert plain["answered_by"] == "ai" and plain["content"] == neutral["answer"]
        # The model sees the real release state, not a fixed "no tests have been run".
        prompt = str(llm.captured[-1])
        assert "No tests have been run" not in prompt and "REL-0001" in prompt and "no_go" in prompt
