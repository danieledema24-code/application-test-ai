// `qa perf` configuration (P5-01a, decision D17/D18): parsed strictly, checked against the hard limits before any
// request is sent. GET only, same origin only, never signed in (no headers, cookies or credentials can be given).
import fs from "node:fs";

/** The generator's own compiled maximum: `--max-*` above it are refused too (backend COMPILED_MAX, 200/200/30 min). */
export const COMPILED_MAX = { vus: 200, rps: 200, duration_s: 30 * 60 } as const;
export const MAX_TARGETS = 10;

export interface Target {
  path: string;
  weight: number;
}
export interface Stage {
  duration_s: number;
  target_vus: number;
}
export interface Threshold {
  metric: "p95" | "p99" | "error_rate";
  scope: "all" | "path";
  path?: string;
  op: "<" | "<=";
  value: number;
}
export interface KillSwitch {
  warmup_s: number;
  window_s: number;
  max_error_rate: number;
  max_p95_ms: number;
  no_success_s: number;
}
export interface PerfConfig {
  origin: string;
  targets: Target[];
  stages: Stage[];
  think_time_ms: { min: number; max: number };
  max_rps: number;
  thresholds: Threshold[];
  kill_switch: KillSwitch;
  allowed_hosts: string[];
  allow_private: boolean;
  max_duration_s: number;
  request_timeout_ms: number;
}
export interface HardLimits {
  vus: number;
  rps: number;
  duration_s: number;
}

/** Decision D18 defaults: after a 10 s warm-up, stop at > 20 % errors or p95 > 10 s over 10 s, or 5 s without a
 * successful response. */
export const DEFAULT_KILL_SWITCH: KillSwitch = {
  warmup_s: 10,
  window_s: 10,
  max_error_rate: 0.2,
  max_p95_ms: 10_000,
  no_success_s: 5,
};

const TOP_KEYS = new Set([
  "origin", "targets", "stages", "think_time_ms", "max_rps", "thresholds", "kill_switch", "allowed_hosts",
  "allow_private", "max_duration_s", "request_timeout_ms",
]); // prettier-ignore

class ConfigError extends Error {}

function fail(message: string): never {
  throw new ConfigError(message);
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(`${what} must be an object`);
  return v as Record<string, unknown>;
}

function only(o: Record<string, unknown>, keys: string[], what: string): void {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) fail(`${what} has unknown field(s): ${extra.join(", ")}`);
}

function num(v: unknown, what: string, min: number, max = Number.MAX_SAFE_INTEGER, integer = true): number {
  if (typeof v !== "number" || !Number.isFinite(v) || (integer && !Number.isInteger(v))) fail(`${what} must be a number`);
  if (v < min || v > max) fail(`${what} must be ${min}–${max}`);
  return v;
}

/** A path on the approved origin: "/x?y", never another origin, scheme-relative URL or backslash trick. */
export function normalisePath(raw: unknown, origin: string): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.length > 2048)
    fail(`Target path ${JSON.stringify(raw)} must start with a single "/"`);
  if (/[\u0000- \u007f]/.test(raw)) fail(`Target path ${JSON.stringify(raw)} contains spaces or control characters`);
  const u = new URL(raw, origin);
  if (u.origin !== new URL(origin).origin) fail(`Target path ${JSON.stringify(raw)} leaves the approved origin`);
  return u.pathname + u.search;
}

