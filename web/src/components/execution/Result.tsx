"use client";

// Result detail building blocks (design P4 §8.6–8.7): expected vs actual, steps per attempt and the evidence viewer.
// Evidence comes from short-lived signed URLs; logs are shown as text and never run.

import { useEffect, useMemo, useState } from "react";
import { CircleCheck, CircleX, ShieldX } from "lucide-react";
import { fmtDuration } from "@/lib/format";
import { attemptsSummary, hostOf, parseConsole, parseNetwork, type ResultDetail, type ResultEvidence } from "@/lib/execution";
import { Segmented, TabPanel, Tabs } from "@/components/ui";
import { ProvenanceLabel } from "@/components/domain/ObservationLabel";
import { ObservedLabel } from "@/components/domain/ExecutionLabels";

export function ExpectedActual({ r }: { r: ResultDetail }) {
  if (!r.case) return null;
  const failed = ["failed", "error"].includes(r.status);
  return (
    <section aria-labelledby="exp-act" className="rounded-xl bg-surface ring-1 ring-line-strong">
      <h2 id="exp-act" className="border-b border-line px-5 py-3 text-h3 font-semibold text-fg-strong">
        Expected and actual
      </h2>
      <div className="space-y-4 px-5 py-4 text-body text-fg">
        <div>
          <p className="flex flex-wrap items-center gap-2 font-semibold text-fg-strong">
            Expected ({r.case.key} v{r.case.version}) <ProvenanceLabel provenance={r.case.provenance} />
          </p>
          <p className="mt-1">{r.case.expected_result || "None"}</p>
        </div>
        <div>
          <p className="flex flex-wrap items-center gap-2 font-semibold text-fg-strong">
            Actual <ObservedLabel text="Observed on the page" />
          </p>
          <p className="mt-1">{r.actual_result || (failed ? "No actual result was recorded." : "As expected.")}</p>
        </div>
      </div>
    </section>
  );
}

function expectedFor(r: ResultDetail, n: number): string | null {
  const checks = r.checks_by_step[String(n)];
  if (!checks?.length) return null;
  const words: Record<string, string> = {
    submission_blocked: "the submission is blocked",
    field_flagged: "",
    form_shown: "the form is shown",
    submission_accepted: "the form is accepted",
    signed_in: "signed in",
    not_signed_in: "not signed in",
  };
  const parts = checks.map((c) => (c.kind === "field_flagged" ? `${c.args[c.args.length - 1]} is flagged as required` : (words[c.kind] ?? c.helper)));
  return parts.filter(Boolean).join("; ");
}

export function StepResults({ r }: { r: ResultDetail }) {
  const attempts = r.attempt_details;
  const [n, setN] = useState(attempts.length ? attempts[attempts.length - 1].attempt : 1);
  if (!attempts.length) return null;
  const a = attempts.find((x) => x.attempt === n) ?? attempts[attempts.length - 1];
  return (
    <section aria-labelledby="steps-title" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="steps-title" className="text-h3 font-semibold text-fg-strong">
          Steps
        </h2>
        {attempts.length > 1 && <Segmented label="Attempt" value={n} onChange={setN} options={attempts.map((x) => ({ value: x.attempt, label: `Attempt ${x.attempt}` }))} />}
      </div>
      {attempts.length > 1 && <p className="text-small text-fg-muted">{attemptsSummary(attempts)}</p>}
      <ol className="space-y-1 rounded-lg bg-surface p-3 ring-1 ring-line">
        {a.steps.map((s) => (
          <li key={s.n} className="grid grid-cols-[1.5rem_1.25rem_minmax(0,1fr)_auto] items-start gap-2 text-body">
            <span className="tabular-nums text-fg-muted">{s.n}</span>
            {s.status === "failed" ? <CircleX className="mt-0.5 h-4 w-4 text-danger-fg" aria-hidden /> : <CircleCheck className="mt-0.5 h-4 w-4 text-success-fg" aria-hidden />}
            <span className="min-w-0">
              <span className="sr-only">{s.status === "failed" ? "Failed: " : "Passed: "}</span>
              {s.title}
              {s.status === "failed" && expectedFor(r, s.n) && <span className="block text-small text-fg-muted">Expected: {expectedFor(r, s.n)}</span>}
            </span>
            <span className="tabular-nums text-small text-fg-muted">{fmtDuration(s.duration_ms)}</span>
          </li>
        ))}
        {a.steps.length === 0 && <li className="text-body text-fg-muted">No steps were recorded for this attempt.</li>}
      </ol>
    </section>
  );
}

