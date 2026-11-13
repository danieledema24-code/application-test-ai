"use client";

import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { CircleCheck, KeyRound, TriangleAlert } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { SecretMeta } from "@/lib/contract";
import { fmtDateTime } from "@/lib/format";
import { hostOf } from "@/lib/url";
import { Button, Callout, Card, CardBody, CardHeader, Checkbox, ConfirmDialog, InlineError, PasswordField, TextField, useToast } from "@/components/ui";

export type CredentialsForm = { login_url: string; username: string; password: string };
export type CredentialsErrors = Partial<Record<keyof CredentialsForm | "confirm", string>>;

export const EMPTY_CREDENTIALS: CredentialsForm = { login_url: "", username: "", password: "" };

/** Copy for sign-in failure reasons (design P2 §4.3 access-gap vocabulary). */
export function signInReason(code: string | null | undefined, loginUrl?: string | null): string {
  switch (code) {
    case "rejected":
      return "the site rejected the username or password";
    case "form_not_found":
      return `no sign-in form found at ${loginUrl ? safePath(loginUrl) : "the sign-in page"}`;
    case "captcha":
    case "mfa_required":
      return "extra verification required (two-step code or CAPTCHA)";
    case "timeout":
      return "still on the sign-in page after submitting";
    case "blocked":
      return "the site blocked the sign-in attempt";
    default:
      return "the sign-in didn’t complete";
  }
}

function safePath(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
}

/**
 * Validates credentials. `required`: all three must be filled (settings, re-scan); otherwise all-or-none
 * (P1 S16). The sign-in page must be on one of the project's hosts (P1 S17).
 */
export function validateCredentials(f: CredentialsForm, hosts: string[], required: boolean): CredentialsErrors {
  const e: CredentialsErrors = {};
  const any = !!(f.login_url.trim() || f.username || f.password);
  if (!any && !required) return e;
  const partial = "Enter a sign-in page URL, username and password, or leave all three empty.";
  if (!f.login_url.trim()) e.login_url = required ? "Enter the sign-in page URL." : partial;
  if (!f.username) e.username = required ? "Enter the username or email." : partial;
  if (!f.password) e.password = required ? "Enter the password." : partial;
  if (f.login_url.trim() && !e.login_url) {
    let host = "";
    try {
      const u = new URL(f.login_url.trim());
      host = u.hostname;
      if (u.protocol !== "http:" && u.protocol !== "https:") host = "";
    } catch {
      host = "";
    }
    if (!host) e.login_url = "Enter a valid URL, like https://example.com/login.";
    else if (hosts.length && !hosts.some((h) => h === host || h.replace(/^www\./, "") === host.replace(/^www\./, ""))) e.login_url = `The sign-in page must be on ${hosts[0]}.`;
  }
  return e;
}

export type CredentialsFieldsHandle = { focusFirstError: (e: CredentialsErrors) => void };

/** The three credential fields, shared by Start QA Analysis, the re-scan dialog and Project settings. */
export const CredentialsFields = forwardRef<
  CredentialsFieldsHandle,
  { value: CredentialsForm; onChange: (v: CredentialsForm) => void; errors: CredentialsErrors; disabled?: boolean; placeholderHost?: string }
>(function CredentialsFields({ value, onChange, errors, disabled, placeholderHost }, ref) {
  const urlRef = useRef<HTMLInputElement>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({
    focusFirstError: (e) => (e.login_url ? urlRef : e.username ? userRef : pwRef).current?.focus(),
  }));
  const set = (k: keyof CredentialsForm, v: string) => onChange({ ...value, [k]: v });
  return (
    <div className="space-y-3">
      <TextField
        ref={urlRef}
        label="Sign-in page URL"
        type="url"
        inputMode="url"
        placeholder={placeholderHost ? `https://${placeholderHost}/login` : "https://example.com/login"}
        value={value.login_url}
        onChange={(e) => set("login_url", e.target.value)}
        error={errors.login_url}
        readOnly={disabled}
      />
      <TextField ref={userRef} label="Username or email" autoComplete="off" value={value.username} onChange={(e) => set("username", e.target.value)} error={errors.username} readOnly={disabled} />
      <PasswordField ref={pwRef} label="Password" autoComplete="off" value={value.password} onChange={(e) => set("password", e.target.value)} error={errors.password} readOnly={disabled} />
    </div>
  );
});

