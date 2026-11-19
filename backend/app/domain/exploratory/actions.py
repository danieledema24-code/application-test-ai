"""The exploration allow-list (decision D30), computed in code for one page state. Pure: unit-tested.

The page script reports the clickable elements it can see (`Element`); `compute_actions` decides, element by
element, whether exploring may touch it:

- allowed: clicks on controls that can't submit (`button[type=button]`, buttons outside any form, `summary`,
  `[role=tab]`, `[aria-expanded]`, `[aria-haspopup]`, `[role=button]`) and same-origin http(s) links outside the
  discovery `SKIP_LINK` vocabulary, plus Escape and reload on the page itself;
- never: typing, selecting, uploading, submitting, downloading, other sites, `mailto:`/`tel:`/`javascript:` links,
  and any control or link whose name matches the data-changing vocabulary below (word boundaries). Those are
  returned as "Not tried" with the reason, never silently dropped.

Every allowed action gets an id (`a1`, `a2`, … per page state) so a model can only pick from this list (P6-03b), and
a fingerprint that dedupes it across pages and states (a nav link is tried once per session).
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from app.agents.discovery.heuristics import skip_reason

# Roadmap "Phase 6 rules" 3: names that may change data are never clicked (whole words, any case).
DATA_CHANGING = re.compile(
    r"\b(delete|remove|buy|pay|order|checkout|check\s+out|subscribe|unsubscribe|sign\s*-?\s*out|log\s*-?\s*out|"
    r"logout|signout|send|submit|confirm|save)\b",
    re.IGNORECASE,
)
SESSION_END = re.compile(r"\b(sign|log)\s*-?\s*(out|off)\b|\blogout\b|\bsignout\b|\blogoff\b", re.IGNORECASE)
CLICKABLE_ROLES = ("button", "tab", "menuitem", "switch", "treeitem", "option")
PAGE_ACTIONS = ("escape", "reload")

# "Why not tried" wording (design §9.6).
SUBMITS_FORM = "Submits a form"
RESETS_FORM = "Resets a form"
ENDS_SESSION = "Would end the session"
CHANGES_DATA = "Name suggests it changes data"
DOWNLOADS = "Downloads a file"
OTHER_SITE = "Goes to another site"
NOT_A_PAGE = "Opens an email or phone app"
SCRIPT_LINK = "Runs a script instead of opening a page"
DESTRUCTIVE_LINK = "Link looks like it changes data"
NAV_BLOCKED = "Leads to an address exploration may not open"
NEW_WINDOW = "Opens a new window"


@dataclass(frozen=True)
class Element:
    """A visible, enabled clickable element as the page script reports it (one page state)."""

    selector: str  # a CSS path the explorer clicks
    tag: str  # lower case
    role: str  # explicit or implicit ARIA role
    name: str  # accessible name (trimmed, <= 120 chars)
    type: str | None = None  # `type` of a button or input (lower case)
    href: str | None = None  # absolute URL of a link
    target: str | None = None
    download: bool = False
    in_form: bool = False  # inside a form, or tied to one with `form=`
    disabled: bool = False

    @classmethod
    def from_js(cls, raw: dict[str, Any]) -> Element:
        return cls(
            selector=str(raw.get("selector") or ""),
            tag=str(raw.get("tag") or "").lower(),
            role=str(raw.get("role") or "").lower(),
            name=" ".join(str(raw.get("name") or "").split())[:120],
            type=(str(raw["type"]).lower() if raw.get("type") else None),
            href=str(raw["href"]) if raw.get("href") else None,
            target=str(raw["target"]) if raw.get("target") else None,
            download=bool(raw.get("download")),
            in_form=bool(raw.get("in_form")),
            disabled=bool(raw.get("disabled")),
        )


@dataclass(frozen=True)
class Action:
    id: str
    kind: str  # click | link | escape | reload
    role: str
    name: str
    fingerprint: str
    selector: str | None = None
    href: str | None = None

    @property
    def label(self) -> str:
        """'Clicked button "Show details"' (the step log; no page text beyond the element's name)."""
        if self.kind == "escape":
            return "Pressed Escape"
        if self.kind == "reload":
            return "Reloaded the page"
        if self.kind == "link":
            return f'Opened link "{self.name}"'
        return f'Clicked {self.role or "element"} "{self.name}"'

    @property
    def verb(self) -> str:
        """'clicking button "Show details"' for sentences ("Uncaught error after clicking …")."""
        if self.kind == "escape":
            return "pressing Escape"
        if self.kind == "reload":
            return "reloading the page"
        if self.kind == "link":
            return f'opening link "{self.name}"'
        return f'clicking {self.role or "element"} "{self.name}"'

    def as_dict(self) -> dict[str, Any]:
        """`exploratory_steps.action`: {kind, target {role, name, fingerprint}, href?}."""
        d: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind,
            "target": {"role": self.role, "name": self.name, "fingerprint": self.fingerprint},
        }
        if self.href:
            d["href"] = self.href
        return d

    def choice(self) -> dict[str, Any]:
        """What a model may see of an action (P6-03b): its id, kind, role and name. Never selectors or URLs."""
        return {"id": self.id, "kind": self.kind, "role": self.role, "name": self.name}


