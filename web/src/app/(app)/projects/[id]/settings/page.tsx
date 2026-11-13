"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { DEFAULT_SCAN_SETTINGS, type ProjectDetail, type SecretMeta } from "@/lib/contract";
import { Button, Card, CardBody, CardHeader, InlineError, TabPanel, Tabs, useToast } from "@/components/ui";
import { ScanSettingsFields, toForm, validateScanSettings, type ScanSettingsErrors, type ScanSettingsForm } from "@/components/domain/ScanSettingsFields";
import { CredentialsCard, projectHosts } from "@/components/domain/Credentials";
import { useProject } from "@/components/workspace/ProjectContext";

const VIEWS = ["scan", "credentials"] as const;
type View = (typeof VIEWS)[number];

/** Default scan settings for future scans (PATCH /projects/{id} with the project version). */
function ScanSettingsCard() {
  const p = useProject();
  const { role } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState<ScanSettingsForm>(toForm(p.project?.settings ?? DEFAULT_SCAN_SETTINGS));
  const [errors, setErrors] = useState<ScanSettingsErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pagesRef = useRef<HTMLInputElement>(null);
  const depthRef = useRef<HTMLInputElement>(null);
  const readOnly = role === "viewer";
  useEffect(() => {
    if (p.project) setForm(toForm(p.project.settings));
  }, [p.project]);

  async function save() {
    if (!p.project) return;
    const { errors: e, settings } = validateScanSettings(form, false);
    setErrors(e);
    setError(null);
    if (!settings) return (e.max_pages ? pagesRef : depthRef).current?.focus();
    setBusy(true);
    try {
      await api<ProjectDetail>(`/projects/${p.id}`, { method: "PATCH", body: { version: p.project.version, settings: { ...p.project.settings, ...settings } } });
      toast("Scan settings saved. They apply to the next scan.");
      p.refresh();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "Someone else changed these settings. Reload the page and try again." : `Couldn’t save the settings. ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Scan settings" description="Defaults for the next scan. Earlier scans keep the settings they ran with." />
      <CardBody className="space-y-4">
        <fieldset disabled={readOnly} className="space-y-4">
          <ScanSettingsFields value={form} onChange={setForm} errors={errors} showName={false} refs={{ max_pages: pagesRef, max_depth: depthRef }} signIn={<p className="text-small text-fg">Test credentials are managed in the Test credentials tab.</p>} />
        </fieldset>
        <InlineError error={error} />
        {readOnly ? (
          <p className="text-small text-fg-muted">Viewers can’t change scan settings.</p>
        ) : (
          <div className="flex justify-end">
            <Button onClick={() => void save()} loading={busy}>
              Save scan settings
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** Project settings (design P2 §3.1, §4.2): scan settings and write-only test credentials. */
function Settings() {
  const p = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get("view") as View | null;
  const view: View = requested && VIEWS.includes(requested) ? requested : "scan";
  const secrets = useApi<SecretMeta[]>(`/projects/${p.id}/secrets`, undefined, { shouldRetryOnError: false });
  useEffect(() => {
    document.title = `Project settings · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [p.project?.name]);
  // "#credentials" links (design §4.1) open the credentials tab.
  useEffect(() => {
    if (window.location.hash === "#credentials" && view !== "credentials") router.replace(`/projects/${p.id}/settings?view=credentials`, { scroll: false });
  }, [p.id, router, view]);
  return (
    <div className="space-y-6">
      <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
        Project settings
      </h1>
      <div>
        <Tabs
          tabs={[
            { id: "scan", label: "Scan settings" },
            { id: "credentials", label: "Test credentials" },
          ]}
          value={view}
          onChange={(v) => router.replace(`/projects/${p.id}/settings?view=${v}`, { scroll: false })}
          label="Project settings"
          idPrefix="settings"
        />
        <TabPanel id={view} idPrefix="settings">
          {view === "scan" ? (
            <ScanSettingsCard />
          ) : (
            <CredentialsCard projectId={p.id} secrets={secrets.data} hosts={projectHosts(p.project)} onChanged={() => void secrets.mutate()} onRescan={p.openRescan} />
          )}
        </TabPanel>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense>
      <Settings />
    </Suspense>
  );
}
