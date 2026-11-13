"""Discovery rules: link safety (T14), URL identity, robots parsing, completeness scoring and the G2 recommendation."""

from __future__ import annotations

from typing import Any

import pytest

from app.agents.discovery.completeness import CompletenessInput, assess, recommend
from app.agents.discovery.crawler import canonical, parse_robots
from app.agents.discovery.heuristics import skip_reason


@pytest.mark.parametrize(
    ("url", "reason"),
    [
        ("https://s.example/logout", "would end the session"),
        ("https://s.example/account/sign-out?next=/", "would end the session"),
        ("https://s.example/files/manual.pdf", "file download"),
        ("https://s.example/items/4/delete", "destructive action"),
        ("https://s.example/newsletter/unsubscribe?id=1", "destructive action"),
        ("https://s.example/products?page=2", None),
        ("https://s.example/login", None),
    ],
)
def test_skip_reason(url: str, reason: str | None) -> None:
    assert skip_reason(url) == reason


def test_canonical_url_identity() -> None:
    assert canonical("HTTPS://Shop.Example:443/a?b=2&a=1&utm_source=x#top") == "https://shop.example/a?a=1&b=2"
    assert canonical("http://shop.example") == "http://shop.example/"
    assert canonical("http://shop.example:8080/x") == "http://shop.example:8080/x"


def test_robots_parsing() -> None:
    parser, sitemaps = parse_robots("User-agent: *\nDisallow: /private\nSitemap: https://s.example/sitemap.xml\n")
    assert not parser.can_fetch("*", "https://s.example/private/a")
    assert parser.can_fetch("*", "https://s.example/public")
    assert sitemaps == ["https://s.example/sitemap.xml"]


def _input(**kw: Any) -> CompletenessInput:
    base: dict[str, Any] = {
        "visited": 12,
        "found_total": 12,
        "not_visited_limit": 0,
        "max_pages": 30,
        "auth_areas": [],
        "failed_loads": [],
        "broken_links": 0,
        "stopped_early": None,
        "mobile_captured": True,
        "mobile_requested": True,
        "forms": 2,
        "journeys": 2,
        "bot_protection": False,
        "robots_skipped": 0,
    }
    base.update(kw)
    return CompletenessInput(**base)


def test_complete_scan_recommends_proceed() -> None:
    c = assess(_input())
    assert c.rating == "good" and c.score >= 80
    assert recommend(c, auth_gaps=False).recommend == "proceed"


def test_page_limit_and_auth_gaps_lower_the_score() -> None:
    c = assess(_input(visited=5, found_total=12, not_visited_limit=7, max_pages=5, auth_areas=["/account"]))
    assert c.score < assess(_input()).score
    assert any("credential" in r for r in c.reasons)


def test_stopped_early_is_never_complete() -> None:
    c = assess(_input(stopped_early="timeout"))
    assert c.score <= 79 and c.rating != "good"
    rec = recommend(c, auth_gaps=True)
    assert rec.recommend in ("proceed_with_caution", "do_not_proceed") and rec.generated_by == "rules"


def test_stop_reason_never_claims_page_limit_without_reaching_it() -> None:
    from app.agents.discovery.crawler import stop_reason

    assert stop_reason("completed", ["https://s.example/x"]) == "page_limit"
    assert stop_reason("completed", []) == "exhausted"
    assert stop_reason("cancelled", ["https://s.example/x"]) == "cancelled"
    assert stop_reason("timeout", ["https://s.example/x"]) == "timeout"


def test_access_gap_wording_follows_stop_reason() -> None:
    from app.agents.discovery.heuristics import access_gaps

    common: dict[str, Any] = {"max_pages": 30, "robots_skipped": [], "skipped_links": [], "bot_protection": False}
    cancelled = access_gaps([], not_visited=5, stop_reason="cancelled", **common)
    assert [g["reason"] for g in cancelled] == ["Not visited: discovery cancelled"]
    assert "limit" not in cancelled[0]["description"]
    limited = access_gaps([], not_visited=5, stop_reason="page_limit", **common)
    assert limited[0]["reason"] == "Not visited: page limit" and "30" in limited[0]["description"]


def test_cancelled_completeness_does_not_mention_page_limit() -> None:
    c = assess(_input(visited=2, found_total=9, not_visited_limit=0, not_visited_stopped=7, stopped_early="cancelled"))
    text = " ".join(c.reasons)
    assert "page limit" not in text and "cancelled after 2 of 9 pages" in text
    # R2-2: one coverage line, not "2 of 9" and "2 of 2" side by side.
    assert sum(" of " in ch["text"] and "pages" in ch["text"] for ch in c.checks) == 1


@pytest.mark.parametrize(
    ("reason", "advice", "forbidden"),
    [
        ("cancelled", "re-run it to completion", "higher page limit"),
        ("timeout", "time limit", "higher page limit"),
        ("failed", "error", "higher page limit"),
        ("page_limit", "higher page limit", "re-run it to completion"),
    ],
)
def test_gate_advice_follows_stop_reason(reason: str, advice: str, forbidden: str) -> None:
    stopped = reason if reason in ("cancelled", "timeout", "failed") else None
    left = 28  # 2 of 30 pages: never rated "good"
    c = assess(
        _input(
            visited=2,
            found_total=30,
            not_visited_limit=left if reason == "page_limit" else 0,
            not_visited_stopped=0 if reason == "page_limit" else left,
            max_pages=2,
            stopped_early=stopped,
        )
    )
    rec = recommend(c, auth_gaps=False, stop_reason=reason)
    text = " ".join(rec.reasons)
    assert advice in text and forbidden not in text


def _login_page() -> Any:
    import uuid

    from app.agents.discovery.heuristics import PageView
    from app.agents.discovery.schemas import ExtractedForm, FormField

    form = ExtractedForm(
        method="POST",
        action="/login",
        submit_label="Sign in",
        fields=[FormField(name="email", type="email"), FormField(name="password", type="password")],
    )
    return PageView(
        id=uuid.uuid4(),
        url="https://s.example/login",
        title="Sign in",
        status=200,
        failed=False,
        depth=1,
        parent_id=None,
        page_type="auth",
        requires_auth=False,
        forms=[form],
    )


def test_sign_in_gap_wording_and_attempted_form() -> None:
    """R2-02: current wording for the credentials suggestion. R2-03: the sign-in form isn't "not submitted" when the
    scan attempted sign-in."""
    from app.agents.discovery.heuristics import access_gaps

    common: dict[str, Any] = {"max_pages": 30, "robots_skipped": [], "skipped_links": [], "bot_protection": False}
    plain = access_gaps([_login_page()], not_visited=0, stop_reason="exhausted", **common)
    creds = next(g for g in plain if g["reason"] == "Needs credentials")
    assert creds["suggestion"] == "Add test credentials in Project settings and re-scan"
    assert "Phase 2" not in str(plain)
    assert any("was not submitted" in g["description"] for g in plain)
    attempted = access_gaps([_login_page()], not_visited=0, stop_reason="exhausted", signin_attempted=True, **common)
    assert not any("was not submitted" in g["description"] for g in attempted)
