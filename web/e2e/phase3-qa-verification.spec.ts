// QA verification of Phase 3 (independent of the developer's journey spec). Drives the real UI against the
// running stack. Needs a QA state file written by the QA scripts (owner account and project id):
//   P3QA_STATE=/path/state.json   P3QA_SHOTS=/path/to/screenshots
// Never reads or writes playwright/.auth/e2e-account.json. Demo-shop credentials are never typed here.
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { seriousA11yViolations } from "./helpers";

test.describe.configure({ mode: "serial" });

const STATE_FILE = process.env.P3QA_STATE ?? "";
const SHOTS = process.env.P3QA_SHOTS ?? "test-results/p3qa";
type State = Record<string, string>;
const state = (): State => JSON.parse(readFileSync(STATE_FILE, "utf8"));
const saveState = (kv: State) => writeFileSync(STATE_FILE, JSON.stringify({ ...state(), ...kv }, null, 1));
const LONG = 15 * 60_000;

async function shot(page: Page, name: string, fullPage = true) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage }).catch(() => undefined);
  const snap = await page.locator("body").ariaSnapshot().catch(() => "");
  writeFileSync(`${SHOTS}/../p3-aria/${name}.yml`, snap);
}
async function a11y(page: Page, screen: string) {
  const v = await seriousA11yViolations(page);
  expect.soft(v, `axe serious/critical on ${screen}`).toEqual([]);
  return v;
}
async function sideways(page: Page, screen: string) {
  const out: Record<number, number> = {};
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(400);
    out[width] = await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth);
    expect.soft(out[width], `${screen} scrolls sideways at ${width} px`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  return out;
}
async function appears(l: Locator, ms: number) {
  return l.first().waitFor({ state: "visible", timeout: ms }).then(() => true).catch(() => false);
}
async function signInAs(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 90_000 });
}
async function reloadUntil(page: Page, url: string, check: () => Promise<boolean>, timeout = LONG) {
  const end = Date.now() + timeout;
  for (;;) {
    await page.goto(url);
    const settle = Date.now() + 15_000;
    while (Date.now() < settle) {
      if (await check().catch(() => false)) return;
      await page.waitForTimeout(1_000);
    }
    if (Date.now() > end) throw new Error(`Timed out waiting on ${url}`);
    await page.waitForTimeout(4_000);
  }
}
const owner = async (page: Page) => { const s = state(); await signInAs(page, s.ownerEmail, s.pw); return s; };

test("J1 Gate 3: approve drafts in bulk, leave the Message question as needs info, approve G3", async ({ page }) => {
  test.setTimeout(LONG);
  const s = await owner(page);
  const base = `/projects/${s.pid}`;
  await page.goto(`${base}/requirements?status=draft`);
  const boxes = page.getByRole("checkbox", { name: /^Select REQ-/ });
  await boxes.first().waitFor({ timeout: 30_000 });
  await page.getByRole("checkbox", { name: /Select all/ }).first().check();
  await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: /^Approve \d+$/ }).click();
  const guard = page.getByRole("dialog", { name: /^Approve \d+ requirements?\?$/ });
  if (await appears(guard, 3_000)) await guard.getByRole("button", { name: /^Approve/ }).last().click();
  await page.waitForTimeout(2_000);
  await page.goto(`${base}/requirements?view=review`);
  const approve = page.getByRole("button", { name: "Approve requirements" });
  await expect(approve).toBeVisible({ timeout: 60_000 });
  await approve.click();
  const confirm = page.getByRole("dialog", { name: /^Approve with \d+ drafts?\?$/ });
  if (await appears(confirm, 3_000)) await confirm.getByRole("button", { name: "Approve requirements" }).click();
  await expect(page.getByText(/Requirements approved/).first()).toBeVisible({ timeout: 30_000 });
  await shot(page, "j1-g3-approved");
});

test("J2 Gate 4: strategy approved; test design starts automatically (design check 5)", async ({ page }) => {
  test.setTimeout(LONG);
  const s = await owner(page);
  const base = `/projects/${s.pid}`;
  await reloadUntil(page, `${base}/test-strategy`, async () => {
    const write = page.getByRole("button", { name: "Write the Test Strategy" });
    if (await appears(write, 2_000)) await write.click();
    return (await page.getByRole("heading", { name: /Test levels/ }).count()) > 0;
  });
  // Before G4: Test Cases tells the user to approve Gate 4 first (design check 6).
  await page.goto(`${base}/test-cases`);
  await page.waitForTimeout(3_000);
  saveState({ preG4Copy: (await page.locator("main").innerText()).slice(0, 1500) });
  await shot(page, "j2-test-cases-before-g4");
  await page.goto(`${base}/test-strategy?view=review`);
  const approve = page.getByRole("button", { name: "Approve test strategy" });
  await expect(approve).toBeVisible({ timeout: 60_000 });
  await approve.click();
  const confirm = page.getByRole("dialog");
  if (await appears(confirm, 3_000)) await confirm.getByRole("button", { name: /Approve/ }).last().click();
  await expect(page.getByText(/Strategy approved/).first()).toBeVisible({ timeout: 30_000 });
  await shot(page, "j2-g4-approved");
  await reloadUntil(page, `${base}/test-cases`, async () => (await page.getByRole("checkbox", { name: /^Select TC-/ }).count()) > 0);
  await shot(page, "j2-test-cases-list");
  await page.goto(`${base}`);
  await page.waitForTimeout(3_000);
  saveState({ overviewText: (await page.locator("main").innerText()).slice(0, 4000) });
  await shot(page, "j2-overview-after-design");
});

