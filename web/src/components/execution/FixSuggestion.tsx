"use client";

// Fix suggestion for "Element not found" results (design P4 §9.3). Only the locator in the page object changes;
// expected results and checks never do. Nothing is applied until a member accepts it, and the scripts using the page
// object must pass their checks again before the next run.

import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { AcceptFixResponse, HealSuggestion, ResultDetail } from "@/lib/execution";
import { Button } from "@/components/ui";
import { DiffView } from "@/components/domain/DiffView";

export function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function FixSuggestion({
  result,
  onAccepted,
  onError,
  onValidate,
}: {
  result: ResultDetail;
  onAccepted: (r: AcceptFixResponse) => void;
  onError: (message: string) => void;
  onValidate: () => void;
}) {
  const sug: HealSuggestion | undefined = result.heal_suggestions?.[0];
  const recommended = Math.max(0, sug?.candidates.findIndex((c) => c.recommended) ?? 0);
  const [n, setN] = useState(recommended);
  const [busy, setBusy] = useState(false);
  if (!sug || sug.candidates.length === 0) return null;
  const file = fileName(sug.asset_path);
  const chosen = sug.candidates[n] ?? sug.candidates[0];
  const canAccept = result.permissions.can_accept_fix && !sug.accepted;

  async function accept() {
    setBusy(true);
    try {
      const r = await api<AcceptFixResponse>(`/execution-results/${result.id}/heal-suggestions/${n}/accept`, { method: "POST", body: {} });
      onAccepted(r);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : "Couldn’t accept the fix suggestion. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="fix-title" className="rounded-xl bg-surface ring-1 ring-line-strong">
      <h2 id="fix-title" className="border-b border-line px-5 py-3 text-h3 font-semibold text-fg-strong">
        Fix suggestion
      </h2>
      <div className="space-y-4 px-5 py-4 text-body text-fg">
        {sug.accepted ? (
          <p className="flex items-center gap-2">
            <CircleCheck className="h-4 w-4 text-success-fg" aria-hidden />
            Accepted: {file} version {sug.accepted.version} uses {sug.candidates[sug.accepted.n]?.expression ?? "the new locator"}. The scripts must pass
            their checks before they run.
          </p>
        ) : (
          <>
            <fieldset>
              <legend className="mb-2">{sug.reason}</legend>
              <div className="space-y-2">
                {sug.candidates.map((c, i) => (
                  <label key={c.expression} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <input type="radio" name="fix-candidate" checked={n === i} onChange={() => setN(i)} disabled={!canAccept} className="h-4 w-4" />
                    <code className="font-mono text-small text-fg-strong">{c.expression}</code>
                    <span className="inline-flex items-center gap-1 text-small text-success-fg">
                      <CircleCheck className="h-3.5 w-3.5" aria-hidden /> Found once
                    </span>
                    {c.recommended && <span className="text-small text-fg-muted">(recommended)</span>}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="space-y-2">
              <p className="font-medium text-fg-strong">Change to {file}</p>
              <DiffView changes={[{ field: "Locator", from: chosen.diff.old, to: chosen.diff.new }]} allowSideBySide={false} />
            </div>
          </>
        )}
        <p className="text-small text-fg-muted">{sug.note}</p>
        {!sug.accepted && result.permissions.can_accept_fix && (
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void accept()} disabled={busy}>
              Accept fix suggestion
            </Button>
            <span className="text-small text-fg-muted">
              Creates {file} version {(sug.asset_version ?? 1) + 1}. Scripts must pass checks before they run.
            </span>
          </div>
        )}
        {sug.accepted && result.permissions.can_accept_fix && (
          <Button variant="secondary" onClick={onValidate}>
            Validate now
          </Button>
        )}
      </div>
    </section>
  );
}
