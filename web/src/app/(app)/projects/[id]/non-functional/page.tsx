"use client";

import { Suspense } from "react";
import { NonFunctionalPage } from "@/components/nonfunctional/NonFunctional";

/** Non-functional (design P5 §6): Performance, Accessibility and Security (passive) tabs (`?tab=`). */
export default function Page() {
  return (
    <Suspense>
      <NonFunctionalPage />
    </Suspense>
  );
}
