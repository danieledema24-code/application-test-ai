"""Passive security rule table (P5-03, decision D19): what a normal visitor's browser receives.

Pure evaluation over observed facts (main-document response headers, cookie names and flags, the network log, the
page's forms, scripts and text) plus one plain-http GET of the start URL and one TLS handshake per HTTPS host.
Every rule ends `failed` (a finding per page), `passed`, `not_applicable` (with the reason) or `not_checked` (with
the reason), so the reader sees what was and wasn't checked. Cookie values are never read or stored: only names
and flags. Severity comes from this table, never from the AI.
"""

from __future__ import annotations

import hashlib
import ipaddress
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit

from app.domain.enums import DefectSeverity, FindingSeverity

STATEMENT = (
    "This is a passive check of what a normal visitor's browser receives. It is not a security audit or a "
    "penetration test, and no findings does not mean the site is secure."
)
LOOPBACK = "The target is plain http on this computer (loopback)"
NOT_HTTPS = "The site isn't served over HTTPS"
DEFECT_SEVERITY = {
    FindingSeverity.high: DefectSeverity.major,
    FindingSeverity.medium: DefectSeverity.minor,
    FindingSeverity.low: DefectSeverity.minor,
    FindingSeverity.info: DefectSeverity.trivial,
}
HSTS_MIN_AGE = 180 * 24 * 3600
OWASP_HEADERS = "https://owasp.org/www-project-secure-headers/"
OWASP_WSTG = "https://owasp.org/www-project-web-security-testing-guide/"
ASVS = "https://owasp.org/www-project-application-security-verification-standard/"


@dataclass(frozen=True)
class Rule:
    id: str
    category: str  # transport | headers | cookies | content
    title: str
    severity: FindingSeverity
    why: str
    fix: str
    reference: dict[str, str]
    passed_text: str = ""


def _ref(name: str, url: str) -> dict[str, str]:
    return {"type": "owasp", "name": name, "url": url}


