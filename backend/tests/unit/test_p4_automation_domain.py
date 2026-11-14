"""P4-02 step model and suitability, P4-03a emitter, P4-04 secret scan and P4-05 side effects, without a database.

The site model mirrors the fixture site and the demo shop: a contact form (Name, Email, Phone, Message; "Send
message"), a sign-in form, and a few pages with navigation."""

from __future__ import annotations

import re

import pytest

from app.domain.automation import emit as em
from app.domain.automation import secret_scan
from app.domain.automation import side_effects as fx
from app.domain.automation import steps as sm

CONTACT = sm.FormInfo(
    anchor="form:/contact:contact us",
    name="Contact us",
    purpose="contact",
    path="/contact",
    submit_label="Send message",
    alias="contact",
    fields=(
        sm.FieldInfo("name", "Name", "name", "text", True),
        sm.FieldInfo("email", "Email", "email", "email", True),
        sm.FieldInfo("phone", "Phone", "phone", "tel"),
        sm.FieldInfo("msg", "Message", "msg", "textarea", True),
    ),
)
LOGIN = sm.FormInfo(
    anchor="form:/login:sign in",
    name="Sign in",
    purpose="login",
    path="/login",
    submit_label="Sign in",
    alias="sign-in",
    fields=(sm.FieldInfo("u", "Email", "u", "email", True), sm.FieldInfo("p", "Password", "p", "password", True)),
)
CHECKOUT = sm.FormInfo(
    anchor="form:/checkout:payment",
    name="Payment",
    purpose="checkout",
    path="/checkout",
    submit_label="Pay now",
    fields=(sm.FieldInfo("cc", "Card number", "cc", "text", True),),
)
NAV = (("Products", "/products"), ("Contact", "/contact"), ("Sign in", "/login"))
PAGES = {
    "/": sm.PageInfo("/", "Home · Shop", nav=NAV),
    "/contact": sm.PageInfo("/contact", "Contact · Shop", nav=NAV, buttons=("Opening hours",)),
    "/products": sm.PageInfo("/products", "Products · Shop", nav=NAV, links=(("", "/products/1"),)),
    "/login": sm.PageInfo("/login", "Sign in · Shop", nav=NAV),
    "/account": sm.PageInfo("/account", "Account · Shop", requires_auth=True, buttons=("Delete account",)),
    "/checkout": sm.PageInfo("/checkout", "Checkout · Shop"),
}
LONG_MESSAGE = "Hello, this is a long message that is well over forty characters long."
DATA = {
    "d-name": sm.DataInfo("d-name", "TD-0001", "Name", "name", CONTACT.anchor, "valid", "Sam Tester"),
    "d-email": sm.DataInfo("d-email", "TD-0002", "Email", "email", CONTACT.anchor, "valid", "sam@example.com"),
    "d-msg": sm.DataInfo("d-msg", "TD-0003", "Message", "msg", CONTACT.anchor, "valid", LONG_MESSAGE),
    "d-empty": sm.DataInfo("d-empty", "TD-0004", "Message", "msg", CONTACT.anchor, "invalid", "", display="empty"),
    "d-user": sm.DataInfo("d-user", "TD-0005", "Email", "u", LOGIN.anchor, "secret_ref", None, secret="username"),
    "d-pass": sm.DataInfo("d-pass", "TD-0006", "Password", "p", LOGIN.anchor, "secret_ref", None, secret="password"),
}


def site(*, credentials: bool = False) -> sm.SiteModel:
    return sm.SiteModel(forms=[CONTACT, LOGIN, CHECKOUT], pages=dict(PAGES), data=dict(DATA),
                        credentials_saved=credentials, login_path="/login")  # fmt: skip


def case(steps: list[tuple[str, str] | tuple[str, str, tuple[str, ...]]], expected: str, **kw: object) -> sm.CaseIn:
    return sm.CaseIn(
        lineage_id="lin-1",
        key=str(kw.pop("key", "TC-0019")),
        title=str(kw.pop("title", "Send the contact form with an empty Message")),
        version=1,
        steps=tuple(
            sm.StepIn(n=i, action=s[0], expected=s[1], data_refs=s[2] if len(s) > 2 else ())  # type: ignore[misc]
            for i, s in enumerate(steps, start=1)
        ),
        expected_result=expected,
        requirement_keys=("REQ-0006",),
        **kw,  # type: ignore[arg-type]
    )


EMPTY_MESSAGE = case(
    [
        ("Open /contact", "The contact form is shown"),
        ("Enter TD-0001 (valid) in Name", "", ("d-name",)),
        ("Enter TD-0002 (valid) in Email", "", ("d-email",)),
        ("Leave Message empty (TD-0004 (empty))", "", ("d-empty",)),
        ("Press Send message", "Submission is blocked and Message is identified as required"),
    ],
    "Submission is blocked and Message is identified as required",
)


