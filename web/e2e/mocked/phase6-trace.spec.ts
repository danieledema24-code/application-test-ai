// Phase 6 traceability, Overview and AI QA Analyst v5 (P6-06; design P6 §4.5, §12.1, §12.3) against the stubbed API
// (./fixtures.ts + the phase 2–4 and 6 fixtures; the traceability and assistant answers are stubbed here, test-only).
// The change gap lists and Change column, CHG and REL chains top-down, the "Application changed" banner, the
// assistant's release answer with the fixed statement and its two action proposals; keyboard, axe and 375 px.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { API, mockApi, newState, project, signedIn } from "./fixtures";
import { mockPhase2, newP2 } from "./phase2-fixtures";
import { mockPhase3, newP3 } from "./phase3-fixtures";
import { mockPhase4, newP4 } from "./phase4-fixtures";
import { mockExec, newExec } from "./phase4-exec-fixtures";
import { mockPhase6, newP6 } from "./phase6-fixtures";
import { mockRelease, newRelease } from "./phase6-release-fixtures";

async function axe(page: Page) {
  await expect(page).toHaveTitle(/\S/);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

const NOW = "2026-11-15T10:20:00Z";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Expose-Headers": "*" };
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const ref = (type: string, key: string, label = key, path = `/projects/p1/x/${key}`) => ({ type, id: key.toLowerCase(), key, label, path });
const CHG = ref("change_set", "CHG-0001", "CHG-0001", "/projects/p1/discovery/changes/CHG-0001");
const STATEMENT =
  "This recommendation is based on the tests the platform ran and the evidence recorded up to 15 Nov 2026, 10:20. It is advisory, it does not cover what wasn't tested, and the release decision belongs to the people who approve it.";

async function setup(page: Page) {
  const s = newState({ phase: "approved" });
  s.projects = [project("p1", { primary_url: "http://localhost:4100/" })];
  const q = newRelease();
  const p4 = newP4({ role: q.role, canApprove: q.canApprove, invalid: false });
  const p2 = newP2({ g3: "approved", strategy: true, g4: "approved", role: q.role });
  await mockApi(page, s);
  await mockPhase2(page, s, p2);
  await mockPhase3(page, s, p2, newP3({ designed: true, g5: "approved", canApprove: q.canApprove }));
  await mockPhase4(page, s, p4);
  await mockExec(page, newExec({ role: q.role, canApprove: q.canApprove }));
  await mockPhase6(page, s, newP6({ role: q.role, outdated: true }));
  await mockRelease(page, s, q, p4);
  await signedIn(page, s);
}

/** Traceability once CHG-0001 exists: TC-0019's script is outdated (HEAL-0001), TC-0020 not re-run, /offers added. */
async function mockTraceP6(page: Page) {
  const tc19 = {
    case: ref("test_case", "TC-0019"),
    status: "approved",
    priority: "high",
    script: { file: "TC-0019.spec.ts", version: 1, state: "outdated", outdated_reason: "getByLabel('Message') not found after CHG-0001" },
    result: { status: "passed", run_key: "RUN-0003", result_key: "RUN-0003-01", at: NOW },
    defects: [],
    impacted: { change_set: "CHG-0001", level: "direct", status: "open", action: "rerun" },
  };
  const tc20 = { case: ref("test_case", "TC-0020"), status: "approved", priority: "medium", script: { file: "TC-0020.spec.ts", version: 1, state: "valid" }, result: null, defects: [], impacted: { change_set: "CHG-0001", level: "indirect", status: "resolved", action: "rerun" } };
  await page.route(`${API}/projects/p1/traceability**`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api/v1", "");
    if (path.endsWith("/coverage"))
      return json(route, 200, {
        basis: "current",
        design_version: 2,
        snapshot_hash: null,
        requirements: { approved: 2, with_case: 2, with_approved_case: 2, percent_approved_covered: 100 },
        acceptance_criteria: { approved: 1, covered: 1, percent: 100 },
        high_risk_requirements: { total: 1, with_approved_case: 1 },
        techniques: [],
        test_cases: { by_status: { approved: 2 }, orphans: 0 },
        execution: { executed: true, requirements: { approved: 2, with_result: 1 }, results: { tests: 1, passed: 1, failed: 0, flaky: 0, error: 0, blocked: 0, skipped: 0 }, automation: { approved_cases: 2, with_valid_script: 1 } },
        changes: { scripts_outdated: 1, impacted_not_rerun: 1, new_pages_without_requirements: 1 },
      });
    if (path.endsWith("/gaps"))
      return json(route, 200, {
        requirements_without_test_cases: { none: [], none_approved: [] },
        test_cases_without_requirements: [],
        acceptance_criteria_without_test_cases: [],
        untested_high_risk: { open: [], accepted: [] },
        features_without_requirements: [],
        requirements_without_execution_evidence: { executed: true, automated_not_run: [], manual_only: [] },
        failed_tests: [],
        flaky_tests: [],
        outdated_automation_scripts: [],
        defects_without_regression_coverage: [],
        scripts_outdated: [
          {
            case: tc19.case,
            file: "TC-0019.spec.ts",
            path: "tests/contact/TC-0019.spec.ts",
            version: 1,
            reason: "getByLabel('Message') not found after CHG-0001",
            change_set: CHG,
            heal_suggestions: [{ key: "HEAL-0001", id: "h1", status: "pending", path: "/projects/p1/discovery/changes/CHG-0001?tab=repairs&heal=HEAL-0001" }],
          },
        ],
        impacted_not_rerun: [{ case: tc20.case, level: "direct", change_set: CHG, reason: "Uses the changed contact form" }],
        new_pages_without_requirements: [{ page: "/offers", url: "http://localhost:4100/offers", change_set: CHG, impact_item_id: "i-gap1", label: "/offers (added in CHG-0001)", path: "/projects/p1/discovery/changes/CHG-0001?tab=impact" }],
      });
    if (path.endsWith("/chain")) {
      const key = url.searchParams.get("key");
      if (key === "CHG-0001")
        return json(route, 200, {
          root: { ...CHG, label: "CHG-0001 · Scan 2 → Scan 3" },
          upstream: [],
          downstream: [
            { type: "change_item", items: [ref("change_item", "ci4", 'Button renamed: "Send message" → "Send"')] },
            { type: "impact_item", items: [ref("impact_item", "i-tc19", "TC-0019 · Direct · Open")] },
            { type: "requirement", items: [ref("requirement", "REQ-0007", "REQ-0007 · Contact form requires name, email and message")] },
            { type: "test_case", items: [ref("test_case", "TC-0019", "TC-0019 · Approved")] },
            { type: "automation_script", items: [ref("automation_script", "tests/contact/TC-0019.spec.ts", "TC-0019.spec.ts v1 · Outdated")] },
            { type: "execution_result", items: [] },
          ],
          later_phase: [],
        });
      if (key === "REL-0001")
        return json(route, 200, {
          root: ref("release_assessment", "REL-0001", "REL-0001 · No-go · Recommended", "/projects/p1/release-readiness/REL-0001"),
          upstream: [],
          downstream: [
            { type: "release_criterion", items: [ref("release_criterion", "c1", "No open critical or high defects · Not met · Blocking")] },
            { type: "evidence", items: [ref("defect", "DEF-0001", "DEF-0001 · Confirmed · Major", "/projects/p1/defects/DEF-0001")] },
          ],
          later_phase: [],
        });
      return json(route, 404, { error: { code: "not_found", message: `Nothing called ${key} in this project`, details: [] } });
    }
    return json(route, 200, {
      next_cursor: null,
      items: [
        {
          requirement: ref("requirement", "REQ-0007", "Contact form requires name, email and message"),
          requirement_status: "approved",
          risk: null,
          acceptance_criteria: [],
          conditions: [],
          test_cases: [tc19, tc20],
          automation: [],
          results: [{ case_key: "TC-0019", ...tc19.result }],
          defects: [],
          impacted: tc19.impacted,
        },
      ],
    });
  });
}

