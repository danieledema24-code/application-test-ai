"use client";

// Change set page (design P6 §4.1, §6.4): /projects/[id]/discovery/changes/CHG-0001, `?page=/contact` opens the drawer.

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { ChangeSetPage } from "@/components/changes/ChangeSet";

export default function ChangeSetRoute() {
  const { chgKey } = useParams<{ chgKey: string }>();
  return (
    <Suspense>
      <ChangeSetPage chgKey={decodeURIComponent(chgKey)} />
    </Suspense>
  );
}