test("J3 open question on TC-0006: callout, Approve disabled, G5 blockers listed", async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const s = await owner(page);
  const base = `/projects/${s.pid}`;
  await page.goto(`${base}/test-cases/TC-0006`);
  await expect(page.getByRole("heading", { level: 1, name: /TC-0006/ })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await shot(page, "j3-tc0006-open-question");
  await a11y(page, "case detail with open question");
  const approve = page.getByRole("button", { name: /^Approve/ }).first();
  saveState({ tc6ApproveDisabled: String(await approve.getAttribute("aria-disabled")) + "/" + String(await approve.isDisabled()) });
  await approve.click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(800);
  saveState({ tc6DialogAfterApprove: String(await page.getByRole("dialog").count()) });
  await page.goto(`${base}/test-cases?view=review`);
  await expect(page.getByRole("heading", { name: /Gate 5/ }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2000);
  await shot(page, "j3-g5-blocked");
  await a11y(page, "gate 5 blocked");
  // Requirement detail tells which case waits for REQ-0007 (design check 34).
  await page.goto(`${base}/requirements/REQ-0007`);
  await page.waitForTimeout(3000);
  await shot(page, "j3-req0007-waiting-case");
  // Conditions tab, Name BVA (design check 16).
  await page.goto(`${base}/test-cases?view=conditions`);
  await page.waitForTimeout(3000);
  await shot(page, "j3-conditions");
  await a11y(page, "conditions");
  const name = page.getByText("TCOND-0006").first();
  if (await appears(name, 5000)) { await name.click().catch(() => undefined); await page.waitForTimeout(1500); await shot(page, "j3-tcond0006"); }
  await page.goto(`${base}/test-cases?view=data`);
  await page.waitForTimeout(3000);
  await shot(page, "j3-test-data");
  const dom = await page.content();
  saveState({ dataDomHasMask: String(/\*{3,}|•{3,}/.test(dom)) });
});

test("J4 write the expected result for the open question, then step editor keyboard and validation", async ({ page }) => {
  test.setTimeout(12 * 60_000);
  const s = await owner(page);
  const base = `/projects/${s.pid}`;
  await page.goto(`${base}/test-cases/TC-0006`);
  await page.getByRole("button", { name: "Write expected result" }).click();
  await page.waitForTimeout(800);
  const focused = await page.evaluate(() => { const e = document.activeElement as HTMLTextAreaElement | null; return { id: e?.id ?? "", tag: e?.tagName ?? "", value: e?.value ?? "" }; });
  saveState({ oqFocus: JSON.stringify(focused) });
  await shot(page, "j4-write-expected-form");
  await a11y(page, "edit form (open question)");
  const decided = "Submission is blocked and Message is identified as required";
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(decided);
  const overall = page.getByRole("textbox", { name: /Overall expected result/ });
  const ov = await overall.inputValue();
  saveState({ oqOverallBefore: ov });
  if (!ov || /not decided/i.test(ov)) await overall.fill(decided);
  // Any remaining "Not decided" step text is replaced too.
  for (const ta of await page.locator("textarea").all()) if (/^Not decided/i.test(await ta.inputValue())) await ta.fill(decided);
  // BUG (QA): the form refuses to save while generated setup steps have no expected result. Record it, then work around.
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForTimeout(1500);
  saveState({ saveBlockedBySetupSteps: String(await page.getByText(/Describe the expected result for step 2/).count() > 0) });
  await shot(page, "j4-save-blocked-setup-steps");
  for (const ta of await page.locator("textarea[id^='step-'][id$='-expected']").all()) if (!(await ta.inputValue()).trim()) await ta.fill("The value is entered in the field");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForTimeout(2500);
  await shot(page, "j4-tc0006-after-write");
  const main = await page.locator("main").innerText();
  saveState({ tc6After: main.slice(0, 2500) });
  const approve = page.getByRole("button", { name: /^Approve$/ }).first();
  saveState({ tc6ApproveEnabledAfter: String(await approve.isEnabled().catch(() => false)) });

  // Step editor by keyboard on TC-0007 (design checks 26, 27, 29).
  await page.goto(`${base}/test-cases/TC-0007`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const down = page.getByRole("button", { name: "Move step 2 down" });
  await down.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const afterMove = await page.evaluate(() => ({ label: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "", live: [...document.querySelectorAll('[role=status],[aria-live]')].map((n) => n.textContent).join(" | ") }));
  saveState({ stepMove: JSON.stringify(afterMove) });
  await page.getByRole("button", { name: "Add step" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const afterAdd = await page.evaluate(() => ({ id: document.activeElement?.id ?? "", label: document.activeElement?.getAttribute("aria-label") ?? "" }));
  saveState({ stepAdd: JSON.stringify(afterAdd) });
  const steps = await page.locator("textarea[id$='-expected']").count();
  // Last step: empty action; the previous one keeps its expected. Empty the expected of the 5th step and save.
  const exp = page.locator("textarea[id='step-4-expected']");
  if (await exp.count()) await exp.fill("");
  await page.locator("textarea[id='step-5-action']").fill("Look at the form").catch(() => undefined);
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForTimeout(1200);
  const err = await page.evaluate(() => ({ focus: document.activeElement?.id ?? "", text: (document.querySelector("main") as HTMLElement).innerText.match(/Describe the expected result[^\n]*/g) ?? [], summary: (document.querySelector("main") as HTMLElement).innerText.match(/(There (is|are) \d+ problems?[^\n]*|Fix these[^\n]*)/g) ?? [] }));
  saveState({ stepErr: JSON.stringify({ ...err, steps }) });
  await shot(page, "j4-step-editor-validation");
  await a11y(page, "edit form with errors");
  await page.getByRole("button", { name: "Cancel" }).click();
  const leave = page.getByRole("dialog");
  if (await appears(leave, 1500)) await leave.getByRole("button", { name: /Discard|Leave|Yes/ }).first().click().catch(() => undefined);
});

test("J5 member without can_approve: accepts the invitation in the UI, approves cases (D2), G5 refused", async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const s = state();
  const inv = JSON.parse(JSON.stringify((s as unknown as { inv: Record<string, { link: string; email: string }> }).inv));
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(inv.memnoapp.link);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1000);
  await shot(page, "j5-invite-accept-page");
  await a11y(page, "invite accept");
  await sideways(page, "invite accept");
  saveState({ invitePageText: (await page.locator("body").innerText()).slice(0, 800) });
  await page.getByLabel("Full name").fill("Mia Member");
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(s.pw);
  await page.getByRole("button", { name: "Create account and join" }).click();
  await page.waitForURL(/\/dashboard|\/projects/, { timeout: 60_000 });
  const base = `/projects/${s.pid}`;
  // Header/lifecycle wording for a non-approver (design check 2).
  await page.goto(base);
  await page.waitForTimeout(4000);
  saveState({ memberOverview: (await page.locator("main").innerText()).slice(0, 1500) });
  await shot(page, "j5-member-overview");
  // Individual case approval works for a member (D2).
  await page.goto(`${base}/test-cases/TC-0006`);
  const approve = page.getByRole("button", { name: /^Approve$/ }).first();
  await expect(approve).toBeEnabled({ timeout: 30_000 });
  await approve.click();
  const d = page.getByRole("dialog");
  if (await appears(d, 1500)) await d.getByRole("button", { name: /^Approve/ }).last().click();
  await expect(page.getByText(/^Approved$/).first()).toBeVisible({ timeout: 20_000 });
  await shot(page, "j5-member-approved-tc0006");
  // Bulk approve every draft (design check 13).
  await page.goto(`${base}/test-cases?status=draft`);
  await page.getByRole("checkbox", { name: /^Select TC-/ }).first().waitFor({ timeout: 30_000 });
  await page.getByRole("checkbox", { name: /Select all/ }).first().check();
  await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: /^Approve/ }).first().click();
  const guard = page.getByRole("dialog");
  await appears(guard, 3000);
  await shot(page, "j5-bulk-approve-guard");
  saveState({ bulkGuard: (await guard.innerText().catch(() => "")).slice(0, 1200) });
  await guard.getByRole("button", { name: /^Approve \d+$/ }).click();
  await page.waitForTimeout(3000);
  saveState({ bulkToast: (await page.locator("[role=status], [role=alert]").allInnerTexts()).join(" | ").slice(0, 500) });
  await shot(page, "j5-after-bulk-approve");
  // G5 panel for a member without can_approve (design check 48).
  await page.goto(`${base}/test-cases?view=review`);
  await expect(page.getByRole("heading", { name: /Gate 5/ }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2000);
  const g5 = page.getByRole("button", { name: "Approve test cases" });
  saveState({ memberG5: `${await g5.isDisabled()}/${await g5.getAttribute("aria-disabled")}` });
  await g5.click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(600);
  saveState({ memberG5Dialog: String(await page.getByRole("dialog").count()), memberG5Text: (await page.locator("main").innerText()).slice(0, 4000) });
  await shot(page, "j5-member-g5-disabled");
  await a11y(page, "gate 5 member");
  await ctx.close();
});

test("J6 member WITH can_approve: new manual case for REQ-0013, approve it, then approve Gate 5 in the UI", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const s = state();
  const inv = (s as unknown as { inv: Record<string, { email: string }> }).inv;
  await signInAs(page, inv.memapp.email, s.pw);
  const base = `/projects/${s.pid}`;
  await page.goto(base);
  await page.waitForTimeout(4000);
  saveState({ approverOverview: (await page.locator("main").innerText()).slice(0, 1200) });
  // New manual case without a requirement first (design check 30) is checked via the API; here link REQ-0013.
  await page.goto(`${base}/test-cases/new?requirement=REQ-0013`);
  await page.getByLabel("Title").first().waitFor({ timeout: 30_000 });
  await shot(page, "j6-new-case-form");
  await a11y(page, "new case form");
  await page.getByLabel("Title").first().fill("Sign-in page is served over HTTPS");
  await page.getByLabel("Objective").first().fill("Check the sign-in form is only reachable over HTTPS so credentials aren't sent in clear text.");
  await page.locator("textarea[id='step-0-action']").fill("Open the sign-in page using an http:// address");
  await page.locator("textarea[id='step-0-expected']").fill("The browser is redirected to the https:// address of the sign-in page");
  await page.getByRole("textbox", { name: /Overall expected result/ }).fill("The sign-in form is only shown over HTTPS");
  saveState({ newCaseReqChecked: String(await page.getByRole("checkbox", { name: /REQ-0013/ }).isChecked().catch(() => "n/a")) });
  // BUG (QA): the default technique "Other" is rejected by the API with a raw enum message. Record it, then pick one.
  await page.getByRole("button", { name: "Create test case" }).click();
  await page.waitForTimeout(2500);
  saveState({ otherTechniqueError: String(await page.getByText(/Input should be 'equivalence_partitioning'/).count()) });
  await shot(page, "j6-new-case-other-technique-error");
  await page.getByRole("combobox", { name: "Technique" }).selectOption({ label: "Checklist" });
  await page.getByRole("button", { name: "Create test case" }).click();
  await page.waitForURL(/\/test-cases\/TC-\d+$/, { timeout: 30_000 });
  const key = page.url().split("/").pop()!;
  saveState({ httpsCase: key });
  await page.waitForTimeout(1500);
  saveState({ httpsCaseText: (await page.locator("main").innerText()).slice(0, 1500) });
  await shot(page, "j6-new-case-created");
  const approve = page.getByRole("button", { name: /^Approve$/ }).first();
  await approve.click();
  const d = page.getByRole("dialog");
  if (await appears(d, 1500)) await d.getByRole("button", { name: /^Approve/ }).last().click();
  await page.waitForTimeout(2000);
  // Gate 5 by a member who can approve (P3-09 step 7, design check 49).
  await page.goto(`${base}/test-cases?view=review`);
  await expect(page.getByRole("heading", { name: /Gate 5/ }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2000);
  await shot(page, "j6-g5-ready");
  const g5 = page.getByRole("button", { name: "Approve test cases" });
  saveState({ approverG5Enabled: String(await g5.isEnabled()) , approverG5Text: (await page.locator("main").innerText()).slice(0, 3000)});
  await g5.click();
  const confirm = page.getByRole("dialog");
  if (await appears(confirm, 3000)) {
    saveState({ g5Confirm: (await confirm.innerText()).slice(0, 800) });
    await shot(page, "j6-g5-confirm");
    await confirm.getByRole("button", { name: /Approve/ }).last().click();
  }
  await expect(page.getByText(/Test cases approved|Gate 5 approved/).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  saveState({ g5After: (await page.locator("main").innerText()).slice(0, 2500), g5Focus: await page.evaluate(() => (document.activeElement?.textContent ?? "").slice(0, 200)), g5Toasts: (await page.locator("[role=status]").allInnerTexts()).join(" | ") });
  await shot(page, "j6-g5-approved");
});

test("J7 edit an approved case after G5: warning, back to Draft, G5 reopens, one-time toast, changes since approval", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const s = await owner(page);
  const base = `/projects/${s.pid}`;
  await page.goto(`${base}/test-cases/TC-0011`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.waitForTimeout(800);
  saveState({ editWarn: ((await page.locator("main").innerText()).match(/Saving moves it back to Draft[^\n]*/) ?? [""])[0] });
  await page.locator("textarea[id='step-0-action']").fill("Open /contact in a new browser tab");
  for (const ta of await page.locator("textarea[id^='step-'][id$='-expected']").all()) if (!(await ta.inputValue()).trim()) await ta.fill("The value is entered in the field");
  await page.getByRole("button", { name: /Save/ }).first().click();
  await page.waitForTimeout(2500);
  saveState({ afterEditToasts: (await page.locator("[role=status]").allInnerTexts()).join(" | "), afterEditHeader: (await page.locator("main").innerText()).slice(0, 900) });
  await shot(page, "j7-edited-approved-case");
  // A second edit must not show the reopen toast again.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("textbox", { name: "Objective" }).fill("Check that the contact form accepts a filled-in Name (QA edit 2).");
  await page.getByRole("button", { name: /Save/ }).first().click();
  await page.waitForTimeout(2500);
  saveState({ secondEditToasts: (await page.locator("[role=status]").allInnerTexts()).join(" | ") });
  await page.goto(`${base}/test-cases?view=review`);
  await expect(page.getByRole("heading", { name: /Gate 5/ }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2000);
  saveState({ reopenG5Text: (await page.locator("main").innerText()).slice(0, 3500) });
  await shot(page, "j7-g5-reopened");
  const cmp = page.getByRole("button", { name: /Compare with approved set/ }).or(page.getByRole("link", { name: /Compare with approved set/ }));
  if (await appears(cmp, 3000)) { await cmp.first().click(); await page.waitForTimeout(2000); await shot(page, "j7-compare-approved"); saveState({ compareText: (await page.locator("body").innerText()).slice(0, 1500) }); }
  // Traceability basis toggle (design check 57 after approval).
  await page.goto(`${base}/traceability?view=matrix`);
  await page.waitForTimeout(3000);
  await shot(page, "j7-trace-matrix-current");
  await a11y(page, "traceability matrix");
  saveState({ traceSideways: JSON.stringify(await sideways(page, "traceability matrix")) });
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(800);
  await shot(page, "j7-trace-matrix-375");
  saveState({ trace375: (await page.locator("main").innerText()).slice(0, 1500) });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base}/traceability`);
  await page.waitForTimeout(3000);
  await shot(page, "j7-trace-coverage");
  saveState({ traceCoverageText: (await page.locator("main").innerText()).slice(0, 4000) });
  await a11y(page, "traceability coverage");
  await page.goto(`${base}/traceability/TC-0013`);
  await page.waitForTimeout(3000);
  await shot(page, "j7-chain-tc0013");
  saveState({ chainText: (await page.locator("main").innerText()).slice(0, 2000) });
  await a11y(page, "chain view");
});

test("J8 regeneration review, test data guard and retire, condition reject, priority override, list filters", async ({ page }) => {
  test.setTimeout(12 * 60_000);
  const s = await owner(page);
  const base = `/projects/${s.pid}`;
  // Design check 45: Regenerate while a review is pending.
  await page.goto(`${base}/test-cases`);
  await page.getByRole("button", { name: "Regenerate…" }).first().click();
  const rd = page.getByRole("dialog");
  await appears(rd, 5000);
  await page.waitForTimeout(1000);
  saveState({ regenPendingText: (await rd.innerText().catch(() => "")).slice(0, 800) });
  await shot(page, "j8-regenerate-pending");
  await page.keyboard.press("Escape");
  // Design check 44: review screen, apply with defaults.
  await page.goto(`${base}/test-cases/changes?run=2`);
  await page.waitForTimeout(4000);
  await shot(page, "j8-change-review");
  await a11y(page, "change review");
  saveState({ reviewText: (await page.locator("main").innerText()).slice(0, 3000) });
  const apply = page.getByRole("button", { name: /^Apply/ }).first();
  if (await appears(apply, 5000)) {
    await apply.click();
    const c = page.getByRole("dialog");
    if (await appears(c, 2000)) await c.getByRole("button", { name: /^Apply/ }).last().click();
    await page.waitForTimeout(3000);
    saveState({ afterApply: (await page.locator("main").innerText()).slice(0, 600), afterApplyUrl: page.url() });
    await shot(page, "j8-after-apply");
  }
  // Test data: real email (40), boundary (41), approved usage warning (42), retire (43).
  await page.goto(`${base}/test-cases?view=data`);
  await page.getByRole("button", { name: "Edit TD-0012" }).click();
  const val = page.getByRole("textbox", { name: /Value/ }).first();
  await val.fill("real.person@gmail.com");
  await page.getByRole("button", { name: /^Save/ }).first().click();
  await page.waitForTimeout(1500);
  saveState({ realEmailErr: ((await page.locator("main").innerText()).match(/Use a reserved domain[^\n]*/) ?? [""])[0], realEmailFocus: await page.evaluate(() => document.activeElement?.tagName + "#" + (document.activeElement?.id ?? "")) });
  await shot(page, "j8-td-real-email");
  await page.getByRole("button", { name: "Cancel" }).first().click().catch(() => undefined);
  await page.getByRole("button", { name: "Edit TD-0008" }).click();
  await page.getByRole("textbox", { name: /Value/ }).first().fill("abc");
  await page.getByRole("button", { name: /^Save/ }).first().click();
  await page.waitForTimeout(1500);
  saveState({ boundaryErr: ((await page.locator("main").innerText()).match(/This item tests the[^\n]*/) ?? [""])[0] });
  await page.getByRole("button", { name: "Cancel" }).first().click().catch(() => undefined);
  await page.getByRole("button", { name: "Edit TD-0001" }).click();
  await page.waitForTimeout(1500);
  saveState({ approvedUseWarn: ((await page.locator("main").innerText()).match(/[^\n]*(back to Draft|reopen)[^\n]*/gi) ?? []).join(" | "), saveLabel: (await page.getByRole("button", { name: /^Save/ }).first().innerText()) });
  await shot(page, "j8-td-edit-used-by-approved");
  await page.getByRole("button", { name: "Cancel" }).first().click().catch(() => undefined);
  await page.getByRole("button", { name: "More actions for TD-0006" }).click();
  await page.getByRole("menuitem", { name: "Retire" }).or(page.getByRole("button", { name: "Retire" })).first().click();
  await page.waitForTimeout(1500);
  const rdlg = page.getByRole("dialog");
  if (await appears(rdlg, 2000)) {
    const confirm = rdlg.getByRole("button", { name: /Retire/ }).last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => undefined);
    await page.waitForTimeout(1500);
    saveState({ retireDialog: (await rdlg.innerText().catch(() => "")).slice(0, 600) });
    await shot(page, "j8-td-retire-in-use");
    await page.keyboard.press("Escape");
  }
  // Condition reject dialog (20).
  await page.goto(`${base}/test-cases?view=conditions`);
  await page.getByRole("button", { name: "Reject TCOND-0004…" }).click();
  const cd = page.getByRole("dialog");
  await appears(cd, 3000);
  saveState({ condRejectDialog: (await cd.innerText()).slice(0, 700) });
  await shot(page, "j8-condition-reject-dialog");
  await page.keyboard.press("Escape");
  // Priority override UI (36).
  await page.goto(`${base}/test-cases/TC-0024`);
  await page.getByRole("button", { name: "Set priority…" }).click();
  const pd = page.getByRole("dialog");
  await pd.getByRole("radio", { name: /Low/ }).check();
  await pd.getByRole("button", { name: /Set priority|Save/ }).last().click();
  await page.waitForTimeout(800);
  saveState({ overrideNoReason: ((await pd.innerText().catch(() => "")).match(/Explain why[^\n]*/) ?? [""])[0] });
  await pd.getByLabel("Reason").fill("Low traffic path in this release");
  await pd.getByRole("button", { name: /Set priority|Save/ }).last().click();
  await page.waitForTimeout(2000);
  saveState({ overrideShown: ((await page.locator("main").innerText()).match(/[^\n]*(set by|Risk-based priority|lower than its risk)[^\n]*/gi) ?? []).join(" | ") });
  await shot(page, "j8-priority-override");
  // Deprecated case (31).
  await page.goto(`${base}/test-cases/TC-0019`);
  await page.waitForTimeout(2000);
  saveState({ deprecatedText: ((await page.locator("main").innerText()).match(/[^\n]*Deprecated[^\n]*/g) ?? []).slice(0, 4).join(" | "), deleteControls: String(await page.getByRole("button", { name: /Delete/ }).count()) });
  // List filters in the URL and Back (11), group by requirement (12).
  await page.goto(`${base}/test-cases`);
  await page.waitForTimeout(2000);
  await page.getByRole("combobox", { name: "Technique" }).first().selectOption({ label: "Boundary value analysis" });
  await page.waitForTimeout(800);
  const u1 = page.url();
  await page.getByRole("combobox", { name: "Status" }).first().selectOption({ label: "Approved" });
  await page.waitForTimeout(800);
  const u2 = page.url();
  await page.goBack();
  await page.waitForTimeout(1000);
  saveState({ filterUrls: JSON.stringify([u1.split("?")[1], u2.split("?")[1], page.url().split("?")[1]]) });
  await page.goto(`${base}/test-cases?group=requirement`);
  await page.waitForTimeout(2500);
  await shot(page, "j8-group-by-requirement");
  saveState({ groupText: (await page.locator("main").innerText()).match(/[^\n]*(REQ-\d+|Not linked to a requirement)[^\n]*/g)?.slice(0, 8).join(" | ") ?? "" });
  await page.goto(`${base}/test-cases`);
  await page.waitForTimeout(2500);
  await shot(page, "j8-list");
  const firstRow = page.getByRole("row").nth(1);
  saveState({ listRow: (await firstRow.innerText()).replace(/\s+/g, " ").slice(0, 400), listHeader: (await page.getByRole("row").first().innerText()).replace(/\s+/g, " ") });
  await a11y(page, "test case list");
});

test("J9 assistant v2: task groups, negative cases proposal accepted (G5 reopens), regression proposal", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const s = await owner(page);
  const base = `/projects/${s.pid}`;
  await page.goto(`${base}/assistant`);
  await page.waitForTimeout(4000);
  await shot(page, "j9-assistant-tasks");
  saveState({ assistantTasks: (await page.locator("main").innerText()).slice(0, 3000) });
  await a11y(page, "assistant");
  await page.getByRole("button", { name: /Generate more negative test cases/ }).first().click();
  const sel = page.getByRole("combobox", { name: "Requirement or feature" });
  await sel.waitFor({ timeout: 10_000 });
  await sel.selectOption({ value: "req:REQ-0006" });
  await page.getByRole("button", { name: "Propose test cases" }).click();
  await page.waitForTimeout(5000);
  await shot(page, "j9-negative-proposal");
  await a11y(page, "assistant with test-case proposal");
  saveState({ negProposal: (await page.locator("main").innerText()).slice(-3500) });
  const add = page.getByRole("button", { name: /^Add \d+ test cases?$/ });
  if (await appears(add, 5000)) {
    saveState({ addLabel: await add.first().innerText() });
    await add.first().click();
    const d = page.getByRole("dialog");
    if (await appears(d, 1500)) await d.getByRole("button", { name: /^(Add|Apply)/ }).last().click();
    await page.waitForTimeout(4000);
    await shot(page, "j9-negative-accepted");
    saveState({ negAccepted: (await page.locator("main").innerText()).slice(-1500) });
  }
  // Same request again: nothing more can be derived? (design check 64)
  await page.getByRole("button", { name: /Generate more negative test cases/ }).first().click().catch(() => undefined);
  const sel2 = page.getByRole("combobox", { name: "Requirement or feature" });
  if (await appears(sel2, 5000)) {
    await sel2.selectOption({ value: "req:REQ-0006" });
    await page.getByRole("button", { name: "Propose test cases" }).click();
    await page.waitForTimeout(5000);
    saveState({ negAgain: (await page.locator("main").innerText()).slice(-1200) });
    await shot(page, "j9-negative-again");
  }
  await page.getByRole("button", { name: /Generate regression scenarios/ }).first().click().catch(() => undefined);
  await page.waitForTimeout(800);
  const hr = page.getByRole("radio", { name: /High-risk/ });
  if (await appears(hr, 3000)) await hr.check();
  await page.getByRole("button", { name: /^(Propose|Suggest|Run|Generate)/ }).last().click().catch(() => undefined);
  await page.waitForTimeout(5000);
  await shot(page, "j9-regression-proposal");
  saveState({ regProposal: (await page.locator("main").innerText()).slice(-2500) });
});

test("J10 regression proposal applied (G5 reopens); members page as owner: invite dialog, copy, close confirm, last owner", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const s = await owner(page);
  const base = `/projects/${s.pid}`;
  await page.goto(`${base}/assistant`);
  await page.waitForTimeout(3000);
  const apply = page.getByRole("button", { name: /^Apply \d+ suite changes?$/ }).first();
  if (await appears(apply, 8000)) {
    await apply.click();
    const d = page.getByRole("dialog");
    if (await appears(d, 1500)) await d.getByRole("button", { name: /^Apply/ }).last().click();
    await page.waitForTimeout(3000);
    saveState({ regApplied: (await page.locator("main").innerText()).slice(-800) });
    await shot(page, "j10-regression-applied");
  }
  await page.goto("/settings/members");
  await expect(page.getByRole("heading", { name: /Members \(\d+\)/ })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await shot(page, "j10-members-owner");
  await a11y(page, "members (owner)");
  saveState({ membersOwner: (await page.locator("main").innerText()).slice(0, 2500), membersSideways: JSON.stringify(await sideways(page, "members")) });
  await page.getByRole("button", { name: "Invite people" }).click();
  const dlg = page.getByRole("dialog");
  const email = `qa-p3-closeprobe-${Date.now()}@example.com`;
  await dlg.getByLabel("Email").fill(email);
  await dlg.getByRole("button", { name: "Create invitation link" }).click();
  await dlg.getByLabel("Invitation link").waitFor({ timeout: 15_000 });
  await shot(page, "j10-invite-link-once");
  await a11y(page, "invite dialog with link");
  saveState({ inviteDialog: (await dlg.innerText()).slice(0, 800) });
  await dlg.getByRole("button", { name: "Done" }).click();
  const cc = page.getByRole("dialog", { name: "Close without copying the link?" });
  await appears(cc, 3000);
  saveState({ closeButtons: String(await page.getByRole("button", { name: "Close", exact: true }).count()), closeButtonsInConfirm: String(await cc.getByRole("button", { name: "Close", exact: true }).count()) });
  await shot(page, "j10-close-without-copy");
  await cc.getByRole("button", { name: "Go back" }).click();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("dialog").getByRole("button", { name: "Copy invitation link" }).click();
  await page.waitForTimeout(500);
  saveState({ copyAnnounce: (await page.getByRole("dialog").locator("[role=status],[aria-live]").allInnerTexts()).join(" | "), copyBtn: await page.getByRole("dialog").getByRole("button", { name: /Link copied|Copy invitation link/ }).innerText() });
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  await page.waitForTimeout(800);
  saveState({ dialogsAfterCopyDone: String(await page.getByRole("dialog").count()) });
  // Revoke the probe invitation again.
  await page.getByRole("button", { name: `Revoke invitation for ${email}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke invitation" }).click();
  await page.waitForTimeout(1000);
  // Existing-account email error (design check 68).
  await page.getByRole("button", { name: "Invite people" }).click();
  await page.getByRole("dialog").getByLabel("Email").fill(s.otherEmail);
  await page.getByRole("dialog").getByRole("button", { name: "Create invitation link" }).click();
  await page.waitForTimeout(1500);
  saveState({ existingAccountErr: (await page.getByRole("dialog").innerText()).slice(0, 600) });
  await shot(page, "j10-invite-existing-account");
  await page.keyboard.press("Escape");
});

test("J11 viewer, member and admin views: read-only controls, permission copy, members page", async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const s = state();
  const inv = (s as unknown as { inv: Record<string, { email: string }> }).inv;
  const base = `/projects/${s.pid}`;
  // Viewer
  let ctx = await browser.newContext(); let page = await ctx.newPage();
  await signInAs(page, inv.viewer.email, s.pw);
  await page.goto(`${base}/test-cases`);
  await page.getByRole("link", { name: /^TC-\d+/ }).first().waitFor({ timeout: 30_000 });
  saveState({ viewerList: JSON.stringify({ checkboxes: await page.getByRole("checkbox", { name: /^Select TC-/ }).count(), newCase: await page.getByRole("link", { name: "New test case" }).or(page.getByRole("button", { name: "New test case" })).count(), regen: await page.getByRole("button", { name: /Regenerate/ }).count() }) });
  await shot(page, "j11-viewer-list");
  await page.goto(`${base}/test-cases/TC-0013`);
  await page.waitForTimeout(2500);
  saveState({ viewerDetail: JSON.stringify({ edit: await page.getByRole("button", { name: "Edit", exact: true }).count(), approve: await page.getByRole("button", { name: /^Approve/ }).count(), setPriority: await page.getByRole("button", { name: /Set priority/ }).count() }) });
  await page.goto(`${base}/test-cases?view=review`);
  await page.waitForTimeout(3000);
  const g5 = page.getByRole("button", { name: "Approve test cases" });
  saveState({ viewerG5: `${await g5.count()}:${(await g5.count()) ? await g5.isDisabled() : "n/a"}`, viewerG5Text: ((await page.locator("main").innerText()).match(/[^\n]*(permission|Waiting for)[^\n]*/g) ?? []).join(" | ") });
  await shot(page, "j11-viewer-g5");
  await page.goto(`${base}/assistant`);
  await page.waitForTimeout(3000);
  saveState({ viewerAssistant: ((await page.locator("main").innerText()).match(/[^\n]*(Only members|Apply|Reject)[^\n]*/g) ?? []).join(" | ") });
  await shot(page, "j11-viewer-assistant");
  await page.goto("/settings/members");
  await page.waitForTimeout(3000);
  saveState({ viewerMembers: (await page.locator("main").innerText()).slice(0, 1200), viewerMemberButtons: String(await page.locator("main").getByRole("button").count()) });
  await shot(page, "j11-viewer-members");
  await ctx.close();
  // Admin without can_approve
  ctx = await browser.newContext(); page = await ctx.newPage();
  await signInAs(page, inv.admin.email, s.pw);
  await page.goto("/settings/members");
  await page.waitForTimeout(3000);
  saveState({ adminMembers: (await page.locator("main").innerText()).slice(0, 2500) });
  await shot(page, "j11-admin-members");
  await page.goto(`${base}/test-cases?view=review`);
  await page.waitForTimeout(3000);
  const ag5 = page.getByRole("button", { name: "Approve test cases" });
  saveState({ adminG5: `${await ag5.count()}:${(await ag5.count()) ? await ag5.isDisabled() : "n/a"}`, adminG5Text: ((await page.locator("main").innerText()).match(/[^\n]*(permission|Waiting for)[^\n]*/g) ?? []).join(" | ") });
  await shot(page, "j11-admin-no-approve-g5");
  await ctx.close();
});

test("J12 lifecycle, sidebar, legacy 404, out of date, reports UI, keyboard focus return, sideways scroll sweep", async ({ page }) => {
  test.setTimeout(12 * 60_000);
  const s = await owner(page);
  const base = `/projects/${s.pid}`;
  // Legacy route (design check 1).
  await page.goto("/test-cases/x");
  await page.waitForTimeout(2000);
  saveState({ legacy404: (await page.locator("body").innerText()).slice(0, 300) });
  await shot(page, "j12-legacy-404");
  // Overview lifecycle (3, 4, 9).
  await page.goto(base);
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: "Show all 21 steps" }).click();
  await page.waitForTimeout(800);
  saveState({ lifecycleAll: (await page.locator("main").innerText()).slice(0, 5000) });
  await shot(page, "j12-lifecycle-all-steps");
  const names = await page.getByRole("link", { name: /^Review Gate \d/ }).allInnerTexts();
  saveState({ reviewGateLinks: JSON.stringify(names) });
  saveState({ sidebar: (await page.getByRole("navigation", { name: "Project sections" }).innerText()).replace(/\n/g, " | ") });
  await page.goto(`${base}/test-cases`);
  await page.waitForTimeout(3000);
  saveState({ staleCallout: ((await page.locator("main").innerText()).match(/[^\n]*(Out of date|Strategy changed|out of date)[^\n]*/g) ?? []).join(" | ") });
  await shot(page, "j12-test-cases-out-of-date");
  // Keyboard: open a case from the list with Enter, go back, focus returns to its row (76).
  const link = page.getByRole("link", { name: /^TC-0013/ }).first();
  await link.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/TC-0013/);
  await page.waitForTimeout(1500);
  const backLink = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Test Cases" }).last();
  await backLink.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  saveState({ focusAfterBack: await page.evaluate(() => (document.activeElement?.textContent ?? "").slice(0, 80) + " <" + document.activeElement?.tagName + ">") });
  // Reports (59, 60).
  await page.goto(`${base}/reports`);
  await page.waitForTimeout(3000);
  await shot(page, "j12-reports-list");
  await a11y(page, "reports list");
  const dl = page.getByRole("button", { name: /^Download Test Case Specification/ }).first();
  if (await appears(dl, 5000)) { await dl.click(); await page.waitForTimeout(500); saveState({ downloadMenu: (await page.getByRole("menu").innerText().catch(() => "")).replace(/\n/g, " | ") }); await shot(page, "j12-download-menu"); await page.keyboard.press("Escape"); }
  for (const slug of ["test-case-spec", "rtm"]) {
    await page.goto(`${base}/reports/${slug}`);
    await page.waitForTimeout(4000);
    const create = page.getByRole("button", { name: "Create draft from current" });
    if (await appears(create, 3000)) { await create.click(); await page.waitForTimeout(8000); await page.reload(); await page.waitForTimeout(4000); }
    await shot(page, `j12-report-${slug}`);
    await a11y(page, `report ${slug}`);
    saveState({ [`report_${slug}`]: ((await page.locator("main").innerText()).match(/[^\n]*(DRAFT|Approved at Gate 5|Approved by|Not available until Phase 4|Download)[^\n]*/g) ?? []).slice(0, 10).join(" | ") });
    saveState({ [`report_${slug}_sideways`]: JSON.stringify(await sideways(page, `report ${slug}`)) });
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }).catch(() => null), page.getByRole("button", { name: "Download CSV" }).click().catch(() => undefined)]);
    if (download) await download.saveAs(`${SHOTS}/../p3-downloads/ui-${slug}.csv`);
  }
  // Sideways sweep (15, 56, 77).
  const out: Record<string, unknown> = {};
  for (const [name, path] of [["list", `${base}/test-cases`], ["detail", `${base}/test-cases/TC-0013`], ["conditions", `${base}/test-cases?view=conditions`], ["data", `${base}/test-cases?view=data`], ["review", `${base}/test-cases?view=review`], ["trace-coverage", `${base}/traceability`], ["chain", `${base}/traceability/REQ-0004`], ["assistant", `${base}/assistant`], ["edit", `${base}/test-cases/TC-0013?edit=1`], ["new", `${base}/test-cases/new`]] as const) {
    await page.goto(path);
    await page.waitForTimeout(2500);
    out[name] = await sideways(page, name);
    if (name === "list") { await page.setViewportSize({ width: 375, height: 800 }); await page.waitForTimeout(800); await shot(page, "j12-list-375"); await page.setViewportSize({ width: 1280, height: 900 }); }
    if (name === "detail" || name === "conditions" || name === "data" || name === "chain") await a11y(page, name);
  }
  saveState({ sidewaysSweep: JSON.stringify(out) });
});

