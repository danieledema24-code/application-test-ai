"""QA P6-04 round 2: a repair on one locator must not hide a genuine application failure on an unrelated check.

TC-0007 (only spaces in Name) on the demo shop: every action passed, the page contradicts the check ("Thank you"
shown where the submission should be blocked), and the failure has nothing to do with the healed Message field or Send
button. The shop accepts whitespace-only names in release 1 and release 2 alike, so it is an application bug the
platform drafted as DEF-0002 before the repair rule; after it, any check failure on a script with a recent repair is
read as test maintenance.
"""

from __future__ import annotations

from app.domain.defects import classify as cl
from tests.unit.test_p4_execution_domain import _f

TC7_ERROR = (
    "QA_ASSERTION: Expected the Contact us form to block the submission and still be shown, but the page shows "
    '"Thank you" (Message sent) at /contact.'
)
TC7 = {
    "error": TC7_ERROR,
    "assertions": [
        {"helper": "expectSubmissionBlocked", "args": ["Contact us"], "kind": "submission_blocked"},
        {"helper": "expectFieldFlagged", "args": ["Contact us", "Name"], "kind": "field_flagged"},
    ],
}


def test_without_repairs_tc0007_is_an_application_defect() -> None:
    a = cl.classify(_f(**TC7))
    assert a.classification == "application_defect"


def test_an_unrelated_repair_does_not_hide_the_application_defect() -> None:
    a = cl.classify(_f(**TC7, repairs=["HEAL-0001 accepted: getByLabel('Message') → getByLabel('Your message')"]))
    assert a.classification == "application_defect", (a.classification, a.confidence)


# ---- QA P6-04 round 3: "goes through a repaired element" (services.repairs.involved + classify rule 7a)

from app.db.models import HealSuggestion  # noqa: E402
from app.domain.enums import HealKind, HealStatus  # noqa: E402
from app.services import repairs as rsvc  # noqa: E402

FORM_HEAL = (
    "HEAL-0003 accepted: locator('form')… → locator('form').filter({ has: getByRole('button', { name: 'Send' }) })"
)
MSG_HEAL = "HEAL-0001 accepted: getByLabel('Message') → getByLabel('Your message')"
FORM_ASSERTS = [
    {"helper": "expectSubmissionBlocked", "args": ["Contact us"], "kind": "submission_blocked",
     "locators": ["pages/ContactPage.ts#form"]},
    {"helper": "expectFieldFlagged", "args": ["Contact us", "Name"], "kind": "field_flagged",
     "locators": ["pages/ContactPage.ts#name"]},
]  # fmt: skip


def _heal(getter: str) -> HealSuggestion:
    return HealSuggestion(key=f"HEAL-{getter}", kind=HealKind.locator, status=HealStatus.accepted,
                          file="pages/ContactPage.ts", getter=getter, candidates=[])  # fmt: skip


def test_a_healed_form_does_not_take_a_field_check_with_it() -> None:
    """The form was healed; the failed check is the Name field's (not through the form): not involved."""
    err = 'QA_ASSERTION: Expected Name to be identified as needing attention (invalid or required), but the page shows "Contact us" at /contact.'
    assert rsvc.involved([_heal("form")], FORM_ASSERTS, err) == []


def test_a_form_level_block_check_with_an_error_page_on_a_healed_form() -> None:
    """Healed form; the block check fails while the page shows the form's own error (not a success): what is it?"""
    err = 'QA_ASSERTION: Expected the Contact us form to block the submission and still be shown, but the page shows "Server busy" at /contact.'
    inv = rsvc.involved([_heal("form")], FORM_ASSERTS, err)
    a = cl.classify(_f(error=err, assertions=FORM_ASSERTS, repaired=[FORM_HEAL] if inv else [],
                       page_state={"url": "/contact", "heading": "Server busy", "messages": ["Server busy"]}))  # fmt: skip
    print("QA-R3 form block, error page:", bool(inv), a.classification, a.confidence)


