"""P4-06 report parsing and P4-08 rule classifier (pure), plus P4-09 code-derived defect fields."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import pytest

from app.domain.defects import classify as cl
from app.domain.enums import DefectSeverity
from app.domain.execution import report as rep
from app.services import defects as dsvc

QA = (
    "QA_ASSERTION: Expected the Contact us form to block the submission and still be shown, but the page shows "
    '"Thank you" (Message sent) at /contact.'
)
# Real Playwright output from the demo shop's contact-form bug (the legacy Node API's test/analysis.test.ts, on main).
EXPECT_ERROR = """Error: The form is not sent: the browser flags the "Message" field, or an error message next to it asks for Message

expect(locator).toBeVisible() failed

Locator: locator('input:invalid, textarea:invalid, select:invalid').first()
Expected: visible
Timeout: 10000ms
Error: element(s) not found"""
STEPS = [
    {"n": 1, "title": "Open /contact", "status": "passed"},
    {"n": 2, "title": 'Enter "Ada Test" in Name', "status": "passed"},
    {"n": 3, "title": "Leave Message empty", "status": "passed"},
    {"n": 4, "title": "Press Send message", "status": "failed"},
]


def _f(**kw: Any) -> cl.FailureInput:
    base: dict[str, Any] = {
        "status": "failed",
        "error": QA,
        "attempts": [{"status": "failed"}, {"status": "failed"}],
        "steps": STEPS,
        "failed_step": {"n": 4, "title": "Press Send message"},
        "page_state": {"url": "/contact", "heading": "Thank you", "messages": ["Message sent"]},
        "network_log": "[t] HTTP 200 GET http://127.0.0.1/contact\n[t] HTTP 200 POST http://127.0.0.1/contact",
        "assertions": [
            {"helper": "expectSubmissionBlocked", "args": ["Contact us"], "kind": "submission_blocked"},
            {"helper": "expectFieldFlagged", "args": ["Contact us", "Message"], "kind": "field_flagged"},
        ],
    }
    base.update(kw)
    return cl.FailureInput(**base)


# ------------------------------------------------------------------ classifier


def test_demo_failure_is_a_likely_application_bug_with_its_signals() -> None:
    a = cl.classify(_f())
    assert (a.classification, a.confidence) == ("application_defect", "high")
    codes = [s["code"] for s in a.signals]
    assert codes == [
        "assertion_failed_after_actions",
        "page_contradicts_expected",
        "failed_every_attempt",
        "no_network_errors",
    ]
    assert all(s["observed"] for s in a.signals)
    assert a.possible_causes[0] == "The Message field isn't marked as required in the form."
    assert a.possible_causes[1] == "The server accepts the Contact us form without checking Message."
    d = a.as_dict()
    assert d["hypothesis"] is True and d["generated_by"] == "rules" and d["label"] == "Likely bug in the application"


def test_a_failed_expect_is_application_not_script_ported_from_the_old_api() -> None:
    a = cl.classify(_f(error=EXPECT_ERROR, page_state=None, attempts=[{"status": "failed"}]))
    assert (a.classification, a.confidence) == ("application_defect", "medium")


@pytest.mark.parametrize(
    "error",
    [
        "Error: locator.click: Error: strict mode violation: getByRole('button', { name: 'Send' }) resolved to 2 elements",
        "TypeError: page.foo is not a function",
        "ReferenceError: x is not defined",
    ],
)
def test_script_errors_stay_script_defects(error: str) -> None:
    assert cl.classify(_f(status="error", error=error)).classification == "script_defect"


def test_flaky_retry_pass_is_flaky_high_and_history_is_medium() -> None:
    a = cl.classify(_f(status="flaky", attempts=[{"status": "failed"}, {"status": "passed"}]))
    assert (a.classification, a.confidence) == ("flaky", "high")
    h = cl.classify(_f(history=[(1, "passed"), (1, "failed")], script_version=1))
    assert (h.classification, h.confidence) == ("flaky", "medium")
    other_version = cl.classify(_f(history=[(1, "passed"), (1, "failed")], script_version=2))
    assert other_version.classification == "application_defect"


def test_network_failures_win_over_assertions() -> None:
    a = cl.classify(_f(error="page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4100/"))
    assert a.classification == "network_failure" and a.signals[0]["detail"] == "net::ERR_CONNECTION_REFUSED"
    log = cl.classify(_f(error="", status="error", network_log="[t] FAILED GET http://x/ — net::ERR_CONNECTION_RESET"))
    assert log.classification == "network_failure"


def test_policy_blocks_and_refused_access_are_environment_problems() -> None:
    a = cl.classify(_f(status="error", error="BLOCKED by policy http://169.254.169.254/x (Cloud metadata endpoint)"))
    assert a.classification == "environment_failure" and "169.254.169.254" in a.signals[0]["detail"]
    r = cl.classify(_f(network_log="[t] HTTP 403 GET http://127.0.0.1/account"))
    assert r.classification == "environment_failure" and r.signals[0]["code"] == "auth_refused"
    expected = cl.classify(_f(network_log="[t] HTTP 403 GET http://127.0.0.1/account", expects_sign_in_failure=True))
    assert expected.classification == "application_defect"
    t = cl.classify(_f(status="error", error="Run time limit reached"))
    assert t.classification == "environment_failure" and t.signals[0]["code"] == "time_limit"


def test_action_timeout_is_element_not_found_and_assertion_timeout_is_not() -> None:
    err = (
        "Error: locator.fill: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByLabel('Message', "
        "{ exact: true })"
    )
    a = cl.classify(_f(error=err, page_path="/contact"))
    assert (a.classification, a.confidence) == ("selector_failure", "medium")
    assert "getByLabel('Message', { exact: true })" in a.signals[0]["detail"]
    elsewhere = cl.classify(_f(error=err, page_path="/login"))
    assert elsewhere.confidence == "low"
    assert cl.classify(_f(error=EXPECT_ERROR)).classification == "application_defect"
    # When the action outlives the test, Playwright words it "Test timeout of …ms exceeded".
    test_timeout = (
        "Error: locator.click: Test timeout of 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button')"
    )
    assert cl.classify(_f(error=test_timeout, page_path="/contact")).classification == "selector_failure"
    # Newer Playwright names the error class.
    typed = "TimeoutError: locator.fill: Timeout 15000ms exceeded.\nCall log:\n  - waiting for getByLabel('Message')"
    assert cl.classify(_f(error=typed, page_path="/contact")).classification == "selector_failure"


def test_valid_test_data_rejected_is_a_test_data_issue() -> None:
    err = "QA_ASSERTION: Expected the Contact us form to be accepted and a confirmation to be shown, but the page shows ..."
    state = {"url": "/contact", "heading": "Contact", "messages": ["Email is not allowed"]}
    a = cl.classify(_f(error=err, page_state=state, valid_fields=["Email"]))
    assert a.classification == "test_data_issue"
    assert cl.classify(_f(error=err, page_state=state, valid_fields=["Phone"])).classification == "application_defect"


def test_server_errors_and_unknowns() -> None:
    a = cl.classify(_f(status="error", error="", network_log="[t] HTTP 500 POST http://x/contact"))
    assert (a.classification, a.signals[0]["code"]) == ("application_defect", "server_error")
    u = cl.classify(_f(status="error", error="Something odd happened", network_log=""))
    assert (u.classification, u.confidence) == ("unknown", "low")


# ------------------------------------------------------------------ report parsing


def _att(name: str, body: bytes, ctype: str) -> dict[str, Any]:
    return {"name": name, "contentType": ctype, "body": base64.b64encode(body).decode()}


def _result(
    status: str, retry: int, error: str | None = None, steps: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    state = {
        "url": "/contact",
        "title": "Contact",
        "heading": "Thank you",
        "messages": ["Message sent"],
        "browser": "Chromium 140.0",
    }
    return {
        "status": status,
        "retry": retry,
        "duration": 1234.4,
        "error": {"message": error} if error else None,
        "steps": steps
        or [
            {"title": "Before Hooks", "duration": 5},
            {"title": "Open /contact", "duration": 300, "category": "test.step"},
            {
                "title": "Press Send message",
                "duration": 900,
                "category": "test.step",
                **({"error": {"message": error}} if error else {}),
            },
            {"title": "After Hooks", "duration": 5},
        ],
        "attachments": [
            _att("page-state", json.dumps(state).encode(), "application/json"),
            _att("final-state", b"\x89PNG", "image/png"),
            _att("console", b"[t] log: secret-pass-1 typed", "text/plain"),
            {"name": "unrelated", "contentType": "text/plain", "body": ""},
        ],
    }


def _test(status: str, results: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "file": "contact/TC-0019.spec.ts",
        "title": "TC-0019: x",
        "project": "chromium-1440x900~once",
        "status": status,
        "results": results,
    }


def test_failed_on_both_attempts() -> None:
    t = _test("unexpected", [_result("failed", 0, QA), _result("failed", 1, QA)])
    o = rep.parse_test(t, [], lambda _p: None)
    assert o.status == "failed" and len(o.attempts) == 2 and o.kind == "assertion"
    assert o.failed_step == {"n": 2, "title": "Press Send message"}
    assert [s["title"] for s in o.steps] == ["Open /contact", "Press Send message"]
    assert o.actual_result.startswith("Step 'Press Send message' failed: Expected the Contact us form to block")
    assert "Thank you" in o.actual_result
    assert {a.name for a in o.attempts[0].attachments} == {"page-state", "final-state", "console"}
    assert rep.project_target(t["project"]) == ("chromium", "1440x900")


def test_flaky_passed_and_errors() -> None:
    flaky = rep.parse_test(_test("flaky", [_result("failed", 0, QA), _result("passed", 1)]), [], lambda _p: None)
    assert flaky.status == "flaky" and flaky.error and flaky.failed_step is not None
    passed = rep.parse_test(_test("expected", [_result("passed", 0)]), [], lambda _p: None)
    assert passed.status == "passed" and passed.error is None and passed.failed_step is None
    script = rep.parse_test(
        _test("unexpected", [_result("failed", 0, "TypeError: x is not a function")]), [], lambda _p: None
    )
    assert script.status == "error" and script.kind == "script"
    hang = rep.parse_test(
        _test("unexpected", [_result("timedOut", 0, "Test timeout of 60000ms exceeded.")]), [], lambda _p: None
    )
    assert hang.status == "failed" and hang.kind == "timeout"
    stopped = rep.parse_test(_test("unexpected", [_result("interrupted", 0)]), [], lambda _p: None)
    assert stopped.status == "error" and stopped.kind == "interrupted"
    none = rep.no_result("Run cancelled")
    assert none.status == "error" and none.actual_result == "The test couldn't finish: run cancelled."


def test_secrets_and_ansi_are_removed_and_errors_capped() -> None:
    err = "\x1b[31mQA_ASSERTION: typed secret-pass-1 into Password\x1b[39m" + "x" * 9000
    o = rep.parse_test(_test("unexpected", [_result("failed", 0, err)]), ["secret-pass-1"], lambda _p: None)
    assert o.error is not None and "secret-pass-1" not in o.error and "\x1b" not in o.error
    assert len(o.error) <= rep.MAX_ERROR


def test_attachments_are_read_only_inside_the_workspace(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    (ws / "test-results").mkdir(parents=True)
    inside = ws / "test-results" / "video.webm"
    inside.write_bytes(b"webm")
    outside = tmp_path / "secret.txt"
    outside.write_text("nope")
    link = ws / "test-results" / "link.webm"
    link.symlink_to(outside)
    read = rep.safe_reader(ws)
    assert read(str(inside)) == b"webm"
    assert read(str(outside)) is None and read(str(link)) is None and read("/etc/passwd") is None


def test_collect_tests_walks_nested_suites() -> None:
    report = {
        "suites": [
            {
                "suites": [
                    {
                        "specs": [
                            {
                                "file": "a.spec.ts",
                                "title": "T",
                                "tests": [
                                    {
                                        "projectName": "chromium-390x844",
                                        "status": "expected",
                                        "results": [{"status": "passed"}],
                                    }
                                ],
                            }
                        ]
                    }
                ]
            }
        ]
    }
    tests = rep.collect_tests(report)
    assert tests[0]["project"] == "chromium-390x844" and tests[0]["file"] == "a.spec.ts"


# ------------------------------------------------------------------ derived defect fields


def test_severity_derivation() -> None:
    assert dsvc.derive_severity("very_high", []) == (
        DefectSeverity.critical,
        "from the linked requirement's very high risk",
    )
    assert dsvc.derive_severity("high", [])[0] == DefectSeverity.major
    assert dsvc.derive_severity(None, ["submission_blocked"]) == (DefectSeverity.major, "a blocked submission failed")
    assert dsvc.derive_severity("low", ["signed_in"]) == (DefectSeverity.major, "a sign-in check failed")
    assert dsvc.derive_severity("medium", ["text_visible"])[0] == DefectSeverity.minor


def test_defect_summary_from_the_case_title() -> None:
    bug = {"classification": "application_defect"}
    assert (
        dsvc.summary_for("Send the contact form with an empty Message", bug) == "Contact form accepts an empty Message"
    )
    assert (
        dsvc.summary_for("Sign in keeps the session", bug)
        == "Sign in keeps the session: the expected result didn't happen"
    )


# ------------------------------------------------------------------ fix suggestions (P4-08, §9.3)

from app.api.errors import Conflict  # noqa: E402
from app.services import heal  # noqa: E402


def test_parse_locator_reads_label_placeholder_and_role_with_name() -> None:
    assert heal.parse_locator("waiting for getByLabel('Message', { exact: true })") == heal.Missing("label", "Message")
    assert heal.parse_locator('waiting for getByPlaceholder("Search")') == heal.Missing("placeholder", "Search")
    assert heal.parse_locator("getByRole('button', { name: 'Send message' })") == heal.Missing(
        "role", "Send message", "button"
    )
    assert heal.parse_locator("locator('#x')") is None


def test_rank_prefers_similar_wording_and_the_same_kind_of_control_and_skips_taken_names() -> None:
    offered = [("Your name", "input"), ("Email", "input"), ("Comments", "textarea"), ("Message body", "input")]
    assert heal.rank("Message", offered, {"Your name", "Email"}, "textarea")[:2] == ["Message body", "Comments"]
    assert heal.rank("Message", offered, {"Your name", "Email", "Message body"}, "textarea") == ["Comments"]


def test_find_spec_and_expression_come_from_the_bundle_output() -> None:
    item = {"getter": "message", "element": "Message field", "by": "label", "name": "Message", "exact": True}
    output = {"locators": {"pages/ContactPage.ts": [item]}, "script_locators": {"L1": ["pages/ContactPage.ts#message"]}}
    assert heal.find_spec(output, "L1", heal.Missing("label", "Message")) == ("pages/ContactPage.ts", item)
    assert heal.find_spec(output, "L2", heal.Missing("label", "Message")) is None
    assert heal.find_spec(output, "L1", heal.Missing("placeholder", "Message")) is None
    assert heal.expression(item).startswith('this.page.getByLabel("Message"')
    alts = heal.candidates_for(item, ["Comments"], "textbox")
    assert [(a["by"], a["name"]) for a in alts] == [("label", "Comments"), ("role", "Comments")]


def test_apply_fix_changes_exactly_one_locator_line() -> None:
    code = 'class P {\n  get message() { return this.page.getByLabel("Message"); }\n  x = 1;\n}\n'
    out = heal.apply_fix(code, 'getByLabel("Message")', 'getByLabel("Comments")')
    assert out == code.replace("Message", "Comments")
    with pytest.raises(Conflict, match="changed since this suggestion"):
        heal.apply_fix(code + code, 'getByLabel("Message")', 'getByLabel("Comments")')
    with pytest.raises(Conflict, match="changed since this suggestion"):
        heal.apply_fix(code, 'getByLabel("Name")', 'getByLabel("Comments")')
    with pytest.raises(Conflict, match="more than the locator"):
        heal.apply_fix(code, 'getByLabel("Message")', 'getByLabel("Comments"));\n  y = 2;')


def test_a_result_that_was_not_analysed_is_not_a_hypothesis() -> None:
    """QA P4-BUG-12: "Did the tests pass?" groups unanalysed failures as "Not analysed", without "(hypothesis)"."""
    from app.db.models import ExecutionResult
    from app.domain.enums import FailureClass
    from app.services.assistant_p4 import _cause

    assert _cause(ExecutionResult(analysis=None, classification=None)) == "Not analysed"
    done = ExecutionResult(
        analysis={"label": "Likely bug in the application"}, classification=FailureClass.application_defect
    )
    assert _cause(done) == "Likely bug in the application (hypothesis)"
    by_person = ExecutionResult(
        analysis={"label": "Flaky", "overridden": {"by": "u"}}, classification=FailureClass.flaky
    )
    assert _cause(by_person) == "Flaky (set by a person)"
