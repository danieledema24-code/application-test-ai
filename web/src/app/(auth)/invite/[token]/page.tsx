"use client";

import { useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import { api, ApiError, setToken } from "@/lib/api";
import type { InvitationLookup } from "@/lib/contract";
import { useAuth } from "@/lib/auth";
import { fmtDate } from "@/lib/format";
import { ROLE_INVITE_LINE, ROLE_TEXT } from "@/lib/members";
import { Button, Callout, EmptyState, InlineError, LinkButton, PasswordField, Skeleton, TextField, useToast } from "@/components/ui";
import { MIN_PASSWORD, authErrorMessage, friendlyFieldError, isSubmit } from "@/components/auth/authErrors";

type Key = "full_name" | "password";
type Errors = Partial<Record<Key, string>>;
const ORDER: Key[] = ["full_name", "password"];

function validateField(k: Key, v: string): string | undefined {
  if (k === "full_name") return v.trim() ? undefined : "Enter your full name.";
  return v.length >= MIN_PASSWORD ? undefined : `Use at least ${MIN_PASSWORD} characters.`;
}

const INVALID = "This invitation is no longer valid. Ask the person who invited you for a new link.";

/** Accept invitation (design P3 §17.3). The token is never shown on the page or in the title. */
export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const toast = useToast();
  const { user, acceptInvite, refresh } = useAuth();
  // 404 is an expected state here; no retries, no console noise beyond the request itself.
  const lookup = useSWR<InvitationLookup>(token ? `/invitations/${token}` : null, (k: string) => api<InvitationLookup>(k, { noAuthRedirect: true }), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  const [form, setForm] = useState({ full_name: "", password: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const refs = { full_name: useRef<HTMLInputElement>(null), password: useRef<HTMLInputElement>(null) };

  const set = (k: Key) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const blur = (k: Key) => (e: React.FocusEvent<HTMLInputElement>) => !isSubmit(e.relatedTarget) && form[k] && setErrors((x) => ({ ...x, [k]: validateField(k, form[k]) }));

  async function signOutAndContinue() {
    setSigningOut(true);
    try {
      await api("/auth/logout", { method: "POST", noAuthRedirect: true });
    } catch {
      /* sign out locally regardless */
    }
    setToken(null);
    await refresh();
    setSigningOut(false);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const v: Errors = {};
    for (const k of ORDER) v[k] = validateField(k, form[k]);
    setErrors(v);
    setFormError(null);
    const first = ORDER.find((k) => v[k]);
    if (first) return refs[first].current?.focus();
    setLoading(true);
    try {
      await acceptInvite(token, { full_name: form.full_name.trim(), password: form.password });
      toast(`Welcome to ${lookup.data?.organisation_name ?? "your workspace"}.`, "success");
      router.replace("/dashboard");
    } catch (err) {
      setLoading(false);
      if (err instanceof ApiError && err.status === 404) {
        void lookup.mutate();
        return;
      }
      const fe = err instanceof ApiError ? err.fieldErrors : {};
      const firstField = ORDER.find((k) => fe[k]);
      if (firstField) {
        setErrors(Object.fromEntries(ORDER.map((k) => [k, fe[k] ? friendlyFieldError(k, fe[k]) : undefined])) as Errors);
        refs[firstField].current?.focus();
        return;
      }
      setFormError(err instanceof ApiError && err.status === 429 ? authErrorMessage(err, "register") : "Couldn’t create your account. Try again.");
    }
  }

  if (lookup.error instanceof ApiError && lookup.error.status === 404)
    return (
      <>
        <h1 className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong">Invitation not valid</h1>
        <EmptyState className="mt-4" title={INVALID} action={<LinkButton href="/login">Go to sign in</LinkButton>} />
      </>
    );
  if (lookup.error)
    return (
      <>
        <h1 className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong">Join a workspace</h1>
        <InlineError error={authErrorMessage(lookup.error, "register")} />
        <Button variant="secondary" className="mt-4" onClick={() => void lookup.mutate()}>
          Try again
        </Button>
      </>
    );
  if (!lookup.data)
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading invitation">
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );

  const inv = lookup.data;
  return (
    <>
      <h1 className="break-words text-h1 font-semibold tracking-[-0.015em] text-fg-strong">Join {inv.organisation_name} on QA Analyst</h1>
      <p className="mt-1 text-body text-fg">
        {inv.invited_by_name} invited you as {inv.role === "admin" ? "an" : "a"} {ROLE_TEXT[inv.role]}.
      </p>
      <p className="mt-1 text-body text-fg-muted">{ROLE_INVITE_LINE[inv.role]}</p>
      {inv.email_hint && <p className="mt-1 text-body text-fg-muted">This invitation is for {inv.email_hint}.</p>}
      <p className="mt-1 text-small text-fg-muted">Expires {fmtDate(inv.expires_at)}.</p>
      {user ? (
        <Callout
          className="mt-6"
          tone="warning"
          actions={
            <Button variant="secondary" onClick={() => void signOutAndContinue()} loading={signingOut}>
              Sign out and continue
            </Button>
          }
        >
          You’re signed in as {user.email}. This invitation creates a new account. Sign out to accept it.
        </Callout>
      ) : (
        <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
          <TextField ref={refs.full_name} label="Full name" autoComplete="name" required readOnly={loading} value={form.full_name} onChange={set("full_name")} onBlur={blur("full_name")} error={errors.full_name} />
          <PasswordField
            ref={refs.password}
            label="Password"
            autoComplete="new-password"
            required
            readOnly={loading}
            hint={`At least ${MIN_PASSWORD} characters.`}
            value={form.password}
            onChange={set("password")}
            onBlur={blur("password")}
            error={errors.password}
          />
          <InlineError error={formError} />
          <Button type="submit" loading={loading} className="w-full">
            {loading ? "Creating account…" : "Create account and join"}
          </Button>
          <p className="text-small text-fg-muted">By joining you’ll be signed in to {inv.organisation_name}.</p>
        </form>
      )}
    </>
  );
}
