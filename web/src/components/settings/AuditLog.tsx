"use client";

// Audit log (design P5 §13.3): who did what in this organisation. Read-only; the export is itself recorded.

import { useEffect, useRef, useState } from "react";
import { api, ApiError, downloadFile } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import type { Page, ProjectSummary } from "@/lib/contract";
import { ADMIN_ONLY_PAGE, auditQuery, exportText, NO_FILTERS, shortWhen, whoText, type AuditEntry, type AuditFilters, type AuditPage } from "@/lib/hardening";
import { Button, EmptyState, ErrorState, InlineError, SelectField, Skeleton, Table, TBody, Td, TextField, Th, THead, Tooltip, useToast } from "@/components/ui";

export function AuditLog() {
  const { organisation } = useAuth();
  const toast = useToast();
  const [f, setF] = useState<AuditFilters>(NO_FILTERS);
  const base = organisation ? `/organisations/${organisation.id}/audit-log` : null;
  const query = auditQuery(f);
  const q = useApi<AuditPage>(base, query, { shouldRetryOnError: false });
  const projects = useApi<Page<ProjectSummary>>("/projects", { limit: 50 });
  const [more, setMore] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "more" | "csv" | "json">("");
  const [error, setError] = useState<unknown>(null);
  const firstNew = useRef<HTMLTableRowElement | null>(null);
  const [firstNewId, setFirstNewId] = useState<string | null>(null);
  const key = JSON.stringify(query);
  useEffect(() => {
    setMore([]);
    setCursor(null);
    setFirstNewId(null);
  }, [key]);
  // [Show 50 more] moves focus to the first new row (design P5 §13.3).
  useEffect(() => {
    if (firstNewId) firstNew.current?.focus();
  }, [firstNewId]);
  if (q.error && !q.data) {
    if (q.error instanceof ApiError && q.error.status === 403) return <p className="text-body text-fg">{ADMIN_ONLY_PAGE}</p>;
    return <ErrorState error={q.error} onRetry={() => q.mutate()} />;
  }
  const d = q.data;
  const items = d ? [...d.items, ...more] : [];
  const next = more.length ? cursor : (d?.next_cursor ?? null);
  const ex = exportText(d?.total ?? 0, d?.export_limit ?? 100000);
  const filtered = Object.keys(query).length > 0;

  async function loadMore() {
    if (!base || !next) return;
    setBusy("more");
    try {
      const r = await api<AuditPage>(base, { query: { ...query, cursor: next } });
      setMore((m) => [...m, ...r.items]);
      setFirstNewId(r.items[0]?.id ?? null);
      setCursor(r.next_cursor);
    } catch (e) {
      setError(e);
    } finally {
      setBusy("");
    }
  }
  async function exportAs(format: "csv" | "json") {
    if (!base || ex.disabled) return;
    setBusy(format);
    setError(null);
    try {
      const qs = new URLSearchParams({ ...query, format }).toString();
      await downloadFile(`${base}/export?${qs}`, `audit-log.${format}`);
      toast(ex.toast, "success");
      void q.mutate();
    } catch (e) {
      setError(e);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-h2 font-semibold text-fg-strong">Audit log</h2>
          <p className="text-body text-fg">Who did what in this organisation. Entries can&apos;t be edited or deleted.</p>
        </div>
        <div className="flex gap-2" role="group" aria-label="Export">
          {(["csv", "json"] as const).map((fmt) => (
            <Button key={fmt} variant="secondary" loading={busy === fmt} aria-disabled={ex.disabled ? true : undefined} aria-describedby={ex.disabled ? "audit-export-why" : undefined} onClick={() => void exportAs(fmt)}>
              Export {fmt.toUpperCase()}
            </Button>
          ))}
        </div>
      </div>
      {ex.disabled && (
        <p id="audit-export-why" className="text-small text-fg-muted">
          {ex.disabled}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <SelectField label="What" value={f.group} onChange={(e) => setF({ ...f, group: e.target.value })} placeholder="Any action" options={(d?.groups ?? []).map((g) => ({ value: g, label: g }))} />
        <SelectField label="Project" value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })} placeholder="Any" options={(projects.data?.items ?? []).map((p) => ({ value: p.id, label: p.name }))} />
        <TextField label="From" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <TextField label="To" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        {filtered && (
          <Button variant="ghost" onClick={() => setF(NO_FILTERS)}>
            Clear filters
          </Button>
        )}
      </div>
      {!d ? (
        <Skeleton className="h-64" />
      ) : d.total === 0 ? (
        <EmptyState title="No entries match these filters." action={filtered ? <Button variant="secondary" onClick={() => setF(NO_FILTERS)}>Clear filters</Button> : undefined} />
      ) : (
        <>
          <p className="text-small text-fg-muted" aria-live="polite">
            {d.total.toLocaleString("en-GB")} {d.total === 1 ? "entry matches" : "entries match"} · newest first
          </p>
          <Table label="Audit log">
            <THead>
              <tr>
                <Th>When</Th>
                <Th>Who</Th>
                <Th>What</Th>
                <Th>Project</Th>
                <Th>Details</Th>
              </tr>
            </THead>
            <TBody>
              {items.map((e) => (
                <tr key={e.id} ref={e.id === firstNewId ? firstNew : undefined} tabIndex={e.id === firstNewId ? -1 : undefined} className="border-t border-line focus:outline-2 focus:outline-focus">
                  <Td className="whitespace-nowrap">
                    <time dateTime={e.at}>{shortWhen(e.at)}</time>
                  </Td>
                  <Td>{whoText(e)}</Td>
                  <Td>
                    <Tooltip content={e.action}>
                      <span>{e.label}</span>
                    </Tooltip>
                  </Td>
                  <Td>{e.project?.name ?? "—"}</Td>
                  <Td>{e.details}</Td>
                </tr>
              ))}
            </TBody>
          </Table>
          {next && (
            <Button variant="secondary" loading={busy === "more"} onClick={() => void loadMore()}>
              Show 50 more
            </Button>
          )}
        </>
      )}
      <InlineError error={error} />
    </div>
  );
}
