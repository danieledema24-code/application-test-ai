"""QA regressions found while verifying Phase 2 (P2-11, docs/qa/phase2-verification.md).

Each test reproduces one bug report against the local fixture site with AI off. They are expected to fail until the
bug is fixed; the bug id is in each docstring. The module shares one project (module-scoped `flow` fixture from
test_phase2_flow) and the tests run in file order.
"""

from __future__ import annotations

import uuid

from app.agents.requirements.rules import ReqDraft, boundary_criteria_for
from app.domain.enums import AcKind, BehaviourScope, Provenance, RequirementType
from tests.integration.test_phase2_flow import Flow, _upload, flow  # noqa: F401  (fixture re-used)

MD = b"# Spec\n\n## Contact\n\nThe contact form shall reject messages longer than 1000 characters.\n"
MD2 = b"# Second spec\n\n## Loyalty\n\nMembers must be able to redeem loyalty points at checkout.\n"


def test_boundary_values_are_exactly_n_and_n_plus_one() -> None:
    """P2-03 AC2: a field with maxlength=50 gets boundary criteria at exactly 50 and 51 characters."""
    req = ReqDraft(
        match_key="f|form.length_limit",
        rule_id="form.length_limit",
        title="Name accepts at most 50 characters",
        description="",
        type=RequirementType.functional,
        category="validation",
        behaviour_scope=BehaviourScope.ui,
        classification=Provenance.observed,
        confidence=0.9,
        evidence_refs=[{"evidence_id": str(uuid.uuid4()), "selector": "#name"}],
        facts={"label": "Name", "form": "contact", "maxlength": "50"},
    )
    acs = boundary_criteria_for(req)
    assert [a.kind for a in acs] == [AcKind.boundary, AcKind.boundary]
    values = [a.test_values[0]["value"] for a in acs if a.test_values]
    assert [len(v) for v in values] == [50, 51]
    assert all(a.classification == Provenance.inferred for a in acs)  # not exercised in discovery
    assert all(a.evidence_refs == req.evidence_refs for a in acs)


async def test_editing_definition_of_ready_after_g3_approval_reopens_g3(flow: Flow) -> None:  # noqa: F811
    """P2-05 AC3: given G3 approved, when I edit a Definition of Ready criterion, then G3 reopens (P2-00 rule)."""
    await flow.idle()
    draft = next(r for r in await flow.reqs(status="draft") if r["classification"] in ("observed", "inferred"))
    ok = await flow.post(f"/requirements/{draft['id']}/status", {"version": draft["version"], "status": "approved"})
    assert ok.status_code == 200, ok.text
    await flow.idle()
    st = await flow.stage("requirements")
    if st["gate"]["status"] != "approved":
        body = {"decision": "approve", "comment": "QA", "stage_run_version": st["current_version"]}
        g3 = await flow.post(f"/projects/{flow.pid}/gates/G3/decision", body)
        assert g3.status_code == 200, g3.text
        await flow.idle()
    before = await flow.stage("requirements")
    assert before["gate"]["status"] == "approved" and before["status"] != "awaiting_approval", before["status"]
    dor = (await flow.get(f"/projects/{flow.pid}/readiness-criteria")).json()["definition_of_ready"]
    first = dor[0]
    body = {"version": first["version"], "text": first["text"] + " (QA)"}
    r = await flow.patch(f"/readiness-criteria/{first['id']}", body)
    assert r.status_code == 200, r.text
    await flow.idle()
    after = await flow.stage("requirements")
    assert after["status"] == "awaiting_approval" or after["gate"]["status"] != "approved", after["status"]


async def test_adding_a_criterion_to_an_approved_requirement_reopens_g3(flow: Flow) -> None:  # noqa: F811
    """BUG-P2-02 / P2-03 AC4: given an approved requirement, when I add an AC, then the requirement returns to draft
    and G3 reopens. Today the requirement stays approved and G3 stays approved (requirements.py create_ac passes
    reopen=False)."""
    await flow.idle()
    draft = next(r for r in await flow.reqs(status="draft") if r["classification"] in ("observed", "inferred"))
    ok = await flow.post(f"/requirements/{draft['id']}/status", {"version": draft["version"], "status": "approved"})
    assert ok.status_code == 200, ok.text
    await flow.idle()
    st = await flow.stage("requirements")
    if st["gate"]["status"] != "approved":
        body = {"decision": "approve", "comment": "QA", "stage_run_version": st["current_version"]}
        g3 = await flow.post(f"/projects/{flow.pid}/gates/G3/decision", body)
        assert g3.status_code == 200, g3.text
    await flow.idle()
    ac = await flow.post(
        f"/requirements/{draft['id']}/acceptance-criteria",
        {"kind": "negative", "given": "the form", "when": "the field is empty", "then": "submission is blocked"},
    )
    assert ac.status_code == 201, ac.text
    after = (await flow.get(f"/requirements/{draft['id']}")).json()
    assert after["status"] == "draft"
    assert (await flow.stage("requirements"))["gate"]["status"] != "approved"


async def test_change_review_items_always_have_a_default_action(flow: Flow) -> None:  # noqa: F811
    """BUG-P2-03: GET …/review?include_unchanged=true returns unchanged items with default_action=null (contract:
    non-null). The web client posts those nulls back and apply answers 422, so Apply never works from the UI."""
    await flow.idle()
    st = await flow.stage("requirements")
    if st["pending_review"] is None:
        r = await flow.post(f"/projects/{flow.pid}/stages/requirements/run", {})
        assert r.status_code == 202, r.text
        await flow.idle()
        st = await flow.stage("requirements")
    version = st["pending_review"]["version"]
    review = (
        await flow.get(f"/projects/{flow.pid}/stages/requirements/runs/{version}/review?include_unchanged=true")
    ).json()
    assert review["items"], "the review should list the unchanged items when asked"
    assert all(i["default_action"] in ("accept", "keep", "skip", "mark_rejected") for i in review["items"])
    # What the web client sends: every listed item with its default action.
    decisions = {i["lineage_id"]: i["default_action"] for i in review["items"]}
    ap = await flow.post(
        f"/projects/{flow.pid}/stages/requirements/runs/{version}/review/apply", {"decisions": decisions}
    )
    assert ap.status_code == 200, ap.text


async def test_second_document_upload_succeeds(flow: Flow) -> None:  # noqa: F811
    """BUG-P2-01: every upload after the first one in a project fails with 500 (FOREIGN KEY constraint failed on
    source_documents.file_evidence_id: the evidence row isn't flushed before the document row once the DOC counter
    exists)."""
    first = await _upload(flow, MD, "spec.md")
    assert first.status_code == 202, first.text
    second = await _upload(flow, MD2, "loyalty.md")
    assert second.status_code == 202, second.text
    await flow.idle()
