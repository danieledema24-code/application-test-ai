"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { LoadTestPage } from "@/components/nonfunctional/LoadTest";

/** A load test (design P5 §9.4–9.6): approval, live numbers, results. */
export default function Page() {
  const { runKey } = useParams<{ runKey: string }>();
  return (
    <Suspense>
      <LoadTestPage runKey={decodeURIComponent(runKey)} />
    </Suspense>
  );
}
