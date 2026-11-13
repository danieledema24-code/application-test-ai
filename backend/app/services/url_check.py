"""Gate 1 URL check and SSRF-safe HTTP fetches (robots.txt, sitemap.xml).

httpx with `follow_redirects=False`; every redirect hop is normalised and checked (max 5); 10 s timeout;
body capped at 1 MB; GET only. Blocked and unreachable outcomes are data, not errors.
"""

from __future__ import annotations

import re
import ssl
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urljoin
from urllib.robotparser import RobotFileParser

import httpx

from app.context import AppContext
from app.db.types import utcnow
from app.security.ssrf import BlockedCode, NormalisedUrl, UrlRejected, check_host, normalise_url

MAX_BODY = 1024 * 1024
_TITLE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_BOT = re.compile(
    r"cf-chl|cf_chl|challenge-platform|g-recaptcha|h-captcha|hcaptcha|cf-turnstile|are you a robot|verify you are human",
    re.I,
)
UA = "QAAnalystDiscovery/0.1 (+authorised QA scan)"


@dataclass
class FetchResult:
    ok: bool
    status: int | None = None
    final_url: str | None = None
    redirects: list[dict[str, Any]] = field(default_factory=list)
    blocked_code: BlockedCode | None = None
    blocked_reason: str | None = None
    blocked_ip: str | None = None
    resolved_ips: list[str] = field(default_factory=list)
    error_code: str | None = None
    error: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""
    tls: dict[str, Any] | None = None


async def safe_fetch(
    ctx: AppContext, url: NormalisedUrl, *, approved_origins: set[str], max_redirects: int | None = None
) -> FetchResult:
    s = ctx.settings
    max_hops = s.url_check_max_redirects if max_redirects is None else max_redirects
    result = FetchResult(ok=False)
    current = url
    timeout = httpx.Timeout(s.url_check_timeout_s)
    async with httpx.AsyncClient(
        follow_redirects=False, timeout=timeout, transport=ctx.http_transport, headers={"User-Agent": UA}, verify=True
    ) as client:
        for hop in range(max_hops + 1):
            allow_loopback = s.allow_private_targets and current.origin in approved_origins
            chk = await check_host(
                current.host, allow_loopback=allow_loopback, resolver=ctx.resolver, dns_timeout_s=s.url_check_timeout_s
            )
            if hop == 0:
                result.resolved_ips = chk.resolved_ips
            if not chk.allowed:
                if hop > 0 and chk.code != BlockedCode.dns_failure:
                    result.blocked_code = BlockedCode.redirect_blocked
                    result.blocked_reason = f"Redirect to a blocked address: {current.url} ({chk.reason})"
                elif chk.dns_timed_out:
                    result.error_code = "dns_timeout"
                    result.error = f"The DNS lookup for {current.host} took longer than {s.url_check_timeout_s:g} s"
                elif chk.code == BlockedCode.dns_failure:
                    result.error_code = "dns_failure"
                    result.error = f"Could not resolve {current.host}"
                else:
                    result.blocked_code = chk.code
                    result.blocked_reason = chk.reason
                result.blocked_ip = chk.blocked_ip
                return result
            try:
                async with client.stream("GET", current.url) as resp:
                    body = b""
                    async for chunk in resp.aiter_bytes():
                        body += chunk
                        if len(body) >= MAX_BODY:
                            body = body[:MAX_BODY]
                            break
            except httpx.TimeoutException:
                result.error_code = "timeout"
                result.error = f"No response after {int(s.url_check_timeout_s)} s"
                return result
            except httpx.ConnectError as exc:
                cause = exc.__cause__ or exc.__context__
                text = str(exc)
                if isinstance(cause, ssl.SSLError) or "CERTIFICATE" in text.upper() or "SSL" in text.upper():
                    result.error_code = "tls_error"
                    result.error = "TLS certificate could not be verified"
                    result.tls = {"valid": False, "error": text[:200]}
                else:
                    result.error_code = "connection_failed"
                    result.error = "Connection refused or reset"
                return result
            except httpx.HTTPError as exc:
                result.error_code = "connection_failed"
                result.error = str(exc)[:200] or "HTTP error"
                return result
            if current.scheme == "https":
                result.tls = {"valid": True, "error": None}
            location = resp.headers.get("location")
            if 300 <= resp.status_code < 400 and location:
                result.redirects.append({"url": current.url, "status": resp.status_code})
                if hop == max_hops:
                    result.error_code = "too_many_redirects"
                    result.error = f"More than {max_hops} redirects"
                    return result
                try:
                    current = normalise_url(urljoin(current.url, location))
                except UrlRejected as exc:
                    result.blocked_code = BlockedCode.redirect_blocked
                    result.blocked_reason = f"Redirect to a blocked address ({exc.reason})"
                    return result
                continue
            result.ok = True
            result.status = resp.status_code
            result.final_url = current.url
            result.headers = {k.lower(): v for k, v in resp.headers.items()}
            result.body = body
            return result
    return result


