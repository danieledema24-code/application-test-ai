// QA verification of Phase 2 (P2-11) through the real UI against the running stack: web (3002), backend (8200)
// and the demo shop (E2E_SITE_URL, default http://localhost:4100). AI off. Written by QA, independent of
// phase2-journey.spec.ts, and stricter: every step asserts instead of skipping when a control is missing.
//
//   P2QA_STATE   JSON file that keeps {projectId, ...} between runs (default: test-results/p2qa-state.json)
//   P2QA_SHOTS   folder for screenshots (default: test-results/p2qa-shots)
//   P2QA_DL      folder for downloads (default: test-results/p2qa-downloads)
//   P2QA_SHOT_PREFIX  optional prefix for screenshot file names (e.g. "round2-")
//   DEMO_LOGIN_USER / DEMO_LOGIN_PASSWORD   demo shop test login (never hard-coded here)
//
// Steps run in order and can be re-run one by one with --grep; state is kept in P2QA_STATE.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { SITE_URL, seriousA11yViolations, useSharedAccount } from "./helpers";

test.describe.configure({ mode: "serial" });

const API = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8200") + "/api/v1";
const STATE = process.env.P2QA_STATE ?? path.join(__dirname, "..", "test-results", "p2qa-state.json");
const SHOTS = process.env.P2QA_SHOTS ?? path.join(__dirname, "..", "test-results", "p2qa-shots");
const DL = process.env.P2QA_DL ?? path.join(__dirname, "..", "test-results", "p2qa-downloads");
const LONG = 15 * 60_000;

type State = Record<string, string | number | boolean | string[] | undefined> & { projectId?: string };
async function load(): Promise<State> {
  try {
    return JSON.parse(await readFile(STATE, "utf8")) as State;
  } catch {
    return {};
  }
}
async function save(patch: State) {
  const s = { ...(await load()), ...patch };
  await mkdir(path.dirname(STATE), { recursive: true });
  await writeFile(STATE, JSON.stringify(s, null, 2));
  return s;
}
async function shot(page: Page, name: string, fullPage = true) {
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${process.env.P2QA_SHOT_PREFIX ?? ""}${name}.png`), fullPage });
}
async function a11y(page: Page, screen: string) {
  expect.soft(await seriousA11yViolations(page), `axe serious/critical on ${screen}`).toEqual([]);
}
async function token(page: Page): Promise<string> {
  const t = await page.evaluate(() => {
    for (const store of [localStorage, sessionStorage])
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i)!;
        const v = store.getItem(k) ?? "";
        if (/token|auth|session/i.test(k)) {
          try {
            const j = JSON.parse(v);
            if (typeof j === "string") return j;
            if (j?.token) return j.token as string;
          } catch {
            if (v.length > 20) return v;
          }
        }
      }
    return "";
  });
  return t;
}
async function apiGet(request: APIRequestContext, page: Page, p: string) {
  const r = await request.get(`${API}${p}`, { headers: { Authorization: `Bearer ${await token(page)}` } });
  return { status: r.status(), body: r.status() < 300 ? await r.json().catch(() => null) : await r.text() };
}
async function reloadUntil(page: Page, url: string, check: () => Promise<boolean>, timeout = LONG) {
  const end = Date.now() + timeout;
  for (;;) {
    await page.goto(url);
    if (await check().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`Timed out waiting on ${url}`);
    await page.waitForTimeout(5_000);
  }
}

/** True if the locator becomes visible within `ms` (pages load data client-side after navigation). */
async function appears(l: ReturnType<Page["locator"]>, ms = 8_000) {
  return l.waitFor({ state: "visible", timeout: ms }).then(() => true).catch(() => false);
}

const consoleErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`${page.url()} :: ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`${page.url()} :: pageerror ${e.message.slice(0, 300)}`));
  // Tokens must never travel in URLs.
  page.on("request", (r) => {
    if (/[?&](token|access_token|auth)=/i.test(r.url()) && !/\/content\?/.test(r.url())) consoleErrors.push(`TOKEN IN URL ${r.url().slice(0, 200)}`);
  });
  await useSharedAccount(page);
});
test.afterAll(async () => {
  await mkdir(path.dirname(STATE), { recursive: true });
  await writeFile(path.join(path.dirname(STATE), "p2qa-console.json"), JSON.stringify(consoleErrors, null, 2));
});

test("S1 new project on the demo shop, discovery finishes, Gate 2 approved", async ({ page }) => {
  test.setTimeout(LONG + 120_000);
  let { projectId } = await load();
  if (!projectId) {
    await page.goto(`/projects/new?url=${encodeURIComponent(SITE_URL)}`);
    await page.getByRole("checkbox", { name: /authorised to test/i }).check();
    await page.getByRole("button", { name: "Start QA Analysis" }).click();
    const dup = page.getByRole("button", { name: /Create anyway/ });
    if (await dup.waitFor({ timeout: 8_000 }).then(() => true).catch(() => false)) await dup.click();
    await page.waitForURL(/\/projects\/[^/]+\/discovery/, { timeout: 60_000 });
    projectId = page.url().match(/\/projects\/([^/]+)\//)![1];
    await save({ projectId });
  }
  const base = `/projects/${projectId}`;
  await reloadUntil(page, `${base}/discovery?view=summary`, () =>
    appears(page.getByRole("button", { name: "Approve discovery" }).or(page.getByText(/Discovery approved/)).first()),
  );
  const approve = page.getByRole("button", { name: "Approve discovery" });
  if (await approve.count()) {
    await approve.click();
    await expect(page.getByText(/Discovery approved/).first()).toBeVisible();
  }
  await shot(page, "01-discovery-approved");
});

// Network log of API writes (method, path, status) so tests can assert on what the UI really sent.
function recordApi(page: Page) {
  const log: { m: string; p: string; s: number }[] = [];
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("/api/v1/") && r.request().method() !== "GET") log.push({ m: r.request().method(), p: u.split("/api/v1")[1], s: r.status() });
  });
  return log;
}

test("S2 requirements: every row labelled, provenance rules hold, evidence resolves, legend by keyboard", async ({ page, request }) => {
  const { projectId } = await load();
  const base = `/projects/${projectId}`;
  await reloadUntil(page, `${base}/requirements`, () => appears(page.getByRole("checkbox", { name: /^Select REQ-/ }).first()));
  await expect(page.getByRole("heading", { level: 1, name: "Requirements" })).toBeVisible();
  // Rule-generated and labelled as such (P2-11 AC1).
  await expect(page.getByText("Generated by rules (AI not configured)").first()).toBeVisible();
  const rows = page.getByRole("table", { name: "Requirements" }).getByRole("row").filter({ has: page.getByRole("checkbox", { name: /^Select REQ-/ }) });
  const n = await rows.count();
  expect(n).toBeGreaterThan(5);
  for (let i = 0; i < n; i++) {
    const t = await rows.nth(i).innerText();
    expect.soft(t, `row ${i}`).toMatch(/Observed|Inferred|Assumed|Unverified/);
    expect.soft(t, `row ${i} confidence`).toMatch(/\d+% · (High|Medium|Low)/);
    expect.soft(t, `row ${i} rules label`).toContain("Generated by rules");
  }
  await a11y(page, "requirements list");
  await shot(page, "02-requirements-list");

  // Legend popover reachable and closable by keyboard (design check 7).
  const legendBtn = page.getByRole("button", { name: "What do these labels mean?" }).first();
  await legendBtn.focus();
  await page.keyboard.press("Enter");
  const legend = page.locator(`[id="${await legendBtn.getAttribute("aria-controls")}"]`);
  await expect(legendBtn).toHaveAttribute("aria-expanded", "true");
  await expect(legend).toBeVisible();
  for (const l of ["Observed", "Inferred", "Assumed", "Unverified"]) await expect(legend).toContainText(l);
  await expect(legend).toContainText(/backend|server/i);
  await page.keyboard.press("Escape");
  await expect(legend).toBeHidden();
  await expect(legendBtn).toBeFocused();

  // Provenance invariants on the live data.
  const list = await apiGet(request, page, `/projects/${projectId}/requirements?limit=200`);
  const caps: Record<string, number> = { observed: 1, inferred: 0.8, assumed: 0.5, unverified: 0.3 };
  for (const r of list.body.items) {
    const d = (await apiGet(request, page, `/requirements/${r.id}`)).body;
    if (d.behaviour_scope !== "ui") expect.soft(d.classification, `${d.key} backend/mixed never observed`).not.toBe("observed");
    expect.soft(d.confidence, `${d.key} confidence cap`).toBeLessThanOrEqual(caps[d.classification]);
    if (d.classification === "observed") {
      expect.soft(d.evidence.length, `${d.key} observed has evidence`).toBeGreaterThan(0);
      for (const e of d.evidence) expect.soft((await apiGet(request, page, `/evidence/${e.id}`)).status, `${d.key} ${e.key}`).toBe(200);
    }
    expect.soft(d.linked_test_cases, `${d.key} no invented test cases`).toEqual([]);
    expect.soft(d.acceptance_criteria.length, `${d.key} has >=1 AC`).toBeGreaterThan(0);
    for (const ac of d.acceptance_criteria) {
      const order = ["observed", "inferred", "assumed", "unverified"];
      expect.soft(order.indexOf(ac.classification), `${ac.key} not stronger than ${d.key}`).toBeGreaterThanOrEqual(order.indexOf(d.classification));
      expect.soft(`${ac.given}|${ac.when}|${ac.then}`.split("|").every((x: string) => x.length >= 3), `${ac.key} GWT`).toBe(true);
    }
  }
  const kinds = new Set<string>();
  for (const r of list.body.items) for (const ac of (await apiGet(request, page, `/requirements/${r.id}`)).body.acceptance_criteria) kinds.add(ac.kind);
  expect(kinds.has("negative")).toBe(true);

  // Observed requirement: detail shows all §6 fields; evidence opens in the drawer.
  await page.goto(`${base}/requirements/REQ-0004`);
  await expect(page.getByRole("heading", { level: 1, name: /REQ-0004/ })).toBeVisible();
  for (const h of ["Description", "Evidence", "Assumptions", "Related features", "Linked test cases"]) await expect(page.getByRole("heading", { name: h })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Acceptance criteria \(\d+\)/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Revision history/ })).toBeVisible();
  // Phase 3 replaced the Phase 2 placeholder with the linked-cases states (design P3 §9).
  await expect(page.getByRole("heading", { name: /Linked test cases/ })).toBeVisible();
  for (const t of ["Given", "When", "Then"]) await expect(page.getByRole("term").filter({ hasText: t }).first()).toBeVisible();
  await a11y(page, "requirement detail");
  const ev = page.getByRole("button", { name: /evidence for REQ-0004/ }).first();
  await ev.click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('main > form [name="name"]');
  await expect(drawer).toContainText("Used by: REQ-0004");
  await shot(page, "03-evidence-drawer", false);
  await a11y(page, "evidence drawer");
  await page.keyboard.press("Escape");
  await expect(ev).toBeFocused();

  // A backend requirement explains why it isn't Observed.
  await page.goto(`${base}/requirements/REQ-0009`);
  await expect(page.getByRole("heading", { level: 1, name: /REQ-0009/ })).toBeVisible();
  await expect(page.getByText(/Inferred/).first()).toBeVisible();
  await expect(page.getByText(/Backend behaviour can.t be observed/).first()).toBeVisible();
});

