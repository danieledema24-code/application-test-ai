"""P6-01 change detection in code (decision D26): page matching, the element matcher (fingerprint → rename → move →
added/removed), links, forms and fields, navigation, journeys, the noise filter ("Content values changed"), the fixed
significance, partial scans ("Not compared"), the re-baseline suggestion (D27), the plain-words subjects, the
`requirement_changed` items and the AI summary's placeholder rule."""

from __future__ import annotations

import hashlib
from typing import Any

import pytest

from app.domain.change import diff as d
from app.domain.enums import ChangeKind as K
from app.domain.enums import ChangeSignificance as S
from app.services.changes import fill_summary

BASE = "http://shop.test"
NAV = [{"text": "Home", "href": f"{BASE}/"}, {"text": "Contact", "href": f"{BASE}/contact"}]


def comp(kind: str, name: str, selector: str, role: str | None = "button") -> dict[str, Any]:
    fp = hashlib.sha1(f"{kind}|{role}|{name.lower()}|{selector}".encode(), usedforsecurity=False).hexdigest()[:16]
    return {"kind": kind, "role": role, "name": name, "locator": f"getByRole('{role}', {{ name: '{name}' }})",
            "fingerprint": fp, "details": {"selector": selector}}  # fmt: skip


def field(name: str, label: str, *, required: bool = False, type_: str = "text", **constraints: Any) -> dict[str, Any]:
    return {"name": name, "label": label, "type": type_, "required": required, "constraints": constraints}


def form(*fields: dict[str, Any], submit: str = "Send", action: str = "/contact", purpose: str = "other") -> dict:  # type: ignore[type-arg]
    return {"name": None, "method": "POST", "action": f"{BASE}{action}", "submit_label": submit, "fields": list(fields),
            "purpose_guess": purpose}  # fmt: skip


def page(path: str, **kw: Any) -> d.PageSnap:
    url = f"{BASE}{path}"
    kw.setdefault("nav_links", NAV)
    kw.setdefault("headings", [path.strip("/").title() or "Home"])
    return d.PageSnap(id=f"id{path}", url=url, url_hash=hashlib.sha256(url.encode()).hexdigest(), **kw)


def scan(
    n: int, *pages: d.PageSnap, status: str = "completed", journeys: list[d.JourneySnap] | None = None
) -> d.ScanSnap:
    return d.ScanSnap(number=n, status=status, pages=list(pages), journeys=journeys or [])


def kinds(result: d.DiffResult) -> list[tuple[str, str, str]]:
    return [(i.kind.value, i.significance.value, d.describe(i)) for i in result.items]


# ------------------------------------------------------------------ pages


def test_identical_scans_have_no_items() -> None:
    p = page("/contact", components=[comp("button", "Send", "main > form > button")], forms=[form(field("m", "M"))])
    r = d.diff_scans(scan(1, page("/"), p), scan(2, page("/"), p))
    assert r.items == [] and r.not_compared == [] and not r.rebaseline_suggested
    assert r.summary["total"] == 0 and r.summary["pages"]["changed"] == 0


def test_pages_matched_by_url_hash_and_auth_context() -> None:
    anon = page("/account")
    signed_in = page("/account", auth_context="authenticated")
    r = d.diff_scans(scan(1, page("/"), anon), scan(2, page("/"), signed_in))
    assert kinds(r) == [
        ("page_added", "structural", "Page added: /account"),
        ("page_removed", "structural", "Page removed: /account"),
    ]


def test_added_page_lists_its_forms_and_removed_page_its_forms() -> None:
    offers = page("/offers", forms=[form(field("code", "Promo code"), submit="Apply code", action="/offers/apply")])
    old = page("/old", forms=[form(field("q", "Search"), action="/search", purpose="search")])
    r = d.diff_scans(scan(1, page("/"), old), scan(2, page("/"), offers))
    assert ("form_added", "structural", "Form added: Promo code") in kinds(r)
    assert ("form_removed", "structural", "Form removed: Search form") in kinds(r)
    added = next(i for i in r.items if i.kind == K.page_added)
    assert added.before_ref is None and added.after_ref and added.after_ref["page_id"] == "id/offers"


