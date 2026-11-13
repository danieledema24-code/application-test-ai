"use client";

import { useParams, usePathname } from "next/navigation";
import { useCallback, useState } from "react";
import { ApiError } from "@/lib/api";
import { projectRoute } from "@/lib/sections";
import { EmptyState, ErrorState, LinkButton } from "@/components/ui";
import { EvidenceProvider } from "@/components/domain/EvidenceDrawer";
import { LifecycleProgress } from "@/components/domain/LifecycleProgress";
import { ProjectProvider, useProject } from "@/components/workspace/ProjectContext";
import { ProjectHeader } from "@/components/workspace/ProjectHeader";
import { CancelDiscoveryDialog, RescanDialog } from "@/components/workspace/ProjectDialogs";

function Frame({ section, children }: { section: string; children: React.ReactNode }) {
  const p = useProject();
  if (p.projectError instanceof ApiError && p.projectError.status === 404)
    return (
      <EmptyState
        title="Project not found"
        description="This project doesn’t exist, or it belongs to another organisation."
        action={<LinkButton href="/projects">View all projects</LinkButton>}
      />
    );
  if (p.projectError && !p.project) return <ErrorState error={p.projectError} title="Couldn’t load this project." message="Try again." onRetry={p.refresh} />;
  const overview = section === "";
  return (
    <div className="space-y-6">
      <ProjectHeader asHeading={overview} />
      {!overview && <LifecycleProgress variant="compact" workflow={p.workflow} projectId={p.id} />}
      <div>{children}</div>
    </div>
  );
}

/** Project workspace shell: one SSE connection, header, lifecycle and dialogs shared by all 12 sections. */
export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const section = projectRoute(pathname)?.section ?? "";
  const [rescanOpen, setRescanOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const openRescan = useCallback(() => setRescanOpen(true), []);
  const openCancel = useCallback(() => setCancelOpen(true), []);
  return (
    <ProjectProvider id={id} onOpenRescan={openRescan} onOpenCancel={openCancel}>
      <EvidenceProvider>
        <Frame section={section}>{children}</Frame>
        <RescanDialog open={rescanOpen} onClose={() => setRescanOpen(false)} />
        <CancelDiscoveryDialog open={cancelOpen} onClose={() => setCancelOpen(false)} />
      </EvidenceProvider>
    </ProjectProvider>
  );
}
