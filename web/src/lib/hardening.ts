// Phase 5 hardening (design P5 §13.3–13.5): audit log, retention and scheduled deletion. Pure helpers only.

import type { IsoDate, Role } from "./contract";

/** Owner/admin-only settings pages opened by anyone else (design P5 §2, check 34). */
export const ADMIN_ONLY_PAGE = "Only owners and admins can see this page.";

export type AuditEntry = {
  id: string;
  at: IsoDate;
  who: { name: string; email: string | null } | null;
  actor_type: string;
  action: string;
  label: string;
  project: { id: string; name: string | null } | null;
  details: string;
};

export type AuditPage = { items: AuditEntry[]; total: number; next_cursor: string | null; groups: string[]; export_limit: number };

export type AuditFilters = { group: string; project: string; from: string; to: string };
export const NO_FILTERS: AuditFilters = { group: "", project: "", from: "", to: "" };

/** Query for the audit log and its export. Dates are whole days: "to" includes the chosen day. */
export function auditQuery(f: AuditFilters): Record<string, string> {
  const q: Record<string, string> = {};
  if (f.group) q.group = f.group;
  if (f.project) q.project = f.project;
  if (f.from) q.from = `${f.from}T00:00:00Z`;
  if (f.to) {
    const d = new Date(`${f.to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    q.to = d.toISOString();
  }
  return q;
}

export function exportText(total: number, limit: number): { disabled: string | null; toast: string } {
  return {
    disabled: total > limit ? `Exports are limited to ${limit.toLocaleString("en-GB")} entries. Narrow the dates.` : null,
    toast: `Export ready: ${total.toLocaleString("en-GB")} ${total === 1 ? "entry" : "entries"}. The export itself is recorded in the audit log.`,
  };
}

export function whoText(e: AuditEntry): string {
  if (!e.who) return e.actor_type === "system" ? "System" : e.actor_type;
  return e.who.email ? `${e.who.name} · ${e.who.email}` : e.who.name;
}

/** "13 Nov 15:10" in local time. */
export function shortWhen(iso: IsoDate): string {
  const d = new Date(iso);
  const mon = d.toLocaleString("en-GB", { month: "short" });
  return `${d.getDate()} ${mon} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ retention

export type RetentionField = "videos_traces_days" | "screenshots_days" | "timeseries_days";
export type Retention = Record<RetentionField, number> & { saved: boolean; can_edit: boolean; message?: string };

export const RETENTION_ROWS: { field: RetentionField; label: string; noun: string }[] = [
  { field: "videos_traces_days", label: "Videos and traces", noun: "videos and traces" },
  { field: "screenshots_days", label: "Screenshots", noun: "screenshots" },
  { field: "timeseries_days", label: "Load test time series", noun: "load test time series" },
];

export const RETENTION_ERROR = "Enter a whole number of days (0 or more).";

export function retentionErrors(form: Record<RetentionField, string>): Partial<Record<RetentionField, string>> {
  const e: Partial<Record<RetentionField, string>> = {};
  for (const { field } of RETENTION_ROWS) if (!/^\d{1,5}$/.test(form[field].trim())) e[field] = RETENTION_ERROR;
  return e;
}

/** "1 day", "30 days". */
export const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

const shorter = (from: number, to: number) => to > 0 && (from === 0 || to < from);

/** The first shortened kind, for the confirm dialog (0 means forever, so any number is shorter than 0). */
export function shortening(cur: Record<RetentionField, number>, next: Record<RetentionField, number>): { title: string; body: string; keep: string; confirm: string } | null {
  const row = RETENTION_ROWS.find((r) => shorter(cur[r.field], next[r.field]));
  if (!row) return null;
  const from = cur[row.field];
  const to = next[row.field];
  const noun = row.noun.charAt(0).toUpperCase() + row.noun.slice(1);
  return {
    title: `Keep ${row.noun} for ${days(to)} instead of ${from === 0 ? "forever" : from}?`,
    body: `${noun} older than ${days(to)} are removed at the next daily clean-up. This can't be undone.`,
    keep: from === 0 ? "Keep forever" : `Keep ${days(from)}`,
    confirm: `Shorten to ${days(to)}`,
  };
}

// ------------------------------------------------------------------ archive and delete

/** "14 Nov at 16:02" (local time), the same wording as the API message. */
export function deletionWhen(iso: IsoDate): string {
  const d = new Date(iso);
  return `${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })} at ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function deletionScheduledText(name: string, iso: IsoDate): string {
  return `${name} will be deleted on ${deletionWhen(iso)}.`;
}

export function deletionCallout(iso: IsoDate): string {
  return `This project will be deleted permanently on ${deletionWhen(iso)}. Only the audit log will keep a record.`;
}

export function canArchive(role: Role | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** Why "Delete project permanently…" is unavailable, or null when the owner can use it. */
export function deleteBlocked(role: Role | null | undefined, archived: boolean): string | null {
  if (role !== "owner") return "Only the organisation owner can delete a project permanently.";
  if (!archived) return "Archive the project first.";
  return null;
}