def test_status_code_change_is_structural_page_changed() -> None:
    r = d.diff_scans(scan(1, page("/"), page("/p", http_status=200)), scan(2, page("/"), page("/p", http_status=500)))
    assert kinds(r) == [("page_changed", "structural", "Page changed: /p now answers 500 (was 200)")]


def test_heading_change_is_cosmetic() -> None:
    r = d.diff_scans(scan(1, page("/about", headings=["About"])), scan(2, page("/about", headings=["About us"])))
    assert kinds(r) == [("page_changed", "cosmetic", "Headings changed on /about: About → About us")]


# ------------------------------------------------------------------ the element matcher (D26)


def test_rename_same_kind_role_selector() -> None:
    b = page("/contact", components=[comp("button", "Send message", "main > form > button")])
    a = page("/contact", components=[comp("button", "Send", "main > form > button")])
    r = d.diff_scans(scan(1, b), scan(2, a))
    assert kinds(r) == [("element_renamed", "behavioural", "Button renamed: Send message → Send")]
    item = r.items[0]
    assert item.before and item.after and item.before["name"] == "Send message" and item.after["name"] == "Send"
    assert item.before_ref and item.before_ref["fingerprint"] != item.after_ref["fingerprint"]  # type: ignore[index]


def test_move_same_kind_role_name_is_cosmetic_unless_a_locator_uses_the_selector() -> None:
    b = page("/p/1", components=[comp("button", "Add to basket", "main > button")])
    a = page("/p/1", components=[comp("button", "Add to basket", "#add-to-basket")])
    r = d.diff_scans(scan(1, b), scan(2, a))
    assert kinds(r) == [("element_moved", "cosmetic", "Button moved: Add to basket")]
    used = d.diff_scans(scan(1, b), scan(2, a), used_selectors={"main > button"})
    assert kinds(used) == [("element_moved", "behavioural", "Button moved: Add to basket")]


def test_renamed_and_moved_is_removed_plus_added() -> None:
    b = page("/c", components=[comp("button", "Opening hours", "main > button")])
    a = page("/c", components=[comp("button", "Hours", "#hours")])
    assert [k for k, _, _ in kinds(d.diff_scans(scan(1, b), scan(2, a)))] == ["element_added", "element_removed"]


def test_ambiguous_rename_is_never_guessed() -> None:
    b = page("/c", components=[comp("button", "Opening hours", "main > button"),
                               comp("modal", "Opening hours", "main > button")])  # fmt: skip
    a = page("/c", components=[comp("button", "Opening times", "main > button:nth-of-type(1)"),
                               comp("button", "Opening days", "main > button:nth-of-type(2)")])  # fmt: skip
    r = d.diff_scans(scan(1, b), scan(2, a))
    # The trigger discovered twice (button and dialog opener) counts once; two candidates pair with nothing.
    assert sorted(kinds(r)) == [
        ("element_added", "structural", "Button added: Opening days"),
        ("element_added", "structural", "Button added: Opening times"),
        ("element_removed", "structural", "Button removed: Opening hours"),
    ]


def test_unchanged_fingerprints_produce_nothing_even_when_reordered() -> None:
    x, y = comp("button", "A", "#a"), comp("button", "B", "#b")
    assert d.diff_scans(scan(1, page("/", components=[x, y])), scan(2, page("/", components=[y, x]))).items == []


def test_links_outside_navigation_are_compared_by_path_and_named_after_their_page() -> None:
    mug = page("/products/1", headings=["Travel mug"])
    lamp = page("/products/2", headings=["Desk lamp"])
    b = page("/products", links=[f"{BASE}/", f"{BASE}/contact", f"{BASE}/products/1", f"{BASE}/products/2"])
    a = page("/products", links=[f"{BASE}/", f"{BASE}/contact", f"{BASE}/products/2"])
    r = d.diff_scans(scan(1, b, mug, lamp), scan(2, a, lamp))
    assert kinds(r) == [
        ("page_removed", "structural", "Page removed: /products/1"),
        ("element_removed", "structural", "Link removed: Travel mug"),
    ]


