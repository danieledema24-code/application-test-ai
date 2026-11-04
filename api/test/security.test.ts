import { test } from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET ??= "test";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.ALLOW_PRIVATE_TARGETS = "false";

const { assertSafeTarget, hostAllowed } = await import("../src/lib/ssrf.js");
const { redactDeep, redactHeaders, redactText } = await import("../src/lib/redact.js");
const { decrypt, encrypt } = await import("../src/lib/crypto.js");
const { validateSchema } = await import("../src/services/api-runner.js");
const { heuristicScript } = await import("../src/services/scriptgen.js");
const { isPlaywrightTestSpec, normaliseSpec } = await import("../src/services/playwright-project.js");
const { provided } = await import("../src/lib/json.js");

test("SSRF guard blocks metadata, private and non-http targets", async () => {
  for (const url of ["http://169.254.169.254/latest/meta-data", "http://metadata.google.internal/", "http://127.0.0.1:8080", "http://10.0.0.5", "http://192.168.1.1", "file:///etc/passwd", "ftp://example.com"])
    await assert.rejects(assertSafeTarget(url), Error, url);
  assert.equal(hostAllowed("http://169.254.169.254/x", ["169.254.169.254"]), false);
  assert.equal(hostAllowed("https://app.example.com/a", ["example.com"]), true);
  assert.equal(hostAllowed("https://evil.com/a", ["example.com"]), false);
});

test("redaction removes secrets from text, headers and nested objects", () => {
  assert.equal(redactText("token=supersecret123 ok", ["supersecret123"]), "token=[REDACTED] ok");
  assert.match(redactText("Authorization: Bearer abcdefghijklmnop"), /Bearer \[REDACTED\]/);
  assert.deepEqual(redactHeaders({ Authorization: "Bearer x", accept: "json" }), { Authorization: "[REDACTED]", accept: "json" });
  assert.deepEqual(redactDeep({ user: { password: "p4ss", name: "a" } }), { user: { password: "[REDACTED]", name: "a" } });
});

test("credential encryption round-trips and is non-deterministic", () => {
  const a = encrypt("secret"), b = encrypt("secret");
  assert.notEqual(a, b);
  assert.equal(decrypt(a), "secret");
});

test("JSON schema subset validator reports type mismatches", () => {
  const schema = { type: "object", required: ["id", "price"], properties: { id: { type: "integer" }, price: { type: "number" } } };
  assert.deepEqual(validateSchema({ id: 1, price: 2.5 }, schema, "$"), []);
  assert.deepEqual(validateSchema({ id: 1, price: "2.5" }, schema, "$"), ["$.price: expected number, got string"]);
  assert.deepEqual(validateSchema({ id: 1 }, schema, "$"), ["$.price: required"]);
});

test("PATCH helper keeps only keys the client sent", () => {
  assert.deepEqual(provided({ title: "x", priority: "MEDIUM", steps: [] }, { title: "x" }), { title: "x" });
});

test("rule-based script generator emits contract-compliant code without secrets", () => {
  const code = heuristicScript({ key: "TC-1", title: "Login", expectedResult: 'Shows "My account"' }, [
    { action: "Open /login" }, { action: 'Enter a valid password in the "Password" field' }, { action: 'Click "Sign in"' }, { action: 'Verify the page title contains "Account"' },
  ]);
  assert.match(code, /import \{ test, expect \} from "\.\.\/fixtures"/);
  assert.match(code, /test\("TC-1: Login", async \(\{ page \}\)/);
  assert.match(code, /process\.env\.TEST_PASSWORD/);
  assert.ok(isPlaywrightTestSpec(code));
  assert.match(code, /toHaveTitle\(new RegExp\("Account"\)\)/);
  assert.match(code, /getByText\("My account"\)/);
});

test("specs importing @playwright/test are pointed at the policy fixtures", () => {
  const code = normaliseSpec('import { test, expect } from "@playwright/test";\ntest("x", async ({ page }) => {});');
  assert.match(code, /from "\.\.\/fixtures"/);
  assert.ok(!code.includes("@playwright/test"));
});
