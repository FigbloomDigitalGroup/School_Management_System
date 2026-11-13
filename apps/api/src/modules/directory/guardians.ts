import type pg from "pg";
import { withTransaction } from "../../db/pool.js";
import { setTenantContext } from "../../db/tenantContext.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";

export type GuardianRelationship = "mother" | "father" | "guardian";
export const GUARDIAN_RELATIONSHIPS: readonly GuardianRelationship[] = ["mother", "father", "guardian"];

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

export interface PublicGuardian {
  id: string;
  tenantId: string;
  full_name: string;
  phone: string | null;
  alt_phone: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
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

function mapGuardian(row: GuardianRow, links: PublicGuardianLink[]): PublicGuardian {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    full_name: row.full_name,
    phone: row.phone,
    alt_phone: row.alt_phone,
    email: row.email,
    created_at: isoStamp(row.created_at),
    updated_at: isoStamp(row.updated_at),
    links,
  };
}

const GUARDIAN_COLS = `id, tenant_id, full_name, phone, alt_phone, email, created_at, updated_at`;
const LINK_COLS = `id, guardian_id, learner_id, relationship, is_primary_payer, created_at`;

function cleanOptional(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function validateLink(link: GuardianLinkInput): { learner_id: string; relationship: GuardianRelationship; primary: boolean } {
  if (!GUARDIAN_RELATIONSHIPS.includes(link.relationship)) {
    throw validationError("Relationship must be mother, father or guardian");
  }
  return {
    learner_id: link.learner_id,
    relationship: link.relationship,
    primary: link.is_primary_payer === true,
  };
}

/** Tenant-scoped transaction; sets app.tenant_id / app.user_id for hybrid RLS. */
async function withGuardianTenantScope<T>(
  pool: pg.Pool,
  input: { tenantId: string; userId: string },
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    await setTenantContext(client, { tenantId: input.tenantId, userId: input.userId, mode: "app" });
    return fn(client);
  });
}

/** Every id must be a learner of this tenant; unknown and foreign ids are indistinguishable. */
async function assertLearnersInTenant(
  client: pg.PoolClient,
  tenantId: string,
  learnerIds: string[],
): Promise<void> {
  const found = await client.query<{ id: string }>(
    `SELECT id FROM learners WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tenantId, learnerIds],
  );
  if (found.rowCount !== new Set(learnerIds).size) {
    throw notFound("Learner not found");
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "23505";
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
export async function createGuardian(pool: pg.Pool, input: CreateGuardianInput): Promise<PublicGuardian> {
  const full_name = input.full_name.trim();
  if (!full_name) throw validationError("Full name is required");
  if (full_name.length > 120) throw validationError("Full name is too long");
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
    return await withGuardianTenantScope(
      pool,
      { tenantId: input.tenantId, userId: input.actorUserId },
      async (client) => {
        await assertLearnersInTenant(client, input.tenantId, ids);

        const inserted = await client.query<GuardianRow>(
          `INSERT INTO guardians (tenant_id, full_name, phone, alt_phone, email, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING ${GUARDIAN_COLS}`,
          [input.tenantId, full_name, phone, alt_phone, email, input.actorUserId],
        );
        const guardian = inserted.rows[0];
        if (!guardian) throw new Error("guardian insert returned no row");

        const savedLinks: PublicGuardianLink[] = [];
        for (const link of links) {
          const row = await client.query<LinkRow>(
            `INSERT INTO guardian_links
               (tenant_id, guardian_id, learner_id, relationship, is_primary_payer, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING ${LINK_COLS}`,
            [input.tenantId, guardian.id, link.learner_id, link.relationship, link.primary, input.actorUserId],
          );
          savedLinks.push(mapLink(row.rows[0]!));
        }

        // Audit detail carries ids and relationship only: no names, phones or emails.
        await recordSecurityEvent(client, {
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

        return mapGuardian(guardian, savedLinks);
      },
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict("This guardian is already linked to that learner");
    }
    throw err;
  }
}

export async function getGuardianById(
  pool: pg.Pool,
  input: { tenantId: string; guardianId: string; actorUserId: string },
): Promise<PublicGuardian> {
  const result = await withGuardianTenantScope(
    pool,
    { tenantId: input.tenantId, userId: input.actorUserId },
    async (client) => {
      const g = await client.query<GuardianRow>(
        `SELECT ${GUARDIAN_COLS} FROM guardians WHERE id = $1 AND tenant_id = $2`,
        [input.guardianId, input.tenantId],
      );
      const guardian = g.rows[0];
      if (!guardian) return null;
      const l = await client.query<LinkRow>(
        `SELECT ${LINK_COLS} FROM guardian_links
         WHERE guardian_id = $1 AND tenant_id = $2
         ORDER BY created_at, id`,
        [input.guardianId, input.tenantId],
      );
      return mapGuardian(guardian, l.rows.map(mapLink));
    },
  );
  if (!result) throw notFound("Guardian not found");
  return result;
}

export async function addGuardianLink(
  pool: pg.Pool,
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
    return await withGuardianTenantScope(
      pool,
      { tenantId: input.tenantId, userId: input.actorUserId },
      async (client) => {
        const g = await client.query(`SELECT 1 FROM guardians WHERE id = $1 AND tenant_id = $2`, [
          input.guardianId,
          input.tenantId,
        ]);
        if (g.rowCount !== 1) throw notFound("Guardian not found");
        await assertLearnersInTenant(client, input.tenantId, [link.learner_id]);

        const row = await client.query<LinkRow>(
          `INSERT INTO guardian_links
             (tenant_id, guardian_id, learner_id, relationship, is_primary_payer, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING ${LINK_COLS}`,
          [input.tenantId, input.guardianId, link.learner_id, link.relationship, link.primary, input.actorUserId],
        );
        await recordSecurityEvent(client, {
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
      },
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict("This guardian is already linked to that learner");
    }
    throw err;
  }
}

export async function listGuardiansForLearner(
  pool: pg.Pool,
  input: { tenantId: string; learnerId: string; actorUserId: string },
): Promise<LearnerGuardian[]> {
  const rows = await withGuardianTenantScope(
    pool,
    { tenantId: input.tenantId, userId: input.actorUserId },
    async (client) => {
      const learner = await client.query(`SELECT 1 FROM learners WHERE id = $1 AND tenant_id = $2`, [
        input.learnerId,
        input.tenantId,
      ]);
      if (learner.rowCount !== 1) return null;
      const result = await client.query<
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
    },
  );
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