type Turn = { content: string; proposals?: Record<string, unknown>[]; citations?: Record<string, unknown>[] };

/** The assistant's answers as the backend writes them with AI off (rules). */
async function mockAssistantP6(page: Page, answers: Record<string, Turn>) {
  const messages: unknown[] = [];
  const accepted: string[] = [];
  await page.route((url) => url.pathname.endsWith("/assistant/threads/t1"), (route) => json(route, 200, { id: "t1", title: "Phase 6", created_at: NOW, messages }));
  await page.route(`${API}/assistant/threads/t1/messages`, (route) => {
    const body = route.request().postDataJSON() as { intent?: string };
    const a = answers[body.intent ?? ""] ?? { content: "?" };
    const base = { thread_id: "t1", citations: a.citations ?? [], notices: [{ code: "built_in_answer", message: "Built-in answer. Works without AI." }], answered_by: "intent", generated_by: "rules", created_at: NOW };
    const turn = {
      user_message: { ...base, id: `u${messages.length}`, role: "user", content: body.intent, intent: body.intent ?? null, proposals: [] },
      reply: { ...base, id: `a${messages.length}`, role: "assistant", intent: body.intent ?? null, content: a.content, proposals: a.proposals ?? [] },
    };
    messages.push(turn.user_message, turn.reply);
    return json(route, 200, turn);
  });
  await page.route(/\/assistant\/proposals\/[^/]+\/accept$/, (route) => {
    const id = route.request().url().split("/").slice(-2)[0];
    accepted.push(id);
    for (const m of messages as { proposals: { id: string; status: string }[] }[]) for (const p of m.proposals) if (p.id === id) p.status = "accepted";
    const key = id === "prop-run" ? "RUN-0004" : "EXP-0002";
    return json(route, 200, { id, status: "accepted", result: { applied: [{ key }] } });
  });
  return accepted;
}

