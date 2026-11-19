// QA (P4-14b): record manual results through the UI against the REAL backend (P4-14a), AI off. Not a mocked spec:
// every number and string is compared with what the API returns.
//
// Needs a project that went through Gate 5 and has CHG-0001 with manual must-run Contact cases: run
// phase6-journey.spec.ts first with P6_STATE set, then this spec with the same P6_STATE. Required:
//   E2E_API_URL        the private backend, e.g. http://localhost:8250 (ALLOW_PRIVATE_TARGETS=true, AI off)
//   P6_STATE           the JSON state file phase6-journey.spec.ts wrote (`pid`, `chg`)
//   P414_VIEWER_FILE   where to keep the viewer account this spec invites (outside the repo; written 0600)
// Accounts: the shared e2e account (owner) and the e2e member (journey.signInMember). Never point it at shared services.
//
// Covers design docs/design/P4-14-manual-results.md §10 on the real stack: 1 (entry points, viewer), 2 (defaults and
// counts), 3 (script note), 4 (case detail prefill), 5 (start, h1 focus, no G7), 6 (validation), 7 (announcement,
// focus), 8 (12 MB, HTML-as-PNG server message, result stays saved), 9 (no draft, prefilled defect), 10 (someone else's
// result read-only), 11 (finish with a case left), 13 (finished read-only), 14 (display everywhere), 15 (change set
// re-test), 16 (keyboard, 320/375 px, axe), 18 (zero results: finish unavailable, discard).
import { readFile, writeFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { uniqueEmail, useSharedAccount, signIn, type Account } from "./helpers";
import { signInMember } from "./journey";

test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 30_000 });

const API = `${(process.env.E2E_API_URL ?? "http://localhost:8200").replace(/\/+$/, "")}/api/v1`;
const STATE = process.env.P6_STATE ?? "";
const VIEWER_FILE = process.env.P414_VIEWER_FILE ?? "";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const s: Json = {};

// A 1×1 PNG and a tiny PDF (real magic bytes).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const WHAT_PASS = "Opened /login with the browser's tools: the sign-in form posts to an https:// address";
const WHAT_FAIL = "Typed an unknown email: the error says the account doesn't exist, which reveals who has an account";
const WHAT_BLOCK = "Couldn't send a request without the browser: no API client on this machine today";
const WHAT_RETEST = "Sent the contact form on release 2: the confirmation never appeared";

class Api {
  constructor(private req: APIRequestContext, private token: string) {}
  async call<T = Json>(method: string, p: string, body?: unknown, ok: number[] = [200, 201, 202]): Promise<T> {
    const r = await this.req.fetch(`${API}${p}`, { method, data: body, headers: { Authorization: `Bearer ${this.token}` } });
    const text = await r.text();
    expect(ok, `${method} ${p} → ${r.status()} ${text.slice(0, 300)}`).toContain(r.status());
    return (text ? JSON.parse(text) : {}) as T;
  }
  get<T = Json>(p: string) {
    return this.call<T>("GET", p);
  }
  post<T = Json>(p: string, body: unknown = {}, ok?: number[]) {
    return this.call<T>("POST", p, body, ok);
  }
}

async function apiFor(req: APIRequestContext, a: Account) {
  const r = await req.post(`${API}/auth/login`, { data: { email: a.email, password: a.password } });
  expect(r.status()).toBe(200);
  return new Api(req, (await r.json()).token);
}

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const card = (page: Page, k: string) => page.getByRole("region", { name: new RegExp(`^${k} `) });
const live = (page: Page) => page.locator('main p[role="status"][aria-live="polite"]').last();

async function allCases(api: Api): Promise<Json[]> {
  const out: Json[] = [];
  let cursor = "";
  for (;;) {
    const p = await api.get(`/projects/${s.pid}/test-cases?limit=100${cursor ? `&cursor=${cursor}` : ""}`);
    out.push(...(p.items as Json[]));
    if (!p.next_cursor) return out;
    cursor = p.next_cursor;
  }
}

let owner: Account;
let member: Account;
let O: Api;
let M: Api;
let mPage: Page;

async function memberPage(browser: Browser): Promise<Page> {
  if (mPage && !mPage.isClosed()) return mPage;
  const ctx = await browser.newContext();
  mPage = await ctx.newPage();
  // signInMember only invites when the file is missing; the phase 6 journey made it already.
  member = await signInMember(mPage, mPage, browser);
  return mPage;
}

test.beforeAll(async () => {
  expect(STATE, "P6_STATE must point at the phase 6 journey's state").toBeTruthy();
  Object.assign(s, JSON.parse(await readFile(STATE, "utf8")));
  // This spec's own ids (RUN, DEF keys) next to the phase 6 state, so a failed step can be resumed with -g.
  Object.assign(s, await readFile(`${STATE}.p414.json`, "utf8").then((x) => JSON.parse(x) as Json).catch(() => ({})));
  expect(s.pid).toBeTruthy();
  const health = await (await fetch(`${API}/health`)).json();
  expect(health.ai.enabled).toBe(false);
});

test.afterEach(async () => {
  const mine = Object.fromEntries(["preselected", "run", "runId", "failId", "defectsBefore", "defKey"].filter((k) => k in s).map((k) => [k, s[k]]));
  await writeFile(`${STATE}.p414.json`, JSON.stringify(mine, null, 2));
});

test.beforeEach(async ({ page, browser, request }) => {
  owner = await useSharedAccount(page);
  await memberPage(browser);
  O = await apiFor(request, owner);
  M = await apiFor(request, member);
});

