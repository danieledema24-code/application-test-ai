// `qa validate`: offline static validation of a bundle directory. Per generated file: spec-guard, tsc (strict,
// noEmit), eslint (the toolkit's own platform/eslint.config.js) and, for specs, the test case tag check.
import fs from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import ts from "typescript";
import { checkSpec, type GuardMessage } from "./spec-guard.ts";
import { PLATFORM_DIR, TOOLKIT_DIR } from "./paths.ts";

export interface Check {
  ok: boolean;
  messages: GuardMessage[];
}

export interface FileReport {
  guard: Check;
  tsc: Check;
  eslint: Check;
  tags: Check & { keys: string[] };
}

export interface ValidateReport {
  ok: boolean;
  files: Record<string, FileReport>;
}

/** Platform files are trusted toolkit code: compiled with the bundle for types, never guarded or reported. */
export const PLATFORM_FILES = ["fixtures.ts", "qa.ts", "policy.ts", "live.ts", "progress.ts", "playwright.config.ts"];

function listTs(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!["node_modules", "test-results", "playwright-report"].includes(entry.name) && !entry.name.startsWith("."))
        out.push(...listTs(dir, p));
    } else if (entry.isFile() && p.endsWith(".ts") && !entry.isSymbolicLink()) out.push(p);
  }
  return out.sort();
}

/** Generated files of a bundle (everything except the platform files at its root). */
export function generatedFiles(dir: string): string[] {
  return listTs(dir).filter((p) => !PLATFORM_FILES.includes(p));
}

function safeRel(dir: string, file: string): string {
  const rel = path.posix.normalize(file.replaceAll("\\", "/"));
  if (rel.startsWith("../") || path.isAbsolute(rel) || rel.includes("\0")) throw new Error(`Invalid file path: ${file}`);
  const real = fs.realpathSync(path.join(dir, rel));
  if (!real.startsWith(fs.realpathSync(dir) + path.sep)) throw new Error(`File is outside the bundle: ${file}`);
  return rel;
}

function runTsc(dir: string, files: string[]): Map<string, GuardMessage[]> {
  const all = listTs(dir).map((p) => path.join(dir, p));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    strict: true,
    noEmit: true,
    noUnusedLocals: true,
    skipLibCheck: true,
    isolatedModules: true,
    esModuleInterop: true,
    types: ["node"],
    typeRoots: [path.join(TOOLKIT_DIR, "node_modules", "@types")],
    // The bundle has no node_modules of its own: resolve Playwright from the toolkit.
    baseUrl: dir,
    paths: { "@playwright/test": [path.join(TOOLKIT_DIR, "node_modules", "@playwright", "test")] },
  };
  const program = ts.createProgram(all, options);
  const wanted = new Map(files.map((f) => [path.resolve(dir, f), f]));
  const out = new Map<string, GuardMessage[]>(files.map((f) => [f, []]));
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const rel = d.file ? wanted.get(path.resolve(d.file.fileName)) : undefined;
    if (!d.file || !rel) continue;
    const line = d.start === undefined ? null : d.file.getLineAndCharacterOfPosition(d.start).line + 1;
    out.get(rel)!.push({ line, message: `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}` });
  }
  return out;
}

async function runEslint(dir: string, files: string[]): Promise<Map<string, GuardMessage[]>> {
  const eslint = new ESLint({
    cwd: dir,
    overrideConfigFile: path.join(PLATFORM_DIR, "eslint.config.js"),
    errorOnUnmatchedPattern: false,
  });
  const out = new Map<string, GuardMessage[]>(files.map((f) => [f, []]));
  const results = await eslint.lintFiles(files.map((f) => path.join(dir, f)));
  for (const r of results) {
    const rel = path.relative(dir, r.filePath).split(path.sep).join("/");
    for (const m of r.messages) {
      out.get(rel)?.push({ line: m.line ?? null, message: `${m.message}${m.ruleId ? ` (${m.ruleId})` : ""}` });
    }
  }
  return out;
}

/** A spec declares exactly one test titled "TC-0001: …", tagged @TC-0001, in a file named TC-0001.spec.ts. */
export function checkTags(code: string, file: string): Check & { keys: string[] } {
  if (!file.endsWith(".spec.ts")) return { ok: true, messages: [], keys: [] };
  const messages: GuardMessage[] = [];
  const lineOf = (index: number) => code.slice(0, index).split("\n").length;
  const titles = [...code.matchAll(/\btest\(\s*(["'`])(TC-\d{4,}): /g)];
  const keys = titles.map((m) => m[2]);
  const fileKey = path.posix.basename(file).replace(/\.spec\.ts$/, "");
  if (titles.length !== 1) {
    messages.push({ line: null, message: `Expected exactly one test titled "TC-nnnn: …", found ${titles.length}` });
  } else {
    const [m] = titles;
    const key = m[2];
    if (key !== fileKey) messages.push({ line: lineOf(m.index ?? 0), message: `Title ${key} does not match the file name ${fileKey}.spec.ts` });
    if (!new RegExp(`tag:\\s*\\[[^\\]]*["'\`]@${key}["'\`]`).test(code))
      messages.push({ line: lineOf(m.index ?? 0), message: `The test is not tagged @${key}` });
  }
  return { ok: messages.length === 0, messages, keys };
}

export async function validate(dir: string, only?: string[]): Promise<ValidateReport> {
  const root = path.resolve(dir);
  if (!fs.statSync(root).isDirectory()) throw new Error(`Not a directory: ${dir}`);
  const files = (only?.length ? only.map((f) => safeRel(root, f)) : generatedFiles(root)).filter(
    (f) => !PLATFORM_FILES.includes(f),
  );
  const tsc = runTsc(root, files);
  const lint = await runEslint(root, files);
  const report: ValidateReport = { ok: true, files: {} };
  for (const f of files) {
    const code = fs.readFileSync(path.join(root, f), "utf8");
    const guard = checkSpec(code, f);
    const entry: FileReport = {
      guard,
      tsc: { ok: !tsc.get(f)?.length, messages: tsc.get(f) ?? [] },
      eslint: { ok: !lint.get(f)?.length, messages: lint.get(f) ?? [] },
      tags: checkTags(code, f),
    };
    report.files[f] = entry;
    if (!entry.guard.ok || !entry.tsc.ok || !entry.eslint.ok || !entry.tags.ok) report.ok = false;
  }
  return report;
}
