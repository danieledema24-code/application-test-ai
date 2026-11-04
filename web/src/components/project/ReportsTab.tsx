import type { ProjectDetail } from "@/lib/types";
import { ReportsList } from "@/components/domain/ReportsList";

export function ReportsTab({ project }: { project: ProjectDetail }) {
  return <ReportsList projectId={project.id} />;
}
