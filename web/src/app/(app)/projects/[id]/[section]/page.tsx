"use client";

import { notFound, useParams } from "next/navigation";
import { useEffect } from "react";
import { isBuilt, sectionBySlug } from "@/lib/sections";
import { ComingInPhase } from "@/components/domain/ComingInPhase";

/** Unbuilt project sections (requirements, test-strategy, …): an honest "Coming in Phase N" page. */
export default function ComingSectionPage() {
  const { id, section: slug } = useParams<{ id: string; section: string }>();
  const section = sectionBySlug(slug);
  useEffect(() => {
    if (section) document.title = `${section.label} · QA Analyst`;
  }, [section]);
  if (!section || !section.slug || isBuilt(section)) notFound();
  return (
    <div className="space-y-4">
      <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
        {section.label}
      </h1>
      <ComingInPhase section={section} projectId={id} />
    </div>
  );
}
