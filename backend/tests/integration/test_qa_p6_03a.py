"""QA probes for P6-03a (independent of the developer's tests).

Adversarial writes (beacon, keepalive, XHR, WebSocket, scripted form posts, worker, iframe, popup), `form=` and
`<input type=image>`, redirects to another origin and to /logout, dialogs, Stop now on a slow page, approval expiry,
concurrent starts, a load test on the project, platform cap, lowered ceiling, repeat sessions and G8 for drafts.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import AsyncIterator
from datetime import timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy import select

from app.config import Settings
from app.context import AppContext
from app.db.models import Approval, Defect, Organisation, QualityScan
from app.db.tenant import BYPASS
from app.db.types import utcnow
from app.domain.enums import DefectSource
from tests.conftest import Account, CtxFactory, client_for, public_resolver, register, site_transport, worker_for
from tests.fixtures.explore_site import running_explore_site
from tests.fixtures.qa_explore_site import running_qa_site
from tests.integration.p5_helpers import API, seed_site

USER, PASSWORD = "qa.p603a@fixture.example", "Qa-secret-pw-0193"


async def _ctx(make_ctx: CtxFactory, **kw: Any) -> AppContext:
    return await make_ctx(resolver=public_resolver(), transport=site_transport(), allow_private_targets=True,
                          scan_page_timeout_s=kw.pop("scan_page_timeout_s", 5), **kw)  # fmt: skip


async def _start(client: httpx.AsyncClient, h: dict[str, str], pid: str, body: dict[str, Any]) -> dict[str, Any]:
    r = await client.post(f"{API}/projects/{pid}/exploratory-sessions", json=body, headers=h)
    assert r.status_code == 201, r.text
    return dict(r.json())


async def _get(client: httpx.AsyncClient, h: dict[str, str], sid: str) -> dict[str, Any]:
    r = await client.get(f"{API}/quality-scans/{sid}", headers=h)
    assert r.status_code == 200, r.text
    return dict(r.json())


@pytest.fixture
async def adv(make_ctx: CtxFactory) -> AsyncIterator[tuple[AppContext, httpx.AsyncClient, Account, str, Any, Any]]:
    ctx = await _ctx(make_ctx)
    with running_qa_site() as (base, site, other):
        async with client_for(ctx) as c:
            owner = await register(c, "owner@qa603.example.com", org="QA 603")
            yield ctx, c, owner, base, site, other


async def test_adversarial_writes_never_reach_any_site(adv: Any) -> None:
    ctx, client, owner, base, site, other = adv
    project = await seed_site(ctx, client, owner, base, ["/adv"])
    started = await _start(client, owner.headers, project["id"], {"charter": "chosen",
                           "pages": [project["pages"]["/adv"]], "budget": {"actions": 60, "minutes": 5}})  # fmt: skip
    await worker_for(ctx).run_until_idle(timeout=400)
    sess = await _get(client, owner.headers, started["id"])
    assert sess["status"] == "completed", sess
    # The hard guarantee: no non-read request reached the target, nothing at all reached another origin.
    assert site.rec.writes() == [], site.rec.writes()
    assert other.requests == [], other.requests
    reached = {p.split("?")[0] for _, p in site.rec.requests}
    print("REACHED", sorted(reached))
    print("BLOCKED", [b["request"] for b in sess["blocked"]])
    print("NOT_TRIED", [(n["element"], n["reason"]) for n in sess["not_tried"]])
    steps = (await client.get(f"{API}/quality-scans/{sess['id']}/steps", headers=owner.headers)).json()["items"]
    print("STEPS", [(s["n"], s["label"], s["outcome"]) for s in steps])
    blocked = {b["request"] for b in sess["blocked"]}
    for want in ("PUT /w/xhr", "POST /w/jsform", "POST /w/reqsubmit"):
        assert want in blocked, (want, blocked)
    not_tried = {(n["element"], n["reason"]) for n in sess["not_tried"]}
    assert ('Button "Go there"', "Submits a form") in not_tried
    assert ('Button "Picture go"', "Submits a form") in not_tried
    # Session survived dialogs and the beforeunload guard: every step recorded, no failure.
    assert sess["error"] is None


async def test_sign_out_url_never_reached(adv: Any) -> None:
    """A same-origin link whose server redirects to /logout: the skip list only sees the link's href."""
    ctx, client, owner, base, site, _other = adv
    project = await seed_site(ctx, client, owner, base, ["/links"])
    st = await _start(client, owner.headers, project["id"], {"charter": "chosen", "pages": [project["pages"]["/links"]],
                                                         "budget": {"actions": 60, "minutes": 5}})  # fmt: skip
    await worker_for(ctx).run_until_idle(timeout=400)
    sess = await _get(client, owner.headers, st["id"])
    steps = (await client.get(f"{API}/quality-scans/{st['id']}/steps", headers=owner.headers)).json()["items"]
    print(
        "LINK_STEPS",
        [(s["n"], s["page"], s["label"], s["outcome"], [o["text"][:80] for o in s["observations"]]) for s in steps],
    )
    print("LINK_REACHED", site.rec.requests, "OTHER", _other.requests, "NT", sess["not_tried"])
    assert _other.requests == [] and site.rec.writes() == []
    hits = [p for _, p in site.rec.requests if p.startswith("/logout")]
    # Recorded as an observation for the report; the explorer reaches /logout through a redirect.
    print("LOGOUT_HITS", hits)
    assert hits == [], "a redirect to the sign-out URL was followed"


