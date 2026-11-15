// Phase 5 QA verification (independent QA, not a developer journey). Runs after phase5-journey.spec.ts and reads the
// ids it saved (P5QA_STATE). Accounts are made through real invitation links by the shared e2e owner and kept only
// in P5QA_ACCOUNTS (a *.local.txt file outside the repo; never printed).
//
//   Q0  accounts: viewer, admin, approver (member + can_approve) in the shared org; an owner in a second org.
//   Q1  cross-organisation 404 on every Phase 5 endpoint; viewer 403 on every Phase 5 mutation; member 403 on
//       owner/admin endpoints; admin 403 on permanent deletion.
//   Q2  load limits at save / request / approve (ceiling lowered after the request); single-use approval.
//   Q3  audit log: approvals say "host typed: yes" and never the typed text; export audited; emails in exports.
//   Q4  archive and scheduled deletion: what the UI promises vs. what is built.
//   Q5  settings pages for member/viewer (design check 34), Server status (39), axe/375 px on settings pages.
//
// Env: P5QA_STATE, P5QA_ACCOUNTS (both required), P5QA_SHOTS (optional screenshot dir).
import { readFile, writeFile } from "node:fs/promises";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { useSharedAccount } from "./helpers";
import { a11y, appears, noSideways, reloadUntil, signInMember } from "./journey";

test.describe.configure({ mode: "serial" });

const API = `${(process.env.E2E_API_URL ?? "http://localhost:8200").replace(/\/+$/, "")}/api/v1`;
const STATE = process.env.P5QA_STATE ?? "";
const ACCOUNTS = process.env.P5QA_ACCOUNTS ?? "";
const SHOTS = process.env.P5QA_SHOTS ?? "";
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Acc = { email: string; password: string; name: string };

let st: Json = {};
let acc: Record<string, Acc> = {};
const tokens: Record<string, string> = {};

async function loadState() {
  expect(STATE && ACCOUNTS, "P5QA_STATE and P5QA_ACCOUNTS are required").toBeTruthy();
  st = JSON.parse(await readFile(STATE, "utf8"));
  acc = JSON.parse(await readFile(ACCOUNTS, "utf8").catch(() => "{}"));
}

async function login(request: APIRequestContext, who: string): Promise<string> {
  if (tokens[who]) return tokens[who];
  const a = acc[who];
  const r = await request.post(`${API}/auth/login`, { data: { email: a.email, password: a.password } });
  expect(r.status(), `login ${who}`).toBe(200);
  tokens[who] = (await r.json()).token;
  return tokens[who];
}

