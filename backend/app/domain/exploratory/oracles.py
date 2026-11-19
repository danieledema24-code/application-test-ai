"""Coded oracles for exploration (roadmap P6-03a "Oracles"): what counts as a problem after an action, and how bad it
is. Severities are fixed here; nothing is judged by a model. Pure: unit-tested.

| rule                | when                                                                   | severity |
|---------------------|------------------------------------------------------------------------|----------|
| server_error        | any response with HTTP >= 500 during the action                        | high     |
| uncaught_exception  | an uncaught error on the page (`pageerror`)                            | medium   |
| not_found           | a same-origin link or navigation that lands on 404/410                 | medium   |
| broken_text         | new visible "undefined", "NaN", "null" or "[object Object]" text      | medium   |
| console_error       | a console error                                                        | low      |
| overflow            | new horizontal overflow at the desktop size                            | low      |
| dialog_trap         | a dialog opened that neither Escape nor a close control can close      | low      |
| injection           | page text that tries to instruct automated tools (informational)       | low      |

"Blocked write attempts" and "no visible effect" are observations, not findings. Errors that are only the
consequence of a blocked write ("Failed to fetch" after the network guard aborted the page's POST) are attributed to
the block, not reported as problems; so are the browser's own "Failed to load resource" lines (the network oracles
above cover those responses).
"""

from __future__ import annotations

import hashlib
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from app.domain.exploratory.actions import path_of

HIGH, MEDIUM, LOW = "high", "medium", "low"
SEVERITY = {
    "server_error": HIGH,
    "uncaught_exception": MEDIUM,
    "not_found": MEDIUM,
    "broken_text": MEDIUM,
    "console_error": LOW,
    "overflow": LOW,
    "dialog_trap": LOW,
    "injection": LOW,
}
RULE_NAMES = {
    "server_error": "Server error",
    "uncaught_exception": "Uncaught error",
    "not_found": "Missing page",
    "broken_text": "Broken value shown",
    "console_error": "Console error",
    "overflow": "Sideways scrolling",
    "dialog_trap": "Dialog can't be closed",
    "injection": "Text aimed at automated tools",
}
# Auto-drafted for Gate 8 (roadmap "Defect drafts"): high findings and uncaught exceptions; the rest on request.
AUTO_DRAFT_RULES = frozenset({"uncaught_exception"})
BROKEN_TEXT = re.compile(r"\[object Object\]|(?<![\w-])(?:NaN|undefined|null)(?![\w-])")
BLOCK_SIDE_EFFECT = re.compile(r"Failed to fetch|NetworkError|ERR_BLOCKED_BY_CLIENT|Load failed|net::ERR_FAILED", re.I)
RESOURCE_LINE = re.compile(r"^Failed to load resource\b", re.I)
_DIGITS = re.compile(r"\d+")
INJECTION_LINE = "This page contains text that tries to instruct automated tools. The explorer ignored it."


def blocked_line(method: str, url: str) -> str:
    """The observation for one aborted request (roadmap wording)."""
    return f"The page tried to send {method.upper()} {path_of(url)}. Blocked: exploration never sends data."


def skipped_line(url: str, reason: str) -> str:
    """A read the guard stopped because of where it goes ('The page tried to open /logout. Blocked: would end the
    session.')."""
    return f"The page tried to open {path_of(url)}. Blocked: {reason[:1].lower()}{reason[1:]}."


def new_window_line(where: str) -> str:
    """A window the page tried to open ('The page tried to open /popup in a new window. Blocked: exploration stays in
    one tab.')."""
    return f"The page tried to open {where} in a new window. Blocked: exploration stays in one tab."


def broken_tokens(text: str) -> Counter[str]:
    return Counter(m.group(0) for m in BROKEN_TEXT.finditer(text or ""))


@dataclass(frozen=True)
class PageState:
    """What the explorer reads of a page before and after an action (no page text is kept beyond the tokens)."""

    url: str
    tokens: Counter[str] = field(default_factory=Counter)
    overflow: bool = False
    dialogs: int = 0
    dom_size: int = 0
    text_hash: str = ""


@dataclass
class ActionObservation:
    """Everything recorded between the start of one action and the end of its settle time."""

    before: PageState
    after: PageState
    action: str | None  # 'clicking button "Show details"'; None for a page opened by the explorer itself
    target: str = ""  # the action's fingerprint (dedupe key part)
    page_errors: list[str] = field(default_factory=list)
    console_errors: list[str] = field(default_factory=list)
    responses: list[tuple[str, str, int]] = field(default_factory=list)  # (method, url, status), same origin only
    nav_status: int | None = None  # status of the main-frame document when the action navigated
    blocked: list[tuple[str, str]] = field(default_factory=list)  # (method, url) aborted by the network guard
    dialog_closable: bool | None = None  # None: no new dialog opened


@dataclass(frozen=True)
class Problem:
    rule: str
    severity: str
    title: str
    observed: str
    subject: str  # what identifies it on the page (dedupe key part)

    def fingerprint(self, url: str, target: str) -> str:
        """rule + page path + action target + subject (digits ignored): dedupe within a session and "Seen before"."""
        basis = "|".join(("exploratory", self.rule, path_of(url), target, _DIGITS.sub("#", self.subject)))
        return hashlib.sha256(basis.encode()).hexdigest()

    def as_dict(self) -> dict[str, Any]:
        return {"rule": self.rule, "severity": self.severity, "title": self.title, "observed": self.observed}


