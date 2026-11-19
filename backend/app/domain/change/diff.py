"""Comparing two scans (P6-01, decision D26). Pure functions over what discovery recorded; no I/O and no AI.

Matching, in order:
- pages by `url_hash` + `auth_context`; unmatched pages are added or removed;
- components on a matched page by `fingerprint` (unchanged), then kind + role + selector with a different name
  (renamed), then kind + role + name with a different selector (moved); anything left is added or removed. A pairing
  is only made when it is one-to-one: two candidates for one element are an add and a remove, never a guess;
- links on a matched page (outside the navigation) by path; a link's name is the heading of the page it points to;
- forms by action + method, then by name; their fields by `name`;
- navigation as the set of nav links over all pages; journeys by name and start page, their steps by page (numbers in
  the path ignored) and, for steps that weren't navigated, by their text.

Significance is fixed here (roadmap P6-01): structural for pages, forms and fields added or removed, `required`,
type, constraint and option changes, and status codes; behavioural for renamed interactive elements and labels,
navigation and journeys; cosmetic for headings, moves that no script locator depends on, and changed values. The noise
filter: names that differ only in numbers or currency amounts (prices, stock counts) are one cosmetic "Content values
changed" item per page, never a rename.

When a scan stopped early (`partial`), the pages only the other scan has are "Not compared" (design P6 §20 OQ2): the
partial scan may simply not have reached them, so they are neither added nor removed and nothing is inferred from them.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from collections.abc import Callable, Hashable, Iterable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from app.domain.enums import ChangeKind as K
from app.domain.enums import ChangeSignificance as S

# The fixed honesty statement (roadmap "Phase 6 rules"; design P6 §3.8). Never edited per screen or by the AI.
CHANGE_STATEMENT = (
    "Changes are detected by comparing what discovery saw in two scans. Content that discovery can't see (behind "
    "sign-in without credentials, inside canvases or iframes, or only after form submission) is not compared."
)
# Scans a person can compare (design P6 §6.1): finished, possibly stopped early.
COMPARABLE_SCAN_STATUSES = frozenset({"completed", "partial"})
INCOMPLETE_SCAN_STATUSES = frozenset({"partial", "cancelled", "failed"})
# The noise-filter group: one cosmetic `page_changed` item per page whose before/after carry this marker.
CONTENT_VALUES = "content_values"
# D27: more than this share of the baseline's pages removed or structurally changed suggests a re-baseline.
REBASELINE_SHARE = 0.5

KIND_ORDER = tuple(K)
SIGNIFICANCES = tuple(S)
ELEMENT_NAMES = {
    "button": "Button",
    "link": "Link",
    "search": "Search box",
    "filter": "Filter",
    "dropdown": "Dropdown",
    "modal": "Dialog",
    "tabs": "Tabs",
    "accordion": "Expandable section",
    "menu": "Menu",
    "table": "Table",
    "pagination": "Pagination",
}
# Forms are named by what they are for when discovery recognised it (`purpose_guess`), else by their only field.
FORM_NAMES = {
    "contact": "Contact form",
    "login": "Sign-in form",
    "registration": "Registration form",
    "search": "Search form",
    "newsletter": "Newsletter form",
    "checkout": "Checkout form",
    "filter": "Filters",
}
CONSTRAINTS = ("min", "max", "minlength", "maxlength", "pattern")
_STRUCTURAL_FIELD_ATTRS = frozenset({"type", "required", "constraints", "options"})
_VALUE = re.compile(r"[£$€¥]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?")
_DIGITS = re.compile(r"\d+")


# ---------------------------------------------------------------- inputs


@dataclass
class PageSnap:
    """One discovered page as the diff sees it (`discovered_pages` plus its evidence ids)."""

    id: str
    url: str
    url_hash: str
    auth_context: str = "anonymous"
    status: str = "visited"
    http_status: int | None = 200
    title: str = ""
    headings: list[str] = field(default_factory=list)
    nav_links: list[dict[str, Any]] = field(default_factory=list)
    links: list[str] = field(default_factory=list)
    forms: list[dict[str, Any]] = field(default_factory=list)
    components: list[dict[str, Any]] = field(default_factory=list)
    screenshot_evidence_id: str | None = None
    dom_evidence_id: str | None = None

    @property
    def path(self) -> str:
        return path_of(self.url)

    @property
    def key(self) -> tuple[str, str]:
        return (self.url_hash, self.auth_context)

    @property
    def name(self) -> str:
        """What a link to this page is called: its first heading, else its title without the site name."""
        if self.headings:
            return str(self.headings[0])
        return self.title.split(" · ")[0].split(" | ")[0].strip() or self.path


@dataclass
class JourneyStepSnap:
    url: str | None
    action: str
    label: str = "observed"  # observed steps were navigated; inferred ones (fill in, submit) weren't performed


@dataclass
class JourneySnap:
    name: str
    steps: list[JourneyStepSnap] = field(default_factory=list)

    @property
    def start(self) -> str:
        first = self.steps[0].url if self.steps else None
        return normalise_path(path_of(first)) if first else ""


@dataclass
class ScanSnap:
    number: int
    status: str
    pages: list[PageSnap] = field(default_factory=list)
    journeys: list[JourneySnap] = field(default_factory=list)

    @property
    def partial(self) -> bool:
        """Stopped before the end (stopped early, cancelled or failed): pages it lacks were maybe never reached."""
        return self.status in INCOMPLETE_SCAN_STATUSES


# ---------------------------------------------------------------- outputs


@dataclass
class Change:
    kind: K
    significance: S
    page_url: str | None
    before: dict[str, Any] | None
    after: dict[str, Any] | None
    before_ref: dict[str, Any] | None = None
    after_ref: dict[str, Any] | None = None


@dataclass
class DiffResult:
    items: list[Change]
    not_compared: list[dict[str, Any]]
    rebaseline_suggested: bool
    summary: dict[str, Any]


# ---------------------------------------------------------------- helpers


def path_of(url: str) -> str:
    p = urlsplit(url)
    return (p.path or "/") + (f"?{p.query}" if p.query else "")


def normalise_path(path: str) -> str:
    """`/products/1` and `/products/2` are the same kind of page for a journey step."""
    return _DIGITS.sub("{n}", path)


def values_only(before: str, after: str) -> bool:
    """True when two names differ only in numbers or currency amounts ("£12.50" → "£13.00", "40 in stock")."""
    if before == after:
        return False
    a, b = _VALUE.sub("#", before), _VALUE.sub("#", after)
    return a == b and "#" in a


def is_content_values(change: Change) -> bool:
    return bool((change.after or {}).get("group") == CONTENT_VALUES)


def page_ref(page: PageSnap, fingerprint: str | None = None) -> dict[str, Any]:
    """Where to find the evidence for an item in one scan: the page, the element and its screenshot and DOM."""
    ref: dict[str, Any] = {
        "page_id": page.id,
        "url": page.url,
        "screenshot_evidence_id": page.screenshot_evidence_id,
        "dom_evidence_id": page.dom_evidence_id,
    }
    if fingerprint:
        ref["fingerprint"] = fingerprint
    return ref


def _pair(
    before: list[dict[str, Any]], after: list[dict[str, Any]], key: Callable[[dict[str, Any]], Hashable]
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """One-to-one pairs with the same key; both lists keep what wasn't paired (an ambiguous key pairs nothing)."""
    by_b: dict[Hashable, list[dict[str, Any]]] = defaultdict(list)
    by_a: dict[Hashable, list[dict[str, Any]]] = defaultdict(list)
    for x in before:
        by_b[key(x)].append(x)
    for x in after:
        by_a[key(x)].append(x)
    pairs = [(bs[0], by_a[k][0]) for k, bs in by_b.items() if len(bs) == 1 and len(by_a.get(k, [])) == 1]
    for b, a in pairs:
        before.remove(b)
        after.remove(a)
    return pairs


