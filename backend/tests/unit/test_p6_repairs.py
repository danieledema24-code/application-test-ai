"""P6-04 repair suggestions (decision D31) as pure rules: the score and its signals in words, the levels, the diff
match (and the ambiguous rename the diff refused to pair), the candidate strategies in the spec §8 order, the rule
order (at most three offered), the single-line locator rewrite and the expected-value guard, asserted-text detection
(proactive from a change set and reactive from a failed text check), the AI order guard, and the OQ3 decision that a
rejected repair lifts the regression block.
"""

from __future__ import annotations

import pytest

from app.api.errors import Conflict
from app.domain.automation import expected_guard as guard
from app.domain.change import heal as hd
from app.domain.change import impact as im
from app.domain.enums import ChangeKind as K
from app.domain.enums import ChangeSignificance as S
from app.services import heal as p4
from app.services import impact as impact_svc
from app.services import repairs

KEY = "CHG-0001"
MESSAGE = {"getter": "message", "element": "Message", "by": "label", "name": "Message", "role": "", "exact": False}
SEND = {"getter": "sendMessage", "element": "Send message", "by": "role", "role": "button", "name": "Send message"}


def _field(label: str, required: bool = False) -> dict[str, object]:
    return {"form": "Contact form", "name": "message", "label": label, "type": "textarea", "required": required,
            "constraints": {}, "options": None}  # fmt: skip


def _button(name: str, selector: str = "form > button") -> dict[str, object]:
    return {"kind": "button", "role": "button", "name": name, "selector": selector, "locator": None}


def demo_changes() -> list[im.ChangeIn]:
    after = {**_field("Your message", True), "changed": ["label", "required"]}
    return [
        im.ChangeIn("c4", K.element_renamed, S.behavioural, "/contact", _button("Send message"), _button("Send")),
        im.ChangeIn("c7", K.field_changed, S.structural, "/contact", _field("Message"), after),
        im.ChangeIn("c8", K.page_changed, S.cosmetic, "/about", {"headings": ["About"]}, {"headings": ["About us"]}),
    ]


def loc(spec: dict[str, object], page: str = "/contact") -> im.LocatorIn:
    return im.LocatorIn(file="pages/ContactPage.ts", getter=str(spec["getter"]), page=page, by=str(spec["by"]),
                        name=str(spec["name"]), role=str(spec.get("role") or ""), element=str(spec["element"]))  # fmt: skip


# ---------------------------------------------------------------- score and signals


def test_demo_message_field_scores_high_with_every_signal_in_words() -> None:
    match = hd.diff_match(loc(MESSAGE), demo_changes(), KEY)
    assert match == hd.DiffMatch("c7", "renamed", "Your message", KEY, "Contact form")
    el = hd.Element("textbox", "Your message", label="Your message", place="form#0")
    s = hd.score(old_name="Message", original=MESSAGE, strategy="label", element=el, match=match,
                 original_place="form#0")  # fmt: skip
    assert (s.score, s.level) == (1.0, "high")  # 0.5 + 0.2 + 0.74 × 0.3 + 0.1 + 0.05, capped at 1
    assert [x.text for x in s.signals] == [
        "Same field, renamed (CHG-0001)",
        "Same role (text box)",
        "Name 74 % similar ('Message' → 'Your message')",
        "In the same form",
        "Uses a label (the most robust kind of locator)",
    ]


def test_demo_send_button_scores_high() -> None:
    match = hd.diff_match(loc(SEND), demo_changes(), KEY)
    assert match is not None and match.new_name == "Send" and match.change_id == "c4"
    el = hd.Element("button", "Send", text="Send", place="form#0")
    s = hd.score(old_name="Send message", original=SEND, strategy="role", element=el, match=match,
                 original_place="form#0")  # fmt: skip
    assert s.level == "high" and s.score == 1.0
    assert s.signals[0].text == "Same field, renamed (CHG-0001)"
    assert "Uses a role and name (the most robust kind of locator)" in [x.text for x in s.signals]
    assert "Name 50 % similar ('Send message' → 'Send')" in [x.text for x in s.signals]


