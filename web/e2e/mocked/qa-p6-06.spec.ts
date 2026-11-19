// QA probes for P6-06 (design P6 §4.5, §12.1, §12.3) against the stubbed API: the banner disappears at 0 open items
// and is a plain link for viewers; unknown chain keys; viewers can't apply Phase 6 proposals; the signed-in exploration
// card asks for approval; the HEAL picker only runs with a valid key; empty change gap lists say so.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { API, mockApi, newState, project, signedIn } from "./fixtures";
import { mockPhase2, newP2 } from "./phase2-fixtures";
import { mockPhase3, newP3 } from "./phase3-fixtures";
import { mockPhase4, newP4 } from "./phase4-fixtures";
import { mockExec, newExec } from "./phase4-exec-fixtures";
import { mockPhase6, newP6, type P6State } from "./phase6-fixtures";
import { mockRelease, newRelease } from "./phase6-release-fixtures";

const NOW = "2026-11-15T10:20:00Z";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Expose-Headers": "*" };
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

async function setup(page: Page, opts: { viewer?: boolean; p6?: (q: P6State) => void } = {}) {
  const role = opts.viewer ? "viewer" : "owner";
  const s = newState({ phase: "approved" });
  s.projects = [project("p1", { primary_url: "http://localhost:4100/" })];
  const q = newRelease({ role, canApprove: !opts.viewer });
  const p4 = newP4({ role: q.role, canApprove: q.canApprove, invalid: false });
  const p2 = newP2({ g3: "approved", strategy: true, g4: "approved", role: q.role });
  const p6 = newP6({ role: q.role, outdated: true });
  opts.p6?.(p6);
  await mockApi(page, s);
  await mockPhase2(page, s, p2);
  await mockPhase3(page, s, p2, newP3({ designed: true, g5: "approved", canApprove: q.canApprove }));
  await mockPhase4(page, s, p4);
  await mockExec(page, newExec({ role: q.role, canApprove: q.canApprove }));
  await mockPhase6(page, s, p6);
  await mockRelease(page, s, q, p4);
  await signedIn(page, s);
}

function proposal(id: string, kind: string, summary: string, payload: Record<string, unknown> = {}) {
  return { id, key: `PROP-${id}`, kind, target: null, summary, payload, preview: null, base_versions: {}, status: "pending", generated_by: "rules", created_by: { id: "u", full_name: "Q A" }, created_at: NOW, decided_by: null, decided_at: null, decision_comment: null, result: null };
}

async function mockAssistant(page: Page, answers: Record<string, { content: string; proposals?: unknown[] }>) {
  const messages: unknown[] = [];
  const accepted: string[] = [];
  const asked: { intent?: string; params?: Record<string, unknown> }[] = [];
  await page.route((url) => url.pathname.endsWith("/assistant/threads/t1"), (route) => json(route, 200, { id: "t1", title: "QA", created_at: NOW, messages }));
  await page.route(`${API}/assistant/threads/t1/messages`, (route) => {
    const body = route.request().postDataJSON() as { intent?: string; params?: Record<string, unknown> };
    asked.push(body);
    const a = answers[body.intent ?? ""] ?? { content: "?" };
    const base = { thread_id: "t1", citations: [], notices: [], answered_by: "intent", generated_by: "rules", created_at: NOW };
    const turn = {
      user_message: { ...base, id: `u${messages.length}`, role: "user", content: body.intent, intent: body.intent ?? null, proposals: [] },
      reply: { ...base, id: `a${messages.length}`, role: "assistant", intent: body.intent ?? null, content: a.content, proposals: a.proposals ?? [] },
    };
    messages.push(turn.user_message, turn.reply);
    return json(route, 200, turn);
  });
  await page.route(/\/assistant\/proposals\/[^/]+\/accept$/, (route) => {
    accepted.push(route.request().url());
    return json(route, 200, { status: "accepted", result: { applied: [{ key: "EXP-0009" }] } });
  });
  return { accepted, asked };
}

const BANNER = /^The application changed\. CHG-0001 found/;

