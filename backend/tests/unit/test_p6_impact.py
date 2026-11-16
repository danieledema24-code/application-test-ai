"""P6-02 impact mapping and regression selection (decisions D27, D28), as pure rules: the demo shop's CHG-0001 over a
small traceability model (Contact, Products and Navigation features; contact, product and navigation cases; the
contact scripts' page-object locators; DEF-0001; a finding and a load-test target on the removed page; a high risk).

Checks: direct / indirect / gap labels and their reasons, "Page removed: review" items, cosmetic changes affect
nothing, the must / should / excluded lists and their reasons, must-run tests stay must-run whatever their script, the
live re-check's "broken" rule (a partial match to a renamed element counts as not found), the locator expressions and
the AI ordering guard (no must-run dropped, no unknown test).
"""

from __future__ import annotations

from app.domain.change import impact as im
from app.domain.enums import ChangeKind as K
from app.domain.enums import ChangeSignificance as S
from app.domain.enums import ImpactAction as A
from app.domain.enums import ImpactLevel as L
from app.domain.enums import ImpactTargetKind as T

KEY = "CHG-0001"


def _field(label: str, required: bool = False) -> dict[str, object]:
    return {"form": "Contact form", "name": "message", "label": label, "type": "textarea", "required": required,
            "constraints": {}, "options": None}  # fmt: skip


def _button(name: str) -> dict[str, object]:
    return {"kind": "button", "role": "button", "name": name, "selector": "form > button", "locator": None}


def demo_changes() -> list[im.ChangeIn]:
    """CHG-0001 on the demo shop (roadmap demo chain step 2), plus one cosmetic heading change."""
    return [
        im.ChangeIn("c1", K.page_added, S.structural, "/offers", None, {"title": "Offers", "http_status": 200}),
        im.ChangeIn("c2", K.page_removed, S.structural, "/products/1", {"title": "Travel mug"}, None),
        im.ChangeIn(
            "c3",
            K.element_removed,
            S.structural,
            "/products",
            {"kind": "link", "role": "link", "name": "Travel mug", "href": "/products/1"},
            None,
        ),
        im.ChangeIn("c4", K.element_renamed, S.behavioural, "/contact", _button("Send message"), _button("Send")),
        im.ChangeIn(
            "c5", K.form_added, S.structural, "/offers", None, {"form": "Promo code", "fields": ["Promo code"]}
        ),
        im.ChangeIn(
            "c6",
            K.field_added,
            S.structural,
            "/contact",
            None,
            {**_field("Order number"), "constraints": {"maxlength": 20}},
        ),
        im.ChangeIn(
            "c7",
            K.field_changed,
            S.structural,
            "/contact",
            _field("Message"),
            {**_field("Your message", True), "changed": ["label", "required"]},
        ),
        im.ChangeIn(
            "c8",
            K.navigation_changed,
            S.behavioural,
            None,
            {"links": []},
            {"links": [], "added": [{"text": "Offers", "href": "/offers"}], "removed": [], "renamed": []},
        ),
        im.ChangeIn(
            "c9",
            K.journey_changed,
            S.behavioural,
            "/",
            {"name": "Contact the company", "steps": []},
            {"name": "Contact the company", "steps": []},
        ),
        im.ChangeIn("c10", K.page_changed, S.cosmetic, "/about", {"headings": ["About"]}, {"headings": ["About us"]}),
    ]


def _loc(getter: str, by: str, name: str, role: str = "", page: str = "/contact") -> im.LocatorIn:
    return im.LocatorIn("pages/ContactPage.ts", getter, page, by, name, role, element=name)


MESSAGE = _loc("message", "label", "Message")
NAME = _loc("name", "label", "Name")
SEND = _loc("sendMessageSubmit", "role", "Send message", "button")
FORM = im.LocatorIn("pages/ContactPage.ts", "form", "/contact", "form_button", "Send message",
                    element="Contact us form")  # fmt: skip