def test_without_the_diff_the_same_rename_is_medium_and_weights_add_up() -> None:
    el = hd.Element("textbox", "Your message", label="Your message", place="form#0")
    s = hd.score(old_name="Message", original=MESSAGE, strategy="label", element=el, match=None,
                 original_place="form#0")  # fmt: skip
    assert s.level == "medium"
    assert s.score == round(0.2 + hd.similarity("Message", "Your message") * 0.3 + 0.1 + 0.05, 2)
    other = hd.score(old_name="Message", original=MESSAGE, strategy="placeholder", element=el, match=None,
                     original_place="form#1")  # fmt: skip
    assert [x.code for x in other.signals] == ["role", "name"]  # another form, a weaker strategy
    moved = hd.DiffMatch("c9", "moved", "Add to basket", KEY)
    btn = {"getter": "add", "element": "Add to basket", "by": "role", "role": "button", "name": "Add to basket"}
    s2 = hd.score(old_name="Add to basket", original=btn, strategy="role",
                  element=hd.Element("button", "Add to basket"), match=moved, original_place=None)  # fmt: skip
    assert s2.signals[0].text == "Same element, moved (CHG-0001)"


@pytest.mark.parametrize(("value", "level"), [(1.0, "high"), (0.8, "high"), (0.79, "medium"), (0.5, "medium"),
                                              (0.49, "low"), (0.0, "low")])  # fmt: skip
def test_levels(value: float, level: str) -> None:
    assert hd.level_of(value) == level


def test_role_matching_and_original_roles() -> None:
    assert hd.original_role(MESSAGE) == "textbox" and hd.original_role(SEND) == "button"
    assert hd.original_role({"by": "css", "css": 'a[href="/products/1"]'}) == "link"
    assert hd.original_role({"by": "css", "css": "#x"}) == ""
    assert hd.same_role("textbox", "searchbox") and not hd.same_role("textbox", "button")
    assert not hd.same_role("", "button")


# ---------------------------------------------------------------- the diff


def test_ambiguous_rename_is_never_a_diff_match() -> None:
    hours = {"getter": "openingHours", "element": "Opening hours", "by": "role", "role": "button",
             "name": "Opening hours"}  # fmt: skip
    changes = [
        im.ChangeIn("r", K.element_removed, S.structural, "/contact", _button("Opening hours", "main > button"), None),
        im.ChangeIn("a1", K.element_added, S.structural, "/contact", None, _button("Opening times", "main > b:nth(1)")),
        im.ChangeIn("a2", K.element_added, S.structural, "/contact", None, _button("Opening days", "main > b:nth(2)")),
    ]
    assert hd.diff_match(loc(hours), changes, KEY) is None
    assert hd.ambiguous_renames(loc(hours), changes) == ["Opening times", "Opening days"]
    assert hd.ambiguous_renames(loc(hours), changes[:2]) == []  # one add and one remove: not "ambiguous"
    assert hd.ambiguous_renames(loc(MESSAGE), changes) == []


def test_candidate_specs_follow_the_spec_order_and_keep_the_getter() -> None:
    el = hd.Element("textbox", "Your message", label="Your message", placeholder="Say hello", testid="msg",
                    locators=("getByRole('textbox', { name: 'Your message' })", "getByLabel('Your message')",
                              "getByTestId('msg')", "locator('#msg')"))  # fmt: skip
    specs = hd.candidate_specs(MESSAGE, el)
    assert [st for st, _s in specs] == ["role", "label", "placeholder", "testid"]
    assert all(s["getter"] == "message" and s["element"] == "Message" for _st, s in specs)
    assert [hd.spec_expression(s) for _st, s in specs] == [
        "getByRole('textbox', { name: 'Your message' })",
        "getByLabel('Your message')",
        "getByPlaceholder('Say hello')",
        "getByTestId('msg')",
    ]
    btn = hd.Element("button", "Send", text="Send", locators=("getByRole('button', { name: 'Send' })",
                                                              "getByText('Send now')"))  # fmt: skip
    assert [(st, hd.spec_expression(s)) for st, s in hd.candidate_specs(SEND, btn)] == [
        ("role", "getByRole('button', { name: 'Send' })"),
        ("text", "getByText('Send')"),
        ("discovery", "getByText('Send now')"),
    ]
    form = {"getter": "contactForm", "element": "Contact form", "by": "form_button", "name": "Send message"}
    assert [hd.spec_expression(s) for _st, s in hd.candidate_specs(form, btn)] == [
        "locator('form').filter({ has: getByRole('button', { name: 'Send' }) })"
    ]
    assert hd.parse_discovery("getByRole('button', { name: 'Go' })") == {"by": "role", "role": "button", "name": "Go"}
    assert hd.parse_discovery("locator('#x')") is None


