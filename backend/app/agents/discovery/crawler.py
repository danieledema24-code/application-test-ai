"""Breadth-first, same-site, read-only crawler for the Application Discovery Agent.

Never clicks, types into or submits anything. GET search forms are explored by navigating to their result URL
with the harmless term "test" (lead decision); forms that send, create, change or delete data are only catalogued.
The frontier is persisted after every page so a paused or interrupted scan resumes without revisiting pages.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Protocol
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

from playwright.async_api import BrowserContext, ConsoleMessage, Error, Page, Request, Response
from playwright.async_api import TimeoutError as PwTimeout

from app.agents.discovery.heuristics import skip_reason
from app.agents.discovery.schemas import DiscoveryLimits, PageExtract, ResponsiveObs
from app.browser.network_policy import NetworkPolicy
from app.browser.pool import DESKTOP, MOBILE
from app.security.redact import redact_text, redact_url_tokens
from app.security.ssrf import host_matches

log = logging.getLogger(__name__)
_HERE = Path(__file__).parent
EXTRACT_JS = (_HERE / "extract.js").read_text(encoding="utf-8")
RESPONSIVE_JS = (_HERE / "responsive.js").read_text(encoding="utf-8")
DOM_JS = (_HERE / "dom_snapshot.js").read_text(encoding="utf-8")
# Signed-in pages often show the account name ("Signed in as …"). Before anything is captured (text, DOM, ARIA,
# screenshot), each credential value is replaced in text nodes, attributes and input values (P2-01: values never
# reach evidence).
MASK_JS = """(values) => {
  const vs = values.filter((v) => v && v.length >= 3);
  if (!vs.length) return 0;
  const esc = (v) => v.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
  const re = new RegExp(vs.map(esc).join('|'), 'gi');
  let n = 0;
  const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) { const t = w.currentNode; if (re.test(t.nodeValue)) { t.nodeValue = t.nodeValue.replace(re, '[redacted]'); n++; } re.lastIndex = 0; }
  for (const el of document.querySelectorAll('*')) {
    for (const a of [...el.attributes]) { if (re.test(a.value)) { el.setAttribute(a.name, a.value.replace(re, '[redacted]')); n++; } re.lastIndex = 0; }
    if ('value' in el && typeof el.value === 'string' && re.test(el.value)) { el.value = el.value.replace(re, '[redacted]'); n++; }
    re.lastIndex = 0;
  }
  return n;
}"""
PASSWORD_VALUES_JS = "[...document.querySelectorAll('input[type=password]')].map((i) => i.value)"  # noqa: S105 - JS source, not a secret
MAX_QUERY_VARIANTS = 20
SEARCH_TERM = "test"
_TRACKING = ("utm_", "fbclid", "gclid", "mc_", "_ga")

Control = Literal["pause", "cancel"] | None
StopKind = Literal["completed", "paused", "cancelled", "timeout", "failed"]
# Why the crawl ended, as reported to users: never claim the page limit unless it was actually reached.
StopReason = Literal["page_limit", "exhausted", "paused", "cancelled", "timeout", "failed"]


def stop_reason(stop: StopKind, not_visited: list[str]) -> StopReason:
    if stop != "completed":
        return stop
    # The loop only ends normally when the frontier is empty or max_pages pages were visited.
    return "page_limit" if not_visited else "exhausted"


def canonical(url: str) -> str:
    """Crawl identity: no fragment, lower-case host, default port dropped, tracking params removed, query sorted."""
    p = urlsplit(url)
    host = (p.hostname or "").lower()
    port = p.port
    netloc = host if port is None or (p.scheme, port) in (("http", 80), ("https", 443)) else f"{host}:{port}"
    query = urlencode(
        sorted((k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if not k.lower().startswith(_TRACKING))
    )
    return urlunsplit((p.scheme.lower(), netloc, p.path or "/", query, ""))


@dataclass
class FrontierItem:
    url: str
    depth: int
    parent_url: str | None = None
    found_via: str = "link"


@dataclass
class Frontier:
    queue: list[FrontierItem] = field(default_factory=list)
    seen: set[str] = field(default_factory=set)
    visited: int = 0
    attempted: int = 0
    elapsed_s: float = 0.0
    path_variants: dict[str, int] = field(default_factory=dict)
    searched_actions: set[str] = field(default_factory=set)
    started: bool = False

    def to_json(self) -> dict[str, Any]:
        return {
            "queue": [vars(i) for i in self.queue],
            "seen": sorted(self.seen),
            "visited": self.visited,
            "attempted": self.attempted,
            "elapsed_s": round(self.elapsed_s, 1),
            "path_variants": self.path_variants,
            "searched_actions": sorted(self.searched_actions),
            "started": self.started,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Frontier:
        return cls(
            queue=[FrontierItem(**i) for i in data.get("queue", [])],
            seen=set(data.get("seen", [])),
            visited=int(data.get("visited", 0)),
            attempted=int(data.get("attempted", 0)),
            elapsed_s=float(data.get("elapsed_s", 0.0)),
            path_variants=dict(data.get("path_variants", {})),
            searched_actions=set(data.get("searched_actions", [])),
            started=bool(data.get("started", False)),
        )


@dataclass
class CapturedPage:
    url: str
    final_url: str
    status: int | None
    depth: int
    parent_url: str | None
    found_via: str
    redirected_from: str | None
    extract: PageExtract
    responsive: dict[str, ResponsiveObs]
    console: list[dict[str, Any]]
    network: list[dict[str, Any]]
    screenshot: bytes | None
    mobile_screenshot: bytes | None
    dom_html: str | None
    aria: str | None
    load_ms: int


@dataclass
class FailedPage:
    url: str
    depth: int
    parent_url: str | None
    found_via: str
    status: int | None
    reason: str
    screenshot: bytes | None = None
    title: str = ""
    redirected_from: str | None = None


class CrawlSink(Protocol):
    async def control(self) -> Control: ...
    async def on_visiting(self, url: str, done: int, total: int | None) -> None: ...
    async def on_page(self, page: CapturedPage) -> None: ...
    async def on_failed(self, page: FailedPage) -> None: ...
    async def on_skip(self, url: str, reason: str) -> None: ...
    async def save_frontier(self, frontier: Frontier) -> None: ...


@dataclass
class CrawlResult:
    stop: StopKind
    frontier: Frontier
    not_visited: list[str]
    skipped_links: list[dict[str, str]]
    external_links: list[str]
    robots_skipped: list[str]
    robots: dict[str, Any] | None
    error: str | None = None

    @property
    def stop_reason(self) -> StopReason:
        return stop_reason(self.stop, self.not_visited)


class Crawler:
    def __init__(
        self,
        *,
        context: BrowserContext,
        policy: NetworkPolicy,
        start_url: str,
        allowed_hosts: list[str],
        limits: DiscoveryLimits,
        sink: CrawlSink,
        robots: RobotFileParser | None = None,
        sitemap_urls: list[str] | None = None,
        max_dom_bytes: int = 2 * 1024 * 1024,
    ) -> None:
        self.context = context
        self.policy = policy
        self.start_url = start_url
        self.allowed_hosts = allowed_hosts
        self.limits = limits
        self.sink = sink
        self.robots = robots
        self.sitemap_urls = sitemap_urls or []
        self.max_dom_bytes = max_dom_bytes
        self.skipped: dict[str, str] = {}
        self.external: set[str] = set()
        self.robots_skipped: list[str] = []
        self.mobile_taken = 0
        self.mask_values: list[str] = []  # credential values hidden on every captured page (signed-in pass)

    # ------------------------------------------------------------------ frontier helpers

    def _same_site(self, url: str) -> bool:
        p = urlsplit(url)
        return p.scheme in ("http", "https") and host_matches(p.hostname or "", self.allowed_hosts)

    def _enqueue(self, fr: Frontier, url: str, depth: int, parent: str | None, via: str) -> None:
        if not url.startswith(("http://", "https://")):
            return
        if not self._same_site(url):
            if len(self.external) < 200:
                self.external.add(canonical(url))
            return
        key = canonical(url)
        if key in fr.seen or any(canonical(i.url) == key for i in fr.queue):
            return
        reason = skip_reason(key)
        if reason:
            self.skipped.setdefault(key, reason)
            return
        if depth > self.limits.max_depth:
            return
        p = urlsplit(key)
        if p.query:
            n = fr.path_variants.get(p.path, 0)
            if n >= MAX_QUERY_VARIANTS:
                self.skipped.setdefault(key, "too many query variants of the same page")
                return
            fr.path_variants[p.path] = n + 1
        if self.limits.respect_robots and self.robots is not None and not self.robots.can_fetch("*", key):
            if key not in self.robots_skipped:
                self.robots_skipped.append(key)
            return
        fr.queue.append(FrontierItem(url=key, depth=depth, parent_url=parent, found_via=via))

    # ------------------------------------------------------------------ main loop

    async def run(self, frontier: Frontier | None = None) -> CrawlResult:
        fr = frontier or Frontier()
        if not fr.started:
            fr.started = True
            self._enqueue(fr, self.start_url, 0, None, "start")
            for u in self.sitemap_urls[:200]:
                self._enqueue(fr, u, 1, None, "sitemap")
        page = await self.context.new_page()
        page.set_default_timeout(self.limits.page_timeout_s * 1000)
        console: list[dict[str, Any]] = []
        network: list[dict[str, Any]] = []
        page.on("console", lambda m: _on_console(console, m))
        page.on("pageerror", lambda e: console.append({"level": "error", "text": redact_text(str(e))[:500]}))
        page.on("requestfailed", lambda r: _on_failed(network, r))
        page.on("response", lambda r: _on_response(network, r))
        resumed_at = time.monotonic()
        base_elapsed = fr.elapsed_s
        stop: StopKind = "completed"
        error: str | None = None
        try:
            while fr.queue and fr.visited < self.limits.max_pages:
                fr.elapsed_s = base_elapsed + (time.monotonic() - resumed_at)
                if fr.elapsed_s >= self.limits.total_timeout_s:
                    stop = "timeout"
                    break
                ctl = await self.sink.control()
                if ctl == "pause":
                    stop = "paused"
                    break
                if ctl == "cancel":
                    stop = "cancelled"
                    break
                item = fr.queue.pop(0)
                key = canonical(item.url)
                if key in fr.seen:
                    continue
                fr.seen.add(key)
                fr.attempted += 1
                await self.sink.on_visiting(key, fr.visited, self.limits.max_pages)
                console.clear()
                network.clear()
                await self._visit(page, fr, item, console, network)
                fr.elapsed_s = base_elapsed + (time.monotonic() - resumed_at)
                await self.sink.save_frontier(fr)
                if fr.queue and self.limits.politeness_ms:
                    await asyncio.sleep(self.limits.politeness_ms / 1000)
        except Exception as exc:
            log.exception("crawler stopped")
            stop = "failed"
            error = (
                "The browser crashed."
                if "closed" in str(exc).lower()
                else f"Unexpected error: {str(exc).splitlines()[0][:200]}"
            )
        finally:
            fr.elapsed_s = base_elapsed + (time.monotonic() - resumed_at)
            await self.sink.save_frontier(fr)
            with contextlib.suppress(Error):
                await page.close()
        not_visited = [i.url for i in fr.queue if canonical(i.url) not in fr.seen]
        return CrawlResult(
            stop=stop,
            frontier=fr,
            not_visited=not_visited,
            skipped_links=[{"url": u, "reason": r} for u, r in self.skipped.items()],
            external_links=sorted(self.external),
            robots_skipped=self.robots_skipped,
            robots=None,
            error=error,
        )

    async def _goto(self, page: Page, url: str) -> tuple[Response | None, str | None, str | None]:
        """Navigates, following policy-validated redirects. Returns (response, error, redirected_from)."""
        current = url
        redirected_from: str | None = None
        for _ in range(6):
            try:
                resp = await page.goto(
                    current, wait_until="domcontentloaded", timeout=self.limits.page_timeout_s * 1000
                )
                return resp, None, redirected_from
            except PwTimeout:
                return None, f"timed out after {self.limits.page_timeout_s} s", redirected_from
            except Error as exc:
                if current in self.policy.nav_blocked:
                    return None, self.policy.nav_blocked.pop(current), redirected_from
                nxt = self.policy.nav_redirects.pop(current, None)
                if nxt is None:
                    msg = str(exc).splitlines()[0]
                    return None, _friendly_error(msg), redirected_from
                redirected_from = redirected_from or url
                current = nxt
        return None, "too many redirects", redirected_from

    async def _visit(
        self, page: Page, fr: Frontier, item: FrontierItem, console: list[dict[str, Any]], network: list[dict[str, Any]]
    ) -> None:
        t0 = time.monotonic()
        resp, err, redirected_from = await self._goto(page, item.url)
        if err is not None:
            await self.sink.on_failed(FailedPage(item.url, item.depth, item.parent_url, item.found_via, None, err))
            return
        with contextlib.suppress(PwTimeout, Error):
            await page.wait_for_load_state("networkidle", timeout=5000)
        load_ms = int((time.monotonic() - t0) * 1000)
        final_url = page.url
        if not self._same_site(final_url):
            await self.sink.on_failed(
                FailedPage(
                    item.url, item.depth, item.parent_url, item.found_via, None, "Redirected outside the approved site"
                )
            )
            return
        final_key = canonical(final_url)
        if redirected_from and final_key in fr.seen and final_key != canonical(item.url):
            # Redirect to a page already captured (e.g. several protected pages -> /login): record the boundary only.
            await self.sink.on_failed(
                FailedPage(
                    item.url,
                    item.depth,
                    item.parent_url,
                    item.found_via,
                    resp.status if resp else None,
                    f"Redirects to {urlsplit(final_url).path}",
                    redirected_from=final_url,
                )
            )
            return
        fr.seen.add(final_key)
        status = resp.status if resp else None
        await self.capture(page, fr, item, final_url, status, redirected_from, load_ms, console, network)

    async def capture(
        self,
        page: Page,
        fr: Frontier,
        item: FrontierItem,
        final_url: str,
        status: int | None,
        redirected_from: str | None,
        load_ms: int,
        console: list[dict[str, Any]],
        network: list[dict[str, Any]],
    ) -> None:
        """Records the page as currently loaded in `page` (also used for the post-sign-in page, which is the
        response to the sign-in POST and can't be fetched again with GET)."""
        final_key = canonical(final_url)
        if self.mask_values:
            with contextlib.suppress(Error):
                await page.evaluate(MASK_JS, self.mask_values)
        if status is not None and status >= 400:
            shot = await _screenshot(page)
            title = ""
            with contextlib.suppress(Error):
                title = (await page.title())[:300]
            await self.sink.on_failed(
                FailedPage(item.url, item.depth, item.parent_url, item.found_via, status, f"HTTP {status}", shot, title)
            )
            return
        raw = await page.evaluate(EXTRACT_JS)
        extract = PageExtract.model_validate(raw)
        responsive: dict[str, ResponsiveObs] = {
            "desktop": ResponsiveObs.model_validate(await page.evaluate(RESPONSIVE_JS))
        }
        shot = await _screenshot(page)
        mobile_shot: bytes | None = None
        if self.limits.include_mobile and self.mobile_taken < self.limits.mobile_sample:
            try:
                await page.set_viewport_size(MOBILE)  # type: ignore[arg-type]
                await page.wait_for_timeout(250)
                responsive["mobile"] = ResponsiveObs.model_validate(await page.evaluate(RESPONSIVE_JS))
                mobile_shot = await _screenshot(page)
                self.mobile_taken += 1
            finally:
                await page.set_viewport_size(DESKTOP)  # type: ignore[arg-type]
        dom_html: str | None = None
        try:
            dom = str(await page.evaluate(DOM_JS))
            dom_html = dom[: self.max_dom_bytes]
        except Error:
            pass
        aria: str | None = None
        with contextlib.suppress(Error):
            aria = (await page.locator("body").aria_snapshot(timeout=5000))[:200_000]
        # Password values (pre-filled or autofilled) must never reach stored evidence (T8). The ARIA snapshot
        # reports textbox values, so every captured text is redacted against the page's current password values.
        secrets: list[str] = []
        with contextlib.suppress(Error):
            secrets = [str(v) for v in await page.evaluate(PASSWORD_VALUES_JS) if v]
        if secrets:
            aria = redact_text(aria, secrets) if aria else aria
            dom_html = redact_text(dom_html, secrets) if dom_html else dom_html
            extract = PageExtract.model_validate(
                json.loads(redact_text(extract.model_dump_json(), [json.dumps(x)[1:-1] for x in secrets]))
            )
        fr.visited += 1
        captured = CapturedPage(
            url=item.url,
            final_url=final_url,
            status=status,
            depth=item.depth,
            parent_url=item.parent_url,
            found_via=item.found_via,
            redirected_from=redirected_from,
            extract=extract,
            responsive=responsive,
            console=list(console)[:50],
            network=list(network)[:50],
            screenshot=shot,
            mobile_screenshot=mobile_shot,
            dom_html=dom_html,
            aria=aria,
            load_ms=load_ms,
        )
        await self.sink.on_page(captured)
        for link in extract.links:
            if link.download:
                self.skipped.setdefault(canonical(link.href), "file download")
                continue
            self._enqueue(fr, urljoin(final_url, link.href), item.depth + 1, final_key, "link")
        for comp in extract.components:
            if comp.kind != "search":
                continue
            action = comp.details.get("form_action")
            param = comp.details.get("param")
            if (
                comp.details.get("form_method") == "GET"
                and isinstance(action, str)
                and isinstance(param, str)
                and param
            ):
                if action in fr.searched_actions:
                    continue
                fr.searched_actions.add(action)
                parts = urlsplit(action)
                url = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode({param: SEARCH_TERM}), ""))
                self._enqueue(fr, url, item.depth + 1, final_key, "search")


