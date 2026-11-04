import { z } from "zod/v4";
import { aiJSON } from "./ai.js";

export type FailureAnalysis = {
  hypothesis: true;
  classification: "APPLICATION" | "SCRIPT" | "ENVIRONMENT" | "NETWORK" | "FLAKY" | "UNKNOWN";
  confidence: "LOW" | "MEDIUM" | "HIGH";
  summary: string;
  possibleCauses: string[];
  suggestedNextSteps: string[];
  generatedBy: "claude" | "heuristic";
};

export type FailureEvidence = {
  testCase: { key: string; title: string; steps: unknown; expectedResult: string };
  executionType: string;
  status: string;
  errorMessage: string;
  failedStep?: string | null;
  kind?: string | null;
  consoleExcerpt?: string;
  networkExcerpt?: string;
  apiExchange?: unknown;
  previousResults?: string[];
  script?: string;
};

const Schema = z.object({
  classification: z.enum(["APPLICATION", "SCRIPT", "ENVIRONMENT", "NETWORK", "FLAKY", "UNKNOWN"]),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  summary: z.string(),
  possibleCauses: z.array(z.string()),
  suggestedNextSteps: z.array(z.string()),
});

/** Spec FR-037/FR-050: classify a failure. The result is always labelled a hypothesis and never changes the recorded status. */
export async function analyseFailure(ev: FailureEvidence, secrets: string[] = []): Promise<FailureAnalysis> {
  const ai = await aiJSON({
    schema: Schema,
    secrets,
    task:
      "A test failed. Using only the evidence below, classify the most likely cause as APPLICATION (a real defect in the app under test), " +
      "SCRIPT (the automation script is wrong or brittle, e.g. bad selector), ENVIRONMENT (env misconfiguration, missing data, auth), " +
      "NETWORK (connectivity/DNS/blocked request), FLAKY (intermittent: the same test has passed and failed recently with no change), or UNKNOWN. " +
      "Be honest about confidence. Keep summary to 2-3 sentences; give at most 4 causes and 4 next steps.",
    input: ev,
  });
  if (ai) return { hypothesis: true, generatedBy: "claude", ...ai };
  return heuristic(ev);
}

function heuristic(ev: FailureEvidence): FailureAnalysis {
  const msg = `${ev.errorMessage}\n${ev.networkExcerpt ?? ""}`;
  const prev = ev.previousResults ?? [];
  const flaky = prev.includes("PASSED") && prev.some((s) => s === "FAILED" || s === "ERROR");
  const base = { hypothesis: true as const, generatedBy: "heuristic" as const };
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|net::ERR|fetch failed|socket hang up|ETIMEDOUT/i.test(msg))
    return { ...base, classification: "NETWORK", confidence: "MEDIUM", summary: "The target could not be reached reliably during execution.",
      possibleCauses: ["The environment URL is down or unreachable", "DNS or TLS problem", "A request was blocked by the platform network policy"],
      suggestedNextSteps: ["Open the environment URL manually", "Check the network log evidence for blocked or failed requests", "Re-run once connectivity is confirmed"] };
  if (/blockedbyclient|BLOCKED by policy/i.test(msg))
    return { ...base, classification: "ENVIRONMENT", confidence: "MEDIUM", summary: "A request was blocked because it targets a host outside the approved environment.",
      possibleCauses: ["The application redirects to a different domain (e.g. SSO)", "The environment base URL is incomplete"],
      suggestedNextSteps: ["Review the network log for blocked hosts", "Add the domain as an approved host in the environment configuration if you are authorised to test it"] };
  if (flaky)
    return { ...base, classification: "FLAKY", confidence: "LOW", summary: "This test has both passed and failed in recent runs, which suggests instability.",
      possibleCauses: ["Timing-dependent assertions", "Shared or changing test data", "Intermittent backend errors"],
      suggestedNextSteps: ["Re-run the test to confirm", "Replace fixed waits with web-first assertions", "Check whether test data is shared between runs"] };
  if (ev.kind === "script" || /locator|strict mode violation|is not a function|SyntaxError|ReferenceError|TypeError/i.test(msg))
    return { ...base, classification: "SCRIPT", confidence: "MEDIUM", summary: "The failure looks like a problem in the automation script rather than the application.",
      possibleCauses: ["A selector no longer matches the page", "The script has a coding error", "The step order does not match the current UI"],
      suggestedNextSteps: ["Compare the final screenshot with the selector used in the failed step", "Edit the script and re-run", "Run the case manually to confirm the application behaviour"] };
  if (ev.kind === "timeout" || /Timeout/i.test(msg))
    return { ...base, classification: "UNKNOWN", confidence: "LOW", summary: "An element or response did not appear in time. This may be an application defect, slow environment or a brittle selector.",
      possibleCauses: ["Expected element is missing (application defect)", "Selector is incorrect (script issue)", "Environment is slow"],
      suggestedNextSteps: ["Check the final screenshot and video", "Run the test manually", "Increase the timeout only if slowness is expected"] };
  if (/HTTP 5\d\d|status 5\d\d|Expected status \d+ but got 5\d\d/i.test(msg))
    return { ...base, classification: "APPLICATION", confidence: "MEDIUM", summary: "The application returned a server error.",
      possibleCauses: ["Unhandled exception on the server", "Invalid input not validated"], suggestedNextSteps: ["Check server logs for the request time", "Raise a defect with the request and response attached"] };
  return { ...base, classification: "APPLICATION", confidence: "LOW", summary: "The observed behaviour did not match the expected result.",
    possibleCauses: ["The application behaves differently from the test case expectation", "The test case expectation may be out of date"],
    suggestedNextSteps: ["Review the evidence against the expected result", "Confirm the requirement with the product owner", "Raise a defect if the behaviour is wrong"] };
}