# ------------------------------------------------------------------ forms and fields


def test_contact_form_changes_like_the_demo() -> None:
    b = page("/contact", forms=[form(field("name", "Name", required=True), field("message", "Message"),
                                     submit="Send message", purpose="contact")],
             components=[comp("button", "Send message", "main > form > button")])  # fmt: skip
    a = page("/contact", forms=[form(field("name", "Name", required=True),
                                     field("message", "Your message", required=True),
                                     field("order", "Order number", maxlength=20), submit="Send", purpose="contact")],
             components=[comp("button", "Send", "main > form > button")])  # fmt: skip
    r = d.diff_scans(scan(1, b), scan(2, a))
    # The submit label is covered by the button rename: no separate form_changed item.
    assert kinds(r) == [
        ("element_renamed", "behavioural", "Button renamed: Send message → Send"),
        ("field_added", "structural", "Field added: Order number"),
        ("field_changed", "structural", "Field changed: Message → Your message (now required)"),
    ]
    changed = next(i for i in r.items if i.kind == K.field_changed)
    assert changed.after and changed.after["changed"] == ["label", "required"]
    added = next(i for i in r.items if i.kind == K.field_added)
    assert added.after and added.after["constraints"] == {"maxlength": 20} and added.after["required"] is False


@pytest.mark.parametrize(
    ("before", "after", "significance"),
    [({"type_": "text"}, {"type_": "email"}, "structural"), ({"maxlength": 10}, {"maxlength": 20}, "structural"),
     ({}, {"pattern": "[0-9]+"}, "structural")],
)  # fmt: skip
def test_field_type_and_constraints_are_structural(before: dict, after: dict, significance: str) -> None:  # type: ignore[type-arg]
    r = d.diff_scans(scan(1, page("/c", forms=[form(field("x", "X", **before))])),
                     scan(2, page("/c", forms=[form(field("x", "X", **after))])))  # fmt: skip
    assert [(i.kind, i.significance.value) for i in r.items] == [(K.field_changed, significance)]


def test_label_only_change_is_behavioural_and_submit_label_change_is_a_form_change() -> None:
    r = d.diff_scans(scan(1, page("/c", forms=[form(field("x", "Email"), submit="Go")])),
                     scan(2, page("/c", forms=[form(field("x", "Email address"), submit="Send now")])))  # fmt: skip
    assert kinds(r) == [
        ("form_changed", "behavioural", "Form changed: Email address (submit button Go → Send now)"),
        ("field_changed", "behavioural", "Field changed: Email → Email address"),
    ]


def test_fields_removed_and_forms_matched_by_action_and_method() -> None:
    b = page("/c", forms=[form(field("a", "A"), field("b", "B"), action="/one"), form(field("q", "Q"), action="/two")])
    a = page("/c", forms=[form(field("a", "A"), action="/one")])
    r = d.diff_scans(scan(1, b), scan(2, a))
    assert kinds(r) == [("form_removed", "structural", "Form removed: Q"),
                        ("field_removed", "structural", "Field removed: B")]  # fmt: skip


# ------------------------------------------------------------------ noise filter


def test_price_change_is_content_values_not_a_rename() -> None:
    b = page("/products/1", headings=["Item 1", "Price: £12.50"], components=[comp("button", "Buy £12.50", "#buy")])
    a = page("/products/1", headings=["Item 1", "Price: £13.00"], components=[comp("button", "Buy £13.00", "#buy")])
    r = d.diff_scans(scan(1, b), scan(2, a))
    assert kinds(r) == [("page_changed", "cosmetic", "Content values changed on /products/1 (2)")]
    item = r.items[0]
    assert d.is_content_values(item)
    assert item.before and item.after
    assert item.before["values"] == ["Buy £12.50", "Price: £12.50"] and item.after["values"][1] == "Price: £13.00"
    assert r.summary["content_values"] == 1 and r.summary["by_significance"]["cosmetic"] == 1