# ---------------------------------------------------------------- components and links


def _component(c: dict[str, Any]) -> dict[str, Any]:
    details = c.get("details") or {}
    name = str(c.get("name") or "").strip()
    selector = str(details.get("selector") or "")
    kind, role = str(c.get("kind") or "other"), c.get("role")
    return {
        "kind": kind,
        "role": role,
        "name": name,
        "selector": selector,
        "locator": c.get("locator"),
        "fingerprint": str(c.get("fingerprint") or f"{kind}|{role}|{name.lower()}|{selector}"),
    }


def _components(page: PageSnap) -> list[dict[str, Any]]:
    """A control discovery saw twice (a button that also opens a dialog) is compared once."""
    seen: set[tuple[Any, str, str]] = set()
    out = []
    for raw in page.components:
        c = _component(raw)
        k = (c["role"], c["name"].lower(), c["selector"])
        if k in seen:
            continue
        seen.add(k)
        out.append(c)
    return out


def _shown(c: dict[str, Any]) -> dict[str, Any]:
    return {k: c[k] for k in ("kind", "role", "name", "selector", "locator")}


class _PageDiff:
    """The items of one matched page, plus its "Content values changed" pairs."""

    def __init__(self, base: PageSnap, target: PageSnap) -> None:
        self.base, self.target = base, target
        self.items: list[Change] = []
        self.values: list[tuple[str, str]] = []
        self.renamed: set[tuple[str, str]] = set()

    def add(
        self,
        kind: K,
        significance: S,
        before: dict[str, Any] | None,
        after: dict[str, Any] | None,
        *,
        fp_before: str | None = None,
        fp_after: str | None = None,
    ) -> None:
        self.items.append(
            Change(
                kind,
                significance,
                self.target.url,
                before,
                after,
                page_ref(self.base, fp_before),
                page_ref(self.target, fp_after),
            )
        )

    def components(self, used_selectors: frozenset[str]) -> None:
        base, target = _components(self.base), _components(self.target)
        left = Counter(c["fingerprint"] for c in target)
        removed: list[dict[str, Any]] = []
        for c in base:
            if left[c["fingerprint"]] > 0:
                left[c["fingerprint"]] -= 1
            else:
                removed.append(c)
        right = Counter(c["fingerprint"] for c in base)
        added: list[dict[str, Any]] = []
        for c in target:
            if right[c["fingerprint"]] > 0:
                right[c["fingerprint"]] -= 1
            else:
                added.append(c)
        for b, a in _pair(removed, added, lambda c: (c["kind"], c["role"], c["selector"])):
            if values_only(b["name"], a["name"]):
                self.values.append((b["name"], a["name"]))
                continue
            self.renamed.add((b["name"], a["name"]))
            self.add(K.element_renamed, S.behavioural, _shown(b), _shown(a), fp_before=b["fingerprint"],
                     fp_after=a["fingerprint"])  # fmt: skip
        for b, a in _pair(removed, added, lambda c: (c["kind"], c["role"], c["name"].lower())):
            significance = S.behavioural if b["selector"] in used_selectors else S.cosmetic
            self.add(K.element_moved, significance, _shown(b), _shown(a), fp_before=b["fingerprint"],
                     fp_after=a["fingerprint"])  # fmt: skip
        for b in removed:
            self.add(K.element_removed, S.structural, _shown(b), None, fp_before=b["fingerprint"])
        for a in added:
            self.add(K.element_added, S.structural, None, _shown(a), fp_after=a["fingerprint"])

    def links(self, nav_paths: set[str], base_names: dict[str, str], target_names: dict[str, str]) -> None:
        def paths(p: PageSnap) -> list[str]:
            return sorted({path_of(h) for h in p.links} - nav_paths - {p.path})

        b, a = paths(self.base), paths(self.target)
        for path in sorted(set(b) - set(a)):
            name = base_names.get(path, path)
            self.add(
                K.element_removed, S.structural, {"kind": "link", "role": "link", "name": name, "href": path}, None
            )
        for path in sorted(set(a) - set(b)):
            name = target_names.get(path, path)
            self.add(K.element_added, S.structural, None, {"kind": "link", "role": "link", "name": name, "href": path})

    def forms(self) -> None:
        base, target = list(self.base.forms), list(self.target.forms)
        pairs = _pair(base, target, lambda f: (_form_key(f), form_label(f)))
        pairs += _pair(base, target, _form_key)
        pairs += _pair(base, target, form_label)
        for b, a in pairs:
            self._form(b, a)
        for f in base:
            self.add(K.form_removed, S.structural, form_shown(f), None)
        for f in target:
            self.add(K.form_added, S.structural, None, form_shown(f))

    def _form(self, b: dict[str, Any], a: dict[str, Any]) -> None:
        label = form_label(a)
        bs, as_ = b.get("submit_label"), a.get("submit_label")
        if bs != as_ and (str(bs or ""), str(as_ or "")) not in self.renamed:
            if bs and as_ and values_only(str(bs), str(as_)):
                self.values.append((str(bs), str(as_)))
            else:
                self.add(K.form_changed, S.behavioural, {"form": label, "submit_label": bs},
                         {"form": label, "submit_label": as_, "changed": ["submit_label"]})  # fmt: skip
        bf, af = list(b.get("fields") or []), list(a.get("fields") or [])
        for x, y in _pair(bf, af, _field_key):
            before, after = field_shown(x, label), field_shown(y, label)
            changed = [k for k in ("label", "type", "required", "constraints", "options") if before[k] != after[k]]
            if not changed:
                continue
            if changed == ["label"]:
                if values_only(str(before["label"]), str(after["label"])):
                    self.values.append((str(before["label"]), str(after["label"])))
                    continue
                significance = S.behavioural
            else:
                significance = S.structural if _STRUCTURAL_FIELD_ATTRS & set(changed) else S.behavioural
            self.add(K.field_changed, significance, before, {**after, "changed": changed})
        for x in bf:
            self.add(K.field_removed, S.structural, field_shown(x, label), None)
        for y in af:
            self.add(K.field_added, S.structural, None, field_shown(y, label))

    def page(self) -> None:
        b, a = self.base, self.target
        if b.http_status is not None and a.http_status is not None and b.http_status != a.http_status:
            self.add(K.page_changed, S.structural, {"http_status": b.http_status}, {"http_status": a.http_status})
        bh, ah = [str(x) for x in b.headings], [str(x) for x in a.headings]
        if bh != ah:
            if len(bh) == len(ah) and all(x == y or values_only(x, y) for x, y in zip(bh, ah, strict=True)):
                self.values += [(x, y) for x, y in zip(bh, ah, strict=True) if x != y]
            else:
                self.add(K.page_changed, S.cosmetic, {"headings": bh}, {"headings": ah})
        # A submit button and its form's submit label are one thing on the page: list each value pair once.
        self.values = list(dict.fromkeys(self.values))
        if self.values:
            self.add(
                K.page_changed,
                S.cosmetic,
                {"group": CONTENT_VALUES, "values": [x for x, _ in self.values]},
                {"group": CONTENT_VALUES, "values": [y for _, y in self.values]},
            )


