"use client";

// Non-functional section (design P5 §6–§9.1): three summary cards and tabs for Performance, Accessibility and
// Security (passive). Checks and load tests start only when someone starts them; load tests need their own approval.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { useOnline } from "@/lib/useOnline";
import {
  a11ySummaryLine,
  A11Y_STATEMENT,
  defaultTab,
  durationShort,
  G2_FIRST,
  G4_FIRST,
  isActiveScan,
  msText,
  runStatusLabel,
  secCountsLine,
  SECURITY_STATEMENT,
  TYPE_TEMPLATES,
  VIEWPORT_LABEL,
  type LoadRun,
  type Overview,
  type Profile,
  type Scan,
} from "@/lib/nonfunctional";
import { Button, Callout, Card, Checkbox, EmptyState, ErrorState, InlineError, LinkButton, Modal, Skeleton, TabPanel, Table, Tabs, TBody, Td, Th, THead, Tr, useToast } from "@/components/ui";
import { GeneratedByLabel } from "@/components/domain/ObservationLabel";
import { OutOfDateCallout } from "@/components/domain/OutOfDateCallout";
import { HonestyNote, LoadRunStatusPill, ScanStatusPill } from "@/components/domain/NonFunctionalLabels";
import { useProject } from "@/components/workspace/ProjectContext";
import { LoadTestRequestDialog } from "./LoadApproval";

type TabId = "performance" | "accessibility" | "security";

function offlineReason(online: boolean, action: string): string | null {
  return online ? null : `You're offline. Reconnect to ${action}.`;
}

