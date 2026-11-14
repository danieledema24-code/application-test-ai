"use client";

// Run tests dialog (design P4 §7): step 1 what to run, step 2 the G7 authorisation summary with risky-action
// approvals. Approvers authorise in the same click (D8); members request authorisation.

import { useEffect, useId, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useOnline } from "@/lib/useOnline";
import {
  aboutDuration,
  approvalsBlocker,
  BROWSER_TEXT,
  hostMatches,
  retriesLine,
  scopeSentence,
  SUITE_TEXT,
  targetsText,
  thatClause,
  type ApprovalChoice,
  type ApprovalNeed,
  type Browser,
  type RunDetail,
  type RunScope,
  type Suite,
  type Viewport,
} from "@/lib/execution";
import { Button, Callout, Disclosure, InlineError, Modal, Skeleton, TextArea, TextField } from "@/components/ui";

export const EVIDENCE_LINE = "A screenshot of every test (password fields hidden); video and trace for failures; console and network logs.";
export const NOT_COVERED_LINE = "This authorisation is for this run only. It doesn't cover re-runs, other sites or scripts changed later.";

export type RunPrefill = { suite?: Suite; caseKeys?: string[]; browsers?: Browser[]; viewports?: Viewport[] };
type Choice = Suite | "choose";

function selectionBody(choice: Choice, keys: string[]) {
  return choice === "choose" ? { case_keys: keys } : { suite: choice };
}

async function preview(projectId: string, selection: object, browsers: Browser[], viewports: Viewport[]): Promise<RunScope> {
  return api<RunScope>(`/projects/${projectId}/execution-runs/preview`, { method: "POST", body: { selection, browsers, viewports } });
}

// ---- Summary (shared by the dialog, the G7 panel and the run's "Authorisation & scope" tab) --------------------

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-line py-2.5 last:border-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-small font-semibold text-fg-strong">{label}</dt>
      <dd className="min-w-0 text-body text-fg">{children}</dd>
    </div>
  );
}

