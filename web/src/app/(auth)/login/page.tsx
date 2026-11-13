"use client";

import Link from "next/link";
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { ApiError, safeNextPath } from "@/lib/api";
import { Button, Callout, InlineError, PasswordField, TextField, useToast } from "@/components/ui";
import { authErrorMessage, isEmail, isSubmit } from "@/components/auth/authErrors";

type Errors = { email?: string; password?: string };

function validate(email: string, password: string): Errors {
  const e: Errors = {};
  if (!email.trim()) e.email = "Enter your email address.";
  else if (!isEmail(email)) e.email = "Enter a valid email address, like name@company.com.";
  if (!password) e.password = "Enter your password.";
  return e;
}

function LoginForm() {
  const { login } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const expired = params.get("reason") === "expired";

  const signedOut = params.get("signed_out") === "1";
  useEffect(() => {
    if (signedOut) {
      toast("You’ve signed out.", "info");
      router.replace("/login");
    }
  }, [signedOut, toast, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const v = validate(email, password);
    setErrors(v);
    setFormError(null);
    if (v.email) return emailRef.current?.focus();
    if (v.password) return passwordRef.current?.focus();
    setLoading(true);
    try {
      await login(email.trim(), password);
      router.replace(safeNextPath(params.get("next")) ?? "/dashboard");
    } catch (err) {
      setLoading(false);
      const fe = err instanceof ApiError ? err.fieldErrors : {};
      if (fe.email || fe.password) {
        setErrors({ email: fe.email, password: fe.password });
        (fe.email ? emailRef : passwordRef).current?.focus();
        return;
      }
      setFormError(authErrorMessage(err, "login"));
      if (err instanceof ApiError && err.status === 401) {
        setPassword("");
        passwordRef.current?.focus();
      }
    }
  }

  return (
    <>
      <h1 className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong">Sign in to QA Analyst</h1>
      {expired && (
        <Callout tone="warning" className="mt-4">
          Your session expired. Sign in again to continue.
        </Callout>
      )}
      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
        <TextField
          ref={emailRef}
          label="Email"
          type="email"
          autoComplete="email"
          required
          readOnly={loading}
          value={email}
          error={errors.email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={(e) => !isSubmit(e.relatedTarget) && email && setErrors((x) => ({ ...x, email: validate(email, "x").email }))}
        />
        <PasswordField
          ref={passwordRef}
          label="Password"
          autoComplete="current-password"
          required
          readOnly={loading}
          value={password}
          error={errors.password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="flex justify-end">
          <Link href="/forgot-password" className="text-body font-medium text-navy-700 underline underline-offset-4 hover:text-navy-900">
            Forgot password?
          </Link>
        </div>
        <InlineError error={formError} />
        <Button type="submit" loading={loading} className="w-full">
          {loading ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <p className="mt-6 text-center text-body text-fg-muted">
        New here?{" "}
        <Link href="/register" className="font-medium text-navy-700 underline underline-offset-4 hover:text-navy-900">
          Create an account
        </Link>
      </p>
    </>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
