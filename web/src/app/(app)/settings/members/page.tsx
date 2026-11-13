"use client";

import { useEffect } from "react";
import { PageHeader } from "@/components/ui";
import { MembersScreen } from "@/components/settings/Members";
import { SettingsTabs } from "@/components/settings/SettingsTabs";

/** Workspace members and invitations (design P3 §17.1, P3-07). */
export default function MembersPage() {
  useEffect(() => {
    document.title = "Members · Settings · QA Analyst";
  }, []);
  return (
    <>
      <PageHeader title="Settings" description="Your profile, organisation and the people in this workspace." />
      <SettingsTabs current="members" />
      <div className="max-w-5xl">
        <MembersScreen />
      </div>
    </>
  );
}
