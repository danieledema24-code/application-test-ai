"""P6-00 demo-shop v2 ("release 2"), against private copies of the shop started on free ports (the shared one on :4100
may be running older code):

- `DEMO_VERSION=1` (and no setting at all) answers every route byte-for-byte as Phase 5 did, checked against
  `tests/fixtures/demo_shop_v1_snapshot.json` (captured from the Phase 5 server before v2 was written);
- `DEMO_VERSION=2` has each listed change: the Offers page and nav link, `/products/1` gone, the Contact form's renamed
  and required Message, the new Order number field and the "Send" button, and the 400 on an empty message;
- with `DEMO_VERSION_FILE`, flipping the file from 1 to 2 serves the next request as v2 without a restart.

Regenerate the snapshot only from a Phase 5 server (`git show 69f4b3a:demo-shop/server.mjs`):
`uv run python -m tests.integration.test_p6_demo_shop <base url>`. The signed-in response carries the demo login,
so only its hash is stored; request bodies with credentials are built here from `demo-shop/demo-login.mjs`.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

SHOP = Path(__file__).resolve().parents[3] / "demo-shop"
SNAPSHOT = Path(__file__).resolve().parents[1] / "fixtures" / "demo_shop_v1_snapshot.json"
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed")
# Per-connection or per-moment headers; everything else (content-type, length, cookies, X-Powered-By) is compared.
VOLATILE = {"date", "connection", "keep-alive"}


def _demo_login() -> tuple[str, str, str]:
    src = (SHOP / "demo-login.mjs").read_text()
    email = re.search(r'email:\s*"([^"]+)"', src)
    password = re.search(r'password:\s*"([^"]+)"', src)
    token = re.search(r'DEMO_API_TOKEN\s*=\s*"([^"]+)"', src)
    assert email and password and token
    return email.group(1), password.group(1), token.group(1)


def _requests() -> list[dict[str, Any]]:
    """Every route the shop serves, with the variants that take different code paths. `redact`: store a hash only."""
    email, password, token = _demo_login()
    bearer = {"Authorization": f"Bearer {token}"}
    form = {"Content-Type": "application/x-www-form-urlencoded"}
    js = {**bearer, "Content-Type": "application/json"}
    gets = ["/", "/products", "/products/1", "/products/2", "/products/3", "/contact", "/login", "/openapi.json",
            "/missing", "/offers"]  # fmt: skip
    out: list[dict[str, Any]] = [{"name": f"GET {p}", "method": "GET", "path": p} for p in gets]
    out += [
        {"name": "GET /api/products (no token)", "method": "GET", "path": "/api/products"},
        {"name": "GET /api/products", "method": "GET", "path": "/api/products", "headers": bearer},
        {"name": "GET /api/products/1", "method": "GET", "path": "/api/products/1", "headers": bearer},
        {"name": "GET /api/products/1 (no token)", "method": "GET", "path": "/api/products/1"},
        {"name": "GET /api/products/9", "method": "GET", "path": "/api/products/9", "headers": bearer},
        {"name": "POST /contact", "method": "POST", "path": "/contact", "headers": form,
         "body": "name=Ann&email=ann%40example.com&message=Hello"},
        {"name": "POST /contact (empty message)", "method": "POST", "path": "/contact", "headers": form,
         "body": "name=Ann&email=ann%40example.com&message="},
        {"name": "POST /contact (no email)", "method": "POST", "path": "/contact", "headers": form,
         "body": "name=Ann&email=&message=Hello"},
        {"name": "POST /login (wrong)", "method": "POST", "path": "/login", "headers": form,
         "body": "email=nobody%40example.com&password=wrong"},
        {"name": "POST /login (demo login)", "method": "POST", "path": "/login", "headers": form, "redact": True,
         "body": httpx.QueryParams({"email": email, "password": password}).__str__()},
        {"name": "POST /api/products", "method": "POST", "path": "/api/products", "headers": js,
         "body": '{"name": "Notebook", "price": 4.99}'},
        {"name": "POST /api/products (malformed)", "method": "POST", "path": "/api/products", "headers": js,
         "body": "{"},
        {"name": "POST /api/products (no name)", "method": "POST", "path": "/api/products", "headers": js,
         "body": '{"price": 1}'},
        {"name": "POST /api/products (bad price)", "method": "POST", "path": "/api/products", "headers": js,
         "body": '{"name": "X", "price": -1}'},
        {"name": "POST /api/products (no token)", "method": "POST", "path": "/api/products",
         "body": '{"name": "X", "price": 1}'},
        {"name": "POST /basket", "method": "POST", "path": "/basket"},
        {"name": "POST /offers/apply", "method": "POST", "path": "/offers/apply", "headers": form, "body": "code=SAVE"},
        {"name": "DELETE /contact", "method": "DELETE", "path": "/contact"},
    ]  # fmt: skip
    return out


def capture(base: str) -> dict[str, dict[str, Any]]:
    """Each request's response: status, headers (bar VOLATILE), body sha256 and, unless redacted, the body."""
    out: dict[str, dict[str, Any]] = {}
    with httpx.Client(base_url=base, timeout=10) as client:
        for req in _requests():
            r = client.request(req["method"], req["path"], headers=req.get("headers"), content=req.get("body"))
            entry: dict[str, Any] = {
                "status": r.status_code,
                "headers": sorted([k.lower(), v] for k, v in r.headers.multi_items() if k.lower() not in VOLATILE),
                "sha256": hashlib.sha256(r.content).hexdigest(),
            }
            if not req.get("redact"):
                entry["body"] = r.content.decode()
            out[req["name"]] = entry
    return out


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class Shop:
    """A private copy of the demo shop with its own environment."""

    def __init__(self, **env: str) -> None:
        self.port = _free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.proc = subprocess.Popen(
            [shutil.which("node") or "node", str(SHOP / "server.mjs")],
            cwd=SHOP,
            env={"PATH": "/usr/bin:/bin", "DEMO_PORT": str(self.port), "DEMO_SLOW_MS": "20", **env},
            stdout=subprocess.DEVNULL,  # never let the shop's output (or the demo login) into test output
            stderr=subprocess.DEVNULL,
        )
        for _ in range(100):
            try:
                httpx.get(self.base, timeout=1)
                return
            except httpx.HTTPError:
                time.sleep(0.05)
        raise RuntimeError("the demo shop did not start")

    def stop(self) -> None:
        self.proc.terminate()
        self.proc.wait(timeout=5)


