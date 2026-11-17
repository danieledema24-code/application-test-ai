"use client";

import { Suspense } from "react";
import { Phase6ReportPage } from "@/components/report/Phase6Report";

/** Release Readiness Report (P6-05c, design P6 §11.2). */
export default function Page() {
  return (
    <Suspense>
      <Phase6ReportPage type="release_readiness" />
    </Suspense>
  );
}
