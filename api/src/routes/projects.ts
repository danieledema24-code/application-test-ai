import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod/v4";
import { prisma } from "../db.js";
import { authenticate, getProjectForUser } from "../auth.js";
import { badRequest, forbidden, HttpError, notFound } from "../lib/errors.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { parse, provided, str } from "../lib/json.js";
import { nextKey } from "../lib/keys.js";
import { assertSafeTarget } from "../lib/ssrf.js";
import { deletePrefix } from "../lib/storage.js";
import { environmentDto, projectDto, projectStats, runDtos, runInclude } from "../lib/serialize.js";
import { audit, recordActivity } from "../services/activity.js";
import { discoveryDto } from "../services/discovery.js";
import { withLock } from "../lib/lock.js";
import { generationDto } from "../services/scan-checks.js";

/** Generation JSON that is still waiting or being written (stored as text, see services/scan-checks.ts). */
const GENERATION_BUSY = [{ generation: { contains: '"status":"PENDING"' } }, { generation: { contains: '"status":"RUNNING"' } }];
import { enqueue, isQueued } from "../services/queue.js";

const ENV_NAMES = ["DEVELOPMENT", "STAGING", "PRODUCTION"] as const;
const url = z.string().trim().pipe(z.url({ protocol: /^https?$/, error: "Enter a full http(s) URL" }));
const credentials = z.object({
  username: z.string().optional(), password: z.string().optional(), apiKey: z.string().optional(), bearerToken: z.string().optional(), apiKeyHeader: z.string().optional(),
  playwrightWsEndpoint: z.string().trim().regex(/^wss?:\/\//, "Remote Playwright endpoint must start with ws:// or wss://").or(z.literal("")).optional(),
}).partial();

/** Credentials are write-only, so updates merge into what is stored; an empty string clears that one value. */
function mergeCredentials(stored: string | null, update: Record<string, string | undefined>) {
  const merged: Record<string, string> = { ...(stored ? parse<Record<string, string>>(decrypt(stored), {}) : {}) };
  for (const [k, v] of Object.entries(update)) {
    if (v === undefined) continue;
    if (v === "") delete merged[k];
    else merged[k] = v;
  }
  return Object.keys(merged).length ? encrypt(JSON.stringify(merged)) : null;
}

/** The remote browser endpoint is network-reachable infrastructure, so it gets the same SSRF guard as targets. */
async function checkCredentials(c: z.infer<typeof credentials> | undefined) {
  if (c?.playwrightWsEndpoint) await assertSafeTarget(c.playwrightWsEndpoint.replace(/^ws/, "http"));
}

/**
 * Whether a scan (or the check writing after it) is really in progress for the project. Scans the worker no
 * longer knows about (lost in a crash, or their site was deleted) are closed out here instead of blocking
 * every future scan.
 */
export async function scanInProgress(projectId: string) {
  const open = await prisma.discovery.findMany({ where: { projectId, OR: [{ status: { in: ["QUEUED", "RUNNING"] } }, { status: "COMPLETED", OR: GENERATION_BUSY }] } });
  let busy = false;
  for (const d of open) {
    const envExists = (await prisma.environment.count({ where: { id: d.environmentId } })) > 0;
    if (envExists && isQueued(d.id)) {
      busy = true;
      continue;
    }
    const reason = envExists ? "The scan was interrupted before it finished." : "The site was removed before the scan could finish.";
    if (d.status === "COMPLETED") {
      const g = generationDto(d.generation);
      await prisma.discovery.update({ where: { id: d.id }, data: { generation: str({ ...g, status: "FAILED", error: "Writing the checks was interrupted" }) } });
    } else {
      const r = parse<{ limitations?: string[] }>(d.result, {});
      await prisma.discovery.update({ where: { id: d.id }, data: { status: "FAILED", summary: reason, completedAt: new Date(), result: str({ ...r, current: undefined, limitations: [...(r.limitations ?? []), reason], stoppedEarly: true }) } });
      if (d.testRunId) await prisma.testRun.updateMany({ where: { id: d.testRunId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "ERROR", completedAt: new Date() } });
    }
  }
  return busy;
}

export async function projectRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.get("/projects", async (req) => {
    const { search } = req.query as { search?: string };
    const projects = await prisma.project.findMany({
      where: { organisationId: req.user.organisationId, ...(search ? { name: { contains: search } } : {}) },
      include: { environments: true }, orderBy: { updatedAt: "desc" },
    });
    return Promise.all(projects.map(async (p) => ({ ...projectDto(p), stats: await projectStats(p.id) })));
  });

  app.post("/projects", async (req) => {
    const body = z.object({
      name: z.string().trim().min(1).max(120), description: z.string().max(2000).default(""), applicationUrl: url,
      applicationType: z.enum(["WEB", "API"]).default("WEB"),
      environments: z.array(z.object({ name: z.enum(ENV_NAMES), baseUrl: url })).optional(),
      // "I own this site or have permission to test it", ticked when the project is created.
      authorised: z.boolean().optional(),
    }).parse(req.body);
    const envs = body.environments?.length ? body.environments : [{ name: "STAGING" as const, baseUrl: body.applicationUrl }];
    if (body.authorised) for (const e of envs) requireAdminForProduction(req, e.name, { authorised: true });
    for (const u of new Set([body.applicationUrl, ...envs.map((e) => e.baseUrl)])) await assertSafeTarget(u);
    const project = await prisma.project.create({
      data: {
        organisationId: req.user.organisationId, name: body.name, description: body.description, applicationUrl: body.applicationUrl, applicationType: body.applicationType,
        environments: { create: envs.map((e) => ({ name: e.name, baseUrl: e.baseUrl, allowDestructive: e.name !== "PRODUCTION", ...authorisation(body.authorised ?? false, req.user.id) })) },
      },
      include: { environments: true },
    });
    await recordActivity({ organisationId: req.user.organisationId, projectId: project.id, userId: req.user.id, actionType: "PROJECT_CREATED", message: `Project ${project.name} created`, link: `/projects/${project.id}` });
    await audit(req.user.organisationId, req.user.id, "project.created", project.name, { authorised: body.authorised ?? false });
    return { ...projectDto(project), stats: await projectStats(project.id) };
  });

  app.get("/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    await getProjectForUser(req.user, id);
    const project = await prisma.project.findUniqueOrThrow({ where: { id }, include: { environments: { orderBy: { createdAt: "asc" } } } });
    const runs = await prisma.testRun.findMany({ where: { projectId: id, executionType: { not: "DISCOVERY" } }, include: runInclude, orderBy: { createdAt: "desc" }, take: 10 });
    const discovery = await prisma.discovery.findFirst({ where: { projectId: id }, orderBy: { createdAt: "desc" } });
    return { ...projectDto(project), stats: await projectStats(id), recentRuns: await runDtos(runs), discovery: discovery ? discoveryDto(discovery) : null };
  });

  app.patch("/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    await getProjectForUser(req.user, id);
    const body = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(2000), applicationUrl: url, applicationType: z.enum(["WEB", "API"]) }).partial().parse(req.body);
    if (body.applicationUrl) await assertSafeTarget(body.applicationUrl);
    const project = await prisma.project.update({ where: { id }, data: body, include: { environments: true } });
    await audit(req.user.organisationId, req.user.id, "project.updated", project.name, body);
    return projectDto(project);
  });

  // FR-015 + NFR-007: deletion requires typing the project name and removes all associated data and evidence.
  app.delete("/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = await getProjectForUser(req.user, id);
    const { confirmName } = z.object({ confirmName: z.string() }).parse(req.body ?? {});
    if (confirmName !== project.name) throw badRequest("Type the project name exactly to confirm deletion");
    await prisma.project.delete({ where: { id } });
    await deletePrefix(`${req.user.organisationId}/${id}`);
    await audit(req.user.organisationId, req.user.id, "project.deleted", project.name);
    reply.code(204).send();
  });

  // ---- Environments ----
  const envBody = z.object({
    name: z.enum(ENV_NAMES), baseUrl: url, configuration: z.record(z.string(), z.unknown()).optional(), credentials: credentials.optional(),
    authorised: z.boolean().optional(), allowDestructive: z.boolean().optional(),
  });

  // Production is the admin's call: authorising a production target or allowing destructive tests on it needs the
  // ADMIN role. Only turning a flag on counts, so re-sending the current value (as the edit form does) is fine.
  const requireAdminForProduction = (req: FastifyRequest, name: string, body: { authorised?: boolean; allowDestructive?: boolean }, current?: { authorised: boolean; allowDestructive: boolean }) => {
    if (name !== "PRODUCTION") return;
    if ((body.authorised === true && !current?.authorised) || (body.allowDestructive === true && !current?.allowDestructive)) {
      if (req.user.role !== "ADMIN") throw forbidden("Only workspace admins can authorise production or allow destructive tests on it");
    }
  };

  const authorisation = (authorised: boolean | undefined, userId: string) =>
    authorised === undefined ? {} : { authorised, authorisedById: authorised ? userId : null, authorisedAt: authorised ? new Date() : null };

  app.post("/projects/:id/environments", async (req) => {
    const { id } = req.params as { id: string };
    await getProjectForUser(req.user, id);
    const body = envBody.parse(req.body);
    requireAdminForProduction(req, body.name, body);
    await assertSafeTarget(body.baseUrl);
    await checkCredentials(body.credentials);
    const env = await prisma.environment.create({
      data: {
        projectId: id, name: body.name, baseUrl: body.baseUrl, configuration: str(body.configuration ?? {}),
        encryptedCredentials: body.credentials && Object.values(body.credentials).some(Boolean) ? encrypt(JSON.stringify(body.credentials)) : null,
        allowDestructive: body.allowDestructive ?? body.name !== "PRODUCTION", ...authorisation(body.authorised ?? false, req.user.id),
      },
    });
    await audit(req.user.organisationId, req.user.id, "environment.created", `${body.name} ${body.baseUrl}`, { authorised: env.authorised });
    return environmentDto(env);
  });

  const envForUser = async (userOrg: string, envId: string) => {
    const env = await prisma.environment.findFirst({ where: { id: envId, project: { organisationId: userOrg } } });
    if (!env) throw notFound("Environment");
    return env;
  };

  app.patch("/environments/:id", async (req) => {
    const { id } = req.params as { id: string };
    const existing = await envForUser(req.user.organisationId, id);
    const body = provided(envBody.partial().parse(req.body), req.body);
    // Changing the target URL withdraws the authorisation confirmation for the old one.
    const urlChanged = body.baseUrl && body.baseUrl !== existing.baseUrl;
    const becomesProd = body.name === "PRODUCTION" && existing.name !== "PRODUCTION";
    requireAdminForProduction(req, body.name ?? existing.name, body, {
      authorised: existing.authorised && !urlChanged && !becomesProd, allowDestructive: existing.allowDestructive && !becomesProd,
    });
    if (body.baseUrl) await assertSafeTarget(body.baseUrl);
    await checkCredentials(body.credentials);
    const env = await prisma.environment.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name } : {}), ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
        ...(body.configuration ? { configuration: str(body.configuration) } : {}),
        ...(body.credentials ? { encryptedCredentials: mergeCredentials(existing.encryptedCredentials, body.credentials) } : {}),
        ...(body.allowDestructive !== undefined ? { allowDestructive: body.allowDestructive }
          // Becoming PRODUCTION switches destructive tests off unless an admin explicitly keeps them on.
          : becomesProd ? { allowDestructive: false } : {}),
        ...authorisation(urlChanged && body.authorised === undefined ? false : body.authorised, req.user.id),
      },
    });
    await audit(req.user.organisationId, req.user.id, "environment.updated", `${env.name} ${env.baseUrl}`, { credentialsChanged: Boolean(body.credentials), authorised: env.authorised, allowDestructive: env.allowDestructive });
    return environmentDto(env);
  });

  app.delete("/environments/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const env = await envForUser(req.user.organisationId, id);
    await prisma.environment.delete({ where: { id } });
    await audit(req.user.organisationId, req.user.id, "environment.deleted", `${env.name} ${env.baseUrl}`);
    reply.code(204).send();
  });

  // ---- Discovery ----
  app.post("/projects/:id/discovery", async (req) => {
    const { id } = req.params as { id: string };
    await getProjectForUser(req.user, id);
    const body = z.object({ environmentId: z.string(), maxPages: z.number().int().min(1).max(50).default(15), useCredentials: z.boolean().default(false) }).parse(req.body);
    const env = await prisma.environment.findFirst({ where: { id: body.environmentId, projectId: id } });
    if (!env) throw notFound("Environment");
    if (!env.authorised) throw new HttpError(409, `Confirm that you are authorised to test ${env.baseUrl} before running discovery (Environments tab).`);
    await assertSafeTarget(env.baseUrl);
    // One scan per project at a time, including the check writing that follows it. The check and the create
    // happen under one lock so two clicks can't both start a scan.
    const { run, d } = await withLock(`scan-start:${id}`, async () => {
      if (await scanInProgress(id)) throw new HttpError(409, "A scan of this site is already in progress. Wait for it to finish, then scan again.");
      const [key] = await nextKey(req.user.organisationId, "run");
      const run = await prisma.testRun.create({ data: { key, projectId: id, name: `Discovery of ${env.baseUrl}`, executionType: "DISCOVERY", environmentId: env.id, initiatedById: req.user.id } });
      const d = await prisma.discovery.create({ data: { projectId: id, environmentId: env.id, maxPages: body.maxPages, useCredentials: body.useCredentials, testRunId: run.id } });
      // Enqueued inside the lock so the next request sees this scan as in progress, not stale.
      enqueue({ type: "discovery", id: d.id });
      return { run, d };
    });
    await audit(req.user.organisationId, req.user.id, "discovery.started", env.baseUrl);
    return { discoveryId: d.id, runId: run.id };
  });

  app.get("/projects/:id/discovery", async (req) => {
    const { id } = req.params as { id: string };
    await getProjectForUser(req.user, id);
    const d = await prisma.discovery.findFirst({ where: { projectId: id }, orderBy: { createdAt: "desc" } });
    return d ? discoveryDto(d) : null;
  });

  app.get("/discovery/:id", async (req) => {
    const { id } = req.params as { id: string };
    const d = await prisma.discovery.findFirst({ where: { id, project: { organisationId: req.user.organisationId } } });
    if (!d) throw notFound("Discovery");
    return discoveryDto(d);
  });

  // "Try again" after automatic check writing failed (or to write checks for an older scan). Duplicates are skipped.
  app.post("/discovery/:id/generate", async (req) => {
    const { id } = req.params as { id: string };
    const d = await prisma.discovery.findFirst({ where: { id, project: { organisationId: req.user.organisationId } } });
    if (!d) throw notFound("Discovery");
    if (d.status !== "COMPLETED") throw badRequest("The scan has to finish before checks can be written");
    if (!parse<{ pages?: unknown[] }>(d.result, {}).pages?.length) throw badRequest("The scan found no pages to write checks for");
    // Claimed atomically: of two clicks at once, only one moves the scan to PENDING; the other gets 409.
    const claimed = await prisma.discovery.updateMany({
      where: { id, status: "COMPLETED", NOT: GENERATION_BUSY },
      data: { generation: str({ status: "PENDING", total: 0, withScript: 0, skippedDuplicates: 0 }) },
    });
    if (!claimed.count) throw new HttpError(409, "Checks for this scan are already being written");
    const updated = await prisma.discovery.findUniqueOrThrow({ where: { id } });
    enqueue({ type: "scan-checks", id });
    await audit(req.user.organisationId, req.user.id, "discovery.generate", id);
    return discoveryDto(updated);
  });
}
