import { CheckCircle2, XCircle } from "lucide-react";
import type { ApiExchange } from "@/lib/types";
import { fmtDuration, prettyJson } from "@/lib/format";

function Headers({ headers }: { headers: Record<string, string> | undefined }) {
  const entries = Object.entries(headers || {});
  if (entries.length === 0) return <p className="text-xs text-slate-600">No headers</p>;
  return (
    <dl className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-3 gap-y-0.5 font-mono text-xs">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-600">{k}</dt>
          <dd className="break-all text-slate-900">{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function statusColour(s: number) {
  if (s >= 200 && s < 300) return "text-emerald-700";
  if (s >= 400) return "text-red-700";
  return "text-amber-800";
}

export function ApiExchangeView({ exchange }: { exchange: ApiExchange }) {
  const { request, response, assertions } = exchange;
  return (
    <div className="space-y-4">
      {assertions?.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600">
            Assertions ({assertions.filter((a) => a.passed).length}/{assertions.length} passed)
          </p>
          <ul className="space-y-1">
            {assertions.map((a, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                {a.passed ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-label="Passed" />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-label="Failed" />
                )}
                <span>
                  <span className="font-medium text-slate-900">{a.name}</span>
                  {a.message && <span className="text-slate-600"> — {a.message}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 rounded-lg border border-slate-200 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Request</p>
          <p className="mt-1 break-all font-mono text-sm text-slate-900">
            <span className="font-semibold">{request.method}</span> {request.url}
          </p>
          <div className="mt-2">
            <Headers headers={request.headers} />
          </div>
          {request.body !== undefined && request.body !== null && request.body !== "" && (
            <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-50 p-2 font-mono text-xs text-slate-900">{prettyJson(request.body)}</pre>
          )}
        </div>
        <div className="min-w-0 rounded-lg border border-slate-200 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Response</p>
          {response ? (
            <>
              <p className="mt-1 text-sm">
                <span className={`font-semibold ${statusColour(response.status)}`}>Status {response.status}</span>
                <span className="text-slate-600"> · {fmtDuration(response.timeMs)}</span>
              </p>
              <div className="mt-2">
                <Headers headers={response.headers} />
              </div>
              <pre className="mt-2 max-h-80 overflow-auto rounded bg-slate-50 p-2 font-mono text-xs text-slate-900">
                {prettyJson(response.body) || "(empty body)"}
              </pre>
            </>
          ) : (
            <p className="mt-1 text-sm text-red-700">No response received.</p>
          )}
        </div>
      </div>
    </div>
  );
}