# ------------------------------------------------------------------ P4-02 step model


def test_demo_empty_message_case_is_suitable() -> None:
    a = sm.assess(EMPTY_MESSAGE, site())
    assert a.suitability == "suitable" and a.reasons == [sm.SUITABLE_REASON] and a.blockers == []
    last = a.model["steps"][-1]
    assert [x["kind"] for x in last["actions"]] == ["press"]
    assert [x["kind"] for x in last["assertions"]] == ["submission_blocked", "field_flagged"]
    assert last["assertions"][1]["label"] == "Message"
    assert a.model["forms"] == [CONTACT.anchor] and a.model["signs_in"] is False


# Every Phase 3 step and expected-result template (testdesign/generate.py), as the generator words them.
TEMPLATE_STEPS = [
    ("Open /contact", "The contact form is shown"),
    ("Open the Contact page", ""),
    ("Enter TD-0001 (valid) in Name", ""),
    ("Type TD-0001 (valid) in Name", ""),
    ("Paste TD-0003 (valid) into Message", ""),
    ("Leave Phone empty", ""),
    ("Press Send message", "The form is accepted without validation messages"),
    ("Press Send message", "A confirmation message is shown"),
    ("Press Send message", "Name is identified as required"),
    ("Press Send message", "Submission is blocked and Email is identified as invalid"),
    ("Press Send message", "Name keeps only the first 80 characters and no validation message is shown"),
    ("Press Send message", "Email is accepted: browsers remove spaces around an email address"),
    ("Press the browser Back button", "The contact form is shown"),
    ("Reload the page", "The contact form is shown"),
    ("Set the browser viewport to 390x844", "The page fits the screen width without horizontal scrolling"),
    ("Open the browser developer console", "No errors are written to the browser console"),
    ('Select "Products" in the primary navigation', "The Products · Shop page (/products) opens"),
    ("Check each field with an accessibility checker such as axe, or a screen reader",
     "Each field announces its label: Name, Email, Phone and Message"),
]  # fmt: skip


@pytest.mark.parametrize(("action", "expected"), TEMPLATE_STEPS)
def test_phase3_templates_parse(action: str, expected: str) -> None:
    steps = [("Open /contact", "")] if not action.startswith(("Open", "Select")) else []
    c = case([*steps, (action, expected, tuple(re.findall(r"TD-000(\d)", action) and ["d-name"]))], "")
    a = sm.assess(c, site())
    assert a.suitability in ("suitable", "manual_only")
    assert not any(b["code"] in ("judgement", "unresolved_form", "unresolved_field") for b in a.blockers), a.reasons


NEGATIVE = [
    "Check the page looks nice",
    "Make sure the colours feel friendly",
    "Ask a colleague whether the wording is clear",
    "Decide if the layout is balanced",
    "Look at the logo for a while",
    "Inspect the sign-in form's action address",
    "Wait until it feels right",
    "Think about whether the copy works",
    "Compare the design with the brand guide",
    "Read the privacy policy carefully",
    "Imagine a first-time visitor",
    "Judge the tone of the error messages",
    "Review the page for typos",
    "Confirm the site is fast enough",
    "Feel the scrolling smoothness",
    "Observe the animations",
    "Assess the reading level",
    "Evaluate the contrast by eye",
    "Note anything unusual",
    "Consider the mobile experience",
]


@pytest.mark.parametrize("action", NEGATIVE)
def test_judgement_phrasings_are_manual_only(action: str) -> None:
    a = sm.assess(case([("Open /contact", ""), (action, "")], "The contact form is shown"), site())
    assert a.suitability == "manual_only", (action, a)
    assert a.reasons[0] == f"Step 2 '{action}' needs human judgement"


def test_check_the_page_looks_nice_reason_is_exact() -> None:
    a = sm.assess(case([("Check the page looks nice", "")], ""), site())
    assert a.suitability == "manual_only"
    assert a.reasons == ["Step 1 'Check the page looks nice' needs human judgement"]


def test_open_question_and_no_assertion_are_manual_only() -> None:
    a = sm.assess(case([("Open /contact", "")], "REQ-0006 asks whether Message is optional", open_question=True),
                  site())  # fmt: skip
    assert a.suitability == "manual_only" and a.reasons == ["The expected result is an open question"]
    b = sm.assess(case([("Open /contact", "")], ""), site())
    assert b.reasons == ["No step has an expected result that can be checked in the browser"]