@dataclass(frozen=True)
class NotTried:
    role: str
    name: str
    page: str  # path of the page it was on
    reason: str
    fingerprint: str

    @property
    def element(self) -> str:
        """'Button "Apply code"'."""
        return f'{(self.role or "element").capitalize()} "{self.name}"'

    def as_dict(self) -> dict[str, Any]:
        return {
            "element": self.element,
            "role": self.role,
            "name": self.name,
            "page": self.page,
            "reason": self.reason,
            "fingerprint": self.fingerprint,
        }


@dataclass
class PageActions:
    allowed: list[Action] = field(default_factory=list)
    not_tried: list[NotTried] = field(default_factory=list)

    def by_id(self, action_id: str) -> Action | None:
        return next((a for a in self.allowed if a.id == action_id), None)


def origin_of(url: str) -> str:
    p = urlsplit(url)
    scheme = p.scheme.lower()
    port = p.port
    default = (scheme == "http" and port in (None, 80)) or (scheme == "https" and port in (None, 443))
    host = (p.hostname or "").lower()
    return f"{scheme}://{host}" if default else f"{scheme}://{host}:{port}"


def path_of(url: str) -> str:
    p = urlsplit(url)
    return (p.path or "/") + (f"?{p.query}" if p.query else "")


def page_key(url: str) -> str:
    """A page's identity for the explorer: origin + path + query, without the fragment."""
    p = urlsplit(url)
    return urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path or "/", p.query, ""))


def _fp(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]


def fingerprint(el: Element) -> str:
    """Links by where they go; controls by role, name and position in the page (component fingerprint)."""
    if el.role == "link" and el.href:
        return _fp("link", page_key(el.href))
    return _fp("click", el.role, el.name.lower(), el.selector)


def link_skip_reason(url: str) -> str | None:
    """Why exploration never opens this address (the discovery skip list in "Not tried" wording), or None. Also
    applied by the network guard to every top-level navigation, so redirects and scripted navigations to a sign-out
    or destructive address are stopped too."""
    why = skip_reason(url)
    if why is None:
        return None
    if why == "would end the session":
        return ENDS_SESSION
    if why == "file download":
        return DOWNLOADS
    return DESTRUCTIVE_LINK


def data_word(name: str) -> str | None:
    m = DATA_CHANGING.search(name or "")
    return m.group(0) if m else None


def _submits(el: Element) -> bool:
    if el.tag == "button":  # HTML: a missing or unknown `type` is "submit"; only button and reset don't submit
        return el.in_form and el.type not in ("button", "reset")
    if el.tag == "input":
        return el.in_form and el.type in ("submit", "image")
    return False


