"use client";

import { useEffect, useRef, useState } from "react";
import { UserPlus } from "lucide-react";
import useSWR from "swr";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { Invitation, InvitationCreated, Member, Page, Role } from "@/lib/contract";
import { useAuth } from "@/lib/auth";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { isEmail } from "@/components/auth/authErrors";
import {
  GUARD,
  ROLE_HELP,
  ROLE_TEXT,
  approvesText,
  canManageMembers,
  defaultCanApprove,
  effectiveCanApprove,
  inviteErrorText,
  memberGuards,
  memberPatch,
  ownerCount,
  roleChangedToast,
  roleOptions,
} from "@/lib/members";
import { Button, Callout, Checkbox, ConfirmDialog, Disclosure, ErrorState, InlineError, Modal, Skeleton, StatusPill, TBody, THead, Table, Td, Th, TextField, Tr, useToast } from "@/components/ui";

function nameOf(m: Member): string {
  return m.user.full_name || m.email || m.user.email || "This person";
}

/** Loads every member page (workspaces are small; the list isn't paginated in the UI). */
async function fetchAllMembers(): Promise<Member[]> {
  const out: Member[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const page: Page<Member> = await api<Page<Member>>("/organisation/members", { query: { limit: 100, cursor: cursor ?? undefined } });
    out.push(...page.items);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return out;
}

function permissionError(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 403) return GUARD.permissionsChanged;
  if (err instanceof ApiError && err.status === 409 && /owner/i.test(err.message)) return GUARD.lastOwner;
  return `${fallback} ${errorMessage(err)}`;
}

export function RoleHelp() {
  return (
    <Disclosure label="What each role can do" openLabel="Hide role descriptions">
      <dl className="mt-2 grid gap-2 text-body sm:grid-cols-[8rem_1fr]">
        {(["owner", "admin", "member", "viewer"] as const).map((r) => (
          <div key={r} className="contents">
            <dt className="font-medium text-fg-strong">{ROLE_TEXT[r]}</dt>
            <dd className="text-fg">{ROLE_HELP[r]}</dd>
          </div>
        ))}
      </dl>
    </Disclosure>
  );
}

function RoleRadios({ name, value, onChange, options, locked, lockId }: { name: string; value: Role; onChange: (r: Role) => void; options: Role[]; locked: string | null; lockId: string }) {
  return (
    <fieldset aria-describedby={locked ? lockId : undefined}>
      <legend className="mb-1 text-body font-medium text-fg-strong">Role</legend>
      <div className="space-y-1.5">
        {options.map((r) => (
          <label key={r} className="flex items-start gap-2 text-body">
            <input type="radio" name={name} value={r} checked={value === r} disabled={!!locked} onChange={() => onChange(r)} className="mt-1 h-4 w-4" />
            <span>
              <span className="font-medium text-fg-strong">{ROLE_TEXT[r]}</span>
              <span className="block text-small text-fg-muted">{ROLE_HELP[r]}</span>
            </span>
          </label>
        ))}
      </div>
      {locked && (
        <p id={lockId} className="mt-1 text-small font-medium text-fg">
          {locked}
        </p>
      )}
    </fieldset>
  );
}

function ApproveBox({ role, checked, onChange }: { role: Role; checked: boolean; onChange: (v: boolean) => void }) {
  const fixed = role === "owner" ? GUARD.ownerAlways : role === "viewer" ? GUARD.viewerNever : null;
  return (
    <Checkbox
      label="Can approve quality gates"
      checked={effectiveCanApprove(role, checked)}
      disabled={!!fixed}
      onChange={(e) => onChange(e.target.checked)}
      description={fixed ?? "Lets this person approve or request changes at Gates 2–5. Owners always can."}
    />
  );
}

// ---- Edit member (§17.1) ---------------------------------------------------------------------------------

