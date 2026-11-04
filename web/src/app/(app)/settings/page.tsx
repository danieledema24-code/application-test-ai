"use client";

import { useState } from "react";
import { UserPlus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { fmtDate, fmtDateTime, personName } from "@/lib/format";
import type { AiStatus, AuditEntry, Role, User } from "@/lib/types";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataState,
  EmptyState,
  InlineError,
  Modal,
  PageHeader,
  SelectField,
  TBody,
  THead,
  Table,
  Tabs,
  TabPanel,
  Td,
  TextField,
  Th,
  Tr,
  useToast,
} from "@/components/ui";

function Profile() {
  const { user, organisation } = useAuth();
  const { data: ai } = useApi<AiStatus>("/ai/status");
  const rows: [string, React.ReactNode][] = [
    ["Full name", user?.fullName],
    ["Email", user?.email],
    ["Role", user?.role === "ADMIN" ? "Administrator" : "Member"],
    ["Workspace", organisation?.name],
    ["Plan", organisation?.subscriptionPlan ? <Badge key="p">{organisation.subscriptionPlan}</Badge> : "—"],
    ["Member since", fmtDate(user?.createdAt)],
    ["AI assistant", ai ? (ai.enabled ? `Enabled${ai.model ? ` (${ai.model})` : ""}` : "Limited mode (rule-based)") : "…"],
  ];
  return (
    <Card className="max-w-2xl">
      <CardHeader title="Your profile" />
      <CardBody>
        <dl className="divide-y divide-line text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 py-2.5">
              <dt className="text-fg-muted">{k}</dt>
              <dd className="text-right font-medium text-fg-strong">{v || "—"}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs text-fg-muted">To change your password, sign out and use “Forgot password”.</p>
      </CardBody>
    </Card>
  );
}

function AddMemberModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ fullName: "", email: "", role: "MEMBER" as Role, password: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api("/workspace/members", { body: f });
      toast(`${f.fullName} added`);
      setF({ fullName: "", email: "", role: "MEMBER", password: "" });
      onAdded();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add member"
      description="Share the initial password with them securely; they can reset it later."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="member-form" loading={saving}>
            Add member
          </Button>
        </>
      }
    >
      <form id="member-form" onSubmit={submit} className="space-y-4">
        <TextField label="Full name" required value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
        <TextField label="Work email" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <SelectField label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })} options={[{ value: "MEMBER", label: "Member" }, { value: "ADMIN", label: "Admin" }]} />
        <TextField label="Initial password" type="password" autoComplete="new-password" required minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        <InlineError error={error} />
      </form>
    </Modal>
  );
}

