"""QA round 2 probes for P6-03a fixes: sign-out guard variants, stuck active rows, approve racing start."""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import pytest

from app.agents.exploratory import explorer
from tests.conftest import CtxFactory, client_for, public_resolver, register, site_transport, worker_for
from tests.fixtures.explore_site import running_explore_site
from tests.fixtures.qa_explore_site import running_qa_site
from tests.integration.p5_helpers import API, seed_site

USER, PASSWORD = "qa.r2@fixture.example", "Qa-r2-secret-pw-77"


async def _ctx(make_ctx: CtxFactory) -> Any:
    return await make_ctx(resolver=public_resolver(), transport=site_transport(), allow_private_targets=True,
                          scan_page_timeout_s=5)  # fmt: skip


async def test_sign_out_variants(make_ctx: CtxFactory) -> None:
    ctx = await _ctx(make_ctx)
    with running_qa_site() as (base, site, other):
        async with client_for(ctx) as client:
            owner = await register(client, "r2@qa603.example.com", org="QA r2")
            project = await seed_site(ctx, client, owner, base, ["/r2"])
            r = await client.post(f"{API}/projects/{project['id']}/exploratory-sessions", headers=owner.headers,
                                  json={"charter": "chosen", "pages": [project["pages"]["/r2"]],
                                        "budget": {"actions": 30, "minutes": 3}})  # fmt: skip
            assert r.status_code == 201, r.text
            await worker_for(ctx).run_until_idle(timeout=300)
            sess = (await client.get(f"{API}/quality-scans/{r.json()['id']}", headers=owner.headers)).json()
            steps = (await client.get(f"{API}/quality-scans/{sess['id']}/steps", headers=owner.headers)).json()
            print("R2_STEPS", [(s["n"], s["page"], s["label"], s["outcome"], [o["text"][:90] for o in s["observations"]])
                               for s in steps["items"]])  # fmt: skip
            print("R2_SESS", sess["status"], sess["end_reason"], sess["status_label"], sess["never_reached"])
            print("R2_NT", [(n["element"], n["reason"], n.get("destination")) for n in sess["not_tried"]])
            print("R2_REACHED", site.rec.requests, "OTHER", other.requests)
            assert other.requests == [] and site.rec.writes() == []
            # Top-level navigations (location.replace, a redirect chain, meta refresh) never reach the sign-out URL.
            assert not [p for _, p in site.rec.requests if "via=" in p]
            by = {s["label"]: s for s in steps["items"]}
            assert by['Clicked button "Swap"']["outcome"] == "blocked"
            assert by['Opened link "Hop chain"']["outcome"] == "blocked"
            assert by['Opened link "Meta page"']["outcome"] == "blocked"
            # A page's own fetch / image / iframe GET to the sign-out URL is blocked too, and listed with its reason.
            sub = sorted(p for _, p in site.rec.requests if p.startswith("/logout"))
            assert sub == [], sub
            stopped = {b["request"]: b for b in sess["blocked"] if b.get("reason")}
            assert {"GET /logout", "GET /logout?img=1", "GET /logout?frame=1"} <= set(stopped), stopped
            assert stopped["GET /logout?img=1"]["text"] == (
                "The page tried to open /logout?img=1. Blocked: would end the session."
            )


async def test_crashed_job_leaves_session_queued(make_ctx: CtxFactory, monkeypatch: pytest.MonkeyPatch) -> None:
    ctx = await _ctx(make_ctx)
    with running_qa_site() as (base, _site, _other):
        async with client_for(ctx) as client:
            owner = await register(client, "crash@qa603.example.com", org="QA crash")
            project = await seed_site(ctx, client, owner, base, ["/plain"])
            url = f"{API}/projects/{project['id']}/exploratory-sessions"
            first = (await client.post(url, json={"budget": {"actions": 1}}, headers=owner.headers)).json()

            async def boom(self: Any) -> None:
                raise RuntimeError("database went away")

            monkeypatch.setattr(explorer.ExploreJob, "run", boom)
            await worker_for(ctx).run_until_idle(timeout=60)
            monkeypatch.undo()
            s1 = (await client.get(f"{API}/quality-scans/{first['id']}", headers=owner.headers)).json()
            r = await client.post(url, json={"budget": {"actions": 1}}, headers=owner.headers)
            print("CRASH", s1["status"], s1["status_label"], s1.get("error"), "new start:", r.status_code, r.text[:150])
            assert s1["status"] != "queued", "a crashed job leaves the session queued, blocking the project"
            assert s1["status"] == "failed" and s1["error"] == "The session's job failed on the server (RuntimeError)"
            assert r.status_code == 201, r.text  # the project is free again


async def test_approve_racing_anonymous_start(make_ctx: CtxFactory) -> None:
    ctx = await _ctx(make_ctx)
    with running_explore_site(credentials=(USER, PASSWORD)) as (base, _site):
        async with client_for(ctx) as client:
            owner = await register(client, "race@qa603.example.com", org="QA race")
            project = await seed_site(ctx, client, owner, base, ["/lab", "/account"], signed_in=("/account",))
            pid = project["id"]
            put = await client.put(f"{API}/projects/{pid}/secrets/scan_credentials", headers=owner.headers,
                                   json={"login_url": f"{base}/login", "username": USER, "password": PASSWORD})  # fmt: skip
            assert put.status_code == 201
            url = f"{API}/projects/{pid}/exploratory-sessions"
            for _ in range(3):
                req = (await client.post(url, json={"signed_in": True}, headers=owner.headers)).json()
                dec = f"{API}/approvals/{req['approval']['id']}/decision"
                a, b = await asyncio.gather(
                    client.post(dec, json={"decision": "approve", "confirm_text": "127.0.0.1"}, headers=owner.headers),
                    client.post(url, json={"budget": {"actions": 1}}, headers=owner.headers),
                )
                print("RACE", a.status_code, b.status_code, a.text[:100], b.text[:100])
                assert sorted([a.status_code, b.status_code]) in ([200, 409], [201, 409]), (a.text, b.text)
                listing = (await client.get(url, headers=owner.headers)).json()
                active = [x["key"] for x in listing["items"] if x["status"] in ("queued", "running")]
                assert len(active) == 1, active
                sid = next(x["id"] for x in listing["items"] if x["status"] == "queued")
                stop = await client.post(f"{API}/quality-scans/{sid}/cancel", headers=owner.headers)
                assert stop.status_code == 200
                # The losing approval: still decidable later, or clearly not.
                req_now = (await client.get(f"{API}/quality-scans/{req['id']}", headers=owner.headers)).json()
                print("LOSER", req_now["status"], req_now["approval"]["status"])
            # After a cancel-while-queued, a new start is allowed.
            r = await client.post(url, json={"budget": {"actions": 1}}, headers=owner.headers)
            assert r.status_code == 201, r.text
            uuid.UUID(r.json()["id"])
