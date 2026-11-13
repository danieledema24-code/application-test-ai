"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, CircleCheck, ExternalLink } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { DEFAULT_SCAN_SETTINGS, type ProjectCreate, type ProjectDetail } from "@/lib/contract";
import { URL_COPY, checkUrlClientSide, hostOf, interpretUrlCheck } from "@/lib/url";
import { useClientUrlPolicy, useUrlCheck } from "@/lib/useUrlCheck";
import { duplicateFromError, type DuplicateProject } from "@/lib/projectStatus";
import { useOnline } from "@/lib/useOnline";
import { Button, Callout, Card, CardBody, CardHeader, Disclosure, InlineError, LinkButton, PageHeader, Spinner, TextField, useToast } from "@/components/ui";
import { AuthorisationConfirm, attestationStatement } from "@/components/domain/AuthorisationConfirm";
import { ScanSettingsFields, toForm, validateScanSettings, type ScanSettingsErrors, type ScanSettingsForm } from "@/components/domain/ScanSettingsFields";
import {
  CredentialsFields,
  EMPTY_CREDENTIALS,
  validateCredentials,
  type CredentialsErrors,
  type CredentialsFieldsHandle,
  type CredentialsForm,
} from "@/components/domain/Credentials";

function NewProject() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const online = useOnline();

  const [urlInput, setUrlInput] = useState(params.get("url") ?? "");
  // The URL actually being checked: changes on "Check again", not on every keystroke.
  const [checkedInput, setCheckedInput] = useState(urlInput);
  const { blockPrivate } = useClientUrlPolicy();
  const client = useMemo(() => checkUrlClientSide(checkedInput, { blockPrivate }), [checkedInput, blockPrivate]);
  const { state: check, recheck, settled } = useUrlCheck(client.ok ? client.url : null, 0);

  const [authorised, setAuthorised] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<ScanSettingsForm>(toForm(DEFAULT_SCAN_SETTINGS));
  const [nameTouched, setNameTouched] = useState(false);
  const [settingsErrors, setSettingsErrors] = useState<ScanSettingsErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [serverUrlError, setServerUrlError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateProject | null>(null);
  const [creds, setCreds] = useState<CredentialsForm>(EMPTY_CREDENTIALS);
  const [credErrors, setCredErrors] = useState<CredentialsErrors>({});
  const credRef = useRef<CredentialsFieldsHandle>(null);

  const urlRef = useRef<HTMLInputElement>(null);
  const authRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const pagesRef = useRef<HTMLInputElement>(null);
  const depthRef = useRef<HTMLInputElement>(null);

  const verdict = check.status === "done" ? interpretUrlCheck(check.result) : null;
  const scopeHost = verdict?.scopeHost || (client.ok ? client.host : "");

  // Default project name = final host, until the user edits it.
  useEffect(() => {
    if (!nameTouched && scopeHost) setSettings((s) => ({ ...s, name: scopeHost }));
  }, [scopeHost, nameTouched]);

  // S8 (sign-in required) auto-expands the settings so the user sees what discovery will cover.
  useEffect(() => {
    if (verdict?.warnings.some((w) => w.startsWith("The page requires sign-in"))) setSettingsOpen(true);
  }, [verdict]);

  useEffect(() => {
    document.title = "Start QA analysis · QA Analyst";
  }, []);

  const [attempted, setAttempted] = useState(false);
  const checkError = !client.ok
    ? client.code === "C1" && !attempted
      ? null
      : client.message
    : serverUrlError
      ? serverUrlError
      : check.status === "error"
        ? URL_COPY.unavailable
        : verdict && !verdict.ok
          ? verdict.error
          : null;

  function checkAgain() {
    setAttempted(true);
    setServerUrlError(null);
    setDuplicate(null);
    if (urlInput.trim() === checkedInput.trim()) void recheck();
    else setCheckedInput(urlInput);
  }

  async function submit(confirmDuplicate = false) {
    setAttempted(true);
    setSubmitError(null);
    if (!online) {
      setSubmitError("You’re offline. Connect to the internet to start an analysis.");
      return;
    }
    if (urlInput.trim() !== checkedInput.trim()) {
      // The user edited the URL without re-checking: check the new one first.
      setCheckedInput(urlInput);
      urlRef.current?.focus();
      return;
    }
    if (!client.ok) return urlRef.current?.focus();
    setSubmitting(true);
    const s = await settled();
    const v = s.status === "done" ? interpretUrlCheck(s.result) : null;
    if (s.status === "error" || (v && !v.ok)) {
      setSubmitting(false);
      urlRef.current?.focus();
      return;
    }
    if (!authorised) {
      setSubmitting(false);
      setAuthError(URL_COPY.unticked);
      authRef.current?.focus();
      return;
    }
    const { errors, settings: scan } = validateScanSettings(settings, true);
    setSettingsErrors(errors);
    if (!scan) {
      setSubmitting(false);
      setSettingsOpen(true);
      // Wait for the disclosure to render its fields before focusing.
      setTimeout(() => (errors.name ? nameRef : errors.max_pages ? pagesRef : depthRef).current?.focus(), 0);
      return;
    }

    const host = v?.scopeHost || client.host;
    // Credentials are optional: all three or none (P1 S16), on the project's host (S17).
    const ce = validateCredentials(creds, [host], false);
    setCredErrors(ce);
    if (Object.keys(ce).length) {
      setSubmitting(false);
      setSettingsOpen(true);
      setTimeout(() => credRef.current?.focusFirstError(ce), 0);
      return;
    }
    const withCreds = !!creds.login_url.trim();
    const body: ProjectCreate = {
      url: v?.finalUrl || client.url,
      name: settings.name.trim() || host,
      authorisation: { attested: true, statement: attestationStatement(host) },
      scan: withCreds ? { ...scan, use_credentials: true } : scan,
      ...(withCreds ? { credentials: { login_url: creds.login_url.trim(), username: creds.username, password: creds.password } } : {}),
      start: true,
      ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
    };
    try {
      const project = await api<ProjectDetail>("/projects", { body });
      toast("Project created. Discovery has started.");
      router.replace(`/projects/${project.id}/discovery?view=live&created=1`);
    } catch (err) {
      setSubmitting(false);
      if (!(err instanceof ApiError)) {
        setSubmitError(URL_COPY.createFailed);
        return;
      }
      const dup = duplicateFromError(err);
      if (dup) {
        setDuplicate(dup);
        return;
      }
      if (err.code === "url_blocked" || err.code === "url_unreachable") {
        setServerUrlError(err.code === "url_blocked" ? err.message || URL_COPY.privateAddress(host) : URL_COPY.timeout(client.url));
        urlRef.current?.focus();
        return;
      }
      if (err.status === 429) {
        const at = err.retryAfter ? new Date(Date.now() + err.retryAfter * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : null;
        setSubmitError(`You’ve started too many analyses in the last hour.${at ? ` You can start another at ${at}.` : " Try again later."}`);
        return;
      }
      const fe = err.fieldErrors;
      if (fe.url) {
        setServerUrlError(fe.url);
        urlRef.current?.focus();
        return;
      }
      if (fe.attested || fe.statement) {
        setAuthError(URL_COPY.unticked);
        authRef.current?.focus();
        return;
      }
      if (fe.name || fe.max_pages || fe.max_depth) {
        setSettingsErrors({ name: fe.name, max_pages: fe.max_pages, max_depth: fe.max_depth });
        setSettingsOpen(true);
        return;
      }
      setSubmitError(URL_COPY.createFailed);
    }
  }

  return (
    <div className="mx-auto max-w-[760px]">
      <PageHeader title="Start QA analysis" description="Step 1 of the QA lifecycle: Application Discovery." />
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
        className="space-y-6"
      >
        <Card>
          <CardHeader title="Website" />
          <CardBody className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <TextField
                ref={urlRef}
                label="Website URL"
                type="url"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    checkAgain();
                  }
                }}
                error={checkError}
                wrapClassName="flex-1"
                className="font-mono"
              />
              <Button variant="secondary" onClick={checkAgain} className="sm:mt-7">
                Check again
              </Button>
            </div>
            <SiteSummary state={check} verdict={verdict} hasError={!!checkError} />
          </CardBody>
        </Card>

        {duplicate && (
          <Callout
            tone="warning"
            role="alert"
            title={`You already have a project for ${hostOf(duplicate.url) || scopeHost}.`}
            actions={
              <>
                <LinkButton href={`/projects/${duplicate.id}`} variant="secondary">
                  Open project{duplicate.name ? `: ${duplicate.name}` : ""}
                </LinkButton>
                <Button variant="primary" loading={submitting} onClick={() => void submit(true)}>
                  Create anyway
                </Button>
              </>
            }
          >
            Re-scanning inside the existing project keeps its history. You can still create a separate project.
          </Callout>
        )}

        <Card>
          <CardHeader title="Gate 1 · Authorisation" />
          <CardBody>
            <AuthorisationConfirm
              ref={authRef}
              host={scopeHost}
              checked={authorised}
              onChange={(v) => {
                setAuthorised(v);
                if (v) setAuthError(null);
              }}
              error={authError}
            />
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <Disclosure
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
              label="Show scan settings (optional)"
              openLabel="Hide scan settings"
              headingLevel={2}
              buttonClassName="text-h3 font-semibold"
            >
              <div className="mt-4">
                <ScanSettingsFields
                  value={settings}
                  onChange={(v) => {
                    if (v.name !== settings.name) setNameTouched(true);
                    setSettings(v);
                  }}
                  errors={settingsErrors}
                  showName
                  refs={{ name: nameRef, max_pages: pagesRef, max_depth: depthRef }}
                  signIn={
                    <div className="space-y-3">
                      <p className="text-small text-fg">
                        Optional. With a dedicated test account, discovery submits the sign-in form only and covers signed-in pages. Leave all three empty to cover public pages only.
                      </p>
                      <CredentialsFields ref={credRef} value={creds} onChange={setCreds} errors={credErrors} placeholderHost={scopeHost || undefined} />
                      <p className="text-small text-fg-muted">Saved encrypted and used only by the discovery browser. You won’t be able to see these values again.</p>
                    </div>
                  }
                />
              </div>
            </Disclosure>
          </CardBody>
        </Card>

        <InlineError error={submitError} />
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <LinkButton href="/dashboard" variant="secondary">
            Cancel
          </LinkButton>
          <Button type="submit" loading={submitting} icon={<ArrowRight className="h-4 w-4" aria-hidden />} className="flex-row-reverse">
            {submitting ? "Starting…" : "Start QA Analysis"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function SiteSummary({
  state,
  verdict,
  hasError,
}: {
  state: ReturnType<typeof useUrlCheck>["state"];
  verdict: ReturnType<typeof interpretUrlCheck> | null;
  hasError: boolean;
}) {
  if (state.status === "checking") return <Spinner label={`Checking ${state.url}…`} />;
  if (state.status !== "done" || !verdict || hasError) return null;
  const r = state.result;
  return (
    <div className="space-y-3" role="status">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body">
        <span className="inline-flex items-center gap-1.5 font-medium text-success-fg">
          <CircleCheck className="h-4 w-4" aria-hidden /> Reachable
        </span>
        {r.http_status && <span className="text-fg-muted">· HTTP {r.http_status}</span>}
        {r.page_title && <span className="text-fg-muted">· “{r.page_title}”</span>}
      </p>
      {verdict.info.map((m) => (
        <Callout key={m} tone="info">
          {m}
        </Callout>
      ))}
      {verdict.warnings.map((m) => (
        <Callout key={m} tone="warning">
          {m}
        </Callout>
      ))}
      <p className="text-small text-fg-muted">
        Scope: pages on <span className="font-medium text-fg-strong">{verdict.scopeHost}</span> only. Links to other sites are listed, not visited.{" "}
        <a href={verdict.finalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-navy-700 underline underline-offset-2">
          Open site <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">(opens in new tab)</span>
        </a>
      </p>
    </div>
  );
}

export default function NewProjectPage() {
  return (
    <Suspense>
      <NewProject />
    </Suspense>
  );
}