# ---------------------------------------------------------------- forms


def _form_key(f: dict[str, Any]) -> tuple[str, str]:
    return (path_of(str(f.get("action") or "")), str(f.get("method") or "GET").upper())


def _field_key(x: dict[str, Any]) -> str:
    return str(x.get("name") or x.get("label") or "")


def form_label(f: dict[str, Any]) -> str:
    purpose = f.get("purpose_guess")
    if purpose in FORM_NAMES:
        return FORM_NAMES[str(purpose)]
    fields = f.get("fields") or []
    if len(fields) == 1 and fields[0].get("label"):
        return str(fields[0]["label"])
    return str(f.get("name") or f.get("submit_label") or "Form")


def form_shown(f: dict[str, Any]) -> dict[str, Any]:
    action, method = _form_key(f)
    return {
        "form": form_label(f),
        "action": action,
        "method": method,
        "fields": [str(x.get("label") or x.get("name") or "") for x in f.get("fields") or []],
        "submit_label": f.get("submit_label"),
    }


def field_shown(x: dict[str, Any], form: str) -> dict[str, Any]:
    raw = x.get("constraints") or {}
    return {
        "form": form,
        "name": x.get("name") or "",
        "label": x.get("label") or x.get("name") or "",
        "type": x.get("type") or "text",
        "required": bool(x.get("required")),
        "constraints": {k: raw[k] for k in CONSTRAINTS if raw.get(k) not in (None, "")},
        "options": list(x.get("options") or []) or None,
    }