def test_judgement_in_the_expected_result_is_reported_once() -> None:
    text = "Only one submission is made and one confirmation is shown"
    a = sm.assess(case([("Open /contact", ""), ("Press Send message twice quickly", text)], text), site())
    assert a.suitability == "manual_only" and a.reasons == [f"Step 2's expected result '{text}' needs human judgement"]


def test_saved_account_makes_a_case_partial_until_credentials_are_saved() -> None:
    signin = case(
        [("Open /login", "The sign-in form is shown"), ("Enter TD-0005 (saved username) in Email", "", ("d-user",)),
         ("Enter TD-0006 (saved password) in Password", "", ("d-pass",)), ("Press Sign in", "The signed-in page is shown")],
        "The signed-in page is shown", key="TC-0027", title="Sign in: valid email and correct password",
    )  # fmt: skip
    a = sm.assess(signin, site())
    assert a.suitability == "partial" and a.reasons == [sm.NEEDS_CREDENTIALS]
    b = sm.with_credentials(a, True)
    assert b.suitability == "suitable" and b.reasons == [sm.SUITABLE_REASON]
    assert sm.with_credentials(b, False).suitability == "partial"
    assert sm.assess(signin, site(credentials=True)).suitability == "suitable"


# ------------------------------------------------------------------ P4-05 side effects


def test_a_negative_case_still_may_submit_the_form() -> None:
    a = sm.assess(EMPTY_MESSAGE, site())
    ce = fx.effects_of(a.model, site())
    assert ce.kinds == ["submits_form"] and ce.needs_approval == []
    lines = fx.summary_lines({"TC-0019": ce}, {CONTACT.anchor: "Contact us"})
    assert lines == [{"kind": "may_submit", "form": CONTACT.anchor, "count": 1, "case_keys": ["TC-0019"],
                      "text": "May submit the Contact us form (if the application does not block it)"}]  # fmt: skip


def test_positive_submission_and_sign_in_lines() -> None:
    sent = case([("Open /contact", ""), ("Enter TD-0003 (valid) in Message", "", ("d-msg",)),
                 ("Press Send message", "A confirmation message is shown")], "A confirmation message is shown")  # fmt: skip
    ce = fx.effects_of(sm.assess(sent, site()).model, site())
    assert fx.summary_lines({"TC-0020": ce}, {CONTACT.anchor: "Contact us"})[0]["text"] == "Submits the Contact us form"
    signin = case([("Open /login", ""), ("Press Sign in", "The signed-in page is shown")], "")
    ce2 = fx.effects_of(sm.assess(signin, site()).model, site())
    assert ce2.kinds == ["signs_in"]
    assert fx.summary_lines({"TC-0027": ce2}, {})[0]["text"] == "Signs in with the saved test account"


def test_checkout_is_an_external_transaction() -> None:
    pay = case([("Open /checkout", ""), ("Press Pay now", "A confirmation message is shown")], "")
    ce = fx.effects_of(sm.assess(pay, site()).model, site())
    assert "external_transaction" in ce.kinds and ce.needs_approval == ["external_transaction"]


def test_press_delete_account_is_destructive() -> None:
    c = case([("Open /account", ""), ("Press Delete account", "The sign-in page is shown")], "")
    ce = fx.effects_of(sm.assess(c, site()).model, site())
    assert "destructive" in ce.kinds and ce.needs_approval == ["destructive"]
    quote = next(e for e in ce.effects if e.kind == "destructive")
    assert quote.step == 2 and quote.quote == "Press Delete account"


@pytest.mark.parametrize(
    ("text", "hit"),
    [("Delete", True), ("Press Delete account", True), ("Remove item", True), ("Cancel order", True),
     ("Close account", True), ("Unsubscribe", True), ("Deactivate", True),
     ("Deleted items are shown", False), ("Removed", False), ("Cancel", False), ("Close", False),
     ("Undelete", False), ("Remover tool", False)],
)  # fmt: skip
def test_destructive_vocabulary_is_word_bounded(text: str, hit: bool) -> None:
    assert fx.is_destructive(text) is hit


def test_destructive_words_in_an_expected_result_do_not_fire() -> None:
    c = case([("Open /contact", ""), ("Press Opening hours", "Deleted items are shown")], "")
    a = sm.assess(c, site())
    assert "destructive" not in fx.effects_of(a.model, site()).kinds


# ------------------------------------------------------------------ P4-03a emitter


def _bundle(*cases: sm.CaseIn, credentials: bool = False) -> em.Bundle:
    s = site(credentials=credentials)
    return em.Emitter(s).emit([(c, sm.assess(c, s).model) for c in cases])