def test_likely_elements_puts_the_diff_match_first_and_skips_taken_names() -> None:
    els = [hd.Element("textbox", "Name"), hd.Element("textbox", "Your message"), hd.Element("textbox", "Messages"),
           hd.Element("button", "Message us")]  # fmt: skip
    got = hd.likely_elements(MESSAGE, els, taken={"Name"}, new_name="Your message")
    assert [e.name for e in got] == ["Your message", "Messages"]  # same role only; "Name" belongs to another getter


def _cand(expr: str, strategy: str, score: float, offered: bool = True, why: str | None = None) -> hd.Candidate:
    c = hd.Candidate(expr, strategy, {"by": strategy}, hd.Element("textbox", expr), 1 if offered else 2, offered)
    c.score, c.not_offered_reason = score, why
    return c


def test_rule_order_offers_at_most_three_and_keeps_the_ambiguous_rows() -> None:
    cands = [
        _cand("r1", "role", 0.9), _cand("l1", "label", 0.9), _cand("p1", "placeholder", 0.6),
        _cand("t1", "text", 0.4), _cand("x", "role", 0.0, offered=False, why=hd.AMBIGUOUS),
    ]  # fmt: skip
    ranked = hd.rank(cands, MESSAGE)
    assert [c.expression for c in ranked] == ["l1", "r1", "p1", "x"]  # the label original's own strategy wins a tie
    assert [c.rule_rank for c in ranked] == [0, 1, 2, 3]
    assert sum(1 for c in ranked if c.offered) == hd.MAX_OFFERED


def test_page_fingerprint_ignores_order_and_case() -> None:
    a = [hd.Element("button", "Send"), hd.Element("textbox", "Your message")]
    b = [hd.Element("textbox", "your  MESSAGE"), hd.Element("button", "send")]
    assert hd.page_fingerprint(a) == hd.page_fingerprint(b)
    assert hd.page_fingerprint(a) != hd.page_fingerprint(a[:1])


# ---------------------------------------------------------------- applying: one locator line, nothing else

PAGE_OBJECT = """import type { Page } from "@playwright/test";

export class ContactPage {
  constructor(private readonly page: Page) {}
  get message() {
    return this.page.getByLabel("Message");
  }
  get sendMessage() {
    return this.page.getByRole("button", { name: "Send message" });
  }
}
"""


def test_single_line_locator_rewrite() -> None:
    new = {**MESSAGE, "name": "Your message"}
    after = p4.apply_fix(PAGE_OBJECT, p4.expression(MESSAGE), p4.expression(new))
    changed = [(a, b) for a, b in zip(PAGE_OBJECT.splitlines(), after.splitlines(), strict=True) if a != b]
    assert changed == [
        ('    return this.page.getByLabel("Message");', '    return this.page.getByLabel("Your message");')
    ]
    assert guard.changed(PAGE_OBJECT, after) == [] and guard.assertion_set(PAGE_OBJECT) == guard.assertion_set(after)
    role = {**SEND, "name": "Send"}
    after2 = p4.apply_fix(after, p4.expression(SEND), p4.expression(role))
    assert 'getByRole("button", { name: "Send" })' in after2 and len(after2.splitlines()) == len(after.splitlines())
    text = {**SEND, "by": "text", "name": "Send", "role": ""}
    assert p4.expression(text) == 'this.page.getByText("Send")'
    with pytest.raises(Conflict):  # a candidate that would add a line (an assertion) is refused
        p4.apply_fix(PAGE_OBJECT, p4.expression(MESSAGE), 'this.page.getByLabel("x");\n    await qa.expectText("y")')
    with pytest.raises(Conflict):  # the old expression isn't there any more
        p4.apply_fix(after, p4.expression(MESSAGE), p4.expression(new))


