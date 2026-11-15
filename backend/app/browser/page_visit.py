"""Shared page-visit helper for accessibility and passive security checks (P5-02, P5-03).

Visits a list of discovered pages in one isolated context with the discovery network policy, the politeness delay,
a per-page timeout (at most 20 s) and, for signed-in pages, the P2-01 sign-in on the saved `login_url`. Each page
is opened with one top-level GET (redirects are followed by the policy rules, as in discovery) and handed to the
caller while it is open; the caller only reads it (DOM, ARIA, the axe script, Tab/Shift+Tab). Nothing is clicked,
typed or submitted here. Credential values are masked in the page before the caller sees it.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from playwright.async_api import Error, Page, Request, Response
from playwright.async_api import TimeoutError as PwTimeout

from app.agents.discovery.crawler import MASK_JS, _friendly_error
from app.browser.network_policy import NetworkPolicy
from app.browser.pool import DESKTOP, MOBILE
from app.context import AppContext
from app.security.redact import redact_url_tokens

log = logging.getLogger(__name__)
MAX_PAGE_TIMEOUT_S = 20
VIEWPORT_SIZES = {"desktop": DESKTOP, "mobile": MOBILE}


@dataclass(frozen=True)
class VisitTarget:
    page_id: uuid.UUID | None
    url: str
    requires_auth: bool = False


@dataclass
class Visit:
    """One page as the browser received it. `page` is open only while the caller's handler runs."""

    target: VisitTarget
    viewport: str
    page: Page | None
    status: int | None
    final_url: str | None
    error: str | None
    headers: list[tuple[str, str]] = field(default_factory=list)  # main document response, as received
    requests: list[dict[str, Any]] = field(default_factory=list)  # {url, type, method}
    console: list[str] = field(default_factory=list)
    load_ms: int = 0

    def header(self, name: str) -> str | None:
        """The (last) value of a response header, or None when it wasn't sent."""
        found = [v for k, v in self.headers if k.lower() == name.lower()]
        return found[-1] if found else None

    def set_cookies(self) -> list[str]:
        return [v for k, v in self.headers if k.lower() == "set-cookie"]


Handler = Callable[[Visit], Awaitable[None]]
StopCheck = Callable[[], Awaitable[bool]]


@dataclass
class SignIn:
    login_url: str
    username: str
    password: str


async def visit_pages(
    ctx: AppContext,
    *,
    origin: str,
    host: str,
    targets: list[VisitTarget],
    viewports: list[str],
    handle: Handler,
    should_stop: StopCheck,
    sign_in: SignIn | None = None,
) -> tuple[list[VisitTarget], str | None]:
    """Visits every target at every viewport (public pages first, then signed-in pages after one sign-in attempt).

    Returns the targets not visited because the caller asked to stop, and the sign-in failure reason (if any)."""
    s_ = ctx.settings
    timeout_s = min(MAX_PAGE_TIMEOUT_S, int(s_.scan_page_timeout_s))
    policy = NetworkPolicy(
        approved_origins={origin},
        allowed_hosts=[host],
        allow_private_targets=s_.allow_private_targets,
        resolver=ctx.resolver,
        fetch_timeout_ms=timeout_s * 1000,
    )
    public = [t for t in targets if not t.requires_auth]
    private = [t for t in targets if t.requires_auth]
    left: list[VisitTarget] = []
    signin_problem: str | None = None
    stopped = False
    async with ctx.browser_pool.isolated_context(policy) as context:
        for batch, signed in ((public, False), (private, True)):
            if stopped:
                left.extend(batch)
                continue
            if not batch:
                continue
            mask: list[str] = []
            if signed:
                if sign_in is None:
                    signin_problem = "needs sign-in; not included"
                    continue
                from app.agents.discovery.signin import sign_in as do_sign_in

                outcome = await do_sign_in(
                    context,
                    policy,
                    sign_in.login_url,
                    sign_in.username,
                    sign_in.password,
                    timeout_ms=timeout_s * 1000,
                )
                mask = [v for v in (sign_in.username, sign_in.password) if v]
                if outcome.result != "succeeded":
                    signin_problem = f"sign-in failed ({(outcome.reason_code or 'unknown').replace('_', ' ')})"
                    continue
            for i, t in enumerate(batch):
                if await should_stop():
                    left.extend(batch[i:])
                    stopped = True
                    break
                for vp in viewports:
                    await _visit_one(context, policy, t, vp, timeout_s, mask, handle)
                if s_.scan_politeness_delay_ms and i < len(batch) - 1:
                    await asyncio.sleep(s_.scan_politeness_delay_ms / 1000)
    return left, signin_problem


async def _goto(page: Page, policy: NetworkPolicy, url: str, timeout_s: int) -> tuple[Response | None, str | None]:
    current = url
    for _ in range(6):
        try:
            return await page.goto(current, wait_until="domcontentloaded", timeout=timeout_s * 1000), None
        except PwTimeout:
            return None, f"page timed out after {timeout_s} s"
        except Error as exc:
            if current in policy.nav_blocked:
                return None, policy.nav_blocked.pop(current)
            nxt = policy.nav_redirects.pop(current, None)
            if nxt is None:
                return None, _friendly_error(str(exc).splitlines()[0])
            current = nxt
    return None, "too many redirects"


async def _visit_one(
    context: Any,
    policy: NetworkPolicy,
    t: VisitTarget,
    viewport: str,
    timeout_s: int,
    mask: list[str],
    handle: Handler,
) -> None:
    page = await context.new_page()
    page.set_default_timeout(timeout_s * 1000)
    requests: list[dict[str, Any]] = []
    console: list[str] = []

    def on_request(req: Request) -> None:
        if len(requests) < 500:
            requests.append({"url": redact_url_tokens(req.url)[:500], "type": req.resource_type, "method": req.method})

    page.on("request", on_request)
    page.on("console", lambda m: console.append(m.text[:300]) if m.type == "error" and len(console) < 50 else None)
    try:
        await page.set_viewport_size(VIEWPORT_SIZES.get(viewport, DESKTOP))
        t0 = time.monotonic()
        resp, err = await _goto(page, policy, t.url, timeout_s)
        visit = Visit(
            target=t,
            viewport=viewport,
            page=None,
            status=None,
            final_url=None,
            error=err,
            requests=requests,
            console=console,
        )
        if resp is not None and err is None:
            with contextlib.suppress(PwTimeout, Error):
                await page.wait_for_load_state("load", timeout=5000)
            visit.load_ms = int((time.monotonic() - t0) * 1000)
            visit.status = resp.status
            visit.final_url = page.url
            fetched = policy.nav_headers.pop(resp.url, None)
            if fetched is not None:
                visit.headers = fetched
            else:
                with contextlib.suppress(Error):
                    visit.headers = [(h["name"], h["value"]) for h in await resp.headers_array()]
            if urlsplit(page.url).hostname != urlsplit(t.url).hostname:
                visit.error = "redirected outside the approved site"
            else:
                if mask:
                    with contextlib.suppress(Error):
                        await page.evaluate(MASK_JS, mask)
                visit.page = page
        await handle(visit)
    finally:
        with contextlib.suppress(Error):
            await page.close()