function useText(url: string | null | undefined): { text: string | null; error: boolean } {
  const [state, setState] = useState<{ text: string | null; error: boolean }>({ text: null, error: false });
  useEffect(() => {
    if (!url) return;
    let live = true;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => live && setState({ text: t, error: false }))
      .catch(() => live && setState({ text: null, error: true }));
    return () => {
      live = false;
    };
  }, [url]);
  return state;
}

type Tab = "screenshot" | "video" | "trace" | "console" | "network";

export function EvidenceViewer({ r }: { r: ResultDetail }) {
  const last = Math.max(1, ...r.evidence.map((e) => e.attempt ?? 1));
  const pick = useMemo(() => {
    const by: Partial<Record<string, ResultEvidence>> = {};
    for (const e of r.evidence) if ((e.attempt ?? 1) === last) by[e.kind] = e;
    return by;
  }, [r.evidence, last]);
  const consoleText = useText(pick.console_log?.content_url);
  const networkText = useText(pick.network_log?.content_url);
  const consoleLines = consoleText.text ? parseConsole(consoleText.text) : [];
  const netRows = networkText.text ? parseNetwork(networkText.text) : [];
  const errors = consoleLines.filter((l) => l.level === "error").length;
  const blocked = netRows.filter((x) => x.blocked).length;
  const [tab, setTab] = useState<Tab>("screenshot");
  const [errorsOnly, setErrorsOnly] = useState<"all" | "errors">("all");
  const [netFilter, setNetFilter] = useState<"all" | "failed" | "blocked">("all");
  const failed = r.status !== "passed";
  const subject = `${r.case_key} on ${r.page_state.browser?.split(" ")[0] ?? "Chromium"} ${r.viewport === "390x844" ? "mobile" : "desktop"}, attempt ${last}`;
  const tabs = [
    { id: "screenshot", label: "Screenshot" },
    { id: "video", label: "Video" },
    { id: "trace", label: "Trace" },
    { id: "console", label: consoleText.text !== null ? `Console (${errors} ${errors === 1 ? "error" : "errors"})` : "Console" },
    { id: "network", label: networkText.text !== null ? `Network (${netRows.length} requests, ${blocked} blocked)` : "Network" },
  ];
  return (
    <section aria-labelledby="evidence-title">
      <h2 id="evidence-title" tabIndex={-1} className="mb-2 focus:outline-none text-h3 font-semibold text-fg-strong">
        Evidence
      </h2>
      <Tabs tabs={tabs} value={tab} onChange={(v) => setTab(v as Tab)} label="Evidence" idPrefix="ev" />
      <TabPanel id={tab} idPrefix="ev">
        {tab === "screenshot" &&
          (pick.screenshot ? (
            <figure className="space-y-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={pick.screenshot.content_url} alt={`Final screen of ${subject}`} className="max-h-[32rem] w-full rounded-lg bg-white object-contain object-top ring-1 ring-line" />
              <figcaption className="flex flex-wrap gap-3 text-small text-fg-muted">
                Password fields are hidden in every screenshot.
                <a href={pick.screenshot.content_url} target="_blank" rel="noreferrer" className="font-medium text-navy-700 underline underline-offset-2">
                  Open full size
                </a>
              </figcaption>
            </figure>
          ) : (
            <p className="text-body text-fg-muted">No screenshot was recorded.</p>
          ))}
        {tab === "video" &&
          (pick.video ? (
            <div className="space-y-2">
              <video controls preload="metadata" src={pick.video.content_url} className="max-h-[32rem] w-full rounded-lg bg-black" aria-describedby="video-alt" />
              <p id="video-alt" className="text-small text-fg-muted">
                Recording of {r.case_key} on {r.page_state.browser?.split(" ")[0] ?? "Chromium"}. The steps above describe the same actions in text.{" "}
                <a href={pick.video.content_url} download className="font-medium text-navy-700 underline underline-offset-2">
                  Download video
                </a>
              </p>
            </div>
          ) : (
            <p className="text-body text-fg-muted">{failed ? "No video was recorded for this attempt." : "No video: videos are kept for failed tests only."}</p>
          ))}
        {tab === "trace" &&
          (r.signs_in ? (
            <p className="text-body text-fg">No trace: traces are switched off for tests that sign in, so the password is never recorded.</p>
          ) : pick.trace ? (
            <p className="text-body text-fg">
              <a href={pick.trace.content_url} download className="font-medium text-navy-700 underline underline-offset-2">
                Download trace (zip)
              </a>{" "}
              Open it in Playwright Trace Viewer (trace.playwright.dev) to step through the test.
            </p>
          ) : (
            <p className="text-body text-fg-muted">{failed ? "No trace was recorded for this attempt." : "No trace: traces are kept for failed tests only."}</p>
          ))}
        {tab === "console" && (
          <div className="space-y-2">
            <p className="text-small text-fg-muted">Messages from the tested site. Shown as text; never run.</p>
            <Segmented label="Show" value={errorsOnly} onChange={setErrorsOnly} options={[{ value: "all", label: "All" }, { value: "errors", label: "Errors only" }]} />
            {consoleText.error ? (
              <p className="text-body text-danger-fg">Evidence couldn&apos;t be loaded. Try again.</p>
            ) : (
              <div role="region" aria-label="Console log" tabIndex={0} className="max-h-80 overflow-auto rounded-lg bg-elevated p-3 font-mono text-xs leading-5 ring-1 ring-line">
                {consoleLines.filter((l) => errorsOnly === "all" || l.level === "error").map((l, i) => (
                  <p key={i} className="whitespace-pre-wrap break-words">
                    <span className="font-semibold">{l.level}</span> {l.text}
                  </p>
                ))}
                {consoleText.text !== null && consoleLines.length === 0 && <p>No console messages.</p>}
              </div>
            )}
          </div>
        )}
        {tab === "network" && (
          <div className="space-y-2">
            <Segmented label="Show" value={netFilter} onChange={setNetFilter} options={[{ value: "all", label: "All" }, { value: "failed", label: "Failed" }, { value: "blocked", label: "Blocked" }]} />
            {networkText.error ? (
              <p className="text-body text-danger-fg">Evidence couldn&apos;t be loaded. Try again.</p>
            ) : (
              <div role="region" aria-label="Network log" tabIndex={0} className="max-h-80 overflow-auto rounded-lg ring-1 ring-line">
                <table className="w-full text-left text-small">
                  <thead className="bg-elevated">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Method</th>
                      <th className="px-3 py-2 font-semibold">Address</th>
                      <th className="px-3 py-2 font-semibold">Status</th>
                      <th className="px-3 py-2 font-semibold">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {netRows
                      .filter((x) => netFilter === "all" || (netFilter === "blocked" ? x.blocked : x.failed))
                      .map((x, i) => (
                        <tr key={i} className="border-t border-line">
                          <td className="px-3 py-1.5 font-mono">{x.method || "—"}</td>
                          <td className="max-w-[28rem] break-all px-3 py-1.5 font-mono">{x.url}</td>
                          <td className="px-3 py-1.5">
                            {x.blocked ? (
                              <span className="inline-flex items-center gap-1 text-danger-fg">
                                <ShieldX className="h-3.5 w-3.5" aria-hidden />
                                Blocked by safety policy: {hostOf(x.url)} isn&apos;t an approved site.
                              </span>
                            ) : (
                              x.status
                            )}
                          </td>
                          <td className="px-3 py-1.5 tabular-nums text-fg-muted">{x.time}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {networkText.text !== null && netRows.length === 0 && <p className="p-3">No requests.</p>}
              </div>
            )}
          </div>
        )}
      </TabPanel>
    </section>
  );
}
