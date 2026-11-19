"use client";

import { useEffect } from "react";
import { PageHeader } from "@/components/ui";
import { SettingsTabs } from "@/components/settings/SettingsTabs";
import { LoadLimits } from "@/components/settings/LoadLimits";
import { ExplorationLimits } from "@/components/settings/ExplorationLimits";

/** Organisation limits (design P5 §9.7, D18; P6 §9.9, D30): load tests and exploratory sessions; owner/admin edit. */
export default function LoadLimitsPage() {
  useEffect(() => {
    document.title = "Limits · Settings · QA Analyst";
  }, []);
  return (
    <>
      <PageHeader title="Settings" description="Your profile, organisation and the people in this workspace." />
      <SettingsTabs current="load-limits" />
      <div className="max-w-3xl space-y-6">
        <LoadLimits />
        <ExplorationLimits />
      </div>
    </>
  );
}
