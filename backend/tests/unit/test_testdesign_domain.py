"""Test design domain (P3-01a, P3-03, P3-05, P3-02 lint): values computed in code (EP/BVA), the synthetic guard,
risk-derived priority, the lint vocabulary and the rule generator on a small contact form with AI off."""

from __future__ import annotations

from app.domain.testdesign import generate as gen
from app.domain.testdesign import lint as lint_rules
from app.domain.testdesign import priority as prio
from app.domain.testdesign import synthetic as syn
from app.domain.testdesign import values as val

ANCHOR = "form:/contact:contact"


def _field(name: str, label: str, **kw: object) -> val.FieldFacts:
    return val.FieldFacts(key=f"{ANCHOR}:{name}", name=name, label=label, **kw)  # type: ignore[arg-type]


NAME = _field("name", "Name", required=True, maxlength=80)
EMAIL = _field("email", "Email", type="email", required=True)
MESSAGE = _field("message", "Message")


# ---------------------------------------------------------------- values (EP / BVA)


def test_maxlength_gives_two_values_and_three_for_high_risk() -> None:
    two = val.length_boundaries(NAME, "2_value")
    assert [v.length for s in two for v in s.values] == [80, 81]
    three = val.length_boundaries(NAME, val.mode_for("high"))
    assert [v.length for s in three for v in s.values] == [79, 80, 81]
    assert val.mode_for("medium") == "2_value" and val.mode_for("very_high") == "3_value"


def test_required_means_zero_and_one_unless_minlength_is_larger() -> None:
    req = val.required_boundaries(NAME, "2_value")
    assert req is not None and [v.length for v in req.values] == [0, 1]
    assert val.required_boundaries(_field("m", "Message", required=True, minlength=10), "2_value") is None
    lo = val.length_boundaries(_field("m", "Message", required=True, minlength=10), "2_value")
    assert [v.length for s in lo for v in s.values] == [9, 10]


def test_pattern_quantifier_and_numeric_ranges() -> None:
    phone = _field("phone", "Phone", pattern="[0-9 ]{6,}")
    assert [v.length for s in val.length_boundaries(phone, "2_value") for v in s.values] == [5, 6]
    qty = _field("qty", "Quantity", type="number", min="1", max="10")
    values = [v.value for s in val.range_boundaries(qty, "2_value") for v in s.values]
    assert values == ["0", "1", "10", "11"]


def test_partitions_and_missing_maximum_note() -> None:
    assert [p.kind for p in val.required_partitions(NAME)] == ["valid", "invalid"]
    assert {p.data for p in val.email_partitions(EMAIL)} >= {"email", "email_missing_at"}
    assert val.missing_upper_bounds([NAME, EMAIL, MESSAGE]) == ["Email", "Message"]
    note = val.no_max_note(["Email", "Message"])
    assert note is not None and "No maximum length was discovered" in note


def test_ac_values_only_supply_boundaries() -> None:
    tv = [{"label": "81 characters (one over)", "value": "x" * 81}, {"label": "missing @", "value": "a.example.com"}]
    bs = val.ac_boundaries(NAME, tv)
    assert bs is not None and [v.length for v in bs.values] == [81]


# ---------------------------------------------------------------- synthetic values and the guard


def _luhn_valid(prefix: str) -> str:
    digits = [int(d) for d in prefix]
    for check in range(10):
        nums = [*digits, check]
        total = 0
        for i, d in enumerate(reversed(nums)):
            if i % 2 == 1:
                d *= 2
                d -= 9 if d > 9 else 0
            total += d
        if total % 10 == 0:
            return prefix + str(check)
    raise AssertionError


def test_factories_are_synthetic_and_exact_length() -> None:
    assert syn.email(3).endswith("@example.com")
    assert len(syn.value_of_length(NAME, 81, 7)) == 81
    assert syn.value_of_length(NAME, 81, 7) == syn.value_of_length(NAME, 81, 7)  # seeded, reproducible
    assert not syn.check_value(syn.valid_value(EMAIL, 1), field_type="email", field_label="Email")
    assert not syn.check_value(syn.phone_of_length(12), field_type="tel", field_label="Phone")


