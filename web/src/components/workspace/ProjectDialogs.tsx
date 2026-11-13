"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { DEFAULT_SCAN_SETTINGS, type SecretMeta } from "@/lib/contract";
import { useApi } from "@/lib/hooks";
import { hostOf } from "@/lib/url";
import { Checkbox, ConfirmDialog, Modal, Button } from "@/components/ui";
import { ScanSettingsFields, toForm, validateScanSettings, type ScanSettingsErrors, type ScanSettingsForm } from "@/components/domain/ScanSettingsFields";
import { useProject } from "./ProjectContext";

/** Re-scan (design spec §7.2): creates Scan N+1; earlier scans, reports and evidence are kept. */
export function RescanDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const p = useProject();
  const n = p.discovery?.current_version ?? 0;
  const [form, setForm] = useState<ScanSettingsForm>(toForm(DEFAULT_SCAN_SETTINGS));
  const [errors, setErrors] = useState<ScanSettingsErrors>({});
  const [busy, setBusy] = useState(false);
  const pagesRef = useRef<HTMLInputElement>(null);
  const depthRef = useRef<HTMLInputElement>(null);
  const secrets = useApi<SecretMeta[]>(open ? `/projects/${p.id}/secrets` : null, undefined, { shouldRetryOnError: false });
  const saved = !!secrets.data?.some((s) => s.name === "scan_credentials" || s.kind === "login_credentials");
  const [signIn, setSignIn] = useState(true);

  useEffect(() => {
    if (open) {
      setForm(toForm(p.project?.settings ?? DEFAULT_SCAN_SETTINGS));
      setErrors({});
      setSignIn(true);
    }
  }, [open, p.project?.settings]);

  async function start() {
    const { errors: e, settings } = validateScanSettings(form, false);
    setErrors(e);
    if (!settings) return (e.max_pages ? pagesRef : depthRef).current?.focus();
    setBusy(true);
    const ok = await p.rescan(saved ? { ...settings, use_credentials: signIn } : settings);
    setBusy(false);
    if (ok) onClose();
  }

  const host = hostOf(p.project?.primary_url) || "this site";
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Re-scan ${host}?`}
      description={`This starts Scan ${n + 1} with the settings below.${n ? ` Scan ${n} and its report stay available.` : ""}`}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void start()} loading={busy}>
            Start re-scan
          </Button>
        </>
      }
    >
      <ScanSettingsFields
        value={form}
        onChange={setForm}
        errors={errors}
        showName={false}
        refs={{ max_pages: pagesRef, max_depth: depthRef }}
        signIn={
          saved ? (
            <Checkbox
              label="Sign in with the saved test account"
              checked={signIn}
              onChange={(e) => setSignIn(e.target.checked)}
              description="Discovery submits the sign-in form only, once, to avoid locking the account."
            />
          ) : (
            <p className="text-small text-fg">
              No test credentials saved. Discovery covers public pages only.{" "}
              <Link href={`/projects/${p.id}/settings?view=credentials`} onClick={onClose} className="font-medium text-navy-700 underline underline-offset-2">
                Add credentials in Project settings
              </Link>
            </p>
          )
        }
      />
    </Modal>
  );
}

export function CancelDiscoveryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const p = useProject();
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Cancel discovery?"
      confirmLabel="Cancel discovery"
      cancelLabel="Keep running"
      danger
      loading={busy}
      onConfirm={async () => {
        setBusy(true);
        await p.cancelDiscovery();
        setBusy(false);
        onClose();
      }}
    >
      <p>Discovery stops after the current page. Findings and evidence collected so far are kept and marked as partial.</p>
    </ConfirmDialog>
  );
}
