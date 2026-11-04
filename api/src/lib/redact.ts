// Removes secrets from anything that may be stored in logs, reports or sent to the AI provider.
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i;
const SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|credential|private[-_]?key/i;

export function redactText(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[REDACTED]");
  return out
    .replace(/(bearer\s+)[a-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]")
    .replace(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{5,}/g, "[REDACTED_JWT]");
}

export function redactHeaders(headers: Record<string, string>, secrets: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = SENSITIVE_HEADER.test(k) ? "[REDACTED]" : redactText(String(v), secrets);
  return out;
}

export function redactDeep<T>(value: T, secrets: string[] = []): T {
  if (typeof value === "string") return redactText(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) && typeof v === "string" ? "[REDACTED]" : redactDeep(v, secrets);
    return out as T;
  }
  return value;
}
