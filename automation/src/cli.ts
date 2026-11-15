// The toolkit CLI, called only by the backend (backend/app/automation/toolkit.py) and by the toolkit's tests.
// Prints one JSON document on stdout (`perf` also prints a progress line a second before it). Exit codes: 0 = ok,
// 1 = validation failed / tests failed / load test stopped or aborted, 2 = could not run (or refused).
import { parseArgs } from "node:util";
import { init } from "./init.ts";
import { perf } from "./perf/index.ts";
import { run } from "./run.ts";
import { validate } from "./validate.ts";
import { version } from "./version.ts";

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      dir: { type: "string" },
      files: { type: "string" },
      report: { type: "string" },
      "live-dir": { type: "string" },
      progress: { type: "string" },
      grep: { type: "string" },
      live: { type: "boolean" },
      // perf (P5-01a)
      config: { type: "string" },
      summary: { type: "string" },
      control: { type: "string" },
      "export-k6": { type: "string" },
      "max-vus": { type: "string" },
      "max-rps": { type: "string" },
      "max-duration": { type: "string" },
    },
    strict: true,
  });
  switch (command) {
    case "version":
      print(version());
      return 0;
    case "init": {
      if (!values.dir) throw new Error("init needs --dir");
      print({ files: init(values.dir, { live: values.live }) });
      return 0;
    }
    case "validate": {
      if (!values.dir) throw new Error("validate needs --dir");
      const files = values.files ? values.files.split(",").map((f) => f.trim()).filter(Boolean) : undefined;
      const report = await validate(values.dir, files);
      print(report);
      return report.ok ? 0 : 1;
    }
    case "run": {
      if (!values.dir || !values.report) throw new Error("run needs --dir and --report");
      const report = await run({
        dir: values.dir,
        report: values.report,
        liveDir: values["live-dir"],
        progress: values.progress,
        grep: values.grep,
      });
      print(report);
      return report.exit_code === 0 ? 0 : report.exit_code === 1 ? 1 : 2;
    }
    case "perf": {
      const { code, result } = await perf(values, version().toolkit);
      print(result);
      return code;
    }
    default:
      throw new Error(`Unknown command ${command ?? "(none)"}; use version, init, validate, run or perf`);
  }
}
