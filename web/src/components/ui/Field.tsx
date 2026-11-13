"use client";

import { forwardRef, useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { humanize } from "@/lib/format";

const inputBase =
  "block min-h-10 w-full rounded-md border-0 bg-surface px-3 py-2 text-body text-fg-strong ring-1 ring-inset ring-line-input placeholder:text-fg-subtle aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-danger-solid read-only:bg-elevated disabled:cursor-not-allowed disabled:bg-elevated disabled:text-fg-muted";

export const inputClass = inputBase;

function describedBy(id: string, hint: unknown, error: unknown): string | undefined {
  const ids = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

function FieldWrap({
  id,
  label,
  hint,
  error,
  required,
  children,
  className = "",
  hideLabel,
}: {
  id: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
  hideLabel?: boolean;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : "mb-1 block text-body font-medium text-fg-strong"}>
        {label}
        {required && (
          <span className="text-danger-fg" aria-hidden>
            {" "}
            *
          </span>
        )}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-small text-fg-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-small font-medium text-danger-fg">
          {error}
        </p>
      )}
    </div>
  );
}

type Common = { label: React.ReactNode; hint?: React.ReactNode; error?: React.ReactNode; wrapClassName?: string; hideLabel?: boolean };

export const TextField = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & Common>(
  function TextField({ label, hint, error, wrapClassName, hideLabel, id, className = "", ...rest }, ref) {
    const auto = useId();
    const fid = id || auto;
    return (
      <FieldWrap id={fid} label={label} hint={hint} error={error} required={rest.required} className={wrapClassName} hideLabel={hideLabel}>
        <input
          ref={ref}
          id={fid}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(fid, hint, error)}
          className={`${inputBase} ${className}`}
          {...rest}
        />
      </FieldWrap>
    );
  },
);

export const TextArea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & Common & { mono?: boolean }>(
  function TextArea({ label, hint, error, wrapClassName, hideLabel, id, className = "", mono, ...rest }, ref) {
    const auto = useId();
    const fid = id || auto;
    return (
      <FieldWrap id={fid} label={label} hint={hint} error={error} required={rest.required} className={wrapClassName} hideLabel={hideLabel}>
        <textarea
          ref={ref}
          id={fid}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(fid, hint, error)}
          className={`${inputBase} ${mono ? "font-mono text-xs leading-5" : ""} ${className}`}
          {...rest}
        />
      </FieldWrap>
    );
  },
);

export function SelectField({
  label,
  hint,
  error,
  wrapClassName,
  hideLabel,
  id,
  options,
  placeholder,
  className = "",
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> &
  Common & { options: (string | { value: string; label: string })[]; placeholder?: string }) {
  const auto = useId();
  const fid = id || auto;
  return (
    <FieldWrap id={fid} label={label} hint={hint} error={error} required={rest.required} className={wrapClassName} hideLabel={hideLabel}>
      <select
        id={fid}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fid, hint, error)}
        className={`${inputBase} pr-8 ${className}`}
        {...rest}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) =>
          typeof o === "string" ? (
            <option key={o} value={o}>
              {humanize(o)}
            </option>
          ) : (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ),
        )}
      </select>
    </FieldWrap>
  );
}

export const Checkbox = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode; description?: React.ReactNode; error?: React.ReactNode }
>(function Checkbox({ label, description, error, className = "", id, ...rest }, ref) {
  const auto = useId();
  const fid = id || auto;
  const describedby = [error ? `${fid}-error` : null, description ? `${fid}-desc` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`flex items-start gap-2.5 ${className}`}>
      <input
        ref={ref}
        id={fid}
        type="checkbox"
        className="mt-0.5 h-5 w-5 shrink-0 rounded border-line-input accent-accent"
        aria-describedby={describedby}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
      <div className="text-body">
        <label htmlFor={fid} className="font-medium text-fg-strong">
          {label}
        </label>
        {description && (
          <div id={`${fid}-desc`} className="text-small text-fg-muted">
            {description}
          </div>
        )}
        {error && (
          <p id={`${fid}-error`} className="mt-1 text-small font-medium text-danger-fg">
            {error}
          </p>
        )}
      </div>
    </div>
  );
});

/** Password input with a real show/hide toggle button (aria-pressed). Paste and password managers allowed. */
export const PasswordField = forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & Common>(
  function PasswordField({ label, hint, error, wrapClassName, hideLabel, id, className = "", ...rest }, ref) {
    const auto = useId();
    const fid = id || auto;
    const [shown, setShown] = useState(false);
    return (
      <FieldWrap id={fid} label={label} hint={hint} error={error} required={rest.required} className={wrapClassName} hideLabel={hideLabel}>
        <div className="relative">
          <input
            ref={ref}
            id={fid}
            type={shown ? "text" : "password"}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy(fid, hint, error)}
            className={`${inputBase} pr-11 ${className}`}
            {...rest}
          />
          <button
            type="button"
            onClick={() => setShown((v) => !v)}
            aria-label={shown ? "Hide password" : "Show password"}
            aria-pressed={shown}
            className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-fg-muted hover:text-fg-strong"
          >
            {shown ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
          </button>
        </div>
      </FieldWrap>
    );
  },
);