test("J13 list row link: what is under the link's top-left corner, and does a plain click navigate", async ({ page }) => {
  const s = await owner(page);
  await page.goto(`/projects/${s.pid}/test-cases`);
  const link = page.getByRole("link", { name: /^TC-\d+/ }).first();
  await link.waitFor();
  const probe = await link.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + 8, r.top + 8);
    return { w: r.width, h: r.height, hitTag: hit?.tagName, hitText: (hit?.textContent ?? "").slice(0, 60), inside: el.contains(hit), linkText: el.textContent };
  });
  await link.click({ position: { x: 8, y: 8 } });
  await page.waitForTimeout(3000);
  const afterPositioned = page.url();
  await page.goto(`/projects/${s.pid}/test-cases`);
  await page.getByRole("link", { name: /^TC-\d+/ }).first().click();
  await page.waitForTimeout(3000);
  saveState({ rowLinkProbe: JSON.stringify({ probe, afterPositioned, afterPlain: page.url() }) });
});

test("J14 report pages render (TCS with an unlinked case, RTM): no runtime error, no sideways scroll", async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const s = await owner(page);
  const out: Record<string, string> = {};
  for (const slug of ["test-case-spec", "rtm"]) {
    await page.goto(`/projects/${s.pid}/reports/${slug}`);
    await page.waitForTimeout(6000);
    const crashed = await page.getByText(/Runtime TypeError|Application error|Cannot read properties/).count();
    const main = await page.locator("main").count();
    const text = main ? await page.locator("main").innerText({ timeout: 5000 }).catch(() => "") : "";
    out[slug] = JSON.stringify({ crashed, main, marks: (text.match(/[^\n]*(DRAFT|Approved at|Not available)[^\n]*/g) ?? []).slice(0, 5) });
    await shot(page, `j14-report-${slug}`);
    if (main && !crashed) out[`${slug}_sideways`] = JSON.stringify(await sideways(page, `report ${slug}`));
  }
  saveState({ j14Reports: JSON.stringify(out) });
});