async function call(request: APIRequestContext, tok: string, method: string, path: string, data?: unknown) {
  const r = await request.fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${tok}` }, data });
  let body: Json = {};
  try {
    body = await r.json();
  } catch {
    body = {};
  }
  return { status: r.status(), body, headers: r.headers(), text: JSON.stringify(body) };
}

test.beforeEach(async () => {
  await loadState();
});

test("Q0 accounts through real invitation links, plus a second organisation", async ({ page, request }) => {
  await useSharedAccount(page);
  const owner = await page.evaluate(() => window.localStorage.getItem("qa_token"));
  tokens.owner = owner!;
  for (const [key, role, ca, name] of [
    ["viewer", "viewer", false, "P5 Viewer"],
    ["admin", "admin", false, "P5 Admin"],
    ["approver", "member", true, "P5 Approver"],
  ] as const) {
    if (acc[key]) continue;
    const email = `p5qa-${key}-${Date.now()}@example.com`;
    const password = `p5qa-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const inv = await call(request, owner!, "POST", "/organisation/invitations", { email, role, can_approve: ca });
    expect(inv.status, `invite ${key}: ${inv.text}`).toBe(201);
    const tok = String(inv.body.link).split("/").pop();
    const ok = await request.post(`${API}/invitations/${tok}/accept`, { data: { full_name: name, password } });
    expect([200, 201]).toContain(ok.status());
    acc[key] = { email, password, name };
    await writeFile(ACCOUNTS, JSON.stringify(acc), { mode: 0o600 });
  }
  if (!acc.other) {
    const email = `p5qa-other-${Date.now()}@example.com`;
    const password = `p5qa-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const r = await request.post(`${API}/auth/register`, { data: { full_name: "Otto Other", email, password, organisation_name: "QA P5 Other Org" } });
    expect([200, 201], `register other org`).toContain(r.status());
    acc.other = { email, password, name: "Otto Other" };
    await writeFile(ACCOUNTS, JSON.stringify(acc), { mode: 0o600 });
  }
  for (const k of ["viewer", "admin", "approver", "other"]) await login(request, k);
});

test("Q1 cross-organisation 404 and role 403 on every Phase 5 endpoint", async ({ page, request }) => {
  await useSharedAccount(page);
  tokens.owner = (await page.evaluate(() => window.localStorage.getItem("qa_token")))!;
  const me = await call(request, tokens.owner, "GET", "/auth/me");
  const orgId = me.body.organisation?.id ?? me.body.organisations?.[0]?.id ?? me.body.membership?.organisation_id;
  expect(orgId, "org id from /auth/me").toBeTruthy();
  st.orgId = orgId;
  const pid = st.projectId;
  const run = await call(request, tokens.owner, "GET", `/performance-runs/${st.perfRunId}`);
  const approvalId = run.body.approval?.id;
  const def = await call(request, tokens.owner, "GET", `/projects/${pid}/defects/by-key/${st.confirmedDefect}`);
  const reports = await call(request, tokens.owner, "GET", `/projects/${pid}/reports`);
  const p5Report = (reports.body as Json[]).find((r) => ["performance", "accessibility", "security"].includes(r.report_type));

  const reads: [string, string][] = [
    ["GET", `/projects/${pid}/non-functional`],
    ["GET", `/projects/${pid}/accessibility-scans`],
    ["GET", `/projects/${pid}/security-assessments`],
    ["GET", `/quality-scans/${st.a11yScanId}`],
    ["GET", `/projects/${pid}/quality-scans/by-key/${st.a11yKey}`],
    ["GET", `/quality-scans/${st.a11yScanId}/findings`],
    ["GET", `/quality-findings/${st.a11yFindingId}`],
    ["GET", `/projects/${pid}/performance-profiles`],
    ["GET", `/projects/${pid}/performance-profiles/eligible-pages`],
    ["GET", `/projects/${pid}/performance-profiles/by-key/${st.prfKey}`],
    ["GET", `/performance-profiles/${st.prfId}`],
    ["GET", `/performance-profiles/${st.prfId}/k6-script`],
    ["GET", `/projects/${pid}/performance-runs`],
    ["GET", `/performance-runs/${st.perfRunId}`],
    ["GET", `/projects/${pid}/performance-runs/by-key/${st.perfKey}`],
    ["GET", `/performance-runs/${st.perfRunId}/k6-script`],
    ["GET", `/approvals/${approvalId}`],
    ["GET", `/projects/${pid}/traceability/chain?key=${st.perfKey}`],
    ["GET", `/reports/${p5Report?.id}`],
    ["GET", `/reports/${p5Report?.id}/download?format=xlsx`],
    ["GET", `/organisations/${orgId}/settings`],
    ["GET", `/organisations/${orgId}/audit-log`],
    ["GET", `/organisations/${orgId}/audit-log/export?format=csv`],
    ["GET", `/organisations/${orgId}/retention`],
  ];
  const writes: [string, string, unknown][] = [
    ["POST", `/projects/${pid}/accessibility-scans`, {}],
    ["POST", `/projects/${pid}/security-assessments`, {}],
    ["POST", `/quality-scans/${st.a11yScanId}/cancel`, {}],
    ["POST", `/quality-findings/${st.a11yFindingId}/triage`, { status: "false_positive", reason: "x" }],
    ["POST", `/quality-findings/${st.a11yFindingId}/raise-defect`, {}],
    ["POST", `/projects/${pid}/performance-profiles`, { type: "load" }],
    ["PATCH", `/performance-profiles/${st.prfId}`, { version: 1 }],
    ["POST", `/performance-profiles/${st.prfId}/ready`, {}],
    ["POST", `/performance-profiles/${st.prfId}/retire`, {}],
    ["POST", `/projects/${pid}/performance-runs`, { profile_id: st.prfId }],
    ["POST", `/performance-runs/${st.perfRunId}/stop`, {}],
    ["POST", `/performance-runs/${st.perfRunId}/withdraw`, {}],
    ["POST", `/approvals/${approvalId}/decision`, { decision: "approve", confirm_text: "localhost" }],
    ["POST", `/defects/${def.body.id}/status`, { action: "reject", reason: "accepted_risk", comment: "x" }],
    ["POST", `/projects/${pid}/reports`, { report_type: "security" }],
    ["PATCH", `/organisations/${orgId}/settings`, { load_ceiling: { vus: 20, rps: 20, duration_s: 300 } }],
    ["PUT", `/organisations/${orgId}/retention`, { videos_traces_days: 0, screenshots_days: 0, timeseries_days: 0 }],
    ["POST", `/organisations/${orgId}/retention/apply`, {}],
    ["POST", `/projects/${pid}/purge`, { confirm_name: "nope" }],
    ["DELETE", `/projects/${pid}/purge`, undefined],
    ["POST", `/projects/${pid}/archive`, {}],
    ["POST", `/projects/${pid}/unarchive`, {}],
  ];
  const problems: string[] = [];
  const other = await login(request, "other");
  for (const [m, path] of reads) {
    const r = await call(request, other, m, path);
    if (r.status !== 404) problems.push(`other org ${m} ${path} → ${r.status} (want 404)`);
  }
  for (const [m, path, data] of writes) {
    const r = await call(request, other, m, path, data);
    if (r.status !== 404) problems.push(`other org ${m} ${path} → ${r.status} (want 404)`);
  }
  // Viewer: reads allowed except owner/admin pages and the k6 script (design: members download it); writes 403.
  const viewer = await login(request, "viewer");
  const viewerReads: Json = {};
  for (const [m, path] of reads) viewerReads[`${m} ${path}`] = (await call(request, viewer, m, path)).status;
  console.log(`[p5qa] viewer reads: ${JSON.stringify(viewerReads)}`);
  for (const [k, v] of Object.entries(viewerReads)) {
    const adminOnly = /audit-log|retention/.test(k);
    const k6 = /k6-script/.test(k);
    if (adminOnly && v !== 403) problems.push(`viewer ${k} → ${v} (want 403)`);
    if (k6 && v !== 403) problems.push(`viewer ${k} → ${v} (design §2: viewers can't download the k6 script)`);
    if (!adminOnly && !k6 && v !== 200) problems.push(`viewer ${k} → ${v} (want 200)`);
  }
  for (const [m, path, data] of writes) {
    const r = await call(request, viewer, m, path, data);
    if (r.status !== 403) problems.push(`viewer ${m} ${path} → ${r.status} (want 403) ${r.text.slice(0, 120)}`);
  }
  // Member (no can_approve): owner/admin endpoints and approvals 403.
  const memberTok = (await (async () => {
    const raw = JSON.parse(await readFile(`${__dirname}/../playwright/.auth/e2e-member.json`, "utf8")) as Acc;
    acc.member = { ...raw, name: "Morgan Member" };
    return login(request, "member");
  })());
  for (const [m, path, data] of [
    ["GET", `/organisations/${orgId}/audit-log`, undefined],
    ["GET", `/organisations/${orgId}/retention`, undefined],
    ["PATCH", `/organisations/${orgId}/settings`, { load_ceiling: { vus: 20, rps: 20, duration_s: 300 } }],
    ["POST", `/projects/${pid}/archive`, {}],
    ["POST", `/projects/${pid}/purge`, { confirm_name: "x" }],
    ["POST", `/approvals/${approvalId}/decision`, { decision: "approve", confirm_text: "localhost" }],
    ["POST", `/defects/${def.body.id}/status`, { action: "reject", reason: "accepted_risk", comment: "x" }],
  ] as [string, string, unknown][]) {
    const r = await call(request, memberTok, m, path, data);
    if (r.status !== 403) problems.push(`member ${m} ${path} → ${r.status} (want 403) ${r.text.slice(0, 120)}`);
  }
  // Admin: purge 403 (owner only).
  const admin = await login(request, "admin");
  const ap = await call(request, admin, "POST", `/projects/${pid}/purge`, { confirm_name: "x" });
  if (ap.status !== 403) problems.push(`admin POST purge → ${ap.status} (want 403)`);
  console.log(`[p5qa] Q1 problems:\n${problems.join("\n")}`);
  await writeFile(STATE, JSON.stringify(st, null, 2));
  expect(problems).toEqual([]);
});

