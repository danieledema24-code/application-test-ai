import path from "node:path";
import { fileURLToPath } from "node:url";

/** The automation/ package root and its platform files (resolved from this file, not the working directory). */
export const TOOLKIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLATFORM_DIR = path.join(TOOLKIT_DIR, "platform");
export const PLAYWRIGHT_CLI = path.join(TOOLKIT_DIR, "node_modules", "@playwright", "test", "cli.js");