@pytest.fixture(scope="module")
def shops(tmp_path_factory: pytest.TempPathFactory) -> Iterator[dict[str, Any]]:
    version_file = tmp_path_factory.mktemp("demo") / "version"
    version_file.write_text("1\n")
    started = {
        "default": Shop(),
        "v1": Shop(DEMO_VERSION="1"),
        "v2": Shop(DEMO_VERSION="2"),
        "file": Shop(DEMO_VERSION_FILE=str(version_file)),
    }
    try:
        yield {**{k: s.base for k, s in started.items()}, "version_file": version_file}
    finally:
        for s in started.values():
            s.stop()


def _diff(expected: dict[str, Any], actual: dict[str, Any]) -> list[str]:
    return [name for name in expected if expected[name] != actual.get(name)] + sorted(set(actual) - set(expected))


def test_v1_is_byte_for_byte_the_phase5_shop(shops: dict[str, Any]) -> None:
    snapshot = json.loads(SNAPSHOT.read_text())
    assert len(snapshot) == len(_requests())
    for which in ("default", "v1"):
        assert _diff(snapshot, capture(shops[which])) == [], which


def test_v2_has_every_listed_change(shops: dict[str, Any]) -> None:
    v2 = shops["v2"]
    home = httpx.get(f"{v2}/").text
    assert re.findall(r"<nav>(.*?)</nav>", home) == [
        '<a href="/">Home</a><a href="/products">Products</a><a href="/offers">Offers</a>'
        '<a href="/contact">Contact</a><a href="/login">Sign in</a>'
    ]
    # 1-2. The Offers page: one offer, two type=button buttons (one throws after writing NaN, one tries POST /basket)
    # and a Promo code form.
    offers = httpx.get(f"{v2}/offers")
    assert offers.status_code == 200
    assert "<h1>Offers</h1>" in offers.text and offers.text.count("Desk lamp bundle") == 1
    details = re.search(r'<button type="button" onclick="([^"]*)">Show details</button>', offers.text)
    assert details is not None and "Bundle price: £" in details.group(1) and ".price" in details.group(1)
    basket = re.search(r'<button type="button" onclick="([^"]*)">Add to basket</button>', offers.text)
    assert basket is not None and "fetch('/basket', {method: 'POST'})" in basket.group(1)
    assert re.findall(r"<form[^>]*>", offers.text) == ['<form method="post" action="/offers/apply">']
    assert re.findall(r'<input [^>]*name="(\w+)"', offers.text) == ["code"]
    assert '<label for="code">Promo code</label>' in offers.text
    assert '<button type="submit">Apply code</button>' in offers.text
    assert httpx.post(f"{v2}/offers/apply", data={"code": "SAVE"}).status_code == 200
    assert httpx.post(f"{v2}/basket").status_code == 200
    # 3. The Travel mug is gone.
    assert httpx.get(f"{v2}/products/1").status_code == 404
    products = httpx.get(f"{v2}/products").text
    assert "Travel mug" not in products and '<a href="/products/2">Desk lamp</a>' in products
    # 4. Contact: "Your message" (same id/name), required; an optional Order number (max 20); the button is "Send".
    contact = httpx.get(f"{v2}/contact").text
    assert '<label for="message">Your message</label><textarea id="message" name="message" required>' in contact
    assert '<label for="order">Order number</label><input id="order" name="order" maxlength="20">' in contact
    assert re.findall(r'name="(\w+)"', contact) == ["name", "email", "message", "order"]
    assert '<button type="submit">Send</button>' in contact and "Send message" not in contact
    empty = httpx.post(f"{v2}/contact", data={"name": "Ann", "email": "ann@example.com", "message": ""})
    assert empty.status_code == 400 and "Name, email and message are required" in empty.text
    sent = httpx.post(f"{v2}/contact", data={"name": "Ann", "email": "ann@example.com", "message": "Hi", "order": ""})
    assert sent.status_code == 200 and '<h1>Thank you</h1><p class="ok">Message sent</p>' in sent.text
    # 5. Everything else as in v1, Phase 5 flaws included.
    lamp = httpx.get(f"{v2}/products/2")
    assert lamp.status_code == 200 and lamp.headers["x-powered-by"] == "DemoShop/0.9 (Node 22)"
    assert lamp.headers["set-cookie"] == "recently_viewed=2; Path=/" and ".stock{color:#9ca3af}" in lamp.text
    assert re.search(r"<img [^>]*>", lamp.text) is not None and " alt=" not in re.findall(r"<img [^>]*>", lamp.text)[0]
    login = httpx.get(f"{v2}/login").text
    assert re.findall(r'name="(\w+)"', login) == ["email", "password"]


