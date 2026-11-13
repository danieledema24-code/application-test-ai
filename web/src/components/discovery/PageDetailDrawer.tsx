"use client";

import type { PageDetail } from "@/lib/contract";
import { componentColumn, COMPONENT_TYPES } from "@/lib/discovery";
import { pathOf } from "@/lib/url";
import { Drawer, ErrorState, Spinner } from "@/components/ui";
import { ObservationLabel } from "@/components/domain/ObservationLabel";
import { EvidenceLinks, linksToItems } from "@/components/domain/EvidenceDrawer";
import { usePageDetail } from "./hooks";

function Shots({ page }: { page: PageDetail }) {
  const views = Object.entries(page.responsive ?? {});
  const shots = views.length ? views.map(([k, v]) => ({ key: k, label: v.viewport || k, shot: v.screenshot })) : [{ key: "desktop", label: "Desktop", shot: page.screenshot }];
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {shots.map((s) => (
        <figure key={s.key} className="overflow-hidden rounded-md border border-line bg-elevated">
          {s.shot ? (
            // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived evidence URL
            <img src={s.shot.content_url} alt={`Screenshot of ${page.title || pathOf(page.url)} (${pathOf(page.url)}), ${s.label}`} className="aspect-[4/3] w-full bg-white object-cover object-top" />
          ) : (
            <div className="flex aspect-[4/3] items-center justify-center text-small text-fg-muted">No screenshot</div>
          )}
          <figcaption className="border-t border-line px-2 py-1 text-caption text-fg-muted">{s.label}</figcaption>
        </figure>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-h3 font-semibold text-fg-strong">{title}</h3>
      {children}
    </section>
  );
}

/** Page detail (design spec §8.2 Sitemap): screenshots, forms, components, links, issues and evidence. */
export function PageDetailDrawer({ pageId, onClose }: { pageId: string | null; onClose: () => void }) {
  const { data: page, error, mutate } = usePageDetail(pageId);
  const evidence = linksToItems(page?.evidence ?? []);
  const subject = page ? page.title || pathOf(page.url) : "";
  return (
    <Drawer open={!!pageId} onClose={onClose} title={page ? subject : "Page"} subtitle={page && <span className="break-all font-mono">{page.url}</span>} wide>
      {error && !page ? (
        <ErrorState error={error} title="Couldn’t load this page." message="Try again." onRetry={() => void mutate()} />
      ) : !page ? (
        <Spinner label="Loading page…" />
      ) : (
        <div className="space-y-6">
          <p className="flex flex-wrap items-center gap-2 text-small text-fg">
            <ObservationLabel provenance="observed" />
            <span>HTTP {page.http_status ?? "—"}</span>
            <span aria-hidden>·</span>
            <span>Depth {page.depth}</span>
            <span aria-hidden>·</span>
            <span>Type: {page.page_type.replace(/_/g, " ")}</span>
            {page.auth_context === "authenticated" ? (
              <>
                <span aria-hidden>·</span>
                <span className="font-medium text-success-fg">Visited while signed in as the test account</span>
              </>
            ) : (
              page.requires_auth && (
                <>
                  <span aria-hidden>·</span>
                  <span className="font-medium text-warning-fg">Needs credentials</span>
                </>
              )
            )}
          </p>
          <Shots page={page} />
          <Section title="Evidence">
            <EvidenceLinks items={evidence} subject={subject} />
          </Section>
          {page.headings.length > 0 && (
            <Section title="Headings">
              <ul className="list-disc space-y-0.5 pl-5 text-body text-fg">
                {page.headings.slice(0, 20).map((h, i) => (
                  <li key={`${h}-${i}`}>{h}</li>
                ))}
              </ul>
            </Section>
          )}
          <Section title={`Forms (${page.forms.length})`}>
            {page.forms.length === 0 ? (
              <p className="text-body text-fg-muted">No forms found.</p>
            ) : (
              <ul className="space-y-3">
                {page.forms.map((f, i) => (
                  <li key={i} className="rounded-md border border-line p-3">
                    <p className="flex flex-wrap items-center gap-2 text-body font-semibold text-fg-strong">
                      Form · {f.name || f.purpose_guess || "Unnamed"} <ObservationLabel provenance="observed" />
                    </p>
                    <p className="mt-1 text-small text-fg">
                      {f.fields.length} field{f.fields.length === 1 ? "" : "s"}:{" "}
                      {f.fields.map((x) => `${x.label || x.name} (${x.type}${x.required ? ", required" : ""})`).join(", ")}.
                      {f.submit_label ? ` Submit button “${f.submit_label}”.` : ""} Not submitted.
                    </p>
                    {f.purpose_guess && (
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-small text-fg-muted">
                        Purpose: {f.purpose_guess} <ObservationLabel provenance="inferred" />
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title={`Components (${page.components.length})`}>
            {page.components.length === 0 ? (
              <p className="text-body text-fg-muted">No interactive components recorded.</p>
            ) : (
              <div className="space-y-3">
                {COMPONENT_TYPES.map((t) => {
                  const items = page.components.filter((c) => componentColumn(c.kind) === t.key);
                  if (!items.length) return null;
                  return (
                    <div key={t.key}>
                      <h4 className="text-small font-semibold text-fg-strong">
                        {t.label} ({items.length})
                      </h4>
                      <ul className="mt-1 space-y-0.5 text-small text-fg">
                        {items.slice(0, 30).map((c) => (
                          <li key={c.fingerprint} className="flex flex-wrap gap-2">
                            <span>{c.name || c.role || c.kind}</span>
                            <span className="break-all font-mono text-fg-muted">{c.locator}</span>
                          </li>
                        ))}
                        {items.length > 30 && <li className="text-fg-muted">+{items.length - 30} more</li>}
                      </ul>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>
          <Section title={`Outgoing links (${page.nav_links.length})`}>
            {/* Link targets come from the site: shown as text, never clickable. */}
            <ul className="max-h-48 space-y-0.5 overflow-y-auto text-small">
              {page.nav_links.slice(0, 100).map((l, i) => (
                <li key={`${l.href}-${i}`} className="flex flex-wrap gap-2">
                  <span className="text-fg-strong">{l.text || "(no text)"}</span>
                  <span className="break-all font-mono text-fg-muted">{l.href}</span>
                </li>
              ))}
            </ul>
          </Section>
          {(page.console_issues.length > 0 || page.network_issues.length > 0) && (
            <Section title="Console and network issues">
              <ul className="space-y-1 text-small text-fg">
                {page.console_issues.map((c, i) => (
                  <li key={`c${i}`} className="break-words">
                    <span className="font-medium">Console {c.level}:</span> {c.text}
                  </li>
                ))}
                {page.network_issues.map((n, i) => (
                  <li key={`n${i}`} className="break-all">
                    <span className="font-medium">Request {n.status ?? n.failure ?? "failed"}:</span> <span className="font-mono">{n.url}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
    </Drawer>
  );
}
