"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { fmtPct, timeAgo } from "@/lib/format";
import type { TestRun } from "@/lib/types";
import { Button, EmptyState, InlineError, Modal, SelectField, StatusPill } from "@/components/ui";

type Compare = { a: TestRun; b: TestRun; changes: { testCaseKey: string; title: string; from: string | null; to: string | null }[] };

export function CompareModal({ open, onClose, run }: { open: boolean; onClose: () => void; run: TestRun }) {
  const [other, setOther] = useState("");
  const [result, setResult] = useState<Compare | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { data: runs } = useApi<TestRun[]>(open ? "/test-runs" : null, { projectId: run.projectId, limit: 50 });
  const candidates = (runs || []).filter((r) => r.id !== run.id);

  async function compare(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      // a = the other (baseline), b = this run, so "from → to" reads chronologically when the baseline is older.
      setResult(await api<Compare>("/test-runs/compare", { query: { a: other, b: run.id } }));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setResult(null);
      }}
      size="lg"
      title={`Compare ${run.key} with another run`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" form="compare-form" loading={loading} disabled={!other}>
            Compare
          </Button>
        </>
      }
    >
      <form id="compare-form" onSubmit={compare} className="space-y-4">
        <SelectField
          label="Baseline run"
          value={other}
          onChange={(e) => {
            setOther(e.target.value);
            setResult(null);
          }}
          placeholder={candidates.length ? "Select a run" : "No other runs in this project"}
          options={candidates.map((r) => ({ value: r.id, label: `${r.key} · ${r.name} · ${r.status.toLowerCase()} · ${timeAgo(r.createdAt)}` }))}
        />
        <InlineError error={error} />
      </form>
      {result && (
        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-sm">
            {[result.a, null, result.b].map((r, i) =>
              r ? (
                <div key={r.id} className="rounded-lg border border-line p-3">
                  <p className="font-medium text-fg-strong">
                    {r.key} <StatusPill status={r.status} className="ml-1" />
                  </p>
                  <p className="text-xs text-fg-muted">
                    Pass rate {fmtPct(r.summary.passRate)} · {r.summary.passed}/{r.summary.total} passed
                  </p>
                </div>
              ) : (
                <ArrowRight key={i} className="h-4 w-4 text-fg-muted" aria-hidden />
              ),
            )}
          </div>
          {result.changes.length === 0 ? (
            <EmptyState title="No status changes" description="Every common test case has the same result in both runs." />
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {result.changes.map((c) => (
                <li key={c.testCaseKey} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                  <span className="font-mono text-xs text-fg-muted">{c.testCaseKey}</span>
                  <span className="min-w-0 flex-1 truncate text-fg-strong">{c.title}</span>
                  {c.from ? <StatusPill status={c.from} /> : <span className="text-xs text-fg-muted">not in run</span>}
                  <ArrowRight className="h-3.5 w-3.5 text-fg-muted" aria-label="changed to" />
                  {c.to ? <StatusPill status={c.to} /> : <span className="text-xs text-fg-muted">not in run</span>}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-fg-muted">
            <Link href={`/test-runs/${result.a.id}`} className="text-fg-strong hover:underline">
              Open baseline run
            </Link>
          </p>
        </div>
      )}
    </Modal>
  );
}
