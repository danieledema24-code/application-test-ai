"""QA P6-01: independent probes of the change diff (decision D26), beyond the developer's test_p6_change_diff.py.

Covers: auth_context separating pages, fingerprint ties (duplicate controls), rename/move/add ordering when one name is
both a rename candidate and a move candidate, the noise filter not hiding a real change (constraint, required, nav
renames with digits, a rename that also changes words), cancelled and blocked target scans (pages they never loaded
must not be reported as removed: design P6 §20 OQ2), journeys through pages a partial scan never reached, and the
re-baseline boundary.
"""

from __future__ import annotations

import hashlib
from typing import Any

import pytest

from app.domain.change import diff as d
from app.domain.enums import ChangeKind as K
from app.domain.enums import ChangeSignificance as S

BASE = "http://shop.test"
NAV = [{"text": "Home", "href": f"{BASE}/"}, {"text": "Contact", "href": f"{BASE}/contact"}]


def comp(kind: str, name: str, selector: str, role: str | None = "button") -> dict[str, Any]:
    fp = hashlib.sha1(f"{kind}|{role}|{name.lower()}|{selector}".encode(), usedforsecurity=False).hexdigest()[:16]
    return {"kind": kind, "role": role, "name": name, "fingerprint": fp, "details": {"selector": selector}}


def page(path: str, **kw: Any) -> d.PageSnap:
    url = f"{BASE}{path}"
    kw.setdefault("nav_links", NAV)
    kw.setdefault("headings", [path.strip("/").title() or "Home"])
    return d.PageSnap(id=f"id{path}{kw.get('auth_context', '')}", url=url,
                      url_hash=hashlib.sha256(url.encode()).hexdigest(), **kw)  # fmt: skip


def scan(
    n: int, *pages: d.PageSnap, status: str = "completed", journeys: list[d.JourneySnap] | None = None
) -> d.ScanSnap:
    return d.ScanSnap(number=n, status=status, pages=list(pages), journeys=journeys or [])


def kinds(r: d.DiffResult) -> list[tuple[str, str, str]]:
    return [(i.kind.value, i.significance.value, d.describe(i)) for i in r.items]


# ------------------------------------------------------------------ pages


def test_qa_same_url_different_auth_context_are_different_pages() -> None:
    r = d.diff_scans(scan(1, page("/account")), scan(2, page("/account", auth_context="authenticated")))
    assert sorted(i.kind.value for i in r.items) == ["page_added", "page_removed"]


def test_qa_same_url_both_contexts_each_matched_with_its_own_context() -> None:
    b = scan(1, page("/a", headings=["Anon"]), page("/a", auth_context="authenticated", headings=["Signed"]))
    t = scan(2, page("/a", headings=["Anon"]), page("/a", auth_context="authenticated", headings=["Signed in"]))
    r = d.diff_scans(b, t)
    assert kinds(r) == [("page_changed", "cosmetic", "Headings changed on /a: Signed → Signed in")]


def test_qa_cancelled_target_never_reports_unreached_pages_as_removed() -> None:
    """Design P6 §20 OQ2 (lead decision 2): pages a partial *or cancelled* rescan didn't reach are 'Not compared'."""
    b = scan(1, page("/"), page("/about"), page("/contact"))
    t = scan(2, page("/"), status="cancelled")
    r = d.diff_scans(b, t)
    assert [i.kind for i in r.items if i.kind == K.page_removed] == [], kinds(r)
    assert {n["page"] for n in r.not_compared} == {"/about", "/contact"}


def test_qa_page_blocked_in_target_is_not_removed() -> None:
    """A page the rescan saw but didn't load (blocked) was not compared; calling it removed is false."""
    r = d.diff_scans(scan(1, page("/"), page("/x")), scan(2, page("/"), page("/x", status="blocked")))
    assert [i for i in r.items if i.kind == K.page_removed] == [], kinds(r)


# ------------------------------------------------------------------ elements


def test_qa_duplicate_identical_controls_tie_is_not_a_change() -> None:
    two = [comp("button", "Buy", "main button"), comp("button", "Buy", "main button")]
    r = d.diff_scans(scan(1, page("/p", components=two)), scan(2, page("/p", components=two[:1])))
    assert r.items == []  # same role, name and selector are indistinguishable


def test_qa_rename_is_tried_before_move() -> None:
    # "Send" keeps its selector but gets a new name; another "Send message" appears elsewhere: rename wins first.
    b = [comp("button", "Send message", "form > button")]
    t = [comp("button", "Send", "form > button"), comp("button", "Send message", "footer > button")]
    r = d.diff_scans(scan(1, page("/c", components=b)), scan(2, page("/c", components=t)))
    assert kinds(r) == [
        ("element_added", "structural", "Button added: Send message"),
        ("element_renamed", "behavioural", "Button renamed: Send message → Send"),
    ]


def test_qa_two_moves_with_the_same_name_are_not_guessed() -> None:
    b = [comp("button", "Edit", "#a"), comp("button", "Edit", "#b")]
    t = [comp("button", "Edit", "#c"), comp("button", "Edit", "#d")]
    r = d.diff_scans(scan(1, page("/p", components=b)), scan(2, page("/p", components=t)))
    assert sorted(i.kind.value for i in r.items) == ["element_added"] * 2 + ["element_removed"] * 2


