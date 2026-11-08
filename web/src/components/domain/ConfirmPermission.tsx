"use client";

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import type { Environment } from "@/lib/types";
import { Button, InlineError, useToast } from "@/components/ui";

/** Inline "I have permission" prompt shown wherever a scan or run is blocked by an unconfirmed site. */
export function ConfirmPermission({ env, onConfirmed }: { env: Pick<Environment, "id" | "baseUrl">; onConfirmed: () => void }) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function confirm() {
    setSaving(true);
    setError(null);
    try {
      await api(`/environments/${env.id}`, { method: "PATCH", body: { authorised: true } });
      toast("Thanks — you can test this site now");
      onConfirmed();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
      <p className="flex gap-2 text-sm text-amber-100">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          Before we test <span className="font-medium break-all">{env.baseUrl}</span>, confirm that you own this site or have permission to test it.
        </span>
      </p>
      <Button size="sm" className="mt-2" loading={saving} onClick={confirm}>
        I have permission — continue
      </Button>
      <div className="mt-2">
        <InlineError error={error} />
      </div>
    </div>
  );
}
