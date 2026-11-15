// `qa perf --export-k6`: an equivalent k6 script (stages, thresholds, weighted GETs, think time, max requests a
// second) for people to run themselves. The platform never runs it (decision D17); it is only parsed with acorn.
// Every value comes from the validated configuration and is written as a JSON literal, so nothing in it can change
// the script's structure, and the only host in it is the approved origin.
import * as acorn from "acorn";
import type { PerfConfig, Threshold } from "./config.ts";

export const K6_LABEL = "Not run by the platform";

function thresholdKey(t: Threshold): string {
  const metric = t.metric === "error_rate" ? "http_req_failed" : "http_req_duration";
  return t.scope === "path" && t.path ? `${metric}{path:${t.path}}` : metric;
}

function thresholdExpr(t: Threshold): string {
  if (t.metric === "error_rate") return `rate${t.op}${t.value}`;
  return `p(${t.metric === "p95" ? 95 : 99})${t.op}${t.value}`;
}

export function k6Script(c: PerfConfig, version: string): string {
  const thresholds: Record<string, string[]> = {};
  for (const t of c.thresholds) (thresholds[thresholdKey(t)] ??= []).push(thresholdExpr(t));
  const stages = c.stages.map((s) => ({ duration: `${s.duration_s}s`, target: s.target_vus }));
  const j = (v: unknown) => JSON.stringify(v, null, 2);
  const minS = c.think_time_ms.min / 1000;
  const spanS = (c.think_time_ms.max - c.think_time_ms.min) / 1000;
  return `// k6 script exported by the AI QA Analyst load generator (ata-loadgen ${version}).
// ${K6_LABEL}: run it yourself with \`k6 run script.js\`, only against a site you are authorised to test.
// Same profile as the platform run: GET only, not signed in, redirects not followed.
// Note: k6 counts 4xx responses as failed requests in http_req_failed; the platform counts only 5xx, timeouts and
// network errors as errors.
import http from "k6/http";
import { sleep } from "k6";

export const options = {
  stages: ${j(stages)},
  rps: ${c.max_rps},
  thresholds: ${j(thresholds)},
};

const BASE = ${JSON.stringify(c.origin)};
const TARGETS = ${j(c.targets.map((t) => ({ path: t.path, weight: t.weight })))};
const TOTAL = TARGETS.reduce((n, t) => n + t.weight, 0);

function pick() {
  let r = Math.random() * TOTAL;
  for (const t of TARGETS) {
    if (r < t.weight) return t;
    r -= t.weight;
  }
  return TARGETS[TARGETS.length - 1];
}

export default function () {
  const t = pick();
  http.get(BASE + t.path, { redirects: 0, tags: { path: t.path } });
  sleep(${minS} + Math.random() * ${spanS});
}
`;
}

/** Throws when the script is not valid JavaScript (module syntax). */
export function checkSyntax(script: string): acorn.Program {
  return acorn.parse(script, { ecmaVersion: "latest", sourceType: "module" });
}
