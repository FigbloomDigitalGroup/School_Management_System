import type { Db } from "../../db/pool.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";

export type GuardianRelationship = "mother" | "father" | "guardian";
export const GUARDIAN_RELATIONSHIPS: readonly GuardianRelationship[] = ["mother", "father", "guardian"];

/**
 * Contact and name rules, shared with the OpenAPI schema (`CreateGuardianRequest`) and
 * checked for agreement in tests (F-5). Values are validated exactly as sent: no trimming,
 * so the published pattern and the backend accept the same strings.
 */
export const GUARDIAN_PHONE_PATTERN = "^[0-9+()\\-][0-9+()\\-\\s]{3,30}[0-9+()\\-]$";
export const GUARDIAN_NAME_PATTERN = "^\\S([\\s\\S]*\\S)?$";

/**
 * Same acceptance set as zod 3.25's built-in `.email()` (case-insensitive flag written out as
 * explicit ranges, so the published OpenAPI `pattern` needs no flags). The backend uses this
 * pattern alone, so the published schema describes exactly what is accepted. A test compares it
 * with zod's own `.email()` on sample values so the backend is not weakened.
 */
export const GUARDIAN_EMAIL_PATTERN =
  "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-.]*)[A-Za-z0-9_+\\-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$";

export const GUARDIAN_NAME_MAX_LENGTH = 120;
export const GUARDIAN_EMAIL_MAX_LENGTH = 254;

/**
 * Length is counted in Unicode code points, the way JSON Schema `minLength` / `maxLength` count
 * it (and the way Postgres `char_length` counts it). `String.prototype.length` counts UTF-16
 * code units and would count one supplementary character (an emoji, for example) as two.
 */
export function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}

export interface GuardianLinkInput {
  learner_id: string;
  relationship: GuardianRelationship;
  is_primary_payer?: boolean;
}

export interface PublicGuardianLink {
  id: string;
  guardianId: string;
  learnerId: string;
  relationship: GuardianRelationship;
  is_primary_payer: boolean;
  created_at: string;
}