test("Q2 load limits at save, request and approve; approvals single use; out-of-range ceilings refused", async ({ page, request }) => {
  await useSharedAccount(page);
  tokens.owner = (await page.evaluate(() => window.localStorage.getItem("qa_token")))!;
  const owner = tokens.owner;
  const orgId = st.orgId;
  const prof = (await call(request, owner, "GET", `/performance-profiles/${st.prfId}`)).body;
  // Save over the ceiling (20 users).
  const over = await call(request, owner, "PATCH", `/performance-profiles/${st.prfId}`, { version: prof.version, stages: [{ duration_s: 10, target_vus: 30 }, { duration_s: 10, target_vus: 0 }] });
  console.log(`[p5qa] save 30 users: ${over.status} ${over.text.slice(0, 200)}`);
  expect(over.status).toBe(422);
  // Ceiling above the hard cap.
  const cap = await call(request, owner, "PATCH", `/organisations/${orgId}/settings`, { load_ceiling: { vus: 51, rps: 20, duration_s: 300 } });
  console.log(`[p5qa] ceiling 51: ${cap.status} ${cap.text.slice(0, 200)}`);
  expect(cap.status).toBe(422);
  expect(cap.text).toContain("This server allows up to 50.");
  const neg = await call(request, owner, "PATCH", `/organisations/${orgId}/settings`, { load_ceiling: { vus: 0, rps: -1, duration_s: 300 } });
  console.log(`[p5qa] ceiling 0/-1: ${neg.status} ${neg.text.slice(0, 200)}`);
  expect.soft(neg.status, "a zero/negative ceiling is refused").toBe(422);
  const odd = await call(request, owner, "PATCH", `/organisations/${orgId}/settings`, { load_ceiling: { vus: 20, rps: 20, duration_s: 300, bogus: 5 } });
  console.log(`[p5qa] ceiling with unknown key: ${odd.status} ${odd.text.slice(0, 200)}`);
  expect([200, 422], "unknown ceiling keys are refused or dropped (never stored)").toContain(odd.status);
  const check = (await call(request, owner, "GET", `/organisations/${orgId}/settings`)).body;
  console.log(`[p5qa] settings now: ${JSON.stringify(check)}`);

  // Request as member, then lower the ceiling below the profile: approval must be refused (409), then restore.
  const memberRaw = JSON.parse(await readFile(`${__dirname}/../playwright/.auth/e2e-member.json`, "utf8")) as Acc;
  acc.member = { ...memberRaw, name: "Morgan Member" };
  const member = await login(request, "member");
  const req = await call(request, member, "POST", `/projects/${st.projectId}/performance-runs`, { profile_id: st.prfId, note: "QA ceiling probe" });
  expect(req.status, req.text).toBe(201);
  const aid = req.body.approval.id;
  try {
    const lower = await call(request, owner, "PATCH", `/organisations/${orgId}/settings`, { load_ceiling: { vus: 5, rps: 20, duration_s: 300 } });
    expect(lower.status, lower.text).toBe(200);
    const appr = await call(request, owner, "POST", `/approvals/${aid}/decision`, { decision: "approve", confirm_text: "localhost" });
    console.log(`[p5qa] approve after lowering ceiling: ${appr.status} ${appr.text.slice(0, 200)}`);
    expect(appr.status).toBe(409);
  } finally {
    const restore = await call(request, owner, "PATCH", `/organisations/${orgId}/settings`, { load_ceiling: { vus: 20, rps: 20, duration_s: 300 } });
    expect(restore.status).toBe(200);
  }
  // Wrong host, empty refusal comment.
  const wrong = await call(request, owner, "POST", `/approvals/${aid}/decision`, { decision: "approve", confirm_text: "127.0.0.1" });
  console.log(`[p5qa] approve with '127.0.0.1': ${wrong.status} ${wrong.text.slice(0, 160)}`);
  expect(wrong.status).toBe(422);
  expect(wrong.text).toContain("Type localhost exactly to approve.");
  const noComment = await call(request, owner, "POST", `/approvals/${aid}/decision`, { decision: "reject" });
  expect(noComment.status).toBe(422);
  expect(noComment.text).toContain("Say why this load test shouldn't run.");
  // Refuse it (nothing sent), then a second decision on the same approval is refused.
  const rej = await call(request, owner, "POST", `/approvals/${aid}/decision`, { decision: "reject", comment: "QA: probe only" });
  console.log(`[p5qa] reject: ${rej.status}`);
  const again = await call(request, owner, "POST", `/approvals/${aid}/decision`, { decision: "approve", confirm_text: "localhost" });
  console.log(`[p5qa] second decision: ${again.status} ${again.text.slice(0, 160)}`);
  expect(again.status).toBe(409);
  // The used approval of the journey's run can't start another run.
  const used = (await call(request, owner, "GET", `/performance-runs/${st.perfRunId}`)).body.approval.id;
  const reuse = await call(request, owner, "POST", `/approvals/${used}/decision`, { decision: "approve", confirm_text: "localhost" });
  console.log(`[p5qa] reuse a used approval: ${reuse.status} ${reuse.text.slice(0, 160)}`);
  expect(reuse.status).toBe(409);
  // Member can't approve in the same call.
  const self = await call(request, member, "POST", `/projects/${st.projectId}/performance-runs`, { profile_id: st.prfId, approve: true, confirm_text: "localhost" });
  expect(self.status).toBe(403);
  // A non-GET or off-host target can't be put in a profile.
  const prof2 = (await call(request, owner, "GET", `/performance-profiles/${st.prfId}`)).body;
  const offHost = await call(request, owner, "PATCH", `/performance-profiles/${st.prfId}`, { version: prof2.version, targets: [{ path: "http://example.com/", weight: 1 }] });
  console.log(`[p5qa] off-host target: ${offHost.status} ${offHost.text.slice(0, 200)}`);
  expect(offHost.status).toBe(422);
  const prof3 = (await call(request, owner, "GET", `/performance-profiles/${st.prfId}`)).body;
  const notFound = await call(request, owner, "PATCH", `/performance-profiles/${st.prfId}`, { version: prof3.version, targets: [{ path: "/admin/delete-everything", weight: 1 }] });
  console.log(`[p5qa] undiscovered target: ${notFound.status} ${notFound.text.slice(0, 200)}`);
  expect.soft(notFound.status, "only discovered public pages can be targets").toBe(422);
});

