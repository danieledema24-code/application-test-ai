"""Rule path of the Requirements Engineering Agent (P2-02) and acceptance criteria (P2-03).

Deterministic templates over discovery data: navigation, listings, search, every discovered form and field
constraint, sign-in, commerce controls, journeys, non-functional observations and access gaps, plus requirement-like
statements from source documents (P2-08). Every item cites the evidence it is derived from and carries a `rule_id`.
Labels set here are proposals: `app.domain.provenance` re-checks them before anything is stored.
"""

from __future__ import annotations

import re
import statistics
import uuid
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from app.domain.enums import AcKind, BehaviourScope, Provenance, RequirementSource, RequirementStatus, RequirementType

TEXT_TYPES = frozenset({"text", "email", "tel", "url", "search", "textarea", "number", "password", "date", "select"})
SUBMISSION_OUTCOME = {
    "contact": "sends the message to the company",
    "newsletter": "subscribes the email address to the newsletter",
    "registration": "creates an account",
    "checkout": "places the order",
}
PURPOSE_VERB = {
    "contact": "send a message",
    "newsletter": "subscribe to the newsletter",
    "registration": "create an account",
    "checkout": "complete a purchase",
}
NO_MORE_NEGATIVES = "No further negative criteria can be derived from the discovered constraints"
MAX_ACS_PER_REQUIREMENT = 10
MAX_REQUIREMENTS = 150


@dataclass
class AcDraft:
    kind: AcKind
    given: str
    when: str
    then: str
    classification: Provenance
    evidence_refs: list[dict[str, Any]] = field(default_factory=list)
    rule_id: str | None = None
    exercised: bool = False
    test_values: list[dict[str, str]] | None = None
    generated_by: str = "rules"

    @property
    def match_key(self) -> str:
        return f"{self.kind.value}|{normalise(self.when)}|{normalise(self.then)}"


@dataclass
class ReqDraft:
    match_key: str
    rule_id: str | None
    title: str
    description: str
    type: RequirementType
    category: str
    behaviour_scope: BehaviourScope
    classification: Provenance
    confidence: float
    evidence_refs: list[dict[str, Any]] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)
    feature_ids: list[uuid.UUID] = field(default_factory=list)
    source: RequirementSource = RequirementSource.discovery
    source_refs: dict[str, list[str]] = field(default_factory=dict)
    status: RequirementStatus = RequirementStatus.draft
    acs: list[AcDraft] = field(default_factory=list)
    generated_by: str = "rules"
    # Facts the AC generator needs (field constraints etc.); never stored.
    facts: dict[str, Any] = field(default_factory=dict)


@dataclass
class DocStatement:
    document_id: uuid.UUID
    document_key: str
    text_evidence_id: uuid.UUID
    text: str
    anchor: str
    heading: str
    page: int | None


@dataclass
class DiscoveryInput:
    scan_key: str
    scan_number: int
    start_url: str
    pages: list[Any]  # DiscoveredPage rows (visited and failed)
    features: list[Any]  # ApplicationFeature rows
    journeys: list[Any]  # UserJourney rows
    access_gaps: list[dict[str, Any]]
    auth_boundaries: list[dict[str, Any]]
    auth: dict[str, Any] | None = None  # scan_sessions.auth (P2-01)
    documents: list[DocStatement] = field(default_factory=list)


