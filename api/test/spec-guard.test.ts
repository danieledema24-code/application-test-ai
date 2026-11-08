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

test("CSV cells cannot start a spreadsheet formula", async () => {
  const { csvCell } = await import("../src/lib/csv.js");
  assert.equal(csvCell('=HYPERLINK("http://evil.example","x")'), `"'=HYPERLINK(""http://evil.example"",""x"")"`);
  assert.equal(csvCell("@SUM(1+1)"), "'@SUM(1+1)");
  assert.equal(csvCell("+cmd|' /C calc'!A0"), "'+cmd|' /C calc'!A0");
  assert.equal(csvCell("-2+3"), "'-2+3");
  assert.equal(csvCell("Login works"), "Login works");
  assert.equal(csvCell("a,b"), '"a,b"');
});

test("session tokens in query strings are masked for logs", async () => {
  const { redactUrlTokens } = await import("../src/lib/redact.js");
  assert.equal(redactUrlTokens("/api/evidence/x/file?token=eyJabc.def&download=1"), "/api/evidence/x/file?token=[REDACTED]&download=1");
  assert.equal(redactUrlTokens("/a?x=1&access_token=s3cr3t"), "/a?x=1&access_token=[REDACTED]");
  assert.equal(redactUrlTokens("/api/projects?search=token"), "/api/projects?search=token");
});

test("rule-based scripts turn verify steps into real checks", () => {
  const code = heuristicScript({ key: "TC-2", title: "Message required", expectedResult: "The form is not accepted while Message is empty" }, [
    { action: "Open /contact" },
    { action: 'Enter "Jane Doe" in the "Name" field' },
    { action: 'Leave the "Message" field empty' },
    { action: "Submit the form" },
    { action: "Verify the form is not accepted", expected: "A message asks for Message" },
    { action: "Verify the user is signed in" },
    { action: "Press Tab repeatedly through the interactive elements" },
    { action: "Verify the vibe is immaculate" },
  ]);
  assert.deepEqual(checkSpec(normaliseSpec(code)), { ok: true });
  assert.match(code, /getByLabel\("Message", \{ exact: false \}\)\.first\(\)\.fill\(""\)/);
  assert.match(code, /page\.locator\("form"\)\.or\(.*\)\.first\(\), "A message asks for Message"\)\.toBeVisible\(\)/);
  assert.match(code, /input\[type="password"\]:visible'\), .*\)\.toHaveCount\(0\)/);
  assert.match(code, /for \(let i = 0; i < 5; i\+\+\) await page\.keyboard\.press\("Tab"\)/);
  assert.match(code, /framenavigated/);
  assert.match(code, /TODO: automate check — wording not recognised: Verify the vibe is immaculate/);
  assert.doesNotMatch(code, /getByRole\("button", \{ name: "Tab/);
  const long = heuristicScript({ key: "TC-3", title: "x", expectedResult: "" }, [{ action: `Enter "${"A".repeat(256)}" in the "Name" field` }]);
  assert.ok(long.includes(`fill("${"A".repeat(256)}")`), "256-character value is used, not a fragment of the sentence");
});

test("failures are described in plain language", async () => {
  const { describeFailure } = await import("../src/services/runner.js");
  assert.equal(
    describeFailure("Verify the form is not accepted", "Error: A message asks for Message\n\nexpect(locator).toBeVisible() failed", { url: "/contact", title: "Contact", heading: "Thank you", messages: ["Message sent"] }),
    'Step "Verify the form is not accepted" failed: A message asks for Message. The page showed "Thank you" at /contact (Message sent).',
  );
  assert.equal(describeFailure(null, "", null), "The test failed during setup.");
});

test("rule-based generation turns a feature description into concrete cases", async () => {
  const { generateCases } = await import("../src/services/generation.js");
  const contact = { url: "http://x/contact", title: "Contact", status: 200, depth: 1, links: [], buttons: [], navItems: [], headings: ["Contact us"], screenshotEvidenceId: null,
    forms: [{ action: "/contact", method: "post", fields: [{ name: "name", label: "Name", type: "text", required: true }, { name: "email", label: "Email", type: "email", required: true }, { name: "message", label: "Message", type: "textarea", required: false }] }] };
  const all = ["FUNCTIONAL", "POSITIVE", "NEGATIVE", "FORM_VALIDATION", "BOUNDARY", "AUTHENTICATION"];
  const r = await generateCases({ source: "DESCRIPTION", applicationUrl: "http://x", categories: all, pages: [contact],
    text: "The contact page at /contact lets a visitor send a message. Name, Email and Message are required. The email must be a valid address. After sending, a thank-you message is shown." });
  assert.deepEqual(r.cases.map((c) => c.title), [
    "Submit Contact with valid data", '"Name" is required on Contact', '"Email" is required on Contact', '"Message" is required on Contact', "Invalid email address is rejected on Contact",
  ]);
  const msg = r.cases[3];
  assert.deepEqual(msg.steps.map((s) => s.action), ["Open /contact", 'Enter "Jane Doe" in the "Name" field', 'Enter "jane.doe@example.com" in the "Email" field', 'Leave the "Message" field empty', "Submit the form", "Verify the form is not accepted"]);
  for (const c of r.cases) assert.deepEqual(checkSpec(normaliseSpec(heuristicScript({ key: "TC-1", title: c.title, expectedResult: c.expectedResult }, c.steps))), { ok: true }, c.title);

  const login = await generateCases({ source: "USER_STORY", applicationUrl: "http://x", categories: all, pages: [],
    text: "As a registered customer I want to sign in with my email and password so that I can see my account. A wrong password shows an error." });
  assert.deepEqual(login.cases.map((c) => c.title), ["Sign in on the sign-in page with valid credentials", "Sign-in with a wrong password is refused on the sign-in page"]);
  assert.equal(login.cases[0].steps[0].action, "Open /login");

  const vague = await generateCases({ source: "REQUIREMENTS", applicationUrl: "http://x", categories: all, pages: [], text: "Reports are exported every night to the archive." });
  assert.match(vague.cases[0].title, /^Manual check: /);
});

test("discovery cases name pages by path when the site reuses one title, and spot sign-up forms", async () => {
  const { generateCases } = await import("../src/services/generation.js");
  const page = (path: string, fields: { name: string; label: string; type: string; required: boolean }[] = []) => ({
    url: `https://x.example${path}`, title: "Acme – Land Interviews Faster", status: 200, depth: 1, links: [], buttons: [], navItems: [], headings: [], screenshotEvidenceId: null,
    forms: fields.length ? [{ action: path, method: "post", fields }] : [] });
  const email = { name: "email", label: "Email Address", type: "email", required: true }, pwd = { name: "password", label: "Password", type: "password", required: true };
  const r = await generateCases({ source: "DISCOVERY", applicationUrl: "https://x.example", categories: ["FUNCTIONAL", "POSITIVE", "NEGATIVE", "AUTHENTICATION", "FORM_VALIDATION"],
    pages: [page("/"), page("/auth/signin", [email, pwd]), page("/auth/signup", [{ name: "name", label: "Full Name", type: "text", required: true }, email, pwd])] });
  const titles = r.cases.map((c) => c.title);
  assert.ok(titles.includes("The home page loads successfully"));
  assert.ok(titles.includes("Submit login on the Sign-in page (/auth/signin) with valid data"));
  assert.ok(titles.includes("Create an account on the Sign-up page (/auth/signup) with valid data"));
  assert.ok(!titles.some((t) => /login.*Sign-up|invalid password.*Sign-up/i.test(t)), "sign-up is not treated as a login");
});
