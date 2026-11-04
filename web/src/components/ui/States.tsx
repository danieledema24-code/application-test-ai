import { AlertTriangle, Inbox, Loader2, RefreshCw } from "lucide-react";
import { errorMessage } from "@/lib/api";

export function Spinner({ label = "Loading", className = "" }: { label?: string; className?: string }) {
  return (
    <span role="status" className={`inline-flex items-center gap-2 text-sm text-slate-600 ${className}`}>
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label}
    </span>
  );
}

export function LoadingBlock({ label = "Loading…", className = "" }: { label?: string; className?: string }) {
  return (
    <div className={`flex items-center justify-center py-12 ${className}`}>
      <Spinner label={label} />
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-md bg-slate-200/70 ${className}`} />;
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  className = "",
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center px-6 py-10 text-center ${className}`}>
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-500">
        {icon || <Inbox className="h-5 w-5" aria-hidden />}
      </div>
      <p className="text-sm font-medium text-slate-900">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-slate-600">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  className = "",
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={`flex flex-col items-center justify-center px-6 py-10 text-center ${className}`}>
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-red-50 text-red-600">
        <AlertTriangle className="h-5 w-5" aria-hidden />
      </div>
      <p className="text-sm font-medium text-slate-900">Couldn’t load this</p>
      <p className="mt-1 max-w-md text-sm text-slate-600">{errorMessage(error)}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50"
        >
          <RefreshCw className="h-4 w-4" aria-hidden /> Try again
        </button>
      )}
    </div>
  );
}

export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-inset ring-red-600/20">
      {typeof error === "string" ? error : errorMessage(error)}
    </p>
  );
}

/** Wraps the common loading / error / empty states for SWR data. */
export function DataState<T>({
  data,
  error,
  isLoading,
  onRetry,
  empty,
  isEmpty,
  children,
  loadingLabel,
}: {
  data: T | undefined;
  error: unknown;
  isLoading: boolean;
  onRetry?: () => void;
  empty?: React.ReactNode;
  isEmpty?: (d: T) => boolean;
  children: (d: T) => React.ReactNode;
  loadingLabel?: string;
}) {
  if (error && !data) return <ErrorState error={error} onRetry={onRetry} />;
  if (isLoading || data === undefined) return <LoadingBlock label={loadingLabel} />;
  const emptyCheck = isEmpty || ((d: T) => Array.isArray(d) && d.length === 0);
  if (empty && emptyCheck(data)) return <>{empty}</>;
  return <>{children(data)}</>;
}
