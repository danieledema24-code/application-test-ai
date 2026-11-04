import type { ProjectDetail } from "@/lib/types";
import { RunsList } from "@/components/domain/RunsList";

export function RunsTab({ project }: { project: ProjectDetail }) {
  return <RunsList projectId={project.id} />;
}