async def test_stop_on_slow_page_within_two_seconds(make_ctx: CtxFactory) -> None:
    ctx = await _ctx(make_ctx, scan_page_timeout_s=20)
    with running_qa_site(slow_s=8) as (base, site, _other):
        async with client_for(ctx) as client:
            owner = await register(client, "slow@qa603.example.com", org="QA slow")
            project = await seed_site(ctx, client, owner, base, ["/slow"])
            started = await _start(client, owner.headers, project["id"], {})
            task = asyncio.create_task(worker_for(ctx).run_until_idle(timeout=120))
            try:
                for _ in range(300):
                    sess = await _get(client, owner.headers, started["id"])
                    if sess["status"] == "running" and any(p == "/slow" for _, p in site.rec.requests):
                        break
                    await asyncio.sleep(0.05)
                assert sess["status"] == "running"
                t0 = time.monotonic()
                r = await client.post(f"{API}/quality-scans/{started['id']}/cancel", headers=owner.headers)
                assert r.status_code == 200, r.text
                while (sess := await _get(client, owner.headers, started["id"]))["status"] == "running":
                    assert time.monotonic() - t0 < 2.0, "Stop now took longer than 2 s on a slow page"
                    await asyncio.sleep(0.05)
                assert sess["status"] == "cancelled", sess
                assert time.monotonic() - t0 < 2.0
                # Stopping a finished session again: 409.
                r = await client.post(f"{API}/quality-scans/{started['id']}/cancel", headers=owner.headers)
                assert r.status_code == 409
            finally:
                await task


async def test_approval_expiry_late_decision_and_rights(make_ctx: CtxFactory) -> None:
    ctx = await _ctx(make_ctx)
    with running_explore_site(credentials=(USER, PASSWORD)) as (base, site):
        async with client_for(ctx) as client:
            owner = await register(client, "exp@qa603.example.com", org="QA expiry")
            other = await register(client, "otherorg@qa603.example.com", org="QA other")
            project = await seed_site(ctx, client, owner, base, ["/lab", "/account"], signed_in=("/account",))
            pid = project["id"]
            put = await client.put(f"{API}/projects/{pid}/secrets/scan_credentials", headers=owner.headers,
                                   json={"login_url": f"{base}/login", "username": USER, "password": PASSWORD})  # fmt: skip
            assert put.status_code == 201, put.text
            req = await _start(client, owner.headers, pid, {"signed_in": True})
            assert req["status"] == "awaiting_approval"
            aid = req["approval"]["id"]
            # Stop on a waiting request: 409 (withdraw or decide instead).
            r = await client.post(f"{API}/quality-scans/{req['id']}/cancel", headers=owner.headers)
            assert r.status_code == 409, r.text
            # Another organisation can't decide it.
            r = await client.post(f"{API}/approvals/{aid}/decision", json={"decision": "approve",
                                  "confirm_text": "127.0.0.1"}, headers=other.headers)  # fmt: skip
            assert r.status_code == 404, r.text
            # Wrong-case/space host accepted; but first: expire it.
            async with ctx.session_factory() as s:
                a = await s.get(Approval, uuid.UUID(aid), execution_options=BYPASS)
                assert a is not None
                a.expires_at = utcnow() - timedelta(minutes=1)
                await s.commit()
            r = await client.post(f"{API}/approvals/{aid}/decision", json={"decision": "approve",
                                  "confirm_text": "127.0.0.1"}, headers=owner.headers)  # fmt: skip
            assert r.status_code == 409, r.text
            sess = await _get(client, owner.headers, req["id"])
            assert sess["status"] == "expired" and sess["status_label"] == "Request expired"
            assert sess["end_text"] == "This request expired after 24 hours. Nothing was sent to the site."
            await worker_for(ctx).run_until_idle(timeout=30)
            assert site.requests == []
            # Withdraw an expired one: 409.
            r = await client.post(f"{API}/quality-scans/{req['id']}/withdraw", headers=owner.headers)
            assert r.status_code == 409
            # Decide twice: the second is 409.
            req2 = await _start(client, owner.headers, pid, {"signed_in": True})
            d2 = f"{API}/approvals/{req2['approval']['id']}/decision"
            r = await client.post(d2, json={"decision": "reject", "comment": "no"}, headers=owner.headers)
            assert r.status_code == 200
            r = await client.post(d2, json={"decision": "approve", "confirm_text": "127.0.0.1"}, headers=owner.headers)
            assert r.status_code == 409, r.text


