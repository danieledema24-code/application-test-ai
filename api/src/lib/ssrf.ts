import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../config.js";
import { HttpError } from "./errors.js";

// Spec §13.3: block internal network addresses and cloud metadata endpoints.
const METADATA_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "metadata", "100.100.100.200", "fd00:ec2::254"]);

/** Expands an IPv6 address to 8 numeric groups (handles "::" and a trailing dotted IPv4). */
function ipv6Groups(ip: string): number[] | null {
  let v = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = v.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (!net.isIPv4(dotted[1])) return null;
    const [a, b, c, d] = dotted[1].split(".").map(Number);
    v = v.slice(0, -dotted[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = v.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = v.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * IPv4 address embedded in an IPv6 one (IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible ::a.b.c.d, NAT64 64:ff9b::a.b.c.d,
 * 6to4 2002:AABB:CCDD::), so "[::ffff:a9fe:a9fe]" is checked as 169.254.169.254.
 */
function embeddedIPv4(ip: string): string | null {
  const g = ipv6Groups(ip);
  if (!g) return null;
  const v4 = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeros(5) && (g[5] === 0xffff || (g[5] === 0 && (g[6] !== 0 || g[7] > 1)))) return v4(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4(g[6], g[7]);
  if (g[0] === 0x2002) return v4(g[1], g[2]);
  return null;
}

/** Canonical form for checks: bracket-free, lower case, embedded IPv4 extracted. */
export function normaliseHost(host: string): string {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return net.isIPv6(h) ? (embeddedIPv4(h) ?? h) : h;
}

function isPrivateIp(raw: string): boolean {
  const ip = normaliseHost(raw);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  return ip === "::1" || ip === "::" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80");
}

export function isMetadataHost(host: string) {
  const h = normaliseHost(host);
  // The whole IPv4 link-local range is blocked: it hosts AWS/ECS/Azure metadata services.
  return METADATA_HOSTS.has(h) || (net.isIPv4(h) && h.startsWith("169.254."));
}

/** Throws unless the URL is http(s) and resolves to a public address (or private targets are allowed in dev). */
export async function assertSafeTarget(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, `Invalid URL: ${rawUrl}`);
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new HttpError(400, "Only http and https targets are supported");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isMetadataHost(host)) throw new HttpError(400, "Cloud metadata endpoints cannot be tested");
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addrs.length === 0) throw new HttpError(400, `Could not resolve host ${host}`);
  if (addrs.some(isMetadataHost)) throw new HttpError(400, "Cloud metadata endpoints cannot be tested");
  if (!config.allowPrivateTargets && addrs.some(isPrivateIp))
    throw new HttpError(400, "Targets on internal or private network addresses are blocked");
  return url;
}

/** Synchronous host allow-list check used inside browser request interception. */
export function hostAllowed(requestUrl: string, allowedHosts: string[]): boolean {
  try {
    const u = new URL(requestUrl);
    if (u.protocol === "data:" || u.protocol === "blob:") return true;
    if (!["http:", "https:"].includes(u.protocol)) return false;
    if (isMetadataHost(u.hostname)) return false;
    return allowedHosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}
