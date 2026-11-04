import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { ZodError } from "zod/v4";
import { Prisma } from "@prisma/client";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { HttpError } from "./lib/errors.js";
import { authRoutes } from "./routes/auth.js";
import { projectRoutes } from "./routes/projects.js";
import { testingRoutes } from "./routes/testing.js";
import { workspaceRoutes } from "./routes/workspace.js";
import { assistantRoutes } from "./routes/assistant.js";
import { enqueue, registerHandler } from "./services/queue.js";
import { executeApiRun, executeAutomatedRun, recoverInterruptedRuns } from "./services/runner.js";
import { runDiscovery } from "./services/discovery.js";
import { aiStatus } from "./services/ai.js";

export async function buildApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.authorization"] }, bodyLimit: 5 * 1024 * 1024 });
  await app.register(cors, { origin: config.webOrigin.split(","), credentials: true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  // Treat an empty JSON body (common for bodiless POST actions) as {} instead of a 400.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, body === "" ? {} : JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error("Request body is not valid JSON"), { statusCode: 400 }), undefined);
    }
  });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff").header("x-frame-options", "DENY").header("referrer-policy", "no-referrer");
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      const details = err.details as Record<string, unknown> | undefined;
      return reply.code(err.status).send({ error: err.message, ...(details && typeof details === "object" && !Array.isArray(details) ? details : details ? { details } : {}) });
    }
    if (err instanceof ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), details: err.issues });
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") return reply.code(404).send({ error: "Not found" });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.code(500).send({ error: "Something went wrong. The error has been logged." });
  });

  app.get("/api/health", async () => ({ ok: true, ai: aiStatus() }));
  for (const routes of [authRoutes, projectRoutes, testingRoutes, workspaceRoutes, assistantRoutes]) await app.register(routes, { prefix: "/api" });
  return app;
}

registerHandler("automated-run", (job) => executeAutomatedRun(job.id));
registerHandler("api-run", (job) => executeApiRun(job.id));
registerHandler("discovery", (job) => runDiscovery(job.id));

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server.ts");
if (isMain) {
  const app = await buildApp();
  await recoverInterruptedRuns((type, id) => enqueue({ type, id }));
  for (const d of await prisma.discovery.findMany({ where: { status: "QUEUED" } })) enqueue({ type: "discovery", id: d.id });
  await app.listen({ port: config.port, host: "127.0.0.1" });
  app.log.info(`AI: ${aiStatus().enabled ? `enabled (${aiStatus().model})` : "not configured — using labelled heuristic fallbacks"}`);
}
