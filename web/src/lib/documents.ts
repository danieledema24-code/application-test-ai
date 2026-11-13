import type { SourceDocument } from "./contract";
import { fmtBytes } from "./format";

/** Upload limits (contract: ≤ 20 MB per file, 10 active documents; both server-enforced too). */
export const DOC_MAX_BYTES = 20 * 1024 * 1024;
export const DOC_MAX_ACTIVE = 10;
export const DOC_ACCEPT = ".pdf,.md,.markdown,.docx";
const EXT = /\.(pdf|md|markdown|docx)$/i;

export type DocFileCheck = { accepted: File[]; errors: string[] };

/** Client checks before upload (design P2 §7.1): errors are per file; allowed files continue. */
export function checkDocumentFiles(files: File[], activeCount: number): DocFileCheck {
  const accepted: File[] = [];
  const errors: string[] = [];
  let room = Math.max(0, DOC_MAX_ACTIVE - activeCount);
  for (const f of files) {
    if (!EXT.test(f.name)) errors.push(`${f.name}: only PDF, Markdown and Word (.docx) files can be added.`);
    else if (f.size > DOC_MAX_BYTES) errors.push(`${f.name} is ${fmtBytes(f.size)}. The limit is 20 MB.`);
    else if (room <= 0) {
      if (!errors.includes(LIMIT_COPY)) errors.push(LIMIT_COPY);
    } else {
      accepted.push(f);
      room -= 1;
    }
  }
  return { accepted, errors };
}

const LIMIT_COPY = `This project already has ${DOC_MAX_ACTIVE} documents. Remove one to add another.`;

export function docType(d: Pick<SourceDocument, "filename" | "mime">): string {
  const m = d.filename.match(/\.([a-z0-9]+)$/i);
  const ext = m ? m[1].toUpperCase() : "";
  return ext === "MARKDOWN" ? "MD" : ext || d.mime;
}

/** Failure reasons in plain words (design §7.2). Unknown codes fall back to the server message. */
export function docFailureText(error: string | null): string {
  const e = (error ?? "").toLowerCase();
  if (e.includes("password") || e.includes("encrypt")) return "password-protected";
  if (e.includes("damaged") || e.includes("corrupt")) return "the file is damaged";
  if (e.includes("no text") || e.includes("empty")) return "no text found";
  if (e.includes("type") || e.includes("magic") || e.includes("mismatch")) return "not a real file of that type";
  return error || "an unknown error";
}

/** Status cell text (design §7.2). Only states the contract reports are shown. */
export function docStatusText(d: SourceDocument): string {
  if (d.status === "extracting") return "Extracting text…";
  if (d.status === "failed") return `Couldn’t read: ${docFailureText(d.error)}`;
  if (d.status === "withdrawn") return "Removed from sources";
  const parts = ["Ready"];
  if (d.pages) parts.push(`${d.pages} page${d.pages === 1 ? "" : "s"}`);
  else if (d.sections) parts.push(`${d.sections} section${d.sections === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
