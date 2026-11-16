"use client";

// Application Discovery › Changes (design P6 §6.1, §6.2): the latest change set, compare any two finished scans,
// the scan history and every change set. Project-wide: it ignores the Discovery `?scan=` selector.

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useSWRConfig } from "swr";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { g2EverApproved, compareError, countsLine, existingPair, impactLine, scanKindLabel, scanOptionLabel, setStatusLabel, type ChangeSet } from "@/lib/change";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { Button, Callout, Card, EmptyState, ErrorState, LinkButton, SelectField, Skeleton, StatusPill, Table, TBody, Td, Th, THead, Tr, useToast } from "@/components/ui";
import { GeneratedByLabel } from "@/components/domain/ObservationLabel";
import { useProject } from "@/components/workspace/ProjectContext";
import { useChangeSet, useChangeSets, useScanRows, type ScanRow } from "./hooks";

const link = "font-medium text-navy-700 underline underline-offset-2";
const pair = (s: ChangeSet) => `Scan ${s.base.number} → Scan ${s.target.number}`;

export function changeSetHref(projectId: string, key: string) {
  return `/projects/${projectId}/discovery/changes/${key}`;
}

export function ChangeSetStatusPill({ set }: { set: Pick<ChangeSet, "status"> }) {
  const tone = set.status === "completed" ? "green" : set.status === "failed" ? "red" : "blue";
  return <StatusPill status={set.status === "completed" ? "completed" : set.status === "failed" ? "failed" : "running"} label={setStatusLabel(set.status)} tone={tone} />;
}

function significanceShort(s: ChangeSet): string {
  const by = s.summary.by_significance;
  const total = s.summary.total ?? 0;
  if (!by) return String(total);
  const bits = (["structural", "behavioural", "cosmetic"] as const).filter((k) => by[k]).map((k) => `${by[k]} ${k}`);
  return bits.length ? `${total} (${bits.join(", ")})` : String(total);
}

export function ChangesTab() {
  const p = useProject();
  const { role } = useAuth();
  const member = role !== "viewer" && role !== null;
  const sets = useChangeSets(p.id);
  const { scans, rows, comparable, baseline } = useScanRows(p.id);
  const offline = p.streamState === "offline";
  const g2 = g2EverApproved(p.workflow) === true;

  if ((sets.error && !sets.data) || (scans.error && !scans.data))
    return <ErrorState error={sets.error ?? scans.error} title="Couldn’t load changes." message="Try again." onRetry={() => (void sets.mutate(), void scans.mutate())} />;
  if (!sets.data || !scans.data)
    return (
      <div className="space-y-4" aria-hidden>
        <Skeleton className="h-28" />
        <Skeleton className="h-40" />
      </div>
    );

  const list = sets.data.items;
  const canCompare = member && sets.data.can_compare;
  const rescanButton = canCompare && g2 && (
    <Button
      onClick={p.openRescan}
      aria-disabled={offline || undefined}
      disabled={offline}
      title={offline ? "You're offline. Reconnect to rescan." : undefined}
    >
      Rescan and compare…
    </Button>
  );

  const heading = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-h2 font-semibold text-fg-strong">Changes</h2>
        <p className="mt-1 text-body text-fg">Compare what discovery saw in two scans. Nothing from earlier scans is changed or deleted.</p>
      </div>
      {rescanButton}
    </div>
  );

  if (!g2 && list.length === 0)
    return (
      <div className="space-y-6">
        {heading}
        <Card className="p-6">
          <EmptyState
            title="Approve Gate 2 first"
            description="Changes are compared with the scan approved at Gate 2. Approve Gate 2 first."
            action={member ? <LinkButton href={`/projects/${p.id}/discovery?view=summary#gate-review`}>Review Gate 2</LinkButton> : undefined}
          />
        </Card>
      </div>
    );

  const latestScan = rows[0];
  const rescanRunning = latestScan && latestScan.is_rescan && ["queued", "running", "paused"].includes(latestScan.status);
  const latest = list[0];

  return (
    <div className="space-y-6">
      {heading}
      {rescanRunning && (
        <Callout tone="info" actions={<LinkButton href={`/projects/${p.id}/discovery?view=live`} variant="secondary">Watch live</LinkButton>}>
          Scan {latestScan.n} is running. When it finishes, it’s compared with Scan {latestScan.baseline_number ?? baseline?.n}.
        </Callout>
      )}
      {comparable.length < 2 && list.length === 0 ? (
        <Card className="p-6">
          <EmptyState
            title="Nothing to compare yet"
            description="Nothing to compare yet. When your site changes, rescan it to see exactly what changed and what that affects."
            action={rescanButton || undefined}
          />
        </Card>
      ) : (
        <>
          {latest && <LatestCard set={latest} member={canCompare} />}
          {canCompare && comparable.length >= 2 && <ComparePicker scans={comparable} sets={list} offline={offline} />}
        </>
      )}
      <ScanHistory rows={rows} sets={list} />
      {list.length > 0 && <ChangeSetList sets={list} />}
    </div>
  );
}

