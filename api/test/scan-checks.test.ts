import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

// SCAN-1: checks written automatically after a site scan. Uses a throwaway SQLite database and a tiny local site.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ata-scan-"));
process.env.DATABASE_URL = `file:${path.join(tmp, "test.db")}`;
process.env.STORAGE_DIR = path.join(tmp, "storage");
process.env.JWT_SECRET ??= "test";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.ALLOW_PRIVATE_TARGETS = "true"; // the test site runs on 127.0.0.1
process.env.ANTHROPIC_API_KEY = ""; // rule-based generator: deterministic output
process.env.ANTHROPIC_AUTH_TOKEN = "";
execSync("npx prisma db push --skip-generate", { cwd: path.resolve(import.meta.dirname, ".."), env: process.env, stdio: "ignore" });

const { prisma } = await import("../src/db.js");
const { discoveryDto, runDiscovery } = await import("../src/services/discovery.js");
const { generateChecksForScan, generationDto, withoutDuplicates } = await import("../src/services/scan-checks.js");
const { caseListWhere } = await import("../src/lib/case-filter.js");
const { liveDir } = await import("../src/services/runner.js");

const pages = (base: string) => [
  {
    url: `${base}/`, title: "Shop", status: 200, depth: 0, links: [`${base}/contact`], buttons: [], forms: [], navItems: ["Contact"], headings: ["Welcome"], screenshotEvidenceId: null,
  },
  {
    url: `${base}/contact`, title: "Contact us", status: 200, depth: 1, links: [], buttons: ["Send"], navItems: ["Contact"], headings: ["Contact us"], screenshotEvidenceId: null,
    forms: [{ action: `${base}/contact`, method: "POST", fields: [{ name: "email", type: "email", label: "Email", required: true }, { name: "message", type: "textarea", label: "Message", required: true }] }],
  },
];

async function setup(baseUrl = "https://shop.example.com") {
  const org = await prisma.organisation.create({ data: { name: "Acme" } });
  const user = await prisma.user.create({ data: { fullName: "Quinn Tester", email: `q${Date.now()}${Math.random()}@example.com`, passwordHash: "x", organisationId: org.id } });
  const project = await prisma.project.create({ data: { organisationId: org.id, name: "Shop", applicationUrl: baseUrl } });
  const env = await prisma.environment.create({ data: { projectId: project.id, name: "STAGING", baseUrl, authorised: true } });
  return { org, user, project, env };
}

async function completedScan(projectId: string, environmentId: string, base = "https://shop.example.com") {
  return prisma.discovery.create({
    data: { projectId, environmentId, status: "COMPLETED", completedAt: new Date(), result: JSON.stringify({ pages: pages(base), workflows: [] }), generation: JSON.stringify({ status: "PENDING", total: 0, withScript: 0, skippedDuplicates: 0 }) },
  });
}

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("generation object: null until generation starts, then a fixed shape", () => {
  assert.equal(generationDto("{}"), null);
  assert.equal(generationDto(""), null);
  assert.equal(generationDto('{"status":"WHATEVER"}'), null);
  assert.deepEqual(generationDto('{"status":"PENDING"}'), { status: "PENDING", total: 0, withScript: 0, skippedDuplicates: 0 });
  assert.deepEqual(generationDto('{"status":"RUNNING","total":5,"withScript":2,"skippedDuplicates":1,"done":3}'), { status: "RUNNING", total: 5, withScript: 2, skippedDuplicates: 1, done: 3 });
  assert.deepEqual(generationDto('{"status":"FAILED","total":5,"withScript":0,"skippedDuplicates":0,"error":"Something went wrong"}'), { status: "FAILED", total: 5, withScript: 0, skippedDuplicates: 0, error: "Something went wrong" });
});

test("duplicate titles are dropped ignoring case and spacing, also within one batch", () => {
  const c = (title: string) => ({ title, description: "", preconditions: "", steps: [], expectedResult: "", category: "UI" as const, priority: "LOW" as const });
  const { fresh, skipped } = withoutDuplicates([c("Home loads"), c("home  LOADS "), c("Contact works"), c("Contact works")], ["Old check"]);
  assert.deepEqual(fresh.map((x) => x.title), ["Home loads", "Contact works"]);
  assert.equal(skipped, 2);
  assert.equal(withoutDuplicates([c("Old check")], [" old CHECK"]).fresh.length, 0);
});

