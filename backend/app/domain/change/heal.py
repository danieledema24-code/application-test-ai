"""Locator repair suggestions (P6-04, decision D31). Pure functions; no I/O and no AI.

A broken page-object locator gets up to three replacement candidates, generated in code from what the live page
offers now, in the spec §8 strategy order (`getByRole` + name, `getByLabel`, `getByPlaceholder`, `getByText`,
`getByTestId`, then the discovery component's own locators). Each candidate is scored, with every signal stated in
words (design P6 §8.2):

- diff match, the element the change set paired with the old one (same field, renamed / same element, moved): +0.5
- same role or kind: +0.2
- name similarity × 0.3
- same form or landmark as the page object's other elements: +0.1
- strategy preference, a role or a label: +0.05

The score is capped at 1. High ≥ 0.8, Medium ≥ 0.5, else Low (shown only under "Other possibilities"). A candidate is
offered only when it finds exactly one visible, enabled element with the original's role; the service checks that on
the live page (read-only) and passes the facts in. Two elements that could equally be the renamed one (the diff paired
neither) are listed as "More than one element matches; not offered".

Expected results are never changed: when a change set shows that a text a script's assertion checks changed, the
result is an "Expected result may be out of date" review that links the case and has no accept action
(`asserted_text_reviews`). A failed text check after a run is the reactive form of the same review
(`failed_text_review`).
"""

from __future__ import annotations

import difflib
import hashlib
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

from app.domain.change import impact as im
from app.domain.enums import ChangeKind as K

