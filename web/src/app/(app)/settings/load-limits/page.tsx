"use client";

import { useEffect } from "react";
import { PageHeader } from "@/components/ui";
import { SettingsTabs } from "@/components/settings/SettingsTabs";
import { LoadLimits } from "@/components/settings/LoadLimits";

/** Organisation load limits (design P5 §9.7, decision D18; owner/admin edit, others read only). */
export default function LoadLimitsPage() {
  useEffect(() => {
    document.title = "Load limits · Settings · QA Analyst";
  }, []);
  return (
    <>
      <PageHeader title="Settings" description="Your profile, organisation and the people in this workspace." />
      <SettingsTabs current="load-limits" />
      <div className="max-w-3xl">
        <LoadLimits />
      </div>
    </>
  );
}