test("writes draft checks linked to the scan, with scripts for the automatable ones; re-scan adds no duplicates", async () => {
  const { project, env } = await setup();
  const first = await completedScan(project.id, env.id);
  await generateChecksForScan(first.id);

  const g = generationDto((await prisma.discovery.findUniqueOrThrow({ where: { id: first.id } })).generation)!;
  assert.equal(g.status, "DONE");
  const linked = await prisma.testCase.findMany({ where: { discoveryId: first.id }, include: { scripts: true } });
  assert.ok(linked.length > 0 && linked.length <= 20, `${linked.length} checks`);
  assert.equal(g.total, linked.length);
  assert.equal(g.done, linked.length);
  assert.equal(g.skippedDuplicates, 0);
  assert.ok(linked.every((c) => c.status === "DRAFT" && JSON.parse(c.steps).length > 0 && c.expectedResult));
  // Rule-based checks are labelled as such (not as AI drafts) and open pages by their absolute URL.
  assert.ok(linked.every((c) => c.source === "RULE_BASED" && !c.aiGenerated), "stored as rule-based");
  assert.ok(linked.every((c) => JSON.parse(c.steps)[0].action.startsWith("Open https://shop.example.com/")), "absolute URLs");
  const scripted = linked.filter((c) => c.scripts.length);
  assert.equal(g.withScript, scripted.length);
  assert.ok(scripted.length > 0, "at least one automated script");
  assert.ok(scripted.every((c) => !c.scripts[0].code.includes("TODO: automate") && c.scripts[0].createdById === null));

  // The scan's DTO carries the same object.
  assert.deepEqual(discoveryDto(await prisma.discovery.findUniqueOrThrow({ where: { id: first.id } })).generation, g);

  // Same pages again: nothing new, everything counted as already there.
  const before = await prisma.testCase.count({ where: { projectId: project.id } });
  const second = await completedScan(project.id, env.id);
  await generateChecksForScan(second.id);
  const g2 = generationDto((await prisma.discovery.findUniqueOrThrow({ where: { id: second.id } })).generation)!;
  assert.deepEqual({ status: g2.status, total: g2.total, withScript: g2.withScript }, { status: "DONE", total: 0, withScript: 0 });
  assert.equal(g2.skippedDuplicates, linked.length);
  assert.equal(await prisma.testCase.count({ where: { projectId: project.id } }), before);

  // Running generation again for the first scan (the retry button) changes nothing either.
  await generateChecksForScan(first.id);
  assert.equal(await prisma.testCase.count({ where: { projectId: project.id } }), before);
  assert.equal(generationDto((await prisma.discovery.findUniqueOrThrow({ where: { id: first.id } })).generation)!.total, linked.length);
});

test("scan filter returns only the checks written by that scan", async () => {
  const { project, env } = await setup();
  const scan = await completedScan(project.id, env.id);
  await generateChecksForScan(scan.id);
  await prisma.testCase.create({ data: { key: "TC-9999", projectId: project.id, title: "Written by hand" } });
  const all = await prisma.testCase.findMany({ where: caseListWhere(project.id, {}) });
  const fromScan = await prisma.testCase.findMany({ where: caseListWhere(project.id, { scan: scan.id }) });
  assert.ok(fromScan.length > 0 && fromScan.length === all.length - 1);
  assert.ok(fromScan.every((c) => c.discoveryId === scan.id));
  assert.equal((await prisma.testCase.findMany({ where: caseListWhere(project.id, { scan: "other-scan" }) })).length, 0);
  // Combines with the other filters.
  assert.equal((await prisma.testCase.findMany({ where: caseListWhere(project.id, { scan: scan.id, status: "APPROVED" }) })).length, 0);
  // Another project's scan id never leaks its cases.
  assert.equal((await prisma.testCase.findMany({ where: caseListWhere("another-project", { scan: scan.id }) })).length, 0);
});