async def test_v2_offers_buttons_in_a_browser(shops: dict[str, Any]) -> None:
    """ "Show details" writes "Bundle price: £NaN" and throws an uncaught TypeError; "Add to basket" sends POST /basket."""
    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        try:
            page = await browser.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda exc: errors.append(f"{exc.name}: {exc.message}"))
            await page.goto(f"{shops['v2']}/offers")
            await page.get_by_role("button", name="Show details").click()
            await page.wait_for_function("document.getElementById('bundle').textContent !== ''")
            assert await page.locator("#bundle").text_content() == "Bundle price: £NaN"
            assert len(errors) == 1 and errors[0].startswith("TypeError") and "price" in errors[0]
            async with page.expect_request(lambda r: r.url.endswith("/basket")) as req:
                await page.get_by_role("button", name="Add to basket").click()
            assert (await req.value).method == "POST"
        finally:
            await browser.close()


def test_v1_has_none_of_the_v2_changes(shops: dict[str, Any]) -> None:
    v1 = shops["default"]
    assert httpx.get(f"{v1}/offers").status_code == 404
    assert httpx.get(f"{v1}/products/1").status_code == 200
    assert httpx.post(f"{v1}/contact", data={"name": "A", "email": "a@example.com", "message": ""}).status_code == 200


def test_version_file_flips_without_a_restart(shops: dict[str, Any]) -> None:
    base, version_file = shops["file"], shops["version_file"]
    try:
        assert httpx.get(f"{base}/offers").status_code == 404
        assert httpx.get(f"{base}/products/1").status_code == 200
        version_file.write_text("2\n")
        assert httpx.get(f"{base}/offers").status_code == 200  # the very next request
        assert httpx.get(f"{base}/products/1").status_code == 404
        version_file.write_text("1")
        assert httpx.get(f"{base}/offers").status_code == 404
        # The file is never served: no route reads it, whatever the path.
        for path in (f"/{version_file.name}", str(version_file), "/version"):
            r = httpx.get(f"{base}{path}" if path.startswith("/") else f"{base}/{path}")
            assert r.status_code == 404 and r.text.count("Page not found") == 1
    finally:
        version_file.write_text("1\n")


def test_unreadable_version_file_falls_back_to_demo_version(tmp_path: Path) -> None:
    shop = Shop(DEMO_VERSION="2", DEMO_VERSION_FILE=str(tmp_path / "missing"))
    try:
        assert httpx.get(f"{shop.base}/offers").status_code == 200
    finally:
        shop.stop()


if __name__ == "__main__":  # pragma: no cover - regenerates the v1 snapshot from a Phase 5 server
    SNAPSHOT.write_text(json.dumps(capture(sys.argv[1]), indent=1, ensure_ascii=False, sort_keys=True) + "\n")
    print(f"wrote {SNAPSHOT.name}")
