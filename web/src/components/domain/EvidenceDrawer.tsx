"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Code, Copy, ExternalLink, FileWarning, Image as ImageIcon } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { EvidenceDetail, EvidenceLink as EvidenceLinkT, EvidenceRef } from "@/lib/contract";
import { fmtBytes, fmtDateTime } from "@/lib/format";
import { Button, Drawer, Segmented, Spinner, useToast } from "@/components/ui";

/** An item to show: a reference (from findings) or an EvidenceLink we already have (from pages/events). */
export type EvidenceItem = { id: string; selector?: string | null; excerpt?: string | null; note?: string | null; link?: EvidenceLinkT | null };

type OpenArgs = { items: EvidenceItem[]; subject: string; startIndex?: number };
const EvidenceCtx = createContext<((args: OpenArgs) => void) | null>(null);

export function refsToItems(refs: EvidenceRef[] | null | undefined): EvidenceItem[] {
  return (refs ?? []).map((r) => ({ id: r.evidence_id, selector: r.selector, excerpt: r.excerpt, note: r.note }));
}

export function linksToItems(links: (EvidenceLinkT | null | undefined)[]): EvidenceItem[] {
  return links.filter((l): l is EvidenceLinkT => !!l).map((l) => ({ id: l.id, link: l }));
}

function isImage(mime: string | undefined, kind: string | undefined) {
  return !!mime?.startsWith("image/") || kind === "screenshot";
}

function isText(mime: string | undefined, kind: string | undefined) {
  return !!mime && (mime.startsWith("text/") || mime.includes("json") || mime.includes("xml") || /dom|aria|html/.test(kind ?? ""));
}

function kindLabel(e: { mime?: string; kind?: string } | null | undefined) {
  if (!e) return "Evidence";
  if (isImage(e.mime, e.kind)) return "Screenshot";
  if (/dom|html/.test(e.kind ?? "") || e.mime === "text/html") return "DOM snippet";
  if (/aria/.test(e.kind ?? "")) return "Accessibility snapshot";
  return (e.kind ?? "Evidence").replace(/_/g, " ");
}

/**
 * Text evidence is fetched from its signed URL and rendered as escaped text only: React never
 * interprets it as HTML, so <script> and <a href> in a snippet are inert, unclickable text (§8.3, §19).
 */
function TextEvidence({ url, excerpt }: { url: string | null; excerpt?: string | null }) {
  const toast = useToast();
  const [text, setText] = useState<string | null>(excerpt ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => !cancelled && setText(t.length > 200_000 ? `${t.slice(0, 200_000)}\n… (truncated)` : t))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (failed && !text) return <MissingEvidence />;
  if (text === null) return <Spinner label="Loading snippet…" />;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-small font-semibold text-fg-strong">DOM snippet</h3>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Copy DOM snippet"
          icon={<Copy className="h-4 w-4" aria-hidden />}
          onClick={() =>
            void navigator.clipboard
              .writeText(text)
              .then(() => toast("Copied."))
              .catch(() => toast("Couldn’t copy. Select the text and copy it instead.", "error"))
          }
        >
          Copy
        </Button>
      </div>
      <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-elevated p-3 font-mono text-caption leading-5 text-fg-strong ring-1 ring-line" tabIndex={0} aria-label="DOM snippet, shown as text">
        {text}
      </pre>
    </div>
  );
}

function MissingEvidence() {
  return (
    <p className="flex items-center gap-2 rounded-md bg-warning-bg px-3 py-2 text-body text-fg-strong ring-1 ring-warning-line">
      <FileWarning className="h-4 w-4 text-warning-fg" aria-hidden /> This evidence file is no longer available.
    </p>
  );
}

