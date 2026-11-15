// `qa perf` (P5-01a): accuracy, the max_rps token bucket, refusing over-limit profiles before any request, the
// kill switch, SIGTERM, network-policy parity on the shared vectors, resolve-once pinning, redirects not followed,
// and the k6 export. Each test runs against its own local fixture server and reads that server's access log.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import * as acorn from "acorn";
import { simple } from "acorn-walk";
import { checkLimits, parseConfig, type PerfConfig } from "../src/perf/config.ts";
import { Histogram } from "../src/perf/histogram.ts";
import { checkSyntax, k6Script } from "../src/perf/k6.ts";
import { LoadRun } from "../src/perf/runner.ts";
import { preflight } from "../src/perf/target.ts";
import { CLI, ROOT, cli } from "./helpers.ts";
import { VECTORS, fill } from "./vectors.ts";

interface Fixture {
  port: number;
  origin: string;
  log: { t: number; method: string; url: string; host: string }[];
  close: () => Promise<void>;
}

function fixture(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Fixture> {
  const log: Fixture["log"] = [];
  const server = http.createServer((req, res) => {
    log.push({ t: performance.now(), method: req.method ?? "", url: req.url ?? "", host: req.headers.host ?? "" });
    handler(req, res);
  });
  server.keepAliveTimeout = 30_000;
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        log,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    }),
  );
}

const ok = (_req: http.IncomingMessage, res: http.ServerResponse) => res.writeHead(200, { "content-type": "text/plain" }).end("ok");

function config(origin: string, over: Record<string, unknown> = {}): PerfConfig {
  return parseConfig({
    origin,
    targets: [{ path: "/a", weight: 3 }, { path: "/b", weight: 1 }],
    stages: [{ duration_s: 1, target_vus: 2 }, { duration_s: 2, target_vus: 2 }],
    think_time_ms: { min: 0, max: 0 },
    max_rps: 50,
    allowed_hosts: [new URL(origin).hostname],
    allow_private: true,
    ...over,
  });
}

const LIMITS = { vus: 50, rps: 50, duration_s: 600 };
const quiet = () => undefined;

