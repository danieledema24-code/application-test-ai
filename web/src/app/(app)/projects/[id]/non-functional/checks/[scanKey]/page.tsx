"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { CheckPage } from "@/components/nonfunctional/CheckResults";

/** An accessibility (A11Y-) or security (SEC-) check (design P5 §7.4, §8.2). `?view=`, `?finding=`. */
export default function Page() {
  const { scanKey } = useParams<{ scanKey: string }>();
  return (
    <Suspense>
      <CheckPage scanKey={decodeURIComponent(scanKey)} />
    </Suspense>
  );
}
