"use client";

import Link from "next/link";
import { useId } from "react";
import { Copy, Loader2 } from "lucide-react";
import type { ArtefactRef, AssistantMessage, StageKey } from "@/lib/contract";
import { splitCitations } from "@/lib/assistant";
import { fmtDateTime } from "@/lib/format";
import { Button, Callout, useToast } from "@/components/ui";
import { GeneratedByLabel } from "@/components/domain/ObservationLabel";
import { useEvidence } from "@/components/domain/EvidenceDrawer";

const TYPE_NAME: Partial<Record<ArtefactRef["type"], string>> = {
  requirement: "Requirement",
  acceptance_criterion: "Acceptance criterion",
  readiness_criterion: "Readiness criterion",
  feature: "Feature",
  journey: "Journey",
  page: "Page",
  evidence: "Evidence",
  risk: "Risk",
  document: "Document",
  gate: "Gate",
  scan: "Scan",
  strategy_section: "Strategy section",
  plan_section: "Plan section",
  stage: "Stage",
  test_condition: "Condition",
  test_case: "Test case",
  test_data: "Test data",
};

/**
 * A cited item (design P2 §11.3). Requirements, risks and gates navigate; evidence and documents open the
 * evidence drawer. The accessible name is the full name. A cited id that doesn't exist is plain text, "TC-0999 (not found)" (P3 §16.1).
 */
export function CitationChip({ refItem, token }: { refItem: ArtefactRef | null; token: string }) {
  const openEvidence = useEvidence();
  if (!refItem) return <span className="font-mono">{token} (not found)</span>;
  const name = `${TYPE_NAME[refItem.type] ?? "Item"} ${refItem.key}${refItem.label && refItem.label !== refItem.key ? `: ${refItem.label}` : ""}`;
  const cls =
    "mx-0.5 inline-flex min-h-6 items-center rounded-sm bg-accent-soft px-1.5 font-mono text-small font-medium text-navy-700 ring-1 ring-inset ring-navy-200 hover:bg-navy-100 hover:text-navy-900";
  if ((refItem.type === "evidence" || refItem.type === "document") && refItem.id)
    return (
      <button type="button" aria-label={name} className={cls} onClick={() => openEvidence({ items: [{ id: refItem.id! }], subject: name })}>
        {refItem.key}
      </button>
    );
  if (refItem.path)
    return (
      <Link href={refItem.path} aria-label={name} className={cls}>
        {refItem.key}
      </Link>
    );
  return <span className="font-mono">{refItem.key}</span>;
}

/** Plain text with ID tokens turned into citation chips. Never interpreted as HTML. */
function Cited({ text, citations }: { text: string; citations: ArtefactRef[] }) {
  return (
    <>
      {splitCitations(text).map((p, i) =>
        p.kind === "text" ? <InlineMd key={i} text={p.text} /> : <CitationChip key={i} token={p.text} refItem={citations.find((c) => c.key === p.text) ?? null} />,
      )}
    </>
  );
}

