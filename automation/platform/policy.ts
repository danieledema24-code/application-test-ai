// Platform file (trusted, shipped by automation/). Network policy for generated tests, with parity to the
// backend's Python policy (backend/app/security/ssrf.py, backend/app/browser/network_policy.py):
//   - only http(s) (and ws/wss) requests; data:/blob: only as sub-resources
//   - no credentials in URLs
//   - IP literals in every form a browser accepts (decimal, octal, hex, shortened) are canonicalised
//   - IPv4 embedded in IPv6 (mapped, compatible, NAT64, 6to4) is checked as IPv4
//   - cloud metadata hosts and the whole IPv4 link-local range are always blocked
//   - private and reserved addresses are blocked; with ATA_ALLOW_PRIVATE=true only loopback, and only for the
//     approved origin (scheme + host + port), as in Phase 1
//   - every A/AAAA record of a host name must pass (resolved through node:dns)
//   - top-level navigations stay on the approved hosts
// The shared vectors in automation/test/policy-vectors.json are run against both implementations.
import { lookup } from "node:dns/promises";

export type BlockCode =
  | "invalid_url"
  | "unsupported_scheme"
  | "credentials_in_url"
  | "metadata"
  | "private_address"
  | "dns_failure"
  | "off_site";

export interface Verdict {
  allowed: boolean;
  code?: BlockCode;
  reason?: string;
}

export type Resolver = (host: string) => Promise<string[]>;

export interface PolicyOptions {
  /** Hosts top-level navigation may reach (subdomains included). Empty = no navigation restriction. */
  allowedHosts: string[];
  /** Origin (scheme://host[:port]) of the approved target; the only place loopback is allowed. */
  approvedOrigin?: string;
  /** Mirrors the backend's ALLOW_PRIVATE_TARGETS (dev/test only): loopback for the approved origin. */
  allowPrivate: boolean;
  resolver?: Resolver;
  dnsTimeoutMs?: number;
}

export const REASONS: Record<BlockCode, string> = {
  invalid_url: "Invalid URL",
  unsupported_scheme: "Unsupported scheme",
  credentials_in_url: "Credentials in URL",
  metadata: "Cloud metadata endpoint",
  private_address: "Private network address",
  dns_failure: "Host name could not be resolved",
  off_site: "Outside the approved site",
};

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata",
  "metadata.goog",
  "metadata.azure.com",
  "instance-data",
  "instance-data.ec2.internal",
]);

type Bytes = number[];

// ------------------------------------------------------------------------------------------- IP parsing

function parseV4Part(part: string): number | null {
  if (part === "") return null;
  if (/^0x[0-9a-f]*$/i.test(part)) return parseInt(part.slice(2) || "0", 16);
  if (/^0[0-7]+$/.test(part)) return parseInt(part.slice(1), 8);
  if (/^[0-9]+$/.test(part)) return parseInt(part, 10);
  return null;
}

/** WHATWG/inet_aton IPv4 parsing: `2130706433`, `0177.0.0.1`, `0x7f.1`, `127.1` are all 127.0.0.1. */
export function parseIPv4(host: string): Bytes | null {
  let parts = host.split(".");
  if (parts.length && parts[parts.length - 1] === "") parts = parts.slice(0, -1);
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = parts.map(parseV4Part);
  if (nums.some((n) => n === null || !Number.isFinite(n))) return null;
  const values = nums as number[];
  if (values.slice(0, -1).some((n) => n > 255)) return null;
  const last = values[values.length - 1];
  if (last >= 256 ** (5 - values.length)) return null;
  let total = last;
  values.slice(0, -1).forEach((n, i) => (total += n * 2 ** (8 * (3 - i))));
  return [(total >>> 24) & 255, (total >>> 16) & 255, (total >>> 8) & 255, total & 255];
}

