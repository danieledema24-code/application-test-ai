import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod/v4";
import { config } from "../config.js";
import { redactDeep, redactText } from "../lib/redact.js";

// All Claude calls go through here so that (a) prompts are redacted before they leave the
// process (spec NFR-007, §13.6) and (b) callers fall back to labelled heuristics when AI is off.

let client: Anthropic | null = null;
export function getClient(): Anthropic | null {
  if (!config.aiEnabled) return null;
  client ??= new Anthropic();
  return client;
}

export const aiStatus = () => ({ enabled: config.aiEnabled, model: config.aiEnabled ? config.aiModel : null });

const BASE_SYSTEM =
  "You are the AI engine inside Application Test AI, a software QA platform. Be precise and concise. " +
  "Never claim coverage, results or certainty you do not have: recorded test results are the source of truth, " +
  "and your analysis is a hypothesis until a human confirms it.";

// Server-side refusal fallback: if a request is declined, the API re-runs it on a fallback model.
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };

/**
 * Structured output call. Returns null when AI is disabled or the call fails, so every
 * caller must have a deterministic fallback path.
 */
export async function aiJSON<S extends z.ZodType>(opts: {
  schema: S;
  task: string;
  input: unknown;
  secrets?: string[];
  effort?: "low" | "medium" | "high";
}): Promise<z.infer<S> | null> {
  const c = getClient();
  if (!c) return null;
  const input = typeof opts.input === "string" ? redactText(opts.input, opts.secrets) : JSON.stringify(redactDeep(opts.input, opts.secrets), null, 1);
  try {
    const res = await c.beta.messages.parse({
      model: config.aiModel,
      max_tokens: 16000,
      ...FALLBACK,
      output_config: { effort: opts.effort ?? "medium", format: betaZodOutputFormat(opts.schema) },
      system: BASE_SYSTEM,
      messages: [{ role: "user", content: `${opts.task}\n\n<input>\n${input}\n</input>` }],
    });
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") return null;
    return (res.parsed_output as z.infer<S> | null) ?? null;
  } catch (err) {
    console.error("[ai] structured call failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export type ToolDef = Anthropic.Beta.BetaTool;

/** One turn of the assistant's tool loop; the loop itself lives in services/assistant.ts. */
export async function aiToolTurn(system: string, messages: Anthropic.Beta.BetaMessageParam[], tools: ToolDef[]) {
  const c = getClient();
  if (!c) throw new Error("AI disabled");
  return c.beta.messages.create({
    model: config.aiModel,
    max_tokens: 16000,
    ...FALLBACK,
    output_config: { effort: "medium" },
    system: `${BASE_SYSTEM}\n\n${system}`,
    tools,
    messages,
  });
}
