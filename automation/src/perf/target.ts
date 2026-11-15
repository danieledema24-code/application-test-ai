// Network policy for load (P5-01a), with parity to the fixtures' policy (platform/policy.ts) and the backend's
// (backend/app/security/ssrf.py) on the shared vectors (test/policy-vectors.json):
//   - only http(s); no credentials in the URL; the host must be on the project's allowed hosts
//   - the host is resolved ONCE per run and every address is checked: metadata always blocked; private and
//     reserved blocked unless allow-private, and then only loopback, only for the approved origin
//   - every connection goes to the validated address (Host header and TLS SNI keep the name), so a DNS answer
//     that changes during the run (rebinding) can't move the load anywhere else
import type { LookupFunction } from "node:net";
import {
  REASONS,
  defaultResolver,
  hostMatches,
  isLoopbackIp,
  isMetadataHost,
  isMetadataIp,
  isPrivateIp,
  parseIpLiteral,
  type BlockCode,
  type Resolver,
} from "../../platform/policy.ts";

export interface Pinned {
  allowed: true;
  host: string;
  address: string;
  family: 4 | 6;
}
export interface Refused {
  allowed: false;
  code: BlockCode;
  reason: string;
}

export interface TargetPolicy {
  approvedOrigin: string;
  allowedHosts: string[];
  allowPrivate: boolean;
  resolver?: Resolver;
  dnsTimeoutMs?: number;
}

const refuse = (code: BlockCode): Refused => ({ allowed: false, code, reason: REASONS[code] });

function format(bytes: number[]): { address: string; family: 4 | 6 } {
  if (bytes.length === 4) return { address: bytes.join("."), family: 4 };
  const words: string[] = [];
  for (let i = 0; i < 16; i += 2) words.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return { address: words.join(":"), family: 6 };
}

/** Checks `url` and pins it to one validated address. `topLevel` = the request is load on the target itself (the
 * allowed-hosts rule applies); the vector tests also run sub-resource vectors with `topLevel: false`. */
export async function preflight(url: string, policy: TargetPolicy, topLevel = true): Promise<Pinned | Refused> {
  const scheme = (url.match(/^([a-z][a-z0-9+.-]*):/i)?.[1] ?? "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") return refuse("unsupported_scheme");
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return refuse("invalid_url");
  }
  if (u.username || u.password) return refuse("credentials_in_url");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!host) return refuse("invalid_url");
  const allowed = policy.allowedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (topLevel && allowed.length && !hostMatches(host, allowed)) return refuse("off_site");
  if (isMetadataHost(host)) return refuse("metadata");
  let approved: string | null = null;
  try {
    approved = new URL(policy.approvedOrigin).origin;
  } catch {
    approved = null;
  }
  const allowLoopback = policy.allowPrivate && approved !== null && u.origin === approved;
  let addrs: number[][];
  const literal = parseIpLiteral(host);
  if (literal) addrs = [literal];
  else {
    let found: string[] = [];
    try {
      found = await Promise.race([
        (policy.resolver ?? defaultResolver)(host),
        new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error("timeout")), policy.dnsTimeoutMs ?? 10_000).unref()),
      ]);
    } catch {
      found = [];
    }
    addrs = found.map((a) => parseIpLiteral(a)).filter((x): x is number[] => x !== null);
    if (!addrs.length) return refuse("dns_failure");
  }
  if (addrs.some(isMetadataIp)) return refuse("metadata");
  if (addrs.some((a) => isPrivateIp(a) && !(allowLoopback && isLoopbackIp(a)))) return refuse("private_address");
  return { allowed: true, host, ...format(addrs[0]) };
}

/** A `lookup` for node:http(s) that always answers with the pinned address (never asks DNS again). */
export function pinnedLookup(pin: Pinned): LookupFunction {
  return ((_hostname: string, options: { all?: boolean } | number | undefined, callback: (...args: unknown[]) => void) => {
    const cb = typeof options === "function" ? (options as (...args: unknown[]) => void) : callback;
    if (typeof options === "object" && options?.all) cb(null, [{ address: pin.address, family: pin.family }]);
    else cb(null, pin.address, pin.family);
  }) as unknown as LookupFunction;
}