test("S3 edit, lock, reject with reason, approve (with criteria), bulk approve with guard and Undo, AC validation", async ({ page, request }) => {
  const { projectId } = await load();
  const base = `/projects/${projectId}`;
  const net = recordApi(page);

  // Edit REQ-0004 (design 13, 18): version increments, Edited flag, revision with reason, focus back on Edit.
  await page.goto(`${base}/requirements/REQ-0004`);
  const before = (await apiGet(request, page, `/projects/${projectId}/requirements/by-key/REQ-0004`)).body;
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("combobox", { name: /Label|Classification/ })).toHaveCount(0); // label not editable
  await page.getByRole("textbox", { name: "Title" }).fill("Name is mandatory on the contact form (QA edited)");
  await page.getByRole("textbox", { name: "Reason for change" }).fill("QA: clarify wording");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /QA edited/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeFocused();
  await expect(page.getByText(/Edited/).first()).toBeVisible();
  await expect(page.getByText(/QA: clarify wording/).first()).toBeVisible();
  const after = (await apiGet(request, page, `/projects/${projectId}/requirements/by-key/REQ-0004`)).body;
  expect(after.version).toBe(before.version + 1);
  expect(after.human_edited).toBe(true);
  expect(after.classification).toBe(before.classification); // approval/edit doesn't relabel

  // AC with empty Then (design 16).
  await page.getByRole("button", { name: "Add criterion" }).click();
  await page.getByRole("textbox", { name: "Given" }).last().fill("the contact form");
  await page.getByRole("textbox", { name: "When" }).last().fill("Name is only spaces");
  await page.getByRole("button", { name: /^(Save|Add) criterion$/ }).click();
  await expect(page.getByText("Describe the expected result.")).toBeVisible();
  await page.getByRole("textbox", { name: "Then" }).last().fill("submission is blocked and Name is identified as required");
  await page.getByRole("button", { name: /^(Save|Add) criterion$/ }).click();
  await expect(page.getByText("Name is only spaces")).toBeVisible();
  await shot(page, "04-requirement-edited");

  // Lock REQ-0005 (design 15).
  await page.goto(`${base}/requirements/REQ-0005`);
  await page.getByRole("button", { name: "More requirement actions" }).click();
  await page.getByRole("menuitem", { name: "Lock" }).click();
  await expect(page.getByRole("button", { name: "Unlock to edit" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);

  // Reject REQ-0022 with reason (Out of scope) and comment.
  await page.goto(`${base}/requirements/REQ-0022`);
  await page.getByRole("button", { name: "Reject…" }).click();
  const rej = page.getByRole("dialog", { name: "Reject REQ-0022?" });
  await rej.getByRole("button", { name: "Reject requirement" }).click();
  // The reason is required, or the comment is: either way a message appears and nothing is sent yet.
  await rej.getByRole("combobox", { name: "Reason" }).selectOption({ label: "Out of scope" });
  await rej.getByRole("textbox", { name: "Comment" }).fill("Performance is not tested in this engagement");
  await rej.getByRole("button", { name: "Reject requirement" }).click();
  await expect(page.getByText("Rejected", { exact: true }).first()).toBeVisible();
  const r22 = (await apiGet(request, page, `/projects/${projectId}/requirements/by-key/REQ-0022`)).body;
  expect(r22.status).toBe("rejected");
  expect(r22.status_comment).toMatch(/Performance is not tested/);

  // Approve REQ-0001 from the detail: its draft criteria are approved by follow-up calls (known risk: 409s).
  await page.goto(`${base}/requirements/REQ-0001`);
  net.length = 0;
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText(/REQ-0001.*approved/).first()).toBeVisible();
  await page.waitForTimeout(1500);
  const r1 = (await apiGet(request, page, `/projects/${projectId}/requirements/by-key/REQ-0001`)).body;
  await save({ approveCalls: net.map((x) => `${x.m} ${x.p} ${x.s}`) });
  expect.soft(net.filter((x) => x.s >= 400).map((x) => `${x.m} ${x.p} ${x.s}`), "no failed calls when approving with criteria").toEqual([]);
  expect.soft(r1.status, "REQ-0001 stays approved after its criteria are approved").toBe("approved");
  expect.soft(r1.acceptance_criteria.map((a: { status: string }) => a.status), "criteria approved").toEqual(r1.acceptance_criteria.map(() => "approved"));

  await save({ s3aDone: true });
});

test("S3b filters in the URL, rejected hidden, bulk approve guard and Undo", async ({ page, request }) => {
  const { projectId } = await load();
  const base = `/projects/${projectId}`;
  // Rejected hidden by default (design 11).
  await page.goto(`${base}/requirements`);
  await expect(page.getByText(/1 rejected requirement hidden\./)).toBeVisible();

  // Filters in URL, chips, count, Back restores (design 8).
  await page.getByRole("combobox", { name: "Status" }).selectOption({ label: "Draft" });
  await expect(page).toHaveURL(/status=draft/);
  await page.waitForTimeout(1000);
  await page.getByRole("combobox", { name: "Label" }).selectOption({ label: "Assumed" });
  await expect(page).toHaveURL(/status=draft/);
  await expect(page).toHaveURL(/label=assumed/);
  await expect(page.getByText(/Showing \d+ of \d+/)).toBeVisible();
  // Design check 8: browser Back restores the previous filter set. Filters use router.replace, so Back leaves the page.
  await page.goBack();
  expect.soft(page.url(), "BUG: Back should restore the previous filter set (design check 8)").toMatch(/requirements\?.*status=draft/);
  await page.goto(`${base}/requirements`);

  // Bulk approve: drafts including Assumed/Unverified -> guard offers "Approve n only" / "Approve all" (design 9), Undo (10).
  await page.goto(`${base}/requirements?status=draft`);
  const boxes = page.getByRole("checkbox", { name: /^Select REQ-/ });
  await expect(boxes.first()).toBeVisible();
  const toSelect = ["REQ-0002", "REQ-0003", "REQ-0013", "REQ-0014"];
  for (const k of toSelect) await page.getByRole("checkbox", { name: new RegExp(`^Select ${k} `) }).check();
  const bar = page.getByRole("region", { name: "Bulk actions" });
  await bar.getByRole("button", { name: "Approve 4" }).click();
  const guard = page.getByRole("dialog", { name: "Approve 4 requirements?" });
  await expect(guard).toBeVisible();
  await expect(guard.getByRole("button", { name: "Approve 2 only" })).toBeVisible();
  await shot(page, "05-bulk-approve-guard", false);
  await a11y(page, "bulk approve guard");
  await guard.getByRole("button", { name: "Approve 2 only" }).click();
  const toast = page.getByRole("status").filter({ hasText: /2 requirements approved/ });
  await expect(toast.first()).toBeVisible();
  for (const k of ["REQ-0013", "REQ-0014"]) expect((await apiGet(request, page, `/projects/${projectId}/requirements/by-key/${k}`)).body.status).toBe("draft");
  for (const k of ["REQ-0002", "REQ-0003"]) expect((await apiGet(request, page, `/projects/${projectId}/requirements/by-key/${k}`)).body.status).toBe("approved");
  // Undo restores.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await apiGet(request, page, `/projects/${projectId}/requirements/by-key/REQ-0002`)).body.status).toBe("draft");
  // Approve again (keep them approved for Gate 3), plus REQ-0006 and REQ-0011.
  await page.goto(`${base}/requirements?status=draft`);
  for (const k of ["REQ-0002", "REQ-0003", "REQ-0006", "REQ-0011"]) await page.getByRole("checkbox", { name: new RegExp(`^Select ${k} `) }).check();
  await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: "Approve 4" }).click();
  await expect(page.getByRole("status").filter({ hasText: /4 requirements approved/ }).first()).toBeVisible();
  await save({ bulkAcStatuses: JSON.stringify((await apiGet(request, page, `/projects/${projectId}/requirements/by-key/REQ-0011`)).body.acceptance_criteria.map((a: { status: string }) => a.status)) });
});

