import path from "node:path";
import { readFileSync, existsSync } from "node:fs";

// Minimal .env loader so the API runs with plain `tsx` (no dotenv dependency).
const envFile = path.resolve(process.cwd(), ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  jwtSecret: required("JWT_SECRET"),
  encryptionKey: required("ENCRYPTION_KEY"),
  storageDir: path.resolve(process.env.STORAGE_DIR ?? "./storage"),
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
  allowPrivateTargets: process.env.ALLOW_PRIVATE_TARGETS === "true",
  aiModel: process.env.AI_MODEL ?? "claude-opus-5-5",
  // Claude is used only when credentials are configured; otherwise heuristics run and are labelled as such.
  aiEnabled: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  devMode: process.env.NODE_ENV !== "production",
  sessionHours: 12,
};