// ---------------- Round 2 (re-verification on a fresh project) ----------------
const R2 = (name: string) => `round2-${name}`;
const focusInfo = (page: Page) =>
  page.evaluate(() => {
    const e = document.activeElement as HTMLElement | null;
    return `${e?.tagName}|${e?.getAttribute("aria-label") ?? ""}|${(e?.textContent ?? "").trim().slice(0, 60)}|${e?.closest("tr")?.textContent?.trim().slice(0, 40) ?? "no-row"}`;
  });

test("R2a open question: requirement page, focusable disabled Approve, write expected result saves without inventing step results", async ({ page }) => {
  test.setTimeout(8 * 60_000);
  const s = await owner(page);
  const base = `/projects/${s.pid}`;
  await page.goto(`${base}/requirements/REQ-0007`);
  await page.waitForTimeout(5000);
  saveState({ r2Req7: ((await page.locator("main").innerText()).match(/[^\n]*(waiting for this answer|Linked test cases)[^\n]*/g) ?? []).join(" | ") });
  await shot(page, R2("req0007-waiting-case"));
  await page.goto(`${base}/test-cases/TC-0006`);
  const approve = page.getByRole("button", { name: /^Approve$/ }).first();
  await approve.waitFor({ timeout: 30_000 });
  await approve.focus();
  saveState({
    r2ApproveDisabled: JSON.stringify({ disabled: await approve.isDisabled(), aria: await approve.getAttribute("aria-disabled"), focused: await approve.evaluate((el) => el === document.activeElement) }),
    r2NotDecided: ((await page.locator("main").innerText()).match(/[^\n]*Not decided[^\n]*/g) ?? []).join(" | "),
    r2Preliminary: String(((await page.locator("main").innerText()).match(/Preliminary: assessed in Phase 4/g) ?? []).length),
    r2StepMissing: String(await page.getByText("Missing expected result").count()),
  });
  await approve.press("Enter");
  await page.waitForTimeout(600);
  saveState({ r2ApproveDialog: String(await page.getByRole("dialog").count()) });
  await shot(page, R2("tc0006-open-question"));
  await page.getByRole("button", { name: "Write expected result" }).click();
  await page.waitForTimeout(800);
  const decided = "Submission is blocked and Message is identified as required";
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(decided);
  const overall = page.getByRole("textbox", { name: /Overall expected result/ });
  if (!(await overall.inputValue()) || /not decided|asks whether/i.test(await overall.inputValue())) await overall.fill(decided);
  for (const ta of await page.locator("textarea").all()) if (/^(Not decided|REQ-0007 asks)/i.test(await ta.inputValue())) await ta.fill(decided);
  await shot(page, R2("write-expected-form"));
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForTimeout(3000);
  const main = await page.locator("main").innerText();
  saveState({ r2SaveBlocked: String(/Describe the expected result for step/.test(main)), r2AfterSave: main.slice(0, 1800), r2SaveToasts: (await page.locator("[role=status]").allInnerTexts()).join(" | ").slice(0, 400) });
  await shot(page, R2("tc0006-after-save"));
});