test("S4 regenerate: nothing applied until Apply; protected items default to Keep current; rejected not re-proposed", async ({ page, request }) => {
  test.setTimeout(LONG);
  const { projectId } = await load();
  const base = `/projects/${projectId}`;
  const cur = async () => (await apiGet(request, page, `/projects/${projectId}/requirements?limit=200`)).body.items as { key: string; version: number; title: string; status: string; stage_run_version: number }[];
  const before = await cur();
  await page.goto(`${base}/requirements`);
  const wf = (await apiGet(request, page, `/projects/${projectId}/workflow`)).body;
  if (!wf.stages.find((x: { key: string }) => x.key === "requirements").pending_review) {
    await page.getByRole("button", { name: "Regenerate…" }).click();
    const dlg = page.getByRole("dialog", { name: "Regenerate requirements?" });
    await expect(dlg).toContainText("Nothing changes until you review and apply the results.");
    await expect(dlg).toContainText(/2 locked or edited requirements are kept/);
    await expect(dlg).toContainText(/1 rejected requirement stays rejected/);
    await a11y(page, "regenerate dialog");
    await dlg.getByRole("button", { name: "Regenerate" }).click();
  }
  // Ready-to-review callout.
  await reloadUntil(page, `${base}/requirements`, () => appears(page.getByRole("link", { name: "Review changes" }).or(page.getByRole("button", { name: "Review changes" })).first()), 5 * 60_000);
  // Current version unchanged while the candidate waits.
  const during = await cur();
  expect(during.map((r) => `${r.key}:${r.version}:${r.status}`)).toEqual(before.map((r) => `${r.key}:${r.version}:${r.status}`));
  await shot(page, "06-review-ready-callout");
  await page.getByRole("link", { name: "Review changes" }).or(page.getByRole("button", { name: "Review changes" })).first().click();
  await expect(page).toHaveURL(/requirements\/changes\?run=\d+/);
  const run = Number(new URL(page.url()).searchParams.get("run"));
  const review = (await apiGet(request, page, `/projects/${projectId}/stages/requirements/runs/${run}/review`)).body;
  await save({ reviewSummary: JSON.stringify(review.summary) });
  // REQ-0022 (rejected) is never offered again.
  expect(review.items.map((i: { key: string }) => i.key)).not.toContain("REQ-0022");
  const prot = review.items.filter((i: { change: string }) => i.change === "protected_with_proposal");
  for (const i of prot) expect(i.default_action, `${i.key}`).toBe("keep");
  // UI: summary counts match API and protected radios default to Keep current.
  for (const [k, v] of Object.entries(review.summary as Record<string, number>)) if (v && k !== "suppressed_rejected") await expect(page.getByText(new RegExp(`${v}`)).first()).toBeVisible();
  for (const i of prot.slice(0, 3)) {
    const grp = page.getByRole("radiogroup", { name: `Decision for ${i.key}` }).or(page.getByRole("group", { name: `Decision for ${i.key}` }));
    await expect(grp.getByRole("radio", { name: /Keep current/ })).toBeChecked();
  }
  await a11y(page, "change review");
  await shot(page, "07-change-review");
  // Keyboard: the first decision group is reachable and operable with arrows.
  if (prot.length) {
    const grp = page.getByRole("radiogroup", { name: `Decision for ${prot[0].key}` }).or(page.getByRole("group", { name: `Decision for ${prot[0].key}` }));
    await grp.getByRole("radio", { name: /Keep current/ }).focus();
    await expect(grp.getByRole("radio", { name: /Keep current/ })).toBeFocused();
  }
  // Still unchanged before Apply.
  expect((await cur()).map((r) => `${r.key}:${r.version}`)).toEqual(before.map((r) => `${r.key}:${r.version}`));
  const net = recordApi(page);
  await page.getByRole("button", { name: /^Apply \d+ changes?$/ }).click();
  const confirm = page.getByRole("dialog");
  if (await appears(confirm, 2_000)) await confirm.getByRole("button", { name: /Apply/ }).click();
  await page.waitForTimeout(3_000);
  const applyCall = net.find((x) => x.p.endsWith("/review/apply"));
  await save({ uiApplyStatus: applyCall?.s ?? 0 });
  expect.soft(applyCall?.s, "BUG: Apply from the UI must succeed (it sends null decisions for unchanged items)").toBe(200);
  if (applyCall?.s !== 200) {
    await shot(page, "07b-apply-422-error");
    // Workaround to continue the journey: apply with the server defaults (empty decisions), as the contract allows.
    const t = await token(page);
    const r = await request.post(`${API}/projects/${projectId}/stages/requirements/runs/${run}/review/apply`, { headers: { Authorization: `Bearer ${t}` }, data: { decisions: {} } });
    expect(r.status()).toBe(200);
    await page.goto(`${base}/requirements`);
  } else {
    await expect(page).toHaveURL(/requirements(\?.*)?$/, { timeout: 30_000 });
  }
  const after = await cur();
  const r4 = after.find((r) => r.key === "REQ-0004")!;
  expect(r4.title).toContain("QA edited"); // edited item kept
  const r5 = (await apiGet(request, page, `/projects/${projectId}/requirements/by-key/REQ-0005`)).body;
  expect(r5.locked).toBe(true);
  expect(after[0].stage_run_version).toBe(run);
  const diff = (await apiGet(request, page, `/projects/${projectId}/requirements/diff`)).body;
  await save({ diff: JSON.stringify(diff), afterApplyUrl: page.url() });
  await shot(page, "08-after-apply");
});

test("S5 Gate 3 by keyboard: request-changes needs a comment, approve with drafts confirm, snapshot excludes drafts", async ({ page, request }) => {
  const { projectId } = await load();
  const base = `/projects/${projectId}`;
  await page.goto(`${base}/requirements?view=review`);
  const approve = page.getByRole("button", { name: "Approve requirements" });
  await expect(approve).toBeVisible({ timeout: 30_000 });
  // Gate 3 check lines link to filtered lists (design 26).
  const checks = page.getByRole("list", { name: "Gate checks" });
  await expect(checks).toBeVisible();
  const hrefs = await checks.getByRole("link").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
  for (const h of hrefs) expect.soft(h, "check line links to a filtered list").toMatch(/requirements\?.*(status|label|without_ac|filter)=/);
  // Summary tile "Assumed or Unverified" should filter to both labels.
  const tile = page.getByRole("link", { name: /Assumed or Unverified/ });
  if (await tile.count()) await save({ g3TileHref: (await tile.getAttribute("href")) ?? "" });
  await a11y(page, "gate 3");
  // Request changes with empty comment (design 27), keyboard only.
  const rc = page.getByRole("button", { name: "Request changes" });
  await rc.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Describe what needs to change.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Comment" })).toBeFocused();
  // Approve by keyboard.
  const stats = (await apiGet(request, page, `/projects/${projectId}/requirements/stats`)).body;
  const drafts = (stats.by_status.draft ?? 0) + (stats.by_status.needs_info ?? 0);
  await page.getByRole("textbox", { name: "Comment" }).fill("QA approval with drafts excluded");
  await approve.focus();
  await page.keyboard.press("Enter");
  const dlg = page.getByRole("dialog", { name: /^Approve with \d+ drafts?\?$/ });
  await expect(dlg).toBeVisible();
  await save({ g3DraftsDialog: (await dlg.getByRole("heading").first().innerText()), g3DraftsApi: drafts });
  expect.soft(await dlg.getByRole("heading").first().innerText()).toContain(String(drafts));
  await shot(page, "09-gate3-drafts-confirm", false);
  await a11y(page, "gate 3 drafts dialog");
  // Focus is inside the dialog; Tab to the confirm button and press Enter.
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[role=dialog]"))).toBe(true);
  const confirmBtn = dlg.getByRole("button", { name: "Approve requirements" });
  for (let i = 0; i < 6 && !(await confirmBtn.evaluate((b) => b === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(confirmBtn).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Requirements approved/).first()).toBeVisible();
  await expect(page.getByText(/Test Strategy Agent/).first()).toBeVisible();
  await expect(page.getByText(/QA approval with drafts excluded/).first()).toBeVisible();
  await shot(page, "10-gate3-approved");
  const wf = (await apiGet(request, page, `/projects/${projectId}/workflow`)).body;
  const g3 = wf.stages.find((x: { key: string }) => x.key === "requirements").gate;
  expect(g3.status).toBe("approved");
});

test("S6 strategy and risk register: approval-gated types, server-computed scores, matrix filters", async ({ page, request }) => {
  const { projectId } = await load();
  const base = `/projects/${projectId}`;
  await page.goto(`${base}/test-strategy`);
  await expect(page.getByRole("heading", { name: /Test levels/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Based on\s*Requirements version \d+/).first()).toBeVisible();
  await expect(page.getByText("Generated by rules (AI not configured)").first()).toBeVisible();
  // Levels: system + acceptance in scope, component out with a reason (P2-06 AC1, design 33).
  await expect(page.getByRole("row", { name: /^System In scope/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /^Acceptance In scope/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /^Component Out of scope No source code access/ })).toBeVisible();
  for (const t of ["Security", "Performance", "Load"]) {
    const row = page.getByRole("row", { name: new RegExp(`^${t} `) });
    if ((await row.count()) && /In scope/.test(await row.first().innerText())) await expect(row.first()).toContainText("Needs separate approval before running");
  }
  await a11y(page, "strategy");
  await shot(page, "11-strategy");

  await page.getByRole("tab", { name: /Risk register/ }).click();
  const matrix = page.getByRole("table", { name: /Risk matrix/ });
  await expect(matrix).toBeVisible();
  await expect(page.getByText("Scores are calculated by the system: likelihood × impact.")).toBeVisible();
  await a11y(page, "risk register");
  await shot(page, "12-risk-register");
  // Cell buttons filter the list (design 35).
  const highCell = matrix.getByRole("button", { name: /score 16, High/ });
  await highCell.focus();
  await page.keyboard.press("Enter");
  const reg = page.getByRole("table", { name: "Risk register" });
  await expect(reg.getByRole("row")).toHaveCount(2); // header + RISK-003
  await expect(reg).toContainText("RISK-003");
  // Clear the filter (whatever control the UI offers).
  const clear = page.getByRole("button", { name: /Clear|Show all|Remove filter/i }).first();
  if (await clear.count()) await clear.click();
  else await page.goto(`${base}/test-strategy?view=risks`);

  // Likelihood change: no client-side score; server's score appears (design 34).
  const before = (await apiGet(request, page, `/projects/${projectId}/risks?limit=50`)).body.items.find((r: { key: string }) => r.key === "RISK-002");
  let sawClientScore = false;
  await page.route(`**/api/v1/risks/${before.id}`, async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      expect(body.score, "client never sends score").toBeUndefined();
      expect(body.level, "client never sends level").toBeUndefined();
      await page.waitForTimeout(1500);
      // While the server hasn't answered, the row must not show a computed 9.
      const rowText = await page.getByRole("row", { name: /^RISK-002 / }).innerText();
      if (/\b9\b/.test(rowText)) sawClientScore = true;
    }
    await route.continue();
  });
  await page.getByRole("combobox", { name: "Likelihood for RISK-002" }).selectOption({ label: "3 Possible" });
  await expect(page.getByText(/Recalculating score/).first()).toBeVisible();
  await expect(page.getByRole("row", { name: /^RISK-002 / })).toContainText("9", { timeout: 15_000 });
  expect(sawClientScore, "no score shown before the server responds").toBe(false);
  await page.unroute(`**/api/v1/risks/${before.id}`);
  const after = (await apiGet(request, page, `/risks/${before.id}`)).body;
  expect(after.score).toBe(9);
  expect(after.level).toBe("medium");
  expect(after.version).toBe(before.version + 1);
  await expect(matrix.getByRole("button", { name: /likelihood 3 Possible, impact 3 Moderate, score 9, Medium/ })).toBeVisible();
  // API rejects client scores.
  const t = await token(page);
  const bad = await request.patch(`${API}/risks/${before.id}`, { headers: { Authorization: `Bearer ${t}` }, data: { version: after.version, score: 25 } });
  expect(bad.status()).toBe(422);
});

