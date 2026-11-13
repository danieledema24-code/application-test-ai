import { CircleCheck, ScanSearch } from "lucide-react";

const POINTS = [
  "Explores your site and maps every page, form and journey",
  "Labels every finding Observed or Inferred, with evidence",
  "You approve each quality gate before the next stage",
];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-canvas">
      <aside className="hidden w-[44%] max-w-xl flex-col justify-between bg-navy-800 p-10 text-white lg:flex">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-white text-navy-800">
            <ScanSearch className="h-5 w-5" aria-hidden />
          </span>
          <span className="text-h3 font-semibold">QA Analyst</span>
        </div>
        <div>
          <p className="text-display font-semibold tracking-[-0.02em]">Your senior QA analyst, on demand.</p>
          <ul className="mt-6 space-y-3 text-body-lg text-navy-50">
            {POINTS.map((t) => (
              <li key={t} className="flex gap-2.5">
                <CircleCheck className="mt-1 h-4 w-4 shrink-0 text-white" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-small text-navy-100">Only analyse sites you’re authorised to test.</p>
      </aside>
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-[400px] rounded-xl bg-surface p-8 shadow-sm ring-1 ring-line">
          <div className="mb-6 flex items-center gap-2 text-fg-strong">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-on-accent">
              <ScanSearch className="h-4.5 w-4.5" aria-hidden />
            </span>
            <span className="text-body font-semibold">QA Analyst</span>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
