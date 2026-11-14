"""Definition of Done rules fed by Phase 4 results (P4-12, QA P4-BUG-10): long details name the first eight and say
how many more there are, instead of dropping names silently."""

from __future__ import annotations

from app.agents.readiness import rules


def _reqs(n: int) -> list[dict[str, object]]:
    return [{"id": f"r{i}", "key": f"REQ-{i:04d}", "status": "approved"} for i in range(1, n + 1)]


def test_tests_executed_says_how_many_more() -> None:
    facts = rules.Facts(requirements=_reqs(11), executed={"r1": ["passed"]})
    out = rules.evaluate("dod.tests_executed", facts)
    assert out is not None and out["status"] == "not_met"
    names = ", ".join(f"REQ-{i:04d}" for i in range(2, 10))
    assert out["detail"] == f"Without a passed or failed result: {names} and 2 more"


def test_exactly_eight_names_are_all_shown() -> None:
    facts = rules.Facts(requirements=_reqs(9), executed={"r1": ["failed"]})
    out = rules.evaluate("dod.tests_executed", facts)
    assert out is not None and out["detail"].endswith("REQ-0009") and "more" not in out["detail"]


def test_open_high_defects_say_how_many_more() -> None:
    facts = rules.Facts(executed={}, open_defects=[(f"DEF-{i:04d}", "major") for i in range(1, 11)])
    out = rules.evaluate("dod.no_open_high_defects", facts)
    assert out is not None and out["detail"].endswith("DEF-0008 (Major) and 2 more are open")
