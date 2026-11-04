import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

// Local filesystem stand-in for S3-compatible storage. Keys are namespaced by organisation
// so one workspace's evidence can never be addressed through another's key prefix.
export async function putObject(key: string, data: Buffer | string): Promise<string> {
  const full = resolveKey(key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data);
  return key;
}

export async function getObject(key: string): Promise<Buffer> {
  return fs.readFile(resolveKey(key));
}

export async function deletePrefix(prefix: string) {
  await fs.rm(resolveKey(prefix), { recursive: true, force: true });
}

export function resolveKey(key: string) {
  const full = path.resolve(config.storageDir, key);
  if (!full.startsWith(config.storageDir + path.sep)) throw new Error("Invalid storage key");
  return full;
}
