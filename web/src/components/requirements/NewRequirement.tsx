"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import type { RequirementCategory, RequirementCreate, RequirementDetail } from "@/lib/contract";
import { CATEGORY_TEXT } from "@/lib/requirements";
import { Button, Card, CardBody, InlineError, SelectField, TextArea, TextField, useToast } from "@/components/ui";
import { ProvenanceLabel } from "@/components/domain/ObservationLabel";
import { noteGateReopened, useDiscoveryFeatures } from "./hooks";

const NON_FUNCTIONAL: RequirementCategory[] = ["accessibility", "usability", "compatibility", "performance", "security", "privacy"];

/** Validates the create form (contract: title 5–160, description ≤ 2000). */
export function validateNewRequirement(f: { title: string; description: string; category: string }): Partial<Record<"title" | "description" | "category", string>> {
  const e: Partial<Record<"title" | "description" | "category", string>> = {};
  const t = f.title.trim();
  if (t.length < 5) e.title = "Enter a title of at least 5 characters.";
  else if (t.length > 160) e.title = "Use 160 characters or fewer.";
  if (f.description.length > 2000) e.description = "Use 2,000 characters or fewer.";
  if (!f.category) e.category = "Choose a category.";
  return e;
}

/**
 * [Add requirement] (design §5.9): source User, label Assumed (set by the server; no evidence picker in
 * Phase 2), status Draft, next REQ id.
 */
export function NewRequirement({ projectId, g3Approved }: { projectId: string; g3Approved: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const features = useDiscoveryFeatures(projectId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<RequirementCategory | "">("");
  const [scope, setScope] = useState<RequirementCreate["behaviour_scope"]>("ui");
  const [featureIds, setFeatureIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<ReturnType<typeof validateNewRequirement>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const catRef = useRef<HTMLSelectElement>(null);
  const base = `/projects/${projectId}/requirements`;

  async function submit() {
    const e = validateNewRequirement({ title, description, category });
    setErrors(e);
    setError(null);
    if (e.title) return titleRef.current?.focus();
    if (e.category) return catRef.current?.focus();
    if (e.description) return;
    setBusy(true);
    try {
      const body: RequirementCreate = {
        title: title.trim(),
        description: description.trim(),
        type: NON_FUNCTIONAL.includes(category as RequirementCategory) ? "non_functional" : "functional",
        category: category as RequirementCategory,
        behaviour_scope: scope,
        assumptions: [],
        feature_ids: featureIds,
      };
      const r = await api<RequirementDetail>(`/projects/${projectId}/requirements`, { body });
      toast(`${r.key} added as Draft.`);
      noteGateReopened(projectId, "G3", g3Approved, toast);
      router.replace(`${base}/${r.key}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setError("You don’t have permission to add requirements. Ask an owner or admin.");
      else if (err instanceof ApiError && err.code === "network") setError("You’re offline. Your changes are still here; save again when you reconnect.");
      else setError(`Couldn’t add the requirement. Your changes are still here. ${err instanceof Error ? err.message : ""}`.trim());
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-small text-fg-muted">
        <Link href={base} className="text-navy-700 underline underline-offset-2">
          Requirements
        </Link>{" "}
        / New
      </nav>
      <h1 tabIndex={-1} className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
        Add requirement
      </h1>
      <Card>
        <CardBody>
          <form
            noValidate
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <p className="flex flex-wrap items-center gap-2 text-small text-fg">
              Source: User · Status: Draft · Label: <ProvenanceLabel provenance="assumed" />
            </p>
            <p className="text-small text-fg-muted">Requirements you add are labelled Assumed: they have no linked evidence. Approve it to accept it.</p>
            <TextField ref={titleRef} label="Title" required maxLength={160} value={title} onChange={(e) => setTitle(e.target.value)} error={errors.title} />
            <TextArea label="Description" rows={4} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} error={errors.description} />
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                ref={catRef}
                label="Category"
                required
                value={category}
                onChange={(e) => setCategory(e.target.value as RequirementCategory)}
                placeholder="Choose a category"
                options={Object.entries(CATEGORY_TEXT).map(([value, label]) => ({ value, label }))}
                error={errors.category}
              />
              <SelectField
                label="Behaviour"
                value={scope}
                onChange={(e) => setScope(e.target.value as RequirementCreate["behaviour_scope"])}
                options={[
                  { value: "ui", label: "Visible in the user interface" },
                  { value: "backend", label: "Server-side (not directly observable)" },
                  { value: "mixed", label: "Both" },
                ]}
              />
            </div>
            <fieldset>
              <legend className="mb-1 text-body font-medium text-fg-strong">Related features</legend>
              {features.data?.length ? (
                <div className="grid gap-1 sm:grid-cols-2">
                  {features.data.map((f) => (
                    <label key={f.id} className="flex min-h-6 items-center gap-2 text-body text-fg">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-accent"
                        checked={featureIds.includes(f.id)}
                        onChange={(e) => setFeatureIds(e.target.checked ? [...featureIds, f.id] : featureIds.filter((x) => x !== f.id))}
                      />
                      {f.name}
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-small text-fg-muted">No discovered features to link.</p>
              )}
            </fieldset>
            <InlineError error={error} />
            <div className="flex justify-end gap-2">
              <Link href={base} className="inline-flex h-10 items-center rounded-md bg-surface px-4 text-body font-medium text-fg-strong ring-1 ring-inset ring-line-input hover:bg-overlay">
                Cancel
              </Link>
              <Button type="submit" loading={busy}>
                Add requirement
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
