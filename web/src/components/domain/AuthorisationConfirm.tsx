"use client";

import { forwardRef } from "react";
import { Checkbox } from "@/components/ui";

/** Gate 1: authorisation attestation (design spec §6). The checkbox names the final host after redirects. */
export const AuthorisationConfirm = forwardRef<
  HTMLInputElement,
  { host: string; checked: boolean; onChange: (v: boolean) => void; error?: string | null; disabled?: boolean }
>(function AuthorisationConfirm({ host, checked, onChange, error, disabled }, ref) {
  return (
    <div className="space-y-4">
      <Checkbox
        ref={ref}
        label="I am authorised to test this site."
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        error={error}
        description={
          <>
            I own <span className="font-medium text-fg-strong">{host || "this site"}</span> or have the owner’s permission to explore it with automated tools. Your
            confirmation is recorded with your name and the time.
          </>
        }
      />
      <p className="rounded-md bg-elevated px-3 py-2 text-small text-fg">
        <span className="font-semibold text-fg-strong">What discovery does:</span> opens pages, reads their structure and takes screenshots. It does not submit forms,
        make purchases, or create, change or delete data.
      </p>
    </div>
  );
});

export function attestationStatement(host: string): string {
  return `I am authorised to test ${host || "this site"}: I own it or have the owner's permission to explore it with automated tools.`;
}
