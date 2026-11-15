// Platform file (trusted, shipped by automation/). Specs import { test, expect } from here instead of
// "@playwright/test" so every test gets the same network policy, evidence capture and `qa` helpers, on the
// platform, on a developer machine and in CI.
import { test as base, expect, type Page, type Route } from "@playwright/test";
import { NetworkPolicy, policyFromEnv } from "./policy";
import { Qa, pageState, type QaLog } from "./qa";

const MAX_REDIRECTS = 5;
const MASK_COLOR = "#FF00FF";
const PASSWORD_FIELDS = 'input[type="password"]';
const FETCH_TIMEOUT_MS = Number(process.env.ATA_FETCH_TIMEOUT_MS ?? 20_000);

function stamp(): string {
  return new Date().toISOString();
}

/** Blocks a request and records it as "BLOCKED by policy <url> (<reason>)" in the network log and on stderr. */
async function blockRequest(route: Route, log: QaLog, url: string, reason: string): Promise<void> {
  log.blocked.push({ url: url.slice(0, 500), reason });
  const line = `BLOCKED by policy ${url.slice(0, 500)} (${reason})`;
  log.network.push(`[${stamp()}] ${line}`);
  console.warn(line);
  await route.abort("blockedbyclient").catch(() => undefined);
}

/**
 * Every http(s) request is fetched by the policy itself with redirects off, and each `Location` hop is checked
 * before anything follows it (Playwright does not route the requests a browser makes when following a redirect).
 * Sub-resources are fulfilled with the final response. A redirected top-level navigation is fulfilled with its
 * first redirect response only after the whole chain was validated, so the browser follows the same hops
 * natively and the page ends up at the right URL (hops after the first are fetched twice; DNS rebinding between
 * the check and the browser's own connection is the residual risk documented as T3).
 */
async function handle(route: Route, policy: NetworkPolicy, log: QaLog): Promise<void> {
  const req = route.request();
  const url = req.url();
  if (/^(data|blob):/i.test(url)) return route.continue();
  let topLevel = false;
  try {
    topLevel = req.isNavigationRequest() && req.frame().parentFrame() === null;
  } catch {
    topLevel = false;
  }
  const verdict = await policy.check(url, topLevel);
  if (!verdict.allowed) return blockRequest(route, log, url, verdict.reason ?? "Blocked");
  try {
    const first = await route.fetch({ maxRedirects: 0, timeout: FETCH_TIMEOUT_MS });
    let resp = first;
    let current = url;
    for (let hops = 0; resp.status() >= 300 && resp.status() < 400 && resp.headers()["location"]; hops++) {
      const next = new URL(resp.headers()["location"], current).toString();
      const hop = await policy.check(next, topLevel);
      if (!hop.allowed) return blockRequest(route, log, next, `Redirect to a blocked address (${hop.reason})`);
      if (hops >= MAX_REDIRECTS) return blockRequest(route, log, next, "Too many redirects");
      resp = await route.fetch({ url: next, method: "GET", maxRedirects: 0, timeout: FETCH_TIMEOUT_MS });
      current = next;
    }
    await route.fulfill({ response: topLevel ? first : resp });
  } catch (err) {
    log.network.push(`[${stamp()}] FAILED ${req.method()} ${url} — ${String((err as Error).message).split("\n")[0]}`);
    await route.abort("failed").catch(() => undefined);
  }
}

/** Only web pages can be opened: file://, chrome:// and similar would expose the machine running the tests. */
function guardGoto(page: Page, log: QaLog): void {
  const frame = page.mainFrame() as unknown as { goto: (url: string, options?: unknown) => Promise<unknown> };
  const original = frame.goto.bind(frame);
  frame.goto = (url: string, options?: unknown) => {
    if (/^[a-z][\w+.-]*:/i.test(url) && !/^(https?:|about:blank$|data:)/i.test(url)) {
      const line = `BLOCKED by policy ${url.slice(0, 500)} (Unsupported scheme)`;
      log.blocked.push({ url: url.slice(0, 500), reason: "Unsupported scheme" });
      log.network.push(`[${stamp()}] ${line}`);
      console.warn(line);
      throw new Error(line);
    }
    return original(url, options);
  };
}

