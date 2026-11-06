import { test } from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET ??= "test";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.ALLOW_PRIVATE_TARGETS = "true"; // metadata must stay blocked even when private targets are allowed

const { checkSpec } = await import("../src/lib/spec-guard.js");
const { heuristicScript } = await import("../src/services/scriptgen.js");
const { normaliseSpec } = await import("../src/services/playwright-project.js");
const { assertSafeTarget, isMetadataHost, normaliseHost } = await import("../src/lib/ssrf.js");
const { executeApi } = await import("../src/services/api-runner.js");

const spec = (body: string, head = 'import { test, expect } from "../fixtures";') =>
  `${head}\ntest("TC-1: x", async ({ page }, testInfo) => {\n${body}\n});\n`;

test("spec guard accepts normal Playwright specs", () => {
  for (const body of [
    'await page.goto("/login");',
    'await page.getByLabel("Email").fill(process.env.TEST_USERNAME ?? "");',
    'await expect(page.getByRole("heading", { name: "Shop" })).toBeVisible();',
    'const items = await page.locator("li").all(); for (const i of items) await expect(i).toBeVisible();',
    'await test.step("Open", async () => { await page.goto("/"); });',
    'await expect(page.locator("a")).toHaveAttribute("target", "_blank");',
    'const rows = ["a", "b"]; await page.getByText(rows.at(0)!).click(); expect(rows[1]).toBe("b");',
  ]) assert.deepEqual(checkSpec(spec(body)), { ok: true }, body);
});

test("spec guard rejects host access and sandbox escapes", () => {
  const bad = [
    'const fs = require("node:fs");',
    'const { readFileSync } = await import("node:fs");',
    'process.exit(1);',
    'const { env } = process;',
    'process.env.NODE_OPTIONS = "--require /tmp/x.js";',
    'const F = (async () => {}).constructor; await F("return 1")();',
    'const F = page["constr" + "uctor"];',
    'const p = Object.getPrototypeOf(page);',
    'const g = globalThis;',
    'await testInfo.attach("env", { path: "../../.env" });',
    'await page.screenshot({ path: "/tmp/x.png" });',
    'await page.locator("input").setInputFiles("/etc/passwd");',
    'const c = page._channel;',
    'test.use({ launchOptions: { executablePath: "/bin/sh" } });',
    'await expect(page).toHaveScreenshot(["..", "..", ".env"]);',
    'const k = "constructor"; const F = page[k];',
    'const { constructor: F } = async () => {};',
    'const { ["proto" + "type"]: p } = page;',
    'const { _channel: ch } = page;',
    'await fetch("http://169.254.169.254/");',
  ];
  for (const body of bad) assert.equal(checkSpec(spec(body)).ok, false, body);
  assert.equal(checkSpec(spec("", 'import { test, expect } from "../fixtures";\nimport fs from "node:fs";')).ok, false, "unused fs import");
});

test("spec guard reports syntax errors with a line number", () => {
  const r = checkSpec(spec('await page.goto("/oops);'));
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /Syntax error on line \d+/);
});

test("generated scripts escape titles and step text (no code injection)", () => {
  const nasty = 'x\nthrow new Error("INJECTED");// \\ "quote"   end';
  const code = heuristicScript({ key: "TC-9", title: nasty, expectedResult: "ok" }, [
    { action: nasty },
    { action: "Click the weird \\ button\nnext" },
    { action: "Enter text into the odd field \\" },
  ]);
  assert.deepEqual(checkSpec(normaliseSpec(code)), { ok: true });
  assert.ok(!/^throw new Error\("INJECTED"\)/m.test(code), "title must not start a new line of code");
  assert.equal(code.split("\n")[0].startsWith("// TC-9: x throw"), true);
});

test("SSRF guard sees IPv4 hidden in IPv6 forms", async () => {
  assert.equal(normaliseHost("[::ffff:a9fe:a9fe]"), "169.254.169.254");
  assert.equal(normaliseHost("::ffff:169.254.169.254"), "169.254.169.254");
  assert.equal(normaliseHost("64:ff9b::a9fe:a9fe"), "169.254.169.254");
  assert.equal(isMetadataHost("169.254.170.2"), true);
  for (const url of ["http://[::ffff:a9fe:a9fe]/", "http://[::ffff:169.254.169.254]/", "http://[0:0:0:0:0:ffff:a9fe:a9fe]/", "http://[64:ff9b::a9fe:a9fe]/"])
    await assert.rejects(assertSafeTarget(url), /metadata/i, url);
});

test("API tests cannot redirect requests (and credentials) to another host", async () => {
  // Closed local port: nothing leaves the machine. Each request is either blocked or stays on the environment host.
  const env = { baseUrl: "http://127.0.0.1:9/api", encryptedCredentials: null } as never;
  for (const path of ["http://127.0.0.1:4987/exfil", "https://evil.example/x", "//evil.example/x", "\\\\evil.example/x"]) {
    const ex = await executeApi({ method: "GET", path, auth: "BEARER" }, env);
    const blocked = /relative to the environment URL/.test(ex.assertions[0]?.message ?? "");
    assert.ok(blocked || new URL(ex.request.url).host === "127.0.0.1:9", `${path} -> ${ex.request.url}`);
  }
  const abs = await executeApi({ method: "GET", path: "http://127.0.0.1:4987/exfil", auth: "BEARER" }, env);
  assert.match(abs.assertions[0].message, /relative to the environment URL/);
});