def normalise(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def _path(url: str) -> str:
    p = urlsplit(url)
    return (p.path or "/") + (f"?{p.query}" if p.query else "")


def _label(f: dict[str, Any]) -> str:
    raw = (f.get("label") or f.get("name") or f.get("placeholder") or f.get("type") or "field").strip()
    return raw[:1].upper() + raw[1:]


def _shot_ref(page: Any, note: str | None = None) -> list[dict[str, Any]]:
    if page.screenshot_evidence_id is None:
        return []
    return [{"evidence_id": str(page.screenshot_evidence_id), "note": note or f"Screenshot of {_path(page.url)}"}]


def _form_refs(form: dict[str, Any]) -> list[dict[str, Any]]:
    return [dict(r) for r in form.get("evidence_refs") or [] if r.get("evidence_id")]


def _field_refs(form: dict[str, Any], fld: dict[str, Any]) -> list[dict[str, Any]]:
    base = _form_refs(form)
    if not base:
        return []
    name = fld.get("name")
    sel = f'{form.get("selector") or "form"} [name="{name}"]' if name else (fld.get("locator") or None)
    constraints = {k: v for k, v in (fld.get("constraints") or {}).items() if v not in (None, "")}
    bits = [f'type="{fld.get("type")}"'] + (["required"] if fld.get("required") else [])
    bits += [f'{k}="{v}"' for k, v in constraints.items()]
    excerpt = f"{_label(fld)}: {' '.join(bits)}"[:300]
    return [
        {"evidence_id": base[0]["evidence_id"], "selector": sel, "excerpt": excerpt, "note": f"Field {_label(fld)}"}
    ]


class _Features:
    def __init__(self, features: list[Any]) -> None:
        self.items = features

    def by_category(self, *cats: str) -> list[Any]:
        return [f for f in self.items if f.category.value in cats]

    def on_page(self, page_id: uuid.UUID, *cats: str) -> list[Any]:
        return [
            f
            for f in self.items
            if str(page_id) in {str(p) for p in f.page_ids or []} and (not cats or f.category.value in cats)
        ]

    def named(self, name: str) -> Any | None:
        return next((f for f in self.items if f.name.lower() == name.lower()), None)

    def fallback(self) -> list[uuid.UUID]:
        nav = self.by_category("navigation")
        return [nav[0].id] if nav else ([self.items[0].id] if self.items else [])


def generate(data: DiscoveryInput) -> list[ReqDraft]:
    """All rule-derived requirements with their acceptance criteria, deduplicated by match key."""
    feats = _Features(data.features)
    visited = [p for p in data.pages if p.status.value == "visited"]
    by_id = {p.id: p for p in visited}
    out: list[ReqDraft] = []
    out += _navigation(visited, by_id, feats)
    out += _listings(visited, by_id, feats)
    out += _search(visited, feats)
    out += _forms(visited, feats, data)
    out += _signed_in_area(data, feats)
    out += _commerce(visited, feats)
    out += _journeys(data, feats, by_id)
    out += _non_functional(visited, feats, data)
    out += documents_to_requirements(data.documents, feats, visited)
    seen: set[str] = set()
    unique: list[ReqDraft] = []
    for r in out:
        if r.match_key in seen:
            continue
        seen.add(r.match_key)
        if not r.feature_ids and r.source != RequirementSource.document:
            r.feature_ids = feats.fallback()
        r.acs = _dedupe_acs(r.acs)[:MAX_ACS_PER_REQUIREMENT]
        unique.append(r)
    return unique[:MAX_REQUIREMENTS]


def _dedupe_acs(acs: list[AcDraft]) -> list[AcDraft]:
    seen: set[str] = set()
    out = []
    for a in acs:
        if a.match_key not in seen:
            seen.add(a.match_key)
            out.append(a)
    return out


# ------------------------------------------------------------------ navigation, listings, search


def _navigation(visited: list[Any], by_id: dict[uuid.UUID, Any], feats: _Features) -> list[ReqDraft]:
    nav_pages = [p for p in visited if len(p.nav_links or []) >= 2]
    if not nav_pages:
        return []
    first = nav_pages[0]
    names = list(dict.fromkeys(str(n.get("text", "")).strip() for n in first.nav_links if n.get("text")))[:8]
    same = sum(1 for p in nav_pages if [n.get("text") for n in p.nav_links][: len(names)] == names[: len(names)])
    where = "on every visited page" if same == len(visited) else f"on {same} of {len(visited)} visited pages"
    nav_feature = feats.by_category("navigation")
    refs = [dict(r) for r in (nav_feature[0].evidence_refs if nav_feature else [])][:3] or _shot_ref(first)
    req = ReqDraft(
        match_key="nav|nav.primary",
        rule_id="nav.primary",
        title=f"Primary navigation links to {_join(names)} {where}"[:200],
        description=(
            f"The main navigation offers {len(names)} links ({', '.join(names)}). Scan pages with the same navigation: "
            f"{same} of {len(visited)}."
        ),
        type=RequirementType.functional,
        category="navigation",
        behaviour_scope=BehaviourScope.ui,
        classification=Provenance.observed,
        confidence=0.9,
        evidence_refs=refs,
        feature_ids=[f.id for f in nav_feature[:1]],
    )
    # Positive ACs from transitions actually navigated during discovery (source page -> target page).
    hrefs = {str(n.get("href", "")).rstrip("/"): str(n.get("text", "")) for n in first.nav_links}
    for p in visited:
        parent = by_id.get(p.parent_page_id) if p.parent_page_id else None
        text = hrefs.get(p.url.rstrip("/")) or hrefs.get(_path(p.url).rstrip("/") or "/")
        if parent is None or not text:
            continue
        req.acs.append(
            AcDraft(
                AcKind.positive,
                given=f"a visitor is on the {parent.title or _path(parent.url)} page",
                when=f'they select "{text}" in the primary navigation',
                then=f"the {p.title or _path(p.url)} page ({_path(p.url)}) opens",
                classification=Provenance.observed,
                evidence_refs=_shot_ref(parent, "Source page") + _shot_ref(p, "Target page"),
                rule_id="ac.nav.transition",
                exercised=True,
            )
        )
        if len(req.acs) >= 4:
            break
    if not req.acs:
        req.acs.append(
            AcDraft(
                AcKind.positive,
                given="a visitor is on any page",
                when="they select a link in the primary navigation",
                then="the linked page opens",
                classification=Provenance.inferred,
                evidence_refs=refs[:1],
                rule_id="ac.nav.generic",
            )
        )
    return [req]


def _listings(visited: list[Any], by_id: dict[uuid.UUID, Any], feats: _Features) -> list[ReqDraft]:
    out: list[ReqDraft] = []
    children: dict[uuid.UUID, list[Any]] = {}
    for p in visited:
        if p.parent_page_id in by_id and p.page_type.value == "detail":
            children.setdefault(p.parent_page_id, []).append(p)
    for parent_id, kids in children.items():
        parent = by_id[parent_id]
        table = next((c for c in parent.components or [] if c.get("kind") == "table"), None)
        cols = [str(c) for c in ((table or {}).get("details") or {}).get("columns", [])][:4]
        listed = f"each item with {_join(cols).lower()}" if cols else "its items"
        title = parent.title or _path(parent.url)
        feature_ids = [f.id for f in feats.on_page(parent.id, "content")][:2]
        req = ReqDraft(
            match_key=f"listing:{_path(parent.url)}|content.listing",
            rule_id="content.listing",
            title=f"{title} page lists {listed}; each item opens a detail page"[:200],
            description=(
                f"{_path(parent.url)} links to {len(kids)} detail page(s) seen during discovery "
                f"(e.g. {_path(kids[0].url)})."
            ),
            type=RequirementType.functional,
            category="content",
            behaviour_scope=BehaviourScope.ui,
            classification=Provenance.observed,
            confidence=0.85,
            evidence_refs=_shot_ref(parent) + _shot_ref(kids[0]),
            feature_ids=feature_ids,
        )
        req.acs.append(
            AcDraft(
                AcKind.positive,
                given=f"a visitor is on the {title} page",
                when="they open an item from the list",
                then=f"the item's detail page opens (for example {_path(kids[0].url)})",
                classification=Provenance.observed,
                evidence_refs=_shot_ref(parent, "Listing") + _shot_ref(kids[0], "Detail page"),
                rule_id="ac.listing.open_item",
                exercised=True,
            )
        )
        out.append(req)
    return out


def _search(visited: list[Any], feats: _Features) -> list[ReqDraft]:
    form_page = next(
        (p for p in visited for f in p.forms or [] if f.get("purpose_guess") == "search"),
        None,
    )
    if form_page is None:
        return []
    form = next(f for f in form_page.forms if f.get("purpose_guess") == "search")
    results = next((p for p in visited if "q=" in urlsplit(p.url).query or p.page_type.value == "search"), None)
    req = ReqDraft(
        match_key=f"search:{_path(form_page.url)}|search.keyword",
        rule_id="search.keyword",
        title="Visitors can search the site by keyword",
        description=f"A search form is available on {_path(form_page.url)}."
        + (f" Discovery searched for 'test' and reached {_path(results.url)}." if results else ""),
        type=RequirementType.functional,
        category="search",
        behaviour_scope=BehaviourScope.ui,
        classification=Provenance.observed,
        confidence=0.85,
        evidence_refs=_form_refs(form)[:1] + (_shot_ref(results, "Search results") if results else []),
        feature_ids=[f.id for f in feats.by_category("search")][:1],
    )
    req.acs.append(
        AcDraft(
            AcKind.positive,
            given=f"a visitor is on {_path(form_page.url)}",
            when='they search for "test"',
            then="a results page for the search term is shown",
            classification=Provenance.observed if results else Provenance.inferred,
            evidence_refs=_shot_ref(results, "Search results") if results else _form_refs(form)[:1],
            rule_id="ac.search.results",
            exercised=results is not None,
        )
    )
    return [req]


# ------------------------------------------------------------------ forms and fields


def _form_feature(feats: _Features, page: Any, form: dict[str, Any]) -> list[uuid.UUID]:
    purpose = form.get("purpose_guess", "other")
    cats = {"login": ("auth",), "registration": ("auth",), "checkout": ("commerce",)}.get(purpose, ("form",))
    found = feats.on_page(page.id, *cats) or feats.on_page(page.id)
    return [f.id for f in found[:1]]


def _form_name(form: dict[str, Any]) -> str:
    purpose = form.get("purpose_guess", "other")
    named = {
        "contact": "contact",
        "login": "sign-in",
        "registration": "registration",
        "newsletter": "newsletter",
        "checkout": "checkout",
    }
    return named.get(purpose) or str(form.get("name") or form.get("submit_label") or "untitled").strip().lower()


def _forms(visited: list[Any], feats: _Features, data: DiscoveryInput) -> list[ReqDraft]:
    out: list[ReqDraft] = []
    seen_forms: set[str] = set()
    for page in visited:
        for idx, form in enumerate(page.forms or []):
            purpose = form.get("purpose_guess", "other")
            if purpose in ("search", "filter"):
                continue
            anchor = f"form:{_path(page.url).split('?')[0]}:{normalise(str(form.get('name') or form.get('submit_label') or idx))}"
            if anchor in seen_forms:
                continue
            seen_forms.add(anchor)
            fields = [f for f in form.get("fields") or [] if f.get("type") not in ("hidden", "submit", "button")]
            if purpose == "login":
                out += _signin(page, form, fields, anchor, feats, data)
                continue
            out += _form_requirements(page, form, fields, anchor, feats)
    return out


def _form_requirements(
    page: Any, form: dict[str, Any], fields: list[dict[str, Any]], anchor: str, feats: _Features
) -> list[ReqDraft]:
    purpose = form.get("purpose_guess", "other")
    name = _form_name(form)
    feature_ids = _form_feature(feats, page, form)
    refs = _form_refs(form)
    labels = [_label(f) for f in fields]
    submit = form.get("submit_label") or "Submit"
    required = [f for f in fields if f.get("required")]
    out: list[ReqDraft] = []
    verb = PURPOSE_VERB.get(purpose, f"submit the {name} form")
    purpose_req = ReqDraft(
        match_key=f"{anchor}|form.purpose",
        rule_id="form.purpose",
        title=f"Visitors can {verb} with {_join(labels)}"[:200],
        description=f"The {name} form on {_path(page.url)} has {len(fields)} field(s) and a '{submit}' button.",
        type=RequirementType.functional,
        category="form_input",
        behaviour_scope=BehaviourScope.ui,
        classification=Provenance.observed,
        confidence=0.85,
        evidence_refs=refs[:1] + _shot_ref(page),
        feature_ids=feature_ids,
    )
    purpose_req.acs.append(
        AcDraft(
            AcKind.positive,
            given=f"the {name} form on {_path(page.url)}",
            when=f"all fields are filled with valid values and '{submit}' is pressed",
            then="the form is accepted without validation messages",
            classification=Provenance.inferred,
            evidence_refs=refs[:1],
            rule_id="ac.form.valid_submission",
        )
    )
    out.append(purpose_req)
    for fld in fields:
        out += _field_requirements(page, form, fld, anchor, name, feature_ids, required)
    if required or any((f.get("constraints") or {}).get("maxlength") for f in fields):
        server = ReqDraft(
            match_key=f"{anchor}|form.server_validation",
            rule_id="form.server_validation",
            title=f"The server rejects {name} form submissions with missing or invalid fields",
            description=(
                "Browser validation can be bypassed, so the application must validate the same rules on the server. "
                "Not observable from the user interface."
            ),
            type=RequirementType.functional,
            category="validation",
            behaviour_scope=BehaviourScope.backend,
            classification=Provenance.inferred,
            confidence=0.6,
            evidence_refs=refs[:1],
            feature_ids=feature_ids,
            assumptions=["Server-side validation mirrors the constraints declared in the page's HTML."],
        )
        server.acs.append(
            AcDraft(
                AcKind.negative,
                given=f"a {name} form request that bypasses browser validation",
                when=f"it is sent without {_join([_label(f) for f in required]) or 'valid values'}",
                then="the server rejects it with an error and does not process it",
                classification=Provenance.inferred,
                evidence_refs=refs[:1],
                rule_id="ac.form.server_rejects",
            )
        )
        out.append(server)
    outcome = SUBMISSION_OUTCOME.get(purpose, "is processed by the application")
    outcome_then = {
        "contact": "the message is sent to the company and a confirmation is shown",
        "newsletter": "the address is subscribed and a confirmation is shown",
        "registration": "an account is created and a confirmation is shown",
        "checkout": "the order is placed and a confirmation is shown",
    }.get(purpose, "the submission is processed and a confirmation is shown")
    subject = f"Submitting a valid {name} form" if purpose != "checkout" else "Completing checkout"
    result = ReqDraft(
        match_key=f"{anchor}|form.submission_outcome",
        rule_id="form.submission_outcome",
        title=f"{subject} {outcome}"[:200],
        description="The effect of submitting the form happens behind the user interface and was not exercised: "
        "discovery never submits forms other than sign-in.",
        type=RequirementType.functional,
        category="notification" if purpose == "contact" else "data_processing",
        behaviour_scope=BehaviourScope.backend,
        classification=Provenance.inferred,
        confidence=0.6,
        evidence_refs=refs[:1],
        feature_ids=feature_ids,
        assumptions=["The outcome is inferred from the form's purpose; confirm it with the product owner."],
    )
    result.acs.append(
        AcDraft(
            AcKind.positive,
            given=f"the {name} form filled with valid values",
            when=f"'{submit}' is pressed",
            then=outcome_then,
            classification=Provenance.inferred,
            evidence_refs=refs[:1],
            rule_id="ac.form.outcome",
        )
    )
    out.append(result)
    unlabelled = [f for f in fields if not (f.get("label") or "").strip()]
    labels_req = ReqDraft(
        match_key=f"{anchor}|nfr.form_labels",
        rule_id="nfr.form_labels",
        title=f"Every field of the {name} form has an accessible label",
        description=f"Labels found: {', '.join(labels) or 'none'}.",
        type=RequirementType.non_functional,
        category="accessibility",
        behaviour_scope=BehaviourScope.ui,
        classification=Provenance.observed if not unlabelled else Provenance.inferred,
        confidence=0.85 if not unlabelled else 0.6,
        evidence_refs=refs[:1],
        feature_ids=feature_ids,
        assumptions=[f"{_label(f)} has no visible label in this scan." for f in unlabelled],
    )
    labels_req.acs.append(
        AcDraft(
            AcKind.positive,
            given=f"the {name} form",
            when="it is inspected with a screen reader or accessibility checker",
            then="every field announces its label",
            classification=Provenance.inferred,
            evidence_refs=refs[:1],
            rule_id="ac.a11y.labels",
        )
    )
    out.append(labels_req)
    return out


def _field_requirements(
    page: Any,
    form: dict[str, Any],
    fld: dict[str, Any],
    anchor: str,
    form_name: str,
    feature_ids: list[uuid.UUID],
    required: list[dict[str, Any]],
) -> list[ReqDraft]:
    out: list[ReqDraft] = []
    label = _label(fld)
    key = f"{anchor}:{normalise(str(fld.get('name') or label))}"
    refs = _field_refs(form, fld)
    c = fld.get("constraints") or {}
    facts = {"form": form_name, "label": label, "type": fld.get("type"), "required": bool(fld.get("required")), **c}
    base = {
        "type": RequirementType.functional,
        "category": "validation",
        "behaviour_scope": BehaviourScope.ui,
        "evidence_refs": refs,
        "feature_ids": feature_ids,
        "facts": facts,
    }
    if fld.get("required"):
        r = ReqDraft(
            match_key=f"{key}|form.required_field",
            rule_id="form.required_field",
            title=f"{label} is mandatory on the {form_name} form",
            description=f"The {label} field has the HTML required attribute.",
            classification=Provenance.observed,
            confidence=0.9,
            **base,  # type: ignore[arg-type]
        )
        r.acs = negative_criteria_for(r)
        out.append(r)
    if fld.get("type") == "email":
        r = ReqDraft(
            match_key=f"{key}|form.email_format",
            rule_id="form.email_format",
            title=f"{label} must be a valid email address",
            description=f"The {label} field is an email input (type=email), so the browser checks the format.",
            classification=Provenance.observed,
            confidence=0.85,
            **base,  # type: ignore[arg-type]
        )
        r.acs = negative_criteria_for(r)
        out.append(r)
    if c.get("maxlength") or c.get("minlength"):
        mx, mn = c.get("maxlength"), c.get("minlength")
        limits = []
        if mn:
            limits.append(f"at least {mn}")
        if mx:
            limits.append(f"at most {mx}")
        r = ReqDraft(
            match_key=f"{key}|form.length_limit",
            rule_id="form.length_limit",
            title=f"{label} accepts {' and '.join(limits)} characters",
            description=f"Declared on the field: {'minlength=' + str(mn) if mn else ''} {'maxlength=' + str(mx) if mx else ''}".strip(),
            classification=Provenance.observed,
            confidence=0.85,
            **base,  # type: ignore[arg-type]
        )
        r.acs = negative_criteria_for(r) + boundary_criteria_for(r)
        out.append(r)
    if c.get("min") not in (None, "") or c.get("max") not in (None, ""):
        r = ReqDraft(
            match_key=f"{key}|form.range",
            rule_id="form.range",
            title=f"{label} accepts values from {c.get('min') or 'any'} to {c.get('max') or 'any'}",
            description="Declared with the HTML min/max attributes.",
            classification=Provenance.observed,
            confidence=0.85,
            **base,  # type: ignore[arg-type]
        )
        r.acs = boundary_criteria_for(r)
        out.append(r)
    if c.get("pattern"):
        r = ReqDraft(
            match_key=f"{key}|form.pattern",
            rule_id="form.pattern",
            title=f"{label} must match the required format",
            description=f"The field declares pattern {c['pattern']!r}.",
            classification=Provenance.observed,
            confidence=0.8,
            **base,  # type: ignore[arg-type]
        )
        r.acs = negative_criteria_for(r)
        out.append(r)
    if not fld.get("required") and required and fld.get("type") in TEXT_TYPES:
        others = [_label(f) for f in required]
        out.append(
            ReqDraft(
                match_key=f"{key}|form.optional_field",
                rule_id="form.optional_field",
                title=f"Confirm whether {label} is optional on the {form_name} form",
                description=f"{label} is not marked required while {_join(others)} {'is' if len(others) == 1 else 'are'}.",
                classification=Provenance.unverified,
                confidence=0.3,
                status=RequirementStatus.needs_info,
                assumptions=[f"{label} has no required attribute; it may be optional by design or missing validation."],
                **base,  # type: ignore[arg-type]
            )
        )
        out[-1].acs.append(
            AcDraft(
                AcKind.positive,
                given=f"the {form_name} form with every mandatory field filled",
                when=f"{label} is left empty and the form is submitted",
                then="the form is accepted (if the product owner confirms the field is optional)",
                classification=Provenance.unverified,
                evidence_refs=refs,
                rule_id="ac.form.optional",
            )
        )
    return out


def negative_criteria_for(req: ReqDraft, *, extended: bool = False) -> list[AcDraft]:
    """Negative criteria derived from a field's constraints. The core set is generated with the requirement; the
    extended set is what `propose_negative_criteria` can add later (P2-03, P2-10)."""
    f = req.facts
    if not f:
        return []
    label, form, refs = f.get("label", "The field"), f.get("form", "the"), req.evidence_refs

    def neg(when: str, then: str, rule: str, values: list[dict[str, str]] | None = None) -> AcDraft:
        return AcDraft(
            AcKind.negative,
            given=f"the {form} form",
            when=when,
            then=then,
            classification=Provenance.inferred,
            evidence_refs=refs,
            rule_id=rule,
            test_values=values,
        )

    core: list[AcDraft] = []
    more: list[AcDraft] = []
    rule = req.rule_id
    if rule == "form.required_field":
        core.append(
            neg(
                f"{label} is left empty and the form is submitted",
                f"submission is blocked and {label} is identified as required",
                "ac.required.empty",
            )
        )
        more.append(
            neg(
                f"{label} contains only spaces and the form is submitted",
                f"submission is blocked and {label} is identified as required",
                "ac.required.whitespace",
                [{"field": label, "value": "   ", "note": "spaces only"}],
            )
        )
    elif rule == "form.email_format":
        core.append(
            neg(
                f'{label} is "name.example.com" (no @) and the form is submitted',
                f"submission is blocked and {label} is identified as an invalid email address",
                "ac.email.invalid_format",
                [{"field": label, "value": "name.example.com", "note": "missing @"}],
            )
        )
        more += [
            neg(
                f'{label} is "name@" (no domain) and the form is submitted',
                f"submission is blocked and {label} is identified as an invalid email address",
                "ac.email.missing_domain",
                [{"field": label, "value": "name@", "note": "missing domain"}],
            ),
            neg(
                f'{label} is "name @example.com" (contains a space) and the form is submitted',
                f"submission is blocked and {label} is identified as an invalid email address",
                "ac.email.space",
                [{"field": label, "value": "name @example.com", "note": "contains a space"}],
            ),
        ]
    elif rule == "form.pattern":
        core.append(
            neg(
                f"{label} contains letters where the format {f.get('pattern')!r} does not allow them",
                f"submission is blocked and {label} is identified as not matching the format",
                "ac.pattern.mismatch",
                [{"field": label, "value": "abc", "note": f"does not match {f.get('pattern')}"}],
            )
        )
        more.append(
            neg(
                f"{label} contains only spaces and the form is submitted",
                f"{label} is identified as not matching the format",
                "ac.pattern.spaces",
                [{"field": label, "value": "   ", "note": "spaces only"}],
            )
        )
    elif rule == "form.length_limit" and f.get("maxlength"):
        n = int(f["maxlength"])
        more.append(
            neg(
                f"{label} is pasted with {n * 2} characters",
                f"{label} keeps at most {n} characters",
                "ac.maxlength.paste",
                [{"field": label, "value": _sample(n * 2), "note": f"{n * 2} characters"}],
            )
        )
    elif rule == "form.range":
        more.append(
            neg(
                f"{label} contains text instead of a number",
                f"{label} does not accept the value",
                "ac.number.text",
                [{"field": label, "value": "abc", "note": "not a number"}],
            )
        )
    return core + more if extended else core


def boundary_criteria_for(req: ReqDraft) -> list[AcDraft]:
    """Boundary values computed in code from the declared constraints."""
    f = req.facts
    label, form, refs = f.get("label", "The field"), f.get("form", "the"), req.evidence_refs
    out: list[AcDraft] = []
    mx, mn = f.get("maxlength"), f.get("minlength")
    if mx:
        n = int(mx)
        out.append(
            AcDraft(
                AcKind.boundary,
                given=f"the {form} form",
                when=f"{label} is filled with exactly {n} characters",
                then=f"{label} accepts the value",
                classification=Provenance.inferred,
                evidence_refs=refs,
                rule_id="ac.maxlength.at_limit",
                test_values=[{"field": label, "value": _sample(n), "note": f"{n} characters (at the limit)"}],
            )
        )
        out.append(
            AcDraft(
                AcKind.boundary,
                given=f"the {form} form",
                when=f"{label} is filled with {n + 1} characters",
                then=f"{label} accepts no more than {n} characters",
                classification=Provenance.inferred,
                evidence_refs=refs,
                rule_id="ac.maxlength.over_limit",
                test_values=[{"field": label, "value": _sample(n + 1), "note": f"{n + 1} characters (one over)"}],
            )
        )
    if mn:
        n = int(mn)
        out.append(
            AcDraft(
                AcKind.boundary,
                given=f"the {form} form",
                when=f"{label} is filled with {n - 1} characters and submitted",
                then=f"submission is blocked and {label} is identified as too short",
                classification=Provenance.inferred,
                evidence_refs=refs,
                rule_id="ac.minlength.under",
                test_values=[{"field": label, "value": _sample(n - 1), "note": f"{n - 1} characters (one under)"}],
            )
        )
        out.append(
            AcDraft(
                AcKind.boundary,
                given=f"the {form} form",
                when=f"{label} is filled with exactly {n} characters",
                then=f"{label} accepts the value",
                classification=Provenance.inferred,
                evidence_refs=refs,
                rule_id="ac.minlength.at_limit",
                test_values=[{"field": label, "value": _sample(n), "note": f"{n} characters (at the limit)"}],
            )
        )
    for bound, word, delta in (("min", "below", -1), ("max", "above", 1)):
        raw = f.get(bound)
        if raw in (None, ""):
            continue
        try:
            v = float(raw)
        except ValueError:
            continue
        val = int(v) if v.is_integer() else v
        out.append(
            AcDraft(
                AcKind.boundary,
                given=f"the {form} form",
                when=f"{label} is {val}",
                then=f"{label} accepts the value",
                classification=Provenance.inferred,
                evidence_refs=refs,
                rule_id=f"ac.range.{bound}",
                test_values=[{"field": label, "value": str(val), "note": f"at the {bound}imum"}],
            )
        )
        out.append(
            AcDraft(
                AcKind.boundary,
                given=f"the {form} form",
                when=f"{label} is {val + delta} ({word} the {bound}imum) and the form is submitted",
                then=f"submission is blocked and {label} is identified as out of range",
                classification=Provenance.inferred,
                evidence_refs=refs,
                rule_id=f"ac.range.{bound}_out",
                test_values=[{"field": label, "value": str(val + delta), "note": f"one {word} the {bound}imum"}],
            )
        )
    return out


def _sample(n: int) -> str:
    """A deterministic test string of exactly n characters (described instead when it is very long)."""
    if n > 500:
        return f"<{n} characters>"
    return ("abcdefghij" * (n // 10 + 1))[:n]


# ------------------------------------------------------------------ sign-in and signed-in area


def _signin(
    page: Any, form: dict[str, Any], fields: list[dict[str, Any]], anchor: str, feats: _Features, data: DiscoveryInput
) -> list[ReqDraft]:
    refs = _form_refs(form)
    feature_ids = _form_feature(feats, page, form)
    user_field = next((f for f in fields if f.get("type") != "password"), None)
    user_label = _label(user_field) if user_field else "Username"
    submit = form.get("submit_label") or "Sign in"
    form_req = ReqDraft(
        match_key=f"{anchor}|auth.signin_form",
        rule_id="auth.signin_form",
        title=f"Registered users can sign in with {user_label.lower()} and password",
        description=f"The sign-in form on {_path(page.url)} has {user_label} and Password fields and a '{submit}' button.",
        type=RequirementType.functional,
        category="authentication",
        behaviour_scope=BehaviourScope.ui,
        classification=Provenance.observed,
        confidence=0.85,
        evidence_refs=refs[:1] + _shot_ref(page),
        feature_ids=feature_ids,
    )
    form_req.acs += [
        AcDraft(
            AcKind.positive,
            given="a registered user on the sign-in page",
            when=f"they enter a valid {user_label.lower()} and password and press '{submit}'",
            then="they are signed in and see the signed-in area",
            classification=Provenance.inferred,
            evidence_refs=refs[:1],
            rule_id="ac.signin.valid",
        ),
        AcDraft(
            AcKind.negative,
            given="a registered user on the sign-in page",
            when=f"they enter a valid {user_label.lower()} with a wrong password and press '{submit}'",
            then="an error message is shown and they are not signed in",
            classification=Provenance.inferred,
            evidence_refs=refs[:1],
            rule_id="ac.signin.wrong_password",
        ),
        AcDraft(
            AcKind.negative,
            given="the sign-in page",
            when=f"{user_label} and Password are left empty and '{submit}' is pressed",
            then="sign-in is blocked and both fields are identified as required",
            classification=Provenance.inferred,
            evidence_refs=refs[:1],
            rule_id="ac.signin.empty",
        ),
    ]
    invalid = ReqDraft(
        match_key=f"{anchor}|auth.invalid_credentials",
        rule_id="auth.invalid_credentials",
        title="Invalid credentials show an error and do not sign the user in",
        description="Credential checks happen on the server; the outcome was not exercised with wrong credentials.",
        type=RequirementType.functional,
        category="authentication",
        behaviour_scope=BehaviourScope.mixed,
        classification=Provenance.inferred,
        confidence=0.6,
        evidence_refs=refs[:1],
        feature_ids=feature_ids,
    )
    invalid.acs.append(
        AcDraft(
            AcKind.negative,
            given="the sign-in page",
            when=f"an unknown {user_label.lower()} and any password are submitted",
            then="a generic error is shown that does not reveal whether the account exists",
            classification=Provenance.inferred,
            evidence_refs=refs[:1],
            rule_id="ac.signin.unknown_user",
        )
    )
    https = urlsplit(page.url).scheme == "https"
    tls = ReqDraft(
        match_key=f"{anchor}|nfr.https_credentials",
        rule_id="nfr.https_credentials",
        title="Sign-in credentials are only sent over HTTPS",
        description="Passwords must never travel unencrypted.",
        type=RequirementType.non_functional,
        category="security",
        behaviour_scope=BehaviourScope.mixed,
        classification=Provenance.assumed,
        confidence=0.5,
        evidence_refs=refs[:1],
        feature_ids=feature_ids,
        assumptions=[]
        if https
        else [f"The target {_origin(page.url)} uses http:, so credentials are sent unencrypted in this environment."],
        facts={"http": not https},
    )
    tls.acs.append(
        AcDraft(
            AcKind.positive,
            given="the sign-in page",
            when="the form is submitted",
            then="the request uses HTTPS",
            classification=Provenance.assumed,
            evidence_refs=[],
            rule_id="ac.https.signin",
        )
    )
    return [form_req, invalid, tls]


def _signed_in_area(data: DiscoveryInput, feats: _Features) -> list[ReqDraft]:
    auth = data.auth or {}
    authed = [p for p in data.pages if getattr(p, "auth_context", None) and p.auth_context.value == "authenticated"]
    out: list[ReqDraft] = []
    gaps = [g for g in data.access_gaps if g.get("reason") == "Needs credentials"]
    areas = [str(g.get("area") or g.get("description") or "") for g in gaps]
    if auth.get("result") == "succeeded" and authed:
        areas = areas or ["Signed-in area"]
    feature = (feats.by_category("account") or feats.by_category("auth"))[:1]
    for area in dict.fromkeys(a for a in areas if a):
        observed = auth.get("result") == "succeeded" and bool(authed)
        refs = [r for p in authed[:2] for r in _shot_ref(p, "Seen after sign-in")]
        req = ReqDraft(
            match_key=f"area:{normalise(area if not observed else 'signed-in')}|auth.signed_in_area",
            rule_id="auth.signed_in_area",
            title=f"Signed-in users can use the {area if area.startswith('/') else area.lower()}"
            if not observed
            else f"Signed-in users can reach {len(authed)} page(s) of the signed-in area",
            description=(
                f"Discovery signed in and visited {', '.join(_path(p.url) for p in authed[:5])}."
                if observed
                else "This area needs credentials and was not observed; its content and behaviour are unknown."
            ),
            type=RequirementType.functional,
            category="account",
            behaviour_scope=BehaviourScope.ui,
            classification=Provenance.observed if observed else Provenance.unverified,
            confidence=0.8 if observed else 0.3,
            evidence_refs=refs if observed else [],
            feature_ids=[f.id for f in feature],
            assumptions=[] if observed else ["Add test credentials and re-run discovery to observe this area."],
        )
        req.acs.append(
            AcDraft(
                AcKind.positive,
                given="a signed-in user",
                when=f"they open {area if area.startswith('/') else 'the signed-in area'}",
                then="the signed-in content is shown",
                classification=Provenance.observed if observed else Provenance.unverified,
                evidence_refs=refs if observed else [],
                rule_id="ac.signed_in.open",
                exercised=observed,
            )
        )
        req.acs.append(
            AcDraft(
                AcKind.negative,
                given="a visitor who is not signed in",
                when=f"they open {area if area.startswith('/') else 'the signed-in area'}",
                then="they are asked to sign in and the content is not shown",
                classification=Provenance.inferred if gaps else Provenance.unverified,
                evidence_refs=[],
                rule_id="ac.signed_in.anonymous",
            )
        )
        out.append(req)
        if observed:
            break
    return out


# ------------------------------------------------------------------ commerce, journeys


def _commerce(visited: list[Any], feats: _Features) -> list[ReqDraft]:
    out: list[ReqDraft] = []
    seen: set[str] = set()
    for p in visited:
        for c in p.components or []:
            details = c.get("details") or {}
            if c.get("kind") != "button" or not details.get("transactional") or details.get("in_form"):
                continue
            name = str(c.get("name") or "").strip()
            if not name or normalise(name) in seen:
                continue
            seen.add(normalise(name))
            refs = [dict(r) for r in c.get("evidence_refs") or []][:1] + _shot_ref(p)
            fid = [f.id for f in feats.items if f.name.lower() == name[:60].lower()][:1] or [
                f.id for f in feats.on_page(p.id, "commerce")
            ][:1]
            ui = ReqDraft(
                match_key=f"commerce:{normalise(name)}|commerce.control",
                rule_id="commerce.control",
                title=f"Item pages offer an '{name}' action",
                description=f"Seen on {_path(p.url)}. Not clicked: transactional actions are never performed.",
                type=RequirementType.functional,
                category="commerce",
                behaviour_scope=BehaviourScope.ui,
                classification=Provenance.observed,
                confidence=0.85,
                evidence_refs=refs,
                feature_ids=fid,
            )
            ui.acs.append(
                AcDraft(
                    AcKind.positive,
                    given=f"a visitor on an item page such as {_path(p.url)}",
                    when="the page loads",
                    then=f"an '{name}' button is visible and enabled",
                    classification=Provenance.observed,
                    evidence_refs=refs,
                    rule_id="ac.commerce.visible",
                    exercised=True,
                )
            )
            effect = ReqDraft(
                match_key=f"commerce:{normalise(name)}|commerce.effect",
                rule_id="commerce.effect",
                title=f"Using '{name}' adds the item and updates the basket",
                description="The effect of the action was not exercised.",
                type=RequirementType.functional,
                category="commerce",
                behaviour_scope=BehaviourScope.mixed,
                classification=Provenance.inferred,
                confidence=0.55,
                evidence_refs=refs,
                feature_ids=fid,
            )
            effect.acs.append(
                AcDraft(
                    AcKind.positive,
                    given=f"a visitor on {_path(p.url)}",
                    when=f"they press '{name}'",
                    then="the basket shows the item with quantity 1",
                    classification=Provenance.inferred,
                    evidence_refs=refs,
                    rule_id="ac.commerce.effect",
                )
            )
            out += [ui, effect]
    return out


def _journeys(data: DiscoveryInput, feats: _Features, by_id: dict[uuid.UUID, Any]) -> list[ReqDraft]:
    out: list[ReqDraft] = []
    for j in data.journeys:
        steps = list(j.steps or [])
        page_ids = {str(s.get("page_id")) for s in steps}
        submits = any(s.get("label") == "inferred" for s in steps)
        fids = [f.id for f in feats.items if page_ids & {str(p) for p in f.page_ids or []}]
        preferred = [f for f in fids if any(x.id == f and x.category.value != "navigation" for x in feats.items)]
        refs = [dict(r) for r in j.evidence_refs or []][:4]
        name = j.name[:1].lower() + j.name[1:]
        req = ReqDraft(
            match_key=f"journey:{normalise(j.name)}|journey.e2e",
            rule_id="journey.e2e",
            title=f"Users can {name} end to end"[:200],
            description=" → ".join(str(s.get("action", "")) for s in steps)[:1900],
            type=RequirementType.functional,
            category="usability",
            behaviour_scope=BehaviourScope.mixed if submits else BehaviourScope.ui,
            classification=Provenance.inferred,
            confidence=0.6,
            evidence_refs=refs,
            feature_ids=(preferred or fids)[:3],
            source_refs={"journey_ids": [str(j.id)], "page_ids": sorted(page_ids)},
        )
        last = steps[-1]["action"] if steps else "reach the goal"
        req.acs.append(
            AcDraft(
                AcKind.positive,
                given=f"a visitor on {_path(by_id[steps[0]['page_id']].url) if steps and steps[0].get('page_id') in by_id else 'the start page'}",
                when="they follow the journey steps",
                then=f"they can {last[:1].lower() + last[1:]}".replace(" (not performed: read-only)", ""),
                classification=Provenance.inferred,
                evidence_refs=refs[:2],
                rule_id="ac.journey.e2e",
            )
        )
        out.append(req)
    return out


# ------------------------------------------------------------------ non-functional


def _non_functional(visited: list[Any], feats: _Features, data: DiscoveryInput) -> list[ReqDraft]:
    out: list[ReqDraft] = []
    if not visited:
        return out
    site = feats.fallback()
    mobile = [p for p in visited if (p.responsive or {}).get("mobile")]
    if mobile:
        overflow = [p for p in mobile if p.responsive["mobile"].get("horizontal_overflow")]
        refs = [
            {"evidence_id": p.responsive["mobile"]["screenshot_evidence_id"], "note": f"Mobile view of {_path(p.url)}"}
            for p in mobile
            if p.responsive["mobile"].get("screenshot_evidence_id")
        ][:3]
        r = ReqDraft(
            match_key="site|nfr.mobile_layout",
            rule_id="nfr.mobile_layout",
            title="Pages display without horizontal scrolling on a 390×844 mobile screen",
            description=f"Checked on {len(mobile)} page(s); horizontal overflow on {len(overflow)}.",
            type=RequirementType.non_functional,
            category="compatibility",
            behaviour_scope=BehaviourScope.ui,
            classification=Provenance.observed,
            confidence=0.8,
            evidence_refs=refs,
            feature_ids=site,
            assumptions=[f"Scan {data.scan_number} found horizontal overflow on {_path(p.url)}." for p in overflow][:5],
        )
        r.acs.append(
            AcDraft(
                AcKind.positive,
                given="a 390×844 mobile viewport",
                when=f"{_path(mobile[0].url)} is opened",
                then="the page fits the screen width without horizontal scrolling",
                classification=Provenance.observed if not overflow else Provenance.inferred,
                evidence_refs=refs[:1],
                rule_id="ac.mobile.fits",
                exercised=True,
            )
        )
        out.append(r)
    errors = [p for p in visited if any(c.get("level") == "error" for c in p.console_issues or [])]
    refs = [r for p in visited[:3] for r in _shot_ref(p)]
    r = ReqDraft(
        match_key="site|nfr.console_errors",
        rule_id="nfr.console_errors",
        title="Visited pages load without browser console errors",
        description=f"{len(visited)} page(s) loaded; console errors on {len(errors)}.",
        type=RequirementType.non_functional,
        category="usability",
        behaviour_scope=BehaviourScope.ui,
        classification=Provenance.observed,
        confidence=0.75,
        evidence_refs=refs,
        feature_ids=site,
        assumptions=[f"Console errors were recorded on {_path(p.url)}." for p in errors][:5],
    )
    r.acs.append(
        AcDraft(
            AcKind.positive,
            given="any page of the site",
            when="it loads in Chromium",
            then="no errors are written to the browser console",
            classification=Provenance.observed if not errors else Provenance.inferred,
            evidence_refs=refs[:1],
            rule_id="ac.console.clean",
            exercised=True,
        )
    )
    out.append(r)
    loads = [int(p.load_ms) for p in visited if p.load_ms]
    median = int(statistics.median(loads)) if loads else None
    r = ReqDraft(
        match_key="site|nfr.response_time",
        rule_id="nfr.response_time",
        title="Pages load within 3 seconds",
        description="Response-time target for page loads.",
        type=RequirementType.non_functional,
        category="performance",
        behaviour_scope=BehaviourScope.mixed,
        classification=Provenance.assumed,
        confidence=0.4,
        evidence_refs=[],
        feature_ids=site,
        assumptions=[
            "3 seconds is a placeholder target: replace it with your own.",
            *(
                [
                    f"Discovery measured a median load time of {median} ms on {len(loads)} page(s) (one run; not a performance test)."
                ]
                if median is not None
                else []
            ),
        ],
    )
    r.acs.append(
        AcDraft(
            AcKind.positive,
            given="a page of the site under normal load",
            when="it is opened",
            then="it finishes loading within 3 seconds",
            classification=Provenance.assumed,
            evidence_refs=[],
            rule_id="ac.performance.load_time",
        )
    )
    out.append(r)
    return out


# ------------------------------------------------------------------ source documents (P2-08)

_STATEMENT_STOP = frozenset(
    [
        "the",
        "a",
        "an",
        "and",
        "or",
        "of",
        "to",
        "in",
        "on",
        "for",
        "with",
        "be",
        "is",
        "are",
        "must",
        "shall",
        "should",
        "will",
        "can",
        "able",
        "when",
        "user",
        "users",
        "system",
        "it",
        "its",
        "that",
        "this",
        "as",
        "by",
        "at",
        "from",
    ]
)


def documents_to_requirements(docs: list[DocStatement], feats: _Features, visited: list[Any]) -> list[ReqDraft]:
    """Document statements become requirements with `source="document"`: `unverified` unless matched to a
    discovered feature by keyword overlap, then `inferred` with both document and UI evidence. Never observed."""
    out: list[ReqDraft] = []
    for st in docs:
        words = {w for w in normalise(st.text).split() if w not in _STATEMENT_STOP and len(w) > 2}
        best, best_score = None, 0
        for f in feats.items:
            fw = {w for w in normalise(f"{f.name} {f.description}").split() if w not in _STATEMENT_STOP and len(w) > 2}
            score = len(words & fw)
            if score > best_score:
                best, best_score = f, score
        matched = best if best_score >= 2 else None
        doc_ref = {
            "evidence_id": str(st.text_evidence_id),
            "excerpt": st.text[:300],
            "note": f"{st.document_key} §{st.anchor}" + (f" p.{st.page}" if st.page else ""),
        }
        refs = [doc_ref] + ([dict(r) for r in matched.evidence_refs][:1] if matched else [])
        title = st.text.strip().rstrip(".")
        req = ReqDraft(
            match_key=f"doc:{st.document_key}:{st.anchor}:{normalise(st.text)[:80]}|document.statement",
            rule_id="document.statement",
            title=(title[:197] + "…") if len(title) > 198 else title,
            description=f"Stated in {st.document_key} ({st.heading or 'untitled section'}).",
            type=RequirementType.functional,
            category=_doc_category(st.text, matched),
            behaviour_scope=BehaviourScope.ui,
            classification=Provenance.inferred if matched else Provenance.unverified,
            confidence=0.6 if matched else 0.3,
            evidence_refs=refs,
            feature_ids=[matched.id] if matched else [],
            source=RequirementSource.document,
            source_refs={"document_ids": [str(st.document_id)]},
            assumptions=[]
            if matched
            else ["No discovered feature matches this statement; it may describe an area discovery did not reach."],
        )
        limit = re.search(r"(longer|more) than (\d+) characters", st.text, re.IGNORECASE)
        req.acs.append(
            AcDraft(
                AcKind.boundary if limit else AcKind.positive,
                given="the documented behaviour",
                when=f"a value of {int(limit.group(2)) + 1} characters is entered" if limit else "it is exercised",
                then=f"the application behaves as stated in {st.document_key} §{st.anchor}",
                classification=Provenance.inferred if matched else Provenance.unverified,
                evidence_refs=[doc_ref],
                rule_id="ac.document.statement",
                test_values=[
                    {"field": "value", "value": _sample(int(limit.group(2)) + 1), "note": "one over the stated limit"}
                ]
                if limit
                else None,
            )
        )
        out.append(req)
    return out


def _doc_category(text: str, feature: Any | None) -> str:
    t = text.lower()
    for word, cat in (
        ("sign in", "authentication"),
        ("log in", "authentication"),
        ("password", "authentication"),
        ("search", "search"),
        ("basket", "commerce"),
        ("cart", "commerce"),
        ("checkout", "commerce"),
        ("email", "notification"),
        ("characters", "validation"),
        ("accessib", "accessibility"),
        ("second", "performance"),
    ):
        if word in t:
            return cat
    if feature is not None:
        return {"form": "form_input", "auth": "authentication", "commerce": "commerce", "search": "search"}.get(
            feature.category.value, "other"
        )
    return "other"


def _join(items: list[str]) -> str:
    items = [i for i in items if i]
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    return ", ".join(items[:-1]) + " and " + items[-1]


def _origin(url: str) -> str:
    p = urlsplit(url)
    return f"{p.scheme}://{p.netloc}"