# ---------------------------------------------------------------- navigation and journeys


def _nav(scan: ScanSnap) -> dict[str, str]:
    out: dict[str, str] = {}
    for p in scan.pages:
        for link in p.nav_links:
            href, text = link.get("href"), str(link.get("text") or "").strip()
            if href and text:
                out.setdefault(path_of(str(href)), text)
    return out


def _navigation(base: ScanSnap, target: ScanSnap) -> Change | None:
    b, a = _nav(base), _nav(target)
    added = [{"text": a[h], "href": h} for h in sorted(set(a) - set(b))]
    removed = [{"text": b[h], "href": h} for h in sorted(set(b) - set(a))]
    renamed = [{"before": b[h], "after": a[h], "href": h} for h in sorted(set(a) & set(b)) if a[h] != b[h]]
    if not (added or removed or renamed):
        return None
    links = [{"text": t, "href": h} for h, t in b.items()]
    after = {"links": [{"text": t, "href": h} for h, t in a.items()], "added": added, "removed": removed,
             "renamed": renamed}  # fmt: skip
    return Change(K.navigation_changed, S.behavioural, None, {"links": links}, after)


def _signature(j: JourneySnap) -> list[tuple[str, str]]:
    return [
        (normalise_path(path_of(s.url)) if s.url else "", "navigate" if s.label == "observed" else s.action)
        for s in j.steps
    ]


