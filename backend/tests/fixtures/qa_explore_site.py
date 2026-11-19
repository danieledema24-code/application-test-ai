"""QA fixture for P6-03a (adversarial exploration site, stdlib only).

Every control on `/adv` has an innocent name but tries to send data in a way a page can, so the only thing that keeps
the site safe is the network guard (or the allow-list for controls tied to a form). Every request is recorded as
(method, path); a second "elsewhere" server records anything that leaks to another origin.

- `/adv`: sendBeacon, fetch keepalive, XHR PUT, WebSocket, JS form.submit() (POST), requestSubmit() (POST), a dedicated
  worker POST, an iframe and a popup that POST on load, alert(), a beforeunload guard, a button and an
  `<input type=image>` tied to a POST form with `form=`, an `<a ping>`, a GET form submitted from script, a link that
  redirects to another origin, a link that redirects to `/logout`, a link "Orders" (whole-word check) and a slow link.
- `/slow`: answers after `slow_s` seconds.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit

HTML = {"Content-Type": "text/html; charset=utf-8"}


def _layout(title: str, body: str) -> str:
    return (
        f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{title}</title></head><body>'
        f'<nav><a href="/">Home</a> <a href="/adv">Adv</a></nav><main><h1>{title}</h1>{body}</main></body></html>'
    )


def adv_page(elsewhere: str) -> str:
    return f"""