RULES: list[Rule] = [
    Rule(
        "https",
        "transport",
        "Pages served over HTTPS",
        FindingSeverity.high,
        "Over plain http, anyone on the network can read or change what visitors send and receive.",
        "Serve every page over HTTPS with a valid certificate.",
        _ref("OWASP ASVS V9: Communication", ASVS),
        "Pages are served over HTTPS",
    ),
    Rule(
        "http-redirect",
        "transport",
        "HTTP redirects to HTTPS",
        FindingSeverity.medium,
        "Visitors who type the address without https stay on an unencrypted page.",
        "Redirect every http:// request to the https:// address (301 or 308).",
        _ref("OWASP WSTG: Test HTTP Strict Transport Security", OWASP_WSTG),
        "http:// redirects to https://",
    ),
    Rule(
        "hsts",
        "transport",
        "HSTS",
        FindingSeverity.medium,
        "Without HSTS, a visitor's first request can be downgraded to plain http.",
        "Send Strict-Transport-Security: max-age=31536000 (at least 180 days).",
        _ref("OWASP Secure Headers Project: Strict-Transport-Security", OWASP_HEADERS),
        "HSTS is sent",
    ),
    Rule(
        "tls-version",
        "transport",
        "TLS version",
        FindingSeverity.high,
        "Old TLS versions have known weaknesses.",
        "Allow TLS 1.2 and 1.3 only.",
        _ref("OWASP ASVS V9: Communication", ASVS),
        "TLS 1.2 or newer",
    ),
    Rule(
        "certificate-valid",
        "transport",
        "Certificate is valid",
        FindingSeverity.high,
        "Browsers warn visitors, and attackers can impersonate the site.",
        "Install a certificate from a trusted authority that matches the host name.",
        _ref("OWASP ASVS V9: Communication", ASVS),
        "The certificate is valid for this host",
    ),
    Rule(
        "certificate-expiry",
        "transport",
        "Certificate expires soon",
        FindingSeverity.medium,
        "When the certificate expires, browsers block the site.",
        "Renew the certificate (automate renewal).",
        _ref("OWASP ASVS V9: Communication", ASVS),
        "The certificate is valid for more than 30 days",
    ),
    Rule(
        "password-over-http",
        "transport",
        "Password field over HTTP",
        FindingSeverity.high,
        "Passwords typed on a plain http page travel unencrypted.",
        "Serve sign-in pages over HTTPS only.",
        _ref("OWASP ASVS V9: Communication", ASVS),
        "Password fields are on HTTPS pages",
    ),
    Rule(
        "csp-missing",
        "headers",
        "Content-Security-Policy missing",
        FindingSeverity.medium,
        "Without a policy, a script injected into a page can run and steal what visitors type.",
        "Send a Content-Security-Policy header. Start with: default-src 'self'; and add the sources your pages need.",
        _ref("OWASP Secure Headers Project: Content-Security-Policy", OWASP_HEADERS),
        "Content-Security-Policy is sent",
    ),
    Rule(
        "csp-unsafe",
        "headers",
        "Content-Security-Policy allows unsafe scripts",
        FindingSeverity.low,
        "'unsafe-inline' or * in script-src lets injected scripts run anyway.",
        "Remove 'unsafe-inline' and * from script-src; use nonces or hashes.",
        _ref("OWASP Secure Headers Project: Content-Security-Policy", OWASP_HEADERS),
        "The policy doesn't allow unsafe scripts",
    ),
    Rule(
        "nosniff",
        "headers",
        "X-Content-Type-Options: nosniff missing",
        FindingSeverity.low,
        "Browsers may guess a file's type and run an upload as a script.",
        "Send X-Content-Type-Options: nosniff on every response.",
        _ref("OWASP Secure Headers Project: X-Content-Type-Options", OWASP_HEADERS),
        "nosniff is sent",
    ),
    Rule(
        "clickjacking",
        "headers",
        "No clickjacking protection",
        FindingSeverity.medium,
        "Another site can show your pages in a hidden frame and trick visitors into clicking.",
        "Send Content-Security-Policy: frame-ancestors 'self' (or X-Frame-Options: DENY).",
        _ref("OWASP Secure Headers Project: X-Frame-Options", OWASP_HEADERS),
        "Framing is restricted",
    ),
    Rule(
        "referrer-policy",
        "headers",
        "Referrer-Policy missing",
        FindingSeverity.low,
        "Full page addresses, which can contain private details, are sent to other sites.",
        "Send Referrer-Policy: strict-origin-when-cross-origin.",
        _ref("OWASP Secure Headers Project: Referrer-Policy", OWASP_HEADERS),
        "Referrer-Policy is sent",
    ),
    Rule(
        "permissions-policy",
        "headers",
        "Permissions-Policy missing",
        FindingSeverity.info,
        "Embedded content may ask for the camera, microphone or location.",
        "Send Permissions-Policy and switch off the features you don't use, e.g. camera=(), microphone=().",
        _ref("OWASP Secure Headers Project: Permissions-Policy", OWASP_HEADERS),
        "Permissions-Policy is sent",
    ),
    Rule(
        "cors-credentials",
        "headers",
        "CORS allows any site with credentials",
        FindingSeverity.high,
        "Any website could read signed-in visitors' data.",
        "Never combine Access-Control-Allow-Origin: * with Access-Control-Allow-Credentials: true.",
        _ref("OWASP WSTG: Test Cross Origin Resource Sharing", OWASP_WSTG),
        "CORS doesn't allow any site with credentials",
    ),
    Rule(
        "version-disclosure",
        "headers",
        "Server version disclosed",
        FindingSeverity.low,
        "Version numbers tell attackers which known weaknesses to try.",
        "Remove version numbers from the Server and X-Powered-By headers (or drop X-Powered-By).",
        _ref("OWASP WSTG: Fingerprint Web Server", OWASP_WSTG),
        "No server version is disclosed",
    ),
    Rule(
        "cookie-httponly",
        "cookies",
        "Session cookie without HttpOnly",
        FindingSeverity.medium,
        "A script injected into the page could read the session cookie and take over the account.",
        "Set HttpOnly on session cookies.",
        _ref("OWASP ASVS V3: Session Management", ASVS),
        "Session cookies are HttpOnly",
    ),
    Rule(
        "cookie-secure",
        "cookies",
        "Cookie without Secure",
        FindingSeverity.medium,
        "The cookie can be sent over plain http and read on the network.",
        "Set Secure on every cookie.",
        _ref("OWASP ASVS V3: Session Management", ASVS),
        "Cookies are Secure",
    ),
    Rule(
        "cookie-samesite",
        "cookies",
        "Cookie without SameSite",
        FindingSeverity.low,
        "Other sites can make the browser send this cookie with their requests (cross-site request forgery).",
        "Set SameSite=Lax (or Strict) on the cookie.",
        _ref("OWASP ASVS V3: Session Management", ASVS),
        "Cookies set SameSite",
    ),
    Rule(
        "mixed-content",
        "content",
        "Mixed content",
        FindingSeverity.medium,
        "Parts of an HTTPS page load over plain http and can be changed on the network.",
        "Load every image, script and style over https.",
        _ref("OWASP WSTG: Testing for Weak Transport Layer Security", OWASP_WSTG),
        "No mixed content",
    ),
    Rule(
        "form-action",
        "content",
        "Form posts to http or another site",
        FindingSeverity.medium,
        "What visitors type is sent unencrypted or to a different site.",
        "Post forms to https:// addresses on your own site.",
        _ref("OWASP ASVS V9: Communication", ASVS),
        "No forms posting elsewhere",
    ),
    Rule(
        "third-party-scripts",
        "content",
        "Third-party scripts without integrity",
        FindingSeverity.info,
        "If the other site is compromised, its script runs on your pages.",
        "Add integrity (Subresource Integrity) attributes to scripts from other sites, or host them yourself.",
        _ref("OWASP WSTG: Test for Subresource Integrity", OWASP_WSTG),
        "Third-party scripts: none",
    ),
    Rule(
        "error-disclosure",
        "content",
        "Error details shown",
        FindingSeverity.medium,
        "Stack traces and framework errors reveal how the site is built.",
        "Show a plain error page and log the details on the server.",
        _ref("OWASP WSTG: Testing for Improper Error Handling", OWASP_WSTG),
        "No error details shown",
    ),
]
RULE_BY_ID = {r.id: r for r in RULES}
CATEGORIES = ["transport", "headers", "cookies", "content"]
_VERSION = re.compile(r"\d+(\.\d+)*")
_ERROR_SIGNATURES = [
    re.compile(p)
    for p in (
        r"Traceback \(most recent call last\)",
        r"\bat [\w$.<>]+\([\w./:-]+\.(?:js|ts|java|kt|cs):\d+(?::\d+)?\)",
        r"Exception in thread \"",
        r"\b(?:Fatal error|Parse error|Warning): .{0,200} on line \d+",
        r"SQLSTATE\[",
        r"\bORA-\d{5}\b",
        r"Microsoft OLE DB Provider",
        r"System\.\w+Exception",
        r"\b(?:NoMethodError|ActionController::\w+)",
        r"Werkzeug Debugger|django\.core\.exceptions",
        r"\bjava\.lang\.\w+(?:Exception|Error)\b",
    )
]