test("R2b new case form: technique default and validation are field errors (no raw enum)", async ({ page }) => {
  const s = await owner(page);
  await page.goto(`/projects/${s.pid}/test-cases/new`);
  await page.getByLabel("Title").first().waitFor({ timeout: 30_000 });
  const tech = page.getByRole("combobox", { name: "Technique" });
  const def = { value: await tech.inputValue().catch(() => "?"), label: await tech.evaluate((el: HTMLSelectElement) => el.selectedOptions[0]?.textContent ?? "").catch(() => "?"), options: await tech.locator("option").allInnerTexts().catch(() => []) };
  await page.getByLabel("Title").first().fill("QA round 2 probe, not saved");
  await page.getByLabel("Objective").first().fill("Probe the form validation.");
  await page.locator("textarea[id='step-0-action']").fill("Open the home page");
  await page.getByRole("textbox", { name: /Overall expected result/ }).fill("The home page is shown");
  await page.getByRole("button", { name: "Create test case" }).click();
  await page.waitForTimeout(2500);
  const main = await page.locator("main").innerText();
  saveState({ r2Technique: JSON.stringify({ def, url: page.url(), raw: /Input should be/.test(main), errors: main.match(/[^\n]*(technique|Technique)[^\n]*/g)?.slice(0, 6) ?? [] }) });
  await shot(page, R2("new-case-technique"));
  await a11y(page, "new case form r2");
});