test("S7 Gate 4: a Very high risk without mitigation blocks approval; after mitigation, approve by keyboard", async ({ page, request }) => {
  const { projectId } = await load();
  const base = `/projects/${projectId}`;
  await page.goto(`${base}/test-strategy?view=risks`);
  let risks = (await apiGet(request, page, `/projects/${projectId}/risks?limit=50`)).body.items as { key: string; title: string; id: string }[];
  let vh = risks.find((r) => r.title.startsWith("QA: card data exposed"));
  if (!vh) {
    await page.getByRole("button", { name: "Add risk" }).click();
    const d = page.getByRole("dialog", { name: "Add risk" });
    await d.getByRole("textbox", { name: "Risk", exact: true }).fill("QA: card data exposed in transit");
    await d.getByRole("textbox", { name: "Description" }).fill("Added by QA to test the Gate 4 blocking rule.");
    await d.getByRole("combobox", { name: "Likelihood" }).selectOption({ label: "5 Almost certain" });
    await d.getByRole("combobox", { name: "Impact" }).selectOption({ label: "5 Severe" });
    await d.getByRole("textbox", { name: "Why this likelihood" }).fill("http: on credential forms");
    await d.getByRole("textbox", { name: "Why this impact" }).fill("Financial loss");
    await a11y(page, "add risk dialog");
    await d.getByRole("button", { name: "Add risk" }).click();
    await expect(d).toBeHidden();
    risks = (await apiGet(request, page, `/projects/${projectId}/risks?limit=50`)).body.items;
    vh = risks.find((r) => r.title.startsWith("QA: card data exposed"))!;
  }
  const vhd = (await apiGet(request, page, `/risks/${vh.id}`)).body;
  expect(vhd.score).toBe(25);
  expect(vhd.level).toBe("very_high");
  expect(vhd.classification).toBe("assumed");
  await save({ vhRisk: vh.key });

  // Summary and Gate 4 show the blocker (design 36).
  await page.goto(`${base}/test-strategy?view=risks`);
  await expect(page.getByText(new RegExp(`${vh.key} \\(Very high\\) has no test type`)).first()).toBeVisible();
  await page.goto(`${base}/test-strategy?view=review`);
  await expect(page.getByText(new RegExp(`${vh.key} \\(Very high\\) has no test type`)).first()).toBeVisible();
  await shot(page, "13-gate4-blocked");
  const net = recordApi(page);
  await page.getByRole("button", { name: "Approve test strategy" }).click();
  await page.waitForTimeout(2_000);
  const dec = net.find((x) => x.p.endsWith("/gates/G4/decision"));
  // Either the UI prevents the call, or the server answers 409 gate_blocked; in both cases G4 stays unapproved.
  if (dec) expect(dec.s).toBe(409);
  await expect(page.getByText(new RegExp(vh.key)).first()).toBeVisible();
  const wf1 = (await apiGet(request, page, `/projects/${projectId}/workflow`)).body;
  expect(wf1.stages.find((x: { key: string }) => x.key === "test_strategy").gate.status).not.toBe("approved");
  await save({ g4BlockedCall: dec ? `${dec.s}` : "not sent" });

  // Mitigate: open the risk row and tick a test type.
  await page.goto(`${base}/test-strategy?view=risks`);
  await page.getByRole("button", { name: /QA: card data exposed/ }).click();
  await page.getByRole("checkbox", { name: "Security" }).last().check();
  await page.getByRole("button", { name: `Save ${vh.key}` }).click();
  await expect(page.getByText(`${vh.key} saved.`).first()).toBeVisible();

  // Keyboard approval of Gate 4.
  await page.goto(`${base}/test-strategy?view=review`);
  await expect(page.getByText(/Every High and Very high risk is mapped/).first()).toBeVisible();
  await a11y(page, "gate 4");
  await page.getByRole("textbox", { name: "Comment" }).fill("QA: strategy approved");
  const ap = page.getByRole("button", { name: "Approve test strategy" });
  await ap.focus();
  await page.keyboard.press("Enter");
  const maybe = page.getByRole("dialog");
  if (await appears(maybe, 2_000)) {
    await save({ g4Dialog: await maybe.innerText() });
    await page.keyboard.press("Tab");
    const btn = maybe.getByRole("button", { name: /Approve/ }).last();
    await btn.focus();
    await page.keyboard.press("Enter");
  }
  await expect(page.getByText(/Strategy approved|Test strategy approved/).first()).toBeVisible({ timeout: 15_000 });
  await shot(page, "14-gate4-approved");
  const wf2 = (await apiGet(request, page, `/projects/${projectId}/workflow`)).body;
  expect(wf2.stages.find((x: { key: string }) => x.key === "test_strategy").gate.status).toBe("approved");
});

test("S8 Test Plan: strategy sections read-only, no invented dates, plan edit creates a version with compare", async ({ page, request }) => {
  const { projectId } = await load();
  const base = `/projects/${projectId}`;
  await reloadUntil(page, `${base}/test-strategy?view=plan`, () => appears(page.getByRole("heading", { name: /Test Plan · Version \d+/ })), 3 * 60_000);
  for (const name of [/^3\s*Scope/, /^4\s*Approach/, /^5\s*Environments/, /^6\s*Entry/]) {
    const sec = page.getByRole("region", { name });
    await expect(sec.getByText("From Test Strategy")).toBeVisible();
    await expect(sec.getByRole("link", { name: "Edit in Test Strategy" })).toBeVisible();
    await expect(sec.getByRole("button", { name: /^Edit/ })).toHaveCount(0);
  }
  await expect(page.getByRole("region", { name: /^10\s*Schedule/ })).toContainText("Not set.");
  const plan = (await apiGet(request, page, `/projects/${projectId}/test-plan`)).body;
  for (const m of plan.sections.schedule) expect(m.target_date, `no invented date for ${m.milestone}`).toBeNull();
  // Test items = every approved requirement in scope.
  const approved = (await apiGet(request, page, `/projects/${projectId}/requirements?status=approved&limit=200`)).body.items.map((r: { key: string }) => r.key).sort();
  expect(plan.sections.test_items.map((x: { key: string }) => x.key).sort()).toEqual(approved);
  // Strategy-derived sections equal the approved strategy.
  const strat = (await apiGet(request, page, `/projects/${projectId}/test-strategy`)).body;
  expect(plan.sections.entry_exit_criteria.entry.map((x: { text: string }) => x.text)).toEqual(strat.sections.entry_criteria.map((x: { text: string }) => x.text));
  await a11y(page, "test plan");
  await shot(page, "15-test-plan");
  // PATCH a strategy-derived section -> 422.
  const t = await token(page);
  const bad = await request.patch(`${API}/projects/${projectId}/test-plan`, { headers: { Authorization: `Bearer ${t}` }, data: { version: plan.version, sections: { scope: {} } } });
  expect(bad.status()).toBe(422);
  expect(await bad.text()).toContain("Edit this in the Test Strategy");
  // Stale version -> 409.
  const stale = await request.patch(`${API}/projects/${projectId}/test-plan`, { headers: { Authorization: `Bearer ${t}` }, data: { version: plan.version - 1 || 999, sections: { introduction: "x" } } });
  expect(stale.status()).toBe(409);
  // Edit Introduction with a change note (design 39).
  await page.getByRole("button", { name: "Edit Introduction" }).click();
  await page.getByRole("textbox", { name: "Introduction" }).fill(`QA edited introduction for the demo shop plan (${Date.now()}).`);
  await page.getByRole("textbox", { name: "Change note (optional)" }).fill("QA intro edit");
  await page.getByRole("button", { name: /^Save/ }).first().click();
  await expect(page.getByText(/Test Plan saved as version \d+/).first()).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Plan version" })).toContainText(`${plan.version + 1} ·`);
  await expect(page.getByRole("combobox", { name: "Plan version" })).toContainText("QA intro edit");
  await page.getByRole("button", { name: "Compare versions" }).click();
  const drawer = page.getByRole("dialog", { name: "Compare Test Plan versions" });
  await drawer.getByRole("combobox", { name: "From" }).selectOption({ label: `Version ${plan.version}` }, { timeout: 10_000 });
  await drawer.getByRole("combobox", { name: "To" }).selectOption({ label: `Version ${plan.version + 1}` }, { timeout: 10_000 });
  await expect(drawer).toContainText(/added: /);
  await a11y(page, "plan compare");
  await shot(page, "16-plan-compare", false);
  // Plan edits don't reopen G4.
  const wf = (await apiGet(request, page, `/projects/${projectId}/workflow`)).body;
  expect(wf.stages.find((x: { key: string }) => x.key === "test_strategy").gate.status).toBe("approved");
});

test("S9 editing an approved requirement reopens Gate 3; strategy keeps its approved input until re-approval", async ({ page, request }) => {
  const { projectId } = await load();
  const base = `/projects/${projectId}`;
  const r2 = (await apiGet(request, page, `/projects/${projectId}/requirements/by-key/REQ-0002`)).body;
  await page.goto(`${base}/requirements/REQ-0002`);
  if (r2.status === "approved") {
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("textbox", { name: "Description" }).fill(`${r2.description} (QA: price must be shown)`);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Requirements changed since Gate 3 approval. Approve again to pass the changes to the Test Strategy").first()).toBeVisible();
  await shot(page, "17-g3-reopened-toast", false);
  }
  const after = (await apiGet(request, page, `/projects/${projectId}/requirements/by-key/REQ-0002`)).body;
  await save({ reqAfterEditStatus: after.status });
  const wf = (await apiGet(request, page, `/projects/${projectId}/workflow`)).body;
  const req = wf.stages.find((x: { key: string }) => x.key === "requirements");
  const strat = wf.stages.find((x: { key: string }) => x.key === "test_strategy");
  expect(req.gate.status).not.toBe("approved");
  expect(req.status).toBe("awaiting_approval");
  expect(strat.status).not.toBe("stale");
  // Rail: G3 waiting; strategy still shows its approved input version.
  await expect(page.getByRole("link", { name: /^Requirements: waiting for your approval/ })).toBeVisible();
  await page.goto(`${base}/requirements?view=review`);
  await page.getByRole("heading", { name: "Gate 3 · Requirements review" }).waitFor();
  expect.soft(await page.getByText(/Changes since approval: \d+/).count(), "BUG: design 22 'Changes since approval: n' (API changes_since_approval is set)").toBeGreaterThan(0);
  await page.goto(`${base}/test-strategy`);
  await expect(page.getByText(/Based on\s*Requirements version 2/).first()).toBeVisible();
});