def _first_line(text: str, limit: int = 300) -> str:
    return (text or "").strip().splitlines()[0][:limit] if (text or "").strip() else ""


def _when(obs: ActionObservation) -> str:
    return f"after {obs.action}" if obs.action else f"when {path_of(obs.before.url)} loads"


def _quote(tokens: list[str]) -> str:
    return " and ".join(f"'{t}'" for t in tokens)


def evaluate(obs: ActionObservation) -> list[Problem]:
    """The problems one action (or page load) produced, in rule-table order, each once."""
    out: list[Problem] = []
    blocked = bool(obs.blocked)
    for status in sorted({s for _m, _u, s in obs.responses if s >= 500}):
        urls = sorted({path_of(u) for m, u, s in obs.responses if s == status})
        out.append(Problem("server_error", HIGH, f"Server error (HTTP {status}) {_when(obs)}",
                           f"HTTP {status} from {', '.join(urls[:3])}", f"{status} {urls[0]}"))  # fmt: skip
    errors: list[str] = []
    for e in obs.page_errors:
        line = _first_line(e)
        if not line or (blocked and BLOCK_SIDE_EFFECT.search(line)) or line in errors:
            continue
        errors.append(line)
    for line in errors:
        out.append(Problem("uncaught_exception", MEDIUM, f"Uncaught error {_when(obs)}", line, line))
    if obs.nav_status in (404, 410):
        where = path_of(obs.after.url)
        out.append(Problem("not_found", MEDIUM, f"{'Link leads' if obs.action else 'Page'} to a missing page "
                           f"(HTTP {obs.nav_status})", f"HTTP {obs.nav_status} for {where}", where))  # fmt: skip
    grown = sorted(t for t, n in obs.after.tokens.items() if n > obs.before.tokens.get(t, 0))
    if grown:
        verb = "appeared on the page" if obs.action else "is shown on the page"
        out.append(Problem("broken_text", MEDIUM, f"{_quote(grown)} {verb}",
                           f"The page shows {_quote(grown)} {_when(obs)}", ",".join(grown)))  # fmt: skip
    seen: list[str] = []
    for c in obs.console_errors:
        line = _first_line(c)
        if not line or RESOURCE_LINE.search(line) or "ERR_BLOCKED_BY_CLIENT" in line:
            continue
        if (blocked and BLOCK_SIDE_EFFECT.search(line)) or line in seen or any(line in e for e in errors):
            continue
        seen.append(line)
        out.append(Problem("console_error", LOW, f"Console error {_when(obs)}", line, line))
    if obs.after.overflow and not obs.before.overflow:
        out.append(Problem("overflow", LOW, f"The page scrolls sideways {_when(obs)}",
                           "The page is wider than the 1440 px window", "overflow"))  # fmt: skip
    if obs.dialog_closable is False:
        out.append(Problem("dialog_trap", LOW, f"A dialog that can't be closed opened {_when(obs)}",
                           "Neither Escape nor a close button closed the dialog", "dialog"))  # fmt: skip
    return out


def injection_problem(url: str, excerpt: str) -> Problem:
    return Problem("injection", LOW, f"Text aimed at automated tools on {path_of(url)}",
                   f"{INJECTION_LINE} Excerpt: {excerpt[:200]}", "injection")  # fmt: skip


def auto_draft(problems: list[Problem]) -> bool:
    """Roadmap "Defect drafts": high findings and uncaught exceptions get a grouped draft automatically."""
    return any(p.severity == HIGH or p.rule in AUTO_DRAFT_RULES for p in problems)


def outcome(problems: list[Problem], blocked: bool, navigated: bool, changed: bool) -> str:
    """`exploratory_steps.outcome`: error > blocked > navigated > ok > no_effect."""
    if any(p.rule != "injection" for p in problems):
        return "error"
    if blocked:
        return "blocked"
    if navigated:
        return "navigated"
    return "ok" if changed else "no_effect"


def changed(before: PageState, after: PageState) -> bool:
    """A visible effect: the text, the number of elements or the open dialogs differ."""
    return (before.text_hash, before.dom_size, before.dialogs) != (after.text_hash, after.dom_size, after.dialogs)


def defect_summary(path: str, name: str, problems: list[Problem]) -> str:
    """'/offers: "Show details" throws an error and shows 'NaN'' (one grouped draft per action)."""
    parts: list[str] = []
    for p in problems:
        if p.rule == "uncaught_exception" and "throws an error" not in parts:
            parts.append("throws an error")
        elif p.rule == "server_error" and "gets a server error" not in parts:
            parts.append("gets a server error")
        elif p.rule == "broken_text":
            parts.append(f"shows {p.subject.replace(',', ' and ')}")
        elif p.rule == "not_found" and "leads to a missing page" not in parts:
            parts.append("leads to a missing page")
    what = " and ".join(parts) or "misbehaves"
    return f'{path}: "{name}" {what}'[:300]
