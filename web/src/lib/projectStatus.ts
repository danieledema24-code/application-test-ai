import type { ProjectSummary } from "./contract";
import { stageStatusLabel } from "./lifecycle";

/** The project's overall status for pills: waiting for approval beats everything, then the stage status. */
export function projectStatusLabel(p: ProjectSummary): { status: string; label: string } {
  if (p.status === "archived") return { status: "archived", label: "Archived" };
  if (p.awaiting_approval) return { status: "awaiting_approval", label: "Waiting for approval" };
  if (p.status === "paused") return { status: "paused", label: "Paused" };
  const s = p.current_stage_status;
  if (!s) return { status: "not_started", label: "Not started" };
  return { status: s, label: `${p.current_stage === "discovery" || p.current_stage === "intake" || p.current_stage === "discovery_report" ? "Discovery" : "Stage"} ${stageStatusLabel(s).toLowerCase()}` };
}

export type DuplicateProject = { id: string; name: string | null; url: string | null };

/**
 * A 409 from POST /projects meaning "a project for this URL already exists". Accepts the code
 * `DUPLICATE_PROJECT` (with the existing project in `details.project` or `details`) and the contract's
 * generic `conflict` with `details.project_id`. Returns null for other errors.
 */
export function duplicateFromError(err: { status: number; code: string; details: unknown; body?: Record<string, unknown> | null }): DuplicateProject | null {
  if (err.status !== 409) return null;
  const code = err.code.toUpperCase();
  if (code !== "DUPLICATE_PROJECT" && code !== "CONFLICT") return null;
  const env = (err.body?.error ?? null) as Record<string, unknown> | null;
  const candidates: unknown[] = [];
  const d = err.details as Record<string, unknown> | null;
  if (d && typeof d === "object" && !Array.isArray(d)) candidates.push(d.project, d.existing_project, d);
  if (env) candidates.push(env.project, env.existing_project);
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const id = (typeof o.id === "string" && o.id) || (typeof o.project_id === "string" && o.project_id) || null;
    if (!id) continue;
    return {
      id,
      name: typeof o.name === "string" ? o.name : typeof o.project_name === "string" ? o.project_name : null,
      url: typeof o.primary_url === "string" ? o.primary_url : typeof o.url === "string" ? o.url : null,
    };
  }
  return null;
}