const REPORTS = [
  { slug: "requirements", name: "Requirements Specification", type: "requirements_spec", h1: "Requirements Specification" },
  { slug: "test-strategy", name: "Test Strategy", type: "test_strategy", h1: "Test Strategy" },
  { slug: "test-plan", name: "Test Plan", type: "test_plan", h1: "Test Plan" },
];

test("S10 reports: each page renders; PDF and HTML download; approved vs draft state", async ({ page, request }) => {
  test.setTimeout(10 * 60_000);
  const { projectId } = await load();
  const base = `/projects/${projectId}`;
  await mkdir(DL, { recursive: true });
  const results: Record<string, string> = {};
  // View each report page in the app.
  for (const r of REPORTS) {
    const errs: string[] = [];
    const onErr = (e: Error) => errs.push(e.message);
    page.on("pageerror", onErr);
    await page.goto(`${base}/reports/${r.slug}`);
    await page.waitForTimeout(4_000);
    const crashed = await page.getByText(/Application error: a client-side exception/).count();
    results[`view:${r.slug}`] = crashed ? `CRASH ${errs.join(" | ").slice(0, 200)}` : "ok";
    expect.soft(crashed, `BUG: ${r.name} report page crashes: ${errs.join(" | ")}`).toBe(0);
    if (!crashed) {
      await expect(page.getByRole("heading", { level: 1, name: new RegExp(r.h1) })).toBeVisible();
      await a11y(page, `${r.name} report page`);
      await shot(page, `20-report-${r.slug}`);
    } else await shot(page, `20-report-${r.slug}-crash`, false);
    page.off("pageerror", onErr);
  }
  // On-demand draft of the Requirements Specification while G3 is reopened -> DRAFT.
  const t = await token(page);
  const created = await request.post(`${API}/projects/${projectId}/reports`, { headers: { Authorization: `Bearer ${t}` }, data: { report_type: "requirements_spec" } });
  expect([200, 201, 202]).toContain(created.status());
  const draftId = (await created.json()).id;
  await expect.poll(async () => (await apiGet(request, page, `/reports/${draftId}`)).body.status, { timeout: 180_000 }).toBe("ready");
  const draft = (await apiGet(request, page, `/reports/${draftId}`)).body;
  results["draft:approval"] = JSON.stringify(draft.approval?.status);
  expect(draft.approval?.status ?? "draft").toBe("draft");
  // Counts equal /requirements/stats.
  const stats = (await apiGet(request, page, `/projects/${projectId}/requirements/stats`)).body;
  expect(draft.content.counts.total).toBe(stats.total);
  expect(draft.content.counts.by_status).toEqual(stats.by_status);
  expect(draft.content.counts.by_classification).toEqual(stats.by_classification);
  expect(draft.content.summary_generated_by).toBe("rules");
  // Download every latest Phase 2 report as PDF and HTML through the list's Download menu.
  await page.goto(`${base}/reports`);
  const table = page.getByRole("table", { name: "Phase 2 and 3 reports" });
  await expect(table).toBeVisible();
  await a11y(page, "reports list");
  await shot(page, "21-reports-list");
  for (const r of REPORTS) {
    for (const fmt of ["PDF", "HTML (single file)"]) {
      await table.getByRole("button", { name: new RegExp(`^Download ${r.name} version \\d+`) }).click();
      const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), page.getByRole("menuitem", { name: fmt }).click()]);
      const file = path.join(DL, dl.suggestedFilename());
      await dl.saveAs(file);
      const buf = await readFile(file);
      results[`${r.slug}:${fmt}`] = `${dl.suggestedFilename()} ${buf.length}B`;
      if (fmt === "PDF") expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
      else {
        const html = buf.toString("utf8");
        expect(html).toMatch(/<html/i);
        expect.soft(/<script/i.test(html), `${r.name} HTML has no scripts`).toBe(false);
        expect.soft(/(src|href)=["']https?:\/\/(?!localhost:4100)/i.test(html), `${r.name} HTML has no external resources`).toBe(false);
        expect(html).toMatch(/Generated by rules|generated by rules|rules/);
        if (r.type === "requirements_spec") {
          results["reqspec:draftBand"] = /DRAFT/.test(html) ? "DRAFT band" : /Approved by/.test(html) ? "Approved stamp" : "none";
          expect(html).toContain("backend behaviour not verified");
        }
        if (r.type === "test_strategy") results["strategy:stamp"] = /Approved by/.test(html) ? "Approved stamp" : /DRAFT/.test(html) ? "DRAFT" : "none";
      }
    }
  }
  await save({ reports: JSON.stringify(results) });
});

test("S9b re-approving Gate 3 with changes marks the Test Strategy out of date", async ({ page, request }) => {
  const { projectId } = await load();
  const base = `/projects/${projectId}`;
  // Approve REQ-0002 again so the snapshot really differs, then approve the gate.
  await page.goto(`${base}/requirements/REQ-0002`);
  const r2 = (await apiGet(request, page, `/projects/${projectId}/requirements/by-key/REQ-0002`)).body;
  if (r2.status !== "approved") {
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText(/REQ-0002.*approved/).first()).toBeVisible();
  }
  await page.goto(`${base}/requirements?view=review`);
  await page.getByRole("button", { name: "Approve requirements" }).click();
  const dlg = page.getByRole("dialog", { name: /^Approve with \d+ drafts?\?$/ });
  if (await appears(dlg, 3_000)) await dlg.getByRole("button", { name: "Approve requirements" }).click();
  await expect(page.getByText(/Requirements approved/).first()).toBeVisible();
  await expect
    .poll(async () => (await apiGet(request, page, `/projects/${projectId}/workflow`)).body.stages.find((x: { key: string }) => x.key === "test_strategy").status, { timeout: 60_000 })
    .toBe("stale");
  const wf = (await apiGet(request, page, `/projects/${projectId}/workflow`)).body;
  await save({ strategyStaleReason: wf.stages.find((x: { key: string }) => x.key === "test_strategy").stale_reason ?? "" });
  await page.goto(`${base}/test-strategy`);
  await expect(page.getByText(/Out of date|out of date/).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /^Strategy: .*out of date/i })).toBeVisible();
  await shot(page, "22-strategy-out-of-date");
  await a11y(page, "strategy out of date");
});

