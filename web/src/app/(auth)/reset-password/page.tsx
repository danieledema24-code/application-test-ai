"use client";

import Link from "next/link";
import { Suspense, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { Button, InlineError, PasswordField } from "@/components/ui";
import { MIN_PASSWORD, authErrorMessage } from "@/components/auth/authErrors";

const LINK = "font-medium text-navy-700 underline underline-offset-4 hover:text-navy-900";

function ResetForm() {
  const params = useSearchParams();
  const token = params.get("token") || "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pwRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const v: typeof errors = {};
    if (password.length < MIN_PASSWORD) v.password = `Use at least ${MIN_PASSWORD} characters.`;
    else if (password !== confirm) v.confirm = "The passwords don’t match.";
    setErrors(v);
    if (v.password) return pwRef.current?.focus();
    if (v.confirm) return confirmRef.current?.focus();
    setLoading(true);
    setError(null);
    try {
      await api("/auth/reset-password", { body: { token, password }, noAuthRedirect: true });
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError && (err.status === 400 || err.status === 404 || err.status === 422) && !err.fieldErrors.password
          ? "This reset link is invalid or has expired. Request a new one."
          : authErrorMessage(err, "reset"),
      );
    } finally {
      setLoading(false);
    }
  }

  if (!token)
    return (
      <>
        <h1 className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong">This link isn’t valid</h1>
        <p className="mt-2 text-body text-fg-muted">The reset link is missing its token.</p>
        <Link href="/forgot-password" className={`mt-4 inline-block text-body ${LINK}`}>
          Request a new link
        </Link>
      </>
    );

  return (
    <>
      <h1 className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong">Choose a new password</h1>
      {done ? (
        <div className="mt-6" role="status">
          <p className="text-body text-fg">Your password has been reset. Sign in with your new password.</p>
          <Link href="/login" className={`mt-4 inline-block text-body ${LINK}`}>
            Sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
          <PasswordField ref={pwRef} label="New password" autoComplete="new-password" required hint={`At least ${MIN_PASSWORD} characters.`} value={password} error={errors.password} onChange={(e) => setPassword(e.target.value)} />
          <PasswordField ref={confirmRef} label="Confirm new password" autoComplete="new-password" required value={confirm} error={errors.confirm} onChange={(e) => setConfirm(e.target.value)} />
          <InlineError error={error} />
          <Button type="submit" loading={loading} className="w-full">
            {loading ? "Saving…" : "Reset password"}
          </Button>
        </form>
      )}
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
