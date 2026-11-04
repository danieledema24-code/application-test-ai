import crypto from "node:crypto";
import { prisma } from "../db.js";
import { decrypt } from "../lib/crypto.js";
import { parse, str } from "../lib/json.js";

type ActivityInput = {
  organisationId: string;
  projectId?: string | null;
  userId?: string | null;
  actionType: string;
  message: string;
  viaAI?: boolean;
  link?: string | null;
  executionReference?: string | null;
  actionStatus?: string;
};

export async function recordActivity(a: ActivityInput) {
  return prisma.aIActivity.create({
    data: {
      organisationId: a.organisationId,
      projectId: a.projectId ?? null,
      userId: a.userId ?? null,
      actionType: a.actionType,
      message: a.message,
      viaAI: a.viaAI ?? false,
      link: a.link ?? null,
      executionReference: a.executionReference ?? null,
      actionStatus: a.actionStatus ?? "DONE",
    },
  });
}

export async function audit(organisationId: string, actorId: string | null, action: string, target = "", metadata: unknown = {}) {
  await prisma.auditLog.create({ data: { organisationId, actorId, action, target, metadata: str(metadata) } });
}

export async function notify(userId: string, title: string, body = "", link: string | null = null) {
  await prisma.notification.create({ data: { userId, title, body, link } });
}

export type WebhookEvent = "run.started" | "run.completed" | "test.failed" | "defect.created" | "report.generated";

/** Fire-and-forget delivery with an HMAC-SHA256 signature header. */
export function emitWebhook(organisationId: string, event: WebhookEvent, payload: unknown) {
  void (async () => {
    const hooks = await prisma.webhook.findMany({ where: { organisationId, active: true } });
    for (const hook of hooks) {
      if (!parse<string[]>(hook.events, []).includes(event)) continue;
      const body = JSON.stringify({ event, createdAt: new Date().toISOString(), data: payload });
      const signature = crypto.createHmac("sha256", decrypt(hook.encryptedSecret)).update(body).digest("hex");
      let statusCode: number | null = null;
      try {
        const res = await fetch(hook.url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-ata-event": event, "x-ata-signature": `sha256=${signature}` },
          body,
          signal: AbortSignal.timeout(5000),
        });
        statusCode = res.status;
      } catch {
        statusCode = null;
      }
      await prisma.webhookDelivery.create({
        data: { webhookId: hook.id, event, statusCode, success: statusCode !== null && statusCode < 300 },
      });
    }
  })().catch(() => {});
}