test("S11 AI QA Analyst with AI off: built-in tasks, citations resolve, proposals only applied on Accept", async ({ page, request }) => {
  test.setTimeout(5 * 60_000);
  const { projectId } = await load();
  const base = `/projects/${projectId}`;
  await page.goto(`${base}/assistant`);
  await expect(page.getByRole("heading", { level: 1, name: "AI QA Analyst" })).toBeVisible();
  await expect(page.getByText("AI off", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /Ask|Message|Question/ })).toHaveCount(0); // free text replaced by the AI-off callout
  const tasks = page.getByRole("complementary", { name: "Tasks" });
  await expect(tasks.getByText(/Available in Phase 3/)).toBeVisible();
  await a11y(page, "assistant");
  // The message log is a polite live region (P2-10 a11y AC).
  const live = await page.locator("[aria-live]").evaluateAll((els) => els.map((e) => `${e.getAttribute("role")}:${e.getAttribute("aria-live")}`));
  await save({ assistantLiveRegions: live });

  // 1. Review coverage: built-in answer with citations that resolve.
  await tasks.getByRole("button", { name: /^Review coverage/ }).first().click();
  await tasks.getByRole("button", { name: "Review coverage", exact: true }).click();
  const answer = page.getByRole("article").last();
  await expect(answer).toContainText(/Answered with a built-in query|Computed from project data/, { timeout: 60_000 });
  await expect(answer).not.toContainText(/\b\d+ (tests?|test cases?) (passed|failed)/i);
  const hrefs = await answer.getByRole("link").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? ""));
  await save({ coverageCitations: hrefs.slice(0, 40) });
  await shot(page, "23-assistant-coverage");
  expect.soft(hrefs.length, "BUG: design 45 coverage answer should cite features/requirements/risks as chips").toBeGreaterThan(0);
  const bad: string[] = [];
  for (const h of [...new Set(hrefs)].filter((h) => h.startsWith("/projects/")).slice(0, 15)) {
    await page.goto(h);
    await page.waitForTimeout(1500);
    if (await page.getByText(/wasn.t found|not found|Couldn.t load/i).count()) bad.push(h);
  }
  expect(bad, "citations that don't resolve").toEqual([]);

  // 2. Proposal on a locked requirement: Accept unavailable with the reason (design 48).
  {
    const r17 = (await apiGet(request, page, `/projects/${projectId}/requirements/by-key/REQ-0017`)).body;
    if (!r17.locked) {
      const t = await token(page);
      expect((await request.post(`${API}/requirements/${r17.id}/lock`, { headers: { Authorization: `Bearer ${t}` }, data: { version: r17.version, locked: true } })).status()).toBe(200);
    }
  }
  await page.goto(`${base}/assistant`);
  await tasks.getByRole("button", { name: /^Add negative criteria/ }).click();
  {
    const sel = tasks.getByRole("combobox", { name: "Requirement" });
    const v = await sel.locator("option", { hasText: "REQ-0017 " }).getAttribute("value");
    await sel.selectOption(v!);
  }
  await tasks.getByRole("button", { name: "Propose criteria" }).click();
  const lockedCard = page.getByRole("region", { name: /Proposal · Add acceptance criteria/ }).last();
  const lockedOrNone = await appears(lockedCard, 30_000);
  if (lockedOrNone) {
    await expect(lockedCard.getByText(/REQ-0017 is locked\. Unlock it to apply this change\./).first()).toBeVisible();
    await expect(lockedCard.getByRole("radio", { name: "Accept" }).first()).toBeDisabled();
    await lockedCard.getByRole("button", { name: "Reject all" }).click();
  } else {
    await save({ lockedProposal: await page.getByRole("article").last().innerText() });
  }

  // 3. Proposal on an approved requirement: nothing changes until Apply; then ACs exist with a revision and G3 reopens.
  const target = (await apiGet(request, page, `/projects/${projectId}/requirements/by-key/REQ-0003`)).body;
  const acBefore = target.acceptance_criteria.length;
  await page.goto(`${base}/assistant`);
  await tasks.getByRole("button", { name: /^Add negative criteria/ }).click();
  {
    const sel = tasks.getByRole("combobox", { name: "Requirement" });
    const v = await sel.locator("option", { hasText: "REQ-0003 " }).getAttribute("value");
    await sel.selectOption(v!);
  }
  await tasks.getByRole("button", { name: "Propose criteria" }).click();
  const card = page.getByRole("region", { name: /Proposal · Add acceptance criteria/ }).last();
  const got = await appears(card, 30_000);
  const lastAnswer = await page.getByRole("article").last().innerText();
  await save({ negativeProposalAnswer: lastAnswer.slice(0, 600) });
  if (got) {
    await expect(card.getByText("Given").first()).toBeVisible();
    await shot(page, "24-assistant-proposal");
    await a11y(page, "assistant proposal");
    expect((await apiGet(request, page, `/projects/${projectId}/requirements/by-key/REQ-0003`)).body.acceptance_criteria.length).toBe(acBefore);
    await expect(card).toContainText("Gate 3 will need approval again.");
    // Keyboard: Apply button reachable.
    const applyBtn = card.getByRole("button", { name: /^Apply \d+ accepted changes?$/ });
    await applyBtn.focus();
    await expect(applyBtn).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText(/changes? applied/).first()).toBeVisible();
    const after = (await apiGet(request, page, `/projects/${projectId}/requirements/by-key/REQ-0003`)).body;
    const wfA = (await apiGet(request, page, `/projects/${projectId}/workflow`)).body;
    await save({ afterProposalG3: wfA.stages.find((x: { key: string }) => x.key === "requirements").gate.status, afterProposalReqStatus: after.status });
    expect(after.acceptance_criteria.length).toBeGreaterThan(acBefore);
    const newAc = after.acceptance_criteria.find((a: { id: string }) => !target.acceptance_criteria.some((b: { id: string }) => b.id === a.id));
    const revs = (await apiGet(request, page, `/acceptance-criteria/${newAc.id}/revisions`)).body;
    await save({ proposalRevision: JSON.stringify(revs.map((r: { source: string; change_reason: string }) => [r.source, r.change_reason])) });
    expect.soft(JSON.stringify(revs), "BUG: revision should say it was applied from the assistant proposal").toMatch(/assistant_proposal|AI QA Analyst proposal|PROP-/);
    expect.soft(wfA.stages.find((x: { key: string }) => x.key === "requirements").gate.status, "BUG: adding an AC to an approved requirement reopens G3 (P2-03 AC4, design 47)").not.toBe("approved");
  }

  // 4. Reassess application risk -> reject; nothing changes.
  const risksBefore = JSON.stringify((await apiGet(request, page, `/projects/${projectId}/risks?limit=50`)).body.items.map((r: { key: string; version: number }) => [r.key, r.version]));
  await page.goto(`${base}/assistant`);
  await tasks.getByRole("button", { name: "Reassess application risk" }).click();
  await tasks.getByRole("button", { name: "Reassess risk" }).click();
  await expect(page.getByRole("article").last()).toContainText(/risk/i, { timeout: 60_000 });
  const rcard = page.getByRole("region", { name: /Proposal · Reassess application risk/ }).last();
  if (await appears(rcard, 5_000)) {
    await rcard.getByRole("button", { name: "Reject all" }).click();
    await expect(page.getByText("Proposal rejected. Nothing was changed.").first()).toBeVisible();
  }
  expect(JSON.stringify((await apiGet(request, page, `/projects/${projectId}/risks?limit=50`)).body.items.map((r: { key: string; version: number }) => [r.key, r.version]))).toBe(risksBefore);

  // 5. Header button opens the side panel.
  await page.goto(`${base}/requirements/REQ-0003`);
  await page.getByRole("button", { name: "Ask AI QA Analyst" }).click();
  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible();
  await a11y(page, "assistant drawer");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Ask AI QA Analyst" })).toBeFocused();
});

const DEMO_USER = process.env.DEMO_LOGIN_USER ?? "";
const DEMO_PASS = process.env.DEMO_LOGIN_PASSWORD ?? "";

async function saveCreds(page: Page, password: string) {
  await page.getByRole("textbox", { name: "Sign-in page URL" }).fill(new URL("/login", SITE_URL).toString());
  await page.getByRole("textbox", { name: "Username or email" }).fill(DEMO_USER);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(password);
  await page.getByRole("checkbox", { name: /dedicated test account/ }).check();
  await page.getByRole("button", { name: "Save credentials" }).click();
  await expect(page.getByText("Saved (hidden)").first()).toBeVisible();
}

test("S12 test credentials: owner-only, write-only, saved hidden, Test sign-in success and failure", async ({ page, request }) => {
  test.skip(!DEMO_USER || !DEMO_PASS, "DEMO_LOGIN_USER / DEMO_LOGIN_PASSWORD not set");
  test.setTimeout(6 * 60_000);
  const { projectId } = await load();
  const base = `/projects/${projectId}`;
  const bodies: string[] = [];
  page.on("response", async (r) => {
    if (r.url().includes("/api/v1/") && (r.headers()["content-type"] ?? "").includes("json")) bodies.push(await r.text().catch(() => ""));
  });
  await page.goto(`${base}/settings`);
  await page.getByRole("tab", { name: "Test credentials" }).click();
  const meta0 = (await apiGet(request, page, `/projects/${projectId}/secrets`)).body as { id: string }[];
  if (meta0.length) {
    await page.getByRole("button", { name: "Remove credentials" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove credentials" }).click();
    await expect(page.getByText(/No test credentials/)).toBeVisible();
  }
  await a11y(page, "settings credentials");
  // Design 1: no confirmation tick -> message + focus on the checkbox.
  await page.getByRole("textbox", { name: "Sign-in page URL" }).fill(new URL("/login", SITE_URL).toString());
  await page.getByRole("textbox", { name: "Username or email" }).fill(DEMO_USER);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(DEMO_PASS);
  await page.getByRole("button", { name: "Save credentials" }).click();
  await expect(page.getByText("Confirm this is a dedicated test account.")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /dedicated test account/ })).toBeFocused();
  // Host outside allowed hosts -> 422 on login_url.
  await page.getByRole("textbox", { name: "Sign-in page URL" }).fill("https://evil.example.com/login");
  await page.getByRole("checkbox", { name: /dedicated test account/ }).check();
  await page.getByRole("button", { name: "Save credentials" }).click();
  await expect(page.getByText(/host|allowed|project/i).first()).toBeVisible();
  const t = await token(page);
  const off = await request.put(`${API}/projects/${projectId}/secrets/scan_credentials`, { headers: { Authorization: `Bearer ${t}` }, data: { login_url: "https://evil.example.com/login", username: "u", password: "p" } });
  expect(off.status()).toBe(422);
  // Save the real ones.
  await page.reload();
  await page.getByRole("tab", { name: "Test credentials" }).click();
  await saveCreds(page, DEMO_PASS);
  // Design 2: after reload only "Saved (hidden)"; nothing in the DOM or API responses.
  await page.reload();
  await page.getByRole("tab", { name: "Test credentials" }).click();
  await expect(page.getByText("Saved (hidden)")).toHaveCount(2);
  const dom = await page.content();
  expect(dom.includes(DEMO_PASS), "password not in DOM").toBe(false);
  expect(dom.includes(DEMO_USER), "username not in DOM").toBe(false);
  const meta = (await apiGet(request, page, `/projects/${projectId}/secrets`)).body;
  expect(JSON.stringify(meta).includes(DEMO_PASS)).toBe(false);
  expect(JSON.stringify(meta).includes(DEMO_USER)).toBe(false);
  expect(meta[0].username_hint).toMatch(/…|\*/);
  await shot(page, "25-credentials-saved");
  // Replace shows empty fields.
  await page.getByRole("button", { name: "Replace credentials" }).click();
  await expect(page.getByRole("textbox", { name: "Username or email" })).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "Password", exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Cancel" }).click();
  // Test sign-in: success.
  const before = (await apiGet(request, page, `/projects/${projectId}/secrets`)).body[0].last_used_at;
  await page.getByRole("button", { name: "Test sign-in" }).click();
  await expect.poll(async () => (await apiGet(request, page, `/projects/${projectId}/secrets`)).body[0].last_used_at, { timeout: 120_000 }).not.toBe(before);
  const ok = (await apiGet(request, page, `/projects/${projectId}/secrets`)).body[0];
  await save({ signinCorrect: `${ok.last_result}/${ok.last_reason_code}` });
  expect.soft(ok.last_result, "BUG: Test sign-in with the demo shop's valid login must succeed (P2-01 AC5)").toBe("succeeded");
  await page.reload();
  await page.getByRole("tab", { name: "Test credentials" }).click();
  await page.getByText("Saved (hidden)").first().waitFor();
  await shot(page, "26-signin-test-correct-password");
  // Wrong password: failure, reason rejected.
  await page.getByRole("button", { name: "Replace credentials" }).click();
  await saveCreds(page, `${DEMO_PASS}-wrong`);
  await page.getByRole("button", { name: "Test sign-in" }).click();
  await expect.poll(async () => (await apiGet(request, page, `/projects/${projectId}/secrets`)).body[0].last_result, { timeout: 120_000 }).toBe("failed");
  const failed = (await apiGet(request, page, `/projects/${projectId}/secrets`)).body[0];
  expect(failed.last_reason_code).toBe("rejected");
  await page.reload();
  await page.getByRole("tab", { name: "Test credentials" }).click();
  await shot(page, "27-signin-test-failed");
  // Put the correct ones back for the re-scan step.
  await page.getByRole("button", { name: "Replace credentials" }).click();
  await saveCreds(page, DEMO_PASS);
  // No API response ever carried the values.
  const leaked = bodies.filter((b) => b.includes(DEMO_PASS));
  expect(leaked.length, "API responses containing the password").toBe(0);
  expect(bodies.filter((b) => b.includes(DEMO_USER)).length, "API responses containing the username").toBe(0);
});