test("Q3 audit log: host typed yes, no typed text, filters, export audited; emails in exports", async ({ page, request }) => {
  await useSharedAccount(page);
  tokens.owner = (await page.evaluate(() => window.localStorage.getItem("qa_token")))!;
  const owner = tokens.owner;
  const orgId = st.orgId;
  const all = await call(request, owner, "GET", `/organisations/${orgId}/audit-log?limit=100`);
  expect(all.status).toBe(200);
  // Filter to the approvals group so the check doesn't depend on load-test rows being in the newest 100.
  const grp = await call(request, owner, "GET", `/organisations/${orgId}/audit-log?limit=100&group=${encodeURIComponent("Approvals and load tests")}`);
  const items = grp.body.items as Json[];
  const approvals = items.filter((i) => /load test/i.test(String(i.label)) || /load_test|performance/.test(String(i.action)));
  console.log(`[p5qa] audit total=${all.body.total} groups=${JSON.stringify(all.body.groups)} load-test rows: ${approvals.slice(0, 6).map((i) => `${i.action}|${i.label}|${JSON.stringify(i.details)}`).join(" || ")}`);
  expect(approvals.length).toBeGreaterThan(0);
  const blob = JSON.stringify(items);
  expect.soft(blob, "audit details never contain the typed host text field").not.toMatch(/confirm_text/);
  expect.soft(blob).toMatch(/host typed: yes/);
  const g = await call(request, owner, "GET", `/organisations/${orgId}/audit-log?group=${encodeURIComponent("Approvals and load tests")}`);
  console.log(`[p5qa] group filter total=${g.body.total} vs all=${all.body.total}`);
  expect(g.body.total).toBeLessThan(all.body.total);
  const before = all.body.total;
  const csv = await request.get(`${API}/organisations/${orgId}/audit-log/export?format=csv&group=${encodeURIComponent("Approvals and load tests")}`, { headers: { Authorization: `Bearer ${owner}` } });
  expect(csv.status()).toBe(200);
  const csvText = await csv.text();
  const rows = csvText.trim().split(/\r?\n/).length - 1;
  console.log(`[p5qa] export X-Entries=${csv.headers()["x-entries"]} rows=${rows} hasEmail=${/@[a-z0-9.-]+\.[a-z]{2,}/i.test(csvText)} formulaCells=${(csvText.match(/(^|,)"?[=+@-]/gm) ?? []).length}`);
  expect(Number(csv.headers()["x-entries"])).toBe(g.body.total);
  const after = (await call(request, owner, "GET", `/organisations/${orgId}/audit-log?limit=1`)).body;
  expect(after.total, "the export itself is audited").toBeGreaterThan(before);
  expect(after.items[0].action).toBe("audit_log.exported");
  const pageTwo = await call(request, owner, "GET", `/organisations/${orgId}/audit-log?limit=2&cursor=${encodeURIComponent(all.body.next_cursor ?? "")}`);
  expect([200, 422]).toContain(pageTwo.status);
});

test("Q4 archive and scheduled deletion: rules hold, and what the UI promises", async ({ page, request }) => {
  await useSharedAccount(page);
  tokens.owner = (await page.evaluate(() => window.localStorage.getItem("qa_token")))!;
  const owner = tokens.owner;
  const mk = await call(request, owner, "POST", "/projects", { url: "http://localhost:4100/", name: `QA P5 purge ${Date.now()}`, start: false, confirm_duplicate: true, authorisation: { attested: true, statement: "QA local demo shop" } });
  expect(mk.status, mk.text).toBe(201);
  const id = mk.body.id;
  const name = mk.body.name;
  st.purgeProjectId = id;
  await writeFile(STATE, JSON.stringify(st, null, 2));
  const active = await call(request, owner, "POST", `/projects/${id}/purge`, { confirm_name: name });
  expect(active.status).toBe(409);
  expect(active.text).toContain("Archive the project first.");
  const admin = await login(request, "admin");
  expect([200, 204]).toContain((await call(request, admin, "POST", `/projects/${id}/archive`, {})).status);
  expect((await call(request, admin, "POST", `/projects/${id}/purge`, { confirm_name: name })).status).toBe(403);
  const wrong = await call(request, owner, "POST", `/projects/${id}/purge`, { confirm_name: name.toLowerCase() });
  expect(wrong.status).toBe(422);
  const ok = await call(request, owner, "POST", `/projects/${id}/purge`, { confirm_name: name });
  console.log(`[p5qa] purge scheduled: ${ok.status} ${ok.body.message} at ${ok.body.purge_scheduled_at}`);
  expect(ok.status).toBe(200);

  // What the UI tells the owner.
  await page.goto(`/projects/${id}/settings?view=archive`);
  await page.waitForTimeout(3_000);
  const text = await page.locator("main").innerText();
  console.log(`[p5qa] archive view text: ${text.replace(/\s+/g, " ").slice(0, 700)}`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/q4-deletion-scheduled.png`, fullPage: true });
  const promises = /will be deleted permanently on/.test(text);
  const honest = /not (yet )?(built|available)|won't be deleted|isn't deleted automatically|not deleted yet/i.test(text);
  console.log(`[p5qa] UI promises deletion: ${promises}; says the deletion job isn't built: ${honest}`);
  // Design check 38: every project page shows the callout with Cancel deletion.
  const pagesWithCallout: string[] = [];
  for (const sub of ["", "/non-functional", "/defects", "/reports"]) {
    await page.goto(`/projects/${id}${sub}`);
    await page.waitForTimeout(2_500);
    if (await page.getByRole("button", { name: "Cancel deletion" }).count()) pagesWithCallout.push(sub || "/");
  }
  console.log(`[p5qa] pages showing [Cancel deletion]: ${pagesWithCallout.join(", ")}`);
  expect.soft(pagesWithCallout.length, "design check 38: every project page shows the deletion callout").toBe(4);
  await a11y(page, "Project settings › Archive and delete (scheduled)");
  // Cancel, and unarchive clears a schedule.
  const cancel = await call(request, owner, "DELETE", `/projects/${id}/purge`);
  expect(cancel.body.message).toBe("Deletion cancelled. Nothing was removed.");
  expect((await call(request, owner, "POST", `/projects/${id}/purge`, { confirm_name: name })).status).toBe(200);
  expect([200, 204]).toContain((await call(request, owner, "POST", `/projects/${id}/unarchive`, {})).status);
  const after = await call(request, owner, "GET", `/projects/${id}`);
  expect(after.body.purge_scheduled_at ?? null, "unarchive clears the schedule").toBeNull();
  expect.soft(honest || !promises, "the UI must not promise a deletion that no job will perform").toBe(true);
});

test("Q5 settings pages: member/viewer see the owner/admin message; Server status; axe and 375 px", async ({ page, browser }) => {
  await useSharedAccount(page);
  for (const path of ["/settings", "/settings/load-limits", "/settings/retention", "/settings/audit-log"]) {
    await page.goto(path);
    await page.waitForTimeout(2_500);
    await a11y(page, `owner ${path}`);
    await noSideways(page, `owner ${path}`);
  }
  await page.goto("/settings");
  await page.waitForTimeout(2_500);
  const s = await page.locator("main").innerText();
  console.log(`[p5qa] /settings server status: ${(s.match(/(axe|load generator|k6|proxy|Docker)[^\n]*/gi) ?? []).join(" | ")}`);
  await page.goto("/settings/audit-log");
  await page.waitForTimeout(3_000);
  // Newest rows come from other journeys; filter to approvals so the approval rows are on screen.
  await page.getByLabel("What").selectOption("Approvals and load tests");
  await page.waitForTimeout(2_000);
  const audit = await page.locator("main").innerText();
  expect.soft(audit).toMatch(/host typed: yes/);
  for (const who of ["viewer"]) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto("/login");
    await p.getByLabel("Email").fill(acc[who].email);
    await p.getByRole("textbox", { name: "Password", exact: true }).fill(acc[who].password);
    await p.getByRole("button", { name: "Sign in" }).click();
    await p.waitForURL(/\/dashboard$/, { timeout: 30_000 });
    await p.goto("/settings");
    await p.waitForTimeout(2_000);
    for (const l of ["Load limits", "Retention", "Audit log"]) expect.soft(await p.getByRole("link", { name: l }).count(), `${who} sees no ${l} link`).toBe(0);
    for (const path of ["/settings/load-limits", "/settings/retention", "/settings/audit-log"]) {
      await p.goto(path);
      await p.waitForTimeout(3_000);
      const exact = await p.getByText("Only owners and admins can see this page.").count();
      const any = await p.getByText(/Only owners and admins can/).first().innerText().catch(() => "(none)");
      console.log(`[p5qa] ${who} ${path}: design text shown=${exact > 0}; shown: ${any}`);
      expect.soft(any, `${who} ${path} gets an owner/admin message`).toMatch(/Only owners and admins can/);
    }
    // Viewer on Non-functional: no start, request, triage or approve controls.
    await p.goto(`/projects/${st.projectId}/non-functional?tab=performance`);
    await p.waitForTimeout(3_000);
    for (const b of ["Draft a load profile", "Request load test…", "Check accessibility…", "Run security check", "New profile"]) expect.soft(await p.getByRole("button", { name: b }).count(), `viewer sees ${b}`).toBe(0);
    await p.goto(`/projects/${st.projectId}/non-functional/checks/${st.a11yKey}?finding=`);
    await p.waitForTimeout(3_000);
    expect.soft(await p.getByRole("button", { name: /Accept risk or mark false positive/ }).count(), "viewer: no triage").toBe(0);
    await p.goto(`/projects/${st.projectId}/non-functional/profiles/${st.prfKey}`);
    await p.waitForTimeout(3_000);
    expect.soft(await p.getByRole("button", { name: /Download k6 script/ }).count(), "viewer: k6 download button (design §2: member+)").toBe(0);
    for (const b of ["Save", "Mark ready", "Retire"]) expect.soft(await p.getByRole("button", { name: b, exact: true }).count(), `viewer sees ${b}`).toBe(0);
    await ctx.close();
  }
});

