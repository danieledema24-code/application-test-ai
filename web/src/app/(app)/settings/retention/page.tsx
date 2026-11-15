"use client";

import { useEffect } from "react";
import { PageHeader } from "@/components/ui";
import { SettingsTabs } from "@/components/settings/SettingsTabs";
import { Retention } from "@/components/settings/Retention";

/** Evidence retention (design P5 §13.4; owner/admin). */
export default function RetentionPage() {
  useEffect(() => {
    document.title = "Retention · Settings · QA Analyst";
  }, []);
  return (
    <>
      <PageHeader title="Settings" description="Your profile, organisation and the people in this workspace." />
      <SettingsTabs current="retention" />
      <div className="max-w-3xl">
        <Retention />
      </div>
    </>
  );
}
