"use client";

// Automation › Scripts (design P4 §6.3): file list, read-only code viewer with line-linked check messages, the
// locator table for page objects, and what each script checks. Scripts are read-only (D13): Copy, never Edit.

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck, CircleDashed, CircleX, Copy, UserRoundCheck } from "lucide-react";
import {
  CHECK_ORDER,
  CHECK_TEXT,
  SCRIPT_STATUS,
  checksByStep,
  fileLinkName,
  groupScripts,
  liveSentence,
  locatorStatusHint,
  locatorStatusText,
  problemLines,
  type AssetDetail,
  type AssetRow,
  type AutomationOverview,
  type Check,
  type CheckName,
  type CheckState,
  type ScriptDetail,
  type ScriptRow,
  type ScriptVersion,
} from "@/lib/automation";
import { useApi } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/format";
import { Button, Checkbox, Disclosure, ErrorState, Skeleton, StatusPill, useToast } from "@/components/ui";
import { GeneratedByLabel } from "@/components/domain/ObservationLabel";

function CheckIcon({ state }: { state: CheckState }) {
  if (state === "ok") return <CircleCheck className="h-4 w-4 text-success-fg" aria-hidden />;
  if (state === "failed") return <CircleX className="h-4 w-4 text-danger-fg" aria-hidden />;
  return <CircleDashed className="h-4 w-4 text-fg-muted" aria-hidden />;
}

const STATE_SR: Record<CheckState, string> = { ok: "passed", failed: "failed", not_checked: "not checked" };

function FolderList({ title, children, count }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <li>
      <Disclosure label={`${title} (${count})`} defaultOpen>
        <ul className="mt-1 space-y-0.5 pl-4">{children}</ul>
      </Disclosure>
    </li>
  );
}

function FileLink({ path, status, active, href }: { path: string; status: ScriptRow["status"] | AssetRow["status"]; active: boolean; href: string }) {
  const name = path.split("/").pop() ?? path;
  const bad = status === "invalid";
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        aria-label={fileLinkName(path, status)}
        className={`flex min-h-8 items-center gap-2 rounded-md px-2 py-1 text-body ${active ? "bg-overlay font-semibold text-fg-strong" : "text-navy-700 hover:bg-overlay"}`}
      >
        {status === "valid" ? <CircleCheck className="h-4 w-4 text-success-fg" aria-hidden /> : bad ? <CircleX className="h-4 w-4 text-danger-fg" aria-hidden /> : <CircleDashed className="h-4 w-4 text-fg-muted" aria-hidden />}
        <span className="min-w-0 truncate font-mono text-small">{name}</span>
        {bad && <span className="text-caption text-danger-fg">Can’t run</span>}
        {status === "platform" && <span className="text-caption text-fg-muted">Platform file</span>}
      </Link>
    </li>
  );
}

