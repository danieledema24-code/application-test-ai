"""Discovery completeness score (Gate 2 input) and the rule-based gate recommendation. Numbers computed in code."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from app.agents.discovery.schemas import Completeness, GateRecommendationModel


@dataclass
class CompletenessInput:
    visited: int
    found_total: int  # visited + failed + not visited (same-site, followable)
    not_visited_limit: int  # links left because the page limit was reached
    max_pages: int
    auth_areas: list[str]
    failed_loads: list[str]  # paths that could not load (excluding 401/403)
    broken_links: int  # 404s
    stopped_early: Literal["cancelled", "timeout", "failed"] | None
    mobile_captured: bool
    mobile_requested: bool
    forms: int
    journeys: int
    bot_protection: bool
    robots_skipped: int
    not_visited_stopped: int = 0  # links left because discovery stopped early (cancel, time limit, error)


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def assess(c: CompletenessInput) -> Completeness:
    if c.visited == 0:
        return Completeness(
            score=0,
            rating="limited",
            reasons=["No pages could be explored. The site may block automated browsers."],
            checks=[{"status": "fail", "text": "No pages could be explored"}],
        )
    score = 100.0
    checks: list[dict[str, str]] = []
    total = max(c.found_total, c.visited)
    if not c.stopped_early:
        # A stopped scan reports its coverage in one line below instead (no page-limit wording).
        checks.append(
            {
                "status": "ok" if c.visited >= total else "warn",
                "text": f"{c.visited} of {total} pages found were visited (page limit {c.max_pages})",
            }
        )
    if c.mobile_requested and c.mobile_captured:
        checks.append({"status": "ok", "text": "Visited pages captured on desktop and mobile"})
    elif c.mobile_requested:
        checks.append({"status": "warn", "text": "Mobile captures are missing for some pages"})
        score -= 5
    else:
        checks.append({"status": "warn", "text": "Desktop only: responsive behaviour was not observed"})
        score -= 5
    checks.append(
        {"status": "ok", "text": f"{_plural(c.forms, 'form')} and {_plural(c.journeys, 'user journey')} catalogued"}
    )
    if c.auth_areas:
        score -= min(20, 8 * len(c.auth_areas))
        shown = ", ".join(c.auth_areas[:3])
        checks.append(
            {
                "status": "warn",
                "text": f"{_plural(len(c.auth_areas), 'area')} {'needs' if len(c.auth_areas) == 1 else 'need'} credentials ({shown})",
            }
        )
    if c.not_visited_limit:
        score -= min(25.0, 25.0 * c.not_visited_limit / max(1, c.not_visited_limit + c.visited))
        checks.append(
            {"status": "warn", "text": f"{_plural(c.not_visited_limit, 'page')} not visited: page limit reached"}
        )
    if c.robots_skipped:
        score -= min(10, 2 * c.robots_skipped)
        checks.append(
            {"status": "warn", "text": f"{_plural(c.robots_skipped, 'page')} not visited: disallowed by robots.txt"}
        )
    if c.failed_loads:
        score -= min(15, 5 * len(c.failed_loads))
        checks.append(
            {
                "status": "fail",
                "text": f"{_plural(len(c.failed_loads), 'page')} couldn't load ({', '.join(c.failed_loads[:3])})",
            }
        )
    if c.broken_links:
        score -= min(5, c.broken_links)
        checks.append({"status": "warn", "text": f"{_plural(c.broken_links, 'link')} led to a missing page (HTTP 404)"})
    if c.bot_protection:
        score -= 15
        checks.append(
            {"status": "warn", "text": "Bot protection detected; some content may be hidden from the scanner"}
        )
    if c.stopped_early:
        score -= 15
        word = {"cancelled": "was cancelled", "timeout": "stopped at the time limit", "failed": "stopped early"}[
            c.stopped_early
        ]
        checks.append(
            {
                "status": "warn",
                "text": f"Discovery {word} after {c.visited} of {_plural(total, 'page')} found; results are partial",
            }
        )
    final = max(0, min(100, round(score)))
    if c.stopped_early:
        final = min(final, 79)  # a partial scan is never "Complete"
    rating: Literal["good", "partial", "limited"] = "good" if final >= 80 else "partial" if final >= 50 else "limited"
    reasons = [ch["text"] for ch in checks if ch["status"] != "ok"] or [
        "Discovery covered every page found within the limit."
    ]
    return Completeness(score=final, rating=rating, reasons=reasons, checks=checks)


RERUN_ADVICE = {
    "cancelled": "Discovery was cancelled: re-run it to completion before deriving requirements.",
    "timeout": "Discovery reached its time limit: re-run it (or narrow the scope) before deriving requirements.",
    "failed": "Discovery stopped because of an error: re-run it before deriving requirements.",
    "paused": "Discovery is paused: resume it before deriving requirements.",
}


def recommend(c: Completeness, *, auth_gaps: bool, stop_reason: str | None = None) -> GateRecommendationModel:
    """The advice follows what actually limited coverage: an early stop, missing credentials, or the page limit."""
    reasons = list(c.reasons)
    if c.rating == "good":
        reasons.append("Discovery is complete enough to derive requirements.")
        return GateRecommendationModel(recommend="proceed", reasons=reasons, generated_by="rules")
    if stop_reason in RERUN_ADVICE:
        reasons.append(RERUN_ADVICE[stop_reason])
    elif auth_gaps:
        reasons.append(
            "Re-scan with credentials before deriving requirements. Approving now means requirements will cover the public site only."
        )
    elif stop_reason == "page_limit":
        reasons.append("Consider re-scanning with a higher page limit before deriving requirements.")
    else:
        reasons.append("Review the gaps above before deriving requirements.")
    rec: Literal["proceed_with_caution", "do_not_proceed"] = (
        "proceed_with_caution" if c.rating == "partial" else "do_not_proceed"
    )
    return GateRecommendationModel(recommend=rec, reasons=reasons, generated_by="rules")