def test_rewrite_of_a_button_the_form_getter_also_uses() -> None:
    # The form is found by its button, so the button's expression appears twice: only its own getter line changes.
    form = 'this.page.locator("form").filter({ has: this.page.getByRole("button", { name: "Send message" }) })'
    code = PAGE_OBJECT.replace(
        "  get sendMessage() {", f"  get form() {{\n    return {form};\n  }}\n  get sendMessage() {{"
    )
    after = p4.apply_fix(code, p4.expression(SEND), p4.expression({**SEND, "name": "Send"}))
    changed = [(a, b) for a, b in zip(code.splitlines(), after.splitlines(), strict=True) if a != b]
    assert changed == [
        (
            '    return this.page.getByRole("button", { name: "Send message" });',
            '    return this.page.getByRole("button", { name: "Send" });',
        )
    ]
    assert form in after


def test_the_rewritten_line_names_the_element_as_it_is_now() -> None:
    code = '  get sendMessage(): Locator {\n    return this.page.getByRole("button", { name: "Send message" }); // Send message\n  }\n'
    after = p4.apply_fix(code, p4.expression(SEND), p4.expression({**SEND, "name": "Send"}))
    assert "// Send message" in after  # apply_fix alone leaves the stale name
    fixed = hd.retitle(code, after, "Send")
    assert fixed.splitlines()[1] == '    return this.page.getByRole("button", { name: "Send" }); // Send'
    assert len([1 for a, b in zip(code.splitlines(), fixed.splitlines(), strict=True) if a != b]) == 1
    assert hd.retitle(PAGE_OBJECT, PAGE_OBJECT, "Send") == PAGE_OBJECT  # nothing changed: nothing renamed
    assert hd.retitle(code, after, None) == after


def test_outdated_reason_loses_only_the_repaired_clause() -> None:
    reason = "getByLabel('Message') not found after CHG-0001; getByRole('button', { name: 'Send message' }) not found after CHG-0001"
    left = repairs.remove_clause(reason, "getByLabel('Message')")
    assert left == "getByRole('button', { name: 'Send message' }) not found after CHG-0001"
    assert repairs.remove_clause(left, "getByRole('button', { name: 'Send message' })") is None
    assert repairs.remove_clause("This script is outdated: its test case changed", "getByLabel('Message')") == (
        "This script is outdated: its test case changed"
    )


# ---------------------------------------------------------------- expected results are never changed


def _checks(assertions: list[dict[str, object]], pages: tuple[str, ...] = ("/contact",)) -> hd.ScriptChecks:
    return hd.ScriptChecks("lin-21", "TC-0021", frozenset(pages), tuple(assertions))


def test_a_changed_text_a_script_checks_is_a_review_not_a_repair() -> None:
    enabled = {"step": 3, "helper": "expectControlEnabled", "kind": "control_enabled", "args": ["Send message"]}
    flagged = {"step": 2, "helper": "expectFieldFlagged", "kind": "field_flagged", "args": ["Contact form", "Message"]}
    [rv, field] = sorted(hd.asserted_text_reviews(demo_changes(), [_checks([enabled, flagged])], KEY),
                         key=lambda x: x.helper)  # fmt: skip
    assert (rv.case_key, rv.page, rv.before, rv.after, rv.change_id) == ("TC-0021", "/contact", "Send message", "Send",
                                                                         "c4")  # fmt: skip
    assert (field.before, field.after, field.helper) == ("Message", "Your message", "expectFieldFlagged")
    # D36: a field check through the page object follows the locator, so a repair covers it: no review.
    [only] = hd.asserted_text_reviews(demo_changes(), [_checks([enabled, {**flagged, "by_locator": True}])], KEY)
    assert only.helper == "expectControlEnabled"
    assert rv.message() == (
        "The text changed from 'Send message' to 'Send' on /contact (CHG-0001). TC-0021 checks this text. Expected "
        "results are never changed automatically. Review TC-0021."
    )
    # A field is found by its whole label, so "Message" is lost in "Your message"; a text check matches part of the
    # text, so the same words are still found.
    assert hd.checks_lost("Message", "Message", "Your message", exact=True)
    assert not hd.checks_lost("Message", "Message", "Your message")
    assert not hd.checks_lost("Message", "Message", " Message ", exact=True)
    renamed = [im.ChangeIn("c1", K.field_changed, S.behavioural, "/contact", _field("Message"),
                           {**_field("Comments"), "changed": ["label"]})]  # fmt: skip
    [rv2] = hd.asserted_text_reviews(renamed, [_checks([flagged])], KEY)
    assert (rv2.before, rv2.after) == ("Message", "Comments")
    # A heading a script checks, on another page than the script's: nothing.
    text = {"step": 1, "helper": "expectText", "kind": "text_visible", "args": ["About"]}
    assert hd.asserted_text_reviews(demo_changes(), [_checks([text])], KEY) == []
    [rv3] = hd.asserted_text_reviews(
        [im.ChangeIn("h", K.page_changed, S.cosmetic, "/about", {"headings": ["Our team"]}, {"headings": ["People"]})],
        [_checks([{**text, "args": ["Our team"]}], ("/about",))],
        KEY,
    )
    assert (rv3.before, rv3.after) == ("Our team", "People")


