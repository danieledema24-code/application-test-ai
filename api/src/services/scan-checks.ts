import { prisma } from "../db.js";
import { parse, str } from "../lib/json.js";
import { nextKey } from "../lib/keys.js";
import { withLock } from "../lib/lock.js";
import { plural } from "../lib/text.js";
import { recordActivity } from "./activity.js";
import type { DiscoveryResult } from "./discovery.js";
import { caseOrigin, generateCases, type GeneratedCase } from "./generation.js";
import { isAutomatable, pageStructureHint, saveScript, writeScriptCode } from "./scriptgen.js";

// Checks written automatically once a site scan completes (SCAN-1): draft test cases from the pages found,
// each linked to the scan, plus a Playwright script for every case the generator can fully automate.
// Nothing is approved or run here; that stays a user decision.

export type GenerationStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED";
export type Generation = { status: GenerationStatus; total: number; withScript: number; skippedDuplicates: number; done?: number; error?: string };

/** Same defaults as the "Suggest checks" dialog. */
const MAX_CHECKS = 20;

/** The `generation` object on GET /discovery/:id, or null when the scan never reached generation. */
export function generationDto(raw: string | null | undefined): Generation | null {
  const g = parse<Partial<Generation>>(raw, {});
  if (!g.status || !["PENDING", "RUNNING", "DONE", "FAILED"].includes(g.status)) return null;
  return {
    status: g.status, total: g.total ?? 0, withScript: g.withScript ?? 0, skippedDuplicates: g.skippedDuplicates ?? 0,
    ...(g.done !== undefined ? { done: g.done } : {}), ...(g.error ? { error: g.error } : {}),
  };
}

const titleKey = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();

/** Drops cases whose title already exists in the project (or earlier in the batch), ignoring case and spacing. */
export function withoutDuplicates(cases: GeneratedCase[], existingTitles: string[]) {
  const seen = new Set(existingTitles.map(titleKey));
  const fresh: GeneratedCase[] = [];
  for (const c of cases) {
    const k = titleKey(c.title);
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push(c);
  }
  return { fresh, skipped: cases.length - fresh.length };
}

const save = (id: string, g: Generation) => prisma.discovery.update({ where: { id }, data: { generation: str(g) } });

/** Plain reason for the "couldn't write the checks" card; internals stay in the server log. */
function plainReason(err: unknown) {
  const m = err instanceof Error ? err.message : String(err);
  if (/timed? ?out|timeout/i.test(m)) return "Writing the checks took too long";
  if (/anthropic|claude|rate.?limit|overloaded/i.test(m)) return "The writing assistant didn't respond";
  return "Something went wrong while writing the checks";
}

/**
 * Writes checks for a completed scan. Safe to call again (the retry button does): titles that already exist in
 * the project are skipped, so re-scanning unchanged pages adds nothing. Never throws; failures are stored on the
 * scan's generation object and the scan itself stays COMPLETED.
 */
export async function generateChecksForScan(discoveryId: string) {
  const scan = await prisma.discovery.findUnique({ where: { id: discoveryId }, select: { projectId: true } });
  if (!scan) return;
  // One check-writing job per project at a time: existing titles are read inside the lock, so two scans (or
  // two retries) finishing together can't both create the same check.
  return withLock(`scan-checks:${scan.projectId}`, () => writeChecks(discoveryId));
}

async function writeChecks(discoveryId: string) {
  const d = await prisma.discovery.findUnique({ where: { id: discoveryId }, include: { project: true } });
  if (!d || d.status !== "COMPLETED") return;
  const r = parse<Partial<DiscoveryResult>>(d.result, {});
  const pages = r.pages ?? [];
  if (!pages.length) return;
  const g: Generation = { status: "RUNNING", total: 0, withScript: 0, skippedDuplicates: 0, done: 0 };
  await save(d.id, g);
  try {
    const run = d.testRunId ? await prisma.testRun.findUnique({ where: { id: d.testRunId } }) : null;
    const initiator = run?.initiatedById ? await prisma.user.findUnique({ where: { id: run.initiatedById } }) : null;
    const by = initiator?.fullName ?? "the site scan";
    const { cases, generatedBy } = await generateCases({ source: "DISCOVERY", pages, workflows: r.workflows, count: MAX_CHECKS, applicationUrl: d.project.applicationUrl });
    const existing = await prisma.testCase.findMany({ where: { projectId: d.projectId }, select: { title: true } });
    const { fresh } = withoutDuplicates(cases, existing.map((c) => c.title));
    // A retry after a partial failure keeps the checks this scan already wrote and counts them in.
    const linked = { discoveryId: d.id };
    const own = await prisma.testCase.count({ where: linked });
    Object.assign(g, { total: own + fresh.length, done: own, withScript: await prisma.testCase.count({ where: { ...linked, scripts: { some: {} } } }) });
    await save(d.id, g);

    const keys = fresh.length ? await nextKey(d.project.organisationId, "case", fresh.length) : [];
    const hint = pageStructureHint(pages);
    for (const [i, c] of fresh.entries()) {
      const tc = await prisma.testCase.create({
        data: {
          key: keys[i], projectId: d.projectId, discoveryId: d.id, title: c.title, description: c.description, preconditions: c.preconditions,
          steps: str(c.steps), expectedResult: c.expectedResult, category: c.category, priority: c.priority, status: "DRAFT", ...caseOrigin(generatedBy),
        },
      });
      // Only scripts that can run unaided are attached; the rest stay manual checks a person follows.
      const { code, byAi } = await writeScriptCode(tc, hint);
      if (isAutomatable(code)) {
        await saveScript(tc, code, byAi ? `AI (Claude) for ${by}` : `Rule-based generator for ${by}`);
        g.withScript++;
      }
      g.done = own + i + 1;
      await save(d.id, g);
    }
    // Generated cases that are not linked to this scan already existed elsewhere in the project.
    g.skippedDuplicates = Math.max(0, withoutDuplicates(cases, []).fresh.length - g.total);
    g.status = "DONE";
    await save(d.id, g);
    await recordActivity({
      organisationId: d.project.organisationId, projectId: d.projectId, userId: run?.initiatedById ?? null, actionType: "CASES_GENERATED",
      message: `${plural(g.total, "draft check")} written from the site scan (${g.withScript} with an automated test${g.skippedDuplicates ? `, ${g.skippedDuplicates} already existed` : ""}; ${generatedBy === "claude" ? "AI" : "rule-based"})`,
      link: `/projects/${d.projectId}?tab=test-cases&scan=${d.id}`, executionReference: d.id,
    });
  } catch (err) {
    console.error(`[scan-checks] ${discoveryId} failed:`, err);
    await save(d.id, { ...g, status: "FAILED", error: plainReason(err) }).catch(() => {});
  }
}

/** After a restart, generation that was mid-flight is marked failed so the user can press "Try again". */
export async function recoverInterruptedGeneration() {
  const stuck = await prisma.discovery.findMany({ where: { status: "COMPLETED", OR: [{ generation: { contains: '"PENDING"' } }, { generation: { contains: '"RUNNING"' } }] } });
  for (const d of stuck) {
    const g = generationDto(d.generation);
    if (g && (g.status === "PENDING" || g.status === "RUNNING")) await save(d.id, { ...g, status: "FAILED", error: "The server restarted while writing the checks" });
  }
}