def _title(body: bytes, content_type: str | None) -> str | None:
    if not content_type or "html" not in content_type:
        return None
    m = _TITLE.search(body[:200_000].decode("utf-8", errors="replace"))
    if not m:
        return None
    return " ".join(m.group(1).split())[:200] or None


async def fetch_robots(
    ctx: AppContext, origin_url: NormalisedUrl, approved_origins: set[str]
) -> tuple[str | None, FetchResult]:
    robots_url = normalise_url(f"{origin_url.origin}/robots.txt")
    res = await safe_fetch(ctx, robots_url, approved_origins=approved_origins, max_redirects=2)
    if res.ok and res.status == 200 and "html" not in (res.headers.get("content-type") or ""):
        return res.body.decode("utf-8", errors="replace"), res
    return None, res


async def check_url(ctx: AppContext, raw: str) -> dict[str, Any]:
    """Runs the full Gate 1 automated check. Always returns a result dict (UrlCheckResult)."""
    out: dict[str, Any] = {
        "input_url": raw,
        "normalised_url": raw.strip(),
        "allowed": False,
        "blocked_reason": None,
        "blocked_code": None,
        "blocked_ip": None,
        "reachable": False,
        "unreachable_code": None,
        "unreachable_reason": None,
        "http_status": None,
        "final_url": None,
        "redirects": [],
        "cross_site_redirect": False,
        "tls": None,
        "content_type": None,
        "robots": None,
        "title": None,
        "resolved_ips": [],
        "requires_auth": False,
        "bot_protection": False,
        "existing_project": None,
        "checked_at": utcnow().isoformat(),
    }
    try:
        n = normalise_url(raw)
    except UrlRejected as exc:
        out.update(blocked_reason=exc.reason, blocked_code=exc.code.value)
        return out
    out["normalised_url"] = n.url
    res = await safe_fetch(ctx, n, approved_origins={n.origin})
    out["resolved_ips"] = res.resolved_ips
    out["redirects"] = res.redirects
    out["tls"] = res.tls
    if res.blocked_code is not None:
        out.update(blocked_reason=res.blocked_reason, blocked_code=res.blocked_code.value, blocked_ip=res.blocked_ip)
        return out
    out["allowed"] = True
    if not res.ok:
        out.update(unreachable_code=res.error_code, unreachable_reason=res.error)
        return out
    final = normalise_url(res.final_url or n.url)
    status = res.status or 0
    ctype = res.headers.get("content-type")
    out.update(
        reachable=True,
        http_status=status,
        final_url=final.url,
        cross_site_redirect=final.host != n.host,
        content_type=ctype,
        title=_title(res.body, ctype),
        requires_auth=status in (401, 403),
    )
    body_text = res.body[:200_000].decode("utf-8", errors="replace")
    out["bot_protection"] = bool(_BOT.search(body_text)) or res.headers.get("cf-mitigated") == "challenge"
    if status == 404:
        out.update(unreachable_code="http_404", unreachable_reason="The page does not exist (HTTP 404)")
    elif status >= 500:
        out.update(unreachable_code="http_5xx", unreachable_reason=f"Server error (HTTP {status})")
    robots_text, robots_res = await fetch_robots(ctx, final, {n.origin, final.origin})
    if robots_text is not None:
        rp = RobotFileParser()
        rp.parse(robots_text.splitlines())
        out["robots"] = {"found": True, "disallows_start": not rp.can_fetch("*", final.url)}
    elif robots_res.ok or robots_res.error_code is None:
        out["robots"] = {"found": False, "disallows_start": False}
    return out


def is_startable(result: dict[str, Any]) -> bool:
    return bool(result["allowed"] and result["reachable"] and result.get("unreachable_code") is None)