def _journey_shown(j: JourneySnap) -> dict[str, Any]:
    return {"name": j.name, "steps": [s.action for s in j.steps]}


def _journeys(base: ScanSnap, target: ScanSnap, not_compared: set[str]) -> list[Change]:
    b = {(j.name, j.start): j for j in base.journeys}
    a = {(j.name, j.start): j for j in target.journeys}
    out: list[Change] = []

    def reached(j: JourneySnap) -> bool:
        return not any(s.url and path_of(s.url) in not_compared for s in j.steps)

    for k in sorted(set(b) & set(a)):
        # A journey through a page one scan never reached can't be compared (OQ2).
        if _signature(b[k]) != _signature(a[k]) and reached(b[k]) and reached(a[k]):
            url = a[k].steps[0].url if a[k].steps else None
            out.append(Change(K.journey_changed, S.behavioural, url, _journey_shown(b[k]), _journey_shown(a[k])))
    for k in sorted(set(b) - set(a)):
        if reached(b[k]):
            url = b[k].steps[0].url if b[k].steps else None
            out.append(Change(K.journey_removed, S.behavioural, url, _journey_shown(b[k]), None))
    for k in sorted(set(a) - set(b)):
        if reached(a[k]):
            url = a[k].steps[0].url if a[k].steps else None
            out.append(Change(K.journey_added, S.behavioural, url, None, _journey_shown(a[k])))
    return out


# ---------------------------------------------------------------- the diff


def _compared(pages: Iterable[PageSnap]) -> dict[tuple[str, str], PageSnap]:
    """Pages discovery reached (visited, or answered with an error status); blocked URLs were never loaded."""
    out: dict[tuple[str, str], PageSnap] = {}
    for p in pages:
        if p.status != "blocked":
            out.setdefault(p.key, p)
    return out


def _stopped(scan: ScanSnap) -> str:
    return {"cancelled": "was cancelled", "failed": "failed"}.get(scan.status, "stopped early")


