import type { Db } from "../../db/pool.js";
import { conflict, forbidden, notFound, validationError } from "../../http/errors.js";
import { hashAccountToken, newAccountToken, ORG_SIGNUP_SETUP_TTL_DAYS, ORG_SIGNUP_VERIFY_TTL_HOURS } from "./service.js";

/**
 * Organisation self-service sign-up (docs/ORG-SIGNUP.md, migration 124). Thin callers of the SECURITY DEFINER functions: the
 * rules (who may, what is stored, what is audited) live in the database, so no route can skip them.
 */

export const ORG_KINDS = ["government", "county", "constituency", "group_owner"] as const;
export type OrgKind = (typeof ORG_KINDS)[number];

export type OrgSignupStatus = "pending_email" | "pending_review" | "approved" | "rejected" | "expired";
export const ORG_SIGNUP_STATUSES: readonly OrgSignupStatus[] = ["pending_email", "pending_review", "approved", "rejected", "expired"];

export interface OrgSignupRow {
  id: string;
  name: string;
  kind: string;
  county: string | null;
  contact_phone: string | null;
  admin_full_name: string;
  admin_email: string;
  status: string;
  created_at_text: string;
  verified_at_text: string | null;
  decided_at_text: string | null;
  decided_by_name: string | null;
  decision_reason: string | null;
  organization_id: string | null;
  organization_slug: string | null;
}

const expiry = (ms: number) => new Date(Date.now() + ms);

/** Map the definer functions' SQLSTATEs onto API errors without leaking internals. */
function mapDb(err: unknown, what: { notFound: string; state: string }): never {
  const code = (err as { code?: string } | null)?.code;
  const message = (err as { message?: string } | null)?.message ?? "";
  if (code === "42501") throw forbidden("Insufficient permissions");
  if (code === "P0002") throw notFound(what.notFound);
  if (code === "55000") throw conflict(what.state);
  if (code === "23505") {
    throw conflict(
      message.includes("already has an account")
        ? "This e-mail address already has an account, so the request cannot be approved. Reject it, or ask the person to use another address."
        : "That organisation address is already taken. Choose another.",
    );
  }
  if (code === "22023") throw validationError("Invalid request");
  throw err;
}

/** Public. `token` is set only when the caller should e-mail a confirmation link (outcome `created` or `resent`). */
export async function submitOrgSignup(
  db: Db,
  input: { name: string; kind: OrgKind; county: string | null; contactPhone: string | null; adminFullName: string; adminEmail: string },
  dailyCap: number,
): Promise<{ outcome: "created" | "resent" | "duplicate" | "capped"; token: string | null }> {
  const t = newAccountToken();
  const r = await db.query<{ outcome: string }>(
    `SELECT public.org_signup_submit($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::timestamptz, $9::integer) AS outcome`,
    [
      input.name,
      input.kind,
      input.county,
      input.contactPhone,
      input.adminFullName,
      input.adminEmail,
      t.hash,
      expiry(ORG_SIGNUP_VERIFY_TTL_HOURS * 3_600_000),
      dailyCap,
    ],
  );
  const outcome = r.rows[0]!.outcome as "created" | "resent" | "duplicate" | "capped";
  return { outcome, token: outcome === "created" || outcome === "resent" ? t.token : null };
}

/** Public. True once for a good link; false for every other cause, so the answer never says which. */
export async function verifyOrgSignup(db: Db, token: string): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>(`SELECT public.org_signup_verify($1::text) AS ok`, [hashAccountToken(token)]);
  return r.rows[0]?.ok === true;
}

const LIST_SQL = `SELECT * FROM public.platform_org_signups_list($1::uuid, $2::text, $3::timestamptz, $4::uuid, $5::integer)`;

export async function listOrgSignups(
  db: Db,
  input: { id?: string | null; status?: OrgSignupStatus | null; beforeAt?: string | null; beforeId?: string | null; limit: number },
): Promise<OrgSignupRow[]> {
  try {
    const r = await db.query<OrgSignupRow>(LIST_SQL, [input.id ?? null, input.status ?? null, input.beforeAt ?? null, input.beforeId ?? null, input.limit]);
    return r.rows;
  } catch (err) {
    return mapDb(err, { notFound: "Sign-up request not found", state: "Unavailable" });
  }
}

export async function readOrgSignup(db: Db, id: string): Promise<OrgSignupRow> {
  const rows = await listOrgSignups(db, { id, limit: 1 });
  const row = rows[0];
  if (!row) throw notFound("Sign-up request not found");
  return row;
}

export async function approveOrgSignup(
  db: Db,
  input: { id: string; slug: string | null },
): Promise<{ organizationId: string; organizationSlug: string; adminUserId: string; adminEmail: string; token: string; expiresAt: Date }> {
  const t = newAccountToken();
  const expiresAt = expiry(ORG_SIGNUP_SETUP_TTL_DAYS * 86_400_000);
  try {
    const r = await db.query<{ organization_id: string; organization_slug: string; admin_user_id: string; admin_email: string }>(
      `SELECT * FROM public.platform_org_signup_approve($1::uuid, $2::text, $3::text, $4::timestamptz)`,
      [input.id, input.slug, t.hash, expiresAt],
    );
    const row = r.rows[0]!;
    return { organizationId: row.organization_id, organizationSlug: row.organization_slug, adminUserId: row.admin_user_id, adminEmail: row.admin_email, token: t.token, expiresAt };
  } catch (err) {
    return mapDb(err, { notFound: "Sign-up request not found", state: "The request is not waiting for review" });
  }
}

export async function rejectOrgSignup(db: Db, input: { id: string; reason: string | null }): Promise<{ adminEmail: string; wasVerified: boolean }> {
  try {
    const r = await db.query<{ admin_email: string; was_verified: boolean }>(`SELECT * FROM public.platform_org_signup_reject($1::uuid, $2::text)`, [input.id, input.reason]);
    const row = r.rows[0]!;
    return { adminEmail: row.admin_email, wasVerified: row.was_verified };
  } catch (err) {
    return mapDb(err, { notFound: "Sign-up request not found", state: "The request has already been decided or has expired" });
  }
}

/** The administrator's new password-setup link; null when they have already set a password. */
export async function reissueOrgSetup(db: Db, id: string): Promise<{ adminEmail: string; token: string; expiresAt: Date } | null> {
  const t = newAccountToken();
  const expiresAt = expiry(ORG_SIGNUP_SETUP_TTL_DAYS * 86_400_000);
  try {
    const r = await db.query<{ admin_email: string }>(`SELECT * FROM public.platform_org_signup_reissue($1::uuid, $2::text, $3::timestamptz)`, [id, t.hash, expiresAt]);
    const row = r.rows[0];
    return row ? { adminEmail: row.admin_email, token: t.token, expiresAt } : null;
  } catch (err) {
    return mapDb(err, { notFound: "Sign-up request not found", state: "The request was not approved" });
  }
}
