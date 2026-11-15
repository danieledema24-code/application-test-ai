// `qa init`: copies the trusted platform files into a bundle, run workspace or export directory.
import fs from "node:fs";
import path from "node:path";
import { PLATFORM_DIR } from "./paths.ts";

/** Files every bundle gets. `live.ts` is for platform runs only and never part of an export. */
export const BUNDLE_FILES = ["fixtures.ts", "qa.ts", "policy.ts", "playwright.config.ts", "tsconfig.json", "eslint.config.js"];

export function init(dir: string, opts: { live?: boolean } = {}): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const files = [...BUNDLE_FILES, ...(opts.live ? ["live.ts"] : [])];
  for (const f of files) fs.copyFileSync(path.join(PLATFORM_DIR, f), path.join(dir, f));
  return files;
}
