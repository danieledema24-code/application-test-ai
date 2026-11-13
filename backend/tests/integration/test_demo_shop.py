"""Real discovery of the demo shop on http://localhost:4100 producing the Discovery Report as JSON, HTML and PDF.

Start the shop first: `cd api && npx tsx src/demo/target-app.ts`. Skipped when it is not running.
The three files are also written to backend/data/test-artifacts/ for manual inspection.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from app.context import AppContext
from tests.conftest import client_for, register, worker_for

DEMO = "http://localhost:4100"
ARTIFACTS = Path(__file__).resolve().parents[2] / "data" / "test-artifacts"
pytestmark = pytest.mark.demo_shop


def _demo_running() -> bool:
    try:
        return httpx.get(DEMO, timeout=2).status_code < 500
    except httpx.HTTPError:
        return False


@pytest.mark.skipif(not _demo_running(), reason="demo shop is not running on http://localhost:4100")
async def test_demo_shop_discovery_report(make_ctx) -> None:  # type: ignore[no-untyped-def]
    ctx: AppContext = await make_ctx(allow_private_targets=True)
    async with client_for(ctx) as c:
        acct = await register(c, org="Demo QA")
        r = await c.post(
            "/api/v1/projects",
            headers=acct.headers,
            json={
                "url": DEMO,
                "name": "Demo shop",
                "start": True,
                "authorisation": {"attested": True, "statement": "The demo shop is our own local test target."},
            },
        )
        assert r.status_code == 201, r.text
        pid = r.json()["id"]
        await worker_for(ctx).run_until_idle(timeout=600)
        scan = (await c.get(f"/api/v1/projects/{pid}/discovery", headers=acct.headers)).json()
        assert scan["status"] == "completed", scan.get("error")
        assert scan["stats"]["pages"] >= 4 and scan["stats"]["forms"] >= 1
        reports = (await c.get(f"/api/v1/projects/{pid}/reports", headers=acct.headers)).json()
        assert reports and reports[0]["status"] == "ready"
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        for fmt in ("json", "html", "pdf"):
            d = await c.get(f"/api/v1/reports/{reports[0]['id']}/download?format={fmt}", headers=acct.headers)
            assert d.status_code == 302
            content = await c.get(d.headers["location"].replace("http://test", ""))
            assert content.status_code == 200 and len(content.content) > 1000
            (ARTIFACTS / f"demo-shop-discovery-report.{fmt}").write_bytes(content.content)
    data = json.loads((ARTIFACTS / "demo-shop-discovery-report.json").read_text())
    assert data["site"]["host"] == "localhost" and data["functionality_map"] and data["journeys"]
    assert (ARTIFACTS / "demo-shop-discovery-report.pdf").read_bytes().startswith(b"%PDF")
    assert "Application Discovery Report" in (ARTIFACTS / "demo-shop-discovery-report.html").read_text()