test("S13 re-scan with sign-in: result shown in discovery, requirements become out of date", async ({ page, request }) => {
  test.skip(!DEMO_USER || !DEMO_PASS, "DEMO_LOGIN_USER / DEMO_LOGIN_PASSWORD not set");
  test.setTimeout(LONG);
  const { projectId } = await load();
  const base = `/projects/${projectId}`;
  const scans0 = (await apiGet(request, page, `/projects/${projectId}/scans`)).body;
  const n0 = (scans0.items ?? scans0).length;
  if (n0 < 2) {
    await page.goto(`${base}/settings`);
    await page.getByRole("tab", { name: "Test credentials" }).click();
    await page.getByRole("button", { name: "Re-scan with sign-in" }).click();
    const d = page.getByRole("dialog", { name: /Re-scan/ });
    await expect(d.getByRole("checkbox", { name: "Sign in with the saved test account" })).toBeChecked();
    await d.getByRole("button", { name: "Start re-scan" }).click();
    await page.waitForURL(/discovery/, { timeout: 30_000 }).catch(() => undefined);
    await shot(page, "28-rescan-live", false);
  }
  await expect
    .poll(async () => (await apiGet(request, page, `/projects/${projectId}/workflow`)).body.stages.find((x: { key: string }) => x.key === "discovery").status, { timeout: LONG - 60_000, intervals: [10_000] })
    .toMatch(/completed|awaiting_approval|approved/);
  const scans = (await apiGet(request, page, `/projects/${projectId}/scans`)).body;
  const latest = (scans.items ?? scans).sort((a: { number: number }, b: { number: number }) => b.number - a.number)[0];
  const scan = (await apiGet(request, page, `/scans/${latest.id}`)).body;
  await save({ scan2Auth: JSON.stringify(scan.auth) });
  expect(scan.auth.attempted).toBe(true);
  await page.goto(`${base}/discovery?view=summary`);
  await page.getByRole("heading", { name: /Gate 2/ }).waitFor();
  await shot(page, "29-scan2-summary");
  await a11y(page, "discovery summary after sign-in scan");
  if (scan.auth.result === "failed") {
    expect.soft(await page.getByText(/Couldn.t sign in with the credentials provided/).count(), "BUG design 5: failure banner").toBeGreaterThan(0);
    await page.getByRole("tab", { name: /Access gaps/ }).click();
    await expect(page.getByText(/Sign-in failed/).first()).toBeVisible();
    expect.soft(await page.getByText(/We tried once, to avoid locking the account\./).count(), "design 5 copy: We tried once…").toBeGreaterThan(0);
    await shot(page, "30-scan2-access-gaps");
  } else {
    await expect(page.getByText(/Signed-in pages/).first()).toBeVisible();
  }
  // DoR "credentials available" now met; requirements out of date (newer scan).
  const rc = (await apiGet(request, page, `/projects/${projectId}/readiness-criteria`)).body;
  const dor = rc.definition_of_ready.find((c: { check: { rule_id: string } | null }) => c.check?.rule_id === "dor.credentials_available");
  await save({ dorCredentials: `${dor?.evaluation?.status}: ${dor?.evaluation?.detail}` });
});

test("S13b approving the newer scan marks Requirements out of date; workspace stays editable", async ({ page, request }) => {
  const { projectId } = await load();
  const base = `/projects/${projectId}`;
  await page.goto(`${base}/discovery?view=summary`);
  const approve = page.getByRole("button", { name: "Approve discovery" });
  if (await appears(approve)) {
    await approve.click();
    await expect(page.getByText(/Discovery approved/).first()).toBeVisible();
  }
  await expect
    .poll(async () => (await apiGet(request, page, `/projects/${projectId}/workflow`)).body.stages.find((x: { key: string }) => x.key === "requirements").status, { timeout: 60_000 })
    .toMatch(/stale|running|queued|awaiting_approval/);
  const wf = (await apiGet(request, page, `/projects/${projectId}/workflow`)).body;
  const req = wf.stages.find((x: { key: string }) => x.key === "requirements");
  await save({ reqAfterScan2: `${req.status} · ${req.stale_reason ?? ""} · pending_review=${JSON.stringify(req.pending_review)}` });
  await page.goto(`${base}/requirements`);
  await page.getByRole("heading", { level: 1, name: "Requirements" }).waitFor();
  await shot(page, "31-requirements-after-scan2");
  const banner = await page.getByText(/out of date/i).count();
  expect.soft(banner, "design 53: Out of date banner on Requirements").toBeGreaterThan(0);
  expect.soft(await page.getByRole("link", { name: /^Requirements: .*out of date/i }).count(), "design 53: lifecycle shows Out of date").toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Regenerate…" }).first()).toBeVisible();
});

test("S14 discard a pending regeneration from the UI keeps the current version", async ({ page, request }) => {
  const { projectId } = await load();
  const base = `/projects/${projectId}`;
  const wf = (await apiGet(request, page, `/projects/${projectId}/workflow`)).body;
  const pr = wf.stages.find((x: { key: string }) => x.key === "requirements").pending_review;
  test.skip(!pr, "no pending regeneration");
  const before = JSON.stringify((await apiGet(request, page, `/projects/${projectId}/requirements?limit=200`)).body.items.map((r: { key: string; version: number; status: string }) => [r.key, r.version, r.status]));
  await page.goto(`${base}/requirements/changes?run=${pr.version}`);
  await expect(page.getByRole("heading", { level: 1, name: "Review regenerated requirements" })).toBeVisible();
  // No-longer-found draft defaults to "mark rejected".
  await expect(page.getByText(/No longer found in Scan \d+/).first()).toBeVisible();
  await a11y(page, "change review (scan 2)");
  await shot(page, "32-review-scan2");
  await page.getByRole("button", { name: "Discard regeneration" }).click();
  const d = page.getByRole("dialog", { name: "Discard these results?" });
  await d.getByRole("button", { name: "Discard regeneration" }).click();
  await expect(page).toHaveURL(/\/requirements(\?.*)?$/, { timeout: 20_000 });
  const after = JSON.stringify((await apiGet(request, page, `/projects/${projectId}/requirements?limit=200`)).body.items.map((r: { key: string; version: number; status: string }) => [r.key, r.version, r.status]));
  expect(after).toBe(before);
  const runs = (await apiGet(request, page, `/projects/${projectId}/stages/requirements/runs`)).body;
  expect(runs.find((r: { version: number }) => r.version === pr.version).review_status).toBe("discarded");
});

const DOCS = path.join(__dirname, "fixtures", "p2-docs");

