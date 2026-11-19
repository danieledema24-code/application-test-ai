// Phase 6 journey (P6-08, roadmap "Demo target chain", design P6 §14) against a running backend, web app and a demo
// shop whose release can be flipped through DEMO_VERSION_FILE, AI off:
//   1. the Phase 4 chain on release 1 (DEF-0001 "Contact form accepts an empty Message", major, confirmed at G8), then
//      REL-0001 recommends No-go naming DEF-0001
//   2. the shop flips to release 2, a rescan, CHG-0001 with the exact item set
//   3. impact: the outdated Contact scripts, the "Page removed" reviews, the gaps and the must-run list
//   4. the member accepts the Contact repairs one at a time in the UI, Gate 6 validates, the regression run is
//      requested and authorised at Gate 7 in the UI, it passes, DEF-0001 is fixed then verified, the must-run items close
//   5. EXP-0001 started from the UI: the /offers findings, POST /basket blocked, "Apply code" not tried, the shop's access
//      log shows only GET/HEAD while it ran; the grouped draft is confirmed at Gate 8 as minor in the UI
//   6. REL-0002 Conditional (every blocking criterion met; the conditions name the minor defect and the removed page),
//      Gate 9 approve in the UI; REL-0003 overridden in the UI with a reason of at least 20 characters
//   7. the Test Completion and Release Readiness reports downloaded as PDF, CSV and XLSX; the verdict equals the API
//   8. history: release 1 and release 2 compared again; DEF-0001's release-1 evidence still opens; nothing from an earlier
//      scan was deleted (scan_sessions, discovered_pages, evidence rows and storage files, before and after)
//   9. the assistant answers "What changed?" and "Can we release?" without AI
// The fixture-site Go verdict is the backend test test_p6_release.py::test_fixture_project_with_every_criterion_met_is_go.
//
// The setup (step 1 up to Gate 8) goes through the API: phase4-journey.spec.ts covers the same chain through the UI.
// Steps 2 to 9 use the UI wherever a person would act, and the API to check exact values.
//
// Never point this at the shared services: it flips the shop's release and writes to the database. Required:
//   E2E_API_URL        the backend, e.g. http://localhost:8230 (with ALLOW_PRIVATE_TARGETS=true, AI off)
//   E2E_SITE_URL       a private demo shop, e.g. http://localhost:4130/
//   DEMO_VERSION_FILE  the shop's DEMO_VERSION_FILE (this spec writes 1 or 2 into it, and leaves 1)
//   DEMO_ACCESS_LOG    the shop's DEMO_ACCESS_LOG (read only)
//   P6_DB              the backend's SQLite file (read only: the inventory)
//   P6_STORAGE_DIR     the backend's STORAGE_DIR (read only: the inventory)
// Optional: P6_STATE (a JSON file of ids, to resume after a failure). Accounts: the shared e2e account (an owner, who
// approves) and the e2e member (journey.signInMember); neither file is written by this spec.
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { SITE_URL, useSharedAccount, type Account } from "./helpers";
import { a11y, signInMember } from "./journey";

test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 60_000 });

const API_BASE = (process.env.E2E_API_URL ?? "http://localhost:8200").replace(/\/+$/, "");
const API = `${API_BASE}/api/v1`;
const VERSION_FILE = process.env.DEMO_VERSION_FILE ?? "";
const ACCESS_LOG = process.env.DEMO_ACCESS_LOG ?? "";
const DB = process.env.P6_DB ?? "";
const STORAGE = process.env.P6_STORAGE_DIR ?? "";
const STATE = process.env.P6_STATE ?? "";
const EXPECTED = "Submission is blocked and Message is identified as required";
const SHOP_DIR = path.join(__dirname, "..", "..", "demo-shop");
const BLOCKING = ["exit.no_open_high_defects", "rr.impacted_rerun", "rr.high_risk_tested", "rr.g8_pending"];
const OVERRIDE_REASON = "Release 2 ships for the demo; the open minor defect on /offers is cosmetic";
const CHANGE_STATEMENT =
  "Changes are detected by comparing what discovery saw in two scans. Content that discovery can't see (behind sign-in without credentials, inside canvases or iframes, or only after form submission) is not compared.";
const RELEASE_STATEMENT = /This recommendation is based on the tests the platform ran and the evidence recorded up to [^.]+\. It is advisory, it does not cover what wasn't tested, and the release decision belongs to the people who approve it\./;
const CHG_ITEMS = [
  "page_added|structural|/offers|Page added: /offers",
  "page_removed|structural|/products/1|Page removed: /products/1",
  "navigation_changed|behavioural||Navigation changed: 'Offers' added",
  "field_changed|structural|/contact|Field changed: Message → Your message (now required)",
  "field_added|structural|/contact|Field added: Order number",
  "element_renamed|behavioural|/contact|Button renamed: Send message → Send",
  "form_added|structural|/offers|Form added: Promo code",
  "journey_changed|behavioural|/|Journey changed: Contact the company",
  "element_removed|structural|/products|Link removed: Travel mug",
].sort();

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const s: Json = {}; // ids carried between the serial steps (and to P6_STATE)

async function save(extra: Json) {
  Object.assign(s, extra);
  if (STATE) await writeFile(STATE, JSON.stringify(s, null, 2));
}

// ---------------------------------------------------------------- API helpers

