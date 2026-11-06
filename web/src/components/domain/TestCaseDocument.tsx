import type { TestStep } from "@/lib/types";

/** Splits stored preconditions ("• a\n• b" or free text) into list items. */
export function preconditionItems(text?: string | null): string[] {
  return (text ?? "")
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[•*-]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</h3>
      {children}
    </section>
  );
}

/** Read-only, tester-friendly layout of a test case: objective, preconditions, numbered step table, pass criterion. */
export function TestCaseDocument({
  description,
  preconditions,
  steps,
  expectedResult,
}: {
  description?: string | null;
  preconditions?: string | null;
  steps: TestStep[];
  expectedResult?: string | null;
}) {
  const pre = preconditionItems(preconditions);
  const hasData = steps.some((s) => s.data?.trim());
  return (
    <div className="space-y-5">
      {description && (
        <Section title="Objective">
          <p className="text-sm leading-relaxed text-fg">{description}</p>
        </Section>
      )}
      {pre.length > 0 && (
        <Section title="Preconditions">
          <ul className="list-disc space-y-1 pl-5 text-sm text-fg marker:text-fg-muted">
            {pre.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={`Steps (${steps.length})`}>
        {steps.length === 0 ? (
          <p className="text-sm text-fg-muted">No steps yet. Use Edit to add them.</p>
        ) : (
          <ol className="divide-y divide-line overflow-hidden rounded-lg border border-line">
            {steps.map((s, i) => (
              <li key={i} className="grid gap-x-4 gap-y-1.5 bg-surface p-3 sm:grid-cols-[2rem_1fr_1fr]">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-overlay text-xs font-semibold text-fg-strong" aria-hidden>
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-sm text-fg-strong">
                    <span className="sr-only">Step {i + 1}: </span>
                    {s.action}
                  </p>
                  {hasData && s.data?.trim() && (
                    <p className="mt-1 text-xs text-fg-muted">
                      Test data: <code className="rounded bg-overlay px-1.5 py-0.5 font-mono text-[11px] text-fg break-all">{s.data}</code>
                    </p>
                  )}
                </div>
                <p className="text-sm text-fg sm:border-l sm:border-line sm:pl-4">
                  <span className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-emerald-400">Expected</span>
                  {s.expected || <span className="text-fg-subtle">Not specified</span>}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Section>
      {expectedResult && (
        <Section title="Overall expected result">
          <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-fg">{expectedResult}</p>
        </Section>
      )}
    </div>
  );
}
