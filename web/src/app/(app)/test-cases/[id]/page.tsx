"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, CheckCheck, Code2, Download, Eye, Pencil, RefreshCw, Save, Sparkles, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { fmtDateTime, fmtDuration, humanize, personName } from "@/lib/format";
import type { AiStatus, Category, Priority, Script, TestCaseDetail, TestStep } from "@/lib/types";
import { CATEGORIES, PRIORITIES } from "@/lib/types";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  InlineError,
  LoadingBlock,
  PageHeader,
  SelectField,
  StatusPill,
  TBody,
  THead,
  Table,
  Td,
  TextArea,
  TextField,
  Th,
  Tr,
  useToast,
} from "@/components/ui";
import { AiDraftBadge } from "@/components/domain/AiBits";
import { StepsEditor } from "@/components/domain/StepsEditor";
import { TestCaseDocument } from "@/components/domain/TestCaseDocument";

type Form = { title: string; description: string; preconditions: string; expectedResult: string; category: Category; priority: Priority; steps: TestStep[] };

function toForm(tc: TestCaseDetail): Form {
  return {
    title: tc.title,
    description: tc.description || "",
    preconditions: tc.preconditions || "",
    expectedResult: tc.expectedResult || "",
    category: tc.category,
    priority: tc.priority,
    steps: tc.steps?.length ? tc.steps : [{ action: "", data: "", expected: "" }],
  };
}

const SCRIPT_PLACEHOLDER = `import { test, expect } from "../fixtures";

test("TC-0001: user can sign in", async ({ page }) => {
  await test.step("Open the login page", async () => {
    await page.goto(process.env.BASE_URL + "/login");
  });
  await test.step("Sign in", async () => {
    await page.getByLabel("Email").fill(process.env.TEST_USERNAME ?? "");
    await page.getByLabel("Password").fill(process.env.TEST_PASSWORD ?? "");
    await page.getByRole("button", { name: "Sign in" }).click();
  });
  await expect(page).toHaveURL(/dashboard/);
});`;

function languageLabel(language: string | undefined) {
  if (!language || language === "playwright-test") return "Playwright Test (TypeScript)";
  return `Legacy ${humanize(language)} script — regenerated as Playwright Test on next run`;
}

/** Save the script currently shown in the editor as <caseKey>.spec.ts (client-side). */
function downloadSpec(filename: string, code: string) {
  const blob = new Blob([code], { type: "text/typescript;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ScriptPanel({ tc, onChanged }: { tc: TestCaseDetail; onChanged: () => void }) {
  const toast = useToast();
  const scripts = [...(tc.scripts || [])].sort((a, b) => b.version - a.version);
  const [viewing, setViewing] = useState<Script | null>(scripts[0] || null);
  const [code, setCode] = useState(scripts[0]?.code || "");
  const [busy, setBusy] = useState<null | "gen" | "save">(null);
  const [error, setError] = useState<unknown>(null);
  const latestId = scripts[0]?.id;
  // Drafts can have a script (site scans attach them automatically); only running one needs approval.
  const runnable = tc.status === "APPROVED" || tc.status === "READY";

  useEffect(() => {
    const latest = (tc.scripts || []).reduce<Script | null>((m, s) => (!m || s.version > m.version ? s : m), null);
    setViewing(latest);
    setCode(latest?.code || "");
  }, [latestId, tc.scripts]);

  async function generate() {
    setBusy("gen");
    setError(null);
    try {
      // v1.1: the backend generates Playwright Test specs by default.
      await api<Script>(`/test-cases/${tc.id}/scripts/generate`, { body: {} });
      toast("Playwright script generated — review before running");
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    setError(null);
    try {
      await api<Script>(`/test-cases/${tc.id}/scripts`, { method: "PUT", body: { code } });
      toast("New script version saved");
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  const dirty = viewing ? code !== viewing.code : code.trim() !== "";
  const outdated = viewing && viewing.testCaseVersion < tc.version;

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Code2 className="h-4 w-4 text-fg-muted" aria-hidden /> Automation script
          </span>
        }
        description={languageLabel(viewing?.language)}
        actions={
          <>
            <Button
              size="sm"
              variant="secondary"
              icon={<Download className="h-4 w-4" aria-hidden />}
              disabled={!code.trim()}
              onClick={() => downloadSpec(`${tc.key}.spec.ts`, code)}
              title={`Save the script shown below as ${tc.key}.spec.ts`}
            >
              Download .spec.ts
            </Button>
            <Button size="sm" variant="secondary" icon={<Sparkles className="h-4 w-4" aria-hidden />} loading={busy === "gen"} onClick={generate}>
              {scripts.length ? "Regenerate script" : "Generate script"}
            </Button>
            <Button size="sm" icon={<Save className="h-4 w-4" aria-hidden />} loading={busy === "save"} disabled={!dirty} onClick={save}>
              Save as new version
            </Button>
          </>
        }
      />
      <CardBody className="space-y-3">
        {!runnable && <p className="text-sm text-fg-muted">Approve this check to run its automated test.</p>}
        {outdated && (
          <p className="rounded-md bg-amber-500/10 p-2.5 text-sm text-amber-200">
            This script was written for test case v{viewing!.testCaseVersion}; the case is now v{tc.version}. Review or regenerate it.
          </p>
        )}
        {scripts.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-fg-muted">Versions:</span>
            {scripts.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setViewing(s);
                  setCode(s.code);
                }}
                aria-pressed={viewing?.id === s.id}
                className={`rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${viewing?.id === s.id ? "bg-accent-soft text-fg-strong ring-accent/60" : "text-fg ring-line hover:bg-elevated"}`}
                title={`${fmtDateTime(s.createdAt)} · ${personName(s.createdBy)}`}
              >
                v{s.version}
              </button>
            ))}
          </div>
        )}
        <TextArea
          label="Script code"
          hideLabel
          mono
          rows={18}
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={`Generate a script or paste a Playwright Test spec, e.g.\n\n${SCRIPT_PLACEHOLDER}`}
          className="bg-canvas text-fg placeholder:text-fg-subtle"
        />
        <p className="text-xs text-fg-muted">
          Standard Playwright Test spec: <code className="font-mono text-fg">import {"{ test, expect }"} from &quot;../fixtures&quot;</code>, one{" "}
          <code className="font-mono text-fg">test(…)</code> with <code className="font-mono text-fg">test.step(…)</code> per step. Read the target from{" "}
          <code className="font-mono text-fg">process.env.BASE_URL</code>, <code className="font-mono text-fg">TEST_USERNAME</code> and{" "}
          <code className="font-mono text-fg">TEST_PASSWORD</code> — never hard-code credentials.
        </p>
        {viewing && (
          <p className="text-xs text-fg-muted">
            Viewing v{viewing.version} · {viewing.language === "playwright-test" ? "Playwright Test" : humanize(viewing.language)} · for case v{viewing.testCaseVersion} · {fmtDateTime(viewing.createdAt)} · {personName(viewing.createdBy)}
          </p>
        )}
        <InlineError error={error} />
      </CardBody>
    </Card>
  );
}

