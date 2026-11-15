// `qa perf`: the load generator's CLI entry (called by backend/app/automation/loadgen.py).
//   qa perf --config <file> --max-vus N --max-rps N --max-duration S [--summary <file>] [--control <file>]
//   qa perf --config <file> --max-vus N --max-rps N --max-duration S --export-k6 <file>
// The `--max-*` flags are the platform hard cap; a configuration above any of them is refused (exit 2) before
// any request. Progress is one JSON line a second on stdout; the last line is the summary.
import fs from "node:fs";
import { loadConfig, parseLimits } from "./config.ts";
import { K6_LABEL, checkSyntax, k6Script } from "./k6.ts";
import { LoadRun } from "./runner.ts";

export interface PerfArgs {
  config?: string;
  summary?: string;
  control?: string;
  "export-k6"?: string;
  "max-vus"?: string;
  "max-rps"?: string;
  "max-duration"?: string;
}

export async function perf(values: PerfArgs, version: string): Promise<{ code: number; result: Record<string, unknown> }> {
  if (!values.config) throw new Error("perf needs --config");
  const limits = parseLimits(values);
  const config = loadConfig(values.config, limits);
  if (values["export-k6"]) {
    const script = k6Script(config, version);
    checkSyntax(script);
    fs.writeFileSync(values["export-k6"], script);
    return { code: 0, result: { k6_script: values["export-k6"], label: K6_LABEL, bytes: Buffer.byteLength(script) } };
  }
  const run = new LoadRun({
    config,
    limits,
    version,
    summaryFile: values.summary,
    controlFile: values.control,
    handleSignals: true,
  });
  const summary = await run.run();
  // With a summary file, the last stdout line leaves the (long) time series out; without one it is the whole summary.
  const result = values.summary ? { ...summary, timeseries: undefined, summary_file: values.summary } : summary;
  return { code: summary.status === "completed" ? 0 : 1, result };
}
