"""QA (Phase 3 verification): P3-01b domain validation of AI-proposed cases, without a model.

The developer's suite has no test for the AI path of the Test Design Agent. These tests call the agent's validation
step (`_ai_case`) directly with model-shaped input on the small contact form used by the domain tests (Name has
maxlength 80, Message has no constraint):
- a BVA case for Message at 1001 characters is dropped with `boundary_not_found` (no maxlength discovered)
- a BVA case for Name at 85 characters is dropped; 81 (a computed boundary) is kept
- a partition that isn't a discovered class is dropped
- an expected result about a backend effect labelled `observed` is stored as `inferred`
- an unknown requirement key is dropped
"""

from __future__ import annotations

import uuid
from typing import Any

from app.agents.testdesign.agent import AiExtraCase, AiStep, TestDesignAgent
from app.domain.testdesign import generate as gen
from tests.unit.test_testdesign_domain import _input


def _agent(inp: gen.DesignInput) -> TestDesignAgent:
    agent = TestDesignAgent(None, None, project_id=uuid.uuid4(), run_id=uuid.uuid4(), task_id=uuid.uuid4())  # type: ignore[arg-type]
    agent.req_keys = {r.key: r for r in inp.requirements}
    return agent


def _extra(**kw: Any) -> AiExtraCase:
    base: dict[str, Any] = {
        "requirement_key": "REQ-0003",
        "technique": "boundary_value_analysis",
        "title": "Message with many characters",
        "objective": "Check a long Message",
        "steps": [AiStep(action="Enter a long Message", expected="")],
        "expected_result": "Submission is blocked",
        "field_label": "Message",
        "boundary_length": 1001,
    }
    base.update(kw)
    return AiExtraCase(**base)


def test_ai_boundary_without_a_discovered_constraint_is_dropped() -> None:
    inp = _input()
    out = gen.design(inp)
    agent = _agent(inp)
    assert agent._ai_case(_extra(), inp, out) is None
    assert [i["code"] for i in agent.issues] == ["boundary_not_found"]
    # The rule baseline is unaffected: still no Message boundary case.
    assert not [c for c in out.cases if c.technique == gen.BVA and "Message" in c.title]


def test_ai_boundary_must_be_a_computed_value() -> None:
    inp = _input()
    out = gen.design(inp)
    agent = _agent(inp)
    dropped = agent._ai_case(_extra(field_label="Name", boundary_length=85, title="Name with 85 characters"), inp, out)
    assert dropped is None and agent.issues[-1]["code"] == "boundary_not_found"
    kept = agent._ai_case(_extra(field_label="Name", boundary_length=81, title="Name just over its limit"), inp, out)
    assert kept is not None and kept.generated_by == "ai"


def test_ai_partition_must_be_a_discovered_class() -> None:
    inp = _input()
    out = gen.design(inp)
    agent = _agent(inp)
    bad = _extra(
        technique="equivalence_partitioning", field_label="Email", partition="emoji_only", boundary_length=None
    )
    assert agent._ai_case(bad, inp, out) is None
    assert agent.issues[-1]["code"] == "boundary_not_found"


def test_ai_backend_claims_are_capped_at_inferred() -> None:
    inp = _input()
    out = gen.design(inp)
    agent = _agent(inp)
    case = agent._ai_case(
        _extra(
            technique="error_guessing",
            title="Submit twice quickly",
            expected_result="The message is stored in the database once",
            classification="observed",
            field_label=None,
            boundary_length=None,
        ),
        inp,
        out,
    )
    assert case is not None
    assert case.provenance == "inferred"


def test_ai_case_for_an_unknown_requirement_is_dropped() -> None:
    inp = _input()
    out = gen.design(inp)
    agent = _agent(inp)
    assert agent._ai_case(_extra(requirement_key="REQ-0999", technique="error_guessing"), inp, out) is None
    assert agent.issues[-1]["code"] == "unknown_requirement"
