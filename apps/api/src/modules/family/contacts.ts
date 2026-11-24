import type { Tx } from "../../db/sql.js";
import { myChildLinks } from "./children.js";

/**
 * Who a parent may start a chat with (docs/FAMILY-READS.md): the school's administrators, and the teachers of their
 * children's current-year classes. This is the same rule as `may_talk` (migration 100), which every chat write checks
 * again; the list only tells the client who to offer. A teacher is reachable only through a staff record linked to an
 * account with an active `teacher` membership.
 */
export interface ChatContact {
  user_id: string;
  full_name: string;
  role: "school_admin" | "teacher";
  /** For a teacher: which of the caller's children they teach, and what (null subject = class teacher). */
  teaches: Array<{ learner_id: string; class_name: string; subject: string | null }>;
}

export async function myChatContacts(tx: Tx, tenantId: string): Promise<ChatContact[]> {
  const admins = await tx.query<{ user_id: string; full_name: string }>(
    `SELECT u.id AS user_id, u.full_name
       FROM school_memberships m
       JOIN users u ON u.id = m.user_id AND u.status = 'active'
      WHERE m.tenant_id = $1 AND m.role::text = 'school_admin' AND m.archived_at IS NULL
      ORDER BY u.full_name, u.id`,
    [tenantId],
  );
  const kids = (await myChildLinks(tx)).map((l) => l.learner_id);
  const teachers = kids.length === 0
    ? { rows: [] as Array<{ user_id: string; full_name: string; learner_id: string; class_name: string; subject: string | null }> }
    : await tx.query<{ user_id: string; full_name: string; learner_id: string; class_name: string; subject: string | null }>(
        `SELECT DISTINCT u.id AS user_id, u.full_name, cm.learner_id, c.name AS class_name, t.subject
           FROM class_memberships cm
           JOIN classes c ON c.tenant_id = cm.tenant_id AND c.id = cm.class_id AND c.active = true AND c.archived_at IS NULL
           JOIN academic_years y ON y.tenant_id = cm.tenant_id AND y.id = cm.academic_year_id AND y.is_current = true
           JOIN LATERAL (
             SELECT c.class_teacher_staff_id AS staff_id, NULL::text AS subject WHERE c.class_teacher_staff_id IS NOT NULL
             UNION ALL
             SELECT ta.staff_member_id, s.name
               FROM teaching_assignments ta
               JOIN subjects s ON s.tenant_id = ta.tenant_id AND s.id = ta.subject_id
              WHERE ta.tenant_id = c.tenant_id AND ta.class_id = c.id AND ta.active = true
           ) t ON true
           JOIN staff_members sm ON sm.tenant_id = cm.tenant_id AND sm.id = t.staff_id AND sm.active = true AND sm.archived_at IS NULL
           JOIN school_memberships m ON m.tenant_id = cm.tenant_id AND m.user_id = sm.user_id AND m.archived_at IS NULL AND m.role::text = 'teacher'
           JOIN users u ON u.id = sm.user_id AND u.status = 'active'
          WHERE cm.tenant_id = $1 AND cm.learner_id = ANY($2::uuid[]) AND cm.active = true AND cm.archived_at IS NULL
          ORDER BY u.full_name, u.id, cm.learner_id, t.subject NULLS FIRST`,
        [tenantId, kids],
      );
  const out: ChatContact[] = admins.rows.map((a) => ({ user_id: a.user_id, full_name: a.full_name, role: "school_admin", teaches: [] }));
  const byTeacher = new Map<string, ChatContact>();
  for (const t of teachers.rows) {
    let c = byTeacher.get(t.user_id);
    if (!c) {
      c = { user_id: t.user_id, full_name: t.full_name, role: "teacher", teaches: [] };
      byTeacher.set(t.user_id, c);
    }
    c.teaches.push({ learner_id: t.learner_id, class_name: t.class_name, subject: t.subject });
  }
  return [...out, ...byTeacher.values()];
}
