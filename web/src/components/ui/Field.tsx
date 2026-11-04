"use client";

import { forwardRef, useId } from "react";
import { humanize } from "@/lib/format";

const inputBase =
  "block w-full rounded-md border-0 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-500 focus:ring-2 focus:ring-inset focus:ring-blue-600 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500";

export const inputClass = inputBase;

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
  error?: string | null;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
  hideLabel?: boolean;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : "mb-1 block text-sm font-medium text-slate-800"}>
        {label}
        {required && (
          <span className="text-red-700" aria-hidden>
            {" "}
            *
          </span>
        )}
      </label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-600">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

type Common = { label: React.ReactNode; hint?: React.ReactNode; error?: string | null; wrapClassName?: string; hideLabel?: boolean };

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
          aria-describedby={error ? `${fid}-error` : hint ? `${fid}-hint` : undefined}
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
          aria-describedby={error ? `${fid}-error` : hint ? `${fid}-hint` : undefined}
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

export function Checkbox({
  label,
  description,
  className = "",
  id,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode; description?: React.ReactNode }) {
  const auto = useId();
  const fid = id || auto;
  return (
    <div className={`flex items-start gap-2.5 ${className}`}>
      <input
        id={fid}
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-400 text-blue-700 accent-blue-700"
        aria-describedby={description ? `${fid}-desc` : undefined}
        {...rest}
      />
      <div className="text-sm">
        <label htmlFor={fid} className="font-medium text-slate-800">
          {label}
        </label>
        {description && (
          <p id={`${fid}-desc`} className="text-xs text-slate-600">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
