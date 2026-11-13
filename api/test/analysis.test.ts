import { test } from "node:test";
import assert from "node:assert/strict";

// Force the rule-based classifier (no AI call).
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
const { analyseFailure } = await import("../src/services/analysis.js");

const testCase = { key: "TC-0011", title: 'Contact form is not sent while "Message" is empty', steps: [], expectedResult: "" };

// Real Playwright output from the demo shop's contact-form bug.
const assertionError = `Error: The form is not sent: the browser flags the "Message" field, or an error message next to it asks for Message

expect(locator).toBeVisible() failed

Locator: locator('input:invalid, textarea:invalid, select:invalid').first()
Expected: visible
Timeout: 10000ms
Error: element(s) not found`;

test("a failed expect() is classed as an application problem, not a script problem", async () => {
  const a = await analyseFailure({ testCase, executionType: "AUTOMATED", status: "FAILED", errorMessage: assertionError, kind: "assertion" });
  assert.equal(a.classification, "APPLICATION");
  assert.equal(a.confidence, "MEDIUM");
  assert.equal(a.generatedBy, "heuristic");
});

test("a failed expect() is recognised from the message alone (no kind passed, e.g. from the assistant)", async () => {
  const a = await analyseFailure({ testCase, executionType: "AUTOMATED", status: "FAILED", errorMessage: assertionError });
  assert.equal(a.classification, "APPLICATION");
});

test("script errors are still classed as script problems", async () => {
  for (const errorMessage of [
    "Error: locator.click: Error: strict mode violation: getByRole('button', { name: 'Send' }) resolved to 2 elements",
    "TypeError: page.foo is not a function",
    "ReferenceError: x is not defined",
  ]) {
    const a = await analyseFailure({ testCase, executionType: "AUTOMATED", status: "ERROR", errorMessage, kind: errorMessage.includes("strict") ? "script" : undefined });
    assert.equal(a.classification, "SCRIPT", errorMessage);
  }
  const ran = await analyseFailure({ testCase, executionType: "AUTOMATED", status: "ERROR", errorMessage: "Test did not run", kind: "script" });
  assert.equal(ran.classification, "SCRIPT");
});

test("network failures and timeouts keep their own classes", async () => {
  const net = await analyseFailure({ testCase, executionType: "AUTOMATED", status: "FAILED", errorMessage: "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4100/" });
  assert.equal(net.classification, "NETWORK");
  const slow = await analyseFailure({ testCase, executionType: "AUTOMATED", status: "FAILED", errorMessage: "locator.click: Timeout 10000ms exceeded.", kind: "timeout" });
  assert.equal(slow.classification, "UNKNOWN");
});
