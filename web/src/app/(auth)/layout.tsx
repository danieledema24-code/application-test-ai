import { CheckCircle2, FlaskConical } from "lucide-react";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-canvas">
      <aside className="hidden w-[44%] max-w-xl flex-col justify-between bg-navy-900 p-10 text-white lg:flex">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600">
            <FlaskConical className="h-5 w-5" aria-hidden />
          </span>
          <span className="font-semibold">Application Test AI</span>
        </div>
        <div>
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">Quality assurance you can audit.</h2>
          <ul className="mt-6 space-y-3 text-sm text-slate-300">
            {[
              "Test management, Playwright automation and API testing in one place",
              "AI drafts test cases and analyses failures — clearly labelled as hypotheses",
              "Recorded results, evidence and defects remain the source of truth",
            ].map((t) => (
              <li key={t} className="flex gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-slate-400">Only test applications you are authorised to test.</p>
      </aside>
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