def test_asserted_texts_reads_the_text_argument_of_each_check() -> None:
    amap = [
        {"kind": "submission_accepted", "helper": "expectSubmissionAccepted", "args": ["Contact form", "Message sent"]},
        {"kind": "submission_accepted", "helper": "expectSubmissionAccepted", "args": ["Contact form"]},
        {"kind": "field_length", "helper": "expectFieldLength", "args": ["Contact form", "Name", "80", "at most"]},
        {"kind": "url_is", "helper": "expectUrl", "args": ["/thanks"]},
    ]
    assert hd.asserted_texts(amap) == [("Message sent", "expectSubmissionAccepted"), ("Name", "expectFieldLength")]


def test_a_failed_text_check_after_a_run_is_a_review() -> None:
    error = 'Expected the text "Message sent" to be shown'
    state = {"url": "/contact", "heading": "Thank you", "messages": ["Thanks, we got your message"]}
    rv = hd.failed_text_review(error, state, lineage="l", case_key="TC-0021", result_key="RUN-0003-07")
    assert rv is not None and (rv.before, rv.after, rv.page) == ("Message sent", "Thanks, we got your message",
                                                                 "/contact")  # fmt: skip
    assert rv.message().startswith("The text changed from 'Message sent' to 'Thanks, we got your message' on /contact "
                                   "(RUN-0003-07). TC-0021 checks this text.")  # fmt: skip
    accepted = 'Expected the Contact form form to be accepted with "Message sent"'
    assert hd.failed_text_review(accepted, state, lineage="l", case_key="TC-0021", result_key="R") is not None
    # Not a text check, or nothing else was shown: no review.
    assert hd.failed_text_review("Element not found: getByLabel('Message')", state, lineage="l", case_key="T",
                                 result_key="R") is None  # fmt: skip
    assert hd.failed_text_review(error, {"messages": []}, lineage="l", case_key="T", result_key="R") is None


# ---------------------------------------------------------------- AI may only reorder verified candidates


def test_ai_order_accepts_a_permutation_only() -> None:
    offered = ["getByLabel('Your message')", "getByRole('textbox', { name: 'Your message' })"]
    assert hd.ai_order(offered, list(reversed(offered))) == list(reversed(offered))
    assert hd.ai_order(offered, [offered[0], "getByLabel('Anything')"]) is None  # an unverified expression
    assert hd.ai_order(offered, [offered[0], offered[0]]) is None
    assert hd.ai_order(offered, offered[:1]) is None
    edited = [offered[0] + "; await qa.expectText('Thanks!')", offered[1]]
    assert hd.ai_order(offered, edited) is None  # anything beyond the locator


# ---------------------------------------------------------------- OQ3: accept or reject lifts the block


def test_a_decided_repair_lifts_the_regression_block() -> None:
    open_ = [{"key": "HEAL-0001", "status": "open"}, {"key": "HEAL-0002", "status": "accepted"}]
    assert impact_svc.repair_decision(open_) == (False, [])
    assert impact_svc.repair_decision([{"key": None, "status": None}]) == (False, [])  # not suggested yet
    assert impact_svc.repair_decision([]) == (False, [])
    done = [{"key": "HEAL-0001", "status": "rejected"}, {"key": "HEAL-0002", "status": "superseded"}]
    assert impact_svc.repair_decision(done) == (True, ["HEAL-0001"])
    assert impact_svc.rejected_reason(["HEAL-0001"]).startswith("Repair rejected (HEAL-0001): its script is still")


