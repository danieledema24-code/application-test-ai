"""QA probes for the P6-03a pure parts: allow-list edge cases, oracles, budget wording."""

from __future__ import annotations

from collections import Counter

import pytest

from app.domain.exploratory import actions as act
from app.domain.exploratory import limits as lim
from app.domain.exploratory import oracles as orc

ORIGIN = "https://shop.example"
PAGE = "https://shop.example/offers"


def el(name: str, tag: str = "button", role: str = "button", **kw: object) -> act.Element:
    return act.Element(selector=kw.pop("selector", f"#x{abs(hash(name))}"), tag=tag, role=role, name=name, **kw)  # type: ignore[arg-type]


def link(name: str, href: str, **kw: object) -> act.Element:
    return el(name, tag="a", role="link", href=href, **kw)


@pytest.mark.parametrize(
    ("element", "kind"),
    [
        (el("Place order"), None),
        (el("Order now"), None),
        (el("Remove from basket"), None),
        (el("Log off"), None),
        (el("Logout"), None),
        (el("Sign Out"), None),
        (el("Unsubscribe me"), None),
        (el("Confirm"), None),
        (el("save"), None),
        (el("Send"), None),
        (el("My orders"), "click"),  # "orders" isn't the word "order"
        (el("Sending options"), "click"),
        (el("Payments"), "click"),
        (el("Show details"), "click"),
        (el("Add to basket"), "click"),  # not in the vocabulary: the network guard is what blocks its POST
        (el("Next", type="submit", in_form=True), None),
        (el("Next", type="SUBMIT".lower(), in_form=True), None),
        (el("Go", tag="input", role="button", type="image", in_form=True), None),
        (el("Clear", tag="input", role="button", type="reset", in_form=True), None),
        (el("Expand", tag="summary", role="button", in_form=True), "click"),
        (link("Partner", "https://shop.example:8443/x"), None),  # another port is another origin
        (link("Same", "https://SHOP.example:443/a"), "link"),  # default port, case-insensitive host
        (link("Data", "data:text/html,hi"), None),
        (link("File", "file:///etc/passwd"), None),
        (link("Ftp", "ftp://shop.example/x"), None),
    ],
)
def test_allow_list_edges(element: act.Element, kind: str | None) -> None:
    got, _reason = act.classify(element, ORIGIN)
    assert got == kind


def test_invalid_button_type_in_form_is_a_submit() -> None:
    """HTML: a <button> with an unknown `type` in a form is a submit button (missing value default = submit)."""
    got, reason = act.classify(el("Next", type="foo", in_form=True), ORIGIN)
    assert (got, reason) == (None, act.SUBMITS_FORM)


def test_never_click_names_and_ids_unique_and_choice_hides_selectors() -> None:
    pa = act.compute_actions(
        [
            el("Details"),
            el("Account menu"),
            link("Shop", "https://shop.example/shop"),
            link("Shop again", "https://shop.example/shop"),
        ],
        PAGE,
        ORIGIN,
        never_click=["account menu"],
    )
    ids = [a.id for a in pa.allowed]
    assert len(ids) == len(set(ids))
    assert [a.name for a in act.element_actions(pa)] == ["Details", "Shop"]  # link deduped by destination
    assert any(n.name == "Account menu" and n.reason == act.ENDS_SESSION for n in pa.not_tried)
    for a in pa.allowed:
        assert set(a.choice()) == {"id", "kind", "role", "name"}


def test_link_to_same_page_is_ignored_not_listed() -> None:
    pa = act.compute_actions([link("Top", PAGE + "#top")], PAGE, ORIGIN)
    assert act.element_actions(pa) == [] and pa.not_tried == []


def _obs(**kw: object) -> orc.ActionObservation:
    before = kw.pop("before", orc.PageState(url=PAGE))
    after = kw.pop("after", orc.PageState(url=PAGE))
    return orc.ActionObservation(before=before, after=after, action='clicking button "X"', **kw)  # type: ignore[arg-type]


def test_oracles_severity_and_block_side_effects() -> None:
    p = orc.evaluate(_obs(responses=[("GET", PAGE + "/api", 503), ("GET", PAGE + "/b", 503), ("GET", PAGE, 200)]))
    assert [(x.rule, x.severity) for x in p] == [("server_error", "high")]
    # "Failed to fetch" after a blocked write is not a problem; without a block it is.
    blocked = orc.evaluate(_obs(page_errors=["TypeError: Failed to fetch"], blocked=[("POST", PAGE)]))
    assert blocked == []
    alone = orc.evaluate(_obs(page_errors=["TypeError: Failed to fetch"]))
    assert [x.rule for x in alone] == ["uncaught_exception"]
    # Pre-existing broken text isn't reported again; new occurrences are.
    same = orc.evaluate(_obs(before=orc.PageState(url=PAGE, tokens=Counter({"NaN": 1})),
                             after=orc.PageState(url=PAGE, tokens=Counter({"NaN": 1}))))  # fmt: skip
    assert same == []
    assert orc.broken_tokens("Price: £NaN; null; nullable; undefined-ish; [object Object]") == Counter(
        {"NaN": 1, "null": 1, "[object Object]": 1}
    )
    # 410 is a missing page too; 401 is not.
    assert [x.rule for x in orc.evaluate(_obs(nav_status=410))] == ["not_found"]
    assert orc.evaluate(_obs(nav_status=401)) == []
    assert orc.outcome([orc.injection_problem(PAGE, "x")], False, False, False) == "no_effect"


def test_fingerprint_ignores_digits_but_not_rule_or_page() -> None:
    a = orc.Problem("uncaught_exception", "medium", "t", "o", "Error at line 12")
    b = orc.Problem("uncaught_exception", "medium", "t", "o", "Error at line 99")
    assert a.fingerprint(PAGE, "fp") == b.fingerprint(PAGE, "fp")
    assert a.fingerprint(PAGE, "fp") != a.fingerprint(ORIGIN + "/other", "fp")


def test_budget_messages_and_meter() -> None:
    cap = lim.Budget(200, 20)
    org = lim.Budget(60, 10)
    assert lim.budget_violations({"actions": 60, "minutes": 10}, org, cap) == []
    assert lim.budget_violations({"actions": 61, "minutes": 10}, org, cap)[0].message == (
        "Your organisation allows up to 60 actions."
    )
    one = lim.budget_violations({"actions": 2, "minutes": 2}, lim.Budget(1, 1), cap)
    assert [v.message for v in one] == [
        "Your organisation allows up to 1 action.",
        "Your organisation allows up to 1 minute.",
    ]
    srv = lim.budget_violations({"actions": 50, "minutes": 1}, org, lim.Budget(40, 20))
    assert srv[0].message == "This server allows up to 40 actions."
    m = lim.BudgetMeter(budget=lim.Budget(2, 1), started=0.0)
    assert m.take() == 1 and m.take() == 2 and m.spent(0.0) == lim.BUDGET_USED
    with pytest.raises(RuntimeError):
        m.take()
    assert lim.BudgetMeter(budget=lim.Budget(5, 1), started=0.0).spent(60.0) == lim.TIME_USED
    assert lim.statement(3, 1) == (
        "This session tried 3 actions on 1 pages within its budget. Exploration is a sample, not a complete test, "
        "and it never submits forms or sends data."
    )
