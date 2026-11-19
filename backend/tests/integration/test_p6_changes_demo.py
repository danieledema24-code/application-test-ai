"""P6-01 on the demo shop (roadmap "Demo target chain" step 2, design P6 §14 step 2), AI off, against a private copy of
the shop started on a free port with `DEMO_VERSION_FILE` (the shared one on :4100 is never touched): Scan 1 on
release 1 is approved at G2, the version file flips to 2, and a rescan produces CHG-0001 with exactly the listed items
and nothing for unchanged pages.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

import pytest

from app.context import build_context
from app.llm.base import DisabledLLM
from tests.conftest import client_for, make_settings, register, worker_for
from tests.integration.test_p6_demo_shop import Shop

API = "/api/v1"
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed")

EXPECTED = {
    ("page_added", "structural", "/offers", "Page added: /offers"),
    ("page_removed", "structural", "/products/1", "Page removed: /products/1"),
    ("navigation_changed", "behavioural", None, "Navigation changed: 'Offers' added"),
    ("field_changed", "structural", "/contact", "Field changed: Message → Your message (now required)"),
    ("field_added", "structural", "/contact", "Field added: Order number"),
    ("element_renamed", "behavioural", "/contact", "Button renamed: Send message → Send"),
    ("form_added", "structural", "/offers", "Form added: Promo code"),
    ("journey_changed", "behavioural", "/", "Journey changed: Contact the company"),
    ("element_removed", "structural", "/products", "Link removed: Travel mug"),
}


async def test_demo_shop_release_2_change_set(tmp_path: Path, template_db: Path) -> None:
    shutil.copy(template_db, tmp_path / "qa.db")
    version = tmp_path / "demo-version"
    version.write_text("1\n")
    shop = Shop(DEMO_VERSION_FILE=str(version))
    ctx = build_context(make_settings(tmp_path, allow_private_targets=True), llm=DisabledLLM())
    try:
        async with client_for(ctx) as client:
            owner = await register(client, "owner@p6-demo.example.com", org="P6 Demo")
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
            r = await client.post(f"{API}/projects/{pid}/rescans", json={}, headers=h)
            assert r.status_code == 202, r.text
            assert r.json()["baseline"]["number"] == 1 and r.json()["scan"]["number"] == 2
            await worker_for(ctx).run_until_idle(timeout=300)
            sets = (await client.get(f"{API}/projects/{pid}/changes", headers=h)).json()["items"]
            assert [s["key"] for s in sets] == ["CHG-0001"]
            chg: dict[str, Any] = sets[0]
            assert chg["status"] == "completed" and chg["generated_by"] == "rules" and chg["ai_summary"] is None
            items = (await client.get(f"{API}/change-sets/{chg['id']}/items", headers=h)).json()["items"]
            got = {(i["kind"], i["significance"], i["page"], i["subject"]) for i in items}
            assert got == EXPECTED, sorted(got ^ EXPECTED, key=str)
            assert len(items) == len(EXPECTED)
            order = next(i for i in items if i["kind"] == "field_added")
            assert order["after"]["constraints"] == {"maxlength": 20} and order["after"]["required"] is False
            message = next(i for i in items if i["kind"] == "field_changed")
            assert message["after"]["changed"] == ["label", "required"]
            assert chg["summary"]["by_significance"] == {"structural": 6, "behavioural": 3, "cosmetic": 0}
            assert chg["rebaseline_suggested"] is False
    finally:
        shop.stop()
        await ctx.close()
