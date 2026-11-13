"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import useSWRInfinite from "swr/infinite";
import { api, buildQuery } from "@/lib/api";
import type { Page, ProjectSummary } from "@/lib/contract";
import { fmtDateTime } from "@/lib/format";
import { projectStatusLabel } from "@/lib/projectStatus";
import { shortUrl } from "@/lib/url";
import { Button, Card, EmptyState, ErrorState, LinkButton, LoadingBlock, PageHeader, Segmented, StatusPill, TBody, THead, Table, Td, TextField, Th, Tr } from "@/components/ui";
import { LifecycleMini } from "@/components/domain/LifecycleProgress";

type View = "all" | "running" | "awaiting" | "failed" | "archived";

const VIEWS: { value: View; label: string }[] = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "awaiting", label: "Awaiting approval" },
  { value: "failed", label: "Failed" },
  { value: "archived", label: "Archived" },
];

/** Running / awaiting / failed are filtered here: the API only filters by active/archived. */
function matches(p: ProjectSummary, view: View): boolean {
  if (view === "running") return p.current_stage_status === "running" || p.current_stage_status === "queued";
  if (view === "awaiting") return p.awaiting_approval;
  if (view === "failed") return p.current_stage_status === "failed";
  return true;
}

function ProjectsList() {
  const router = useRouter();
  const params = useSearchParams();
  const view = (VIEWS.find((v) => v.value === params.get("view"))?.value ?? "all") as View;
  const [q, setQ] = useState(params.get("q") ?? "");
  const [term, setTerm] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const status = view === "archived" ? "archived" : "active";
  const getKey = (i: number, prev: Page<ProjectSummary> | null) => {
    if (prev && !prev.next_cursor) return null;
    return `/projects${buildQuery({ status, q: term, limit: 50, cursor: i === 0 ? null : prev?.next_cursor })}`;
  };
  const { data, error, isLoading, size, setSize, mutate } = useSWRInfinite<Page<ProjectSummary>>(getKey, (k: string) => api<Page<ProjectSummary>>(k), {
    revalidateOnFocus: false,
  });
  const items = (data ?? []).flatMap((p) => p.items).filter((p) => matches(p, view));
  const hasMore = !!data?.[data.length - 1]?.next_cursor;

  useEffect(() => {
    document.title = "Projects · QA Analyst";
  }, []);

  return (
    <>
      <PageHeader
        title="Projects"
        description="Each project is one website and its QA lifecycle."
        actions={
          <LinkButton href="/dashboard" variant="primary" icon={<Plus className="h-4 w-4" aria-hidden />}>
            Start QA analysis
          </LinkButton>
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Segmented label="Show" options={VIEWS} value={view} onChange={(v) => router.replace(`/projects${buildQuery({ view: v === "all" ? null : v })}`)} />
        <TextField label="Search projects" hideLabel type="search" placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} wrapClassName="w-full sm:ml-auto sm:w-72" />
      </div>
      <Card>
        {error && !data ? (
          <ErrorState error={error} title="Couldn’t load your projects." message="Try again." onRetry={() => void mutate()} />
        ) : isLoading && !data ? (
          <LoadingBlock label="Loading projects…" />
        ) : items.length === 0 ? (
          <EmptyState
            title={term || view !== "all" ? "No projects match." : "No projects yet"}
            description={term || view !== "all" ? "Try a different filter or search." : "Start a QA analysis from the dashboard to create your first project."}
          />
        ) : (
          <Table label="Projects">
            <THead>
              <tr>
                <Th>Project</Th>
                <Th>Status</Th>
                <Th>Lifecycle</Th>
                <Th className="text-right">Pages found</Th>
                <Th>Last activity</Th>
              </tr>
            </THead>
            <TBody>
              {items.map((p) => {
                const st = projectStatusLabel(p);
                return (
                  <Tr key={p.id}>
                    <Td rowHeader>
                      <Link href={`/projects/${p.id}`} className="block hover:underline">
                        {p.name}
                      </Link>
                      <span className="block text-small font-normal text-fg-muted">{shortUrl(p.primary_url)}</span>
                    </Td>
                    <Td>
                      <StatusPill status={st.status} label={st.label} />
                    </Td>
                    <Td>
                      <LifecycleMini project={p} />
                    </Td>
                    <Td className="text-right tabular-nums">{p.pages_discovered}</Td>
                    <Td className="whitespace-nowrap tabular-nums text-fg-muted">{fmtDateTime(p.updated_at)}</Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        )}
        {hasMore && (
          <div className="border-t border-line px-5 py-3 text-center">
            <Button variant="secondary" onClick={() => void setSize(size + 1)}>
              Load more projects
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense>
      <ProjectsList />
    </Suspense>
  );
}
