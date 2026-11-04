"use client";

import Link from "next/link";
import { useState } from "react";
import { FolderPlus, Search } from "lucide-react";
import { useApi } from "@/lib/hooks";
import { fmtPct, timeAgo } from "@/lib/format";
import type { Project } from "@/lib/types";
import { Badge, Button, Card, DataState, EmptyState, PageHeader, StatusPill, TBody, THead, Table, Td, Th, Tr, inputClass } from "@/components/ui";
import { NewProjectModal } from "@/components/domain/NewProjectModal";

export default function ProjectsPage() {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const { data, error, isLoading, mutate } = useApi<Project[]>("/projects", { search: search.trim() || undefined }, { keepPreviousData: true });

  return (
    <>
      <PageHeader
        title="Projects"
        description="Each project is one application under test."
        actions={
          <Button icon={<FolderPlus className="h-4 w-4" aria-hidden />} onClick={() => setOpen(true)}>
            New project
          </Button>
        }
      />
      <Card>
        <div className="border-b border-slate-100 p-4">
          <div className="relative max-w-sm">
            <label htmlFor="project-search" className="sr-only">
              Search projects
            </label>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" aria-hidden />
            <input id="project-search" type="search" className={`${inputClass} pl-9`} placeholder="Search projects" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <DataState
          data={data}
          error={error}
          isLoading={isLoading}
          onRetry={() => mutate()}
          empty={
            <EmptyState
              title={search ? "No matching projects" : "No projects yet"}
              description={search ? "Try a different search." : "Create a project to start testing an application."}
              action={!search && <Button onClick={() => setOpen(true)}>New project</Button>}
            />
          }
        >
          {(projects) => (
            <Table label="Projects">
              <THead>
                <tr>
                  <Th>Name</Th>
                  <Th>Type</Th>
                  <Th>Environments</Th>
                  <Th className="text-right">Test cases</Th>
                  <Th>Last run</Th>
                  <Th>Latest status</Th>
                  <Th className="text-right">Pass rate</Th>
                  <Th className="text-right">Open defects</Th>
                </tr>
              </THead>
              <TBody>
                {projects.map((p) => (
                  <Tr key={p.id}>
                    <Td>
                      <Link href={`/projects/${p.id}`} className="font-medium text-blue-800 hover:underline">
                        {p.name}
                      </Link>
                      <p className="max-w-xs truncate text-xs text-slate-600">{p.applicationUrl}</p>
                    </Td>
                    <Td>
                      <Badge>{p.applicationType}</Badge>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {(p.environments || []).map((e) => (
                          <StatusPill key={e.id} status={e.name} dot={false} />
                        ))}
                      </div>
                    </Td>
                    <Td className="text-right tabular-nums">{p.stats?.testCases ?? "—"}</Td>
                    <Td className="text-slate-600">{timeAgo(p.stats?.lastRunAt)}</Td>
                    <Td>{p.stats?.lastRunStatus ? <StatusPill status={p.stats.lastRunStatus} /> : <span className="text-slate-500">—</span>}</Td>
                    <Td className="text-right tabular-nums">{fmtPct(p.stats?.passRate)}</Td>
                    <Td className="text-right tabular-nums">{p.stats?.openDefects ?? "—"}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </DataState>
      </Card>
      <NewProjectModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
