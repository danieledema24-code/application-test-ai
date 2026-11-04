import net from "node:net";
import type { BrowserContext } from "playwright";
import { isMetadataHost } from "../lib/ssrf.js";

/**
 * Network policy for every browser context we create (spec §13.2–13.4):
 * - top-level navigations may only go to the approved application host(s);
 * - no request of any kind may reach cloud metadata endpoints or (unless explicitly
 *   allowed for local development) private network IP literals.
 * Subresources from public CDNs are allowed so real-world apps still render.
 */
export async function applyNetworkPolicy(context: BrowserContext, allowedHosts: string[], allowPrivate: boolean, blocked: string[] = []) {
  await context.route("**/*", (route) => {
    const req = route.request();
    let url: URL;
    try {
      url = new URL(req.url());
    } catch {
      return route.abort();
    }
    if (url.protocol === "data:" || url.protocol === "blob:") return route.continue();
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const approved = allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
    const privateLiteral = net.isIP(host) !== 0 && !approved && isPrivateLiteral(host);
    const offDomainNavigation = req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame() && !approved;
    if (isMetadataHost(host) || (privateLiteral && !allowPrivate) || offDomainNavigation) {
      blocked.push(req.url());
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
}

function isPrivateLiteral(ip: string) {
  return /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || ip === "::1" || /^f[cd]/i.test(ip);
}
