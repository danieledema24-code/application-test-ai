"""Phase 5 rules in code: the passive security rule table (P5-03), accessibility result mapping and the keyboard
heuristics (P5-02), and load profile drafting and threshold judging (P5-01b)."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.domain.enums import FindingSeverity, PerfProfileType
from app.domain.nonfunctional import accessibility as a11y
from app.domain.performance import profile as perf
from app.domain.performance.limits import LoadLimits
from app.security import passive_rules as sec

NOW = datetime(2026, 11, 14, tzinfo=UTC)
HARDENED = [
    ("Content-Security-Policy", "default-src 'self'; frame-ancestors 'self'"),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "strict-origin-when-cross-origin"),
    ("Permissions-Policy", "camera=()"),
    ("Strict-Transport-Security", "max-age=31536000"),
]


def _rows(result: dict[str, object]) -> dict[tuple[str, str], dict[str, object]]:
    return {(r["rule_id"], r["subject"]): r for r in result["rules"]}  # type: ignore[attr-defined]


# ------------------------------------------------------------------ passive security


@pytest.mark.parametrize(
    ("name", "expected"),
    [("PHPSESSID", True), ("connect.sid", True), ("auth_token", True), ("session", True), ("jwt", True),
     ("recently_viewed", False), ("consent", False), ("theme", False)],
)  # fmt: skip
def test_session_like_cookie_names(name: str, expected: bool) -> None:
    assert sec.session_like(name) is expected


def test_cookie_parsing_drops_the_value() -> None:
    c = sec.parse_cookie("sid=s3cr3t-value; Path=/; HttpOnly; SameSite=Lax")
    assert c == {"name": "sid", "path": "/", "http_only": True, "secure": False, "same_site": "Lax"}
    assert "s3cr3t" not in sec.cookie_text(c)
    assert sec.cookie_text(sec.parse_cookie("recently_viewed=7; Path=/")) == (
        "recently_viewed · Path=/ · no HttpOnly · no Secure · no SameSite"
    )


def test_loopback_http_marks_transport_rules_not_applicable() -> None:
    page = sec.PageObs(url="http://localhost:4100/", status=200, headers=HARDENED)
    rows = _rows(sec.evaluate(sec.TransportObs("http://localhost:4100/"), [page], now=NOW))
    for rid in ("https", "http-redirect", "hsts", "tls-version", "certificate-valid", "password-over-http"):
        assert rows[(rid, "")]["result"] == "not_applicable"
        assert rows[(rid, "")]["reason"] == sec.LOOPBACK
    assert sec.is_loopback_host("127.0.0.1") and sec.is_loopback_host("app.localhost")
    assert not sec.is_loopback_host("shop.example.com")


def test_public_http_fails_https_and_password_over_http() -> None:
    page = sec.PageObs(url="http://shop.example.com/login", status=200, headers=HARDENED, password_inputs=1)
    rows = _rows(sec.evaluate(sec.TransportObs("http://shop.example.com/"), [page], now=NOW))
    assert rows[("https", "")]["result"] == "failed"
    assert rows[("password-over-http", "")]["result"] == "failed"
    assert rows[("hsts", "")]["result"] == "not_applicable" and rows[("hsts", "")]["reason"] == sec.NOT_HTTPS


def test_hardened_https_page_passes_and_a_bare_one_fails_per_header() -> None:
    t = sec.TransportObs("https://shop.example.com/", http_redirect={"status": 301, "location": "https://shop.example.com/"},
                         tls={"version": "TLSv1.3", "hostname_ok": True, "not_after": "2027-06-01T00:00:00+00:00"})  # fmt: skip
    good = sec.PageObs(url="https://shop.example.com/", status=200, headers=HARDENED,
                       set_cookies=["sid=x; Path=/; HttpOnly; Secure; SameSite=Lax"])  # fmt: skip
    res = sec.evaluate(t, [good], now=NOW)
    assert res["findings"] == [] and res["counts"]["failed"] == 0
    bare = sec.PageObs(url="https://shop.example.com/a", status=200, headers=[("X-Powered-By", "Express 4.18")],
                       set_cookies=["sid=x; Path=/"])  # fmt: skip
    rows = _rows(sec.evaluate(t, [good, bare], now=NOW))
    for rid in ("csp-missing", "nosniff", "clickjacking", "referrer-policy", "permissions-policy", "hsts"):
        assert rows[(rid, "")]["result"] == "failed", rid
    assert rows[("csp-missing", "")]["page_count"] == 1
    assert rows[("version-disclosure", "X-Powered-By")]["result"] == "failed"
    for rid in ("cookie-httponly", "cookie-secure", "cookie-samesite"):
        assert rows[(rid, "sid")]["result"] == "failed", rid
    assert rows[("certificate-expiry", "")]["result"] == "passed"


def test_mixed_content_form_elsewhere_scripts_and_error_disclosure() -> None:
    t = sec.TransportObs("https://shop.example.com/", http_redirect={"status": 301, "location": "https://shop.example.com/"},
                         tls={"version": "TLSv1.2", "hostname_ok": True})  # fmt: skip
    page = sec.PageObs(
        url="https://shop.example.com/checkout", status=200, headers=HARDENED,
        requests=[{"url": "http://cdn.example.net/pic.png", "type": "image", "method": "GET"}],
        forms=[{"action": "https://collect.example.org/submit", "method": "post"}],
        text="Traceback (most recent call last):\n  File \"app.py\", line 3",
    )  # fmt: skip
    res = sec.evaluate(t, [page], now=NOW)
    failed = {r["rule_id"] for r in res["rules"] if r["result"] == "failed"}
    assert {"mixed-content", "form-action", "error-disclosure"} <= failed
    assert {f["rule"] for f in res["findings"]} >= {"mixed-content", "form-action", "error-disclosure"}


def test_an_expiring_certificate_and_old_tls_fail() -> None:
    t = sec.TransportObs("https://shop.example.com/", http_redirect={"status": 200},
                         tls={"version": "TLSv1.1", "hostname_ok": False, "not_after": "2026-11-20T00:00:00+00:00"})  # fmt: skip
    rows = _rows(sec.evaluate(t, [sec.PageObs(url="https://shop.example.com/", status=200, headers=HARDENED)], now=NOW))
    assert rows[("tls-version", "")]["result"] == "failed"
    assert rows[("certificate-valid", "")]["result"] == "failed"
    assert rows[("certificate-expiry", "")]["result"] == "failed"
    assert rows[("http-redirect", "")]["result"] == "failed"


def test_no_page_loaded_means_not_checked_not_passed() -> None:
    res = sec.evaluate(sec.TransportObs("http://localhost:4100/"), [sec.PageObs(url="http://localhost:4100/", error="timed out")],
                       now=NOW)  # fmt: skip
    rows = _rows(res)
    assert rows[("csp-missing", "")]["result"] == "not_checked"
    assert res["counts"]["passed"] == 0


def test_defect_summaries_and_fingerprints() -> None:
    assert sec.defect_summary("csp-missing", "", 6) == "Pages don't send a Content-Security-Policy (6 pages)"
    assert sec.defect_summary("cookie-samesite", "recently_viewed", 1) == (
        "The recently_viewed cookie is set without SameSite (1 page)"
    )
    assert sec.fingerprint("nosniff", "", "https://a.example/x/") == sec.fingerprint(
        "nosniff", "", "https://a.example/x"
    )


# ------------------------------------------------------------------ accessibility


def test_wcag_references_severity_and_best_practice() -> None:
    refs = a11y.wcag_refs(["cat.forms", "wcag2a", "wcag412", "wcag131"])
    assert refs == [
        {"type": "wcag", "criterion": "4.1.2", "name": "Name, Role, Value", "level": "A"},
        {"type": "wcag", "criterion": "1.3.1", "name": "Info and Relationships", "level": "A"},
    ]
    assert a11y.is_best_practice(["best-practice", "cat.semantics"])
    assert a11y.severity_of("critical", ["best-practice"]) == FindingSeverity.minor
    assert a11y.severity_of("serious", ["wcag2aa", "wcag143"]) == FindingSeverity.serious


def test_axe_results_become_findings_without_password_values() -> None:
    result = {
        "violations": [{
            "id": "label", "impact": "critical", "tags": ["wcag2a", "wcag412"], "help": "Form elements must have labels",
            "helpUrl": "https://dequeuniversity.com/rules/axe/4.14/label",
            "nodes": [{"target": ["#pw"], "html": '<input id="pw" type="password" value="hunter2">',
                       "failureSummary": "Fix any of the following"}],
        }],
        "incomplete": [{"id": "color-contrast", "impact": "serious", "tags": ["wcag2aa", "wcag143"],
                        "nodes": [{"target": ["p"], "html": "<p>x</p>"}]}],
    }  # fmt: skip
    out = a11y.findings_from_axe(result, url="http://localhost:4100/login", viewport="desktop", secrets=["hunter2"])
    label, review = out
    assert label["rule_id"] == "label" and label["severity"] == FindingSeverity.critical
    assert "hunter2" not in label["nodes"][0]["html"] and "value=" not in label["nodes"][0]["html"]
    assert {"type": "help", "url": result["violations"][0]["helpUrl"], "source": "axe-core"} in label["references"]
    assert review["needs_review"] and review["severity"] == FindingSeverity.minor
    assert label["fingerprint"] != review["fingerprint"]


def _kb(**over: object) -> dict[str, object]:
    base: dict[str, object] = {
        "order": [{"id": "1", "selector": "a#home", "label": "Home", "visible_focus": True},
                  {"id": "2", "selector": "button", "label": "Save", "visible_focus": True}],
        "tabbable": [{"id": "1", "selector": "a#home", "label": "Home"}, {"id": "2", "selector": "button", "label": "Save"}],
        "stuck_at": None, "completed": True, "cycled": True, "presses": 3,
    }  # fmt: skip
    return {**base, **over}


def test_keyboard_pass_clean_trap_focus_and_reachability() -> None:
    findings, summary = a11y.keyboard_findings(_kb(), url="http://x.localhost/", viewport="desktop")
    assert findings == [] and summary["trap"] is False and summary["focusable"] == 2
    findings, summary = a11y.keyboard_findings(_kb(stuck_at="#trap"), url="http://x.localhost/", viewport="desktop")
    assert [f["rule_id"] for f in findings] == ["keyboard-trap"] and summary["trap"] is True
    assert findings[0]["heuristic"] and findings[0]["references"][0]["criterion"] == "2.1.2"
    order = [{"id": "1", "selector": "a#plain", "label": "Plain", "visible_focus": False}]
    tabbable = [{"id": "1", "selector": "a#plain", "label": "Plain"}, {"id": "9", "selector": "#far", "label": "Far"}]
    findings, _ = a11y.keyboard_findings(_kb(order=order, tabbable=tabbable, cycled=False), url="http://x.localhost/",
                                         viewport="desktop")  # fmt: skip
    assert {f["rule_id"] for f in findings} == {"focus-not-visible", "not-reachable"}
    # Reachability is only judged after a full cycle.
    findings, _ = a11y.keyboard_findings(_kb(order=order, tabbable=tabbable, cycled=False, completed=False),
                                         url="http://x.localhost/", viewport="desktop")  # fmt: skip
    assert {f["rule_id"] for f in findings} == {"focus-not-visible"}


def test_grouped_draft_titles() -> None:
    urls = ["http://s.localhost/products/1", "http://s.localhost/products/2"]
    assert (
        a11y.draft_title("image-alt", "Images must have alt text", urls)
        == "Product images have no text alternative (2 pages)"
    )
    assert a11y.draft_title("label", "x", urls[:1]) == "Form fields have no label (1 page)"
    assert (
        a11y.draft_title("region", "Content should be in landmarks.", urls)
        == "Content should be in landmarks (2 pages)"
    )


# ------------------------------------------------------------------ load profiles


@pytest.mark.parametrize(
    ("text", "ms"),
    [("Product pages load within 2 seconds", 2000), ("The API responds in under 500 ms", 500),
     ("Search results appear in less than 1.5 s", 1500), ("Users can pay by card", None),
     ("The page loads within 3 days", None)],
)  # fmt: skip
def test_requirement_speed_statements(text: str, ms: int | None) -> None:
    assert perf.parse_threshold_ms(text) == ms


def test_target_selection_and_eligibility() -> None:
    pages = [
        perf.PageInfo("1", "http://localhost:4100/about", 200, "other", False, "About"),
        perf.PageInfo("2", "http://localhost:4100/", 200, "landing", False, "Home"),
        perf.PageInfo("3", "http://localhost:4100/products", 200, "listing", False, "Products"),
        perf.PageInfo("4", "http://localhost:4100/account", 200, "other", True, "Account"),
        perf.PageInfo("5", "http://localhost:4100/logout", 200, "other", False, "Logout"),
        perf.PageInfo("6", "http://localhost:4100/gone", 404, "other", False, "Gone"),
        perf.PageInfo("7", "http://cdn.example.com/", 200, "other", False, "CDN"),
    ]
    picked = perf.select_targets(pages, "localhost")
    assert [(t["path"], t["weight"]) for t in picked] == [("/", 3), ("/products", 2), ("/about", 1)]
    reasons = {p.page_id: perf.eligible(p, "localhost") for p in pages}
    assert reasons["4"] == "needs sign-in" and reasons["6"] == "answered HTTP 404"
    assert reasons["7"] == "is on another host" and reasons["5"] == "looks like a logout, delete or download link"


def test_default_stages_stay_within_the_ceiling() -> None:
    ceiling = LoadLimits(vus=4, rps=10, duration_s=600)
    for kind in PerfProfileType:
        stages = perf.stages_for(kind, ceiling)
        assert max(s["target_vus"] for s in stages) <= 4 and stages[-1]["target_vus"] == 0


def test_summary_sentence_is_exact() -> None:
    snap = {"stages": [{"duration_s": 30, "target_vus": 10}, {"duration_s": 90, "target_vus": 10},
                       {"duration_s": 10, "target_vus": 0}], "max_rps": 20, "targets": [{"path": "/"}]}  # fmt: skip
    assert perf.summary_sentence(snap, "localhost:4100") == (
        "Up to 10 virtual users, at most 20 requests a second, for 2 minutes 10 seconds, against localhost:4100; "
        "GET only; not signed in."
    )
    assert perf.rounded(2086) == "2,100" and perf.rounded(42) == "42"
    assert perf.expected_requests(snap) <= 20 * 130


def test_thresholds_are_judged_in_code_and_not_measured_when_stopped() -> None:
    ths = perf.thresholds_for([{"path": "/", "page_id": "p1"}, {"path": "/slow", "page_id": "p2"}],
                              {"p2": {"ms": 200, "key": "REQ-0012", "lineage_id": "L"}})  # fmt: skip
    assert [t["value"] for t in ths] == [perf.DEFAULT_P95_MS, 200, perf.DEFAULT_ERROR_RATE]
    summary = {
        "overall": {"count": 100, "error_rate": 0.0},
        "targets": [{"path": "/", "count": 50, "latency_ms": {"p95": 40}},
                    {"path": "/slow", "count": 50, "latency_ms": {"p95": 310}}],
    }  # fmt: skip
    res = perf.evaluate(ths, summary, judged=True)
    assert [(r.get("path"), r["result"]) for r in res] == [("/slow", "missed"), ("/", "met"), (None, "met")]
    assert all(
        r["result"] == "not_measured" and r["measured"] is not None for r in perf.evaluate(ths, summary, judged=False)
    )
    summary_text, expected, actual = perf.defect_text(res[0], users=10, page_title="Slow · Fixture")
    assert summary_text == "Slow page slows down under load (p95 310 ms with 10 users; threshold 200 ms)"
    assert expected == "[From REQ-0012] 95 % of requests to /slow faster than 200 ms"
    assert actual == "[Measured] 95 % of requests to /slow were faster than 310 ms (p95)"
    err = perf.defect_text({"metric": "error_rate", "value": 0.01, "measured": 0.034}, users=5, page_title=None)
    assert err[0] == "Requests fail under load (3.4 % errors with 5 users; threshold 1 %)"