class Api {
  constructor(private req: APIRequestContext, private token: string) {}
  async call<T = Json>(method: string, p: string, body?: unknown, ok: number[] = [200, 201, 202]): Promise<T> {
    const r = await this.req.fetch(`${API}${p}`, { method, data: body, headers: { Authorization: `Bearer ${this.token}` } });
    const text = await r.text();
    expect(ok, `${method} ${p} → ${r.status()} ${text.slice(0, 400)}`).toContain(r.status());
    return (text ? JSON.parse(text) : {}) as T;
  }
  get<T = Json>(p: string) {
    return this.call<T>("GET", p);
  }
  post<T = Json>(p: string, body: unknown = {}, ok?: number[]) {
    return this.call<T>("POST", p, body, ok);
  }
}

async function apiFor(req: APIRequestContext, account: Account): Promise<Api> {
  const r = await req.post(`${API}/auth/login`, { data: { email: account.email, password: account.password } });
  expect(r.status(), "sign in through the API").toBe(200);
  return new Api(req, (await r.json()).token as string);
}

/** Polls `check` until it returns a value (not undefined/false) or the time runs out. */
async function until<T>(what: string, check: () => Promise<T | undefined | false>, timeout = 10 * 60_000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await check().catch(() => undefined);
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

async function stage(api: Api, key: string): Promise<Json> {
  const wf = await api.get(`/projects/${s.pid}/workflow`);
  return (wf.stages as Json[]).find((x) => x.key === key)!;
}

async function settled(api: Api, key: string, statuses = ["awaiting_approval", "approved", "completed"]) {
  return until(`${key} to finish`, async () => {
    const st = await stage(api, key);
    if (st.status === "failed") throw new Error(`${key} failed: ${JSON.stringify(st).slice(0, 400)}`);
    return statuses.includes(st.status) ? st : undefined;
  });
}

async function gate(api: Api, g: string, key: string) {
  const st = await settled(api, key);
  if (st.status === "approved" || st.gate?.status === "approved") return;
  await api.post(`/projects/${s.pid}/gates/${g}/decision`, { decision: "approve", comment: "ok", stage_run_version: st.current_version });
}

async function allCases(api: Api): Promise<Json[]> {
  const out: Json[] = [];
  let cursor = "";
  for (;;) {
    const page = await api.get(`/projects/${s.pid}/test-cases?limit=100${cursor ? `&cursor=${cursor}` : ""}`);
    out.push(...(page.items as Json[]));
    if (!page.next_cursor) return out;
    cursor = page.next_cursor;
  }
}

async function finishedRun(api: Api, runId: string): Promise<Json> {
  return until(`run ${runId}`, async () => {
    const run = await api.get(`/execution-runs/${runId}`);
    return ["passed", "failed", "error", "cancelled"].includes(run.status) ? run : undefined;
  }, 15 * 60_000);
}

async function runCases(member: Api, owner: Api, keys: string[]): Promise<Json> {
  const req = await member.post(`/projects/${s.pid}/execution-runs`, { selection: { case_keys: keys } });
  await owner.post(`/execution-runs/${req.id}/authorise`, { decision: "approve" });
  return finishedRun(owner, req.id);
}

async function assess(member: Api, owner: Api): Promise<Json> {
  const before = (await owner.get(`/projects/${s.pid}/release-readiness`)).latest?.key ?? null;
  await member.post(`/projects/${s.pid}/release-assessments`, {});
  return until("the release assessment", async () => {
    const body = await owner.get(`/projects/${s.pid}/release-readiness`);
    return !body.assessing && body.latest && body.latest.key !== before ? (body.latest as Json) : undefined;
  });
}

const crit = (a: Json): Record<string, Json> => Object.fromEntries((a.criteria as Json[]).map((c) => [c.id, c]));

/** The shop's test account, read from demo-shop/demo-login.mjs (never printed). */
async function demoLogin(): Promise<{ email: string; password: string }> {
  const src = await readFile(path.join(SHOP_DIR, "demo-login.mjs"), "utf8");
  return { email: src.match(/email:\s*"([^"]+)"/)![1], password: src.match(/password:\s*"([^"]+)"/)![1] };
}

async function setRelease(v: 1 | 2) {
  await writeFile(VERSION_FILE, `${v}\n`);
  const nav = await (await fetch(SITE_URL)).text();
  expect(nav.includes('href="/offers"'), `the shop serves release ${v}`).toBe(v === 2);
}

async function accessLines(): Promise<string[]> {
  return (await readFile(ACCESS_LOG, "utf8")).split("\n").filter(Boolean);
}

// ---------------------------------------------------------------- inventory (history is never deleted)

type Inventory = { scans: string[]; pages: string[]; evidence: string[]; purged: string[]; files: Record<string, number> };

async function filesUnder(dir: string, base = dir, out: Record<string, number> = {}): Promise<Record<string, number>> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await filesUnder(full, base, out);
    else out[path.relative(base, full)] = (await stat(full)).size;
  }
  return out;
}

