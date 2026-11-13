// URL validation for Start QA Analysis (design spec §6.1). Pure functions, unit-tested in tests/unit.
// The client checks (C1–C5) are a convenience only; the server's SSRF policy is authoritative.

import type { UrlCheckResult } from "./contract";

export type ClientUrlCheck =
  | { ok: true; url: string; host: string; /** true when we added https:// */ addedScheme: boolean }
  | { ok: false; code: "C1" | "C2" | "C3" | "C4" | "C5"; message: string };

export const URL_COPY = {
  C1: "Enter a website URL.",
  C2: "Enter a valid URL, like https://example.com.",
  C3: "Only http:// and https:// websites can be analysed.",
  C4: "Remove the username and password from the URL. Add sign-in details under Scan settings instead.",
  privateAddress: (host: string, ip?: string | null) =>
    `${host} resolves to a private or internal address${ip ? ` (${ip})` : ""}. For safety, only public websites can be analysed.`,
  metadata: "This is a cloud metadata address. It can't be analysed.",
  redirectBlocked: "This site redirects to a private or internal address. For safety, it can't be analysed.",
  dns: (host: string) => `We couldn't find ${host}. Check the address for typos.`,
  timeout: (url: string, seconds = 10) =>
    `We couldn't reach ${url} (no response after ${seconds} s). Check that the site is online and publicly reachable, then try again.`,
  server: (host: string, code: number) => `${host} responded with a server error (HTTP ${code}). Try again later.`,
  notFound: "This page doesn't exist (HTTP 404). Check the URL or use the site's home page.",
  signIn: (code: number) =>
    `The page requires sign-in (HTTP ${code}). Discovery will be limited to public pages, and signed-in areas will be listed as access gaps.`,
  redirect: (finalUrl: string) => `Redirects to ${finalUrl}. We'll analyse that address.`,
  unavailable: "We couldn't check this site right now. Try again in a moment.",
  unticked: "Confirm you're authorised to test this site.",
  createFailed: "We couldn't create the project. Nothing was started. Try again.",
};

/** Cloud metadata endpoints get the S2 wording even when caught on the client. */
const METADATA_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "100.100.100.200", "fd00:ec2::254"]);

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(":")) return false;
  return h === "::" || h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:");
}

/** C5: hosts that can only be private (localhost, .local, .internal, literal private/loopback IPs). */
export function isObviouslyPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    isPrivateIPv4(h) ||
    isPrivateIPv6(h)
  );
}

export type ClientUrlPolicy = {
  /**
   * Block loopback/private hosts in the browser (C5). Only when the server is known to block them
   * too (GET /health `allow_private_targets: false`); otherwise the server's URL check decides,
   * because it is authoritative and dev/test servers may allow local targets.
   * Cloud metadata addresses are always blocked.
   */
  blockPrivate?: boolean;
};

