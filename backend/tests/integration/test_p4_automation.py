"""Phase 4 automation against the local fixture site with AI off (P4-02, P4-03a, P4-04, P4-05): G5 approval →
automatic assessment → rule-written bundle → validation (static checks + read-only live locator check) → G6
"Passed automatically", plus a renamed label, a leaked secret, test credentials, roles, tenant isolation, and the
run scope preview with risky-action approvals. The tests share one project but not an order: each sets up what it
needs (G3 → G5 runs once, for whichever test comes first) and puts back what it changes."""

from __future__ import annotations

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
from sqlalchemy import select

from app.context import AppContext, build_context
from app.db.models import AutomationScript, Membership, User
from app.db.tenant import BYPASS
from app.domain.enums import Role
from app.llm.base import DisabledLLM
from app.security.passwords import hash_password
from tests.conftest import Account, client_for, make_settings, register, worker_for
from tests.fixtures.site import FixtureSite, running_site

API = "/api/v1"
pytestmark = pytest.mark.skipif(
    not (Path(__file__).resolve().parents[3] / "automation" / "node_modules" / "@playwright" / "test").is_dir(),
    reason="the automation toolkit's dependencies are not installed",
)


@dataclass
class Flow:
    ctx: AppContext
    client: httpx.AsyncClient
    site: FixtureSite
    owner: Account
    member: dict[str, str]
    approver: dict[str, str]
    viewer: dict[str, str]
    other: Account
    pid: str
    state: dict[str, Any] = field(default_factory=dict)

    async def idle(self) -> None:
        await worker_for(self.ctx).run_until_idle(timeout=300)

    async def get(self, path: str, h: dict[str, str] | None = None) -> httpx.Response:
        return await self.client.get(f"{API}{path}", headers=h or self.owner.headers)

    async def post(self, path: str, body: Any, h: dict[str, str] | None = None) -> httpx.Response:
        return await self.client.post(f"{API}{path}", json=body, headers=h or self.owner.headers)

    async def stage(self, key: str) -> dict[str, Any]:
        wf = (await self.get(f"/projects/{self.pid}/workflow")).json()
        return next(s for s in wf["stages"] if s["key"] == key)

    async def gate(self, gate: str, h: dict[str, str] | None = None) -> httpx.Response:
        stage = {"G3": "requirements", "G4": "test_strategy", "G5": "test_design"}[gate]
        st = await self.stage(stage)
        body = {"decision": "approve", "comment": "OK", "stage_run_version": st["current_version"]}
        return await self.post(f"/projects/{self.pid}/gates/{gate}/decision", body, h)

    async def cases(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        cursor = None
        while True:
            page = (
                await self.get(f"/projects/{self.pid}/test-cases?limit=50" + (f"&cursor={cursor}" if cursor else ""))
            ).json()
            out += page["items"]
            cursor = page["next_cursor"]
            if not cursor:
                return out

    async def automation(self, h: dict[str, str] | None = None) -> dict[str, Any]:
        r = await self.get(f"/projects/{self.pid}/automation", h)
        assert r.status_code == 200, r.text
        return dict(r.json())

    async def events(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        after = 0
        while True:
            page = (await self.get(f"/projects/{self.pid}/events?after={after}&limit=100")).json()
            out += page["items"]
            if len(page["items"]) < 100:
                return out
            after = page["next_after"]


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
    tmp = tmp_path_factory.mktemp("p4flow")
    shutil.copy(template_db, tmp / "qa.db")
    ctx = build_context(make_settings(tmp, allow_private_targets=True), llm=DisabledLLM())
    with running_site() as (base_url, site):
        async with client_for(ctx) as client:
            owner = await register(client, "owner@p4a.example.com", org="P4 Org")
            other = await register(client, "other@p4a.example.com", org="Other Org")
            member = await _user(ctx, client, owner.org_id, "member@p4a.example.com", Role.member)
            approver = await _user(ctx, client, owner.org_id, "approver@p4a.example.com", Role.member, True)
            viewer = await _user(ctx, client, owner.org_id, "viewer@p4a.example.com", Role.viewer)
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
            f = Flow(ctx, client, site, owner, member, approver, viewer, other, r.json()["id"])
            f.state["base"] = base_url
            await f.idle()
            yield f
    await ctx.close()


async def _script(flow: Flow, script_id: str) -> AutomationScript:
    async with flow.ctx.session_factory() as s:
        return (
            await s.execute(
                select(AutomationScript).where(AutomationScript.id == uuid.UUID(script_id)).execution_options(**BYPASS)
            )
        ).scalar_one()


async def _validate(flow: Flow, path: str, h: dict[str, str] | None = None) -> None:
    r = await flow.post(path, {}, h)
    assert r.status_code == 202, r.text
    await flow.idle()


EMPTY_TITLES = ("Message left empty: rejected", "Send the contact form with an empty Message")


async def _ready(flow: Flow) -> dict[str, Any]:
    """G3 → G5 once per module (the first test to need it does the setup); returns a snapshot taken just after G5 so
    the G5 test can check it whatever ran before."""
    if "g5" in flow.state:
        return dict(flow.state["g5"])
    reqs = (await flow.get(f"/projects/{flow.pid}/requirements?limit=100")).json()["items"]
    drafts = [r for r in reqs if r["status"] == "draft" and r["classification"] in ("observed", "inferred")]
    res = await flow.post(f"/projects/{flow.pid}/requirements/bulk-status",
                          {"ids": [r["id"] for r in drafts], "status": "approved"})  # fmt: skip
    assert res.status_code == 200, res.text
    assert (await flow.gate("G3")).status_code == 200
    await flow.idle()
    assert (await flow.gate("G4")).status_code == 200
    await flow.idle()
    before = (await flow.get(f"/projects/{flow.pid}/automation/assessment")).json()
    before_bundle = (await flow.automation())["bundle"]
    for c in await flow.cases():
        if c["expected_result_status"] == "open_question":
            d = (await flow.get(f"/projects/{flow.pid}/test-cases/by-key/{c['key']}")).json()
            r = await flow.client.patch(
                f"{API}/test-cases/{d['id']}",
                headers=flow.owner.headers,
                json={"version": d["version"], "change_reason": "Decided by the PO",
                      "expected_result": "The form is sent without a phone number and a confirmation is shown"},
            )  # fmt: skip
            assert r.status_code == 200, r.text
    cases = await flow.cases()
    res = await flow.post(f"/projects/{flow.pid}/test-cases/bulk-status",
                          {"ids": [c["id"] for c in cases if c["status"] == "draft"], "status": "approved"})  # fmt: skip
    assert res.status_code == 200, res.text
    cases = await flow.cases()
    seen = len(flow.site.requests)
    assert (await flow.gate("G5", flow.approver)).status_code == 200
    await flow.idle()
    flow.state["g5"] = {
        "before": before,
        "before_bundle": before_bundle,
        "cases": cases,
        "during": flow.site.requests[seen:],
        "login_posts": len(flow.site.login_posts),
        "assessment": (await flow.get(f"/projects/{flow.pid}/automation/assessment")).json(),
        "automation": await flow.automation(),
        "stage": await flow.stage("automation_assessment"),
        "events": await flow.events(),
        "after": await flow.cases(),
    }
    return dict(flow.state["g5"])


async def _scripts(flow: Flow) -> dict[str, dict[str, Any]]:
    """The current bundle's scripts by case key."""
    await _ready(flow)
    return {x["case_key"]: x for x in (await flow.automation())["bundle"]["scripts"]}


async def _empty_key(flow: Flow) -> str:
    """The key of the case that leaves Message empty (its script checks the submission is blocked)."""
    return next(k for k, x in (await _scripts(flow)).items() if x["case_title"] in EMPTY_TITLES)


async def test_g5_approval_starts_assessment_and_scripts(flow: Flow) -> None:
    g5 = await _ready(flow)
    # Before G5: Automation explains why nothing is there yet.
    before = g5["before"]
    assert before["g5_approved"] is False and before["run"] is None and before["cases"] == []
    assert g5["before_bundle"] is None
    cases = g5["cases"]
    # The live locator check only loaded pages: no POST, no form submission, no sign-in (no credentials saved).
    during = g5["during"]
    assert during and {m for m, _p in during} == {"GET"}, during
    assert not g5["login_posts"]

    assessment = g5["assessment"]
    counts = assessment["counts"]
    assert counts["total"] == len(cases) and counts["suitable"] > 0, counts
    assert counts["suitable"] + counts["partial"] + counts["manual_only"] == counts["total"]
    assert assessment["credentials_saved"] is False
    for x in assessment["cases"]:
        assert x["reasons"], x
        if x["suitability"] == "partial":
            assert x["reasons"] == ["Needs saved test credentials (Project settings)"], x
        if x["suitability"] == "manual_only":
            assert all("needs human judgement" in r or "open question" in r or "no " in r for r in x["reasons"]), x
    auto = g5["automation"]
    bundle = auto["bundle"]
    assert bundle["version"] == 1 and bundle["generated_by"] == "rules" and bundle["is_current"]
    scripts = bundle["scripts"]
    assert len(scripts) == counts["suitable"] + counts["partial"]
    assert bundle["counts"]["not_automated"] == counts["manual_only"] == len(bundle["not_automated"])
    assert all(x["status"] == "valid" for x in scripts), [(x["case_key"], x["first_problem"]) for x in scripts]
    assert bundle["validation"]["status"] == "done" and bundle["validation"]["toolkit"] is None
    # D10: rules only and nothing blocking, so G6 passes automatically; no gate decision row is needed.
    assert auto["g6"]["state"] == "passed_automatically", auto["g6"]
    assert auto["stage"] == {"status": "completed", "gate_status": "approved", "stale_reason": None}
    assert g5["stage"]["status"] == "completed"
    by_type = {e["type"]: e["message"] for e in g5["events"]}
    assert by_type["automation.assessed"].startswith(f"Assessed {len(cases)} approved cases: ")
    assert by_type["automation.generated"].endswith("(rules)")
    assert by_type["automation.validated"].startswith(f"Validation: {len(scripts)} valid · 0 invalid")
    assert by_type["gate.passed_automatically"] == "Gate 6: Script validation passed automatically"
    # Derived case fields: assessed, no version bump.
    after = {c["key"]: c for c in g5["after"]}
    for c in cases:
        assert after[c["key"]]["version"] == c["version"]


async def test_scripts_are_readable_deterministic_and_linked(flow: Flow) -> None:
    scripts = await _scripts(flow)
    empty = None
    for key, row in scripts.items():
        d = (await flow.get(f"/automation-scripts/{row['id']}")).json()
        code = d["code"]
        assert code.startswith(f"// {key} v{d['case_version']} · ") and "Generated by rules (AI not configured)" in code
        assert f'test("{key}: ' in code and f'tag: ["@{key}"' in code and row["path"].endswith(f"/{key}.spec.ts")
        for banned in ("waitForTimeout", "test.only", "page.locator(", "sk-", "Bearer"):
            assert banned not in code, (key, banned)
        assert all(d["checks"][c] == "ok" for c in ("guard", "tsc", "eslint", "secret_scan", "tags")), d["checks"]
        if row["case_title"] in EMPTY_TITLES:
            empty = d
    assert empty is not None, [(k, v["case_title"]) for k, v in scripts.items()]
    assert empty["path"] == f"tests/contact/{empty['case']['key']}.spec.ts"
    assert "await qa.expectSubmissionBlocked(contact.form);" in empty["code"]
    steps = [m for m in empty["assertion_map"] if m["helper"] == "expectFieldFlagged"]
    assert steps and steps[0]["args"][-1] == "Message" and steps[0]["step_text"] == "Press Send message"
    assert empty["can_review"] is False and empty["review"] is None
    # The ContactPage locator table: labels and roles first, each found once on the live page.
    auto = await flow.automation()
    pom = next(a for a in auto["bundle"]["assets"] if a["path"] == "pages/ContactPage.ts")
    assert pom["status"] == "valid" and pom["generated_by"] == "rules"
    table = (await flow.get(f"/automation-assets/{pom['id']}")).json()
    rows = {x["element"]: x for x in table["locators"]}
    assert rows["Message"]["how"] == 'getByLabel("Message")' and rows["Message"]["status"] == "unique"
    assert rows["Send message"]["how"] == 'getByRole("button", { name: "Send message" })'
    assert rows["Contact form"]["fallback"], rows["Contact form"]  # found by its button, said so
    assert empty["case"]["key"] in rows["Message"]["used_by"]
    platform = [a for a in auto["bundle"]["assets"] if a["generated_by"] == "platform"]
    assert {a["path"] for a in platform} >= {"fixtures.ts", "qa.ts", "policy.ts", "playwright.config.ts"}
    assert all(a["status"] == "platform" for a in platform)
    # Regenerating with unchanged cases keeps every script's version and checks (deterministic output).
    version = auto["bundle"]["version"]
    history = f"/automation-scripts/{scripts[empty['case']['key']]['id']}/versions"
    versions = (await flow.get(history)).json()
    r = await flow.post(f"/projects/{flow.pid}/stages/automation/run", {})
    assert r.status_code == 202, r.text
    await flow.idle()
    again = await flow.automation()
    assert again["bundle"]["version"] == version + 1 and again["bundle"]["counts"]["kept"] == len(scripts)
    assert again["bundle"]["counts"]["new_versions"] == 0
    for x in again["bundle"]["scripts"]:
        assert x["version"] == scripts[x["case_key"]]["version"] and x["status"] == "valid"
    old = (await flow.get(f"/projects/{flow.pid}/automation?version={version}")).json()
    assert old["bundle"]["version"] == version and old["bundle"]["is_current"] is False
    now = {x["case_key"]: x for x in again["bundle"]["scripts"]}
    assert (await flow.get(f"/automation-scripts/{now[empty['case']['key']]['id']}/versions")).json() == versions
    first = min(versions, key=lambda v: v["version"])
    assert first["version"] == 1 and first["cause"] == "First version", versions


async def test_renamed_label_makes_scripts_invalid_and_left_out(flow: Flow) -> None:
    empty_key = await _empty_key(flow)
    sid = (await _scripts(flow))[empty_key]["id"]
    flow.site.message_label = "Comments"
    try:
        await _validate(flow, f"/projects/{flow.pid}/automation/validate")
        auto = await flow.automation()
        rows = {x["case_key"]: x for x in auto["bundle"]["scripts"]}
        bad = rows[empty_key]
        assert bad["status"] == "invalid" and bad["checks"]["locators"] == "failed"
        d = (await flow.get(f"/automation-scripts/{bad['id']}")).json()
        msgs = d["validation"]["locators"]["messages"]
        code_lines = list(enumerate(d["code"].splitlines(), start=1))
        line = next((i for i, text in code_lines if ".message" in text), None) or next(
            i for i, text in code_lines if '"Message"' in text
        )
        assert {"line": line, "message": f"Line {line}: Locator 'Message' was not found on /contact"} in msgs, msgs
        # Scripts that never touch Message stay valid; invalid ones are a warning for G6, never a blocker.
        assert any(x["status"] == "valid" for x in rows.values())
        assert auto["g6"]["state"] == "passed_automatically"
        warn = {p["code"]: p for p in auto["g6"]["preconditions"]}["no_invalid"]
        assert not warn["met"] and not warn["blocking"] and empty_key in warn["message"]
        assert f"{empty_key}: Locator 'Message' was not found on /contact" in auto["bundle"]["validation"]["issues"]
        # The run scope leaves it out with the reason.
        prev = (await flow.post(f"/projects/{flow.pid}/execution-runs/preview",
                                {"selection": {"case_keys": [empty_key]}}, flow.member)).json()  # fmt: skip
        assert prev["cases"] == [] and prev["left_out"][0]["reason"] == "script can't run", prev["left_out"]
    finally:
        flow.site.message_label = "Message"
        await _validate(flow, f"/projects/{flow.pid}/automation/validate", flow.member)
    assert (await flow.get(f"/automation-scripts/{sid}")).json()["status"] == "valid"
    assert all(x["status"] == "valid" for x in (await _scripts(flow)).values())


async def test_secret_literal_fails_the_scan_without_showing_the_value(flow: Flow) -> None:
    token = "ghp_" + "Q7x" * 12
    row = (await _scripts(flow))[await _empty_key(flow)]
    async with flow.ctx.session_factory() as s:
        x = (
            await s.execute(
                select(AutomationScript).where(AutomationScript.id == uuid.UUID(row["id"])).execution_options(**BYPASS)
            )
        ).scalar_one()
        original = x.code
        x.code = original.replace("  const contact", f'  const token = "{token}";\n  void token;\n  const contact', 1)
        await s.commit()
    try:
        await _validate(flow, f"/automation-scripts/{row['id']}/validate")
        r = await flow.get(f"/automation-scripts/{row['id']}")
        d = r.json()
        assert d["status"] == "invalid" and d["checks"]["secret_scan"] == "failed"
        line = next(i for i, text in enumerate(d["code"].splitlines(), start=1) if "const token" in text)
        assert d["validation"]["secret_scan"]["messages"] == [
            {"line": line, "message": f"Line {line}: an access token appears in the script"}
        ]
        assert token not in json.dumps({k: v for k, v in d.items() if k != "code"})  # only the code carries it
        auto = (await flow.get(f"/projects/{flow.pid}/automation")).text
        assert token not in auto
    finally:
        async with flow.ctx.session_factory() as s:
            x = (
                await s.execute(
                    select(AutomationScript)
                    .where(AutomationScript.id == uuid.UUID(row["id"]))
                    .execution_options(**BYPASS)
                )
            ).scalar_one()
            x.code = original
            await s.commit()
    await _validate(flow, f"/automation-scripts/{row['id']}/validate")
    assert (await flow.get(f"/automation-scripts/{row['id']}")).json()["status"] == "valid"


async def test_credentials_switch_partial_cases_without_a_new_approval(flow: Flow) -> None:
    scripts = await _scripts(flow)
    before = (await flow.get(f"/projects/{flow.pid}/automation/assessment")).json()
    partial = [x["key"] for x in before["cases"] if x["suitability"] == "partial"]
    if not partial:
        pytest.skip("no case uses the saved test account on this fixture")
    base = flow.state["base"]
    r = await flow.client.put(
        f"{API}/projects/{flow.pid}/secrets/scan_credentials",
        headers=flow.owner.headers,
        json={"login_url": f"{base.rstrip('/')}/login", "username": "qa@example.com", "password": "fixture-pass-1"},
    )
    assert r.status_code in (200, 201), r.text
    after = {x["key"]: x for x in (await flow.get(f"/projects/{flow.pid}/automation/assessment")).json()["cases"]}
    assert all(after[k]["suitability"] == "suitable" for k in partial), after
    case = await flow.get(f"/projects/{flow.pid}/test-cases/by-key/{partial[0]}")
    assert case.json()["automation_suitability"]["value"] == "suitable"
    sid = r.json()["id"]
    assert (
        await flow.client.delete(f"{API}/projects/{flow.pid}/secrets/{sid}", headers=flow.owner.headers)
    ).status_code == 204
    back = {x["key"]: x for x in (await flow.get(f"/projects/{flow.pid}/automation/assessment")).json()["cases"]}
    assert all(back[k]["suitability"] == "partial" for k in partial)
    assert len({x["case_key"] for x in (await flow.automation())["bundle"]["scripts"]}) == len(scripts)


async def test_roles_and_tenant_isolation(flow: Flow) -> None:
    row = (await _scripts(flow))[await _empty_key(flow)]
    auto = await flow.automation(flow.viewer)
    assert auto["permissions"] == {"can_edit": False, "can_approve": False}
    assert (await flow.get(f"/automation-scripts/{row['id']}", flow.viewer)).status_code == 200
    assert (await flow.post(f"/projects/{flow.pid}/automation/validate", {}, flow.viewer)).status_code == 403
    assert (await flow.post(f"/projects/{flow.pid}/execution-runs/preview", {}, flow.viewer)).status_code == 403
    member = await flow.automation(flow.member)
    assert member["permissions"] == {"can_edit": True, "can_approve": False}
    asset = auto["bundle"]["assets"][0]
    other = flow.other.headers
    for path in (f"/projects/{flow.pid}/automation", f"/projects/{flow.pid}/automation/assessment",
                 f"/automation-scripts/{row['id']}", f"/automation-scripts/{row['id']}/versions",
                 f"/automation-assets/{asset['id']}"):  # fmt: skip
        assert (await flow.get(path, other)).status_code == 404, path
    assert (await flow.post(f"/automation-scripts/{row['id']}/validate", {}, other)).status_code == 404
    # Rules scripts need no review (D10).
    r = await flow.post(f"/automation-scripts/{row['id']}/review", {"decision": "approve"}, flow.approver)
    assert r.status_code == 409


async def _set_generated_by(flow: Flow, script_id: str, value: Any, review: dict[str, Any] | None = None) -> None:
    async with flow.ctx.session_factory() as s:
        x = (
            await s.execute(
                select(AutomationScript).where(AutomationScript.id == uuid.UUID(script_id)).execution_options(**BYPASS)
            )
        ).scalar_one()
        x.generated_by = value
        x.review = review
        await s.commit()


async def test_ai_script_needs_review_and_rejection_falls_back_to_rules(flow: Flow) -> None:
    from app.db.tenant import system_scope
    from app.domain.enums import ScriptGeneratedBy
    from app.orchestrator.orchestrator import Orchestrator

    key = await _empty_key(flow)
    # The fallback comes from an earlier bundle: regenerate so there is one whatever ran before.
    r = await flow.post(f"/projects/{flow.pid}/stages/automation/run", {})
    assert r.status_code == 202, r.text
    await flow.idle()
    row = (await _scripts(flow))[key]
    orch, scope = Orchestrator(flow.ctx), system_scope(uuid.UUID(str(flow.owner.org_id)))
    # Stand-in for P4-03b: the current bundle's script for this case is marked as written by AI.
    await _set_generated_by(flow, row["id"], ScriptGeneratedBy.ai)
    try:
        await orch.finalise_g6(scope, uuid.UUID(flow.pid))
        auto = await flow.automation(flow.member)
        assert auto["g6"]["state"] == "waiting" and auto["stage"]["status"] == "awaiting_approval"
        pre = {p["code"]: p for p in auto["g6"]["preconditions"]}
        assert not pre["ai_reviewed"]["met"] and pre["ai_reviewed"]["blocking"] and key in pre["ai_reviewed"]["message"]
        assert (await flow.get(f"/automation-scripts/{row['id']}", flow.member)).json()["status"] == "needs_review"
        assert (await flow.get(f"/automation-scripts/{row['id']}", flow.member)).json()["can_review"] is False
        assert (await flow.get(f"/automation-scripts/{row['id']}", flow.approver)).json()["can_review"] is True
        prev = (await flow.post(f"/projects/{flow.pid}/execution-runs/preview",
                                {"selection": {"case_keys": [key]}})).json()  # fmt: skip
        assert prev["cases"] == [] and prev["left_out"][0]["reason"] == "script needs review (Gate 6)"
        r = await flow.post(f"/automation-scripts/{row['id']}/review", {"decision": "approve"}, flow.member)
        assert r.status_code == 403
        r = await flow.post(f"/automation-scripts/{row['id']}/review", {"decision": "reject"}, flow.approver)
        assert r.status_code == 422 and r.json()["error"]["message"] == "Say what's wrong with this script."
        r = await flow.post(f"/automation-scripts/{row['id']}/review",
                            {"decision": "reject", "comment": "It checks the wrong field"}, flow.approver)  # fmt: skip
        assert r.status_code == 200, r.text
        # An earlier bundle's rules script of the same case version is the fallback (open question 6).
        assert r.json()["message"] == f"Script rejected. {key} will use its rules script."
        assert r.json()["fallback_script_id"] is not None and r.json()["fallback_script_id"] != row["id"]
        auto = await flow.automation()
        assert auto["g6"]["state"] in ("reviewed", "passed_automatically") and auto["stage"]["status"] == "completed"
        assert (await flow.get(f"/automation-scripts/{row['id']}")).json()["status"] == "rejected"
        prev = (await flow.post(f"/projects/{flow.pid}/execution-runs/preview",
                                {"selection": {"case_keys": [key]}})).json()  # fmt: skip
        assert [c["script_id"] for c in prev["cases"]] == [r.json()["fallback_script_id"]]
        # Approving an AI script completes G6 too.
        await _set_generated_by(flow, row["id"], ScriptGeneratedBy.ai)
        await orch.finalise_g6(scope, uuid.UUID(flow.pid))
        assert (await flow.automation())["g6"]["state"] == "waiting"
        ok = await flow.post(f"/automation-scripts/{row['id']}/review", {"decision": "approve"}, flow.approver)
        assert ok.status_code == 200 and ok.json()["message"] == "Script approved."
        assert (await flow.automation())["g6"]["state"] == "reviewed"
    finally:
        await _set_generated_by(flow, row["id"], ScriptGeneratedBy.rules)
        await orch.finalise_g6(scope, uuid.UUID(flow.pid))
    assert (await flow.automation())["g6"]["state"] == "passed_automatically"


async def test_run_scope_lists_side_effects_and_left_out_cases(flow: Flow) -> None:
    empty_key = await _empty_key(flow)
    r = await flow.post(f"/projects/{flow.pid}/execution-runs/preview", {"selection": {"suite": "all_approved"}},
                        flow.member)  # fmt: skip
    assert r.status_code == 200, r.text
    scope = r.json()
    assert scope["browsers"] == ["chromium"] and scope["viewports"] == ["desktop"]
    assert scope["viewport_sizes"] == {"desktop": {"width": 1440, "height": 900}}
    assert scope["tests"] == len(scope["cases"]) and not scope["over_limit"]
    lines = {x["text"]: x for x in scope["side_effects"]}
    may = lines["May submit the Contact form (if the application does not block it)"]
    assert empty_key in may["case_keys"] and may["count"] == len(may["case_keys"])
    assert scope["risky_line"] == "Pays, buys or deletes anything: no" and scope["approvals_needed"] == []
    manual = [x for x in scope["left_out"] if x["code"] == "manual_only"]
    assert manual and all(x["reason"] == "needs a person" for x in manual)
    # QA P4-BUG-07: without saved credentials, sign-in tests are "Will be blocked", never "Signs in with …".
    blocked = {b["key"] for b in scope["blocked"]}
    signs_in = {k for x in scope["side_effects"] if x["kind"] == "signs_in" for k in x["case_keys"]}
    assert not blocked & signs_in
    if blocked:
        assert lines["Will be blocked: no saved test login"]["case_keys"] == sorted(blocked)
    assert len(scope["scope_hash"]) == 64
    # Nothing was created and the site was not contacted.
    seen = len(flow.site.requests)
    again = await flow.post(f"/projects/{flow.pid}/execution-runs/preview", {"selection": {"suite": "all_approved"}})
    assert again.json()["scope_hash"] == scope["scope_hash"] and len(flow.site.requests) == seen
    bad = await flow.post(f"/projects/{flow.pid}/execution-runs/preview", {"selection": {"case_keys": ["TC-9999"]}})
    assert bad.status_code == 422 and bad.json()["error"]["message"] == "TC-9999 is not an approved test case"


async def test_risky_action_approvals(flow: Flow) -> None:
    from datetime import timedelta

    from app.api.errors import GateBlocked
    from app.db.models import Approval, ExecutionRun, Project
    from app.db.tenant import bind_scope, system_scope
    from app.domain.enums import ApprovalStatus
    from app.services import approvals as apr

    await _ready(flow)
    org = uuid.UUID(str(flow.owner.org_id))
    pid = uuid.UUID(flow.pid)
    scope = (await flow.post(f"/projects/{flow.pid}/execution-runs/preview", {})).json()
    keys = [c["key"] for c in scope["cases"]][:2]
    scope["approvals_needed"] = [{"kind": "external_transaction", "title": "External transaction (payment or purchase)",
                                  "case_keys": keys[:1], "cases": []},
                                 {"kind": "destructive", "title": "Destructive action (delete, cancel or close something)",
                                  "case_keys": keys[1:2], "cases": []}]  # fmt: skip
    async with flow.ctx.session_factory() as s:
        bind_scope(s, system_scope(org))
        project = (await s.execute(select(Project).where(Project.id == pid))).scalar_one()
        # Runs made directly in the database (nothing executes them); found again by id, not by key.
        run = ExecutionRun(organisation_id=org, project_id=pid, key="RUN-0901", scope=scope)
        s.add(run)
        await s.flush()
        run_id = run.id
        rows = await apr.request_approvals(s, project, run, requested_by=None)
        await s.commit()
        ids = [str(a.id) for a in rows]
        k1, k2 = [a.key for a in rows]
        assert re.fullmatch(r"APR-\d{4}", k1) and int(k2[4:]) == int(k1[4:]) + 1, (k1, k2)
        try:
            await apr.ensure_decided(s, run)
            raise AssertionError("expected 409")
        except GateBlocked as exc:
            assert str(exc) == f"Approve or reject: external transaction ({k1}), destructive action ({k2})"
    host = scope["target_host"]
    got = (await flow.get(f"/approvals/{ids[0]}", flow.member)).json()
    assert (
        got["status"] == "pending" and got["can_decide"] is False and got["confirm_prompt"] == f"Type {host} to confirm"
    )
    assert (await flow.get(f"/approvals/{ids[0]}", flow.other.headers)).status_code == 404
    body = {"decision": "approve", "confirm_text": host}
    assert (await flow.post(f"/approvals/{ids[0]}/decision", body, flow.member)).status_code == 403
    assert (await flow.post(f"/approvals/{ids[0]}/decision", body, flow.other.headers)).status_code == 404
    wrong = await flow.post(f"/approvals/{ids[0]}/decision", {"decision": "approve", "confirm_text": "example.com"},
                            flow.approver)  # fmt: skip
    assert wrong.status_code == 422 and wrong.json()["error"]["message"] == f"Type {host} exactly to confirm."
    # Destructive actions need the typed host too (open question 2).
    wrong = await flow.post(f"/approvals/{ids[1]}/decision", {"decision": "approve"}, flow.approver)
    assert wrong.status_code == 422
    ok = await flow.post(f"/approvals/{ids[0]}/decision", {"decision": "approve", "confirm_text": f" {host.upper()} "},
                         flow.approver)  # fmt: skip
    assert ok.status_code == 200 and ok.json()["status"] == "approved", ok.text
    assert (await flow.post(f"/approvals/{ids[0]}/decision", body, flow.approver)).status_code == 409
    no = await flow.post(f"/approvals/{ids[1]}/decision", {"decision": "reject", "comment": "Not on this site"},
                         flow.approver)  # fmt: skip
    assert no.status_code == 200 and no.json()["status"] == "rejected"
    async with flow.ctx.session_factory() as s:
        bind_scope(s, system_scope(org))
        run = (await s.execute(select(ExecutionRun).where(ExecutionRun.id == run_id))).scalar_one()
        skipped = await apr.consume(s, run)
        await s.commit()
        assert skipped == {keys[1]: "Not approved: destructive action"}
        statuses = {a.key: a.status for a in await apr.run_approvals(s, run.id)}
        assert statuses == {k1: ApprovalStatus.used, k2: ApprovalStatus.rejected}
        # A pending approval older than 24 h expires, and the run can't start until it is requested again.
        run2 = ExecutionRun(organisation_id=org, project_id=pid, key="RUN-0902", scope=scope)
        s.add(run2)
        await s.flush()
        run2_id = run2.id
        project = (await s.execute(select(Project).where(Project.id == pid))).scalar_one()
        late = await apr.request_approvals(s, project, run2, requested_by=None)
        for a in late:
            a.expires_at = a.expires_at - timedelta(hours=25)
        await s.commit()
        late_id = str(late[0].id)
    assert (await flow.get(f"/approvals/{late_id}")).json()["status"] == "expired"
    r = await flow.post(f"/approvals/{late_id}/decision", body, flow.approver)
    assert r.status_code == 409 and "expired after 24 hours" in r.json()["error"]["message"]
    async with flow.ctx.session_factory() as s:
        bind_scope(s, system_scope(org))
        run2 = (await s.execute(select(ExecutionRun).where(ExecutionRun.id == run2_id))).scalar_one()
        try:
            await apr.ensure_decided(s, run2)
            raise AssertionError("expected 409")
        except GateBlocked as exc:
            assert "expired after 24 hours" in str(exc)
        assert apr.request_expired(run2) is False
        run2.created_at = run2.created_at - timedelta(days=8)
        assert apr.request_expired(run2) is True
        assert await apr.scripts_changed(s, run2) == []
        acts = {
            a.action
            for a in (await s.execute(select(__import__("app.db.models", fromlist=["AuditLog"]).AuditLog))).scalars()
        }
        assert {
            "approval.requested",
            "approval.approved",
            "approval.rejected",
            "approval.used",
            "approval.expired",
        } <= acts
        _ = Approval


async def test_playwright_project_export_with_ci_templates(flow: Flow) -> None:
    import io
    import zipfile

    import yaml

    await _ready(flow)
    url = f"{API}/projects/{flow.pid}/automation/export"
    assert (await flow.client.get(url, headers=flow.viewer)).status_code == 403
    assert (await flow.client.get(url, headers=flow.other.headers)).status_code == 404
    r = await flow.client.get(url, headers=flow.member)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    auto = await flow.automation()
    version = auto["bundle"]["version"]
    assert f'-playwright-v{version}.zip"' in r.headers["content-disposition"]
    z = zipfile.ZipFile(io.BytesIO(r.content))
    root = z.namelist()[0].split("/")[0]
    names = {n.removeprefix(f"{root}/") for n in z.namelist()}
    assert {"package.json", "README.md", ".gitignore", "playwright.config.ts", "fixtures.ts", "qa.ts", "policy.ts",
            "tsconfig.json", ".github/workflows/playwright.yml", ".gitlab-ci.yml"} <= names  # fmt: skip
    assert "live.ts" not in names and "progress.ts" not in names
    specs = sorted(n for n in names if n.endswith(".spec.ts"))
    summary = auto["bundle"]["export"]
    assert len(specs) == summary["scripts"] >= 1
    valid = {x["path"] for x in auto["bundle"]["scripts"] if x["status"] == "valid"}
    assert set(specs) <= valid | {x["path"] for x in auto["bundle"]["scripts"] if x["status"] == "rejected"}
    for a in auto["bundle"]["assets"]:
        if a["path"] not in ("live.ts", "progress.ts"):
            assert a["path"] in names, a["path"]
    files = {n: z.read(f"{root}/{n}").decode() for n in names}
    # CI templates are valid YAML with the expected shape (they are never run here).
    gh = yaml.safe_load(files[".github/workflows/playwright.yml"])
    steps = gh["jobs"]["test"]["steps"]
    assert any(st.get("run") == "npx playwright test" for st in steps)
    assert gh["jobs"]["test"]["env"]["TEST_PASSWORD"] == "${{ secrets.TEST_PASSWORD }}"
    gl = yaml.safe_load(files[".gitlab-ci.yml"])
    assert gl["playwright"]["script"][-1] == "npx playwright test" and "1.65.0" in gl["playwright"]["image"]
    pkg = json.loads(files["package.json"])
    assert pkg["devDependencies"]["@playwright/test"] == "1.65.0" and pkg["scripts"]["test"] == "playwright test"
    assert pkg["scripts"]["test:regression"] == "playwright test --grep @regression"  # P4-BUG-02
    # P4-BUG-02: the local fixture site needs ATA_ALLOW_PRIVATE, in the README command and in .env.example, and a
    # local run retries once like the platform.
    assert f"ATA_ALLOW_PRIVATE=true BASE_URL={flow.state['base'].rstrip('/')}" in files["README.md"]
    assert "ATA_ALLOW_PRIVATE=true" in files[".env.example"] and "TEST_PASSWORD=\n" in files[".env.example"]
    assert 'process.env.PW_RETRIES ||= "1";' in files["playwright.config.ts"]
    readme = files["README.md"]
    assert f"Exported from scripts version {version}" in readme and f"{len(specs)} test(s) included" in readme
    for x in summary["left_out"]:
        assert x["case_key"] in readme and x["reason"] in readme
    # Nothing secret: the saved test password never appears; settings come from the environment.
    assert not any("fixture-pass-1" in text for text in files.values())
    assert "BASE_URL" in readme and "TEST_PASSWORD" in readme
    async with flow.ctx.session_factory() as s:
        from app.db.models import AuditLog

        rows = list(
            (
                await s.execute(
                    select(AuditLog).where(AuditLog.action == "automation.exported").execution_options(**BYPASS)
                )
            ).scalars()
        )
    assert len(rows) == 1 and rows[0].meta["scripts"] == len(specs)


async def test_ai_path_real_checks_and_ai_scripts_need_g6_review(flow: Flow) -> None:
    """P4-03b with a fake provider: the real offline checks reject `node:fs` (3 repairs, rules script kept), and a
    regenerated bundle stores an accepted AI rewrite as generated_by="ai", waiting for review at G6."""
    from app.agents.automation import ai_writer as ai
    from app.db.models import AutomationAsset
    from app.llm.base import BaseLLMClient, Budget, FakeLLM, RawCompletion

    key = await _empty_key(flow)
    auto = await flow.automation()
    row = next(x for x in auto["bundle"]["scripts"] if x["case_key"] == key)
    rule = (await flow.get(f"/automation-scripts/{row['id']}")).json()["code"]
    async with flow.ctx.session_factory() as s:
        assets = {
            a.path: a.code
            for a in (
                await s.execute(
                    select(AutomationAsset)
                    .where(AutomationAsset.stage_run_id == uuid.UUID(auto["bundle"]["id"]))
                    .execution_options(**BYPASS)
                )
            ).scalars()
            if a.generated_by.value != "platform"
        }
    bad = rule.replace("import { test }", 'import fs from "node:fs";\nimport { test }', 1)
    fake = FakeLLM([{"code": bad}] * 4)
    ctx = type("Ctx", (), {"llm": fake, "settings": flow.ctx.settings})()
    case = type("Case", (), {"key": key, "title": "t", "steps": (), "expected_result": ""})()
    res = await ai.write(ctx, case=case, path=row["path"], baseline=rule, blockers=None, blocks=[],  # type: ignore[arg-type]
                         check=ai.toolkit_check(flow.ctx, assets))  # fmt: skip
    assert res.code is None and res.fallback_used and res.attempts == 4 and res.repairs == 3
    assert any("guard" in p for p in res.problems), res.problems
    assert all("guard" in c["user"] and "node:fs" in c["user"] for c in fake.captured[1:])

    class EchoLLM(BaseLLMClient):
        """Restructures only the empty-Message spec (adds a comment); other specs come back unchanged."""

        provider, model = "fake", "echo"

        async def _complete(self, system: str, user: str, schema: dict[str, Any], budget: Budget) -> RawCompletion:
            m = re.search(r"```ts\n(.*?)```", user, re.S)
            if m is None:
                return RawCompletion({"code": "short"})  # AI-only drafts are unusable: those cases stay manual
            code = m.group(1)
            if f"test case {key} to improve" in user:
                code = code.replace(
                    "  await qa.expectSubmissionBlocked",
                    "  // Submit, then check\n  await qa.expectSubmissionBlocked",
                    1,
                )
            return RawCompletion({"code": code})

    previous = flow.ctx.llm
    flow.ctx.llm = EchoLLM()
    try:
        r = await flow.post(f"/projects/{flow.pid}/stages/automation/run", {})
        assert r.status_code == 202, r.text
        await flow.idle()
    finally:
        flow.ctx.llm = previous
    try:
        await _check_ai_bundle(flow, key)
    finally:
        # Back to an all-rules bundle with G6 passed, as the other tests expect.
        r = await flow.post(f"/projects/{flow.pid}/stages/automation/run", {})
        assert r.status_code == 202, r.text
        await flow.idle()
    restored = await flow.automation()
    assert restored["g6"]["state"] == "passed_automatically", restored["g6"]
    assert all(x["generated_by"] == "rules" and x["status"] == "valid" for x in restored["bundle"]["scripts"])


async def _check_ai_bundle(flow: Flow, key: str) -> None:
    auto = await flow.automation()
    assert auto["bundle"]["generated_by"] == "mixed", [
        (x["case_key"], x["generated_by"], x["status"]) for x in auto["bundle"]["scripts"]
    ]
    ai_rows = [x for x in auto["bundle"]["scripts"] if x["generated_by"] == "ai"]
    assert [x["case_key"] for x in ai_rows] == [key] and ai_rows[0]["status"] == "needs_review"
    d = (await flow.get(f"/automation-scripts/{ai_rows[0]['id']}")).json()
    assert "// Submit, then check" in d["code"] and "test.only" not in d["code"]
    assert all(d["checks"][c] == "ok" for c in ("guard", "tsc", "eslint", "secret_scan", "tags")), d["checks"]
    assert auto["g6"]["state"] == "waiting"
    pre = {p["code"]: p for p in auto["g6"]["preconditions"]}
    assert not pre["ai_reviewed"]["met"] and key in pre["ai_reviewed"]["message"]
    # Every other rule script was returned unchanged and kept as rules.
    assert all(x["generated_by"] == "rules" for x in auto["bundle"]["scripts"] if x["case_key"] != key)


async def test_a_retried_automation_job_reuses_its_rows(flow: Flow) -> None:
    """QA P4-BUG-04: a re-claimed `automation` job runs the handler again for the same stage run. It updates the rows
    the first attempt wrote (no UNIQUE failure), keeps their ids, and validation reports a result for every script."""
    from app.agents.automation.engineer import AutomationAgent
    from app.db.models import AutomationAsset
    from app.db.tenant import bind_scope, system_scope
    from app.domain.enums import StageKey
    from app.services import automation as svc

    await _ready(flow)
    scope = system_scope(uuid.UUID(str(flow.owner.org_id)))
    pid = uuid.UUID(flow.pid)

    async def rows() -> tuple[uuid.UUID, dict[str, uuid.UUID], dict[str, uuid.UUID]]:
        async with flow.ctx.session_factory() as s:
            bind_scope(s, scope)
            run = await svc.current_run(s, pid, StageKey.automation)
            assert run is not None
            scripts, assets = await svc.bundle_rows(s, run.id)
            return run.id, {x.path: x.id for x in scripts}, {x.path: x.id for x in assets}

    run_id, scripts, assets = await rows()
    outcome = await AutomationAgent(flow.ctx, scope, project_id=pid, run_id=run_id, task_id=uuid.uuid4()).run()
    again_id, scripts2, assets2 = await rows()
    assert again_id == run_id and scripts2 == scripts and assets2 == assets
    validation = outcome.output["validation"]
    assert validation["status"] == "done" and validation["toolkit"] is None, validation
    assert validation["counts"]["not_checked"] == 0 and validation["counts"]["valid"] >= 1
    async with flow.ctx.session_factory() as s:
        bind_scope(s, scope)
        n = len(
            list((await s.execute(select(AutomationAsset).where(AutomationAsset.stage_run_id == run_id))).scalars())
        )
    assert n == len(assets)