def test_qa_role_differs_is_not_a_rename_or_move() -> None:
    b = [comp("button", "Open", "#x", role="button")]
    t = [comp("button", "Open", "#x", role="link")]
    r = d.diff_scans(scan(1, page("/p", components=b)), scan(2, page("/p", components=t)))
    assert sorted(i.kind.value for i in r.items) == ["element_added", "element_removed"]


def test_qa_move_behavioural_when_the_old_selector_is_used() -> None:
    b = [comp("button", "Add", "#old")]
    t = [comp("button", "Add", "#new")]
    r = d.diff_scans(scan(1, page("/p", components=b)), scan(2, page("/p", components=t)), used_selectors={"#old"})
    assert [(i.kind, i.significance) for i in r.items] == [(K.element_moved, S.behavioural)]
    r2 = d.diff_scans(scan(1, page("/p", components=b)), scan(2, page("/p", components=t)), used_selectors={"#new"})
    assert [(i.kind, i.significance) for i in r2.items] == [(K.element_moved, S.cosmetic)]


# ------------------------------------------------------------------ the noise filter never hides a real change


def test_qa_rename_with_words_and_digits_is_a_rename() -> None:
    b = [comp("button", "Buy for £10", "#b")]
    t = [comp("button", "Pre-order for £12", "#b")]
    r = d.diff_scans(scan(1, page("/p", components=b)), scan(2, page("/p", components=t)))
    assert [(i.kind, i.significance) for i in r.items] == [(K.element_renamed, S.behavioural)]


def test_qa_digit_label_change_with_a_constraint_change_stays_structural() -> None:
    f1 = {"name": "age", "label": "Age (18+)", "type": "number", "required": False, "constraints": {"min": 18}}
    f2 = {"name": "age", "label": "Age (21+)", "type": "number", "required": False, "constraints": {"min": 21}}
    mk = lambda f: {"method": "POST", "action": f"{BASE}/join", "submit_label": "Join", "fields": [f]}  # noqa: E731
    r = d.diff_scans(scan(1, page("/j", forms=[mk(f1)])), scan(2, page("/j", forms=[mk(f2)])))
    assert [(i.kind, i.significance) for i in r.items] == [(K.field_changed, S.structural)]
    assert r.summary["content_values"] == 0


def test_qa_required_change_with_a_digit_label_is_not_hidden() -> None:
    f1 = {"name": "q", "label": "Quantity (max 5)", "type": "number", "required": False}
    f2 = {"name": "q", "label": "Quantity (max 9)", "type": "number", "required": True}
    mk = lambda f: {"method": "POST", "action": f"{BASE}/b", "submit_label": "Add", "fields": [f]}  # noqa: E731
    r = d.diff_scans(scan(1, page("/b", forms=[mk(f1)])), scan(2, page("/b", forms=[mk(f2)])))
    assert [(i.kind, i.significance) for i in r.items] == [(K.field_changed, S.structural)]


def test_qa_nav_rename_with_digits_is_still_a_navigation_change() -> None:
    nav2 = [{"text": "Home", "href": f"{BASE}/"}, {"text": "Contact 24/7", "href": f"{BASE}/contact"}]
    nav1 = [{"text": "Home", "href": f"{BASE}/"}, {"text": "Contact 9/5", "href": f"{BASE}/contact"}]
    r = d.diff_scans(scan(1, page("/", nav_links=nav1)), scan(2, page("/", nav_links=nav2)))
    assert [(i.kind, i.significance) for i in r.items] == [(K.navigation_changed, S.behavioural)]


def test_qa_values_only_submit_button_counted_once_in_content_values() -> None:
    """A submit button "Pay £10" → "Pay £12": the element pair and the form's submit label are the same thing."""
    b = page("/pay", components=[comp("button", "Pay £10", "form > button")],
             forms=[{"method": "POST", "action": f"{BASE}/pay", "submit_label": "Pay £10", "fields": []}])  # fmt: skip
    t = page("/pay", components=[comp("button", "Pay £12", "form > button")],
             forms=[{"method": "POST", "action": f"{BASE}/pay", "submit_label": "Pay £12", "fields": []}])  # fmt: skip
    r = d.diff_scans(scan(1, b), scan(2, t))
    assert len(r.items) == 1 and d.is_content_values(r.items[0])
    assert r.items[0].after is not None
    assert r.items[0].after["values"] == ["Pay £12"], r.items[0].after  # listed once, not twice


# ------------------------------------------------------------------ journeys and partial scans


def test_qa_journey_through_an_unreached_page_is_not_changed_on_a_partial_target() -> None:
    step = d.JourneyStepSnap
    j1 = d.JourneySnap("Contact us", [step(f"{BASE}/", "Open Home"), step(f"{BASE}/contact", "Open Contact")])
    j2 = d.JourneySnap("Contact us", [step(f"{BASE}/", "Open Home")])  # the partial scan stopped before /contact
    r = d.diff_scans(scan(1, page("/"), page("/contact"), journeys=[j1]),
                     scan(2, page("/"), status="partial", journeys=[j2]))  # fmt: skip
    assert [i.kind for i in r.items] == [], kinds(r)


# ------------------------------------------------------------------ re-baseline boundary


@pytest.mark.parametrize(("removed", "expected"), [(2, False), (3, True)])
def test_qa_rebaseline_boundary(removed: int, expected: bool) -> None:
    five = [page(f"/p{i}") for i in range(5)]
    r = d.diff_scans(scan(1, *five), scan(2, *five[removed:], page("/new1"), page("/new2"), page("/new3")))
    assert r.rebaseline_suggested is expected  # added pages never count
