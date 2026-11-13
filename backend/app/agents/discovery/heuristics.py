"""Rule-based discovery analysis (works with AI off; labelled generated_by="rules").

Ported from `api/src/services/discovery.ts` (SKIP_LINK, heuristicWorkflows) and extended: page typing, form
purpose, features backed by observed elements, inferred journeys over navigated pages, auth boundaries, access gaps.
"""

from __future__ import annotations

import re
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from app.agents.discovery.schemas import (
    EvidenceRefModel,
    ExtractedComponent,
    ExtractedForm,
    FeatureCandidate,
    JourneyCandidate,
    JourneyStep,
    NavLink,
)
from app.domain.enums import FeatureCategory, GeneratedBy, PageType, Provenance

SKIP_LINK = re.compile(
    r"log-?out|sign-?out|sign_out|logoff|log_off|delete|remove|destroy|unsubscribe|deactivate|cancel-account"
    r"|\.(pdf|zip|png|jpe?g|gif|svg|webp|ico|mp4|mp3|mov|avi|docx?|xlsx?|pptx?|csv|exe|dmg|pkg|msi|tar|gz|tgz|rar|7z|apk)$",
    re.IGNORECASE,
)
_FILE_EXT = re.compile(
    r"\.(pdf|zip|png|jpe?g|gif|svg|webp|ico|mp4|mp3|mov|avi|docx?|xlsx?|pptx?|csv|exe|dmg|pkg|msi|tar|gz|tgz|rar|7z|apk)$",
    re.I,
)
_SESSION_END = re.compile(r"log-?out|sign-?out|sign_out|logoff|log_off", re.I)
_LOGIN_PATH = re.compile(r"/(log-?in|sign-?in|signin|auth|account/login|session/new)(/|$)", re.I)
_SEARCH_PATH = re.compile(r"/(search|find|results)(/|$)", re.I)
UI_ONLY_LIMITATION = (
    "Discovery observes the user interface only. Backend behaviour, data handling and security have not been verified."
)


def skip_reason(url: str) -> str | None:
    """Why a same-site link is not followed (None = follow)."""
    path = urlsplit(url).path
    target = path + ("?" + urlsplit(url).query if urlsplit(url).query else "")
    if _SESSION_END.search(target):
        return "would end the session"
    if _FILE_EXT.search(path):
        return "file download"
    if SKIP_LINK.search(target):
        return "destructive action"
    return None


def path_of(url: str) -> str:
    parts = urlsplit(url)
    return (parts.path or "/") + (f"?{parts.query}" if parts.query else "")


# ------------------------------------------------------------------ forms and pages


def form_purpose(form: ExtractedForm) -> str:
    fields = form.fields
    types = [f.type for f in fields]
    names = " ".join(f"{f.name} {f.label} {f.placeholder or ''}" for f in fields).lower()
    label = f"{form.name or ''} {form.heading or ''} {form.submit_label or ''} {form.action}".lower()
    pw = types.count("password")
    if pw >= 2 or re.search(r"regist|sign ?up|create (an )?account|join", label):
        return "registration" if pw else ("newsletter" if re.search(r"newsletter|subscribe", label) else "registration")
    if pw == 1:
        return "login"
    if form.role == "search" or (
        len(fields) <= 2 and re.search(r"\b(q|query|search|s|keywords?)\b", names + " " + label)
    ):
        return "search"
    if re.search(r"checkout|payment|card number|billing|shipping", label + " " + names):
        return "checkout"
    if re.search(r"newsletter|subscribe", label) and len(fields) <= 2:
        return "newsletter"
    if re.search(r"contact|message|enquir|inquir|feedback|support", label + " " + names):
        return "contact"
    if fields and all(t in ("select", "checkbox", "radio") for t in types):
        return "filter"
    return "other"