function LatestCard({ set, member }: { set: ChangeSet; member: boolean }) {
  const p = useProject();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  async function retry() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ change_set: ChangeSet }>(`/projects/${p.id}/changes`, { body: { from_scan_id: set.base.id, to_scan_id: set.target.id } });
      router.push(changeSetHref(p.id, r.change_set.key));
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (set.status === "failed")
    return (
      <Callout
        tone="danger"
        actions={
          member ? (
            <Button variant="secondary" onClick={() => void retry()} loading={busy}>
              Try again
            </Button>
          ) : undefined
        }
      >
        Couldn’t compare Scan {set.base.number} with Scan {set.target.number}: {(set.error ?? "an unexpected error").replace(/\.$/, "")}. Both scans are unchanged.
        {err && <span className="mt-1 block">{err}</span>}
      </Callout>
    );
  if (set.status !== "completed")
    return (
      <Card className="p-5">
        <h3 className="text-h3 font-semibold text-fg-strong">
          Comparing Scan {set.target.number} with Scan {set.base.number}…
        </h3>
        <ol className="mt-3 space-y-1 text-small text-fg">
          <li className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-fg-muted motion-reduce:animate-none" aria-hidden />
            <span>1 Comparing pages, elements, forms and navigation</span>
          </li>
        </ol>
      </Card>
    );
  return (
    <Card className="p-5">
      <h3 className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">Latest change</h3>
      <p className="mt-2 text-body font-semibold text-fg-strong">
        {set.key} · {pair(set)}
        {set.source === "rescan" ? " (rescan)" : ""} · {fmtDateTime(set.finished_at ?? set.created_at)}
      </p>
      <p className="mt-1 text-body text-fg">{countsLine(set)}</p>
      {impactLine(set) && <p className="mt-1 text-body text-fg">{impactLine(set)}</p>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <GeneratedByLabel generatedBy={set.generated_by} />
        <LinkButton href={changeSetHref(p.id, set.key)} variant="secondary">
          Open {set.key}
        </LinkButton>
      </div>
    </Card>
  );
}