const GUIDANCE = [
  "Create an account only for testing. Never use a real customer’s or a colleague’s account.",
  "Give it the least access needed. Avoid admin accounts unless you want admin pages covered.",
  "Two-step verification and CAPTCHAs can’t be completed by discovery.",
  "Signed-in pages are screenshotted. Use an account that holds test data only.",
];

export function CredentialsGuidance() {
  return (
    <Callout tone="warning" title="Use a dedicated test account">
      <ul className="list-disc space-y-0.5 pl-5">
        {GUIDANCE.map((g) => (
          <li key={g}>{g}</li>
        ))}
      </ul>
    </Callout>
  );
}

/** Last sign-in line (design §4.4). Never shows the values. */
export function lastSignInText(meta: SecretMeta): { tone: "ok" | "warn" | "none"; text: string } {
  if (meta.last_result === "succeeded") return { tone: "ok", text: `Signed in${meta.last_used_at ? ` · ${fmtDateTime(meta.last_used_at)}` : ""}` };
  if (meta.last_result === "failed") return { tone: "warn", text: `Sign-in failed${meta.last_used_at ? ` (${fmtDateTime(meta.last_used_at)})` : ""}: ${signInReason(meta.last_reason_code, meta.login_url)}` };
  return { tone: "none", text: "Saved. Not used yet. Re-scan to sign in." };
}

/**
 * Project settings → Test credentials (design P2 §4.2). Write-only: after saving, the username and password
 * are never rendered ("Saved (hidden)", never asterisks); Replace starts with empty fields. Owners and admins
 * only; others see the status rows and a note.
 */
