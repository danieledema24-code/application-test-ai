// Spec-guard vectors, ported from the legacy Node API's test/spec-guard.test.ts (on main), plus the Phase 4 additions (bundle imports,
// test.use with literal trace/video options, every problem reported with its line number).
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSpec } from "../src/spec-guard.ts";

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
    'void testInfo.title;',
  ])
    assert.deepEqual(checkSpec(spec(body)), { ok: true, messages: [] }, body);
});

test("spec guard rejects host access and sandbox escapes, each with a line number", () => {
  const bad = [
    'const fs = require("node:fs");',
    'const { readFileSync } = await import("node:fs");',
    "process.exit(1);",
    "const { env } = process;",
    'process.env.NODE_OPTIONS = "--require /tmp/x.js";',
    'const F = (async () => {}).constructor; await F("return 1")();',
    'const F = page["constr" + "uctor"];',
    "const p = Object.getPrototypeOf(page);",
    "const g = globalThis;",
    'await testInfo.attach("env", { path: "../../.env" });',
    'await page.screenshot({ path: "/tmp/x.png" });',
    'await page.locator("input").setInputFiles("/etc/passwd");',
    "const c = page._channel;",
    'test.use({ launchOptions: { executablePath: "/bin/sh" } });',
    'await expect(page).toHaveScreenshot(["..", "..", ".env"]);',
    'const k = "constructor"; const F = page[k];',
    "const { constructor: F } = async () => {};",
    'const { ["proto" + "type"]: p } = page;',
    "const { _channel: ch } = page;",
    'await fetch("http://169.254.169.254/");',
    "const o = {}; o.__proto__ = page;",
    "const b = await page.context().browser()!.browserType().connectOverCDP(\"http://x\");",
  ];
  for (const body of bad) {
    const r = checkSpec(spec(body));
    assert.equal(r.ok, false, body);
    // The body is line 3 of the generated file (import, test(...), body).
    assert.ok(r.messages.some((m) => m.line === 3), `${body} -> ${JSON.stringify(r.messages)}`);
  }
});

test("only bundle files can be imported; specs take test/expect from the fixtures", () => {
  const unusedFs = checkSpec(spec("", 'import { test, expect } from "../fixtures";\nimport fs from "node:fs";'));
  assert.equal(unusedFs.ok, false, "unused fs import");
  assert.equal(unusedFs.messages[0].line, 2);
  assert.match(unusedFs.messages[0].message, /not "node:fs"/);
  const cp = checkSpec('import { test } from "../../fixtures";\nimport { exec } from "child_process";\ntest("TC-0001: x", async () => { exec("id"); });\n', "tests/contact/TC-0001.spec.ts");
  assert.deepEqual(cp.messages.map((m) => m.line), [2]);
  const pw = checkSpec('import { test } from "@playwright/test";\ntest("TC-0001: x", async () => {});\n', "tests/a/TC-0001.spec.ts");
  assert.equal(pw.ok, false);
  const escape = checkSpec('import { x } from "../../../../etc/passwd";\n', "tests/a/TC-0001.spec.ts");
  assert.equal(escape.ok, false);
  const ok = checkSpec(
    [
      'import { test, expect } from "../../fixtures";',
      'import { ContactPage } from "../../pages/ContactPage";',
      'import { contactForm } from "../../data/factories";',
      'test("TC-0001: x", { tag: ["@TC-0001"] }, async ({ page }) => { const c = new ContactPage(page); await c.goto(); expect(contactForm().name).toBeTruthy(); });',
    ].join("\n"),
    "tests/contact/TC-0001.spec.ts",
  );
  assert.deepEqual(ok, { ok: true, messages: [] });
  const pom = checkSpec(
    'import type { Page } from "@playwright/test";\nexport class ContactPage {\n  readonly page: Page;\n  constructor(page: Page) { this.page = page; }\n  name() { return this.page.getByLabel("Name"); }\n}\n',
    "pages/ContactPage.ts",
  );
  assert.deepEqual(pom, { ok: true, messages: [] }, "page objects may declare a constructor");
  assert.equal(checkSpec('export class X { m() { return this.constructor; } }\n', "pages/XPage.ts").ok, false);
});

test("test.use is allowed only for literal trace/video options", () => {
  assert.equal(checkSpec(spec("", 'import { test, expect } from "../fixtures";\ntest.use({ trace: "off" });')).ok, true);
  assert.equal(checkSpec(spec("", 'import { test, expect } from "../fixtures";\ntest.use({ trace: "off", video: "on" });')).ok, true);
  assert.equal(checkSpec(spec("", 'import { test, expect } from "../fixtures";\ntest.use({ storageState: "x.json" });')).ok, false);
  assert.equal(checkSpec(spec("", 'import { test, expect } from "../fixtures";\nconst t = "off";\ntest.use({ trace: t });')).ok, false);
  assert.equal(checkSpec(spec("", 'import { test, expect } from "../fixtures";\nconst u = test.use;')).ok, false);
});

test("spec guard reports syntax errors with a line number", () => {
  const r = checkSpec(spec('await page.goto("/oops);'));
  assert.equal(r.ok, false);
  assert.match(r.messages[0].message, /Syntax error on line \d+/);
});

test("line numbers survive TypeScript-only lines removed by the transform", () => {
  const code = [
    'import { test } from "../fixtures";',
    "interface A {",
    "  a: string;",
    "}",
    "type B = A;",
    'test("TC-1: x", async ({ page }) => {',
    "  const g = globalThis;",
    "});",
  ].join("\n");
  assert.deepEqual(checkSpec(code).messages.map((m) => m.line), [7]);
});
