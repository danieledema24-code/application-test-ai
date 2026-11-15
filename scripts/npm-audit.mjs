#!/usr/bin/env node
// npm audit for production dependencies (P5-05d): fails on high or critical advisories unless the advisory is listed
// in scripts/audit-allowlist.json with a reason and a review date. Usage: node scripts/npm-audit.mjs <package dir>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[2];
const allow = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "audit-allowlist.json"), "utf8")).npm ?? {};
let raw;
try {
  raw = execFileSync("npm", ["audit", "--omit=dev", "--json"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  raw = e.stdout; // npm audit exits non-zero when it finds anything
}
const report = JSON.parse(raw);
const today = new Date().toISOString().slice(0, 10);
const bad = [];
const used = new Set();
for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of v.via ?? []) {
    if (typeof via !== "object" || !["high", "critical"].includes(via.severity)) continue;
    const id = String(via.url ?? "").split("/").pop();
    const entry = allow[id];
    if (!entry) {
      bad.push(`${via.severity} ${name} ${id}: ${via.title}`);
      continue;
    }
    used.add(id);
    // An expired acceptance blocks again: someone has to look at it and either fix it or set a new date.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.review_by ?? "") || entry.review_by < today)
      bad.push(`${via.severity} ${name} ${id}: allow-list review date ${entry.review_by ?? "(missing)"} has passed; fix it or re-review`);
    else console.log(`allowed  ${via.severity} ${name} ${id}: ${entry.reason} (review by ${entry.review_by})`);
  }
}
const pkgDir = dir.replace(/\/+$/, "").split("/").pop();
for (const [id, entry] of Object.entries(allow))
  if (!used.has(id) && (entry.package_dir ?? pkgDir) === pkgDir) console.log(`WARNING  allow-list entry ${id} is no longer needed in ${pkgDir}; remove it`);
for (const b of bad) console.log(`BLOCKING ${b}`);
const counts = report.metadata?.vulnerabilities ?? {};
console.log(`${dir}: ${JSON.stringify(counts)}; blocking ${bad.length}`);
process.exit(bad.length ? 1 : 0);