async function inventory(): Promise<Inventory> {
  // node:sqlite (Node 22), read only. A string specifier keeps the web's @types/node 20 out of it.
  const mod = "node:sqlite";
  const { DatabaseSync } = await import(mod);
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    const ids = (sql: string) => (db.prepare(sql).all() as { id: string }[]).map((r) => String(r.id)).sort();
    return {
      scans: ids("select id from scan_sessions"),
      pages: ids("select id from discovered_pages"),
      evidence: ids("select id from evidence"),
      purged: ids("select id from evidence where purged_at is not null"),
      files: await filesUnder(STORAGE),
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- pages

async function memberPage(browser: Browser, owner: Page): Promise<{ page: Page; account: Account }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const account = await signInMember(page, owner, browser);
  return { page, account };
}

let owner: Account;
let member: Account;
let O: Api; // owner (approver)
let M: Api; // member (no gate approval)

test.beforeAll(async () => {
  for (const [name, v] of Object.entries({ E2E_API_URL: process.env.E2E_API_URL, DEMO_VERSION_FILE: VERSION_FILE, DEMO_ACCESS_LOG: ACCESS_LOG, P6_DB: DB, P6_STORAGE_DIR: STORAGE }))
    expect(v, `${name} must be set: this journey flips a private demo shop and reads a private database`).toBeTruthy();
  // Harness: no test uses the Postgres/Redis ports of other projects on this machine.
  for (const url of [API_BASE, SITE_URL, process.env.WEB_URL ?? "http://localhost:3002", `sqlite:${DB}`])
    expect(url, "never the instances on 5432/6379").not.toMatch(/:(5432|6379)\b/);
  const health = await (await fetch(`${API}/health`)).json();
  expect(health.ai.enabled, "AI off").toBe(false);
  expect(health.allow_private_targets).toBe(true);
  if (STATE) Object.assign(s, await readFile(STATE, "utf8").then((t) => JSON.parse(t) as Json).catch(() => ({})));
  // Resuming after the rescan: the shop must serve release 2 again (afterAll always leaves release 1).
  if (s.chg) await setRelease(2);
});

test.beforeEach(async ({ page, browser, request }) => {
  owner = await useSharedAccount(page);
  if (!member) {
    const m = await memberPage(browser, page);
    member = m.account;
    await m.page.context().close();
  }
  O = await apiFor(request, owner);
  M = await apiFor(request, member);
});

test.afterAll(async () => {
  // Harness: the demo is left on release 1, whatever happened.
  if (VERSION_FILE) {
    await writeFile(VERSION_FILE, "1\n");
    expect((await readFile(VERSION_FILE, "utf8")).trim()).toBe("1");
  }
});

test("1. Release 1: the Phase 4 chain to DEF-0001 at Gate 8, then REL-0001 recommends No-go naming DEF-0001", async ({ page }) => {
  test.setTimeout(60 * 60_000);
  if (!s.pid) {
    await setRelease(1);
    const p = await O.post(`/projects`, {
      url: SITE_URL, name: `Demo shop P6 ${Date.now()}`, start: true,
      authorisation: { attested: true, statement: "Private demo shop started for the Phase 6 journey." },
      scan: { max_pages: 30, max_depth: 3 },
    }, [201]);
    await save({ pid: p.id });
  }
  if (!s.def1) {
    await gate(O, "G2", "discovery");
    await settled(O, "requirements", ["awaiting_approval", "approved"]);
    const reqs = (await O.get(`/projects/${s.pid}/requirements?limit=100`)).items as Json[];
    const drafts = reqs.filter((x) => x.status === "draft").map((x) => x.id);
    if (drafts.length) await O.post(`/projects/${s.pid}/requirements/bulk-status`, { ids: drafts, status: "approved" });
    await gate(O, "G3", "requirements");
    await gate(O, "G4", "test_strategy");
    await settled(O, "test_design", ["awaiting_approval", "approved"]);
    let cases = await allCases(O);
    const empty = cases.find((x) => /empty Message/i.test(x.title))!;
    const d = await O.get(`/test-cases/${empty.id}`);
    if (d.expected_result !== EXPECTED) await O.call("PATCH", `/test-cases/${empty.id}`, { version: d.version, expected_result: EXPECTED });
    cases = await allCases(O);
    const draftCases = cases.filter((x) => x.status === "draft").map((x) => x.id);
    if (draftCases.length) await O.post(`/projects/${s.pid}/test-cases/bulk-status`, { ids: draftCases, status: "approved" });
    await gate(O, "G5", "test_design");
    await settled(O, "automation", ["approved", "completed"]);
    const run = await runCases(M, O, [empty.key]);
    const row = (run.tests_rows as Json[]).find((t) => t.case_key === empty.key)!;
    expect(row.status, "release 1 accepts an empty Message").toBe("failed");
    const res = await O.get(`/execution-results/${row.id}`);
    expect(res.defect.key).toBe("DEF-0001");
    await O.post(`/defects/${res.defect.id}/status`, { action: "confirm" });
    await save({ emptyKey: empty.key, emptyId: empty.id, def1: res.defect.id, run1: run.id });
  }
  const def1 = await O.get(`/defects/${s.def1}`);
  // (On a resumed run past release 2, DEF-0001 is already fixed and verified.)
  expect([def1.key, def1.severity, s.chg ? "confirmed" : def1.status]).toEqual(["DEF-0001", "major", "confirmed"]);

  if (!s.rel1) {
    const a1 = await assess(M, O);
    await save({ rel1: a1.id, rel1Key: a1.key, highRisk: [...new Set(String(crit(a1)["rr.high_risk_tested"].detail).match(/TC-\d{4}/g) ?? [])].sort() });
  }
  const a1 = await O.get(`/release-assessments/${s.rel1}`);
  expect([a1.key, a1.recommendation]).toEqual(["REL-0001", "no_go"]);
  const high = crit(a1)["exit.no_open_high_defects"];
  expect(high.status).toBe("not_met");
  expect(high.detail).toContain("DEF-0001");
  expect(a1.conditions_list[0].text).toBe("Fix or accept DEF-0001 (major)");

  // The workspace says the same.
  await page.goto(`/projects/${s.pid}/release-readiness/REL-0001`);
  const card = page.getByRole("region", { name: /^(Recommendation|Final verdict)$/ });
  await expect(card.getByText(/No-go/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/DEF-0001/).first()).toBeVisible();
  await expect(page.getByText(RELEASE_STATEMENT).first()).toBeVisible();
  await a11y(page, "release readiness (REL-0001)");
});

test("2. Release 2: the rescan gives CHG-0001 with the exact item set; earlier scans are inventoried first", async ({ page }) => {
  test.setTimeout(30 * 60_000);
  if (!s.chg) {
    await save({ before: await inventory() });
    await setRelease(2);
    const r = await M.post(`/projects/${s.pid}/rescans`, {}, [202]);
    expect(r.baseline.number).toBe(1);
    const chg = await until("CHG-0001", async () => {
      const sets = (await O.get(`/projects/${s.pid}/changes`)).items as Json[];
      return sets.find((x) => x.key === "CHG-0001" && x.status === "completed");
    });
    // The repairs and the outdated-script check follow the change set; wait for them before going on.
    await until("the change set's repair suggestions", async () => {
      const list = (await O.get(`/projects/${s.pid}/heal-suggestions?change_set=${chg.id}`)).items as Json[];
      return list.some((i) => i.kind === "locator") ? list : undefined;
    });
    await save({ chg: chg.id, scan1: r.baseline.id, scan2: r.scan.id });
  }
  const chg = await O.get(`/change-sets/${s.chg}`);
  expect([chg.key, chg.generated_by]).toEqual(["CHG-0001", "rules"]);
  const items = (await O.get(`/change-sets/${s.chg}/items`)).items as Json[];
  expect(items.map((i) => [i.kind, i.significance, i.page ?? "", i.subject].join("|")).sort()).toEqual(CHG_ITEMS);

  await page.goto(`/projects/${s.pid}/discovery/changes/CHG-0001`);
  await expect(page.getByRole("heading", { level: 1, name: /CHG-0001/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(CHANGE_STATEMENT).first()).toBeVisible();
  await expect(page.getByRole("row", { name: /^\/offers Added Structural/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /^\/products\/1 Removed Structural/ })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "Button renamed: Send message → Send" })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: /^Field changed: Message → Your message/ })).toBeVisible();
  await a11y(page, "change set CHG-0001");
});

