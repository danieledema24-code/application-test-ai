import type { ApiEndpoint, Environment } from "@prisma/client";
import { decrypt } from "../lib/crypto.js";
import { parse } from "../lib/json.js";
import { redactDeep, redactHeaders, redactText } from "../lib/redact.js";
import { assertSafeTarget } from "../lib/ssrf.js";

export type ApiSpec = {
  method: string; path: string; headers?: Record<string, string>; query?: Record<string, string>; body?: unknown;
  auth?: "NONE" | "BEARER" | "API_KEY" | "BASIC"; expectedStatus?: number; maxResponseMs?: number;
  requiredFields?: string[]; jsonSchema?: Record<string, unknown> | null; bodyContains?: string[];
  expectedHeaders?: Record<string, string>; omitAuth?: boolean; invalidAuth?: boolean;
};

export type Assertion = { name: string; passed: boolean; message: string };
export type ApiExchange = {
  request: { method: string; url: string; headers: Record<string, string>; body?: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown; timeMs: number } | null;
  assertions: Assertion[];
};

export const DESTRUCTIVE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
type Creds = { username?: string; password?: string; apiKey?: string; bearerToken?: string; apiKeyHeader?: string };

export function envCredentials(env: Environment): Creds {
  return env.encryptedCredentials ? parse<Creds>(decrypt(env.encryptedCredentials), {}) : {};
}
export const secretValues = (c: Creds) => [c.password, c.apiKey, c.bearerToken].filter(Boolean) as string[];

export function endpointToSpec(e: ApiEndpoint): ApiSpec {
  return {
    method: e.method, path: e.path, headers: parse(e.headers, {}), query: parse(e.query, {}), body: parse(e.body, undefined),
    auth: e.auth as ApiSpec["auth"], expectedStatus: e.expectedStatus, maxResponseMs: e.maxResponseMs,
    requiredFields: parse(e.requiredFields, []), jsonSchema: responseSchema(e),
  };
}

/** Stored jsonSchema may carry the OpenAPI request schema under x-request-schema; split the two. */
export function responseSchema(e: ApiEndpoint): Record<string, unknown> | null {
  const { "x-request-schema": _req, ...rest } = parse<Record<string, unknown>>(e.jsonSchema, {});
  return Object.keys(rest).length ? rest : null;
}
export const requestSchema = (e: ApiEndpoint) => parse<Record<string, unknown>>(e.jsonSchema, {})["x-request-schema"] as Record<string, unknown> | null ?? null;