def session_like(name: str) -> bool:
    """`sess|sid|auth|token` as a word of the cookie name (PHPSESSID, connect.sid, auth_token; not recently_viewed)."""
    for tok in re.split(r"[^a-z0-9]+", name.lower()):
        if tok in ("sess", "session", "sid", "auth", "token", "jwt") or tok.endswith("sessid"):
            return True
        if tok.startswith("session") or (tok.startswith("sess") and len(tok) <= 6):
            return True
    return False


def parse_cookie(header: str) -> dict[str, Any]:
    """Name and flags of a Set-Cookie header. The value is dropped here and never stored."""
    parts = [p.strip() for p in header.split(";")]
    name = parts[0].split("=", 1)[0].strip()[:120]
    flags = {p.split("=", 1)[0].strip().lower(): (p.split("=", 1)[1].strip() if "=" in p else "") for p in parts[1:]}
    return {
        "name": name,
        "path": flags.get("path"),
        "http_only": "httponly" in flags,
        "secure": "secure" in flags,
        "same_site": flags.get("samesite") or None,
    }


def cookie_text(c: dict[str, Any]) -> str:
    """'recently_viewed · Path=/ · no HttpOnly · no SameSite' (no value)."""
    bits = [c["name"]]
    if c.get("path"):
        bits.append(f"Path={c['path']}")
    bits.append("HttpOnly" if c.get("http_only") else "no HttpOnly")
    bits.append("Secure" if c.get("secure") else "no Secure")
    bits.append(f"SameSite={c['same_site']}" if c.get("same_site") else "no SameSite")
    return " · ".join(bits)


