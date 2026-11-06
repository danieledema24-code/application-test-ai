"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { Button, InlineError, TextField } from "@/components/ui";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ ok: boolean; devResetLink?: string }>("/auth/forgot-password", { body: { email }, noAuthRedirect: true });
      setSent(true);
      setDevLink(res.devResetLink || null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">Reset your password</h1>
      {sent ? (
        <div className="mt-6 space-y-4" role="status">
          <p className="text-sm text-fg">If an account exists for {email}, a reset link has been sent.</p>
          {devLink && (
            <div className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-200 ring-1 ring-inset ring-amber-600/30">
              <p className="font-medium">Development mode</p>
              <p className="mt-1">Email isn’t configured, so here is the reset link:</p>
              <a href={devLink} className="mt-1 block break-all font-medium text-fg-strong underline decoration-line-strong underline-offset-4 hover:decoration-fg-strong">
                {devLink}
              </a>
            </div>
          )}
          <Link href="/login" className="inline-block text-sm font-medium text-fg-strong underline decoration-line-strong underline-offset-4 hover:decoration-fg-strong">
            Back to sign in
          </Link>
        </div>
      ) : (
        <>
          <p className="mt-1 text-sm text-fg-muted">Enter your work email and we’ll send you a reset link.</p>
          <form onSubmit={onSubmit} className="mt-8 space-y-4">
            <TextField label="Work email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <InlineError error={error} />
            <Button type="submit" loading={loading} className="w-full">
              Send reset link
            </Button>
          </form>
          <p className="mt-6 text-center text-sm">
            <Link href="/login" className="font-medium text-fg-strong underline decoration-line-strong underline-offset-4 hover:decoration-fg-strong">
              Back to sign in
            </Link>
          </p>
        </>
      )}
    </>
  );
}
