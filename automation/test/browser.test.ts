// Real-browser toolkit run through `qa run` (Chromium): the shared policy vectors are requested by a fixture page
// and blocked, a redirect to a private address is blocked at the hop, a failing qa assertion reports
// "QA_ASSERTION: …", and the final screenshot masks password fields.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import { cli, startSite, workspace } from "./helpers.ts";
import { VECTORS, fill } from "./vectors.ts";

interface Attachment {
  name: string;
  contentType: string;
  body?: string;
}
interface Result {
  status: string;
  errors: { message?: string }[];
  attachments: Attachment[];
}
interface Spec {
  title: string;
  tests: { results: Result[] }[];
}
interface Suite {
  specs?: Spec[];
  suites?: Suite[];
}

let site: Awaited<ReturnType<typeof startSite>>;
let dir: string;
const results = new Map<string, Result>();

function collect(suite: Suite): void {
  for (const s of suite.specs ?? []) results.set(s.title.split(":")[0], s.tests[0].results.at(-1)!);
  for (const child of suite.suites ?? []) collect(child);
}

const text = (r: Result, name: string) =>
  Buffer.from(r.attachments.find((a) => a.name === name)?.body ?? "", "base64").toString("utf8");

const SPECS: Record<string, string> = {
  "tests/policy/TC-0001.spec.ts": `import { test, expect } from "../../fixtures";
const urls = JSON.parse(process.env.VECTOR_URLS ?? "[]") as string[];
test("TC-0001: policy vectors", { tag: ["@TC-0001"] }, async ({ page }) => {
  await page.goto("/vectors?" + urls.map((u) => "u=" + encodeURIComponent(u)).join("&"));
  await expect(page.getByRole("heading", { name: "Vectors" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.goto("file:///etc/passwd")).rejects.toThrow(/BLOCKED by policy/);
});
`,
  "tests/policy/TC-0002.spec.ts": `import { test, expect } from "../../fixtures";
test("TC-0002: redirects are validated hop by hop", { tag: ["@TC-0002"] }, async ({ page }) => {
  await page.goto("/redirect-ok");
  await expect(page).toHaveURL(/\\/contact$/);
  await page.goto("/vectors?u=" + encodeURIComponent("/redirect-metadata"));
  await page.waitForLoadState("networkidle");
  await expect(page.goto("/redirect-private")).rejects.toThrow();
  await expect(page.goto("/redirect-metadata")).rejects.toThrow();
});
`,
  "tests/contact/TC-0003.spec.ts": `import { test } from "../../fixtures";
test("TC-0003: Contact form blocks an empty Message", { tag: ["@TC-0003"] }, async ({ page, qa }) => {
  await test.step("Open the Contact us page", async () => {
    await page.goto("/contact");
  });
  await test.step("Enter Name and Email, leave Message empty, press Send message", async () => {
    await qa.fill("Name", "Jane Doe");
    await qa.fill("Email", "jane.doe@example.com");
    await qa.press("Send message");
    await qa.expectSubmissionBlocked({ name: "Contact us", locator: page.getByRole("form", { name: "Contact us" }) });
  });
});
`,
  "tests/login/TC-0004.spec.ts": `import { test, expect } from "../../fixtures";
test.use({ trace: "off" });
test("TC-0004: password is masked", { tag: ["@TC-0004"] }, async ({ page, qa }) => {
  await page.goto("/login");
  await qa.fill("Email", "someone@example.com");
  await page.getByLabel("Password").fill("hunter2-visible-secret");
  await expect(page.getByLabel("Password")).toHaveValue("hunter2-visible-secret");
});
`,
};

const browserVectors = VECTORS.vectors.filter((v) => v.browser !== false && !v.top_level);

before(async () => {
  site = await startSite();
  dir = await workspace("browser", SPECS);
  const urls = browserVectors.map((v) => fill(v.url, site.port));
  const report = path.join(dir, "report.json");
  const r = await cli(["run", "--dir", dir, "--report", report], {
    BASE_URL: site.url,
    ATA_ALLOWED_HOSTS: "127.0.0.1",
    ATA_ALLOW_PRIVATE: "true",
    ATA_VIDEO: "off",
    ATA_TRACE: "off",
    PW_WORKERS: "2",
    ATA_OUTPUT_DIR: path.join(dir, "test-results"),
    VECTOR_URLS: JSON.stringify(urls),
  });
  assert.equal(r.json?.report_file, report, r.stdout);
  assert.equal(r.code, 1, "one test fails on purpose (TC-0003)");
  collect(JSON.parse(fs.readFileSync(report, "utf8")) as Suite);
});