def test_guard_messages() -> None:
    def msgs(value: str | None, **kw: object) -> list[str]:
        return [e.message for e in syn.check_value(value, **kw)]  # type: ignore[arg-type]

    assert msgs("real.person@gmail.com", field_label="Email") == [syn.MSG_EMAIL]
    assert msgs("4111 1111 1111 1111", field_label="Card") == []  # published test card
    assert msgs(_luhn_valid("453914880343646"), field_label="Card") == [syn.MSG_CARD]
    assert msgs("hunter2hunter2", field_type="password", field_label="Password") == [syn.MSG_PASSWORD]
    assert msgs(None, secret_ref="nope", known_secrets={"scan_credentials"}) == [
        "No saved test credentials are called 'nope'"
    ]
    assert msgs(None, secret_ref="scan_credentials", known_secrets={"scan_credentials"}) == []
    assert msgs("x" * 79, field_label="Name", boundary_length=81) == [
        "This item tests the 81-character boundary; change the case instead"
    ]
    assert msgs("x" * 5001, field_label="Notes") == [syn.MSG_TOO_LONG]
    assert msgs("+44 20 7946 0000", field_type="tel", field_label="Phone") == [syn.MSG_PHONE]


# ---------------------------------------------------------------- priority


def test_priority_follows_the_highest_linked_risk_and_override_warns() -> None:
    risks = [
        prio.RiskFact("r1", "RISK-001", "medium", 9, "open", frozenset({"req-a"}), frozenset()),
        prio.RiskFact("r2", "RISK-002", "high", 15, "accepted", frozenset({"req-a"}), frozenset()),
    ]
    top = prio.top_risk(risks, {"req-a"}, set())
    assert top is not None and top.key == "RISK-002"  # accepted risks still count
    assert prio.derived_priority("very_high") == "critical" and prio.derived_priority(None) == "low"
    assert prio.effective("high", "low") == "low"
    assert prio.below_risk("low", "high", "high") and not prio.below_risk("low", "medium", "medium")
    assert sorted(["b", "a"], key=lambda k: prio.sort_key("high" if k == "b" else "low", 0, k)) == ["b", "a"]


# ---------------------------------------------------------------- lint


def _facts(**kw: object) -> lint_rules.CaseFacts:
    base: dict[str, object] = {
        "title": "Name with 81 characters",
        "objective": "Check the Name boundary.",
        "steps": [
            {"n": 1, "action": "Open /contact", "expected": ""},
            {"n": 2, "action": "Submit the form", "expected": "Name is marked as too long"},
        ],
        "expected_result": "Name is marked as too long",
        "expected_result_status": "defined",
        "technique": "use_case",
        "test_type": "functional",
        "requirement_count": 1,
    }
    base.update(kw)
    return lint_rules.CaseFacts(**base)  # type: ignore[arg-type]


def test_lint_vocabulary_and_blocking() -> None:
    assert lint_rules.lint_case(_facts()) == []
    codes = {
        i["code"] for i in lint_rules.lint_case(_facts(requirement_count=0, expected_result="It works as expected"))
    }
    assert {"orphan_case", "vague_wording"} <= codes
    oq = lint_rules.lint_case(
        _facts(
            expected_result_status="open_question",
            expected_result="REQ-0007 asks whether it works as expected <field>",
            open_question_message="REQ-0007 asks whether it works as expected <field>",
            open_question_key="REQ-0007",
        )
    )
    assert [i["code"] for i in oq] == ["open_question"]
    assert oq[0]["severity"] == "warning" and oq[0]["blocks_approval"] is True  # decision D6
    assert lint_rules.blocking(oq) == oq
    bva = lint_rules.lint_case(_facts(technique="boundary_value_analysis"))
    assert [i["code"] for i in bva] == ["technique_data_mismatch"] and bva[0]["severity"] == "error"
    secret = lint_rules.lint_case(_facts(objective='Use the password: "hunter2"'))
    assert any(i["code"] == "literal_secret" for i in secret)
    todo = lint_rules.lint_case(_facts(expected_result="TBD"))
    assert any(i["code"] == "unresolved_placeholder" for i in todo)
    low = lint_rules.lint_case(_facts(priority_override="low", derived_priority="high", risk_level="high"))
    assert [i["code"] for i in low] == ["priority_below_risk"] and not lint_rules.blocking(low)


