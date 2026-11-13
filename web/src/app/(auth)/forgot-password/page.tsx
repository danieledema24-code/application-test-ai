"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button, Callout, InlineError, TextField } from "@/components/ui";
import { authErrorMessage, isEmail } from "@/components/auth/authErrors";

const LINK = "font-medium text-navy-700 underline underline-offset-4 hover:text-navy-900";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isEmail(email)) {
      setFieldError(email.trim() ? "Enter a valid email address, like name@company.com." : "Enter your email address.");
      ref.current?.focus();
      return;
    }
    setFieldError(null);
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ ok: boolean; dev_reset_link?: string }>("/auth/forgot-password", { body: { email: email.trim() }, noAuthRedirect: true });
      setSent(true);
      setDevLink(res.dev_reset_link || null);
    } catch (err) {
      setError(authErrorMessage(err, "reset"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h1 className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong">Reset your password</h1>
      {sent ? (
        <div className="mt-6 space-y-4" role="status">
          <p className="text-body text-fg">If an account exists for {email}, we’ve sent a link to reset your password.</p>
          {devLink && (
            <Callout tone="warning" title="Development mode">
              Email isn’t configured, so here is the reset link:{" "}
              <a href={devLink} className={`break-all ${LINK}`}>
                Open reset link
              </a>
            </Callout>
          )}
          <Link href="/login" className={`inline-block text-body ${LINK}`}>
            Back to sign in
          </Link>
        </div>
      ) : (
        <>
          <p className="mt-1 text-body text-fg-muted">Enter your email and we’ll send you a reset link.</p>
          <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
            <TextField ref={ref} label="Email" type="email" autoComplete="email" required readOnly={loading} value={email} error={fieldError} onChange={(e) => setEmail(e.target.value)} />
            <InlineError error={error} />
            <Button type="submit" loading={loading} className="w-full">
              {loading ? "Sending…" : "Send reset link"}
            </Button>
          </form>
          <p className="mt-6 text-center text-body">
            <Link href="/login" className={LINK}>
              Back to sign in
            </Link>
          </p>
        </>
      )}
    </>
  );
}