def is_loopback_host(host: str) -> bool:
    if host in ("localhost",) or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


@dataclass
class PageObs:
    url: str
    page_id: str | None = None
    status: int | None = None
    error: str | None = None
    headers: list[tuple[str, str]] = field(default_factory=list)
    set_cookies: list[str] = field(default_factory=list)
    requests: list[dict[str, Any]] = field(default_factory=list)
    forms: list[dict[str, Any]] = field(default_factory=list)  # {action (absolute), method}
    password_inputs: int = 0
    scripts: list[dict[str, Any]] = field(default_factory=list)  # {src (absolute), integrity: bool}
    text: str = ""  # visible text, for error signatures only (never stored)

    def header(self, name: str) -> str | None:
        found = [v for k, v in self.headers if k.lower() == name.lower()]
        return found[-1] if found else None


@dataclass
class TransportObs:
    start_url: str
    http_redirect: dict[str, Any] | None = None  # {status, location} or {error}
    tls: dict[str, Any] | None = None  # {version, not_after (ISO), hostname_ok, error}


def _observed(name: str, value: str | None) -> str:
    return f"{name}: {value if value is not None else '(not sent)'}"


def _directive(csp: str, name: str) -> str | None:
    for part in csp.split(";"):
        bits = part.strip().split(None, 1)
        if bits and bits[0].lower() == name:
            return bits[1] if len(bits) > 1 else ""
    return None


