// The shared network-policy vectors (policy-vectors.json), also run by backend/tests/unit/test_ssrf.py.
import fs from "node:fs";

export interface Vector {
  url: string;
  top_level: boolean;
  verdict: "allowed" | "blocked";
  code?: string;
  resolves_to?: string[];
  browser?: boolean;
}
export interface VectorFile {
  approved_origin: string;
  allowed_hosts: string[];
  allow_private: boolean;
  vectors: Vector[];
}

export const VECTORS = JSON.parse(
  fs.readFileSync(new URL("./policy-vectors.json", import.meta.url), "utf8"),
) as VectorFile;
export const fill = (s: string, port: number) => s.replaceAll("{port}", String(port)).replaceAll("{other_port}", String(port + 1));