<button type="button" onclick="navigator.sendBeacon('/w/beacon', 'x')">Beacon</button>
<button type="button" onclick="fetch('/w/keepalive', {{method: 'POST', body: 'x', keepalive: true}}).catch(function () {{}})">Keepalive</button>
<button type="button" onclick="var x = new XMLHttpRequest(); x.open('PUT', '/w/xhr'); x.send('x');">Xhr</button>
<button type="button" onclick="try {{ new WebSocket('ws://' + location.host + '/w/ws'); }} catch (e) {{}}">Socket</button>
<form id="hf" method="post" action="/w/jsform" hidden><input name="a" value="1"></form>
<button type="button" onclick="document.getElementById('hf').submit()">Next step</button>
<form id="rf" method="post" action="/w/reqsubmit" hidden><input name="a" value="1"></form>
<button type="button" onclick="document.getElementById('rf').requestSubmit()">Proceed</button>
<button type="button" onclick="var b = new Blob([&quot;fetch('&quot; + location.origin + &quot;/w/worker', {{method: 'POST'}})&quot;]); new Worker(window.URL.createObjectURL(b));">Worker</button>
<button type="button" onclick="var f = document.createElement('iframe'); f.src = '/frame'; document.body.appendChild(f);">Frame</button>
<button type="button" onclick="window.open('/popup')">Popup</button>
<button type="button" onclick="alert('Hello there')">Alert</button>
<button type="button" onclick="window.onbeforeunload = function (e) {{ e.preventDefault(); e.returnValue = 'stay'; return 'stay'; }}">Guard</button>
<form id="ext" method="post" action="/w/formattr"></form>
<button form="ext">Go there</button>
<input type="image" form="ext" alt="Picture go" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="20" height="20">
<a href="/plain" ping="/w/ping">Ping link</a>
<form id="gf" method="get" action="/w/getform" hidden><input name="q" value="1"></form>
<button type="button" onclick="document.getElementById('gf').submit()">Search now</button>
<a href="/go-out">Partner deals</a>
<a href="/bye">Goodbye page</a>
<a href="/orders">Orders</a>
<a href="{elsewhere}/direct">Direct elsewhere</a>
"""


@dataclass
class Recorder:
    requests: list[tuple[str, str]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def add(self, method: str, path: str) -> None:
        with self.lock:
            self.requests.append((method, path))

    def writes(self) -> list[tuple[str, str]]:
        with self.lock:
            return [(m, p) for m, p in self.requests if m not in ("GET", "HEAD", "OPTIONS")]


@dataclass
class QaSite:
    elsewhere: str = ""
    slow_s: float = 0.0
    rec: Recorder = field(default_factory=Recorder)

    def page(self, method: str, path: str) -> tuple[int, dict[str, str], str]:
        if method not in ("GET", "HEAD"):
            return 405, {"Content-Type": "text/plain"}, "no"
        if path == "/":
            return 200, HTML, _layout("Home", "<p>Welcome.</p>")
        if path == "/adv":
            return 200, HTML, _layout("Adv", adv_page(self.elsewhere))
        if path == "/frame":
            return 200, HTML, "<p>frame</p><script>fetch('/w/frame', {method: 'POST'}).catch(function () {});</script>"
        if path == "/popup":
            return 200, HTML, "<p>popup</p><script>fetch('/w/popup', {method: 'POST'}).catch(function () {});</script>"
        if path == "/go-out":
            return 302, {"Location": f"{self.elsewhere}/stolen"}, ""
        if path == "/bye":
            return 302, {"Location": "/logout"}, ""
        if path == "/logout":
            return 200, HTML, _layout("Signed out", "<p>Bye.</p>")
        if path in ("/plain", "/orders"):
            return 200, HTML, _layout(path.strip("/").title(), "<p>Content.</p>")
        if path.startswith("/w/getform"):
            return 200, HTML, _layout("Search", "<p>Results.</p>")
        if path == "/r2":
            body = (
                '<button type="button" onclick="location.replace(\'/logout\')">Swap</button>'
                '<button type="button" onclick="fetch(\'/logout\')">Ping status</button>'
                '<button type="button" onclick="var i = new Image(); i.src = \'/logout?img=1\'; document.body.appendChild(i);">Picture</button>'
                "<button type=\"button\" onclick=\"var f = document.createElement('iframe'); f.src = '/logout?frame=1'; document.body.appendChild(f);\">Embed</button>"
                "<button type=\"button\" onclick=\"history.pushState({}, '', '/logout')\">History</button>"
                '<button type="button" onclick="window.onbeforeunload = function (e) { e.preventDefault(); e.returnValue = \'x\'; }; '
                "location.href = '" + self.elsewhere + "/away'\">Leave site</button>"
                '<a href="/hop1">Hop chain</a> <a href="/meta">Meta page</a> <a href="/plain">Plain</a>'
            )
            return 200, HTML, _layout("R2", body)
        if path == "/hop1":
            return 302, {"Location": "/hop2"}, ""
        if path == "/hop2":
            return 302, {"Location": "/logout?via=hop"}, ""
        if path == "/meta":
            return (
                200,
                HTML,
                (
                    '<!doctype html><html><head><meta http-equiv="refresh" content="0; url=/logout?via=meta">'
                    "<title>Meta</title></head><body><p>Moving.</p></body></html>"
                ),
            )
        if path == "/links":
            body = (
                '<a href="/plain" ping="/w/ping">Ping link</a> <a href="/go-out">Partner deals</a> '
                '<a href="/bye">Goodbye page</a> <a href="/orders">Orders</a> '
                '<button type="button" onclick="location.href = \'/logout\'">Continue</button>'
                '<form method="get" action="/w/getform"><button type="foo">Next</button></form>'
            )
            return 200, HTML, _layout("Links", body)
        if path == "/guard":
            body = (
                '<button type="button" onclick="window.onbeforeunload = function (e) { e.preventDefault(); '
                "e.returnValue = 'stay'; return 'stay'; }\">Guard</button>"
                '<button type="button" onclick="this.textContent = \'Beta pressed\'">Beta</button>'
                '<a href="/plain">Alpha</a> <a href="/orders">Orders</a>'
            )
            return 200, HTML, _layout("Guard", body)
        if path == "/worker":
            body = (
                '<button type="button" onclick="var b = new Blob([&quot;fetch(\'&quot; + location.origin + '
                "&quot;/w/worker', {method: 'POST'})&quot;]); new Worker(window.URL.createObjectURL(b));\">Worker</button>"
                '<button type="button" onclick="new Worker(\'/worker.js\')">Worker2</button>'
            )
            return 200, HTML, _layout("Worker", body)
        if path == "/worker.js":
            return 200, {"Content-Type": "text/javascript"}, "fetch('/w/worker2', {method: 'POST'});"
        if path == "/slow":
            time.sleep(self.slow_s)
            return 200, HTML, _layout("Slow", '<p>Slow.</p><a href="/slow">Again slow</a>')
        return 404, HTML, _layout("Not found", "<p>Nothing.</p>")


def _handler(site: QaSite | None, rec: Recorder) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:
            pass

        def _serve(self) -> None:
            parts = urlsplit(self.path)
            n = int(self.headers.get("Content-Length") or 0)
            if n:
                self.rfile.read(n)
            rec.add(self.command, self.path)
            if site is None:
                status, headers, body = 200, HTML, "<p>elsewhere</p>"
            else:
                status, headers, body = site.page(self.command, parts.path)
            data = body.encode()
            try:
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _serve

    return Handler


@contextmanager
def _server(site: QaSite | None, rec: Recorder) -> Iterator[str]:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _handler(site, rec))
    srv.daemon_threads = True
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{srv.server_address[1]}"
    finally:
        srv.shutdown()
        srv.server_close()


@contextmanager
def running_qa_site(*, slow_s: float = 0.0) -> Iterator[tuple[str, QaSite, Recorder]]:
    """(base url, site, recorder of the other-origin server)."""
    other = Recorder()
    with _server(None, other) as elsewhere:
        site = QaSite(elsewhere=elsewhere, slow_s=slow_s)
        with _server(site, site.rec) as base:
            yield base, site, other