def diff_scans(base: ScanSnap, target: ScanSnap, *, used_selectors: Iterable[str] = ()) -> DiffResult:
    """Every difference between `base` (the earlier scan) and `target`, with its significance (D26)."""
    used = frozenset(used_selectors)
    bp, tp = _compared(base.pages), _compared(target.pages)
    nav_paths = set(_nav(base)) | set(_nav(target))
    base_names = {p.path: p.name for p in bp.values()}
    target_names = {p.path: p.name for p in tp.values()}
    items: list[Change] = []
    not_compared: list[dict[str, Any]] = []
    removed_pages = 0
    # Pages a scan listed but didn't load (blocked) were not compared either.
    base_blocked = {p.key for p in base.pages if p.status == "blocked"}
    target_blocked = {p.key for p in target.pages if p.status == "blocked"}
    for key in sorted(set(bp) - set(tp), key=lambda k: bp[k].path):
        p = bp[key]
        if key in target_blocked:
            not_compared.append({"page": p.path, "url": p.url, "missing_from": "target",
                                 "reason": f"Scan {target.number} didn't load this page (blocked)"})  # fmt: skip
            continue
        if target.partial:
            not_compared.append({"page": p.path, "url": p.url, "missing_from": "target",
                                 "reason": f"Scan {target.number} {_stopped(target)} and didn't reach this page"})  # fmt: skip
            continue
        removed_pages += 1
        before = {"title": p.name, "http_status": p.http_status}
        items.append(Change(K.page_removed, S.structural, p.url, before, None, page_ref(p), None))
        for f in p.forms:
            items.append(Change(K.form_removed, S.structural, p.url, form_shown(f), None, page_ref(p), None))
    for key in sorted(set(tp) - set(bp), key=lambda k: tp[k].path):
        p = tp[key]
        if key in base_blocked:
            not_compared.append({"page": p.path, "url": p.url, "missing_from": "base",
                                 "reason": f"Scan {base.number} didn't load this page (blocked)"})  # fmt: skip
            continue
        if base.partial:
            not_compared.append({"page": p.path, "url": p.url, "missing_from": "base",
                                 "reason": f"Scan {base.number} {_stopped(base)} and didn't reach this page"})  # fmt: skip
            continue
        after = {"title": p.name, "http_status": p.http_status}
        items.append(Change(K.page_added, S.structural, p.url, None, after, None, page_ref(p)))
        for f in p.forms:
            items.append(Change(K.form_added, S.structural, p.url, None, form_shown(f), None, page_ref(p)))
    changed_pages: set[str] = set()
    structural_pages = 0
    for key in sorted(set(bp) & set(tp), key=lambda k: tp[k].path):
        d = _PageDiff(bp[key], tp[key])
        d.components(used)
        d.links(nav_paths, base_names, target_names)
        d.forms()
        d.page()
        if d.items:
            changed_pages.add(tp[key].path)
            items += d.items
            structural_pages += any(i.significance == S.structural for i in d.items)
    nav = _navigation(base, target)
    if nav is not None:
        items.append(nav)
    items += _journeys(base, target, {n["page"] for n in not_compared})
    items.sort(key=lambda i: (KIND_ORDER.index(i.kind), path_of(i.page_url) if i.page_url else "", describe(i)))
    baseline_compared = len(bp) - sum(1 for n in not_compared if n["missing_from"] == "target")
    rebaseline = baseline_compared > 0 and (removed_pages + structural_pages) > REBASELINE_SHARE * baseline_compared
    summary = summarise(items)
    summary["pages"] = {
        "baseline": len(bp),
        "target": len(tp),
        "added": sum(1 for i in items if i.kind == K.page_added),
        "removed": removed_pages,
        "changed": len(changed_pages),
        "not_compared": len(not_compared),
        "structural": structural_pages,
        "baseline_compared": baseline_compared,
    }
    summary["not_compared"] = not_compared
    return DiffResult(items, not_compared, rebaseline, summary)


def summarise(items: Iterable[Change]) -> dict[str, Any]:
    """Counts by kind and significance; "Content values changed" groups are counted apart as well."""
    rows = list(items)
    return {
        "total": len(rows),
        "by_significance": {s.value: sum(1 for i in rows if i.significance == s) for s in SIGNIFICANCES},
        "by_kind": dict(sorted(Counter(i.kind.value for i in rows).items())),
        "content_values": sum(1 for i in rows if is_content_values(i)),
    }


# ---------------------------------------------------------------- requirements (appended after a regeneration)


