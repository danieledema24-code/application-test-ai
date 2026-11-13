// "Needs your attention" rows for the project Overview (design P2 §12.2). Pure; unit-tested.

import type { Workflow } from "./contract";
import { gateReview } from "./lifecycle";

const GATE_TITLE: Record<string, string> = { G2: "Discovery completeness", G3: "Requirements review", G4: "Test Strategy review" };

/** Needs your attention (design P2 §12.2): one sentence + one action per row, in priority order, max 5. */
export function attentionRows(o: {
  projectId: string;
  wf: Workflow | undefined;
  credFailed: boolean;
  conflicts: number;
  proposals: number;
  drafts: number;
}): { text: string; action: string; href: string }[] {
  const rows: { text: string; action: string; href: string }[] = [];
  const base = `/projects/${o.projectId}`;
  const gateHref = (k: string) => (k === "G2" ? `${base}/discovery?view=summary#gate-review` : k === "G3" ? `${base}/requirements?view=review` : `${base}/test-strategy?view=review`);
  for (const st of o.wf?.stages ?? []) {
    const review = gateReview(st);
    if (review && st.gate)
      rows.push({
        text: `Gate ${st.gate.key.slice(1)} · ${GATE_TITLE[st.gate.key] ?? st.title} is ${review === "required" ? "waiting for your approval" : "ready for your review"}.`,
        action: `Review Gate ${st.gate.key.slice(1)}`,
        href: gateHref(st.gate.key),
      });
  }
  for (const st of o.wf?.stages ?? [])
    if (st.status === "changes_requested" && st.gate) rows.push({ text: `Changes were requested at Gate ${st.gate.key.slice(1)}.`, action: "Open", href: gateHref(st.gate.key) });
  if (o.credFailed) rows.push({ text: "Sign-in with the test account failed.", action: "Check credentials", href: `${base}/settings?view=credentials` });
  for (const st of o.wf?.stages ?? [])
    if (st.status === "stale")
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