test("R2c owner approves every case (bulk) and Gate 5 through the UI", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const s = await owner(page);
  const base = `/projects/${s.pid}`;
  await page.goto(`${base}/test-cases?status=draft`);
  // Bulk approve the drafts if any remain. With nothing to skip there is no guard dialog.
  if (await appears(page.getByRole("checkbox", { name: /^Select TC-/ }), 20_000)) {
    await page.getByRole("checkbox", { name: /Select all/ }).first().check();
    await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: /^Approve/ }).first().click();
    const guard = page.getByRole("dialog");
    if (await appears(guard, 3000)) {
      saveState({ r2BulkGuard: (await guard.innerText().catch(() => "")).slice(0, 800) });
      await guard.getByRole("button", { name: /^Approve( \d+)?$/ }).last().click();
    }
    await page.waitForTimeout(4000);
    saveState({ r2BulkToast: (await page.locator("[role=status], [role=alert]").allInnerTexts()).join(" | ").slice(0, 400) });
  }
  await page.goto(`${base}/test-cases?view=review`);
  await expect(page.getByRole("heading", { name: /Gate 5/ }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2500);
  await shot(page, R2("g5-ready"));
  await a11y(page, "gate 5 r2");
  const g5 = page.getByRole("button", { name: "Approve test cases" });
  saveState({ r2G5Before: JSON.stringify({ enabled: await g5.isEnabled(), aria: await g5.getAttribute("aria-disabled") }), r2G5Text: (await page.locator("main").innerText()).slice(0, 3000) });
  await g5.click();
  const confirm = page.getByRole("dialog");
  if (await appears(confirm, 3000)) {
    saveState({ r2G5Confirm: (await confirm.innerText()).slice(0, 600) });
    await confirm.getByRole("button", { name: /Approve/ }).last().click();
  }
  await expect(page.getByText(/Gate 5 approved|Test cases approved/).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  saveState({ r2G5After: (await page.locator("main").innerText()).slice(0, 1500), r2G5Toasts: (await page.locator("[role=status]").allInnerTexts()).join(" | ") });
  await shot(page, R2("g5-approved"));
});

