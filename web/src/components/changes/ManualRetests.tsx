"use client";

// Manual re-tests (D37; design P6 §7.4, placed by P6-05b; revised by P4-14 §4.6): impacted manual must-run tests
// aren't part of the automated regression run, so a person records passed or failed with what happened here. Since D39
// each one is a manual result: it counts for the case, for "Impacted tests re-run since the change" and release
// readiness; recording one makes an assessment waiting for Gate 9 out of date. With files or Blocked, people use the
// manual run Start modal ([Record re-tests with files…]).

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/format";
import { claimRouteFocus } from "@/lib/focusReturn";
import { useOnline } from "@/lib/useOnline";
import { retestErrors, retestLine, type ManualRetestItem, type ManualRetests as ManualRetestsT } from "@/lib/release";
import { NO_DEFECT_MANUAL, recordStartHref } from "@/lib/execution";
import { Button, Callout, Disclosure, ErrorState, LinkButton, Modal, Skeleton, useToast } from "@/components/ui";
import { ManualResultFields } from "@/components/execution/ManualRecord";

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
        These must-run tests are run by a person, not by the regression run. Record what happened after {changeSetKey}. Each result counts as a manual result on the test case and for release readiness.
      </p>
      {d?.permissions.can_record && d.items.length > 0 && (
        <LinkButton size="sm" href={recordStartHref(projectId, { cases: d.items.map((i) => i.case_key), change: changeSetKey })}>
          Record re-tests with files…
        </LinkButton>
      )}
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
              <p className="break-words text-fg">
                {i.latest ? `Latest: ${retestLine(i.latest, fmtDateTime)}` : "Not recorded yet."}
                {i.latest?.run_key && i.latest.result_key && (
                  <>
                    {" "}
                    <Link href={`/projects/${projectId}/execution/${i.latest.run_key}/results/${i.latest.result_key}`} className={link}>
                      Open {i.latest.result_key} result
                    </Link>
                  </>
                )}
              </p>
              {i.latest?.status === "failed" && i.latest.result_key && d.permissions.can_record && (
                <Callout
                  tone="info"
                  actions={
                    <LinkButton size="sm" href={`/projects/${projectId}/defects/new?from=${i.latest.result_key}`}>
                      Raise defect…<span className="sr-only"> from {i.case_key} result</span>
                    </LinkButton>
                  }
                >
                  {NO_DEFECT_MANUAL}
                </Callout>
              )}
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
  const [errors, setErrors] = useState<{ status?: string; actual_result?: string }>({});
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const firstRadio = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  async function save() {
    const e = retestErrors(status, note);
    setErrors({ status: e.status, actual_result: e.note });
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
      description={`What happened when you tested ${item.case_key} by hand after ${changeSetKey}.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy}>
            Save result
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* The D37 contract keeps Passed/Failed only and no files (P4-14 §4.6). */}
        <ManualResultFields
          caseKey={item.case_key}
          statuses={["passed", "failed"]}
          status={status}
          onStatus={(s) => setStatus(s === "blocked" ? null : s)}
          what={note}
          onWhat={setNote}
          errors={errors}
          firstRadioRef={firstRadio}
          whatRef={noteRef}
        />
        {/* D39: one result per manual run; saving again while that run is recording updates it, not adds to history. */}
        <p className="text-small text-fg-muted">{`If you're still recording a manual run for ${changeSetKey}, this updates your result there instead of adding a new one.`}</p>
        {serverError && (
          <Callout tone="danger" role="alert">
            {serverError}
          </Callout>
        )}
      </div>
    </Modal>
  );
}