def requirement_changes(diff: dict[str, Any], titles: dict[str, str]) -> list[Change]:
    """`requirement_changed` items from an applied requirements regeneration's version diff (P2-00)."""
    out: list[Change] = []
    for change, keys, significance in (
        ("added", diff.get("added") or [], S.structural),
        ("changed", diff.get("changed") or [], S.behavioural),
        ("removed", diff.get("rejected_as_no_longer_found") or [], S.structural),
    ):
        for key in sorted({str(k) for k in keys if str(k).startswith("REQ-")}):
            shown = {"key": key, "title": titles.get(key, ""), "change": change}
            out.append(
                Change(
                    K.requirement_changed,
                    significance,
                    None,
                    None if change == "added" else shown,
                    None if change == "removed" else shown,
                )
            )
    return out


# ---------------------------------------------------------------- plain-words subjects (design P6 §3.1)


def _element(x: dict[str, Any]) -> str:
    return ELEMENT_NAMES.get(str(x.get("kind")), "Control")


def _field_detail(b: dict[str, Any], a: dict[str, Any]) -> str:
    bits = []
    if b.get("required") != a.get("required"):
        bits.append("now required" if a.get("required") else "now optional")
    if b.get("type") != a.get("type"):
        bits.append(f"type {b.get('type')} → {a.get('type')}")
    if b.get("constraints") != a.get("constraints"):
        bits.append("allowed values changed")
    if b.get("options") != a.get("options"):
        bits.append("options changed")
    return f" ({', '.join(bits)})" if bits else ""


def describe(c: Change) -> str:
    """The item written out for people: "Page added: /offers", "Button renamed: Send message → Send"."""
    b, a = c.before or {}, c.after or {}
    page = path_of(c.page_url) if c.page_url else ""
    k = c.kind
    if k == K.page_added:
        return f"Page added: {page}"
    if k == K.page_removed:
        return f"Page removed: {page}"
    if k == K.page_changed:
        if is_content_values(c):
            n = len(a.get("values") or [])
            return f"Content values changed on {page} ({n})"
        if "http_status" in a:
            return f"Page changed: {page} now answers {a['http_status']} (was {b.get('http_status')})"
        before, after = (b.get("headings") or ["(none)"])[0], (a.get("headings") or ["(none)"])[0]
        return f"Headings changed on {page}: {before} → {after}"
    if k in (K.element_added, K.element_removed):
        x = a if k == K.element_added else b
        return f"{_element(x)} {'added' if k == K.element_added else 'removed'}: {x.get('name')}"
    if k == K.element_renamed:
        return f"{_element(b)} renamed: {b.get('name')} → {a.get('name')}"
    if k == K.element_moved:
        return f"{_element(b)} moved: {b.get('name')}"
    if k == K.form_added:
        return f"Form added: {a.get('form')}"
    if k == K.form_removed:
        return f"Form removed: {b.get('form')}"
    if k == K.form_changed:
        return f"Form changed: {a.get('form')} (submit button {b.get('submit_label')} → {a.get('submit_label')})"
    if k == K.field_added:
        return f"Field added: {a.get('label')}"
    if k == K.field_removed:
        return f"Field removed: {b.get('label')}"
    if k == K.field_changed:
        label = f"{b.get('label')} → {a.get('label')}" if b.get("label") != a.get("label") else str(a.get("label"))
        return f"Field changed: {label}{_field_detail(b, a)}"
    if k == K.navigation_changed:
        parts = [f"'{x['text']}' added" for x in a.get("added") or []]
        parts += [f"'{x['text']}' removed" for x in a.get("removed") or []]
        parts += [f"'{x['before']}' renamed '{x['after']}'" for x in a.get("renamed") or []]
        return f"Navigation changed: {', '.join(parts)}"
    if k in (K.journey_added, K.journey_removed, K.journey_changed):
        word = {K.journey_added: "added", K.journey_removed: "removed", K.journey_changed: "changed"}[k]
        return f"Journey {word}: {(a or b).get('name')}"
    x = a or b
    return f"Requirement {x.get('change')}: {x.get('key')}{(' ' + str(x['title'])) if x.get('title') else ''}"
