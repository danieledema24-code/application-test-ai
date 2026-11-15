// Members and invitations (design P3 §17): role copy and the guards shown before acting. Pure; unit-tested.

import type { Member, Role } from "./contract";

export const ROLE_TEXT: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };

export const ROLE_HELP: Record<Role, string> = {
  owner: "Full control, including members and other owners. Always approves gates.",
  admin: "Manages members (except owners), project settings and test credentials. Approves gates unless turned off.",
  member: "Runs agents, edits and approves requirements and test cases. Approves gates only if allowed.",
  viewer: "Reads everything. Can’t change anything or approve.",
};

/** One-line role summary on the accept-invitation page. */
export const ROLE_INVITE_LINE: Record<Exclude<Role, "owner">, string> = {
  admin: "Admins manage members, project settings and test credentials, and approve gates unless turned off.",
  member: "Members run agents, edit and approve requirements and test cases.",
  viewer: "Viewers read everything but can’t change anything or approve.",
};

export const GUARD = {
  lastOwner: "A workspace needs at least one owner. Make someone else an owner first.",
  adminOnOwner: "Only owners can change or remove an owner.",
  adminSelf: "You can’t change your own role. Ask an owner.",
  ownerAlways: "Owners always approve gates.",
  viewerNever: "Viewers can’t approve.",
  readOnly: "Only owners and admins can manage members.",
  permissionsChanged: "Your permissions changed. Refresh to see what you can do now.",
} as const;

export function canManageMembers(role: Role | null): boolean {
  return role === "owner" || role === "admin";
}

export function ownerCount(members: Pick<Member, "role">[]): number {
  return members.filter((m) => m.role === "owner").length;
}

/** What the signed-in user may do to a row, with the visible reason when they can't (§17.1 Guards). */
export function memberGuards(me: Role | null, target: Pick<Member, "role" | "is_you">, owners: number): { canEdit: boolean; canRemove: boolean; roleLocked: string | null; reason: string | null } {
  if (!canManageMembers(me)) return { canEdit: false, canRemove: false, roleLocked: GUARD.readOnly, reason: GUARD.readOnly };
  const lastOwner = target.role === "owner" && owners <= 1;
  if (me === "admin" && target.role === "owner") return { canEdit: false, canRemove: false, roleLocked: GUARD.adminOnOwner, reason: GUARD.adminOnOwner };
  if (lastOwner) return { canEdit: true, canRemove: false, roleLocked: GUARD.lastOwner, reason: GUARD.lastOwner };
  if (me === "admin" && target.is_you) return { canEdit: true, canRemove: true, roleLocked: GUARD.adminSelf, reason: null };
  return { canEdit: true, canRemove: true, roleLocked: null, reason: null };
}

/** Roles offered in the edit and invite dialogs: admins never see Owner. */
export function roleOptions(me: Role | null, forInvite = false): Role[] {
  const base: Role[] = ["admin", "member", "viewer"];
  return me === "owner" && !forInvite ? ["owner", ...base] : base;
}

/** The checkbox rule: owners are always on, viewers always off (server returns 422 otherwise). */
export function effectiveCanApprove(role: Role, requested: boolean): boolean {
  if (role === "owner") return true;
  if (role === "viewer") return false;
  return requested;
}

/** Invite default: on for Admin, off for Member, hidden (off) for Viewer. */
export function defaultCanApprove(role: Role): boolean {
  return role === "admin" || role === "owner";
}

export function approvesText(m: Pick<Member, "role" | "can_approve">): string {
  if (m.role === "owner") return "Yes (always)";
  return m.can_approve ? "Yes" : "No";
}

/** Toast after an edit: "Sam Patel is now a Member who can approve gates." */
export function roleChangedToast(name: string, role: Role, canApprove: boolean): string {
  if (role === "owner") return `${name} is now an Owner.`;
  const article = role === "admin" ? "an" : "a";
  return `${name} is now ${article} ${ROLE_TEXT[role]}${role === "viewer" ? "" : canApprove ? " who can approve gates" : " who can’t approve gates"}.`;
}

/** Only changed fields are sent (Phase 2 lesson: saves send what changed). */
export function memberPatch(m: Pick<Member, "role" | "can_approve" | "version">, role: Role, canApprove: boolean): Record<string, unknown> | null {
  const next = effectiveCanApprove(role, canApprove);
  const body: Record<string, unknown> = {};
  if (role !== m.role) body.role = role;
  if (next !== m.can_approve && role !== "owner") body.can_approve = next;
  if (Object.keys(body).length === 0) return null;
  if (m.version !== undefined) body.version = m.version;
  return body;
}

/** Invitation server errors mapped to field copy (§17.2). */
export function inviteErrorText(status: number, code: string | undefined, message: string): { field?: string; form?: string } {
  if (status === 409 && /account/i.test(message + (code ?? "")))
    return { field: "This email already has an account. Multi-workspace accounts aren’t supported yet, so this person can’t join a second workspace. Ask them to use a different email address." };
  if (status === 409) return { field: "There’s already a pending invitation for this email. Revoke it to create a new link." };
  if (status === 429) return { form: "You’ve created 20 invitations in the last hour. Try again later." };
  if (status === 422) return { field: "Enter an email address, like name@example.com." };
  return { form: `Couldn’t create the invitation. ${message}` };
}
