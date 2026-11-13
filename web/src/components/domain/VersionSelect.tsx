"use client";

import { Button, Callout, SelectField } from "@/components/ui";

/** Artefact version picker (design P2 §5.1, §8.1, §9). */
export function VersionSelect({
  label = "Version",
  versions,
  value,
  onChange,
  className = "w-72",
}: {
  label?: string;
  versions: { version: number; label: string }[];
  value: number | null;
  onChange: (v: number) => void;
  className?: string;
}) {
  if (versions.length === 0) return null;
  return (
    <SelectField
      label={label}
      value={value === null ? "" : String(value)}
      onChange={(e) => onChange(Number(e.target.value))}
      options={versions.map((v) => ({ value: String(v.version), label: v.label }))}
      wrapClassName={className}
    />
  );
}

/** "You're viewing … version {n}. The latest is version {m}." [View latest] — older versions are read-only. */
export function OlderVersionBanner({ what, n, latest, onViewLatest }: { what: string; n: number; latest: number; onViewLatest: () => void }) {
  return (
    <Callout
      tone="info"
      actions={
        <Button variant="secondary" onClick={onViewLatest}>
          View latest
        </Button>
      }
    >
      You’re viewing {what} version {n}. The latest is version {latest}. Older versions are read-only.
    </Callout>
  );
}
