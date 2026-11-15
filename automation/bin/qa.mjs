#!/usr/bin/env node
// Entry point: `node automation/bin/qa.mjs <version|init|validate|run|perf> [...]`. The toolkit is written in
// TypeScript and run with Node's type stripping; on Node versions where it is still behind a flag, this file
// re-executes itself with the flag.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.features.typescript) {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  // A SIGTERM sent to this process alone still stops the toolkit (P5-01a: `qa perf` must stop within 2 s). The
  // backend signals the whole process group, so the child may get it twice; the toolkit's handlers allow that.
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  // P5-01b: if the platform worker that started this dies, stop the toolkit instead of leaving load running.
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) child.kill("SIGTERM");
  }, 200).unref();
  // Killed by a signal (a stop that lands before the toolkit's own handlers exist) is not "refused" (exit 2).
  const code = await new Promise((resolve) => child.on("exit", (c, sig) => resolve(c ?? (sig ? 128 + (sig === "SIGKILL" ? 9 : 15) : 2))));
  process.exit(code);
}

const { main } = await import("../src/cli.ts");
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  process.stdout.write(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }) + "\n");
  process.exitCode = 2;
}