function scratch(name: string): string {
  const dir = path.join(ROOT, ".runs", `perf-${name}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("histogram percentiles are within 1 % of the recorded values", () => {
  const h = new Histogram();
  for (let i = 1; i <= 1000; i++) h.record(i);
  for (const [q, exact] of [[0.5, 500], [0.9, 900], [0.95, 950], [0.99, 990]] as const) {
    const got = h.percentile(q)!;
    assert.ok(Math.abs(got - exact) / exact <= 0.01, `p${q * 100}: ${got} vs ${exact}`);
  }
  assert.equal(h.percentile(1), 1000);
});

test("a 10-user, 20 s run against a 50 ms fixture: p50 in 50–65 ms, counts equal the access log", async () => {
  const site = await fixture((req, res) => setTimeout(() => ok(req, res), 50));
  try {
    const c = config(site.origin, {
      stages: [{ duration_s: 1, target_vus: 10 }, { duration_s: 19, target_vus: 10 }],
      think_time_ms: { min: 100, max: 200 },
      max_rps: 200,
    });
    const s = (await new LoadRun({ config: c, limits: { vus: 50, rps: 200, duration_s: 600 }, version: "test", progress: quiet }).run()) as any;
    assert.equal(s.status, "completed");
    const p50 = s.overall.latency_ms.p50;
    assert.ok(p50 >= 50 && p50 <= 65, `p50 ${p50}`);
    assert.equal(s.overall.count, site.log.length);
    assert.equal(s.targets.reduce((n: number, t: any) => n + t.count, 0), s.overall.count);
    assert.ok(site.log.every((l) => l.method === "GET"));
    assert.equal(s.timeseries.length, 20);
  } finally {
    await site.close();
  }
});

test("max_rps 20 holds in every one-second window and the total is within 5 % of 20 per second", async () => {
  const site = await fixture(ok);
  try {
    const c = config(site.origin, {
      stages: [{ duration_s: 1, target_vus: 10 }, { duration_s: 9, target_vus: 10 }],
      max_rps: 20,
    });
    const s = (await new LoadRun({ config: c, limits: LIMITS, version: "test", progress: quiet }).run()) as any;
    const times = site.log.map((l) => l.t).sort((a, b) => a - b);
    let worst = 0;
    for (let i = 0, j = 0; i < times.length; i++) {
      while (times[i] - times[j] >= 1000) j++;
      worst = Math.max(worst, i - j + 1);
    }
    assert.ok(worst <= 21, `a one-second window had ${worst} requests`);
    assert.ok(Math.abs(s.overall.count - 200) <= 10, `total ${s.overall.count}, expected 200 ± 5 %`);
  } finally {
    await site.close();
  }
});

test("a profile over a hard limit is refused with exit code 2 before any request", async () => {
  const site = await fixture(ok);
  const dir = scratch("limits");
  try {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ ...config(site.origin), stages: [{ duration_s: 5, target_vus: 51 }] }));
    const r = await cli(["perf", "--config", file, "--max-vus", "50", "--max-rps", "50", "--max-duration", "600"]);
    assert.equal(r.code, 2);
    assert.equal(r.json.error, "Profile exceeds the platform limit: 51 users (limit 50)");
    const rps = await cli(["perf", "--config", file, "--max-vus", "60", "--max-rps", "10", "--max-duration", "600"]);
    assert.equal(rps.json.error, "Profile exceeds the platform limit: 50 requests a second (limit 10)");
    const above = await cli(["perf", "--config", file, "--max-vus", "201", "--max-rps", "50", "--max-duration", "600"]);
    assert.match(above.json.error, /compiled maximum \(200\)/);
    const none = await cli(["perf", "--config", file]);
    assert.match(none.json.error, /--max-vus/);
    assert.equal(site.log.length, 0);
    assert.throws(() => parseConfig({ ...config(site.origin), targets: [{ path: "//evil.example/x", weight: 1 }] }), /single "\/"/);
    assert.throws(() => parseConfig({ ...config(site.origin), targets: [{ path: "/a", weight: 1, method: "POST" }] }), /Only GET/);
    assert.throws(() => parseConfig({ ...config(site.origin), headers: { cookie: "x" } }), /unknown field/);
    const eleven = Array.from({ length: 11 }, (_, i) => ({ path: `/p${i}`, weight: 1 }));
    assert.throws(() => parseConfig({ ...config(site.origin), targets: eleven }), /up to 10 pages/);
    assert.throws(() => checkLimits(config(site.origin, { max_duration_s: 2 }), LIMITS), /duration cap/);
  } finally {
    await site.close();
  }
});

test("a fixture answering 500 is stopped by the kill switch between 10 and 15 s", async () => {
  const site = await fixture((_req, res) => res.writeHead(500).end("boom"));
  try {
    const c = config(site.origin, { stages: [{ duration_s: 1, target_vus: 2 }, { duration_s: 59, target_vus: 2 }], max_rps: 10 });
    const started = performance.now();
    const s = (await new LoadRun({ config: c, limits: LIMITS, version: "test", progress: quiet }).run()) as any;
    const took = (performance.now() - started) / 1000;
    assert.ok(took >= 10 && took <= 15, `stopped after ${took} s`);
    assert.equal(s.status, "aborted");
    assert.equal(s.reason, "Stopped automatically: 100 % errors over 10 s");
  } finally {
    await site.close();
  }
});

test("SIGTERM mid-run: the CLI exits within 2 s and flushes a partial summary marked stopped", async () => {
  const site = await fixture((req, res) => setTimeout(() => ok(req, res), 200));
  const dir = scratch("sigterm");
  try {
    const file = path.join(dir, "config.json");
    const summary = path.join(dir, "summary.json");
    fs.writeFileSync(file, JSON.stringify({ ...config(site.origin), stages: [{ duration_s: 1, target_vus: 5 }, { duration_s: 59, target_vus: 5 }] }));
    const child = spawn(
      process.execPath,
      [CLI, "perf", "--config", file, "--summary", summary, "--max-vus", "50", "--max-rps", "50", "--max-duration", "600"],
      { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (out.includes('"t":3')) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });
    const sent = performance.now();
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    const took = performance.now() - sent;
    assert.ok(took <= 2000, `exited ${took} ms after SIGTERM`);
    assert.equal(code, 1);
    const s = JSON.parse(fs.readFileSync(summary, "utf8"));
    assert.equal(s.status, "stopped");
    assert.equal(s.reason, "Stopped by a person");
    assert.ok(s.overall.count > 0 && s.timeseries.length >= 3);
  } finally {
    await site.close();
  }
});

test("a control file stops the run like SIGTERM", async () => {
  const site = await fixture(ok);
  const dir = scratch("control");
  try {
    const control = path.join(dir, "stop");
    const c = config(site.origin, { stages: [{ duration_s: 60, target_vus: 2 }], max_rps: 10 });
    const run = new LoadRun({ config: c, limits: LIMITS, version: "test", progress: quiet, controlFile: control });
    setTimeout(() => fs.writeFileSync(control, "stop"), 1500);
    const started = performance.now();
    const s = (await run.run()) as any;
    assert.equal(s.status, "stopped");
    assert.ok(performance.now() - started < 3500);
  } finally {
    await site.close();
  }
});

test("the shared network-policy vectors get the same verdict as the Python policy", async () => {
  const port = 4100;
  for (const v of VECTORS.vectors) {
    const verdict = await preflight(
      fill(v.url, port),
      {
        approvedOrigin: fill(VECTORS.approved_origin, port),
        allowedHosts: VECTORS.allowed_hosts,
        allowPrivate: VECTORS.allow_private,
        resolver: async () => v.resolves_to ?? ["93.184.216.34"],
      },
      v.top_level,
    );
    assert.equal(verdict.allowed ? "allowed" : "blocked", v.verdict, v.url);
    if (v.code && !verdict.allowed) assert.equal(verdict.code, v.code, v.url);
  }
});

test("metadata and private targets are refused before any request; the host is resolved once and pinned", async () => {
  const site = await fixture(ok);
  try {
    const meta = config(`http://rebind.example.com:${site.port}`, { allowed_hosts: ["rebind.example.com"] });
    await assert.rejects(
      new LoadRun({ config: meta, limits: LIMITS, version: "test", progress: quiet, resolver: async () => ["169.254.169.254"] }).run(),
      /Cloud metadata endpoint \(metadata\)/,
    );
    const priv = config(site.origin, { allow_private: false });
    await assert.rejects(new LoadRun({ config: priv, limits: LIMITS, version: "test", progress: quiet }).run(), /private_address/);
    assert.equal(site.log.length, 0);
    // A name the system resolver doesn't know reaches the fixture only through the pinned address, and the
    // resolver is asked once even when later answers would point elsewhere (DNS rebinding).
    let asked = 0;
    const pinned = config(`http://shop.test:${site.port}`, { allowed_hosts: ["shop.test"] });
    const s = (await new LoadRun({
      config: pinned,
      limits: LIMITS,
      version: "test",
      progress: quiet,
      resolver: async () => (asked++ === 0 ? ["127.0.0.1"] : ["169.254.169.254"]),
    }).run()) as any;
    assert.equal(asked, 1);
    assert.equal(s.overall.ok, site.log.length);
    assert.ok(site.log.length > 0 && site.log.every((l) => l.host === `shop.test:${site.port}`));
  } finally {
    await site.close();
  }
});

