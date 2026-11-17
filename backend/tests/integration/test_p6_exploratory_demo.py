"""P6-03a on the demo shop (roadmap "Demo target chain" step 3, design P6 §14 step 3), AI off, against a private copy
of the shop on a free port with `DEMO_VERSION_FILE` and `DEMO_ACCESS_LOG` (the shared one on :4100 is never touched):
release 1 is scanned and approved at G2, the version flips to 2, the rescan produces CHG-0001, and EXP-0001 with the
default charter (the change set's pages) finds the uncaught error and the 'NaN' on /offers with a defect draft, records
`POST /basket` as a blocked write attempt, lists "Apply code" as not tried, and the shop's access log shows that only
GET/HEAD requests arrived while it ran.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from app.context import build_context
from app.llm.base import DisabledLLM
from tests.conftest import client_for, make_settings, register, worker_for
from tests.integration.test_p6_demo_shop import Shop

API = "/api/v1"
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed")


async def test_demo_shop_exploration_on_release_2(tmp_path: Path, template_db: Path) -> None:
    shutil.copy(template_db, tmp_path / "qa.db")
    version, log = tmp_path / "demo-version", tmp_path / "access.log"
    version.write_text("1\n")
    shop = Shop(DEMO_VERSION_FILE=str(version), DEMO_ACCESS_LOG=str(log))
    ctx = build_context(make_settings(tmp_path, allow_private_targets=True), llm=DisabledLLM())
    try:
        async with client_for(ctx) as client:
            owner = await register(client, "owner@p6-explore.example.com", org="P6 Explore Demo")
            h = owner.headers
            r = await client.post(f"{API}/projects", headers=h, json={
                "url": shop.base, "name": "Demo shop", "start": True,
                "authorisation": {"attested": True, "statement": "Private demo shop run by the test suite."},
                "scan": {"max_pages": 30, "max_depth": 3},
            })  # fmt: skip
            assert r.status_code == 201, r.text
            pid = r.json()["id"]
            await worker_for(ctx).run_until_idle(timeout=300)
            wf = (await client.get(f"{API}/projects/{pid}/workflow", headers=h)).json()
            disc = next(s for s in wf["stages"] if s["key"] == "discovery")
            body = {"decision": "approve", "comment": "", "stage_run_version": disc["current_version"]}
            assert (
                await client.post(f"{API}/projects/{pid}/gates/G2/decision", json=body, headers=h)
            ).status_code == 200
            await worker_for(ctx).run_until_idle(timeout=300)
            version.write_text("2\n")
            assert (await client.post(f"{API}/projects/{pid}/rescans", json={}, headers=h)).status_code == 202
            await worker_for(ctx).run_until_idle(timeout=300)

            listing = (await client.get(f"{API}/projects/{pid}/exploratory-sessions", headers=h)).json()
            assert listing["options"]["default_charter"] == "change_set"
            chg = next(c for c in listing["options"]["charters"] if c["key"] == "change_set")
            assert chg["label"] == "New and changed pages from CHG-0001"
            mark = len(log.read_text().splitlines())
            r = await client.post(f"{API}/projects/{pid}/exploratory-sessions", json={}, headers=h)
            assert r.status_code == 201, r.text
            assert r.json()["key"] == "EXP-0001" and r.json()["charter"]["key"] == "change_set"
            await worker_for(ctx).run_until_idle(timeout=600)
            sess = (await client.get(f"{API}/quality-scans/{r.json()['id']}", headers=h)).json()
            assert sess["status"] == "completed", sess

            # Only reading reached the shop while the session ran: no POST /basket, no promo code applied.
            lines = log.read_text().splitlines()[mark:]
            assert lines and {ln.split(" ", 1)[0] for ln in lines} <= {"GET", "HEAD"}, lines
            assert not any("/basket" in ln or "/offers/apply" in ln for ln in lines)
            assert any(ln.startswith("GET /offers ") for ln in lines)

            assert "POST /basket" in [b["request"] for b in sess["blocked"]]
            assert ('Button "Apply code"', "/offers", "Submits a form") in {
                (n["element"], n["page"], n["reason"]) for n in sess["not_tried"]
            }
            findings = (await client.get(f"{API}/quality-scans/{sess['id']}/findings", headers=h)).json()["items"]
            offers = {(f["rule_id"], f["severity"], f["title"]) for f in findings if f["path"] == "/offers"}
            assert ("uncaught_exception", "medium", 'Uncaught error after clicking button "Show details"') in offers
            assert ("broken_text", "medium", "'NaN' appeared on the page") in offers
            exc = next(f for f in findings if f["path"] == "/offers" and f["rule_id"] == "uncaught_exception")
            assert {e["role"] for e in exc["evidence"]} == {"before", "after"}
            assert exc["details"]["steps"][-1] == 'Click the button "Show details"'
            # One grouped draft for the "Show details" step (the uncaught error and the 'NaN' together), for G8.
            drafts = [d for d in sess["defects"] if "Show details" in d["summary"]]
            assert len(drafts) == 1 and drafts[0]["status"] == "draft", sess["defects"]
            assert drafts[0]["summary"] == '/offers: "Show details" throws an error and shows NaN'
    finally:
        shop.stop()
        await ctx.close()
