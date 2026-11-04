import type { ProjectDetail } from "@/lib/types";
import { DefectsList } from "@/components/domain/DefectsList";

export function DefectsTab({ project }: { project: ProjectDetail }) {
  return <DefectsList projectId={project.id} />;
}