/** Compare two scans (design P6 §6.1): members only; To must be later; an existing pair opens instead. */
export function ComparePicker({ scans, sets, offline }: { scans: ScanRow[]; sets: ChangeSet[]; offline: boolean }) {
  const p = useProject();
  const router = useRouter();
  const toast = useToast();
  const baseline = scans.find((s) => s.g2_approved);
  const [from, setFrom] = useState<number | null>(baseline?.n ?? scans[1]?.n ?? null);
  const [to, setTo] = useState<number | null>(scans[0]?.n ?? null);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const watched = useChangeSet(p.id, pending);
  const { mutate } = useSWRConfig();
  const existing = existingPair(sets, from, to);
  const label = (s: ScanRow) => scanOptionLabel({ ...s, number: s.n }, fmtDate);
  const options = scans.map((s) => ({ value: String(s.n), label: label(s) }));

  useEffect(() => {
    const s = pending ? watched.data : undefined;
    if (!s || s.key !== pending) return;
    if (s.status === "completed") {
      setPending(null);
      toast(`${s.key} ready: ${s.summary.total ?? 0} change${s.summary.total === 1 ? "" : "s"}.`);
      router.push(changeSetHref(p.id, s.key));
    } else if (s.status === "failed") {
      setPending(null);
      setFailure(`Couldn’t compare Scan ${s.base.number} with Scan ${s.target.number}: ${(s.error ?? "an unexpected error").replace(/\.$/, "")}. Both scans are unchanged.`);
    }
  }, [pending, watched.data, toast, router, p.id]);

  async function compare() {
    const e = compareError(from, to);
    setError(e);
    setFailure(null);
    if (e) return document.getElementById("compare-to")?.focus();
    if (existing) return router.push(changeSetHref(p.id, existing.key));
    const a = scans.find((s) => s.n === from)!;
    const b = scans.find((s) => s.n === to)!;
    setBusy(true);
    try {
      const r = await api<{ change_set: ChangeSet; created: boolean }>(`/projects/${p.id}/changes`, { body: { from_scan_id: a.id, to_scan_id: b.id } });
      if (!r.created) router.push(changeSetHref(p.id, r.change_set.key));
      else {
        setPending(r.change_set.key);
        void mutate((k) => typeof k === "string" && k.startsWith(`/projects/${p.id}/changes`));
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && /later scan/.test(err.message)) setError(err.message);
      else setFailure(`Couldn’t compare Scan ${from} with Scan ${to}: ${errorMessage(err).replace(/\.$/, "")}. Both scans are unchanged.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="compare-heading" className="space-y-3">
      <h3 id="compare-heading" className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
        Compare two scans
      </h3>
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <SelectField label="From" value={from === null ? "" : String(from)} onChange={(e) => (setFrom(Number(e.target.value)), setError(null))} options={options} wrapClassName="w-full md:w-72" />
        <SelectField
          id="compare-to"
          label="To"
          value={to === null ? "" : String(to)}
          onChange={(e) => (setTo(Number(e.target.value)), setError(null))}
          options={options}
          error={error ?? undefined}
          wrapClassName="w-full md:w-72"
        />
        <div className={error ? "md:mb-6" : ""}>
          {existing ? (
            <LinkButton href={changeSetHref(p.id, existing.key)} variant="secondary" className="w-full md:w-auto">
              Open {existing.key}
            </LinkButton>
          ) : (
            <Button
              onClick={() => void compare()}
              loading={busy}
              disabled={!!pending || offline}
              aria-disabled={offline || undefined}
              title={offline ? "You're offline. Reconnect to compare scans." : undefined}
              className="w-full md:w-auto"
            >
              Compare
            </Button>
          )}
        </div>
      </div>
      <div role="status" aria-live="polite">
        {pending && (
          <span className="inline-flex items-center gap-2 text-body text-fg-muted">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
            Comparing Scan {from} with Scan {to}…
          </span>
        )}
      </div>
      {failure && (
        <Callout tone="danger" role="alert">
          {failure}
        </Callout>
      )}
    </section>
  );
}

function ScanHistory({ rows, sets }: { rows: ScanRow[]; sets: ChangeSet[] }) {
  const p = useProject();
  const first = rows.length ? rows[rows.length - 1].n : 1;
  const comparedIn = (n: number) => sets.filter((s) => s.status !== "failed" && (s.base.number === n || s.target.number === n)).map((s) => s.key);
  const gate2 = (s: ScanRow) => (s.g2_approved ? (s.id === rows.find((x) => x.g2_approved && ["completed", "partial"].includes(x.status))?.id ? "Approved (baseline)" : "Approved") : "—");
  const scanHref = (n: number) => `/projects/${p.id}/discovery?view=summary&scan=${n}`;
  const keys = (n: number) => {
    const k = comparedIn(n);
    return k.length ? (
      <span className="flex flex-wrap gap-x-2">
        {k.map((key) => (
          <Link key={key} href={changeSetHref(p.id, key)} className={link}>
            {key}
          </Link>
        ))}
      </span>
    ) : (
      "—"
    );
  };
  return (
    <section aria-labelledby="scans-heading" className="space-y-3">
      <h3 id="scans-heading" className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
        Scans
      </h3>
      <div className="hidden md:block">
        <Table label="Scans">
          <THead>
            <tr>
              <Th>Scan</Th>
              <Th>Started</Th>
              <Th>Kind</Th>
              <Th>Pages</Th>
              <Th>Gate 2</Th>
              <Th>Compared in</Th>
            </tr>
          </THead>
          <TBody>
            {rows.map((s) => (
              <Tr key={s.id}>
                <Td rowHeader>
                  <Link href={scanHref(s.n)} className={link}>
                    Scan {s.n}
                  </Link>
                  {s.status === "partial" ? " (partial)" : ""}
                </Td>
                <Td>{fmtDateTime(s.started_at ?? s.created_at)}</Td>
                <Td>{scanKindLabel({ number: s.n, is_rescan: s.is_rescan, baseline_number: s.baseline_number }, first)}</Td>
                <Td className="tabular-nums">{s.pages_found}</Td>
                <Td>{gate2(s)}</Td>
                <Td>{keys(s.n)}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </div>
      <ul className="space-y-2 md:hidden" aria-label="Scans">
        {rows.map((s) => (
          <li key={s.id} className="rounded-lg bg-surface p-3 text-small ring-1 ring-line">
            <Link href={scanHref(s.n)} className={link}>
              Scan {s.n}
            </Link>{" "}
            · {fmtDate(s.started_at ?? s.created_at)} · {scanKindLabel({ number: s.n, is_rescan: s.is_rescan, baseline_number: s.baseline_number }, first)} · {s.pages_found} pages
            {s.g2_approved ? ` · ${gate2(s)}` : ""} · {keys(s.n)}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ChangeSetList({ sets }: { sets: ChangeSet[] }) {
  const p = useProject();
  const sorted = useMemo(() => [...sets], [sets]);
  return (
    <section aria-labelledby="sets-heading" className="space-y-3">
      <h3 id="sets-heading" className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
        Change sets
      </h3>
      <div className="hidden md:block">
        <Table label="Change sets">
          <THead>
            <tr>
              <Th>Change set</Th>
              <Th>Compared</Th>
              <Th>Changes</Th>
              <Th>Status</Th>
              <Th>Created</Th>
            </tr>
          </THead>
          <TBody>
            {sorted.map((s) => (
              <Tr key={s.id}>
                <Td rowHeader>
                  <Link href={changeSetHref(p.id, s.key)} className={link}>
                    {s.key}
                  </Link>
                </Td>
                <Td>{pair(s)}</Td>
                <Td>{s.status === "completed" ? significanceShort(s) : "—"}</Td>
                <Td>
                  <ChangeSetStatusPill set={s} />
                </Td>
                <Td>{fmtDateTime(s.created_at)}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </div>
      <ul className="space-y-2 md:hidden" aria-label="Change sets">
        {sorted.map((s) => (
          <li key={s.id} className="rounded-lg bg-surface p-3 text-small ring-1 ring-line">
            <Link href={changeSetHref(p.id, s.key)} className={link}>
              {s.key}
            </Link>{" "}
            · {pair(s)} · {s.status === "completed" ? `${significanceShort(s)} changes` : setStatusLabel(s.status)} · {fmtDate(s.created_at)}
          </li>
        ))}
      </ul>
    </section>
  );
}