# ---------------------------------------------------------------- generator


def _req(key: str, rule: str, anchor: str, **kw: object) -> gen.ReqIn:
    return gen.ReqIn(
        lineage_id=f"lin-{key}", key=key, title=kw.pop("title", key), description=str(kw.pop("description", "")),  # type: ignore[arg-type]
        match_key=f"{anchor}|{rule}", rule_id=rule, category=str(kw.pop("category", "form_input")),
        type="functional", behaviour_scope="frontend", provenance=str(kw.pop("provenance", "observed")),
        status=str(kw.pop("status", "approved")),
    )  # fmt: skip


def _input(message_question: bool = True) -> gen.DesignInput:
    form = gen.FormIn(ANCHOR, "contact", "contact", "/contact", "Send message", [NAME, EMAIL, MESSAGE])
    reqs = [
        _req("REQ-0001", "form.purpose", ANCHOR, title="Visitors can contact the company"),
        _req("REQ-0002", "form.required_field", NAME.key),
        _req("REQ-0003", "form.length_limit", NAME.key),
        _req("REQ-0004", "form.email_format", EMAIL.key),
    ]
    other = []
    if message_question:
        other.append(
            _req(
                "REQ-0007",
                "form.optional_field",
                MESSAGE.key,
                status="needs_info",
                provenance="unverified",
                title="Is Message optional?",
            )
        )
    types = [
        {"type": "functional", "in_scope": True},
        {"type": "security", "in_scope": True, "requires_approval": True},
    ]
    return gen.DesignInput(requirements=reqs, other_requirements=other, forms=[form], test_types=types)


def test_generator_computes_values_and_never_runs_anything() -> None:
    out = gen.design(_input())
    titles = {c.title for c in out.cases}
    assert {"Name with 0 characters", "Name with 1 character", "Name with 80 characters",
            "Name with 81 characters"} <= titles  # fmt: skip
    boundary = {d.length: d for d in out.data.values() if d.kind == "boundary" and d.field_label == "Name"}
    assert set(boundary) >= {0, 1, 80, 81}
    assert all(len(d.value or "") == n for n, d in boundary.items())
    assert all(not syn.text_issues(d.value or "") for d in out.data.values())
    assert any(n["test_type"] == "security" for n in out.not_designed)
    assert all(c.generated_by == "rules" for c in out.cases)
    assert all(c.requirement_lineages for c in out.cases)


def test_steps_without_expected_results_are_fine_when_one_step_has_one() -> None:
    steps = [
        {"n": 1, "action": "Open /contact", "expected": ""},
        {"n": 2, "action": "Press Send message", "expected": "The form is accepted"},
        {"n": 3, "action": "Press the browser Back button", "expected": ""},
    ]
    assert lint_rules.lint_case(_facts(steps=steps)) == []
    none = [{**st, "expected": ""} for st in steps]
    items = lint_rules.lint_case(_facts(steps=none))
    assert [(i["code"], i["path"], i["blocks_approval"]) for i in items] == [
        ("missing_expected_result", "steps[2].expected", True)
    ]
    overall = lint_rules.lint_case(_facts(steps=steps, expected_result=""))
    assert [(i["code"], i["path"]) for i in overall] == [("missing_expected_result", "expected_result")]


def test_optional_field_next_to_required_ones_is_an_open_question() -> None:
    out = gen.design(_input())
    oq = [c for c in out.cases if c.expected_result_status == "open_question"]
    assert len(oq) == 1
    case = oq[0]
    assert case.title == "Send the contact form with an empty Message"
    assert case.expected_result == "REQ-0007 asks whether Message is optional"  # the UI adds "Not decided:"
    assert case.open_question is not None and case.open_question["key"] == "REQ-0007"
    assert case.open_question["field"] == "Message"


def test_design_is_deterministic() -> None:
    a, b = gen.design(_input()), gen.design(_input())
    assert [c.match_key for c in a.cases] == [c.match_key for c in b.cases]
    assert {k: d.value for k, d in a.data.items()} == {k: d.value for k, d in b.data.items()}


