"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { api, ApiError, errorMessage } from "@/lib/api";
import { compareWithHint, g2EverApproved, scanOptionLabel, type RescanResult } from "@/lib/change";
import { DEFAULT_SCAN_SETTINGS, type ScanDetail, type SecretMeta } from "@/lib/contract";
import { fmtDate } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { hostOf } from "@/lib/url";
import { Button, Callout, Checkbox, ConfirmDialog, LinkButton, Modal, SelectField, useToast } from "@/components/ui";
import { useScanRows } from "@/components/changes/hooks";
import { ScanSettingsFields, toForm, validateScanSettings, type ScanSettingsErrors, type ScanSettingsForm } from "@/components/domain/ScanSettingsFields";
import { useProject } from "./ProjectContext";

/**
 * Re-scan (design spec §7.2): creates Scan N+1; earlier scans, reports and evidence are kept. Once a scan was
 * approved at Gate 2 it becomes "Rescan and compare" (design P6 §6.3, D25): the new scan is compared with the
 * baseline and only accessibility and security go out of date (D27). There is no plain re-scan after G2 (OQ1).
 */
export function RescanDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const p = useProject();
  const n = p.discovery?.current_version ?? 0;
  const { comparable, baseline, rows } = useScanRows(p.id, open);
  // From the workflow's G2 state, not the scan list (OQ1): a slow or failed list never falls back to a plain re-scan.
  const g2 = g2EverApproved(p.workflow);
  const compare = g2 === true;
  const [touched, setTouched] = useState(false);
  const [compareWith, setCompareWith] = useState("");
  const chosen = comparable.find((s) => s.id === compareWith) ?? baseline;
  const chosenDetail = useApi<ScanDetail>(open && chosen ? `/projects/${p.id}/scans/${chosen.n}` : null);
  const [form, setForm] = useState<ScanSettingsForm>(toForm(DEFAULT_SCAN_SETTINGS));
  const [errors, setErrors] = useState<ScanSettingsErrors>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ text: string; g1?: boolean; running?: boolean } | null>(null);
  const failureRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLInputElement>(null);
  const depthRef = useRef<HTMLInputElement>(null);
  const secrets = useApi<SecretMeta[]>(open ? `/projects/${p.id}/secrets` : null, undefined, { shouldRetryOnError: false });
  const saved = !!secrets.data?.some((s) => s.name === "scan_credentials" || s.kind === "login_credentials");
  const [signIn, setSignIn] = useState(true);
  const toast = useToast();
  const router = useRouter();
  const { mutate } = useSWRConfig();

  useEffect(() => {
    if (open) {
      setForm(toForm(p.project?.settings ?? DEFAULT_SCAN_SETTINGS));
      setErrors({});
      setSignIn(true);
      setFailure(null);
      setCompareWith("");
      setTouched(false);
    }
  }, [open, p.project?.settings]);

  // Prefill with the compared scan's limits (design P6 §6.3).
  const limits = chosenDetail.data?.limits;
  useEffect(() => {
    if (open && compare && limits) setForm(toForm({ ...DEFAULT_SCAN_SETTINGS, ...limits }));
  }, [open, compare, limits]);

  useEffect(() => {
    if (failure) failureRef.current?.focus();
  }, [failure]);

  async function start() {
    const { errors: e, settings } = validateScanSettings(form, false);
    setErrors(e);
    if (!settings) return (e.max_pages ? pagesRef : depthRef).current?.focus();
    const body = saved ? { ...settings, use_credentials: signIn } : settings;
    if (g2 === null) return;
    if (!compare) {
      setBusy(true);
      const ok = await p.rescan(body);
      setBusy(false);
      if (ok) onClose();
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const res = await api<RescanResult>(`/projects/${p.id}/rescans`, {
        // Without the compared scan's limits loaded (and nothing edited), the API uses the baseline's own limits.
        body: {
          ...(limits || touched ? { limits: body } : {}),
          ...(chosen && chosen.id !== baseline?.id ? { compare_with: chosen.id } : {}),
        },
      });
      toast(`Scan ${res.scan.number} started. It will be compared with Scan ${res.baseline.number}.`);
      p.announce("Discovery started", true);
      p.refresh();
      void mutate((k) => typeof k === "string" && (k.includes(`/projects/${p.id}/scans`) || k.includes(`/projects/${p.id}/discovery`) || k.includes(`/projects/${p.id}/changes`)));
      onClose();
      router.push(`/projects/${p.id}/discovery?view=live`);
    } catch (err) {
      const msg = errorMessage(err);
      if (err instanceof ApiError && err.status === 409 && /URL or allowed hosts changed/.test(msg))
        setFailure({ g1: true, text: "The site's URL or allowed hosts changed since they were authorised. Authorise them again (Gate 1) before rescanning." });
      else if (err instanceof ApiError && err.status === 409 && /already queued or running/.test(msg))
        setFailure({ running: true, text: `A scan is already running (Scan ${rows[0]?.n ?? n}).` });
      else if (err instanceof ApiError && err.status === 422 && err.fieldErrors.max_pages) {
        setErrors({ max_pages: err.fieldErrors.max_pages });
        pagesRef.current?.focus();
      } else setFailure({ text: `Couldn’t start the rescan: ${msg.replace(/\.$/, "")}. Nothing was started.` });
    } finally {
      setBusy(false);
    }
  }

  const host = hostOf(p.project?.primary_url) || "this site";
  const next = (rows[0]?.n ?? n) + 1;
  const hint = compareWithHint(chosen && { ...chosen, number: chosen.n }, baseline && { number: baseline.n });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={compare ? `Rescan ${host} and compare?` : `Re-scan ${host}?`}
      description={
        compare
          ? `Starts Scan ${next} with the settings below and compares it with the scan you choose. Approved requirements, test cases and scripts stay as they are: the comparison lists exactly what the change affects.`
          : `This starts Scan ${n + 1} with the settings below.${n ? ` Scan ${n} and its report stay available.` : ""}`
      }
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void start()} loading={busy} disabled={g2 === null}>
            {compare ? "Start rescan" : "Start re-scan"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {failure && (
          <div ref={failureRef} tabIndex={-1} className="focus:outline-none">
            <Callout
              tone="danger"
              role="alert"
              actions={
                failure.g1 ? (
                  <LinkButton href={`/projects/${p.id}/settings`} variant="secondary" onClick={onClose}>
                    Open Project settings
                  </LinkButton>
                ) : failure.running ? (
                  <LinkButton href={`/projects/${p.id}/discovery?view=live`} variant="secondary" onClick={onClose}>
                    Watch live
                  </LinkButton>
                ) : undefined
              }
            >
              {failure.text}
            </Callout>
          </div>
        )}
        {compare && comparable.length === 0 && <p className="text-small text-fg">Compared with the scan approved at Gate 2.</p>}
        {compare && comparable.length > 0 && (
          <SelectField
            label="Compare with"
            value={chosen?.id ?? ""}
            onChange={(e) => setCompareWith(e.target.value)}
            hint={hint ?? undefined}
            options={[...comparable].sort((a, b) => (a.id === baseline?.id ? -1 : b.id === baseline?.id ? 1 : b.n - a.n)).map((s) => ({
              value: s.id,
              label: `${scanOptionLabel({ ...s, number: s.n }, fmtDate)}${s.id === baseline?.id ? " (recommended)" : ""}`,
            }))}
          />
        )}
        <ScanSettingsFields
          value={form}
          onChange={(f) => (setForm(f), setTouched(true))}
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
        {compare && <p className="text-small text-fg">Accessibility and security results will be marked out of date, because pages may have changed.</p>}
      </div>
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
