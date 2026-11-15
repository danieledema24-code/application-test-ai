"""P5-00 demo-shop flaws, against a private copy of the shop started on a free port (the shared one on :4100 may be
running older code): product pages have an image without `alt`, a low-contrast stock line and a `recently_viewed`
cookie without HttpOnly/SameSite; every response has `X-Powered-By`; `/products/2` answers fast alone but is
serialised under concurrency. Forms, fields and links are unchanged."""

from __future__ import annotations

import asyncio
import re
import shutil
import socket
import subprocess
import time
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest

SHOP = Path(__file__).resolve().parents[3] / "demo-shop"
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed")


@pytest.fixture(scope="module")
def shop() -> Iterator[str]:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    proc = subprocess.Popen(
        [shutil.which("node") or "node", str(SHOP / "server.mjs")],
        cwd=SHOP,
        env={"PATH": "/usr/bin:/bin", "DEMO_PORT": str(port)},
        stdout=subprocess.DEVNULL,  # the shop prints its demo login; keep it out of test output
        stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(100):
            try:
                httpx.get(base, timeout=1)
                break
            except httpx.HTTPError:
                time.sleep(0.05)
        yield base
    finally:
        proc.terminate()
        proc.wait(timeout=5)


def test_product_pages_carry_the_accessibility_and_security_flaws(shop: str) -> None:
    for pid in (1, 2):
        r = httpx.get(f"{shop}/products/{pid}")
        assert r.status_code == 200
        img = re.search(r"<img [^>]*>", r.text)
        assert img is not None and " alt=" not in img.group(0) and 'src="data:image/svg+xml,' in img.group(0)
        assert re.search(r'<p class="stock">\d+ in stock</p>', r.text)
        assert ".stock{color:#9ca3af}" in r.text
        cookie = r.headers["set-cookie"]
        assert cookie == f"recently_viewed={pid}; Path=/"
        assert "httponly" not in cookie.lower() and "samesite" not in cookie.lower()
        assert r.headers["x-powered-by"] == "DemoShop/0.9 (Node 22)"
    for path in ("/", "/products", "/contact", "/login", "/missing"):
        r = httpx.get(f"{shop}{path}")
        assert r.headers["x-powered-by"] == "DemoShop/0.9 (Node 22)"
        assert "set-cookie" not in r.headers and "<img" not in r.text
        for header in ("content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy"):
            assert header not in r.headers
    login = httpx.post(f"{shop}/login", data={"email": "nobody@example.com", "password": "wrong"})
    assert "set-cookie" not in login.headers  # Phase 4 relies on sign-in not persisting


def test_forms_fields_and_links_are_unchanged(shop: str) -> None:
    links = re.findall(r'href="([^"]+)"', httpx.get(f"{shop}/products/2").text)
    assert links == ["/", "/products", "/contact", "/login"]
    contact = httpx.get(f"{shop}/contact").text
    assert re.findall(r'name="(\w+)"', contact) == ["name", "email", "message"]
    assert re.findall(r"<form[^>]*>", contact) == ['<form method="post" action="/contact">']


async def test_desk_lamp_is_fast_alone_and_serialised_under_concurrency(shop: str) -> None:
    await asyncio.sleep(5.1)  # earlier requests to the page age out of its 5 s window
    async with httpx.AsyncClient(base_url=shop, timeout=60) as c:
        t0 = time.perf_counter()
        assert (await c.get("/products/2")).status_code == 200
        single = time.perf_counter() - t0
        assert single < 0.25, single

        async def timed(path: str) -> float:
            start = time.perf_counter()
            assert (await c.get(path)).status_code == 200
            return time.perf_counter() - start

        lamp = await asyncio.gather(*(timed("/products/2") for _ in range(10)))
        assert max(lamp) >= 5 * single, (single, lamp)
        others = await asyncio.gather(*(timed("/products/1") for _ in range(10)))
        assert max(others) < 0.1, others


async def test_real_requirements_keep_the_800_ms_default_and_the_desk_lamp_misses_it(shop: str, make_ctx) -> None:  # type: ignore[no-untyped-def]
    """P5-BUG-02 (design check 25, the demo chain): on a real project, AI off, the rule-made requirement "Pages load
    within 3 seconds" is *assumed*, so it must not replace the 800 ms default page threshold. Discovery, requirements,
    strategy and the drafted profile are all real; only the stages are shortened. Ten users then make /products/2
    miss p95 < 800 ms, the run fails and drafts one performance defect named after the page."""
    from tests.conftest import client_for, register, worker_for

    api = "/api/v1"
    ctx = await make_ctx(allow_private_targets=True)
    async with client_for(ctx) as c:
        h = (await register(c, org="Demo QA P5")).headers
        r = await c.post(f"{api}/projects", headers=h, json={
            "url": shop, "name": "Demo shop", "start": True,
            "authorisation": {"attested": True, "statement": "Local demo shop run by the test suite."},
            "scan": {"max_pages": 30, "max_depth": 3},
        })  # fmt: skip
        assert r.status_code == 201, r.text
        pid = r.json()["id"]
        await worker_for(ctx).run_until_idle(timeout=600)
        reqs = (await c.get(f"{api}/projects/{pid}/requirements?limit=100", headers=h)).json()["items"]
        placeholder = next(x for x in reqs if x["title"] == "Pages load within 3 seconds")
        assert placeholder["provenance"] == "assumed"
        ids = [x["id"] for x in reqs if x["status"] == "draft"]
        assert (await c.post(f"{api}/projects/{pid}/requirements/bulk-status", headers=h,
                             json={"ids": ids, "status": "approved"})).status_code == 200  # fmt: skip
        for gate, key in (("G3", "requirements"), ("G4", "test_strategy")):
            wf = (await c.get(f"{api}/projects/{pid}/workflow", headers=h)).json()
            st = next(s for s in wf["stages"] if s["key"] == key)
            d = await c.post(f"{api}/projects/{pid}/gates/{gate}/decision", headers=h,
                             json={"decision": "approve", "comment": "ok", "stage_run_version": st["current_version"]})  # fmt: skip
            assert d.status_code == 200, d.text
            await worker_for(ctx).run_until_idle(timeout=600)

        prof = (await c.post(f"{api}/projects/{pid}/performance-profiles", json={"type": "load"}, headers=h)).json()
        lamp = next(t for t in prof["thresholds"] if t.get("path") == "/products/2")
        assert (lamp["value"], lamp["source"]["type"]) == (800, "default"), prof["thresholds"]
        assert not [t for t in prof["thresholds"] if t["source"].get("type") == "requirement"]
        stages = [{"duration_s": 5, "target_vus": 10}, {"duration_s": 20, "target_vus": 10},
                  {"duration_s": 2, "target_vus": 0}]  # fmt: skip
        r = await c.patch(f"{api}/performance-profiles/{prof['id']}", json={"version": prof["version"], "stages": stages},
                          headers=h)  # fmt: skip
        assert r.status_code == 200, r.text
        assert (await c.post(f"{api}/performance-profiles/{prof['id']}/ready", headers=h)).status_code == 200
        r = await c.post(f"{api}/projects/{pid}/performance-runs", headers=h,
                         json={"profile_id": prof["id"], "approve": True, "confirm_text": "127.0.0.1"})  # fmt: skip
        assert r.status_code == 201, r.text
        await worker_for(ctx).run_until_idle(timeout=180)
        run = (await c.get(f"{api}/performance-runs/{r.json()['id']}", headers=h)).json()
        assert run["status"] == "failed", (run["status"], run["error"], run["aborted_reason"])
        result = next(t for t in run["threshold_results"] if t.get("path") == "/products/2")
        assert result["result"] == "missed" and result["value"] == 800, result
        assert [d["status"] for d in run["defects"]] == ["draft"]
        defects = (await c.get(f"{api}/projects/{pid}/defects?source=performance", headers=h)).json()["items"]
        assert len(defects) == 1 and defects[0]["summary"].startswith("Desk lamp page slows down under load"), defects