def _friendly_error(msg: str) -> str:
    m = msg.lower()
    if "err_name_not_resolved" in m:
        return "host not found"
    if "err_connection_refused" in m:
        return "connection refused"
    if "timeout" in m:
        return "timed out"
    if "err_blocked_by_client" in m:
        return "blocked by the scanner's network policy"
    if "err_cert" in m or "ssl" in m:
        return "TLS certificate error"
    if "err_aborted" in m:
        return "navigation aborted (download or blocked)"
    return msg[:200]


async def _screenshot(page: Page) -> bytes | None:
    try:
        return await page.screenshot(
            type="jpeg", quality=70, mask=[page.locator("input[type=password]")], timeout=10_000
        )
    except Error:
        return None


def _on_console(sink: list[dict[str, Any]], msg: ConsoleMessage) -> None:
    if msg.type in ("error", "warning") and len(sink) < 100:
        sink.append({"level": "error" if msg.type == "error" else "warning", "text": redact_text(msg.text)[:500]})


def _on_failed(sink: list[dict[str, Any]], req: Request) -> None:
    failure = req.failure or "failed"
    if "ERR_BLOCKED_BY_CLIENT" in failure or "ERR_ABORTED" in failure:
        return  # recorded by the network policy / expected aborts
    if len(sink) < 100:
        sink.append({"url": redact_url_tokens(req.url)[:500], "status": None, "failure": failure[:200]})


def _on_response(sink: list[dict[str, Any]], resp: Response) -> None:
    if resp.status >= 400 and len(sink) < 100:
        sink.append({"url": redact_url_tokens(resp.url)[:500], "status": resp.status, "failure": None})


def parse_robots(text: str) -> tuple[RobotFileParser, list[str]]:
    rp = RobotFileParser()
    rp.parse(text.splitlines())
    sitemaps = [line.split(":", 1)[1].strip() for line in text.splitlines() if line.lower().startswith("sitemap:")]
    return rp, sitemaps