def page_checks(p: PageObs, *, https: bool) -> list[dict[str, Any]]:
    """Per-page results of the header, cookie and content rules: [{rule, subject, result, observed, reason}]."""
    out: list[dict[str, Any]] = []

    def add(rule: str, failed: bool, observed: str, subject: str = "", reason: str = "") -> None:
        out.append(
            {
                "rule": rule,
                "subject": subject,
                "result": "failed" if failed else "passed",
                "observed": observed[:500],
                "reason": reason,
            }
        )

    csp = p.header("content-security-policy")
    add("csp-missing", csp is None, _observed("Content-Security-Policy", csp))
    if csp is None:
        out.append(
            {
                "rule": "csp-unsafe",
                "subject": "",
                "result": "not_applicable",
                "observed": "",
                "reason": "No Content-Security-Policy was sent",
            }
        )
    else:
        scripts = _directive(csp, "script-src") or _directive(csp, "default-src") or ""
        add(
            "csp-unsafe",
            "'unsafe-inline'" in scripts or "*" in scripts.split(),
            _observed("Content-Security-Policy", csp),
        )
    add(
        "nosniff",
        (p.header("x-content-type-options") or "").strip().lower() != "nosniff",
        _observed("X-Content-Type-Options", p.header("x-content-type-options")),
    )
    frame_ok = p.header("x-frame-options") is not None or (
        csp is not None and _directive(csp, "frame-ancestors") is not None
    )
    add(
        "clickjacking",
        not frame_ok,
        _observed("X-Frame-Options", p.header("x-frame-options"))
        + (
            ""
            if csp is None
            else f"\nContent-Security-Policy frame-ancestors: {_directive(csp, 'frame-ancestors') or '(not set)'}"
        ),
    )
    add(
        "referrer-policy",
        p.header("referrer-policy") is None,
        _observed("Referrer-Policy", p.header("referrer-policy")),
    )
    add(
        "permissions-policy",
        p.header("permissions-policy") is None,
        _observed("Permissions-Policy", p.header("permissions-policy")),
    )
    acao, acac = p.header("access-control-allow-origin"), p.header("access-control-allow-credentials")
    add(
        "cors-credentials",
        (acao or "").strip() == "*" and (acac or "").strip().lower() == "true",
        _observed("Access-Control-Allow-Origin", acao) + "\n" + _observed("Access-Control-Allow-Credentials", acac),
    )
    for hname in ("server", "x-powered-by"):
        v = p.header(hname)
        if v is not None and _VERSION.search(v):
            add(
                "version-disclosure",
                True,
                _observed("Server" if hname == "server" else "X-Powered-By", v),
                subject="X-Powered-By" if hname == "x-powered-by" else "Server",
            )
    if not any(r["rule"] == "version-disclosure" for r in out):
        add(
            "version-disclosure",
            False,
            _observed("Server", p.header("server")) + "\n" + _observed("X-Powered-By", p.header("x-powered-by")),
        )
    for raw in p.set_cookies:
        c = parse_cookie(raw)
        text = cookie_text(c)
        if session_like(c["name"]):
            add("cookie-httponly", not c["http_only"], text, subject=c["name"])
        if https:
            add("cookie-secure", not c["secure"], text, subject=c["name"])
        add("cookie-samesite", not c["same_site"], text, subject=c["name"])
    host = urlsplit(p.url).hostname or ""
    if https:
        mixed = [r["url"] for r in p.requests if str(r.get("url", "")).startswith("http://")]
        add("mixed-content", bool(mixed), "\n".join(mixed[:10]) or "No http:// requests")
    for f in p.forms:
        action = str(f.get("action") or p.url)
        a = urlsplit(action)
        bad = (a.hostname or host) != host or (https and a.scheme == "http")
        add(
            "form-action",
            bad,
            f"{str(f.get('method') or 'get').upper()} {action}"[:300],
            subject=(a.hostname or host) if bad else "",
        )
    third = [sc for sc in p.scripts if (urlsplit(str(sc.get("src"))).hostname or host) != host]
    unprotected = [sc for sc in third if not sc.get("integrity")]
    if third:
        add("third-party-scripts", bool(unprotected), "\n".join(str(sc["src"]) for sc in (unprotected or third)[:10]))
    sig = next((m.group(0) for rx in _ERROR_SIGNATURES if (m := rx.search(p.text or ""))), None)
    add("error-disclosure", sig is not None, f"Found on the page: {sig[:200]}" if sig else "No error details found")
    return out


