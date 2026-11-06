"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { Button, InlineError, TextField } from "@/components/ui";

function ResetForm() {
  const params = useSearchParams();
  const token = params.get("token") || "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (password !== confirm) return setError("Passwords don’t match.");
    setLoading(true);
    setError(null);
    try {
      await api("/auth/reset-password", { body: { token, password }, noAuthRedirect: true });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  if (!token)
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">Invalid link</h1>
        <p className="mt-2 text-sm text-fg-muted">This reset link is missing its token.</p>
        <Link href="/forgot-password" className="mt-4 inline-block text-sm font-medium text-fg-strong underline decoration-line-strong underline-offset-4 hover:decoration-fg-strong">
          Request a new link
        </Link>
      </>
    );

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">Choose a new password</h1>
      {done ? (
        <div className="mt-6" role="status">
          <p className="text-sm text-fg">Your password has been reset.</p>
          <Link href="/login" className="mt-4 inline-block text-sm font-medium text-fg-strong underline decoration-line-strong underline-offset-4 hover:decoration-fg-strong">
            Sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-8 space-y-4">
          <TextField label="New password" type="password" autoComplete="new-password" required minLength={8} hint="At least 8 characters." value={password} onChange={(e) => setPassword(e.target.value)} />
          <TextField label="Confirm new password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <InlineError error={error} />
          <Button type="submit" loading={loading} className="w-full">
            Reset password
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