/** Executes one request and evaluates its assertions. Credentials are injected here and redacted from the returned exchange. */
export async function executeApi(spec: ApiSpec, env: Environment): Promise<ApiExchange> {
  const creds = envCredentials(env);
  const secrets = secretValues(creds);
  const url = new URL(spec.path.replace(/^\//, ""), env.baseUrl.endsWith("/") ? env.baseUrl : `${env.baseUrl}/`);
  for (const [k, v] of Object.entries(spec.query ?? {})) url.searchParams.set(k, String(v));
  await assertSafeTarget(url.toString());

  const headers: Record<string, string> = { accept: "application/json", ...(spec.headers ?? {}) };
  if (!spec.omitAuth) {
    const bad = spec.invalidAuth;
    if (spec.auth === "BEARER" && (creds.bearerToken || bad)) headers.authorization = `Bearer ${bad ? "invalid-token-ata" : creds.bearerToken}`;
    if (spec.auth === "API_KEY" && (creds.apiKey || bad)) headers[creds.apiKeyHeader ?? "x-api-key"] = bad ? "invalid-key-ata" : creds.apiKey!;
    if (spec.auth === "BASIC" && (creds.username || bad))
      headers.authorization = `Basic ${Buffer.from(bad ? "invalid:invalid" : `${creds.username}:${creds.password ?? ""}`).toString("base64")}`;
  }
  let bodyText: string | undefined;
  if (spec.body !== undefined && spec.body !== null && spec.method !== "GET") {
    bodyText = typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
    headers["content-type"] ??= "application/json";
  }

  const exchange: ApiExchange = {
    request: { method: spec.method, url: redactText(url.toString(), secrets), headers: redactHeaders(headers, secrets), body: redactDeep(spec.body, secrets) },
    response: null,
    assertions: [],
  };
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(url, { method: spec.method, headers, body: bodyText, redirect: "manual", signal: AbortSignal.timeout(30000) });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    exchange.assertions.push({ name: "Request completed", passed: false, message: `Request failed: ${cause ?? (err as Error).message}` });
    return exchange;
  }
  const raw = await res.text();
  const timeMs = Math.round(performance.now() - t0);
  let body: unknown = raw;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* non-JSON body */ }
  const resHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => (resHeaders[k] = v));
  exchange.response = { status: res.status, headers: redactHeaders(resHeaders, secrets), body: redactDeep(truncate(body), secrets), timeMs };

  const a = exchange.assertions;
  if (spec.expectedStatus) a.push({ name: "Status code", passed: res.status === spec.expectedStatus, message: res.status === spec.expectedStatus ? `HTTP ${res.status} as expected` : `Expected status ${spec.expectedStatus} but got ${res.status}` });
  if (spec.maxResponseMs) a.push({ name: "Response time", passed: timeMs <= spec.maxResponseMs, message: `${timeMs}ms (limit ${spec.maxResponseMs}ms)` });
  for (const [k, v] of Object.entries(spec.expectedHeaders ?? {})) {
    const got = resHeaders[k.toLowerCase()];
    a.push({ name: `Header ${k}`, passed: Boolean(got && got.includes(v)), message: `Expected "${v}", got "${got ?? "(missing)"}"` });
  }
  if ((spec.requiredFields?.length || spec.jsonSchema) && res.status < 400) {
    const isJson = typeof body === "object" && body !== null;
    a.push({ name: "JSON body", passed: isJson, message: isJson ? "Response is JSON" : "Response is not JSON" });
    if (isJson) {
      for (const f of spec.requiredFields ?? []) {
        const present = getPath(body, f) !== undefined;
        a.push({ name: `Field ${f}`, passed: present, message: present ? "present" : "missing" });
      }
      if (spec.jsonSchema) {
        const errs = validateSchema(body, spec.jsonSchema, "$");
        a.push({ name: "JSON structure & types", passed: errs.length === 0, message: errs.length ? errs.slice(0, 5).join("; ") : "matches schema" });
      }
    }
  }
  for (const s of spec.bodyContains ?? []) a.push({ name: `Body contains "${s}"`, passed: raw.includes(s), message: raw.includes(s) ? "found" : "not found" });
  return exchange;
}

function truncate(body: unknown) {
  const s = JSON.stringify(body);
  return s && s.length > 50_000 ? `${s.slice(0, 50_000)}… [truncated]` : body;
}

function getPath(obj: unknown, path: string): unknown {
  const target = Array.isArray(obj) ? obj[0] : obj;
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), target);
}

/** Small JSON-Schema subset validator: type, required, properties, items, enum. */
export function validateSchema(v: unknown, schema: Record<string, unknown>, at: string): string[] {
  const errs: string[] = [];
  const type = schema.type as string | undefined;
  const actual = v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" && Number.isInteger(v) ? "integer" : typeof v;
  if (type && !(type === actual || (type === "number" && actual === "integer") || (schema.nullable && v === null))) {
    errs.push(`${at}: expected ${type}, got ${actual}`);
    return errs;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(v)) errs.push(`${at}: value not in enum`);
  if (actual === "object" && v) {
    for (const r of (schema.required as string[]) ?? []) if (!(r in (v as object))) errs.push(`${at}.${r}: required`);
    for (const [k, sub] of Object.entries((schema.properties as Record<string, Record<string, unknown>>) ?? {}))
      if ((v as Record<string, unknown>)[k] !== undefined) errs.push(...validateSchema((v as Record<string, unknown>)[k], sub, `${at}.${k}`));
  }
  if (actual === "array" && schema.items) (v as unknown[]).slice(0, 20).forEach((x, i) => errs.push(...validateSchema(x, schema.items as Record<string, unknown>, `${at}[${i}]`)));
  return errs;
}