function EditMember({ m, owners, onClose, onSaved }: { m: Member; owners: number; onClose: () => void; onSaved: (msg: string, self: boolean) => void }) {
  const { role: me } = useAuth();
  const [role, setRole] = useState<Role>(m.role);
  const [can, setCan] = useState(m.can_approve);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmSelf, setConfirmSelf] = useState(false);
  const guard = memberGuards(me, m, owners);

  async function save() {
    const body = memberPatch(m, role, can);
    if (!body) return onClose();
    setBusy(true);
    setError(null);
    try {
      const d = await api<Member>(`/organisation/members/${m.membership_id}`, { method: "PATCH", body });
      onSaved(roleChangedToast(nameOf(m), d.role, d.can_approve), m.is_you);
    } catch (err) {
      setError(permissionError(err, "Couldn’t save the changes."));
      setBusy(false);
    }
  }

  function submit() {
    if (m.is_you && m.role === "owner" && role !== "owner") return setConfirmSelf(true);
    void save();
  }

  return (
    <>
      <Modal
        open={!confirmSelf}
        onClose={onClose}
        title={`Edit ${nameOf(m)}`}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={submit} loading={busy}>
              Save changes
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <RoleRadios
            name="edit-role"
            value={role}
            onChange={(r) => {
              setRole(r);
              setCan(r === m.role ? m.can_approve : defaultCanApprove(r));
            }}
            options={roleOptions(me)}
            locked={guard.roleLocked}
            lockId="edit-role-locked"
          />
          <ApproveBox role={role} checked={can} onChange={setCan} />
          <InlineError error={error} />
        </div>
      </Modal>
      <ConfirmDialog
        open={confirmSelf}
        onClose={() => setConfirmSelf(false)}
        onConfirm={() => {
          setConfirmSelf(false);
          void save();
        }}
        title={`Change your own role to ${ROLE_TEXT[role]}?`}
        confirmLabel="Change my role"
        danger
      >
        You’ll lose owner rights straight away. Only another owner can give them back.
      </ConfirmDialog>
    </>
  );
}

// ---- Invite people (§17.2) -------------------------------------------------------------------------------

function absoluteLink(link: string): string {
  return link.startsWith("/") && typeof window !== "undefined" ? `${window.location.origin}${link}` : link;
}

export function InviteDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [can, setCan] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<InvitationCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const [everCopied, setEverCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setRole("member");
    setCan(false);
    setEmailError(null);
    setFormError(null);
    setCreated(null);
    setCopied(false);
    setEverCopied(false);
    setCopyError(null);
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 3000);
    return () => clearTimeout(t);
  }, [copied]);

  async function create() {
    if (!isEmail(email)) {
      setEmailError("Enter an email address, like name@example.com.");
      emailRef.current?.focus();
      return;
    }
    setBusy(true);
    setEmailError(null);
    setFormError(null);
    try {
      const res = await api<InvitationCreated>("/organisation/invitations", { body: { email: email.trim(), role, can_approve: effectiveCanApprove(role, can) } });
      setCreated(res);
      onCreated();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setFormError(GUARD.permissionsChanged);
      else {
        const e = err instanceof ApiError ? inviteErrorText(err.status, err.code, err.message) : { form: `Couldn’t create the invitation. ${errorMessage(err)}` };
        setEmailError(e.field ?? null);
        setFormError(e.form ?? null);
        if (e.field) emailRef.current?.focus();
      }
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(absoluteLink(created.link));
      setCopied(true);
      setEverCopied(true);
      setCopyError(null);
    } catch {
      setCopyError("Couldn’t copy. Select the link and copy it yourself.");
      linkRef.current?.focus();
      linkRef.current?.select();
    }
  }

  function requestClose() {
    if (created && !everCopied) setConfirmClose(true);
    else onClose();
  }

  const inv = created?.invitation;
  return (
    <>
      <Modal
        open={open && !confirmClose}
        onClose={requestClose}
        title={inv ? `Invitation link for ${inv.email}` : "Invite people"}
        footer={
          inv ? (
            <Button onClick={requestClose}>Done</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={() => void create()} loading={busy}>
                Create invitation link
              </Button>
            </>
          )
        }
      >
        {inv && created ? (
          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <TextField ref={linkRef} label="Invitation link" readOnly value={absoluteLink(created.link)} onFocus={(e) => e.currentTarget.select()} wrapClassName="min-w-0 flex-1" className="font-mono" />
              <Button variant="secondary" onClick={() => void copy()}>
                {copied ? "Link copied" : "Copy invitation link"}
              </Button>
            </div>
            <p role="status" aria-live="polite" className="sr-only">
              {copied ? "Link copied" : ""}
            </p>
            {copyError && <p className="text-small font-medium text-danger-fg">{copyError}</p>}
            <p className="text-body text-fg">
              Joins as {ROLE_TEXT[inv.role]} · {inv.can_approve ? "can approve gates" : "can’t approve gates"} · expires {fmtDateTime(inv.expires_at)}
            </p>
            <p className="text-body text-fg">This link is shown only once. Send it to {inv.email} yourself, for example in a chat message.</p>
            <p className="text-body text-fg">Anyone with the link can join as {inv.role === "admin" ? "an" : "a"} {ROLE_TEXT[inv.role]}, so share it only with this person.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <TextField ref={emailRef} label="Email" type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} error={emailError} />
            <RoleRadios
              name="invite-role"
              value={role}
              onChange={(r) => {
                setRole(r);
                setCan(defaultCanApprove(r));
              }}
              options={roleOptions(null, true)}
              locked={null}
              lockId="invite-role-locked"
            />
            {role !== "viewer" && <Checkbox label="Can approve quality gates" checked={can} onChange={(e) => setCan(e.target.checked)} description="Lets this person approve or request changes at Gates 2–5." />}
            <p className="text-small text-fg-muted">We don’t send emails yet. You’ll get a link to share yourself.</p>
            <InlineError error={formError} />
          </div>
        )}
      </Modal>
      <ConfirmDialog
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        onConfirm={() => {
          setConfirmClose(false);
          onClose();
        }}
        title="Close without copying the link?"
        cancelLabel="Go back"
        confirmLabel="Close without copying"
      >
        You won’t be able to see it again. To share it later, revoke this invitation and create a new one.
      </ConfirmDialog>
    </>
  );
}