test("3. Impact: the Contact scripts are outdated, the removed page needs review, /offers is a gap, the must-run list", async ({ page }) => {
  const view = await O.get(`/change-sets/${s.chg}/impact`);
  const items = view.items as Json[];
  // The Contact scripts were outdated by CHG-0001 (open until the repairs are accepted, then resolved).
  const outdated = items.filter((i) => i.target_kind === "automation_script" && i.page === "/contact");
  expect(outdated.map((i) => i.target?.key).join(" ")).toContain(s.emptyKey);
  expect(outdated.map((i) => i.reason).join(" ")).toContain("getByLabel('Message') not found after CHG-0001");
  // The removed product page: its cases are "Page removed: review" (its requirements are offered for regeneration).
  const removed = items.filter((i) => i.page === "/products/1" && i.target_kind === "test_case");
  expect(removed.length).toBeGreaterThan(0);
  expect(removed.every((i) => i.action === "review" && /^Page removed: \/products\/1\. Review or retire TC-\d+$/.test(i.reason))).toBe(true);
  expect(items.some((i) => i.level === "gap" && /\/offers/.test(`${i.page} ${i.reason}`))).toBe(true);
  const rec = await O.get(`/change-sets/${s.chg}/regression-recommendation`);
  const must = Object.fromEntries((rec.must as Json[]).map((x) => [x.key, x]));
  expect(Object.keys(must)).toContain(s.emptyKey);
  expect(must[s.emptyKey].reasons).toContain("Re-tests DEF-0001");

  await page.goto(`/projects/${s.pid}/discovery/changes/CHG-0001?tab=impact`);
  // The page counts the same impact items as the API (open ones are shown by default).
  await expect(page.getByText(new RegExp(`^Showing \\d+ of ${items.length} impact items$`))).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("region", { name: /^Requirements and tests \(\d+\)$/ })).toBeVisible();
  await a11y(page, "impact of CHG-0001");
});