test("R2d after G5: focus returns to the row, TCS and RTM pages render, reopen keeps Last approved, members Close", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const s = await owner(page);
  const base = `/projects/${s.pid}`;
  // Focus return (76): Enter on a row link, then browser Back, and breadcrumb.
  await page.goto(`${base}/test-cases`);
  const link = page.getByRole("link", { name: /^TC-0013/ }).first();
  await link.waitFor({ timeout: 60_000 });
  await link.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/TC-0013/);
  await page.waitForTimeout(2000);
  await page.goBack();
  await page.waitForTimeout(3000);
  const afterBrowserBack = await focusInfo(page);
  await page.getByRole("link", { name: /^TC-0013/ }).first().focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/TC-0013/);
  await page.waitForTimeout(2000);
  const crumb = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Test Cases" }).last();
  await crumb.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);
  saveState({ r2Focus: JSON.stringify({ afterBrowserBack, afterBreadcrumb: await focusInfo(page) }) });
  // Reports (21 in round 1): TCS page with every case, RTM.
  const rep: Record<string, string> = {};
  for (const slug of ["test-case-spec", "rtm"]) {
    await page.goto(`${base}/reports/${slug}`);
    await page.waitForTimeout(6000);
    const crashed = await page.getByText(/Runtime TypeError|Application error|Cannot read properties/).count();
    const text = (await page.locator("main").count()) ? await page.locator("main").innerText({ timeout: 5000 }).catch(() => "") : "";
    rep[slug] = JSON.stringify({ crashed, marks: (text.match(/[^\n]*(DRAFT|Approved at|Not linked)[^\n]*/g) ?? []).slice(0, 4) });
    await shot(page, R2(`report-${slug}`));
    if (!crashed) { await a11y(page, `report ${slug} r2`); rep[`${slug}_sideways`] = JSON.stringify(await sideways(page, `report ${slug}`)); }
  }
  saveState({ r2Reports: JSON.stringify(rep) });
  // Reopen G5 by editing an approved case, then Traceability "Last approved" (round 1 BUG-P3-18).
  await page.goto(`${base}/test-cases/TC-0013`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const warn = ((await page.locator("main").innerText()).match(/[^\n]*Saving moves it back to Draft[^\n]*/g) ?? []).join(" | ");
  await page.getByLabel("Objective").first().fill("Check the Name field at its lower boundary (QA round 2 edit).");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForTimeout(3000);
  saveState({ r2EditWarn: warn, r2EditToasts: (await page.locator("[role=status]").allInnerTexts()).join(" | ").slice(0, 400) });
  await page.goto(`${base}/traceability`);
  await page.waitForTimeout(5000);
  const lastApproved = page.getByRole("radio", { name: "Last approved (Gate 5)" });
  saveState({ r2LastApproved: JSON.stringify({ disabled: await lastApproved.isDisabled().catch(() => "n/a"), aria: await lastApproved.getAttribute("aria-disabled").catch(() => "n/a"), hint: await page.getByText("Available after Gate 5 is approved.").count() }) });
  if (!(await lastApproved.isDisabled().catch(() => true))) { await lastApproved.click(); await page.waitForTimeout(3000); }
  saveState({ r2TraceUrl: page.url() });
  await shot(page, R2("trace-last-approved"));
  // Members close-without-copying confirm (round 1 BUG-P3-11).
  await page.goto("/settings/members");
  await page.getByRole("button", { name: "Invite people" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Email").fill(`qa-p3-r2-close-${Date.now()}@example.com`);
  await dlg.getByRole("button", { name: "Create invitation link" }).click();
  await dlg.getByLabel("Invitation link").waitFor({ timeout: 15_000 });
  await dlg.getByRole("button", { name: "Done" }).click();
  const cc = page.getByRole("dialog", { name: "Close without copying the link?" });
  await appears(cc, 3000);
  saveState({ r2CloseButtons: String(await page.getByRole("button", { name: "Close", exact: true }).count()), r2CloseDialogButtons: (await cc.getByRole("button").allInnerTexts().catch(() => [])).join(" / ") });
  await shot(page, R2("close-without-copy"));
  await a11y(page, "members close confirm r2");
  // Leave the confirm by closing (the link isn't needed).
  await cc.getByRole("button").filter({ hasText: /Close/ }).last().click().catch(() => undefined);
  await page.waitForTimeout(1000);
  // Revoke what was just created so no live link remains.
  const revoke = page.getByRole("button", { name: /^Revoke/ }).first();
  if (await appears(revoke, 3000)) { await revoke.click(); const d = page.getByRole("dialog"); if (await appears(d, 2000)) await d.getByRole("button", { name: "Revoke invitation" }).click(); }
});

test("R2e test data headings and approved-use warning, retire dialog, coverage item names, regenerate copy, assistant task groups and proposals", async ({ page }) => {
  test.setTimeout(8 * 60_000);
  const s = await owner(page);
  const base = `/projects/${s.pid}`;
  await page.goto(`${base}/test-cases?view=data`);
  await page.getByRole("button", { name: "Edit TD-0001" }).waitFor({ timeout: 60_000 });
  const headings = await page.locator("main").getByRole("heading").allInnerTexts();
  await shot(page, R2("test-data"));
  await page.getByRole("button", { name: "Edit TD-0001" }).click();
  await page.waitForTimeout(1500);
  const warn = ((await page.locator("main").innerText()).match(/[^\n]*(back to Draft|reopen)[^\n]*/gi) ?? []).join(" | ");
  const saveLabel = await page.getByRole("button", { name: /^Save/ }).first().innerText();
  await shot(page, R2("td-edit-used-by-approved"));
  await page.getByRole("button", { name: "Cancel" }).first().click().catch(() => undefined);
  await page.getByRole("button", { name: "More actions for TD-0001" }).click();
  await page.getByRole("menuitem", { name: "Retire" }).or(page.getByRole("button", { name: "Retire" })).first().click();
  await page.waitForTimeout(1500);
  const rdlg = page.getByRole("dialog");
  let retire = "";
  if (await appears(rdlg, 2000)) {
    const confirm = rdlg.getByRole("button", { name: /Retire/ }).last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => undefined);
    await page.waitForTimeout(1500);
    retire = (await rdlg.innerText().catch(() => "")).slice(0, 600);
    await shot(page, R2("td-retire-in-use"));
    await page.keyboard.press("Escape");
  }
  saveState({ r2Data: JSON.stringify({ headings: headings.slice(0, 12), warn, saveLabel, retire }) });
  // Conditions: coverage item names, evidence link (16).
  await page.goto(`${base}/test-cases?view=conditions`);
  await page.waitForTimeout(4000);
  const cond = page.getByRole("link", { name: /TCOND-0006/ }).first();
  if (await appears(cond, 5000)) { await cond.click(); await page.waitForTimeout(3000); }
  const ctext = await page.locator("main").innerText();
  saveState({ r2Cond: JSON.stringify({ lenItems: ctext.match(/TD-\d+ \(len:\d+\)/g) ?? [], evidence: await page.getByRole("link", { name: /evidence|DOM|Evidence/i }).count(), url: page.url() }) });
  await shot(page, R2("tcond0006"));
  // Regenerate dialog copy.
  await page.goto(`${base}/test-cases`);
  const regen = page.getByRole("button", { name: /^Regenerate/ }).first();
  if (await appears(regen, 10_000)) { await regen.click(); const d = page.getByRole("dialog"); await appears(d, 3000); saveState({ r2Regen: (await d.innerText().catch(() => "")).slice(0, 800) }); await shot(page, R2("regenerate-dialog")); await page.keyboard.press("Escape"); }
  // Assistant: task groups and the proposals list (62, 63, 65).
  await page.goto(`${base}/assistant`);
  await page.waitForTimeout(5000);
  const atext = await page.locator("main").innerText();
  const needsAi = atext.slice(atext.indexOf("NEEDS AI"), atext.indexOf("NEEDS AI") + 300);
  saveState({ r2AssistantNeedsAi: needsAi.replace(/\n/g, " | ") });
  await shot(page, R2("assistant-tasks"));
  await a11y(page, "assistant r2");
});

