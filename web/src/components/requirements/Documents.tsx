"use client";

import { useRef, useState } from "react";
import { MoreHorizontal, Upload } from "lucide-react";
import { API_URL, ApiError, api, authHeaders, downloadFile, toApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import type { SourceDocument, SourceDocumentDetail } from "@/lib/contract";
import { DOC_ACCEPT, checkDocumentFiles, docStatusText, docType } from "@/lib/documents";
import { fmtBytes, fmtDate } from "@/lib/format";
import { Button, Callout, Card, CardBody, CardHeader, ConfirmDialog, Disclosure, Drawer, EmptyState, ErrorState, InlineError, Skeleton, Spinner, StatusPill, Table, TBody, Td, Th, THead, useToast } from "@/components/ui";
import { TextEvidence } from "@/components/domain/EvidenceDrawer";

type Upload = { id: string; name: string; pct: number; error: string | null; file: File; xhr: XMLHttpRequest | null };

/** multipart upload with progress (fetch has no upload progress). Auth header only; no token in the URL. */
function uploadWithProgress(projectId: string, file: File, onProgress: (pct: number) => void): { xhr: XMLHttpRequest; done: Promise<SourceDocument> } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<SourceDocument>((resolve, reject) => {
    xhr.open("POST", `${API_URL}/projects/${projectId}/documents`);
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = xhr.responseText;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as SourceDocument);
      else reject(toApiError(xhr.status, data));
    };
    xhr.onerror = () => reject(new ApiError(0, "network", "Upload failed. Check your connection and try again."));
    xhr.onabort = () => reject(new ApiError(0, "aborted", "Upload cancelled."));
    const body = new FormData();
    body.append("file", file);
    xhr.send(body);
  });
  return { xhr, done };
}

function ExtractedText({ doc, onClose }: { doc: SourceDocument | null; onClose: () => void }) {
  const detail = useApi<SourceDocumentDetail>(doc ? `/documents/${doc.id}` : null);
  return (
    <Drawer open={!!doc} onClose={onClose} title={doc ? `${doc.title || doc.filename} · extracted text` : ""} wide>
      <p className="mb-3 text-small text-fg-muted">Showing the text we extracted. Formatting, images and tables may be missing.</p>
      {detail.error ? (
        <ErrorState error={detail.error} title="Couldn’t load the extracted text." message="Try again." onRetry={() => void detail.mutate()} />
      ) : !detail.data ? (
        <Spinner label="Loading the extracted text…" />
      ) : (
        <>
          {detail.data.injection_findings.length > 0 && (
            <Callout tone="warning" className="mb-3">
              This document contains text addressed to AI agents. It was treated as content and ignored.
            </Callout>
          )}
          <TextEvidence url={detail.data.text?.content_url ?? null} title="Extracted text" />
        </>
      )}
    </Drawer>
  );
}