function EvidenceView({ item, subject }: { item: EvidenceItem; subject: string }) {
  // Always fetch the record: signed content URLs expire after 15 minutes, so a fresh one is needed.
  const { data, error } = useApi<EvidenceDetail>(`/evidence/${item.id}`);
  const ev = data ?? item.link ?? null;
  const missing = error instanceof ApiError && error.status === 404;
  if (missing) return <MissingEvidence />;
  if (!ev) return error ? <MissingEvidence /> : <Spinner label="Loading evidence…" />;
  const meta = (data?.metadata ?? {}) as Record<string, unknown>;
  const page = typeof meta.url === "string" ? meta.url : typeof meta.page_url === "string" ? meta.page_url : null;
  const viewport = typeof meta.viewport === "string" ? meta.viewport : null;
  return (
    <div className="space-y-4">
      <p className="text-small text-fg-muted">
        {kindLabel(ev)}
        {page && <> · <span className="font-mono">{page}</span></>}
        {viewport && <> · {viewport}</>} · <time dateTime={ev.captured_at}>{fmtDateTime(ev.captured_at)}</time> · {fmtBytes(ev.size)}
        <br />
        Captured by Application Discovery Agent · <span className="font-mono">{ev.id.slice(0, 8)}</span>
      </p>
      {isImage(ev.mime, ev.kind) ? (
        <figure>
          {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived evidence URL from the API */}
          <img src={ev.content_url} alt={`Screenshot evidence for ${subject}`} className="w-full rounded-md ring-1 ring-line" />
          <figcaption className="mt-2 flex justify-end">
            <a href={ev.content_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-body font-medium text-navy-700 underline underline-offset-4">
              Open full size <ExternalLink className="h-4 w-4" aria-hidden />
              <span className="sr-only">(opens in new tab)</span>
            </a>
          </figcaption>
        </figure>
      ) : isText(ev.mime, ev.kind) ? (
        <TextEvidence url={ev.content_url} excerpt={item.excerpt} />
      ) : (
        <a href={ev.content_url} className="text-body font-medium text-navy-700 underline underline-offset-4" download>
          Download evidence file
        </a>
      )}
      {(item.selector || item.excerpt || item.note) && (
        <dl className="space-y-2 text-small">
          {item.selector && (
            <div>
              <dt className="font-semibold text-fg-strong">Element</dt>
              <dd className="break-all font-mono text-fg">{item.selector}</dd>
            </div>
          )}
          {item.excerpt && isImage(ev.mime, ev.kind) && (
            <div>
              <dt className="font-semibold text-fg-strong">Excerpt</dt>
              <dd className="whitespace-pre-wrap break-words font-mono text-fg">{item.excerpt}</dd>
            </div>
          )}
          {item.note && (
            <div>
              <dt className="font-semibold text-fg-strong">Note</dt>
              <dd className="text-fg">{item.note}</dd>
            </div>
          )}
        </dl>
      )}
      <p className="text-small text-fg-muted">Used by: {subject}</p>
    </div>
  );
}

export function EvidenceProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<OpenArgs | null>(null);
  const [index, setIndex] = useState(0);
  const open = useCallback((args: OpenArgs) => {
    setIndex(args.startIndex ?? 0);
    setState(args);
  }, []);
  const item = state?.items[index];
  return (
    <EvidenceCtx.Provider value={open}>
      {children}
      <Drawer
        open={!!state}
        onClose={() => setState(null)}
        title={item ? `Evidence ${index + 1} of ${state?.items.length}` : "Evidence"}
        subtitle={state?.subject}
      >
        {state && state.items.length > 1 && (
          <div className="mb-4">
            <Segmented
              label="Evidence item"
              options={state.items.map((_, i) => ({ value: i, label: String(i + 1) }))}
              value={index}
              onChange={setIndex}
            />
          </div>
        )}
        {item ? <EvidenceView key={item.id} item={item} subject={state?.subject ?? ""} /> : <MissingEvidence />}
      </Drawer>
    </EvidenceCtx.Provider>
  );
}

export function useEvidence() {
  const open = useContext(EvidenceCtx);
  if (!open) throw new Error("useEvidence must be used inside EvidenceProvider");
  return open;
}

/**
 * Evidence buttons for a finding: [Screenshot] [DOM] … or the text "Evidence missing".
 * Accessible names read "Screenshot evidence for Contact form".
 */
export function EvidenceLinks({ items, subject, className = "" }: { items: EvidenceItem[]; subject: string; className?: string }) {
  const open = useEvidence();
  const buttons = useMemo(() => {
    if (items.length === 0) return [];
    const imgs = items.filter((i) => i.link && isImage(i.link.mime, i.link.kind));
    const rest = items.filter((i) => !imgs.includes(i));
    // Unknown types (refs) get one "Evidence" button that opens all of them.
    const out: { label: string; Icon: typeof Code; start: number }[] = [];
    if (imgs.length) out.push({ label: "Screenshot", Icon: ImageIcon, start: items.indexOf(imgs[0]) });
    const dom = rest.find((i) => i.link && /dom|html/.test(i.link.kind));
    if (dom) out.push({ label: "DOM", Icon: Code, start: items.indexOf(dom) });
    if (!out.length) out.push({ label: items.length > 1 ? `Evidence (${items.length})` : "Evidence", Icon: ImageIcon, start: 0 });
    return out;
  }, [items]);
  if (items.length === 0) return <span className={`text-small text-fg-muted ${className}`}>Evidence missing</span>;
  return (
    <span className={`inline-flex flex-wrap gap-2 ${className}`}>
      {buttons.map((b) => (
        <button
          key={b.label}
          type="button"
          onClick={() => open({ items, subject, startIndex: b.start })}
          aria-label={`${b.label.replace(/ \(\d+\)$/, "")} evidence for ${subject}`}
          className="inline-flex min-h-6 items-center gap-1 rounded-sm px-1 text-small font-medium text-navy-700 underline underline-offset-2 hover:text-navy-900"
        >
          <b.Icon className="h-3.5 w-3.5" aria-hidden />
          {b.label}
        </button>
      ))}
    </span>
  );
}