export const test = base.extend<{ qaLog: QaLog; qa: Qa; _policy: void; _evidence: void; _live: void }>({
  qaLog: async ({}, use) => {
    await use({ console: [], network: [], blocked: [] });
  },

  qa: async ({ page, qaLog }, use) => {
    await use(new Qa(page, qaLog));
  },

  _policy: [
    async ({ context, page, qaLog }, use) => {
      const policy = policyFromEnv();
      guardGoto(page, qaLog);
      await context.route("**/*", (route) => handle(route, policy, qaLog));
      await context.routeWebSocket("**/*", async (ws) => {
        const verdict = await policy.check(ws.url(), false);
        if (!verdict.allowed) {
          qaLog.blocked.push({ url: ws.url().slice(0, 500), reason: verdict.reason ?? "Blocked" });
          qaLog.network.push(`[${stamp()}] BLOCKED by policy ${ws.url().slice(0, 500)} (${verdict.reason})`);
          await ws.close({ code: 1008, reason: "Blocked by policy" });
          return;
        }
        ws.connectToServer();
      });
      await use();
    },
    { auto: true },
  ],

  // Console and network logs, page state and a final screenshot with every password field masked.
  _evidence: [
    async ({ page, qaLog }, use, testInfo) => {
      page.on("console", (m) => qaLog.console.push({ type: m.type(), text: `[${stamp()}] ${m.type()}: ${m.text()}` }));
      page.on("pageerror", (e) => qaLog.console.push({ type: "pageerror", text: `[${stamp()}] pageerror: ${e.message}` }));
      page.on("requestfailed", (r) => {
        const why = r.failure()?.errorText ?? "unknown";
        if (why.includes("ERR_BLOCKED_BY_CLIENT")) return; // already logged as BLOCKED by policy
        qaLog.network.push(`[${stamp()}] FAILED ${r.method()} ${r.url()} — ${why}`);
      });
      page.on("response", (r) => {
        qaLog.network.push(`[${stamp()}] HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
      });
      await use();
      try {
        const masked = await page.locator(PASSWORD_FIELDS).evaluateAll((els) =>
          els.map((e) => {
            const r = e.getBoundingClientRect();
            return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
          }),
        );
        const shot = await page.screenshot({
          fullPage: true,
          mask: [page.locator(PASSWORD_FIELDS)],
          maskColor: MASK_COLOR,
        });
        await testInfo.attach("final-state", { body: shot, contentType: "image/png" });
        await testInfo.attach("masked-regions", {
          body: JSON.stringify({ color: MASK_COLOR, regions: masked }),
          contentType: "application/json",
        });
      } catch {
        /* page already closed */
      }
      const state = await pageState(page);
      // "Chromium 131.0.6778.33" for the defect report's environment (never anything about the user).
      const b = page.context().browser();
      const browser = b ? `${b.browserType().name().replace(/^./, (c) => c.toUpperCase())} ${b.version()}` : undefined;
      await testInfo.attach("page-state", { body: JSON.stringify({ ...state, browser }), contentType: "application/json" });
      // Always attached (P4-06 evidence), with a line saying so when nothing was logged.
      const consoleText = qaLog.console.map((c) => c.text).join("\n") || "No console messages.";
      await testInfo.attach("console", { body: consoleText, contentType: "text/plain" });
      await testInfo.attach("network", { body: qaLog.network.join("\n") || "No requests.", contentType: "text/plain" });
    },
    { auto: true },
  ],

  // Live frames (ATA_LIVE_DIR, Chromium only) come from live.ts, which exports leave out; a no-op otherwise.
  _live: [
    async ({ page }, use, testInfo) => {
      if (!process.env.ATA_LIVE_DIR) return use();
      const specifier = "./live.ts";
      const live = (await import(specifier)) as {
        startLive: (page: Page, info: typeof testInfo) => Promise<() => Promise<void>>;
      };
      const stop = await live.startLive(page, testInfo);
      await use();
      await stop();
    },
    { auto: true },
  ],
});

export { expect };