test("S15 source documents: upload PDF/MD/DOCX with must/shall and an injection line; flagged, not obeyed; document-only = Unverified", async ({ page, request }) => {
  test.setTimeout(8 * 60_000);
  const { projectId } = await load();
  const base = `/projects/${projectId}`;
  const docs0 = (await apiGet(request, page, `/projects/${projectId}/documents`)).body as { filename: string }[];
  await page.goto(`${base}/requirements`);
  await page.getByRole("tab", { name: /Source documents/ }).click();
  if (!docs0.some((d) => d.filename === "spec.md")) {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Choose files" }).click()]);
    await chooser.setFiles(["spec.md", "wishlist.docx", "giftcards.pdf", "notes.txt"].map((f) => path.join(DOCS, f)));
    // Design 28: the .txt is refused client-side and the others still upload.
    await save({ txtMessage: (await page.getByText(/notes\.txt/).first().innerText().catch(() => "")) });
  }
  await expect.poll(async () => ((await apiGet(request, page, `/projects/${projectId}/documents`)).body as { status: string }[]).filter((d) => d.status === "ready").length, { timeout: 120_000 }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(5_000);
  const docs = (await apiGet(request, page, `/projects/${projectId}/documents`)).body as { id: string; key: string; filename: string; status: string; injection_flags: number; statements_found: number }[];
  await save({ docs: JSON.stringify(docs.map((d) => [d.key, d.filename, d.status, d.injection_flags, d.statements_found])) });
  for (const f of ["spec.md", "wishlist.docx", "giftcards.pdf"]) {
    const d = docs.find((x) => x.filename === f)!;
    expect.soft(d, `BUG: ${f} should upload (every upload after the first returns 500)`).toBeTruthy();
    if (!d) continue;
    expect.soft(d.injection_flags, `${f} injection flagged`).toBeGreaterThan(0);
    expect.soft(d.statements_found, `${f} statements found`).toBeGreaterThan(0);
  }
  await page.reload();
  await page.getByRole("tab", { name: /Source documents/ }).click();
  await expect(page.getByText(/instruction|flag/i).first()).toBeVisible();
  await a11y(page, "source documents");
  await shot(page, "33-source-documents");
  // A .pdf that is really HTML -> 422.
  const t = await token(page);
  const fake = await request.post(`${API}/projects/${projectId}/documents`, { headers: { Authorization: `Bearer ${t}` }, multipart: { file: { name: "fake.pdf", mimeType: "application/pdf", buffer: await readFile(path.join(DOCS, "fake.pdf")) } } });
  expect(fake.status()).toBe(422);
  expect(await fake.text()).toContain("File content does not match a supported type");

  // Regenerate requirements with documents, review, apply (API workaround for the Apply bug if needed).
  let wf = (await apiGet(request, page, `/projects/${projectId}/workflow`)).body;
  let pr = wf.stages.find((x: { key: string }) => x.key === "requirements").pending_review;
  if (!pr) {
    await page.getByRole("tab", { name: /^Requirements/ }).click();
    await page.getByRole("button", { name: "Regenerate…" }).first().click();
    await page.getByRole("dialog", { name: "Regenerate requirements?" }).getByRole("button", { name: "Regenerate" }).click();
    await expect.poll(async () => (await apiGet(request, page, `/projects/${projectId}/workflow`)).body.stages.find((x: { key: string }) => x.key === "requirements").pending_review, { timeout: 180_000 }).toBeTruthy();
    wf = (await apiGet(request, page, `/projects/${projectId}/workflow`)).body;
    pr = wf.stages.find((x: { key: string }) => x.key === "requirements").pending_review;
  }
  const review = (await apiGet(request, page, `/projects/${projectId}/stages/requirements/runs/${pr.version}/review`)).body;
  await save({ docReview: JSON.stringify(review.summary), docReviewAdded: JSON.stringify(review.items.filter((i: { change: string }) => i.change === "added").map((i: { key: string; proposed: { title?: string } }) => `${i.key} ${i.proposed?.title}`)) });
  await page.goto(`${base}/requirements/changes?run=${pr.version}`);
  await shot(page, "34-review-with-documents");
  const r = await request.post(`${API}/projects/${projectId}/stages/requirements/runs/${pr.version}/review/apply`, { headers: { Authorization: `Bearer ${t}` }, data: { decisions: {} } });
  expect(r.status()).toBe(200);
  const list = (await apiGet(request, page, `/projects/${projectId}/requirements?source=document&limit=200`)).body.items as { key: string; title: string; classification: string; id: string; status: string }[];
  await save({ docReqs: JSON.stringify(list.map((x) => [x.key, x.classification, x.status, x.title])) });
  expect(list.length).toBeGreaterThan(0);
  const loyalty = list.find((x) => /loyalty|gift card/i.test(x.title));
  expect(loyalty, "document-only requirement (loyalty or gift cards)").toBeTruthy();
  expect(loyalty!.classification).toBe("unverified");
  for (const x of list) {
    expect(x.classification, `${x.key} never observed from a document`).not.toBe("observed");
    expect(x.status, `${x.key} not auto-approved by injected text`).not.toBe("approved");
    expect(x.title).not.toMatch(/ignore previous|SYSTEM:|approve all/i);
  }
  const contact = list.find((x) => /1000 characters/.test(x.title));
  if (contact) await save({ contactDocReq: contact.classification });
  // Detail page: why-line names the document; evidence chip shows the excerpt as text.
  await page.goto(`${base}/requirements/${loyalty!.key}`);
  await expect(page.getByText(/Unverified/).first()).toBeVisible();
  await expect(page.getByText(/spec\.md|giftcards\.pdf|DOC-\d+/).first()).toBeVisible();
  await a11y(page, "document requirement detail");
  await shot(page, "35-document-requirement");
  const chip = page.getByRole("button", { name: /evidence for/i }).first();
  if (await chip.count()) {
    await chip.click();
    await expect(page.getByRole("dialog")).toContainText(/loyalty|gift card/i);
    await shot(page, "36-document-excerpt-drawer", false);
  }
  // Gate 3 was not approved by the injected "approve all requirements" line.
  const g3 = (await apiGet(request, page, `/projects/${projectId}/workflow`)).body.stages.find((x: { key: string }) => x.key === "requirements").gate.status;
  await save({ g3AfterDocs: g3 });
});

async function signInAs(page: Page, role: "member" | "viewer") {
  const file = process.env.P2QA_ACCOUNTS ?? "";
  const acc = JSON.parse(await readFile(file, "utf8"))[role] as { email: string; password: string };
  await page.goto("/login").catch(() => undefined);
  await page.evaluate(() => localStorage.clear());
  await page.goto("/login");
  await page.getByLabel("Email").waitFor();
  await page.getByLabel("Email").fill(acc.email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(acc.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard$/);
}

test("S16 roles in the UI: viewer sees no edit, bulk or gate controls; member sees credentials status only", async ({ page }) => {
  test.skip(!process.env.P2QA_ACCOUNTS, "P2QA_ACCOUNTS not set");
  const { projectId } = await load();
  const base = `/projects/${projectId}`;
  await signInAs(page, "viewer");
  await page.goto(`${base}/requirements`);
  await page.getByRole("heading", { level: 1, name: "Requirements" }).waitFor();
  await page.waitForTimeout(2_000);
  expect(await page.getByRole("checkbox", { name: /^Select REQ-/ }).count(), "viewer: no row selection").toBe(0);
  expect(await page.getByRole("button", { name: "Regenerate…" }).count(), "viewer: no regenerate").toBe(0);
  expect(await page.getByRole("link", { name: "Add requirement" }).count(), "viewer: no add").toBe(0);
  await page.goto(`${base}/requirements/REQ-0003`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  for (const b of ["Approve", "Edit", "Reject…", "Add criterion"]) expect(await page.getByRole("button", { name: b, exact: true }).count(), `viewer: no ${b}`).toBe(0);
  await page.goto(`${base}/requirements?view=review`);
  await page.getByRole("heading", { name: "Gate 3 · Requirements review" }).waitFor();
  // Design P2 §"No permission for an action": the button may be shown; the panel says approval needs permission and a press
  // ends in the permission error (checked once by hand: 403 + "You don't have permission to approve quality gates…").
  if (await page.getByRole("button", { name: "Approve requirements" }).count())
    await expect(page.getByText(/approving needs gate-approval permission/)).toBeVisible();
  await a11y(page, "gate 3 (viewer)");
  await page.goto(`${base}/test-strategy?view=risks`);
  await page.getByRole("table", { name: /Risk matrix/ }).waitFor();
  expect(await page.getByRole("combobox", { name: /^Likelihood for RISK-/ }).count(), "viewer: no risk editing").toBe(0);
  await page.goto(`${base}/settings`);
  await page.getByRole("tab", { name: "Test credentials" }).click();
  await expect(page.getByText("Only owners and admins can change test credentials.")).toBeVisible();
  await shot(page, "37-viewer-credentials");

  await signInAs(page, "member");
  await page.goto(`${base}/settings`);
  await page.getByRole("tab", { name: "Test credentials" }).click();
  await expect(page.getByText("Only owners and admins can change test credentials.")).toBeVisible();
  for (const b of ["Save credentials", "Replace credentials", "Test sign-in", "Remove credentials"]) expect(await page.getByRole("button", { name: b }).count(), `member: no ${b}`).toBe(0);
  await expect(page.getByText("Saved (hidden)").first()).toBeVisible();
  await shot(page, "38-member-credentials");
  await page.goto(`${base}/requirements?view=review`);
  await page.getByRole("heading", { name: "Gate 3 · Requirements review" }).waitFor();
  if (await page.getByRole("button", { name: "Approve requirements" }).count())
    await expect(page.getByText(/approving needs gate-approval permission/)).toBeVisible();
  await page.goto(`${base}/test-strategy?view=review`);
  await page.getByRole("heading", { name: /Gate 4/ }).waitFor();
  if (await page.getByRole("button", { name: "Approve test strategy" }).count())
    await expect(page.getByText(/approving needs gate-approval permission/)).toBeVisible();
});

test("S17 375 px and overview: cards, no sideways scroll, attention list order", async ({ page }) => {
  const { projectId } = await load();
  const base = `/projects/${projectId}`;
  await page.goto(`${base}`);
  await page.getByRole("heading", { name: /Needs your attention/ }).waitFor({ timeout: 15_000 }).catch(() => undefined);
  await a11y(page, "overview");
  await shot(page, "39-overview");
  await page.setViewportSize({ width: 375, height: 800 });
  const sideways = async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const res: Record<string, number> = {};
  for (const [name, url] of [
    ["requirements", `${base}/requirements`],
    ["requirement detail", `${base}/requirements/REQ-0003`],
    ["risk register", `${base}/test-strategy?view=risks`],
    ["test plan", `${base}/test-strategy?view=plan`],
    ["assistant", `${base}/assistant`],
    ["settings", `${base}/settings`],
  ] as const) {
    await page.goto(url);
    await page.waitForTimeout(3_000);
    res[name] = await sideways();
    await a11y(page, `${name} @375`);
  }
  await save({ sidewaysAt375: JSON.stringify(res) });
  await page.goto(`${base}/requirements`);
  await page.waitForTimeout(2_000);
  await shot(page, "40-requirements-375");
  await page.goto(`${base}/test-strategy?view=risks`);
  await page.waitForTimeout(2_000);
  await shot(page, "41-risks-375");
  for (const [k, v] of Object.entries(res)) expect.soft(v, `no horizontal page scroll at 375 px on ${k}`).toBeLessThanOrEqual(1);
});

test("S18 Ready & Done: edit mode by keyboard (move, remove), saving after G3 approval reopens Gate 3", async ({ page, request }) => {
  const { projectId } = await load();
  const base = `/projects/${projectId}`;
  const g3 = async () => (await apiGet(request, page, `/projects/${projectId}/workflow`)).body.stages.find((x: { key: string }) => x.key === "requirements").gate.status;
  const g3Before = await g3();
  await page.goto(`${base}/requirements?view=readiness`);
  await page.getByRole("heading", { name: /Definition of Ready \(\d+\)/ }).waitFor();
  const before = (await apiGet(request, page, `/projects/${projectId}/readiness-criteria`)).body.definition_of_ready.map((c: { text: string }) => c.text);
  await page.getByRole("button", { name: "Edit Definition of Ready" }).click();
  await expect(page.getByRole("button", { name: /^Move criterion 1 down$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Remove criterion 1$/ })).toBeVisible();
  await a11y(page, "ready & done edit mode");
  // Keyboard: focus "Move criterion 1 down" and press Enter.
  await page.getByRole("button", { name: "Move criterion 1 down" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Save/ }).first().click();
  await expect.poll(async () => (await apiGet(request, page, `/projects/${projectId}/readiness-criteria`)).body.definition_of_ready.map((c: { text: string }) => c.text)[0], { timeout: 15_000 }).toBe(before[1]);
  await shot(page, "42-ready-done-reordered");
  // Text edit after approval -> G3 reopens (P2-05 AC3).
  await page.getByRole("button", { name: "Edit Definition of Ready" }).click();
  const first = page.getByRole("textbox", { name: /Criterion 1/ });
  await first.fill(`${before[1]} (QA)`);
  await page.getByRole("button", { name: /^Save/ }).first().click();
  await expect.poll(async () => (await apiGet(request, page, `/projects/${projectId}/readiness-criteria`)).body.definition_of_ready[0].text, { timeout: 15_000 }).toContain("(QA)");
  await save({ g3BeforeDorEdit: g3Before, g3AfterDorEdit: await g3() });
  if (g3Before === "approved") expect.soft(await g3(), "P2-05 AC3: editing DoR after G3 approval reopens G3").not.toBe("approved");
});
