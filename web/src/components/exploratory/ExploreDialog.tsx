"use client";

// Start dialog (design P6 §9.2, decisions D29, D30): what to explore, the budget with the organisation and server
// limits inline, the signed-in option and the fixed "What it does" list. Anonymous sessions start at once; signed-in
// sessions are requested (member) or approved in the same request with the host typed (approver). One request at a
// time: a second click while the first is in flight is ignored, and a 409 names the session that is already running.

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { api, ApiError, errorMessage, fieldErrorsOf } from "@/lib/api";
import {
  charterChoices,
  charterLabel,
  conflictKey,
  defaultCharter,
  limitLine,
  MEMBER_REQUEST_LINE,
  NO_CREDENTIALS,
  pageReason,
  SIGNED_IN_HELP,
  startErrors,
  type Charter,
  type Session,
  type SessionList,
} from "@/lib/exploratory";
import { Button, Callout, Checkbox, Modal, TextField } from "@/components/ui";
import { useTypedHost } from "@/components/nonfunctional/LoadApproval";

type Errors = { charter?: string; pages?: string; actions?: string; minutes?: string; signed_in?: string };

/** The fixed "What it does" list (§9.2): the start dialog and the approval panel show the same lines. */
export function ExploreWhatItDoes({ items, headingLevel = 3 }: { items: string[]; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <div>
      <H className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">What it does</H>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-small text-fg">
        {items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

export function ExploreDialog({
  open,
  onClose,
  projectId,
  list,
  onStarted,
  onConflict,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  list: SessionList;
  onStarted: (s: Session & { message?: string }, approved: boolean) => void;
  /** A 409: another session started meanwhile (the list is refreshed so the Explore button explains it). */
  onConflict: () => void;
}) {
  const o = list.options!;
  const canApprove = list.permissions.can_approve;
  const limits = o.limits;
  const [charter, setCharter] = useState<Charter["key"]>(() => defaultCharter(o));
  const [pages, setPages] = useState<string[]>([]);
  const [actions, setActions] = useState(String(limits.default.actions));
  const [minutes, setMinutes] = useState(String(limits.default.minutes));
  const [signedIn, setSignedIn] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState<"start" | "approve" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState<{ key: string | null; message: string } | null>(null);
  const inFlight = useRef(false);
  const alertRef = useRef<HTMLDivElement>(null);
  const th = useTypedHost(o.host);
  const hintId = useId();
  const pagesErrId = useId();

  // Each opening starts from the defaults.
  useEffect(() => {
    if (!open) return;
    setCharter(defaultCharter(o));
    setPages([]);
    setActions(String(limits.default.actions));
    setMinutes(String(limits.default.minutes));
    setSignedIn(false);
    setErrors({});
    setError(null);
    setConflict(null);
    inFlight.current = false;
    setBusy(null);
    th.setTyped("");
    th.setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Pages that can't be explored the new way are unticked when "Explore signed in" changes.
  useEffect(() => {
    setPages((cur) => cur.filter((id) => {
      const p = o.pages.find((x) => x.page_id === id);
      return p && !pageReason(p, signedIn);
    }));
  }, [signedIn, o.pages]);

  const focusFirstInvalid = (e: Errors) => {
    const order: (keyof Errors)[] = ["charter", "pages", "actions", "minutes", "signed_in"];
    const first = order.find((k) => e[k]);
    if (!first) return;
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-explore-field="${first}"]`)?.focus());
  };

  async function send(approve: boolean) {
    if (inFlight.current) return; // a double click never sends two requests
    const e = startErrors({ charter, pages, actions, minutes }, limits);
    setErrors(e);
    if (Object.keys(e).length) {
      focusFirstInvalid(e);
      return;
    }
    if (approve && !th.ok) {
      th.setError(th.typed.trim() ? `Type ${o.host} exactly to approve.` : th.reason);
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-explore-field="host"]`)?.focus());
      return;
    }
    inFlight.current = true;
    let done = false;
    setBusy(approve ? "approve" : "start");
    setError(null);
    setConflict(null);
    try {
      const s = await api<Session & { message?: string }>(`/projects/${projectId}/exploratory-sessions`, {
        method: "POST",
        body: {
          charter,
          pages: charter === "chosen" ? pages : undefined,
          change_set_id: charter === "change_set" ? (o.change_set?.id ?? undefined) : undefined,
          budget: { actions: Number(actions), minutes: Number(minutes) },
          signed_in: signedIn,
          approve: signedIn && approve ? true : undefined,
          confirm_text: signedIn && approve ? th.typed : undefined,
        },
      });
      // Stay busy until the page navigates: a second click after the answer must not send another request.
      done = true;
      onStarted(s, signedIn && approve);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const key = conflictKey(err);
        // The server names the session: "EXP-n is already running…" or "EXP-n is waiting for approval…".
        const message = key ? (err.message.startsWith(key) ? err.message : `${key} is already running on this project. One session at a time.`) : /gate/i.test(err.code) ? "Approve Gate 2 first." : err.message;
        setConflict({ key, message });
        onConflict();
        requestAnimationFrame(() => alertRef.current?.focus());
      } else if (err instanceof ApiError && err.status === 422) {
        const f = fieldErrorsOf(err.details);
        if (approve && /exactly to approve/.test(err.message)) {
          th.setError(err.message);
          requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-explore-field="host"]`)?.focus());
        } else if (Object.keys(f).length) {
          const next: Errors = { actions: f.actions, minutes: f.minutes, pages: f.pages, signed_in: f.signed_in, charter: f.charter };
          setErrors(next);
          focusFirstInvalid(next);
        } else {
          setError(new Error(`Couldn't start exploring: ${err.message.replace(/\.$/, "")}. Nothing was started.`));
          requestAnimationFrame(() => alertRef.current?.focus());
        }
      } else {
        setError(new Error(`Couldn't start exploring: ${errorMessage(err).replace(/\.$/, "")}. Nothing was started.`));
        requestAnimationFrame(() => alertRef.current?.focus());
      }
    } finally {
      if (!done) {
        inFlight.current = false;
        setBusy(null);
      }
    }
  }

  const charters = charterChoices(o);
  const footer = !signedIn ? (
    <>
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button onClick={() => send(false)} loading={busy === "start"}>
        Start exploring
      </Button>
    </>
  ) : canApprove ? (
    <>
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button variant="secondary" onClick={() => send(false)} loading={busy === "start"}>
        Request approval instead
      </Button>
      <Button onClick={() => send(true)} loading={busy === "approve"} aria-disabled={!th.ok || undefined} aria-describedby={!th.ok ? hintId : undefined}>
        Approve and start exploring
      </Button>
    </>
  ) : (
    <>
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button onClick={() => send(false)} loading={busy === "start"}>
        Request approval
      </Button>
    </>
  );

  // The limit line is the field's hint, so it is announced with the field (aria-describedby) next to any error.
  const budgetField = (field: "actions" | "minutes", label: string, value: string, set: (v: string) => void) => (
    <TextField
      label={label}
      inputMode="numeric"
      value={value}
      onChange={(e) => {
        set(e.target.value);
        setErrors((x) => ({ ...x, [field]: undefined }));
      }}
      error={errors[field]}
      hint={limitLine(field, limits)}
      data-explore-field={field}
    />
  );

  return (
    <Modal open={open} onClose={onClose} size="lg" title="Explore pages" footer={footer}>
      <div className="space-y-5">
        {list.queued_note && <Callout tone="info">{list.queued_note}</Callout>}
        <fieldset aria-describedby={errors.charter ? "explore-charter-error" : undefined}>
          <legend className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">What to explore</legend>
          <div className="mt-2 space-y-2">
            {charters.map((c, i) => (
              <div key={c.key}>
                <label className={`flex items-start gap-2.5 text-body ${c.disabled_reason ? "text-fg-muted" : "text-fg-strong"}`}>
                  <input
                    type="radio"
                    name="explore-charter"
                    className="mt-1 h-4 w-4 accent-accent"
                    checked={charter === c.key}
                    disabled={!!c.disabled_reason}
                    onChange={() => {
                      setCharter(c.key);
                      setErrors((x) => ({ ...x, charter: undefined, pages: undefined }));
                    }}
                    data-explore-field={i === 0 ? "charter" : undefined}
                  />
                  <span>
                    {charterLabel(c)}
                    {c.disabled_reason && <span className="block text-small">{c.disabled_reason}</span>}
                  </span>
                </label>
              </div>
            ))}
          </div>
          {errors.charter && (
            <p id="explore-charter-error" className="mt-1 text-small font-medium text-danger-fg">
              {errors.charter}
            </p>
          )}
        </fieldset>
        {charter === "chosen" && (
          <fieldset aria-describedby={errors.pages ? pagesErrId : undefined} className="space-y-2">
            <legend className="text-body font-medium text-fg-strong">Pages to explore</legend>
            {errors.pages && (
              <p id={pagesErrId} className="text-small font-medium text-danger-fg">
                {errors.pages}
              </p>
            )}
            <ul className="max-h-60 space-y-1.5 overflow-y-auto rounded-md p-1 ring-1 ring-line" tabIndex={-1} data-explore-field="pages">
              {o.pages.map((pg) => {
                const why = pageReason(pg, signedIn);
                return (
                  <li key={pg.page_id}>
                    <Checkbox
                      label={<span className="break-all font-mono text-small">{pg.path}</span>}
                      description={why ?? undefined}
                      disabled={!!why}
                      checked={pages.includes(pg.page_id)}
                      onChange={(e) => {
                        setPages((cur) => (e.target.checked ? [...cur, pg.page_id] : cur.filter((x) => x !== pg.page_id)));
                        setErrors((x) => ({ ...x, pages: undefined }));
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}
        <section aria-labelledby="explore-budget-h" className="space-y-3">
          <h3 id="explore-budget-h" className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
            Budget
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {budgetField("actions", "Actions", actions, setActions)}
            {budgetField("minutes", "Minutes", minutes, setMinutes)}
          </div>
          {list.permissions.can_edit_limits && (
            <Link href="/settings/load-limits" className="text-small font-medium text-navy-700 underline underline-offset-2">
              Change organisation limits
            </Link>
          )}
        </section>
        <section aria-labelledby="explore-signed-h" className="space-y-2">
          <h3 id="explore-signed-h" className="text-caption font-semibold uppercase tracking-[0.04em] text-fg-muted">
            Signed-in pages
          </h3>
          <Checkbox
            label="Explore signed in, with the saved test account"
            description={o.credentials_saved ? SIGNED_IN_HELP : NO_CREDENTIALS}
            checked={signedIn}
            disabled={!o.credentials_saved}
            onChange={(e) => setSignedIn(e.target.checked)}
            error={errors.signed_in}
            data-explore-field="signed_in"
          />
          {!o.credentials_saved && (
            <Link href={`/projects/${projectId}/settings?view=credentials`} className="text-small font-medium text-navy-700 underline underline-offset-2">
              Add test credentials
            </Link>
          )}
        </section>
        <ExploreWhatItDoes items={o.what_it_does} />
        {signedIn &&
          (canApprove ? (
            <div className="space-y-1">
              <TextField
                label={`Type ${o.host} to approve and start`}
                value={th.typed}
                onChange={(e) => {
                  th.setTyped(e.target.value);
                  th.setError(null);
                }}
                autoComplete="off"
                spellCheck={false}
                error={th.error}
                data-explore-field="host"
              />
              <p id={hintId} className="text-small text-fg-muted">
                {th.ok ? "Your approval is recorded with your name, the time and that you typed the host." : th.reason}
              </p>
            </div>
          ) : (
            <p className="text-small text-fg-muted">{MEMBER_REQUEST_LINE}</p>
          ))}
        {/* §16.2: a 409 or a server error moves focus to its callout. */}
        <div ref={alertRef} tabIndex={-1} className="space-y-2 focus:outline-none">
          {conflict && (
            <Callout tone="warning" role="alert" title={conflict.message}>
              {conflict.key && (
                <Link href={`/projects/${projectId}/execution/exploratory/${conflict.key}`} className="font-medium text-navy-700 underline underline-offset-2">
                  Open {conflict.key}
                </Link>
              )}
            </Callout>
          )}
          {error ? <Callout tone="danger" role="alert" title={errorMessage(error)} /> : null}
        </div>
      </div>
    </Modal>
  );
}