/** Parses an IPv6 literal (with or without brackets and zone) into 16 bytes. */
export function parseIPv6(raw: string): Bytes | null {
  let h = raw.replace(/^\[|\]$/g, "").toLowerCase().split("%")[0];
  if (!h.includes(":")) return null;
  let tail: Bytes = [];
  const dotted = h.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = dotted[2].split(".").map(Number);
    if (v4.some((n) => n > 255)) return null;
    tail = v4;
    h = dotted[1] + "0:0"; // placeholder words, replaced below
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const words = (s: string) => (s === "" ? [] : s.split(":"));
  const head = words(halves[0]);
  const rest = halves.length === 2 ? words(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (all.length !== 8 || all.some((w) => !/^[0-9a-f]{1,4}$/.test(w))) return null;
  const bytes = all.flatMap((w) => {
    const n = parseInt(w, 16);
    return [n >> 8, n & 255];
  });
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

export function parseIpLiteral(host: string): Bytes | null {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase().split("%")[0];
  if (h.includes(":")) return parseIPv6(h);
  if (/^[0-9a-fx.]+$/.test(h) && /\d/.test(h)) return parseIPv4(h);
  return null;
}

/** IPv4 inside IPv6: mapped ::ffff:a.b.c.d, compatible ::a.b.c.d, NAT64 64:ff9b::a.b.c.d, 6to4 2002:AABB:CCDD::. */
export function embeddedIPv4(b: Bytes): Bytes | null {
  if (b.length !== 16) return null;
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 10) && b[10] === 255 && b[11] === 255) return b.slice(12);
  if (b[0] === 0x20 && b[1] === 0x02) return b.slice(2, 6);
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return b.slice(12);
  if (zero(0, 12)) {
    const v = ((b[12] << 24) >>> 0) + (b[13] << 16) + (b[14] << 8) + b[15];
    if (v > 1) return b.slice(12);
  }
  return null;
}

function canonical(b: Bytes): Bytes {
  return b.length === 16 ? (embeddedIPv4(b) ?? b) : b;
}

function inV4(b: Bytes, cidr: string): boolean {
  const [base, bits] = cidr.split("/");
  const n = (x: Bytes) => ((x[0] << 24) >>> 0) + (x[1] << 16) + (x[2] << 8) + x[3];
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return ((n(b) & mask) >>> 0) === ((n(parseIPv4(base)!) & mask) >>> 0);
}

function inV6(b: Bytes, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const p = parseIPv6(base)!;
  let bits = Number(bitsRaw);
  for (let i = 0; i < 16 && bits > 0; i++, bits -= 8) {
    const m = bits >= 8 ? 255 : (0xff << (8 - bits)) & 255;
    if ((b[i] & m) !== (p[i] & m)) return false;
  }
  return true;
}

// Non-public IPv4 ranges (Python's ipaddress is_private/is_reserved/is_multicast/not is_global, plus CGNAT).
const V4_PRIVATE = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24",
  "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
  "224.0.0.0/4", "240.0.0.0/4",
]; // prettier-ignore
const V6_NON_GLOBAL = ["2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"];

export function isMetadataIp(raw: Bytes): boolean {
  const b = canonical(raw);
  if (b.length === 4) return inV4(b, "169.254.0.0/16") || b.join(".") === "100.100.100.200";
  return inV6(b, "fd00:ec2::254/128");
}

export function isLoopbackIp(raw: Bytes): boolean {
  const b = canonical(raw);
  return b.length === 4 ? b[0] === 127 : inV6(b, "::1/128");
}

export function isPrivateIp(raw: Bytes): boolean {
  const b = canonical(raw);
  if (b.length === 4) return V4_PRIVATE.some((c) => inV4(b, c));
  // Global unicast is 2000::/3 minus documentation and special-purpose blocks; everything else is non-public.
  if (!inV6(b, "2000::/3")) return true;
  return V6_NON_GLOBAL.some((c) => inV6(b, c));
}

export function isMetadataHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (METADATA_HOSTS.has(h)) return true;
  const ip = parseIpLiteral(h);
  return ip !== null && isMetadataIp(ip);
}

