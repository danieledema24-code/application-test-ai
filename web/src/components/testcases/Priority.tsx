"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { UserPen } from "lucide-react";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { Priority, TestCaseDetail } from "@/lib/contract";
import { fmtDate } from "@/lib/format";
import { PRIORITY_TEXT, RISK_LEVEL_TEXT, overrideBelowRisk } from "@/lib/testcases";
import { Button, InlineError, Modal, TextArea } from "@/components/ui";
import { PriorityValue } from "./Bits";

function riskLine(c: TestCaseDetail): string {
  const risk = c.priority_source?.risk;
  if (!risk) return "no linked risk";
  const level = c.risk_level ? RISK_LEVEL_TEXT[c.risk_level] : null;
  return `${risk.key}${level ? ` (${level}${c.risk_score !== null && c.risk_score !== undefined ? `, score ${c.risk_score}` : ""})` : ""}`;
}

/** Priority with its source (design P3 §10): derived from a risk, set by a person, or no linked risk. */
export function PrioritySource({ c, projectId }: { c: TestCaseDetail; projectId: string }) {
  const src = c.priority_source;
  const risk = src?.risk ?? null;
  const others = Math.max(0, (c.risks ?? []).length - 1);
  if (c.priority_overridden || src?.kind === "override") {
    const who = src?.overridden_by?.full_name || src?.overridden_by?.email || "a person";
    return (
      <div>
        <p className="flex flex-wrap items-center gap-1.5">
          <PriorityValue priority={c.priority} />
          <UserPen className="h-4 w-4 text-fg-muted" aria-hidden />
          <span>
            set by {who}
            {src?.overridden_at ? ` on ${fmtDate(src.overridden_at)}` : ""}
            {src?.override_reason ? `: ‘${src.override_reason}’` : ""}
          </span>
        </p>
        <p className="text-small text-fg-muted">
          Risk-based priority: {PRIORITY_TEXT[c.derived_priority]}
          {risk ? ` (${risk.key})` : ""}
        </p>
      </div>
    );
  }
  if (!risk)
    return (
      <p className="flex flex-wrap items-center gap-1.5">
        <PriorityValue priority={c.priority} /> · no linked risk
      </p>
    );
  return (
    <p className="flex flex-wrap items-center gap-1.5">
      <PriorityValue priority={c.priority} /> · from{" "}
      <Link href={`/projects/${projectId}/test-strategy?view=risks&risk=${risk.key}`} className="font-mono text-navy-700 underline underline-offset-2">
        {risk.key}
      </Link>
      <span>
        ({c.risk_level ? RISK_LEVEL_TEXT[c.risk_level] : "risk"}
        {c.risk_score !== null && c.risk_score !== undefined ? `, score ${c.risk_score}` : ""})
        {risk.label ? `: ${risk.label}` : ""}
        {others > 0 ? ` and ${others} other risk${others === 1 ? "" : "s"}` : ""}
      </span>
    </p>
  );
}

/** [Set priority…] (§10): radios in a fieldset, a required reason, the below-risk warning, and the reset action. */
export function PriorityDialog({ open, onClose, c, g5Approved, onSaved }: { open: boolean; onClose: () => void; c: TestCaseDetail; g5Approved: boolean; onSaved: (d: TestCaseDetail, msg: string) => void }) {
  const [value, setValue] = useState<Priority>(c.priority);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"set" | "clear" | null>(null);
  useEffect(() => {
    if (open) {
      setValue(c.priority);
      setReason(c.priority_source?.override_reason ?? "");
      setReasonError(null);
      setError(null);
    }
  }, [open, c]);
  const below = overrideBelowRisk(value, c.derived_priority, c.risk_level);

  async function send(body: Record<string, unknown>, kind: "set" | "clear") {
    setBusy(kind);
    setError(null);
    try {
      const d = await api<TestCaseDetail>(`/test-cases/${c.id}`, { method: "PATCH", body: { version: c.version, ...body } });
      onSaved(
        d,
        kind === "clear"
          ? `Priority set back to ${PRIORITY_TEXT[d.priority]}${c.priority_source?.risk ? ` (from ${c.priority_source.risk.key})` : ""}.`
          : `Priority set to ${PRIORITY_TEXT[d.priority]}.`,
      );
      onClose();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? `${c.key} changed since you opened it. Reload to see the latest version.` : `Couldn’t set the priority. ${errorMessage(err)}`);
    } finally {
      setBusy(null);
    }
  }

  function submit() {
    if (!reason.trim()) {
      setReasonError("Explain why you changed the priority.");
      document.getElementById("priority-reason")?.focus();
      return;
    }
    void send({ priority_override: value, priority_override_reason: reason.trim() }, "set");
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Set priority for ${c.key}`}
      description={`Risk-based priority: ${PRIORITY_TEXT[c.derived_priority]}, from ${riskLine(c)}`}
      footer={
        <>
          {c.priority_overridden && (
            <Button variant="ghost" className="mr-auto" onClick={() => void send({ clear_priority_override: true }, "clear")} loading={busy === "clear"}>
              Use risk-based priority
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy === "set"}>
            Set priority
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <fieldset>
          <legend className="mb-1 text-body font-medium text-fg-strong">Priority</legend>
          <div className="flex flex-wrap gap-4">
            {(["critical", "high", "medium", "low"] as const).map((p) => (
              <label key={p} className="inline-flex min-h-6 items-center gap-1.5 text-body text-fg-strong">
                <input type="radio" name="priority" value={p} checked={value === p} onChange={() => setValue(p)} className="h-4 w-4" />
                {PRIORITY_TEXT[p]}
              </label>
            ))}
          </div>
        </fieldset>
        {below && <p className="text-body font-medium text-warning-fg">This is lower than the risk suggests. The case will show a warning.</p>}
        <TextArea
          id="priority-reason"
          label="Reason"
          required
          rows={2}
          maxLength={300}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="Explain why this case needs a different priority. Shown on the case and in reports."
          error={reasonError}
        />
        {c.status === "approved" && <p className="text-small text-fg">This case is approved. Setting a priority moves it back to Draft{g5Approved ? " and Gate 5 will need approval again" : ""}.</p>}
        <InlineError error={error} />
      </div>
    </Modal>
  );
}
