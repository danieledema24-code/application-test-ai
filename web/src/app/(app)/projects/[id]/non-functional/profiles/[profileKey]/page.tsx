"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { ProfileEditor } from "@/components/nonfunctional/Profiles";

/** Load profile editor (design P5 §9.2). `?v=` shows an older version read-only. */
export default function Page() {
  const { profileKey } = useParams<{ profileKey: string }>();
  return (
    <Suspense>
      <ProfileEditor profileKey={decodeURIComponent(profileKey)} />
    </Suspense>
  );
}
