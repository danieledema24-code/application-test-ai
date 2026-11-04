"use client";

import { useApi } from "@/lib/hooks";
import type { Project } from "@/lib/types";
import { SelectField } from "@/components/ui";

export function useProjects() {
  return useApi<Project[]>("/projects");
}

export function ProjectSelect({
  value,
  onChange,
  label = "Project",
  placeholder = "Select a project",
  required,
  hideLabel,
  wrapClassName,
}: {
  value: string;
  onChange: (id: string, project?: Project) => void;
  label?: string;
  placeholder?: string;
  required?: boolean;
  hideLabel?: boolean;
  wrapClassName?: string;
}) {
  const { data, isLoading } = useProjects();
  return (
    <SelectField
      label={label}
      hideLabel={hideLabel}
      wrapClassName={wrapClassName}
      required={required}
      value={value}
      onChange={(e) => onChange(e.target.value, data?.find((p) => p.id === e.target.value))}
      placeholder={isLoading ? "Loading projects…" : placeholder}
      options={(data || []).map((p) => ({ value: p.id, label: p.name }))}
    />
  );
}
