"use client";

// Automation › Review · Gate 6 (design P4 §6.4, decision D10). There is no "Approve Gate 6" button: the gate completes
// by itself when every script written by AI has been reviewed; scripts written by rules need no sign-off.

import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, CircleCheck, CircleX } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { g6Groups, g6StatusText, type AutomationOverview, type Precondition, type ScriptRow } from "@/lib/automation";
import { fmtDate } from "@/lib/format";
import { Button, Callout, Card, Disclosure, StatusPill, TextArea, useToast } from "@/components/ui";

const LINK_TEXT: Record<string, string> = {
  valid_scripts: "Open scripts",
  ai_reviewed: "Review the scripts below",
  no_invalid: "Open scripts",
  checked: "Open scripts",
  locators_checked: "Add test credentials",
  not_outdated: "Regenerate scripts…",
};

function Line({ p, tone }: { p: Precondition; tone: "fail" | "warn" | "ok" }) {
  const Icon = tone === "ok" ? CircleCheck : tone === "warn" ? AlertTriangle : CircleX;
  const cls = tone === "ok" ? "text-success-fg" : tone === "warn" ? "text-warning-fg" : "text-danger-fg";
  const href = p.link ? (p.code === "locators_checked" ? `${p.link}#credentials` : p.link) : null;
  return (
    <li className="flex items-start gap-2 text-body text-fg">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${cls}`} aria-hidden />
      <span className="min-w-0 flex-1">
        {p.message}
        {href && tone !== "ok" && (
          <Link href={href} className="ml-2 font-medium text-navy-700 underline underline-offset-2">
            {LINK_TEXT[p.code] ?? "Open"}
          </Link>
        )}
      </span>
    </li>
  );
}

function AiScriptReview({ s, canApprove, viewer, onDone }: { s: ScriptRow; canApprove: boolean; viewer: boolean; onDone: () => void }) {
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const toast = useToast();
  async function decide(decision: "approve" | "reject") {
    if (!canApprove) return;
    if (decision === "reject" && !comment.trim()) {
      setError("Say what's wrong with this script.");
      return;
    }
    setBusy(decision);
    setError(null);
    try {
      const r = await api<{ message: string }>(`/automation-scripts/${s.id}/review`, { method: "POST", body: { decision, comment: comment.trim() || null } });
      toast(r.message, "success");
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn’t save the review. Try again.");
    } finally {
      setBusy(null);
    }
  }
  const errId = `review-err-${s.id}`;
  return (
    <li className="space-y-2 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <p className="text-body text-fg-strong">
        <span className="font-mono">{s.case_key}</span> {s.case_title} · {s.status === "needs_review" ? "checks passed" : s.status === "rejected" ? "rejected in review" : s.status}
      </p>
      {!viewer && s.status === "needs_review" && (
        <div className="space-y-2">
          <TextArea label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} rows={2} error={error ?? undefined} aria-describedby={error ? errId : undefined} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void decide("approve")} loading={busy === "approve"} aria-disabled={!canApprove || undefined} aria-describedby={!canApprove ? "g6-permission" : undefined}>
              Approve script<span className="sr-only"> {s.case_key}</span>
            </Button>
            <Button variant="secondary" onClick={() => void decide("reject")} loading={busy === "reject"} aria-disabled={!canApprove || undefined} aria-describedby={!canApprove ? "g6-permission" : undefined}>
              Reject script…<span className="sr-only"> {s.case_key}</span>
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function Gate6Review({ overview, viewer, onChanged }: { overview: AutomationOverview; viewer: boolean; onChanged: () => void }) {
  const { g6, bundle, permissions } = overview;
  const groups = g6Groups(g6.preconditions);
  const ai = (bundle?.scripts ?? []).filter((s) => s.generated_by === "ai");
  const canApprove = permissions.can_approve;
  const tone = g6.state === "waiting" ? "awaiting_approval" : g6.state === "not_started" ? "not_started" : "approved";
  return (
    <Card as="section" className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-h3 font-semibold text-fg-strong">Gate 6 · Script validation</h2>
        <StatusPill status={tone} label={g6StatusText(g6.state, canApprove)} />
      </div>
      {bundle && <p className="text-small text-fg-muted">Scripts v{bundle.version}{overview.g5.decided_at ? ` · written from the Gate 5 approval on ${fmtDate(overview.g5.decided_at)}` : ""}</p>}
      {g6.state === "passed_automatically" ? (
        <Callout tone="success" title={`Passed automatically${g6.decided_at ? ` · ${fmtDate(g6.decided_at)}` : ""}`}>
          Every script was written by rules and passed its checks. No sign-off needed.
        </Callout>
      ) : (
        <p className="text-body text-fg">Gate 6 completes by itself when every script written by AI has been reviewed. Scripts written by rules need no sign-off.</p>
      )}
      {!viewer && !canApprove && ai.some((s) => s.status === "needs_review") && (
        <Callout tone="neutral">
          <span id="g6-permission">You can review these scripts, but approving needs gate-approval permission. Ask someone who can approve gates, or ask an owner or admin to give you that permission.</span>
        </Callout>
      )}
      {groups.blockers.length > 0 && (
        <div>
          <h3 className="flex items-center gap-2 text-body font-semibold uppercase tracking-[0.04em] text-danger-fg">
            <CircleX className="h-4 w-4" aria-hidden /> Must fix before tests can run ({groups.blockers.length})
          </h3>
          <ul className="mt-2 space-y-2">
            {groups.blockers.map((p) => (
              <Line key={p.code} p={p} tone="fail" />
            ))}
          </ul>
        </div>
      )}
      {groups.advice.length > 0 && (
        <div>
          <h3 className="flex items-center gap-2 text-body font-semibold uppercase tracking-[0.04em] text-warning-fg">
            <AlertTriangle className="h-4 w-4" aria-hidden /> Advice ({groups.advice.length})
          </h3>
          <ul className="mt-2 space-y-2">
            {groups.advice.map((p) => (
              <Line key={p.code} p={p} tone="warn" />
            ))}
          </ul>
        </div>
      )}
      {groups.passed.length > 0 && (
        <Disclosure headingLevel={3} label={<span className="uppercase tracking-[0.04em] text-success-fg">Passed ({groups.passed.length})</span>}>
          <ul className="mt-2 space-y-1.5">
            {groups.passed.map((p) => (
              <Line key={p.code} p={p} tone="ok" />
            ))}
          </ul>
        </Disclosure>
      )}
      {ai.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-body font-semibold uppercase tracking-[0.04em] text-fg-strong">Scripts written by AI ({ai.length})</h3>
          <ul className="space-y-3">
            {ai.map((s) => (
              <AiScriptReview key={s.id} s={s} canApprove={canApprove} viewer={viewer} onDone={onChanged} />
            ))}
          </ul>
        </section>
      )}
    </Card>
  );
}
