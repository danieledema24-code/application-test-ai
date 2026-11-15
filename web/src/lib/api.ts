// Typed fetch wrapper for the QA Analyst API (docs/architecture/api-contracts.md).
// Auth is a bearer token in the Authorization header. Tokens never go in URLs: files come
// from short-lived signed URLs the API returns (EvidenceLink.content_url, report downloads).

export const API_ORIGIN = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8200").replace(/\/+$/, "").replace(/\/api\/v1$/, "");
export const API_URL = `${API_ORIGIN}/api/v1`;

const TOKEN_KEY = "qa_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** A non-2xx response, parsed from the API's `{error: {code, message, details, request_id}}` envelope. */
export class ApiError extends Error {
  status: number;
  /** Machine code, e.g. "validation_error", "url_blocked", "rate_limited". "network" when the API is unreachable. */
  code: string;
  /** Raw `error.details` (list of field errors, or an object such as `{project_id}`). */
  details: unknown;
  requestId: string | null;
  /** Seconds from the Retry-After header on 429. */
  retryAfter: number | null;
  body: Record<string, unknown> | null;
  constructor(
    status: number,
    code: string,
    message: string,
    opts: { details?: unknown; requestId?: string | null; retryAfter?: number | null; body?: Record<string, unknown> | null } = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = opts.details ?? null;
    this.requestId = opts.requestId ?? null;
    this.retryAfter = opts.retryAfter ?? null;
    this.body = opts.body ?? null;
  }

  /** Field-level messages from a `validation_error`, keyed by the last path segment (`body.url` → `url`). */
  get fieldErrors(): Record<string, string> {
    return fieldErrorsOf(this.details);
  }
}

export function fieldErrorsOf(details: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(details)) return out;
  for (const d of details as unknown[]) {
    if (!d || typeof d !== "object") continue;
    const { field, message } = d as { field?: unknown; message?: unknown };
    if (typeof field !== "string" || typeof message !== "string") continue;
    const key = field.split(".").pop() || field;
    if (!out[key]) out[key] = message;
  }
  return out;
}

export const NETWORK_ERROR_MESSAGE = "Can't reach QA Analyst. Check your connection and try again.";

/** Parses an error response body into an ApiError. Exported for the SSE client and tests. */
export function toApiError(status: number, data: unknown, headers?: Headers): ApiError {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const env = obj && obj.error && typeof obj.error === "object" ? (obj.error as Record<string, unknown>) : null;
  const code =
    (env && typeof env.code === "string" && env.code) || (status === 401 ? "unauthenticated" : status >= 500 ? "internal" : "bad_request");
  const message =
    (env && typeof env.message === "string" && env.message) ||
    (obj && typeof obj.error === "string" && obj.error) ||
    (typeof data === "string" && data && data.length < 300 && data) ||
    `Request failed (${status})`;
  const ra = headers?.get("retry-after");
  const retryAfter = ra && /^\d+$/.test(ra) ? Number(ra) : null;
  return new ApiError(status, code, message, {
    details: env?.details,
    requestId: env && typeof env.request_id === "string" ? env.request_id : null,
    retryAfter,
    body: obj,
  });
}

// `/invite/<token>` is public (design P3 §17.3): a 401 there must never redirect to sign-in.
const PUBLIC_PATHS = ["/login", "/register", "/forgot-password", "/reset-password", "/invite/"];

/** A same-origin path to return to after sign-in, or null. Rejects protocol-relative and absolute URLs. */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null;
  if (PUBLIC_PATHS.some((p) => next.startsWith(p))) return null;
  return next;
}

let redirecting = false;
function handleUnauthorised() {
  setToken(null);
  if (typeof window === "undefined" || redirecting) return;
  const path = window.location.pathname;
  if (!PUBLIC_PATHS.some((p) => path.startsWith(p))) {
    redirecting = true;
    const next = encodeURIComponent(path + window.location.search);
    window.location.href = `/login?next=${next}&reason=expired`;
  }
}

/** Called by the SSE client when the stream answers 401. */
export function onUnauthorised() {
  handleUnauthorised();
}

type Query = Record<string, string | number | boolean | null | undefined>;

type RequestOptions = {
  method?: string;
  body?: unknown;
  query?: Query;
  /** Don't redirect to /login on 401 (used by the auth forms). */
  noAuthRedirect?: boolean;
  signal?: AbortSignal;
};

export function buildQuery(query?: Query): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...authHeaders() };
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    body = opts.body;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}${buildQuery(opts.query)}`, {
      method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body,
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new ApiError(0, "network", NETWORK_ERROR_MESSAGE);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    if (res.status === 401 && !opts.noAuthRedirect) handleUnauthorised();
    throw toApiError(res.status, data, res.headers);
  }
  return data as T;
}

/**
 * Downloads a file with the session header (the API answers with a 302 to a signed URL, which
 * fetch follows) and saves it under `fileName`. No token is ever put in a URL.
 */
export async function downloadFile(path: string, fileName: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { headers: authHeaders() });
  } catch {
    throw new ApiError(0, "network", NETWORK_ERROR_MESSAGE);
  }
  if (!res.ok) {
    if (res.status === 401) handleUnauthorised();
    const data = await res.json().catch(() => null);
    throw toApiError(res.status, data, res.headers);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Absolute URL for an API file path. Signed content URLs from the API are returned as-is; relative
 * ones are resolved against the API origin. Never appends a token.
 */
export function fileUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  if (path.startsWith("/api/")) return `${API_ORIGIN}${path}`;
  return `${API_URL}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}