test("generation failure keeps the scan COMPLETED and stores a plain reason; retry then finishes the job", async () => {
  const { project, env } = await setup();
  const scan = await completedScan(project.id, env.id);
  // Scripts can't be saved: generation stops part-way through.
  await prisma.$executeRawUnsafe('ALTER TABLE "Script" RENAME TO "Script_off"');
  try {
    await generateChecksForScan(scan.id);
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "Script_off" RENAME TO "Script"');
  }
  const d = await prisma.discovery.findUniqueOrThrow({ where: { id: scan.id } });
  assert.equal(d.status, "COMPLETED");
  const g = generationDto(d.generation)!;
  assert.equal(g.status, "FAILED");
  assert.equal(g.error, "Something went wrong while writing the checks");
  const partial = await prisma.testCase.count({ where: { discoveryId: scan.id } });

  await generateChecksForScan(scan.id);
  const g2 = generationDto((await prisma.discovery.findUniqueOrThrow({ where: { id: scan.id } })).generation)!;
  assert.equal(g2.status, "DONE");
  assert.equal(g2.error, undefined);
  // Checks written before the failure are kept and counted, not reported as duplicates.
  assert.ok(g2.total > partial);
  assert.equal(g2.total, await prisma.testCase.count({ where: { discoveryId: scan.id } }));
  assert.equal(g2.skippedDuplicates, 0);
});