/** Contact fields only — used for GET so linked learner ids are not exposed (F-2). */
export interface PublicGuardianContact {
  id: string;
  tenantId: string;
  full_name: string;
  phone: string | null;
  alt_phone: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Create response: id and the links just written. Contact fields are deliberately not echoed
 * back, so a caller with only resource.guardian.write never receives contact details (F-2, F-6).
 */
export interface PublicCreatedGuardian {
  id: string;
  tenantId: string;
  links: PublicGuardianLink[];
}

/** A guardian as listed under one learner. */
export interface LearnerGuardian {
  id: string;
  tenantId: string;
  full_name: string;
  phone: string | null;
  alt_phone: string | null;
  email: string | null;
  linkId: string;
  relationship: GuardianRelationship;
  is_primary_payer: boolean;
  created_at: string;
}

interface GuardianRow {
  id: string;
  tenant_id: string;
  full_name: string;
  phone: string | null;
  alt_phone: string | null;
  email: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface LinkRow {
  id: string;
  guardian_id: string;
  learner_id: string;
  relationship: string;
  is_primary_payer: boolean;
  created_at: Date | string;
}

function isoStamp(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

function mapLink(row: LinkRow): PublicGuardianLink {
  return {
    id: row.id,
    guardianId: row.guardian_id,
    learnerId: row.learner_id,
    relationship: row.relationship as GuardianRelationship,
    is_primary_payer: row.is_primary_payer,
    created_at: isoStamp(row.created_at),
  };
}

function mapGuardianContact(row: GuardianRow): PublicGuardianContact {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    full_name: row.full_name,
    phone: row.phone,
    alt_phone: row.alt_phone,
    email: row.email,
    created_at: isoStamp(row.created_at),
    updated_at: isoStamp(row.updated_at),
  };
}

const GUARDIAN_COLS = `id, tenant_id, full_name, phone, alt_phone, email, created_at, updated_at`;
const LINK_COLS = `id, guardian_id, learner_id, relationship, is_primary_payer, created_at`;

function cleanOptional(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** UUID strings compare case-insensitively in Postgres; normalize before Set checks (F-1). */
function normalizeLearnerId(id: string): string {
  return id.trim().toLowerCase();
}

function validateLink(link: GuardianLinkInput): { learner_id: string; relationship: GuardianRelationship; primary: boolean } {
  if (!GUARDIAN_RELATIONSHIPS.includes(link.relationship)) {
    throw validationError("Relationship must be mother, father or guardian");
  }
  return {
    learner_id: normalizeLearnerId(link.learner_id),
    relationship: link.relationship,
    primary: link.is_primary_payer === true,
  };
}

/**
 * Application precheck: every id must be an active learner of this tenant.
 *
 * F-3: unknown, foreign and archived learners get the same 404, so a caller cannot tell
 * whether a learner id exists or is archived.
 * F-4: this precheck alone is not enough under concurrency. The database guard
 * (migration 008, guardian_links_active_learner) locks the learner row and refuses the
 * insert with SQLSTATE P0002, which mapLinkWriteError() turns into the same 404.
 */
async function assertActiveLearnersInTenant(
  db: Db,
  tenantId: string,
  learnerIds: string[],
): Promise<void> {
  const found = await db.query<{ id: string; active: boolean }>(
    `SELECT id, active FROM learners WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tenantId, learnerIds],
  );
  if (found.rowCount !== new Set(learnerIds).size || found.rows.some((r) => !r.active)) {
    throw notFound("Learner not found");
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "23505";
}

function isInactiveLearnerViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P0002";
}

/** Maps the database guard and the unique key to the API's safe errors. */
function mapLinkWriteError(err: unknown): unknown {
  if (isUniqueViolation(err)) return conflict("This guardian is already linked to that learner");
  if (isInactiveLearnerViolation(err)) return notFound("Learner not found");
  return err;
}

export interface CreateGuardianInput {
  tenantId: string;
  actorUserId: string;
  full_name: string;
  phone?: string | null;
  alt_phone?: string | null;
  email?: string | null;
  learners: GuardianLinkInput[];
  ip?: string | null;
}

/** Guardian + its initial learner links in one transaction. */
export async function createGuardian(db: Db, input: CreateGuardianInput): Promise<PublicCreatedGuardian> {
  const full_name = input.full_name.trim();
  if (!full_name) throw validationError("Full name is required");
  if (codePointLength(full_name) > GUARDIAN_NAME_MAX_LENGTH) throw validationError("Full name is too long");
  if (!Array.isArray(input.learners) || input.learners.length === 0) {
    throw validationError("A guardian must be linked to at least one learner");
  }
  const links = input.learners.map(validateLink);
  const ids = links.map((l) => l.learner_id);
  if (new Set(ids).size !== ids.length) {
    throw validationError("A learner can only be listed once per guardian");
  }

  const phone = cleanOptional(input.phone);
  const alt_phone = cleanOptional(input.alt_phone);
  const email = cleanOptional(input.email);

  try {
    return await (async () => {
        await assertActiveLearnersInTenant(db, input.tenantId, ids);

        const inserted = await db.query<GuardianRow>(
          `INSERT INTO guardians (tenant_id, full_name, phone, alt_phone, email, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING ${GUARDIAN_COLS}`,
          [input.tenantId, full_name, phone, alt_phone, email, input.actorUserId],
        );
        const guardian = inserted.rows[0];
        if (!guardian) throw new Error("guardian insert returned no row");

        const savedLinks: PublicGuardianLink[] = [];
        for (const link of links) {
          const row = await db.query<LinkRow>(
            `INSERT INTO guardian_links
               (tenant_id, guardian_id, learner_id, relationship, is_primary_payer, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING ${LINK_COLS}`,
            [input.tenantId, guardian.id, link.learner_id, link.relationship, link.primary, input.actorUserId],
          );
          savedLinks.push(mapLink(row.rows[0]!));
        }

        // Audit detail carries ids and relationship only: no names, phones or emails.
        await recordSecurityEvent(db, {
          eventType: "directory.guardian.created",
          actorUserId: input.actorUserId,
          tenantId: input.tenantId,
          detail: {
            guardianId: guardian.id,
            learnerIds: ids,
            relationships: links.map((l) => l.relationship),
          },
          ip: input.ip ?? null,
        });

        return { id: guardian.id, tenantId: guardian.tenant_id, links: savedLinks };
    })();
  } catch (err) {
    throw mapLinkWriteError(err);
  }
}

export async function getGuardianById(
  db: Db,
  input: { tenantId: string; guardianId: string; actorUserId: string },
): Promise<PublicGuardianContact> {
  const result = await (async () => {
      const g = await db.query<GuardianRow>(
        `SELECT ${GUARDIAN_COLS} FROM guardians WHERE id = $1 AND tenant_id = $2`,
        [input.guardianId, input.tenantId],
      );
      const guardian = g.rows[0];
      if (!guardian) return null;
      // F-2: do not return linked learner ids on guardian read.
      return mapGuardianContact(guardian);
  })();
  if (!result) throw notFound("Guardian not found");
  return result;
}

export async function addGuardianLink(
  db: Db,
  input: {
    tenantId: string;
    guardianId: string;
    actorUserId: string;
    link: GuardianLinkInput;
    ip?: string | null;
  },
): Promise<PublicGuardianLink> {
  const link = validateLink(input.link);
  try {
    return await (async () => {
        const g = await db.query(`SELECT 1 FROM guardians WHERE id = $1 AND tenant_id = $2`, [
          input.guardianId,
          input.tenantId,
        ]);
        if (g.rowCount !== 1) throw notFound("Guardian not found");
        await assertActiveLearnersInTenant(db, input.tenantId, [link.learner_id]);

        const row = await db.query<LinkRow>(
          `INSERT INTO guardian_links
             (tenant_id, guardian_id, learner_id, relationship, is_primary_payer, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING ${LINK_COLS}`,
          [input.tenantId, input.guardianId, link.learner_id, link.relationship, link.primary, input.actorUserId],
        );
        await recordSecurityEvent(db, {
          eventType: "directory.guardian.linked",
          actorUserId: input.actorUserId,
          tenantId: input.tenantId,
          detail: {
            guardianId: input.guardianId,
            learnerId: link.learner_id,
            relationship: link.relationship,
          },
          ip: input.ip ?? null,
        });
        return mapLink(row.rows[0]!);
    })();
  } catch (err) {
    throw mapLinkWriteError(err);
  }
}

export async function listGuardiansForLearner(
  db: Db,
  input: { tenantId: string; learnerId: string; actorUserId: string },
): Promise<LearnerGuardian[]> {
  const rows = await (async () => {
      const learner = await db.query(`SELECT 1 FROM learners WHERE id = $1 AND tenant_id = $2`, [
        input.learnerId,
        input.tenantId,
      ]);
      if (learner.rowCount !== 1) return null;
      const result = await db.query<
        GuardianRow & { link_id: string; relationship: string; is_primary_payer: boolean; link_created_at: Date | string }
      >(
        `SELECT g.id, g.tenant_id, g.full_name, g.phone, g.alt_phone, g.email,
                g.created_at, g.updated_at,
                l.id AS link_id, l.relationship, l.is_primary_payer, l.created_at AS link_created_at
         FROM guardian_links l
         JOIN guardians g ON g.id = l.guardian_id AND g.tenant_id = l.tenant_id
         WHERE l.learner_id = $1 AND l.tenant_id = $2
         ORDER BY l.created_at, l.id`,
        [input.learnerId, input.tenantId],
      );
      return result.rows;
  })();
  if (!rows) throw notFound("Learner not found");
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    full_name: r.full_name,
    phone: r.phone,
    alt_phone: r.alt_phone,
    email: r.email,
    linkId: r.link_id,
    relationship: r.relationship as GuardianRelationship,
    is_primary_payer: r.is_primary_payer,
    created_at: isoStamp(r.link_created_at),
  }));
}
