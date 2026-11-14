#!/usr/bin/env node
// Entry point: `node automation/bin/qa.mjs <version|init|validate|run> [...]`. The toolkit is written in
// TypeScript and run with Node's type stripping; on Node versions where it is still behind a flag, this file
// re-executes itself with the flag.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.features.typescript) {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exit(r.status ?? 2);
}

const { main } = await import("../src/cli.ts");
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  process.stdout.write(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }) + "\n");
  process.exitCode = 2;
}
