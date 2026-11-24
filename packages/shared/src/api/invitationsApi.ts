import { apiClient } from "./client";

/**
 * Sign-in invitations and account resets on apps/api (the People page). On the API a sign-in is made by an invitation, not by
 * the school typing a password for someone:
 *
 *  - STAFF are invited by e-mail (`POST /v1/tenants/{id}/invitations`, role teacher, staff or driver). The link is valid once for
 *    72 hours. Nothing lists open staff invitations, and nothing links the new sign-in to the staff record by itself (the record's
 *    `userId` is set by hand, and nothing says which user accepted).
 *  - GUARDIANS are invited per guardian record and learner, by e-mail or SMS (`.../guardians/{id}/invitations`); a new invitation
 *    replaces any open one, which is how "send again" works. The open ones are listed (contact masked).
 *  - A member's password is reset by the school with a one-time link (`.../members/{userId}/password-reset`).
 *
 * Every one of these answers `delivery`: `sent` (the e-mail went), or `not_configured` / `failed` with the single-use `token`, returned ONCE
 * to the administrator so it can be handed over another way. Nothing here sends e-mail itself; local APIs (APP_ENV=local) never do.
 */

export type InvitationDelivery = "sent" | "not_configured" | "failed";

export interface InvitationSent {
  id: string;
  expiresAt: string;
  delivery: InvitationDelivery;
  /** Only when `delivery` is not `sent`: shown once, never again. */
  token: string | null;
}

/** The roles a school administrator can invite to a school. An administrator is invited by the platform. */
export type StaffInviteRole = "teacher" | "staff" | "driver";

export async function apiInviteStaff(input: { tenantId: string; email: string; role: StaffInviteRole; fullName?: string }): Promise<InvitationSent> {
  const res = await apiClient().post("/v1/tenants/{tenantId}/invitations", {
    path: { tenantId: input.tenantId },
    tenantId: input.tenantId,
    body: { email: input.email.trim(), role: input.role, ...(input.fullName?.trim() ? { full_name: input.fullName.trim() } : {}) },
  });
  const i = res.invitation;
  return { id: i.id, expiresAt: i.expires_at, delivery: i.delivery, token: i.token ?? null };
}

export async function apiRevokeStaffInvitation(tenantId: string, invitationId: string): Promise<void> {
  await apiClient().post("/v1/tenants/{tenantId}/invitations/{invitationId}/revoke", { path: { tenantId, invitationId }, tenantId });
}

export type GuardianInviteMethod = "email" | "sms";

/** How an invitation can reach a guardian: their e-mail first, else their phone; null when the record has neither. */
export function guardianInviteMethod(contact: { email: string | null; phone: string | null }): GuardianInviteMethod | null {
  if (contact.email?.trim()) return "email";
  if (contact.phone?.trim()) return "sms";
  return null;
}

/** Invites (or invites again: a new invitation replaces the open one) one guardian for one learner. A guardian who already has a login is a 409. */
export async function apiInviteGuardian(input: { tenantId: string; guardianId: string; learnerId: string; method: GuardianInviteMethod }): Promise<InvitationSent & { method: GuardianInviteMethod }> {
  const res = await apiClient().post("/v1/tenants/{tenantId}/guardians/{guardianId}/invitations", {
    path: { tenantId: input.tenantId, guardianId: input.guardianId },
    tenantId: input.tenantId,
    body: { learner_id: input.learnerId, method: input.method },
  });
  const i = res.invitation;
  return { id: i.id, method: i.method, expiresAt: i.expires_at, delivery: i.delivery, token: i.token ?? null };
}

export type GuardianInvitationStatus = "pending" | "accepted" | "revoked" | "expired" | "superseded";

export interface GuardianInvitation {
  id: string;
  guardianId: string;
  learnerId: string;
  method: GuardianInviteMethod;
  /** The contact with most of it hidden (the server never sends it whole). */
  contactHint: string;
  status: GuardianInvitationStatus;
  deliveryStatus: "not_configured" | "pending" | "sent" | "failed";
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
}

/** The school's guardian invitations, newest first as the server gives them; `status` narrows (usually "pending"). */
export async function apiListGuardianInvitations(tenantId: string, status?: GuardianInvitationStatus): Promise<GuardianInvitation[]> {
  const res = await apiClient().get("/v1/tenants/{tenantId}/guardian-invitations", { path: { tenantId }, query: { limit: 200, ...(status ? { status } : {}) }, tenantId });
  return res.invitations.map((i) => ({
    id: i.id, guardianId: i.guardian_id, learnerId: i.learner_id, method: i.contact_method, contactHint: i.contact_hint, status: i.status,
    deliveryStatus: i.delivery_status, createdAt: i.created_at, expiresAt: i.expires_at, acceptedAt: i.accepted_at,
  }));
}

export async function apiRevokeGuardianInvitation(tenantId: string, invitationId: string): Promise<void> {
  await apiClient().post("/v1/tenants/{tenantId}/guardian-invitations/{invitationId}/revoke", { path: { tenantId, invitationId }, tenantId });
}

/** A one-time reset link for a member of the school (needs the password confirmed recently). The link is shown once. */
export async function apiIssueMemberReset(tenantId: string, userId: string): Promise<{ expiresAt: string; token: string }> {
  const res = await apiClient().post("/v1/tenants/{tenantId}/members/{userId}/password-reset", { path: { tenantId, userId }, tenantId });
  return { expiresAt: res.reset.expires_at, token: res.reset.token };
}

/** The addresses the e-mails would carry (apps/api resendNotifier.ts), for handing a token over by another route. */
export function acceptInviteLink(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/accept-invite?token=${encodeURIComponent(token)}`;
}

export function resetPasswordLink(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/reset-password?token=${encodeURIComponent(token)}`;
}