export function FileList({ overview, file, href }: { overview: AutomationOverview; file: string | null; href: (file: string) => string }) {
  const b = overview.bundle!;
  const groups = groupScripts(b.scripts.filter((s) => s.status !== "outdated"));
  const pages = b.assets.filter((a) => a.path.startsWith("pages/"));
  const data = b.assets.filter((a) => a.path.startsWith("data/"));
  const platform = b.assets.filter((a) => a.generated_by === "platform");
  const outdated = b.scripts.filter((s) => s.status === "outdated");
  return (
    <nav aria-label="Script files" className="space-y-3">
      <div>
        <h3 className="text-small font-semibold uppercase tracking-[0.04em] text-fg-muted">Tests</h3>
        <ul className="mt-1 space-y-1">
          {groups.map((g) => (
            <FolderList key={g.folder} title={g.folder} count={g.scripts.length}>
              {g.scripts.map((s) => (
                <FileLink key={s.id} path={s.path} status={s.status} active={file === s.path} href={href(s.path)} />
              ))}
            </FolderList>
          ))}
        </ul>
      </div>
      {pages.length > 0 && (
        <div>
          <h3 className="text-small font-semibold uppercase tracking-[0.04em] text-fg-muted">Page objects</h3>
          <ul className="mt-1 space-y-0.5">
            {pages.map((a) => (
              <FileLink key={a.id} path={a.path} status={a.status} active={file === a.path} href={href(a.path)} />
            ))}
          </ul>
        </div>
      )}
      {data.length > 0 && (
        <div>
          <h3 className="text-small font-semibold uppercase tracking-[0.04em] text-fg-muted">Test data</h3>
          <ul className="mt-1 space-y-0.5">
            {data.map((a) => (
              <FileLink key={a.id} path={a.path} status={a.status} active={file === a.path} href={href(a.path)} />
            ))}
          </ul>
        </div>
      )}
      {platform.length > 0 && (
        <div>
          <h3 className="text-small font-semibold uppercase tracking-[0.04em] text-fg-muted">Platform files</h3>
          <ul className="mt-1 space-y-0.5">
            {platform.map((a) => (
              <FileLink key={a.id} path={a.path} status="platform" active={file === a.path} href={href(a.path)} />
            ))}
          </ul>
        </div>
      )}
      {outdated.length > 0 && (
        <div>
          <h3 className="text-small font-semibold uppercase tracking-[0.04em] text-fg-muted">Outdated ({outdated.length})</h3>
          <ul className="mt-1 space-y-0.5">
            {outdated.map((s) => (
              <FileLink key={s.id} path={s.path} status="outdated" active={file === s.path} href={href(s.path)} />
            ))}
          </ul>
        </div>
      )}
      {b.not_automated.length > 0 && (
        <div>
          <h3 className="text-small font-semibold uppercase tracking-[0.04em] text-fg-muted">Not automated ({b.not_automated.length})</h3>
          <ul className="mt-1 space-y-0.5 text-small">
            {b.not_automated.map((c) => (
              <li key={c.key} className="px-2 py-0.5 text-fg">
                <span className="font-mono">{c.key}</span> · Needs a person
              </li>
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
}

/** Read-only code (design §6.3, §17): focusable named region, line numbers hidden from screen readers. */
export function CodeView({ path, code, problems, focusLine }: { path: string; code: string; problems?: Map<number, string[]>; focusLine?: number | null }) {
  const [wrap, setWrap] = useState(false);
  const toast = useToast();
  const regionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusLine) return;
    const el = regionRef.current?.querySelector<HTMLElement>(`[data-line="${focusLine}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [focusLine]);
  const lines = code.replace(/\n$/, "").split("\n");
  const name = path.split("/").pop() ?? path;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          icon={<Copy className="h-4 w-4" aria-hidden />}
          onClick={() => {
            void navigator.clipboard?.writeText(code).catch(() => undefined);
            toast("Code copied", "success");
          }}
        >
          Copy code
        </Button>
        <Checkbox label="Wrap lines" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
      </div>
      <div ref={regionRef} role="region" aria-label={`Code of ${name}`} tabIndex={0} className="max-h-[32rem] overflow-auto rounded-md border border-line bg-elevated font-mono text-small focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy-600">
        <pre className={`py-2 ${wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}>
          {lines.map((l, i) => {
            const n = i + 1;
            const issue = problems?.get(n);
            return (
              <div key={n} id={`line-${n}`} data-line={n} className={`flex ${issue ? "border-l-4 border-danger-solid bg-danger-bg" : "border-l-4 border-transparent"} ${focusLine === n ? "outline outline-2 outline-danger-fg" : ""}`}>
                <span aria-hidden className="w-10 shrink-0 select-none pr-3 text-right text-fg-muted">
                  {n}
                </span>
                <code className="min-w-0 flex-1 pr-3 text-fg-strong">
                  {issue && <span className="sr-only">Problem on this line: {issue.join("; ")}. </span>}
                  {l || " "}
                </code>
              </div>
            );
          })}
        </pre>
      </div>
    </div>
  );
}

function CheckRow({ checks, validation, onLine, locatorsUsed }: { checks: Record<CheckName, CheckState>; validation: Partial<Record<CheckName, Check>>; onLine: (n: number) => void; locatorsUsed: number }) {
  return (
    <div className="space-y-2">
      <p className="text-small font-semibold text-fg-strong">Checks</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {CHECK_ORDER.map((c) => (
          <li key={c} className="flex items-center gap-1.5 text-small text-fg">
            <CheckIcon state={checks[c]} />
            {c === "locators" ? liveSentence(checks[c], validation.locators, locatorsUsed) : CHECK_TEXT[c]}
            <span className="sr-only">: {STATE_SR[checks[c]]}</span>
          </li>
        ))}
      </ul>
      {CHECK_ORDER.filter((c) => checks[c] !== "ok" && (validation[c]?.messages ?? []).length > 0).map((c) => (
        <div key={c} className="rounded-md bg-elevated px-3 py-2">
          <p className="text-small font-semibold text-fg-strong">{CHECK_TEXT[c]}</p>
          <ul className="mt-1 space-y-0.5">
            {(validation[c]?.messages ?? []).map((m, i) => (
              <li key={i} className="text-small text-fg">
                {m.line ? (
                  <a
                    href={`#line-${m.line}`}
                    onClick={(e) => {
                      e.preventDefault();
                      onLine(m.line!);
                    }}
                    className="text-navy-700 underline underline-offset-2"
                  >
                    {m.message}
                  </a>
                ) : (
                  m.message
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function ScriptViewer({ id, projectId }: { id: string; projectId: string }) {
  const d = useApi<ScriptDetail>(`/automation-scripts/${id}`);
  const versions = useApi<ScriptVersion[]>(`/automation-scripts/${id}/versions`);
  const [line, setLine] = useState<number | null>(null);
  const problems = useMemo(() => problemLines(d.data?.validation), [d.data?.validation]);
  if (d.error && !d.data) return <ErrorState error={d.error} title="Couldn’t load this script." message="Try again." onRetry={() => void d.mutate()} />;
  if (!d.data) return <Skeleton className="h-96" />;
  const s = d.data;
  const st = SCRIPT_STATUS[s.status];
  const used = new Set((s.validation.locators?.messages ?? []).map((m) => m.message)).size || Math.max(1, s.assertion_map.length);
  return (
    <article className="space-y-4" aria-labelledby="viewer-h">
      <div className="space-y-1">
        <h2 id="viewer-h" className="break-all font-mono text-h3 font-semibold text-fg-strong">
          {s.path}
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-small">
          <StatusPill status={st.status} tone={st.tone} label={st.label} />
          {s.generated_by === "ai" && s.status === "needs_review" ? (
            <span className="inline-flex items-center gap-1 text-warning-fg">
              <UserRoundCheck className="h-4 w-4" aria-hidden /> Written by AI · needs review
            </span>
          ) : (
            <GeneratedByLabel generatedBy={s.generated_by === "heal" ? "rules" : s.generated_by} />
          )}
          <span className="text-fg">Version {s.version}</span>
        </div>
        <p className="text-small text-fg">
          Test case:{" "}
          <Link href={`/projects/${projectId}/test-cases/${s.case.key}`} className="text-navy-700 underline underline-offset-2">
            {s.case.key} {s.case.title}
          </Link>{" "}
          (v{s.case.version}){s.case.requirement_keys.length ? ` · ${s.case.requirement_keys.join(", ")}` : ""}
        </p>
        <p className="text-small text-fg-muted">
          Read-only. To change what this test does, edit {s.case.key} and approve Gate 5 again; the script is rewritten. Engineers can edit the downloaded project.
        </p>
        {s.review && (
          <p className="text-small text-fg">
            {s.review.decision === "approve" ? "Approved" : "Rejected"} in review{s.review.decided_by?.full_name ? ` by ${s.review.decided_by.full_name}` : ""} · {fmtDateTime(s.review.decided_at)}
            {s.review.comment ? `: “${s.review.comment}”` : ""}
          </p>
        )}
      </div>
      <CheckRow checks={s.checks} validation={s.validation} onLine={setLine} locatorsUsed={used} />
      <CodeView path={s.path} code={s.code} problems={problems} focusLine={line} />
      <section aria-labelledby="checks-h" className="space-y-1">
        <h3 id="checks-h" className="text-body font-semibold text-fg-strong">
          What this script checks (from the test case)
        </h3>
        <ul className="space-y-0.5">
          {checksByStep(s.assertion_map).map((g, i) => (
            <li key={i} className="text-small text-fg">
              {typeof g.step === "number" ? `Step ${g.step}` : "Overall"}
              {g.stepText ? ` ${g.stepText}` : ""} → {g.checks.join(" · ")}
            </li>
          ))}
        </ul>
        <p className="text-small text-fg-muted">Expected results are never changed to make a test pass.</p>
      </section>
      {versions.data && versions.data.length > 0 && (
        <Disclosure label={`Versions (${versions.data.length})`} headingLevel={3}>
          <ul className="mt-2 space-y-1">
            {versions.data.map((v) => (
              <li key={v.id} className="text-small text-fg">
                Version {v.version} · {fmtDateTime(v.created_at)} · {v.cause} (test case v{v.case_version})
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </article>
  );
}

export function LocatorTable({ rows }: { rows: AssetDetail["locators"] }) {
  if (!rows?.length) return <p className="text-body text-fg-muted">No locators in this page object.</p>;
  return (
    <div className="overflow-x-auto" role="region" aria-label="Locators" tabIndex={0}>
      <table className="w-full text-left text-small">
        <caption className="sr-only">How each element is found and whether it was found on the live page</caption>
        <thead>
          <tr className="border-b border-line text-fg-muted">
            <th scope="col" className="py-2 pr-3 font-semibold">Element</th>
            <th scope="col" className="py-2 pr-3 font-semibold">How it’s found</th>
            <th scope="col" className="py-2 pr-3 font-semibold">On the live page</th>
            <th scope="col" className="py-2 font-semibold">Used by</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const hint = locatorStatusHint(r.status, r.reason);
            return (
              <tr key={r.getter} className="border-b border-line align-top">
                <th scope="row" className="py-2 pr-3 font-medium text-fg-strong">{r.element}</th>
                <td className="py-2 pr-3">
                  <code className="break-all font-mono text-fg-strong">{r.how}</code>
                  {r.fallback && <span className="block text-fg">Fallback: {r.fallback}</span>}
                </td>
                <td className="py-2 pr-3">
                  <span className="inline-flex items-center gap-1.5">
                    <CheckIcon state={r.status === "unique" ? "ok" : r.status === "not_checked" ? "not_checked" : "failed"} />
                    {locatorStatusText(r.status, r.count)}
                  </span>
                  {hint && <span className="block text-fg">{hint}</span>}
                </td>
                <td className="py-2">{r.used_by.length === 1 ? r.used_by[0] : `${r.used_by.length} scripts`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function AssetViewer({ id }: { id: string }) {
  const d = useApi<AssetDetail>(`/automation-assets/${id}`);
  if (d.error && !d.data) return <ErrorState error={d.error} title="Couldn’t load this file." message="Try again." onRetry={() => void d.mutate()} />;
  if (!d.data) return <Skeleton className="h-96" />;
  const a = d.data;
  const platform = a.generated_by === "platform";
  return (
    <article className="space-y-4" aria-labelledby="viewer-h">
      <div className="space-y-1">
        <h2 id="viewer-h" className="break-all font-mono text-h3 font-semibold text-fg-strong">
          {a.path}
        </h2>
        {platform ? (
          <p className="text-small text-fg">Platform file: part of the testing toolkit, the same in every project. Not generated.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-small">
            <StatusPill status={a.status === "valid" ? "completed" : a.status === "invalid" ? "failed" : "not_started"} label={a.status === "valid" ? "Valid" : a.status === "invalid" ? "Can’t run" : "Not checked yet"} />
            <GeneratedByLabel generatedBy="rules" />
            <span className="text-fg">Version {a.version}</span>
            {a.page_path && <span className="text-fg">· Page {a.page_path}</span>}
          </div>
        )}
      </div>
      <CodeView path={a.path} code={a.code} />
      {a.kind === "page_object" && (
        <section aria-labelledby="locators-h" className="space-y-2">
          <h3 id="locators-h" className="text-body font-semibold text-fg-strong">
            Locators
          </h3>
          <LocatorTable rows={a.locators} />
        </section>
      )}
    </article>
  );
}
