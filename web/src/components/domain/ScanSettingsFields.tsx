"use client";

import { Checkbox, TextField } from "@/components/ui";
import type { ScanSettings } from "@/lib/contract";

export type ScanSettingsForm = { name: string; max_pages: string; max_depth: string; include_mobile: boolean; respect_robots: boolean };
export type ScanSettingsErrors = Partial<Record<"name" | "max_pages" | "max_depth", string>>;

export const PAGE_LIMIT = { min: 1, max: 100 };
export const DEPTH_LIMIT = { min: 0, max: 5 };

export function toForm(s: ScanSettings, name = ""): ScanSettingsForm {
  return { name, max_pages: String(s.max_pages), max_depth: String(s.max_depth), include_mobile: s.include_mobile, respect_robots: s.respect_robots };
}

function intIn(v: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(v.trim())) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}

/** Validates the form; returns errors or the ScanSettings to send. */
export function validateScanSettings(f: ScanSettingsForm, withName: boolean): { errors: ScanSettingsErrors; settings: ScanSettings | null } {
  const errors: ScanSettingsErrors = {};
  const pages = intIn(f.max_pages, PAGE_LIMIT.min, PAGE_LIMIT.max);
  const depth = intIn(f.max_depth, DEPTH_LIMIT.min, DEPTH_LIMIT.max);
  if (pages === null) errors.max_pages = `Enter a whole number from ${PAGE_LIMIT.min} to ${PAGE_LIMIT.max}.`;
  if (depth === null) errors.max_depth = `Enter a whole number from ${DEPTH_LIMIT.min} to ${DEPTH_LIMIT.max}.`;
  if (withName && f.name.trim().length > 120) errors.name = "Use 120 characters or fewer.";
  if (Object.keys(errors).length) return { errors, settings: null };
  return { errors, settings: { max_pages: pages!, max_depth: depth!, include_mobile: f.include_mobile, respect_robots: f.respect_robots } };
}

/** Scan settings shared by Start QA Analysis and the re-scan dialog (design spec §6, §7.2). */
export function ScanSettingsFields({
  value,
  onChange,
  errors,
  showName,
  refs,
  signIn,
}: {
  /** Phase 2 sign-in block (credential fields or "Sign in with the saved test account"). */
  signIn?: React.ReactNode;
  value: ScanSettingsForm;
  onChange: (v: ScanSettingsForm) => void;
  errors: ScanSettingsErrors;
  showName: boolean;
  refs?: Partial<Record<keyof ScanSettingsErrors, React.Ref<HTMLInputElement>>>;
}) {
  const set = <K extends keyof ScanSettingsForm>(k: K, v: ScanSettingsForm[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="space-y-4">
      {showName && (
        <TextField ref={refs?.name} label="Project name" value={value.name} maxLength={120} onChange={(e) => set("name", e.target.value)} error={errors.name} />
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          ref={refs?.max_pages}
          label="Maximum pages"
          inputMode="numeric"
          value={value.max_pages}
          onChange={(e) => set("max_pages", e.target.value)}
          hint={`${PAGE_LIMIT.min}–${PAGE_LIMIT.max}. Discovery stops after this many pages.`}
          error={errors.max_pages}
          className="tabular-nums"
        />
        <TextField
          ref={refs?.max_depth}
          label="Maximum link depth"
          inputMode="numeric"
          value={value.max_depth}
          onChange={(e) => set("max_depth", e.target.value)}
          hint={`${DEPTH_LIMIT.min}–${DEPTH_LIMIT.max} clicks from the start page.`}
          error={errors.max_depth}
          className="tabular-nums"
        />
      </div>
      <fieldset>
        <legend className="mb-2 text-body font-medium text-fg-strong">Viewports</legend>
        <div className="flex flex-col gap-2">
          <Checkbox label="Desktop (1440 × 900)" checked disabled description="Always included." />
          <Checkbox
            label="Mobile (390 × 844)"
            checked={value.include_mobile}
            onChange={(e) => set("include_mobile", e.target.checked)}
            description="Both viewports are needed for responsive observations."
          />
        </div>
      </fieldset>
      <Checkbox
        label="Respect robots.txt"
        checked={value.respect_robots}
        onChange={(e) => set("respect_robots", e.target.checked)}
        description="Skip pages the site asks automated tools not to visit."
      />
      <fieldset>
        <legend className="mb-2 text-body font-medium text-fg-strong">Signed-in areas</legend>
        {signIn ?? <p className="text-small text-fg">Without test credentials, discovery covers public pages only and lists sign-in areas as access gaps.</p>}
      </fieldset>
    </div>
  );
}