async def test_unknown_charter_and_budget_types(adv: Any) -> None:
    ctx, client, owner, base, _site, _other = adv
    project = await seed_site(ctx, client, owner, base, ["/adv"])
    url = f"{API}/projects/{project['id']}/exploratory-sessions"
    r = await client.post(url, json={"charter": "everything"}, headers=owner.headers)
    assert r.status_code == 422 and r.json()["error"]["message"] == "Choose what to explore"
    for bad in ({"actions": 1.5}, {"minutes": -1}, {"actions": 0}):
        r = await client.post(url, json={"budget": bad}, headers=owner.headers)
        assert r.status_code == 422, (bad, r.text)
    r = await client.post(url, json={"budget": {"actions": 5, "pages": 3}}, headers=owner.headers)
    assert r.status_code == 422
    r = await client.post(url, json={"charter": "chosen", "pages": []}, headers=owner.headers)
    assert r.status_code == 422 and r.json()["error"]["message"] == "Choose at least one page."
    r = await client.post(url, json={"charter": "chosen", "pages": [str(uuid.uuid4())]}, headers=owner.headers)
    assert r.status_code == 422
    r = await client.post(url, json={"charter": "open_defects"}, headers=owner.headers)
    assert r.status_code == 422 and r.json()["error"]["message"] == "No page has an open defect."
    r = await client.post(url, json={"charter": "change_set"}, headers=owner.headers)
    assert r.status_code == 422
    # Nothing was created by any of those.
    listing = (await client.get(url, headers=owner.headers)).json()
    assert listing["items"] == []


async def test_concurrent_starts_only_one_session(adv: Any) -> None:
    ctx, client, owner, base, _site, _other = adv
    project = await seed_site(ctx, client, owner, base, ["/adv"])
    url = f"{API}/projects/{project['id']}/exploratory-sessions"
    rs = await asyncio.gather(*(client.post(url, json={"budget": {"actions": 1}}, headers=owner.headers)
                                for _ in range(3)))  # fmt: skip
    codes = sorted(r.status_code for r in rs)
    print("CONCURRENT", codes, [r.text[:120] for r in rs])
    assert codes.count(201) == 1, codes