test("1. Member opens the Start modal from Test Execution: Needs a person by default, counts equal the API, script note, axe; starts 4 cases (checks 1, 2, 3, 5)", async () => {
  const page = mPage;
  const cases = await allCases(O);
  const assess = await O.get(`/projects/${s.pid}/automation/assessment`);
  const suit = new Map((assess.cases as Json[]).map((c) => [c.key, c.suitability]));
  const approved = cases.filter((c) => c.status === "approved");
  const needs = approved.filter((c) => suit.get(c.key) === "manual_only");
  const pre = needs.filter((c) => !["passed", "failed"].includes(c.last_result?.status)).map((c) => c.key);
  s.preselected = pre;
  const runs = await M.get(`/projects/${s.pid}/execution-runs?limit=50`);
  const mine = (runs.items as Json[]).filter((r) => r.status === "recording" && r.requested_by?.id);
  console.log(`[p414] approved=${approved.length} needs=${needs.length} preselected=${pre.join(",")} recording=${(runs.recording ?? []).join(",")}`);

  await page.goto(`/projects/${s.pid}/execution`);
  await expect(page.getByRole("heading", { level: 1, name: "Test Execution" })).toBeVisible({ timeout: 60_000 });
  for (const r of mine) {
    await expect(page.getByText(`You're recording ${r.key} by hand: ${r.manual.recorded} of ${r.manual.tests} recorded.`)).toBeVisible();
    await expect(page.getByRole("link", { name: `Continue recording ${r.key}` })).toBeVisible();
  }
  await page.getByRole("button", { name: "Record manual results" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Record manual results" });
  await expect(dialog.getByText("You test the site yourself and record what happened. Nothing runs on the platform, so this doesn't need Gate 7.")).toBeVisible();
  const show = dialog.getByRole("radiogroup", { name: "Show" });
  await expect(show.getByRole("radio", { name: `Needs a person (${needs.length})` })).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await expect(show.getByRole("radio", { name: `All approved cases (${approved.length})` })).toBeVisible();
  for (const c of needs) {
    const box = dialog.getByRole("checkbox", { name: new RegExp(`^Select ${c.key} `) });
    if (pre.includes(c.key)) await expect(box).toBeChecked();
    else await expect(box).not.toBeChecked();
  }
  await expect(dialog.getByText(`${pre.length} selected (up to 100)`)).toBeVisible();
  for (const r of mine) {
    await expect(dialog.getByText(`You're already recording ${r.key} (${r.manual.recorded} of ${r.manual.tests} recorded).`)).toBeVisible();
    for (const k of (r.selection?.case_keys ?? []) as string[]) if (needs.some((c) => c.key === k)) await expect(dialog.getByRole("listitem").filter({ hasText: k }).getByText(`Also in ${r.key} (recording)`)).toBeVisible();
  }
  // A case recorded by hand reads "By hand, {name}" in its last result line.
  const byHand = needs.find((c) => c.last_result?.manual);
  if (byHand) await expect(dialog.getByRole("listitem").filter({ hasText: byHand.key }).getByText(new RegExp(`Last result: \\w+ · By hand, ${byHand.last_result.recorded_by} · `))).toBeVisible();
  expect(await axe(page), "axe on the Start modal").toEqual([]);

  await show.getByRole("radio", { name: `All approved cases (${approved.length})` }).click();
  await expect(dialog.getByRole("list", { name: "Approved test cases" }).getByRole("listitem")).toHaveCount(approved.length);
  await expect(dialog.getByRole("status")).toHaveText(`Showing ${approved.length} cases.`);
  // Clear the selection with the tri-state "Select all shown".
  const all = dialog.getByRole("checkbox", { name: `Select all shown (${approved.length})` });
  if (!(await all.isChecked())) await all.click();
  await all.click();
  await expect(dialog.getByText("0 selected (up to 100)")).toBeVisible();
  await expect(dialog.getByText("Choose at least one case.")).toBeVisible();
  const find = dialog.getByRole("textbox", { name: "Find a case" });
  for (const k of ["TC-0041", "TC-0028", "TC-0040", "TC-0027"]) {
    await find.fill(k);
    await expect(dialog.getByRole("status")).toHaveText("Showing 1 case.");
    await dialog.getByRole("checkbox", { name: new RegExp(`^Select ${k} `) }).check();
  }
  // TC-0027 can be automated (it has a script): the note shows once it is checked.
  await expect(dialog.getByText("Has a script. A result you record replaces its latest automated result.")).toBeVisible();
  await find.fill("");
  await expect(dialog.getByText("4 selected (up to 100)")).toBeVisible();
  await dialog.getByRole("button", { name: "Start recording 4 cases" }).click();

  await expect(page).toHaveURL(/\/execution\/RUN-\d{4}\/record$/, { timeout: 30_000 });
  s.run = page.url().match(/(RUN-\d{4})\/record$/)![1];
  const h1 = page.getByRole("heading", { level: 1, name: `Record manual results · ${s.run}` });
  await expect(h1).toBeFocused();
  await expect(page.getByText(/^By hand · started by Morgan Member, .+ · 4 cases · Results count as soon as you save them\.$/)).toBeVisible();
  await expect(page.getByText("0 of 4 recorded", { exact: true })).toBeVisible();
  await expect(page.getByText(/Gate 7|Authoris/)).toHaveCount(0);
  const run = await M.get(`/projects/${s.pid}/execution-runs/by-key/${s.run}`);
  s.runId = run.id;
  expect([run.mode, run.status, run.authorisation ?? null, run.manual]).toEqual(["manual", "recording", null, { recorded: 0, tests: 4, change_set_key: null }]);
  expect(run.permissions).toMatchObject({ can_record: true, can_finish: false, can_rerun: false });
  // Card order follows the run plan; the unrecorded cards read "Not recorded yet" with their steps open.
  await expect(card(page, "TC-0041").getByText("Not recorded yet")).toBeVisible();
  await expect(card(page, "TC-0041").getByRole("button", { name: "Steps and expected result" })).toHaveAttribute("aria-expanded", "true");
  await expect(card(page, "TC-0041").getByText(/^Expected result \(TC-0041 v\d+\):/)).toBeVisible();
  expect(await axe(page), "axe on the record page").toEqual([]);

  // Run list: "Recording · 0 of 4 recorded", "Manual · 4 cases".
  await page.goto(`/projects/${s.pid}/execution`);
  const row = page.getByRole("table", { name: "Test runs" }).getByRole("row").filter({ hasText: s.run });
  await expect(row.getByText("Recording · 0 of 4 recorded")).toBeVisible();
  await expect(row.getByText("Manual · 4 cases")).toBeVisible();
  await expect(row.getByText(/Morgan Member · not needed \(manual\)/)).toBeVisible();
});

test("2. Record Passed (announced, focus on Save), Failed with a PNG and a PDF (12 MB refused, HTML-as-PNG refused by the server), Blocked by keyboard only (checks 6, 7, 8, 16)", async () => {
  const page = mPage;
  await page.goto(`/projects/${s.pid}/execution/${s.run}/record`);
  await expect(page.getByRole("heading", { level: 1, name: `Record manual results · ${s.run}` })).toBeVisible({ timeout: 60_000 });

  // Passed.
  const pass = card(page, "TC-0041");
  await pass.getByRole("radio", { name: "Passed" }).check();
  await pass.getByRole("textbox", { name: "What happened" }).fill(WHAT_PASS);
  await pass.getByRole("textbox", { name: "Notes" }).fill("Chromium 131 on macOS, developer tools Network tab");
  await pass.getByRole("button", { name: "Save result for TC-0041" }).click();
  await expect(live(page)).toHaveText("TC-0041 saved as Passed. 1 of 4 recorded.");
  await expect(page.getByText("1 of 4 recorded · 1 passed", { exact: true })).toBeVisible();
  await expect(pass.getByRole("button", { name: "Save changes for TC-0041" })).toBeFocused();
  await expect(pass.getByText(/^Saved · Passed · Recorded by Morgan Member, /)).toBeVisible();
  // No toast for a save (§8).
  await expect(page.locator("[data-toast]").filter({ hasText: "saved as" })).toHaveCount(0);
  // Counts as soon as it is saved: REQ-0013 leaves "manual only" before the run is finished.
  const gaps = await O.get(`/projects/${s.pid}/traceability/gaps`);
  expect((gaps.requirements_without_execution_evidence.manual_only as Json[]).map((r) => r.key)).not.toContain("REQ-0013");

  // Failed: validation first.
  const fail = card(page, "TC-0028");
  await fail.getByRole("button", { name: "Save result for TC-0028" }).click();
  await expect(fail.getByText("Choose Passed, Failed or Blocked.")).toBeVisible();
  await expect(fail.getByText("Describe what happened.")).toBeVisible();
  await expect(fail.getByRole("radio", { name: "Passed" })).toBeFocused();
  await expect(fail.getByRole("textbox", { name: "What happened" })).toHaveAttribute("aria-invalid", "true");
  await expect(fail.getByRole("textbox", { name: "What happened" })).toHaveAccessibleDescription(/Describe what happened\./);
  const input = fail.locator('input[type="file"]');
  await input.setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(12 * 1024 * 1024, 1) });
  await expect(fail.getByText("huge.png: This file is larger than 10 MB.")).toBeVisible();
  await expect(live(page)).toHaveText("huge.png: This file is larger than 10 MB.");
  await input.setInputFiles([
    { name: "sign-in-error.png", mimeType: "image/png", buffer: PNG },
    { name: "network.pdf", mimeType: "application/pdf", buffer: PDF },
  ]);
  await expect(fail.getByText("Will upload when you save")).toHaveCount(2);
  await fail.getByRole("radio", { name: "Failed" }).check();
  await fail.getByRole("textbox", { name: "What happened" }).fill(WHAT_FAIL);
  await fail.getByRole("button", { name: "Save result for TC-0028" }).click();
  await expect(fail.getByRole("link", { name: "Open sign-in-error.png from TC-0028 (opens in a new tab)" })).toBeVisible({ timeout: 30_000 });
  await expect(fail.getByRole("link", { name: "Open network.pdf from TC-0028 (opens in a new tab)" })).toBeVisible();
  await expect(fail.getByText(/· Uploaded/)).toHaveCount(2);
  for (const [name, mime] of [["sign-in-error.png", "image/png"], ["network.pdf", "application/pdf"]]) {
    const href = await fail.getByRole("link", { name: `Open ${name} from TC-0028 (opens in a new tab)` }).getAttribute("href");
    const r = await fetch(href!);
    expect(r.status, `${name} opens`).toBe(200);
    expect(r.headers.get("content-type")).toContain(mime);
  }
  await expect(page.getByText("2 of 4 recorded · 1 passed · 1 failed", { exact: true })).toBeVisible();
  await expect(fail.getByText("No defect is drafted automatically for manual results.")).toBeVisible();
  // The server checks content: an HTML page named .png is refused, the result stays saved.
  await input.setInputFiles({ name: "fake.png", mimeType: "image/png", buffer: Buffer.from("<!doctype html><html><body>not an image</body></html>") });
  await fail.getByRole("button", { name: "Save changes for TC-0028" }).click();
  await expect(fail.getByText("fake.png: This file type isn't supported. Use PNG, JPEG or PDF.")).toBeVisible();
  await expect(live(page)).toHaveText("fake.png: This file type isn't supported. Use PNG, JPEG or PDF.");
  const res = await M.get(`/projects/${s.pid}/execution-results/by-key/${s.run}-02`);
  expect([res.case_key, res.status, res.actual_result, res.evidence.length, res.manual, res.recorded_by?.full_name, res.not_analysed]).toEqual([
    "TC-0028",
    "failed",
    WHAT_FAIL,
    2,
    true,
    "Morgan Member",
    "Not analysed: recorded by a person",
  ]);
  s.failId = res.id;
  const defects = await O.get(`/projects/${s.pid}/defects?status=all&limit=100`);
  s.defectsBefore = (defects.items as Json[]).length;
  expect((defects.items as Json[]).filter((d) => JSON.stringify(d).includes(`${s.run}-02`))).toEqual([]);

  // Blocked, keyboard only: jump link → h2 → Steps → radios (arrows) → What happened → … → Save (Enter).
  const blocked = card(page, "TC-0040");
  const nav = page.getByRole("navigation", { name: "Cases" });
  await nav.getByRole("link", { name: /^TC-0040 .+, not recorded yet$/ }).focus();
  await page.keyboard.press("Enter");
  await expect(blocked.getByRole("heading", { level: 2 })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(blocked.getByRole("button", { name: "Steps and expected result" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(blocked.getByRole("radio", { name: "Passed" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(blocked.getByRole("radio", { name: "Blocked" })).toBeChecked();
  await expect(blocked.getByRole("group", { name: /Result for TC-0040/ })).toHaveAccessibleDescription(/Blocked means you couldn't test it\. It doesn't count as execution evidence\./);
  await page.keyboard.press("Tab");
  await expect(blocked.getByRole("textbox", { name: "What happened" })).toBeFocused();
  await page.keyboard.type(WHAT_BLOCK);
  await page.keyboard.press("Tab");
  await expect(blocked.getByRole("textbox", { name: "Notes" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(blocked.getByRole("button", { name: "Add files… to TC-0040" })).toBeFocused();
  await page.keyboard.press("Tab");
  const save = blocked.getByRole("button", { name: "Save result for TC-0040" });
  await expect(save).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(live(page)).toHaveText("TC-0040 saved as Blocked. 3 of 4 recorded.");
  await expect(blocked.getByRole("button", { name: "Save changes for TC-0040" })).toBeFocused();
  // Blocked isn't evidence: REQ-0008 stays "manual only".
  const g2 = await O.get(`/projects/${s.pid}/traceability/gaps`);
  expect((g2.requirements_without_execution_evidence.manual_only as Json[]).map((r) => r.key)).toContain("REQ-0008");
  expect((g2.failed_tests as Json[]).find((f) => f.case.key === "TC-0028")).toMatchObject({ manual: true, recorded_by: "Morgan Member", label: "Not analysed: recorded by a person", classification: null });
});

test("3. Someone else's result is read-only for the owner (check 10); the 403 copy matches the server", async ({ page }) => {
  await page.goto(`/projects/${s.pid}/execution/${s.run}/record`);
  await expect(page.getByRole("heading", { level: 1, name: `Record manual results · ${s.run}` })).toBeVisible({ timeout: 60_000 });
  const c = card(page, "TC-0041");
  await expect(c.getByText(`Recorded by Morgan Member`, { exact: true })).toBeVisible();
  await expect(c.getByText(new RegExp(`^Recorded by Morgan Member, .+\\. Only they can change it until ${s.run} is finished\\.$`))).toBeVisible();
  await expect(c.getByRole("radio")).toHaveCount(0);
  await expect(c.getByText(WHAT_PASS)).toBeVisible();
  // The owner started nothing here: the finish confirm names the starter.
  await page.getByRole("button", { name: "Finish recording…" }).first().click();
  const confirm = page.getByRole("dialog", { name: "Finish with 1 case not recorded? It'll show 'Not run'." });
  await expect(confirm.getByText(`Morgan Member started ${s.run}. Finishing it ends recording for everyone.`)).toBeVisible();
  await confirm.getByRole("button", { name: "Keep recording" }).click();
  // The server's own refusal for an edit by someone else.
  const r = await O.call("PUT", `/execution-runs/${s.runId}/results/TC-0041`, { status: "failed", actual_result: "x" }, [403]);
  expect(r.error.message).toBe(`Only Morgan Member can change this result until ${s.run} is finished.`);
});

test("4. Raise defect from the manual failure: no draft before submit, form prefilled with What happened; the draft says 'By hand' and links both files (check 9)", async () => {
  const page = mPage;
  await page.goto(`/projects/${s.pid}/execution/${s.run}/record`);
  const fail = card(page, "TC-0028");
  await fail.getByRole("link", { name: "Raise defect… from TC-0028 result" }).click();
  await expect(page).toHaveURL(new RegExp(`/defects/new\\?from=${s.run}-02$`));
  await expect(page.getByText(`Prefilled from ${s.run}-02. Check the wording before saving.`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("textbox", { name: /Actual result/ })).toHaveValue(WHAT_FAIL);
  expect(((await O.get(`/projects/${s.pid}/defects?status=all&limit=100`)).items as Json[]).length).toBe(s.defectsBefore);
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page).toHaveURL(/\/defects\/DEF-\d{4}$/, { timeout: 30_000 });
  s.defKey = page.url().match(/(DEF-\d{4})$/)![1];
  const d = await O.get(`/projects/${s.pid}/defects/by-key/${s.defKey}`).catch(async () => {
    const list = (await O.get(`/projects/${s.pid}/defects?status=all&limit=100`)).items as Json[];
    return O.get(`/defects/${list.find((x) => x.key === s.defKey)!.id}`);
  });
  console.log(`[p414] defect environment=${JSON.stringify(d.environment)} refs=${JSON.stringify((d.evidence_refs ?? d.evidence ?? []).map((e: Json) => e.kind ?? e.type))} source=${d.source}`);
  expect(d.actual).toBe(WHAT_FAIL);
  expect(d.environment.browser).toBe("By hand, recorded by Morgan Member");
  expect(JSON.stringify(d.evidence_refs ?? d.evidence)).toContain("document_file");
  // Back on the card, the defect replaces [Raise defect…].
  await page.goto(`/projects/${s.pid}/execution/${s.run}/record`);
  await expect(card(page, "TC-0028").getByRole("link", { name: `Open ${s.defKey}` })).toBeVisible({ timeout: 30_000 });
  await expect(card(page, "TC-0028").getByRole("link", { name: /Raise defect/ })).toHaveCount(0);
});

test("5. Finish with a case left: the confirm lists it; run page with By hand rows and Not run; h1 focused; run list and record page read-only (checks 11, 13)", async () => {
  const page = mPage;
  await page.goto(`/projects/${s.pid}/execution/${s.run}/record`);
  await page.getByRole("button", { name: "Finish recording…" }).last().click();
  const dialog = page.getByRole("dialog", { name: "Finish with 1 case not recorded? It'll show 'Not run'." });
  await expect(dialog.getByText("Not recorded: TC-0027.")).toBeVisible();
  await expect(dialog.getByText("Results can't be changed after this.")).toBeVisible();
  await dialog.getByRole("button", { name: "Finish recording", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/execution/${s.run}$`));
  await expect(page.getByRole("heading", { level: 1, name: `${s.run} · Manual` })).toBeFocused();
  await expect(page.getByText(`${s.run} finished: 1 passed, 1 failed, 1 blocked, 1 not run.`)).toBeVisible();
  await expect(page.getByText("Finished · 1 failed")).toBeVisible();
  await expect(page.getByText(`Failed by hand (1): TC-0028. Not analysed: recorded by a person.`)).toBeVisible();
  const table = page.getByRole("table", { name: "Results (4)" });
  await expect(table.getByText("Not run")).toHaveCount(1);
  await expect(table.getByText(/^Morgan Member · /)).toHaveCount(3);
  await expect(page.getByRole("link", { name: /Continue recording/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Re-run/ })).toHaveCount(0);
  const run = await M.get(`/execution-runs/${s.runId}`);
  expect([run.status, run.totals.tests, run.finished_by?.full_name]).toEqual(["failed", 4, "Morgan Member"]);
  await page.getByRole("button", { name: `More actions for ${s.run}` }).click();
  await expect(page.getByRole("menuitem", { name: "Open Test Execution Report" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto(`/projects/${s.pid}/execution`);
  const row = page.getByRole("table", { name: "Test runs" }).getByRole("row").filter({ hasText: s.run });
  await expect(row.getByText("Finished · 1 failed")).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText("1 passed · 1 failed · 1 blocked · 1 not run (by hand)")).toBeVisible();

  await page.goto(`/projects/${s.pid}/execution/${s.run}/record`);
  await expect(page.getByText(new RegExp(`^${s.run} was finished by Morgan Member on .+\\. Start a new manual run to record again\\.$`))).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Finish recording/ })).toHaveCount(0);
  await expect(card(page, "TC-0027").getByText("Not run: nothing was recorded for this case.")).toBeVisible();
});

test("6. 'By hand · Recorded by' on the result, case list, case detail and traceability; never a cause (check 14)", async () => {
  const page = mPage;
  await page.goto(`/projects/${s.pid}/execution/${s.run}/results/${s.run}-02`);
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(`${s.run}-02 · TC-0028`) })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(new RegExp(`^By hand · Recorded by Morgan Member, .+ · ${s.run} · TC-0028 v\\d+$`))).toBeVisible();
  await expect(page.getByText(WHAT_FAIL)).toBeVisible();
  await expect(page.getByText("No notes.")).toBeVisible();
  await expect(page.getByText("Not analysed: recorded by a person.")).toBeVisible();
  await expect(page.getByText(/^Steps \(TC-0028 v\d+; recorded as one result, not step by step\)$/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open File 1 (PNG) (opens in a new tab)" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open File 2 (PDF) (opens in a new tab)" })).toBeVisible();
  await expect(page.getByText(/Hypothesis|Confidence|Observed on the page|Change the cause|Likely/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: new RegExp(`View ${s.defKey}`) })).toBeVisible();
  expect(await axe(page), "axe on a manual result").toEqual([]);

  await page.goto(`/projects/${s.pid}/test-cases/TC-0041`);
  await expect(page.getByText("By hand · Recorded by Morgan Member").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("link", { name: "Record a manual result…" })).toBeVisible();

  await page.goto(`/projects/${s.pid}/test-cases`);
  await expect(page.getByRole("link", { name: new RegExp(`^Passed by hand, recorded by Morgan Member, ${s.run}, \\d+ \\w+$`) }).first()).toBeVisible({ timeout: 60_000 });

  await page.goto(`/projects/${s.pid}/traceability?view=matrix`);
  await expect(page.getByText(`✓ Passed ${s.run} · By hand · Recorded by Morgan Member`).first()).toBeVisible({ timeout: 60_000 });
  const gaps = await O.get(`/projects/${s.pid}/traceability/gaps`);
  const manualOnly = (gaps.requirements_without_execution_evidence.manual_only as Json[]).length;
  await page.goto(`/projects/${s.pid}/traceability?view=coverage`);
  await expect(page.getByRole("heading", { name: `Manual only, no recorded result (${manualOnly})` })).toBeVisible({ timeout: 60_000 });
  const failed = page.locator("#gap-failed");
  const item = failed.getByRole("listitem").filter({ hasText: "TC-0028" });
  await expect(item.getByText("By hand · Recorded by Morgan Member")).toBeVisible();
  await expect(item.getByText("Not analysed: recorded by a person")).toBeVisible();
  await expect(item.getByText("(Hypothesis)")).toHaveCount(0);
});

test("7. Change set Manual re-tests: Passed/Failed only, What happened; the item reads 'By hand · Recorded by'; the case shows it; a waiting assessment goes out of date (check 15)", async () => {
  const page = mPage;
  // A waiting assessment first, so the re-test makes it stale.
  const before = (await O.get(`/projects/${s.pid}/release-readiness`)).latest?.key ?? null;
  await M.post(`/projects/${s.pid}/release-assessments`, {});
  const end = Date.now() + 120_000;
  let latest: Json | null = null;
  while (Date.now() < end) {
    const b = await O.get(`/projects/${s.pid}/release-readiness`);
    if (!b.assessing && b.latest && b.latest.key !== before) {
      latest = b.latest;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  expect(latest, "a new release assessment").toBeTruthy();
  const list = await M.get(`/change-sets/${s.chg}/manual-retests`);
  const target = (list.items as Json[])[0];
  console.log(`[p414] retest item keys=${Object.keys(target).join(",")} latest keys=${Object.keys(target.latest ?? {}).join(",")}`);
  await page.goto(`/projects/${s.pid}/discovery/changes/CHG-0001?tab=regression`);
  const section = page.getByRole("region", { name: /^Manual re-tests/ });
  await expect(section.getByText("These must-run tests are run by a person, not by the regression run. Record what happened after CHG-0001. Each result counts as a manual result on the test case and for release readiness.")).toBeVisible({ timeout: 60_000 });
  await expect(section.getByRole("link", { name: "Record re-tests with files…" })).toHaveAttribute("href", new RegExp(`/execution\\?record=1&cases=.*${target.case_key}.*&change=CHG-0001$`));
  await section.getByRole("button", { name: `Record re-test result for ${target.case_key}` }).click();
  const dialog = page.getByRole("dialog", { name: `Record re-test: ${target.case_key}` });
  await expect(dialog.getByText(`What happened when you tested ${target.case_key} by hand after CHG-0001.`)).toBeVisible();
  await expect(dialog.getByRole("group", { name: new RegExp(`Result for ${target.case_key}`) }).getByRole("radio")).toHaveCount(2);
  await dialog.getByRole("button", { name: "Save result" }).click();
  await expect(dialog.getByText("Choose Passed or Failed.")).toBeVisible();
  await expect(dialog.getByText("Describe what happened.")).toBeVisible();
  await dialog.getByRole("radio", { name: "Failed" }).check();
  await dialog.getByRole("textbox", { name: "What happened" }).fill(WHAT_RETEST);
  await dialog.getByRole("button", { name: "Save result" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  await expect(section.getByText(new RegExp(`^Latest: Failed · By hand · Recorded by Morgan Member · .+: '${WHAT_RETEST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`))).toBeVisible();
  const after = await M.get(`/change-sets/${s.chg}/manual-retests`);
  const item = (after.items as Json[]).find((i) => i.case_key === target.case_key)!;
  console.log(`[p414] retest latest=${JSON.stringify(item.latest)}`);
  if (item.latest.result_key) {
    await expect(section.getByRole("link", { name: `Open ${item.latest.result_key} result` })).toBeVisible();
    await expect(section.getByRole("link", { name: `Raise defect… from ${target.case_key} result` })).toHaveAttribute("href", new RegExp(`/defects/new\\?from=${item.latest.result_key}$`));
  }
  await page.goto(`/projects/${s.pid}/test-cases/${target.case_key}`);
  await expect(page.getByText("By hand · Recorded by Morgan Member").first()).toBeVisible({ timeout: 60_000 });
  const rr = await O.get(`/projects/${s.pid}/release-readiness`);
  console.log(`[p414] readiness latest=${rr.latest?.key} status=${rr.latest?.status} stale=${JSON.stringify(rr.latest?.stale ?? rr.latest?.stale_reasons ?? null)}`);
  // The D37 endpoint keeps its own stale reason ("Manual re-test of TC-0005 recorded (failed)"); the page shows it verbatim.
  expect([rr.latest.status, rr.latest.stale_reason]).toEqual(["stale", `Manual re-test of ${target.case_key} recorded (failed)`]);
  await page.goto(`/projects/${s.pid}/release-readiness`);
  await expect(page.getByText(`Evidence changed after this assessment (${rr.latest.stale_reason}).`, { exact: false }).first()).toBeVisible({ timeout: 60_000 });
});

test("7b. A save on the record page makes a waiting assessment stale ('TC-0042 recorded by hand (passed)'); finishing with every case recorded uses the short confirm (§4.4)", async () => {
  const page = mPage;
  const before = (await O.get(`/projects/${s.pid}/release-readiness`)).latest?.key ?? null;
  await M.post(`/projects/${s.pid}/release-assessments`, {});
  const end = Date.now() + 120_000;
  for (;;) {
    const b = await O.get(`/projects/${s.pid}/release-readiness`);
    if (!b.assessing && b.latest && b.latest.key !== before) break;
    expect(Date.now() < end, "a new release assessment").toBe(true);
    await new Promise((r) => setTimeout(r, 2000));
  }
  const run = await M.post(`/projects/${s.pid}/execution-runs`, { mode: "manual", case_keys: ["TC-0042"] }, [201]);
  await page.goto(`/projects/${s.pid}/execution/${run.key}/record`);
  const c = card(page, "TC-0042");
  await c.getByRole("radio", { name: "Passed" }).check({ timeout: 60_000 });
  await c.getByRole("textbox", { name: "What happened" }).fill("Every page loaded in under 2 seconds on a 4G profile");
  await c.getByRole("button", { name: "Save result for TC-0042" }).click();
  await expect(live(page)).toHaveText("TC-0042 saved as Passed. 1 of 1 recorded.");
  const rr = await O.get(`/projects/${s.pid}/release-readiness`);
  expect([rr.latest.status, rr.latest.stale_reason]).toEqual(["stale", "TC-0042 recorded by hand (passed)"]);
  await page.getByRole("button", { name: "Finish recording…" }).first().click();
  const dialog = page.getByRole("dialog", { name: `Finish ${run.key}?` });
  await expect(dialog.getByText("Results can't be changed after this. To record again, start a new manual run.")).toBeVisible();
  await dialog.getByRole("button", { name: "Finish recording", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: `${run.key} · Manual` })).toBeFocused({ timeout: 30_000 });
  await expect(page.getByText(`${run.key} finished: 1 passed, 0 failed.`)).toBeVisible();
  await expect(page.getByText("Finished · all passed")).toBeVisible();
  await page.goto(`/projects/${s.pid}/release-readiness`);
  await expect(page.getByText("TC-0042 recorded by hand (passed)", { exact: false }).first()).toBeVisible({ timeout: 60_000 });
});

test("8. Case detail → Start modal with only that case; record page at 320 and 375 px; zero results: Finish unavailable, Discard cancels (checks 4, 16, 18)", async () => {
  const page = mPage;
  await page.goto(`/projects/${s.pid}/test-cases/TC-0042`);
  await page.getByRole("link", { name: "Record a manual result…" }).click({ timeout: 60_000 });
  await expect(page).toHaveURL(/\/execution\?record=1&cases=TC-0042$/);
  const dialog = page.getByRole("dialog", { name: "Record manual results" });
  await expect(dialog.getByRole("checkbox", { name: /^Select TC-0042 / })).toBeChecked({ timeout: 30_000 });
  await expect(dialog.getByText("1 selected (up to 100)")).toBeVisible();
  for (const w of [375, 320]) {
    await page.setViewportSize({ width: w, height: 800 });
    expect(await sideways(page), `Start modal at ${w} px`).toBeLessThanOrEqual(0);
  }
  await dialog.getByRole("button", { name: "Start recording 1 case" }).click();
  await expect(page).toHaveURL(/\/record$/, { timeout: 30_000 });
  const key = page.url().match(/(RUN-\d{4})\/record$/)![1];
  await expect(page.getByRole("heading", { level: 1, name: `Record manual results · ${key}` })).toBeFocused();
  const finish = page.getByRole("button", { name: "Finish recording…" }).first();
  await expect(finish).toHaveAttribute("aria-disabled", "true");
  await expect(finish).toHaveAccessibleDescription("Record at least one case to finish, or discard the run.");
  for (const w of [375, 320]) {
    await page.setViewportSize({ width: w, height: 800 });
    expect(await sideways(page), `record page at ${w} px`).toBeLessThanOrEqual(0);
    const c = card(page, "TC-0042");
    for (const el of await c.locator("button, a, label:has(input[type=radio])").all()) {
      const box = await el.boundingBox();
      if (!box) continue;
      expect(Math.min(box.height, box.width), `${w}px target ${await el.innerText()}`).toBeGreaterThanOrEqual(24);
    }
  }
  expect(await axe(page), "axe at 320 px").toEqual([]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: `More actions for ${key}` }).click();
  await page.getByRole("menuitem", { name: `Discard ${key}…` }).click();
  const discard = page.getByRole("dialog", { name: `Discard ${key}?` });
  await expect(discard.getByText("Nothing has been recorded in it. It will show as Cancelled.")).toBeVisible();
  await discard.getByRole("button", { name: `Discard ${key}` }).click();
  await expect(page).toHaveURL(new RegExp(`/execution/${key}$`));
  await expect(page.getByText(`${key} discarded.`)).toBeVisible();
  await expect(page.getByText(`${key} was discarded. Nothing was recorded.`)).toBeVisible();
  const runs = (await M.get(`/projects/${s.pid}/execution-runs?limit=50`)).items as Json[];
  expect(runs.find((r) => r.key === key)?.status).toBe("cancelled");
});

test("9. Overview: the 'need a person' row for members matches the API", async () => {
  const page = mPage;
  const cases = await allCases(O);
  const auto = await O.get(`/projects/${s.pid}/automation`);
  const keys = ((auto.bundle?.not_automated ?? []) as Json[]).map((c) => c.key);
  const n = cases.filter((c) => keys.includes(c.key) && !["passed", "failed"].includes(c.last_result?.status)).length;
  console.log(`[p414] overview not_automated=${keys.length} pending=${n}`);
  await page.goto(`/projects/${s.pid}`);
  await page.getByRole("button", { name: /Show all/ }).click({ timeout: 10_000 }).catch(() => undefined);
  if (n > 0) await expect(page.getByText(`${n} approved case${n === 1 ? " needs" : "s need"} a person and ${n === 1 ? "has" : "have"} no recorded result.`)).toBeVisible({ timeout: 60_000 });
});

test("10. Viewer: no entry point anywhere; the record page sends them to the read-only run page (checks 1, 13)", async ({ browser }) => {
  // The owner invites a viewer once; the account is kept in P414_VIEWER_FILE (outside the repo).
  let viewer: Account | null = VIEWER_FILE ? await readFile(VIEWER_FILE, "utf8").then((t) => JSON.parse(t) as Account).catch(() => null) : null;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (!viewer || !(await signIn(page, viewer))) {
    const ownerCtx = await browser.newContext();
    const op = await ownerCtx.newPage();
    await signIn(op, owner);
    viewer = { email: uniqueEmail("viewer"), password: `viewer-${Date.now()}-pass` };
    await op.goto("/settings/members");
    await op.getByRole("button", { name: "Invite people" }).click({ timeout: 60_000 });
    const d = op.getByRole("dialog");
    await d.getByLabel("Email").fill(viewer.email);
    await d.getByRole("radio", { name: /^Viewer/ }).check();
    await d.getByRole("button", { name: "Create invitation link" }).click();
    const link = await d.getByLabel("Invitation link").inputValue();
    await d.getByRole("button", { name: "Done" }).click();
    const closeConfirm = op.getByRole("dialog", { name: "Close without copying the link?" });
    if (await closeConfirm.isVisible().catch(() => false)) await closeConfirm.getByRole("button", { name: "Close without copying" }).click();
    await ownerCtx.close();
    await page.goto(link);
    await page.getByLabel("Full name").fill("Vera Viewer");
    await page.getByRole("textbox", { name: "Password", exact: true }).fill(viewer.password);
    await page.getByRole("button", { name: "Create account and join" }).click();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 60_000 });
    if (VIEWER_FILE) await writeFile(VIEWER_FILE, JSON.stringify(viewer), { mode: 0o600 });
  }
  await page.goto(`/projects/${s.pid}/execution`);
  await expect(page.getByRole("heading", { level: 1, name: "Test Execution" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("table", { name: "Test runs" }).getByText(s.run)).toBeVisible();
  await expect(page.getByRole("button", { name: "Record manual results" })).toHaveCount(0);
  await expect(page.getByText(/You're recording/)).toHaveCount(0);
  await page.goto(`/projects/${s.pid}/execution?record=1`);
  await expect(page.getByRole("heading", { level: 1, name: "Test Execution" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  for (const [url, name] of [
    [`/projects/${s.pid}/test-cases/TC-0042`, "Record a manual result…"],
    [`/projects/${s.pid}/automation`, "Record manual results"],
    [`/projects/${s.pid}/traceability?view=coverage`, "Record manual results"],
    [`/projects/${s.pid}`, "Record manual results"],
  ]) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 60_000 });
    // The project stream keeps the network busy, so give the page's data a moment instead of waiting for idle.
    await page.waitForTimeout(3_000);
    await expect(page.getByRole("link", { name }), url).toHaveCount(0);
    await expect(page.getByRole("button", { name }), url).toHaveCount(0);
  }
  // A recording run (the member's D37 run) read-only; its record page redirects.
  const recording = ((await O.get(`/projects/${s.pid}/execution-runs?limit=50`)).recording ?? []) as string[];
  if (recording.length) {
    await page.goto(`/projects/${s.pid}/execution/${recording[0]}/record`);
    await expect(page).toHaveURL(new RegExp(`/execution/${recording[0]}$`), { timeout: 60_000 });
    await expect(page.getByRole("heading", { level: 1, name: `${recording[0]} · Manual` })).toBeVisible();
    await expect(page.getByRole("link", { name: /Continue recording/ })).toHaveCount(0);
  }
  await page.goto(`/projects/${s.pid}/execution/${s.run}/results/${s.run}-03`);
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(`${s.run}-03`) })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/^By hand · Recorded by Morgan Member/).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Raise defect/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Edit in/ })).toHaveCount(0);
  await page.goto(`/projects/${s.pid}/discovery/changes/CHG-0001?tab=regression`);
  const section = page.getByRole("region", { name: /^Manual re-tests/ });
  await expect(section).toContainText("Latest:", { timeout: 60_000 });
  await expect(section.getByRole("button")).toHaveCount(0);
  await expect(section.getByRole("link", { name: /Record re-tests with files|Raise defect/ })).toHaveCount(0);
  // Viewers' writes are refused by the server too.
  const v = await apiFor(page.request, viewer!);
  await v.call("POST", `/projects/${s.pid}/execution-runs`, { mode: "manual", case_keys: ["TC-0042"] }, [403]);
  await ctx.close();
});