def classify(el: Element, origin: str) -> tuple[str | None, str | None]:
    """(action kind, None) when allowed, (None, reason) when not tried, (None, None) when ignored."""
    if el.disabled or not el.selector:
        return None, None
    name = el.name or ""
    if el.role == "link" or (el.tag == "a" and el.href):
        href = el.href or ""
        scheme = urlsplit(href).scheme.lower()
        if scheme in ("mailto", "tel", "sms"):
            return None, NOT_A_PAGE
        if scheme == "javascript":
            return None, SCRIPT_LINK
        if scheme not in ("http", "https"):
            return None, NOT_A_PAGE
        if el.download:
            return None, DOWNLOADS
        if origin_of(href) != origin:
            return None, OTHER_SITE
        if SESSION_END.search(name):
            return None, ENDS_SESSION
        why = link_skip_reason(href)
        if why is not None:
            return None, why
        if data_word(name):
            return None, CHANGES_DATA
        return "link", None
    if el.tag in ("input", "select", "textarea") and not (
        el.tag == "input" and el.type in ("button", "submit", "image", "reset")
    ):
        return None, None  # fields are never typed into or selected; they aren't actions
    if SESSION_END.search(name):
        return None, ENDS_SESSION
    if _submits(el):
        return None, SUBMITS_FORM
    if el.type == "reset" and el.in_form:
        return None, RESETS_FORM
    if data_word(name):
        return None, CHANGES_DATA
    return "click", None


def compute_actions(
    elements: Iterable[Element],
    page_url: str,
    origin: str,
    *,
    priority_names: Iterable[str] = (),
    never_click: Iterable[str] = (),
) -> PageActions:
    """The allow-list of one page state, in the rule strategy's order: elements named like a changed or new element
    first (`priority_names`, from the change set), then controls before links, then page order. `never_click` adds
    names (case-insensitive) that are never activated (a signed-in session's sign-out controls)."""
    prio = {n.strip().lower() for n in priority_names if n and n.strip()}
    never = {n.strip().lower() for n in never_click if n and n.strip()}
    page = path_of(page_url)
    ranked: list[tuple[tuple[int, int, int], Element, str]] = []
    not_tried: list[NotTried] = []
    seen: set[str] = set()
    for i, el in enumerate(elements):
        kind, reason = classify(el, origin)
        if kind is not None and el.name.strip().lower() in never:
            kind, reason = None, ENDS_SESSION
        fp = fingerprint(el)
        if fp in seen:
            continue
        if kind is None:
            if reason is not None:
                seen.add(fp)
                not_tried.append(NotTried(el.role or el.tag, el.name or "(no name)", page, reason, fp))
            continue
        if kind == "link" and page_key(el.href or "") == page_key(page_url):
            continue  # a link to this very page (or a fragment of it) changes nothing
        seen.add(fp)
        ranked.append(((0 if el.name.strip().lower() in prio else 1, 0 if kind == "click" else 1, i), el, kind))
    ranked.sort(key=lambda x: x[0])
    allowed = [
        Action(
            id=f"a{n}",
            kind=kind,
            role=el.role or ("link" if kind == "link" else "button"),
            name=el.name or "(no name)",
            fingerprint=fingerprint(el),
            selector=el.selector,
            href=page_key(el.href) if kind == "link" and el.href else None,
        )
        for n, (_k, el, kind) in enumerate(ranked, start=1)
    ]
    n = len(allowed)
    for extra in PAGE_ACTIONS:  # page-level actions (P6-03b may choose them; the rules never need to)
        n += 1
        allowed.append(Action(id=f"a{n}", kind=extra, role="page", name=extra, fingerprint=_fp(extra, page)))
    return PageActions(allowed=allowed, not_tried=not_tried)


def element_actions(pa: PageActions) -> list[Action]:
    """The clicks and links of a page state (what the rule strategy works through)."""
    return [a for a in pa.allowed if a.kind in ("click", "link")]
