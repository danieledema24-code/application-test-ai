// Platform file (trusted, platform runs only: NOT included in exports). When ATA_LIVE_DIR is set, streams the
// viewport as JPEG frames through a Chromium CDP screencast, one slot per worker (w<n>.jpg + w<n>.json), so the
// platform can show the test while it runs. About 5 frames a second; frames are not stored (the video is the
// record). Other browsers: a no-op.
import fs from "node:fs";
import path from "node:path";
import type { Page, TestInfo } from "@playwright/test";

const MIN_FRAME_INTERVAL_MS = 200;

export async function startLive(page: Page, testInfo: TestInfo): Promise<() => Promise<void>> {
  const dir = process.env.ATA_LIVE_DIR;
  if (!dir || page.context().browser()?.browserType().name() !== "chromium") return async () => undefined;
  const slot = path.join(dir, `w${testInfo.parallelIndex}`);
  const state = (s: string) => {
    try {
      fs.writeFileSync(`${slot}.json`, JSON.stringify({ title: testInfo.title, state: s, at: Date.now() }));
    } catch {
      /* best effort */
    }
  };
  state("running");
  let last = 0;
  const cdp = await page
    .context()
    .newCDPSession(page)
    .catch(() => null);
  if (cdp) {
    cdp.on("Page.screencastFrame", (f) => {
      cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
      if (Date.now() - last < MIN_FRAME_INTERVAL_MS) return;
      last = Date.now();
      try {
        fs.writeFileSync(`${slot}.tmp`, Buffer.from(f.data, "base64"));
        fs.renameSync(`${slot}.tmp`, `${slot}.jpg`);
      } catch {
        /* best effort */
      }
    });
    await cdp
      .send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 860 })
      .catch(() => undefined);
  }
  return async () => {
    state(testInfo.status === testInfo.expectedStatus ? "passed" : "failed");
    await cdp?.send("Page.stopScreencast").catch(() => undefined);
    await cdp?.detach().catch(() => undefined);
  };
}
