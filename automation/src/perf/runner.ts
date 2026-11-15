// The load generator (P5-01a, decision D17): a closed model of virtual users looping over weighted GET targets with
// think time, ramped by stages, with a token bucket enforcing `max_rps` across all users. Redirects are never
// followed (3xx is counted as `redirect`). Errors are network errors, timeouts and HTTP 5xx; 4xx are counted
// separately. A kill switch stops the run on errors, latency or an unreachable target; SIGTERM or the control file
// stops it within 2 s. Nothing is sent before the configuration and the target passed every check.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
import { peakVus, totalDuration, type HardLimits, type PerfConfig } from "./config.ts";
import { Histogram, exactPercentile, round1 } from "./histogram.ts";
import { pinnedLookup, preflight, type Pinned } from "./target.ts";
import type { Resolver } from "../../platform/policy.ts";

export const ENGINE = "ata-loadgen";
export const LOCATION_NOTE = "Load generated from the platform host, not from your users' locations.";

type Outcome = "ok" | "redirect" | "client_error" | "server_error" | "timeout" | "network_error";
export type RunStatus = "completed" | "stopped" | "aborted";

interface Sample {
  target: number;
  ms: number | null;
  outcome: Outcome;
  status: number | null;
}

class Stats {
  hist = new Histogram();
  count = 0;
  ok = 0;
  redirects = 0;
  clientErrors = 0;
  errors = 0;
  cancelled = 0;
  codes: Record<string, number> = {};

  add(s: Sample): void {
    this.count++;
    if (s.ms !== null && s.status !== null) this.hist.record(s.ms);
    const code = s.status !== null ? String(s.status) : s.outcome;
    this.codes[code] = (this.codes[code] ?? 0) + 1;
    if (s.outcome === "ok") this.ok++;
    else if (s.outcome === "redirect") this.redirects++;
    else if (s.outcome === "client_error") this.clientErrors++;
    else this.errors++;
  }

  json(seconds: number): Record<string, unknown> {
    const p = (q: number) => round1(this.hist.percentile(q));
    return {
      count: this.count,
      ok: this.ok,
      redirects: this.redirects,
      client_errors: this.clientErrors,
      errors: this.errors,
      error_rate: this.count ? Math.round((this.errors / this.count) * 10_000) / 10_000 : 0,
      cancelled: this.cancelled,
      rps: seconds > 0 ? Math.round((this.count / seconds) * 100) / 100 : 0,
      latency_ms: {
        min: this.hist.count ? round1(this.hist.min) : null,
        mean: this.hist.count ? round1(this.hist.sum / this.hist.count) : null,
        p50: p(0.5),
        p90: p(0.9),
        p95: p(0.95),
        p99: p(0.99),
        max: this.hist.count ? round1(this.hist.max) : null,
      },
      status_codes: this.codes,
    };
  }
}

interface Second {
  latencies: number[];
  requests: number;
  errors: number;
}

export interface RunOptions {
  config: PerfConfig;
  limits: HardLimits;
  version: string;
  summaryFile?: string;
  controlFile?: string;
  resolver?: Resolver;
  /** One JSON line per second (default: stdout). */
  progress?: (line: Record<string, unknown>) => void;
  /** Install SIGTERM/SIGINT handlers (the CLI does; tests drive `stop()` directly). */
  handleSignals?: boolean;
}

export class LoadRun {
  private readonly c: PerfConfig;
  private readonly opts: RunOptions;
  private readonly overall = new Stats();
  private readonly perTarget: Stats[];
  private readonly cumulative: number[];
  private readonly totalWeight: number;
  private readonly seconds: Second[] = [];
  private readonly series: Record<string, unknown>[] = [];
  private readonly inflight = new Set<http.ClientRequest>();
  private readonly sleepers = new Set<() => void>();
  private readonly running = new Set<number>();
  private agent: http.Agent | null = null;
  private pin: Pinned | null = null;
  private t0 = 0;
  private startedAt = "";
  private desired = 0;
  private nextSlot = 0;
  private lastSuccess = 0;
  private stopping = false;
  private cancelling = false;
  private status: RunStatus = "completed";
  private reason: string | null = null;
  private done!: () => void;
  private finished = new Promise<void>((r) => (this.done = r));

  constructor(opts: RunOptions) {
    this.opts = opts;
    this.c = opts.config;
    this.perTarget = this.c.targets.map(() => new Stats());
    let acc = 0;
    this.cumulative = this.c.targets.map((t) => (acc += t.weight));
    this.totalWeight = acc;
  }

  private now(): number {
    return performance.now() - this.t0;
  }