test("a 302 to another host is counted as a redirect and not followed", async () => {
  const other = await fixture(ok);
  const site = await fixture((_req, res) => res.writeHead(302, { location: `${other.origin}/elsewhere` }).end());
  try {
    const s = (await new LoadRun({ config: config(site.origin), limits: LIMITS, version: "test", progress: quiet }).run()) as any;
    assert.ok(s.overall.count > 0);
    assert.equal(s.overall.redirects, s.overall.count);
    assert.equal(s.overall.errors, 0);
    assert.equal(other.log.length, 0);
  } finally {
    await site.close();
    await other.close();
  }
});

test("--export-k6 writes a script that parses and matches the profile, with only the approved origin", async () => {
  const dir = scratch("k6");
  const origin = "http://localhost:4100";
  const raw = {
    origin,
    targets: [{ path: "/", weight: 3 }, { path: "/products/2", weight: 1 }],
    stages: [{ duration_s: 30, target_vus: 10 }, { duration_s: 90, target_vus: 10 }, { duration_s: 10, target_vus: 0 }],
    think_time_ms: { min: 500, max: 1500 },
    max_rps: 20,
    thresholds: [
      { metric: "p95", scope: "path", path: "/products/2", op: "<", value: 800, source: "default" },
      { metric: "error_rate", scope: "all", op: "<", value: 0.01, source: "default" },
    ],
    allowed_hosts: ["localhost"],
    allow_private: true,
  };
  const file = path.join(dir, "config.json");
  const out = path.join(dir, "script.js");
  fs.writeFileSync(file, JSON.stringify(raw));
  const r = await cli(["perf", "--config", file, "--export-k6", out, "--max-vus", "50", "--max-rps", "50", "--max-duration", "600"]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.label, "Not run by the platform");
  const script = fs.readFileSync(out, "utf8");
  const ast = checkSyntax(script);
  const strings: string[] = [];
  simple(ast as acorn.Node, { Literal: (n: any) => typeof n.value === "string" && strings.push(n.value) });
  const urls = [...script.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(urls)], [origin]);
  assert.ok(strings.includes(origin));
  assert.match(script, /"duration": "30s",\s+"target": 10/);
  assert.match(script, /"duration": "10s",\s+"target": 0/);
  assert.match(script, /"http_req_duration\{path:\/products\/2\}": \[\s+"p\(95\)<800"/);
  assert.match(script, /"http_req_failed": \[\s+"rate<0.01"/);
  assert.match(script, /"path": "\/products\/2",\s+"weight": 1/);
  assert.match(script, /rps: 20/);
  assert.match(script, /Not run by the platform/);
  // The generator itself never parses it as anything but data: a hostile path can't break out of its literal.
  const hostile = parseConfig({ ...raw, targets: [{ path: '/x"});import("http://evil.example/");//', weight: 1 }], thresholds: [] });
  const hostileAst = checkSyntax(k6Script(hostile, "test"));
  let imports = 0;
  const literals: string[] = [];
  simple(hostileAst as acorn.Node, {
    ImportExpression: () => imports++,
    Literal: (n: any) => typeof n.value === "string" && literals.push(n.value),
  });
  assert.equal(imports, 0);
  assert.ok(literals.includes(hostile.targets[0].path));
});
