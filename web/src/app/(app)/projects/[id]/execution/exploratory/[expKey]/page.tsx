"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { SessionPage } from "@/components/exploratory/SessionPage";

/** An exploratory session (design P6 §9.3–9.7): approval, live progress, results. `?view=`, `&finding=`. */
export default function Page() {
  const { expKey } = useParams<{ expKey: string }>();
  return (
    <Suspense>
      <SessionPage expKey={decodeURIComponent(expKey)} />
    </Suspense>
  );
}