test("R2f assistant-added case: steps read as values, not placeholders", async ({ page }) => {
  const s = await owner(page);
  await page.goto(`/projects/${s.pid}/test-cases/TC-0045`);
  await page.getByRole("heading", { level: 1 }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2000);
  const text = await page.locator("main").innerText();
  saveState({ r2Placeholder: JSON.stringify({ count: (text.match(/\{d\d\}/g) ?? []).length, lines: (text.match(/[^\n]*\{d\d\}[^\n]*/g) ?? []).slice(0, 4) }) });
  await shot(page, R2("assistant-case-placeholders"));
});

// ---------------- Round 3 (targeted re-checks; needs a pending regeneration review) ----------------
const R3 = (name: string) => `round3-${name}`;
test("R3 copy and web fixes: pending regenerate, readable change review, check 5, preliminary, coverage labels, data headings, retire wording, toast case, accepted case steps", async ({ page }) => {
  test.setTimeout(8 * 60_000);
  const s = await owner(page);
  const base = `/projects/${s.pid}`;
  const out: Record<string, unknown> = {};
  // Regenerate while a review is pending (45).
  await page.goto(`${base}/test-cases`);
  await page.getByRole("button", { name: /^Regenerate/ }).first().click();
  const rd = page.getByRole("dialog");
  await appears(rd, 5000);
  await page.waitForTimeout(800);
  out.regenPending = (await rd.innerText().catch(() => "")).slice(0, 600);
  out.regenButtons = await rd.getByRole("button").allInnerTexts().catch(() => []);
  await shot(page, R3("regenerate-pending"));
  await page.keyboard.press("Escape");
  // Change review steps (readable, no JSON).
  await page.goto(`${base}/test-cases/changes?run=${s.r3pending}`);
  await page.waitForTimeout(5000);
  const rv = await page.locator("main").innerText();
  out.reviewJson = /\{"|"action"|data_ids|[0-9a-f]{8}-[0-9a-f]{4}-/.test(rv);
  out.reviewSteps = (rv.match(/[^\n]*Open \/contact[^\n]*/g) ?? []).slice(0, 4);
  await shot(page, R3("change-review"));
  await a11y(page, "change review r3");
  // Check 5 on the overview after the run finished.
  await page.goto(base);
  await page.waitForTimeout(4000);
  const ov = await page.locator("main").innerText();
  out.check5 = (ov.match(/[^\n]*Started automatically after Gate 4 approval[^\n]*/g) ?? []).slice(0, 2);
  // Preliminary once (23).
  await page.goto(`${base}/test-cases/TC-0006`);
  await page.getByRole("heading", { level: 1 }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  out.preliminary = ((await page.locator("main").innerText()).match(/Preliminary: assessed in Phase 4/g) ?? []).length;
  await shot(page, R3("tc0006-preliminary"));
  // Accepted negative case steps on the page.
  await page.goto(`${base}/test-cases/TC-0045`);
  await page.getByRole("heading", { level: 1 }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  const tc45 = await page.locator("main").innerText();
  out.tc45 = { placeholders: (tc45.match(/\{d\d\}/g) ?? []).length, steps: (tc45.match(/[^\n]*Enter [^\n]*/g) ?? []).slice(0, 3), dataLinks: await page.getByRole("link", { name: /TD-00\d\d/ }).count() };
  await shot(page, R3("tc0045-accepted-case"));
  // Coverage item labels (TCOND-0006).
  await page.goto(`${base}/test-cases?view=conditions`);
  await page.waitForTimeout(4000);
  const cv = await page.locator("main").innerText();
  out.lenLabels = (cv.match(/\(len:\d+\)/g) ?? []).length;
  out.coverageSamples = (cv.match(/TD-\d+ \([^)\n]{1,30}\)/g) ?? []).slice(0, 6);
  await shot(page, R3("conditions"));
  // Test data headings and retire wording.
  await page.goto(`${base}/test-cases?view=data`);
  await page.getByRole("button", { name: "Edit TD-0001" }).waitFor({ timeout: 60_000 });
  out.dataHeadings = (await page.locator("main").getByRole("heading").allInnerTexts()).filter((h) => /Form/.test(h));
  await page.getByRole("button", { name: "More actions for TD-0001" }).click();
  await page.getByRole("menuitem", { name: "Retire" }).or(page.getByRole("button", { name: "Retire" })).first().click();
  const rdlg = page.getByRole("dialog");
  if (await appears(rdlg, 3000)) {
    const confirm = rdlg.getByRole("button", { name: /Retire/ }).last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => undefined);
    await page.waitForTimeout(1500);
    out.retire = (await rdlg.innerText().catch(() => "")).slice(0, 500);
    await shot(page, R3("td-retire-in-use"));
    await page.keyboard.press("Escape");
  }
  await shot(page, R3("test-data"));
  // Toast sentence case: edit an approved-or-draft case and collect toasts.
  await page.goto(`${base}/test-cases/TC-0013`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Objective").first().fill("Check the Name field at its lower boundary (QA round 3 edit).");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForTimeout(3000);
  out.toasts = await page.locator("[role=status]").allInnerTexts();
  saveState({ r3: JSON.stringify(out) });
});

test("R3b apply the pending review in the UI and read the toasts (sentence case)", async ({ page }) => {
  const s = await owner(page);
  await page.goto(`/projects/${s.pid}/test-cases/changes?run=${s.r3pending}`);
  const apply = page.getByRole("button", { name: /^Apply/ }).first();
  await apply.waitFor({ timeout: 60_000 });
  await apply.click();
  const c = page.getByRole("dialog");
  if (await appears(c, 2000)) await c.getByRole("button", { name: /^Apply/ }).last().click();
  const seen = new Set<string>();
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    for (const t of await page.locator("[role=status], [role=alert]").allInnerTexts()) for (const line of t.split("\n")) if (line.trim()) seen.add(line.trim());
    await page.waitForTimeout(500);
  }
  saveState({ r3Toasts: JSON.stringify([...seen].slice(0, 12)) });
  await shot(page, R3("after-apply-toasts"));
});

test("R3c check 5 on a project whose design was started by G4 (round 2 project), after the run finished", async ({ page }) => {
  const s = await owner(page);
  await page.goto(`/projects/${s.pid_r2}`);
  await page.getByRole("button", { name: /^Show all \d+ steps$/ }).click({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  const t = await page.locator("main").innerText();
  saveState({ r3Check5: JSON.stringify((t.match(/[^\n]*(Started automatically after Gate 4 approval|Test conditions & test cases)[^\n]*/g) ?? []).slice(0, 4)) });
  await shot(page, R3("check5-started-automatically"));
});

test("R3d coverage item labels on TCOND-0006 (no len:n)", async ({ page }) => {
  const s = await owner(page);
  await page.goto(`/projects/${s.pid}/test-cases?view=conditions`);
  await page.waitForTimeout(4000);
  const name = page.getByText("TCOND-0006").first();
  if (await appears(name, 10_000)) { await name.click().catch(() => undefined); await page.waitForTimeout(2000); }
  const t = await page.locator("main").innerText();
  const btns = await page.getByRole("button", { name: /^TD-\d+/ }).allInnerTexts();
  saveState({ r3Coverage: JSON.stringify({ len: (t.match(/len:\d+/g) ?? []).length, buttons: btns.slice(0, 8) }) });
  await shot(page, R3("tcond0006-coverage-labels"));
});