// Q6 retention, in QA's own organisation only ("QA P5 Other Org"), so no shared evidence is ever removed.
// Q6a creates a demo-shop project there and waits for discovery (screenshots). Between Q6a and Q6b QA moves that
// organisation's evidence `captured_at` back 40 days in the database (the only way to have "old" evidence today).
test("Q6a retention setup: a project with discovery screenshots in QA's own organisation", async ({ request }) => {
  test.setTimeout(10 * 60_000);
  const other = await login(request, "other");
  if (!st.otherProjectId) {
    const mk = await call(request, other, "POST", "/projects", { url: "http://localhost:4100/", name: "QA P5 retention", start: true, confirm_duplicate: true, authorisation: { attested: true, statement: "QA local demo shop" } });
    expect(mk.status, mk.text).toBe(201);
    st.otherProjectId = mk.body.id;
    await writeFile(STATE, JSON.stringify(st, null, 2));
  }
  await expect.poll(async () => (await call(request, other, "GET", `/projects/${st.otherProjectId}/discovery`)).body.status, { timeout: 8 * 60_000, intervals: [5_000] }).toMatch(/completed|partial/);
  const scan = (await call(request, other, "GET", `/projects/${st.otherProjectId}/discovery`)).body;
  const ev = await call(request, other, "GET", `/scans/${scan.id}/evidence`);
  const items = (ev.body.items ?? ev.body) as Json[];
  console.log(`[p5qa] Q6a scan ${scan.id} evidence: ${items.length} (${[...new Set(items.map((e) => e.kind))].join(",")})`);
  st.otherScanId = scan.id;
  st.otherOrgId = (await call(request, other, "GET", "/auth/me")).body.organisation?.id;
  await writeFile(STATE, JSON.stringify(st, null, 2));
  expect(items.length).toBeGreaterThan(0);
});