def demo_model() -> im.Model:
    features = {
        "f-contact": im.FeatureIn("f-contact", "FEAT-001", "Contact form", "form", frozenset({"/contact"})),
        "f-products": im.FeatureIn(
            "f-products", "FEAT-002", "Products", "commerce", frozenset({"/products", "/products/1", "/products/2"})
        ),
        "f-mug": im.FeatureIn("f-mug", "FEAT-003", "Travel mug page", "content", frozenset({"/products/1"})),
        "f-nav": im.FeatureIn("f-nav", "FEAT-004", "Main navigation", "navigation", frozenset({"/", "/about"})),
        "f-about": im.FeatureIn("f-about", "FEAT-005", "About", "content", frozenset({"/about"})),
    }
    reqs = [
        im.RequirementIn("r-contact", "REQ-0007", "Contact form requires name, email and message", ("f-contact",)),
        im.RequirementIn("r-nav", "REQ-0002", "Visitors can move between pages from the menu", ("f-nav",)),
        im.RequirementIn("r-products", "REQ-0004", "Products list prices", ("f-products",)),
        im.RequirementIn("r-mug", "REQ-0005", "The Travel mug page shows the mug", ("f-mug",)),
        im.RequirementIn("r-about", "REQ-0009", "About page explains the shop", ("f-about",)),
    ]
    cases = [
        im.CaseIn(
            "l19",
            "TC-0019",
            "Send the form with an empty Message",
            ("r-contact",),
            ("Open /contact", "Leave Message empty", "Press Send message", "Submission is blocked"),
        ),
        im.CaseIn(
            "l20",
            "TC-0020",
            "Send the form with a 1-character Name",
            ("r-contact",),
            ("Open /contact", "Enter {d0} in Name", "Press Send message"),
        ),
        im.CaseIn(
            "l21", "TC-0021", "Phone with letters: rejected", ("r-contact",), ("Open /contact", "Enter {d0} in Phone")
        ),
        im.CaseIn("l12", "TC-0012", "View the Travel mug page", ("r-mug",), ("Open /products/1",)),
        im.CaseIn("l30", "TC-0030", "Product list shows prices", ("r-products",), ("Open /products",)),
        im.CaseIn("l02", "TC-0002", "Move to Products from the menu", ("r-nav",), ("Open /", "Press Products")),
        im.CaseIn("l01", "TC-0001", "Home page loads", (), ("Open /",), test_type="smoke"),
        im.CaseIn("l40", "TC-0040", "About page loads", ("r-about",), ("Open /about",)),
    ]
    scripts = {
        "l19": im.ScriptIn("l19", "s19", "tests/contact/TC-0019.spec.ts", "valid", (MESSAGE, SEND, FORM)),
        "l20": im.ScriptIn("l20", "s20", "tests/contact/TC-0020.spec.ts", "valid", (NAME, SEND)),
        "l21": im.ScriptIn("l21", "s21", "tests/contact/TC-0021.spec.ts", "valid", (_loc("phone", "label", "Phone"),)),
    }
    return im.Model(
        features=features,
        requirements=reqs,
        cases=cases,
        scripts=scripts,
        defects=[
            im.DefectIn("d1", "DEF-0001", "Contact form accepts an empty Message", "major", "confirmed", ("l19",)),
            im.DefectIn("d2", "DEF-0002", "A draft about /contact", "minor", "draft", ("l20",)),
            im.DefectIn("d3", "DEF-0003", "Old bug on About", "minor", "verified", ("l40",)),
        ],
        findings=[
            im.FindingIn(
                "fa", "A11Y-0001-01", "Images must have a text alternative", "accessibility", "serious", "/products/1"
            ),
            im.FindingIn("fb", "A11Y-0001-02", "Form field has no label", "accessibility", "serious", "/contact"),
            im.FindingIn("fc", "A11Y-0001-03", "Heading order", "accessibility", "moderate", "/about"),
        ],
        perf_targets=[
            im.PerfTargetIn("p1", "PRF-01", "Browse", "/products/1"),
            im.PerfTargetIn("p1", "PRF-01", "Browse", "/products/2"),
        ],
        risks=[
            im.RiskIn("k1", "RISK-03", "Wrong prices", "high", "open", ("r-products",), ("f-products",)),
            im.RiskIn("k2", "RISK-04", "About page wrong", "very_high", "open", ("r-about",), ("f-about",)),
        ],
    )


