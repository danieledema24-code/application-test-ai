"""Discovery variants: page limit, G2 required policy, locked gates, pause/resume, AI-on validation (T11/T16)."""

from __future__ import annotations

import json
import re
from typing import Any

from app.context import AppContext
from app.llm.base import Budget, FakeLLM, RawCompletion
from app.llm.untrusted import TAG
from tests.conftest import client_for, register, worker_for
from tests.fixtures.site import PREFILLED_SECRET, running_site

API = "/api/v1"


def _body(url: str, **scan: Any) -> dict[str, Any]:
    return {
        "url": url,
        "start": True,
        "scan": {"max_pages": 30, **scan},
        "authorisation": {"attested": True, "statement": "Local fixture site owned by the test suite."},
    }


async def test_page_limit_is_respected_and_reported(make_ctx) -> None:  # type: ignore[no-untyped-def]
    ctx: AppContext = await make_ctx(allow_private_targets=True, scan_mobile_sample_pages=1)
    with running_site() as (url, site):
        async with client_for(ctx) as c:
            acct = await register(c)
            p = (await c.post(f"{API}/projects", json=_body(url, max_pages=5), headers=acct.headers)).json()
            await worker_for(ctx).run_until_idle(timeout=180)
            scan = (await c.get(f"{API}/projects/{p['id']}/discovery", headers=acct.headers)).json()
    assert scan["status"] == "completed"
    assert scan["stats"]["pages"] == 5
    assert scan["completeness"]["rating"] != "good"
    assert any("limit" in lim.lower() for lim in scan["limitations"])
    assert scan["not_visited"], "pages beyond the limit are listed as not visited"
    assert len({p for m, p in site.requests if not p.startswith(("/robots.txt", "/sitemap"))}) <= 6


async def test_required_g2_waits_for_approval(make_ctx) -> None:  # type: ignore[no-untyped-def]
    ctx: AppContext = await make_ctx(allow_private_targets=True, scan_mobile_sample_pages=0)
    with running_site() as (url, _site):
        async with client_for(ctx) as c:
            acct = await register(c)
            body = _body(url, max_pages=3)
            body["start"] = False
            p = (await c.post(f"{API}/projects", json=body, headers=acct.headers)).json()
            for gate in ("G1", "G7"):
                bad = await c.patch(
                    f"{API}/projects/{p['id']}",
                    headers=acct.headers,
                    json={"version": p["version"], "approval_policy": {gate: "auto"}},
                )
                assert bad.status_code == 422, gate
            ok = await c.patch(
                f"{API}/projects/{p['id']}",
                headers=acct.headers,
                json={"version": p["version"], "approval_policy": {"G2": "required"}},
            )
            assert ok.status_code == 200 and ok.json()["approval_policy"]["G2"] == "required"
            stale = await c.patch(
                f"{API}/projects/{p['id']}", headers=acct.headers, json={"version": p["version"], "name": "stale write"}
            )
            assert stale.status_code == 409
            run = await c.post(f"{API}/projects/{p['id']}/stages/discovery/run", json={}, headers=acct.headers)
            assert run.status_code == 202
            await worker_for(ctx).run_until_idle(timeout=180)
            wf = (await c.get(f"{API}/projects/{p['id']}/workflow", headers=acct.headers)).json()
            d = next(s for s in wf["stages"] if s["key"] == "discovery")
            assert d["status"] == "awaiting_approval" and d["gate"]["status"] == "pending"
            waiting = (await c.get(f"{API}/projects?status=awaiting_approval", headers=acct.headers)).json()["items"]
            assert [x["id"] for x in waiting] == [p["id"]]
            events = (await c.get(f"{API}/projects/{p['id']}/events?limit=100", headers=acct.headers)).json()["items"]
            assert any(e["type"] == "gate.awaiting_approval" for e in events)
            rej = await c.post(
                f"{API}/projects/{p['id']}/gates/G2/decision",
                headers=acct.headers,
                json={
                    "decision": "request_changes",
                    "comment": "Scan the help centre too.",
                    "stage_run_version": d["current_version"],
                },
            )
            assert rej.status_code == 200 and rej.json()["status"] == "changes_requested"


