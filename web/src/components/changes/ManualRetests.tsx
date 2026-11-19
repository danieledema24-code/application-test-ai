"use client";

// Manual re-tests (D37; design P6 §7.4, placed by P6-05b): impacted manual must-run tests aren't part of the automated
// regression run, so a person records passed or failed with a note here. Release readiness counts the latest result
// for "Impacted tests re-run since the change"; recording one makes an assessment waiting for Gate 9 out of date.

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/format";
import { claimRouteFocus } from "@/lib/focusReturn";
import { useOnline } from "@/lib/useOnline";
import { retestErrors, retestLine, type ManualRetestItem, type ManualRetests as ManualRetestsT } from "@/lib/release";
import { Button, Callout, Disclosure, ErrorState, Modal, Skeleton, TextArea, useToast } from "@/components/ui";

const link = "font-medium text-navy-700 underline underline-offset-2 hover:text-navy-900";
const headingId = (key: string) => `retest-${key}`;

export function ManualRetests({ changeSetId, changeSetKey, projectId }: { changeSetId: string; changeSetKey: string; projectId: string }) {
  const q = useApi<ManualRetestsT>(`/change-sets/${changeSetId}/manual-retests`);
  const [recording, setRecording] = useState<ManualRetestItem | null>(null);
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const sectionRef = useRef<HTMLHeadingElement>(null);
  const jumped = useRef(false);

  // `#manual-retests` (from release readiness): bring the section into view once it's loaded.
  useEffect(() => {
    if (jumped.current || !q.data || typeof window === "undefined" || window.location.hash !== "#manual-retests") return;
    jumped.current = true;
    claimRouteFocus(window.location.pathname); // so the route-change focus doesn't move it back to the h1
    sectionRef.current?.scrollIntoView({ block: "start" });
    sectionRef.current?.focus();
  }, [q.data]);

  const d = q.data;
  return (
    <section id="manual-retests" aria-labelledby="manual-retests-heading" className="scroll-mt-20 space-y-2">
      <h3 id="manual-retests-heading" ref={sectionRef} tabIndex={-1} className="text-h3 font-semibold text-fg-strong focus:outline-none">
        Manual re-tests{d ? ` (${d.counts.recorded} of ${d.counts.total} recorded)` : ""}
      </h3>
      <p className="text-small text-fg">
        These must-run tests are run by a person, not by the regression run. Record what happened after {changeSetKey}; release readiness counts the latest result for each.
      </p>
      {q.error && !d ? (
        <ErrorState error={q.error} title="Couldn’t load the manual re-tests." message="Try again." onRetry={() => void q.mutate()} />
      ) : !d ? (
        <Skeleton className="h-16" />
      ) : (
        <ul className="space-y-2">
          {d.items.map((i) => (
            <li key={i.case_lineage_id} className="space-y-1 rounded-lg bg-surface p-3 text-small ring-1 ring-line">
              <h4 id={headingId(i.case_key)} tabIndex={-1} className="break-words text-body font-medium text-fg-strong focus:outline-none">
                <Link href={`/projects/${projectId}/test-cases/${i.case_key}`} className={link}>
                  {i.case_key}
                </Link>{" "}
                {i.title}
              </h4>
              <p className="break-words text-fg">{i.latest ? `Latest: ${retestLine(i.latest, fmtDateTime)}` : "Not recorded yet."}</p>
              {i.history.length > 1 && (
                <Disclosure label={`Earlier results for ${i.case_key} (${i.history.length - 1})`}>
                  <ul className="mt-1 space-y-1 text-fg">
                    {i.history.slice(1).map((r) => (
                      <li key={r.id} className="break-words">
                        {retestLine(r, fmtDateTime)}
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              )}
              {d.permissions.can_record && (
                <Button size="sm" variant="secondary" aria-label={`Record re-test result for ${i.case_key}`} onClick={() => setRecording(i)}>
                  Record result…
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {recording && (
        <RecordDialog
          changeSetId={changeSetId}
          changeSetKey={changeSetKey}
          item={recording}
          onClose={() => setRecording(null)}
          onDone={(next, message) => {
            const key = recording.case_key;
            setRecording(null);
            toast(message, "success");
            void q.mutate(next, { revalidate: false });
            // A waiting assessment goes out of date (D37).
            void mutate((k) => typeof k === "string" && (k.startsWith(`/projects/${projectId}/release-`) || k.startsWith("/release-assessments/") || k === `/projects/${projectId}/workflow`));
            setTimeout(() => document.getElementById(headingId(key))?.focus(), 50);
          }}
        />
      )}
    </section>
  );
}

function RecordDialog({ changeSetId, changeSetKey, item, onClose, onDone }: { changeSetId: string; changeSetKey: string; item: ManualRetestItem; onClose: () => void; onDone: (next: ManualRetestsT, message: string) => void }) {
  const online = useOnline();
  const [status, setStatus] = useState<"passed" | "failed" | null>(null);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<{ status?: string; note?: string }>({});
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const firstRadio = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const statusError = useId();

  async function save() {
    const e = retestErrors(status, note);
    setErrors(e);
    if (e.status) return firstRadio.current?.focus();
    if (e.note) return noteRef.current?.focus();
    if (!online) return setServerError("You're offline. Reconnect to record the result.");
    setBusy(true);
    setServerError(null);
    try {
      const res = await api<ManualRetestsT>(`/change-sets/${changeSetId}/manual-retests`, { body: { case_key: item.case_key, status, note: note.trim() } });
      onDone(res, res.message ?? `Manual re-test of ${item.case_key} recorded: ${status}.`);
    } catch (err) {
      setServerError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={`Record re-test: ${item.case_key}`}
      description={`What happened when a person ran ${item.case_key} after ${changeSetKey}.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <fieldset aria-describedby={errors.status ? statusError : undefined}>
          <legend className="mb-1 text-body font-medium text-fg-strong">Result</legend>
          <div className="flex flex-wrap gap-x-6">
            {(["passed", "failed"] as const).map((s, i) => (
              <label key={s} className="flex min-h-6 cursor-pointer items-center gap-2 pointer-coarse:min-h-11">
                <input ref={i === 0 ? firstRadio : undefined} type="radio" name={`retest-${item.case_key}`} className="h-4 w-4" checked={status === s} onChange={() => setStatus(s)} />
                {s === "passed" ? "Passed" : "Failed"}
              </label>
            ))}
          </div>
          {errors.status && (
            <p id={statusError} className="mt-1 text-small font-medium text-danger-fg">
              {errors.status}
            </p>
          )}
        </fieldset>
        <TextArea
          ref={noteRef}
          label="Note"
          required
          rows={3}
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          error={errors.note}
          hint="What you did and what you saw. Kept with the result and in the audit log."
        />
        {serverError && (
          <Callout tone="danger" role="alert">
            {serverError}
          </Callout>
        )}
      </div>
    </Modal>
  );
}