def test_a_genuine_defect_on_the_healed_field_itself() -> None:
    """The Message field was healed and G6 passed; later the app stops flagging an empty Message (DEF-0001 back)
    while the page stays on the form (no success text): the failed check goes through the healed field."""
    asserts = [{"helper": "expectFieldFlagged", "args": ["Contact us", "Message"], "kind": "field_flagged",
                "locators": ["pages/ContactPage.ts#message"]}]  # fmt: skip
    err = 'QA_ASSERTION: Expected Message to be identified as needing attention (invalid or required), but the page shows "Contact us" at /contact.'
    inv = rsvc.involved([_heal("message")], asserts, err)
    a = cl.classify(_f(error=err, assertions=asserts, repaired=[MSG_HEAL] if inv else [],
                       page_state={"url": "/contact", "heading": "Contact us", "messages": []}))  # fmt: skip
    print("QA-R3 regression on healed field:", bool(inv), a.classification, a.confidence)
    assert inv  # it does go through the healed field


def test_success_exception_on_the_demo_regression() -> None:
    """DEF-0001 back on v2 (empty Message accepted, "Thank you"): the block check goes through the healed form."""
    err = 'QA_ASSERTION: Expected the Contact us form to block the submission and still be shown, but the page shows "Thank you" (Message sent) at /contact.'
    inv = rsvc.involved([_heal("form")], FORM_ASSERTS, err)
    a = cl.classify(_f(error=err, assertions=FORM_ASSERTS, repaired=[FORM_HEAL] if inv else []))
    assert inv and a.classification == "application_defect", (inv, a.classification)


# ---- P6-04 round 3 fix: the window closes at the case's first passed result after the repair


def _healed_field_failure(*, passed_since: bool) -> cl.Analysis:
    asserts = [{"helper": "expectFieldFlagged", "args": ["Contact us", "Message"], "kind": "field_flagged",
                "locators": ["pages/ContactPage.ts#message"]}]  # fmt: skip
    err = 'QA_ASSERTION: Expected Message to be identified as needing attention (invalid or required), but the page shows "Contact us" at /contact.'
    assert rsvc.involved([_heal("message")], asserts, err)
    through = {"proven": [MSG_HEAL]} if passed_since else {"repaired": [MSG_HEAL]}
    return cl.classify(_f(error=err, assertions=asserts, page_state={"url": "/contact", "heading": "Contact us",
                                                                     "messages": []}, **through))  # fmt: skip


def test_before_the_first_pass_a_failure_on_the_healed_field_is_test_maintenance() -> None:
    a = _healed_field_failure(passed_since=False)
    assert (a.classification, a.confidence) == ("script_defect", "medium")
    assert [s["detail"] for s in a.signals if s["code"] == "repair_context"] == [MSG_HEAL]


def test_after_a_pass_a_failure_on_the_healed_field_is_an_application_defect() -> None:
    a = _healed_field_failure(passed_since=True)
    assert a.classification == "application_defect" and a.confidence in ("medium", "high"), a  # drafted (P4-08 rule)
    assert f"The test passed after this repair: {MSG_HEAL}" in [s["detail"] for s in a.signals]


def test_after_a_pass_an_error_page_on_the_healed_form_is_an_application_defect() -> None:
    err = 'QA_ASSERTION: Expected the Contact us form to block the submission and still be shown, but the page shows "Server busy" at /contact.'
    assert rsvc.involved([_heal("form")], FORM_ASSERTS, err)
    page = {"url": "/contact", "heading": "Server busy", "messages": ["Server busy"]}
    before = cl.classify(_f(error=err, assertions=FORM_ASSERTS, repaired=[FORM_HEAL], page_state=page))
    after = cl.classify(_f(error=err, assertions=FORM_ASSERTS, proven=[FORM_HEAL], page_state=page))
    assert before.classification == "script_defect"
    assert after.classification == "application_defect", (after.classification, after.confidence)
