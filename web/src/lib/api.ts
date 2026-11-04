// Small typed fetch wrapper for the Application Test AI REST API (docs/API.md).

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api").replace(/\/$/, "");

const TOKEN_KEY = "ata_token";

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

export class ApiError extends Error {
  status: number;
  details: unknown;
  body: Record<string, unknown> | null;
  constructor(status: number, message: string, body: Record<string, unknown> | null) {
    super(message);
    this.status = status;
    this.details = body?.details;
    this.body = body;
  }
}

const PUBLIC_PATHS = ["/login", "/register", "/forgot-password", "/reset-password"];

function handleUnauthorised() {
  setToken(null);
  if (typeof window === "undefined") return;
  const path = window.location.pathname;
  if (!PUBLIC_PATHS.some((p) => path.startsWith(p))) {
    const next = encodeURIComponent(path + window.location.search);
    window.location.href = `/login?next=${next}`;
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Don't redirect to /login on 401 (used by the login form itself). */
  noAuthRedirect?: boolean;
  signal?: AbortSignal;
};

export function buildQuery(query?: RequestOptions["query"]): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
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
  } catch {
    throw new ApiError(0, "Cannot reach the API server. Check that it is running.", null);
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
    const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    const message =
      (obj && typeof obj.error === "string" && obj.error) ||
      (typeof data === "string" && data) ||
      `Request failed (${res.status})`;
    throw new ApiError(res.status, message, obj);
  }
  return data as T;
}

/**
 * Build an absolute, token-authenticated URL for <img>, <video> and download links.
 * Accepts either an API-relative path ("/evidence/x/file"), a path that already
 * includes the "/api" prefix ("/api/evidence/x/file"), or an absolute URL.
 */
export function fileUrl(path: string): string {
  let url: string;
  if (/^https?:\/\//.test(path)) {
    url = path;
  } else {
    const apiOrigin = API_URL.replace(/\/api$/, "");
    url = path.startsWith("/api/") ? `${apiOrigin}${path}` : `${API_URL}${path.startsWith("/") ? "" : "/"}${path}`;
  }
  const token = getToken();
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

export function evidenceUrl(e: { id: string; url?: string }): string {
  return fileUrl(e.url || `/evidence/${e.id}/file`);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}
