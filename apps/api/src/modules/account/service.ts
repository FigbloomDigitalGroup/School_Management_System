import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../../db/pool.js";
import { conflict, forbidden, notFound, validationError } from "../../http/errors.js";
import { hashPassword } from "../identity/password.js";
import { assertPasswordPolicy } from "../identity/passwordPolicy.js";

/** 32 random bytes; only the SHA-256 is ever stored. */
export function newAccountToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashAccountToken(token) };
}
export function hashAccountToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export const INVITATION_TTL_HOURS = 72;
export const RESET_TTL_MINUTES = 30;
/** The confirmation link of an organisation sign-up (docs/ORG-SIGNUP.md). */
export const ORG_SIGNUP_VERIFY_TTL_HOURS = 24;
/** The first administrator's password-setup link, after approval (a password_reset token; the table allows at most 14 days). */
export const ORG_SIGNUP_SETUP_TTL_DAYS = 7;
const expiry = (ms: number) => new Date(Date.now() + ms);

function policy(password: string): void {
  try {
    assertPasswordPolicy(password);
  } catch (err) {
    throw validationError(err instanceof Error ? err.message : "Invalid password");
  }
}

/** Map the definer functions' SQLSTATEs onto API errors without leaking internals. */
function mapDb(err: unknown): never {
  const code = (err as { code?: string } | null)?.code;
  const message = (err as { message?: string } | null)?.message ?? "";
  if (code === "42501") throw forbidden("Insufficient permissions");
  if (code === "23505") throw conflict(message.includes("already belongs") ? "This person already belongs to the school" : "An open invitation or the school already exists");
  if (code === "22023") throw validationError("Invalid request");
  if (code === "P0002") throw notFound("Not found");
  throw err;
}

export async function provisionSchool(
  db: Db,
  input: { organizationId?: string | null; organizationName?: string | null; schoolName: string; slug: string; adminEmail: string; adminName?: string | null },
): Promise<{ tenantId: string; organizationId: string; invitationId: string; token: string; expiresAt: Date }> {
  const t = newAccountToken();
  const expiresAt = expiry(INVITATION_TTL_HOURS * 3_600_000);
  try {
    const r = await db.query<{ tenant_id: string; organization_id: string; invitation_id: string }>(
      `SELECT * FROM public.platform_provision_school($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::timestamptz)`,
      [input.organizationId ?? null, input.organizationName ?? null, input.schoolName, input.slug, input.adminEmail, input.adminName ?? null, t.hash, expiresAt],
    );
    const row = r.rows[0]!;
    return { tenantId: row.tenant_id, organizationId: row.organization_id, invitationId: row.invitation_id, token: t.token, expiresAt };
  } catch (err) {
    return mapDb(err);
  }
}

export async function createInvitation(
  db: Db,
  input: { tenantId: string; email: string; role: string; fullName?: string | null },
): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
  const t = newAccountToken();
  const expiresAt = expiry(INVITATION_TTL_HOURS * 3_600_000);
  try {
    const r = await db.query<{ id: string }>(
      `SELECT public.account_create_invitation($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::timestamptz) AS id`,
      [input.tenantId, input.email, input.role, input.fullName ?? null, t.hash, expiresAt],
    );
    return { invitationId: r.rows[0]!.id, token: t.token, expiresAt };
  } catch (err) {
    return mapDb(err);
  }
}

export async function revokeInvitation(db: Db, input: { tenantId: string; invitationId: string }): Promise<void> {
  let ok = false;
  try {
    const r = await db.query<{ ok: boolean }>(`SELECT public.account_revoke_invitation($1::uuid, $2::uuid) AS ok`, [input.tenantId, input.invitationId]);
    ok = r.rows[0]?.ok === true;
  } catch (err) {
    return mapDb(err);
  }
  if (!ok) throw notFound("Open invitation not found");
}

/** Public. Same generic failure for every cause (unknown, used, revoked, expired, suspended school). */
export async function acceptInvitation(
  db: Db,
  input: { token: string; password: string; fullName?: string | null; sessionUserId?: string | null },
): Promise<{ outcome: "accepted" | "login_required"; tenantId: string | null }> {
  policy(input.password);
  const passwordHash = await hashPassword(input.password);
  const r = await db.query<{ outcome: string; tenant_id: string | null }>(
    `SELECT outcome, tenant_id FROM public.account_accept_invitation($1::text, $2::text, $3::text, $4::uuid)`,
    [hashAccountToken(input.token), passwordHash, input.fullName ?? null, input.sessionUserId ?? null],
  );
  const row = r.rows[0];
  if (!row || row.outcome === "invalid") throw validationError("The invitation is invalid or has expired");
  return { outcome: row.outcome as "accepted" | "login_required", tenantId: row.tenant_id };
}

/** Public. Returns the raw token only to the caller of this function (the route never sends it back to the requester). */
export async function requestPasswordReset(db: Db, email: string): Promise<{ token: string; email: string } | null> {
  const t = newAccountToken();
  const r = await db.query<{ ok: boolean }>(`SELECT public.account_request_password_reset($1::text, $2::text, $3::timestamptz) AS ok`, [
    email,
    t.hash,
    expiry(RESET_TTL_MINUTES * 60_000),
  ]);
  return r.rows[0]?.ok ? { token: t.token, email: email.trim().toLowerCase() } : null;
}

export async function adminIssueReset(db: Db, input: { tenantId: string; userId: string }): Promise<{ token: string; expiresAt: Date } | null> {
  const t = newAccountToken();
  const expiresAt = expiry(RESET_TTL_MINUTES * 60_000);
  try {
    const r = await db.query<{ ok: boolean }>(`SELECT public.account_admin_issue_reset($1::uuid, $2::uuid, $3::text, $4::timestamptz) AS ok`, [
      input.tenantId,
      input.userId,
      t.hash,
      expiresAt,
    ]);
    return r.rows[0]?.ok ? { token: t.token, expiresAt } : null;
  } catch (err) {
    return mapDb(err);
  }
}

export async function completePasswordReset(db: Db, input: { token: string; password: string }): Promise<void> {
  policy(input.password);
  const passwordHash = await hashPassword(input.password);
  const r = await db.query<{ ok: boolean }>(`SELECT public.account_complete_password_reset($1::text, $2::text) AS ok`, [hashAccountToken(input.token), passwordHash]);
  if (!r.rows[0]?.ok) throw validationError("The reset link is invalid or has expired");
}

export async function deactivateMembership(db: Db, input: { tenantId: string; userId: string }): Promise<boolean> {
  try {
    const r = await db.query<{ ok: boolean }>(`SELECT public.account_deactivate_membership($1::uuid, $2::uuid) AS ok`, [input.tenantId, input.userId]);
    return r.rows[0]?.ok === true;
  } catch (err) {
    return mapDb(err);
  }
}
