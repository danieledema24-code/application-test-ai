// `qa validate` end to end: guard, tsc, eslint and tag checks on a bundle directory, offline.
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";
import { cli, workspace } from "./helpers.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const CONTACT_PAGE = `import type { Locator, Page } from "@playwright/test";

export class ContactPage {
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }
  async goto(): Promise<void> {
    await this.page.goto("/contact");
  }
  get form(): { name: string; locator: Locator } {
    return { name: "Contact us", locator: this.page.getByRole("form", { name: "Contact us" }) };
  }
  get message(): Locator {
    return this.page.getByLabel("Message");
  }
}
`;

const CLEAN_SPEC = `import { test } from "../../fixtures";
import { ContactPage } from "../../pages/ContactPage";

test("TC-0007: Contact form blocks an empty Message", { tag: ["@TC-0007", "@regression"] }, async ({ page, qa }) => {
  const contact = new ContactPage(page);
  await test.step("Open the Contact us page", async () => {
    await contact.goto();
  });
  await test.step("Leave Message empty and press Send message", async () => {
    await contact.message.fill("");
    await qa.press("Send message");
    await qa.expectSubmissionBlocked(contact.form);
    await qa.expectFieldFlagged("Message");
  });
});
`;

test("a clean bundle passes guard, tsc, eslint and tags", async () => {
  const dir = await workspace("clean", { "pages/ContactPage.ts": CONTACT_PAGE, "tests/contact/TC-0007.spec.ts": CLEAN_SPEC });
  dirs.push(dir);
  const r = await cli(["validate", "--dir", dir]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.ok, true);
  assert.deepEqual(Object.keys(r.json.files).sort(), ["pages/ContactPage.ts", "tests/contact/TC-0007.spec.ts"]);
  const spec = r.json.files["tests/contact/TC-0007.spec.ts"];
  for (const check of ["guard", "tsc", "eslint", "tags"]) assert.equal(spec[check].ok, true, `${check}: ${JSON.stringify(spec[check])}`);
  assert.deepEqual(spec.tags.keys, ["TC-0007"]);
});

test("waitForTimeout is an eslint error and makes the file invalid", async () => {
  const waits = CLEAN_SPEC.replace('await contact.message.fill("");', 'await contact.message.fill("");\n    await page.waitForTimeout(500);');
  const dir = await workspace("waits", { "pages/ContactPage.ts": CONTACT_PAGE, "tests/contact/TC-0007.spec.ts": waits });
  dirs.push(dir);
  const r = await cli(["validate", "--dir", dir, "--files", "tests/contact/TC-0007.spec.ts"]);
  assert.equal(r.code, 1);
  const spec = r.json.files["tests/contact/TC-0007.spec.ts"];
  assert.equal(spec.eslint.ok, false);
  assert.ok(spec.eslint.messages.some((m: { line: number; message: string }) => m.line === 11 && /waitForTimeout/.test(m.message)), JSON.stringify(spec.eslint));
  assert.equal(spec.guard.ok, true);
});

test("old spec-guard vectors are rejected by validate with line numbers", async () => {
  const vectors: Record<string, string> = {
    "node-fs": 'import fs from "node:fs";\nvoid fs;',
    "child-process": 'import { exec } from "child_process";\nvoid exec;',
    globalthis: "const g = globalThis;\nvoid g;",
    constructor: 'const F = (async () => {}).constructor;\nvoid F;',
    "set-input-files": 'await page.locator("input").setInputFiles("/etc/passwd");',
    "connect-over-cdp": 'const t = page.context().browser()!.browserType();\nawait t.connectOverCDP("http://127.0.0.1:9222");',
    proto: "const o: Record<string, unknown> = {};\no.__proto__ = page;",
    "host-path": 'await page.screenshot({ path: "/tmp/x.png" });',
  };
  const files: Record<string, string> = {};
  Object.entries(vectors).forEach(([name, body], i) => {
    const key = `TC-${String(100 + i).padStart(4, "0")}`;
    const imports = body.startsWith("import") ? body.split("\n")[0] + "\n" : "";
    const rest = body.startsWith("import") ? body.split("\n").slice(1).join("\n") : body;
    files[`tests/guard/${key}.spec.ts`] =
      `import { test } from "../../fixtures";\n${imports}test("${key}: ${name}", { tag: ["@${key}"] }, async ({ page }) => {\n${rest}\n});\n`;
  });
  const dir = await workspace("guard", files);
  dirs.push(dir);
  const r = await cli(["validate", "--dir", dir]);
  assert.equal(r.code, 1);
  for (const [file, rep] of Object.entries(r.json.files) as [string, { guard: { ok: boolean; messages: { line: number | null }[] } }][]) {
    assert.equal(rep.guard.ok, false, file);
    assert.ok(rep.guard.messages.every((m) => typeof m.line === "number" && m.line > 0), `${file}: ${JSON.stringify(rep.guard)}`);
  }
});

test("a spec whose title, tag and file name disagree fails the tag check", async () => {
  const spec = CLEAN_SPEC.replace('"@TC-0007", ', "");
  const dir = await workspace("tags", { "pages/ContactPage.ts": CONTACT_PAGE, "tests/contact/TC-0008.spec.ts": spec });
  dirs.push(dir);
  const r = await cli(["validate", "--dir", dir]);
  const tags = r.json.files["tests/contact/TC-0008.spec.ts"].tags;
  assert.equal(tags.ok, false);
  assert.equal(tags.messages.length, 2, JSON.stringify(tags));
});

test("validate refuses files outside the bundle", async () => {
  const dir = await workspace("escape", {});
  dirs.push(dir);
  const r = await cli(["validate", "--dir", dir, "--files", "../../package.json"]);
  assert.equal(r.code, 2);
  assert.match(r.json.error, /Invalid file path|outside the bundle/);
});
