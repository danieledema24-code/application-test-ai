"""Rule classifier for failed, errored and flaky results (P4-08). Pure; first match wins.

Ported from the legacy Node API's `src/services/analysis.ts` heuristic (on `main`) with its correction kept: a failed assertion
(`QA_ASSERTION:` or a failed `expect(…)`) means the script ran and the page did not behave as the case expects, so it
points at the **application**, not the script. Playwright assertion text mentions "locator", so only explicit script
errors (TypeError, ReferenceError, SyntaxError, strict-mode violations, guard or fixture errors) are script defects.

Order: flaky → network → environment → script → element not found → test data → application → unknown.
Every result is a hypothesis; the classification never changes the result's status.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

QA_PREFIX = "QA_ASSERTION:"
NETWORK = re.compile(
    r"net::ERR_[A-Z_]+|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|"
    r"NS_ERROR_[A-Z_]+|SSL_ERROR|ERR_CERT_[A-Z_]+|Could not connect|Connection refused",
    re.I,
)
BLOCKED = re.compile(r"BLOCKED by policy (\S+)", re.I)
SCRIPT = re.compile(
    r"strict mode violation|TypeError|ReferenceError|SyntaxError|is not a function|is not defined|"
    r"Script not run|spec-guard|Cannot find module|fixture",
    re.I,
)
ACTION_TIMEOUT = re.compile(
    r"^(?:\w*Error:\s*)?(?:locator|page|frame)\.(click|fill|dblclick|check|uncheck|selectOption|press|type|hover|"
    r"setInputFiles|focus|tap):\s*(?:Test\s+)?timeout\s*(?:of\s*)?\d+ms exceeded",
    re.I | re.M,
)
WAITING_FOR = re.compile(r"waiting for (get[A-Za-z]+\([^\n]*?\)|locator\([^\n]*?\))(?:\.first\(\))?\s*$", re.M)
EXPECT_FAILED = re.compile(
    r"expect\([^)]*\)\.\w+\([^)]*\) failed|^\s*Expected[: ].*\n\s*(Received|Timeout)", re.I | re.M
)
HTTP_STATUS = re.compile(r"HTTP (\d{3}) (GET|POST|PUT|PATCH|DELETE|HEAD) (\S+)")
SUCCESS = re.compile(r"\b(thank you|thanks|message sent|has been sent|success(fully)?|submitted|received)\b", re.I)
CREDENTIALS_MISSING = re.compile(r"Saved test credentials are not available", re.I)
MISSING_BROWSER = re.compile(r"Executable doesn't exist|browserType\.launch", re.I)
TIME_LIMIT = re.compile(r"Run time limit reached", re.I)

LABELS = {
    "application_defect": "Likely bug in the application",
    "selector_failure": "Element not found",
    "script_defect": "Problem in the test script",
    "test_data_issue": "Test data problem",
    "environment_failure": "Environment problem",
    "network_failure": "Site unreachable",
    "flaky": "Flaky",
    "unknown": "Cause unclear",
}


@dataclass
class FailureInput:
    status: str  # failed | error | flaky
    error: str = ""
    attempts: list[dict[str, Any]] = field(default_factory=list)  # [{status, error}]
    steps: list[dict[str, Any]] = field(default_factory=list)  # last attempt: [{n, title, status}]
    failed_step: dict[str, Any] | None = None
    page_state: dict[str, Any] | None = None
    network_log: str = ""
    console_log: str = ""
    target_host: str = ""
    expected_result: str = ""
    expects_sign_in_failure: bool = False
    assertions: list[dict[str, Any]] = field(default_factory=list)  # assertion map of the script
    valid_fields: list[str] = field(default_factory=list)  # fields filled with valid synthetic data
    history: list[tuple[int | None, str]] = field(default_factory=list)  # (script version, status), newest first
    script_version: int | None = None
    page_path: str | None = None  # the page the failed step is on, when known


@dataclass
class Analysis:
    classification: str
    confidence: str
    signals: list[dict[str, Any]]
    summary: str
    possible_causes: list[str]
    next_steps: list[str]
    hypothesis: bool = True
    generated_by: str = "rules"

    def as_dict(self) -> dict[str, Any]:
        return {
            "classification": self.classification,
            "label": LABELS[self.classification],
            "confidence": self.confidence,
            "signals": self.signals,
            "summary": self.summary,
            "possible_causes": self.possible_causes[:4],
            "next_steps": self.next_steps[:4],
            "hypothesis": True,
            "generated_by": self.generated_by,
        }


def _sig(code: str, detail: str, evidence: list[str] | None = None) -> dict[str, Any]:
    return {"code": code, "detail": detail, "observed": True, "evidence": evidence or []}


def _first_line(text: str) -> str:
    for line in (text or "").split("\n"):
        line = re.sub(r"^(Error:\s*)+", "", line.strip())
        if line:
            return line[:300]
    return ""


def _shown(state: dict[str, Any] | None) -> str:
    if not state:
        return ""
    return str(state.get("heading") or state.get("title") or "")


def is_assertion(text: str) -> bool:
    first = _first_line(text)
    if first.startswith(QA_PREFIX) or QA_PREFIX in (text or "")[:200]:
        return True
    return bool(EXPECT_FAILED.search(text or "")) and not re.search(r"strict mode violation", text or "", re.I)


def _form_and_fields(assertions: list[dict[str, Any]]) -> tuple[str | None, list[str]]:
    form = None
    fields: list[str] = []
    for a in assertions:
        args = [str(x) for x in a.get("args") or []]
        if a.get("helper") in ("expectSubmissionBlocked", "expectSubmissionAccepted", "expectFormShown") and args:
            form = form or args[0]
        if a.get("helper") == "expectFieldFlagged" and args:
            fields.append(args[-1])
    return form, fields


def classify(f: FailureInput) -> Analysis:
    err = f.error or ""
    first = _first_line(err)
    net = f.network_log or ""
    attempts = f.attempts or [{"status": f.status, "error": err}]
    failed_attempts = [a for a in attempts if a.get("status") not in ("passed", "skipped")]
    every = len(attempts) > 0 and len(failed_attempts) == len(attempts)

    # 1. Flaky: passed on retry (high), or the same script version both passed and failed recently (medium).
    if f.status == "flaky":
        return Analysis(
            "flaky",
            "high",
            [_sig("flaky_retry_pass", f"Failed on attempt 1, passed on attempt {len(attempts)}", ["video"])],
            "The test failed, then passed when it ran again. This points at timing or shared state, not at a bug.",
            [
                "A check runs before the page has finished updating",
                "Test data shared with another test",
                "An intermittent slow response from the site",
            ],
            ["Look at the failed attempt's video", "Re-run the test to see whether it keeps happening"],
        )
    same = [st for v, st in f.history[:5] if v == f.script_version]
    if "passed" in same and any(st in ("failed", "error") for st in same):
        return Analysis(
            "flaky",
            "medium",
            [_sig("flaky_history", "The same script both passed and failed in the last 5 runs, with no change")],
            "This test has both passed and failed recently without any change to the test case or the script.",
            ["Timing-dependent checks", "Shared or changing test data", "Intermittent errors on the site"],
            ["Re-run the test to confirm", "Compare the passing and failing runs' evidence"],
        )

    # 2. Network: DNS, connection refused or reset, TLS, net::ERR_*.
    m = NETWORK.search(err) or NETWORK.search("\n".join(ln for ln in net.splitlines() if " FAILED " in ln))
    if m and not BLOCKED.search(m.group(0)):
        return Analysis(
            "network_failure",
            "high" if NETWORK.search(err) else "medium",
            [_sig("network_error", m.group(0), ["network_log"])],
            "The site couldn't be reached, or the connection dropped while the test was running.",
            [
                "The site is down or restarting",
                "A DNS or TLS problem",
                "The network between the test runner and the site",
            ],
            ["Open the site in a browser to check it responds", "Re-run once the site is reachable"],
        )

    # 3. Environment: a policy block on navigation, sign-in refused, a missing browser, the run's time limit.
    blocked = BLOCKED.search(err) or (BLOCKED.search(net) if f.page_state and _shown(f.page_state) == "" else None)
    if blocked:
        return Analysis(
            "environment_failure",
            "medium",
            [_sig("policy_block", f"Blocked by safety policy: {blocked.group(1)[:200]}", ["network_log"])],
            "A request was blocked because it goes outside the approved site, so the test couldn't continue.",
            ["The site redirects to another address (for example single sign-on)", "A link points to another site"],
            [
                "Check the network log for the blocked address",
                "Add the address to the approved site only if you are authorised to test it",
            ],
        )
    for code, rx, detail in (
        ("auth_refused", CREDENTIALS_MISSING, "The saved test account wasn't available to the test"),
        ("missing_browser", MISSING_BROWSER, "The browser isn't installed on the test server"),
        ("time_limit", TIME_LIMIT, "The run reached its time limit"),
    ):
        if rx.search(err):
            return Analysis(
                "environment_failure",
                "high",
                [_sig(code, detail)],
                "Something around the test stopped it before it could check the site.",
                ["The test environment isn't set up for this test"],
                ["Fix the environment, then re-run the test"],
            )
    refused = [h for h in HTTP_STATUS.findall(net) if h[0] in ("401", "403")]
    if refused and not f.expects_sign_in_failure:
        return Analysis(
            "environment_failure",
            "medium",
            [_sig("auth_refused", f"HTTP {refused[0][0]} on {refused[0][2][:200]}", ["network_log"])],
            "The site refused access to a page the test needed, so the test couldn't check what it should.",
            ["The saved test account has expired or lacks permission", "The page now needs a sign-in"],
            ["Check the saved test account in Project settings", "Re-run after fixing access"],
        )

    # 4. Script: the script itself broke (never a failed assertion).
    if not is_assertion(err) and SCRIPT.search(err):
        strict = bool(re.search(r"strict mode violation", err, re.I))
        return Analysis(
            "script_defect",
            "medium",
            [
                _sig(
                    "strict_mode" if strict else "script_error",
                    "A locator matched more than one element" if strict else first,
                    ["console_log"],
                )
            ],
            "The test script itself broke, so the site wasn't really tested.",
            [
                "A locator matches more than one element" if strict else "A coding error in the script",
                "The script doesn't match the current page",
            ],
            ["Validate the scripts again", "Regenerate the scripts if the test case changed"],
        )

    # 5. Element not found: an action timed out waiting for an element.
    if not is_assertion(err) and ACTION_TIMEOUT.search(err):
        w = WAITING_FOR.search(err)
        locator = w.group(1) if w else "an element"
        page = (f.page_state or {}).get("url") or ""
        matches = bool(f.page_path) and str(page).split("?")[0] == f.page_path
        signals = [_sig("element_not_found", f"Waiting for {locator} timed out", ["screenshot"])]
        if f.page_path:
            signals.append(
                _sig(
                    "page_matches" if matches else "page_differs",
                    f"The page was {page or 'unknown'}" + ("" if matches else f", not {f.page_path}"),
                    ["screenshot"],
                )
            )
        return Analysis(
            "selector_failure",
            "medium" if matches or not f.page_path else "low",
            signals,
            f"The test couldn't find {locator} on the page. The page may have changed since discovery.",
            ["A label or button name changed", "The element is now hidden or moved"],
            ["Look at the final screenshot", "Accept a fix suggestion or validate the scripts again"],
        )

    # 6. Test data: an "accepted" check failed while a field filled with valid data is flagged.
    shown_msgs = " ".join(str(x) for x in (f.page_state or {}).get("messages") or [])
    if is_assertion(err) and re.search(r"to be accepted", first, re.I) and f.valid_fields:
        hit = next((fld for fld in f.valid_fields if fld and re.search(re.escape(fld), shown_msgs, re.I)), None)
        if hit:
            return Analysis(
                "test_data_issue",
                "medium",
                [
                    _sig(
                        "field_rejected_valid_data",
                        f"The page flags {hit}, which was filled with a valid value",
                        ["screenshot"],
                    )
                ],
                f"The site rejected the value the test uses as a valid {hit}.",
                [f"The site's rules for {hit} are stricter than the test data", "The test data is out of date"],
                ["Check the test data item for this field", "Confirm the field's rules with the product owner"],
            )

    # 7. Application: an assertion failed after every action step passed, or a server error.
    if is_assertion(err) or (f.status == "failed" and not err):
        steps = f.steps or []
        fs = f.failed_step or {}
        before = [s for s in steps if s.get("n", 0) < fs.get("n", 10**6)]
        signals = []
        if all(s.get("status") == "passed" for s in before):
            n = fs.get("n")
            signals.append(
                _sig(
                    "assertion_failed_after_actions",
                    "Every action step passed, then the check failed",
                    ["steps"] if not n else [f"steps 1–{n}"],
                )
            )
        shown = _shown(f.page_state)
        contradicts = bool(shown) and (
            (
                re.search(r"block the submission|to be shown|still be shown|not be accepted", first, re.I)
                and (SUCCESS.search(shown) or SUCCESS.search(shown_msgs))
            )
            or "but the page shows" in first
        )
        if contradicts:
            signals.append(
                _sig(
                    "page_contradicts_expected",
                    f'The page showed "{shown}" instead of what the test case expects',
                    ["screenshot", "video"],
                )
            )
        if every and len(attempts) > 1:
            signals.append(_sig("failed_every_attempt", f"It failed on all {len(attempts)} attempts"))
        elif every:
            signals.append(_sig("failed_every_attempt", "It failed on its only attempt (not retried)"))
        bad_http = [h for h in HTTP_STATUS.findall(net) if h[0].startswith("5")]
        if not BLOCKED.search(net) and not bad_http and " FAILED " not in net:
            signals.append(
                _sig("no_network_errors", "No network errors, safety blocks or server errors", ["network_log"])
            )
        confidence = "high" if every and contradicts and len(attempts) > 1 else "medium"
        form, fields = _form_and_fields(f.assertions)
        causes = []
        for fld in fields[:2]:
            causes.append(f"The {fld} field isn't marked as required in the form.")
        if form and re.search(r"block the submission", first, re.I):
            causes.append(f"The server accepts the {form} form without checking {fields[0] if fields else 'it'}.")
        causes = causes or [
            "The application behaves differently from the test case's expected result",
            "The expected result is out of date because the application changed on purpose",
        ]
        return Analysis(
            "application_defect",
            confidence,
            signals,
            "The test did every step, and the site didn't do what the test case expects. "
            "This is most likely a bug in the application.",
            causes,
            ["Confirm or reject the defect draft (Gate 8)", "After a fix, re-run the test to verify"],
        )
    bad_http = [h for h in HTTP_STATUS.findall(net) if h[0].startswith("5")]
    if bad_http:
        return Analysis(
            "application_defect",
            "medium",
            [
                _sig(
                    "server_error", f"HTTP {bad_http[0][0]} on {bad_http[0][1]} {bad_http[0][2][:200]}", ["network_log"]
                )
            ],
            "The site answered with a server error.",
            ["An unhandled error on the server", "Input the server doesn't validate"],
            ["Check the server logs at the time of the run", "Confirm or reject the defect draft (Gate 8)"],
        )

    # 8. Unknown.
    return Analysis(
        "unknown",
        "low",
        [_sig("no_clear_signal", first or "No error detail was recorded")],
        "The evidence doesn't point to one cause. A person needs to look.",
        ["The application", "The test script", "The environment"],
        ["Look at the screenshot, video and logs", "Run the test by hand to confirm"],
    )
