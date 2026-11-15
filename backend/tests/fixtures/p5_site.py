"""Phase 5 fixture website (stdlib only): accessibility, passive security and load test pages (P5-01b, P5-02, P5-03).

Records every request (method, path, headers it saw) so tests can assert the checks only read pages: no POST, no
paths discovery didn't find, Tab/Shift+Tab only. Pages:
- accessibility: `/a11y/clean` (no violations), `/a11y/label` (input without a label), `/a11y/button` (button with no
  name), `/a11y/trap` (a widget that keeps focus on Tab), `/a11y/outline` (a link with `outline: none`);
- security: `/sec/hardened` (every header, a secure session cookie), `/sec/form-elsewhere` (a form posting to another
  host), `/sec/stacktrace` (a stack trace in the body); every other page sends `X-Powered-By: Fixture/1.2` and no
  security headers, and `/` sets a `recently_viewed` cookie without SameSite;
- load: `/perf/slow` (held 300 ms); with `errors` on, every page answers 500.
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

HARDENED = {
    "Content-Security-Policy": "default-src 'self'; frame-ancestors 'self'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=()",
}


def _page(title: str, body: str, style: str = "") -> str:
    return (
        f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{title} · P5 Fixture</title>'
        f'<meta name="viewport" content="width=device-width, initial-scale=1"><style>body{{font-family:sans-serif;'
        f"color:#111;background:#fff}}a{{color:#1d4ed8}}{style}</style></head><body>"
        f'<header><nav aria-label="Main"><a href="/">Home</a> <a href="/a11y/clean">Clean</a></nav></header>'
        f"<main><h1>{title}</h1>{body}</main></body></html>"
    )


PAGES: dict[str, str] = {
    "/": _page("Home", "<p>Welcome.</p>"),
    "/a11y/clean": _page("Clean", '<p>A clean page.</p><button type="button">Save</button>'),
    "/a11y/label": _page("Label", '<form action="/search" method="get"><input id="q" name="q" value="keep-me"></form>'),
    "/a11y/button": _page("Button", '<button type="button"></button><p>An empty button.</p>'),
    "/a11y/trap": _page(
        "Trap",
        '<p><a href="/">Before</a></p><div id="trap" role="button" tabindex="0" aria-label="Trap widget">Trap</div>'
        '<p><a href="/a11y/clean">After</a></p>'
        "<script>document.getElementById('trap').addEventListener('keydown', (e) => {"
        " if (e.key === 'Tab') { e.preventDefault(); } });</script>",
    ),
    "/a11y/outline": _page("Outline", '<p><a id="plain" href="/a11y/clean" style="outline:none">Plain link</a></p>'),
    "/sec/hardened": _page("Hardened", "<p>Every header.</p>"),
    "/sec/form-elsewhere": _page(
        "Form elsewhere",
        '<form action="https://collect.example.org/submit" method="post"><label for="e">Email</label>'
        '<input id="e" name="e" type="email"><button type="submit">Send</button></form>',
    ),
    "/sec/stacktrace": _page(
        "Error", "<pre>Traceback (most recent call last):\n  File \"app.py\", line 3, in view\nKeyError: 'id'</pre>"
    ),
    "/perf/slow": _page("Slow", "<p>Slow page.</p>"),
}


@dataclass
class P5Site:
    errors: bool = False  # P5-01b: every page answers 500 (the kill switch fixture)
    slow_ms: int = 300
    requests: list[tuple[str, str]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def answer(self, path: str) -> tuple[int, dict[str, str], str]:
        html = {"Content-Type": "text/html; charset=utf-8", "X-Powered-By": "Fixture/1.2"}
        if self.errors:
            return 500, html, _page("Server error", "<p>Internal error.</p>")
        if path == "/perf/slow":
            time.sleep(self.slow_ms / 1000)
        if path == "/sec/hardened":
            headers = {"Content-Type": "text/html; charset=utf-8", **HARDENED,
                       "Set-Cookie": "sid=fixture-session; Path=/; HttpOnly; SameSite=Lax"}  # fmt: skip
            return 200, headers, PAGES[path]
        if path in PAGES:
            if path == "/":
                html["Set-Cookie"] = "recently_viewed=7; Path=/"
            return 200, html, PAGES[path]
        return 404, html, _page("Not found", "<p>Nothing here.</p>")


def _handler(site: P5Site) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version, sys_version = "Fixture", ""  # no version in Server; only X-Powered-By discloses one

        def log_message(self, *args: Any) -> None:
            pass

        def _serve(self) -> None:
            path = urlsplit(self.path).path
            with site.lock:
                site.requests.append((self.command, self.path))
            if self.command != "GET":
                status, headers, body = 405, {"Content-Type": "text/plain"}, "no"
            else:
                status, headers, body = site.answer(path)
            data = body.encode()
            self.send_response(status)
            for k, v in headers.items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _serve

    return Handler


@contextmanager
def running_p5_site(*, errors: bool = False) -> Iterator[tuple[str, P5Site]]:
    site = P5Site(errors=errors)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _handler(site))
    srv.daemon_threads = True
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{srv.server_address[1]}", site
    finally:
        srv.shutdown()
        srv.server_close()
