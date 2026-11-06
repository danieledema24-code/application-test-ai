import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod/v4";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { authenticate, issueToken, requireAdmin } from "../auth.js";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { parse } from "../lib/json.js";
import { peopleById, userDto } from "../lib/serialize.js";
import { audit } from "../services/activity.js";

const password = z.string().min(8, "Password must be at least 8 characters").max(200);
const email = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address"));

export async function authRoutes(app: FastifyInstance) {
  // Basic brute-force protection for credential endpoints.
  const attempts = new Map<string, { n: number; until: number }>();
  const throttle = (key: string) => {
    const a = attempts.get(key);
    if (a && a.until > Date.now() && a.n >= 10) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
  };
  const fail = (key: string) => {
    const a = attempts.get(key);
    attempts.set(key, { n: (a && a.until > Date.now() ? a.n : 0) + 1, until: Date.now() + 10 * 60_000 });
  };

  app.post("/auth/register", async (req) => {
    const body = z.object({ fullName: z.string().trim().min(1).max(120), email, password, organisationName: z.string().trim().min(1).max(120) }).parse(req.body);
    if (await prisma.user.findUnique({ where: { email: body.email } })) throw new HttpError(409, "An account with this email already exists");
    const org = await prisma.organisation.create({ data: { name: body.organisationName } });
    const user = await prisma.user.create({
      data: { fullName: body.fullName, email: body.email, passwordHash: await bcrypt.hash(body.password, 12), organisationId: org.id, role: "ADMIN" },
    });
    await audit(org.id, user.id, "user.registered", user.email);
    return { token: await issueToken(user.id), user: userDto(user), organisation: org };
  });

  app.post("/auth/login", async (req) => {
    const body = z.object({ email, password: z.string() }).parse(req.body);
    throttle(`${req.ip}:${body.email}`);
    const user = await prisma.user.findUnique({ where: { email: body.email }, include: { organisation: true } });
    if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
      fail(`${req.ip}:${body.email}`);
      throw new HttpError(401, "Incorrect email or password");
    }
    await audit(user.organisationId, user.id, "user.login", user.email, { ip: req.ip });
    const { organisation, ...u } = user;
    return { token: await issueToken(user.id), user: userDto(u), organisation };
  });

  app.post("/auth/logout", { preHandler: authenticate }, async (req, reply) => {
    await prisma.session.update({ where: { id: req.sessionId }, data: { revoked: true } });
    reply.code(204).send();
  });

  app.get("/auth/me", { preHandler: authenticate }, async (req) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user.id }, include: { organisation: true } });
    const { organisation, ...u } = user;
    return { user: userDto(u), organisation };
  });

  app.post("/auth/forgot-password", async (req) => {
    const { email: addr } = z.object({ email }).parse(req.body);
    throttle(`reset:${req.ip}`);
    fail(`reset:${req.ip}`);
    const user = await prisma.user.findUnique({ where: { email: addr } });
    // Always 200 so the endpoint cannot be used to enumerate accounts.
    if (!user) return { ok: true };
    const token = randomToken();
    await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600_000) } });
    const link = `${config.webOrigin}/reset-password?token=${token}`;
    // No SMTP provider is configured in the MVP; in dev the link is returned and logged.
    if (config.devMode) console.log(`[auth] password reset link for ${addr}: ${link}`);
    return config.devMode ? { ok: true, devResetLink: link } : { ok: true };
  });

  app.post("/auth/reset-password", async (req) => {
    const body = z.object({ token: z.string().min(10), password }).parse(req.body);
    const rec = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(body.token) }, include: { user: true } });
    if (!rec || rec.usedAt || rec.expiresAt < new Date()) throw badRequest("This reset link is invalid or has expired");
    await prisma.$transaction([
      prisma.user.update({ where: { id: rec.userId }, data: { passwordHash: await bcrypt.hash(body.password, 12) } }),
      // Spend every outstanding link for this user, not just the one used, so older emails stop working.
      prisma.passwordResetToken.updateMany({ where: { userId: rec.userId, usedAt: null }, data: { usedAt: new Date() } }),
      prisma.session.updateMany({ where: { userId: rec.userId }, data: { revoked: true } }),
    ]);
    await audit(rec.user.organisationId, rec.userId, "user.password_reset", rec.user.email);
    return { ok: true };
  });

  // ---- Workspace members & audit log ----
  app.get("/workspace/members", { preHandler: authenticate }, async (req) => {
    const users = await prisma.user.findMany({ where: { organisationId: req.user.organisationId }, orderBy: { createdAt: "asc" } });
    return users.map(userDto);
  });

  app.post("/workspace/members", { preHandler: authenticate }, async (req) => {
    requireAdmin(req);
    const body = z.object({ fullName: z.string().trim().min(1), email, role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER"), password }).parse(req.body);
    if (await prisma.user.findUnique({ where: { email: body.email } })) throw new HttpError(409, "An account with this email already exists");
    const user = await prisma.user.create({
      data: { fullName: body.fullName, email: body.email, role: body.role, passwordHash: await bcrypt.hash(body.password, 12), organisationId: req.user.organisationId },
    });
    await audit(req.user.organisationId, req.user.id, "member.added", user.email, { role: body.role });
    return userDto(user);
  });

  app.patch("/workspace/members/:id", { preHandler: authenticate }, async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const { role } = z.object({ role: z.enum(["ADMIN", "MEMBER"]) }).parse(req.body);
    const target = await prisma.user.findFirst({ where: { id, organisationId: req.user.organisationId } });
    if (!target) throw notFound("Member");
    if (target.role === "ADMIN" && role === "MEMBER" && (await prisma.user.count({ where: { organisationId: req.user.organisationId, role: "ADMIN" } })) === 1)
      throw badRequest("A workspace must keep at least one administrator");
    const user = await prisma.user.update({ where: { id }, data: { role } });
    await audit(req.user.organisationId, req.user.id, "member.role_changed", user.email, { role });
    return userDto(user);
  });

  app.delete("/workspace/members/:id", { preHandler: authenticate }, async (req, reply) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    if (id === req.user.id) throw badRequest("You cannot remove yourself");
    const target = await prisma.user.findFirst({ where: { id, organisationId: req.user.organisationId } });
    if (!target) throw notFound("Member");
    await prisma.user.delete({ where: { id } });
    await audit(req.user.organisationId, req.user.id, "member.removed", target.email);
    reply.code(204).send();
  });

  app.get("/workspace/audit-log", { preHandler: authenticate }, async (req) => {
    requireAdmin(req);
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 100), 500);
    const logs = await prisma.auditLog.findMany({ where: { organisationId: req.user.organisationId }, orderBy: { createdAt: "desc" }, take: limit });
    const people = await peopleById(logs.map((l) => l.actorId));
    return logs.map((l) => ({ id: l.id, action: l.action, actor: people.get(l.actorId ?? "") ?? null, target: l.target, metadata: parse(l.metadata, {}), createdAt: l.createdAt }));
  });
}
