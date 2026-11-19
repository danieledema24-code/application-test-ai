"use client";

// A specific release assessment (design P6 §4.1): /projects/[id]/release-readiness/REL-0001; older ones are read-only.

import { useParams } from "next/navigation";
import { ReleaseReadinessPage } from "@/components/release/ReleaseReadiness";

export default function ReleaseAssessmentRoute() {
  const { relKey } = useParams<{ relKey: string }>();
  return <ReleaseReadinessPage relKey={decodeURIComponent(relKey)} />;
}
