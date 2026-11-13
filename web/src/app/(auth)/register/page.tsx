"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, type RegisterInput } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { Button, InlineError, PasswordField, TextField } from "@/components/ui";
import { MIN_PASSWORD, authErrorMessage, friendlyFieldError, isEmail, isSubmit } from "@/components/auth/authErrors";

type Key = keyof RegisterInput;
type Errors = Partial<Record<Key, React.ReactNode>>;
const ORDER: Key[] = ["full_name", "email", "password", "organisation_name"];

function validateField(k: Key, v: string): string | undefined {
  if (k === "full_name") return v.trim() ? undefined : "Enter your full name.";
  if (k === "email") return !v.trim() ? "Enter your work email." : isEmail(v) ? undefined : "Enter a valid email address, like name@company.com.";
  if (k === "password") return v.length >= MIN_PASSWORD ? undefined : `Use at least ${MIN_PASSWORD} characters.`;
  if (k === "organisation_name") return v.trim() ? undefined : "Enter your organisation’s name.";
  return undefined;
}

export default function RegisterPage() {
  const { register } = useAuth();
  const router = useRouter();
  const [form, setForm] = useState<RegisterInput>({ full_name: "", email: "", password: "", organisation_name: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refs = { full_name: useRef<HTMLInputElement>(null), email: useRef<HTMLInputElement>(null), password: useRef<HTMLInputElement>(null), organisation_name: useRef<HTMLInputElement>(null) };

  const set = (k: Key) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  // Skip when focus is moving to the submit button: submit validates anyway, and inserting an error
  // here would shift the button under the pointer and swallow the click.
  const blur = (k: Key) => (e: React.FocusEvent<HTMLInputElement>) =>
    !isSubmit(e.relatedTarget) && form[k] && setErrors((x) => ({ ...x, [k]: validateField(k, form[k]) }));

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
      await register({ ...form, full_name: form.full_name.trim(), email: form.email.trim(), organisation_name: form.organisation_name.trim() });
      router.replace("/dashboard");
    } catch (err) {
      setLoading(false);
      if (err instanceof ApiError && err.status === 409) {
        setErrors({
          email: (
            <>
              An account with this email already exists.{" "}
              <Link href="/login" className="underline underline-offset-2">
                Sign in instead.
              </Link>
            </>
          ),
        });
        refs.email.current?.focus();
        return;
      }
      const fe = err instanceof ApiError ? err.fieldErrors : {};
      const firstField = ORDER.find((k) => fe[k]);
      if (firstField) {
        setErrors(Object.fromEntries(ORDER.map((k) => [k, fe[k] ? friendlyFieldError(k, fe[k]) : undefined])) as Errors);
        refs[firstField].current?.focus();
        return;
      }
      setFormError(authErrorMessage(err, "register"));
    }
  }

  return (
    <>
      <h1 className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong">Create your account</h1>
      <p className="mt-1 text-body text-fg-muted">Set up your organisation’s QA workspace. You’ll be its owner.</p>
      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
        <TextField ref={refs.full_name} label="Full name" autoComplete="name" required readOnly={loading} value={form.full_name} onChange={set("full_name")} onBlur={blur("full_name")} error={errors.full_name} />
        <TextField ref={refs.email} label="Work email" type="email" autoComplete="email" required readOnly={loading} value={form.email} onChange={set("email")} onBlur={blur("email")} error={errors.email} />
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
        <TextField
          ref={refs.organisation_name}
          label="Organisation name"
          autoComplete="organization"
          required
          readOnly={loading}
          hint="Shown on your reports. You can change it later."
          value={form.organisation_name}
          onChange={set("organisation_name")}
          onBlur={blur("organisation_name")}
          error={errors.organisation_name}
        />
        <InlineError error={formError} />
        <Button type="submit" loading={loading} className="w-full">
          {loading ? "Creating account…" : "Create account"}
        </Button>
        <p className="text-small text-fg-muted">By creating an account you agree to the Terms and Privacy Policy.</p>
      </form>
      <p className="mt-6 text-center text-body text-fg-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-navy-700 underline underline-offset-4 hover:text-navy-900">
          Sign in
        </Link>
      </p>
    </>
  );
}

