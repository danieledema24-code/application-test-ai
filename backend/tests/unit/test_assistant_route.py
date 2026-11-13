"""P2-10 keyword routing used when AI is off (and as the AI fallback)."""

from __future__ import annotations

import pytest

from app.services.assistant import INTENTS, route


@pytest.mark.parametrize(
    ("text", "intent", "params"),
    [
        ("Add negative criteria to req-0004", "propose_negative_criteria", {"requirement_key": "REQ-0004"}),
        ("Please reassess the risks", "propose_risk_reassessment", {}),
        ("Explain REQ-0012", "explain_requirement", {"key": "REQ-0012"}),
        ("Why can't I approve G4?", "explain_gate", {"gate": "G4"}),
        ("What needs my attention?", "needs_attention", {}),
        ("Did the tests pass?", "execution_results", {}),
        ("Which requirements are still draft?", "list_requirements", {"status": "draft"}),
        ("Regenerate the test strategy", "propose_regenerate", {"stage": "test_strategy"}),
        ("Approve Gate 3", "refuse_gate", {"gate": "G3"}),
        ("please approve G4 now", "refuse_gate", {"gate": "G4"}),
        ("Which requirements aren't approved yet?", "list_requirements", {"status": "draft"}),
        ("Explain the failed login test", "execution_results", {}),
    ],
)
def test_route(text: str, intent: str, params: dict[str, str]) -> None:
    assert route(text) == (intent, params)


def test_unknown_text_is_not_routed() -> None:
    assert route("Write me a poem about ducks") is None


def test_ai_only_intents_are_marked() -> None:
    assert {i for i, s in INTENTS.items() if s.requires_ai} == {
        "propose_requirement_update",
        "propose_missing_requirements",
        "propose_risk_update",
        "propose_test_case_update",  # P3-06, AI-only
        "propose_missing_test_cases",  # P3-06, AI-only
    }
    assert all(s.requires_role == "member" for s in INTENTS.values() if s.creates_proposal)