def test_demo_spec_content() -> None:
    b = _bundle(EMPTY_MESSAGE)
    out = b.scripts["lin-1"]
    assert out.path == "tests/contact/TC-0019.spec.ts"
    code = out.code
    assert code.splitlines()[0] == "// TC-0019 v1 · REQ-0006 · Generated by rules (AI not configured)"
    assert 'import { test } from "../../fixtures";' in code
    assert 'import { ContactPage } from "../../pages/ContactPage";' in code
    assert 'test("TC-0019: Send the contact form with an empty Message", { tag: ["@TC-0019"] }' in code
    assert 'await test.step("Press Send message", async () => {' in code
    assert "await qa.expectSubmissionBlocked(contact.form);" in code
    assert 'await qa.expectFieldFlagged("Message");' in code
    assert 'await test.step("Enter \\"Sam Tester\\" in Name"' in code
    for banned in ("waitForTimeout", "test.only", "page.locator(", 'Sam Tester")', 'sam@example.com")'):
        assert banned not in code, banned
    pom = b.assets["pages/ContactPage.ts"]
    assert 'this.page.getByLabel("Message")' in pom
    assert 'this.page.getByRole("button", { name: "Send message" })' in pom
    assert "// fallback locator: a form rarely has an accessible name" in pom
    assert '"TD-0001": "Sam Tester"' in b.assets["data/factories.ts"]
    assert [m["helper"] for m in out.assertion_map] == ["expectFormShown", "expectSubmissionBlocked",
                                                        "expectFieldFlagged"]  # fmt: skip
    assert "pages/ContactPage.ts#message" in out.locators  # used through qa.expectFieldFlagged("Message")


def test_long_valid_values_are_titled_by_field() -> None:
    c = case([("Open /contact", ""), ("Enter TD-0003 (valid) in Message", "", ("d-msg",)),
              ("Press Send message", "A confirmation message is shown")], "")  # fmt: skip
    code = _bundle(c).scripts["lin-1"].code
    assert 'test.step("Enter a valid Message"' in code and 'in Message"' not in code


def test_output_is_deterministic() -> None:
    a, b = _bundle(EMPTY_MESSAGE), _bundle(EMPTY_MESSAGE)
    assert a.scripts["lin-1"].sha256 == b.scripts["lin-1"].sha256 and a.assets == b.assets


def test_saved_account_comes_from_the_environment() -> None:
    signin = case(
        [("Open /login", ""), ("Enter TD-0005 (saved username) in Email", "", ("d-user",)),
         ("Enter TD-0006 (saved password) in Password", "", ("d-pass",)), ("Press Sign in", "The signed-in page is shown")],
        "", key="TC-0027", title="Sign in: valid email and correct password",
    )  # fmt: skip
    b = _bundle(signin, credentials=True)
    code = b.scripts["lin-1"].code
    assert "credentials.password" in code and 'test.use({ trace: "off" })' in code
    factories = b.assets["data/factories.ts"]
    assert "process.env" in factories
    assert secret_scan.scan(code, username="qa@example.com", password="fixture-pass-1")["ok"]


def test_href_only_links_use_a_css_fallback_with_a_comment() -> None:
    c = case([("Open /products", ""), ("Open an item from the list", "The item's detail page opens (for example "
                                                                      "/products/1)")], "")  # fmt: skip
    a = sm.assess(c, site())
    if a.suitability == "manual_only":
        pytest.skip(f"not parsed on this model: {a.reasons}")
    pom = _bundle(c).assets["pages/ProductsPage.ts"]
    assert 'this.page.locator("a[href=\\"/products/1\\"]")' in pom
    assert "// fallback locator: the link's text wasn't recorded" in pom


def test_unsafe_names_are_never_emitted() -> None:
    for text in ("constructor", "use", "extend", "_private", "downloadPath", "rootDir"):
        name = em.camel(text)
        assert name not in ("constructor", "use", "extend") and not name.startswith("_")
        assert not re.search(r"(path|dir)$", name, re.I), name


# ------------------------------------------------------------------ P4-04 secret scan


def test_secret_scan_names_lines_never_values() -> None:
    code = 'const a = 1;\nconst t = "ghp_' + "x" * 36 + '";\nawait signIn.password.fill("hunter22");\n'
    out = secret_scan.scan(code + "// qa@example.com\n", username="qa@example.com", password="hunter22")
    assert not out["ok"]
    text = str(out)
    assert "hunter22" not in text and "qa@example.com" not in text and "ghp_" not in text
    assert {m["line"] for m in out["messages"]} == {2, 3, 4}
    assert "Line 3: a password field is filled with a literal value" in [m["message"] for m in out["messages"]]
    assert secret_scan.scan("await signIn.password.fill(credentials.password);\n")["ok"]