DIFF_MATCH = 0.5
SAME_ROLE = 0.2
NAME_WEIGHT = 0.3
SAME_PLACE = 0.1
STRATEGY_BONUS = 0.05
HIGH = 0.8
MEDIUM = 0.5
MAX_OFFERED = 3
# Spec §8 order; "discovery" is a locator discovery recorded for the element that none of the others wrote.
STRATEGIES = ("role", "label", "placeholder", "text", "testid", "discovery")
PREFERRED = frozenset({"role", "label"})
AMBIGUOUS = "More than one element matches; not offered"
NOT_SAME_ROLE = "Finds an element with a different role; not offered"
REPAIR_LINE = "Only this locator changes; the test's checks stay the same."
NEVER_CHANGED = "Expected results are never changed automatically."
# Roles a person reads ("Same role (text box)").
ROLE_WORDS = {
    "textbox": "text box",
    "searchbox": "search box",
    "combobox": "dropdown",
    "listbox": "list",
    "checkbox": "checkbox",
    "radio": "radio button",
    "button": "button",
    "link": "link",
    "tab": "tab",
    "spinbutton": "number box",
    "slider": "slider",
    "menuitem": "menu item",
    "form": "form",
}
# Roles that are the same kind of control for a repair (a search box is a text box).
_ROLE_FAMILY = {"searchbox": "textbox"}
_FIELD_ROLES = frozenset({"textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "spinbutton", "slider"})
_Q = r"""(?P<{n}q>['"])(?P<{n}>(?:\\.|(?!(?P={n}q)).)*)(?P={n}q)"""
_DISCOVERY = re.compile(
    r"^getBy(?P<kind>Role|Label|Placeholder|Text|TestId)\("
    + _Q.format(n="first")
    + r"(?:\s*,\s*\{\s*name:\s*"
    + _Q.format(n="name")
    + r"\s*\})?\)$"
)


# ---------------------------------------------------------------- the original locator


def original_role(spec: dict[str, Any]) -> str:
    """The role the broken locator found: fields for labels and placeholders, the spec's role for role locators, a
    link for `a[href=…]` CSS. Empty when it can't be known (then nothing is offered)."""
    by = str(spec.get("by") or "")
    if by in ("label", "placeholder"):
        return "textbox"
    if by == "role":
        return str(spec.get("role") or "button")
    if by == "form_button":
        return "button"
    if by == "form_role":
        return "form"
    if by == "css" and str(spec.get("css") or "").startswith("a["):
        return "link"
    return ""


def same_role(a: str, b: str) -> bool:
    return bool(a) and _ROLE_FAMILY.get(a, a) == _ROLE_FAMILY.get(b, b)


def role_word(role: str) -> str:
    return ROLE_WORDS.get(role, role or "element")


def spec_expression(spec: dict[str, Any]) -> str:
    """How people read a locator spec (`getByLabel('Message')`), as the outdated reason writes it."""
    return im.expression(
        im.LocatorIn(
            file="", getter=str(spec.get("getter") or ""), page="", by=str(spec.get("by") or "css"),
            name=str(spec.get("name") or ""), role=str(spec.get("role") or ""), element=str(spec.get("element") or ""),
            css=str(spec.get("css") or ""), within=str(spec.get("within") or ""), exact=bool(spec.get("exact")),
        )
    )  # fmt: skip


def retitle(before: str, after: str, name: str | None) -> str:
    """After a one-line locator rewrite: the comment at the end of that same line names the element as it is now
    (`return …; // Your message`). Nothing else changes; without a trailing comment or a name, `after` as is."""
    a, b = before.splitlines(keepends=True), after.splitlines(keepends=True)
    changed = [i for i, (x, y) in enumerate(zip(a, b, strict=False)) if x != y]
    if len(a) != len(b) or len(changed) != 1 or not name:
        return after
    line = b[changed[0]]
    code, sep, _old = line.rstrip("\n").partition("; // ")
    if not sep:
        return after
    b[changed[0]] = f"{code}; // {' '.join(name.split())}" + ("\n" if line.endswith("\n") else "")
    return "".join(b)


def is_address(text: Any) -> bool:
    """A page address or URL ('/products/1', 'https://…'), as CSS link locators carry instead of a name."""
    t = str(text or "").strip()
    return t.startswith("/") or "://" in t


_HREF = re.compile(r"""^a\[href=(?P<q>["'])(?P<href>.+?)(?P=q)\]$""")


def link_target(spec: dict[str, Any]) -> str | None:
    """The page a CSS link locator (`a[href="/products/1"]`) points at, without query or fragment; else None."""
    m = _HREF.match(str(spec.get("css") or "").strip()) if spec.get("by") == "css" else None
    if not m:
        return None
    return m.group("href").split("#", 1)[0].split("?", 1)[0] or None


def fold(text: Any) -> str:
    return " ".join(str(text or "").split()).casefold()


def similarity(a: str, b: str) -> float:
    """0–1: how alike two names read (case and spacing ignored)."""
    x, y = fold(a), fold(b)
    if not x or not y:
        return 0.0
    return difflib.SequenceMatcher(None, x, y).ratio()


# ---------------------------------------------------------------- what the diff says


@dataclass(frozen=True)
class DiffMatch:
    """The element the change set paired with the old one."""

    change_id: str
    how: str  # renamed | moved
    new_name: str
    set_key: str
    form: str | None = None


def _names_before(c: im.ChangeIn) -> set[str]:
    b = c.before or {}
    if c.kind == K.field_changed:
        return {fold(b.get("label")), fold(b.get("name"))} - {""}
    if c.kind in (K.element_renamed, K.element_moved, K.element_removed):
        return {fold(b.get("name"))} - {""}
    if c.kind == K.form_changed:
        return {fold(b.get("submit_label"))} - {""}
    return set()


def _on_page(loc: im.LocatorIn, c: im.ChangeIn) -> bool:
    return c.page == loc.page or (c.page is None and loc.within == "navigation")


def diff_match(loc: im.LocatorIn, changes: Sequence[im.ChangeIn], set_key: str) -> DiffMatch | None:
    """The renamed or moved element the diff paired with the locator's element, when exactly one new name is
    possible."""
    names = {fold(loc.name), fold(loc.element)} - {""}
    found: dict[str, DiffMatch] = {}
    for c in changes:
        if not _on_page(loc, c) or not (_names_before(c) & names):
            continue
        a = c.after or {}
        if c.kind == K.field_changed and "label" in (a.get("changed") or []):
            new, how = str(a.get("label") or ""), "renamed"
        elif c.kind == K.element_renamed:
            new, how = str(a.get("name") or ""), "renamed"
        elif c.kind == K.form_changed:
            new, how = str(a.get("submit_label") or ""), "renamed"
        elif c.kind == K.element_moved:
            new, how = str(a.get("name") or ""), "moved"
        else:
            continue
        if new.strip():
            found.setdefault(fold(new), DiffMatch(c.id, how, new, set_key, str(a.get("form") or "") or None))
    return next(iter(found.values())) if len(found) == 1 else None


def ambiguous_renames(loc: im.LocatorIn, changes: Sequence[im.ChangeIn]) -> list[str]:
    """When the locator's element was removed and two or more elements of the same kind were added on the page, the
    diff refused to guess which one replaced it (D26): their names, each "not offered"."""
    names = {fold(loc.name), fold(loc.element)} - {""}
    removed = [c for c in changes if c.kind == K.element_removed and _on_page(loc, c) and _names_before(c) & names]
    if not removed:
        return []
    kind = str((removed[0].before or {}).get("kind") or "")
    added = [
        str((c.after or {}).get("name") or "")
        for c in changes
        if c.kind == K.element_added and _on_page(loc, c) and str((c.after or {}).get("kind") or "") == kind
    ]
    added = [n for n in added if n.strip()]
    return added if len(added) >= 2 else []


# ---------------------------------------------------------------- candidates from the live page


@dataclass(frozen=True)
class Element:
    """One control on the live page, as the read-only collector saw it."""

    role: str
    name: str
    label: str = ""
    placeholder: str = ""
    text: str = ""
    testid: str = ""
    place: str = ""  # "form#0", "nav", "main", …
    visible: bool = True
    enabled: bool = True
    locators: tuple[str, ...] = ()  # discovery's locators for the element, when it recorded it


def element_of(raw: dict[str, Any]) -> Element:
    return Element(
        role=str(raw.get("role") or ""), name=str(raw.get("name") or ""), label=str(raw.get("label") or ""),
        placeholder=str(raw.get("placeholder") or ""), text=str(raw.get("text") or ""),
        testid=str(raw.get("testid") or ""), place=str(raw.get("place") or ""), visible=bool(raw.get("visible", True)),
        enabled=bool(raw.get("enabled", True)), locators=tuple(str(x) for x in raw.get("locators") or []),
    )  # fmt: skip


def likely_elements(
    original: dict[str, Any], elements: Sequence[Element], *, taken: set[str], new_name: str | None, limit: int = 4
) -> list[Element]:
    """The page's elements that could be the old one, most likely first: the diff's renamed element, then same-role
    elements by name similarity. Names another getter of the page object already uses are skipped."""
    role = original_role(original)
    old = str(original.get("name") or original.get("element") or "")
    taken_f = {fold(x) for x in taken} - {fold(old)}
    scored: list[tuple[float, int, Element]] = []
    for i, e in enumerate(elements):
        if not e.name or fold(e.name) in taken_f or not same_role(role, e.role):
            continue
        if new_name is not None and fold(e.name) == fold(new_name):
            scored.append((2.0, i, e))
            continue
        if fold(e.name) == fold(old):
            continue  # the old name still on the page: not a replacement (the locator broke for another reason)
        if is_address(old):
            continue  # found by its address: only the diff's own pairing could name a replacement
        sim = similarity(old, e.name)
        words = set(fold(old).split()) & set(fold(e.name).split())
        if sim >= 0.3 or words:
            scored.append((sim + (0.2 if words else 0.0), i, e))
    scored.sort(key=lambda x: (-x[0], x[1]))
    seen: set[tuple[str, str]] = set()
    out: list[Element] = []
    for _s, _i, e in scored:
        k = (e.role, fold(e.name))
        if k not in seen:
            seen.add(k)
            out.append(e)
    return out[:limit]


def parse_discovery(text: str) -> dict[str, Any] | None:
    """A discovery locator string (`getByRole('button', { name: 'Send' })`) as a page-object spec."""
    m = _DISCOVERY.match(text.strip())
    if not m:
        return None
    kind, first, name = m.group("kind"), m.group("first"), m.group("name")
    if kind == "Role":
        return {"by": "role", "role": first, "name": name or ""} if name else None
    return {"by": {"Label": "label", "Placeholder": "placeholder", "Text": "text", "TestId": "testid"}[kind],
            "name": first}  # fmt: skip


def candidate_specs(original: dict[str, Any], e: Element) -> list[tuple[str, dict[str, Any]]]:
    """Locator specs that could find `e`, in the spec §8 strategy order. The getter, the element name people read and
    `within` (navigation links) are kept; only how the element is found changes."""
    keep = {k: original.get(k) for k in ("getter", "element", "within") if original.get(k) is not None}
    by = str(original.get("by") or "")
    out: list[tuple[str, dict[str, Any]]] = []
    if by == "form_button":  # the form found by its submit button: only the button's new name changes
        return [("role", {**keep, "by": "form_button", "name": e.name, "role": "", "exact": False})]
    if e.role and e.name:
        out.append(("role", {**keep, "by": "role", "role": e.role, "name": e.name, "exact": False}))
    if e.label and e.role in _FIELD_ROLES:
        out.append(("label", {**keep, "by": "label", "name": e.label, "role": "", "exact": False}))
    if e.placeholder:
        out.append(("placeholder", {**keep, "by": "placeholder", "name": e.placeholder, "role": "", "exact": False}))
    if e.text and e.role not in _FIELD_ROLES and not keep.get("within"):
        out.append(("text", {**keep, "by": "text", "name": e.text, "role": "", "exact": False}))
    if e.testid and not keep.get("within"):
        out.append(("testid", {**keep, "by": "testid", "name": e.testid, "role": "", "exact": False}))
    have = {spec_expression(s) for _st, s in out}
    for raw in e.locators:
        spec = parse_discovery(raw)
        if spec is None or keep.get("within"):
            continue
        full = {**keep, "role": "", "exact": False, **spec}
        if spec_expression(full) not in have:
            have.add(spec_expression(full))
            out.append(("discovery", full))
    return out


def strategy_of(spec: dict[str, Any]) -> str:
    by = str(spec.get("by") or "")
    return {"form_button": "role", "form_role": "role"}.get(by, by)


# ---------------------------------------------------------------- the score


@dataclass(frozen=True)
class Signal:
    code: str  # diff | role | name | place | strategy
    text: str
    weight: float


@dataclass(frozen=True)
class Scored:
    score: float
    level: str
    signals: tuple[Signal, ...]


def level_of(score: float) -> str:
    return "high" if score >= HIGH else "medium" if score >= MEDIUM else "low"


def score(
    *,
    old_name: str,
    original: dict[str, Any],
    strategy: str,
    element: Element,
    match: DiffMatch | None,
    original_place: str | None,
) -> Scored:
    """The coded score of one verified candidate, with each signal that counted stated in words."""
    signals: list[Signal] = []
    if match is not None and fold(element.name) == fold(match.new_name):
        # Design P6 §8.2 wording: "Same field, renamed" for any rename the diff paired, "Same element, moved".
        words = f"Same field, renamed ({match.set_key})" if match.how == "renamed" else (
            f"Same element, moved ({match.set_key})"
        )  # fmt: skip
        signals.append(Signal("diff", words, DIFF_MATCH))
    role = original_role(original)
    if same_role(role, element.role):
        signals.append(Signal("role", f"Same role ({role_word(role)})", SAME_ROLE))
    # An address ('/products/1') is not a name: it is never compared with the text people read.
    sim = 0.0 if is_address(old_name) or is_address(element.name) else similarity(old_name, element.name)
    if sim > 0:
        pct = round(sim * 100)
        signals.append(Signal("name", f"Name {pct} % similar ('{old_name}' → '{element.name}')", sim * NAME_WEIGHT))
    if original_place and element.place == original_place:
        words = "In the same form" if original_place.startswith("form") else "In the same section"
        signals.append(Signal("place", words, SAME_PLACE))
    if strategy_of({"by": strategy}) in PREFERRED:
        how = "Uses a label" if strategy == "label" else "Uses a role and name"
        signals.append(Signal("strategy", f"{how} (the most robust kind of locator)", STRATEGY_BONUS))
    total = min(1.0, round(sum(s.weight for s in signals), 4))
    return Scored(round(total, 2), level_of(total), tuple(signals))


def majority_place(places: Iterable[str]) -> str | None:
    """Where the page object's other elements are: the form or landmark most of them sit in."""
    counts: dict[str, int] = {}
    for p in places:
        if p:
            counts[p] = counts.get(p, 0) + 1
    if not counts:
        return None
    return sorted(counts.items(), key=lambda x: (-x[1], x[0]))[0][0]


@dataclass
class Candidate:
    """One replacement expression, as stored in `heal_suggestions.candidates`."""

    expression: str
    strategy: str
    spec: dict[str, Any]
    element: Element
    match_count: int
    offered: bool
    score: float = 0.0
    level: str = "low"
    signals: list[dict[str, Any]] = field(default_factory=list)
    not_offered_reason: str | None = None
    evidence_id: str | None = None
    rule_rank: int = 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "expression": self.expression,
            "strategy": self.strategy,
            "score": self.score,
            "level": self.level,
            "signals": list(self.signals),
            "match_count": self.match_count,
            "offered": self.offered,
            "not_offered_reason": self.not_offered_reason,
            "evidence_id": self.evidence_id,
            "rule_rank": self.rule_rank,
            "spec": {k: v for k, v in self.spec.items() if k in ("by", "name", "role", "exact", "within", "css")},
            "element": {"role": self.element.role, "name": self.element.name},
        }


def rank(candidates: list[Candidate], original: dict[str, Any]) -> list[Candidate]:
    """Rule order: offered first, by score, the original's own strategy first on a tie, then the spec §8 order. At
    most three are offered; the others are kept (not offered) only when they explain why (ambiguous)."""
    own = strategy_of(original)

    def key(c: Candidate) -> tuple[int, float, int, int]:
        return (0 if c.offered else 1, -c.score, 0 if c.strategy == own else 1, STRATEGIES.index(c.strategy))

    ordered = sorted(candidates, key=key)
    offered = [c for c in ordered if c.offered][:MAX_OFFERED]
    shown = offered + [c for c in ordered if not c.offered and c.not_offered_reason == AMBIGUOUS]
    for i, c in enumerate(shown):
        c.rule_rank = i
    return shown


def page_fingerprint(elements: Sequence[Element]) -> str:
    """What the page offered (roles and names), so a rejected suggestion isn't offered again for the same page."""
    text = "\n".join(sorted(f"{e.role}|{fold(e.name)}" for e in elements))
    return hashlib.sha256(text.encode()).hexdigest()[:16]


# ---------------------------------------------------------------- AI: reorder verified candidates only


def ai_order(offered: Sequence[str], answer: Sequence[str]) -> list[str] | None:
    """The AI may reorder the verified candidates. Its order must name exactly those expressions, each once; an
    expression that wasn't verified (or anything else) rejects the answer (None) and the rule order stays."""
    if len(answer) != len(set(answer)) or sorted(answer) != sorted(offered):
        return None
    return list(answer)


# ---------------------------------------------------------------- expected results (never changed)


@dataclass(frozen=True)
class ScriptChecks:
    lineage: str
    case_key: str
    pages: frozenset[str]
    assertions: tuple[dict[str, Any], ...]  # the script's `assertion_map`


@dataclass(frozen=True)
class TextReview:
    lineage: str
    case_key: str
    page: str | None
    before: str
    after: str | None
    helper: str
    change_id: str | None = None
    source_key: str = ""  # CHG-0001 or RUN-0003-07
    reason: str = "text"  # text | page_removed (a link whose page the change set removed)

    def message(self) -> str:
        if self.reason == "page_removed":
            return (f"The link to {self.before} goes to a page removed in {self.source_key}. {self.case_key} follows it, "
                    f"so no replacement locator can be right. Update or retire {self.case_key}.")  # fmt: skip
        where = f" on {self.page}" if self.page else ""
        if self.after:
            what = f"The text changed from '{self.before}' to '{self.after}'{where} ({self.source_key})."
        else:
            what = f"The text '{self.before}' is no longer shown{where} ({self.source_key})."
        return f"{what} {self.case_key} checks this text. {NEVER_CHANGED} Review {self.case_key}."

    def as_dict(self) -> dict[str, Any]:
        return {"page": self.page, "before": self.before, "after": self.after, "helper": self.helper,
                "case_key": self.case_key, "source_key": self.source_key, "reason": self.reason,
                "message": self.message()}  # fmt: skip


# Assertion kinds that check a text on the page, and the changes that can take that text away: a field check finds
# its field by the label, a control check its button or link by name; a text check reads anything on the page.
_TEXT_CHECKS = {
    "text_visible": None,
    "submission_accepted": None,
    "control_enabled": frozenset({K.element_renamed, K.element_removed, K.form_changed}),
    "field_flagged": frozenset({K.field_changed, K.field_removed}),
    "field_length": frozenset({K.field_changed, K.field_removed}),
}


def asserted_texts(assertion_map: Iterable[dict[str, Any]]) -> list[tuple[str, str]]:  # (text, helper)
    """(text, helper) for each assertion that checks a text on the page. `args` is what a person reads (the form's
    name, a label, a text, a control's name), then the call's extra values (a length, "at most")."""
    out: list[tuple[str, str]] = []
    for a in assertion_map:
        kind = str(a.get("kind") or "")
        if kind not in _TEXT_CHECKS or a.get("by_locator"):
            continue  # D36: a field check through the page object follows its locator (a repair covers it)
        texts = [str(x) for x in a.get("args") or [] if isinstance(x, str) and x.strip()]
        texts = [x for x in texts if not x.isdigit() and x not in ("at most", "exactly")]
        if kind == "submission_accepted":
            texts = texts[1:2]  # the first is the form's name; the text is optional
        elif kind in ("field_flagged", "field_length"):
            texts = texts[-1:]  # the label comes after the form's name
        else:
            texts = texts[:1]
        out += [(t, str(a.get("helper") or kind)) for t in texts]
    return out


def _kinds_for(assertion_map: Iterable[dict[str, Any]], helper: str) -> frozenset[K] | None:
    for a in assertion_map:
        if str(a.get("helper") or a.get("kind")) == helper:
            return _TEXT_CHECKS.get(str(a.get("kind") or ""))
    return None


def _text_pairs(c: im.ChangeIn) -> list[tuple[str, str | None]]:
    """(old text, new text or None) for each text the change took off the page."""
    b, a = c.before or {}, c.after or {}
    if c.kind == K.field_changed and "label" in (a.get("changed") or []):
        return [(str(b.get("label") or ""), str(a.get("label") or ""))]
    if c.kind == K.element_renamed:
        return [(str(b.get("name") or ""), str(a.get("name") or ""))]
    if c.kind == K.form_changed:
        return [(str(b.get("submit_label") or ""), str(a.get("submit_label") or ""))]
    if c.kind in (K.element_removed, K.field_removed):
        return [(str(b.get("name") or b.get("label") or ""), None)]
    if c.kind == K.page_changed:
        before, after = (
            [str(x) for x in b.get("headings") or b.get("values") or []],
            [str(x) for x in a.get("headings") or a.get("values") or []],
        )
        if len(before) == len(after):
            return [(x, y) for x, y in zip(before, after, strict=True) if x != y]
        return [(x, None) for x in before if x not in after]
    return []


# Field checks find the field by its whole label (`qa.field`: exact), so "Message" is lost when it becomes "Your message".
_EXACT = frozenset({"field_flagged", "field_length", "expectFieldFlagged", "expectFieldLength"})


def checks_lost(text: str, old: str, new: str | None, *, exact: bool = False) -> bool:
    """The check finds `text` in the old wording and no longer in the new one: as the toolkit does, part of the text
    (case-insensitive) for texts and controls, the whole label for fields (`exact`)."""
    if exact:
        t = " ".join(text.split())
        return bool(t) and t == " ".join(old.split()) and (new is None or t != " ".join(new.split()))
    t = fold(text)
    return bool(t) and t in fold(old) and (new is None or t not in fold(new))


def asserted_text_reviews(
    changes: Sequence[im.ChangeIn], scripts: Sequence[ScriptChecks], set_key: str
) -> list[TextReview]:
    """One review per case whose script checks a text the change set shows changed or removed on its pages. Cosmetic
    changes count here: a heading or value a script checks is exactly what a test depends on."""
    out: list[TextReview] = []
    seen: set[tuple[str, str]] = set()
    for sc in sorted(scripts, key=lambda x: x.case_key):
        for text, helper in asserted_texts(sc.assertions):
            kinds = _kinds_for(sc.assertions, helper)
            for c in changes:
                if c.page is None or c.page not in sc.pages or (kinds is not None and c.kind not in kinds):
                    continue
                for old, new in _text_pairs(c):
                    if (
                        not old
                        or not checks_lost(text, old, new, exact=helper in _EXACT)
                        or (sc.lineage, fold(text)) in seen
                    ):
                        continue
                    seen.add((sc.lineage, fold(text)))
                    out.append(TextReview(sc.lineage, sc.case_key, c.page, old, new, helper, c.id, set_key))
    return out


_FAILED_TEXT = (
    re.compile(r'Expected the text "(?P<t>.+?)" to be shown'),
    re.compile(r'Expected the .+? form to be accepted with "(?P<t>.+?)"'),
    re.compile(r"Expected the (?P<t>.+?) control to be shown and enabled"),
)


def failed_text_review(
    error: str, page_state: dict[str, Any], *, lineage: str, case_key: str, result_key: str
) -> TextReview | None:
    """After a run: a text check failed and the page showed another message instead. The expected text may be out of
    date (or the application is wrong); a person decides. None when the error isn't a text check."""
    for rx in _FAILED_TEXT:
        m = rx.search(error or "")
        if m is None:
            continue
        text = m.group("t")
        shown = [str(x) for x in page_state.get("messages") or [] if str(x).strip()]
        shown = [x for x in shown if fold(text) not in fold(x)]
        if not shown:
            return None
        page = str(page_state.get("url") or "") or None
        return TextReview(lineage, case_key, page, text, shown[0][:200], "failed", None, result_key)
    return None