/** **bold** and `code` only; everything else stays literal text. */
function InlineMd({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
          <strong key={i}>{p.slice(2, -2)}</strong>
        ) : p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
          <code key={i} className="rounded bg-overlay px-1 font-mono text-small">
            {p.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** Minimal markdown blocks: paragraphs, "- " lists, "## " headings and "> " quoted (untrusted) text. */
export function MessageBody({ content, citations }: { content: string; citations: ArtefactRef[] }) {
  const lines = content.split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  let quote: string[] = [];
  const flush = () => {
    if (list.length) {
      const items = list;
      blocks.push(
        <ul key={`l${blocks.length}`} className="list-disc space-y-1 pl-5">
          {items.map((l, i) => (
            <li key={i}>
              <Cited text={l} citations={citations} />
            </li>
          ))}
        </ul>,
      );
      list = [];
    }
    if (quote.length) {
      const q = quote;
      blocks.push(
        <figure key={`q${blocks.length}`} className="rounded-md bg-overlay px-3 py-2">
          <figcaption className="text-caption font-semibold text-fg-muted">Quoted content (untrusted)</figcaption>
          <blockquote className="whitespace-pre-wrap break-words text-body text-fg">{q.join("\n")}</blockquote>
        </figure>,
      );
      quote = [];
    }
  };
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^\s*[-*•]\s+/.test(l)) {
      if (quote.length) flush();
      list.push(l.replace(/^\s*[-*•]\s+/, ""));
    } else if (/^>\s?/.test(l)) {
      if (list.length) flush();
      quote.push(l.replace(/^>\s?/, ""));
    } else {
      flush();
      if (!l.trim()) continue;
      if (/^#{1,4}\s+/.test(l))
        blocks.push(
          <p key={`h${blocks.length}`} className="font-semibold text-fg-strong">
            <Cited text={l.replace(/^#{1,4}\s+/, "")} citations={citations} />
          </p>,
        );
      else
        blocks.push(
          <p key={`p${blocks.length}`}>
            <Cited text={l} citations={citations} />
          </p>,
        );
    }
  }
  flush();
  return <div className="space-y-2 text-body text-fg">{blocks}</div>;
}

const STAGE_LABEL: Partial<Record<StageKey, string>> = {
  discovery: "Scan",
  requirements: "Requirements v",
  test_strategy: "Strategy v",
  readiness_criteria: "Ready & Done v",
  test_design: "Test design run ",
};

function changedText(k: StageKey, n: number): string {
  if (k === "discovery") return `the latest scan is Scan ${n}`;
  if (k === "requirements") return `Requirements are now v${n}`;
  if (k === "test_strategy") return `Strategy is now v${n}`;
  if (k === "test_design") return `the current test design run is ${n}`;
  return `Ready & Done is now v${n}`;
}

export function basedOnText(v: Partial<Record<StageKey, number>> | null | undefined): string | null {
  if (!v) return null;
  const parts = Object.entries(v)
    .filter(([k]) => STAGE_LABEL[k as StageKey])
    .map(([k, n]) => (k === "discovery" ? `Scan ${n}` : `${STAGE_LABEL[k as StageKey]}${n}`));
  return parts.length ? parts.join(" · ") : null;
}

/**
 * One message in the thread (design P2 §11.3): header with provenance tag, cited body, notices, the
 * "Based on" footer and copy. Streaming answers are aria-busy; only "Answer ready" is announced.
 */
export function AnswerCard({
  message,
  streaming,
  streamText,
  stopped,
  current,
  onAskAgain,
  onFollowUp,
  children,
}: {
  message: AssistantMessage | null;
  streaming?: boolean;
  streamText?: string;
  stopped?: boolean;
  /** Current data versions, to flag answers whose data changed since. */
  current?: Partial<Record<StageKey, number>>;
  onAskAgain?: () => void;
  onFollowUp?: (f: NonNullable<AssistantMessage["follow_ups"]>[number]) => void;
  children?: React.ReactNode;
}) {
  const toast = useToast();
  const hid = useId();
  const isUser = message?.role === "user";
  const computed = message?.answered_by === "intent" || message?.generated_by === "rules";
  const changed =
    message?.data_versions && current
      ? Object.entries(message.data_versions).filter(([k, n]) => current[k as StageKey] && current[k as StageKey] !== n && STAGE_LABEL[k as StageKey])
      : [];
  return (
    <article aria-labelledby={hid} aria-busy={streaming || undefined} className={`rounded-lg border p-4 ${isUser ? "border-line bg-elevated" : "border-line bg-surface"}`}>
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 id={hid} className="text-small font-semibold text-fg-strong">
          {isUser ? "You" : "AI QA Analyst"}
          {message?.created_at && <span className="font-normal text-fg-muted"> · {fmtDateTime(message.created_at)}</span>}
        </h3>
        {!isUser && message && <GeneratedByLabel generatedBy={computed ? "computed" : "ai"} />}
      </header>
      {streaming ? (
        <div className="space-y-2">
          {streamText ? (
            <p className="whitespace-pre-wrap text-body text-fg">{streamText}</p>
          ) : (
            <p className="inline-flex items-center gap-2 text-body text-fg-muted">
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
              {message ? "Writing an answer…" : "Checking project data…"}
            </p>
          )}
        </div>
      ) : message ? (
        <MessageBody content={message.content} citations={message.citations} />
      ) : null}
      {stopped && <p className="mt-2 text-small font-medium text-warning-fg">Stopped. Partial answer.</p>}
      {!isUser && message && message.notices.length > 0 && (
        <ul className="mt-3 space-y-1">
          {message.notices
            .filter((n) => n.code !== "built_in_answer")
            .map((n, i) => (
              <li key={i}>
                <Callout tone={n.code === "ai_unavailable" || n.code === "unresolved_citation" ? "warning" : "neutral"}>{n.message}</Callout>
              </li>
            ))}
          {message.notices.some((n) => n.code === "built_in_answer") && <li className="text-small text-fg-muted">Answered with a built-in query.</li>}
        </ul>
      )}
      {children}
      {!isUser && message && !streaming && (
        <footer className="mt-3 space-y-2 border-t border-line pt-2 text-small text-fg-muted">
          {basedOnText(message.data_versions) && <p>Based on: {basedOnText(message.data_versions)}</p>}
          {changed.length > 0 && (
            <p className="text-warning-fg">
              Data changed since this answer: {changed.map(([k]) => changedText(k as StageKey, current?.[k as StageKey] ?? 0)).join(", ")}.{" "}
              {onAskAgain && (
                <button type="button" onClick={onAskAgain} className="font-medium text-navy-700 underline underline-offset-2">
                  Ask again
                </button>
              )}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              icon={<Copy className="h-4 w-4" aria-hidden />}
              onClick={() =>
                void navigator.clipboard
                  .writeText(message.content)
                  .then(() => toast("Answer copied."))
                  .catch(() => toast("Couldn’t copy the answer.", "error"))
              }
            >
              Copy answer
            </Button>
            {(message.follow_ups ?? []).slice(0, 3).map((f) => (
              <Button key={f.label} size="sm" variant="secondary" onClick={() => onFollowUp?.(f)}>
                {f.label}
              </Button>
            ))}
          </div>
        </footer>
      )}
    </article>
  );
}