PURPOSE_FEATURE: dict[str, tuple[str, FeatureCategory]] = {
    "login": ("Sign in", FeatureCategory.auth),
    "registration": ("Account registration", FeatureCategory.auth),
    "search": ("Site search", FeatureCategory.search),
    "contact": ("Contact form", FeatureCategory.form),
    "newsletter": ("Newsletter sign-up", FeatureCategory.form),
    "checkout": ("Checkout", FeatureCategory.commerce),
    "filter": ("Filtering and sorting", FeatureCategory.search),
}
PURPOSE_JOURNEY: dict[str, str] = {
    "login": "Sign in",
    "registration": "Register an account",
    "search": "Search the site",
    "contact": "Contact the company",
    "newsletter": "Subscribe to the newsletter",
    "checkout": "Complete a purchase",
}
DATA_SENDING_PURPOSES = frozenset({"contact", "registration", "newsletter", "checkout", "login", "other"})


def form_display_name(form: ExtractedForm) -> str:
    purpose = form_purpose(form)
    if purpose in PURPOSE_FEATURE:
        return PURPOSE_FEATURE[purpose][0].replace(" form", "")
    return form.name or form.heading or form.submit_label or "Untitled form"


def describe_form(form: ExtractedForm) -> str:
    parts = []
    for f in form.fields[:8]:
        bits = [f.type]
        if f.required:
            bits.append("required")
        if f.constraints.maxlength:
            bits.append(f"max {f.constraints.maxlength} chars")
        if f.constraints.pattern:
            bits.append("pattern")
        parts.append(f"{f.label or f.name or f.type} ({', '.join(bits)})")
    n = len(form.fields)
    submit = f" Submit button '{form.submit_label}'." if form.submit_label else ""
    return f"{n} field{'s' if n != 1 else ''}: {', '.join(parts)}.{submit} Not submitted."


def page_counts(forms: list[ExtractedForm], components: list[ExtractedComponent], link_count: int) -> dict[str, int]:
    def count(kind: str) -> int:
        return sum(1 for c in components if c.kind == kind)

    return {
        "forms": len(forms),
        "inputs": sum(len(f.fields) for f in forms),
        "buttons": count("button"),
        "links": link_count,
        "dropdowns": count("dropdown"),
        "search": count("search"),
        "filters": count("filter"),
        "tables": count("table"),
        "modals": count("modal"),
        "tabs": count("tabs"),
        "accordions": count("accordion"),
        "menus": count("menu"),
        "pagination": count("pagination"),
        "other": count("other"),
    }


def classify_page(
    url: str,
    status: int | None,
    *,
    depth: int,
    forms: list[ExtractedForm],
    components: list[ExtractedComponent],
    has_password: bool,
    title: str = "",
) -> PageType:
    path = urlsplit(url).path or "/"
    if status is not None and status >= 400:
        return PageType.auth if status in (401, 403) else PageType.error
    if has_password or _LOGIN_PATH.search(path):
        return PageType.auth
    if re.search(r"\b(not found|page not found|404)\b", title, re.I):
        return PageType.error
    purposes = [form_purpose(f) for f in forms]
    if _SEARCH_PATH.search(path) or (urlsplit(url).query and "search" in purposes):
        return PageType.search
    if depth == 0 or path in ("/", "/index.html", "/home"):
        return PageType.landing
    if any(p not in ("search", "filter") for p in purposes):
        return PageType.form
    if (
        any(c.kind in ("table", "pagination") for c in components)
        or sum(1 for c in components if c.kind == "filter") >= 1
    ):
        return PageType.listing
    segments = [s for s in path.split("/") if s]
    if len(segments) >= 2 or any(c.details.get("transactional") for c in components if c.kind == "button"):
        return PageType.detail
    return PageType.other


# ------------------------------------------------------------------ analysis over all pages


@dataclass
class PageView:
    id: uuid.UUID
    url: str
    title: str
    status: int | None
    failed: bool
    depth: int
    parent_id: uuid.UUID | None
    page_type: str
    requires_auth: bool
    forms: list[ExtractedForm] = field(default_factory=list)
    components: list[ExtractedComponent] = field(default_factory=list)
    nav_links: list[NavLink] = field(default_factory=list)
    screenshot_id: uuid.UUID | None = None
    dom_id: uuid.UUID | None = None
    failure_reason: str | None = None
    redirected_from: str | None = None
    redirect_target: str | None = None
    found_via: str | None = None

    @property
    def path(self) -> str:
        return path_of(self.url)

    @property
    def label(self) -> str:
        return self.title or self.path