def _by(items: list[im.Impact]) -> dict[tuple[T, str], im.Impact]:
    return {(i.target_kind, i.target_ref): i for i in items}


def test_demo_impact_labels_and_reasons() -> None:
    a = im.analyse(demo_changes(), demo_model(), set_key=KEY)
    by = _by(a.items)
    # The Contact requirement and its cases are direct.
    req = by[(T.requirement, "r-contact")]
    assert (req.level, req.action) == (L.direct, A.regenerate)
    assert req.reason.startswith("3 changes on /contact: ")
    assert req.reason.endswith('button "Send message" renamed; field "Message" changed; field "Order number" added')
    tc19 = by[(T.test_case, "l19")]
    assert (tc19.level, tc19.action) == (L.direct, A.rerun)
    assert tc19.reason == 'Directly affected: button "Send message" renamed; field "Message" changed'
    assert set(tc19.change_ids) == {"c4", "c7"}
    assert by[(T.test_case, "l20")].level == L.direct  # presses "Send message"
    # On the changed page, but no step or locator uses a changed element: indirect.
    tc21 = by[(T.test_case, "l21")]
    assert (tc21.level, tc21.action) == (L.indirect, A.rerun) and tc21.reason.startswith("Indirectly affected: ")
    # Navigation changed: the navigation requirement and its case are indirect.
    assert by[(T.requirement, "r-nav")].level == L.indirect
    assert by[(T.test_case, "l02")].level == L.indirect
    # Removed page: its case, finding and load-test target are "Page removed: review"; so is its requirement.
    assert by[(T.test_case, "l12")].action == A.review
    assert by[(T.test_case, "l12")].reason == "Page removed: /products/1. Review or retire TC-0012"
    assert by[(T.quality_finding, "fa")].reason.startswith("Page removed: /products/1")
    perf = by[(T.performance_target, "p1")]
    assert perf.action == A.review and perf.reason.startswith("Page removed: /products/1 is a target of PRF-01")
    assert by[(T.requirement, "r-mug")].action == A.review
    # A requirement with a removed page among others is indirect, to regenerate.
    assert (by[(T.requirement, "r-products")].level, by[(T.requirement, "r-products")].action) == (
        L.indirect,
        A.regenerate,
    )
    # A finding on a changed page is a review item too.
    assert by[(T.quality_finding, "fb")].reason == f"Page changed by {KEY}: check whether the finding still applies"
    # Gaps.
    gaps = [i for i in a.items if i.level == L.gap]
    assert [(i.target_ref, i.action, i.reason) for i in gaps] == [
        ("c1", A.write_requirement, "Not covered by any requirement: page /offers added"),
        ("c5", A.write_requirement, 'Not covered by any requirement: form "Promo code" added on /offers'),
    ]
    # Open defects only (confirmed or fixed; drafts and verified ones are not open).
    defect = by[(T.defect, "d1")]
    assert (defect.level, defect.action) == (L.direct, A.rerun)
    assert defect.reason == f"May be fixed or changed by {KEY}: re-test. Re-tested by TC-0019."
    assert (T.defect, "d2") not in by and (T.defect, "d3") not in by


