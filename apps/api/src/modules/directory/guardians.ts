import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import {
  CONTACT_EMAIL_MAX_LENGTH,
  CONTACT_EMAIL_PATTERN,
  CONTACT_NAME_MAX_LENGTH,
  CONTACT_NAME_PATTERN,
  CONTACT_PHONE_PATTERN,
  codePointLength,
} from "./contact.js";
import { LIKE_ESCAPE_CLAUSE, likeContains } from "./search.js";

export type GuardianRelationship = "mother" | "father" | "guardian";
export const GUARDIAN_RELATIONSHIPS: readonly GuardianRelationship[] = ["mother", "father", "guardian"];

/**
 * Contact and name rules, shared with the OpenAPI schema (`CreateGuardianRequest`) and
 * checked for agreement in tests (F-5). Values are validated exactly as sent: no trimming,
 * so the published pattern and the backend accept the same strings.
 *
 * These are now the directory-wide contact rules (`./contact.ts`), re-exported under their
 * original names so the published schema, the route schemas and the VS-2 tests keep their
 * existing identifiers. Staff and the school profile apply the same rules (P3-AUDIT-013).
 */
export const GUARDIAN_PHONE_PATTERN = CONTACT_PHONE_PATTERN;
export const GUARDIAN_NAME_PATTERN = CONTACT_NAME_PATTERN;
export const GUARDIAN_EMAIL_PATTERN = CONTACT_EMAIL_PATTERN;
export const GUARDIAN_NAME_MAX_LENGTH = CONTACT_NAME_MAX_LENGTH;
export const GUARDIAN_EMAIL_MAX_LENGTH = CONTACT_EMAIL_MAX_LENGTH;
export { codePointLength };

/**
 * Why a guardian link is archived.
 *
 * `unlinked` is the database default and means a person deliberately removed the relationship.
 * `guardian_archived` is written by {@link archiveGuardian} for the links it cascades over, so
 * {@link restoreGuardian} can reverse exactly that cascade and nothing else: a relationship that
 * was unlinked on purpose stays unlinked when the guardian comes back (migration 027).
 */
export type GuardianLinkArchiveReason = "unlinked" | "guardian_archived";

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
  /**
   * Lifecycle state. Learners and staff have always returned these; guardians did not, so a
   * caller could filter on `?active=` but could never tell from a record whether it was archived.
   * Returned wherever contact fields are returned (same permission, no new disclosure).
   */
  active: boolean;
  archived_at: string | null;
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
  active: boolean;
  archived_at: Date | string | null;
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
    active: row.active,
    archived_at: row.archived_at == null ? null : isoStamp(row.archived_at),
    created_at: isoStamp(row.created_at),
    updated_at: isoStamp(row.updated_at),
  };
}

const GUARDIAN_COLS = `id, tenant_id, full_name, phone, alt_phone, email, active, archived_at, created_at, updated_at`;
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
  db: Tx,
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

/**
 * Serialise read-modify-write on one guardian (P3-AUDIT-012).
 *
 * Silent on a missing row: the caller's own lookup produces the 404, so the lock never becomes a
 * second, differently-worded existence oracle. `FOR UPDATE` needs UPDATE privilege, which the
 * runtime role holds at column level from migration 027.
 */
async function lockGuardianRow(db: Tx, tenantId: string, guardianId: string): Promise<void> {
  await db.query(`SELECT 1 FROM guardians WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [
    guardianId,
    tenantId,
  ]);
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
export async function createGuardian(db: Tx, input: CreateGuardianInput): Promise<PublicCreatedGuardian> {
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

/** The create-response view of a guardian (id, tenant, current links). No contact fields (F-2, F-6). */
export async function getCreatedGuardianView(
  db: Tx,
  input: { tenantId: string; guardianId: string },
): Promise<PublicCreatedGuardian | null> {
  const g = await db.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM guardians WHERE id = $1 AND tenant_id = $2`,
    [input.guardianId, input.tenantId],
  );
  if (g.rowCount !== 1) return null;
  const links = await db.query<LinkRow>(
    `SELECT ${LINK_COLS} FROM guardian_links WHERE guardian_id = $1 AND tenant_id = $2 AND archived_at IS NULL ORDER BY created_at, id`,
    [input.guardianId, input.tenantId],
  );
  return { id: g.rows[0]!.id, tenantId: g.rows[0]!.tenant_id, links: links.rows.map(mapLink) };
}

export async function getGuardianLinkById(
  db: Tx,
  input: { tenantId: string; linkId: string },
): Promise<PublicGuardianLink | null> {
  const r = await db.query<LinkRow>(
    `SELECT ${LINK_COLS} FROM guardian_links WHERE id = $1 AND tenant_id = $2`,
    [input.linkId, input.tenantId],
  );
  return r.rows[0] ? mapLink(r.rows[0]) : null;
}