test("Q6b retention applied: file gone with 410 and the text; what the screens show", async ({ page, request }) => {
  const other = await login(request, "other");
  const orgId = st.otherOrgId;
  const put = await call(request, other, "PUT", `/organisations/${orgId}/retention`, { videos_traces_days: 30, screenshots_days: 1, timeseries_days: 90 });
  expect(put.status, put.text).toBe(200);
  const applied = await call(request, other, "POST", `/organisations/${orgId}/retention/apply`, {});
  console.log(`[p5qa] Q6b apply: ${applied.status} ${applied.body.message}`);
  expect(applied.status).toBe(200);
  const ev = await call(request, other, "GET", `/scans/${st.otherScanId}/evidence`);
  const items = (ev.body.items ?? ev.body) as Json[];
  const shot = items.find((e) => e.kind === "screenshot");
  console.log(`[p5qa] Q6b screenshot record: removed=${shot?.removed} url=${shot?.content_url ? "yes" : "no"}`);
  expect(shot?.removed).toMatch(/^Removed by the retention policy on \d{1,2} \w{3} \d{4}\.$/);
  const content = await request.get(String(shot!.content_url).startsWith("http") ? shot!.content_url : `${API.replace(/\/api\/v1$/, "")}${shot!.content_url}`);
  console.log(`[p5qa] Q6b content: ${content.status()} ${(await content.text()).slice(0, 160)}`);
  expect(content.status()).toBe(410);
  // The audit log of that organisation records the clean-up; who ran it?
  const audit = await call(request, other, "GET", `/organisations/${orgId}/audit-log?limit=5`);
  console.log(`[p5qa] Q6b audit: ${(audit.body.items as Json[]).map((i) => `${i.action}|${i.who?.name ?? "system"}|${JSON.stringify(i.details)}`).join(" || ")}`);
  // Screens: sign the other owner in and look at discovery pages for broken images.
  await page.goto("/login");
  await page.getByLabel("Email").fill(acc.other.email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(acc.other.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 30_000 });
  const broken: string[] = [];
  page.on("response", (r) => {
    if (r.status() === 410) broken.push(r.url().replace(/\?.*/, ""));
  });
  for (const path of [`/projects/${st.otherProjectId}/discovery?view=summary`, `/projects/${st.otherProjectId}/discovery?view=sitemap`, `/projects/${st.otherProjectId}/discovery?view=responsive`]) {
    await page.goto(path);
    await page.waitForTimeout(4_000);
  }
  // Open the first page's detail drawer if there is one.
  const firstPage = page.getByRole("button", { name: /Open|details/i }).first();
  if (await firstPage.count()) await firstPage.click().catch(() => undefined);
  await page.waitForTimeout(3_000);
  const brokenImgs = await page.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.alt || i.src.slice(0, 80)));
  const removedText = await page.getByText(/Removed by the retention policy on/).count();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/q6-retention-discovery.png`, fullPage: true });
  console.log(`[p5qa] Q6b 410 responses on screens: ${broken.length}; broken <img>: ${brokenImgs.length} (${brokenImgs.slice(0, 3).join(" | ")}); "Removed by the retention policy" shown: ${removedText}`);
  expect.soft(brokenImgs, "design check 37: no broken image where evidence was removed").toEqual([]);
});

// Q7 design checks 42 and 44 on every Phase 5 page of the journey project: axe serious/critical, and at 375 and
// 320 px no sideways scroll; when there is, name the widest offending element.
test("Q7 axe and 375/320 px on every Phase 5 page", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  await useSharedAccount(page);
  const base = `/projects/${st.projectId}`;
  const pages = [
    `${base}/non-functional?tab=performance`,
    `${base}/non-functional?tab=accessibility`,
    `${base}/non-functional?tab=security`,
    `${base}/non-functional/checks/${st.a11yKey}`,
    `${base}/non-functional/checks/${st.a11yKey}?view=pages`,
    `${base}/non-functional/checks/${st.a11yKey}?view=keyboard`,
    `${base}/non-functional/checks/${st.secKey}`,
    `${base}/non-functional/profiles/${st.prfKey}`,
    `${base}/non-functional/load-tests/${st.perfKey}`,
    `${base}/non-functional/load-tests/${st.stopKey}`,
    `${base}/reports/performance`,
    `${base}/reports/accessibility`,
    `${base}/reports/security`,
    `${base}/defects`,
    `${base}/defects?view=review`,
    `${base}/traceability`,
    `${base}`,
    `/settings`,
    `/settings/load-limits`,
    `/settings/retention`,
    `/settings/audit-log`,
  ];
  const out: string[] = [];
  for (const url of pages) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url);
    await page.waitForTimeout(3_500);
    const ax = await (await import("./helpers")).seriousA11yViolations(page);
    if (ax.length) out.push(`axe ${url}: ${ax.join(" ; ")}`);
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(500);
      const r = await page.evaluate(() => {
        const extra = document.documentElement.scrollWidth - window.innerWidth;
        if (extra <= 0) return null;
        let worst = "";
        let max = window.innerWidth;
        for (const el of document.querySelectorAll<HTMLElement>("body *")) {
          const b = el.getBoundingClientRect();
          if (b.right > max + 0.5 && b.width > 0) {
            // only the outermost offender inside a non-scrolling parent
            const scroller = el.closest("[role=region], .overflow-x-auto, .overflow-auto, pre, table");
            if (scroller && scroller !== el) continue;
            max = b.right;
            worst = `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 3).join(".")} "${(el.innerText || "").slice(0, 40).replace(/\s+/g, " ")}"`;
          }
        }
        return `${extra}px · ${worst}`;
      });
      if (r) out.push(`${width}px ${url}: ${r}`);
    }
  }
  console.log(`[p5qa] Q7 problems (${out.length}):\n${out.join("\n")}`);
  expect.soft(out).toEqual([]);
});

// Q8 a second accessibility check: triage survives by fingerprint ("Seen before"), open drafts get occurrences
// instead of new drafts (D20), a running check blocks a second one (409).
test("Q8 re-check: accepted risk kept, occurrences instead of new drafts, one running check per kind", async ({ page, request }) => {
  test.setTimeout(6 * 60_000);
  await useSharedAccount(page);
  const owner = (await page.evaluate(() => window.localStorage.getItem("qa_token")))!;
  const pid = st.projectId;
  const draftsBefore = ((await call(request, owner, "GET", `/projects/${pid}/defects?source=accessibility&status=all`)).body.items as Json[]).length;
  const s1 = await call(request, owner, "POST", `/projects/${pid}/accessibility-scans`, {});
  expect(s1.status, s1.text).toBe(201);
  const dup = await call(request, owner, "POST", `/projects/${pid}/accessibility-scans`, {});
  console.log(`[p5qa] Q8 second start while running: ${dup.status} ${dup.text.slice(0, 160)}`);
  await expect.poll(async () => (await call(request, owner, "GET", `/quality-scans/${s1.body.id}`)).body.status, { timeout: 5 * 60_000, intervals: [2_000] }).toMatch(/completed|partial|failed/);
  const scan = (await call(request, owner, "GET", `/quality-scans/${s1.body.id}`)).body;
  const fs = (await call(request, owner, "GET", `/quality-scans/${s1.body.id}/findings`)).body.items as Json[];
  const accepted = fs.filter((f) => f.status === "accepted_risk").map((f) => `${f.rule_id}@${f.path} seen_before=${f.seen_before ?? f.first_seen_scan ?? "?"}`);
  const draftsAfter = ((await call(request, owner, "GET", `/projects/${pid}/defects?source=accessibility&status=all`)).body.items as Json[]).length;
  console.log(`[p5qa] Q8 ${scan.key} ${scan.status} occurrences_added=${JSON.stringify(scan.summary.occurrences_added)} drafted=${JSON.stringify(scan.summary.drafted)} accepted kept: ${accepted.join(", ")} drafts ${draftsBefore} → ${draftsAfter}`);
  expect([409]).toContain(dup.status);
  expect(accepted.length, "the accepted-risk finding keeps its status on a re-check").toBeGreaterThan(0);
  expect(draftsAfter, "no new accessibility drafts on a re-check").toBe(draftsBefore);
});

// Q9 axe detail on the load-test approval panel (the journey saw a serious color-contrast violation there).
test("Q9 approval panel axe detail", async ({ page }) => {
  await useSharedAccount(page);
  const AxeBuilder = (await import("@axe-core/playwright")).default;
  await page.goto(`/projects/${st.projectId}/non-functional/load-tests/PERF-0008`);
  const approve = page.getByRole("button", { name: "Approve and start load test" });
  await expect(approve).toBeVisible({ timeout: 30_000 });
  for (const step of ["empty", "wrong+Enter", "typed"]) {
    if (step === "wrong+Enter") {
      await page.getByLabel("Type localhost to approve").fill("localhost:4100");
      await approve.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByText("Type localhost exactly to approve.").first()).toBeVisible();
    }
    if (step === "typed") await page.getByLabel("Type localhost to approve").fill("localhost");
    await page.waitForTimeout(500);
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const v = r.violations.filter((x) => x.impact === "serious" || x.impact === "critical");
    console.log(`[p5qa] Q9 ${step}: ${v.map((x) => `${x.id}: ${x.nodes.map((n) => `${n.html.slice(0, 160)} :: ${n.failureSummary?.replace(/\s+/g, " ").slice(0, 220)}`).join(" || ")}`).join(" ;; ") || "none"}`);
  }
});

test("Q10 which element overflows SEC results at 320 px", async ({ page }) => {
  await useSharedAccount(page);
  await page.setViewportSize({ width: 320, height: 800 });
  for (const q of ["", "?finding="]) {
    await page.goto(`/projects/${st.projectId}/non-functional/checks/${st.secKey}${q}`);
    await page.waitForTimeout(4_000);
    const r = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const extra = document.documentElement.scrollWidth - w;
      const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((el) => el.getBoundingClientRect().right > w + 0.5)
        .map((el) => `${el.tagName.toLowerCase()}[${el.getAttribute("role") ?? ""}] right=${Math.round(el.getBoundingClientRect().right)} "${(el.innerText || el.getAttribute("aria-label") || "").slice(0, 50).replace(/\s+/g, " ")}"`);
      // Also: pseudo-elements and the deepest element whose own box is wider than the viewport.
      const pseudo: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("body *")) {
        for (const ps of ["::before", "::after"]) {
          const cs = getComputedStyle(el, ps);
          if (cs.content && cs.content !== "none" && cs.position === "absolute") pseudo.push(`${el.tagName.toLowerCase()}${ps}`);
        }
      }
      const wide = [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((el) => el.scrollWidth > el.clientWidth + 0.5 && getComputedStyle(el).overflowX === "visible" && el.clientWidth > 0)
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 3).join(".")} sw=${el.scrollWidth} cw=${el.clientWidth} "${el.innerText.slice(0, 60).replace(/\s+/g, " ")}"`);
      const sr = [...document.querySelectorAll<HTMLElement>(".sr-only")].map((el) => Math.round(el.getBoundingClientRect().right)).filter((r) => r > w);
      return { extra, offenders: [...offenders.slice(0, 8), `pseudo:${pseudo.slice(0, 4).join(",")}`, `wide:${wide.slice(-4).join(" ; ")}`, `sr-only past edge:${sr.length}`] };
    });
    console.log(`[p5qa] Q10 SEC${q} extra=${r.extra}px offenders: ${r.offenders.join(" | ")}`);
  }
});

