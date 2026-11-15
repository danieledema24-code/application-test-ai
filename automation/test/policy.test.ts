// The shared policy vectors (automation/test/policy-vectors.json) against the Node policy. The Python policy runs
// the same file in backend/tests/unit/test_ssrf.py; browser.test.ts runs the browser-capable ones in Chromium.
import assert from "node:assert/strict";
import { test } from "node:test";
import { NetworkPolicy, embeddedIPv4, parseIPv4, parseIPv6, isPrivateIp } from "../platform/policy.ts";
import { VECTORS, fill } from "./vectors.ts";

test("every shared vector gets the expected verdict and code", async () => {
  const port = 4100;
  for (const v of VECTORS.vectors) {
    const policy = new NetworkPolicy({
      allowedHosts: VECTORS.allowed_hosts,
      approvedOrigin: fill(VECTORS.approved_origin, port),
      allowPrivate: VECTORS.allow_private,
      resolver: async () => v.resolves_to ?? ["93.184.216.34"],
    });
    const verdict = await policy.check(fill(v.url, port), v.top_level);
    assert.equal(verdict.allowed ? "allowed" : "blocked", v.verdict, v.url);
    if (v.code) assert.equal(verdict.code, v.code, v.url);
  }
});

test("IP literal parsing matches the Python policy", () => {
  assert.deepEqual(parseIPv4("2852039166"), [169, 254, 169, 254]);
  assert.deepEqual(parseIPv4("0251.0376.0251.0376"), [169, 254, 169, 254]);
  assert.deepEqual(parseIPv4("127.1"), [127, 0, 0, 1]);
  assert.deepEqual(parseIPv4("1.2.3"), [1, 2, 0, 3]);
  assert.equal(parseIPv4("256.1.1.1"), null);
  assert.deepEqual(embeddedIPv4(parseIPv6("::ffff:a9fe:a9fe")!), [169, 254, 169, 254]);
  assert.deepEqual(embeddedIPv4(parseIPv6("64:ff9b::a9fe:a9fe")!), [169, 254, 169, 254]);
  assert.deepEqual(embeddedIPv4(parseIPv6("2002:a9fe:a9fe::")!), [169, 254, 169, 254]);
  assert.deepEqual(embeddedIPv4(parseIPv6("::ffff:169.254.169.254")!), [169, 254, 169, 254]);
  assert.equal(isPrivateIp(parseIPv6("2606:4700::1111")!), false);
  assert.equal(isPrivateIp(parseIPv6("fe80::1")!), true);
  assert.equal(isPrivateIp([93, 184, 216, 34]), false);
  assert.equal(isPrivateIp([100, 64, 0, 1]), true);
});

test("loopback is allowed only for the approved origin, and only with allowPrivate", async () => {
  const on = new NetworkPolicy({ allowedHosts: ["127.0.0.1"], approvedOrigin: "http://127.0.0.1:4100", allowPrivate: true });
  const off = new NetworkPolicy({ allowedHosts: ["127.0.0.1"], approvedOrigin: "http://127.0.0.1:4100", allowPrivate: false });
  assert.equal((await on.check("http://127.0.0.1:4100/a", false)).allowed, true);
  assert.equal((await on.check("http://127.0.0.1:4101/a", false)).allowed, false);
  assert.equal((await off.check("http://127.0.0.1:4100/a", false)).code, "private_address");
});
