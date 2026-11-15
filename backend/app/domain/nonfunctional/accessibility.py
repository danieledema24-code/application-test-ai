"""Accessibility rule handling (P5-02): axe results to findings, WCAG references, keyboard heuristics, D20 drafts.

Pure functions; the scan agent feeds them what the browser observed. Severity comes from axe's `impact` (a fixed
table, never the AI). Best-practice rules are stored as `minor` and labelled "Best practice (not a WCAG failure)";
axe `incomplete` items are "Needs review" (`minor`, never counted as problems, never drafted). Keyboard findings are
heuristics and never drafted.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any
from urllib.parse import urlsplit

from app.domain.enums import DefectSeverity, FindingSeverity
from app.security.redact import redact_text

IMPACT = {
    "critical": FindingSeverity.critical,
    "serious": FindingSeverity.serious,
    "moderate": FindingSeverity.moderate,
    "minor": FindingSeverity.minor,
}
DRAFTED = (FindingSeverity.critical, FindingSeverity.serious)  # decision D20
DEFECT_SEVERITY = {FindingSeverity.critical: DefectSeverity.major, FindingSeverity.serious: DefectSeverity.minor}
MAX_NODES = 20
MAX_HTML = 500
BEST_PRACTICE = "Best practice (not a WCAG failure)"
NEEDS_REVIEW = "Needs review: the automated check couldn't decide"
STATEMENT = (
    "Automated checks find only part of WCAG 2.2 AA issues. Screen reader, zoom and cognitive checks need a person."
)
KEYBOARD_NO_DRAFT = "Keyboard checks don't create defect drafts automatically. Raise one if a person confirms it."
KEYBOARD_RULES = {
    "keyboard-trap": ("Keyboard trap", FindingSeverity.critical, "2.1.2", "No Keyboard Trap", "A"),
    "focus-not-visible": ("Focus not visible", FindingSeverity.serious, "2.4.7", "Focus Visible", "AA"),
    "not-reachable": ("Not reachable by keyboard", FindingSeverity.serious, "2.1.1", "Keyboard", "A"),
}
# Names of the WCAG 2.2 success criteria axe reports most often (the number alone is shown otherwise).
CRITERIA = {
    "1.1.1": "Non-text Content",
    "1.3.1": "Info and Relationships",
    "1.4.3": "Contrast (Minimum)",
    "1.4.11": "Non-text Contrast",
    "2.1.1": "Keyboard",
    "2.1.2": "No Keyboard Trap",
    "2.4.1": "Bypass Blocks",
    "2.4.2": "Page Titled",
    "2.4.4": "Link Purpose (In Context)",
    "2.4.7": "Focus Visible",
    "2.5.8": "Target Size (Minimum)",
    "3.1.1": "Language of Page",
    "3.3.2": "Labels or Instructions",
    "4.1.2": "Name, Role, Value",
}
# Plain-words titles for grouped drafts (design §10); other rules use axe's help text.
PLAIN_TITLES = {
    "image-alt": "Images have no text alternative",
    "color-contrast": "Text has too little contrast",
    "label": "Form fields have no label",
    "button-name": "Buttons have no accessible name",
    "link-name": "Links have no accessible name",
    "html-has-lang": "Pages don't declare their language",
    "document-title": "Pages have no title",
}
_WCAG_TAG = re.compile(r"^wcag(\d)(\d)(\d+)$")
_LEVEL_TAGS = {"wcag2a": "A", "wcag21a": "A", "wcag2aa": "AA", "wcag21aa": "AA", "wcag22aa": "AA"}
_PASSWORD_VALUE = re.compile(r"""(<input\b[^>]*type=["']?password["']?[^>]*?)\svalue=(["']).*?\2""", re.IGNORECASE)
_PASSWORD_VALUE_REV = re.compile(r"""(<input\b[^>]*?)\svalue=(["']).*?\2([^>]*type=["']?password)""", re.IGNORECASE)


def wcag_refs(tags: list[str]) -> list[dict[str, Any]]:
    """axe tags -> [{type: wcag, criterion: "1.1.1", name, level}] (level from the wcag2a/wcag2aa tags)."""
    level = next((_LEVEL_TAGS[t] for t in tags if t in _LEVEL_TAGS), None)
    out = []
    for t in tags:
        m = _WCAG_TAG.match(t)
        if m:
            crit = f"{m.group(1)}.{m.group(2)}.{m.group(3)}"
            out.append({"type": "wcag", "criterion": crit, "name": CRITERIA.get(crit), "level": level})
    return out


def is_best_practice(tags: list[str]) -> bool:
    return "best-practice" in tags and not any(_WCAG_TAG.match(t) for t in tags)


def severity_of(impact: str | None, tags: list[str]) -> FindingSeverity:
    if is_best_practice(tags):
        return FindingSeverity.minor
    return IMPACT.get(impact or "", FindingSeverity.minor)


def clean_html(html: str, secrets: list[str]) -> str:
    """Element HTML as stored: password `value` attributes removed, secrets redacted, <= 500 chars."""
    out = _PASSWORD_VALUE.sub(r"\1", html)
    out = _PASSWORD_VALUE_REV.sub(r"\1\3", out)
    return redact_text(out, secrets)[:MAX_HTML]


def path_of(url: str) -> str:
    p = urlsplit(url)
    return (p.path or "/") + (f"?{p.query}" if p.query else "")


def fingerprint(rule_id: str, url: str, target: str, viewport: str) -> str:
    """Rule + normalised path + first element + viewport: the same problem in a later scan ("Seen before")."""
    basis = f"{rule_id}|{path_of(url).rstrip('/') or '/'}|{target}|{viewport}"
    return hashlib.sha256(basis.encode()).hexdigest()


def findings_from_axe(result: dict[str, Any], *, url: str, viewport: str, secrets: list[str]) -> list[dict[str, Any]]:
    """One finding per violated (or incomplete) rule on this page and viewport."""
    out: list[dict[str, Any]] = []
    for bucket, review in (("violations", False), ("incomplete", True)):
        for v in result.get(bucket) or []:
            tags = [str(t) for t in v.get("tags") or []]
            nodes = []
            for n in (v.get("nodes") or [])[:MAX_NODES]:
                target = n.get("target") or []
                sel = " ".join(str(x) for x in target) if isinstance(target, list) else str(target)
                nodes.append(
                    {
                        "target": redact_text(sel, secrets)[:300],
                        "html": clean_html(str(n.get("html") or ""), secrets),
                        "summary": redact_text(str(n.get("failureSummary") or ""), secrets)[:500],
                    }
                )
            if not nodes:
                continue
            rule = str(v.get("id"))
            sev = FindingSeverity.minor if review else severity_of(v.get("impact"), tags)
            refs = wcag_refs(tags)
            if v.get("helpUrl"):
                refs.append({"type": "help", "url": str(v["helpUrl"]), "source": "axe-core"})
            out.append(
                {
                    "rule_id": rule,
                    "severity": sev,
                    "title": str(v.get("help") or rule)[:300],
                    "description": str(v.get("description") or "")[:1000],
                    "how_to_fix": str(v.get("help") or "")[:500],
                    "url": url,
                    "viewport": viewport,
                    "nodes": nodes,
                    "references": refs,
                    "best_practice": is_best_practice(tags),
                    "needs_review": review,
                    "impact": v.get("impact"),
                    "fingerprint": fingerprint(rule + ("#review" if review else ""), url, nodes[0]["target"], viewport),
                }
            )
    return out


# ------------------------------------------------------------------ keyboard pass (heuristic)


def keyboard_findings(k: dict[str, Any], *, url: str, viewport: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Heuristic findings from a Tab/Shift+Tab pass and the per-page keyboard summary.

    `k`: {order: [{id, selector, label, visible_focus}], stuck_at: selector|None, tabbable: [{id, selector, label}],
    completed: bool, presses: int}. A trap is focus not moving for 3 presses or a cycle through fewer elements than
    the page's tabbable controls; "Not reachable" is only judged after a full cycle."""
    order = list(k.get("order") or [])
    tabbable = list(k.get("tabbable") or [])
    distinct = {o["id"] for o in order}
    trap_at: str | None = k.get("stuck_at")
    if trap_at is None and k.get("cycled") and len(distinct) < len(tabbable):
        trap_at = order[-1]["selector"] if order else None
    not_visible = [o for o in _unique(order) if not o.get("visible_focus")]
    unreachable = [t for t in tabbable if t["id"] not in distinct] if k.get("completed") and not trap_at else []
    findings: list[dict[str, Any]] = []

    def add(rule: str, nodes: list[dict[str, Any]]) -> None:
        title, sev, crit, name, level = KEYBOARD_RULES[rule]
        findings.append(
            {
                "rule_id": rule,
                "severity": sev,
                "title": title,
                "description": "",
                "how_to_fix": "",
                "url": url,
                "viewport": viewport,
                "nodes": nodes[:MAX_NODES],
                "heuristic": True,
                "references": [{"type": "wcag", "criterion": crit, "name": name, "level": level}],
                "best_practice": False,
                "needs_review": False,
                "impact": None,
                "fingerprint": fingerprint(rule, url, nodes[0]["target"] if nodes else "", viewport),
            }
        )

    if trap_at is not None:
        add("keyboard-trap", [{"target": trap_at, "html": "", "summary": "Focus stopped moving here."}])
    if not_visible:
        add(
            "focus-not-visible",
            [{"target": o["selector"], "html": "", "summary": o.get("label") or ""} for o in not_visible],
        )
    if unreachable:
        add(
            "not-reachable",
            [{"target": t["selector"], "html": "", "summary": t.get("label") or ""} for t in unreachable],
        )
    summary = {
        "url": url,
        "viewport": viewport,
        "focusable": len(distinct),
        "tabbable": len(tabbable),
        "presses": int(k.get("presses") or 0),
        "trap": trap_at is not None,
        "not_visible": len(not_visible),
        "not_reachable": len(unreachable),
        "completed": bool(k.get("completed")),
        "reverse_ok": bool(k.get("reverse_ok", True)),
        "order": [
            {"n": i + 1, "role": o.get("role") or "", "label": (o.get("label") or "")[:80]}
            for i, o in enumerate(_unique(order))
        ][:60],
    }
    return findings, summary


def _unique(order: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out = []
    for o in order:
        if o["id"] not in seen:
            seen.add(o["id"])
            out.append(o)
    return out


# ------------------------------------------------------------------ grouped drafts (D20)


def draft_title(rule_id: str, help_text: str, urls: list[str]) -> str:
    """'Product images have no text alternative (2 pages)' (product pages: every page's path names products)."""
    base = PLAIN_TITLES.get(rule_id) or help_text.rstrip(".")
    pages = len(set(urls))
    if rule_id == "image-alt" and urls and all("product" in path_of(u).lower() for u in urls):
        base = "Product images have no text alternative"
    return f"{base} ({pages} page{'s' if pages != 1 else ''})"[:300]