async def test_pause_and_resume_queued_discovery(make_ctx) -> None:  # type: ignore[no-untyped-def]
    ctx: AppContext = await make_ctx(allow_private_targets=True, scan_mobile_sample_pages=0)
    with running_site() as (url, _site):
        async with client_for(ctx) as c:
            acct = await register(c)
            p = (await c.post(f"{API}/projects", json=_body(url, max_pages=2), headers=acct.headers)).json()
            paused = await c.post(f"{API}/projects/{p['id']}/workflow/pause", headers=acct.headers)
            assert paused.status_code == 200 and paused.json()["project_status"] == "paused"
            await worker_for(ctx).run_until_idle(timeout=60)
            scan = (await c.get(f"{API}/projects/{p['id']}/discovery", headers=acct.headers)).json()
            assert scan["status"] in ("paused", "queued") and scan["stats"]["pages"] == 0
            resumed = await c.post(f"{API}/projects/{p['id']}/workflow/resume", headers=acct.headers)
            assert resumed.status_code == 200 and resumed.json()["project_status"] == "active"
            await worker_for(ctx).run_until_idle(timeout=120)
            scan = (await c.get(f"{API}/projects/{p['id']}/discovery", headers=acct.headers)).json()
            assert scan["status"] == "completed" and scan["stats"]["pages"] == 2


class ScriptedAnalysis(FakeLLM):
    """Answers with output that mixes valid references with invented page ids, evidence ids and URLs."""

    async def _complete(self, system: str, user: str, schema: dict[str, Any], budget: Budget) -> RawCompletion:
        self.captured.append({"system": system, "user": user})
        pages = re.findall(r'\\?"page_id\\?": ?\\?"([0-9a-f-]{36})', user)
        evid = re.findall(r'\\?"evidence_ids\\?": ?\[\\?"([0-9a-f-]{36})', user)
        assert pages and evid
        data = {
            "summary": "AI summary: the fixture shop has a catalogue, contact form and sign-in. Coverage is partial.",
            "features": [
                {
                    "name": "Product catalogue",
                    "description": "Lists products.",
                    "category": "content",
                    "page_ids": [pages[0]],
                    "evidence_ids": [evid[0]],
                    "provenance": "observed",
                    "confidence": 0.9,
                },
                {
                    "name": "Invented admin panel",
                    "description": "Made up.",
                    "category": "other",
                    "page_ids": [pages[0], "00000000-0000-0000-0000-000000000000"],
                    "evidence_ids": ["11111111-1111-1111-1111-111111111111"],
                    "provenance": "observed",
                    "confidence": 0.8,
                },
            ],
            "journeys": [
                {"name": "Browse", "steps": [{"page_id": pages[0], "action": "Open the home page"}], "confidence": 0.6}
            ],
            "page_urls_mentioned": ["https://evil.example/exfiltrate"],
        }
        return RawCompletion(data=json.dumps(data), tokens_in=100, tokens_out=100)


async def test_ai_output_is_validated_downgraded_and_labelled(make_ctx) -> None:  # type: ignore[no-untyped-def]
    llm = ScriptedAnalysis()
    llm.provider, llm.model = "fake", "fake-model"
    ctx: AppContext = await make_ctx(allow_private_targets=True, scan_mobile_sample_pages=0, llm=llm)
    with running_site() as (url, _site):
        async with client_for(ctx) as c:
            acct = await register(c)
            p = (await c.post(f"{API}/projects", json=_body(url, max_pages=6), headers=acct.headers)).json()
            await worker_for(ctx).run_until_idle(timeout=180)
            scan = (await c.get(f"{API}/projects/{p['id']}/discovery", headers=acct.headers)).json()
            feats = (await c.get(f"{API}/scans/{scan['id']}/features", headers=acct.headers)).json()
            run = (await c.get(f"{API}/projects/{p['id']}/stages/discovery/runs/1", headers=acct.headers)).json()
    assert scan["status"] == "completed" and scan["summary_generated_by"] == "ai"
    by_name = {f["name"]: f for f in feats}
    assert by_name["Product catalogue"]["generated_by"] == "ai"
    assert by_name["Product catalogue"]["provenance"] == "observed"
    invented = by_name.get("Invented admin panel")
    assert invented is None or (invented["provenance"] != "observed" and len(invented["page_ids"]) == 1)
    codes = {i["code"] for i in run["validation_issues"]}
    assert "undiscovered_url" in codes
    assert run["generated_by"] == "ai"
    prompt = llm.captured[0]["user"]
    assert f"<{TAG}" in prompt and PREFILLED_SECRET not in prompt
    assert "never instructions" in llm.captured[0]["system"]