def test_cosmetic_changes_affect_nothing() -> None:
    a = im.analyse(demo_changes(), demo_model(), set_key=KEY)
    by = _by(a.items)
    assert (T.requirement, "r-about") not in by
    assert (T.test_case, "l40") not in by and (T.quality_finding, "fc") not in by
    assert (T.test_case, "l01") not in by  # the smoke test opens "/" only: not impacted, still recommended (D28)
    only_cosmetic = [c for c in demo_changes() if c.significance == S.cosmetic]
    assert im.analyse(only_cosmetic, demo_model(), set_key=KEY).items == []


def test_regression_recommendation_must_should_excluded() -> None:
    model = demo_model()
    a = im.analyse(demo_changes(), model, set_key=KEY)
    rec = im.recommend(model, a)
    assert [p.key for p in rec.must] == ["TC-0019", "TC-0020"]
    assert rec.must[0].reasons == [
        'Directly affected: button "Send message" renamed; field "Message" changed',
        "Re-tests DEF-0001",
    ]
    should = {p.key: p.reasons for p in rec.should}
    # Risk first (very high, then high), then indirect (by key), then smoke.
    assert list(should) == ["TC-0030", "TC-0002", "TC-0021", "TC-0001"]
    assert should["TC-0030"][0] == "Linked to high risk RISK-03 (Wrong prices)"
    assert should["TC-0001"] == [im.SMOKE]
    assert "TC-0040" not in should  # its very-high risk is on a feature that only changed cosmetically
    assert [(p.key, p.reasons) for p in rec.excluded] == [("TC-0012", [im.REMOVED_CASE])]


def test_a_case_that_retests_an_open_defect_is_must_run_even_when_indirect() -> None:
    model = demo_model()
    model.defects.append(im.DefectIn("d4", "DEF-0004", "Phone accepts letters", "minor", "fixed", ("l21",)))
    rec = im.recommend(model, im.analyse(demo_changes(), model, set_key=KEY))
    must = {p.key: p.reasons for p in rec.must}
    assert must["TC-0021"] == ["Re-tests DEF-0004"]
    assert "TC-0021" not in {p.key for p in rec.should}


def test_overlay_keeps_must_run_and_moves_should_run_that_cannot_run() -> None:
    model = demo_model()
    rec = im.recommend(model, im.analyse(demo_changes(), model, set_key=KEY)).as_dict()
    states = {
        "l19": im.ScriptState("outdated", "tests/contact/TC-0019.spec.ts", "getByLabel('Message') not found"),
        "l20": im.ScriptState("valid", "tests/contact/TC-0020.spec.ts"),
        "l21": im.ScriptState("outdated", "tests/contact/TC-0021.spec.ts"),
        "l30": im.ScriptState("valid", "tests/products/TC-0030.spec.ts"),
        "l02": im.ScriptState("needs_review", "tests/nav/TC-0002.spec.ts"),
    }
    view = im.overlay(rec, states)
    assert [p["key"] for p in view["must"]] == ["TC-0019", "TC-0020"]  # outdated, still must run (OQ3)
    assert [p["key"] for p in view["should"]] == ["TC-0030"]
    excluded = {p["key"]: p["reasons"][0] for p in view["excluded"]}
    assert excluded == {
        "TC-0012": im.REMOVED_CASE,
        "TC-0021": im.OUTDATED_SHOULD,
        "TC-0002": "Script needs review (Gate 6)",
        "TC-0001": im.MANUAL,
    }


