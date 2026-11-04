import YAML from "yaml";
import { badRequest } from "../lib/errors.js";
import type { ApiSpec } from "./api-runner.js";

type Schema = Record<string, unknown>;
type Doc = { paths?: Record<string, Record<string, Op>>; components?: { schemas?: Record<string, Schema>; securitySchemes?: Record<string, { type?: string; scheme?: string }> }; definitions?: Record<string, Schema>; security?: unknown[] };
type Op = { summary?: string; operationId?: string; parameters?: { name: string; in: string; required?: boolean; schema?: Schema; type?: string; example?: unknown }[]; requestBody?: { content?: Record<string, { schema?: Schema; example?: unknown }> }; responses?: Record<string, { content?: Record<string, { schema?: Schema }>; schema?: Schema }>; security?: unknown[] };

export type ImportedEndpoint = {
  name: string; method: string; path: string; headers: Record<string, string>; query: Record<string, string>; body: unknown;
  auth: "NONE" | "BEARER" | "API_KEY" | "BASIC"; expectedStatus: number; requiredFields: string[]; jsonSchema: Schema | null; requestSchema: Schema | null;
};

const METHODS = ["get", "post", "put", "patch", "delete"];

export function parseOpenApi(text: string): ImportedEndpoint[] {
  let doc: Doc;
  try {
    doc = (text.trim().startsWith("{") ? JSON.parse(text) : YAML.parse(text)) as Doc;
  } catch (e) {
    throw badRequest(`Could not parse OpenAPI document: ${(e as Error).message}`);
  }
  if (!doc?.paths) throw badRequest("Document has no `paths`; is this an OpenAPI/Swagger file?");
  const resolve = (s: Schema | undefined, depth = 0): Schema | null => {
    if (!s || depth > 6) return s ?? null;
    if (typeof s.$ref === "string") {
      const name = s.$ref.split("/").pop()!;
      return resolve(doc.components?.schemas?.[name] ?? doc.definitions?.[name], depth + 1);
    }
    const out: Schema = { ...s };
    if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties as Record<string, Schema>).map(([k, v]) => [k, resolve(v, depth + 1)]));
    if (s.items) out.items = resolve(s.items as Schema, depth + 1);
    return out;
  };
  const schemes = Object.values(doc.components?.securitySchemes ?? {});
  const defaultAuth: ImportedEndpoint["auth"] = schemes.some((s) => s.scheme === "bearer" || s.type === "oauth2") ? "BEARER" : schemes.some((s) => s.type === "apiKey") ? "API_KEY" : schemes.some((s) => s.scheme === "basic") ? "BASIC" : "NONE";

  const out: ImportedEndpoint[] = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const m of METHODS) {
      const op = ops[m];
      if (!op) continue;
      const okCode = Object.keys(op.responses ?? {}).find((c) => /^2\d\d$/.test(c)) ?? (m === "post" ? "201" : "200");
      const okResp = op.responses?.[okCode];
      const respSchema = resolve(okResp?.content?.["application/json"]?.schema ?? okResp?.schema);
      const reqContent = op.requestBody?.content?.["application/json"];
      const reqSchema = resolve(reqContent?.schema);
      const query: Record<string, string> = {};
      let concretePath = path;
      for (const p of op.parameters ?? []) {
        const ex = String(p.example ?? exampleFor(resolve(p.schema) ?? { type: p.type ?? "string" }, p.name) ?? "1");
        if (p.in === "query" && p.required) query[p.name] = ex;
        if (p.in === "path") concretePath = concretePath.replace(`{${p.name}}`, encodeURIComponent(ex));
      }
      const secured = op.security ? op.security.length > 0 : Boolean(doc.security?.length);
      const target = respSchema?.type === "array" ? (respSchema.items as Schema | null) : respSchema;
      out.push({
        name: op.summary ?? op.operationId ?? `${m.toUpperCase()} ${path}`, method: m.toUpperCase(), path: concretePath, headers: {}, query,
        body: reqContent?.example ?? (reqSchema ? exampleFor(reqSchema) : undefined), auth: secured ? defaultAuth : "NONE",
        expectedStatus: Number(okCode), requiredFields: ((target?.required as string[]) ?? []).slice(0, 20), jsonSchema: respSchema, requestSchema: reqSchema,
      });
    }
  }
  return out;
}