/** Trim, add https:// when there is no scheme, and apply C1–C5. */
export function checkUrlClientSide(raw: string, policy: ClientUrlPolicy = { blockPrivate: true }): ClientUrlCheck {
  const input = raw.trim();
  if (!input) return { ok: false, code: "C1", message: URL_COPY.C1 };

  // "example.com:8080" looks like a scheme to the regex; only treat it as one when followed by "//" or a known non-web scheme.
  const hasScheme = SCHEME_RE.test(input) && (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) || /^(javascript|data|file|mailto|ftp|about|blob|vbscript):/i.test(input));
  const candidate = hasScheme ? input : `https://${input}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, code: "C2", message: URL_COPY.C2 };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, code: "C3", message: URL_COPY.C3 };
  if (parsed.username || parsed.password) return { ok: false, code: "C4", message: URL_COPY.C4 };

  const host = parsed.hostname;
  // Require something that looks like a host: a dot, an IP literal, or localhost (caught by C5 below).
  if (!host || /\s/.test(input) || (!host.includes(".") && !host.includes(":") && host !== "localhost")) {
    return { ok: false, code: "C2", message: URL_COPY.C2 };
  }
  if (METADATA_HOSTS.has(host.toLowerCase().replace(/^\[|\]$/g, ""))) return { ok: false, code: "C5", message: URL_COPY.metadata };
  if (policy.blockPrivate && isObviouslyPrivateHost(host)) return { ok: false, code: "C5", message: URL_COPY.privateAddress(host) };

  parsed.hash = "";
  let url = parsed.toString();
  // Keep the user's form for bare hosts: "https://example.com" rather than "https://example.com/".
  if (parsed.pathname === "/" && !parsed.search && !input.replace(/[?#].*$/, "").endsWith("/")) url = url.replace(/\/$/, "");
  return { ok: true, url, host, addedScheme: !hasScheme };
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Display form of a URL in compact lists: host + path without trailing slash. */
export function shortUrl(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    return `${u.hostname}${path}${u.search}`;
  } catch {
    return url;
  }
}

export function pathOf(url: string | null | undefined): string {
  if (!url) return "/";
  try {
    const u = new URL(url);
    return `${u.pathname || "/"}${u.search}`;
  } catch {
    return url;
  }
}

export type SiteCheckVerdict = {
  /** false = blocking error: the project can't be created for this URL. */
  ok: boolean;
  /** Blocking message (S1–S7, S14). */
  error: string | null;
  /** Non-blocking notes (S8, S9, robots). */
  warnings: string[];
  info: string[];
  /** Host the analysis will be scoped to (after redirects). */
  scopeHost: string;
  finalUrl: string;
};

/** Interprets POST /projects/url-check (rows S1–S9 of §6.1). */
export function interpretUrlCheck(r: UrlCheckResult): SiteCheckVerdict {
  const finalUrl = r.final_url || r.normalised_url;
  const host = hostOf(r.normalised_url);
  const scopeHost = hostOf(finalUrl) || host;
  const base = { scopeHost, finalUrl, warnings: [] as string[], info: [] as string[] };

  if (!r.allowed) {
    const reason = (r.blocked_reason || "").toLowerCase();
    const viaRedirect = r.redirects.length > 0 && /redirect/.test(reason);
    let error: string;
    if (/metadata/.test(reason)) error = URL_COPY.metadata;
    else if (viaRedirect) error = URL_COPY.redirectBlocked;
    else if (/scheme/.test(reason)) error = URL_COPY.C3;
    else if (/credential|userinfo|password/.test(reason)) error = URL_COPY.C4;
    else error = URL_COPY.privateAddress(host, r.resolved_ip);
    return { ...base, ok: false, error };
  }

  if (!r.reachable) {
    const why = (r.error || "").toLowerCase();
    const error = /dns|resolve|name|nxdomain|not found|getaddrinfo/.test(why) ? URL_COPY.dns(host) : URL_COPY.timeout(r.normalised_url);
    return { ...base, ok: false, error };
  }

  const status = r.http_status ?? 0;
  if (status >= 500) return { ...base, ok: false, error: URL_COPY.server(host, status) };
  if (status === 404) return { ...base, ok: false, error: URL_COPY.notFound };

  const warnings: string[] = [];
  const info: string[] = [];
  if (status === 401 || status === 403) warnings.push(URL_COPY.signIn(status));
  if (r.final_url && r.final_url !== r.normalised_url && (r.cross_site_redirect || hostOf(r.final_url) !== host)) {
    info.push(URL_COPY.redirect(r.final_url));
  }
  if (r.tls && !r.tls.valid) warnings.push(`The site's security certificate is not valid${r.tls.error ? ` (${r.tls.error})` : ""}.`);
  if (r.robots?.disallows_start) warnings.push("The site's robots.txt asks automated tools not to visit this page. Discovery respects robots.txt by default.");
  return { ...base, ok: true, error: null, warnings, info };
}

/** File name for the Discovery Report PDF: `{host}-discovery-report-scan{n}-{yyyy-mm-dd}.pdf` (§9.2). */
export function reportFileName(host: string, scanNumber: number | null, date: Date, format = "pdf"): string {
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const safeHost = host.replace(/[^a-z0-9.-]/gi, "-") || "site";
  return `${safeHost}-discovery-report-scan${scanNumber ?? 1}-${d}.${format}`;
}

/** "SCAN-0002" → 2. */
export function scanNumber(key: string | null | undefined): number | null {
  const m = key?.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}
