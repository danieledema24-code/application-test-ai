"""Browser network policy (threats T1–T4). Applied to every context the platform creates.

Playwright does not route requests that Chromium creates by following a redirect, so the policy never lets the
browser follow one: every http(s) request is fetched by the policy with `max_redirects=0`, each `Location` hop is
validated, and only a final non-redirect response is fulfilled. Top-level navigations are restricted to the
approved hosts; when a navigation redirects to an allowed URL the navigation is aborted and the redirect target is
recorded so the crawler can navigate to it itself (which goes through this policy again).

Residual risk (documented in security-risks.md T3): DNS rebinding between our resolution and Playwright's
connection. Closed in Phase 5 with an egress proxy that connects to the validated IP.
"""

from __future__ import annotations

import contextlib
import logging
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlsplit

from playwright.async_api import BrowserContext, Error, Route, WebSocketRoute

from app.security.ssrf import (
    BLOCKED_REASONS,
    BlockedCode,
    Resolver,
    UrlRejected,
    check_host,
    default_resolver,
    host_matches,
    normalise_url,
)

log = logging.getLogger(__name__)
MAX_REDIRECTS = 5


@dataclass
class NetworkPolicy:
    approved_origins: set[str]
    allowed_hosts: list[str]
    allow_private_targets: bool
    resolver: Resolver = default_resolver
    fetch_timeout_ms: float = 20_000
    blocked: list[dict[str, str]] = field(default_factory=list)
    nav_redirects: dict[str, str] = field(default_factory=dict)
    nav_blocked: dict[str, str] = field(default_factory=dict)
    _host_cache: dict[tuple[str, bool], str | None] = field(default_factory=dict)

    def _record(self, url: str, reason: str) -> None:
        if len(self.blocked) < 500 and not any(b["url"] == url for b in self.blocked):
            self.blocked.append({"url": url[:500], "reason": reason})

    async def check(self, url: str, *, top_level: bool) -> str | None:
        """Returns a blocked reason, or None when the request may proceed."""
        scheme = urlsplit(url).scheme.lower()
        if scheme in ("data", "blob") and not top_level:
            return None
        if scheme not in ("http", "https", "ws", "wss"):
            return BLOCKED_REASONS[BlockedCode.unsupported_scheme]
        try:
            n = normalise_url(url.replace("ws://", "http://", 1).replace("wss://", "https://", 1))
        except UrlRejected as exc:
            return exc.reason
        if top_level and not host_matches(n.host, self.allowed_hosts):
            return "Outside the approved site"
        allow_loopback = self.allow_private_targets and n.origin in self.approved_origins
        key = (n.host, allow_loopback)
        if key not in self._host_cache:
            res = await check_host(n.host, allow_loopback=allow_loopback, resolver=self.resolver)
            self._host_cache[key] = None if res.allowed else (res.reason or "Blocked")
        return self._host_cache[key]

    async def handle(self, route: Route) -> None:
        req = route.request
        url = req.url
        if urlsplit(url).scheme.lower() in ("data", "blob"):
            await route.continue_()
            return
        try:
            top_level = req.is_navigation_request() and req.frame.parent_frame is None
        except Error:
            top_level = False
        reason = await self.check(url, top_level=top_level)
        if reason:
            self._record(url, reason)
            if top_level:
                self.nav_blocked[url] = reason
            await _safe_abort(route)
            return
        try:
            resp = await route.fetch(max_redirects=0, timeout=self.fetch_timeout_ms)
            current = url
            hops = 0
            while 300 <= resp.status < 400 and resp.headers.get("location"):
                nxt = urljoin(current, resp.headers["location"])
                reason = await self.check(nxt, top_level=top_level)
                if reason:
                    why = f"Redirect to a blocked address ({reason})"
                    self._record(nxt, why)
                    if top_level:
                        self.nav_blocked[url] = why
                    await _safe_abort(route)
                    return
                if top_level:
                    # Let the crawler navigate to the validated target itself, so it is routed through this policy.
                    self.nav_redirects[url] = nxt
                    await _safe_abort(route, "aborted")
                    return
                hops += 1
                if hops > MAX_REDIRECTS:
                    self._record(nxt, "Too many redirects")
                    await _safe_abort(route)
                    return
                resp = await route.fetch(url=nxt, max_redirects=0, timeout=self.fetch_timeout_ms)
                current = nxt
            await route.fulfill(response=resp)
        except Error as exc:
            log.debug("policy fetch failed for %s: %s", url, str(exc).splitlines()[0])
            await _safe_abort(route, "failed")

    async def handle_ws(self, ws: WebSocketRoute) -> None:
        reason = await self.check(ws.url, top_level=False)
        if reason:
            self._record(ws.url, reason)
            await ws.close(code=1008, reason="Blocked by scanner policy")
            return
        ws.connect_to_server()

    async def apply(self, context: BrowserContext) -> None:
        await context.route("**/*", self.handle)
        await context.route_web_socket("**/*", self.handle_ws)


async def _safe_abort(route: Route, code: str = "blockedbyclient") -> None:
    with contextlib.suppress(Error):
        await route.abort(code)