async def test_waits_for_a_running_load_test(adv: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import exploratory as esvc

    ctx, client, owner, base, site, _other = adv
    project = await seed_site(ctx, client, owner, base, ["/adv"])
    pid = uuid.UUID(project["id"])

    async def perf(_s: Any, _pid: Any) -> str:
        return "PERF-0001"

    monkeypatch.setattr(esvc, "perf_running", perf)
    started = await _start(client, owner.headers, project["id"], {"budget": {"actions": 2}})
    listing = (await client.get(f"{API}/projects/{pid}/exploratory-sessions", headers=owner.headers)).json()
    assert listing["queued_note"] == "PERF-0001 is running on this project. Exploration waits until it finishes."
    await worker_for(ctx).run_until_idle(timeout=30)
    sess = await _get(client, owner.headers, started["id"])
    assert sess["status"] == "queued", sess
    assert site.rec.requests == []


async def test_platform_cap_and_lowered_ceiling(make_ctx: CtxFactory) -> None:
    with pytest.raises(ValueError):
        Settings(explore_max_actions=201)  # type: ignore[call-arg]
    with pytest.raises(ValueError):
        Settings(explore_max_minutes=0)  # type: ignore[call-arg]
    ctx = await _ctx(make_ctx, explore_max_actions=30, explore_max_minutes=5)
    with running_qa_site() as (base, site, _other):
        async with client_for(ctx) as client:
            owner = await register(client, "cap@qa603.example.com", org="QA cap")
            project = await seed_site(ctx, client, owner, base, ["/adv"])
            url = f"{API}/projects/{project['id']}/exploratory-sessions"
            r = await client.post(url, json={"budget": {"actions": 31}}, headers=owner.headers)
            assert r.status_code == 422 and r.json()["error"]["message"] == "This server allows up to 30 actions."
            r = await client.post(url, json={"budget": {"minutes": 6}}, headers=owner.headers)
            assert r.status_code == 422 and r.json()["error"]["message"] == "This server allows up to 5 minutes."
            listing = (await client.get(url, headers=owner.headers)).json()
            assert listing["limits"]["organisation"] == {"actions": 30, "minutes": 5}
            # Default budget = effective ceiling.
            started = await _start(client, owner.headers, project["id"], {})
            assert started["budget"] == {"actions": 30, "minutes": 5}
            # The ceiling is lowered before the job starts: it fails with the limit named, sends nothing.
            r = await client.patch(f"{API}/organisations/{owner.org_id}/settings",
                                   json={"exploration_ceiling": {"actions": 10, "minutes": 5}}, headers=owner.headers)  # fmt: skip
            assert r.status_code == 200, r.text
            await worker_for(ctx).run_until_idle(timeout=60)
            sess = await _get(client, owner.headers, started["id"])
            assert sess["status"] == "failed" and "Your organisation allows up to 10 actions." in sess["error"], sess
            assert site.rec.requests == []
            async with ctx.session_factory() as s:
                org = await s.get(Organisation, owner.org_id, execution_options=BYPASS)
                assert org is not None and org.settings["exploration_ceiling"] == {"actions": 10, "minutes": 5}


async def test_repeat_session_reuses_drafts_and_g8_reject(make_ctx: CtxFactory) -> None:
    ctx = await _ctx(make_ctx)
    with running_explore_site() as (base, _site):
        async with client_for(ctx) as client:
            owner = await register(client, "rep@qa603.example.com", org="QA repeat")
            project = await seed_site(ctx, client, owner, base, ["/lab"])
            body = {"charter": "chosen", "pages": [project["pages"]["/lab"]], "budget": {"actions": 12}}
            s1 = await _start(client, owner.headers, project["id"], body)
            await worker_for(ctx).run_until_idle(timeout=300)
            s1 = await _get(client, owner.headers, s1["id"])
            s2 = await _start(client, owner.headers, project["id"], body)
            await worker_for(ctx).run_until_idle(timeout=300)
            s2 = await _get(client, owner.headers, s2["id"])
            assert s1["status"] == s2["status"] == "completed"
            async with ctx.session_factory() as s:
                drafts = list((await s.execute(select(Defect).where(Defect.source == DefectSource.exploratory)
                                               .execution_options(**BYPASS))).scalars())  # fmt: skip
                sc2 = (await s.execute(select(QualityScan).where(QualityScan.key == s2["key"])
                                       .execution_options(**BYPASS))).scalar_one()  # fmt: skip
            print(
                "DRAFTS",
                [(d.key, d.summary) for d in drafts],
                sc2.summary.get("drafted"),
                sc2.summary.get("occurrences_added"),
            )
            assert len(drafts) == len(s1["defects"]) >= 1, "the second session duplicated drafts"
            assert sc2.summary.get("drafted") == [] and sc2.summary.get("occurrences_added")
            f2 = (await client.get(f"{API}/quality-scans/{s2['id']}/findings", headers=owner.headers)).json()["items"]
            print("SEEN", [(f["key"], f.get("seen_before")) for f in f2][:5])
            # G8: rejecting an exploratory draft as "accepted risk" (like the other non-functional drafts).
            d = drafts[0]
            dl = (await client.get(f"{API}/projects/{project['id']}/defects", headers=owner.headers)).json()
            row = next(x for x in dl["items"] if x["key"] == d.key)
            print("WHY", row.get("why"), row.get("source"))
            r = await client.post(f"{API}/defects/{d.id}/status", headers=owner.headers,
                                  json={"action": "reject", "reason": "accepted_risk", "comment": "Known, low impact",
                                        "mark_findings": True})  # fmt: skip
            print("REJECT", r.status_code, r.text[:300])
            assert row.get("why"), "Gate 8 'Why' line missing for an exploratory draft (design §9.8)"
            assert r.status_code == 200, r.text


async def test_beforeunload_guard_does_not_drop_the_rest_of_the_page(adv: Any) -> None:
    ctx, client, owner, base, site, _other = adv
    project = await seed_site(ctx, client, owner, base, ["/guard"])
    started = await _start(client, owner.headers, project["id"], {"charter": "chosen",
                           "pages": [project["pages"]["/guard"]], "budget": {"actions": 20, "minutes": 3}})  # fmt: skip
    await worker_for(ctx).run_until_idle(timeout=200)
    sess = await _get(client, owner.headers, started["id"])
    steps = (await client.get(f"{API}/quality-scans/{sess['id']}/steps", headers=owner.headers)).json()["items"]
    print(
        "GUARD_STEPS", [(s["n"], s["label"], s["outcome"], [o["text"][:80] for o in s["observations"]]) for s in steps]
    )
    print(
        "GUARD_SESS", sess["status"], sess["end_reason"], sess["status_label"], sess["end_text"], sess["never_reached"]
    )
    print("GUARD_REACHED", site.rec.requests)
    assert not (sess["end_reason"] == "exhausted" and sess["never_reached"]), "claims every action tried"
    names = {s["action"]["target"]["name"] for s in steps}
    assert {"Guard", "Beta", "Alpha", "Orders"} <= names, names


async def test_worker_writes_are_blocked_and_listed(adv: Any) -> None:
    ctx, client, owner, base, site, _other = adv
    project = await seed_site(ctx, client, owner, base, ["/worker"])
    started = await _start(client, owner.headers, project["id"], {"charter": "chosen",
                           "pages": [project["pages"]["/worker"]], "budget": {"actions": 10, "minutes": 3}})  # fmt: skip
    await worker_for(ctx).run_until_idle(timeout=200)
    sess = await _get(client, owner.headers, started["id"])
    steps = (await client.get(f"{API}/quality-scans/{sess['id']}/steps", headers=owner.headers)).json()["items"]
    found = (await client.get(f"{API}/quality-scans/{sess['id']}/findings", headers=owner.headers)).json()["items"]
    print(
        "WORKER_STEPS",
        [(s["n"], s["label"], s["outcome"], [o["text"][:120] for o in s["observations"]]) for s in steps],
    )
    print("WORKER_FINDINGS", [(f["rule_id"], f["title"], (f.get("details") or {}).get("observed")) for f in found])
    print("WORKER_BLOCKED", sess["blocked"], "REACHED", site.rec.requests)
    assert site.rec.writes() == []


async def test_concurrent_sessions_never_run_together(adv: Any) -> None:
    ctx, client, owner, base, _site, _other = adv
    project = await seed_site(ctx, client, owner, base, ["/guard"])
    url = f"{API}/projects/{project['id']}/exploratory-sessions"
    rs = await asyncio.gather(*(client.post(url, json={"budget": {"actions": 4}}, headers=owner.headers)
                                for _ in range(2)))  # fmt: skip
    ids = [r.json()["id"] for r in rs if r.status_code == 201]
    seen_both = False
    task = asyncio.create_task(worker_for(ctx).run_until_idle(timeout=200))
    try:
        while not task.done():
            st = [(await _get(client, owner.headers, i))["status"] for i in ids]
            if st.count("running") >= 2:
                seen_both = True
            await asyncio.sleep(0.05)
    finally:
        await task
    print("BOTH_RUNNING", seen_both, len(ids))
    assert not seen_both, "two exploratory sessions ran at the same time on one project"


async def test_restart_safety_running_session_fails_with_steps_kept(adv: Any) -> None:
    from app.domain.enums import QualityScanStatus
    from app.services import exploratory as esvc

    ctx, client, owner, base, _site, _other = adv
    project = await seed_site(ctx, client, owner, base, ["/guard"])
    started = await _start(client, owner.headers, project["id"], {"budget": {"actions": 2}})
    async with ctx.session_factory() as s:
        sc = await s.get(QualityScan, uuid.UUID(started["id"]), execution_options=BYPASS)
        assert sc is not None
        sc.status = QualityScanStatus.running  # as if the worker died mid-session and the job is picked up again
        await s.commit()
        await esvc.enqueue(ctx, sc)
    await worker_for(ctx).run_until_idle(timeout=60)
    sess = await _get(client, owner.headers, started["id"])
    assert sess["status"] == "failed" and sess["error"] == "The worker stopped", sess
    assert sess["end_text"].startswith("Didn't complete: The worker stopped.")