def _refs(
    page: PageView, selector: str | None = None, excerpt: str | None = None, note: str | None = None
) -> list[EvidenceRefModel]:
    refs: list[EvidenceRefModel] = []
    if page.dom_id and selector:
        refs.append(
            EvidenceRefModel(
                evidence_id=page.dom_id, selector=selector, excerpt=(excerpt or None) and excerpt[:300], note=note
            )
        )
    if page.screenshot_id:
        refs.append(EvidenceRefModel(evidence_id=page.screenshot_id, note=f"Screenshot of {page.path}"))
    return refs


class _FeatureAcc:
    def __init__(self) -> None:
        self.items: OrderedDict[str, FeatureCandidate] = OrderedDict()

    def add(
        self,
        name: str,
        category: FeatureCategory,
        description: str,
        page: PageView,
        refs: list[EvidenceRefModel],
        *,
        provenance: Provenance = Provenance.observed,
        confidence: float = 0.9,
        reason: str | None = None,
    ) -> None:
        key = name.lower()
        if key in self.items:
            f = self.items[key]
            if page.id not in f.page_ids:
                f.page_ids.append(page.id)
            if len(f.evidence_refs) < 8:
                f.evidence_refs.extend(refs[: 8 - len(f.evidence_refs)])
            return
        if provenance == Provenance.observed and not refs:
            provenance = Provenance.unverified
        self.items[key] = FeatureCandidate(
            name=name,
            description=description,
            category=category,
            page_ids=[page.id],
            provenance=provenance,
            confidence=confidence,
            evidence_refs=refs,
            generated_by=GeneratedBy.rules,
            reason=reason,
        )


def build_features(pages: list[PageView]) -> list[FeatureCandidate]:
    acc = _FeatureAcc()
    visited = [p for p in pages if not p.failed]
    nav_pages = [p for p in visited if len(p.nav_links) >= 2]
    if nav_pages:
        first = nav_pages[0]
        names = list(OrderedDict.fromkeys(link.text for link in first.nav_links))[:8]
        for p in nav_pages:
            acc.add(
                "Site navigation",
                FeatureCategory.navigation,
                f"Navigation menu with links: {', '.join(names)}.",
                p,
                _refs(p, "nav, header, [role=navigation]", None, "Navigation links"),
            )
    for p in visited:
        for form in p.forms:
            purpose = form_purpose(form)
            if purpose in PURPOSE_FEATURE:
                name, cat = PURPOSE_FEATURE[purpose]
            else:
                name, cat = (
                    f"Form: {form.name or form.heading or form.submit_label or 'untitled'}",
                    FeatureCategory.form,
                )
            acc.add(
                name,
                cat,
                f"{form_display_name(form)} form on {p.path}. {describe_form(form)}",
                p,
                _refs(p, form.selector, form.html),
            )
        for c in p.components:
            if c.kind == "search":
                acc.add(
                    "Site search",
                    FeatureCategory.search,
                    f"Search input '{c.name}' on {p.path}.",
                    p,
                    _refs(p, c.selector, c.html),
                )
            elif c.kind == "filter":
                acc.add(
                    "Filtering and sorting",
                    FeatureCategory.search,
                    f"Filter control '{c.name}' on {p.path}.",
                    p,
                    _refs(p, c.selector, c.html),
                )
            elif c.kind == "table":
                cols = ", ".join(c.details.get("columns", [])[:6]) or "no header row"
                acc.add(
                    "Data tables",
                    FeatureCategory.content,
                    f"Table on {p.path} (columns: {cols}).",
                    p,
                    _refs(p, c.selector, c.html),
                )
            elif c.kind == "pagination":
                acc.add(
                    "Paginated listings",
                    FeatureCategory.content,
                    f"Pagination controls on {p.path}.",
                    p,
                    _refs(p, c.selector, c.html),
                )
            elif c.kind == "modal":
                acc.add(
                    "Dialogs",
                    FeatureCategory.other,
                    f"Dialog or dialog trigger '{c.name}' on {p.path}. Not opened.",
                    p,
                    _refs(p, c.selector, c.html),
                )
            elif c.kind == "tabs":
                acc.add(
                    "Tabbed content", FeatureCategory.content, f"Tabs on {p.path}.", p, _refs(p, c.selector, c.html)
                )
            elif c.kind == "accordion":
                acc.add(
                    "Expandable sections",
                    FeatureCategory.content,
                    f"Expandable section '{c.name}' on {p.path}.",
                    p,
                    _refs(p, c.selector, c.html),
                )
            elif c.kind == "button" and c.details.get("transactional") and not c.details.get("in_form"):
                acc.add(
                    f"{c.name[:60]}",
                    FeatureCategory.commerce,
                    f"Button '{c.name}' on {p.path}. Not clicked: transactional actions are never performed.",
                    p,
                    _refs(p, c.selector, c.html),
                )
    for p in pages:
        if p.failed and p.status in (401, 403):
            acc.add(
                "Restricted area",
                FeatureCategory.account,
                f"{p.path} refused access without signing in (HTTP {p.status}).",
                p,
                _refs(p),
                provenance=Provenance.inferred,
                confidence=0.6,
                reason=f"Access was refused (HTTP {p.status}); the content behind it was not observed.",
            )
    by_id = {p.id: p for p in visited}
    listing_children: dict[uuid.UUID, list[PageView]] = {}
    for p in visited:
        if p.parent_id in by_id and p.page_type == PageType.detail:
            listing_children.setdefault(p.parent_id, []).append(p)
    for parent_id, children in listing_children.items():
        if len(children) >= 2:
            parent = by_id[parent_id]
            acc.add(
                "Item catalogue",
                FeatureCategory.content,
                f"{parent.path} links to {len(children)} detail pages (e.g. {children[0].path}).",
                parent,
                _refs(parent),
                provenance=Provenance.inferred,
                confidence=0.6,
                reason="Inferred from a page linking to several pages with the same structure.",
            )
    return list(acc.items.values())