// ---------------------------------------------------------------------------------------------------- round 2
// R1  QA's own organisation: project O to Gate 4 (so a load profile can exist there for the time-series retention).
// R2  design check 37 on every evidence viewer that O has: Discovery responsive / sitemap / page drawer.
// R3  design check 34: member and viewer see "Only owners and admins can see this page." on the three pages.
// R4  design check 44 live as owner and member: SEC check page and load-test results at 320 and 375 px.

async function signInOther(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(acc.other.email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(acc.other.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 30_000 });
}

test("R1 other org: project O through Gates 3 and 4", async ({ page }) => {
  test.setTimeout(15 * 60_000);
  await signInOther(page);
  const base = `/projects/${st.otherProjectId}`;
  await reloadUntil(page, `${base}/requirements`, async () => {
    const gen = page.getByRole("button", { name: "Generate requirements" });
    if (await appears(gen, 3_000)) await gen.click();
    return (await page.getByRole("checkbox", { name: /^Select REQ-/ }).count()) > 0;
  });
  await page.goto(`${base}/requirements?status=draft`);
  const boxes = page.getByRole("checkbox", { name: /^Select REQ-/ });
  await boxes.first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  if ((await boxes.count()) > 0) {
    await page.getByRole("checkbox", { name: /Select all/ }).first().check();
    await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: /^Approve \d+$/ }).click();
    const guard = page.getByRole("dialog", { name: /^Approve \d+ requirements?\?$/ });
    if (await appears(guard, 2_000)) await guard.getByRole("button", { name: /^Approve/ }).last().click();
  }
  await page.goto(`${base}/requirements?view=review`);
  const reqApproved = page.getByText(/Requirements approved/).first();
  if (!(await appears(reqApproved, 5_000))) {
    await page.getByRole("button", { name: "Approve requirements" }).click({ timeout: 60_000 });
    const confirm = page.getByRole("dialog", { name: /^Approve with \d+ drafts?\?$/ });
    if (await appears(confirm, 3_000)) await confirm.getByRole("button", { name: "Approve requirements" }).click();
    await expect(reqApproved).toBeVisible({ timeout: 30_000 });
  }
  await reloadUntil(page, `${base}/test-strategy`, async () => {
    const write = page.getByRole("button", { name: "Write the Test Strategy" });
    if (await appears(write, 3_000)) await write.click();
    return (await page.getByRole("heading", { name: /Test levels/ }).count()) > 0;
  });
  await page.goto(`${base}/test-strategy?view=review`);
  const strategyApproved = page.getByText(/Strategy approved/).first();
  if (!(await appears(strategyApproved, 5_000))) {
    await page.getByRole("button", { name: "Approve test strategy" }).click({ timeout: 60_000 });
    await expect(strategyApproved).toBeVisible({ timeout: 30_000 });
  }
});

