"""One Chromium per worker process, a bounded number of isolated contexts (one per scan)."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from playwright.async_api import Browser, BrowserContext, Playwright, async_playwright

from app.browser.network_policy import NetworkPolicy

log = logging.getLogger(__name__)

DESKTOP = {"width": 1440, "height": 900}
MOBILE = {"width": 390, "height": 844}
USER_AGENT_SUFFIX = " QAAnalystDiscovery/0.1 (+authorised QA scan)"


class BrowserPool:
    def __init__(self, *, headless: bool = True, max_contexts: int = 4) -> None:
        self._headless = headless
        self._sem = asyncio.Semaphore(max_contexts)
        self._lock = asyncio.Lock()
        self._pw: Playwright | None = None
        self._browser: Browser | None = None

    async def browser(self) -> Browser:
        async with self._lock:
            if self._browser is None or not self._browser.is_connected():
                if self._pw is None:
                    self._pw = await async_playwright().start()
                # Chromium sandbox stays on (no --no-sandbox); no extensions; no persistent profile.
                self._browser = await self._pw.chromium.launch(headless=self._headless)
            return self._browser

    @asynccontextmanager
    async def isolated_context(
        self, policy: NetworkPolicy | None, *, java_script: bool = True, offline: bool = False
    ) -> AsyncIterator[BrowserContext]:
        """Fresh incognito context: no shared cookies/storage, downloads off, service workers blocked."""
        async with self._sem:
            browser = await self.browser()
            ua = (await self._default_ua(browser)) + USER_AGENT_SUFFIX
            context = await browser.new_context(
                viewport=DESKTOP,  # type: ignore[arg-type]
                user_agent=ua,
                accept_downloads=False,
                service_workers="block",
                java_script_enabled=java_script,
                bypass_csp=False,
                ignore_https_errors=False,
                permissions=[],
                locale="en-GB",
            )
            try:
                if offline:
                    await context.route("**/*", _block_network)
                elif policy is not None:
                    await policy.apply(context)
                yield context
            finally:
                try:
                    await context.close()
                except Exception:
                    log.debug("context close failed", exc_info=True)

    async def _default_ua(self, browser: Browser) -> str:
        return f"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/{browser.version}"

    async def available(self) -> bool:
        try:
            await self.browser()
            return True
        except Exception:  # noqa: BLE001 - health check reports any launch failure as unavailable
            return False

    async def close(self) -> None:
        async with self._lock:
            if self._browser is not None:
                with contextlib.suppress(Exception):  # browser already gone: nothing to clean up
                    await self._browser.close()
                self._browser = None
            if self._pw is not None:
                await self._pw.stop()
                self._pw = None


async def _block_network(route: object) -> None:
    from playwright.async_api import Route

    assert isinstance(route, Route)
    url = route.request.url
    if url.startswith(("data:", "about:")):
        await route.continue_()
    else:
        await route.abort("blockedbyclient")
