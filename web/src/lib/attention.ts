// "Needs your attention" rows for the project Overview (design P2 §12.2). Pure; unit-tested.

import type { Workflow } from "./contract";
import type { ExecSummary } from "./execution";
import { gateReview } from "./lifecycle";

const GATE_TITLE: Record<string, string> = { G2: "Discovery completeness", G3: "Requirements review", G4: "Test Strategy review", G5: "Test case quality", G6: "Script validation" };
const WEEK_MS = 7 * 24 * 3600 * 1000;

/** Needs your attention (design P2 §12.2): one sentence + one action per row, in priority order, max 5. */
export function attentionRows(o: {
  projectId: string;
  wf: Workflow | undefined;
  credFailed: boolean;
  conflicts: number;
  proposals: number;
  drafts: number;
  /** Phase 3: active test cases with an open question. */
  openQuestions?: number;
  /** Role-aware waiting copy (design P3 §4.3). Defaults to the approver's wording. */
  canApprove?: boolean;
  /** Phase 4 (design P4 §4.3): runs and defect drafts, and the scripts' state. */
  exec?: ExecSummary | null;
  scripts?: { aiReview: number; invalid: number; outdated: number } | null;
  viewer?: boolean;
  now?: number;
  /** Phase 5 (design P5 §4.5): non-functional rows (lib/nonfunctional `nfAttentionRows`), placed after the run rows. */
  nonFunctional?: { text: string; action: string; href: string | null }[];
}): { text: string; action: string; href: string | null }[] {
  const rows: { text: string; action: string; href: string | null }[] = [];
  const base = `/projects/${o.projectId}`;
  const gateHref = (k: string) =>
    k === "G2"
      ? `${base}/discovery?view=summary#gate-review`
      : k === "G3"
        ? `${base}/requirements?view=review`
        : k === "G5"
          ? `${base}/test-cases?view=review`
          : k === "G6"
            ? `${base}/automation?view=review`
            : `${base}/test-strategy?view=review`;
  const canApprove = o.canApprove ?? true;
  for (const st of o.wf?.stages ?? []) {
    const review = gateReview(st);
    // G7 and G8 are decided per run and per defect: their rows come from `exec` below.
    if (!review || !st.gate || st.gate.key === "G7" || st.gate.key === "G8") continue;
    if (st.gate.key === "G6" && o.scripts?.aiReview)
      rows.push({
        text: `${o.scripts.aiReview} script${o.scripts.aiReview === 1 ? "" : "s"} written by AI need${o.scripts.aiReview === 1 ? "s" : ""} review before ${o.scripts.aiReview === 1 ? "it" : "they"} can run.`,
        action: "Review Gate 6",
        href: gateHref("G6"),
      });
    else
      rows.push({
        text: `Gate ${st.gate.key.slice(1)} · ${GATE_TITLE[st.gate.key] ?? st.title} is ${review === "required" ? (canApprove ? "waiting for your approval" : "waiting for approval by someone who can approve gates") : "ready for your review"}.`,
        action: `Review Gate ${st.gate.key.slice(1)}`,
        href: gateHref(st.gate.key),
      });
  }
  const x = o.exec;
  if (x?.waiting.length) {
    const key = x.waiting[0];
    const scope = x.waitingTests ? `: ${x.waitingTests} test${x.waitingTests === 1 ? "" : "s"}${x.waitingSideEffect ? `, ${sideEffectPhrase(x.waitingSideEffect)}` : ""}` : "";
    rows.push(
      canApprove
        ? { text: `${key} is waiting for your authorisation${scope}.`, action: `Review ${key}`, href: `${base}/execution/${key}` }
        : { text: `${key} is waiting for authorisation by someone who can approve gates.`, action: o.viewer ? "" : `Open ${key}`, href: o.viewer ? null : `${base}/execution/${key}` },
    );
  }
  if (x?.drafts) {
    const from = x.latest?.key;
    rows.push({
      text: `${x.drafts} defect draft${x.drafts === 1 ? "" : "s"}${from ? ` from ${from}` : ""} need${x.drafts === 1 ? "s" : ""} confirming or rejecting.`,
      action: "Review Gate 8",
      href: `${base}/defects?view=review`,
    });
  }
  rows.push(...(o.nonFunctional ?? []));
  const cant = (o.scripts?.invalid ?? 0) + (o.scripts?.outdated ?? 0);
  if (cant)
    rows.push({
      text: `${cant} script${cant === 1 ? "" : "s"} can't run: ${o.scripts!.invalid} invalid, ${o.scripts!.outdated} outdated.`,
      action: "Open Automation",
      href: `${base}/automation`,
    });
  const done = x?.latest;
  if (done?.finished_at && (o.now ?? Date.now()) - Date.parse(done.finished_at) < WEEK_MS) {
    const t = done.totals;
    const parts = [`${t.failed ?? 0} failed`, ...(t.flaky ? [`${t.flaky} flaky`] : []), ...(t.error ? [`${t.error} error${t.error === 1 ? "" : "s"}`] : [])];
    if ((t.failed ?? 0) + (t.flaky ?? 0) + (t.error ?? 0) > 0)
      rows.push({ text: `${done.key} finished: ${parts.join(", ")}.`, action: `Open ${done.key}`, href: `${base}/execution/${done.key}` });
  }
  if (o.openQuestions)
    rows.push({
      text: `${o.openQuestions} test case${o.openQuestions === 1 ? " has an" : "s have"} open question${o.openQuestions === 1 ? "" : "s"}.`,
      action: "Resolve open questions",
      href: `${base}/test-cases?oq=1`,
    });
  for (const st of o.wf?.stages ?? [])
    if (st.status === "changes_requested" && st.gate) rows.push({ text: `Changes were requested at Gate ${st.gate.key.slice(1)}.`, action: "Open", href: gateHref(st.gate.key) });
  if (o.credFailed) rows.push({ text: "Sign-in with the test account failed.", action: "Check credentials", href: `${base}/settings?view=credentials` });
  for (const st of o.wf?.stages ?? [])
    if (st.status === "stale" && st.key === "test_design") rows.push({ text: "Test cases are out of date.", action: "Open test cases", href: `${base}/test-cases` });
    else if (st.status === "stale" && st.key !== "traceability")
      rows.push({
        text: `${st.key === "requirements" ? "Requirements are" : st.key === "test_strategy" ? "The Test Strategy is" : `${st.title} is`} out of date.`,
        action: st.key === "test_strategy" ? "Open strategy" : "Open requirements",
        href: st.key === "test_strategy" ? `${base}/test-strategy` : `${base}/requirements`,
      });
  if (o.conflicts) rows.push({ text: `${o.conflicts} requirement${o.conflicts === 1 ? " conflicts" : "s conflict"} with a document.`, action: "Review conflicts", href: `${base}/requirements?conflict=1` });
  if (o.proposals) rows.push({ text: `${o.proposals} AI QA Analyst proposal${o.proposals === 1 ? " is" : "s are"} waiting for review.`, action: "Review proposals", href: `${base}/assistant` });
  if (o.drafts) rows.push({ text: `${o.drafts} requirement${o.drafts === 1 ? " is" : "s are"} still Draft.`, action: "Review drafts", href: `${base}/requirements?status=draft` });
  return rows;
}


/** "May submit the Contact us form (if …)" → "may submit the Contact us form". */
function sideEffectPhrase(text: string): string {
  const t = text.replace(/\s*\(.*\)\s*$/, "");
  return t.charAt(0).toLowerCase() + t.slice(1);
}