def test_short_values_in_an_email_field_are_invalid_emails() -> None:
    inp = _input()
    inp.requirements.append(_req("REQ-0005", "form.required_field", EMAIL.key))
    out = gen.design(inp)
    one = next(c for c in out.cases if c.title == "Email with 1 character")
    assert not one.positive and one.expected_result.endswith("is identified as an invalid email address")
    value = next(out.data[mk].value for st in one.steps for mk in st["data"] if out.data[mk].field_label == "Email")
    assert value is not None and len(value) == 1
    assert syn.format_problem(EMAIL, "s") == "invalid_email" and syn.format_problem(EMAIL, "a@x.test") is None
    assert syn.value_of_length(EMAIL, 8, 1) == "a@x.test" and syn.value_of_length(EMAIL, 13, 1) == "a@example.com"
    # Every case that expects acceptance uses a value the field's format accepts.
    for c in out.cases:
        if not c.positive:
            continue
        for st in c.steps:
            for mk in st["data"]:
                d = out.data[mk]
                fl = next(f for f in (NAME, EMAIL, MESSAGE) if f.label == d.field_label)
                assert syn.format_problem(fl, d.value or "") is None, (c.title, d.value)


def test_every_approved_requirement_gets_a_case_including_https() -> None:
    inp = _input()
    signin = "form:/sign-in:sign in"
    inp.requirements += [
        gen.ReqIn(
            lineage_id="lin-REQ-0013", key="REQ-0013", title="Sign-in credentials are only sent over HTTPS",
            description="Passwords must never travel unencrypted.", match_key=f"{signin}|nfr.https_credentials",
            rule_id="nfr.https_credentials", category="security", type="non_functional", behaviour_scope="mixed",
            provenance="assumed", status="approved",
            acs=(gen.AcIn("lin-AC-1", "AC-0030", "positive", "the sign-in page", "the form is submitted",
                          "the request uses HTTPS", "assumed"),),
        ),
        gen.ReqIn(
            lineage_id="lin-REQ-0020", key="REQ-0020", title="Order emails are sent to the shop owner",
            description="", match_key="page:/checkout|backend.notification", rule_id=None, category="notifications",
            type="functional", behaviour_scope="backend", provenance="inferred", status="approved",
            acs=(gen.AcIn("lin-AC-2", "AC-0031", "positive", "an order was placed", "the order is confirmed",
                          "the shop owner receives an email", "inferred"),),
        ),
    ]  # fmt: skip
    out = gen.design(inp)
    covered = {lin for c in out.cases for lin in c.requirement_lineages}
    assert {r.lineage_id for r in inp.requirements} <= covered
    https = next(c for c in out.cases if "lin-REQ-0013" in c.requirement_lineages)
    assert https.technique == gen.CHECKLIST and https.test_type == "functional"  # passive: security needs approval
    assert "https://" in https.expected_result and "separate approval" in https.explanation
    backend = next(c for c in out.cases if "lin-REQ-0020" in c.requirement_lineages)
    assert backend.technique == gen.CHECKLIST and backend.steps[0]["expected"] == "The shop owner receives an email"
    assert backend.provenance == "inferred"  # a backend effect is never stronger than inferred
    assert not out.skipped_requirements
    assert any(n["test_type"] == "security" for n in out.not_designed)  # active security testing still isn't designed


def test_extra_negatives_go_beyond_the_baseline() -> None:
    inp = _input()
    base = {c.match_key for c in gen.design(inp).cases}
    extra = gen.extra_negatives(inp, {"lin-REQ-0004"})
    new = [c for c in extra.cases if c.match_key not in base]
    titles = {c.title for c in new}
    assert {"Email with spaces before and after the value", 'Email with two "@": rejected',
            "Email with a space inside: rejected"} <= titles  # fmt: skip
    assert all(not c.positive and c.requirement_lineages == ["lin-REQ-0004"] for c in new)
    assert all(not syn.text_issues(extra.data[mk].value or "") for c in new for st in c.steps for mk in st["data"])
    name = gen.extra_negatives(inp, {"lin-REQ-0003"})
    paste = next(c for c in name.cases if c.title == "Name: paste 81 characters")
    assert paste.provenance == "inferred" and any(st["action"].startswith("Paste") for st in paste.steps)
