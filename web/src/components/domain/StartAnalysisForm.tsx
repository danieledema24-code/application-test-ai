"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { ArrowRight, CircleCheck, CircleX, Info } from "lucide-react";
import { checkUrlClientSide, interpretUrlCheck } from "@/lib/url";
import { useClientUrlPolicy, useUrlCheck } from "@/lib/useUrlCheck";
import { Button, Spinner } from "@/components/ui";
import { inputClass } from "@/components/ui/Field";
import { useOnline } from "@/lib/useOnline";

/**
 * Website URL + "Start QA Analysis" (design spec §5). Client checks C1–C5 run on submit; a URL
 * without a scheme gets https:// and a hint, not an error. On success → /projects/new?url=…
 */
export function StartAnalysisForm({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter();
  const online = useOnline();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const id = useId();

  const policy = useClientUrlPolicy();
  const check = value.trim() ? checkUrlClientSide(value, policy) : null;
  const live = useUrlCheck(check?.ok ? check.url : null, 800);
  const hint = check?.ok && check.addedScheme ? `We’ll analyse ${check.url}` : "Public websites only. You’ll confirm you’re authorised to test it next.";

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!online) {
      setError("You’re offline. Connect to the internet to start an analysis.");
      return;
    }
    const r = checkUrlClientSide(value, policy);
    if (!r.ok) {
      setError(r.message);
      ref.current?.focus();
      return;
    }
    setError(null);
    router.push(`/projects/new?url=${encodeURIComponent(r.url)}`);
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Start a QA analysis">
      <label htmlFor={id} className="mb-1 block text-body font-medium text-fg-strong">
        Website URL
      </label>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          ref={ref}
          id={id}
          name="url"
          type="url"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          autoFocus={autoFocus}
          placeholder="https://"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
          className={`${inputClass} h-12 text-body-lg sm:flex-1`}
        />
        <Button type="submit" size="lg" icon={<ArrowRight className="h-5 w-5" aria-hidden />} className="flex-row-reverse">
          Start QA Analysis
        </Button>
      </div>
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-small font-medium text-danger-fg">
          {error}
        </p>
      )}
      <p id={`${id}-hint`} className="mt-1.5 text-small text-fg-muted">
        {hint}
      </p>
      <LiveCheck state={live.state} />
    </form>
  );
}

/** Result of the debounced site check, shown under the field before the user starts (P1-13). */
function LiveCheck({ state }: { state: ReturnType<typeof useUrlCheck>["state"] }) {
  if (state.status === "idle") return null;
  if (state.status === "checking") return <Spinner className="mt-2 text-small" label={`Checking ${state.url}…`} />;
  if (state.status === "error")
    return (
      <p className="mt-2 inline-flex items-center gap-1.5 text-small text-fg-muted">
        <Info className="h-4 w-4" aria-hidden /> We couldn’t check this site right now. You can still continue.
      </p>
    );
  const v = interpretUrlCheck(state.result);
  const r = state.result;
  return (
    <div role="status" className="mt-2 space-y-1 text-small">
      {v.ok ? (
        <p className="inline-flex flex-wrap items-center gap-1.5 text-success-fg">
          <CircleCheck className="h-4 w-4" aria-hidden />
          <span className="font-medium">Reachable</span>
          {r.http_status && <span className="text-fg-muted">· HTTP {r.http_status}</span>}
          <span className="text-fg-muted">
            · Final URL <span className="font-mono text-fg-strong">{v.finalUrl}</span>
          </span>
        </p>
      ) : (
        <p className="inline-flex items-start gap-1.5 text-danger-fg">
          <CircleX className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            <span className="font-medium">{r.allowed ? "Unreachable" : "Blocked"}.</span> {v.error}
          </span>
        </p>
      )}
      {[...v.info, ...v.warnings].map((m) => (
        <p key={m} className="flex items-start gap-1.5 text-fg-muted">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {m}
        </p>
      ))}
    </div>
  );
}
