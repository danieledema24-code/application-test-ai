"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { humanize } from "@/lib/format";
import type { AiStatus, Category, ProjectDetail, TestCase } from "@/lib/types";
import { CATEGORIES } from "@/lib/types";
import { Button, Checkbox, InlineError, Modal, SelectField, StatusPill, TextArea, TextField, useToast } from "@/components/ui";
import { AiDraftBadge } from "./AiBits";
import { ProjectSelect } from "./ProjectSelect";

type Source = "DISCOVERY" | "USER_STORY" | "REQUIREMENTS" | "DESCRIPTION" | "OPENAPI";
const SOURCES: { value: Source; label: string; placeholder: string }[] = [
  { value: "DISCOVERY", label: "Pages found by the site scan", placeholder: "e.g. focus on the contact form" },
  { value: "USER_STORY", label: "User story", placeholder: "As a customer, I want to reset my password so that…" },
  { value: "REQUIREMENTS", label: "Requirements", placeholder: "Paste requirements or acceptance criteria…" },
  { value: "DESCRIPTION", label: "A description I write", placeholder: "e.g. The contact page at /contact lets visitors send a message. Name and Email are required…" },
];

type GenerateResponse = { generated: TestCase[]; generatedBy: "claude" | "heuristic"; notes: string };

export function GenerateCasesModal({
  open,
  onClose,
  projectId: fixedProjectId,
  onGenerated,
  onApproveAndRun,
}: {
  open: boolean;
  onClose: () => void;
  projectId?: string;
  onGenerated?: () => void;
  /** Approve the new cases and go straight to running them. */
  onApproveAndRun?: (ids: string[]) => void;
}) {
  const toast = useToast();
  const [projectId, setProjectId] = useState(fixedProjectId || "");
  const [source, setSource] = useState<Source>("DESCRIPTION");
  const [text, setText] = useState("");
  // Form validation, boundary and sign-in cases are where most bugs are found, so they are on by default.
  const [cats, setCats] = useState<Set<Category>>(new Set(["FUNCTIONAL", "POSITIVE", "NEGATIVE", "FORM_VALIDATION", "BOUNDARY", "AUTHENTICATION"]));
  const [count, setCount] = useState(20);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<GenerateResponse | null>(null);

  useEffect(() => {
    if (open) {
      setProjectId(fixedProjectId || "");
      setResult(null);
      setError(null);
    }
  }, [open, fixedProjectId]);

  const { data: project } = useApi<ProjectDetail>(open && projectId ? `/projects/${projectId}` : null);
  const { data: ai } = useApi<AiStatus>(open ? "/ai/status" : null);
  const aiOff = ai?.enabled === false;
  const discoveryId = project?.discovery?.status === "COMPLETED" ? project.discovery.id : undefined;
  // Once the app has been scanned, the map is the easiest starting point: no writing needed.
  useEffect(() => {
    if (open && discoveryId) setSource("DISCOVERY");
  }, [open, discoveryId]);
  const src = SOURCES.find((s) => s.value === source)!;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (source === "DISCOVERY" && !discoveryId) return setError("Scan your site first, or describe what to test instead.");
    if (source !== "DISCOVERY" && !text.trim()) return setError("Describe what you’d like to test.");
    setLoading(true);
    setError(null);
    try {
      const res = await api<GenerateResponse>(`/projects/${projectId}/test-cases/generate`, {
        body: {
          source,
          ...(text.trim() ? { text } : {}),
          ...(source === "DISCOVERY" && discoveryId ? { discoveryId } : {}),
          categories: Array.from(cats),
          count,
        },
      });
      setResult(res);
      toast(`${res.generated.length} checks suggested`);
      onGenerated?.();
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <span className="inline-flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-violet-300" aria-hidden /> {aiOff ? "Suggest checks" : "Suggest checks with AI"}
        </span>
      }
      description={
        aiOff
          ? "We suggest checks from the pages and forms your scan found, or from a description you write. Nothing runs until you approve it."
          : "AI suggests checks for you. Nothing runs until you approve them."
      }
      footer={
        result ? (
          onApproveAndRun && result.generated.length > 0 ? (
            <>
              <Button variant="secondary" onClick={onClose}>
                Review them first
              </Button>
              <Button onClick={() => onApproveAndRun(result.generated.map((c) => c.id))}>Approve all and run</Button>
            </>
          ) : (
            <Button onClick={onClose}>Done</Button>
          )
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="gen-cases-form" loading={loading} disabled={!projectId}>
              Suggest checks
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          {result.generatedBy === "claude" && <AiDraftBadge />}
          <p className="text-sm text-fg">
            {result.generated.length} checks suggested. Skim the list: delete any that don’t apply to your site, or approve them all and run.
          </p>
          {result.notes && (
            <details className="text-sm text-fg-muted">
              <summary className="cursor-pointer">How these were made</summary>
              <p className="mt-1">{result.notes}</p>
            </details>
          )}
          <ul className="divide-y divide-line rounded-md border border-line">
            {result.generated.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="font-mono text-xs text-fg-muted">{c.key}</span>
                <Link href={`/test-cases/${c.id}`} className="min-w-0 flex-1 truncate font-medium text-fg-strong hover:underline">
                  {c.title}
                </Link>
                <span className="text-xs text-fg-muted">{humanize(c.category)}</span>
                <StatusPill status={c.status} />
              </li>
            ))}
          </ul>
          {result.generated.length === 0 && <p className="text-sm text-fg-muted">No cases were generated. Try adding more detail.</p>}
        </div>
      ) : (
        <form id="gen-cases-form" onSubmit={submit} className="space-y-4">
          {!fixedProjectId && <ProjectSelect value={projectId} onChange={setProjectId} required />}
          <SelectField label="Source" value={source} onChange={(e) => setSource(e.target.value as Source)} options={SOURCES.map((s) => ({ value: s.value, label: s.label }))} />
          {source === "DISCOVERY" && projectId && !discoveryId && (
            <p className="rounded-md bg-amber-500/10 p-2.5 text-sm text-amber-200">No completed discovery for this project yet. Start one from the Discovery tab.</p>
          )}
          <TextArea
            label={source === "DISCOVERY" ? "Anything specific to focus on? (optional)" : "Describe what to test"}
            rows={source === "OPENAPI" ? 10 : 6}
            mono={source === "OPENAPI"}
            placeholder={src.placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <details className="rounded-lg border border-line px-3 py-2 [&[open]]:pb-3">
            <summary className="cursor-pointer text-sm font-medium text-fg">Advanced options</summary>
          <fieldset className="mt-3">
            <legend className="mb-1.5 text-sm font-medium text-fg">Kinds of checks</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {CATEGORIES.map((c) => (
                <Checkbox
                  key={c}
                  label={<span className="font-normal">{humanize(c)}</span>}
                  checked={cats.has(c)}
                  onChange={() =>
                    setCats((s) => {
                      const n = new Set(s);
                      if (n.has(c)) n.delete(c);
                      else n.add(c);
                      return n;
                    })
                  }
                />
              ))}
            </div>
          </fieldset>
          <TextField label="How many checks (max)" type="number" min={1} max={40} value={count} onChange={(e) => setCount(Number(e.target.value) || 1)} wrapClassName="mt-3 max-w-[10rem]" />
          </details>
          <InlineError error={error} />
        </form>
      )}
    </Modal>
  );
}