export function CredentialsCard({
  projectId,
  secrets,
  hosts,
  onChanged,
  onRescan,
}: {
  projectId: string;
  secrets: SecretMeta[] | undefined;
  hosts: string[];
  onChanged: () => void;
  onRescan: () => void;
}) {
  const { canApprove } = useAuth();
  const toast = useToast();
  const meta = secrets?.find((s) => s.name === "scan_credentials" || s.kind === "login_credentials") ?? null;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<CredentialsForm>(EMPTY_CREDENTIALS);
  const [confirmed, setConfirmed] = useState(false);
  const [errors, setErrors] = useState<CredentialsErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [testing, setTesting] = useState(false);
  const fieldsRef = useRef<CredentialsFieldsHandle>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const showForm = canApprove && (editing || !meta);

  function startReplace() {
    // The sign-in page isn't secret, so it's prefilled; the username and password never are.
    setForm({ login_url: meta?.login_url ?? "", username: "", password: "" });
    setConfirmed(false);
    setErrors({});
    setSaveError(null);
    setEditing(true);
  }

  async function save() {
    const e = validateCredentials(form, hosts, true);
    if (!confirmed) e.confirm = "Confirm this is a dedicated test account.";
    setErrors(e);
    if (Object.keys(e).length) {
      if (e.login_url || e.username || e.password) fieldsRef.current?.focusFirstError(e);
      else confirmRef.current?.focus();
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await api<SecretMeta>(`/projects/${projectId}/secrets/scan_credentials`, { method: "PUT", body: { login_url: form.login_url.trim(), username: form.username, password: form.password } });
      setForm(EMPTY_CREDENTIALS);
      setEditing(false);
      setJustSaved(true);
      toast("Test credentials saved. Re-scan to use them.");
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && err.fieldErrors.login_url) {
        setErrors({ login_url: hosts[0] ? `The sign-in page must be on ${hosts[0]}.` : err.fieldErrors.login_url });
        fieldsRef.current?.focusFirstError({ login_url: "x" });
      } else if (err instanceof ApiError && err.status === 403) setSaveError("Only owners and admins can change test credentials.");
      else setSaveError("Couldn’t save the credentials. Nothing was changed. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function testSignIn() {
    setTesting(true);
    try {
      await api(`/projects/${projectId}/secrets/scan_credentials/test`, { method: "POST" });
      toast("Testing sign-in. The result appears here and in the activity feed.", "info");
      setTimeout(onChanged, 4000);
    } catch (err) {
      toast(err instanceof ApiError && err.status === 429 ? "Sign-in was tested several times recently. Try again in a few minutes." : "Couldn’t test sign-in. Try again.", "error");
    } finally {
      setTesting(false);
    }
  }

  const last = meta ? lastSignInText(meta) : null;
  const rowCls = "grid grid-cols-[9rem_1fr] gap-2 py-1";
  return (
    <Card>
      <CardHeader title="Test credentials" />
      <CardBody className="space-y-4">
        <CredentialsGuidance />
        {!secrets ? (
          <p className="text-body text-fg-muted">Loading credentials…</p>
        ) : !meta ? (
          <p className="text-body text-fg">No test credentials. Discovery covers public pages only.</p>
        ) : (
          <dl className="text-body">
            <div className={rowCls}>
              <dt className="text-fg-muted">Status</dt>
              <dd className="flex items-center gap-1.5 text-fg-strong">
                <CircleCheck className="h-4 w-4 text-success-fg" aria-hidden />
                Saved · added by {meta.created_by?.full_name || meta.created_by?.email || "a team member"}, {fmtDateTime(meta.rotated_at ?? meta.created_at)}
              </dd>
            </div>
            <div className={rowCls}>
              <dt className="text-fg-muted">Sign-in page</dt>
              <dd className="break-all font-mono text-fg">{meta.login_url ?? "—"}</dd>
            </div>
            <div className={rowCls}>
              <dt className="text-fg-muted">Username</dt>
              <dd className="text-fg">Saved (hidden)</dd>
            </div>
            <div className={rowCls}>
              <dt className="text-fg-muted">Password</dt>
              <dd className="text-fg">Saved (hidden)</dd>
            </div>
            <div className={rowCls}>
              <dt className="text-fg-muted">Last sign-in</dt>
              <dd className={`flex items-center gap-1.5 ${last?.tone === "ok" ? "text-success-fg" : last?.tone === "warn" ? "text-warning-fg" : "text-fg"}`}>
                {last?.tone === "ok" && <CircleCheck className="h-4 w-4" aria-hidden />}
                {last?.tone === "warn" && <TriangleAlert className="h-4 w-4" aria-hidden />}
                {last?.text}
              </dd>
            </div>
          </dl>
        )}

        {!canApprove && <p className="text-body text-fg-muted">Only owners and admins can change test credentials.</p>}

        {canApprove && meta && !editing && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant={justSaved || last?.tone !== "warn" ? "primary" : "secondary"}
              icon={<KeyRound className="h-4 w-4" aria-hidden />}
              onClick={onRescan}
            >
              Re-scan with sign-in
            </Button>
            <Button variant={last?.tone === "warn" && !justSaved ? "primary" : "secondary"} onClick={startReplace}>
              Replace credentials
            </Button>
            <Button variant="secondary" onClick={() => void testSignIn()} loading={testing}>
              Test sign-in
            </Button>
            <Button variant="ghost" className="text-danger-fg" onClick={() => setRemoveOpen(true)}>
              Remove credentials
            </Button>
          </div>
        )}

        {showForm && (
          <form
            noValidate
            className="space-y-3 border-t border-line pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <CredentialsFields ref={fieldsRef} value={form} onChange={setForm} errors={errors} disabled={saving} placeholderHost={hosts[0]} />
            <Checkbox
              ref={confirmRef}
              label="This is a dedicated test account, not a real person’s account."
              description="Your confirmation is recorded with your name and the time."
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              error={errors.confirm}
              required
            />
            <p className="text-small text-fg-muted">Saved encrypted and used only by the discovery browser. You won’t be able to see these values again; to change them, replace them.</p>
            <InlineError error={saveError} />
            <div className="flex gap-2">
              {meta && (
                <Button variant="secondary" onClick={() => setEditing(false)} disabled={saving}>
                  Cancel
                </Button>
              )}
              <Button type="submit" loading={saving}>
                {saving ? "Saving…" : "Save credentials"}
              </Button>
            </div>
          </form>
        )}
      </CardBody>
      <ConfirmDialog
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        title="Remove test credentials?"
        confirmLabel="Remove credentials"
        danger
        loading={removing}
        onConfirm={async () => {
          if (!meta) return;
          setRemoving(true);
          try {
            await api(`/projects/${projectId}/secrets/${meta.id}`, { method: "DELETE" });
            toast("Test credentials removed.");
            setRemoveOpen(false);
            onChanged();
          } catch {
            toast("Couldn’t remove the credentials. Try again.", "error");
          } finally {
            setRemoving(false);
          }
        }}
      >
        <p>Future scans will cover public pages only. Earlier scans and their evidence are kept.</p>
      </ConfirmDialog>
    </Card>
  );
}

/** Hosts a sign-in page may be on, from the project's URLs. */
export function projectHosts(p: { primary_url?: string; urls?: { allowed_hosts: string[] }[] } | null | undefined): string[] {
  const hosts = (p?.urls ?? []).flatMap((u) => u.allowed_hosts ?? []);
  const primary = hostOf(p?.primary_url);
  return [...new Set([...(primary ? [primary] : []), ...hosts])];
}
