"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useApi } from "@/lib/hooks";
import type { TestRun } from "@/lib/types";
import { EXEC_TYPES, RUN_STATUSES } from "@/lib/types";
import { Button, Card, DataState, EmptyState, SelectField } from "@/components/ui";
import { ProjectSelect } from "./ProjectSelect";
import { RunsTable } from "./RunsTable";
import { NewRunModal } from "./NewRunModal";

export function RunsList({ projectId: fixedProjectId }: { projectId?: string }) {
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [open, setOpen] = useState(false);
  const pid = fixedProjectId || projectId;
  const { data, error, isLoading, mutate } = useApi<TestRun[]>(
    "/test-runs",
    { projectId: pid, status, type, limit: 100 },
    {
      keepPreviousData: true,
      refreshInterval: (d) => (d?.some((r) => r.status === "QUEUED" || r.status === "RUNNING") ? 5000 : 0),
    },
  );
  const filtered = !!(projectId || status || type);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          {!fixedProjectId && <ProjectSelect value={projectId} onChange={setProjectId} placeholder="All projects" wrapClassName="w-52" />}
          <SelectField label="Status" wrapClassName="w-40" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All statuses" options={RUN_STATUSES} />
          <SelectField label="Type" wrapClassName="w-40" value={type} onChange={(e) => setType(e.target.value)} placeholder="All types" options={EXEC_TYPES} />
        </div>
        <Button icon={<Plus className="h-4 w-4" aria-hidden />} onClick={() => setOpen(true)}>
          New run
        </Button>
      </div>
      <Card>
        <DataState
          data={data}
          error={error}
          isLoading={isLoading}
          onRetry={() => mutate()}
          empty={<EmptyState title={filtered ? "No runs match these filters" : "No test runs yet"} action={!filtered && <Button onClick={() => setOpen(true)}>New run</Button>} />}
        >
          {(runs) => <RunsTable runs={runs} showProject={!fixedProjectId} />}
        </DataState>
      </Card>
      <NewRunModal open={open} onClose={() => setOpen(false)} projectId={fixedProjectId} />
    </div>
  );
}