function RowMenu({ doc, onView, onRemove, canEdit }: { doc: SourceDocument; onView: () => void; onRemove: () => void; canEdit: boolean }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const item = "flex min-h-10 w-full items-center px-4 py-2 text-left text-body text-fg-strong hover:bg-overlay";
  return (
    <div className="relative" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <Button size="sm" variant="ghost" aria-label={`Actions for ${doc.title || doc.filename}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 top-9 z-30 w-56 rounded-lg bg-surface py-1 shadow-lg ring-1 ring-line-strong">
          {doc.status === "ready" && (
            <button role="menuitem" type="button" className={item} onClick={() => (setOpen(false), onView())}>
              View extracted text
            </button>
          )}
          <button
            role="menuitem"
            type="button"
            className={item}
            onClick={() => {
              setOpen(false);
              void downloadFile(`/documents/${doc.id}/download`, doc.filename).catch(() => toast("Couldn’t download the file. Try again.", "error"));
            }}
          >
            Download original
          </button>
          {canEdit && doc.status !== "withdrawn" && (
            <button role="menuitem" type="button" className={`${item} text-danger-fg`} onClick={() => (setOpen(false), onRemove())}>
              Remove from sources
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Source documents tab (design P2 §7): drop zone with a real [Choose files] button, client checks, upload
 * progress per file, extraction states, remove (withdraw) with confirm, and the extracted-text drawer.
 */
export function SourceDocuments({
  projectId,
  docs,
  loading,
  error,
  onChanged,
  requirementsExist,
  newSinceGeneration,
  onRegenerate,
}: {
  projectId: string;
  docs: SourceDocument[] | undefined;
  loading: boolean;
  error: unknown;
  onChanged: () => void;
  requirementsExist: boolean;
  /** Ready documents added after the current requirement set was generated. */
  newSinceGeneration: number;
  onRegenerate?: () => void;
}) {
  const { role } = useAuth();
  const toast = useToast();
  const canEdit = role !== "viewer";
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [clientErrors, setClientErrors] = useState<string[]>([]);
  const [viewing, setViewing] = useState<SourceDocument | null>(null);
  const [removing, setRemoving] = useState<SourceDocument | null>(null);
  const [busy, setBusy] = useState(false);

  const all = docs ?? [];
  const active = all.filter((d) => d.status !== "withdrawn");
  const removed = all.filter((d) => d.status === "withdrawn");

  function start(file: File, id = `${file.name}-${Date.now()}-${Math.random()}`) {
    const { xhr, done } = uploadWithProgress(projectId, file, (pct) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, pct } : x))));
    setUploads((u) => [...u.filter((x) => x.id !== id), { id, name: file.name, pct: 0, error: null, file, xhr }]);
    done
      .then(() => {
        setUploads((u) => u.filter((x) => x.id !== id));
        toast(`${file.name} uploaded. Extracting text…`);
        onChanged();
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.code === "aborted") return setUploads((u) => u.filter((x) => x.id !== id));
        const msg =
          err instanceof ApiError && err.status === 409
            ? `This project already has 10 documents. Remove one to add another.`
            : err instanceof ApiError && err.status === 422
              ? `${file.name}: ${err.message}`
              : "Upload failed. Check your connection and try again.";
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, error: msg, xhr: null } : x)));
      });
  }

  function add(files: File[]) {
    const { accepted, errors } = checkDocumentFiles(files, active.length + uploads.filter((u) => !u.error).length);
    setClientErrors(errors);
    accepted.forEach((f) => start(f));
  }

  async function withdraw(d: SourceDocument) {
    setBusy(true);
    try {
      await api(`/documents/${d.id}/withdraw`, { body: {} });
      toast(`${d.title || d.filename} removed from sources.`);
      onChanged();
    } catch (err) {
      toast(`Couldn’t remove the document. ${err instanceof Error ? err.message : ""}`.trim(), "error");
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  }

  const row = (d: SourceDocument) => {
    const pill = d.status === "ready" ? "ready" : d.status === "extracting" ? "extracting" : d.status === "failed" ? "failed" : "withdrawn";
    return (
      <tr key={d.id} className="hover:bg-overlay">
        <Td rowHeader className="max-w-[18rem] break-words">
          {d.title || d.filename}
          {d.title && d.title !== d.filename && <span className="block text-caption font-normal text-fg-muted">{d.filename}</span>}
        </Td>
        <Td>{docType(d)}</Td>
        <Td className="tabular-nums">{fmtBytes(d.size)}</Td>
        <Td>
          <StatusPill status={pill} label={docStatusText(d)} />
          {d.status === "ready" && d.injection_flags > 0 && <p className="mt-1 text-small text-warning-fg">This document contains text addressed to AI agents. It was treated as content and ignored.</p>}
          {d.status === "withdrawn" && <p className="mt-1 text-small text-fg-muted">Removed {fmtDate(d.withdrawn_at)}</p>}
        </Td>
        <Td>{d.uploaded_by?.full_name || d.uploaded_by?.email || "—"}</Td>
        <Td>{fmtDate(d.created_at)}</Td>
        <Td className="text-right">
          <RowMenu doc={d} canEdit={canEdit} onView={() => setViewing(d)} onRemove={() => setRemoving(d)} />
        </Td>
      </tr>
    );
  };

  const head = (
    <THead>
      <tr>
        <Th>Name</Th>
        <Th>Type</Th>
        <Th>Size</Th>
        <Th>Status</Th>
        <Th>Added by</Th>
        <Th>Added</Th>
        <Th srOnly>Actions</Th>
      </tr>
    </THead>
  );

  return (
    <div className="space-y-6">
      {canEdit && (
        <Card>
          <CardHeader title="Add requirement documents" />
          <CardBody className="space-y-3">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                add(Array.from(e.dataTransfer.files));
              }}
              className={`rounded-lg border-2 border-dashed px-4 py-6 text-center ${drag ? "border-focus bg-accent-soft" : "border-line-strong"}`}
            >
              <p className="text-body text-fg">
                {drag ? (
                  "Drop to upload"
                ) : (
                  <>
                    Drop PDF, Markdown or Word files here, or{" "}
                    <Button size="sm" variant="secondary" icon={<Upload className="h-4 w-4" aria-hidden />} onClick={() => input.current?.click()}>
                      Choose files
                    </Button>
                  </>
                )}
              </p>
              <p className="mt-1 text-small text-fg-muted">PDF, MD, DOCX · up to 20 MB each · up to 10 documents per project</p>
              <input
                ref={input}
                type="file"
                accept={DOC_ACCEPT}
                multiple
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => {
                  add(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
            </div>
            <Callout tone="info">
              Documents are read as untrusted text. Instructions inside them are ignored. The agent uses them as a source and cites the page or section. They don’t replace evidence from the application.
            </Callout>
            {!requirementsExist && <p className="text-small text-fg-muted">This document will be used when requirements are generated.</p>}
            {clientErrors.length > 0 && (
              <InlineError error={clientErrors.join(" ")}>
                <ul className="list-disc pl-5">
                  {clientErrors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </InlineError>
            )}
            {uploads.length > 0 && (
              <ul className="space-y-2">
                {uploads.map((u) => (
                  <li key={u.id} className="flex flex-wrap items-center gap-3 text-small">
                    <span className="min-w-0 flex-1 break-words font-medium text-fg-strong">{u.name}</span>
                    {u.error ? (
                      <>
                        <span className="text-danger-fg">{u.error}</span>
                        <Button size="sm" variant="secondary" onClick={() => start(u.file, u.id)}>
                          Try again
                        </Button>
                      </>
                    ) : (
                      <>
                        <span role="progressbar" aria-label={`Uploading ${u.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={u.pct} className="h-2 w-32 overflow-hidden rounded-full bg-overlay">
                          <span className="block h-full bg-accent" style={{ width: `${u.pct}%` }} />
                        </span>
                        <span className="tabular-nums text-fg-muted">Uploading… {u.pct}%</span>
                        <Button size="sm" variant="ghost" onClick={() => u.xhr?.abort()}>
                          Cancel upload
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      {newSinceGeneration > 0 && requirementsExist && (
        <Callout
          tone="info"
          actions={
            onRegenerate && canEdit ? (
              <Button variant="secondary" onClick={onRegenerate}>
                Regenerate…
              </Button>
            ) : undefined
          }
        >
          {newSinceGeneration} new document{newSinceGeneration === 1 ? "" : "s"} since requirements were generated.
        </Callout>
      )}

      <Card>
        <CardHeader title={`Documents (${active.length})`} />
        {error && !docs ? (
          <CardBody>
            <ErrorState error={error} title="Couldn’t load documents." message="Try again." onRetry={onChanged} />
          </CardBody>
        ) : loading && !docs ? (
          <CardBody className="space-y-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </CardBody>
        ) : active.length === 0 ? (
          <CardBody>
            <EmptyState title="No documents yet." description="Requirements come from discovery alone until you add one." />
          </CardBody>
        ) : (
          <Table label="Source documents">
            {head}
            <TBody>{active.map(row)}</TBody>
          </Table>
        )}
        {removed.length > 0 && (
          <CardBody className="border-t border-line">
            <Disclosure label={`Removed (${removed.length})`}>
              <div className="mt-3">
                <Table label="Removed documents">
                  {head}
                  <TBody>{removed.map(row)}</TBody>
                </Table>
              </div>
            </Disclosure>
          </CardBody>
        )}
      </Card>

      <ExtractedText doc={viewing} onClose={() => setViewing(null)} />
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && void withdraw(removing)}
        title={`Remove ${removing?.title || removing?.filename || "this document"} from sources?`}
        confirmLabel="Remove"
        danger
        loading={busy}
      >
        It won’t be used the next time requirements are generated. Requirements that cite it keep their citation, marked ‘document removed’. The file is kept in the evidence store.
      </ConfirmDialog>
    </div>
  );
}