@pytest.mark.parametrize(
    ("a", "b", "noise"),
    [("£12.50", "£13.00", True), ("40 in stock", "39 in stock", True), ("Item 1", "Item 2", True),
     ("10 EUR", "12 EUR", True), ("$1,299", "$1,349.99", True), ("Send message", "Send", False),
     ("About", "About us", False), ("Page 1", "Page 1", False), ("Total", "Total 3", False)],
)  # fmt: skip
def test_values_only(a: str, b: str, noise: bool) -> None:
    assert d.values_only(a, b) is noise


# ------------------------------------------------------------------ navigation and journeys


def test_navigation_link_added_is_one_behavioural_item_and_not_repeated_per_page() -> None:
    nav2 = [*NAV, {"text": "Offers", "href": f"{BASE}/offers"}]
    b = [page("/", links=[f"{BASE}/contact"]), page("/contact")]
    a = [page("/", nav_links=nav2, links=[f"{BASE}/contact", f"{BASE}/offers"]), page("/contact", nav_links=nav2),
         page("/offers", nav_links=nav2)]  # fmt: skip
    r = d.diff_scans(scan(1, *b), scan(2, *a))
    assert kinds(r) == [("page_added", "structural", "Page added: /offers"),
                        ("navigation_changed", "behavioural", "Navigation changed: 'Offers' added")]  # fmt: skip
    nav = r.items[1]
    assert nav.page_url is None and nav.after and nav.after["added"] == [{"text": "Offers", "href": "/offers"}]


def _journey(name: str, *steps: tuple[str, str, str]) -> d.JourneySnap:
    return d.JourneySnap(name, [d.JourneyStepSnap(f"{BASE}{p}", action, label) for p, action, label in steps])


def test_journeys_matched_by_name_and_start_and_compared_by_steps() -> None:
    contact = ("Contact the company", ("/", "Open Home", "observed"), ("/contact", "Go to Contact", "observed"))
    b_contact = _journey(*contact, ("/contact", "Submit 'Send message' (not performed: read-only)", "inferred"))
    a_contact = _journey(*contact, ("/contact", "Submit 'Send' (not performed: read-only)", "inferred"))
    # The browse journey now ends on another product: numbers in paths and navigation step names are ignored.
    b_browse = _journey(
        "Browse items and view details",
        ("/", "Open Home", "observed"),
        ("/products", "Go to Products", "observed"),
        ("/products/1", "Go to Travel mug", "observed"),
    )
    a_browse = _journey(
        "Browse items and view details",
        ("/", "Open Home", "observed"),
        ("/products", "Go to Products", "observed"),
        ("/products/2", "Go to Desk lamp", "observed"),
    )
    gone = _journey("Sign in", ("/", "Open Home", "observed"), ("/login", "Go to Sign in", "observed"))
    pages = [page("/"), page("/contact"), page("/login")]
    r = d.diff_scans(scan(1, *pages, journeys=[b_contact, b_browse, gone]),
                     scan(2, *pages, journeys=[a_contact, a_browse]))  # fmt: skip
    assert kinds(r) == [("journey_removed", "behavioural", "Journey removed: Sign in"),
                        ("journey_changed", "behavioural", "Journey changed: Contact the company")]  # fmt: skip
    changed = r.items[1]
    assert changed.after and changed.after["steps"][-1] == "Submit 'Send' (not performed: read-only)"


# ------------------------------------------------------------------ partial scans, re-baseline


