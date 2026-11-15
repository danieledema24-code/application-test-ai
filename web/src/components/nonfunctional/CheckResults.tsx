"use client";

// Accessibility (A11Y-) and security (SEC-) check pages (design P5 §7.3–7.8, §8.2–8.4): progress while running,
// results by rule / page / keyboard (accessibility) or by category with four results (security), the finding drawer
// (`?finding=`) and the triage dialog. Nothing here claims "accessible" or "secure".

import { RemovedEvidence, removedText } from "@/components/domain/RemovedEvidence";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { fmtDateTime } from "@/lib/format";
import {
  a11ySummaryLine,
  CATEGORY_LABEL,
  groupByRule,
  isActiveScan,
  KEYBOARD_NO_DRAFT,
  mappedKeys,
  screenshotAlt,
  secCountsLine,
  VIEWPORT_LABEL,
  type Finding,
  type FindingStatus,
  type Scan,
  type SecurityRuleRow,
} from "@/lib/nonfunctional";
import { Button, Callout, ConfirmDialog, Disclosure, Drawer, ErrorState, InlineError, LinkButton, Modal, Segmented, Skeleton, Table, TBody, Td, TextArea, Th, THead, Tr, useToast } from "@/components/ui";
import { ObservedLabel } from "@/components/domain/ExecutionLabels";
import { CheckResultLabel, FindingStatusLabel, HeuristicLabel, HonestyNote, NeedsReview, ScanStatusPill, SeenBefore, Severity } from "@/components/domain/NonFunctionalLabels";
import { useProject } from "@/components/workspace/ProjectContext";

type Evidence = { id: string; content_url: string; mime: string; removed?: string | null };

// ------------------------------------------------------------------ triage (§7.7)

export function TriageDialog({ finding, open, onClose, onDone }: { finding: Finding; open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [choice, setChoice] = useState<FindingStatus | null>(null);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ choice?: string; reason?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const options: { value: FindingStatus; label: string }[] = [
    { value: "accepted_risk", label: "Accept the risk: it's a real problem, and we've decided not to fix it now" },
    { value: "false_positive", label: "False positive: the check is wrong here" },
    ...(finding.status !== "open" ? [{ value: "open" as FindingStatus, label: "Reopen" }] : []),
  ];
  async function save() {
    const e: typeof errors = {};
    if (!choice) e.choice = "Choose an option.";
    if (!reason.trim()) e.reason = "Say why. The reason is shown in reports.";
    setErrors(e);
    if (e.choice || e.reason) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ message: string }>(`/quality-findings/${finding.id}/triage`, { method: "POST", body: { status: choice, reason: reason.trim() } });
      toast(r.message, "success");
      onDone();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) setErrors({ reason: err.message });
      else setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Accept risk or mark false positive · ${finding.key}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <fieldset aria-describedby={errors.choice ? "triage-choice-error" : undefined}>
          <legend className="sr-only">What is this finding?</legend>
          <div className="space-y-2">
            {options.map((o) => (
              <label key={o.value} className="flex items-start gap-2.5 text-body text-fg-strong">
                <input type="radio" name="triage" className="mt-1 h-4 w-4 accent-accent" checked={choice === o.value} onChange={() => setChoice(o.value)} />
                {o.label}
              </label>
            ))}
          </div>
          {errors.choice && (
            <p id="triage-choice-error" className="mt-1 text-small font-medium text-danger-fg">
              {errors.choice}
            </p>
          )}
        </fieldset>
        <TextArea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} rows={3} error={errors.reason} maxLength={1000} />
        <p className="text-small text-fg-muted">This stays on later checks of the same element (shown as &quot;Seen before&quot;). It doesn&apos;t change the defect, if there is one.</p>
        {finding.defect?.status === "draft" && (
          <p className="text-small text-fg">
            {finding.defect.key} is still a draft. Reject it at Gate 8 if it isn&apos;t a bug.
          </p>
        )}
        <InlineError error={error} />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ finding drawer (§7.5, §8.3)

