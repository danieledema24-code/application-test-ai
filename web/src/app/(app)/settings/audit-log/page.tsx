"use client";

import { useEffect } from "react";
import { PageHeader } from "@/components/ui";
import { SettingsTabs } from "@/components/settings/SettingsTabs";
import { AuditLog } from "@/components/settings/AuditLog";

/** Organisation audit log (design P5 §13.3; owner/admin). */
export default function AuditLogPage() {
  useEffect(() => {
    document.title = "Audit log · Settings · QA Analyst";
  }, []);
  return (
    <>
      <PageHeader title="Settings" description="Your profile, organisation and the people in this workspace." />
      <SettingsTabs current="audit-log" />
      <div className="max-w-6xl">
        <AuditLog />
      </div>
    </>
  );
}
