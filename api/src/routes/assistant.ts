import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import { authenticate } from "../auth.js";
import { chat } from "../services/assistant.js";

export async function assistantRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);
  app.post("/assistant/chat", async (req) => {
    const body = z.object({
      messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20_000) })).min(1).max(50),
      projectId: z.string().optional(),
      confirmations: z.array(z.string()).max(5).optional(),
    }).parse(req.body);
    return chat(req.user, body.messages, body.projectId, body.confirmations);
  });
}
