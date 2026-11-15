"use client";

// Load profile editor (design P5 §9.2): pages to load (eligible discovered pages only), traffic stages, pause,
// max requests a second and thresholds, with the organisation's limits inline. Requirement thresholds can be
// tightened, never loosened or removed. Every save is a new version; older versions are read-only (`?v=`).

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { api, ApiError, downloadFile, errorMessage } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import {
  durationShort,
  limitErrors,
  profileTotals,
  thresholdLimit,
  thresholdMeasure,
  thresholdScope,
  thresholdSource,
  type Profile,
  type Stage,
  type Target,
  type Threshold,
} from "@/lib/nonfunctional";
import { Button, Callout, Checkbox, ErrorState, InlineError, Modal, Skeleton, Table, TBody, Td, TextField, Th, THead, Tr, useToast } from "@/components/ui";
import { GeneratedByLabel } from "@/components/domain/ObservationLabel";
import { useProject } from "@/components/workspace/ProjectContext";
import { LoadTestRequestDialog } from "./LoadApproval";

type Eligible = { page_id: string; path: string; title: string; reason: string | null };

function AddPagesDialog({ open, onClose, projectId, current, onAdd, max }: { open: boolean; onClose: () => void; projectId: string; current: string[]; onAdd: (paths: string[]) => void; max: number }) {
  const pages = useApi<{ items: Eligible[] }>(open ? `/projects/${projectId}/performance-profiles/eligible-pages` : null);
  const [picked, setPicked] = useState<string[]>([]);
  const total = current.length + picked.length;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add pages"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onAdd(picked);
              onClose();
            }}
            disabled={!picked.length}
          >
            Add {picked.length || ""} page{picked.length === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      {!pages.data ? (
        <Skeleton className="h-32" />
      ) : (
        <div className="space-y-2">
          <p className="text-small text-fg-muted">Only public pages discovery visited, opened with GET, never signed in.</p>
          {total >= max && <p className="text-small font-medium text-warning-fg">A profile can load at most {max} pages.</p>}
          {pages.data.items
            .filter((e) => !current.includes(e.path))
            .map((e) => (
              <Checkbox
                key={e.page_id}
                label={e.path}
                description={e.reason ? `Can't be loaded: ${e.reason}` : e.title}
                disabled={!!e.reason || (!picked.includes(e.path) && total >= max)}
                checked={picked.includes(e.path)}
                onChange={(ev) => setPicked(ev.target.checked ? [...picked, e.path] : picked.filter((x) => x !== e.path))}
              />
            ))}
        </div>
      )}
    </Modal>
  );
}

