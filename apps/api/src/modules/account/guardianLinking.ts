import type { Db } from "../../db/pool.js";
import { conflict, forbidden, notFound, unauthorized, validationError } from "../../http/errors.js";
import { hashPassword } from "../identity/password.js";
import { assertPasswordPolicy } from "../identity/passwordPolicy.js";
import { hashAccountToken, newAccountToken } from "./service.js";

/**
 * Guardian invitation and account linking (migration 073). Every rule that protects the link (single use, expiry, tenant and
 * learner binding, contact echo, explicit confirmation, one live login per guardian record, revocation on deactivation) is enforced
 * in the SECURITY DEFINER functions, not here; this module only maps their outcomes onto safe API errors.
 */
export const GUARDIAN_INVITATION_TTL_HOURS = 72;

function mapDb(err: unknown): never {
  const code = (err as { code?: string } | null)?.code;
  if (code === "42501") throw forbidden("Insufficient permissions");
  if (code === "55000") throw conflict("The guardian is archived or already linked to an account; revoke the existing link first");
  if (code === "23505") throw conflict("An open invitation already exists");
  if (code === "22023") throw validationError("Invalid request");
  if (code === "P0002") throw notFound("Guardian or learner relationship not found");
  throw err;
}

export async function createGuardianInvitation(
  db: Db,
  input: { tenantId: string; guardianId: string; learnerId: string; method: "email" | "sms" },
): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
  const t = newAccountToken();
  const expiresAt = new Date(Date.now() + GUARDIAN_INVITATION_TTL_HOURS * 3_600_000);
  try {
    const r = await db.query<{ id: string }>(
      `SELECT public.guardian_create_invitation($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::timestamptz) AS id`,
      [input.tenantId, input.guardianId, input.learnerId, input.method, t.hash, expiresAt],
    );
    return { invitationId: r.rows[0]!.id, token: t.token, expiresAt };
  } catch (err) {
    return mapDb(err);
  }
}

export async function recordGuardianDelivery(db: Db, input: { tenantId: string; invitationId: string; status: "pending" | "sent" | "failed" | "not_configured" }): Promise<void> {
  try {
    await db.query(`SELECT public.guardian_record_delivery($1::uuid, $2::uuid, $3::text)`, [input.tenantId, input.invitationId, input.status]);
  } catch (err) {
    mapDb(err);
  }
}

export async function revokeGuardianInvitation(db: Db, input: { tenantId: string; invitationId: string }): Promise<void> {
  try {
    const r = await db.query<{ ok: boolean }>(`SELECT public.guardian_revoke_invitation($1::uuid, $2::uuid) AS ok`, [input.tenantId, input.invitationId]);
    if (r.rows[0]?.ok !== true) throw notFound("Open invitation not found");
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode) throw err;
    mapDb(err);
  }
}

export async function listGuardianInvitations(db: Db, input: { tenantId: string; status?: string | null; limit?: number }): Promise<Record<string, unknown>[]> {
  try {
    const r = await db.query(`SELECT * FROM public.guardian_list_invitations($1::uuid, $2::text, $3::int)`, [input.tenantId, input.status ?? null, input.limit ?? 50]);
    return r.rows as Record<string, unknown>[];
  } catch (err) {
    return mapDb(err);
  }
}

export async function revokeGuardianAccountLink(db: Db, input: { tenantId: string; guardianId: string; reason: string }): Promise<void> {
  try {
    const r = await db.query<{ ok: boolean }>(`SELECT public.guardian_revoke_account_link($1::uuid, $2::uuid, $3::text) AS ok`, [input.tenantId, input.guardianId, input.reason]);
    if (r.rows[0]?.ok !== true) throw notFound("No live account link for this guardian");
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode) throw err;
    mapDb(err);
  }
}

/** Public. Same empty answer for every failure cause. */
export async function previewGuardianInvitation(db: Db, token: string): Promise<{ school_name: string; relationship: string; contact_method: string; existing_account: boolean } | null> {
  const r = await db.query<{ school_name: string; relationship: string; contact_method: string; existing_account: boolean }>(
    `SELECT * FROM public.guardian_preview_invitation($1::text)`,
    [hashAccountToken(token)],
  );
  return r.rows[0] ?? null;
}

export async function acceptGuardianInvitation(
  db: Db,
  input: { token: string; contact: string; confirm: boolean; password?: string | null; fullName?: string | null; sessionUserId?: string | null },
): Promise<{ tenantId: string }> {
  let passwordHash: string | null = null;
  if (input.password) {
    try {
      assertPasswordPolicy(input.password);
    } catch (err) {
      throw validationError(err instanceof Error ? err.message : "Invalid password");
    }
    passwordHash = await hashPassword(input.password);
  }
  const r = await db.query<{ outcome: string; tenant_id: string | null }>(
    `SELECT outcome, tenant_id FROM public.guardian_accept_invitation($1::text, $2::text, $3::boolean, $4::text, $5::text, $6::uuid)`,
    [hashAccountToken(input.token), input.contact, input.confirm, passwordHash, input.fullName ?? null, input.sessionUserId ?? null],
  );
  const row = r.rows[0];
  if (!row || row.outcome === "invalid") throw validationError("The invitation is invalid or has expired");
  if (row.outcome === "login_required") throw unauthorized("Sign in to the existing account to accept this invitation");
  if (row.outcome === "confirmation_required") throw validationError("Explicit confirmation of the relationship is required");
  return { tenantId: row.tenant_id! };
}

export async function myGuardianLinks(db: Db): Promise<{ tenant_id: string; guardian_id: string; learner_id: string }[]> {
  const r = await db.query<{ tenant_id: string; guardian_id: string; learner_id: string }>(`SELECT * FROM public.guardian_my_links()`);
  return r.rows;
}