def _chain(page: PageView, by_id: dict[uuid.UUID, PageView]) -> list[PageView]:
    chain = [page]
    seen = {page.id}
    cur = page
    while cur.parent_id and cur.parent_id in by_id and cur.parent_id not in seen and len(chain) < 6:
        cur = by_id[cur.parent_id]
        seen.add(cur.id)
        chain.append(cur)
    return list(reversed(chain))


def build_journeys(pages: list[PageView]) -> list[JourneyCandidate]:
    visited = [p for p in pages if not p.failed]
    by_id = {p.id: p for p in visited}
    journeys: list[JourneyCandidate] = []
    names: set[str] = set()

    def nav_steps(chain: list[PageView]) -> list[JourneyStep]:
        steps = [JourneyStep(page_id=chain[0].id, action=f"Open {chain[0].label}", label="observed")]
        steps += [JourneyStep(page_id=p.id, action=f"Go to {p.label}", label="observed") for p in chain[1:]]
        return steps

    for p in visited:
        for form in p.forms:
            purpose = form_purpose(form)
            name = PURPOSE_JOURNEY.get(purpose)
            if not name or name in names:
                continue
            chain = _chain(p, by_id)
            steps = nav_steps(chain)
            fill = (
                "Enter a search term" if purpose == "search" else f"Fill in the {form_display_name(form).lower()} form"
            )
            steps.append(JourneyStep(page_id=p.id, action=fill, label="inferred"))
            steps.append(
                JourneyStep(
                    page_id=p.id,
                    action=f"Submit '{form.submit_label or 'Submit'}' (not performed: read-only)",
                    label="inferred",
                )
            )
            names.add(name)
            journeys.append(
                JourneyCandidate(
                    name=name,
                    steps=steps,
                    provenance=Provenance.inferred,
                    confidence=0.6,
                    evidence_refs=[r for c in chain for r in _refs(c)][:6],
                    generated_by=GeneratedBy.rules,
                    reason=f"Steps 1–{len(chain)} were navigated; filling in and submitting the form was not performed.",
                )
            )
    # Browse journey: start -> listing -> detail.
    details = [p for p in visited if p.page_type == PageType.detail and p.parent_id in by_id]
    if details and "Browse items and view details" not in names:
        chain = _chain(details[0], by_id)
        if len(chain) >= 2:
            journeys.append(
                JourneyCandidate(
                    name="Browse items and view details",
                    steps=nav_steps(chain),
                    provenance=Provenance.inferred,
                    confidence=0.55,
                    evidence_refs=[r for c in chain for r in _refs(c)][:6],
                    generated_by=GeneratedBy.rules,
                    reason="Every step was navigated, but the goal of the journey is inferred.",
                )
            )
    return journeys[:12]