/** A start control: aria-disabled with the visible reason when it can't be used (P3 §13.1). */
function StartButton({ children, reason, onClick, loading, variant = "primary" }: { children: React.ReactNode; reason: string | null; onClick: () => void; loading?: boolean; variant?: "primary" | "secondary" }) {
  const id = `why-${String(children).replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="flex flex-col items-start gap-1">
      <Button variant={variant} onClick={() => !reason && onClick()} loading={loading} aria-disabled={reason ? true : undefined} aria-describedby={reason ? id : undefined}>
        {children}
      </Button>
      {reason && (
        <p id={id} className="text-small text-fg-muted">
          {reason}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ accessibility start dialog (§7.2)

export function CheckAccessibilityDialog({ open, onClose, projectId, overview }: { open: boolean; onClose: () => void; projectId: string; overview: Overview }) {
  const router = useRouter();
  const toast = useToast();
  const [phone, setPhone] = useState(false);
  const [keyboard, setKeyboard] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pages = overview.pages.public + (signedIn ? overview.pages.signed_in : 0);
  const sizes = phone ? 2 : 1;
  const minutes = Math.max(1, Math.round((pages * sizes * (keyboard ? 6 : 4)) / 60));
  async function start() {
    setBusy(true);
    setError(null);
    try {
      const scan = await api<Scan>(`/projects/${projectId}/accessibility-scans`, { method: "POST", body: { viewports: phone ? ["desktop", "mobile"] : ["desktop"], keyboard, signed_in: signedIn } });
      toast(`${scan.key} started.`, "success");
      onClose();
      router.push(`/projects/${projectId}/non-functional/checks/${scan.key}`);
    } catch (e) {
      const msg = errorMessage(e);
      setError(msg.startsWith("An accessibility check is already running") ? msg : `Couldn't start the check: ${msg}. Nothing was started.`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Check accessibility"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={start} loading={busy}>
            Start check
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <fieldset>
          <legend className="text-body font-medium text-fg-strong">Pages</legend>
          <p className="text-body text-fg">All discovered pages ({overview.pages.public})</p>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="text-body font-medium text-fg-strong">Screen sizes</legend>
          <Checkbox label={VIEWPORT_LABEL.desktop.replace("Desktop", "Desktop")} checked disabled />
          <Checkbox label={VIEWPORT_LABEL.mobile} checked={phone} onChange={(e) => setPhone(e.target.checked)} />
        </fieldset>
        <Checkbox label="Follow keyboard focus with Tab and Shift+Tab (up to 60 presses per page)" checked={keyboard} onChange={(e) => setKeyboard(e.target.checked)} />
        <Checkbox
          label={`Include pages behind sign-in (${overview.pages.signed_in}), using the saved test account`}
          checked={signedIn}
          disabled={!overview.credentials_saved || overview.pages.signed_in === 0}
          onChange={(e) => setSignedIn(e.target.checked)}
          description={!overview.credentials_saved ? "Save test credentials to include these pages." : undefined}
        />
        <p className="text-small text-fg-muted">
          About {minutes} minute{minutes === 1 ? "" : "s"} · {pages} page{pages === 1 ? "" : "s"} × {sizes} screen size{sizes === 1 ? "" : "s"}. Nothing on the site is clicked, typed or submitted.
        </p>
        {error && <InlineError error={error} />}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ summary cards (§6.1)

function cardLine(o: Overview, tab: TabId): React.ReactNode {
  if (tab === "accessibility") {
    const s = o.accessibility;
    if (!s) return "Not checked yet.";
    return (
      <>
        <span className="font-medium text-fg-strong">
          {s.key} · {fmtDate(s.created_at)}
        </span>
        <br />
        {isActiveScan(s) ? s.status_label : a11ySummaryLine(s).split(" · ")[0]}
      </>
    );
  }
  if (tab === "security") {
    const s = o.security;
    if (!s) return "Not checked yet.";
    const c = s.summary.counts ?? {};
    return (
      <>
        <span className="font-medium text-fg-strong">
          {s.key} · {fmtDate(s.created_at)}
        </span>
        <br />
        {isActiveScan(s) ? s.status_label : `${c.failed ?? 0} findings · ${c.passed ?? 0} rules passed · ${c.not_applicable ?? 0} not applicable`}
      </>
    );
  }
  const r = o.performance.latest;
  if (!r) return o.performance.waiting.length ? `${o.performance.waiting[0]} waiting for approval` : "Not checked yet.";
  return (
    <>
      <span className="font-medium text-fg-strong">
        {r.key} · {fmtDate(r.created_at)}
      </span>
      <br />
      {runStatusLabel(r)}
    </>
  );
}

function SummaryCards({ o, onOpen }: { o: Overview; onOpen: (t: TabId) => void }) {
  const cards: { id: TabId; title: string; name: string }[] = [
    { id: "accessibility", title: "Accessibility", name: "Open accessibility results" },
    { id: "security", title: "Security (passive)", name: "Open security results" },
    { id: "performance", title: "Performance", name: "Open performance results" },
  ];
  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      {cards.map((c) => (
        <Card key={c.id} className="p-4">
          <h2 className="text-h3 font-semibold text-fg-strong">
            <button type="button" onClick={() => onOpen(c.id)} className="text-left hover:underline" aria-label={c.name}>
              {c.title}
            </button>
          </h2>
          <p className="mt-1 text-small text-fg">{cardLine(o, c.id)}</p>
        </Card>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ tabs

function ToolCallout({ text }: { text: string | null }) {
  if (!text) return null;
  return <Callout tone="danger">{text}</Callout>;
}

function a11yToolMessage(o: Overview): string | null {
  if (!o.tools.browser) return "Accessibility and security checks can't run on this server: the Chromium browser isn't installed.";
  if (!o.tools.axe) return "Accessibility checks can't run on this server: the accessibility checker (axe-core) isn't installed. Ask whoever runs this server to run `npm install` in automation/.";
  return null;
}

function ScanStaleCallout({ o, stage, onAgain }: { o: Overview; stage: string; onAgain?: () => void }) {
  if (o.stages[stage]?.status !== "stale") return null;
  return (
    <OutOfDateCallout title="Out of date" actions={onAgain && <Button size="sm" variant="secondary" onClick={onAgain}>Check again</Button>}>
      Pages changed after this check. The results still show what was found then. Run the check again to update them.
    </OutOfDateCallout>
  );
}

function AccessibilityTab({ o, projectId, canStart, online, refresh }: { o: Overview; projectId: string; canStart: boolean; online: boolean; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const s = o.accessibility;
  const tool = a11yToolMessage(o);
  const reason = tool ? "The accessibility checker isn't available on this server." : isActiveScan(s) ? `An accessibility check is already running (${s!.key}).` : offlineReason(online, "start a check");
  const start = canStart && <StartButton reason={reason} onClick={() => setOpen(true)}>Check accessibility…</StartButton>;
  return (
    <div className="space-y-4">
      <h2 className="text-h2 font-semibold text-fg-strong">Accessibility</h2>
      <p className="text-body text-fg">Checks every discovered page for barriers that affect people using screen readers, keyboards or low vision.</p>
      <HonestyNote>{A11Y_STATEMENT}</HonestyNote>
      <ToolCallout text={tool} />
      <ScanStaleCallout o={o} stage="accessibility" onAgain={canStart ? () => setOpen(true) : undefined} />
      {!s ? (
        <Card className="p-5">
          <p className="text-body text-fg">
            What the check does: opens each page, runs the axe-core rules for WCAG 2.2 A and AA, and presses only Tab and Shift+Tab to follow keyboard focus. It never clicks, types or submits.
          </p>
          <div className="mt-4">{start}</div>
        </Card>
      ) : (
        <Card className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="text-body font-semibold text-fg-strong">
                <Link href={`/projects/${projectId}/non-functional/checks/${s.key}`} className="underline-offset-2 hover:underline">
                  {s.key}
                </Link>{" "}
                · {fmtDateTime(s.created_at)}
              </p>
              <ScanStatusPill scan={s} />
              {!isActiveScan(s) && <p className="text-body text-fg">{a11ySummaryLine(s)}</p>}
              {s.open_findings !== undefined && <p className="text-small text-fg-muted">{s.open_findings} open findings</p>}
            </div>
            <div className="flex flex-wrap items-start gap-2">
              <LinkButton href={`/projects/${projectId}/non-functional/checks/${s.key}`} size="sm">
                Open {s.key}
              </LinkButton>
              {start}
            </div>
          </div>
        </Card>
      )}
      {open && <CheckAccessibilityDialog open onClose={() => { setOpen(false); refresh(); }} projectId={projectId} overview={o} />}
    </div>
  );
}

function SecurityTab({ o, projectId, canStart, online }: { o: Overview; projectId: string; canStart: boolean; online: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = o.security;
  const tool = o.tools.browser ? null : "Accessibility and security checks can't run on this server: the Chromium browser isn't installed.";
  const reason = tool ? "The browser isn't available on this server." : isActiveScan(s) ? `A security check is already running (${s!.key}).` : offlineReason(online, "start a check");
  async function run() {
    setBusy(true);
    setError(null);
    try {
      const scan = await api<Scan>(`/projects/${projectId}/security-assessments`, { method: "POST", body: { signed_in: signedIn } });
      toast(`${scan.key} started.`, "success");
      router.push(`/projects/${projectId}/non-functional/checks/${scan.key}`);
    } catch (e) {
      setError(`Couldn't start the check: ${errorMessage(e)}. Nothing was started.`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <h2 className="text-h2 font-semibold text-fg-strong">Security (passive)</h2>
      <HonestyNote>{SECURITY_STATEMENT}</HonestyNote>
      <p className="text-body text-fg">
        Checks what a normal visitor&apos;s browser receives on each discovered page: HTTPS, security headers, cookies, mixed content and error messages. It opens each page once, plus one plain-http request to the start page and one encryption (TLS) handshake. No attacks, no guessing of hidden pages, no form submission. No approval needed.
      </p>
      <ToolCallout text={tool} />
      <ScanStaleCallout o={o} stage="security_assessment" />
      {s && (
        <Card className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="text-body font-semibold text-fg-strong">
                <Link href={`/projects/${projectId}/non-functional/checks/${s.key}`} className="underline-offset-2 hover:underline">
                  {s.key}
                </Link>{" "}
                · {fmtDateTime(s.created_at)}
              </p>
              <ScanStatusPill scan={s} />
              {!isActiveScan(s) && <p className="text-body text-fg">{secCountsLine(s)}</p>}
            </div>
            <LinkButton href={`/projects/${projectId}/non-functional/checks/${s.key}`} size="sm">
              Open {s.key}
            </LinkButton>
          </div>
        </Card>
      )}
      {canStart && (
        <div className="space-y-3">
          {o.pages.signed_in > 0 && (
            <Checkbox
              label={`Include pages behind sign-in (${o.pages.signed_in}), using the saved test account`}
              checked={signedIn}
              disabled={!o.credentials_saved}
              onChange={(e) => setSignedIn(e.target.checked)}
              description={!o.credentials_saved ? "Save test credentials to include these pages." : undefined}
            />
          )}
          <StartButton reason={reason} onClick={run} loading={busy}>
            Run security check
          </StartButton>
          {error && <InlineError error={error} />}
        </div>
      )}
    </div>
  );
}

function ProfileRow({ p, projectId, o, canRequest, online }: { p: Profile; projectId: string; o: Overview; canRequest: boolean; online: boolean }) {
  const [open, setOpen] = useState(false);
  const thresholdsText = p.thresholds.some((t) => t.source?.type === "requirement") ? "thresholds from requirements" : "default thresholds";
  const blocker = !o.tools.loadgen
    ? "The load generator isn't available on this server."
    : p.violations.length
      ? `${p.key} is over your organisation's limits. Edit it first.`
      : p.status !== "ready"
        ? `Mark ${p.key} ready first.`
        : offlineReason(online, "request a load test");
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 border-t border-line py-3 first:border-t-0">
      <div className="min-w-0 space-y-1">
        <p className="text-body font-medium text-fg-strong">
          <Link href={`/projects/${projectId}/non-functional/profiles/${p.key}`} className="underline-offset-2 hover:underline">
            {p.key} {p.name}
          </Link>{" "}
          · v{p.version} · {p.status === "stale" ? "Strategy changed" : p.status.charAt(0).toUpperCase() + p.status.slice(1)} <GeneratedByLabel generatedBy={p.generated_by} />
        </p>
        <p className="text-small text-fg-muted">
          {p.totals.targets} pages · up to {p.totals.vus} users · {durationShort(p.totals.duration_s)} · at most {p.totals.rps} requests/s · {thresholdsText}
        </p>
        {p.status === "stale" && <p className="text-small text-warning-fg">This profile still works. Draft it again to pick up changes.</p>}
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <LinkButton href={`/projects/${projectId}/non-functional/profiles/${p.key}`} size="sm" aria-label={`Edit ${p.key}`}>
          Edit
        </LinkButton>
        {canRequest && (
          <StartButton variant="secondary" reason={blocker} onClick={() => setOpen(true)}>
            Request load test…
          </StartButton>
        )}
      </div>
      {open && <LoadTestRequestDialog open onClose={() => setOpen(false)} projectId={projectId} profile={p} limits={o.limits} canApprove={o.permissions.can_approve} />}
    </li>
  );
}

function PerformanceTab({ o, projectId, canStart, online }: { o: Overview; projectId: string; canStart: boolean; online: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const profiles = useApi<{ items: Profile[] }>(o.gates.g4 ? `/projects/${projectId}/performance-profiles` : null);
  const runs = useApi<{ items: LoadRun[] }>(`/projects/${projectId}/performance-runs`, undefined, {
    refreshInterval: (d) => (d?.items.some((r) => r.status === "queued" || r.status === "running" || r.status === "awaiting_approval") ? 3000 : 15000),
  });
  const [drafting, setDrafting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const lim = o.limits.organisation;
  async function draft(type: Profile["type"] = "load") {
    setDrafting(type);
    setError(null);
    setMenu(false);
    try {
      const p = await api<Profile>(`/projects/${projectId}/performance-profiles`, { method: "POST", body: { type } });
      toast(`${p.key} drafted.`, "success");
      router.push(`/projects/${projectId}/non-functional/profiles/${p.key}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDrafting(null);
    }
  }
  const items = profiles.data?.items.filter((p) => p.status !== "retired") ?? [];
  return (
    <div className="space-y-4">
      <h2 className="text-h2 font-semibold text-fg-strong">Performance</h2>
      <p className="text-body text-fg">How fast pages respond when several people use the site at once. Every load test needs its own approval.</p>
      {!o.tools.loadgen && <Callout tone="danger">Load tests can&apos;t run on this server: the built-in load generator isn&apos;t installed. Ask whoever runs this server to follow automation/README.</Callout>}
      {o.performance.waiting.length > 0 && (
        <Callout tone="warning" title={`${o.performance.waiting.join(", ")} ${o.performance.waiting.length === 1 ? "is" : "are"} waiting for ${o.permissions.can_approve ? "your approval" : "approval by someone who can approve"}`}
          actions={<LinkButton size="sm" href={`/projects/${projectId}/non-functional/load-tests/${o.performance.waiting[0]}`}>{o.permissions.can_approve ? `Review ${o.performance.waiting[0]}` : `Open ${o.performance.waiting[0]}`}</LinkButton>}
        />
      )}
      <section aria-labelledby="profiles-title" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="profiles-title" className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
            Load profiles
          </h3>
          {o.gates.g4 && canStart && items.length > 0 && (
            <div className="relative">
              <Button variant="secondary" size="sm" aria-expanded={menu} aria-haspopup="true" onClick={() => setMenu(!menu)}>
                New profile
              </Button>
              {menu && (
                <ul className="absolute right-0 z-30 mt-1 w-72 rounded-lg bg-surface py-1 shadow-md ring-1 ring-line-strong">
                  {TYPE_TEMPLATES.map((t) => (
                    <li key={t.type}>
                      <button type="button" onClick={() => draft(t.type)} className="block w-full px-3 py-2 text-left text-body hover:bg-overlay">
                        {t.label}
                        {t.type === "soak" && <span className="block text-small text-fg-muted">Short: limited to {durationShort(lim.duration_s)} by your organisation</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        {!o.gates.g4 ? (
          <Card className="p-5">
            <p className="text-body text-fg">{G4_FIRST}</p>
          </Card>
        ) : profiles.error && !profiles.data ? (
          <ErrorState error={profiles.error} onRetry={() => profiles.mutate()} />
        ) : !profiles.data ? (
          <Skeleton className="h-16" />
        ) : items.length === 0 ? (
          <Card className="p-5">
            <p className="text-body text-fg">No load profile yet. The Performance Agent can draft one from the public pages discovery found.</p>
            {canStart && (
              <div className="mt-3">
                <StartButton reason={offlineReason(online, "draft a profile")} onClick={() => draft("load")} loading={drafting === "load"}>
                  Draft a load profile
                </StartButton>
                {drafting && <p role="status" className="mt-2 text-small text-fg-muted">Drafting a load profile from {o.pages.public} public pages…</p>}
              </div>
            )}
          </Card>
        ) : (
          <Card className="px-5 py-1">
            <ul>
              {items.map((p) => (
                <ProfileRow key={p.id} p={p} projectId={projectId} o={o} canRequest={canStart} online={online} />
              ))}
            </ul>
          </Card>
        )}
        {error && <InlineError error={error} />}
      </section>
      <section aria-labelledby="runs-title" className="space-y-2">
        <h3 id="runs-title" className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
          Load tests
        </h3>
        {!runs.data ? (
          <Skeleton className="h-16" />
        ) : runs.data.items.length === 0 ? (
          <p className="text-body text-fg-muted">No load test yet.</p>
        ) : (
          <Table label="Load tests">
            <THead>
              <tr>
                <Th>Test</Th>
                <Th>Profile</Th>
                <Th>Status</Th>
                <Th>Result</Th>
                <Th>Requested · approved by</Th>
                <Th>When</Th>
              </tr>
            </THead>
            <TBody>
              {runs.data.items.map((r) => {
                const worst = r.threshold_results.filter((t) => t.metric !== "error_rate" && t.measured !== null).sort((a, b) => (b.measured ?? 0) - (a.measured ?? 0))[0];
                return (
                  <Tr key={r.id}>
                    <Td rowHeader>
                      <Link href={`/projects/${projectId}/non-functional/load-tests/${r.key}`} className="underline-offset-2 hover:underline">
                        {r.key}
                      </Link>
                    </Td>
                    <Td>
                      {r.profile.key} v{r.profile.version}
                    </Td>
                    <Td>
                      <LoadRunStatusPill run={r} />
                    </Td>
                    <Td>{worst ? `p95 worst: ${msText(worst.measured)} (${worst.path})` : "—"}</Td>
                    <Td>
                      {r.requested_by?.full_name ?? "—"} · {r.approval?.decided_by?.full_name ?? "—"}
                    </Td>
                    <Td>
                      {fmtDateTime(r.created_at)}
                      {r.elapsed_s ? ` · ${durationShort(r.elapsed_s)}` : ""}
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        )}
        <p className="text-small text-fg-muted">
          Limits: this organisation allows up to {lim.vus} virtual users, {lim.rps} requests a second and {durationShort(lim.duration_s)} per load test.
          {o.permissions.can_admin_limits && (
            <>
              {" "}
              <Link href="/settings/load-limits" className="font-medium text-fg-strong underline underline-offset-2">
                Change organisation limits
              </Link>
            </>
          )}
        </p>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ page

export function NonFunctionalPage() {
  const p = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const { role } = useAuth();
  const online = useOnline();
  const viewer = role === "viewer" || role === null;
  const o = useApi<Overview>(`/projects/${p.id}/non-functional`, undefined, {
    refreshInterval: (d) => (d && (d.performance.running || d.performance.waiting.length || isActiveScan(d.accessibility) || isActiveScan(d.security)) ? 3000 : 20000),
  });
  useEffect(() => {
    document.title = `Non-functional · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [p.project?.name]);
  const origin = p.project?.urls?.find((u) => u.role === "primary")?.url ?? p.project?.urls?.[0]?.url;
  const header = (
    <div className="space-y-1">
      <h1 tabIndex={-1} data-page-title className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
        Non-functional
      </h1>
      <p className="text-body text-fg-muted">Speed under load, accessibility and basic security, checked on the pages discovery found{origin ? ` on ${origin.replace(/\/$/, "")}` : ""}.</p>
    </div>
  );
  if (o.error && !o.data)
    return (
      <div className="space-y-4">
        {header}
        <ErrorState error={o.error} title="Couldn't load non-functional results. Try again." onRetry={() => o.mutate()} />
      </div>
    );
  if (!o.data)
    return (
      <div className="space-y-4">
        {header}
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  const d = o.data;
  if (!d.gates.g2)
    return (
      <div className="space-y-4">
        {header}
        <EmptyState title="Not available yet" description={G2_FIRST} action={<LinkButton href={`/projects/${p.id}/discovery`}>Review Gate 2</LinkButton>} />
      </div>
    );
  const tabParam = params.get("tab") as TabId | null;
  const tab: TabId = tabParam && ["performance", "accessibility", "security"].includes(tabParam) ? tabParam : defaultTab(d);
  const setTab = (t: string) => router.replace(`/projects/${p.id}/non-functional?tab=${t}`, { scroll: false });
  const canStart = !viewer && d.permissions.can_start;
  const waitingN = d.performance.waiting.length;
  const tabs = [
    { id: "performance", label: waitingN ? `Performance · ${waitingN} waiting` : "Performance" },
    { id: "accessibility", label: "Accessibility", count: d.accessibility?.open_findings || undefined },
    { id: "security", label: "Security", count: d.security?.open_findings || undefined },
  ];
  return (
    <div className="space-y-5">
      {header}
      <SummaryCards o={d} onOpen={(t) => setTab(t)} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Non-functional checks" idPrefix="nf" />
      <TabPanel id={tab} idPrefix="nf">
        {tab === "accessibility" && <AccessibilityTab o={d} projectId={p.id} canStart={canStart} online={online} refresh={() => o.mutate()} />}
        {tab === "security" && <SecurityTab o={d} projectId={p.id} canStart={canStart} online={online} />}
        {tab === "performance" && <PerformanceTab o={d} projectId={p.id} canStart={canStart} online={online} />}
      </TabPanel>
    </div>
  );
}