test("R2 removed evidence: no broken image on any viewer, honest Responsive text (check 37)", async ({ page }) => {
  await signInOther(page);
  const base = `/projects/${st.otherProjectId}`;
  const out: string[] = [];
  const look = async (label: string) => {
    await page.waitForTimeout(4_000);
    const broken = await page.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0).length);
    const removed = await page.getByText(/Removed by the retention policy on \d{1,2} \w{3} \d{4}\./).count();
    const noDiff = await page.getByText("No layout differences observed").count();
    out.push(`${label}: broken=${broken} removedText=${removed} noLayoutDiff=${noDiff}`);
    expect.soft(broken, `${label}: broken images`).toBe(0);
    return { removed, noDiff };
  };
  await page.goto(`${base}/discovery?view=responsive`);
  const r = await look("responsive");
  expect.soft(r.removed, "responsive: removed text shown").toBeGreaterThan(0);
  expect.soft(r.noDiff, "responsive: no 'No layout differences observed' while images are removed").toBe(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/r2-responsive.png`, fullPage: true });
  await page.goto(`${base}/discovery?view=summary`);
  await look("summary");
  await page.goto(`${base}/discovery?view=sitemap`);
  await look("sitemap");
  await page.goto(`${base}/discovery?view=journeys`);
  await page.waitForTimeout(3_000);
  for (const b of await page.locator('button[aria-controls^="steps-"]').all()) await b.click().catch(() => undefined);
  const j = await look("user journeys");
  expect.soft(j.removed, "user journeys: removed text").toBeGreaterThan(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/r2-journeys.png`, fullPage: true });
  await page.goto(`${base}/discovery?view=sitemap`);
  await page.waitForTimeout(2_000);
  const pages = page.getByRole("button", { name: /\/products\/1|Desk lamp|Home/ });
  if (await pages.count()) {
    await pages.first().click().catch(() => undefined);
    const d = await look("page drawer");
    expect.soft(d.removed, "page drawer: removed text").toBeGreaterThan(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/r2-drawer.png`, fullPage: true });
  } else out.push("page drawer: no page button found");
  console.log(`[p5qa] R2 ${out.join(" || ")}`);
});

test("R3 member and viewer: settings pages show the design's owner/admin message (check 34)", async ({ page, browser }) => {
  await useSharedAccount(page);
  const ctxs: Record<string, import("@playwright/test").Page> = {};
  const mctx = await browser.newContext();
  ctxs.member = await mctx.newPage();
  await signInMember(ctxs.member, page, browser);
  const vctx = await browser.newContext();
  ctxs.viewer = await vctx.newPage();
  const p = ctxs.viewer;
  await p.goto("/login");
  await p.getByLabel("Email").fill(acc.viewer.email);
  await p.getByRole("textbox", { name: "Password", exact: true }).fill(acc.viewer.password);
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL(/\/dashboard$/, { timeout: 30_000 });
  for (const who of ["member", "viewer"]) {
    const q = ctxs[who];
    await q.goto("/settings");
    await q.waitForTimeout(2_500);
    for (const l of ["Load limits", "Retention", "Audit log"]) expect.soft(await q.getByRole("link", { name: l }).count(), `${who}: no ${l} link`).toBe(0);
    for (const path of ["/settings/load-limits", "/settings/retention", "/settings/audit-log"]) {
      await q.goto(path);
      await q.waitForTimeout(3_000);
      const shown = await q.locator("main").innerText();
      console.log(`[p5qa] R3 ${who} ${path}: design text=${shown.includes("Only owners and admins can see this page.")}; inputs=${await q.locator("main input").count()}`);
      expect.soft(shown, `${who} ${path}`).toContain("Only owners and admins can see this page.");
      expect.soft(await q.locator("main input, main table").count(), `${who} ${path}: nothing of the page shown`).toBe(0);
      await a11y(q, `${who} ${path}`);
    }
  }
  await mctx.close();
  await vctx.close();
});

test("R4 320/375 px live as owner and member: SEC check and load-test results (check 44)", async ({ page, browser }) => {
  await useSharedAccount(page);
  const mctx = await browser.newContext();
  const member = await mctx.newPage();
  await signInMember(member, page, browser);
  const paths = [`/projects/${st.projectId}/non-functional/checks/${st.secKey}`, `/projects/${st.projectId}/non-functional/load-tests/${st.perfKey}`, `/projects/${st.projectId}/non-functional/load-tests/${st.stopKey}`, `/projects/${st.projectId}/non-functional/checks/${st.a11yKey}`];
  const out: string[] = [];
  for (const [who, q] of [["owner", page], ["member", member]] as const) {
    for (const w of [320, 375]) {
      await q.setViewportSize({ width: w, height: 800 });
      for (const path of paths) {
        await q.goto(path);
        await q.waitForTimeout(3_500);
        for (const tab of ["By rule", "By page"]) {
          const t = q.getByRole("radio", { name: tab }).or(q.getByRole("tab", { name: tab })).first();
          if (await t.count()) await t.click().catch(() => undefined);
          const extra = await q.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth);
          if (extra > 0) out.push(`${who} ${w}px ${path.split("/").slice(-1)[0]} ${tab}: ${extra}px`);
          if (!(await t.count())) break;
        }
      }
    }
  }
  console.log(`[p5qa] R4 overflow: ${out.length ? out.join(" | ") : "none"}`);
  expect.soft(out).toEqual([]);
  await mctx.close();
});

test("R5 which element overflows a fresh failed load test at 320 px", async ({ page }) => {
  await useSharedAccount(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/projects/${st.projectId}/non-functional/load-tests/${st.perfKey}`);
  await page.waitForTimeout(5_000);
  const r = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const all = [...document.querySelectorAll<HTMLElement>("main *")];
    const past = all.filter((el) => el.getBoundingClientRect().right > w + 0.5).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 4).join(".")} right=${Math.round(el.getBoundingClientRect().right)} "${(el.innerText || "").slice(0, 50).replace(/\s+/g, " ")}"`);
    const wide = all.filter((el) => el.scrollWidth > el.clientWidth + 0.5 && el.clientWidth > 0 && getComputedStyle(el).overflowX === "visible").map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 4).join(".")} sw=${el.scrollWidth} cw=${el.clientWidth} "${(el.innerText || "").slice(0, 50).replace(/\s+/g, " ")}"`);
    return { extra: document.documentElement.scrollWidth - w, past: past.slice(0, 6), wide: wide.slice(-6) };
  });
  console.log(`[p5qa] R5 ${st.perfKey} extra=${r.extra}px past-edge: ${r.past.join(" | ")} || wide: ${r.wide.join(" | ")}`);
});

// R6 (round 3) design check 37 in the evidence drawer opened from the agent activity feed: sample the drawer every
// 50 ms for 3 s after opening, so a broken image that only flashes before the removed text appears is caught.
test("R6 activity feed evidence drawer: removed text, no broken-image flash", async ({ page }) => {
  await signInOther(page);
  const out: string[] = [];
  for (const path of [`/projects/${st.otherProjectId}`, `/projects/${st.otherProjectId}/discovery?view=summary`]) {
    await page.goto(path);
    await page.waitForTimeout(4_000);
    const shots = page.getByRole("button", { name: /^Screenshot/ });
    const n = Math.min(await shots.count(), 3);
    for (let i = 0; i < n; i++) {
      await shots.nth(i).click();
      let maxBroken = 0;
      for (let t = 0; t < 60; t++) {
        const b = await page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>("[role=dialog] img")].filter((im) => im.complete && im.naturalWidth === 0).length);
        maxBroken = Math.max(maxBroken, b);
        await page.waitForTimeout(50);
      }
      const removed = await page.getByRole("dialog").getByText(/Removed by the retention policy on/).count();
      out.push(`${path.endsWith("summary") ? "discovery" : "overview"} #${i + 1}: max broken in drawer=${maxBroken} removedText=${removed}`);
      expect.soft(maxBroken, "no broken image, even briefly").toBe(0);
      expect.soft(removed, "removed text shown").toBeGreaterThan(0);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
    }
    if (!n) out.push(`${path}: no Screenshot evidence button found`);
  }
  console.log(`[p5qa] R6 ${out.join(" || ")}`);
});
