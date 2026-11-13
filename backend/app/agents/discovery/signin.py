"""One sign-in attempt with saved test credentials (P2-01).

Opens the sign-in page, finds the form that contains a password input, fills the nearest username/email input
and the password, and submits **only that form**, once. CAPTCHA or MFA markers stop the attempt before anything is
submitted. Values are never logged or returned; callers register them with the redactor for the task.
"""

from __future__ import annotations

import contextlib
import logging
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from playwright.async_api import BrowserContext, Error, Page

from app.browser.network_policy import NetworkPolicy

log = logging.getLogger(__name__)

FAILURE_TEXT = re.compile(
    r"invalid|incorrect|wrong (?:email|password|username)|not recogni[sz]ed|try again|failed|doesn['’]t match|"
    r"unable to sign in|login failed",
    re.IGNORECASE,
)
CAPTCHA_SELECTOR = (
    ".g-recaptcha, .h-captcha, [data-sitekey], iframe[src*='recaptcha'], iframe[src*='hcaptcha'], "
    "iframe[src*='turnstile'], .cf-turnstile"
)
MFA_SELECTOR = "input[autocomplete='one-time-code'], input[name*='otp' i], input[name*='totp' i], input[name*='2fa' i]"
SIGN_OUT = re.compile(r"\b(sign|log)\s?-?out\b", re.IGNORECASE)
ACCOUNT_MARKER = re.compile(
    r"\b(signed|logged) in as\b|\bmy account\b|\bwelcome back\b|\byour account\b|\b(sign|log)\s?-?out\b",
    re.IGNORECASE,
)
ERROR_SELECTOR = "[role='alert'], .error, .alert-danger, .alert-error, .invalid-feedback, .form-error, .error-message"


@dataclass
class SignInOutcome:
    result: str  # succeeded | failed
    reason_code: str | None  # form_not_found | rejected | captcha | mfa_required | timeout | blocked
    landing_url: str | None = None
    links: list[str] | None = None
    page: Page | None = field(default=None, repr=False)  # the post-sign-in page, left open when keep_page=True
    status: int | None = None
    screenshot: bytes | None = field(default=None, repr=False)  # failures: the page afterwards, values masked


async def _failure(page: Page, reason: str, values: list[str]) -> SignInOutcome:
    """A failed outcome with a screenshot of the page as it was left. Credential values are blanked in inputs and
    masked in the page text first, so the image never shows them."""
    from app.agents.discovery.crawler import MASK_JS

    shot: bytes | None = None
    with contextlib.suppress(Error):
        await page.evaluate(
            "() => document.querySelectorAll('input').forEach((i) => { if (i.type !== 'hidden') i.value = ''; })"
        )
        await page.evaluate(MASK_JS, values)
        shot = await page.screenshot(type="jpeg", quality=70, full_page=False)
    return SignInOutcome("failed", reason, screenshot=shot)


async def _links(page: Page) -> list[str]:
    try:
        hrefs = await page.eval_on_selector_all("a[href]", "els => els.map(e => e.href)")
    except Error:
        return []
    return [str(h) for h in hrefs][:300]


async def sign_in(
    context: BrowserContext,
    policy: NetworkPolicy,
    login_url: str,
    username: str,
    password: str,
    *,
    timeout_ms: float = 20_000,
    keep_page: bool = False,
) -> SignInOutcome:
    """With keep_page, a successful outcome carries the open post-sign-in page; the caller closes it."""
    page = await context.new_page()
    kept = False
    page.set_default_timeout(timeout_ms)
    try:
        try:
            await page.goto(login_url, wait_until="domcontentloaded")
        except Error:
            return SignInOutcome("failed", "blocked" if login_url in policy.nav_blocked else "timeout")
        if login_url in policy.nav_blocked:
            return SignInOutcome("failed", "blocked")
        if await page.locator(CAPTCHA_SELECTOR).count() > 0:
            return await _failure(page, "captcha", [username, password])
        if await page.locator(MFA_SELECTOR).count() > 0:
            return await _failure(page, "mfa_required", [username, password])
        form = page.locator("form:has(input[type='password'])").first
        if await page.locator("form:has(input[type='password'])").count() == 0:
            return await _failure(page, "form_not_found", [username, password])
        user = form.locator(
            "input[type='email'], input[autocomplete='username'], input[name*='user' i], input[name*='email' i], "
            "input[name*='login' i], input[type='text']"
        ).first
        pwd = form.locator("input[type='password']").first
        if await user.count() == 0:
            return await _failure(page, "form_not_found", [username, password])
        before_links = set(await _links(page))
        before_cookies = {(c.get("name"), c.get("value")) for c in await context.cookies()}
        await user.fill(username)
        await pwd.fill(password)
        submit = form.locator("button[type='submit'], input[type='submit'], button:not([type])").first
        status: int | None = None
        try:
            async with page.expect_navigation(wait_until="domcontentloaded", timeout=timeout_ms) as nav:
                if await submit.count() > 0:
                    await submit.click()
                else:
                    await form.evaluate("f => f.requestSubmit ? f.requestSubmit() : f.submit()")
            response = await nav.value
            status = response.status if response is not None else None
        except Error:
            # A redirect after the POST is validated by the policy and left for us to follow.
            pass
        target = next(
            (v for k, v in policy.nav_redirects.items() if urlsplit(k).path == urlsplit(login_url).path), None
        )
        if target:
            with contextlib.suppress(Error):
                await page.goto(target, wait_until="domcontentloaded")
        if await page.locator(CAPTCHA_SELECTOR).count() > 0:
            return await _failure(page, "captcha", [username, password])
        if await page.locator(MFA_SELECTOR).count() > 0:
            return await _failure(page, "mfa_required", [username, password])
        text = ""
        with contextlib.suppress(Error):
            text = await page.inner_text("body")
        links = await _links(page)
        password_visible = await page.locator("input[type='password']:visible").count() > 0
        left_login = urlsplit(page.url).path != urlsplit(login_url).path
        after_cookies = {(c.get("name"), c.get("value")) for c in await context.cookies()}
        new_cookie = bool(after_cookies - before_cookies)
        marker = bool(ACCOUNT_MARKER.search(text))
        error_text = ""
        with contextlib.suppress(Error):
            error_text = " ".join(await page.locator(ERROR_SELECTOR).all_inner_texts())
        # Failure: an HTTP error for the submit, a visible error message, or the same sign-in form shown again.
        error_shown = bool(FAILURE_TEXT.search(error_text)) or (password_visible and bool(FAILURE_TEXT.search(text)))
        same_form = password_visible and not left_login and not marker
        rejected_status = status is not None and status >= 400
        if error_shown or same_form or rejected_status:
            return await _failure(page, "rejected", [username, password])
        # Success: any positive signal (moved away from the sign-in page, a session cookie, the form disappeared, or
        # an account / sign-out marker), now that failure signals are ruled out.
        if left_login or new_cookie or not password_visible or marker or bool(set(links) - before_links):
            kept = keep_page
            return SignInOutcome("succeeded", None, page.url, links, page if keep_page else None, status)
        return await _failure(page, "rejected", [username, password])
    except Error as exc:
        log.info("sign-in attempt stopped: %s", str(exc).splitlines()[0][:120])
        return SignInOutcome("failed", "timeout")
    finally:
        if not kept:
            with contextlib.suppress(Error):
                await page.close()
