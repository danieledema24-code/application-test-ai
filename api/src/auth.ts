import type { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { prisma } from "./db.js";
import { config } from "./config.js";
import { HttpError, forbidden } from "./lib/errors.js";

export type AuthUser = { id: string; fullName: string; email: string; role: string; organisationId: string };

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser;
    sessionId: string;
  }
}

export async function issueToken(userId: string) {
  const session = await prisma.session.create({
    data: { userId, expiresAt: new Date(Date.now() + config.sessionHours * 3600_000) },
  });
  return jwt.sign({ sub: userId, sid: session.id }, config.jwtSecret, { expiresIn: `${config.sessionHours}h` });
}

/** Accepts `Authorization: Bearer` or `?token=` (for <img> and download links). */
export async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : (req.query as Record<string, string>)?.token;
  if (!token) throw new HttpError(401, "Authentication required");
  let payload: { sub: string; sid: string };
  try {
    payload = jwt.verify(token, config.jwtSecret) as typeof payload;
  } catch {
    throw new HttpError(401, "Session expired, please log in again");
  }
  const session = await prisma.session.findUnique({ where: { id: payload.sid }, include: { user: true } });
  if (!session || session.revoked || session.expiresAt < new Date()) throw new HttpError(401, "Session expired, please log in again");
  const u = session.user;
  req.user = { id: u.id, fullName: u.fullName, email: u.email, role: u.role, organisationId: u.organisationId };
  req.sessionId = session.id;
}

export function requireAdmin(req: FastifyRequest) {
  if (req.user.role !== "ADMIN") throw forbidden("Administrator role required");
}

/** Loads a project only if it belongs to the caller's workspace (spec NFR-002 / AC-015). */
export async function getProjectForUser(user: AuthUser, projectId: string) {
  const project = await prisma.project.findFirst({ where: { id: projectId, organisationId: user.organisationId } });
  if (!project) throw new HttpError(404, "Project not found");
  return project;
}