export function exampleFor(s: Schema | null, name = ""): unknown {
  if (!s) return null;
  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.enum)) return s.enum[0];
  switch (s.type) {
    case "object": return Object.fromEntries(Object.entries((s.properties as Record<string, Schema>) ?? {}).map(([k, v]) => [k, exampleFor(v, k)]));
    case "array": return [exampleFor(s.items as Schema, name)];
    case "integer": return (s.minimum as number) ?? 1;
    case "number": return (s.minimum as number) ?? 1.5;
    case "boolean": return true;
    default:
      if (s.format === "email" || /email/i.test(name)) return "qa.user@example.com";
      if (s.format === "date-time") return new Date().toISOString();
      if (s.format === "uuid") return "00000000-0000-4000-8000-000000000000";
      return name ? `test-${name}` : "test";
  }
}

/** Rule-based API scenarios (FR-042/FR-044): happy path + negatives derived from the schema. */
export function heuristicApiCases(e: ImportedEndpoint & { id: string }): { title: string; category: string; priority: string; spec: Partial<ApiSpec>; expectedResult: string }[] {
  const label = `${e.method} ${e.path}`;
  const cases: ReturnType<typeof heuristicApiCases> = [
    { title: `${label} returns ${e.expectedStatus} with valid request`, category: "POSITIVE", priority: "HIGH", spec: {}, expectedResult: `HTTP ${e.expectedStatus}, required fields present, response matches schema` },
  ];
  if (e.auth !== "NONE") {
    cases.push({ title: `${label} rejects missing authentication`, category: "AUTHENTICATION", priority: "HIGH", spec: { omitAuth: true, expectedStatus: 401, requiredFields: [], jsonSchema: null }, expectedResult: "HTTP 401 Unauthorized" });
    cases.push({ title: `${label} rejects invalid credentials`, category: "AUTHENTICATION", priority: "HIGH", spec: { invalidAuth: true, expectedStatus: 401, requiredFields: [], jsonSchema: null }, expectedResult: "HTTP 401 Unauthorized" });
  }
  const req = e.requestSchema;
  const body = e.body && typeof e.body === "object" && !Array.isArray(e.body) ? (e.body as Record<string, unknown>) : null;
  if (req && body && ["POST", "PUT", "PATCH"].includes(e.method)) {
    const required = (req.required as string[]) ?? [];
    for (const f of required.slice(0, 3)) {
      const { [f]: _omit, ...rest } = body;
      cases.push({ title: `${label} rejects missing required field "${f}"`, category: "NEGATIVE", priority: "HIGH", spec: { body: rest, expectedStatus: 400, requiredFields: [], jsonSchema: null }, expectedResult: "HTTP 400 with a validation error" });
    }
    const props = (req.properties as Record<string, Schema>) ?? {};
    const typed = Object.entries(props).find(([, v]) => v?.type === "integer" || v?.type === "number" || v?.type === "boolean");
    if (typed) cases.push({ title: `${label} rejects wrong data type for "${typed[0]}"`, category: "NEGATIVE", priority: "MEDIUM", spec: { body: { ...body, [typed[0]]: "not-a-number" }, expectedStatus: 400, requiredFields: [], jsonSchema: null }, expectedResult: "HTTP 400 with a type validation error" });
    const bounded = Object.entries(props).find(([, v]) => v?.maxLength !== undefined || v?.maximum !== undefined);
    if (bounded) {
      const [k, v] = bounded;
      const over = v.maxLength !== undefined ? "x".repeat((v.maxLength as number) + 1) : (v.maximum as number) + 1;
      cases.push({ title: `${label} enforces upper bound on "${k}"`, category: "BOUNDARY", priority: "MEDIUM", spec: { body: { ...body, [k]: over }, expectedStatus: 400, requiredFields: [], jsonSchema: null }, expectedResult: "HTTP 400 for out-of-range value" });
    }
    cases.push({ title: `${label} rejects malformed JSON`, category: "NEGATIVE", priority: "MEDIUM", spec: { body: "{ not valid json", expectedStatus: 400, requiredFields: [], jsonSchema: null }, expectedResult: "HTTP 400" });
  }
  return cases;
}
