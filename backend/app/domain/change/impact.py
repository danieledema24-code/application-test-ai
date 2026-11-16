"""Change impact and regression selection (P6-02, decisions D27, D28). Pure functions over a change set and the
project's traceability (page → feature → requirement → approved case → script); no I/O and no AI.

Impact (one item per affected artefact, each with a reason in words):
- a case is **direct** when a changed element or field is one its steps name or its script's page-object locators
  find (same page); otherwise it is **indirect** when it opens a changed page or tests an impacted requirement;
- a requirement is impacted when one of its features is on a changed or removed page (navigation features also by a
  navigation change); it is direct when one of its cases is. Its action is `regenerate`, or `review` when every page
  of its features was removed;
- cases that open a removed page, findings on removed or changed pages and performance targets on removed pages are
  `review` items ("Page removed: …");
- open defects (confirmed at G8, not yet verified) whose steps or linked cases are on a changed or removed page are
  `rerun` items when a linked approved case re-tests them, else `review`;
- added pages and added forms are `gap` items (`write_requirement`: "Not covered by any requirement");
- `heal` items come from the live locator re-check (`heal_items`).
Cosmetic changes (headings, values, moves no locator uses) affect nothing: by definition no test depends on them.

Regression (D28): must run = approved cases with direct impact and the cases that re-test open defects on changed
pages; should run = indirectly impacted cases, cases linked to open high or very-high risks on affected features, and
smoke cases; excluded = cases on removed pages ("review or retire"). Which must-run and should-run tests can run as
automated tests is decided on read from the scripts' current state (`overlay`): a must-run test is never dropped.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

from app.domain.enums import ChangeKind as K
from app.domain.enums import ChangeSignificance as S
from app.domain.enums import ImpactAction as A
from app.domain.enums import ImpactLevel as L
from app.domain.enums import ImpactTargetKind as T

HIGH_RISK = frozenset({"high", "very_high"})
OPEN_RISK = "open"
# Defects a person confirmed at G8 that aren't verified yet (traceability `OPEN_DEFECT`): drafts are hypotheses.
OPEN_DEFECT = frozenset({"confirmed", "fixed"})
_OPEN_STEP = re.compile(r"\bOpen (/[^\s,;)]*)")
_PATH_IN_TEXT = re.compile(r"(?<![\w.])(/[A-Za-z0-9._~\-/]*)")

# Fixed reason texts (design P6 §7.1, §7.4).
REMOVED_CASE = "Page removed: review or retire the case"
MANUAL = "Manual test: a person runs it"
SMOKE = "Smoke test"
OUTDATED_SHOULD = "Script outdated: accept or reject the repair suggestion first"
NOT_RUNNABLE = {
    "invalid": "Script can't run: it failed its checks",
    "not_checked": "Script not checked yet",
    "needs_review": "Script needs review (Gate 6)",
    "rejected": "Script rejected in review",
}


# ---------------------------------------------------------------- inputs


@dataclass(frozen=True)
class ChangeIn:
    id: str
    kind: K
    significance: S
    page: str | None  # path ("/contact"); None for navigation and requirement changes
    before: dict[str, Any] | None
    after: dict[str, Any] | None
    subject: str = ""


@dataclass(frozen=True)
class FeatureIn:
    id: str
    key: str
    name: str
    category: str
    pages: frozenset[str]


@dataclass(frozen=True)
class RequirementIn:
    lineage: str
    key: str
    title: str
    feature_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class LocatorIn:
    """One page-object getter a script uses (the bundle's `locators` spec plus its page)."""

    file: str
    getter: str
    page: str
    by: str
    name: str = ""
    role: str = ""
    element: str = ""
    css: str = ""
    within: str = ""
    exact: bool = False

    @property
    def ref(self) -> str:
        return f"{self.file}#{self.getter}"


@dataclass(frozen=True)
class ScriptIn:
    lineage: str  # the case lineage (script lineage = case lineage)
    id: str
    path: str
    state: str  # valid | invalid | not_checked | outdated | needs_review | rejected (automation.script_state)
    locators: tuple[LocatorIn, ...] = ()
    outdated_reason: str | None = None


@dataclass(frozen=True)
class CaseIn:
    lineage: str
    key: str
    title: str
    requirement_lineages: tuple[str, ...] = ()
    steps: tuple[str, ...] = ()  # action and expected texts
    test_type: str = "functional"
    suites: tuple[str, ...] = ()
    risk_lineage: str | None = None
    test_case_id: str = ""

    @property
    def opened(self) -> frozenset[str]:
        """The pages the case's steps open ("Open /contact")."""
        return frozenset(m.group(1) for st in self.steps for m in _OPEN_STEP.finditer(st))

    @property
    def smoke(self) -> bool:
        return self.test_type == "smoke" or "smoke" in self.suites


@dataclass(frozen=True)
class DefectIn:
    id: str
    key: str
    summary: str
    severity: str
    status: str
    case_lineages: tuple[str, ...] = ()
    steps: tuple[str, ...] = ()


@dataclass(frozen=True)
class FindingIn:
    id: str
    key: str
    title: str
    kind: str
    severity: str
    page: str


@dataclass(frozen=True)
class PerfTargetIn:
    profile_id: str
    profile_key: str
    name: str
    path: str


@dataclass(frozen=True)
class RiskIn:
    lineage: str
    key: str
    title: str
    level: str
    status: str
    requirement_lineages: tuple[str, ...] = ()
    feature_ids: tuple[str, ...] = ()


@dataclass
class Model:
    """What the change can affect: the approved work of the project as it is now."""

    features: dict[str, FeatureIn] = field(default_factory=dict)  # feature id -> feature
    requirements: list[RequirementIn] = field(default_factory=list)  # approved requirements
    cases: list[CaseIn] = field(default_factory=list)  # cases of the last G5 approval, at their approved versions
    scripts: dict[str, ScriptIn] = field(default_factory=dict)  # case lineage -> script of the current bundle
    defects: list[DefectIn] = field(default_factory=list)
    findings: list[FindingIn] = field(default_factory=list)  # open findings of the latest checks
    perf_targets: list[PerfTargetIn] = field(default_factory=list)
    risks: list[RiskIn] = field(default_factory=list)

    def case_pages(self, c: CaseIn) -> frozenset[str]:
        """The pages a case works on: those its steps open and its script's locators are on; else its requirements'
        feature pages."""
        pages = set(c.opened)
        script = self.scripts.get(c.lineage)
        if script is not None:
            pages |= {loc.page for loc in script.locators}
        if pages:
            return frozenset(pages)
        by_lineage = {r.lineage: r for r in self.requirements}
        for lin in c.requirement_lineages:
            req = by_lineage.get(lin)
            for fid in req.feature_ids if req else ():
                f = self.features.get(fid)
                if f is not None:
                    pages |= f.pages
        return frozenset(pages)


# ---------------------------------------------------------------- outputs


@dataclass
class Impact:
    target_kind: T
    target_ref: str
    level: L
    action: A
    reason: str
    change_ids: list[str] = field(default_factory=list)


@dataclass
class Pick:
    """One test of the recommendation and why it is there."""

    case_lineage_id: str
    key: str
    title: str
    reasons: list[str]

    def as_dict(self) -> dict[str, Any]:
        return {"case_lineage_id": self.case_lineage_id, "key": self.key, "title": self.title,
                "reasons": list(self.reasons)}  # fmt: skip


@dataclass
class Recommendation:
    must: list[Pick]
    should: list[Pick]
    excluded: list[Pick]

    def as_dict(self) -> dict[str, Any]:
        return {
            "must": [p.as_dict() for p in self.must],
            "should": [p.as_dict() for p in self.should],
            "excluded": [p.as_dict() for p in self.excluded],
        }


# ---------------------------------------------------------------- helpers


def quote(text: str) -> str:
    return "'" + text.replace("\\", "\\\\").replace("'", "\\'") + "'"


def expression(loc: LocatorIn) -> str:
    """How a script finds the element, as people read it: `getByLabel('Message')`,
    `getByRole('button', { name: 'Send message' })` (design P6 §3.4; the page object writes `this.page.` first)."""
    if loc.by == "label":
        return f"getByLabel({quote(loc.name)})"
    if loc.by == "placeholder":
        return f"getByPlaceholder({quote(loc.name)})"
    if loc.by in ("role", "form_role"):
        role = "form" if loc.by == "form_role" else (loc.role or "button")
        exact = ", exact: true" if loc.exact else ""
        scope = "getByRole('navigation')." if loc.within == "navigation" else ""
        return f"{scope}getByRole({quote(role)}, {{ name: {quote(loc.name)}{exact} }})"
    if loc.by == "form_button":
        return f"locator('form').filter({{ has: getByRole('button', {{ name: {quote(loc.name)} }}) }})"
    return f"locator({quote(loc.css or 'body')})"


def _norm(text: Any) -> str:
    return " ".join(str(text or "").split()).casefold()


ELEMENT_WORDS = {"button": "button", "link": "link", "search": "search box", "filter": "filter",
                 "dropdown": "dropdown", "modal": "dialog", "tabs": "tabs", "accordion": "expandable section",
                 "menu": "menu", "table": "table", "pagination": "pagination"}  # fmt: skip


def phrase(c: ChangeIn) -> str:
    """The change in a few words, for reasons: 'field "Message" changed', 'button "Send message" renamed'."""
    b, a = c.before or {}, c.after or {}
    k = c.kind
    if k == K.field_changed:
        return f'field "{b.get("label") or b.get("name")}" changed'
    if k == K.field_removed:
        return f'field "{b.get("label") or b.get("name")}" removed'
    if k == K.field_added:
        return f'field "{a.get("label") or a.get("name")}" added'
    if k in (K.element_renamed, K.element_removed, K.element_moved, K.element_added):
        x = a if k == K.element_added else b
        word = {K.element_renamed: "renamed", K.element_removed: "removed", K.element_moved: "moved",
                K.element_added: "added"}[k]  # fmt: skip
        return f'{ELEMENT_WORDS.get(str(x.get("kind")), "control")} "{x.get("name")}" {word}'
    if k == K.form_changed:
        return f'submit button "{b.get("submit_label")}" renamed'
    if k == K.form_removed:
        return f'form "{b.get("form")}" removed'
    if k == K.form_added:
        return f'form "{a.get("form")}" added'
    if k == K.page_removed:
        return f"page {c.page} removed"
    if k == K.page_added:
        return f"page {c.page} added"
    if k == K.page_changed:
        if "http_status" in a:
            return f"{c.page} now answers {a['http_status']}"
        return f"headings changed on {c.page}"
    if k == K.navigation_changed:
        return "navigation changed"
    if k in (K.journey_added, K.journey_removed, K.journey_changed):
        return f'journey "{(a or b).get("name")}" changed'
    return c.subject or k.value


def used_names(c: ChangeIn) -> set[str]:
    """Names a test step or a locator would use to find what the change touched (as it was before)."""
    b = c.before or {}
    k = c.kind
    names: set[str] = set()
    if k in (K.field_changed, K.field_removed):
        names |= {str(b.get("label") or ""), str(b.get("name") or "")}
    elif k in (K.element_renamed, K.element_removed) or (k == K.element_moved and c.significance != S.cosmetic):
        names.add(str(b.get("name") or ""))
    elif k == K.form_changed:
        names.add(str(b.get("submit_label") or ""))
    elif k == K.form_removed:
        names |= {str(b.get("submit_label") or ""), *[str(x) for x in b.get("fields") or []]}
    elif k == K.navigation_changed:
        a = c.after or {}
        names |= {str(x.get("text") or "") for x in a.get("removed") or []}
        names |= {str(x.get("before") or "") for x in a.get("renamed") or []}
    return {n for n in names if n.strip()}


def step_names(c: ChangeIn) -> set[str]:
    """Names a test step would use: what a person reads on the page. A field is referred to by its label (accessible
    name); its HTML `name` ("message") is only a fallback when the field has no label, never a free word in a step."""
    b = c.before or {}
    if c.kind in (K.field_changed, K.field_removed) and str(b.get("label") or "").strip():
        return {str(b["label"])}
    return used_names(c)


def _mentions(text: str, name: str) -> bool:
    """A step names an element: the whole name, case as written ("Message" is not "Send message")."""
    return re.search(rf"(?<![\w]){re.escape(name)}(?![\w])", text) is not None


def _is_removed_like(c: ChangeIn) -> bool:
    return c.kind == K.page_removed or (
        c.kind == K.page_changed and int((c.after or {}).get("http_status") or 0) >= 400
    )


@dataclass
class AffectedPages:
    removed: dict[str, list[ChangeIn]]
    changed: dict[str, list[ChangeIn]]  # existing pages with non-cosmetic changes (removed pages excluded)
    navigation: list[ChangeIn]

    @property
    def touched(self) -> set[str]:
        return set(self.removed) | set(self.changed)


def affected_pages(changes: Sequence[ChangeIn]) -> AffectedPages:
    """Removed pages, existing pages with a non-cosmetic change, and navigation changes."""
    removed: dict[str, list[ChangeIn]] = {}
    changed: dict[str, list[ChangeIn]] = {}
    added = {c.page for c in changes if c.kind == K.page_added and c.page}
    nav: list[ChangeIn] = []
    for c in changes:
        if c.significance == S.cosmetic or c.kind == K.requirement_changed:
            continue
        if c.kind == K.navigation_changed:
            nav.append(c)
            continue
        if not c.page or c.page in added or c.kind in (K.journey_added, K.journey_removed, K.journey_changed):
            continue
        if _is_removed_like(c):
            removed.setdefault(c.page, []).append(c)
    for c in changes:
        if c.significance == S.cosmetic or not c.page or c.page in added or c.page in removed:
            continue
        if c.kind in (K.navigation_changed, K.requirement_changed, K.journey_added, K.journey_removed,
                      K.journey_changed, K.page_added):  # fmt: skip
            continue
        changed.setdefault(c.page, []).append(c)
    return AffectedPages(removed, changed, nav)


def _direct_changes(case: CaseIn, model: Model, pages: AffectedPages) -> list[ChangeIn]:
    """Changes a step of the case or a locator of its script uses."""
    script = model.scripts.get(case.lineage)
    case_pages = model.case_pages(case)
    out: list[ChangeIn] = []
    candidates = [c for page, cs in pages.changed.items() for c in cs] + pages.navigation
    for c in candidates:
        names = used_names(c)
        if not names:
            continue
        hit = False
        if script is not None:
            for loc in script.locators:
                on_page = loc.page == c.page if c.page else loc.within == "navigation" or loc.role == "link"
                if on_page and {_norm(loc.name), _norm(loc.element)} & {_norm(n) for n in names}:
                    hit = True
                    break
        if not hit and (c.page is None or c.page in case_pages):
            hit = any(_mentions(st, n) for st in case.steps for n in step_names(c))
        if hit:
            out.append(c)
    return out


def _join(parts: Iterable[str]) -> str:
    seen = list(dict.fromkeys(p for p in parts if p))
    return "; ".join(seen)


# ---------------------------------------------------------------- impact


@dataclass
class Analysis:
    """Every impact item, plus what the regression recommendation needs."""

    items: list[Impact]
    direct_cases: dict[str, list[ChangeIn]]  # case lineage -> changes it uses
    indirect_cases: dict[str, list[str]]  # case lineage -> reasons
    removed_cases: dict[str, str]  # case lineage -> removed page
    defect_cases: dict[str, list[str]]  # case lineage -> keys of open defects it re-tests
    affected_features: set[str]
    impacted_requirements: set[str]
    touched_pages: set[str]


def analyse(changes: Sequence[ChangeIn], model: Model, *, set_key: str) -> Analysis:
    """The impact items of a change set (rule path; with AI on the model adds nothing here)."""
    pages = affected_pages(changes)
    touched = pages.touched
    items: list[Impact] = []

    # Features and requirements on changed or removed pages (navigation features by a navigation change).
    affected_features = {
        fid
        for fid, f in model.features.items()
        if f.pages & touched or (pages.navigation and f.category == "navigation")
    }
    req_changes: dict[str, list[ChangeIn]] = {}
    for r in model.requirements:
        cs: list[ChangeIn] = []
        for fid in r.feature_ids:
            f = model.features.get(fid)
            if f is None or fid not in affected_features:
                continue
            for p in sorted(f.pages):
                cs += pages.removed.get(p, []) + pages.changed.get(p, [])
            if f.category == "navigation":
                cs += pages.navigation
        if cs or fid_all_removed(r, model, pages):
            req_changes[r.lineage] = list({c.id: c for c in cs}.values())

    # Cases.
    direct_cases: dict[str, list[ChangeIn]] = {}
    indirect_cases: dict[str, list[str]] = {}
    removed_cases: dict[str, str] = {}
    for c in model.cases:
        cp = model.case_pages(c)
        gone = sorted(cp & set(pages.removed))
        if gone and (c.opened & set(pages.removed) or not c.opened):
            removed_cases[c.lineage] = gone[0]
            continue
        used = _direct_changes(c, model, pages)
        if used:
            direct_cases[c.lineage] = used
            continue
        why: list[str] = []
        on_changed = sorted(cp & set(pages.changed))
        if on_changed:
            why.append(f"Indirectly affected: {_join(phrase(x) for p in on_changed for x in pages.changed[p][:2])}")
        linked = [r for r in c.requirement_lineages if r in req_changes]
        if linked and not why:
            changed_here = [x for r in linked for x in req_changes[r]]
            why.append(
                f"Indirectly affected: {_join(phrase(x) for x in changed_here[:3]) or 'its requirement changed'}"
            )
        if why:
            indirect_cases[c.lineage] = why

    # Requirements: direct when one of their cases is.
    impacted_requirements: set[str] = set()
    case_by_lineage = {c.lineage: c for c in model.cases}
    for r in sorted(model.requirements, key=lambda x: x.key):
        if r.lineage not in req_changes:
            continue
        impacted_requirements.add(r.lineage)
        cs = req_changes[r.lineage]
        mine = [c for c in model.cases if r.lineage in c.requirement_lineages]
        direct = [x for c in mine for x in direct_cases.get(c.lineage, [])]
        removed_only = fid_all_removed(r, model, pages)
        if removed_only:
            gone = sorted({p for fid in r.feature_ids for p in (model.features[fid].pages
                                                                 if fid in model.features else ())})  # fmt: skip
            items.append(Impact(T.requirement, r.lineage, L.indirect, A.review,
                                f"Page removed: {', '.join(gone)}. Review whether {r.key} still applies",
                                [x.id for x in cs]))  # fmt: skip
            continue
        level = L.direct if direct else L.indirect
        # Every change on its pages counts; the ones that hit its tests are named first.
        shown = list({x.id: x for x in [*direct, *cs]}.values())
        pages_of = sorted({x.page for x in shown if x.page})
        where = f" on {', '.join(pages_of)}" if pages_of else ""
        n = len({x.id for x in shown})
        reason = f"{n} change{'s' if n != 1 else ''}{where}: {_join(phrase(x) for x in shown[:4])}"
        items.append(Impact(T.requirement, r.lineage, level, A.regenerate, reason, [x.id for x in cs]))

    # Defects to re-test.
    defect_cases: dict[str, list[str]] = {}
    for d in sorted(model.defects, key=lambda x: x.key):
        if d.status not in OPEN_DEFECT:
            continue
        linked_cases = [case_by_lineage[x] for x in d.case_lineages if x in case_by_lineage]
        dpages: set[str] = {m.group(1) for st in d.steps for m in _OPEN_STEP.finditer(st)}
        for lc in linked_cases:
            dpages |= model.case_pages(lc)
        hit = sorted(dpages & touched)
        if not hit:
            continue
        ids = [x.id for p in hit for x in pages.removed.get(p, []) + pages.changed.get(p, [])]
        runnable = [rc for rc in linked_cases if rc.lineage not in removed_cases]
        if runnable:
            for rc in runnable:
                defect_cases.setdefault(rc.lineage, []).append(d.key)
            level = L.direct if any(rc.lineage in direct_cases for rc in runnable) else L.indirect
            keys = ", ".join(rc.key for rc in sorted(runnable, key=lambda x: x.key))
            items.append(Impact(T.defect, d.id, level, A.rerun,
                                f"May be fixed or changed by {set_key}: re-test. Re-tested by {keys}.", ids))  # fmt: skip
        else:
            items.append(Impact(T.defect, d.id, L.indirect, A.review,
                                f"May be fixed or changed by {set_key}: check it again on {', '.join(hit)}.", ids))  # fmt: skip

    # Case items.
    for c in sorted(model.cases, key=lambda x: x.key):
        if c.lineage in removed_cases:
            page = removed_cases[c.lineage]
            ids = [x.id for x in pages.removed.get(page, [])]
            items.append(Impact(T.test_case, c.lineage, L.indirect, A.review,
                                f"Page removed: {page}. Review or retire {c.key}", ids))  # fmt: skip
        elif c.lineage in direct_cases:
            used = direct_cases[c.lineage]
            reason = f"Directly affected: {_join(phrase(x) for x in used)}"
            items.append(Impact(T.test_case, c.lineage, L.direct, A.rerun, reason, [x.id for x in used]))
        elif c.lineage in indirect_cases:
            ids = [x.id for p in model.case_pages(c) for x in pages.changed.get(p, [])]
            ids += [x.id for r in c.requirement_lineages for x in req_changes.get(r, [])]
            items.append(Impact(T.test_case, c.lineage, L.indirect, A.rerun, indirect_cases[c.lineage][0],
                                list(dict.fromkeys(ids))))  # fmt: skip

    # Findings and performance targets.
    for fnd in sorted(model.findings, key=lambda x: x.key):
        if fnd.page in pages.removed:
            ids = [x.id for x in pages.removed[fnd.page]]
            items.append(Impact(T.quality_finding, fnd.id, L.indirect, A.review,
                                f"Page removed: {fnd.page}. The finding may no longer apply", ids))  # fmt: skip
        elif fnd.page in pages.changed:
            ids = [x.id for x in pages.changed[fnd.page]]
            items.append(Impact(T.quality_finding, fnd.id, L.indirect, A.review,
                                f"Page changed by {set_key}: check whether the finding still applies", ids))  # fmt: skip
    for t in sorted(model.perf_targets, key=lambda x: (x.profile_key, x.path)):
        if t.path in pages.removed:
            ids = [x.id for x in pages.removed[t.path]]
            items.append(Impact(T.performance_target, t.profile_id, L.indirect, A.review,
                                f"Page removed: {t.path} is a target of {t.profile_key}. The profile is marked out of "
                                "date", ids))  # fmt: skip

    # Gaps: added pages and forms nothing tests yet.
    for ch in changes:
        if ch.kind == K.page_added:
            items.append(Impact(T.coverage_gap, ch.id, L.gap, A.write_requirement,
                                f"Not covered by any requirement: page {ch.page} added", [ch.id]))  # fmt: skip
        elif ch.kind == K.form_added:
            form = (ch.after or {}).get("form") or "Form"
            items.append(Impact(T.coverage_gap, ch.id, L.gap, A.write_requirement,
                                f'Not covered by any requirement: form "{form}" added on {ch.page}', [ch.id]))  # fmt: skip

    return Analysis(items, direct_cases, indirect_cases, removed_cases, defect_cases, affected_features,
                    impacted_requirements, touched)  # fmt: skip


def fid_all_removed(r: RequirementIn, model: Model, pages: AffectedPages) -> bool:
    """Every page of the requirement's features was removed (and it has some)."""
    all_pages = {p for fid in r.feature_ids for p in (model.features[fid].pages if fid in model.features else ())}
    return bool(all_pages) and all_pages <= set(pages.removed)


# ---------------------------------------------------------------- outdated scripts (live locator re-check)


def renamed_names(changes: Sequence[ChangeIn]) -> dict[str, set[str]]:
    """Per page, the names (folded) a change took away: a locator that still finds its element only by a partial
    match ("Message" inside "Your message") relies on luck after the change."""
    out: dict[str, set[str]] = {}
    for c in changes:
        if c.significance == S.cosmetic:
            continue
        for n in used_names(c):
            out.setdefault(c.page or "", set()).add(_norm(n))
    return out


def broken_locators(
    script: ScriptIn,
    counts: dict[str, dict[str, tuple[int, int | None]]],
    renamed: dict[str, set[str]],
) -> list[LocatorIn]:
    """Locators of the script that no longer resolve to exactly one element on the live page, or that only resolve
    by a partial match to an element the change renamed. `counts[file][getter] = (count, exact count)`; locators
    that weren't checked (sign-in needed, page didn't open) are not called broken."""
    out: list[LocatorIn] = []
    for loc in script.locators:
        got = counts.get(loc.file, {}).get(loc.getter)
        if got is None:
            continue
        n, exact = got
        names = renamed.get(loc.page, set()) | (renamed.get("", set()) if loc.within == "navigation" else set())
        if n != 1 or (exact == 0 and {_norm(loc.name), _norm(loc.element)} & names):
            out.append(loc)
    return out


def outdated_reason(broken: Sequence[LocatorIn], set_key: str) -> str:
    """ "getByLabel('Message') not found after CHG-0001" (one clause per locator)."""
    return "; ".join(f"{expression(loc)} not found after {set_key}" for loc in broken)


def heal_items(broken: dict[str, list[LocatorIn]], changes: Sequence[ChangeIn], *, set_key: str) -> list[Impact]:
    """One `heal` item per outdated script; P6-04 makes the repair suggestions from it."""
    out: list[Impact] = []
    for lineage, locs in sorted(broken.items()):
        pages = {loc.page for loc in locs}
        names = {_norm(loc.name) for loc in locs} | {_norm(loc.element) for loc in locs}
        ids = [c.id for c in changes if c.page in pages and {_norm(n) for n in used_names(c)} & names]
        out.append(Impact(T.automation_script, lineage, L.direct, A.heal, outdated_reason(locs, set_key), ids))
    return out


# ---------------------------------------------------------------- regression (D28)


def recommend(model: Model, a: Analysis) -> Recommendation:
    """Must run, should run and excluded, in rule order (must: by key; should: risk first, then indirect, then
    smoke)."""
    cases = {c.lineage: c for c in model.cases}
    must: dict[str, Pick] = {}
    for lin in sorted(set(a.direct_cases) | set(a.defect_cases), key=lambda x: cases[x].key):
        c = cases[lin]
        reasons = []
        if lin in a.direct_cases:
            reasons.append(f"Directly affected: {_join(phrase(x) for x in a.direct_cases[lin])}")
        reasons += [f"Re-tests {k}" for k in a.defect_cases.get(lin, [])]
        must[lin] = Pick(lin, c.key, c.title, reasons)
    excluded = [
        Pick(lin, cases[lin].key, cases[lin].title, [REMOVED_CASE])
        for lin in sorted(a.removed_cases, key=lambda x: cases[x].key)
    ]
    skip = set(must) | set(a.removed_cases)
    should: dict[str, Pick] = {}

    def add(c: CaseIn, reason: str) -> None:
        if c.lineage in skip:
            return
        p = should.setdefault(c.lineage, Pick(c.lineage, c.key, c.title, []))
        if reason not in p.reasons:
            p.reasons.append(reason)

    risky = [
        r
        for r in sorted(model.risks, key=lambda x: (0 if x.level == "very_high" else 1, x.key))
        if r.status == OPEN_RISK
        and r.level in HIGH_RISK
        and (set(r.feature_ids) & a.affected_features or set(r.requirement_lineages) & a.impacted_requirements)
    ]
    for r in risky:
        level = "very high" if r.level == "very_high" else "high"
        for c in sorted(model.cases, key=lambda x: x.key):
            if c.risk_lineage == r.lineage or set(c.requirement_lineages) & set(r.requirement_lineages):
                add(c, f"Linked to {level} risk {r.key} ({r.title})")
    for lin in sorted(a.indirect_cases, key=lambda x: cases[x].key):
        add(cases[lin], a.indirect_cases[lin][0])
    for c in sorted(model.cases, key=lambda x: x.key):
        if c.smoke:
            add(c, SMOKE)
    return Recommendation(list(must.values()), list(should.values()), excluded)


@dataclass(frozen=True)
class ScriptState:
    """A case's automated script as it stands now (for the read-time overlay)."""

    state: str | None  # None: no script (a person runs the case)
    path: str | None = None
    outdated_reason: str | None = None


def runnable_reason(s: ScriptState | None) -> str | None:
    """None when the test can run automatically; else why not, in words."""
    if s is None or s.state is None:
        return MANUAL
    if s.state == "valid":
        return None
    if s.state == "outdated":
        return OUTDATED_SHOULD
    return NOT_RUNNABLE.get(s.state, "Script can't run yet")


def overlay(rec: dict[str, Any], scripts: dict[str, ScriptState]) -> dict[str, list[dict[str, Any]]]:
    """The stored recommendation against the scripts as they are now: must-run tests stay must-run whatever their
    script (OQ3), should-run tests that can't run automatically move to "Not included" with the reason."""
    must = [dict(p) for p in rec.get("must") or []]
    should: list[dict[str, Any]] = []
    excluded = [dict(p) for p in rec.get("excluded") or []]
    for p in rec.get("should") or []:
        why = runnable_reason(scripts.get(str(p["case_lineage_id"])))
        if why is None:
            should.append(dict(p))
        else:
            excluded.append({**p, "reasons": [why, *p.get("reasons", [])]})
    return {"must": must, "should": should, "excluded": excluded}


def estimate(lineages: Iterable[str], durations: dict[str, int], workers: int = 2) -> int | None:
    """Seconds for these tests from their last results' timings, run `workers` at a time; None when none ran."""
    wanted = list(lineages)
    known = [durations[x] for x in wanted if x in durations]
    if not wanted or not known:
        return None
    avg = sum(known) / len(known)
    total_ms = sum(known) + avg * (len(wanted) - len(known))
    return max(1, -(-int(total_ms) // (1000 * max(1, workers))))


def ai_order(rule: dict[str, Any], must_keys: Sequence[str], should_keys: Sequence[str]) -> list[str] | None:
    """The AI may reorder "should run" only. Its answer must list the must-run tests exactly as the rules did
    (none dropped, none added) and the should-run tests exactly once each; else it is rejected (None)."""
    rule_must = [str(p["key"]) for p in rule.get("must") or []]
    rule_should = [str(p["key"]) for p in rule.get("should") or []]
    if sorted(must_keys) != sorted(rule_must) or len(set(must_keys)) != len(must_keys):
        return None
    if sorted(should_keys) != sorted(rule_should) or len(set(should_keys)) != len(should_keys):
        return None
    return list(should_keys)
