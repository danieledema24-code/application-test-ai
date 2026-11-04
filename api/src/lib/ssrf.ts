import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../config.js";
import { HttpError } from "./errors.js";

// Spec §13.3: block internal network addresses and cloud metadata endpoints.
const METADATA_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "metadata", "100.100.100.200", "fd00:ec2::254"]);

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

export function isMetadataHost(host: string) {
  return METADATA_HOSTS.has(host.toLowerCase());
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