test("4. Repairs one at a time (member, UI), Gate 6, the regression run through Gate 7 (UI) passes; DEF-0001 fixed and verified", async ({ page, browser }) => {
  test.setTimeout(40 * 60_000);
  if (!s.healed) {
    const listing = (await O.get(`/projects/${s.pid}/heal-suggestions?change_set=${s.chg}`)).items as Json[];
    const contact = listing
      .filter((i) => i.kind === "locator" && (i.used_by as Json[]).some((u) => String(u.path ?? "").startsWith("tests/contact/")))
      .sort((a, b) => a.key.localeCompare(b.key));
    expect(contact.length, "the Message field, the Send button and the form found by its button").toBeGreaterThanOrEqual(3);
    const { page: m } = await memberPage(browser, page);
    try {
      for (const sug of contact.filter((x) => x.status === "open")) {
        await m.goto(`/projects/${s.pid}/discovery/changes/CHG-0001?tab=repairs&heal=${sug.key}`);
        const card = m.getByRole("article", { name: new RegExp(`^${sug.key} `) });
        await expect(card).toBeVisible({ timeout: 60_000 });
        await expect(card.getByText(/High match/).first()).toBeVisible();
        // There is no bulk accept (D31): one suggestion, one confirmation.
        await expect(m.getByRole("button", { name: /accept all|accept selected/i })).toHaveCount(0);
        await card.getByRole("button", { name: /^Accept this replacement for / }).click();
        const dialog = m.getByRole("dialog", { name: `Accept ${sug.key}?` });
        await expect(dialog.getByText("Only this locator changes; the test's checks stay the same.", { exact: false })).toBeVisible();
        await dialog.getByRole("button", { name: "Accept replacement" }).click();
        await expect(m.getByText(new RegExp(`^${sug.key} accepted\\.`)).first()).toBeVisible({ timeout: 60_000 });
        await until(`${sug.key} to be accepted`, async () => (await O.get(`/heal-suggestions/${sug.id}`)).status === "accepted");
      }
      await a11y(m, "repairs (member)");
    } finally {
      await m.context().close();
    }
    // Gate 6 validates the repaired scripts: every Contact script's impact item is resolved. (The products script that
    // follows a link to the removed /products/1 stays outdated: that is a "Page removed" review, never a repair.)
    await until("the repaired Contact scripts to be valid", async () => {
      const scripts = ((await O.get(`/change-sets/${s.chg}/impact`)).items as Json[]).filter((i) => i.target_kind === "automation_script");
      const contactScripts = scripts.filter((i) => i.page === "/contact");
      return contactScripts.length > 0 && contactScripts.every((i) => i.status === "resolved");
    }, 15 * 60_000);
    const spec = await O.get(`/test-cases/${s.emptyId}`);
    expect(spec.expected_result, "expected results never change").toBe(EXPECTED);
    await save({ healed: contact.map((x) => x.key) });
  }

  if (!s.regRun) {
    await M.post(`/defects/${s.def1}/status`, { action: "fixed" });
    const reg = await M.post(`/change-sets/${s.chg}/regression-run`, { include_should: false }, [201]);
    await save({ regRun: reg.id, regKey: reg.key });
    // Gate 7 in the UI, by the approver.
    await page.goto(`/projects/${s.pid}/execution/${reg.key}`);
    const panel = page.getByRole("region", { name: `Gate 7 · Authorise ${reg.key}` });
    await expect(panel.getByText("Waiting for your authorisation")).toBeVisible({ timeout: 60_000 });
    await panel.getByRole("button", { name: /^Authorise and run \d+ tests?$/ }).click();
    await expect(page.getByText(new RegExp(`${reg.key} authorised|Authorised`)).first()).toBeVisible({ timeout: 30_000 });
  }
  const run = await finishedRun(O, s.regRun);
  const rows = Object.fromEntries((run.tests_rows as Json[]).map((t) => [t.case_key, t]));
  expect(rows[s.emptyKey]?.status, "release 2 requires the message, found through the repaired locator (D36)").toBe("passed");
  const def1 = await O.get(`/defects/${s.def1}`);
  if (def1.status === "fixed") await O.post(`/defects/${s.def1}/status`, { action: "verified" });
  expect((await O.get(`/defects/${s.def1}`)).status).toBe("verified");
  // The must-run items of the passed tests close by themselves.
  const view = await O.get(`/change-sets/${s.chg}/impact`);
  const reruns = (view.items as Json[]).filter((i) => i.action === "rerun" && i.target?.key === s.emptyKey);
  expect(reruns.length).toBeGreaterThan(0);
  expect(reruns.every((i) => i.status === "resolved"), JSON.stringify(reruns.map((i) => [i.target?.key, i.status]))).toBe(true);
});