function Members() {
  const { user } = useAuth();
  const toast = useToast();
  const isAdmin = user?.role === "ADMIN";
  const { data, error, isLoading, mutate } = useApi<User[]>("/workspace/members");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<User | null>(null);

  async function changeRole(m: User, role: Role) {
    try {
      await api(`/workspace/members/${m.id}`, { method: "PATCH", body: { role } });
      toast(`${m.fullName} is now ${role === "ADMIN" ? "an admin" : "a member"}`);
      await mutate();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Update failed", "error");
    }
  }

  async function remove() {
    if (!removing) return;
    try {
      await api(`/workspace/members/${removing.id}`, { method: "DELETE" });
      toast(`${removing.fullName} removed`);
      setRemoving(null);
      await mutate();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Remove failed", "error");
    }
  }

  return (
    <Card>
      <CardHeader
        title="Workspace members"
        description={isAdmin ? undefined : "Only admins can manage members."}
        actions={
          isAdmin && (
            <Button size="sm" icon={<UserPlus className="h-4 w-4" aria-hidden />} onClick={() => setAdding(true)}>
              Add member
            </Button>
          )
        }
      />
      <DataState data={data} error={error} isLoading={isLoading} onRetry={() => mutate()} empty={<EmptyState title="No members" />}>
        {(members) => (
          <Table label="Workspace members">
            <THead>
              <tr>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Role</Th>
                <Th>Joined</Th>
                {isAdmin && <Th srOnly>Actions</Th>}
              </tr>
            </THead>
            <TBody>
              {members.map((m) => (
                <Tr key={m.id}>
                  <Td className="font-medium text-fg-strong">
                    {m.fullName} {m.id === user?.id && <span className="text-xs font-normal text-fg-muted">(you)</span>}
                  </Td>
                  <Td className="text-fg">{m.email}</Td>
                  <Td>
                    {isAdmin && m.id !== user?.id ? (
                      <SelectField
                        label={`Role for ${m.fullName}`}
                        hideLabel
                        wrapClassName="w-32"
                        value={m.role}
                        onChange={(e) => changeRole(m, e.target.value as Role)}
                        options={[
                          { value: "MEMBER", label: "Member" },
                          { value: "ADMIN", label: "Admin" },
                        ]}
                      />
                    ) : (
                      <Badge tone={m.role === "ADMIN" ? "blue" : "grey"}>{m.role === "ADMIN" ? "Admin" : "Member"}</Badge>
                    )}
                  </Td>
                  <Td className="text-fg-muted">{fmtDate(m.createdAt)}</Td>
                  {isAdmin && (
                    <Td className="text-right">
                      {m.id !== user?.id && (
                        <Button size="sm" variant="ghost" aria-label={`Remove ${m.fullName}`} icon={<Trash2 className="h-4 w-4" aria-hidden />} onClick={() => setRemoving(m)} />
                      )}
                    </Td>
                  )}
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </DataState>
      <AddMemberModal open={adding} onClose={() => setAdding(false)} onAdded={() => mutate()} />
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={remove} danger title={`Remove ${removing?.fullName}?`} confirmLabel="Remove member">
        They will lose access to this workspace immediately.
      </ConfirmDialog>
    </Card>
  );
}

function AuditLog() {
  const [limit, setLimit] = useState(50);
  const { data, error, isLoading, mutate } = useApi<AuditEntry[]>("/workspace/audit-log", { limit }, { keepPreviousData: true });
  const fmtMeta = (m: unknown) => {
    if (m === null || m === undefined) return "";
    if (typeof m === "string") return m;
    try {
      const s = JSON.stringify(m);
      return s === "{}" ? "" : s;
    } catch {
      return "";
    }
  };
  return (
    <Card>
      <CardHeader title="Audit log" description="Security-relevant actions in this workspace." />
      <DataState data={data} error={error} isLoading={isLoading} onRetry={() => mutate()} empty={<EmptyState title="No audit entries" />}>
        {(rows) => (
          <>
            <Table label="Audit log">
              <THead>
                <tr>
                  <Th>Time</Th>
                  <Th>Actor</Th>
                  <Th>Action</Th>
                  <Th>Target</Th>
                  <Th>Details</Th>
                </tr>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <Tr key={r.id}>
                    <Td className="whitespace-nowrap text-fg-muted">{fmtDateTime(r.createdAt)}</Td>
                    <Td>{personName(r.actor)}</Td>
                    <Td className="font-mono text-xs">{r.action}</Td>
                    <Td className="max-w-[16rem] truncate text-fg">{r.target || "—"}</Td>
                    <Td className="max-w-[24rem] truncate font-mono text-xs text-fg-muted" >{fmtMeta(r.metadata)}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            {rows.length >= limit && (
              <div className="border-t border-line p-3 text-center">
                <Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + 100)}>
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </DataState>
    </Card>
  );
}

export default function SettingsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const [tab, setTab] = useState("profile");
  const tabs = [
    { id: "profile", label: "Profile" },
    { id: "members", label: "Members" },
    ...(isAdmin ? [{ id: "audit", label: "Audit log" }] : []),
  ];
  return (
    <>
      <PageHeader title="Settings" description="Your profile and workspace administration." />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Settings sections" idPrefix="settings" />
      <TabPanel id={tab} idPrefix="settings">
        {tab === "profile" && <Profile />}
        {tab === "members" && <Members />}
        {tab === "audit" && isAdmin && <AuditLog />}
      </TabPanel>
    </>
  );
}
