"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CheckCheck, Code2, Download, FileSpreadsheet, Plus, Search, Sparkles, PlayCircle } from "lucide-react";
import { api, buildQuery, downloadFile } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { humanize, timeAgo } from "@/lib/format";
import type { Category, Priority, ProjectDetail, TestCase, TestStep } from "@/lib/types";
import { CASE_STATUSES, CATEGORIES, PRIORITIES } from "@/lib/types";
import {
  Button,
  Card,
  DataState,
  EmptyState,
  InlineError,
  Modal,
  SelectField,
  StatusPill,
  TBody,
  THead,
  Table,
  Td,
  TextArea,
  TextField,
  Th,
  Tr,
  inputClass,
  useToast,
} from "@/components/ui";
import { AiDraftBadge } from "@/components/domain/AiBits";
import { GenerateCasesModal } from "@/components/domain/GenerateCasesModal";
import { StepsEditor } from "@/components/domain/StepsEditor";
import { NewRunModal } from "@/components/domain/NewRunModal";

function NewCaseModal({ projectId, open, onClose, onCreated }: { projectId: string; open: boolean; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ title: "", description: "", preconditions: "", expectedResult: "", category: "FUNCTIONAL" as Category, priority: "MEDIUM" as Priority });
  const [steps, setSteps] = useState<TestStep[]>([{ action: "", expected: "" }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const tc = await api<TestCase>(`/projects/${projectId}/test-cases`, {
        body: { ...f, steps: steps.filter((s) => s.action.trim()).map((s) => ({ action: s.action, ...(s.expected ? { expected: s.expected } : {}) })) },
      });
      toast(`${tc.key} created`);
      setF({ title: "", description: "", preconditions: "", expectedResult: "", category: "FUNCTIONAL", priority: "MEDIUM" });
      setSteps([{ action: "", expected: "" }]);
      onCreated();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="New test case"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="new-case-form" loading={saving}>
            Create test case
          </Button>
        </>
      }
    >
      <form id="new-case-form" onSubmit={submit} className="space-y-4">
        <TextField label="Title" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as Category })} options={CATEGORIES} />
          <SelectField label="Priority" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as Priority })} options={PRIORITIES} />
        </div>
        <TextArea label="Description" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <TextArea label="Preconditions" rows={2} value={f.preconditions} onChange={(e) => setF({ ...f, preconditions: e.target.value })} />
        <StepsEditor steps={steps} onChange={setSteps} />
        <TextArea label="Expected result" rows={2} required value={f.expectedResult} onChange={(e) => setF({ ...f, expectedResult: e.target.value })} />
        <InlineError error={error} />
      </form>
    </Modal>
  );
}