test("5. EXP-0001 from the UI: /offers findings, POST /basket blocked, 'Apply code' not tried, GET only at the shop; Gate 8 as minor", async ({ page }) => {
  test.setTimeout(30 * 60_000);
  if (!s.exp) {
    const mark = (await accessLines()).length;
    await page.goto(`/projects/${s.pid}/execution?tab=exploratory`);
    await page.getByRole("button", { name: "Explore…" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Explore pages" });
    await expect(dialog.getByRole("radio", { name: /^New and changed pages from CHG-0001/ })).toBeChecked({ timeout: 30_000 });
    await expect(dialog.getByText("Never types, selects, uploads, submits forms or downloads files.")).toBeVisible();
    await dialog.getByRole("button", { name: "Start exploring" }).click();
    await expect(page).toHaveURL(/\/execution\/exploratory\/EXP-0001$/, { timeout: 60_000 });
    const listing = await O.get(`/projects/${s.pid}/exploratory-sessions`);
    const exp = (listing.items as Json[]).find((x) => x.key === "EXP-0001")!;
    const done = await until("EXP-0001", async () => {
      const q = await O.get(`/quality-scans/${exp.id}`);
      return ["completed", "partial", "failed", "cancelled"].includes(q.status) ? q : undefined;
    }, 25 * 60_000);
    expect(done.status).toBe("completed");
    const lines = (await accessLines()).slice(mark);
    await save({ exp: exp.id, expLines: lines });
  }
  // Harness: nothing but reading reached the shop while the session ran.
  const lines = s.expLines as string[];
  expect(lines.length).toBeGreaterThan(0);
  expect([...new Set(lines.map((l) => l.split(" ")[0]))].filter((m) => m !== "GET" && m !== "HEAD"), "non-GET at the shop during exploration").toEqual([]);
  expect(lines.some((l) => l.includes("/basket") || l.includes("/offers/apply"))).toBe(false);
  expect(lines.some((l) => l.startsWith("GET /offers "))).toBe(true);

  const sess = await O.get(`/quality-scans/${s.exp}`);
  expect((sess.blocked as Json[]).map((b) => b.request)).toContain("POST /basket");
  expect((sess.not_tried as Json[]).some((n) => n.element === 'Button "Apply code"' && n.page === "/offers")).toBe(true);
  const findings = (await O.get(`/quality-scans/${s.exp}/findings`)).items as Json[];
  const offers = findings.filter((f) => f.path === "/offers").map((f) => `${f.rule_id}|${f.severity}`);
  expect(offers).toEqual(expect.arrayContaining(["uncaught_exception|medium", "broken_text|medium"]));
  const draft = (sess.defects as Json[]).find((d) => /Show details/.test(d.summary))!;
  expect(draft.summary).toBe('/offers: "Show details" throws an error and shows NaN');

  await page.goto(`/projects/${s.pid}/execution/exploratory/EXP-0001`);
  await expect(page.getByRole("heading", { level: 1, name: "EXP-0001 · Exploratory session" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/^This session tried \d+ actions? on \d+ pages? within its budget\. Exploration is a sample, not a complete test, and it never submits forms or sends data\.$/).first()).toBeVisible();
  const view = page.getByRole("radio", { name: /^Not tried and blocked \(\d+\)$/ });
  await view.click();
  await expect(view).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("POST /basket").first()).toBeVisible();
  await expect(page.getByText(/Apply code/).first()).toBeVisible();
  await a11y(page, "exploratory session");

  // Gate 8: the grouped draft is confirmed as a minor defect.
  const d = await O.get(`/projects/${s.pid}/defects/by-key/${draft.key}`);
  if (d.status === "draft") {
    if (d.severity !== "minor")
      await M.call("PATCH", `/defects/${d.id}`, { version: d.version, severity: "minor", severity_reason: "Only the bundle details panel is affected; the price shown in the list is right." });
    await page.goto(`/projects/${s.pid}/defects?view=review`);
    const g8 = page.getByRole("region", { name: "Gate 8 · Defect review" });
    await g8.getByRole("button", { name: `Confirm ${d.key}` }).click({ timeout: 60_000 });
    await expect(page.getByText(`${d.key} confirmed.`).first()).toBeVisible({ timeout: 30_000 });
  }
  const confirmed = await O.get(`/defects/${d.id}`);
  expect([confirmed.status, confirmed.severity]).toEqual(["confirmed", "minor"]);
  await save({ expDefect: confirmed.id, expDefectKey: confirmed.key });
});

test("6. REL-0002 Conditional with every blocking criterion met; Gate 9 approve (UI); REL-0003 overridden with a reason (UI)", async ({ page }) => {
  test.setTimeout(40 * 60_000);
  if (!s.rel2) {
    // The very high risks REL-0001 named are tested signed in, with the shop's test account (never printed).
    const login = await demoLogin();
    await O.call("PUT", `/projects/${s.pid}/secrets/scan_credentials`, { login_url: `${SITE_URL.replace(/\/+$/, "")}/login`, username: login.email, password: login.password });
    expect((s.highRisk as string[]).length).toBeGreaterThan(0);
    const hr = await runCases(M, O, s.highRisk);
    expect((hr.tests_rows as Json[]).some((t) => t.status === "passed")).toBe(true);
    // D37: the manual must-run tests are re-tested by hand and recorded.
    const manual = await O.get(`/change-sets/${s.chg}/manual-retests`);
    for (const item of manual.items as Json[])
      if (!item.latest) await M.post(`/change-sets/${s.chg}/manual-retests`, { case_key: item.case_key, status: "passed", note: "Followed the steps on release 2: the expected result is shown" }, [201]);
    const a2 = await assess(M, O);
    await save({ rel2: a2.id });
  }
  const a2 = await O.get(`/release-assessments/${s.rel2}`);
  const c2 = crit(a2);
  expect([a2.key, a2.recommendation], JSON.stringify((a2.criteria as Json[]).filter((c) => c.status !== "met").map((c) => [c.id, c.status, c.detail]))).toEqual(["REL-0002", "conditional"]);
  expect(BLOCKING.filter((k) => c2[k].status !== "met")).toEqual([]);
  const conds = (a2.conditions_list as Json[]).map((c) => c.text).join("\n");
  expect(conds).toContain(s.expDefectKey);
  expect(conds).toContain("Page removed: /products/1");

  // Gate 9 in the UI: approve.
  if (a2.status === "awaiting_approval") {
    await page.goto(`/projects/${s.pid}/release-readiness`);
    const g9 = page.getByRole("region", { name: "Gate 9 · Release decision for REL-0002" });
    await expect(g9.getByText("Waiting for your decision")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(RELEASE_STATEMENT).first()).toBeVisible();
    await a11y(page, "Gate 9 (REL-0002)");
    await g9.getByRole("radio", { name: "Approve: Conditional becomes the final verdict" }).check();
    await g9.getByRole("button", { name: "Record decision for REL-0002" }).click();
    await page.getByRole("dialog", { name: "Approve REL-0002?" }).getByRole("button", { name: "Approve: Conditional" }).click();
    await expect(g9.getByText(/^Final verdict: Conditional · approved by /)).toBeVisible({ timeout: 30_000 });
  }
  const final2 = await O.get(`/release-assessments/${s.rel2}`);
  expect([final2.status, final2.final_verdict]).toEqual(["final", "conditional"]);

  // A second assessment, overridden in the UI with a written reason (D33).
  if (!s.rel3) await save({ rel3: (await assess(M, O)).id });
  const a3 = await O.get(`/release-assessments/${s.rel3}`);
  expect([a3.key, a3.recommendation]).toEqual(["REL-0003", "conditional"]);
  if (a3.status === "awaiting_approval") {
    await page.goto(`/projects/${s.pid}/release-readiness`);
    const g9 = page.getByRole("region", { name: "Gate 9 · Release decision for REL-0003" });
    await expect(g9.getByText("Waiting for your decision")).toBeVisible({ timeout: 60_000 });
    await g9.getByRole("radio", { name: "Override: choose a different final verdict" }).check();
    await g9.getByRole("group", { name: "Final verdict" }).getByRole("radio", { name: "Go", exact: true }).check();
    const reason = g9.getByRole("textbox", { name: "Reason (at least 20 characters)" });
    await reason.fill("Too short");
    await g9.getByRole("button", { name: "Record decision for REL-0003" }).click();
    await expect(g9.getByText("Write at least 20 characters. The reason is shown next to the verdict.")).toBeVisible();
    await reason.fill(OVERRIDE_REASON);
    await g9.getByRole("button", { name: "Record decision for REL-0003" }).click();
    await page.getByRole("dialog", { name: "Override the recommendation?" }).getByRole("button", { name: "Override to Go" }).click();
    await expect(page.getByText("REL-0003 overridden: Go is final.").first()).toBeVisible({ timeout: 30_000 });
  }
  const final3 = await O.get(`/release-assessments/${s.rel3}`);
  expect([final3.status, final3.final_verdict, final3.recommendation]).toEqual(["final", "go", "conditional"]);
  expect(JSON.stringify(final3)).toContain(OVERRIDE_REASON);
});

test("7. Test Completion and Release Readiness reports: PDF, CSV and XLSX; the verdict equals the API", async ({ page }) => {
  test.setTimeout(20 * 60_000);
  const a3 = await O.get(`/release-assessments/${s.rel3}`);
  // Release Readiness: the latest report follows the Gate 9 decision.
  const rr = await until("the Release Readiness Report after Gate 9", async () => {
    const reps = (await O.get<Json[]>(`/projects/${s.pid}/reports`)).filter((r) => r.report_type === "release_readiness" && r.run_key === "REL-0003" && r.status === "ready");
    const latest = reps.sort((a, b) => b.version - a.version)[0];
    if (!latest) return undefined;
    const d = await O.get(`/reports/${latest.id}`);
    return d.content.verdict_text === "Go · Final" ? d : undefined;
  });
  // The override and its reason are in the report (D33).
  expect(JSON.stringify(rr.content)).toContain(OVERRIDE_REASON);

  // Test Completion: generated from the UI for REL-0003.
  if (!s.completion) {
    await page.goto(`/projects/${s.pid}/reports/completion`);
    await page.getByRole("button", { name: "Generate…" }).first().click({ timeout: 60_000 });
    await page.getByRole("dialog").getByRole("button", { name: "Generate" }).click();
    const tc = await until("the Test Completion Report", async () => {
      const reps = (await O.get<Json[]>(`/projects/${s.pid}/reports`)).filter((r) => r.report_type === "completion" && r.status === "ready");
      return reps.sort((a, b) => b.version - a.version)[0];
    });
    await save({ completion: tc.id });
  }
  const tc = await O.get(`/reports/${s.completion}`);
  expect(tc.content.release.key).toBe(a3.key);
  const cov = await O.get(`/projects/${s.pid}/traceability/coverage?basis=approved`);
  expect([tc.content.measures.total.passed, tc.content.measures.total.failed]).toEqual([cov.execution.results.passed, cov.execution.results.failed]);
  expect(tc.content.exploratory.sessions[0].key).toBe("EXP-0001");

  for (const [url, verdict] of [
    [`/projects/${s.pid}/reports/release-readiness`, "Go · Final"],
    [`/projects/${s.pid}/reports/completion`, null],
  ] as const) {
    await page.goto(url);
    await expect(page.getByRole("button", { name: "Download PDF" })).toBeVisible({ timeout: 90_000 });
    if (verdict) await expect(page.getByRole("article").getByText(verdict).first()).toBeVisible();
    else await expect(page.getByText(tc.content.release.verdict_text).first()).toBeVisible();
    for (const [button, ext] of [["Download PDF", ".pdf"], ["Download CSV", ".csv"], ["Download XLSX", ".xlsx"]] as const) {
      const [file] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), page.getByRole("button", { name: button }).click()]);
      expect(file.suggestedFilename()).toMatch(new RegExp(`\\${ext}$`));
      const body = await readFile((await file.path())!);
      if (ext === ".pdf") expect(body.subarray(0, 5).toString()).toBe("%PDF-");
      if (ext === ".xlsx") expect(body.subarray(0, 2).toString()).toBe("PK");
      if (ext === ".csv") {
        expect(body.toString()).not.toMatch(/@example\.com/);
        if (verdict) expect(body.toString()).toContain(verdict);
      }
    }
    await a11y(page, `report ${url}`);
  }
});