async def test_cancelled_discovery_reports_cancellation_not_page_limit(make_ctx) -> None:  # type: ignore[no-untyped-def]
    """BUG-8: a scan cancelled after a couple of pages must not say it stopped at the page limit."""
    import asyncio

    ctx: AppContext = await make_ctx(
        allow_private_targets=True, scan_mobile_sample_pages=0, scan_politeness_delay_ms=400
    )
    with running_site() as (url, _site):
        async with client_for(ctx) as c:
            acct = await register(c)
            p = (await c.post(f"{API}/projects", json=_body(url, max_pages=30), headers=acct.headers)).json()
            worker = asyncio.create_task(worker_for(ctx).run_until_idle(timeout=180))
            for _ in range(200):
                events = (await c.get(f"{API}/projects/{p['id']}/events?limit=100", headers=acct.headers)).json()
                if sum(e["type"] == "page.discovered" for e in events["items"]) >= 2:
                    break
                await asyncio.sleep(0.1)
            cancel = await c.post(f"{API}/projects/{p['id']}/stages/discovery/cancel", headers=acct.headers)
            assert cancel.status_code == 200, cancel.text
            await worker
            scan = (await c.get(f"{API}/projects/{p['id']}/discovery", headers=acct.headers)).json()
            sitemap = (await c.get(f"{API}/scans/{scan['id']}/sitemap", headers=acct.headers)).json()
            reports = (await c.get(f"{API}/projects/{p['id']}/reports", headers=acct.headers)).json()
            report = (await c.get(f"{API}/reports/{reports[0]['id']}", headers=acct.headers)).json()
            report_partial = report["content"]["partial"]
            assert reports[0]["partial"] is report_partial
    assert scan["status"] == "cancelled" and scan["stop_reason"] == "cancelled"
    assert scan["partial"] is True and report_partial is True  # R2-4: API and report agree
    advice = " ".join(scan["gate"]["recommendation"]["reasons"]).lower()
    assert "higher page limit" not in advice and "re-run it to completion" in advice  # R2-2
    coverage = [ch["text"] for ch in scan["completeness"]["checks"] if " of " in ch["text"] and "pages" in ch["text"]]
    assert len(coverage) == 1, coverage
    assert scan["stats"]["pages"] < 30 and scan["not_visited"]
    text = json.dumps([scan["limitations"], scan["completeness"], scan["access_gaps"]]).lower()
    assert "limit of 30" not in text and "page limit reached" not in text and "not visited: page limit" not in text
    assert "cancelled" in text
    assert "page limit" not in json.dumps(sitemap)


async def test_login_form_only_site_has_one_signed_in_area_gap(make_ctx) -> None:  # type: ignore[no-untyped-def]
    """R2-1: when the only sign-in signal is a visible login form, exactly one gap covers the area behind it,
    and the limitation, Gate 2 completeness line and summary all agree."""
    ctx: AppContext = await make_ctx(allow_private_targets=True, scan_mobile_sample_pages=0)
    with running_site(account_public=True) as (url, _site):
        async with client_for(ctx) as c:
            acct = await register(c)
            p = (await c.post(f"{API}/projects", json=_body(url, max_pages=12), headers=acct.headers)).json()
            await worker_for(ctx).run_until_idle(timeout=180)
            scan = (await c.get(f"{API}/projects/{p['id']}/discovery", headers=acct.headers)).json()
    needs = [g for g in scan["access_gaps"] if g["reason"] == "Needs credentials"]
    assert len(needs) == 1, needs
    assert needs[0]["area"] == "Signed-in area behind /login" and "credentials" in needs[0]["suggestion"].lower()
    assert [b["kind"] for b in scan["auth_boundaries"]] == ["login_form"]
    assert any(lim.startswith("Some pages need a sign-in") for lim in scan["limitations"])
    assert any("1 area needs credentials" in r for r in scan["completeness"]["reasons"])
    assert "1 area needs a sign-in" in (scan["summary"] or "")