export function ProfileEditor({ profileKey }: { profileKey: string }) {
  const p = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { role } = useAuth();
  const v = params.get("v");
  const prof = useApi<Profile>(`/projects/${p.id}/performance-profiles/by-key/${profileKey}`, v ? { v } : undefined);
  const d = prof.data;
  const readOnly = !d || !!d.read_only || !d.permissions?.can_edit || role === "viewer";
  const [stages, setStages] = useState<Stage[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [thresholds, setThresholds] = useState<Threshold[]>([]);
  const [maxRps, setMaxRps] = useState(0);
  const [think, setThink] = useState({ min: 500, max: 1500 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // `?request=1` opens the request dialog ([Request again] on a request that can't be approved as made, check 21).
  const [requesting, setRequesting] = useState(params.get("request") === "1" && !v);
  useEffect(() => {
    if (!d) return;
    setStages(d.stages.map((s) => ({ ...s })));
    setTargets(d.targets.map((t) => ({ ...t })));
    setThresholds(d.thresholds.map((t) => ({ ...t })));
    setMaxRps(d.max_rps);
    setThink(d.think_time_ms);
  }, [d]);
  useEffect(() => {
    document.title = `${profileKey} · Non-functional · ${p.project?.name ?? "Project"} · QA Analyst`;
  }, [profileKey, p.project?.name]);
  const totals = useMemo(() => profileTotals(stages, targets.length, maxRps), [stages, targets.length, maxRps]);
  const lim = d?.limits;
  const errs = lim ? limitErrors(totals, lim.organisation, lim.server) : {};
  const dirty = !!d && JSON.stringify([stages, targets.map((t) => [t.path, t.weight]), thresholds, maxRps, think]) !== JSON.stringify([d.stages, d.targets.map((t) => [t.path, t.weight]), d.thresholds, d.max_rps, d.think_time_ms]);

  const back = (
    <Link href={`/projects/${p.id}/non-functional?tab=performance`} className="inline-flex items-center gap-1 text-small font-medium text-fg-muted hover:text-fg-strong">
      <ArrowLeft className="h-4 w-4" aria-hidden /> Non-functional
    </Link>
  );
  if (prof.error && !d)
    return (
      <div className="space-y-4">
        {back}
        <ErrorState error={prof.error} title={prof.error instanceof ApiError && prof.error.status === 404 ? `We couldn't find ${profileKey} in this project.` : "Couldn't load this profile."} onRetry={() => prof.mutate()} />
      </div>
    );
  if (!d)
    return (
      <div className="space-y-4">
        {back}
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-96" />
      </div>
    );

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await api<Profile & { message: string }>(`/performance-profiles/${d!.id}`, {
        method: "PATCH",
        body: { version: d!.version, stages, targets: targets.map((t) => ({ path: t.path, weight: t.weight })), thresholds, max_rps: maxRps, think_time_ms: think },
      });
      toast(r.message, "success");
      prof.mutate();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }
  async function action(a: "ready" | "retire") {
    setSaving(true);
    setError(null);
    try {
      await api(`/performance-profiles/${d!.id}/${a}`, { method: "POST" });
      toast(a === "ready" ? `${d!.key} is ready.` : `${d!.key} retired.`, "success");
      prof.mutate();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }
  const setStage = (i: number, k: keyof Stage, val: number) => setStages(stages.map((s, j) => (j === i ? { ...s, [k]: val } : s)));
  const stageName = (i: number) => (i === 0 ? "Ramp up" : i === stages.length - 1 && stages[i].target_vus === 0 ? "Ramp down" : "Hold");
  const requestBlocker = d.violations.length || Object.keys(errs).length ? `${d.key} is over your organisation's limits. Edit it first.` : d.status !== "ready" ? `Mark ${d.key} ready first.` : dirty ? "Save your changes first." : null;

  return (
    <div className="space-y-5">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 tabIndex={-1} data-page-title className="text-h1 font-semibold tracking-[-0.015em] text-fg-strong focus:outline-none">
            {d.key} · {d.name}
          </h1>
          <p className="flex flex-wrap items-center gap-2 text-small text-fg-muted">
            <label className="inline-flex items-center gap-1">
              Version
              <select
                className="rounded-md bg-surface px-2 py-1 text-small ring-1 ring-inset ring-line-input"
                value={String(d.version)}
                onChange={(e) => router.replace(`/projects/${p.id}/non-functional/profiles/${profileKey}${Number(e.target.value) === Math.max(...d.versions, d.version) ? "" : `?v=${e.target.value}`}`)}
              >
                {[...new Set([d.version, ...d.versions])].sort((a, b) => b - a).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            · {d.status === "stale" ? "Strategy changed" : d.status.charAt(0).toUpperCase() + d.status.slice(1)} · <GeneratedByLabel generatedBy={d.generated_by} />
          </p>
        </div>
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} loading={saving} disabled={!dirty}>
              Save
            </Button>
            {d.status !== "ready" && (
              <Button variant="secondary" onClick={() => action("ready")} disabled={dirty || saving}>
                Mark ready
              </Button>
            )}
            {d.permissions?.can_request && (
              <Button variant="secondary" aria-disabled={requestBlocker ? true : undefined} aria-describedby={requestBlocker ? "request-why" : undefined} onClick={() => !requestBlocker && setRequesting(true)}>
                Request load test…
              </Button>
            )}
            <Button variant="ghost" onClick={() => action("retire")} disabled={saving}>
              Retire
            </Button>
          </div>
        )}
      </div>
      {!readOnly && requestBlocker && d.permissions?.can_request && (
        <p id="request-why" className="text-small text-fg-muted">
          {requestBlocker}
        </p>
      )}
      {d.read_only && <Callout tone="neutral">You&apos;re viewing version {d.version}, read-only.</Callout>}
      {d.status === "stale" && <Callout tone="warning">{d.stale_reason ?? "The test strategy changed after this profile was written."} This profile still works. Draft it again to pick up changes.</Callout>}
      <p className="text-body text-fg">Type {d.type_label}</p>
      {d.rationale && <p className="text-small text-fg-muted">{d.rationale}</p>}

      <section aria-labelledby="pages-h" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="pages-h" className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
            Pages to load ({targets.length} of at most {lim?.max_targets ?? 10})
          </h2>
          {!readOnly && (
            <Button variant="secondary" size="sm" onClick={() => setAdding(true)} disabled={targets.length >= (lim?.max_targets ?? 10)}>
              Add pages…
            </Button>
          )}
        </div>
        <Table label="Pages to load">
          <THead>
            <tr>
              <Th>Page</Th>
              <Th>Weight</Th>
              <Th>Why</Th>
              <Th srOnly>Actions</Th>
            </tr>
          </THead>
          <TBody>
            {targets.map((t, i) => (
              <Tr key={t.path}>
                <Td rowHeader>{t.path}</Td>
                <Td>
                  {readOnly ? (
                    t.weight
                  ) : (
                    <input
                      type="number"
                      min={1}
                      max={10}
                      aria-label={`Weight of ${t.path}`}
                      value={t.weight}
                      onChange={(e) => setTargets(targets.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) } : x)))}
                      className="w-20 rounded-md bg-surface px-2 py-1 ring-1 ring-inset ring-line-input"
                    />
                  )}
                </Td>
                <Td>{t.why ?? ""}</Td>
                <Td>
                  {!readOnly && targets.length > 1 && (
                    <Button variant="ghost" size="sm" aria-label={`Remove ${t.path} from ${d.key}`} onClick={() => setTargets(targets.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  )}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
        <p className="text-small text-fg-muted">Only public pages discovery visited, opened with GET, never signed in. Forms are never submitted.</p>
      </section>

      <section aria-labelledby="traffic-h" className="space-y-3">
        <h2 id="traffic-h" className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
          Traffic
        </h2>
        <Table label="Stages">
          <THead>
            <tr>
              <Th>Stage</Th>
              <Th>Duration (s)</Th>
              <Th>Users at end of stage</Th>
              <Th srOnly>Actions</Th>
            </tr>
          </THead>
          <TBody>
            {stages.map((s, i) => (
              <Tr key={i}>
                <Td rowHeader>
                  {i + 1} {stageName(i)}
                </Td>
                <Td>
                  {readOnly ? s.duration_s : (
                    <input type="number" min={1} aria-label={`Duration of stage ${i + 1} in seconds`} value={s.duration_s} onChange={(e) => setStage(i, "duration_s", Number(e.target.value))} className="w-24 rounded-md bg-surface px-2 py-1 ring-1 ring-inset ring-line-input" aria-describedby="limit-duration" />
                  )}
                </Td>
                <Td>
                  {readOnly ? s.target_vus : (
                    <input type="number" min={0} aria-label={`Users at end of stage ${i + 1}`} value={s.target_vus} onChange={(e) => setStage(i, "target_vus", Number(e.target.value))} aria-invalid={errs.vus ? true : undefined} className="w-24 rounded-md bg-surface px-2 py-1 ring-1 ring-inset ring-line-input aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-danger-solid" aria-describedby="limit-vus" />
                  )}
                </Td>
                <Td>
                  {!readOnly && stages.length > 1 && (
                    <Button variant="ghost" size="sm" aria-label={`Remove stage ${i + 1}`} onClick={() => setStages(stages.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  )}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
        {!readOnly && stages.length < 10 && (
          <Button variant="secondary" size="sm" onClick={() => setStages([...stages, { duration_s: 30, target_vus: stages[stages.length - 1]?.target_vus ?? 1 }])}>
            Add stage
          </Button>
        )}
        <p id="limit-vus" className={`text-small ${errs.vus ? "font-medium text-danger-fg" : "text-fg-muted"}`}>
          {errs.vus ?? `Up to ${totals.vus} virtual users. Your organisation allows up to ${lim?.organisation.vus ?? "—"} virtual users.`}
        </p>
        <p id="limit-duration" className={`text-small ${errs.duration_s ? "font-medium text-danger-fg" : "text-fg-muted"}`}>
          {errs.duration_s ?? `Total ${durationShort(totals.duration_s)} · your organisation allows up to ${durationShort(lim?.organisation.duration_s)}.`}
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <TextField label="Pause between pages from (s)" type="number" step="0.1" min={0} readOnly={readOnly} value={think.min / 1000} onChange={(e) => setThink({ ...think, min: Math.round(Number(e.target.value) * 1000) })} wrapClassName="w-48" />
          <TextField label="to (s)" type="number" step="0.1" min={0} readOnly={readOnly} value={think.max / 1000} onChange={(e) => setThink({ ...think, max: Math.round(Number(e.target.value) * 1000) })} wrapClassName="w-32" />
          <TextField
            label="Max requests a second"
            type="number"
            min={1}
            readOnly={readOnly}
            value={maxRps}
            onChange={(e) => setMaxRps(Number(e.target.value))}
            error={errs.rps}
            hint={errs.rps ? undefined : `Your organisation allows up to ${lim?.organisation.rps ?? "—"}.`}
            wrapClassName="w-56"
          />
        </div>
      </section>

      <section aria-labelledby="th-h" className="space-y-2">
        <h2 id="th-h" className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
          Thresholds
        </h2>
        <Table label="Thresholds">
          <THead>
            <tr>
              <Th>Measure</Th>
              <Th>Applies to</Th>
              <Th>Must be</Th>
              <Th>Source</Th>
            </tr>
          </THead>
          <TBody>
            {thresholds.map((t, i) => {
              const locked = t.source?.type === "requirement";
              return (
                <Tr key={`${t.metric}|${t.path ?? "all"}`}>
                  <Td rowHeader>{thresholdMeasure(t)}</Td>
                  <Td>{thresholdScope(t)}</Td>
                  <Td>
                    {readOnly || t.metric === "error_rate" ? (
                      thresholdLimit(t)
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        under
                        <input
                          type="number"
                          min={1}
                          aria-label={`${thresholdMeasure(t)} for ${thresholdScope(t)}, in milliseconds`}
                          value={t.value}
                          onChange={(e) => setThresholds(thresholds.map((x, j) => (j === i ? { ...x, value: Number(e.target.value) } : x)))}
                          className="w-24 rounded-md bg-surface px-2 py-1 ring-1 ring-inset ring-line-input"
                        />
                        ms
                      </span>
                    )}
                  </Td>
                  <Td>
                    {thresholdSource(t)}
                    {locked && <span className="block text-small text-fg-muted">Locked: comes from a requirement. It can be tightened, not loosened.</span>}
                  </Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
      </section>
      {error && <InlineError error={error} />}
      {role !== "viewer" && (
        <p className="flex flex-wrap items-center gap-2 text-small text-fg-muted">
          <Button variant="secondary" size="sm" onClick={() => downloadFile(`/performance-profiles/${d.id}/k6-script`, `${d.key}-v${d.version}-k6.js`).catch((e) => toast(errorMessage(e), "error"))} aria-label={`Download k6 script for ${d.key}`}>
            Download k6 script
          </Button>
          Not run by the platform. Run it yourself with k6 if you use it.
        </p>
      )}
      {adding && <AddPagesDialog open onClose={() => setAdding(false)} projectId={p.id} current={targets.map((t) => t.path)} max={lim?.max_targets ?? 10} onAdd={(paths) => setTargets([...targets, ...paths.map((path) => ({ path, weight: 1 }))])} />}
      {requesting && lim && <LoadTestRequestDialog open onClose={() => setRequesting(false)} projectId={p.id} profile={d} limits={lim} canApprove={!!d.permissions?.can_approve} />}
    </div>
  );
}