  /** Target users at `ms` into the run: linear ramps between stage targets, starting from 0 (as k6 does). */
  private targetVus(ms: number): number {
    let from = 0;
    let start = 0;
    for (const s of this.c.stages) {
      const end = start + s.duration_s * 1000;
      if (ms < end) return Math.round(from + ((s.target_vus - from) * (ms - start)) / (end - start));
      from = s.target_vus;
      start = end;
    }
    return 0;
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.sleepers.add(wake);
    });
  }

  /** Token bucket of capacity 1: request slots are at least 1/max_rps apart on a fixed grid, so no one-second
   * window holds more than max_rps + 1 requests and the long-run rate is exactly max_rps. */
  private async take(): Promise<void> {
    const interval = 1000 / this.c.max_rps;
    const now = this.now();
    const slot = Math.max(this.nextSlot, now);
    this.nextSlot = slot + interval;
    await this.sleep(slot - now);
  }

  private pick(): number {
    const r = Math.random() * this.totalWeight;
    const i = this.cumulative.findIndex((c) => r < c);
    return i < 0 ? this.cumulative.length - 1 : i;
  }

  private second(at: number): Second {
    const i = Math.floor(at / 1000);
    while (this.seconds.length <= i) this.seconds.push({ latencies: [], requests: 0, errors: 0 });
    return this.seconds[i];
  }

  private record(s: Sample): void {
    this.overall.add(s);
    this.perTarget[s.target].add(s);
    const sec = this.second(this.now());
    sec.requests++;
    if (s.ms !== null && s.status !== null) sec.latencies.push(s.ms);
    if (s.outcome === "server_error" || s.outcome === "timeout" || s.outcome === "network_error") sec.errors++;
    // Reachability: any HTTP answer below 500 counts as a success for the "no successful response" rule.
    else this.lastSuccess = this.now();
  }

  private request(index: number): Promise<void> {
    const t = this.c.targets[index];
    const url = new URL(t.path, this.c.origin);
    const mod = url.protocol === "https:" ? https : http;
    const started = performance.now();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: Outcome, status: number | null, cancelled = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.inflight.delete(req);
        if (cancelled) {
          this.overall.cancelled++;
          this.perTarget[index].cancelled++;
        } else this.record({ target: index, ms: performance.now() - started, outcome, status });
        resolve();
      };
      const req = mod.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: url.pathname + url.search,
          method: "GET",
          agent: this.agent ?? undefined,
          lookup: this.pin ? pinnedLookup(this.pin) : undefined,
          headers: { "user-agent": `${ENGINE}/${this.opts.version}`, accept: "*/*" },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          res.on("data", () => undefined);
          res.on("end", () =>
            finish(
              status >= 500 ? "server_error" : status >= 400 ? "client_error" : status >= 300 ? "redirect" : "ok",
              status,
            ),
          );
          res.on("error", () => finish("network_error", null, this.cancelling));
        },
      );
      const timer = setTimeout(() => {
        finish("timeout", null);
        req.destroy();
      }, this.c.request_timeout_ms);
      req.on("error", () => finish("network_error", null, this.cancelling));
      this.inflight.add(req);
      req.end();
    });
  }

  private async user(id: number): Promise<void> {
    this.running.add(id);
    try {
      while (!this.stopping && id < this.desired) {
        const target = this.pick();
        await this.take();
        if (this.stopping) break;
        await this.request(target);
        if (this.stopping || id >= this.desired) break;
        const { min, max } = this.c.think_time_ms;
        await this.sleep(min + Math.random() * (max - min));
      }
    } finally {
      this.running.delete(id);
    }
  }

  private tickUsers(): void {
    if (this.stopping) return;
    this.desired = this.targetVus(this.now());
    for (let id = 0; id < this.desired; id++) if (!this.running.has(id)) void this.user(id);
  }

  /** Once a second: the time-series point, the progress line and the kill switch. */
  private tickSecond(t: number): void {
    const sec = this.second((t - 1) * 1000);
    const point = {
      t,
      users: this.running.size,
      requests: sec.requests,
      rps: sec.requests,
      errors: sec.errors,
      p95_ms: round1(exactPercentile(sec.latencies, 0.95)),
    };
    this.series.push(point);
    (this.opts.progress ?? ((l) => process.stdout.write(JSON.stringify(l) + "\n")))({
      type: "progress",
      ...point,
      requests_total: this.overall.count,
      errors_total: this.overall.errors,
    });
    const k = this.c.kill_switch;
    if (this.stopping || t < k.warmup_s) return;
    const window = this.seconds.slice(Math.max(0, t - k.window_s), t);
    const requests = window.reduce((n, s) => n + s.requests, 0);
    const errors = window.reduce((n, s) => n + s.errors, 0);
    if (requests > 0 && errors / requests > k.max_error_rate) {
      return this.stop("aborted", `Stopped automatically: ${Math.round((errors / requests) * 100)} % errors over ${k.window_s} s`);
    }
    const p95 = exactPercentile(window.flatMap((s) => s.latencies), 0.95);
    if (p95 !== null && p95 > k.max_p95_ms) {
      return this.stop("aborted", `Stopped automatically: p95 response time ${(p95 / 1000).toFixed(1)} s over ${k.window_s} s`);
    }
    if (this.now() - this.lastSuccess >= k.no_success_s * 1000) {
      return this.stop("aborted", `Stopped automatically: no successful response for ${k.no_success_s} s`);
    }
  }

  /** Ends the run now: no new requests, in-flight ones are cancelled. Idempotent. */
  stop(status: Exclude<RunStatus, "completed">, reason: string): void {
    if (this.stopping) return;
    this.stopping = true;
    this.cancelling = true;
    this.status = status;
    this.reason = reason;
    for (const wake of [...this.sleepers]) wake();
    for (const req of [...this.inflight]) req.destroy();
  }

  summary(): Record<string, unknown> {
    const elapsed = Math.max(this.now() / 1000, 0.001);
    return {
      type: "summary",
      engine: { name: ENGINE, version: this.opts.version },
      status: this.status,
      reason: this.reason,
      origin: this.c.origin,
      generator_location: LOCATION_NOTE,
      started_at: this.startedAt,
      finished_at: new Date().toISOString(),
      duration_s: Math.round(elapsed * 10) / 10,
      planned_duration_s: totalDuration(this.c),
      profile: { peak_vus: peakVus(this.c), max_rps: this.c.max_rps, targets: this.c.targets.length },
      limits: { max_vus: this.opts.limits.vus, max_rps: this.opts.limits.rps, max_duration_s: this.opts.limits.duration_s },
      overall: this.overall.json(elapsed),
      targets: this.c.targets.map((t, i) => ({ path: t.path, weight: t.weight, ...this.perTarget[i].json(elapsed) })),
      timeseries: this.series,
    };
  }

  private writeSummary(): Record<string, unknown> {
    const s = this.summary();
    if (this.opts.summaryFile) {
      const tmp = `${this.opts.summaryFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s));
      fs.renameSync(tmp, this.opts.summaryFile);
    }
    return s;
  }

  /** Checks the target, then runs to the end (or until stopped). Throws before any request when refused. */
  async run(): Promise<Record<string, unknown>> {
    const verdict = await preflight(this.c.origin, {
      approvedOrigin: this.c.origin,
      allowedHosts: this.c.allowed_hosts,
      allowPrivate: this.c.allow_private,
      resolver: this.opts.resolver,
    });
    if (!verdict.allowed) throw new Error(`The target is not allowed: ${verdict.reason} (${verdict.code})`);
    this.pin = verdict;
    const Agent = this.c.origin.startsWith("https:") ? https.Agent : http.Agent;
    this.agent = new Agent({ keepAlive: true, maxSockets: peakVus(this.c) });
    this.t0 = performance.now();
    this.startedAt = new Date().toISOString();
    this.lastSuccess = 0;
    const onSignal = () => this.stop("stopped", "Stopped by a person");
    if (this.opts.handleSignals) {
      process.on("SIGTERM", onSignal);
      process.on("SIGINT", onSignal);
    }
    const end = totalDuration(this.c) * 1000;
    let t = 0;
    // P5-01b restart safety: when the process that started the run dies (the platform worker), stop the load.
    const parent = process.ppid;
    const users = setInterval(() => {
      if (this.opts.handleSignals && process.ppid !== parent && !this.stopping) {
        this.stop("stopped", "Stopped: the platform worker stopped");
      }
      this.tickUsers();
      if (this.now() >= end && !this.stopping) {
        this.stopping = true; // the profile is over: no new requests, in-flight ones finish
        for (const wake of [...this.sleepers]) wake();
      }
      if (this.opts.controlFile && !this.stopping && fs.existsSync(this.opts.controlFile)) onSignal();
      if (this.stopping && this.inflight.size === 0) this.done();
    }, 100);
    const seconds = setInterval(() => {
      t++;
      if (t * 1000 <= end + 50) this.tickSecond(t);
    }, 1000);
    this.tickUsers();
    try {
      await this.finished;
    } finally {
      clearInterval(users);
      clearInterval(seconds);
      if (this.opts.handleSignals) {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
      }
      this.agent.destroy();
    }
    return this.writeSummary();
  }
}