def transport_checks(t: TransportObs, pages: list[PageObs], *, now: datetime) -> list[dict[str, Any]]:
    """Site-level transport results: [{rule, result, observed, reason}]."""
    u = urlsplit(t.start_url)
    https = u.scheme == "https"
    host = u.hostname or ""
    out: list[dict[str, Any]] = []

    def res(rule: str, result: str, observed: str = "", reason: str = "") -> None:
        out.append({"rule": rule, "subject": "", "result": result, "observed": observed[:500], "reason": reason})

    if not https and is_loopback_host(host):
        for rule in (
            "https",
            "http-redirect",
            "hsts",
            "tls-version",
            "certificate-valid",
            "certificate-expiry",
            "password-over-http",
        ):
            res(rule, "not_applicable", reason=LOOPBACK)
        return out
    if not https:
        res("https", "failed", f"The start page is {t.start_url}")
        res("http-redirect", "failed", f"{t.start_url} is served over plain http")
        for rule in ("hsts", "tls-version", "certificate-valid", "certificate-expiry"):
            res(rule, "not_applicable", reason=NOT_HTTPS)
        pw = [p.url for p in pages if p.password_inputs]
        if pw:
            res("password-over-http", "failed", "\n".join(pw[:10]))
        else:
            res("password-over-http", "passed", reason="No password field was found")
        return out
    res("https", "passed", f"The start page is {t.start_url}")
    r = t.http_redirect or {}
    if r.get("error"):
        res("http-redirect", "not_checked", reason=f"Not checked: the http:// address didn't answer ({r['error']})")
    else:
        loc = str(r.get("location") or "")
        ok = 300 <= int(r.get("status") or 0) < 400 and loc.startswith("https://")
        res("http-redirect", "passed" if ok else "failed", f"HTTP {r.get('status')}" + (f" → {loc}" if loc else ""))
    hsts_vals = [(p.url, p.header("strict-transport-security")) for p in pages if p.status is not None]
    bad = [u_ for u_, v in hsts_vals if not v or _max_age(v) < HSTS_MIN_AGE]
    if not hsts_vals:
        res("hsts", "not_checked", reason="Not checked: no page could be loaded")
    else:
        res("hsts", "failed" if bad else "passed", _observed("Strict-Transport-Security", hsts_vals[0][1]))
    tls = t.tls or {}
    if tls.get("error") and not tls.get("version"):
        reason = f"Not checked: the encrypted connection couldn't be opened ({tls['error']})"
        if tls.get("cert_error"):
            res("certificate-valid", "failed", str(tls["cert_error"]))
        else:
            res("certificate-valid", "not_checked", reason=reason)
        res("tls-version", "not_checked", reason=reason)
        res("certificate-expiry", "not_checked", reason=reason)
    else:
        v = str(tls.get("version") or "")
        res("tls-version", "failed" if v in ("SSLv3", "TLSv1", "TLSv1.1") else "passed", v)
        res(
            "certificate-valid",
            "passed" if tls.get("hostname_ok", True) else "failed",
            f"Valid for {host}" if tls.get("hostname_ok", True) else f"Not valid for {host}",
        )
        na = tls.get("not_after")
        if na:
            days = (datetime.fromisoformat(na) - now).days
            res("certificate-expiry", "failed" if days < 30 else "passed", f"Expires {na[:10]} (in {days} days)")
        else:
            res("certificate-expiry", "not_checked", reason="Not checked: the certificate's expiry wasn't readable")
    res("password-over-http", "passed", reason="Every page is served over HTTPS")
    return out


def _max_age(v: str) -> int:
    m = re.search(r"max-age=\"?(\d+)", v, re.IGNORECASE)
    return int(m.group(1)) if m else 0


def _default_row(rule_id: str, *, https: bool, any_page: bool) -> dict[str, Any]:
    """The result of a rule that produced no per-page result (nothing of its kind was observed)."""
    if not any_page:
        return {"result": "not_checked", "reason": "Not checked: no page could be loaded"}
    reasons = {
        "cookie-httponly": ("passed", "No session-like cookie was set"),
        "cookie-samesite": ("passed", "No cookie was set"),
        "cookie-secure": ("passed", "No cookie was set") if https else ("not_applicable", NOT_HTTPS),
        "mixed-content": ("not_applicable", "The pages themselves are plain http"),
        "form-action": ("passed", "No forms posting elsewhere"),
        "third-party-scripts": ("passed", "Third-party scripts: none"),
    }
    result, reason = reasons.get(rule_id, ("passed", ""))
    return {"result": result, "reason": reason}