// ---- Members screen ----------------------------------------------------------------------------------------

export function MembersScreen() {
  const { role: me, refresh: refreshMe, logout } = useAuth();
  const toast = useToast();
  const manage = canManageMembers(me);
  const members = useSWR<Member[]>(me ? "/organisation/members#all" : null, fetchAllMembers, { revalidateOnFocus: false });
  const invites = useSWR<Invitation[]>(manage ? "/organisation/invitations" : null, (k: string) => api<Invitation[]>(k), { revalidateOnFocus: false, shouldRetryOnError: false });
  const [editing, setEditing] = useState<Member | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const list = members.data ?? [];
  const owners = ownerCount(list);
  const shownInvites = (invites.data ?? []).filter((i) => i.status === "pending" || i.status === "expired");

  async function remove(m: Member) {
    setBusy(true);
    setRowError(null);
    const idx = list.findIndex((x) => x.membership_id === m.membership_id);
    try {
      await api(`/organisation/members/${m.membership_id}`, { method: "DELETE" });
      setRemoving(null);
      if (m.is_you) return void logout();
      toast(`${nameOf(m)} was removed.`, "success");
      const next = await members.mutate();
      const target = next?.[Math.min(idx, (next?.length ?? 1) - 1)];
      requestAnimationFrame(() => (target ? document.getElementById(`member-${target.membership_id}`) : document.getElementById("members-h"))?.focus());
    } catch (err) {
      setRemoving(null);
      setRowError(permissionError(err, `Couldn’t remove ${nameOf(m)}.`));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(i: Invitation) {
    setBusy(true);
    try {
      await api(`/organisation/invitations/${i.id}/revoke`, { method: "POST" });
      toast("Invitation revoked.", "success");
      await invites.mutate();
    } catch (err) {
      setRowError(permissionError(err, "Couldn’t revoke the invitation."));
    } finally {
      setBusy(false);
      setRevoking(null);
    }
  }

  const actions = (m: Member) => {
    const g = memberGuards(me, m, owners);
    if (!manage) return null;
    const reasonId = g.reason ? `member-${m.membership_id}-reason` : undefined;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" aria-disabled={!g.canEdit || undefined} aria-describedby={!g.canEdit ? reasonId : undefined} onClick={() => g.canEdit && setEditing(m)}>
          Edit<span className="sr-only"> {nameOf(m)}</span>
        </Button>
        <Button variant="secondary" aria-disabled={!g.canRemove || undefined} aria-describedby={!g.canRemove ? reasonId : undefined} onClick={() => g.canRemove && setRemoving(m)}>
          {m.is_you ? "Leave" : "Remove"}
          {!m.is_you && <span className="sr-only"> {nameOf(m)}</span>}
        </Button>
        {g.reason && (!g.canEdit || !g.canRemove) && (
          <p id={reasonId} className="w-full text-small text-fg-muted">
            {g.reason}
          </p>
        )}
      </div>
    );
  };

  const nameCell = (m: Member) => (
    <span id={`member-${m.membership_id}`} tabIndex={-1} className="focus:outline-none focus-visible:ring-2 focus-visible:ring-focus">
      {nameOf(m)}
      {m.is_you && <span className="font-normal text-fg-muted"> (you)</span>}
    </span>
  );

  if (members.error && !members.data) return <ErrorState error={members.error} title="Couldn’t load members." message="Try again." onRetry={() => void members.mutate()} />;

  return (
    <div className="space-y-8">
      <section aria-labelledby="members-h" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="members-h" tabIndex={-1} className="text-h2 font-semibold text-fg-strong focus:outline-none">
            Members{members.data ? ` (${list.length})` : ""}
          </h2>
          {manage && (
            <Button icon={<UserPlus className="h-4 w-4" aria-hidden />} onClick={() => setInviteOpen(true)}>
              Invite people
            </Button>
          )}
        </div>
        {!manage && <p className="text-body text-fg-muted">{GUARD.readOnly}</p>}
        {rowError && (
          <Callout
            tone="danger"
            actions={
              rowError === GUARD.permissionsChanged ? (
                <Button variant="secondary" onClick={() => window.location.reload()}>
                  Refresh
                </Button>
              ) : undefined
            }
          >
            {rowError}
          </Callout>
        )}
        {!members.data ? (
          <div className="space-y-2" aria-busy="true">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : (
          <>
            <div className="hidden md:block">
              <Table label="Members">
                <THead>
                  <tr>
                    <Th>Name</Th>
                    {manage && <Th>Email</Th>}
                    <Th>Role</Th>
                    <Th>Approves gates</Th>
                    <Th>Joined</Th>
                    {manage && <Th srOnly>Actions</Th>}
                  </tr>
                </THead>
                <TBody>
                  {list.map((m) => (
                    <Tr key={m.membership_id}>
                      <Td rowHeader>{nameCell(m)}</Td>
                      {manage && <Td className="break-all">{m.email ?? "—"}</Td>}
                      <Td>{ROLE_TEXT[m.role]}</Td>
                      <Td>{approvesText(m)}</Td>
                      <Td>{m.joined_at ? fmtDate(m.joined_at) : "—"}</Td>
                      {manage && <Td className="max-w-[18rem]">{actions(m)}</Td>}
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
            <ul className="space-y-3 md:hidden">
              {list.map((m) => (
                <li key={m.membership_id}>
                  <article className="space-y-2 rounded-lg bg-surface p-4 ring-1 ring-line">
                    <h3 className="break-words font-semibold text-fg-strong">{nameCell(m)}</h3>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body">
                      {manage && (
                        <>
                          <dt className="text-fg-muted">Email</dt>
                          <dd className="min-w-0 break-all">{m.email ?? "—"}</dd>
                        </>
                      )}
                      <dt className="text-fg-muted">Role</dt>
                      <dd>{ROLE_TEXT[m.role]}</dd>
                      <dt className="text-fg-muted">Approves gates</dt>
                      <dd>{approvesText(m)}</dd>
                      <dt className="text-fg-muted">Joined</dt>
                      <dd>{m.joined_at ? fmtDate(m.joined_at) : "—"}</dd>
                    </dl>
                    {actions(m)}
                  </article>
                </li>
              ))}
            </ul>
          </>
        )}
        <RoleHelp />
      </section>

      {manage && (
        <section aria-labelledby="invites-h" className="space-y-4">
          <h2 id="invites-h" className="text-h2 font-semibold text-fg-strong">
            Pending invitations{invites.data ? ` (${shownInvites.filter((i) => i.status === "pending").length})` : ""}
          </h2>
          {invites.error && !invites.data ? (
            <Callout tone="danger">Couldn’t load invitations. Try again.</Callout>
          ) : !invites.data ? (
            <Skeleton className="h-24" />
          ) : shownInvites.length === 0 ? (
            <p className="text-body text-fg-muted">No pending invitations.</p>
          ) : (
            <ul className="space-y-3">
              {shownInvites.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface p-4 ring-1 ring-line">
                  <div className="min-w-0 space-y-0.5">
                    <p className="break-all font-medium text-fg-strong">{i.email}</p>
                    <p className="text-small text-fg-muted">
                      {ROLE_TEXT[i.role]} · {i.can_approve ? "approves gates" : "doesn’t approve gates"} · invited by {i.invited_by?.full_name || "someone"} · {i.status === "expired" ? `expired ${fmtDate(i.expires_at)}` : `expires ${fmtDateTime(i.expires_at)}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusPill status={i.status} label={i.status === "pending" ? "Pending" : "Expired"} />
                    {i.status === "pending" && (
                      <Button variant="secondary" onClick={() => setRevoking(i)}>
                        Revoke<span className="sr-only"> invitation for {i.email}</span>
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {editing && (
        <EditMember
          m={editing}
          owners={owners}
          onClose={() => setEditing(null)}
          onSaved={(msg, self) => {
            setEditing(null);
            toast(msg, "success");
            void members.mutate();
            if (self) void refreshMe();
          }}
        />
      )}
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && void remove(removing)}
        title={removing?.is_you ? "Leave this workspace?" : `Remove ${removing ? nameOf(removing) : ""}?`}
        confirmLabel={removing?.is_you ? "Leave workspace" : "Remove member"}
        danger
        loading={busy}
      >
        {removing?.is_you
          ? "You’ll be signed out and won’t be able to come back without a new invitation."
          : "They’ll be signed out of this workspace straight away. Requirements, test cases and approvals they made keep their name."}
      </ConfirmDialog>
      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => revoking && void revoke(revoking)}
        title={`Revoke the invitation for ${revoking?.email ?? ""}?`}
        confirmLabel="Revoke invitation"
        danger
        loading={busy}
      >
        The link stops working straight away.
      </ConfirmDialog>
      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} onCreated={() => void invites.mutate()} />
    </div>
  );
}
