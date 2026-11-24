import type { Tx } from "../../db/sql.js";
import { attachDenialAudit } from "../../db/errors.js";
import { notFound } from "../../http/errors.js";

/**
 * Family reads (A1, docs/FAMILY-READS.md). "My child" is decided only by `family_my_children()` (migration 099), a
 * definer function that reads the owner-only guardian_accounts with the user and school the server set for this
 * transaction. Nothing here takes a user id from the client, and nothing is cached between requests.
 */
export interface ChildLink {
  learner_id: string;
  guardian_id: string;
  relationship: string;
  is_primary_payer: boolean;
}

/** One answer for every reason a learner is not the caller's child, so the endpoints are not an oracle for learner ids. */
export const CHILD_NOT_FOUND = "Child not found";

export async function myChildLinks(tx: Tx): Promise<ChildLink[]> {
  const res = await tx.query<ChildLink>(
    `SELECT learner_id, guardian_id, relationship, is_primary_payer FROM public.family_my_children()`,
  );
  return res.rows;
}

/** True when the learner is one of the caller's children in the school of this transaction. */
export async function isMyChild(tx: Tx, learnerId: string): Promise<ChildLink | null> {
  const res = await tx.query<ChildLink>(
    `SELECT learner_id, guardian_id, relationship, is_primary_payer FROM public.family_my_children() WHERE learner_id = $1::uuid`,
    [learnerId],
  );
  return res.rows[0] ?? null;
}

/**
 * The gate of every per-child endpoint: 404 for another family's child, another school's learner, an archived learner,
 * a revoked link, an archived relationship or guardian record, or an id that does not exist. The refusal is audited
 * (`family.child.denied`) after the rollback, like a permission denial.
 */
export async function assertMyChild(
  tx: Tx,
  input: { learnerId: string; actorUserId: string; tenantId: string; ip?: string | null },
): Promise<ChildLink> {
  const link = await isMyChild(tx, input.learnerId);
  if (link) return link;
  const err = notFound(CHILD_NOT_FOUND);
  attachDenialAudit(err, {
    eventType: "family.child.denied",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { learnerId: input.learnerId },
    ip: input.ip ?? null,
  });
  throw err;
}

export interface ChildClass {
  id: string;
  name: string;
  form_level: number | null;
  stream: string | null;
  academic_year_id: string;
}

export interface FamilyChild {
  learner_id: string;
  full_name: string;
  admission_no: string;
  boarding: boolean;
  relationship: string;
  is_primary_payer: boolean;
  /** The learner's class in the current academic year (active membership of an active class), or null. */
  class: ChildClass | null;
}

/** Active memberships of active classes in the school's current academic year, one per learner. */
export async function currentClasses(tx: Tx, tenantId: string, learnerIds: readonly string[]): Promise<Map<string, ChildClass>> {
  if (learnerIds.length === 0) return new Map();
  const res = await tx.query<ChildClass & { learner_id: string }>(
    `SELECT DISTINCT ON (cm.learner_id) cm.learner_id, c.id, c.name, c.form_level, c.stream, c.academic_year_id
       FROM class_memberships cm
       JOIN classes c ON c.tenant_id = cm.tenant_id AND c.id = cm.class_id AND c.active = true AND c.archived_at IS NULL
       JOIN academic_years y ON y.tenant_id = cm.tenant_id AND y.id = cm.academic_year_id AND y.is_current = true
      WHERE cm.tenant_id = $1 AND cm.learner_id = ANY($2::uuid[]) AND cm.active = true AND cm.archived_at IS NULL
      ORDER BY cm.learner_id, cm.created_at DESC, cm.id`,
    [tenantId, learnerIds],
  );
  const out = new Map<string, ChildClass>();
  for (const r of res.rows) {
    out.set(r.learner_id, { id: r.id, name: r.name, form_level: r.form_level, stream: r.stream, academic_year_id: r.academic_year_id });
  }
  return out;
}

export async function listMyChildren(tx: Tx, tenantId: string): Promise<FamilyChild[]> {
  const links = await myChildLinks(tx);
  if (links.length === 0) return [];
  const ids = links.map((l) => l.learner_id);
  const learners = await tx.query<{ id: string; full_name: string; admission_no: string; boarding: boolean }>(
    `SELECT id, full_name, admission_no, boarding FROM learners
      WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND active = true AND archived_at IS NULL`,
    [tenantId, ids],
  );
  const byId = new Map(learners.rows.map((l) => [l.id, l]));
  const classes = await currentClasses(tx, tenantId, ids);
  const out: FamilyChild[] = [];
  for (const link of links) {
    const l = byId.get(link.learner_id);
    if (!l) continue;
    out.push({
      learner_id: l.id,
      full_name: l.full_name,
      admission_no: l.admission_no,
      boarding: l.boarding,
      relationship: link.relationship,
      is_primary_payer: link.is_primary_payer,
      class: classes.get(l.id) ?? null,
    });
  }
  out.sort((a, b) => a.admission_no.localeCompare(b.admission_no) || a.learner_id.localeCompare(b.learner_id));
  return out;
}