export function hostMatches(host: string, allowed: string[]): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return allowed.some((a) => h === a || h.endsWith("." + a));
}

// ------------------------------------------------------------------------------------------- policy

export const defaultResolver: Resolver = async (host) =>
  [...new Set((await lookup(host, { all: true })).map((r) => r.address))].sort();

function block(code: BlockCode, reason = REASONS[code]): Verdict {
  return { allowed: false, code, reason };
}

/** Checks one host; `allowLoopback` is true only for the approved origin with ATA_ALLOW_PRIVATE=true. */
export async function checkHost(
  host: string,
  allowLoopback: boolean,
  resolver: Resolver = defaultResolver,
  dnsTimeoutMs = 10_000,
): Promise<Verdict> {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (isMetadataHost(h)) return block("metadata");
  let addrs: Bytes[];
  const literal = parseIpLiteral(h);
  if (literal) addrs = [literal];
  else {
    let found: string[] = [];
    try {
      found = await Promise.race([
        resolver(h),
        // eslint-disable-next-line no-restricted-syntax -- bounds a DNS lookup; not a wait inside a test
        new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error("timeout")), dnsTimeoutMs).unref()),
      ]);
    } catch {
      found = [];
    }
    addrs = found.map((a) => parseIpLiteral(a)).filter((x): x is Bytes => x !== null);
    if (!addrs.length) return block("dns_failure");
  }
  if (addrs.some(isMetadataIp)) return block("metadata");
  if (addrs.some((a) => isPrivateIp(a) && !(allowLoopback && isLoopbackIp(a)))) return block("private_address");
  return { allowed: true };
}

function originOf(u: URL): string {
  return `${u.protocol}//${u.host}`; // URL.host omits default ports, like the Python origin
}

export class NetworkPolicy {
  private cache = new Map<string, Verdict>();
  private readonly opts: PolicyOptions;
  private readonly allowedHosts: string[];
  private readonly approvedOrigin: string | null;

  constructor(opts: PolicyOptions) {
    this.opts = opts;
    this.allowedHosts = opts.allowedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
    let origin: string | null = null;
    try {
      origin = opts.approvedOrigin ? originOf(new URL(opts.approvedOrigin)) : null;
    } catch {
      origin = null;
    }
    this.approvedOrigin = origin;
  }

  /** Verdict for one request; `topLevel` = a navigation of the page's main frame. */
  async check(raw: string, topLevel: boolean): Promise<Verdict> {
    const scheme = (raw.match(/^([a-z][a-z0-9+.-]*):/i)?.[1] ?? "").toLowerCase();
    if ((scheme === "data" || scheme === "blob") && !topLevel) return { allowed: true };
    if (!["http", "https", "ws", "wss"].includes(scheme)) return block("unsupported_scheme");
    let url: URL;
    try {
      url = new URL(raw.replace(/^ws/i, "http"));
    } catch {
      return block("invalid_url");
    }
    if (url.username || url.password) return block("credentials_in_url");
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!host) return block("invalid_url");
    if (topLevel && this.allowedHosts.length && !hostMatches(host, this.allowedHosts)) return block("off_site");
    const allowLoopback = this.opts.allowPrivate && this.approvedOrigin !== null && originOf(url) === this.approvedOrigin;
    const key = `${host}|${allowLoopback}`;
    let verdict = this.cache.get(key);
    if (!verdict) {
      verdict = await checkHost(host, allowLoopback, this.opts.resolver, this.opts.dnsTimeoutMs);
      this.cache.set(key, verdict);
    }
    return verdict;
  }
}

/** Builds the policy from the run environment (set by the backend; see playwright.config.ts). */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): NetworkPolicy {
  return new NetworkPolicy({
    allowedHosts: (env.ATA_ALLOWED_HOSTS ?? "").split(","),
    approvedOrigin: env.ATA_APPROVED_ORIGIN ?? env.BASE_URL,
    allowPrivate: env.ATA_ALLOW_PRIVATE === "true",
  });
}
