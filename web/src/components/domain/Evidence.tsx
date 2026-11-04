"use client";

import { useEffect, useState } from "react";
import { Download, FileText, Paperclip, ScrollText } from "lucide-react";
import { evidenceUrl } from "@/lib/api";
import { fmtBytes, humanize } from "@/lib/format";
import type { Evidence } from "@/lib/types";
import { Modal } from "@/components/ui";

function TextViewer({ ev, onClose }: { ev: Evidence; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(evidenceUrl(ev))
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const t = await r.text();
        if (cancelled) return;
        try {
          setText(JSON.stringify(JSON.parse(t), null, 2));
        } catch {
          setText(t);
        }
      })
      .catch((e: Error) => !cancelled && setErr(e.message));
    return () => {
      cancelled = true;
    };
  }, [ev]);
  return (
    <Modal open onClose={onClose} title={ev.name} description={humanize(ev.fileType)} size="xl">
      {err && <p className="text-sm text-red-700">Couldn’t load file: {err}</p>}
      {!err && text === null && <p className="text-sm text-slate-600">Loading…</p>}
      {text !== null && (
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-900 p-3 font-mono text-xs text-slate-100">
          {text || "(empty)"}
        </pre>
      )}
      <a href={evidenceUrl(ev)} download={ev.name} className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-blue-700 hover:underline">
        <Download className="h-4 w-4" aria-hidden /> Download
      </a>
    </Modal>
  );
}

export function EvidenceGallery({ evidence }: { evidence: Evidence[] }) {
  const [viewing, setViewing] = useState<Evidence | null>(null);
  const [zoom, setZoom] = useState<Evidence | null>(null);
  if (!evidence || evidence.length === 0) return <p className="text-sm text-slate-600">No evidence captured.</p>;

  const images = evidence.filter((e) => e.fileType === "SCREENSHOT" || e.mimeType?.startsWith("image/"));
  const videos = evidence.filter((e) => e.fileType === "VIDEO" || e.mimeType?.startsWith("video/"));
  const others = evidence.filter((e) => !images.includes(e) && !videos.includes(e));

  return (
    <div className="space-y-3">
      {images.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {images.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => setZoom(e)}
              className="group overflow-hidden rounded-lg border border-slate-200 bg-slate-50 text-left"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={evidenceUrl(e)} alt={`Screenshot: ${e.name}`} className="aspect-video w-full object-cover object-top group-hover:opacity-90" loading="lazy" />
              <span className="block truncate px-2 py-1 text-xs text-slate-700">{e.name}</span>
            </button>
          ))}
        </div>
      )}
      {videos.map((e) => (
        <div key={e.id}>
          <video controls preload="metadata" className="w-full max-w-2xl rounded-lg border border-slate-200 bg-black" aria-label={`Video recording: ${e.name}`}>
            <source src={evidenceUrl(e)} type={e.mimeType || "video/webm"} />
          </video>
          <p className="mt-1 text-xs text-slate-600">{e.name}</p>
        </div>
      ))}
      {others.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {others.map((e) => {
            const isText =
              e.fileType === "CONSOLE_LOG" ||
              e.fileType === "NETWORK_LOG" ||
              e.fileType === "NOTE" ||
              e.mimeType?.startsWith("text/") ||
              e.mimeType === "application/json";
            return (
              <li key={e.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                {isText ? <ScrollText className="h-4 w-4 text-slate-500" aria-hidden /> : e.fileType === "TRACE" ? <FileText className="h-4 w-4 text-slate-500" aria-hidden /> : <Paperclip className="h-4 w-4 text-slate-500" aria-hidden />}
                <span className="min-w-0 flex-1 truncate text-slate-900">{e.name}</span>
                <span className="text-xs text-slate-600">
                  {humanize(e.fileType)} · {fmtBytes(e.size)}
                </span>
                {isText && (
                  <button type="button" onClick={() => setViewing(e)} className="text-xs font-medium text-blue-700 hover:underline">
                    View
                  </button>
                )}
                <a href={evidenceUrl(e)} download={e.name} className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline">
                  <Download className="h-3.5 w-3.5" aria-hidden /> Download
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {viewing && <TextViewer ev={viewing} onClose={() => setViewing(null)} />}
      {zoom && (
        <Modal open onClose={() => setZoom(null)} title={zoom.name} size="xl">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={evidenceUrl(zoom)} alt={`Screenshot: ${zoom.name}`} className="w-full rounded border border-slate-200" />
          <a href={evidenceUrl(zoom)} download={zoom.name} className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-blue-700 hover:underline">
            <Download className="h-4 w-4" aria-hidden /> Download
          </a>
        </Modal>
      )}
    </div>
  );
}