export default function TestCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const { data: tc, error, isLoading, mutate } = useApi<TestCaseDetail>(`/test-cases/${id}`);
  const { data: aiStatus } = useApi<AiStatus>("/ai/status");
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "delete" | "regenerate">(null);

  useEffect(() => {
    if (tc) setForm(toForm(tc));
  }, [tc]);

  if (error && !tc)
    return (
      <Card>
        <ErrorState error={error} onRetry={() => mutate()} />
      </Card>
    );
  if (isLoading || !tc || !form) return <LoadingBlock label="Loading test case…" />;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api(`/test-cases/${id}`, {
        method: "PATCH",
        body: { ...form, steps: form.steps.filter((s) => s.action.trim()) },
      });
      toast("Test case saved");
      await mutate();
      setEditing(false);
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(status: "APPROVED" | "READY" | "DEPRECATED") {
    setBusy(status);
    try {
      await api(`/test-cases/${id}/status`, { body: { status } });
      toast(`Status changed to ${humanize(status).toLowerCase()}`);
      await mutate();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Update failed", "error");
    } finally {
      setBusy(null);
    }
  }

  async function regenerate() {
    setBusy("regenerate");
    try {
      await api(`/test-cases/${id}/regenerate`, { method: "POST" });
      toast("Test case regenerated as a draft — review it");
      setConfirm(null);
      await mutate();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Regenerate failed", "error");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("delete");
    try {
      await api(`/test-cases/${id}`, { method: "DELETE" });
      toast(`${tc!.key} deleted`);
      router.push(`/projects/${tc!.projectId}?tab=test-cases`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Delete failed", "error");
      setBusy(null);
    }
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(tc));

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href={`/projects/${tc.projectId}?tab=test-cases`} className="hover:underline">
            ← Back to test cases
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-base text-fg-muted">{tc.key}</span> {tc.title}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill status={tc.status} />
            <StatusPill status={tc.priority} dot={false} />
            <Badge>{humanize(tc.category)}</Badge>
            <Badge>v{tc.version}</Badge>
            <span className="text-xs">Source: {humanize(tc.source)}</span>
            {/* Rule-based drafts get the plain draft badge; older ones were stored as AI, so AI being off also counts. */}
            {(tc.aiGenerated || tc.source === "RULE_BASED") && tc.status === "DRAFT" && <AiDraftBadge ruleBased={!tc.aiGenerated || aiStatus?.enabled === false} />}
            {tc.lastResult && (
              <span className="inline-flex items-center gap-1 text-xs">
                Last result <StatusPill status={tc.lastResult} />
              </span>
            )}
          </span>
        }
        actions={
          <>
            {tc.status !== "APPROVED" && tc.status !== "READY" && (
              <Button variant="success" icon={<Check className="h-4 w-4" aria-hidden />} loading={busy === "APPROVED"} onClick={() => setStatus("APPROVED")}>
                Approve
              </Button>
            )}
            {tc.status !== "READY" && (
              <Button variant="secondary" icon={<CheckCheck className="h-4 w-4" aria-hidden />} loading={busy === "READY"} onClick={() => setStatus("READY")}>
                Mark ready
              </Button>
            )}
            <Button variant="secondary" icon={<RefreshCw className="h-4 w-4" aria-hidden />} onClick={() => setConfirm("regenerate")}>
              Regenerate
            </Button>
            {tc.status !== "DEPRECATED" && (
              <Button variant="ghost" loading={busy === "DEPRECATED"} onClick={() => setStatus("DEPRECATED")}>
                Deprecate
              </Button>
            )}
            <Button variant="ghost" icon={<Trash2 className="h-4 w-4" aria-hidden />} onClick={() => setConfirm("delete")} aria-label="Delete test case" />
          </>
        }
      />

      <div className="grid gap-6 2xl:grid-cols-2">
        <Card>
          <CardHeader
            title={editing ? "Edit test case" : "Test case"}
            description={editing ? "Saving creates a new version and returns the case for review." : "Follow the steps in order and compare each outcome with the expected result."}
            actions={
              <Button size="sm" variant="secondary" icon={editing ? <Eye className="h-4 w-4" aria-hidden /> : <Pencil className="h-4 w-4" aria-hidden />} onClick={() => setEditing((v) => !v)}>
                {editing ? "View" : "Edit"}
              </Button>
            }
          />
          <CardBody>
            {editing ? (
              <form onSubmit={save} className="space-y-4">
                <TextField label="Title" required value={form.title} onChange={(e) => set("title", e.target.value)} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <SelectField label="Category" value={form.category} onChange={(e) => set("category", e.target.value as Category)} options={CATEGORIES} />
                  <SelectField label="Priority" value={form.priority} onChange={(e) => set("priority", e.target.value as Priority)} options={PRIORITIES} />
                </div>
                <TextArea label="Description" rows={3} value={form.description} onChange={(e) => set("description", e.target.value)} />
                <TextArea label="Preconditions" rows={2} value={form.preconditions} onChange={(e) => set("preconditions", e.target.value)} />
                <StepsEditor steps={form.steps} onChange={(s) => set("steps", s)} />
                <TextArea label="Expected result" rows={2} value={form.expectedResult} onChange={(e) => set("expectedResult", e.target.value)} />
                <InlineError error={saveError} />
                <div className="flex gap-2">
                  <Button type="submit" loading={saving} disabled={!dirty}>
                    Save changes
                  </Button>
                  {dirty && (
                    <Button variant="ghost" onClick={() => setForm(toForm(tc))}>
                      Discard
                    </Button>
                  )}
                </div>
              </form>
            ) : (
              <TestCaseDocument description={tc.description} preconditions={tc.preconditions} steps={tc.steps ?? []} expectedResult={tc.expectedResult} />
            )}
          </CardBody>
        </Card>

        <div className="space-y-6">
          <ScriptPanel tc={tc} onChanged={() => mutate()} />
          <Card>
            <CardHeader title="Execution history" description="Recorded results for this test case" />
            {!tc.history || tc.history.length === 0 ? (
              <EmptyState title="Not executed yet" />
            ) : (
              <Table label="Execution history">
                <THead>
                  <tr>
                    <Th>Run</Th>
                    <Th>Result</Th>
                    <Th>Duration</Th>
                    <Th>Script</Th>
                    <Th>Executed</Th>
                  </tr>
                </THead>
                <TBody>
                  {tc.history.map((r) => (
                    <Tr key={r.id}>
                      <Td>
                        <Link href={`/test-runs/${r.testRunId}`} className="font-medium text-fg-strong hover:underline">
                          View run
                        </Link>
                      </Td>
                      <Td>
                        <StatusPill status={r.status} />
                      </Td>
                      <Td className="tabular-nums">{fmtDuration(r.durationMs)}</Td>
                      <Td>{r.scriptVersion ? `v${r.scriptVersion}` : "—"}</Td>
                      <Td className="whitespace-nowrap text-fg-muted">
                        {fmtDateTime(r.executedAt)} · {personName(r.executedBy)}
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </div>
      </div>

      <ConfirmDialog open={confirm === "delete"} onClose={() => setConfirm(null)} onConfirm={remove} loading={busy === "delete"} danger title={`Delete ${tc.key}?`} confirmLabel="Delete">
        This permanently deletes the test case and its automation scripts.
      </ConfirmDialog>
      <ConfirmDialog open={confirm === "regenerate"} onClose={() => setConfirm(null)} onConfirm={regenerate} loading={busy === "regenerate"} title="Regenerate with AI?" confirmLabel="Regenerate">
        AI will rewrite this test case. It will return to <strong>Draft</strong> and must be reviewed and approved again.
      </ConfirmDialog>
    </>
  );
}