function OutlinedScreenshot({ finding }: { finding: Finding }) {
  const ref = finding.evidence.find((e) => e.kind === "screenshot");
  const ev = useApi<Evidence>(ref ? `/evidence/${ref.evidence_id}` : null, undefined, { shouldRetryOnError: false });
  if (!ref) return null;
  if (ev.error) {
    const gone = ev.error instanceof ApiError && ev.error.status === 410;
    return <p className="text-small text-fg-muted">{gone ? errorMessage(ev.error) : "The screenshot couldn't be loaded."}</p>;
  }
  if (!ev.data) return <Skeleton className="h-40" />;
  if (removedText(ev.data)) return <RemovedEvidence text={removedText(ev.data)!} />;
  return (
    <figure className="space-y-1">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={ev.data.content_url} alt={screenshotAlt(finding)} className="w-full rounded-md ring-1 ring-line" />
      <figcaption className="text-small text-fg-muted">
        Numbered outlines match the element list. Password fields are masked.{" "}
        <a href={ev.data.content_url} target="_blank" rel="noreferrer" className="font-medium text-fg-strong underline underline-offset-2">
          Open full size<span className="sr-only"> (opens in a new tab)</span>
        </a>
      </figcaption>
    </figure>
  );
}

function FindingBody({ f, canAct, onTriage, onRaise, raising, rule }: { f: Finding; canAct: boolean; onTriage: () => void; onRaise: () => void; raising: boolean; rule?: SecurityRuleRow }) {
  const wcag = f.references.filter((r) => r.type === "wcag");
  const help = f.references.find((r) => r.type === "help");
  const d = f.details as { observed?: string; why?: string; fix?: string; subject?: string; reference?: { name: string; url: string } };
  const security = f.kind === "security";
  const reference = d.reference ?? rule?.reference ?? null;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Severity severity={f.severity} />
        <FindingStatusLabel status={f.status} />
        {f.seen_before && <SeenBefore keyText={f.seen_before} reopened={f.reopened} />}
        {f.heuristic && <HeuristicLabel />}
        {f.needs_review && <NeedsReview />}
      </div>
      <p className="text-small text-fg-muted">
        {f.path}
        {f.viewport ? ` · ${f.viewport === "mobile" ? "Phone" : "Desktop"}` : ""}
        {wcag.map((r) => ` · WCAG ${r.criterion}${r.name ? ` ${r.name}` : ""}${r.level ? ` (Level ${r.level})` : ""}`).join("")}
        {f.best_practice && " · Best practice (not a WCAG failure)"}
      </p>
      {f.status !== "open" && f.status_reason && (
        <p className="text-small text-fg">
          {f.status === "accepted_risk" ? "Accepted" : "Marked"} by {f.status_by?.full_name ?? "someone"}: &lsquo;{f.status_reason}&rsquo;
        </p>
      )}
      {security ? (
        <>
          {rule && rule.pages.length > 0 && (
            <p className="text-small text-fg">
              Pages ({rule.pages.length}): {rule.pages.map((u) => new URL(u).pathname).join(" · ")}
            </p>
          )}
          <section className="space-y-1">
            <h3 className="flex items-center gap-2 text-body font-semibold text-fg-strong">
              Observed in the response headers <ObservedLabel />
            </h3>
            <pre tabIndex={0} aria-label="Observed value" className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-elevated p-3 font-mono text-xs text-fg-strong ring-1 ring-line">
              {d.observed || "—"}
            </pre>
            {f.rule_id.startsWith("cookie") && <p className="text-small text-fg-muted">Cookie values are never stored.</p>}
          </section>
          {d.why && (
            <p className="text-body text-fg">
              <span className="font-semibold text-fg-strong">Why it matters </span>
              {d.why}
            </p>
          )}
          {d.fix && (
            <p className="text-body text-fg">
              <span className="font-semibold text-fg-strong">How to fix </span>
              {d.fix}
            </p>
          )}
        </>
      ) : (
        <>
          <section className="space-y-1">
            <h3 className="flex items-center gap-2 text-body font-semibold text-fg-strong">
              What&apos;s wrong {f.heuristic ? <HeuristicLabel /> : <ObservedLabel text="Observed on the page" />}
            </h3>
            {f.nodes[0]?.summary && <p className="whitespace-pre-line text-body text-fg">{f.nodes[0].summary}</p>}
          </section>
          <section className="space-y-2">
            <h3 className="text-body font-semibold text-fg-strong">Elements ({f.nodes.length})</h3>
            <ol className="space-y-2">
              {f.nodes.map((n, i) => (
                <li key={i} className="space-y-1">
                  <p className="text-small font-medium text-fg-strong">
                    <span aria-hidden className="mr-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-danger-solid text-caption text-white">
                      {i + 1}
                    </span>
                    {n.target}
                  </p>
                  {n.html && (
                    <pre tabIndex={0} aria-label={`HTML of element ${i + 1}`} className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-elevated p-2 font-mono text-xs text-fg-strong ring-1 ring-line">
                      {n.html}
                    </pre>
                  )}
                </li>
              ))}
            </ol>
          </section>
          <OutlinedScreenshot finding={f} />
          {f.heuristic ? (
            <p className="text-small text-fg-muted">{KEYBOARD_NO_DRAFT}</p>
          ) : (
            <section className="space-y-1">
              <h3 className="text-body font-semibold text-fg-strong">How to fix</h3>
              <p className="text-body text-fg">{(f.details as { how_to_fix?: string }).how_to_fix || f.title} <span className="text-small text-fg-muted">(From axe-core)</span></p>
              {help?.url && (
                <a href={help.url} target="_blank" rel="noreferrer" className="text-small font-medium text-fg-strong underline underline-offset-2">
                  Learn more about {f.rule_id}
                  <span className="sr-only"> (opens Deque University in a new tab)</span>
                </a>
              )}
            </section>
          )}
        </>
      )}
      {security && reference?.url && (
        <p className="text-small">
          <span className="font-semibold text-fg-strong">Reference </span>
          <a href={reference.url} target="_blank" rel="noreferrer" className="font-medium text-fg-strong underline underline-offset-2">
            {reference.name}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      )}
      <section className="space-y-1 text-small">
        <h3 className="text-body font-semibold text-fg-strong">Linked to</h3>
        <p className="text-fg">{f.mapped.requirements.length ? [...mappedKeys(f.mapped.requirements), ...mappedKeys(f.mapped.test_cases)].join(" · ") : "No requirement covers this page."}</p>
      </section>
      {f.defect && (
        <p className="text-small text-fg">
          Defect {f.defect.key} · {f.defect.status.charAt(0).toUpperCase() + f.defect.status.slice(1)}
        </p>
      )}
      {canAct && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onTriage} aria-label={`Accept risk or mark false positive for ${f.key}`}>
            Accept risk or mark false positive…
          </Button>
          {!f.defect && (
            <Button variant="secondary" onClick={onRaise} loading={raising} aria-label={`Raise defect for ${f.title}`}>
              Raise defect…
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function FindingDrawer({ findingKey, findings, projectId, canAct, onClose, onChanged, statement, rules }: { findingKey: string; findings: Finding[]; projectId: string; canAct: boolean; onClose: () => void; onChanged: () => void; statement: string | null; rules?: SecurityRuleRow[] }) {
  const toast = useToast();
  const router = useRouter();
  const f = findings.find((x) => x.key === findingKey);
  const [triage, setTriage] = useState(false);
  const [confirmRaise, setConfirmRaise] = useState(false);
  const [raising, setRaising] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!f) return null;
  async function raise() {
    setRaising(true);
    setError(null);
    try {
      const r = await api<{ defect: { key: string } }>(`/quality-findings/${f!.id}/raise-defect`, { method: "POST", body: {} });
      toast(`${r.defect.key} created as a draft.`, "success", { action: { label: `Open ${r.defect.key}`, onClick: () => router.push(`/projects/${projectId}/defects/${r.defect.key}`) } });
      setConfirmRaise(false);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setRaising(false);
    }
  }
  return (
    <Drawer open onClose={onClose} title={`${f.key} · ${f.title}`} subtitle={f.path}>
      <FindingBody
        f={f}
        canAct={canAct}
        onTriage={() => setTriage(true)}
        onRaise={() => setConfirmRaise(true)}
        raising={raising}
        rule={rules?.find((r) => r.rule_id === f.rule_id && r.subject === ((f.details as { subject?: string }).subject ?? "")) ?? rules?.find((r) => r.rule_id === f.rule_id)}
      />
      <InlineError error={error} />
      {statement && <p className="mt-6 border-t border-line pt-3 text-small text-fg-muted">{statement}</p>}
      {triage && <TriageDialog finding={f} open onClose={() => setTriage(false)} onDone={onChanged} />}
      <ConfirmDialog open={confirmRaise} onClose={() => setConfirmRaise(false)} onConfirm={raise} loading={raising} title={`Raise a defect for ${f.rule_id}?`} confirmLabel="Raise defect">
        <p>
          One draft is created for this rule across {findings.filter((x) => x.rule_id === f.rule_id).length} page
          {findings.filter((x) => x.rule_id === f.rule_id).length === 1 ? "" : "s"}. It goes to Gate 8 like every draft.
        </p>
      </ConfirmDialog>
    </Drawer>
  );
}

// ------------------------------------------------------------------ progress (§7.3)

function ProgressTable({ scan }: { scan: Scan }) {
  const done = new Map((scan.progress ?? scan.summary.progress ?? []).map((r) => [`${r.url}|${r.viewport}`, r]));
  const viewports = scan.viewports;
  const pages = scan.page_list ?? [];
  let checkingShown = false;
  return (
    <Table label={`Pages in ${scan.key}`}>
      <THead>
        <tr>
          <Th>Page</Th>
          {viewports.map((v) => (
            <Th key={v}>{v === "mobile" ? "Phone" : "Desktop"}</Th>
          ))}
        </tr>
      </THead>
      <TBody>
        {pages.map((p) => (
          <Tr key={p.url}>
            <Td rowHeader>{p.path}</Td>
            {viewports.map((v) => {
              const r = done.get(`${p.url}|${v}`);
              let text = "○ Waiting";
              if (r) text = r.state === "not_checked" ? `Not checked: ${r.reason}` : r.problems ? `✓ Done · ${r.problems} rule${r.problems === 1 ? "" : "s"} failed` : "✓ Done · no problems";
              else if (isActiveScan(scan) && !checkingShown) {
                checkingShown = true;
                text = "● Checking";
              }
              return <Td key={v}>{text}</Td>;
            })}
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}

// ------------------------------------------------------------------ accessibility views (§7.4, §7.6)

function RulesView({ findings, open, projectId, scanKey }: { findings: Finding[]; open: (k: string) => void; projectId: string; scanKey: string }) {
  const groups = groupByRule(findings.filter((f) => !f.needs_review && !f.heuristic));
  const review = findings.filter((f) => f.needs_review);
  return (
    <div className="space-y-3">
      {groups.length === 0 ? (
        <p className="text-body text-fg">No rule failed on the pages checked.</p>
      ) : (
        <Table label="Findings by rule">
          <THead>
            <tr>
              <Th>Rule</Th>
              <Th>Severity</Th>
              <Th>Where</Th>
              <Th>WCAG</Th>
              <Th>Status</Th>
            </tr>
          </THead>
          <TBody>
            {groups.map((g) => (
              <Tr key={g.rule_id}>
                <Td rowHeader>
                  <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => open(g.findings[0].key)}>
                    {g.title} ({g.rule_id})
                  </button>
                </Td>
                <Td>
                  <Severity severity={g.severity} />
                </Td>
                <Td>
                  <span className="block">
                    {g.pages.length} page{g.pages.length === 1 ? "" : "s"} · {g.elements} element{g.elements === 1 ? "" : "s"}
                  </span>
                  <span className="text-small">
                    {g.findings.map((f, i) => (
                      <span key={f.key}>
                        {i > 0 && ", "}
                        <Link href={`/projects/${projectId}/non-functional/checks/${scanKey}?finding=${f.key}`} scroll={false} className="underline underline-offset-2" aria-label={`Open ${g.rule_id} on ${f.path}`}>
                          {f.path}
                        </Link>
                      </span>
                    ))}
                  </span>
                </Td>
                <Td>{g.wcag || "—"}</Td>
                <Td>
                  <FindingStatusLabel status={g.status} />
                  {g.findings[0].defect && <span className="mt-1 block text-small">{g.findings[0].defect.key} {g.findings[0].defect.status === "draft" ? "Draft" : g.findings[0].defect.status}</span>}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      {review.length > 0 && (
        <Disclosure label={`Needs review (${new Set(review.map((f) => f.rule_id)).size})`}>
          <p className="mb-2 text-small text-fg-muted">Needs review: the automated check couldn&apos;t decide. These are never counted as problems or drafted.</p>
          <ul className="space-y-1 text-small">
            {review.map((f) => (
              <li key={f.key}>
                <button type="button" className="underline underline-offset-2" onClick={() => open(f.key)}>
                  {f.title} on {f.path}
                </button>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}

function PagesView({ scan, findings }: { scan: Scan; findings: Finding[] }) {
  const rows = scan.progress ?? scan.summary.progress ?? [];
  return (
    <Table label="Findings by page">
      <THead>
        <tr>
          <Th>Page · size</Th>
          <Th>Result</Th>
        </tr>
      </THead>
      <TBody>
        {rows.map((r) => {
          const fs = findings.filter((f) => f.url === r.url && f.viewport === r.viewport && !f.needs_review && !f.heuristic);
          const els = fs.reduce((n, f) => n + f.nodes.length, 0);
          return (
            <Tr key={`${r.url}|${r.viewport}`}>
              <Td rowHeader>
                {r.path} · {r.viewport === "mobile" ? "Phone" : "Desktop"}
              </Td>
              <Td>
                {r.state === "not_checked"
                  ? `Not checked: ${r.reason}`
                  : fs.length
                    ? `${fs.length} rule${fs.length === 1 ? "" : "s"} failed · ${els} element${els === 1 ? "" : "s"}`
                    : "✓ No problems found by the automated rules"}
              </Td>
            </Tr>
          );
        })}
      </TBody>
    </Table>
  );
}

function KeyboardView({ scan, findings, open }: { scan: Scan; findings: Finding[]; open: (k: string) => void }) {
  const kb = scan.summary.keyboard ?? [];
  const [shown, setShown] = useState<string | null>(null);
  if (!scan.keyboard) return <p className="text-body text-fg-muted">The keyboard pass was off for this check.</p>;
  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-h3 font-semibold text-fg-strong">
        Keyboard checks (heuristic) <HeuristicLabel />
      </h3>
      <p className="text-body text-fg">Pressed Tab up to 60 times and Shift+Tab back on each page. Nothing was clicked or typed.</p>
      <Table label="Keyboard checks">
        <THead>
          <tr>
            <Th>Page</Th>
            <Th>Focus moves through</Th>
            <Th>Trap</Th>
            <Th>Focus visible</Th>
            <Th>Not reachable</Th>
          </tr>
        </THead>
        <TBody>
          {kb.map((k) => {
            const path = k.path ?? new URL(k.url).pathname;
            const fs = findings.filter((f) => f.heuristic && f.url === k.url);
            const trap = fs.find((f) => f.rule_id === "keyboard-trap");
            return (
              <Tr key={`${k.url}|${k.viewport}`}>
                <Td rowHeader>{path}</Td>
                <Td>{k.error ? `Not checked: ${k.error}` : `${k.focusable ?? 0} links and controls`}</Td>
                <Td>
                  {trap ? (
                    <button type="button" className="font-medium text-danger-fg underline underline-offset-2" onClick={() => open(trap.key)}>
                      ✗ Trap found
                    </button>
                  ) : (
                    "✓ None"
                  )}
                </Td>
                <Td>{k.not_visible ? `✗ ${k.not_visible} without outline` : `✓ On all ${k.focusable ?? 0}`}</Td>
                <Td>{k.not_reachable ? `✗ ${k.not_reachable}` : "✓ None"}</Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>
      <div className="space-y-2">
        {kb
          .filter((k) => k.order?.length)
          .map((k) => {
            const path = k.path ?? new URL(k.url).pathname;
            const isOpen = shown === k.url;
            return (
              <div key={k.url}>
                <Button variant="ghost" size="sm" aria-expanded={isOpen} onClick={() => setShown(isOpen ? null : k.url)}>
                  {isOpen ? `Hide focus order for ${path}` : `Show focus order for ${path}`}
                </Button>
                {isOpen && (
                  <ol className="ml-6 list-decimal text-small text-fg">
                    {k.order!.map((o) => (
                      <li key={o.n}>
                        {o.role} &quot;{o.label}&quot;
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            );
          })}
      </div>
      <p className="text-small text-fg-muted">{KEYBOARD_NO_DRAFT}</p>
    </div>
  );
}

// ------------------------------------------------------------------ security view (§8.2)

function SecurityView({ scan, findings, open }: { scan: Scan; findings: Finding[]; open: (k: string) => void }) {
  const rules = scan.summary.rules ?? [];
  const anyFailed = rules.some((r) => r.result === "failed");
  const [filter, setFilter] = useState<"problems" | "all">(anyFailed ? "problems" : "all");
  const shown = filter === "all" ? rules : rules.filter((r) => r.result === "failed" || r.result === "not_checked" || r.result === "not_applicable");
  const cats = ["transport", "headers", "cookies", "content"] as const;
  const first = (r: SecurityRuleRow) => findings.find((f) => f.rule_id === r.rule_id && ((f.details as { subject?: string }).subject ?? "") === r.subject) ?? findings.find((f) => f.rule_id === r.rule_id);
  return (
    <div className="space-y-4">
      <p className="text-body text-fg-strong">{secCountsLine(scan)}</p>
      <p className="text-small text-fg-muted">Defects are created only when you raise one.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "problems", label: "Failed and not checked" },
            { value: "all", label: `Show all ${rules.length} checks` },
          ]}
        />
      </div>
      {!anyFailed && scan.status !== "running" && <p className="text-body text-fg">No passive check failed on the {scan.summary.pages_checked ?? scan.pages} pages checked.</p>}
      {cats.map((c) => {
        const rows = shown.filter((r) => r.category === c);
        if (!rows.length) return null;
        return (
          <section key={c} aria-labelledby={`cat-${c}`} className="space-y-1">
            <h3 id={`cat-${c}`} className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
              {CATEGORY_LABEL[c]}
            </h3>
            <ul className="divide-y divide-line rounded-lg bg-surface ring-1 ring-line">
              {rows.map((r) => {
                const f = r.result === "failed" ? first(r) : undefined;
                return (
                  <li key={`${r.rule_id}|${r.subject}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                    <CheckResultLabel result={r.result} />
                    {r.result === "failed" && <Severity severity={r.severity} />}
                    <span className="min-w-0 flex-1 basis-40 text-body text-fg-strong [overflow-wrap:anywhere]">
                      {r.title}
                      {(r.result === "not_applicable" || r.result === "not_checked" || (r.result === "passed" && r.reason)) && <span className="block text-small text-fg-muted">{r.reason}</span>}
                    </span>
                    {r.result === "failed" && <span className="text-small text-fg-muted">{r.page_count ? `${r.page_count} of ${scan.summary.pages_checked ?? scan.pages} pages` : "site"}</span>}
                    {f && (
                      <Button variant="secondary" size="sm" onClick={() => open(f.key)} aria-label={`Details for ${r.title}`}>
                        Details
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ page

export function CheckPage({ scanKey }: { scanKey: string }) {
  const p = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { role } = useAuth();
  const canAct = role !== "viewer" && role !== null;
  const scan = useApi<Scan>(`/projects/${p.id}/quality-scans/by-key/${scanKey}`, undefined, { refreshInterval: (d) => (!d || isActiveScan(d) ? 2000 : 0) });
  const s = scan.data;
  const findings = useApi<{ items: Finding[] }>(s ? `/quality-scans/${s.id}/findings` : null, undefined, { refreshInterval: isActiveScan(s) ? 3000 : 0 });
  const [cancelOpen, setCancelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const view = (params.get("view") as "rules" | "pages" | "keyboard" | null) ?? "rules";
  const findingKey = params.get("finding");
  const prevStatus = useRef<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const title = s ? `${s.key} · ${s.kind === "accessibility" ? "Accessibility check" : "Security check (passive)"}` : scanKey;
  useEffect(() => {
    document.title = `${title} · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [title, p.project?.name]);
  useEffect(() => {
    if (!s) return;
    if (prevStatus.current && isActiveScan({ status: prevStatus.current as Scan["status"] }) && !isActiveScan(s))
      setAnnounce(s.kind === "accessibility" ? `${s.key} finished: ${a11ySummaryLine(s).split(" · ")[0]}, ${s.summary.pages_not_checked ?? 0} pages not checked` : `${s.key} finished: ${secCountsLine(s)}`);
    prevStatus.current = s.status;
  }, [s]);
  const go = (q: Record<string, string | null>) => {
    const u = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(q)) if (v === null) u.delete(k);
    else u.set(k, v);
    router.replace(`/projects/${p.id}/non-functional/checks/${scanKey}${u.toString() ? `?${u}` : ""}`, { scroll: false });
  };
  const items = useMemo(() => findings.data?.items ?? [], [findings.data]);
  async function cancel() {
    if (!s) return;
    setBusy(true);
    try {
      await api(`/quality-scans/${s.id}/cancel`, { method: "POST" });
      toast(`${s.key} cancelled.`, "success");
      setCancelOpen(false);
      scan.mutate();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }
  const back = (
    <Link href={`/projects/${p.id}/non-functional?tab=${s?.kind ?? "accessibility"}`} className="inline-flex items-center gap-1 text-small font-medium text-fg-muted hover:text-fg-strong">
      <ArrowLeft className="h-4 w-4" aria-hidden /> Non-functional
    </Link>
  );
  if (scan.error && !s)
    return (
      <div className="space-y-4">
        {back}
        <ErrorState error={scan.error} title={scan.error instanceof ApiError && scan.error.status === 404 ? `We couldn't find ${scanKey} in this project.` : "Couldn't load this check."} onRetry={() => scan.mutate()} />
      </div>
    );
  if (!s)
    return (
      <div className="space-y-4">
        {back}
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-64" />
      </div>
    );
  const a11y = s.kind === "accessibility";
  const nc = s.not_checked ?? [];
  return (
    <div className="space-y-5">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 tabIndex={-1} data-page-title className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
            {title}
          </h1>
          <ScanStatusPill scan={s} />
        </div>
        {canAct && isActiveScan(s) && (
          <Button variant="secondary" onClick={() => setCancelOpen(true)} disabled={s.cancel_requested}>
            {s.cancel_requested ? "Cancelling…" : "Cancel check…"}
          </Button>
        )}
      </div>
      <p className="text-small text-fg-muted">
        {fmtDateTime(s.created_at)} · {s.pages} pages
        {a11y && ` · ${s.viewports.map((v) => VIEWPORT_LABEL[v] ?? v).join(", ")} · keyboard pass ${s.keyboard ? "on" : "off"}`}
        {a11y && s.tool_versions.axe && ` · axe-core ${s.tool_versions.axe}`}
        {s.requested_by?.full_name && ` · started by ${s.requested_by.full_name}`}
      </p>
      <HonestyNote>{s.statement}</HonestyNote>
      {["completed", "partial", "cancelled"].includes(s.status) && (
        <p className="text-small">
          <Link href={`/projects/${p.id}/reports/${a11y ? "accessibility" : "security"}?run=${s.key}`} className="font-medium text-navy-700 underline underline-offset-2">
            Open the {a11y ? "Accessibility" : "Security"} Report for {s.key}
          </Link>
        </p>
      )}
      <p role="status" className="sr-only">
        {announce}
      </p>
      {s.status === "partial" && (
        <Callout tone="warning" title={`Partial: ${nc.length} page${nc.length === 1 ? "" : "s"} ${nc.length === 1 ? "wasn't" : "weren't"} checked. ${nc.length === 1 ? "It isn't" : "They aren't"} counted as clean.`} />
      )}
      {s.status === "failed" && <Callout tone="danger">The check didn&apos;t complete: {s.error}. Pages already checked keep their results.</Callout>}
      {s.status === "cancelled" && (
        <Callout tone="neutral">
          Cancelled. {s.summary.pages_checked ?? 0} pages were checked; the rest show &apos;Not checked: check cancelled&apos;.
        </Callout>
      )}
      {nc.length > 0 && (
        <div className="text-small text-fg">
          {nc.length} page{nc.length === 1 ? "" : "s"} {nc.length === 1 ? "wasn't" : "weren't"} checked, so {nc.length === 1 ? "it isn't" : "they aren't"} counted as clean:
          <ul className="ml-5 list-disc">
            {nc.map((n) => (
              <li key={`${n.url}|${n.viewport ?? ""}`}>
                {new URL(n.url).pathname} ({n.reason})
              </li>
            ))}
          </ul>
        </div>
      )}
      {isActiveScan(s) ? (
        <ProgressTable scan={s} />
      ) : findings.error && !findings.data ? (
        <ErrorState error={findings.error} onRetry={() => findings.mutate()} />
      ) : !findings.data ? (
        <Skeleton className="h-64" />
      ) : a11y ? (
        <div className="space-y-4">
          <p className="text-body text-fg-strong">{s.summary.rules_failed ? a11ySummaryLine(s) : `The automated rules found no problems on the ${s.summary.pages_checked ?? s.pages} pages checked.`}</p>
          {(s.defects?.length ?? 0) > 0 && (
            <p className="text-small text-fg">
              {(s.summary.drafted?.length ?? 0) === 0 && (s.summary.occurrences_added?.length ?? 0) > 0
                ? `No new drafts: the problems were added to ${s.summary.occurrences_added!.join(" and ")} as new occurrences.`
                : "Defects drafted: "}
              {(s.summary.drafted?.length ?? 0) > 0 &&
                s.defects!.map((d, i) => (
                  <span key={d.key}>
                    {i > 0 && ", "}
                    <Link href={`/projects/${p.id}/defects/${d.key}`} className="font-medium underline underline-offset-2">
                      {d.key}
                    </Link>{" "}
                    ({d.summary})
                  </span>
                ))}
              {(s.summary.drafted?.length ?? 0) > 0 && " · Gate 8"}
            </p>
          )}
          <Segmented
            label="View"
            value={view}
            onChange={(v) => go({ view: v === "rules" ? null : v })}
            options={[
              { value: "rules", label: "By rule" },
              { value: "pages", label: "By page" },
              { value: "keyboard", label: "Keyboard" },
            ]}
          />
          {view === "rules" && <RulesView findings={items} open={(k) => go({ finding: k })} projectId={p.id} scanKey={scanKey} />}
          {view === "pages" && <PagesView scan={s} findings={items} />}
          {view === "keyboard" && <KeyboardView scan={s} findings={items} open={(k) => go({ finding: k })} />}
        </div>
      ) : (
        <SecurityView scan={s} findings={items} open={(k) => go({ finding: k })} />
      )}
      {findingKey && (
        <FindingDrawer
          findingKey={findingKey}
          findings={items}
          projectId={p.id}
          canAct={canAct}
          onClose={() => go({ finding: null })}
          onChanged={() => {
            findings.mutate();
            scan.mutate();
          }}
          statement={a11y ? null : s.statement}
          rules={s.summary.rules}
        />
      )}
      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={cancel}
        loading={busy}
        danger
        title={`Cancel ${s.key}?`}
        confirmLabel="Cancel check"
        cancelLabel="Keep checking"
      >
        <p>Pages already checked keep their results; the rest show &apos;Not checked: check cancelled&apos;.</p>
      </ConfirmDialog>
      {a11y && !isActiveScan(s) && canAct && <div className="pt-2"><LinkButton href={`/projects/${p.id}/non-functional?tab=accessibility`} size="sm">Check again</LinkButton></div>}
    </div>
  );
}
