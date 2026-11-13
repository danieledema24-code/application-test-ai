"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_SCAN_SETTINGS } from "@/lib/contract";
import { hostOf } from "@/lib/url";
import { ConfirmDialog, Modal, Button } from "@/components/ui";
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

  useEffect(() => {
    if (open) {
      setForm(toForm(p.project?.settings ?? DEFAULT_SCAN_SETTINGS));
      setErrors({});
    }
  }, [open, p.project?.settings]);

  async function start() {
    const { errors: e, settings } = validateScanSettings(form, false);
    setErrors(e);
    if (!settings) return (e.max_pages ? pagesRef : depthRef).current?.focus();
    setBusy(true);
    const ok = await p.rescan(settings);
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
      <ScanSettingsFields value={form} onChange={setForm} errors={errors} showName={false} refs={{ max_pages: pagesRef, max_depth: depthRef }} />
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