test("a finished scan writes its checks automatically and streams live frames while it runs", { timeout: 120_000 }, async (t) => {
  // Small two-page site; each response is a little slow so the browser is on screen long enough to stream frames.
  const site = http.createServer((req, res) => {
    const body = req.url === "/contact"
      ? '<title>Contact us</title><h1>Contact us</h1><form method="post"><label for="e">Email</label><input id="e" name="email" type="email" required><label for="m">Message</label><textarea id="m" name="message" required></textarea><button type="submit">Send</button></form>'
      : '<title>Shop</title><nav><a href="/contact">Contact</a></nav><h1>Welcome</h1>';
    setTimeout(() => res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><body style="background:#fff">${body}</body></html>`), 400);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  t.after(() => site.close());
  const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

  const { user, project, env } = await setup(base);
  const run = await prisma.testRun.create({ data: { key: "RUN-0001", projectId: project.id, name: "Scan", executionType: "DISCOVERY", environmentId: env.id, initiatedById: user.id } });
  const scan = await prisma.discovery.create({ data: { projectId: project.id, environmentId: env.id, maxPages: 5, testRunId: run.id } });

  let sawFrame = false, sawProgress = false;
  const frame = path.join(liveDir(run.id), "w0.jpg");
  const watcher = setInterval(async () => {
    if (fs.existsSync(frame)) sawFrame = true;
    const d = await prisma.discovery.findUnique({ where: { id: scan.id } }).catch(() => null);
    if (d?.status === "RUNNING" && discoveryDto(d).current) sawProgress = true;
  }, 50);
  await runDiscovery(scan.id);
  clearInterval(watcher);

  const d = await prisma.discovery.findUniqueOrThrow({ where: { id: scan.id } });
  assert.equal(d.status, "COMPLETED", d.summary);
  assert.ok(sawFrame, "the scan's browser wrote live frames");
  assert.ok(sawProgress, "the page being visited was reported while running");
  assert.equal(fs.existsSync(liveDir(run.id)), false, "live frames are removed when the scan ends");
  const g = discoveryDto(d).generation!;
  assert.equal(g.status, "DONE");
  assert.ok(g.total > 0);
  assert.equal(await prisma.testCase.count({ where: { discoveryId: scan.id } }), g.total);
  assert.equal(discoveryDto(d).current, null);
  // The scan keeps what detailed checks need: h1, navigation targets, the submit button and field details.
  const contact = discoveryDto(d).pages.find((p) => p.url.endsWith("/contact"))!;
  const home = discoveryDto(d).pages.find((p) => !p.url.endsWith("/contact"))!;
  assert.deepEqual(contact.h1, ["Contact us"]);
  assert.equal(contact.forms[0].submit, "Send");
  assert.equal(contact.forms[0].fields[0].placeholder, "");
  assert.deepEqual(home.navLinks, [{ text: "Contact", href: `${base}/contact` }]);
  const written = await prisma.testCase.findMany({ where: { discoveryId: scan.id }, include: { scripts: true } });
  assert.ok(written.some((c) => c.steps.includes('Click \\"Send\\"')), "real submit button text is used");
  assert.ok(written.filter((c) => c.scripts.length).length >= written.length - 1, "almost every check has a script");
});

test("a cancelled scan stays CANCELLED, keeps its pages and writes no checks", { timeout: 120_000 }, async (t) => {
  const { cancel } = await import("../src/services/queue.js");
  const site = http.createServer((req, res) => {
    const links = Array.from({ length: 6 }, (_, i) => `<a href="/p${i}">Page ${i}</a>`).join(" ");
    setTimeout(() => res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Page ${req.url}</title><h1>Page</h1>${links}`), 300);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  t.after(() => site.close());
  const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const { user, project, env } = await setup(base);
  const run = await prisma.testRun.create({ data: { key: "RUN-0002", projectId: project.id, name: "Scan", executionType: "DISCOVERY", environmentId: env.id, initiatedById: user.id } });
  const scan = await prisma.discovery.create({ data: { projectId: project.id, environmentId: env.id, maxPages: 6, testRunId: run.id } });
  const scanning = runDiscovery(scan.id);
  // Cancel the way POST /test-runs/:id/cancel does, once the first page is in.
  for (let i = 0; i < 200 && !discoveryDto(await prisma.discovery.findUniqueOrThrow({ where: { id: scan.id } })).pages.length; i++) await new Promise((r) => setTimeout(r, 50));
  cancel(run.id);
  await prisma.testRun.update({ where: { id: run.id }, data: { status: "CANCELLED" } });
  await scanning;

  const d = await prisma.discovery.findUniqueOrThrow({ where: { id: scan.id } });
  assert.equal(d.status, "CANCELLED");
  assert.equal((await prisma.testRun.findUniqueOrThrow({ where: { id: run.id } })).status, "CANCELLED");
  assert.ok(discoveryDto(d).pages.length >= 1 && discoveryDto(d).pages.length < 6);
  assert.equal(discoveryDto(d).generation, null);
  assert.equal(await prisma.testCase.count({ where: { projectId: project.id } }), 0);
});

test("a scan cancelled while still queued never starts", async () => {
  const { user, project, env } = await setup();
  const run = await prisma.testRun.create({ data: { key: "RUN-0003", projectId: project.id, name: "Scan", executionType: "DISCOVERY", environmentId: env.id, initiatedById: user.id, status: "CANCELLED" } });
  const scan = await prisma.discovery.create({ data: { projectId: project.id, environmentId: env.id, testRunId: run.id } });
  await runDiscovery(scan.id);
  const d = await prisma.discovery.findUniqueOrThrow({ where: { id: scan.id } });
  assert.equal(d.status, "CANCELLED");
  assert.equal(d.startedAt, null);
});

test("the one-scan-at-a-time guard only counts scans the worker is really handling; stale ones are closed out", async () => {
  const { scanInProgress } = await import("../src/routes/projects.js");
  const { enqueue, registerHandler } = await import("../src/services/queue.js");
  const { project, env } = await setup();
  // Left QUEUED by a crash (not in the queue) and RUNNING on a deleted site: neither blocks, both end FAILED.
  const lost = await prisma.discovery.create({ data: { projectId: project.id, environmentId: env.id, status: "QUEUED" } });
  const orphan = await prisma.discovery.create({ data: { projectId: project.id, environmentId: "deleted-site", status: "RUNNING" } });
  const writing = await completedScan(project.id, env.id); // generation PENDING but no job
  assert.equal(await scanInProgress(project.id), false);
  for (const id of [lost.id, orphan.id]) {
    const d = await prisma.discovery.findUniqueOrThrow({ where: { id } });
    assert.equal(d.status, "FAILED");
    assert.ok(d.summary.length > 0 && !/discovery/i.test(d.summary));
  }
  assert.equal(generationDto((await prisma.discovery.findUniqueOrThrow({ where: { id: writing.id } })).generation)!.status, "FAILED");

  // A scan that is actually queued does block.
  const live = await prisma.discovery.create({ data: { projectId: project.id, environmentId: env.id, status: "QUEUED" } });
  let release = () => {};
  registerHandler("scan-checks", () => new Promise<void>((r) => (release = r))); // a job that is still being worked on
  enqueue({ type: "scan-checks", id: live.id });
  assert.equal(await scanInProgress(project.id), true);
  release();
});