def test_an_address_is_never_scored_against_a_name_and_a_removed_link_target_is_known() -> None:
    link = {"getter": "products1Link", "element": "/products/1", "by": "css", "css": 'a[href="/products/1"]'}
    assert hd.link_target(link) == "/products/1"
    assert hd.link_target({**link, "css": "a[href='/products/1?x=1#top']"}) == "/products/1"
    assert hd.link_target(MESSAGE) is None
    products = hd.Element("link", "Products", text="Products", place="nav#0")
    # QA P6-04: 'Name 84 % similar ('/products/1' → 'Products')' compared an address with link text.
    assert hd.likely_elements(link, [products], taken=set(), new_name=None) == []
    s = hd.score(old_name="/products/1", original=link, strategy="role", element=products, match=None,
                 original_place=None)  # fmt: skip
    assert "name" not in [x.code for x in s.signals]


def test_a_failed_check_after_a_repair_is_test_maintenance_not_a_defect() -> None:
    from app.domain.defects import classify as cl

    err = "QA_ASSERTION: Expected Message to be identified as needing attention (invalid or required), but …"
    base = cl.FailureInput(status="failed", error=err, attempts=[{"status": "failed", "error": err}] * 2)
    assert cl.classify(base).classification == "application_defect"
    # The failed check goes through the repaired element: a test problem, with the HEAL key shown.
    fixed = cl.classify(cl.FailureInput(**{**base.__dict__, "repaired": ["HEAL-0001 accepted: a → b"]}))
    assert fixed.classification == "script_defect"
    assert (fixed.signals[0]["code"], fixed.signals[0]["detail"]) == ("repair_context", "HEAL-0001 accepted: a → b")
    # A repair elsewhere in the script is context only (QA P6-04 R2).
    other = cl.classify(cl.FailureInput(**{**base.__dict__, "repairs": ["HEAL-0002 accepted: c → d"]}))
    assert other.classification == "application_defect" and other.confidence == "medium"
    assert ("repair_context", "Not involved in this check: HEAL-0002 accepted: c → d") in [
        (s["code"], s["detail"]) for s in other.signals
    ]
    # A changed page is context too: the defect keeps being linked (application_defect at medium confidence).
    changed = cl.classify(cl.FailureInput(**{**base.__dict__, "page_changed_by": "CHG-0001 changed /contact"}))
    assert changed.classification == "application_defect" and changed.confidence == "medium"
    assert "page_changed" in [s["code"] for s in changed.signals]


def test_a_repaired_form_with_the_confirmation_shown_is_still_an_application_defect() -> None:
    from app.domain.defects import classify as cl

    err = 'QA_ASSERTION: Expected the Contact us form to block the submission, but the page shows "Thank you"'
    f = cl.FailureInput(status="failed", error=err, attempts=[{"status": "failed", "error": err}] * 2,
                        repaired=["HEAL-0003 accepted: x → y"])  # fmt: skip
    assert cl.classify(f).classification == "application_defect"


def test_involved_picks_only_the_repairs_the_failed_check_goes_through() -> None:
    from app.db.models import HealSuggestion
    from app.domain.enums import HealKind

    def row(key: str, getter: str) -> HealSuggestion:
        return HealSuggestion(key=key, kind=HealKind.locator, file="pages/contact.ts", getter=getter)

    message, form = row("HEAL-0001", "message"), row("HEAL-0003", "form")
    amap = [
        {"helper": "expectFieldFlagged", "args": ["Message"], "kind": "field_flagged",
         "locators": ["pages/contact.ts#message"]},
        {"helper": "expectFormBlocked", "args": ["Contact us"], "kind": "form_blocked",
         "locators": ["pages/contact.ts#form"]},
    ]  # fmt: skip
    on_field = "QA_ASSERTION: Expected Message to be identified as needing attention"
    assert [r.key for r in repairs.involved([message, form], amap, on_field)] == ["HEAL-0001"]
    on_form = 'QA_ASSERTION: Expected the Contact us form to block the submission, but the page shows "Thanks"'
    assert [r.key for r in repairs.involved([message, form], amap, on_form)] == ["HEAL-0003"]
    assert repairs.involved([message, form], amap, "QA_ASSERTION: Expected Email to be identified") == []
