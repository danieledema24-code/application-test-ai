import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// SCAN-1 QA: edge cases for automatic check writing (concurrency, legacy scans, retry states). Throwaway SQLite database.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ata-scanqa-"));
process.env.DATABASE_URL = `file:${path.join(tmp, "test.db")}`;
process.env.STORAGE_DIR = path.join(tmp, "storage");
process.env.JWT_SECRET ??= "test";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.ANTHROPIC_API_KEY = "";
process.env.ANTHROPIC_AUTH_TOKEN = "";
execSync("npx prisma db push --skip-generate", { cwd: path.resolve(import.meta.dirname, ".."), env: process.env, stdio: "ignore" });

const { prisma } = await import("../src/db.js");
const { discoveryDto } = await import("../src/services/discovery.js");
const { generateChecksForScan, generationDto, recoverInterruptedGeneration } = await import("../src/services/scan-checks.js");

const base = "https://shop.example.com";
const pages = [
  { url: `${base}/`, title: "Shop", status: 200, depth: 0, links: [`${base}/contact`], buttons: [], forms: [], navItems: ["Contact"], headings: ["Welcome"], screenshotEvidenceId: null },
  {
    url: `${base}/contact`, title: "Contact us", status: 200, depth: 1, links: [], buttons: ["Send"], navItems: ["Contact"], headings: ["Contact us"], screenshotEvidenceId: null,
    forms: [{ action: `${base}/contact`, method: "POST", fields: [{ name: "email", type: "email", label: "Email", required: true }] }],
  },
];

async function setup() {
  const org = await prisma.organisation.create({ data: { name: "Acme" } });
  const project = await prisma.project.create({ data: { organisationId: org.id, name: "Shop", applicationUrl: base } });
  const env = await prisma.environment.create({ data: { projectId: project.id, name: "STAGING", baseUrl: base, authorised: true } });
  return { org, project, env };
}
const scan = (projectId: string, environmentId: string, generation = "{}") =>
  prisma.discovery.create({ data: { projectId, environmentId, status: "COMPLETED", completedAt: new Date(), result: JSON.stringify({ pages, workflows: [] }), generation } });
const dupTitles = async (projectId: string) => {
  const t = (await prisma.testCase.findMany({ where: { projectId }, select: { title: true } })).map((c) => c.title.trim().toLowerCase());
  return t.length - new Set(t).size;
};

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("an older scan (no generation yet) reports generation: null, and writing checks for it works", async () => {
  const { project, env } = await setup();
  const d = await scan(project.id, env.id);
  assert.equal(discoveryDto(d).generation, null);
  await generateChecksForScan(d.id);
  const g = generationDto((await prisma.discovery.findUniqueOrThrow({ where: { id: d.id } })).generation)!;
  assert.equal(g.status, "DONE");
  assert.ok(g.total > 0);
});

test("generation is skipped for scans that are not COMPLETED or have no pages", async () => {
  const { project, env } = await setup();
  const failed = await prisma.discovery.create({ data: { projectId: project.id, environmentId: env.id, status: "FAILED", result: JSON.stringify({ pages }) } });
  const empty = await prisma.discovery.create({ data: { projectId: project.id, environmentId: env.id, status: "COMPLETED", result: JSON.stringify({ pages: [] }) } });
  await generateChecksForScan(failed.id);
  await generateChecksForScan(empty.id);
  assert.equal(await prisma.testCase.count({ where: { projectId: project.id } }), 0);
  assert.equal(generationDto((await prisma.discovery.findUniqueOrThrow({ where: { id: failed.id } })).generation), null);
});

test("restart recovery marks in-flight generation FAILED with a plain reason and leaves DONE alone", async () => {
  const { project, env } = await setup();
  const stuck = await scan(project.id, env.id, JSON.stringify({ status: "RUNNING", total: 3, withScript: 1, skippedDuplicates: 0, done: 1 }));
  const done = await scan(project.id, env.id, JSON.stringify({ status: "DONE", total: 3, withScript: 1, skippedDuplicates: 0 }));
  await recoverInterruptedGeneration();
  const g = generationDto((await prisma.discovery.findUniqueOrThrow({ where: { id: stuck.id } })).generation)!;
  assert.equal(g.status, "FAILED");
  assert.match(g.error ?? "", /restarted/);
  assert.equal(generationDto((await prisma.discovery.findUniqueOrThrow({ where: { id: done.id } })).generation)!.status, "DONE");
});

test("the same scan written twice at once (double-click / two tabs on Try again) creates no duplicate checks", async () => {
  const { project, env } = await setup();
  const d = await scan(project.id, env.id);
  await Promise.all([generateChecksForScan(d.id), generateChecksForScan(d.id)]);
  assert.equal(await dupTitles(project.id), 0, "duplicate titles in the project");
});

test("two scans of the same project finishing together create no duplicate checks", async () => {
  const { project, env } = await setup();
  const a = await scan(project.id, env.id), b = await scan(project.id, env.id);
  await Promise.all([generateChecksForScan(a.id), generateChecksForScan(b.id)]);
  assert.equal(await dupTitles(project.id), 0, "duplicate titles in the project");
});

test("the per-project lock is released when the locked work throws", async () => {
  const { withLock } = await import("../src/lib/lock.js");
  await assert.rejects(withLock("qa-key", async () => { throw new Error("boom"); }), /boom/);
  const order: string[] = [];
  await Promise.all([
    withLock("qa-key", async () => { order.push("a1"); await new Promise((r) => setTimeout(r, 30)); order.push("a2"); }),
    withLock("qa-key", async () => { order.push("b"); }),
  ]);
  assert.deepEqual(order, ["a1", "a2", "b"], "second caller runs after the first, not alongside it");
  assert.equal(await withLock("qa-key", async () => 42), 42);
});

test("a queued scan whose site was deleted does not stay QUEUED (it would block every future scan with 409)", async () => {
  const { runDiscovery } = await import("../src/services/discovery.js");
  const { project } = await setup();
  const d = await prisma.discovery.create({ data: { projectId: project.id, environmentId: "deleted-environment", status: "QUEUED" } });
  await runDiscovery(d.id).catch(() => {});
  const after = await prisma.discovery.findUniqueOrThrow({ where: { id: d.id } });
  assert.ok(!["QUEUED", "RUNNING"].includes(after.status), `scan left as ${after.status}`);
});
