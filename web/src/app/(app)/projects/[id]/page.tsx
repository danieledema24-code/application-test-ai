"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { useApi } from "@/lib/hooks";
import type { ProjectDetail } from "@/lib/types";
import { Badge, Card, ErrorState, LoadingBlock, PageHeader, TabPanel, Tabs } from "@/components/ui";
import { OverviewTab } from "@/components/project/OverviewTab";
import { EnvironmentsTab } from "@/components/project/EnvironmentsTab";
import { DiscoveryTab } from "@/components/project/DiscoveryTab";
import { TestCasesTab } from "@/components/project/TestCasesTab";
import { ApiTab } from "@/components/project/ApiTab";
import { RunsTab } from "@/components/project/RunsTab";
import { DefectsTab } from "@/components/project/DefectsTab";
import { ReportsTab } from "@/components/project/ReportsTab";
import { SettingsTab } from "@/components/project/SettingsTab";
import { Suspense } from "react";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "environments", label: "Environments" },
  { id: "discovery", label: "Discovery" },
  { id: "test-cases", label: "Test Cases" },
  { id: "api", label: "API" },
  { id: "runs", label: "Runs" },
  { id: "defects", label: "Defects" },
  { id: "reports", label: "Reports" },
  { id: "settings", label: "Settings" },
];

function ProjectView({ id }: { id: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const initial = params.get("tab") || "overview";
  const [tab, setTab] = useState(TABS.some((t) => t.id === initial) ? initial : "overview");
  const { data: project, error, isLoading, mutate } = useApi<ProjectDetail>(`/projects/${id}`);

  useEffect(() => {
    const t = params.get("tab");
    if (t && TABS.some((x) => x.id === t)) setTab(t);
  }, [params]);

  function changeTab(t: string) {
    setTab(t);
    router.replace(`${pathname}?tab=${t}`, { scroll: false });
  }

  if (error && !project)
    return (
      <Card>
        <ErrorState error={error} onRetry={() => mutate()} />
      </Card>
    );
  if (isLoading || !project) return <LoadingBlock label="Loading project…" />;

  const tabs = TABS.map((t) =>
    t.id === "environments" ? { ...t, count: project.environments.length } : t.id === "test-cases" ? { ...t, count: project.stats?.testCases } : t,
  );

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/projects" className="hover:underline">
            Projects
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {project.name} <Badge>{project.applicationType}</Badge>
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {project.description && <span>{project.description}</span>}
            {project.applicationUrl && (
              <a href={project.applicationUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-700 hover:underline">
                {project.applicationUrl} <ExternalLink className="h-3 w-3" aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            )}
          </span>
        }
      />
      <Tabs tabs={tabs} value={tab} onChange={changeTab} label="Project sections" idPrefix="project" />
      <TabPanel id={tab} idPrefix="project">
        {tab === "overview" && <OverviewTab project={project} onNavigate={changeTab} />}
        {tab === "environments" && <EnvironmentsTab project={project} onChanged={() => mutate()} />}
        {tab === "discovery" && <DiscoveryTab project={project} onChanged={() => mutate()} />}
        {tab === "test-cases" && <TestCasesTab project={project} />}
        {tab === "api" && <ApiTab project={project} />}
        {tab === "runs" && <RunsTab project={project} />}
        {tab === "defects" && <DefectsTab project={project} />}
        {tab === "reports" && <ReportsTab project={project} />}
        {tab === "settings" && <SettingsTab project={project} onChanged={() => mutate()} />}
      </TabPanel>
    </>
  );
}

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={<LoadingBlock />}>
      <ProjectView id={id} />
    </Suspense>
  );
}