function ShowTests({ keys, titles, what }: { keys: string[]; titles: Record<string, string>; what: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} className="ml-2 text-small font-medium text-navy-700 underline underline-offset-2 hover:text-navy-900">
        Show {keys.length} {keys.length === 1 ? "test" : "tests"}
        <span className="sr-only"> {thatClause(what, keys.length)}</span>
      </button>
      {open && (
        <ul id={id} className="mt-1 space-y-0.5 pl-4 text-small text-fg">
          {keys.map((k) => (
            <li key={k}>
              <span className="font-mono">{k}</span> {titles[k] ?? ""}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The §7.2 summary. Identical wording wherever it's shown. */
export function AuthorisationSummary({ scope, approvals }: { scope: RunScope; approvals?: React.ReactNode }) {
  const titles = Object.fromEntries(scope.cases.map((c) => [c.key, c.title]));
  const n = scope.tests;
  return (
    <dl>
      <Row label="Site">
        <span className="break-all font-mono text-small">{scope.target_origin}</span> (approved at Gate 1). Tests can&apos;t reach any other site.
      </Row>
      <Row label="Tests">
        {n} {n === 1 ? "test" : "tests"} · {targetsText(scope.browsers, scope.viewports)} · {aboutDuration(scope.estimated_seconds)}
      </Row>
      <Row label="What it may do on the site">
        <ul className="space-y-1">
          {scope.side_effects.map((l) => (
            <li key={`${l.kind}-${l.form}`}>
              <span>
                {l.kind === "blocked" ? `${l.text} (${l.count} ${l.count === 1 ? "test" : "tests"})` : `${l.text}: ${l.count} ${l.count === 1 ? "test" : "tests"}`}
                {l.kind === "signs_in" ? ". The password is never shown, recorded or traced." : ""}
              </span>
              <ShowTests keys={l.case_keys} titles={titles} what={l.text} />
            </li>
          ))}
          {!scope.side_effects.some((l) => l.kind === "creates_data") && <li>Creates data on the site: none</li>}
          {scope.risky_line && <li>{scope.risky_line}</li>}
        </ul>
      </Row>
      {approvals}
      <Row label="Retries">{retriesLine(scope)}</Row>
      <Row label="Evidence">{EVIDENCE_LINE}</Row>
      <Row label="Not covered">{NOT_COVERED_LINE}</Row>
    </dl>
  );
}

// ---- Risky-action approval cards (§7.3) -------------------------------------------------------------------------

export function RiskyActionCard({
  need,
  approvalKey,
  host,
  choice,
  onChange,
  readOnly,
  showError,
}: {
  need: ApprovalNeed;
  approvalKey?: string;
  host: string;
  choice: ApprovalChoice;
  onChange: (c: ApprovalChoice) => void;
  readOnly: boolean;
  showError: boolean;
}) {
  const id = useId();
  const title = need.kind === "external_transaction" ? "External transaction (payment or purchase)" : "Destructive action (delete, cancel or close something)";
  const keys = need.case_keys.join(", ");
  const typedWrong = choice.decision === "approve" && choice.confirm_text.trim() !== "" && !hostMatches(choice.confirm_text, host);
  const missing = showError && choice.decision === "approve" && !hostMatches(choice.confirm_text, host);
  return (
    <fieldset className="rounded-lg p-4 ring-1 ring-inset ring-warning-line">
      <legend className="px-1 text-body font-semibold text-fg-strong">
        {approvalKey ? `${approvalKey} · ` : ""}
        {title}
      </legend>
      <ul className="mb-3 space-y-0.5 text-small text-fg">
        {need.cases.map((c) => (
          <li key={c.key}>
            <span className="font-mono">{c.key}</span> {c.title}
            {c.step && c.quote ? ` · Step ${c.step} '${c.quote}'` : ""} · Not retried
          </li>
        ))}
      </ul>
      {readOnly ? (
        <p className="text-small text-fg-muted">Needs approval by someone who can approve gates. They&apos;ll see this when they review the request.</p>
      ) : (
        <div className="space-y-2">
          <label className="flex min-h-11 items-start gap-2">
            <input type="radio" name={id} className="mt-1 h-4 w-4" checked={choice.decision === "approve"} onChange={() => onChange({ ...choice, decision: "approve" })} />
            <span>
              Approve: {need.kind === "external_transaction" ? "this test may make a payment or purchase" : "this test may delete, cancel or close something"} on {host}
            </span>
          </label>
          {choice.decision === "approve" && (
            <TextField
              label={`Type ${host} to confirm`}
              value={choice.confirm_text}
              onChange={(e) => onChange({ ...choice, confirm_text: e.target.value })}
              error={typedWrong || missing ? `Type ${host} exactly to confirm.` : undefined}
              autoComplete="off"
              spellCheck={false}
              wrapClassName="ml-6"
            />
          )}
          <label className="flex min-h-11 items-start gap-2">
            <input type="radio" name={id} className="mt-1 h-4 w-4" checked={choice.decision === "reject"} onChange={() => onChange({ ...choice, decision: "reject" })} />
            <span>
              Don&apos;t approve: skip {keys} in this run (the other tests still run)
            </span>
          </label>
        </div>
      )}
    </fieldset>
  );
}

export function ApprovalsRow({ children, count }: { children: React.ReactNode; count: number }) {
  if (!count) return null;
  return (
    <div className="border-b border-line py-2.5">
      <p className="mb-2 text-small font-semibold text-fg-strong">Needs a separate approval ({count})</p>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

// ---- The dialog -------------------------------------------------------------------------------------------------

export function RunDialog({
  open,
  onClose,
  projectId,
  canAuthorise,
  prefill,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  canAuthorise: boolean;
  prefill?: RunPrefill;
  onCreated: (run: RunDetail, authorised: boolean) => void;
}) {
  const online = useOnline();
  const [step, setStep] = useState<1 | 2>(1);
  const [choice, setChoice] = useState<Choice>("regression");
  const [keys, setKeys] = useState<string[]>([]);
  const [browsers, setBrowsers] = useState<Browser[]>(["chromium"]);
  const [viewports, setViewports] = useState<Viewport[]>(["desktop"]);
  const [notes, setNotes] = useState("");
  const [counts, setCounts] = useState<Partial<Record<Suite, number>>>({});
  const [all, setAll] = useState<RunScope | null>(null);
  const [scope, setScope] = useState<RunScope | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [choices, setChoices] = useState<ApprovalChoice[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Reset and read the per-suite counts when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setChoice(prefill?.caseKeys?.length ? "choose" : (prefill?.suite ?? "regression"));
    setKeys(prefill?.caseKeys ?? []);
    setBrowsers(prefill?.browsers ?? ["chromium"]);
    setViewports(prefill?.viewports ?? ["desktop"]);
    setNotes("");
    setError(null);
    setTried(false);
    setScope(null);
    let live = true;
    void Promise.all((["smoke", "regression", "all_approved"] as Suite[]).map((s) => preview(projectId, { suite: s }, ["chromium"], ["desktop"]).catch(() => null))).then((r) => {
      if (!live) return;
      setCounts({ smoke: r[0]?.cases.length, regression: r[1]?.cases.length, all_approved: r[2]?.cases.length });
      setAll(r[2]);
      if (!prefill?.caseKeys?.length && !prefill?.suite && !r[1]?.cases.length && r[2]?.cases.length) setChoice("all_approved");
    });
    return () => {
      live = false;
    };
  }, [open, projectId, prefill]);

  // The scope of the current choice (server dry-run; creates nothing).
  useEffect(() => {
    if (!open) return;
    if (choice === "choose" && keys.length === 0) {
      setScope(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      preview(projectId, selectionBody(choice, keys), browsers, viewports)
        .then((s) => {
          if (!live) return;
          setScope(s);
          setError(null);
          setChoices(s.approvals_needed.map((a) => ({ kind: a.kind, decision: null, confirm_text: "" })));
        })
        .catch((e) => live && setError(e));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, projectId, choice, keys, browsers, viewports]);

  useEffect(() => {
    if (open) headingRef.current?.focus();
  }, [step, open]);

  const installed = all?.installed_browsers ?? scope?.installed_browsers ?? { chromium: true };
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));
  const nextBlocker = !scope ? (choice === "choose" ? "Choose at least one test case." : null) : scope.over_limit ? scope.limit_message : scope.cases.length === 0 ? "No script can run yet. Open Automation to see why." : null;
  const host = scope?.target_host ?? "";
  const approvalBlock = canAuthorise && scope ? approvalsBlocker(choices, host) : null;

  async function next() {
    if (nextBlocker || !scope) return;
    try {
      const fresh = await preview(projectId, selectionBody(choice, keys), browsers, viewports);
      if (fresh.scope_hash !== scope.scope_hash) setError(new Error("The scripts changed while you were choosing. Check the summary again."));
      setScope(fresh);
      setStep(2);
    } catch (e) {
      setError(e);
    }
  }

  async function submit() {
    if (!scope) return;
    setTried(true);
    if (canAuthorise && approvalBlock) return;
    setBusy(true);
    setError(null);
    try {
      const run = await api<RunDetail>(`/projects/${projectId}/execution-runs`, {
        method: "POST",
        body: {
          selection: selectionBody(choice, keys),
          browsers,
          viewports,
          notes: notes.trim() || null,
          authorise: canAuthorise,
          approvals: canAuthorise ? choices.map((c) => ({ kind: c.kind, decision: c.decision, confirm_text: c.decision === "approve" ? c.confirm_text : null })) : [],
        },
      });
      onCreated(run, canAuthorise);
    } catch (e) {
      setError(new Error(`Couldn't create the run: ${e instanceof ApiError ? e.message.replace(/\.$/, "") : "the server didn't answer"}. Nothing was started.`));
    } finally {
      setBusy(false);
    }
  }

  const cases = all?.cases ?? [];
  const leftAll = all?.left_out ?? [];
  const shown = filter.trim() ? cases.filter((c) => `${c.key} ${c.title}`.toLowerCase().includes(filter.trim().toLowerCase())) : cases;
  const n = scope?.tests ?? 0;
  const offline = !online ? "You're offline. Reconnect to run tests." : null;

  const footer =
    step === 1 ? (
      <div className="flex w-full flex-wrap items-center justify-end gap-2">
        {(nextBlocker || offline) && (
          <p id="run-next-reason" className="mr-auto text-small text-fg-muted">
            {offline ?? nextBlocker}
          </p>
        )}
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void next()} aria-disabled={!!nextBlocker || !!offline || !scope || undefined} aria-describedby={nextBlocker || offline ? "run-next-reason" : undefined}>
          Next: check what this run will do
        </Button>
      </div>
    ) : (
      <div className="flex w-full flex-wrap items-center justify-end gap-2">
        <Button variant="secondary" onClick={() => setStep(1)} className="mr-auto">
          Back
        </Button>
        <div className="flex flex-col items-end gap-1">
          <Button
            onClick={() => (approvalBlock || offline ? setTried(true) : void submit())}
            loading={busy}
            aria-disabled={(canAuthorise && !!approvalBlock) || !!offline || undefined}
            aria-describedby="run-submit-note"
          >
            {canAuthorise ? `Authorise and run ${n} ${n === 1 ? "test" : "tests"}` : "Request authorisation"}
          </Button>
          <p id="run-submit-note" className="text-small text-fg-muted">
            {offline ??
              (canAuthorise && approvalBlock
                ? approvalBlock
                : canAuthorise
                  ? "Your authorisation is recorded with your name, the time and this exact list."
                  : "Nothing runs until someone who can approve gates authorises it.")}
          </p>
        </div>
      </div>
    );

  return (
    <Modal open={open} onClose={onClose} size="lg" title="Run tests" description={step === 1 ? "Step 1 of 2 · What to run" : "Step 2 of 2 · Authorise"} footer={footer}>
      <h3 ref={headingRef} tabIndex={-1} className="mb-3 text-h3 font-semibold text-fg-strong focus:outline-none">
        {step === 1 ? "What to run" : "Check what this run will do"}
      </h3>
      {step === 1 && (
        <div className="space-y-5">
          <fieldset>
            <legend className="mb-1 text-body font-medium text-fg-strong">Test cases</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              {(["smoke", "regression", "all_approved", "choose"] as Choice[]).map((c) => (
                <label key={c} className="flex min-h-11 items-center gap-2">
                  <input type="radio" name="run-suite" className="h-4 w-4" checked={choice === c} onChange={() => setChoice(c)} />
                  {c === "choose" ? "Choose test cases…" : `${SUITE_TEXT[c]}${counts[c] !== undefined ? ` (${counts[c]})` : ""}`}
                </label>
              ))}
            </div>
            {choice === "choose" && (
              <div className="mt-2 rounded-lg p-3 ring-1 ring-inset ring-line">
                <TextField label="Find a test case" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="TC id or title" />
                <ul className="mt-2 max-h-56 space-y-0.5 overflow-y-auto" aria-label="Test cases with valid scripts">
                  {shown.map((c) => (
                    <li key={c.key}>
                      <label className="flex min-h-9 items-center gap-2 text-body">
                        <input type="checkbox" className="h-4 w-4" checked={keys.includes(c.key)} onChange={(e) => setKeys((k) => toggle(k, c.key, e.target.checked))} />
                        <span className="font-mono text-small">{c.key}</span> {c.title}
                      </label>
                    </li>
                  ))}
                  {leftAll.map((c) => (
                    <li key={c.key}>
                      <label className="flex min-h-9 items-center gap-2 text-body text-fg-muted">
                        <input type="checkbox" className="h-4 w-4" disabled />
                        <span className="font-mono text-small">{c.key}</span> {c.title} · {c.reason}
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </fieldset>
          <fieldset>
            <legend className="mb-1 text-body font-medium text-fg-strong">Browsers</legend>
            {(["chromium", "firefox", "webkit"] as Browser[]).map((b) => {
              const ok = b === "chromium" || !!installed[b];
              return (
                <label key={b} className={`flex min-h-9 items-center gap-2 ${ok ? "" : "text-fg-muted"}`}>
                  <input type="checkbox" className="h-4 w-4" disabled={!ok} checked={browsers.includes(b)} onChange={(e) => setBrowsers((l) => (e.target.checked ? [...l, b] : l.length > 1 ? l.filter((x) => x !== b) : l))} />
                  {BROWSER_TEXT[b]}
                  {b === "chromium" ? " (desktop browser engine)" : b === "webkit" ? " (Safari's engine)" : ""}
                  {!ok && <span className="text-small"> · Not installed on this server</span>}
                </label>
              );
            })}
          </fieldset>
          <fieldset>
            <legend className="mb-1 text-body font-medium text-fg-strong">Screen sizes</legend>
            <div className="flex flex-wrap gap-x-5">
              {(["desktop", "mobile"] as Viewport[]).map((v) => (
                <label key={v} className="flex min-h-9 items-center gap-2">
                  <input type="checkbox" className="h-4 w-4" checked={viewports.includes(v)} onChange={(e) => setViewports((l) => (e.target.checked ? [...l, v] : l.length > 1 ? l.filter((x) => x !== v) : l))} />
                  {v === "desktop" ? "Desktop 1440 × 900 (the size discovery used)" : "Mobile 390 × 844"}
                </label>
              ))}
            </div>
          </fieldset>
          <TextArea label="Note (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={500} />
          {!scope && !error && choice !== "choose" && <Skeleton className="h-10" />}
          {scope && (
            <div className="space-y-2" aria-live="polite">
              <p className="text-body font-medium text-fg-strong">{scopeSentence(scope)}</p>
              {scope.over_limit && <Callout tone="warning">{scope.limit_message}</Callout>}
              {scope.left_out.length > 0 && (
                <Disclosure label={`Left out (${scope.left_out.length})`}>
                  <ul className="space-y-0.5 text-small text-fg">
                    {scope.left_out.map((l) => (
                      <li key={l.key}>
                        <span className="font-mono">{l.key}</span> · {l.reason}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-small text-fg-muted">Scripts that can&apos;t run, are outdated or still need review (Gate 6) can&apos;t be chosen. Cases needing test credentials run as Blocked.</p>
                </Disclosure>
              )}
              {scope.blocked.length > 0 && (
                <p className="text-small text-fg-muted">
                  {scope.blocked.map((b) => b.key).join(", ")} will show as Blocked: needs saved test credentials.
                </p>
              )}
            </div>
          )}
          {error !== null && <InlineError error={error} />}
        </div>
      )}
      {step === 2 && scope && (
        <div className="space-y-3">
          {error !== null && <InlineError error={error} />}
          <AuthorisationSummary
            scope={scope}
            approvals={
              <ApprovalsRow count={scope.approvals_needed.length}>
                {scope.approvals_needed.map((need, i) => (
                  <RiskyActionCard
                    key={need.kind}
                    need={need}
                    host={host}
                    choice={choices[i] ?? { kind: need.kind, decision: null, confirm_text: "" }}
                    onChange={(c) => setChoices((cs) => cs.map((x, j) => (j === i ? c : x)))}
                    readOnly={!canAuthorise}
                    showError={tried}
                  />
                ))}
              </ApprovalsRow>
            }
          />
        </div>
      )}
      {step === 2 && !scope && <Skeleton className="h-64" />}
    </Modal>
  );
}
