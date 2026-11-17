"""P6-03a rule-based safe explorer against the exploration fixture site (real Chromium, AI off).

Covers: every coded oracle on the lab page with its fixed severity, steps to reproduce and before/after screenshots;
the blocked POST ("Blocked write attempts") with nothing but GET/HEAD reaching the site; "Delete account", "Pay now",
the newsletter submit and `/logout` listed as "Not tried" and never activated; grouped defect drafts for the high and
uncaught-error findings (G8 as always); the endless chain ending `completed` at exactly the action budget; the
prompt-injection page (the rules' actions unchanged, a finding recorded); Stop now within 2 s with steps kept; the
budget checked against the organisation ceiling and the platform cap (422 naming the limit); signed-in sessions
waiting for an approver who types the host, with nothing sent before and no credential anywhere after; viewers and
members' rights; other organisations 404.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.context import AppContext
from app.db.migrate import downgrade, upgrade
from app.db.models import (
    AgentEvent,
    AuditLog,
    Defect,
    Evidence,
    ExploratoryStep,
    Membership,
    QualityFinding,
    QualityScan,
)
from app.db.tenant import BYPASS
from app.domain.enums import DefectSource, EvidenceKind, QualityScanKind, QualityScanStatus, Role
from tests.conftest import (
    Account,
    CtxFactory,
    client_for,
    create_project,
    public_resolver,
    register,
    site_transport,
    worker_for,
)
from tests.fixtures.explore_site import ExploreSite, running_explore_site
from tests.integration.p5_helpers import API, seed_site

USER, PASSWORD = "qa.explorer@fixture.example", "Expl0re-secret-pw"


@pytest.fixture
async def env(
    make_ctx: CtxFactory,
) -> AsyncIterator[tuple[AppContext, httpx.AsyncClient, Account, Account, str, ExploreSite]]:
    ctx = await make_ctx(resolver=public_resolver(), transport=site_transport(), allow_private_targets=True,
                         scan_page_timeout_s=5)  # fmt: skip
    with running_explore_site(credentials=(USER, PASSWORD)) as (base, site):
        async with client_for(ctx) as c:
            owner = await register(c, "owner@p6x.example.com", org="P6 Explore")
            other = await register(c, "other@p6x.example.com", org="Other Org")
            yield ctx, c, owner, other, base, site


async def _join(
    ctx: AppContext, client: httpx.AsyncClient, owner: Account, role: Role, can_approve: bool
) -> dict[str, str]:
    acc = await register(client, f"{role.value}-{uuid.uuid4().hex[:6]}@p6x.example.com", org="Spare Org")
    async with ctx.session_factory() as s:
        m = (await s.execute(select(Membership).where(Membership.user_id == acc.user_id)
                             .execution_options(**BYPASS))).scalar_one()  # fmt: skip
        m.organisation_id, m.role, m.can_approve = owner.org_id, role, can_approve
        await s.commit()
    login = await client.post(f"{API}/auth/login", json={"email": acc.email, "password": "correct-horse-battery"})
    return {"Authorization": f"Bearer {login.json()['token']}"}


async def _start(client: httpx.AsyncClient, headers: dict[str, str], pid: str, body: dict[str, Any]) -> dict[str, Any]:
    r = await client.post(f"{API}/projects/{pid}/exploratory-sessions", json=body, headers=headers)
    assert r.status_code == 201, r.text
    return dict(r.json())


async def _session(client: httpx.AsyncClient, headers: dict[str, str], sid: str) -> dict[str, Any]:
    r = await client.get(f"{API}/quality-scans/{sid}", headers=headers)
    assert r.status_code == 200, r.text
    return dict(r.json())


def _writes(site: ExploreSite) -> set[str]:
    return {m for m, _ in site.requests} - {"GET", "HEAD"}


async def test_lab_oracles_blocked_write_not_tried_and_budget(env: Any) -> None:
    ctx, client, owner, other, base, site = env
    project = await seed_site(ctx, client, owner, base, ["/lab"])
    pid = project["id"]
    started = await _start(client, owner.headers, pid, {"budget": {"actions": 25, "minutes": 5}})
    assert (
        started["status"] == "queued"
        and started["charter"]["key"] == "all"
        and started["message"] == (f"{started['key']} started.")
    )
    assert started["key"] == "EXP-0001" and started["budget"] == {"actions": 25, "minutes": 5}
    await worker_for(ctx).run_until_idle(timeout=300)
    sess = await _session(client, owner.headers, started["id"])
    assert sess["status"] == "completed", sess
    assert sess["end_reason"] == "budget" and sess["progress"]["actions_used"] == 25, sess
    assert sess["status_label"] == "Finished · budget used" and sess["end_text"] == "Budget used: 25 of 25 actions"
    pages = sess["progress"]["pages_explored"]
    assert sess["statement"] == (
        f"This session tried 25 actions on {pages} pages within its budget. Exploration is a sample, not a complete "
        "test, and it never submits forms or sends data."
    )
    # Only reading reached the site; the controls that may change data were never activated.
    assert _writes(site) == set(), site.requests
    paths = {p.split("?")[0] for _, p in site.requests}
    assert not paths & {"/api/account", "/paid", "/subscribe", "/logout", "/api/cart", "/login"}
    assert "/api/stock" in paths and "/gone" in paths
    # Blocked write attempts and Not tried (with reasons).
    assert [b["request"] for b in sess["blocked"]] == ["POST /api/cart"]
    assert sess["blocked"][0]["after"] == 'Clicking button "Add to cart" on /lab'
    not_tried = {(n["element"], n["reason"]) for n in sess["not_tried"]}
    assert ('Button "Delete account"', "Name suggests it changes data") in not_tried
    assert ('Button "Pay now"', "Name suggests it changes data") in not_tried
    assert ('Button "Join"', "Submits a form") in not_tried
    assert ('Link "Log out"', "Would end the session") in not_tried
    # Every oracle, with its fixed severity, on the lab page.
    r = await client.get(f"{API}/quality-scans/{sess['id']}/findings", headers=owner.headers)
    findings = r.json()["items"]
    by_rule = {f["rule_id"]: f for f in findings if f["path"] == "/lab"}
    expected = {"uncaught_exception": "medium", "server_error": "high", "not_found": "medium", "broken_text": "medium",
                "console_error": "low", "overflow": "low", "dialog_trap": "low"}  # fmt: skip
    assert {k: v["severity"] for k, v in by_rule.items()} == expected, sorted(by_rule)
    exc = by_rule["uncaught_exception"]
    assert exc["title"] == 'Uncaught error after clicking button "Show details"'
    assert exc["details"]["steps"] == [f"{base}/lab".join(["Open ", ""]), 'Click the button "Show details"']
    assert "TypeError" in exc["details"]["observed"]
    assert {e["role"] for e in exc["evidence"]} == {"before", "after"}
    assert by_rule["broken_text"]["title"] == "'NaN' appeared on the page"
    assert by_rule["not_found"]["details"]["steps"][-1] == 'Click the link "Old offer"'
    # The notes page: the injection is a finding; its "Delete account" stays not tried.
    notes = [f for f in findings if f["path"] == "/notes"]
    assert [f["rule_id"] for f in notes] == ["injection"] and notes[0]["severity"] == "low"
    # Step log: one row per action, outcomes from the fixed set, the blocked step and the findings linked.
    steps = (await client.get(f"{API}/quality-scans/{sess['id']}/steps", headers=owner.headers)).json()["items"]
    assert [s["n"] for s in steps] == list(range(1, 26))
    assert all(s["chosen_by"] == "rules" for s in steps)
    cart = next(s for s in steps if s["action"]["target"]["name"] == "Add to cart")
    assert cart["outcome"] == "blocked" and cart["observations"][0]["text"] == (
        "The page tried to send POST /api/cart. Blocked: exploration never sends data."
    )
    show = next(s for s in steps if s["action"]["target"]["name"] == "Show details")
    assert show["outcome"] == "error" and exc["key"] in show["findings"] and len(show["evidence_ids"]) == 2
    more = next(s for s in steps if s["action"]["target"]["name"] == "More")
    assert more["outcome"] == "ok"
    chain = [s for s in steps if s["page"].startswith("/chain/")]
    assert chain and all(s["action"]["target"]["name"] == "Next page" for s in chain)
    # Drafts: the server error (high) and the uncaught error get grouped drafts; the rest only on request.
    drafts = {d["key"]: d for d in sess["defects"]}
    assert len(drafts) == 2, drafts
    async with ctx.session_factory() as s:
        rows = list((await s.execute(select(Defect).where(Defect.source == DefectSource.exploratory)
                                     .execution_options(**BYPASS))).scalars())  # fmt: skip
        assert {d.severity.value for d in rows} == {"major", "minor"}
        assert all(d.status.value == "draft" and d.steps for d in rows)
        shots = list((await s.execute(select(Evidence).where(Evidence.kind == EvidenceKind.screenshot,
                                                             Evidence.quality_scan_id == uuid.UUID(sess["id"]))
                                      .execution_options(**BYPASS))).scalars())  # fmt: skip
        assert shots
        audit = {a.action for a in (await s.execute(select(AuditLog).execution_options(**BYPASS))).scalars()}
        assert {"exploratory_session.requested", "exploratory_session.started", "exploratory_session.finished"} <= audit
        events = list((await s.execute(select(AgentEvent).where(AgentEvent.type == "exploration.step")
                                       .execution_options(**BYPASS))).scalars())  # fmt: skip
        assert len(events) == 25 and all(set(e.data) == {"scan_key", "n", "outcome"} for e in events)
    # Raise defect on a low finding (on request); viewers can't; other organisations get 404.
    low = by_rule["console_error"]
    r = await client.post(f"{API}/quality-findings/{low['id']}/raise-defect", json={}, headers=owner.headers)
    assert r.status_code == 201, r.text
    assert (await client.get(f"{API}/quality-scans/{sess['id']}", headers=other.headers)).status_code == 404
    assert (await client.get(f"{API}/quality-scans/{sess['id']}/steps", headers=other.headers)).status_code == 404
    assert (await client.get(f"{API}/projects/{pid}/exploratory-sessions", headers=other.headers)).status_code == 404
    evid = exc["evidence"][0]["evidence_id"]
    assert (await client.get(f"{API}/evidence/{evid}", headers=other.headers)).status_code == 404


async def test_chain_ends_at_exactly_the_budget(env: Any) -> None:
    ctx, client, owner, _other, base, site = env
    project = await seed_site(ctx, client, owner, base, ["/chain/1"])
    started = await _start(client, owner.headers, project["id"], {"charter": "chosen", "pages": [project["pages"]["/chain/1"]],
                                                                  "budget": {"actions": 6, "minutes": 2}})  # fmt: skip
    await worker_for(ctx).run_until_idle(timeout=120)
    sess = await _session(client, owner.headers, started["id"])
    assert sess["status"] == "completed" and sess["progress"]["actions_used"] == 6 and sess["end_reason"] == "budget"
    assert sess["never_reached"], "the chain had more to explore"
    assert _writes(site) == set()


async def test_stop_now_ends_within_two_seconds(env: Any) -> None:
    ctx, client, owner, _other, base, site = env
    project = await seed_site(ctx, client, owner, base, ["/chain/1"])
    started = await _start(client, owner.headers, project["id"], {})
    worker = worker_for(ctx)
    task = asyncio.create_task(worker.run_until_idle(timeout=240))
    try:
        for _ in range(600):
            sess = await _session(client, owner.headers, started["id"])
            if sess["progress"]["actions_used"] >= 2:
                break
            await asyncio.sleep(0.1)
        assert sess["status"] == "running", sess
        t0 = time.monotonic()
        r = await client.post(f"{API}/quality-scans/{started['id']}/cancel", headers=owner.headers)
        assert r.status_code == 200, r.text
        while True:
            sess = await _session(client, owner.headers, started["id"])
            if sess["status"] != "running":
                break
            assert time.monotonic() - t0 < 2.0, "Stop now took longer than 2 s"
            await asyncio.sleep(0.05)
        assert sess["status"] == "cancelled" and sess["status_label"] == "Stopped by Ada Tester"
        assert sess["end_text"].startswith("Stopped by Ada Tester after ")
        steps = (await client.get(f"{API}/quality-scans/{started['id']}/steps", headers=owner.headers)).json()["items"]
        assert len(steps) == sess["progress"]["actions_used"] >= 2
    finally:
        await task
    assert _writes(site) == set()


async def test_budget_limits_and_rights(env: Any) -> None:
    ctx, client, owner, other, base, _site = env
    project = await seed_site(ctx, client, owner, base, ["/lab"])
    pid = project["id"]
    url = f"{API}/projects/{pid}/exploratory-sessions"
    r = await client.post(url, json={"budget": {"actions": 61}}, headers=owner.headers)
    assert r.status_code == 422 and r.json()["error"]["message"] == "Your organisation allows up to 60 actions."
    r = await client.post(url, json={"budget": {"minutes": 11}}, headers=owner.headers)
    assert r.status_code == 422 and r.json()["error"]["message"] == "Your organisation allows up to 10 minutes."
    for bad in (0, "5", True, 2.5):  # taken as sent: no coercion of "5" or true
        r = await client.post(url, json={"budget": {"actions": bad}}, headers=owner.headers)
        assert r.status_code == 422 and r.json()["error"]["message"] == "Enter a whole number of actions (1 or more)."
    # The ceiling can be raised by owners and admins, never above the platform cap.
    sets = f"{API}/organisations/{owner.org_id}/settings"
    r = await client.patch(sets, json={"exploration_ceiling": {"actions": 201, "minutes": 10}}, headers=owner.headers)
    assert r.status_code == 422 and r.json()["error"]["message"] == "This server allows up to 200 actions."
    r = await client.patch(sets, json={"exploration_ceiling": {"actions": 120, "minutes": 15}}, headers=owner.headers)
    assert r.status_code == 200 and r.json()["exploration_ceiling"] == {"actions": 120, "minutes": 15}
    assert r.json()["exploration_cap"] == {"actions": 200, "minutes": 20}
    assert r.json()["load_ceiling"] == {"vus": 20, "rps": 20, "duration_s": 300}
    r = await client.post(url, json={"budget": {"actions": 201}}, headers=owner.headers)
    assert r.status_code == 422 and r.json()["error"]["message"] == "Your organisation allows up to 120 actions."
    # Viewers read only; members start anonymous sessions but can't approve or change limits.
    viewer = await _join(ctx, client, owner, Role.viewer, False)
    member = await _join(ctx, client, owner, Role.member, False)
    assert (await client.post(url, json={}, headers=viewer)).status_code == 403
    assert (await client.patch(sets, json={"exploration_ceiling": {"actions": 10, "minutes": 1}},
                               headers=member)).status_code == 403  # fmt: skip
    listing = (await client.get(url, headers=viewer)).json()
    assert listing["permissions"] == {"can_start": False, "can_approve": False, "can_edit_limits": False}
    assert listing["limits"]["organisation"] == {"actions": 120, "minutes": 15}
    assert listing["options"]["default_charter"] == "all" and listing["gate"]["ok"] is True
    started = await _start(client, member, pid, {"charter": "all", "budget": {"actions": 1}})
    assert started["permissions"]["can_stop"] is True
    r = await client.post(url, json={}, headers=owner.headers)
    assert r.status_code == 409 and "One session at a time" in r.json()["error"]["message"]
    # A viewer and another member can't stop it; the owner (an approver) can.
    viewer_stop = await client.post(f"{API}/quality-scans/{started['id']}/cancel", headers=viewer)
    assert viewer_stop.status_code == 403
    other_member = await _join(ctx, client, owner, Role.member, False)
    assert (await client.post(f"{API}/quality-scans/{started['id']}/cancel", headers=other_member)).status_code == 403
    r = await client.post(f"{API}/quality-scans/{started['id']}/cancel", headers=owner.headers)
    assert r.status_code == 200 and r.json()["scan"]["status"] == "cancelled"
    # Another organisation: 404 on every endpoint.
    for method, path in (("post", url), ("get", url), ("post", f"{API}/quality-scans/{started['id']}/cancel"),
                         ("post", f"{API}/quality-scans/{started['id']}/withdraw")):  # fmt: skip
        r = await getattr(client, method)(path, headers=other.headers, **({"json": {}} if method == "post" else {}))
        assert r.status_code == 404, (path, r.text)


async def test_signed_in_session_waits_for_a_typed_host_approval(env: Any) -> None:
    ctx, client, owner, _other, base, site = env
    project = await seed_site(ctx, client, owner, base, ["/lab", "/account"], signed_in=("/account",))
    pid = project["id"]
    url = f"{API}/projects/{pid}/exploratory-sessions"
    member = await _join(ctx, client, owner, Role.member, False)
    r = await client.post(url, json={"signed_in": True}, headers=member)
    assert r.status_code == 422 and r.json()["error"]["message"] == "Save test credentials to explore signed in."
    put = await client.put(f"{API}/projects/{pid}/secrets/scan_credentials", headers=owner.headers,
                           json={"login_url": f"{base}/login", "username": USER, "password": PASSWORD})  # fmt: skip
    assert put.status_code == 201, put.text
    site.requests.clear()
    req = await _start(client, member, pid, {"signed_in": True, "charter": "chosen",
                                             "pages": [project["pages"]["/account"]], "budget": {"actions": 5}})  # fmt: skip
    assert req["status"] == "awaiting_approval" and req["status_label"] == "Waiting for approval"
    assert req["message"] == f"{req['key']} requested. Someone who can approve must approve it."
    host = "127.0.0.1"
    assert req["summary_sentence"] == (
        f"Explore 1 page on {base.split('://')[1]} signed in with the saved test account, for up to 5 actions and "
        "10 minutes."
    )
    approval = req["approval"]
    assert approval["status"] == "pending" and approval["confirm_prompt"] == f"Type {host} to approve"
    assert req["permissions"]["can_approve"] is False and req["permissions"]["can_withdraw"] is True
    # Nothing contacts the site while it waits.
    await worker_for(ctx).run_until_idle(timeout=30)
    assert site.requests == []
    decide = f"{API}/approvals/{approval['id']}/decision"
    r = await client.post(decide, json={"decision": "approve", "confirm_text": host}, headers=member)
    assert r.status_code == 403, r.text
    r = await client.post(decide, json={"decision": "approve", "confirm_text": "example.com"}, headers=owner.headers)
    assert r.status_code == 422 and r.json()["error"]["message"] == f"Type {host} exactly to approve."
    r = await client.post(decide, json={"decision": "approve", "confirm_text": f" {host.upper()} "},
                          headers=owner.headers)  # fmt: skip
    assert r.status_code == 200 and r.json()["status"] == "queued", r.text
    assert r.json()["approval"]["host_typed"] is True and r.json()["approved_by"]["full_name"] == "Ada Tester"
    await worker_for(ctx).run_until_idle(timeout=180)
    sess = await _session(client, owner.headers, req["id"])
    assert sess["status"] == "completed" and sess["signed_in"] is True, sess
    assert sess["approval"]["status"] == "used"
    # Only the P2-01 sign-in form was posted; the sign-out link was never followed.
    assert [(m, p) for m, p in site.requests if m not in ("GET", "HEAD")] == [("POST", "/login")]
    assert "/logout" not in {p for _, p in site.requests}
    # "Sign out" goes where the menu's "Log out" goes: listed once (links are fingerprinted by destination).
    assert ('Link "Log out"', "Would end the session") in {(n["element"], n["reason"]) for n in sess["not_tried"]}
    assert next(c for c in sess["coverage"] if c["page"] == "/account")["visited"] is True
    steps = (await client.get(f"{API}/quality-scans/{req['id']}/steps", headers=owner.headers)).json()["items"]
    assert "Details" in {x["action"]["target"]["name"] for x in steps}  # only there when signed in
    # No credential in steps, findings, evidence metadata, events or the session.
    async with ctx.session_factory() as s:
        steps = [(x.action, x.observations, x.page_url) for x in (await s.execute(
            select(ExploratoryStep).execution_options(**BYPASS))).scalars()]  # fmt: skip
        found = [(f.title, f.mapped, f.nodes) for f in (await s.execute(
            select(QualityFinding).execution_options(**BYPASS))).scalars()]  # fmt: skip
        ev = [(e.meta, e.source_url) for e in (await s.execute(select(Evidence).execution_options(**BYPASS))).scalars()]
        events = [
            (e.message, e.data) for e in (await s.execute(select(AgentEvent).execution_options(**BYPASS))).scalars()
        ]
    blob = json.dumps([steps, found, ev, events, sess], default=str)
    assert USER not in blob and PASSWORD not in blob
    # A refused request needs a comment and sends nothing; a withdrawn one too.
    req2 = await _start(client, member, pid, {"signed_in": True, "charter": "chosen",
                                              "pages": [project["pages"]["/account"]]})  # fmt: skip
    d2 = f"{API}/approvals/{req2['approval']['id']}/decision"
    r = await client.post(d2, json={"decision": "reject"}, headers=owner.headers)
    assert r.status_code == 422 and r.json()["error"]["message"] == "Say why this session shouldn't run."
    r = await client.post(d2, json={"decision": "reject", "comment": "Not on production"}, headers=owner.headers)
    assert r.status_code == 200 and r.json()["status"] == "rejected"
    assert r.json()["end_text"] == "Not approved. Nothing was sent to the site."
    req3 = await _start(client, member, pid, {"signed_in": True, "charter": "chosen",
                                              "pages": [project["pages"]["/account"]]})  # fmt: skip
    assert (await client.post(f"{API}/quality-scans/{req3['id']}/withdraw", headers=owner.headers)).status_code == 403
    r = await client.post(f"{API}/quality-scans/{req3['id']}/withdraw", headers=member)
    assert r.status_code == 200 and r.json()["status_label"] == "Withdrawn"
    # An approver may request and approve in one go (design open question 5).
    r = await client.post(url, json={"signed_in": True, "charter": "chosen", "pages": [project["pages"]["/account"]],
                                     "approve": True, "confirm_text": host}, headers=owner.headers)  # fmt: skip
    assert r.status_code == 201 and r.json()["status"] == "queued" and r.json()["approval"]["self_approved"] is True
    await client.post(f"{API}/quality-scans/{r.json()['id']}/cancel", headers=owner.headers)


async def test_migration_0021_up_down_up(make_ctx: CtxFactory) -> None:
    """0021 widens `quality_scan_status`; its downgrade turns the three new statuses into `cancelled` first."""
    ctx = await make_ctx(resolver=public_resolver(), transport=site_transport())
    async with client_for(ctx) as client:
        owner = await register(client, "mig21@p6x.example.com", org="Mig 0021")
        pid = uuid.UUID((await create_project(client, owner))["id"])
    async with ctx.session_factory() as s:
        for i, st in enumerate((QualityScanStatus.awaiting_approval, QualityScanStatus.rejected,
                                QualityScanStatus.expired, QualityScanStatus.completed), start=1):  # fmt: skip
            s.add(QualityScan(organisation_id=owner.org_id, project_id=pid, key=f"EXP-000{i}",
                              kind=QualityScanKind.exploratory, status=st))  # fmt: skip
        await s.commit()
    async with ctx.engine.connect() as conn:
        idx = "SELECT COUNT(*) FROM sqlite_master WHERE name = 'uq_quality_scans_one_active_exploration'"
        assert (await conn.execute(text(idx))).scalar_one() == 1
    await downgrade(ctx.engine, "0020")
    async with ctx.engine.connect() as conn:
        rows = dict((await conn.execute(text("SELECT key, status FROM quality_scans"))).all())
        assert rows == {"EXP-0001": "cancelled", "EXP-0002": "cancelled", "EXP-0003": "cancelled",
                        "EXP-0004": "completed"}  # fmt: skip
    with pytest.raises(IntegrityError):
        async with ctx.engine.begin() as conn:
            await conn.execute(text("UPDATE quality_scans SET status = 'awaiting_approval' WHERE key = 'EXP-0004'"))
    async with ctx.engine.connect() as conn:
        assert (await conn.execute(text(idx))).scalar_one() == 0
    await upgrade(ctx.engine)
    async with ctx.engine.begin() as conn:
        await conn.execute(text("UPDATE quality_scans SET status = 'awaiting_approval' WHERE key = 'EXP-0004'"))
        await conn.execute(text("UPDATE quality_scans SET status = 'queued' WHERE key = 'EXP-0001'"))
    with pytest.raises(IntegrityError):  # one queued or running exploratory session per project
        async with ctx.engine.begin() as conn:
            await conn.execute(text("UPDATE quality_scans SET status = 'running' WHERE key = 'EXP-0002'"))