export async function getGuardianById(
  db: Tx,
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
  db: Tx,
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
        // P3-AUDIT-007: lock the guardian row for the rest of the transaction. A concurrent archive
        // of this guardian waits for this link to commit (and then archives it), instead of
        // committing first and leaving an active link on an archived guardian.
        const g = await db.query(
          `SELECT 1 FROM guardians WHERE id = $1 AND tenant_id = $2 AND active = true FOR SHARE`,
          [input.guardianId, input.tenantId],
        );
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

/**
 * SQL keyset page of guardians linked to a learner.
 * ORDER BY l.created_at, l.id with row comparison; timestamps as microsecond UTC text.
 */
export async function listGuardiansForLearnerPage(
  db: Tx,
  input: {
    tenantId: string;
    learnerId: string;
    actorUserId: string;
    limit: number;
    after?: { createdAt: string; linkId: string } | null;
  },
): Promise<LearnerGuardian[]> {
  const learner = await db.query(`SELECT 1 FROM learners WHERE id = $1 AND tenant_id = $2`, [
    input.learnerId,
    input.tenantId,
  ]);
  if (learner.rowCount !== 1) throw notFound("Learner not found");

  const params: unknown[] = [input.learnerId, input.tenantId];
  let keyset = "";
  if (input.after) {
    params.push(input.after.createdAt, input.after.linkId);
    keyset = `AND (l.created_at, l.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(input.limit);
  const limitParam = `$${params.length}`;

  const result = await db.query<{
    id: string;
    tenant_id: string;
    full_name: string;
    phone: string | null;
    alt_phone: string | null;
    email: string | null;
    link_id: string;
    relationship: string;
    is_primary_payer: boolean;
    link_created_at_text: string;
  }>(
    `SELECT g.id, g.tenant_id, g.full_name, g.phone, g.alt_phone, g.email,
            l.id AS link_id, l.relationship, l.is_primary_payer,
            to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS link_created_at_text
     FROM guardian_links l
     JOIN guardians g ON g.id = l.guardian_id AND g.tenant_id = l.tenant_id
     WHERE l.learner_id = $1 AND l.tenant_id = $2
       AND l.archived_at IS NULL
       AND g.active = true
     ${keyset}
     ORDER BY l.created_at, l.id
     LIMIT ${limitParam}`,
    params,
  );
  return result.rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    full_name: r.full_name,
    phone: r.phone,
    alt_phone: r.alt_phone,
    email: r.email,
    linkId: r.link_id,
    relationship: r.relationship as GuardianRelationship,
    is_primary_payer: r.is_primary_payer,
    created_at: r.link_created_at_text,
  }));
}

export async function listGuardiansForLearner(
  db: Tx,
  input: { tenantId: string; learnerId: string; actorUserId: string },
): Promise<LearnerGuardian[]> {
  return listGuardiansForLearnerPage(db, { ...input, limit: 10_000, after: null });
}

export async function updateGuardian(
  db: Tx,
  input: {
    tenantId: string;
    guardianId: string;
    actorUserId: string;
    full_name?: string;
    phone?: string | null;
    alt_phone?: string | null;
    email?: string | null;
    ip?: string | null;
  },
): Promise<PublicGuardianContact> {
  // P3-AUDIT-012: lock the row for the rest of the transaction before the read-modify-write, so
  // two concurrent PATCHes cannot each read the same `current` and have the later one silently
  // discard the earlier one's fields. The lock is released by COMMIT/ROLLBACK of the tenant
  // transaction the route already opened.
  await lockGuardianRow(db, input.tenantId, input.guardianId);
  const current = await getGuardianById(db, input);
  // Audit finding A-05: the UPDATE below is `WHERE active = true`, so an archived guardian fell
  // through to `notFound("Guardian not found")` — a 404 for a record the caller can read, and
  // different from the 400-with-instruction that learners and staff give for the same action.
  // The three directory entities share one lifecycle, so they answer the same way.
  if (!current.active) {
    throw validationError("Archived guardians cannot be updated; restore first");
  }
  const full_name = input.full_name !== undefined ? input.full_name : current.full_name;
  if (input.full_name !== undefined) {
    if (!new RegExp(GUARDIAN_NAME_PATTERN).test(full_name) || codePointLength(full_name) > GUARDIAN_NAME_MAX_LENGTH) {
      throw validationError("full_name is invalid");
    }
  }
  const phone = input.phone !== undefined ? input.phone : current.phone;
  const alt_phone = input.alt_phone !== undefined ? input.alt_phone : current.alt_phone;
  const email = input.email !== undefined ? input.email : current.email;
  if (phone != null && !new RegExp(GUARDIAN_PHONE_PATTERN).test(phone)) {
    throw validationError("phone is invalid");
  }
  if (alt_phone != null && !new RegExp(GUARDIAN_PHONE_PATTERN).test(alt_phone)) {
    throw validationError("alt_phone is invalid");
  }
  if (email != null && !new RegExp(GUARDIAN_EMAIL_PATTERN, "i").test(email)) {
    throw validationError("email is invalid");
  }

  const result = await db.query<GuardianRow>(
    `UPDATE guardians
        SET full_name = $3, phone = $4, alt_phone = $5, email = $6, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND active = true
      RETURNING ${GUARDIAN_COLS}`,
    [input.guardianId, input.tenantId, full_name, phone, alt_phone, email],
  );
  const row = result.rows[0];
  if (!row) throw notFound("Guardian not found");
  await recordSecurityEvent(db, {
    eventType: "directory.guardian.updated",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { guardianId: row.id },
    ip: input.ip ?? null,
  });
  return mapGuardianContact(row);
}

export async function listGuardiansPage(
  db: Tx,
  input: {
    tenantId: string;
    limit: number;
    cursorKeys?: string[] | null;
    active?: boolean | null;
    q?: string | null;
  },
): Promise<Array<PublicGuardianContact & { _sort_name: string }>> {
  const params: unknown[] = [input.tenantId];
  const filters = [`tenant_id = $1`];
  if (input.active === true || input.active === false) {
    params.push(input.active);
    filters.push(`active = $${params.length}`);
  }
  if (input.q?.trim()) {
    // P3-AUDIT-013: literal search, not a pattern language. `%`/`_`/`\` in the term are escaped.
    params.push(likeContains(input.q.trim()));
    filters.push(`lower(full_name) LIKE $${params.length} ${LIKE_ESCAPE_CLAUSE}`);
  }
  let keyset = "";
  if (input.cursorKeys?.length === 2) {
    params.push(input.cursorKeys[0], input.cursorKeys[1]);
    keyset = `AND (lower(full_name), id) > ($${params.length - 1}::text, $${params.length}::uuid)`;
  }
  params.push(input.limit + 1);
  const result = await db.query<GuardianRow & { sort_name: string }>(
    `SELECT ${GUARDIAN_COLS}, lower(full_name) AS sort_name
       FROM guardians
      WHERE ${filters.join(" AND ")}
      ${keyset}
      ORDER BY lower(full_name) ASC, id ASC
      LIMIT $${params.length}`,
    params,
  );
  return result.rows.map((row) => ({
    ...mapGuardianContact(row),
    _sort_name: row.sort_name,
  }));
}

export async function archiveGuardianLink(
  db: Tx,
  input: {
    tenantId: string;
    guardianId: string;
    linkId: string;
    actorUserId: string;
    ip?: string | null;
  },
): Promise<PublicGuardianLink> {
  const result = await db.query<LinkRow>(
    // `archived_reason = 'unlinked'` is stated rather than left to the column default: this is a
    // deliberate removal, so restoring the guardian must NOT bring it back (migration 027).
    `UPDATE guardian_links
        SET archived_at = now(), archived_reason = 'unlinked'
      WHERE id = $1 AND guardian_id = $2 AND tenant_id = $3 AND archived_at IS NULL
      RETURNING ${LINK_COLS}`,
    [input.linkId, input.guardianId, input.tenantId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("Guardian link not found");
  await recordSecurityEvent(db, {
    eventType: "directory.guardian.link_archived",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { guardianId: input.guardianId, linkId: input.linkId, learnerId: row.learner_id },
    ip: input.ip ?? null,
  });
  return mapLink(row);
}

export async function archiveGuardian(
  db: Tx,
  input: { tenantId: string; guardianId: string; actorUserId: string; ip?: string | null },
): Promise<PublicGuardianContact> {
  const result = await db.query<GuardianRow>(
    `UPDATE guardians
        SET active = false, archived_at = now(), updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND active = true
      RETURNING ${GUARDIAN_COLS}`,
    [input.guardianId, input.tenantId],
  );
  const row = result.rows[0];
  if (!row) {
    await getGuardianById(db, input);
    throw validationError("Guardian is already archived");
  }
  // The cascade is stamped `guardian_archived` so restore can reverse exactly these links and
  // leave deliberately unlinked relationships alone (migration 027).
  const cascaded = await db.query(
    `UPDATE guardian_links SET archived_at = now(), archived_reason = 'guardian_archived'
      WHERE guardian_id = $1 AND tenant_id = $2 AND archived_at IS NULL`,
    [input.guardianId, input.tenantId],
  );
  await recordSecurityEvent(db, {
    eventType: "directory.guardian.archived",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { guardianId: row.id, linksArchived: cascaded.rowCount ?? 0 },
    ip: input.ip ?? null,
  });
  return mapGuardianContact(row);
}

/**
 * Restore an archived guardian, and with it exactly the links that archiving the guardian
 * archived (`archived_reason = 'guardian_archived'`).
 *
 * Why this shape, and what it deliberately does not do:
 *
 *  * **Guardian archive was irreversible through the API.** `guardians.active` / `archived_at` and
 *    the `guardians_archive_consistency` CHECK were added by migration 019 in the same shape as
 *    learners (006) and staff (018), both of which restore. Only the guardian route was missing,
 *    so an operator mistake could not be undone.
 *  * **Only the cascade is reversed.** A link a user unlinked on purpose carries the default
 *    reason `unlinked` and is left archived. Re-linking it is the existing, already-authorised
 *    `POST /guardians/:id/links`; no second way to create a relationship is introduced.
 *  * **The active-learner rule still applies.** Migration 027 extends the migration-008 guard to
 *    un-archiving, so a link whose learner has since been archived cannot come back. Those links
 *    are skipped here (not refused), the guardian is still restored, and the audit event records
 *    how many were restored and how many were held back, so the result is never silent.
 */
export async function restoreGuardian(
  db: Tx,
  input: { tenantId: string; guardianId: string; actorUserId: string; ip?: string | null },
): Promise<PublicGuardianContact> {
  const result = await db.query<GuardianRow>(
    `UPDATE guardians
        SET active = true, archived_at = NULL, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND active = false
      RETURNING ${GUARDIAN_COLS}`,
    [input.guardianId, input.tenantId],
  );
  const row = result.rows[0];
  if (!row) {
    // Distinguishes "no such guardian in this tenant" (404) from "not archived" (400) using the
    // same lookup every other guardian read uses, so neither answer is a new oracle.
    await getGuardianById(db, input);
    throw validationError("Guardian is not archived");
  }

  // One set-based statement, because `Tx` refuses SAVEPOINT (AD-3: one tenant transaction, never
  // nested), so a per-link try/catch could not recover — the first failure would poison the
  // transaction. Everything that must not be restored is therefore excluded by the query itself:
  //   * `archived_reason = 'guardian_archived'` — only this guardian-archive's own cascade;
  //   * `lr.active = true`              — the migration-008 active-learner rule, which 027 extends
  //                                       to un-archiving, so this also matches what the trigger
  //                                       would enforce;
  //   * `NOT EXISTS (… archived_at IS NULL)` — a relationship re-created after the archive already
  //                                       occupies the partial unique index; restoring would be a
  //                                       23505;
  //   * `DISTINCT ON (learner_id)`      — archive/re-link/archive leaves several cascaded links for
  //                                       one learner; exactly the most recent one comes back.
  let restored;
  try {
    restored = await db.query<{ id: string }>(
      `WITH candidates AS (
         SELECT DISTINCT ON (l.learner_id) l.id
           FROM guardian_links l
           JOIN learners lr ON lr.id = l.learner_id AND lr.tenant_id = l.tenant_id
          WHERE l.guardian_id = $1
            AND l.tenant_id = $2
            AND l.archived_at IS NOT NULL
            AND l.archived_reason = 'guardian_archived'
            AND lr.active = true
            AND NOT EXISTS (
              SELECT 1 FROM guardian_links a
               WHERE a.guardian_id = l.guardian_id
                 AND a.learner_id = l.learner_id
                 AND a.tenant_id = l.tenant_id
                 AND a.archived_at IS NULL
            )
          ORDER BY l.learner_id, l.created_at DESC, l.id DESC
       )
       UPDATE guardian_links g
          SET archived_at = NULL, archived_reason = 'unlinked'
         FROM candidates c
        WHERE g.id = c.id AND g.tenant_id = $2
       RETURNING g.id`,
      [input.guardianId, input.tenantId],
    );
  } catch (err) {
    // Narrow race: a learner archived between this statement's snapshot and the guard's FOR SHARE,
    // or a link created concurrently for the same pair. Atomic by design — the guardian restore
    // rolls back with it and the caller retries against the new state.
    if (isInactiveLearnerViolation(err) || isUniqueViolation(err)) {
      throw conflict("The guardian's relationships changed during the restore; try again");
    }
    throw err;
  }
  const restoredLinks = restored.rowCount ?? 0;

  const heldBack = (await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM guardian_links
      WHERE guardian_id = $1 AND tenant_id = $2
        AND archived_at IS NOT NULL AND archived_reason = 'guardian_archived'`,
    [input.guardianId, input.tenantId],
  )).rows[0];

  await recordSecurityEvent(db, {
    eventType: "directory.guardian.restored",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: {
      guardianId: row.id,
      linksRestored: restoredLinks,
      linksHeldBack: Number(heldBack?.n ?? 0),
    },
    ip: input.ip ?? null,
  });
  return mapGuardianContact(row);
}