test.describe("QA P6-06 · banner, chains, assistant", () => {
  test("banner: gone when no impact item is open; nothing else replaces it", async ({ page }) => {
    await setup(page, { p6: (q) => { for (const cs of q.sets) if (cs.impact) cs.impact = { ...cs.impact, open: 0 }; } });
    await page.goto("/projects/p1");
    await expect(page.getByRole("heading", { name: "QA lifecycle" })).toBeVisible();
    await expect(page.getByText(BANNER)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open CHG-0001" })).toHaveCount(0);
  });

  test("banner: viewers see it with a plain link (no buttons), keyboard reachable", async ({ page }) => {
    await setup(page, { viewer: true });
    await page.goto("/projects/p1");
    await expect(page.getByText(BANNER)).toBeVisible();
    const link = page.getByRole("link", { name: "Open CHG-0001" });
    await expect(link).toHaveAttribute("href", "/projects/p1/discovery/changes/CHG-0001");
    await link.focus();
    await expect(link).toBeFocused();
    expect(await axe(page)).toEqual([]);
  });

  test("chain: unknown or malformed Phase 6 keys say we couldn't find them", async ({ page }) => {
    await setup(page);
    await page.route(`${API}/projects/p1/traceability/chain**`, (route) => json(route, 404, { error: { code: "not_found", message: "Nothing called it in this project", details: [] } }));
    for (const key of ["CHG-0099", "HEAL-0042", "EXP-0007", "REL-0009"]) {
      await page.goto(`/projects/p1/traceability/${key}`);
      await expect(page.getByText(`We couldn’t find ${key} in this project.`)).toBeVisible();
    }
    await page.goto("/projects/p1/traceability/REL-");
    await expect(page.getByText("We couldn’t find REL- in this project.")).toBeVisible();
  });

  test("assistant (viewer): Phase 6 proposals show the viewer line and no apply button", async ({ page }) => {
    await setup(page, { viewer: true });
    const { accepted } = await mockAssistant(page, {
      release_readiness_summary: { content: "No release assessment exists yet.", proposals: [proposal("p-assess", "assess_release", "Assess release readiness now.")] },
    });
    await page.goto("/projects/p1/assistant");
    const tasks = page.getByRole("complementary", { name: "Tasks" });
    await tasks.getByRole("button", { name: /Can we release\?/ }).click();
    await tasks.getByRole("button", { name: "Check now" }).click();
    const card = page.getByRole("region", { name: "Proposal · Assess release readiness" });
    await expect(card).toBeVisible();
    await expect(card.getByText("Only members, owners and admins can apply proposals.")).toBeVisible();
    await expect(card.getByRole("button", { name: "Assess" })).toHaveCount(0);
    expect(accepted).toEqual([]);
  });

  test("assistant: signed-in exploration asks for approval; HEAL picker needs a valid key", async ({ page }) => {
    await setup(page);
    const { accepted, asked } = await mockAssistant(page, {
      propose_exploration: {
        content: "Explore 3 new and changed pages from CHG-0001: up to 60 actions and 10 minutes, signed in with the saved test account.",
        proposals: [proposal("p-exp", "start_exploration", "Explore 3 new and changed pages from CHG-0001: up to 60 actions and 10 minutes, signed in.", { signed_in: true })],
      },
      explain_heal: { content: "HEAL-0001 (pending) replaces the locator getByLabel('Message')." },
    });
    await page.goto("/projects/p1/assistant");
    const tasks = page.getByRole("complementary", { name: "Tasks" });
    await tasks.getByRole("button", { name: /Explore new and changed pages/ }).click();
    await tasks.getByRole("checkbox", { name: /Explore signed in/ }).check();
    await tasks.getByRole("button", { name: "Propose exploring" }).click();
    const card = page.getByRole("region", { name: "Proposal · Explore pages" });
    await expect(card.getByText(/Needs approval by someone who can approve\./)).toBeVisible();
    expect(asked.at(-1)?.intent).toBe("propose_exploration");
    expect(asked.at(-1)?.params).toEqual({ signed_in: true });
    await expect(card.getByRole("button", { name: "Start exploring" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Request approval" })).toBeVisible();
    expect(accepted).toEqual([]); // proposing starts nothing

    await tasks.getByRole("button", { name: /Explain a repair suggestion/ }).click();
    const field = tasks.getByRole("textbox", { name: /Repair suggestion/ });
    const explain = tasks.getByRole("button", { name: "Explain", exact: true });
    await expect(explain).toBeDisabled();
    await field.fill("heal-1");
    await expect(explain).toBeDisabled();
    await field.fill("heal-0001");
    await expect(field).toHaveValue("HEAL-0001");
    await expect(explain).toBeEnabled();
    await explain.click();
    await expect(page.getByText(/HEAL-0001 \(pending\) replaces the locator/)).toBeVisible();
    expect(asked.at(-1)).toMatchObject({ intent: "explain_heal", params: { key: "HEAL-0001" } });
    expect(await axe(page)).toEqual([]);
  });

  test("traceability: empty change gap lists say so and their counts are 0", async ({ page }) => {
    await setup(page);
    const empty = { scripts_outdated: [], impacted_not_rerun: [], new_pages_without_requirements: [] };
    await page.route(`${API}/projects/p1/traceability/gaps**`, (route) =>
      json(route, 200, {
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
        ...empty,
      }),
    );
    await page.goto("/projects/p1/traceability");
    for (const [title, text] of [
      ["Scripts that are outdated (0)", "None. Every script's locators were found."],
      ["Impacted tests not re-run (0)", "None. Every impacted test has a result after its change."],
      ["New pages without requirements (0)", "None."],
    ] as const) {
      const btn = page.getByRole("button", { name: title });
      await expect(btn).toBeVisible();
      if ((await btn.getAttribute("aria-expanded")) === "false") await btn.click();
      await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
    }
  });
});
