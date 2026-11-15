// `qa version`: Node, toolkit and Playwright versions plus the browsers installed for this Playwright build.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TOOLKIT_DIR } from "./paths.ts";

export interface VersionReport {
  node: string;
  toolkit: string;
  playwright: string | null;
  browsers_installed: string[];
  browsers_path: string;
  /** P5-01a: the `qa perf` load generator ships with the toolkit and has its version. */
  loadgen: string;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Playwright's default browser cache (or PLAYWRIGHT_BROWSERS_PATH), as its registry computes it. */
export function browsersPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0") return env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  if (process.platform === "win32")
    return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "ms-playwright");
  return path.join(env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "ms-playwright");
}

export function version(): VersionReport {
  const pkg = readJson(path.join(TOOLKIT_DIR, "package.json"));
  const pw = readJson(path.join(TOOLKIT_DIR, "node_modules", "@playwright", "test", "package.json"));
  const registry = readJson(path.join(TOOLKIT_DIR, "node_modules", "playwright-core", "browsers.json"));
  const dir = browsersPath();
  const installed: string[] = [];
  const browsers = (registry?.browsers ?? []) as { name: string; revision: string }[];
  const rev = (name: string) => browsers.find((b) => b.name === name)?.revision;
  // Runs are headless, so Chromium counts as installed when its headless shell is (`npx playwright install
  // chromium` installs both). A browser is installed once Playwright wrote its INSTALLATION_COMPLETE marker.
  const dirs: Record<string, string> = {
    chromium: `chromium_headless_shell-${rev("chromium-headless-shell")}`,
    firefox: `firefox-${rev("firefox")}`,
    webkit: `webkit-${rev("webkit")}`,
  };
  for (const [name, d] of Object.entries(dirs)) {
    if (rev(name === "chromium" ? "chromium-headless-shell" : name) && fs.existsSync(path.join(dir, d, "INSTALLATION_COMPLETE")))
      installed.push(name);
  }
  return {
    node: process.version,
    toolkit: String(pkg?.version ?? "unknown"),
    playwright: pw ? String(pw.version) : null,
    browsers_installed: installed,
    browsers_path: dir,
    loadgen: String(pkg?.version ?? "unknown"),
  };
}
