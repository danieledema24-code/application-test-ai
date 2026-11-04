"use client";

import Link from "next/link";
import { useState } from "react";
import { Plus, Search } from "lucide-react";
import { useApi } from "@/lib/hooks";
import { personName, timeAgo } from "@/lib/format";
import type { Defect } from "@/lib/types";
import { DEFECT_STATUSES, ENV_NAMES, SEVERITIES } from "@/lib/types";
import { Button, Card, DataState, EmptyState, SelectField, StatusPill, TBody, THead, Table, Td, TextField, Th, Tr, inputClass } from "@/components/ui";
import { ProjectSelect } from "./ProjectSelect";
import { DefectFormModal } from "./DefectFormModal";

export function DefectsList({ projectId: fixedProjectId }: { projectId?: string }) {
  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState("");
  const [status, setStatus] = useState("");
  const [environment, setEnvironment] = useState("");
  const [projectId, setProjectId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [creating, setCreating] = useState(false);
  const pid = fixedProjectId || projectId;
  const { data, error, isLoading, mutate } = useApi<Defect[]>(
    "/defects",
    { projectId: pid, severity, status, environment, from, to, search: search.trim() || undefined },
    { keepPreviousData: true },
  );
  const filtered = !!(search || severity || status || environment || projectId || from || to);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setCreating(true)}>
          New defect
        </Button>
      </div>
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <div className="relative min-w-[14rem] flex-1">
            <label htmlFor="defect-search" className="mb-1 block text-xs font-medium text-fg">
              Search
            </label>
            <Search className="pointer-events-none absolute bottom-2.5 left-3 h-4 w-4 text-fg-muted" aria-hidden />
            <input id="defect-search" type="search" className={`${inputClass} pl-9`} placeholder="Key or title" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {!fixedProjectId && <ProjectSelect value={projectId} onChange={setProjectId} placeholder="All projects" wrapClassName="w-48 [&_label]:text-xs" />}
          <SelectField label="Severity" wrapClassName="w-36 [&_label]:text-xs" value={severity} onChange={(e) => setSeverity(e.target.value)} placeholder="All" options={SEVERITIES} />
          <SelectField label="Status" wrapClassName="w-40 [&_label]:text-xs" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All" options={DEFECT_STATUSES} />
          <SelectField label="Environment" wrapClassName="w-40 [&_label]:text-xs" value={environment} onChange={(e) => setEnvironment(e.target.value)} placeholder="All" options={ENV_NAMES} />
          <TextField label="From" type="date" wrapClassName="w-40 [&_label]:text-xs" value={from} onChange={(e) => setFrom(e.target.value)} />
          <TextField label="To" type="date" wrapClassName="w-40 [&_label]:text-xs" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <DataState
          data={data}
          error={error}
          isLoading={isLoading}
          onRetry={() => mutate()}
          empty={<EmptyState title={filtered ? "No defects match these filters" : "No defects logged"} description={filtered ? undefined : "Defects you raise from failed results appear here."} />}
        >
          {(defects) => (
            <Table label="Defects">
              <THead>
                <tr>
                  <Th>Key</Th>
                  <Th>Title</Th>
                  {!fixedProjectId && <Th>Project</Th>}
                  <Th>Severity</Th>
                  <Th>Priority</Th>
                  <Th>Status</Th>
                  <Th>Environment</Th>
                  <Th>Raised</Th>
                </tr>
              </THead>
              <TBody>
                {defects.map((d) => (
                  <Tr key={d.id}>
                    <Td className="font-mono text-xs text-fg-muted">{d.key}</Td>
                    <Td>
                      <Link href={`/defects/${d.id}`} className="font-medium text-accent hover:underline">
                        {d.title}
                      </Link>
                      {d.testCaseKey && <p className="text-xs text-fg-muted">from {d.testCaseKey}</p>}
                    </Td>
                    {!fixedProjectId && <Td className="text-fg">{d.projectName}</Td>}
                    <Td>
                      <StatusPill status={d.severity} />
                    </Td>
                    <Td>
                      <StatusPill status={d.priority} dot={false} />
                    </Td>
                    <Td>
                      <StatusPill status={d.status} />
                    </Td>
                    <Td>{d.environmentName ? <StatusPill status={d.environmentName} dot={false} /> : "—"}</Td>
                    <Td className="whitespace-nowrap text-fg-muted">
                      {personName(d.createdBy)} · {timeAgo(d.createdAt)}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </DataState>
      </Card>
      <DefectFormModal open={creating} onClose={() => setCreating(false)} projectId={fixedProjectId} />
    </div>
  );
}
