import type { Tx } from "../../db/sql.js";
import { notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import {
  ACCENT_PATTERN,
  CONTACT_EMAIL_MAX_LENGTH,
  CONTACT_EMAIL_PATTERN,
  CONTACT_PHONE_PATTERN,
} from "./contact.js";

export type InstitutionType = "k12" | "higher_ed";

export interface PublicSchoolProfile {
  tenantId: string;
  name: string;
  slug: string;
  status: string;
  timezone: string;
  organizationId: string;
  county: string | null;
  country: string | null;
  level: string | null;
  institution_type: InstitutionType | null;
  contact_email: string | null;
  contact_phone: string | null;
  moe_registration: string | null;
  // P3-AUDIT-005: no logo storage key is accepted from, or returned to, a client. A server-assigned
  // key will be introduced with the storage integration (same contract as directory documents).
  accent: string | null;
  updated_at: string | null;
}

export interface PatchSchoolProfileInput {
  tenantId: string;
  actorUserId: string;
  name?: string;
  timezone?: string;
  county?: string | null;
  country?: string | null;
  level?: string | null;
  institution_type?: InstitutionType | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  moe_registration?: string | null;
  accent?: string | null;
  ip?: string | null;
}

function isKnownTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function isoStamp(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : value.toISOString();
}

/**
 * School-profile contact and presentation validation (P3-AUDIT-013).
 *
 * These fields were length-checked only. `contact_email` / `contact_phone` now follow the same
 * directory-wide rules as guardian and staff contacts, and `accent` — which existing clients
 * interpolate into CSS — is restricted to a token shape that cannot terminate or extend a
 * declaration. See `./contact.ts` for why `accent` is a conservative token rather than a
 * hex-colour assertion.
 */
function validateProfileFields(input: {
  contact_email: string | null;
  contact_phone: string | null;
  accent: string | null;
}): void {
  if (input.contact_phone != null && !new RegExp(CONTACT_PHONE_PATTERN).test(input.contact_phone)) {
    throw validationError("contact_phone is invalid");
  }
  if (input.contact_email != null) {
    if (
      input.contact_email.length > CONTACT_EMAIL_MAX_LENGTH ||
      !new RegExp(CONTACT_EMAIL_PATTERN, "i").test(input.contact_email)
    ) {
      throw validationError("contact_email is invalid");
    }
  }
  if (input.accent != null && !new RegExp(ACCENT_PATTERN).test(input.accent)) {
    throw validationError(
      "accent must be a short token such as #1d4ed8 or brand-primary (letters, digits, - and _ only)",
    );
  }
}

export async function getSchoolProfile(
  db: Tx,
  input: { tenantId: string },
): Promise<PublicSchoolProfile> {
  const result = await db.query<{
    id: string;
    name: string;
    slug: string;
    status: string;
    timezone: string;
    organization_id: string;
    county: string | null;
    country: string | null;
    level: string | null;
    institution_type: string | null;
    contact_email: string | null;
    contact_phone: string | null;
    moe_registration: string | null;
    accent: string | null;
    updated_at: Date | string | null;
  }>(
    `SELECT t.id, t.name, t.slug, t.status, t.timezone, t.organization_id,
            p.county, p.country, p.level, p.institution_type,
            p.contact_email, p.contact_phone, p.moe_registration,
            p.accent, p.updated_at
       FROM tenants t
       LEFT JOIN school_profiles p ON p.tenant_id = t.id
      WHERE t.id = $1`,
    [input.tenantId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("School not found");
  return {
    tenantId: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    timezone: row.timezone,
    organizationId: row.organization_id,
    county: row.county,
    country: row.country,
    level: row.level,
    institution_type: (row.institution_type as InstitutionType | null) ?? null,
    contact_email: row.contact_email,
    contact_phone: row.contact_phone,
    moe_registration: row.moe_registration,
    accent: row.accent,
    updated_at: isoStamp(row.updated_at),
  };
}

/**
 * Row provenance for `school_profiles` — why there is no create route.
 *
 * `school_profiles.tenant_id` is the primary key AND a foreign key to `tenants`, so a profile row
 * is a 1:1 extension of a school, not an independently creatable object:
 *
 *   * it cannot exist without a tenant (FK), and there can never be two for one school (PK);
 *   * tenant provisioning is Stage 7's, not the directory's, so the directory never decides that
 *     a school exists;
 *   * RLS (`school_profiles_tenant`, migration 016) scopes every read and write to
 *     `app_current_tenant_id()`, so the row is owned by construction, not by a supplied id.
 *
 * The row is therefore created on demand the first time anyone writes profile fields, by this
 * function. A separate `POST .../school-profile` would add a second way to produce the same row
 * and a 409 path that cannot be reached meaningfully — so one is deliberately not published.
 * (Stage 8 open question from the reconciliation: resolved, not deferred.)
 *
 * The row is materialised *before* the read below so the subsequent `FOR UPDATE` always has
 * something to lock, which is what makes concurrent PATCHes serialise (P3-AUDIT-012) instead of
 * each reading the same `current` and overwriting the other's fields.
 */
async function ensureProfileRowLocked(db: Tx, tenantId: string): Promise<void> {
  try {
    await db.query(
      `INSERT INTO school_profiles (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId],
    );
  } catch (err) {
    // Authorization already proved a membership in this school, so the tenant exists on every
    // real path. Kept so a deleted-mid-request school is a 404 and not a 500.
    if ((err as { code?: string } | null)?.code === "23503") throw notFound("School not found");
    throw err;
  }
  await db.query(`SELECT 1 FROM school_profiles WHERE tenant_id = $1 FOR UPDATE`, [tenantId]);
}

export async function patchSchoolProfile(
  db: Tx,
  input: PatchSchoolProfileInput,
): Promise<PublicSchoolProfile> {
  await ensureProfileRowLocked(db, input.tenantId);
  const current = await getSchoolProfile(db, { tenantId: input.tenantId });

  const nextName = input.name !== undefined ? input.name.trim() : current.name;
  const nextTimezone = input.timezone !== undefined ? input.timezone.trim() : current.timezone;
  if (!nextName || nextName.length > 200) throw validationError("name must be 1–200 characters");
  if (!nextTimezone || nextTimezone.length > 64) throw validationError("timezone must be 1–64 characters");
  // P3-AUDIT-004 (TS/SQL twin of migration 023): reject an unknown zone early with a clear message.
  // The database remains the authority (pg_timezone_names) and re-checks inside the identity function.
  if (input.timezone !== undefined && !isKnownTimezone(nextTimezone)) {
    throw validationError("timezone must be a recognised time zone name, e.g. Africa/Nairobi");
  }

  if (input.name !== undefined || input.timezone !== undefined) {
    try {
      await db.query(`SELECT * FROM directory_update_tenant_identity($1, $2)`, [
        nextName,
        nextTimezone,
      ]);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "42501") throw validationError("tenant context required");
      if (code === "22023") throw validationError("invalid name or timezone");
      if (code === "P0002") throw notFound("School not found");
      throw err;
    }
  }

  const county = input.county !== undefined ? input.county : current.county;
  const country = input.country !== undefined ? input.country : current.country;
  const level = input.level !== undefined ? input.level : current.level;
  const institution_type =
    input.institution_type !== undefined ? input.institution_type : current.institution_type;
  const contact_email =
    input.contact_email !== undefined ? input.contact_email : current.contact_email;
  const contact_phone =
    input.contact_phone !== undefined ? input.contact_phone : current.contact_phone;
  const moe_registration =
    input.moe_registration !== undefined ? input.moe_registration : current.moe_registration;
  const accent = input.accent !== undefined ? input.accent : current.accent;

  // Validate the resulting record, not just the submitted fields, so a value that predates this
  // rule cannot be silently carried forward by a PATCH that touches something else.
  validateProfileFields({ contact_email, contact_phone, accent });

  // logo_object_key is intentionally not written here (P3-AUDIT-005).
  // The row is guaranteed to exist and be locked by ensureProfileRowLocked; the ON CONFLICT arm
  // is kept as a belt-and-braces no-op path rather than relied upon for creation.
  await db.query(
    `INSERT INTO school_profiles (
       tenant_id, county, country, level, institution_type,
       contact_email, contact_phone, moe_registration, accent, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       county = EXCLUDED.county,
       country = EXCLUDED.country,
       level = EXCLUDED.level,
       institution_type = EXCLUDED.institution_type,
       contact_email = EXCLUDED.contact_email,
       contact_phone = EXCLUDED.contact_phone,
       moe_registration = EXCLUDED.moe_registration,
       accent = EXCLUDED.accent,
       updated_at = now()`,
    [
      input.tenantId,
      county,
      country,
      level,
      institution_type,
      contact_email,
      contact_phone,
      moe_registration,
      accent,
    ],
  );

  await recordSecurityEvent(db, {
    eventType: "directory.school_profile.updated",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: {
      fields: Object.keys(input).filter((k) => !["tenantId", "actorUserId", "ip"].includes(k)),
    },
    ip: input.ip ?? null,
  });

  return getSchoolProfile(db, { tenantId: input.tenantId });
}
