import { CircleDashed } from "lucide-react";
import type { ProjectSection } from "@/lib/sections";
import { Card, EmptyState, LinkButton } from "@/components/ui";

/** Honest placeholder for an unbuilt project section (design spec §3.4): no tables, charts, counts or sample data. */
export function ComingInPhase({ section, projectId }: { section: ProjectSection; projectId: string }) {
  const when = section.phase === null ? "coming in a later phase" : `coming in Phase ${section.phase}`;
  return (
    <Card>
      <EmptyState
        icon={<CircleDashed className="h-5 w-5" aria-hidden />}
        title={`${section.label}: ${when}`}
        description={
          <>
            {section.description && <p>{section.description}</p>}
            <p className="mt-3">Your discovery results are saved and will be used then.</p>
          </>
        }
        action={
          <LinkButton href={`/projects/${projectId}/discovery`} variant="secondary">
            Go to Application Discovery
          </LinkButton>
        }
        className="py-14"
      />
    </Card>
  );
}