def test_partial_target_lists_unreached_pages_as_not_compared() -> None:
    sign_in = _journey("Sign in", ("/login", "Open Sign in", "observed"))
    b = scan(1, page("/"), page("/login"), page("/about"), journeys=[sign_in])
    t = scan(3, page("/"), status="partial")
    r = d.diff_scans(b, t)
    assert r.items == [] and not r.rebaseline_suggested
    assert [(n["page"], n["missing_from"]) for n in r.not_compared] == [("/about", "target"), ("/login", "target")]
    assert r.not_compared[0]["reason"] == "Scan 3 stopped early and didn't reach this page"
    assert r.summary["pages"]["not_compared"] == 2 and r.summary["not_compared"] == r.not_compared
    # A partial baseline: pages only the new scan has are not "added" either.
    r2 = d.diff_scans(scan(1, page("/"), status="partial"), scan(2, page("/"), page("/new")))
    assert r2.items == [] and r2.not_compared[0]["missing_from"] == "base"


def test_rebaseline_suggested_when_more_than_half_the_baseline_pages_changed() -> None:
    four = [page(f"/p{i}") for i in range(4)]
    two_removed = d.diff_scans(scan(1, *four), scan(2, *four[:2]))
    assert not two_removed.rebaseline_suggested  # exactly half
    three = d.diff_scans(scan(1, *four), scan(2, four[0], page("/p1", http_status=404)))
    assert three.rebaseline_suggested  # 2 removed + 1 structurally changed of 4
    cosmetic = d.diff_scans(scan(1, *four), scan(2, *[page(p.path, headings=["New"]) for p in four]))
    assert not cosmetic.rebaseline_suggested  # headings only


def test_summary_counts_by_kind_and_significance() -> None:
    r = d.diff_scans(scan(1, page("/"), page("/old")), scan(2, page("/", headings=["Welcome"]), page("/new")))
    assert r.summary["total"] == 3
    assert r.summary["by_significance"] == {"structural": 2, "behavioural": 0, "cosmetic": 1}
    assert r.summary["by_kind"] == {"page_added": 1, "page_changed": 1, "page_removed": 1}
    assert r.summary["pages"] == {"baseline": 2, "target": 2, "added": 1, "removed": 1, "changed": 1,
                                  "not_compared": 0, "structural": 0, "baseline_compared": 2}  # fmt: skip


def test_blocked_pages_are_not_compared_at_all() -> None:
    r = d.diff_scans(scan(1, page("/"), page("/x", status="blocked")), scan(2, page("/")))
    assert r.items == []


# ------------------------------------------------------------------ requirements and the AI summary rule


def test_requirement_changes_from_an_applied_regeneration() -> None:
    diff = {"added": ["REQ-0009", "AC-0040"], "changed": ["REQ-0007"], "rejected_as_no_longer_found": ["REQ-0003"]}
    items = d.requirement_changes(diff, {"REQ-0007": "Contact form", "REQ-0009": "Offers"})
    assert [(i.kind, i.significance, d.describe(i)) for i in items] == [
        (K.requirement_changed, S.structural, "Requirement added: REQ-0009 Offers"),
        (K.requirement_changed, S.behavioural, "Requirement changed: REQ-0007 Contact form"),
        (K.requirement_changed, S.structural, "Requirement removed: REQ-0003"),
    ]


SUMMARY = {"total": 9, "by_significance": {"structural": 4, "behavioural": 4, "cosmetic": 1},
           "pages": {"added": 1, "removed": 1}}  # fmt: skip


@pytest.mark.parametrize(
    ("text", "expected"),
    [("The contact form changed: {total} changes, {structural} structural.",
      "The contact form changed: 9 changes, 4 structural."),
     ("{pages_added} page was added and {pages_removed} removed.", "1 page was added and 1 removed."),
     ("The site changed in 12 places.", None),  # a number the model wrote itself
     ("{total} changes, {secret} hidden.", None)],  # an unknown placeholder
)  # fmt: skip
def test_ai_summary_numbers_are_placeholders(text: str, expected: str | None) -> None:
    assert fill_summary(text, SUMMARY) == expected