export function TestCasesTab({ project }: { project: ProjectDetail }) {
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [priority, setPriority] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<null | "generate" | "new" | "run">(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const { data, error, isLoading, mutate } = useApi<TestCase[]>(
    `/projects/${project.id}/test-cases`,
    { search: search.trim() || undefined, category, priority, status },
    { keepPreviousData: true },
  );

  const visibleIds = useMemo(() => (data || []).map((c) => c.id), [data]);
  const selectedVisible = visibleIds.filter((id) => selected.has(id));
  const allSelected = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;

  async function bulk(newStatus: "APPROVED" | "READY") {
    setBulkBusy(true);
    try {
      await api("/test-cases/bulk-status", { body: { ids: selectedVisible, status: newStatus } });
      toast(`${selectedVisible.length} test case${selectedVisible.length === 1 ? "" : "s"} ${newStatus === "APPROVED" ? "approved" : "marked ready"}`);
      setSelected(new Set());
      await mutate();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Bulk update failed", "error");
    } finally {
      setBulkBusy(false);
    }
  }

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const filtersActive = !!(search || category || priority || status);

  // Downloads go through fetch so API errors (e.g. draft cases selected) show as a toast, not a raw error page.
  const [downloading, setDownloading] = useState<"csv" | "playwright" | null>(null);
  async function download(kind: "csv" | "playwright") {
    const path = kind === "csv"
      ? `/projects/${project.id}/test-cases/export.csv${buildQuery({ search: search.trim() || undefined, category, priority, status })}`
      : `/projects/${project.id}/playwright-export${buildQuery({ caseIds: selectedVisible.length ? selectedVisible.join(",") : undefined })}`;
    setDownloading(kind);
    try {
      await downloadFile(path, kind === "csv" ? "test-cases.csv" : "playwright-tests.zip");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Download failed", "error");
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">AI-generated cases start as drafts. Approve them before they can be run.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setModal("new")}>
            New test case
          </Button>
          <Button icon={<Sparkles className="h-4 w-4" aria-hidden />} onClick={() => setModal("generate")}>
            Generate with AI
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-surface px-4 py-3">
        <Button variant="secondary" size="sm" loading={downloading === "csv"} icon={<FileSpreadsheet className="h-4 w-4" aria-hidden />} onClick={() => download("csv")}>
          Export CSV
          {filtersActive && <span className="sr-only"> (current filters applied)</span>}
        </Button>
        <Button variant="secondary" size="sm" loading={downloading === "playwright"} icon={<Download className="h-4 w-4" aria-hidden />} onClick={() => download("playwright")}>
          {selectedVisible.length > 0
            ? `Download Playwright project (${selectedVisible.length} selected)`
            : "Download Playwright project"}
        </Button>
        <p className="text-xs text-fg-muted">
          Standard Playwright Test project — run with <code className="rounded bg-elevated px-1 py-0.5 font-mono text-fg">npx playwright test</code>
          <span className="text-fg-subtle">
            {" "}
            · {selectedVisible.length > 0 ? "includes the selected cases" : "includes all approved and ready cases"}
          </span>
        </p>
      </div>
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <div className="relative min-w-[14rem] flex-1">
            <label htmlFor="tc-search" className="sr-only">
              Search test cases
            </label>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" aria-hidden />
            <input id="tc-search" type="search" className={`${inputClass} pl-9`} placeholder="Search by key or title" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <SelectField label="Category" hideLabel value={category} onChange={(e) => setCategory(e.target.value)} placeholder="All categories" options={CATEGORIES} wrapClassName="w-44" />
          <SelectField label="Priority" hideLabel value={priority} onChange={(e) => setPriority(e.target.value)} placeholder="All priorities" options={PRIORITIES} wrapClassName="w-40" />
          <SelectField label="Status" hideLabel value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All statuses" options={CASE_STATUSES} wrapClassName="w-40" />
        </div>
        {selectedVisible.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-accent/30 bg-accent-soft/70 px-4 py-2.5" role="region" aria-label="Bulk actions">
            <span className="text-sm font-medium text-fg-strong">{selectedVisible.length} selected</span>
            <Button size="sm" variant="success" icon={<CheckCheck className="h-4 w-4" aria-hidden />} loading={bulkBusy} onClick={() => bulk("APPROVED")}>
              Approve
            </Button>
            <Button size="sm" variant="secondary" loading={bulkBusy} onClick={() => bulk("READY")}>
              Mark ready
            </Button>
            <Button size="sm" variant="secondary" icon={<PlayCircle className="h-4 w-4" aria-hidden />} onClick={() => setModal("run")}>
              Run selected
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        )}
        <DataState
          data={data}
          error={error}
          isLoading={isLoading}
          onRetry={() => mutate()}
          empty={
            <EmptyState
              title={filtersActive ? "No test cases match these filters" : "No test cases yet"}
              description={filtersActive ? undefined : "Generate drafts with AI or write one by hand."}
              action={!filtersActive && <Button onClick={() => setModal("generate")}>Generate with AI</Button>}
            />
          }
        >
          {(cases) => (
            <Table label="Test cases">
              <THead>
                <tr>
                  <Th className="w-10">
                    <input
                      type="checkbox"
                      aria-label="Select all test cases"
                      className="h-4 w-4 accent-accent"
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(visibleIds))}
                    />
                  </Th>
                  <Th>Key</Th>
                  <Th>Title</Th>
                  <Th>Category</Th>
                  <Th>Priority</Th>
                  <Th>Status</Th>
                  <Th>Last result</Th>
                  <Th>Updated</Th>
                </tr>
              </THead>
              <TBody>
                {cases.map((c) => (
                  <Tr key={c.id} className={selected.has(c.id) ? "bg-accent-soft/40" : ""}>
                    <Td>
                      <input type="checkbox" aria-label={`Select ${c.key}`} className="h-4 w-4 accent-accent" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                    </Td>
                    <Td className="font-mono text-xs text-fg-muted">{c.key}</Td>
                    <Td className="min-w-[16rem]">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/test-cases/${c.id}`} className="font-medium text-fg-strong hover:underline">
                          {c.title}
                        </Link>
                        {c.hasScript && <Code2 className="h-3.5 w-3.5 text-fg-muted" aria-label="Has automation script" />}
                      </div>
                      {c.aiGenerated && c.status === "DRAFT" && <AiDraftBadge className="mt-1" />}
                    </Td>
                    <Td className="whitespace-nowrap text-fg">{humanize(c.category)}</Td>
                    <Td>
                      <StatusPill status={c.priority} dot={false} />
                    </Td>
                    <Td>
                      <StatusPill status={c.status} />
                    </Td>
                    <Td>{c.lastResult ? <StatusPill status={c.lastResult} /> : <span className="text-fg-muted">—</span>}</Td>
                    <Td className="whitespace-nowrap text-fg-muted">{timeAgo(c.updatedAt)}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </DataState>
      </Card>
      <GenerateCasesModal open={modal === "generate"} onClose={() => setModal(null)} projectId={project.id} onGenerated={() => mutate()} />
      <NewCaseModal open={modal === "new"} onClose={() => setModal(null)} projectId={project.id} onCreated={() => mutate()} />
      <NewRunModal open={modal === "run"} onClose={() => setModal(null)} projectId={project.id} preselectedCaseIds={selectedVisible} />
    </div>
  );
}