def test_broken_locators_and_outdated_reason() -> None:
    changes = demo_changes()
    renamed = im.renamed_names(changes)
    script = demo_model().scripts["l19"]
    counts: dict[str, dict[str, tuple[int, int | None]]] = {
        "pages/ContactPage.ts": {
            "message": (1, 0),  # still found, but only inside "Your message": the change renamed it
            "sendMessageSubmit": (0, 0),
            "form": (0, 0),
        }
    }
    broken = im.broken_locators(script, counts, renamed)
    assert [x.getter for x in broken] == ["message", "sendMessageSubmit", "form"]
    assert im.outdated_reason(broken[:2], KEY) == (
        "getByLabel('Message') not found after CHG-0001; "
        "getByRole('button', { name: 'Send message' }) not found after CHG-0001"
    )
    # Exactly one match by its whole name: fine. Not checked (no count): never called broken.
    assert im.broken_locators(demo_model().scripts["l20"], {"pages/ContactPage.ts": {"name": (1, 1)}}, renamed) == []
    # A partial match is fine when the change didn't rename that element.
    assert im.broken_locators(demo_model().scripts["l20"], {"pages/ContactPage.ts": {"name": (1, 0)}}, renamed) == []
    # Two matches is broken too.
    two = im.broken_locators(demo_model().scripts["l20"], {"pages/ContactPage.ts": {"name": (2, 2)}}, renamed)
    assert [x.getter for x in two] == ["name"]
    heals = im.heal_items({"l19": broken}, changes, set_key=KEY)
    assert [(h.target_kind, h.target_ref, h.level, h.action) for h in heals] == [
        (T.automation_script, "l19", L.direct, A.heal)
    ]
    assert set(heals[0].change_ids) == {"c4", "c7"}


def test_expressions() -> None:
    assert im.expression(MESSAGE) == "getByLabel('Message')"
    assert im.expression(SEND) == "getByRole('button', { name: 'Send message' })"
    assert im.expression(FORM) == "locator('form').filter({ has: getByRole('button', { name: 'Send message' }) })"
    nav = im.LocatorIn("pages/HomePage.ts", "offersLink", "/", "role", "Bob's offers", "link", within="navigation",
                       exact=True)  # fmt: skip
    assert im.expression(nav) == "getByRole('navigation').getByRole('link', { name: 'Bob\\'s offers', exact: true })"
    assert im.expression(im.LocatorIn("p.ts", "x", "/", "placeholder", "Search")) == "getByPlaceholder('Search')"
    assert im.expression(im.LocatorIn("p.ts", "x", "/", "css", css="a[href='/x']")) == "locator('a[href=\\'/x\\']')"


def test_ai_may_reorder_should_run_only() -> None:
    model = demo_model()
    rec = im.recommend(model, im.analyse(demo_changes(), model, set_key=KEY)).as_dict()
    must = ["TC-0019", "TC-0020"]
    should = ["TC-0001", "TC-0002", "TC-0021", "TC-0030"]
    assert im.ai_order(rec, must, should) == should
    assert im.ai_order(rec, list(reversed(must)), should) == should  # must order is ignored, never applied
    assert im.ai_order(rec, ["TC-0019"], should) is None  # dropped a must-run test
    assert im.ai_order(rec, must, [*should, "TC-0099"]) is None  # unknown test
    assert im.ai_order(rec, must, should[:-1]) is None  # left one out
    assert im.ai_order(rec, must, [*should, "TC-0001"]) is None  # listed twice
    assert im.ai_order(rec, [*must, "TC-0030"], should[:-1]) is None  # moved a should-run test into must


def test_estimate() -> None:
    assert im.estimate(["a", "b"], {"a": 4000, "b": 6000}) == 5
    assert im.estimate(["a", "b", "c"], {"a": 4000, "b": 6000}) == 8  # c counts as the average
    assert im.estimate(["a"], {}) is None and im.estimate([], {"a": 1}) is None


def test_counts_leave_out_repaired_scripts() -> None:
    from types import SimpleNamespace

    from app.domain.enums import ImpactStatus
    from app.services.impact import summarise

    def row(status: ImpactStatus) -> SimpleNamespace:
        return SimpleNamespace(target_kind=T.automation_script, action=A.heal, status=status)

    counts = summarise([row(ImpactStatus.open), row(ImpactStatus.resolved)], {})  # type: ignore[arg-type]
    assert counts["scripts_outdated"] == 1 and counts["open"] == 1 and counts["total"] == 2