after(async () => {
  await site?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("every browser-capable vector is requested by the page and blocked by policy", () => {
  const r = results.get("TC-0001")!;
  assert.equal(r.status, "passed", JSON.stringify(r.errors));
  const net = text(r, "network");
  for (const v of browserVectors) {
    const url = new URL(fill(v.url, site.port)).href; // Chromium canonicalises like WHATWG URL
    const line = net.split("\n").find((l) => l.includes(`BLOCKED by policy ${url} `));
    if (v.verdict === "blocked") assert.ok(line, `${v.url} (${url}) not blocked:\n${net}`);
    else assert.equal(line, undefined, `${v.url} must be allowed`);
  }
  assert.match(net, /BLOCKED by policy file:\/\/\/etc\/passwd \(Unsupported scheme\)/);
  assert.ok(site.log.includes("GET /ok"), "the approved origin itself is reachable");
});

test("a redirect from the approved host to a private address is blocked at the hop", () => {
  const r = results.get("TC-0002")!;
  assert.equal(r.status, "passed", JSON.stringify(r.errors));
  const net = text(r, "network");
  // Top-level hops are checked against the approved hosts first, as in the Python policy.
  assert.match(net, /BLOCKED by policy http:\/\/10\.0\.0\.5\/admin \(Redirect to a blocked address \(Outside the approved site\)\)/);
  assert.match(net, /BLOCKED by policy http:\/\/169\.254\.169\.254\/latest\/meta-data\/ \(Redirect to a blocked address/);
  assert.ok(site.log.includes("GET /redirect-private") && site.log.includes("GET /contact"));
  // A sub-resource that redirects to the metadata service is blocked at the hop too.
  assert.match(net, /BLOCKED by policy http:\/\/169\.254\.169\.254\/latest\/meta-data\/ \(Redirect to a blocked address \(Cloud metadata endpoint\)\)/);
});

test("a failing qa assertion reports QA_ASSERTION with the form and what the page showed", () => {
  const r = results.get("TC-0003")!;
  assert.equal(r.status, "failed");
  const message = r.errors[0]?.message ?? "";
  assert.match(message, /^QA_ASSERTION: Expected the Contact us form to block the submission/, message);
  assert.match(message, /the page shows "Thank you" \(Message sent\) at \/contact\./);
  assert.equal(JSON.parse(text(r, "page-state")).heading, "Thank you");
});

test("live frames are written for platform runs (live.ts)", async () => {
  const live = path.join(dir, "live");
  const r = await cli(["run", "--dir", dir, "--report", path.join(dir, "live-report.json"), "--live-dir", live, "--grep", "@TC-0004"], {
    BASE_URL: site.url,
    ATA_ALLOWED_HOSTS: "127.0.0.1",
    ATA_ALLOW_PRIVATE: "true",
    ATA_VIDEO: "off",
    ATA_TRACE: "off",
    PW_WORKERS: "1",
    ATA_OUTPUT_DIR: path.join(dir, "test-results-live"),
  });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(JSON.parse(fs.readFileSync(path.join(live, "w0.json"), "utf8")).state, "passed");
});

test("the final screenshot masks password fields", async () => {
  const r = results.get("TC-0004")!;
  assert.equal(r.status, "passed", JSON.stringify(r.errors));
  const regions = JSON.parse(text(r, "masked-regions")) as { color: string; regions: { x: number; y: number; width: number; height: number }[] };
  assert.equal(regions.regions.length, 1);
  const png = r.attachments.find((a) => a.name === "final-state")!.body!;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const [x, y] = [regions.regions[0].x + regions.regions[0].width / 2, regions.regions[0].y + regions.regions[0].height / 2];
    const pixel = await page.evaluate(
      async ({ src, x, y }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext("2d")!;
        g.drawImage(img, 0, 0);
        return Array.from(g.getImageData(Math.round(x), Math.round(y), 1, 1).data);
      },
      { src: `data:image/png;base64,${png}`, x, y },
    );
    assert.deepEqual(pixel.slice(0, 3), [255, 0, 255], "mask colour over the password field");
  } finally {
    await browser.close();
  }
});

test("retries per spec (D9), no trace for sign-in specs, and progress lines (P4-06)", async () => {
  const progress = path.join(dir, "progress.jsonl");
  const report = path.join(dir, "retry-report.json");
  const r = await cli(["run", "--dir", dir, "--report", report, "--progress", progress, "--grep", "@TC-0003|@TC-0004"], {
    BASE_URL: site.url,
    ATA_ALLOWED_HOSTS: "127.0.0.1",
    ATA_ALLOW_PRIVATE: "true",
    ATA_VIDEO: "off",
    ATA_TRACE: "retain-on-failure",
    PW_WORKERS: "2",
    PW_RETRIES: "1",
    ATA_NO_RETRY: "tests/login/TC-0004.spec.ts",
    ATA_NO_TRACE: "tests/login/TC-0004.spec.ts",
    ATA_OUTPUT_DIR: path.join(dir, "test-results-retry"),
  });
  assert.equal(r.code, 1, r.stdout);
  const byTitle = new Map<string, { project: string; results: Result[] }>();
  const walk = (suite: Suite) => {
    for (const s of suite.specs ?? [])
      for (const t of s.tests as { projectName?: string; results: Result[] }[])
        byTitle.set(s.title.split(":")[0], { project: t.projectName ?? "", results: t.results });
    for (const child of suite.suites ?? []) walk(child);
  };
  walk(JSON.parse(fs.readFileSync(report, "utf8")) as Suite);
  assert.equal(byTitle.get("TC-0003")!.results.length, 2, "a failing test runs once more");
  assert.equal(byTitle.get("TC-0003")!.project, "chromium-1440x900");
  assert.equal(byTitle.get("TC-0004")!.project, "chromium-1440x900~once~notrace");
  assert.equal(byTitle.get("TC-0004")!.results.length, 1);
  const lines = fs.readFileSync(progress, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const ends = lines.filter((l) => l.event === "end" && l.file === "tests/contact/TC-0003.spec.ts");
  assert.deepEqual(ends.map((l) => l.attempt), [1, 2]);
  assert.ok(lines.some((l) => l.event === "begin" && l.file === "tests/login/TC-0004.spec.ts"));
  assert.ok(lines.every((l) => !("error" in l)), "progress lines never carry error text");
});
