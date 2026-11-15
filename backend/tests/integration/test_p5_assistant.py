"""P5-07 AI QA Analyst v4, AI off, on the P5 fixture site.

Covers: the four non-functional questions answer from stored checks and load tests only (no run → "No load test has
run in this project yet."); security answers always end with the fixed statement (design check 33); Later phases
lists only Phase 6 items (32); accepting "Check accessibility" starts a check; accepting "Plan a load test" creates a
request waiting for approval, never a running test (32); A11Y/SEC/PERF/PRF keys resolve in the citation guard and
unknown ones are removed.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from app.context import AppContext
from app.db.tenant import bind_scope, system_scope
from app.security.passive_rules import STATEMENT as SECURITY_STATEMENT
from app.services.assistant import Answer, citation_guard, route
from tests.conftest import Account, CtxFactory, client_for, public_resolver, register, site_transport, worker_for
from tests.fixtures.p5_site import P5Site, running_p5_site
from tests.integration.p5_helpers import API, seed_site
from tests.integration.test_p5_performance import REQ, SHORT, _approved_run, _ready_profile


@pytest.fixture
async def env(make_ctx: CtxFactory) -> AsyncIterator[tuple[AppContext, httpx.AsyncClient, Account, str, P5Site]]:
    ctx = await make_ctx(resolver=public_resolver(), transport=site_transport(), allow_private_targets=True,
                         scan_page_timeout_s=3)  # fmt: skip
    with running_p5_site() as (base, site):
        async with client_for(ctx) as c:
            owner = await register(c, "owner@p5a.example.com", org="P5 Assistant")
            yield ctx, c, owner, base, site


def test_routes() -> None:
    assert route("Is the site fast enough?") == ("performance_summary", {})
    assert route("Can everyone use the site?") == ("accessibility_summary", {})
    assert route("Is the site missing basic protections?") == ("security_summary", {})
    assert route("Explain a11y-0001-02") == ("explain_finding", {"key": "A11Y-0001-02"})
    assert route("Check accessibility") == ("propose_scan", {"kind": "accessibility"})
    assert route("Run a security check") == ("propose_scan", {"kind": "security"})
    assert route("Plan a load test with PRF-01") == ("propose_performance_run", {"profile": "PRF-01"})
    assert route("Re-run the failed tests") == ("propose_rerun", {"only_failed": True})


async def test_assistant_v4_ai_off(env: Any) -> None:
    ctx, client, owner, base, _site = env
    project = await seed_site(ctx, client, owner, base, ["/", "/a11y/button", "/perf/slow"], g4=True,
                              requirement=(REQ, ["/perf/slow"]))  # fmt: skip
    pid = project["id"]
    h = owner.headers
    tid = (await client.post(f"{API}/projects/{pid}/assistant/threads", json={}, headers=h)).json()["id"]

    async def ask(body: dict[str, Any]) -> dict[str, Any]:
        r = await client.post(f"{API}/assistant/threads/{tid}/messages", json=body, headers=h)
        assert r.status_code in (200, 201), r.text
        return dict(r.json()["reply"])

    async def accept(prop: dict[str, Any]) -> list[dict[str, Any]]:
        r = await client.post(f"{API}/assistant/proposals/{prop['id']}/accept", json={}, headers=h)
        assert r.status_code == 200, r.text
        return list(r.json()["result"]["applied"])

    caps = (await client.get(f"{API}/projects/{pid}/assistant/capabilities", headers=h)).json()
    assert {x["needs"] for x in caps["later_phase_tasks"]} == {"Phase 6"}
    ours = {i["intent"]: i for i in caps["intents"]}
    for intent in ("performance_summary", "accessibility_summary", "security_summary", "explain_finding"):
        assert ours[intent]["available"] and not ours[intent]["needs_ai"]

    # Nothing has run yet.
    perf = await ask({"content": "Is the site fast enough?"})
    assert perf["intent"] == "performance_summary" and perf["content"] == "No load test has run in this project yet."
    assert perf["follow_ups"][0]["intent"] == "propose_performance_run"
    sec = await ask({"content": "Is the site missing basic protections?"})
    assert sec["content"].endswith(SECURITY_STATEMENT)

    # "Check accessibility": accepting starts the check (no approval, D19).
    chk = await ask({"content": "Check accessibility"})
    assert chk["intent"] == "propose_scan" and chk["proposals"][0]["kind"] == "start_check", chk
    assert chk["content"].startswith("Check accessibility on 3 pages (desktop).")
    applied = await accept(chk["proposals"][0])
    assert applied[0]["key"].startswith("A11Y-")
    await worker_for(ctx).run_until_idle(timeout=180)
    scans = (await client.get(f"{API}/projects/{pid}/accessibility-scans", headers=h)).json()["items"]
    assert scans[0]["key"] == applied[0]["key"] and scans[0]["status"] in ("completed", "partial")
    a11y = await ask({"content": "Can everyone use the site?"})
    assert a11y["intent"] == "accessibility_summary" and scans[0]["key"] in {c["key"] for c in a11y["citations"]}
    assert a11y["content"].endswith(scans[0]["statement"])
    findings = (await client.get(f"{API}/quality-scans/{scans[0]['id']}/findings", headers=h)).json()["items"]
    button = next(f for f in findings if f["rule_id"] == "button-name")
    assert button["key"] in a11y["content"]
    ex = await ask({"content": f"Explain {button['key']}"})
    assert ex["intent"] == "explain_finding" and "Status: open." in ex["content"] and "4.1.2" in ex["content"]

    # A security check through its proposal; the answer ends with the statement.
    sp = await ask({"intent": "propose_scan", "params": {"kind": "security"}})
    await accept(sp["proposals"][0])
    await worker_for(ctx).run_until_idle(timeout=180)
    sec = await ask({"content": "Are the security headers set?"})
    assert sec["intent"] == "security_summary" and sec["content"].endswith(SECURITY_STATEMENT)
    assert any(c["key"].startswith("SEC-") for c in sec["citations"])

    # "Plan a load test": a request waiting for approval, never a running test.
    prof = await _ready_profile(client, owner, pid, stages=SHORT, paths=["/perf/slow"])
    plan = await ask({"content": "Plan a load test"})
    assert plan["intent"] == "propose_performance_run" and plan["proposals"], plan
    assert f"Run a load test with {prof['key']}: up to 2 virtual users" in plan["content"]
    assert "the assistant can't approve load tests or start load" in plan["content"]
    applied = await accept(plan["proposals"][0])
    runs = (await client.get(f"{API}/projects/{pid}/performance-runs", headers=h)).json()["items"]
    req = next(x for x in runs if x["key"] == applied[0]["key"])
    assert req["status"] == "awaiting_approval"
    await client.post(f"{API}/performance-runs/{req['id']}/withdraw", headers=h)

    # A finished load test: numbers quoted from the stored run, with the profile and approval cited.
    run = await _approved_run(client, owner, pid, prof["id"], "127.0.0.1")
    await worker_for(ctx).run_until_idle(timeout=180)
    api_run = (await client.get(f"{API}/performance-runs/{run['id']}", headers=h)).json()
    perf = await ask({"content": "Is the site fast enough?"})
    cited = {c["key"] for c in perf["citations"]}
    assert {api_run["key"], prof["key"]} <= cited and any(k.startswith("APR-") for k in cited)
    assert f"{api_run['key']}: /perf/slow p95" in perf["content"] and "✗ Missed" in perf["content"]

    # Citation guard: P5 keys of this project resolve; unknown ones are removed.
    async with ctx.session_factory() as s:
        bind_scope(s, system_scope(owner.org_id))
        ans = Answer(f"See {button['key']}, {api_run['key']}, {prof['key']}, PERF-9999 and A11Y-0001-99.", "ai")
        await citation_guard(s, uuid.UUID(pid), ans)
    assert {c["key"] for c in ans.citations} == {button["key"], api_run["key"], prof["key"]}
    assert "PERF-9999" not in ans.content and "A11Y-0001-99" not in ans.content