test("8. History: release 1 and 2 compared again, DEF-0001's release-1 evidence opens, nothing from an earlier scan deleted", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  if (!s.compare) {
    const r = await M.post(`/projects/${s.pid}/changes`, { from_scan_id: s.scan1, to_scan_id: s.scan2 }, [200, 202]);
    await save({ compare: r.id ?? r.change_set?.id ?? true });
  }
  const sets = (await O.get(`/projects/${s.pid}/changes`)).items as Json[];
  expect(sets.filter((x) => x.status === "completed").length).toBeGreaterThanOrEqual(1);
  // The pair is listed (compared once; asking again returns the same set).
  const again = sets.find((x) => x.from_scan?.id === s.scan1 && x.to_scan?.id === s.scan2);
  expect(again, "release 1 vs release 2 resolves to a change set").toBeTruthy();
  expect(again!.key).toBe("CHG-0001");
  const items = (await O.get(`/change-sets/${again!.id}/items`)).items as Json[];
  expect(items.map((i) => [i.kind, i.significance, i.page ?? "", i.subject].join("|")).sort()).toEqual(CHG_ITEMS);

  // DEF-0001's evidence from release 1 still opens.
  const def1 = await O.get(`/defects/${s.def1}`);
  const urls = JSON.stringify(def1).match(/http[^"]+\/evidence\/[0-9a-f-]+\/content\?[^"]+/g) ?? [];
  expect(urls.length, "DEF-0001 has evidence").toBeGreaterThan(0);
  const shot = await fetch(String(urls[0]));
  expect(shot.status).toBe(200);
  await page.goto(`/projects/${s.pid}/defects/DEF-0001`);
  await expect(page.getByRole("heading", { level: 1, name: /DEF-0001/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("img").first()).toBeVisible();

  await page.goto(`/projects/${s.pid}/discovery?view=changes`);
  await expect(page.getByRole("region", { name: "Change sets" }).getByRole("row", { name: /CHG-0001/ })).toBeVisible({ timeout: 60_000 });

  // Harness: every scan, page, evidence row and stored file from before the rescan is still there.
  const before = s.before as Inventory;
  const after = await inventory();
  // Guard against a wrong P6_STORAGE_DIR: every evidence row taken before the rescan has a file there.
  expect(Object.keys(before.files).length, "storage dir holds the evidence files").toBeGreaterThanOrEqual(before.evidence.length);
  expect(before.scans.filter((x) => !after.scans.includes(x)), "scan_sessions deleted").toEqual([]);
  expect(before.pages.filter((x) => !after.pages.includes(x)), "discovered_pages deleted").toEqual([]);
  expect(before.evidence.filter((x) => !after.evidence.includes(x)), "evidence rows deleted").toEqual([]);
  expect(after.purged.filter((x) => before.evidence.includes(x)), "evidence files purged").toEqual([]);
  expect(Object.entries(before.files).filter(([f, size]) => after.files[f] !== size).map(([f]) => f), "storage files deleted or changed").toEqual([]);
  expect(after.scans.length).toBeGreaterThan(before.scans.length);
});

test("9. The assistant, AI off: 'What changed?' and 'Can we release?'", async ({ page }) => {
  await page.goto(`/projects/${s.pid}/assistant`);
  const tasks = page.getByRole("complementary", { name: "Tasks" });
  await tasks.getByRole("button", { name: /What changed\?/ }).click({ timeout: 60_000 });
  await tasks.getByRole("button", { name: "Check now" }).click();
  const changed = page.getByRole("article").filter({ hasText: /CHG-\d{4}/ }).last();
  await expect(changed).toBeVisible({ timeout: 60_000 });
  await expect(changed.getByText(/Changes are detected by comparing what discovery saw in two scans\./).first()).toBeVisible();

  await tasks.getByRole("button", { name: /Can we release\?/ }).click();
  await tasks.getByRole("button", { name: "Check now" }).click();
  const release = page.getByRole("article").filter({ hasText: "REL-0003" }).last();
  await expect(release).toBeVisible({ timeout: 60_000 });
  await expect(release.getByText(RELEASE_STATEMENT).first()).toBeVisible();
  await a11y(page, "assistant");
});

test("Harness: the demo is back on release 1", async () => {
  await setRelease(1);
  expect((await readFile(VERSION_FILE, "utf8")).trim()).toBe("1");
});
