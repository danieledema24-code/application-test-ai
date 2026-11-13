"use client";

import { useState } from "react";
import type { Journey, PageSummary } from "@/lib/contract";
import { pathOf } from "@/lib/url";
import { Button, Card } from "@/components/ui";
import { GeneratedByLabel, ObservationLabel } from "@/components/domain/ObservationLabel";
import { EvidenceLinks, linksToItems, refsToItems } from "@/components/domain/EvidenceDrawer";

/**
 * A user journey (design spec §8.2). Each step shows the label the API gives it (navigated steps are
 * Observed; steps discovery never performed are Inferred). Nothing is guessed from the step's wording.
 */
export function JourneyCard({ journey, pages }: { journey: Journey; pages: Map<string, PageSummary> }) {
  const [open, setOpen] = useState(false);
  const steps = journey.steps.map((s) => {
    const page = pages.get(s.page_id);
    return { ...s, page, inferred: s.label === "inferred" };
  });
  const notPerformed = steps.filter((s) => s.inferred);
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-h3 font-semibold text-fg-strong">{journey.name}</h3>
        <span className="flex flex-wrap items-center gap-2">
          <ObservationLabel provenance={journey.provenance} confidence={journey.confidence} />
          <GeneratedByLabel generatedBy={journey.generated_by} />
        </span>
      </div>
      <ol aria-label={`Steps of ${journey.name}`} className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 text-small">
        {steps.map((s, i) => (
          <li key={i} className="flex items-center gap-2">
            {i > 0 && (
              <span aria-hidden className="text-fg-muted">
                →
              </span>
            )}
            <span className="inline-flex flex-wrap items-center gap-1.5 rounded-md bg-elevated px-2 py-1 ring-1 ring-line">
              <span className="text-fg-strong">{s.action || s.page?.title || "Step"}</span>
              {s.page && <span className="font-mono text-caption text-fg-muted">{pathOf(s.page.url)}</span>}
              {s.label && <ObservationLabel provenance={s.label} />}
            </span>
          </li>
        ))}
      </ol>
      {notPerformed.length > 0 && <p className="mt-2 text-small text-fg-muted">{notPerformed.map((s) => s.action).join(", ")} not performed: read-only.</p>}
      {journey.provenance === "inferred" && (
        <p className="mt-1 text-small text-fg">
          <span className="font-medium">Why inferred:</span>{" "}
          {journey.reason ||
            (notPerformed.length
              ? `${steps.length - notPerformed.length} of ${steps.length} step${steps.length === 1 ? " was" : "s were"} navigated; ${notPerformed.length === 1 ? "one step was" : `${notPerformed.length} steps were`} not performed.`
              : "the journey’s goal was concluded from page structure, not exercised.")}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-small text-fg-muted">
          Evidence: <EvidenceLinks items={refsToItems(journey.evidence_refs)} subject={`${journey.name} journey`} />
        </span>
        <Button size="sm" variant="secondary" aria-expanded={open} aria-controls={`steps-${journey.id}`} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide steps" : "View steps"}
        </Button>
      </div>
      {open && (
        <ol id={`steps-${journey.id}`} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {steps.map((s, i) => (
            <li key={i} className="rounded-md border border-line p-2 text-small">
              <p className="font-medium text-fg-strong">
                {i + 1}. {s.action}
              </p>
              {s.page?.screenshot ? (
                // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived evidence URL
                <img src={s.page.screenshot.content_url} alt={`Screenshot of ${s.page.title || pathOf(s.page.url)} (${pathOf(s.page.url)}), desktop`} className="mt-2 aspect-[4/3] w-full rounded-sm bg-white object-cover object-top ring-1 ring-line" />
              ) : (
                <p className="mt-2 text-fg-muted">No screenshot for this step.</p>
              )}
              {s.page && <EvidenceLinks items={linksToItems([s.page.screenshot])} subject={`step ${i + 1} of ${journey.name}`} className="mt-1" />}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