# ------------------------------------------------------------------ auth boundaries and access gaps


def auth_boundaries(pages: list[PageView]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for p in pages:
        refs = [r.model_dump(mode="json") for r in _refs(p, "input[type=password]" if not p.failed else None)]
        if p.failed and p.status in (401, 403):
            out.append({"url": p.url, "kind": f"http_{p.status}", "evidence_refs": refs})
        elif not p.failed and p.redirected_from and p.page_type == PageType.auth:
            out.append(
                {"url": p.redirected_from, "kind": "redirect_to_login", "login_url": p.url, "evidence_refs": refs}
            )
        elif p.failed and p.redirect_target and p.requires_auth:
            out.append(
                {"url": p.url, "kind": "redirect_to_login", "login_url": p.redirect_target, "evidence_refs": refs}
            )
        elif not p.failed and any(form_purpose(f) == "login" for f in p.forms):
            out.append({"url": p.url, "kind": "login_form", "evidence_refs": refs})
    return out


def signed_in_area_label(login_paths: list[str]) -> str:
    """Name of the unobserved area behind sign-in forms, e.g. "Signed-in area behind /login"."""
    shown = ", ".join(list(dict.fromkeys(login_paths))[:2])
    return f"Signed-in area behind {shown}"


def access_gaps(
    pages: list[PageView],
    *,
    not_visited: int,
    max_pages: int,
    stop_reason: str = "page_limit",
    robots_skipped: list[str],
    skipped_links: list[dict[str, str]],
    bot_protection: bool,
) -> list[dict[str, Any]]:
    gaps: list[dict[str, Any]] = []
    boundaries = auth_boundaries(pages)
    for b in boundaries:
        path = path_of(b["url"])
        if b["kind"] == "login_form":
            # The visible sign-in page itself was observed: it is an authentication boundary, not a gap.
            continue
        if b["kind"] == "redirect_to_login":
            desc = f"{path} redirects to the sign-in page."
        else:
            desc = f"{path} requires signing in (HTTP {b['kind'][-3:]})."
        gaps.append(
            {
                "area": path,
                "reason": "Needs credentials",
                "description": desc,
                "suggestion": "Add credentials and re-scan",
                "evidence_refs": b["evidence_refs"],
            }
        )
    login_forms = [b for b in boundaries if b["kind"] == "login_form"]
    if login_forms and not any(g["reason"] == "Needs credentials" for g in gaps):
        # Only a sign-in form was seen: the signed-in area behind it is one gap (never one per form page).
        where = signed_in_area_label([path_of(b["url"]) for b in login_forms])
        gaps.append(
            {
                "area": where,
                "reason": "Needs credentials",
                "description": f"A sign-in form was found on {path_of(login_forms[0]['url'])}; the pages behind it "
                "could not be observed without signing in.",
                "suggestion": "Add test credentials and re-scan (authenticated discovery arrives in Phase 2)",
                "evidence_refs": login_forms[0]["evidence_refs"],
            }
        )
    for p in pages:
        if p.failed and p.redirect_target:
            continue
        if p.failed and p.status not in (401, 403):
            why = f"HTTP {p.status}" if p.status else (p.failure_reason or "error")
            if p.failure_reason and "blocked" in p.failure_reason.lower():
                gaps.append(
                    {
                        "area": p.path,
                        "reason": "Outside scope (blocked address)",
                        "description": p.failure_reason,
                        "suggestion": "—",
                        "evidence_refs": [],
                    }
                )
                continue
            gaps.append(
                {
                    "area": p.path,
                    "reason": f"Couldn't load ({why})",
                    "description": f"{p.path} could not be loaded ({why}).",
                    "suggestion": "Re-scan",
                    "evidence_refs": [r.model_dump(mode="json") for r in _refs(p)],
                }
            )
    seen_forms: set[str] = set()
    for p in pages:
        if p.failed:
            continue
        for f in p.forms:
            purpose = form_purpose(f)
            if purpose in ("search", "filter"):
                continue
            key = f"{purpose}:{p.path}"
            if key in seen_forms:
                continue
            seen_forms.add(key)
            gaps.append(
                {
                    "area": f"{form_display_name(f)} form ({p.path})",
                    "reason": "Not performed: destructive or transactional action",
                    "description": f"The {form_display_name(f).lower()} form on {p.path} was not submitted; its validation, "
                    "confirmation and resulting data changes were not observed.",
                    "suggestion": "Requires explicit approval in a later phase",
                    "evidence_refs": [r.model_dump(mode="json") for r in _refs(p, f.selector, f.html)],
                }
            )
        for c in p.components:
            if c.kind == "button" and (
                c.details.get("destructive") or (c.details.get("transactional") and not c.details.get("in_form"))
            ):
                gaps.append(
                    {
                        "area": f"'{c.name[:60]}' button ({p.path})",
                        "reason": "Not performed: destructive or transactional action",
                        "description": f"'{c.name[:60]}' was not clicked; destructive and transactional actions are never performed.",
                        "suggestion": "Requires explicit approval in a later phase",
                        "evidence_refs": [r.model_dump(mode="json") for r in _refs(p, c.selector, c.html)],
                    }
                )
    if not_visited:
        links = f"{not_visited} discovered link{'s were' if not_visited != 1 else ' was'} not visited"
        reason, description, suggestion = {
            "page_limit": (
                "Not visited: page limit",
                f"The page limit of {max_pages} was reached; {links}.",
                "Re-scan with a higher limit",
            ),
            "cancelled": ("Not visited: discovery cancelled", f"Discovery was cancelled; {links}.", "Re-run discovery"),
            "timeout": ("Not visited: time limit", f"Discovery reached its time limit; {links}.", "Re-run discovery"),
        }.get(
            stop_reason,
            ("Not visited: discovery stopped early", f"Discovery stopped early; {links}.", "Re-run discovery"),
        )
        gaps.append(
            {
                "area": f"{not_visited} more page{'s' if not_visited != 1 else ''}",
                "reason": reason,
                "description": description,
                "suggestion": suggestion,
                "evidence_refs": [],
            }
        )
    if robots_skipped:
        gaps.append(
            {
                "area": f"{len(robots_skipped)} page{'s' if len(robots_skipped) != 1 else ''}",
                "reason": "Not visited: robots.txt",
                "description": "robots.txt disallows these paths for automated agents: "
                + ", ".join(robots_skipped[:5]),
                "suggestion": "Allow the scanner in robots.txt or turn off 'Respect robots.txt'",
                "evidence_refs": [],
            }
        )
    destructive_links = [s for s in skipped_links if s.get("reason") in ("would end the session", "destructive action")]
    if destructive_links:
        gaps.append(
            {
                "area": ", ".join(path_of(s["url"]) for s in destructive_links[:4]),
                "reason": "Not performed: destructive or transactional action",
                "description": "Links that sign out, delete or unsubscribe were not followed on purpose.",
                "suggestion": "Requires explicit approval in a later phase",
                "evidence_refs": [],
            }
        )
    if bot_protection:
        gaps.append(
            {
                "area": "Site",
                "reason": "Blocked by bot protection",
                "description": "A bot-protection check (CAPTCHA or challenge) was detected; some pages may be incomplete.",
                "suggestion": "Allowlist the scanner or provide a test environment",
                "evidence_refs": [],
            }
        )
    return gaps


def responsive_observations(pages: list[dict[str, Any]]) -> list[str]:
    """`pages`: [{path, responsive: {desktop: {...}, mobile: {...}}}] -> sentences."""
    out: list[str] = []
    for p in pages:
        r = p.get("responsive") or {}
        mob = r.get("mobile")
        desk = r.get("desktop")
        if not mob:
            continue
        if mob.get("nav_collapsed") and not (desk or {}).get("nav_collapsed"):
            out.append(f"{p['path']}: navigation collapses into a menu button at 390 px.")
        if mob.get("horizontal_overflow"):
            out.append(f"{p['path']}: content is wider than the screen at 390 px (horizontal scrolling).")
    return out