export function parseConfig(raw: unknown): PerfConfig {
  const c = obj(raw, "The configuration");
  only(c, [...TOP_KEYS], "The configuration");
  if (typeof c.origin !== "string") fail("origin is required");
  let origin: URL;
  try {
    origin = new URL(c.origin);
  } catch {
    fail("origin is not a valid URL");
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") fail("origin must be http or https");
  if (origin.username || origin.password) fail("origin must not contain credentials");
  if (origin.pathname !== "/" || origin.search || origin.hash) fail("origin must be scheme://host[:port] only");
  const originStr = origin.origin;

  if (!Array.isArray(c.targets) || c.targets.length === 0) fail("Add at least one target");
  if (c.targets.length > MAX_TARGETS) fail(`A load test can target up to ${MAX_TARGETS} pages (got ${c.targets.length})`);
  const targets = c.targets.map((t, i) => {
    const o = obj(t, `targets[${i}]`);
    only(o, ["path", "weight", "method"], `targets[${i}]`);
    if (o.method !== undefined && o.method !== "GET") fail("Only GET requests are allowed");
    return { path: normalisePath(o.path, originStr), weight: num(o.weight ?? 1, `targets[${i}].weight`, 1, 1000) };
  });

  if (!Array.isArray(c.stages) || c.stages.length === 0) fail("Add at least one stage");
  const stages = c.stages.map((s, i) => {
    const o = obj(s, `stages[${i}]`);
    only(o, ["duration_s", "target_vus"], `stages[${i}]`);
    return {
      duration_s: num(o.duration_s, `stages[${i}].duration_s`, 1),
      target_vus: num(o.target_vus, `stages[${i}].target_vus`, 0),
    };
  });

  const tt = obj(c.think_time_ms ?? { min: 500, max: 1500 }, "think_time_ms");
  only(tt, ["min", "max"], "think_time_ms");
  const think = { min: num(tt.min, "think_time_ms.min", 0, 60_000), max: num(tt.max, "think_time_ms.max", 0, 60_000) };
  if (think.max < think.min) fail("think_time_ms.max must be at least think_time_ms.min");

  const thresholds = (Array.isArray(c.thresholds) ? c.thresholds : c.thresholds === undefined ? [] : fail("thresholds must be a list")).map(
    (t, i) => {
      const o = obj(t, `thresholds[${i}]`);
      only(o, ["metric", "scope", "path", "op", "value", "source"], `thresholds[${i}]`);
      if (!["p95", "p99", "error_rate"].includes(String(o.metric))) fail(`thresholds[${i}].metric must be p95, p99 or error_rate`);
      if (!["all", "path"].includes(String(o.scope ?? "all"))) fail(`thresholds[${i}].scope must be all or path`);
      if (!["<", "<="].includes(String(o.op ?? "<"))) fail(`thresholds[${i}].op must be < or <=`);
      const out: Threshold = {
        metric: o.metric as Threshold["metric"],
        scope: (o.scope ?? "all") as Threshold["scope"],
        op: (o.op ?? "<") as Threshold["op"],
        value: num(o.value, `thresholds[${i}].value`, 0, 3_600_000, false),
      };
      if (out.scope === "path") {
        out.path = normalisePath(o.path, originStr);
        if (!targets.some((t) => t.path === out.path)) fail(`thresholds[${i}].path is not one of the targets`);
      }
      return out;
    },
  );

  const ks = obj(c.kill_switch ?? {}, "kill_switch");
  only(ks, Object.keys(DEFAULT_KILL_SWITCH), "kill_switch");
  const kill: KillSwitch = {
    warmup_s: num(ks.warmup_s ?? DEFAULT_KILL_SWITCH.warmup_s, "kill_switch.warmup_s", 0, 600),
    window_s: num(ks.window_s ?? DEFAULT_KILL_SWITCH.window_s, "kill_switch.window_s", 1, 600),
    max_error_rate: num(ks.max_error_rate ?? DEFAULT_KILL_SWITCH.max_error_rate, "kill_switch.max_error_rate", 0, 1, false),
    max_p95_ms: num(ks.max_p95_ms ?? DEFAULT_KILL_SWITCH.max_p95_ms, "kill_switch.max_p95_ms", 1, 600_000),
    no_success_s: num(ks.no_success_s ?? DEFAULT_KILL_SWITCH.no_success_s, "kill_switch.no_success_s", 1, 600),
  };

  if (!Array.isArray(c.allowed_hosts) || !c.allowed_hosts.every((h) => typeof h === "string"))
    fail("allowed_hosts must be a list of host names");
  return {
    origin: originStr,
    targets,
    stages,
    think_time_ms: think,
    max_rps: num(c.max_rps, "max_rps", 1),
    thresholds,
    kill_switch: kill,
    allowed_hosts: (c.allowed_hosts as string[]).map((h) => h.trim().toLowerCase()).filter(Boolean),
    allow_private: c.allow_private === true,
    max_duration_s: num(c.max_duration_s ?? COMPILED_MAX.duration_s, "max_duration_s", 1),
    request_timeout_ms: num(c.request_timeout_ms ?? 10_000, "request_timeout_ms", 100, 60_000),
  };
}

export const peakVus = (c: PerfConfig): number => Math.max(...c.stages.map((s) => s.target_vus));
export const totalDuration = (c: PerfConfig): number => c.stages.reduce((n, s) => n + s.duration_s, 0);

/** The `--max-*` flags (required), refused above the compiled maximum. */
export function parseLimits(values: { "max-vus"?: string; "max-rps"?: string; "max-duration"?: string }): HardLimits {
  const one = (flag: "max-vus" | "max-rps" | "max-duration", max: number): number => {
    const raw = values[flag];
    if (raw === undefined) fail(`perf needs --${flag} (the platform limit)`);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) fail(`--${flag} must be a whole number above 0`);
    if (n > max) fail(`--${flag} ${n} is above the load generator's compiled maximum (${max})`);
    return n;
  };
  return {
    vus: one("max-vus", COMPILED_MAX.vus),
    rps: one("max-rps", COMPILED_MAX.rps),
    duration_s: one("max-duration", COMPILED_MAX.duration_s),
  };
}

/** Refuses a configuration above any hard limit (or its own duration cap) before the first request. */
export function checkLimits(c: PerfConfig, limits: HardLimits): void {
  const vus = peakVus(c);
  const duration = totalDuration(c);
  if (vus < 1) fail("At least one stage needs one or more virtual users");
  if (vus > limits.vus) fail(`Profile exceeds the platform limit: ${vus} users (limit ${limits.vus})`);
  if (c.max_rps > limits.rps)
    fail(`Profile exceeds the platform limit: ${c.max_rps} requests a second (limit ${limits.rps})`);
  if (duration > limits.duration_s)
    fail(`Profile exceeds the platform limit: ${duration} s of load (limit ${limits.duration_s} s)`);
  if (duration > c.max_duration_s)
    fail(`Profile exceeds its duration cap: ${duration} s of load (cap ${c.max_duration_s} s)`);
}

export function loadConfig(file: string, limits: HardLimits): PerfConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    fail(`The configuration file could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const config = parseConfig(raw);
  checkLimits(config, limits);
  return config;
}
