"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { Button, InlineError, TextField } from "@/components/ui";

export default function RegisterPage() {
  const { register } = useAuth();
  const router = useRouter();
  const [form, setForm] = useState({ fullName: "", email: "", password: "", organisationName: "" });
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form.password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await register(form);
      router.replace("/dashboard");
    } catch (err) {
      setError(err);
      setLoading(false);
    }
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Create your workspace</h1>
      <p className="mt-1 text-sm text-slate-600">You’ll be the workspace administrator.</p>
      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        <TextField label="Full name" autoComplete="name" required value={form.fullName} onChange={set("fullName")} />
        <TextField label="Work email" type="email" autoComplete="email" required value={form.email} onChange={set("email")} />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          hint="At least 8 characters."
          value={form.password}
          onChange={set("password")}
        />
        <TextField label="Organisation" autoComplete="organization" required value={form.organisationName} onChange={set("organisationName")} />
        <InlineError error={error} />
        <Button type="submit" loading={loading} className="w-full">
          Create workspace
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-600">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-blue-700 hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