def evaluate(t: TransportObs, pages: list[PageObs], *, now: datetime) -> dict[str, Any]:
    """Rule results (one row per rule, or per rule and cookie/header when it failed, with page counts) and the
    per-page findings to store."""
    https = urlsplit(t.start_url).scheme == "https"
    checked = [p for p in pages if p.status is not None and p.error is None]
    agg: dict[tuple[str, str], dict[str, Any]] = {}
    findings: list[dict[str, Any]] = []
    for r in transport_checks(t, checked, now=now):
        agg[(r["rule"], "")] = {"result": r["result"], "reason": r["reason"], "observed": r["observed"], "pages": []}
    for p in checked:
        for r in page_checks(p, https=https):
            row = agg.setdefault((r["rule"], r["subject"]), {"result": None, "reason": "", "observed": "", "pages": []})
            if r["result"] == "failed":
                row["result"] = "failed"
                row["pages"].append(p.url)
                row["observed"] = row["observed"] if row["result"] == "failed" and row["pages"][:-1] else r["observed"]
                findings.append(
                    {
                        "rule": r["rule"],
                        "subject": r["subject"],
                        "url": p.url,
                        "page_id": p.page_id,
                        "observed": r["observed"],
                    }
                )
            elif row["result"] is None:
                row["result"], row["reason"], row["observed"] = r["result"], r["reason"], r["observed"]
            elif row["result"] == "not_applicable" and r["result"] == "passed":
                row["result"], row["reason"] = "passed", ""
    rows: list[dict[str, Any]] = []
    for rule in RULES:
        mine = {subject: row for (rid, subject), row in agg.items() if rid == rule.id}
        failed = {sj: row for sj, row in mine.items() if row["result"] == "failed"}
        if failed:
            picked = list(failed.items())
        elif "" in mine:
            picked = [("", mine[""])]
        else:
            first = next(iter(mine.values()), None)
            base = _default_row(rule.id, https=https, any_page=bool(checked))
            if first is not None:
                base = {"result": first["result"], "reason": first["reason"], "observed": first["observed"]}
            picked = [("", {**base, "observed": base.get("observed", ""), "pages": []})]
        for subject, row in picked:
            rows.append(
                {
                    "rule_id": rule.id,
                    "subject": subject,
                    "category": rule.category,
                    "title": finding_title(rule.id, subject),
                    "severity": rule.severity.value,
                    "result": row["result"],
                    "reason": row.get("reason") or "",
                    "passed_text": rule.passed_text,
                    "pages": sorted(set(row["pages"])),
                    "page_count": len(set(row["pages"])),
                    "observed": row.get("observed") or "",
                    "why": rule.why,
                    "fix": rule.fix,
                    "reference": rule.reference,
                }
            )
    counts = {
        k: sum(1 for r in rows if r["result"] == k) for k in ("failed", "passed", "not_applicable", "not_checked")
    }
    return {"rules": rows, "findings": findings, "counts": counts}


def finding_title(rule_id: str, subject: str) -> str:
    rule = RULE_BY_ID[rule_id]
    if rule_id.startswith("cookie") and subject:
        return f"{rule.title}: {subject}"
    if rule_id == "version-disclosure" and subject:
        return f"{rule.title} ({subject})"
    if rule_id == "form-action" and subject:
        return f"Form posts to another site: {subject}"
    return rule.title


def fingerprint(rule_id: str, subject: str, url: str) -> str:
    path = (urlsplit(url).path or "/").rstrip("/") or "/"
    return hashlib.sha256(f"sec|{rule_id}|{subject}|{path}".encode()).hexdigest()


def defect_summary(rule_id: str, subject: str, pages: int) -> str:
    """'Pages don't send a Content-Security-Policy (6 pages)' (design §8.3)."""
    n = f"({pages} page{'s' if pages != 1 else ''})"
    texts = {
        "csp-missing": "Pages don't send a Content-Security-Policy",
        "nosniff": "Pages don't send X-Content-Type-Options: nosniff",
        "clickjacking": "Pages can be framed by other sites (no clickjacking protection)",
        "referrer-policy": "Pages don't send a Referrer-Policy",
        "permissions-policy": "Pages don't send a Permissions-Policy",
        "version-disclosure": f"Responses disclose the server version{f' ({subject})' if subject else ''}",
        "cookie-samesite": f"The {subject} cookie is set without SameSite",
        "cookie-httponly": f"The {subject} session cookie is readable by scripts (no HttpOnly)",
        "cookie-secure": f"The {subject} cookie is set without Secure",
    }
    return f"{texts.get(rule_id, finding_title(rule_id, subject))} {n}"[:300]
