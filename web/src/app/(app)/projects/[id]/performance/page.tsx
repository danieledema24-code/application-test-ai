"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { LoadingBlock } from "@/components/ui";

/** Old links and bookmarks (design P5 §4.1): Performance is now a tab of Non-functional. */
export default function PerformanceRedirect() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/projects/${id}/non-functional?tab=performance`);
  }, [id, router]);
  return <LoadingBlock label="Opening Non-functional…" />;
}
