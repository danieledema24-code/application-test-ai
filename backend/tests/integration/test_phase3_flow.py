"""Phase 3 end to end against the local fixture site with AI off (P3-00 … P3-08): discovery → G3 → G4 → automatic
test design → review and edits → G5 → traceability → reports, plus test data, risk-based priority, the assistant v2
intents, roles and tenant isolation. Tests run in file order and share one project."""

from __future__ import annotations

import csv
import io
import json
import re
import shutil
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.context import AppContext, build_context
from app.db.models import Membership, User
from app.domain.enums import Role
from app.llm.base import DisabledLLM
from app.security.passwords import hash_password
from tests.conftest import Account, client_for, make_settings, register, worker_for
from tests.fixtures.site import PREFILLED_SECRET, running_site

API = "/api/v1"


@dataclass
class Flow:
    ctx: AppContext
    client: httpx.AsyncClient
    owner: Account
    member: dict[str, str]
    approver: dict[str, str]
    viewer: dict[str, str]
    other: Account
    pid: str
    state: dict[str, Any] = field(default_factory=dict)

    async def idle(self) -> None:
        await worker_for(self.ctx).run_until_idle(timeout=240)

    async def get(self, path: str, h: dict[str, str] | None = None) -> httpx.Response:
        return await self.client.get(f"{API}{path}", headers=h or self.owner.headers)

    async def post(self, path: str, body: Any, h: dict[str, str] | None = None) -> httpx.Response:
        return await self.client.post(f"{API}{path}", json=body, headers=h or self.owner.headers)

    async def patch(self, path: str, body: Any, h: dict[str, str] | None = None) -> httpx.Response:
        return await self.client.patch(f"{API}{path}", json=body, headers=h or self.owner.headers)

    async def stage(self, key: str) -> dict[str, Any]:
        wf = (await self.get(f"/projects/{self.pid}/workflow")).json()
        return next(s for s in wf["stages"] if s["key"] == key)

    async def cases(self, **params: Any) -> list[dict[str, Any]]:
        q = "&".join(f"{k}={v}" for k, v in {"limit": 50, **params}.items())
        out: list[dict[str, Any]] = []
        cursor = None
        while True:
            page = (
                await self.get(f"/projects/{self.pid}/test-cases?{q}" + (f"&cursor={cursor}" if cursor else ""))
            ).json()
            out += page["items"]
            cursor = page["next_cursor"]
            if not cursor:
                return out

    async def events(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        after = 0
        while True:
            page = (await self.get(f"/projects/{self.pid}/events?after={after}&limit=100")).json()
            out += page["items"]
            if len(page["items"]) < 100:
                return out
            after = page["next_after"]

    async def case(self, key: str) -> dict[str, Any]:
        r = await self.get(f"/projects/{self.pid}/test-cases/by-key/{key}")
        assert r.status_code == 200, r.text
        return dict(r.json())

    async def gate(self, gate: str, h: dict[str, str] | None = None, comment: str = "OK") -> httpx.Response:
        stage = {"G3": "requirements", "G4": "test_strategy", "G5": "test_design"}[gate]
        st = await self.stage(stage)
        body = {"decision": "approve", "comment": comment, "stage_run_version": st["current_version"]}
        return await self.post(f"/projects/{self.pid}/gates/{gate}/decision", body, h)


async def _user(
    ctx: AppContext, client: httpx.AsyncClient, org_id: uuid.UUID, email: str, role: Role, can_approve: bool = False
) -> dict[str, str]:
    async with ctx.session_factory() as s:
        u = User(email=email, full_name="Team Mate", password_hash=hash_password("team-password-1"))
        s.add(u)
        await s.flush()
        s.add(Membership(organisation_id=org_id, user_id=u.id, role=role, can_approve=can_approve))
        await s.commit()
    login = await client.post(f"{API}/auth/login", json={"email": email, "password": "team-password-1"})
    return {"Authorization": f"Bearer {login.json()['token']}"}


@pytest.fixture(scope="module")
async def flow(tmp_path_factory: pytest.TempPathFactory, template_db: Path) -> AsyncIterator[Flow]:
    tmp = tmp_path_factory.mktemp("p3flow")
    shutil.copy(template_db, tmp / "qa.db")
    ctx = build_context(make_settings(tmp, allow_private_targets=True), llm=DisabledLLM())
    with running_site() as (base_url, _site):
        async with client_for(ctx) as client:
            owner = await register(client, "owner@p3.example.com", org="P3 Org")
            other = await register(client, "other@p3.example.com", org="Other Org")
            member = await _user(ctx, client, owner.org_id, "member@p3.example.com", Role.member)
            approver = await _user(ctx, client, owner.org_id, "approver@p3.example.com", Role.member, True)
            viewer = await _user(ctx, client, owner.org_id, "viewer@p3.example.com", Role.viewer)
            r = await client.post(
                f"{API}/projects",
                headers=owner.headers,
                json={
                    "url": base_url,
                    "name": "Fixture shop",
                    "start": True,
                    "authorisation": {"attested": True, "statement": "Local fixture site owned by the test suite."},
                    "scan": {"max_pages": 30, "max_depth": 3},
                },
            )
            assert r.status_code == 201, r.text
            f = Flow(ctx, client, owner, member, approver, viewer, other, r.json()["id"])
            await f.idle()
            yield f
    await ctx.close()


async def test_g3_and_g4_then_design_runs_automatically(flow: Flow) -> None:
    # Before G4: test design isn't available, traceability is derived and can't be run.
    st = await flow.stage("test_design")
    assert st["status"] in ("not_started", "blocked"), st
    tr = await flow.post(f"/projects/{flow.pid}/stages/traceability/run", {})
    assert tr.status_code == 422 and "computed automatically" in tr.json()["error"]["message"]
    empty = (await flow.get(f"/projects/{flow.pid}/test-cases")).json()
    assert empty == {"items": [], "next_cursor": None}
    blocked = await flow.post(f"/projects/{flow.pid}/reports", {"report_type": "test_case_spec"})
    assert blocked.status_code == 409 and blocked.json()["error"]["message"] == "Design test cases first"
    # Approve every requirement that has an approved basis, then G3 and G4.
    reqs = (await flow.get(f"/projects/{flow.pid}/requirements?limit=100")).json()["items"]
    drafts = [r for r in reqs if r["status"] == "draft" and r["classification"] in ("observed", "inferred")]
    res = await flow.post(f"/projects/{flow.pid}/requirements/bulk-status",
                          {"ids": [r["id"] for r in drafts], "status": "approved"})  # fmt: skip
    assert res.status_code == 200, res.text
    assert (await flow.gate("G3")).status_code == 200
    await flow.idle()
    g4 = await flow.gate("G4")
    assert g4.status_code == 200, g4.text
    await flow.idle()
    st = await flow.stage("test_design")
    assert st["status"] == "awaiting_approval" and st["current_version"] == 1, st
    assert st["approved_input"]["stage_key"] == "test_strategy"
    assert st["gate"]["key"] == "G5"
    trace_stage = await flow.stage("traceability")
    assert trace_stage["status"] in ("completed", "awaiting_approval", "approved", "not_started"), trace_stage
    stats = (await flow.get(f"/projects/{flow.pid}/test-cases/stats")).json()
    assert stats["total"] > 5 and stats["generated_by"] == "rules", stats
    assert stats["by_status"]["draft"] == stats["total"]
    flow.state["stats"] = stats


def _dump(x: Any) -> str:
    return json.dumps(x, default=str)


async def test_design_values_are_computed_and_labelled(flow: Flow) -> None:
    cases = await flow.cases()
    flow.state["cases"] = {c["key"]: c for c in cases}
    assert all(c["execution_status"] == "not_run" and c["last_result"] is None for c in cases)
    assert {c["technique"] for c in cases} >= {
        "equivalence_partitioning", "boundary_value_analysis", "decision_table", "state_transition", "use_case",
        "error_guessing", "checklist",
    }  # fmt: skip
    nfr = [c for c in cases if c["test_type"] in ("accessibility", "compatibility", "usability")]
    assert nfr and all(c["technique"] == "checklist" for c in nfr if c["technique"] not in ("use_case",))
    data = (await flow.get(f"/projects/{flow.pid}/test-data?limit=50")).json()["items"]
    by_label = {(d["field_label"], d["length"]) for d in data if d["kind"] == "boundary"}
    assert {("Name", 0), ("Name", 1), ("Name", 80), ("Name", 81)} <= by_label  # maxlength=80 -> on/off
    assert {("Message", 9), ("Message", 10)} <= by_label  # minlength=10
    for d in data:
        if d["kind"] == "boundary" and d["value"] is not None and d["length"] is not None:
            assert len(d["value"]) == d["length"]  # the value has exactly the length it tests
        if d["value"] and "@" in d["value"]:
            assert d["value"].endswith(("@example.com", "@")) or "@" not in d["value"].split("@")[-1]
        assert d["synthetic"] is True
    creds = [d for d in data if d["kind"] == "secret_ref"]
    assert creds and all(d["value"] is None and d["secret_ref"] for d in creds)
    flow.state["data"] = {d["key"]: d for d in data}
    stats = flow.state["stats"]
    assert any(n["test_type"] == "security" and "approval" in n["reason"] for n in stats["not_designed"])
    assert stats["execution"]["available"] is False
    # The prefilled password on the fixture's sign-in form never reaches the design.
    conds = (await flow.get(f"/projects/{flow.pid}/test-conditions?limit=50")).json()["items"]
    assert PREFILLED_SECRET not in _dump([cases, data, conds])
    flow.state["conds"] = {c["key"]: c for c in conds}


async def test_case_detail_conditions_and_rules(flow: Flow) -> None:
    key = next(k for k, c in flow.state["cases"].items() if c["technique"] == "boundary_value_analysis")
    d = await flow.case(key)
    for f in ("objective", "preconditions", "steps", "expected_result", "design_basis", "requirements",
              "test_data", "priority_source", "lint", "automation_suitability", "condition", "execution_note"):  # fmt: skip
        assert f in d, f
    assert d["automation_suitability"]["assessed"] == "preliminary"
    assert d["requirements"] and d["condition"]["key"].startswith("TCOND-")
    assert d["steps"] and all(s["n"] == i + 1 for i, s in enumerate(d["steps"]))
    assert (await flow.get(f"/test-cases/{d['id']}")).json()["key"] == key
    cond = (await flow.get(f"/test-conditions/{d['condition']['id']}")).json()
    assert any(key in i["covered_by"] for i in cond["coverage_items"])
    assert any(c["key"] == key for c in cond["cases"])
    # Fields the web reads (BUG-P3-08).
    summary = next(c for c in await flow.cases() if c["key"] == key)
    assert summary["condition_key"] == cond["key"] and summary["objective"] == d["objective"]
    assert summary["classification"] == summary["provenance"] and summary["changed_in_latest"] is False  # v1
    assert "risk_key" in summary and "feature" in summary and "open_question" in summary
    assert "overridden_at" in d["priority_source"]
    basis = cond["design_basis"]
    assert basis["constraint"] and isinstance(basis["evidence_refs"], list)
    row = next(v for v in basis["values"] if key in v["case_keys"])
    assert row["coverage_item"] == d["design_basis"]["coverage_item"] and row["expected"] == d["expected_result"]
    assert row["length"] is not None and len(row["value"] or "") == row["length"]
    # Search covers step text and expected results too.
    step_word = d["steps"][0]["action"].split()[-1]
    assert key in {c["key"] for c in await flow.cases(q=step_word)}
    assert key in {c["key"] for c in await flow.cases(q=d["expected_result"][:20].replace(" ", "%20"))}
    data = (await flow.get(f"/test-data/{d['test_data'][0]['id']}")).json()
    assert data["form"]["label"].endswith(" form") and data["form"]["path"] not in data["form"]["label"]
    assert "form:" not in data["form"]["label"]
    assert all(u["status"] in ("draft", "approved", "rejected", "deprecated") for u in data["used_by"])
    assert data["used_by_approved"] == []
    # Derived fields can't be sent; no DELETE; unknown fields 422.
    for bad in ({"risk_level": "low"}, {"derived_priority": "low"}, {"risk_score": 1}, {"lint": []}):
        r = await flow.patch(f"/test-cases/{d['id']}", {"version": d["version"], **bad})
        assert r.status_code == 422, bad
    rm = await flow.client.delete(f"{API}/test-cases/{d['id']}", headers=flow.owner.headers)
    assert rm.status_code == 405
    # Viewers read but can't edit; other organisations see nothing.
    assert (await flow.get(f"/test-cases/{d['id']}", flow.viewer)).status_code == 200
    v = await flow.patch(f"/test-cases/{d['id']}", {"version": d["version"], "title": "Viewer edit"}, flow.viewer)
    assert v.status_code == 403
    for path in (f"/test-cases/{d['id']}", f"/test-conditions/{cond['id']}", f"/projects/{flow.pid}/test-cases",
                 f"/projects/{flow.pid}/test-cases/stats", f"/projects/{flow.pid}/test-data",
                 f"/projects/{flow.pid}/test-conditions", f"/projects/{flow.pid}/test-design/lint",
                 f"/test-cases/{d['id']}/revisions", f"/projects/{flow.pid}/traceability",
                 f"/projects/{flow.pid}/traceability/coverage", f"/projects/{flow.pid}/traceability/gaps",
                 f"/projects/{flow.pid}/traceability/chain?key={key}"):  # fmt: skip
        assert (await flow.get(path, flow.other.headers)).status_code == 404, path
    lint = (await flow.get(f"/projects/{flow.pid}/test-design/lint")).json()
    assert lint["rules_version"] >= 1 and "open_question" in lint["by_code"]


async def test_g5_blocked_by_open_question_and_no_approved_case(flow: Flow) -> None:
    st = await flow.stage("test_design")
    pre = {p["code"]: p for p in st["gate"]["preconditions"]}
    assert not pre["approved_case"]["met"] and pre["approved_case"]["blocking"]
    assert not pre["open_questions"]["met"] and pre["open_questions"]["blocking"]  # even on drafts
    r = await flow.gate("G5")
    assert r.status_code == 409 and r.json()["error"]["code"] == "gate_blocked"
    oq = [c for c in flow.state["cases"].values() if c["expected_result_status"] == "open_question"]
    assert len(oq) == 1
    d = await flow.case(oq[0]["key"])
    assert d["open_question"]["requirement"]["key"].startswith("REQ-")
    # The UI adds the "Not decided:" prefix; the text itself doesn't repeat it.
    key = d["open_question"]["requirement"]["key"]
    assert re.fullmatch(rf"{key} asks whether \w+ is optional", d["expected_result"]), d["expected_result"]
    ap = await flow.post(f"/test-cases/{d['id']}/status", {"version": d["version"], "status": "approved"})
    assert ap.status_code == 422
    assert (
        ap.json()["error"]["message"]
        == f"Write an expected result or resolve {d['open_question']['requirement']['key']} first"
    )
    flow.state["oq"] = d


async def test_writing_the_expected_result_resolves_the_question(flow: Flow) -> None:
    d = flow.state["oq"]
    r = await flow.patch(f"/test-cases/{d['id']}", {"version": d["version"],
                         "expected_result": "The form is sent without a phone number and a confirmation is shown",
                         "change_reason": "Phone is optional (PO)"}, flow.member)  # fmt: skip
    assert r.status_code == 200, r.text
    e = r.json()
    assert e["expected_result_status"] == "defined" and e["open_question"] is None
    assert e["classification"] == "assumed" and e["human_edited"] and e["version"] == d["version"] + 1
    revs = (await flow.get(f"/test-cases/{d['id']}/revisions")).json()
    assert revs[-1]["change_reason"] == "Phone is optional (PO)" and "expected_result" in revs[-1]["changes"]
    stale = await flow.patch(f"/test-cases/{d['id']}", {"version": d["version"], "title": "Stale edit here"})
    assert stale.status_code == 409
    ok = await flow.post(f"/test-cases/{d['id']}/status", {"version": e["version"], "status": "approved"}, flow.member)
    assert ok.status_code == 200 and ok.json()["status"] == "approved", ok.text


async def test_reject_needs_reason_and_records_decision(flow: Flow) -> None:
    c = next(c for c in flow.state["cases"].values() if c["technique"] == "error_guessing"
             and "twice" in c["title"])  # fmt: skip
    d = await flow.case(c["key"])
    no = await flow.post(f"/test-cases/{d['id']}/status", {"version": d["version"], "status": "rejected"})
    assert no.status_code == 422
    dep = await flow.post(f"/test-cases/{d['id']}/status", {"version": d["version"], "status": "deprecated",
                                                            "comment": "x"})  # fmt: skip
    assert dep.status_code == 422  # only approved cases can be deprecated
    ok = await flow.post(f"/test-cases/{d['id']}/status",
                         {"version": d["version"], "status": "rejected", "reason": "not_applicable",
                          "comment": "The button disables itself"})  # fmt: skip
    assert ok.status_code == 200 and ok.json()["status"] == "rejected"
    flow.state["rejected_case"] = ok.json()


async def test_priority_override_needs_reason_and_warns_below_risk(flow: Flow) -> None:
    high = [c for c in await flow.cases() if c["risk_level"] in ("high", "very_high") and c["status"] == "draft"]
    assert high, "sign-in cases carry the sign-in risk"
    d = await flow.case(high[0]["key"])
    assert d["priority_source"]["kind"] == "risk" and d["priority_source"]["risk"]["key"].startswith("RISK-")
    no = await flow.patch(f"/test-cases/{d['id']}", {"version": d["version"], "priority_override": "low"})
    assert no.status_code == 422
    ok = await flow.patch(f"/test-cases/{d['id']}", {"version": d["version"], "priority_override": "low",
                          "priority_override_reason": "Covered by the e2e journey"})  # fmt: skip
    assert ok.status_code == 200, ok.text
    e = ok.json()
    assert e["priority"] == "low" and e["derived_priority"] in ("high", "critical")
    assert any(i["code"] == "priority_below_risk" for i in e["lint"])
    assert e["priority_source"]["kind"] == "override"
    assert e["priority_source"]["override_reason"] == "Covered by the e2e journey"
    assert e["priority_source"]["overridden_at"] and e["priority_source"]["overridden_by"]
    assert d["priority_source"]["overridden_at"] is None
    revs = (await flow.get(f"/test-cases/{d['id']}/revisions")).json()
    assert revs[-1]["changes"]["priority_override_reason"]["to"] == "Covered by the e2e journey"
    flow.state["overridden"] = e


async def test_test_data_guard_and_lifecycle(flow: Flow) -> None:
    form = {"field_type": "email", "path": "/contact"}
    body = {"name": "Real email", "field_label": "Email", "kind": "invalid", "form_ref": form}
    real = await flow.post(f"/projects/{flow.pid}/test-data", {**body, "value": "real.person@gmail.com"})
    assert real.status_code == 422
    assert (
        real.json()["error"]["message"] == "Use a reserved domain such as example.com; real-looking data isn't allowed"
    )
    card = await flow.post(f"/projects/{flow.pid}/test-data", {**body, "name": "Test card", "field_label": "Card",
                           "form_ref": {}, "value": "4111 1111 1111 1111"})  # fmt: skip
    assert card.status_code == 201, card.text
    luhn = await flow.post(f"/projects/{flow.pid}/test-data", {**body, "name": "Card", "field_label": "Card",
                           "form_ref": {}, "value": "4012 8888 8888 1882"[:-1] + "7"})  # fmt: skip
    assert luhn.status_code in (201, 422)
    pw = await flow.post(f"/projects/{flow.pid}/test-data", {"name": "Pw", "field_label": "Password",
                         "kind": "invalid", "form_ref": {"field_type": "password"}, "value": "hunter2hunter2"})  # fmt: skip
    assert pw.status_code == 422 and pw.json()["error"]["message"] == "Passwords must reference saved test credentials"
    unknown = await flow.post(f"/projects/{flow.pid}/test-data", {"name": "Pw", "field_label": "Password",
                              "kind": "secret_ref", "secret_ref": "nope"})  # fmt: skip
    assert unknown.status_code == 422 and "No saved test credentials are called 'nope'" in unknown.text
    assert (await flow.post(f"/projects/{flow.pid}/test-data", {**body, "value": "a@example.com"},
                            flow.viewer)).status_code == 403  # fmt: skip
    # Boundary items keep the length they test.
    b81 = next(d for d in flow.state["data"].values() if d["field_label"] == "Name" and d["length"] == 81)
    lock = await flow.patch(f"/test-data/{b81['id']}", {"version": b81["version"], "value": "x" * 79})
    assert lock.status_code == 422
    assert lock.json()["error"]["message"] == "This item tests the 81-character boundary; change the case instead"
    same = await flow.patch(f"/test-data/{b81['id']}", {"version": b81["version"], "value": "y" * 81})
    assert same.status_code == 200 and same.json()["affected_cases"], same.text
    # Retiring an item a draft case uses is refused, with the case keys.
    used = await flow.get(f"/test-data/{b81['id']}")
    users = [c["key"] for c in used.json()["used_by"]]
    retire = await flow.post(f"/test-data/{b81['id']}/status", {"version": used.json()["version"], "status": "retired"})
    assert retire.status_code == 409 and all(k in retire.text for k in users)
    assert set(retire.json()["error"]["details"]["used_by"]) == set(users), retire.text
    # Unused items can be retired.
    c = card.json()
    ok = await flow.post(f"/test-data/{c['id']}/status", {"version": c["version"], "status": "retired"})
    assert ok.status_code == 200 and ok.json()["status"] == "retired"
    assert (await flow.get(f"/test-data/{c['id']}", flow.other.headers)).status_code == 404


async def test_bulk_approve_and_condition_reject_cascade(flow: Flow) -> None:
    # Reject the phone boundary condition: its draft cases are rejected with it.
    cond = next(c for c in flow.state["conds"].values() if c["title"].startswith("Phone length"))
    no = await flow.post(f"/test-conditions/{cond['id']}/status", {"version": cond["version"], "status": "rejected"})
    assert no.status_code == 422
    r = await flow.post(f"/test-conditions/{cond['id']}/status",
                        {"version": cond["version"], "status": "rejected", "comment": "Phone is free text"})  # fmt: skip
    assert r.status_code == 200 and r.json()["rejected_cases"], r.text
    drafts = await flow.cases(status="draft")
    res = await flow.post(f"/projects/{flow.pid}/test-cases/bulk-status",
                          {"ids": [c["id"] for c in drafts], "status": "approved"}, flow.member)  # fmt: skip
    assert res.status_code == 200, res.text
    out = res.json()
    assert len(out["updated"]) + len(out["skipped"]) == len(drafts) and out["updated"]
    stats = (await flow.get(f"/projects/{flow.pid}/test-cases/stats")).json()
    assert stats["open_questions"] == 0 and stats["by_status"]["approved"] >= len(out["updated"])


async def test_g5_needs_can_approve_and_freezes_reports(flow: Flow) -> None:
    st = await flow.stage("test_design")
    pre = {p["code"]: p for p in st["gate"]["preconditions"]}
    assert pre["approved_case"]["met"] and pre["open_questions"]["met"], pre
    assert (await flow.gate("G5", flow.member)).status_code == 403  # member without can_approve
    r = await flow.gate("G5", flow.approver, comment="Design reviewed")
    assert r.status_code == 200, r.text
    assert r.json()["gate"]["decision"]["artefact_snapshot"]["items"] >= 1
    await flow.idle()
    reports = (await flow.get(f"/projects/{flow.pid}/reports")).json()
    p3 = {x["report_type"]: x for x in reports if x["report_type"] in ("test_case_spec", "rtm")}
    assert set(p3) == {"test_case_spec", "rtm"}
    for x in p3.values():
        assert x["status"] == "ready" and x["frozen"], x
        assert x["formats"] == ["json", "html", "pdf", "csv"]
        assert x["approval"]["gate"] == "G5" and x["approval"]["status"] == "approved"
    flow.state["reports"] = p3
    items = await flow.events()
    assert any(e["type"] == "test_design.generated" for e in items)


async def test_traceability_matrix_coverage_gaps_and_chain(flow: Flow) -> None:
    cov = (await flow.get(f"/projects/{flow.pid}/traceability/coverage")).json()
    assert cov["basis"] == "current" and cov["execution"]["available"] is False
    assert 0 < cov["requirements"]["with_approved_case"] <= cov["requirements"]["approved"]
    gaps = (await flow.get(f"/projects/{flow.pid}/traceability/gaps")).json()
    for k in ("requirements_without_execution_evidence", "failed_tests", "outdated_automation_scripts",
              "defects_without_regression_coverage"):  # fmt: skip
        assert gaps[k]["available"] is False and gaps[k]["available_from_phase"] == 4
    approved_reqs = cov["requirements"]["approved"]
    none = len(gaps["requirements_without_test_cases"]["none"])
    assert cov["requirements"]["with_case"] == approved_reqs - none
    fwd = (await flow.get(f"/projects/{flow.pid}/traceability?view=forward")).json()
    assert fwd["items"] and all(r["automation"]["available"] is False for r in fwd["items"])
    bwd = (await flow.get(f"/projects/{flow.pid}/traceability?view=backward&limit=5")).json()
    assert len(bwd["items"]) == 5 and bwd["next_cursor"]
    row = next(r for r in fwd["items"] if r["test_cases"])
    chain = (await flow.get(f"/projects/{flow.pid}/traceability/chain?key={row['requirement']['key']}")).json()
    tcs = next(g for g in chain["downstream"] if g["type"] == "test_case")["items"]
    assert {c["key"] for c in tcs} == {c["case"]["key"] for c in row["test_cases"]}
    case_key = row["test_cases"][0]["case"]["key"]
    back = (await flow.get(f"/projects/{flow.pid}/traceability/chain?key={case_key}")).json()
    reqs = next(g for g in back["upstream"] if g["type"] == "requirement")["items"]
    assert row["requirement"]["key"] in {r["key"] for r in reqs}
    assert {x["type"] for x in back["later_phase"]} == {"automation_script", "execution_result", "defect"}
    assert (await flow.get(f"/projects/{flow.pid}/traceability/chain?key=TC-9999")).status_code == 404
    approved = (await flow.get(f"/projects/{flow.pid}/traceability/coverage?basis=approved")).json()
    assert approved["basis"] == "approved" and approved["snapshot_hash"] and approved["approved_at"]
    assert cov["approved_at"] == approved["approved_at"]  # the current view says a snapshot exists too
    uncovered = (await flow.get(f"/projects/{flow.pid}/traceability?uncovered=true")).json()["items"]
    assert all(not any(c["status"] == "approved" for c in r["test_cases"]) for r in uncovered)


async def test_readiness_uses_test_data_and_coverage(flow: Flow) -> None:
    rc = (await flow.get(f"/projects/{flow.pid}/readiness-criteria")).json()
    items = [*rc["definition_of_ready"], *rc["definition_of_done"]]
    by_rule = {(i["check"] or {}).get("rule_id"): i for i in items}
    cov = by_rule["dod.ac_covered"]["evaluation"]
    assert cov["status"] in ("met", "not_met") and "Phase 3" not in cov["detail"], cov
    trace = by_rule["dod.traceability_updated"]["evaluation"]
    assert trace["status"] in ("met", "not_met") and "Phase 3" not in trace["detail"], trace
    data = by_rule["dor.test_data_identified"]["evaluation"]
    assert data["status"] in ("met", "not_met"), data
    assert "Name" in data["detail"] or "Email" in data["detail"], data


async def _download(flow: Flow, report_id: str, fmt: str) -> bytes:
    r = await flow.get(f"/reports/{report_id}/download?format={fmt}")
    assert r.status_code == 302, r.text
    loc = r.headers["location"]
    got = await flow.client.get(loc)
    assert got.status_code == 200, got.text
    return got.content


async def test_reports_counts_csv_and_no_credentials(flow: Flow) -> None:
    # A spreadsheet formula in a title is neutralised in CSV and escaped in HTML.
    c = (await flow.cases(status="approved"))[-1]
    d = await flow.case(c["key"])
    title = '=HYPERLINK("http://x.example.com")'
    r = await flow.patch(f"/test-cases/{d['id']}", {"version": d["version"], "title": title})
    assert r.status_code == 200, r.text
    gen = await flow.post(f"/projects/{flow.pid}/reports", {"report_type": "test_case_spec"})
    assert gen.status_code == 202, gen.text
    await flow.idle()
    rep = (await flow.get(f"/reports/{gen.json()['id']}")).json()
    assert rep["status"] == "ready" and rep["approval"]["status"] == "draft"  # not the G5-approved set any more
    stats = (await flow.get(f"/projects/{flow.pid}/test-cases/stats")).json()
    assert rep["content"]["counts"]["total"] == stats["total"]
    assert rep["content"]["counts"]["by_status"] == stats["by_status"]
    assert rep["content"]["execution_note"] == "Execution status: Not run. Execution arrives in Phase 4."
    raw = await _download(flow, rep["id"], "csv")
    assert raw.startswith("\ufeff".encode())
    rows = list(csv.reader(io.StringIO(raw.decode("utf-8-sig"))))
    keys = [row[0] for row in rows[1:]]
    assert len(keys) == len(set(keys))  # one row per case, even when it covers several requirements
    cell = next(row[1] for row in rows[1:] if row[0] == d["key"])
    assert cell == "'" + title
    html = (await _download(flow, rep["id"], "html")).decode()
    assert (title not in html and "=HYPERLINK(&#34;" in html) or "=HYPERLINK(&quot;" in html
    rtm = flow.state["reports"]["rtm"]
    rtm_csv = (await _download(flow, rtm["id"], "csv")).decode("utf-8-sig")
    assert "Not available until Phase 4" in rtm_csv
    other = await flow.get(f"/reports/{rtm['id']}/download?format=csv", flow.other.headers)
    assert other.status_code == 404
    spec = next(x for x in (await flow.get(f"/projects/{flow.pid}/reports")).json()
                if x["report_type"] == "requirements_spec")  # fmt: skip
    bad = await flow.get(f"/reports/{spec['id']}/download?format=csv")
    assert bad.status_code == 422
    for x in (rep["id"], rtm["id"]):
        for fmt in ("json", "html", "csv"):
            assert PREFILLED_SECRET.encode() not in await _download(flow, x, fmt)


async def test_editing_an_approved_case_reopens_g5(flow: Flow) -> None:
    approved = await flow.cases(status="approved")
    d = await flow.case(approved[0]["key"])
    r = await flow.patch(f"/test-cases/{d['id']}", {"version": d["version"], "objective": "Sharper objective."})
    assert r.status_code == 200 and r.json()["status"] == "draft"
    st = await flow.stage("test_design")
    assert st["gate"]["status"] != "approved" and st["status"] == "awaiting_approval", st
    items = await flow.events()
    assert any(e["type"] == "gate.reopened" and "G5" in _dump(e) for e in items)
    back = await flow.post(f"/test-cases/{d['id']}/status", {"version": r.json()["version"], "status": "approved"})
    assert back.status_code == 200
    assert (await flow.gate("G5", flow.approver)).status_code == 200
    await flow.idle()


async def _thread(flow: Flow, h: dict[str, str] | None = None) -> str:
    r = await flow.post(f"/projects/{flow.pid}/assistant/threads", {}, h)
    assert r.status_code == 201, r.text
    return str(r.json()["id"])


async def _ask(flow: Flow, tid: str, body: dict[str, Any], h: dict[str, str] | None = None) -> dict[str, Any]:
    r = await flow.post(f"/assistant/threads/{tid}/messages", body, h)
    assert r.status_code in (200, 201), r.text
    return dict(r.json()["reply"])


async def test_assistant_v2_intents_ai_off(flow: Flow) -> None:
    caps = (await flow.get(f"/projects/{flow.pid}/assistant/capabilities")).json()
    by = {i["intent"]: i for i in caps["intents"]}
    assert by["propose_negative_cases"]["available"] and by["propose_regression_suite"]["available"]
    assert not by["propose_test_case_update"]["available"]
    for intent, label in (("propose_test_case_update", "Update test cases"),
                          ("propose_missing_test_cases", "Suggest missing test cases")):  # fmt: skip
        assert by[intent]["needs_ai"] and not by[intent]["available"] and by[intent]["label"] == label
    assert not by["propose_negative_cases"]["needs_ai"]
    assert not any("negative test cases" in t["label"].lower() for t in caps["later_phase_tasks"])
    tid = await _thread(flow)
    cov = await _ask(flow, tid, {"content": "Review test coverage"})
    assert cov["intent"] == "coverage_summary", cov
    numbers = (await flow.get(f"/projects/{flow.pid}/traceability/coverage")).json()
    rq = numbers["requirements"]
    assert f"{rq['with_approved_case']} of {rq['approved']} approved requirements" in cov["content"]
    assert "Execution coverage is available from Phase 4" in cov["content"]
    tokens = set(re.findall(r"\b(?:REQ|AC|RISK|TC|TCOND|TD|FEAT)-\d+\b", cov["content"]))
    assert tokens <= {c["key"] for c in cov["citations"]}
    key = (await flow.cases(status="approved"))[0]["key"]
    ex = await _ask(flow, tid, {"content": f"Explain {key}"})
    assert ex["intent"] == "explain_test_case" and key in {c["key"] for c in ex["citations"]}
    tr = await _ask(flow, tid, {"intent": "traceability_for", "params": {"key": key}})
    assert "Phase 4" in tr["content"] and key in {c["key"] for c in tr["citations"]}
    ls = await _ask(flow, tid, {"intent": "list_test_cases", "params": {"status": "approved"}})
    assert ls["citations"] and all(c["type"] == "test_case" for c in ls["citations"])
    g5 = await _ask(flow, tid, {"intent": "explain_gate", "params": {"gate": "G5"}})
    assert "G5 preconditions" in g5["content"]


async def _req_key(flow: Flow, rule: str, anchor_part: str) -> str:
    from sqlalchemy import select

    from app.db.models import Requirement

    async with flow.ctx.session_factory() as s:
        q = select(Requirement.key, Requirement.match_key).where(
            Requirement.project_id == uuid.UUID(flow.pid), Requirement.rule_id == rule
        )
        rows = (await s.execute(q.execution_options(tenant_bypass=True))).all()
    return str(next(k for k, mk in rows if anchor_part in mk))


async def _proposal_row(flow: Flow, pid: str) -> Any:
    from sqlalchemy import select

    from app.db.models import AssistantProposal

    async with flow.ctx.session_factory() as s:
        q = (
            select(AssistantProposal)
            .where(AssistantProposal.id == uuid.UUID(pid))
            .execution_options(tenant_bypass=True)
        )
        return (await s.execute(q)).scalar_one()


async def test_assistant_negative_cases_beyond_the_baseline(flow: Flow) -> None:
    tid = await _thread(flow, flow.member)
    req_key = await _req_key(flow, "form.required_field", ":email")  # the Email field
    neg = await _ask(flow, tid, {"content": f"Generate more negative test cases for {req_key}"}, flow.member)
    assert neg["intent"] == "propose_negative_cases" and neg["proposals"], neg
    prop = neg["proposals"][0]
    existing = {c["title"] for c in await flow.cases()}
    titles = [x["title"] for x in prop["preview"]]
    assert titles and not set(titles) & existing and len(titles) == len(set(titles))  # only what's missing
    assert all(x["classification"] in ("inferred", "assumed") and x["constraint"] for x in prop["preview"])
    assert all("{d0}" not in st["action"] for x in prop["preview"] for st in x["steps"])
    before = len(await flow.cases())
    acc = await flow.post(f"/assistant/proposals/{prop['id']}/accept", {}, flow.member)
    assert acc.status_code == 200, acc.text
    assert acc.json()["status"] == "accepted"
    after = await flow.cases()
    assert len(after) == before + len(titles)
    added = [c for c in after if c["title"] in titles]
    assert all(c["status"] == "draft" and c["source"] == "assistant" for c in added)
    by_title = {x["title"]: x for x in prop["preview"]}
    for c in added:
        d = await flow.case(c["key"])
        assert not [i for i in d["lint"] if i["blocks_approval"]], c["key"]
        # Stored exactly as previewed: step text (values written out), expected results, data values and label.
        shown = by_title[c["title"]]
        assert [(s["action"], s["expected"]) for s in d["steps"]] == [
            (s["action"], s["expected"]) for s in shown["steps"]
        ], c["key"]
        assert not any("{d" in s["action"] for s in d["steps"])
        assert {x["value"] for x in shown["data"]} <= {x["value"] for x in d["test_data"]}
        assert d["classification"] == shown["classification"] and d["generated_by"] == "rules"
        assert d["source"] == "assistant" and not d["human_edited"]
        assert d["design_basis"]["explanation"] == shown["constraint"]
    assert "assistant.proposal_accepted" in await _audit_actions(flow)
    # Asking again: nothing is missing any more, and the answer cites the cases that exist.
    again = await _ask(flow, tid, {"content": f"Generate more negative test cases for {req_key}"}, flow.member)
    assert not again["proposals"] and again["content"].startswith("No further negative test cases"), again
    assert {c["key"] for c in added} <= {c["key"] for c in again["citations"]}


async def test_add_test_cases_accept_is_all_or_nothing(flow: Flow) -> None:
    from sqlalchemy import update

    from app.db.models import AssistantProposal

    tid = await _thread(flow)
    # The contact form as a whole still has catalogue items left (spaces around Name, paste over Name's maxlength, …).
    key = await _req_key(flow, "form.purpose", "contact")
    reply = await _ask(flow, tid, {"content": f"Generate more negative test cases for {key}"})
    assert reply["proposals"] and len(reply["proposals"][0]["preview"]) >= 2, reply
    prop = reply["proposals"][0]
    # Make the second case invalid (a real-looking email address): the first must not be applied either.
    row = await _proposal_row(flow, prop["id"])
    payload = json.loads(json.dumps(row.payload))
    assert payload["cases"][1]["data"], payload["cases"][1]
    payload["cases"][1]["data"][0]["value"] = "real.person@gmail.com"
    async with flow.ctx.session_factory() as s:
        await s.execute(update(AssistantProposal).where(AssistantProposal.id == row.id).values(payload=payload)
                        .execution_options(tenant_bypass=True))  # fmt: skip
        await s.commit()
    before = await _counts(flow)
    bad = await flow.post(f"/assistant/proposals/{prop['id']}/accept", {})
    assert bad.status_code == 422, bad.text
    assert await _counts(flow) == before  # the first case and its data were rolled back too
    assert (await _proposal_row(flow, prop["id"])).status.value == "failed"


async def test_accept_rolls_back_and_stays_pending_on_an_unexpected_error(
    flow: Flow, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api.routers import testdesign as td_api

    tid = await _thread(flow)
    key = await _req_key(flow, "form.purpose", "contact")
    reply = await _ask(flow, tid, {"content": f"Generate more negative test cases for {key}"})
    assert reply["proposals"] and len(reply["proposals"][0]["preview"]) >= 2, reply
    prop = reply["proposals"][0]
    real = td_api.create_case
    calls = 0

    async def flaky(*args: Any, **kwargs: Any) -> Any:
        nonlocal calls
        calls += 1
        if calls == 2:  # after the first case (and its data) is flushed
            raise RuntimeError("disk full")
        return await real(*args, **kwargs)

    monkeypatch.setattr(td_api, "create_case", flaky)
    before = await _counts(flow)
    boom = await flow.post(f"/assistant/proposals/{prop['id']}/accept", {})
    assert boom.status_code == 500 and "disk full" not in boom.text
    assert calls == 2 and await _counts(flow) == before  # nothing applied, no audit row
    assert (await _proposal_row(flow, prop["id"])).status.value == "pending"
    monkeypatch.setattr(td_api, "create_case", real)
    ok = await flow.post(f"/assistant/proposals/{prop['id']}/accept", {})  # still pending, so it can be retried
    assert ok.status_code == 200 and ok.json()["status"] == "accepted", ok.text


async def _counts(flow: Flow) -> tuple[int, int, int]:
    from sqlalchemy import func, select

    from app.db.models import AuditLog, TestCase, TestData

    async with flow.ctx.session_factory() as s:
        out = []
        for model in (TestCase, TestData, AuditLog):
            q = select(func.count()).select_from(model).execution_options(tenant_bypass=True)
            out.append(int((await s.execute(q)).scalar_one()))
        return out[0], out[1], out[2]


async def test_regression_suite_proposal_accepts_atomically(flow: Flow) -> None:
    tid = await _thread(flow, flow.member)
    viewer_tid = await _thread(flow, flow.viewer)
    ro = await _ask(flow, viewer_tid, {"intent": "propose_regression_suite", "params": {"scope": "high_risk"}},
                    flow.viewer)  # fmt: skip
    assert not ro["proposals"]
    approved = {c["key"]: c for c in await flow.cases(status="approved")}
    # Clear the tag from two approved cases so the "all" scope has something to add.
    for key in list(approved)[:2]:
        d = await flow.case(key)
        suites = [x for x in d["suites"] if x != "regression"]
        r = await flow.patch(f"/test-cases/{d['id']}", {"version": d["version"], "suites": suites})
        assert r.status_code == 200 and r.json()["status"] == "approved", r.text
    if (await flow.stage("test_design"))["gate"]["status"] != "approved":
        assert (await flow.gate("G5", flow.approver)).status_code == 200
        await flow.idle()
    reg = await _ask(flow, tid, {"intent": "propose_regression_suite", "params": {"scope": "all"}}, flow.member)
    assert reg["intent"] == "propose_regression_suite" and reg["proposals"], reg
    prop = reg["proposals"][0]
    assert prop["kind"] == "set_suite" and "(every approved case)" in prop["summary"]
    assert all(p["reason"] and p["action"] in ("add", "remove") for p in prop["preview"])
    tagged_after = {p["key"] for p in prop["preview"] if "regression" in p["to"]}
    assert len(tagged_after) >= 2 and tagged_after <= set(approved)
    # A stale target: nothing is applied and the proposal goes stale.
    stale_key = sorted(tagged_after)[0]
    d = await flow.case(stale_key)
    bump = await flow.patch(f"/test-cases/{d['id']}", {"version": d["version"], "priority_override": "high",
                                                       "priority_override_reason": "Checkout matters"})  # fmt: skip
    assert bump.status_code == 200, bump.text
    stale = await flow.post(f"/assistant/proposals/{prop['id']}/accept", {}, flow.member)
    assert stale.status_code == 409, stale.text
    assert (await _proposal_row(flow, prop["id"])).status.value == "stale"
    now = {c["key"]: c for c in await flow.cases()}
    assert not any("regression" in now[k]["suites"] for k in tagged_after)  # nothing was applied
    assert (await flow.gate("G5", flow.approver)).status_code == 200  # the override edit reopened it
    await flow.idle()
    # A fresh proposal is accepted in one transaction, with the audit row, and G5 reopens.
    reg = await _ask(flow, tid, {"intent": "propose_regression_suite", "params": {"scope": "all"}}, flow.member)
    prop = reg["proposals"][0]
    tagged_after = {p["key"] for p in prop["preview"] if "regression" in p["to"]}
    acc = await flow.post(f"/assistant/proposals/{prop['id']}/accept", {}, flow.member)
    assert acc.status_code == 200, acc.text
    assert acc.json()["status"] == "accepted" and {a["key"] for a in acc.json()["result"]["applied"]} >= tagged_after
    after = {c["key"]: c for c in await flow.cases()}
    assert all("regression" in after[k]["suites"] and after[k]["status"] == "approved" for k in tagged_after)
    revs = (await flow.get(f"/test-cases/{after[sorted(tagged_after)[0]]['id']}/revisions")).json()
    assert revs[0]["source"] == "assistant" and prop["key"] in revs[0]["change_reason"]  # newest first
    assert "assistant.proposal_accepted" in await _audit_actions(flow)
    st = await flow.stage("test_design")
    assert st["gate"]["status"] != "approved"  # accepting into approved content reopens G5
    assert any(e["type"] == "gate.reopened" and prop["key"] in _dump(e) for e in await flow.events())
    assert (await flow.gate("G5", flow.approver)).status_code == 200
    await flow.idle()


async def test_regeneration_is_reviewed_and_keeps_human_work(flow: Flow) -> None:
    cur = (await flow.stage("test_design"))["current_version"]
    oq = flow.state["oq"]
    from_assistant = {c["key"]: c["status"] for c in await flow.cases() if c["source"] == "assistant"}
    assert from_assistant
    r = await flow.post(f"/projects/{flow.pid}/stages/test_design/run", {})
    assert r.status_code == 202, r.text
    await flow.idle()
    st = await flow.stage("test_design")
    assert st["current_version"] == cur and st["pending_review"] is not None, st
    v = st["pending_review"]["version"]
    review = (await flow.get(f"/projects/{flow.pid}/stages/test_design/runs/{v}/review")).json()
    assert review["artefact"] == "test_design" and review["candidate_version"] == v
    ap = await flow.post(f"/projects/{flow.pid}/stages/test_design/runs/{v}/review/apply", {"decisions": {}})
    assert ap.status_code == 200, ap.text
    assert ap.json()["current_version"] == v
    runs = {r["version"]: r for r in (await flow.get(f"/projects/{flow.pid}/stages/test_design/runs")).json()}
    assert runs[cur]["status"] == "superseded" and runs[cur]["superseded"], runs[cur]
    assert not runs[v]["superseded"] and runs[v]["status"] != "superseded"
    kept = await flow.case(oq["key"])
    assert kept["expected_result_status"] == "defined" and kept["expected_result"].startswith("The form is sent")
    after_review = {c["key"]: c["status"] for c in await flow.cases() if c["source"] == "assistant"}
    assert after_review == from_assistant  # accepted assistant cases are kept, not rejected as no longer found
    rejected = flow.state["rejected_case"]
    assert (await flow.case(rejected["key"]))["status"] == "rejected"
    old = await flow.patch(f"/test-cases/{oq['id']}", {"version": 99, "title": "Edit of the old run"})
    assert old.status_code == 409


async def test_assistant_proposes_only_missing_negative_cases(flow: Flow) -> None:
    from sqlalchemy import delete, select

    from app.db.models import TestCase, test_case_data, test_case_requirements
    from app.db.tenant import bind_scope, system_scope

    # Simulate a design without the "Email without a domain" case (cases can't be deleted through the API).
    gone = next(c for c in await flow.cases() if c["title"] == "Email without a domain: rejected")
    req_key = (await flow.case(gone["key"]))["requirements"][0]["key"]
    async with flow.ctx.session_factory() as s:
        bind_scope(s, system_scope(flow.owner.org_id))
        cid = uuid.UUID(gone["id"])
        await s.execute(delete(test_case_requirements).where(test_case_requirements.c.test_case_id == cid))
        await s.execute(delete(test_case_data).where(test_case_data.c.test_case_id == cid))
        row = (await s.execute(select(TestCase).where(TestCase.id == cid))).scalar_one()
        await s.delete(row)
        await s.commit()
    tid = await _thread(flow, flow.member)
    reply = await _ask(flow, tid, {"content": f"Generate more negative test cases for {req_key}"}, flow.member)
    assert reply["intent"] == "propose_negative_cases" and reply["proposals"], reply
    prop = reply["proposals"][0]
    titles = [x["title"] for x in prop["preview"]]
    assert "Email without a domain: rejected" in titles  # what's missing comes back
    assert not set(titles) & {c["title"] for c in await flow.cases()}
    email = next(d["value"] for d in prop["preview"][0]["data"] if d["field_label"] == "Email")
    assert email.endswith("@")  # computed by the generator: a missing domain
    before = len(await flow.cases())
    assert (await flow.post(f"/assistant/proposals/{prop['id']}/accept", {}, flow.viewer)).status_code in (403, 404)
    acc = await flow.post(f"/assistant/proposals/{prop['id']}/accept", {}, flow.member)
    assert acc.status_code == 200, acc.text
    after = await flow.cases()
    assert len(after) == before + 1
    new = next(c for c in after if c["title"] == "Email without a domain: rejected")
    assert new["status"] == "draft" and new["source"] == "assistant"
    revs = (await flow.get(f"/test-cases/{new['id']}/revisions")).json()
    assert revs[0]["source"] == "assistant" and prop["key"] in revs[0]["change_reason"]
    audit_actions = await _audit_actions(flow)
    assert "assistant.proposal_accepted" in audit_actions and "test_case.created" in audit_actions


async def _audit_actions(flow: Flow) -> set[str]:
    from sqlalchemy import select

    from app.db.models import AuditLog

    async with flow.ctx.session_factory() as s:
        rows = (await s.execute(select(AuditLog.action).execution_options(tenant_bypass=True))).scalars()
        return set(rows)


async def test_credentials_never_leave_the_vault(flow: Flow) -> None:
    everything = [
        await flow.cases(),
        (await flow.get(f"/projects/{flow.pid}/test-data?limit=50")).json(),
        (await flow.get(f"/projects/{flow.pid}/test-conditions?limit=50")).json(),
        await flow.events(),
        (await flow.get(f"/projects/{flow.pid}/traceability?view=backward&limit=50")).json(),
    ]
    assert PREFILLED_SECRET not in _dump(everything)


async def test_risk_change_recomputes_priority_without_versions_or_reopen(flow: Flow) -> None:
    case = flow.state["overridden"]
    risk_key = case["priority_source"]["risk"]["key"]
    risks = (await flow.get(f"/projects/{flow.pid}/risks")).json()["items"]
    risk = next(r for r in risks if r["key"] == risk_key)
    assert risk["coverage"]["requirements"] >= 1 and risk["coverage"]["test_cases"] >= 1
    others = [c for c in await flow.cases() if c["risk_level"] == risk["level"] and c["id"] != case["id"]]
    before = {c["id"]: c["version"] for c in others}
    g5_before = (await flow.stage("test_design"))["gate"]["status"]
    r = await flow.patch(f"/risks/{risk['id']}", {"version": risk["version"], "likelihood": 5, "impact": 5})
    assert r.status_code == 200 and r.json()["level"] == "very_high", r.text
    after = {c["id"]: c for c in await flow.cases()}
    for cid, version in before.items():
        assert after[cid]["risk_level"] == "very_high" and after[cid]["derived_priority"] == "critical"
        assert after[cid]["version"] == version  # derived: no version bump
        if not after[cid]["priority_overridden"]:
            assert after[cid]["priority"] == "critical"
    revs = (await flow.get(f"/test-cases/{others[0]['id']}/revisions")).json()
    assert all("risk_level" not in (x["changes"] or {}) for x in revs)
    uncovered = (await flow.get(f"/projects/{flow.pid}/risks?uncovered=true")).json()["items"]
    covered = (await flow.get(f"/projects/{flow.pid}/risks?uncovered=false")).json()["items"]
    assert {x["key"] for x in uncovered}.isdisjoint({x["key"] for x in covered})
    gaps = (await flow.get(f"/projects/{flow.pid}/traceability/gaps")).json()
    assert {x["risk"]["key"] for x in gaps["untested_high_risk"]["open"]} <= {x["key"] for x in uncovered}
    cov = (await flow.get(f"/projects/{flow.pid}/traceability/coverage")).json()
    assert cov["high_risk_requirements"]["total"] >= 1
    # The risk change reopens G4 (Phase 2 rule) but not G5.
    assert (await flow.stage("test_design"))["gate"]["status"] == g5_before