function proposal(id: string, kind: string, summary: string, payload: Record<string, unknown> = {}) {
  return {
    id,
    key: `PROP-${id}`,
    kind,
    target: CHG,
    summary,
    payload,
    preview: null,
    base_versions: {},
    status: "pending",
    generated_by: "rules",
    created_by: { id: "u", full_name: "Daniele Edema" },
    created_at: NOW,
    decided_by: null,
    decided_at: null,
    decision_comment: null,
    result: null,
  };
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.describe("Phase 6 · traceability, Overview and the assistant (P6-06)", () => {
  test("Overview: 'Application changed' banner under the header links to CHG-0001 (§4.5)", async ({ page }) => {
    await setup(page);
    await page.goto("/projects/p1");
    const banner = page.getByText(/^The application changed\. CHG-0001 found 9 changes between Scan 2 \(\d+ \w+\) and Scan 3 \(\d+ \w+\): \d+ structural, \d+ behavioural, \d+ cosmetic\. \d+ impact items? (is|are) open\.$/);
    await expect(banner).toBeVisible();
    const open = page.getByRole("link", { name: "Open CHG-0001" });
    await expect(open).toHaveAttribute("href", "/projects/p1/discovery/changes/CHG-0001");
    expect(await axe(page)).toEqual([]);
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(banner).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });

  test("coverage: the three change gap lists with their links; tiles jump to them (§12.1)", async ({ page }) => {
    await setup(page);
    await mockTraceP6(page);
    await page.goto("/projects/p1/traceability");
    await expect(page.getByRole("button", { name: "Scripts that are outdated (1)" })).toBeVisible();
    await expect(page.getByText("· getByLabel('Message') not found after CHG-0001")).toBeVisible();
    await expect(page.getByRole("link", { name: "Review HEAL-0001" })).toHaveAttribute("href", /tab=repairs&heal=HEAL-0001/);
    await expect(page.getByRole("button", { name: "Impacted tests not re-run (1)" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open regression run for CHG-0001" })).toHaveAttribute("href", "/projects/p1/discovery/changes/CHG-0001?tab=regression");
    await expect(page.getByRole("button", { name: "New pages without requirements (1)" })).toBeVisible();
    await expect(page.getByText("/offers (added in CHG-0001)")).toBeVisible();
    await expect(page.getByRole("link", { name: "Write a requirement for /offers" })).toHaveAttribute("href", /requirements\/new\?from=CHG-0001&page=%2Foffers/);
    expect(await axe(page)).toEqual([]);
  });

  test("matrix: Change column after Scripts, in text with a screen-reader sentence; 375 px card line", async ({ page }) => {
    await setup(page);
    await mockTraceP6(page);
    await page.goto("/projects/p1/traceability?view=matrix");
    const table = page.getByRole("table");
    await expect(table.getByRole("columnheader", { name: "Change" })).toBeVisible();
    await expect(table.getByText("Change for TC-0019: directly affected by CHG-0001, open. Script outdated.")).toBeAttached();
    await expect(table.getByText("Direct · CHG-0001 · open")).toBeVisible();
    await expect(table.getByText("Indirect · resolved")).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.setViewportSize({ width: 375, height: 800 });
    await page.reload();
    await expect(page.getByText(/Change: Direct · CHG-0001 · open · Script outdated/)).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });

  test("chains: CHG-0001 and REL-0001 read top-down from the root", async ({ page }) => {
    await setup(page);
    await mockTraceP6(page);
    await page.goto("/projects/p1/traceability/CHG-0001");
    await expect(page.getByRole("heading", { level: 1, name: /Trace CHG-0001/ })).toBeVisible();
    await expect(page.getByText("(you are here)")).toBeVisible();
    await expect(page.getByText('Button renamed: "Send message" → "Send"')).toBeVisible();
    await expect(page.getByRole("link", { name: "TC-0019", exact: true })).toHaveAttribute("href", "/projects/p1/test-cases/TC-0019");
    await expect(page.getByText("TC-0019 · Approved")).toBeVisible();
    await page.goto("/projects/p1/traceability/REL-0001");
    await expect(page.getByRole("heading", { level: 1, name: /Trace REL-0001/ })).toBeVisible();
    await expect(page.getByText("No open critical or high defects · Not met · Blocking")).toBeVisible();
    await expect(page.getByRole("link", { name: "DEF-0001", exact: true })).toHaveAttribute("href", "/projects/p1/defects/DEF-0001");
    await expect(page.getByText("DEF-0001 · Confirmed · Major")).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("assistant: 'Can we release?' by keyboard ends with the fixed statement; no Later phases item is Phase 6", async ({ page }) => {
    await setup(page);
    const content = [
      "REL-0001: No-go · Recommended. Gate 9 decides; the recommendation is advisory.",
      "1 blocking criterion isn't met: there is an open major defect (DEF-0001).",
      STATEMENT,
    ].join("\n");
    await mockAssistantP6(page, { release_readiness_summary: { content, citations: [ref("release_assessment", "REL-0001", "REL-0001", "/projects/p1/release-readiness/REL-0001")] } });
    await page.goto("/projects/p1/assistant");
    const tasks = page.getByRole("complementary", { name: "Tasks" });
    const noAi = tasks.locator("section").filter({ has: page.getByRole("heading", { name: "Works without AI" }) });
    for (const label of ["What changed?", "What does the change affect?", "Propose a regression run", "Explain a repair suggestion", "Explore new and changed pages", "Can we release?"])
      await expect(noAi.getByRole("button", { name: new RegExp(label.replace(/[?]/g, "\\?")) })).toBeVisible();
    await expect(tasks.getByText(/Phase 6/)).toHaveCount(0);
    const chip = noAi.getByRole("button", { name: /Can we release\?/ });
    await chip.focus();
    await page.keyboard.press("Enter");
    const check = noAi.getByRole("button", { name: "Check now" });
    await check.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText(STATEMENT)).toBeVisible();
    await expect(page.getByText(/REL-0001: No-go · Recommended/)).toBeVisible();
    await expect(page).toHaveURL(/thread=t1/);
    await expect(page).toHaveTitle(/^AI QA Analyst · /);
    expect(await axe(page)).toEqual([]);
  });

  test("assistant: regression proposal creates a run request for Gate 7; exploration proposal starts nothing until accepted", async ({ page }) => {
    await setup(page);
    const accepted = await mockAssistantP6(page, {
      propose_regression_run: {
        content: "Re-run 4 tests recommended after CHG-0001 (3 must run, 1 should run), about 3 min.",
        proposals: [proposal("prop-run", "request_regression_run", "Re-run 4 tests recommended after CHG-0001 (3 must run, 1 should run), about 3 min.", { change_set_key: "CHG-0001" })],
      },
      propose_exploration: {
        content: "Explore 4 new and changed pages from CHG-0001: up to 200 actions and 10 minutes, not signed in.",
        proposals: [proposal("prop-exp", "start_exploration", "Explore 4 new and changed pages from CHG-0001: up to 200 actions and 10 minutes, not signed in.", { change_set_key: "CHG-0001" })],
      },
    });
    await page.goto("/projects/p1/assistant");
    const tasks = page.getByRole("complementary", { name: "Tasks" });
    await tasks.getByRole("button", { name: /Propose a regression run/ }).click();
    await tasks.getByRole("button", { name: "Propose a run request" }).click();
    const run = page.getByRole("region", { name: "Proposal · Request a regression run" });
    await expect(run.getByText(/Someone who can approve must still authorise it at Gate 7; the assistant can't start runs\./)).toBeVisible();
    await run.getByRole("button", { name: "Create run request" }).click();
    await expect(page.getByText("RUN-0004 requested. Someone who can approve must authorise it (Gate 7).")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open RUN-0004" })).toBeVisible();
    expect(accepted).toEqual(["prop-run"]);
    await tasks.getByRole("button", { name: /Explore new and changed pages/ }).click();
    await tasks.getByRole("button", { name: "Propose exploring" }).click();
    const exp = page.getByRole("region", { name: "Proposal · Explore pages" });
    await expect(exp.getByText(/Only clicks things that can't change data/)).toBeVisible();
    expect(accepted).toEqual(["prop-run"]); // nothing started by proposing
    await exp.getByRole("button", { name: "Start exploring" }).click();
    await expect(page.getByText("EXP-0002 started.")).toBeVisible();
    expect(accepted).toEqual(["prop-run", "prop-exp"]);
    expect(await axe(page)).toEqual([]);
    await page.setViewportSize({ width: 375, height: 800 });
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });
});
