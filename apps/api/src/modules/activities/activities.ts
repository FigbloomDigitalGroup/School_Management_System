import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import type { PageInfo } from "../../http/pagination.js";
import { pageQuery, type PageInput } from "../academics/pagination.js";
import { recordSecurityEvent } from "../audit/audit.js";

export interface Activity {
  id: string;
  tenant_id: string;
  name: string;
  category: string;
  description: string;
  meeting_schedule: string;
  active: boolean;
  archived_at: string | null;
  created_at: string;
}

const COLS = `id, tenant_id, name, category, description, meeting_schedule, active, archived_at, created_at`;

export async function createActivity(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    name: string;
    category: string;
    description?: string;
    meeting_schedule?: string;
  },
): Promise<Activity> {
  try {
    const res = await tx.query<Activity>(
      `INSERT INTO activities (tenant_id, name, category, description, meeting_schedule, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING ${COLS}`,
      [
        input.tenantId,
        input.name.trim(),
        input.category,
        input.description ?? "",
        input.meeting_schedule ?? "",
        input.actorUserId,
      ],
    );
    await recordSecurityEvent(tx, {
      eventType: "activities.activity.created",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { activityId: res.rows[0]!.id },
    });
    return res.rows[0]!;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") throw conflict("An activity with this name already exists");
    throw err;
  }
}

export async function listActivities(
  tx: Tx,
  tenantId: string,
  limit: number,
  rawCursor?: unknown,
): Promise<{ activities: Activity[]; page: PageInfo }> {
  const page: PageInput = { limit, rawCursor };
  const inner = `SELECT ${COLS} FROM activities WHERE tenant_id = $1 AND archived_at IS NULL`;
  const res = await pageQuery<Activity>(
    tx,
    inner,
    [tenantId],
    { name: "activities_active_name_asc", expr: "q.name", type: "text", dir: "asc" },
    page,
  );
  const activities = res.rows.map(({ page_key: _pk, ...rest }) => rest);
  return { activities, page: res.page };
}

export async function updateActivity(
  tx: Tx,
  input: {
    tenantId: string;
    activityId: string;
    actorUserId: string;
    name?: string;
    category?: string;
    description?: string;
    meeting_schedule?: string;
    active?: boolean;
  },
): Promise<Activity> {
  const assignments: string[] = [];
  const values: unknown[] = [input.tenantId, input.activityId];
  const add = (column: string, value: unknown) => {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  };
  if (input.name !== undefined) add("name", input.name.trim());
  if (input.category !== undefined) add("category", input.category);
  if (input.description !== undefined) add("description", input.description.trim());
  if (input.meeting_schedule !== undefined) add("meeting_schedule", input.meeting_schedule.trim());
  if (input.active !== undefined) add("active", input.active);
  try {
    const res = await tx.query<Activity>(
      `UPDATE activities SET ${assignments.join(", ")} WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL
       RETURNING ${COLS}`,
      values,
    );
    if (!res.rows[0]) throw notFound("Activity not found");
    await recordSecurityEvent(tx, {
      eventType: "activities.activity.updated",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { activityId: input.activityId, fields: assignments.map((x) => x.split(" = ")[0]) },
    });
    return res.rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw conflict("An activity with this name already exists");
    throw err;
  }
}

export async function archiveActivity(
  tx: Tx,
  input: { tenantId: string; activityId: string; actorUserId: string },
): Promise<void> {
  const res = await tx.query(
    `UPDATE activities SET archived_at = now(), active = false
      WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL RETURNING id`,
    [input.tenantId, input.activityId],
  );
  if (!res.rows[0]) throw notFound("Activity not found");
  await recordSecurityEvent(tx, {
    eventType: "activities.activity.archived",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { activityId: input.activityId },
  });
}

export async function addPatron(
  tx: Tx,
  input: { tenantId: string; activityId: string; teacherUserId: string; actorUserId: string },
): Promise<void> {
  const activity = await tx.query(
    `SELECT 1 FROM activities WHERE tenant_id = $1 AND id = $2 AND active = true AND archived_at IS NULL`,
    [input.tenantId, input.activityId],
  );
  if (!activity.rows[0]) throw notFound("Activity not found");

  const membership = await tx.query(
    `SELECT 1 FROM school_memberships WHERE tenant_id = $1 AND user_id = $2 AND archived_at IS NULL AND role IN ('teacher', 'school_admin')`,
    [input.tenantId, input.teacherUserId],
  );
  if (!membership.rows[0]) throw validationError("teacher_user_id must be an active teacher or school admin");
  await tx.query(
    `INSERT INTO activity_patrons (activity_id, tenant_id, teacher_user_id) VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING`,
    [input.activityId, input.tenantId, input.teacherUserId],
  );
  await recordSecurityEvent(tx, {
    eventType: "activities.patron.added",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { activityId: input.activityId, teacherUserId: input.teacherUserId },
  });
}

export async function listPatrons(
  tx: Tx,
  input: { tenantId: string; activityId: string },
): Promise<Array<{ teacher_user_id: string; full_name: string }>> {
  const activity = await tx.query(`SELECT 1 FROM activities WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL`, [
    input.tenantId,
    input.activityId,
  ]);
  if (!activity.rows[0]) throw notFound("Activity not found");
  const res = await tx.query<{ teacher_user_id: string; full_name: string }>(
    `SELECT p.teacher_user_id, u.full_name
       FROM activity_patrons p JOIN users u ON u.id = p.teacher_user_id
      WHERE p.tenant_id = $1 AND p.activity_id = $2
      ORDER BY u.full_name, p.teacher_user_id`,
    [input.tenantId, input.activityId],
  );
  return res.rows;
}

export async function removePatron(
  tx: Tx,
  input: { tenantId: string; activityId: string; teacherUserId: string; actorUserId: string },
): Promise<void> {
  const res = await tx.query(
    `DELETE FROM activity_patrons p USING activities a
      WHERE p.tenant_id = $1 AND p.activity_id = $2 AND p.teacher_user_id = $3
        AND a.tenant_id = p.tenant_id AND a.id = p.activity_id AND a.archived_at IS NULL
      RETURNING p.teacher_user_id`,
    [input.tenantId, input.activityId, input.teacherUserId],
  );
  if (!res.rows[0]) throw notFound("Activity patron not found");
  await recordSecurityEvent(tx, {
    eventType: "activities.patron.removed",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { activityId: input.activityId, teacherUserId: input.teacherUserId },
  });
}

export async function addMember(
  tx: Tx,
  input: { tenantId: string; activityId: string; learnerId: string; role?: string | null; actorUserId: string },
): Promise<void> {
  const activity = await tx.query(`SELECT 1 FROM activities WHERE tenant_id = $1 AND id = $2 AND active = true AND archived_at IS NULL`, [
    input.tenantId,
    input.activityId,
  ]);
  if (!activity.rows[0]) throw notFound("Activity not found");
  const learner = await tx.query(`SELECT 1 FROM learners WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL`, [
    input.tenantId,
    input.learnerId,
  ]);
  if (!learner.rows[0]) throw validationError("learner_id must be an active learner");
  await tx.query(
    `INSERT INTO activity_members (activity_id, tenant_id, learner_id, role, joined_on)
     VALUES ($1,$2,$3,$4, (now() AT TIME ZONE COALESCE((SELECT t.timezone FROM tenants t WHERE t.id = $2), 'Africa/Nairobi'))::date)
     ON CONFLICT DO NOTHING`,
    [input.activityId, input.tenantId, input.learnerId, input.role ?? null],
  );
  await recordSecurityEvent(tx, {
    eventType: "activities.member.added",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { activityId: input.activityId, learnerId: input.learnerId },
  });
}

export async function listMembers(
  tx: Tx,
  input: { tenantId: string; activityId: string; limit?: number; rawCursor?: unknown },
): Promise<{ members: Array<{ learner_id: string; role: string | null; joined_on: string }>; page: PageInfo }> {
  const activity = await tx.query(`SELECT 1 FROM activities WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL`, [
    input.tenantId,
    input.activityId,
  ]);
  if (!activity.rows[0]) throw notFound("Activity not found");

  const page: PageInput = { limit: input.limit ?? 50, rawCursor: input.rawCursor };
  const inner = `SELECT learner_id AS id, learner_id, role, joined_on::text AS joined_on
       FROM activity_members
      WHERE tenant_id = $1 AND activity_id = $2`;
  const res = await pageQuery<{ id: string; learner_id: string; role: string | null; joined_on: string }>(
    tx,
    inner,
    [input.tenantId, input.activityId],
    { name: "activity_members_joined_asc", expr: "q.joined_on", type: "date", dir: "asc" },
    page,
  );
  const members = res.rows.map(({ learner_id, role, joined_on }) => ({ learner_id, role, joined_on }));
  return { members, page: res.page };
}

export async function updateMemberRole(
  tx: Tx,
  input: { tenantId: string; activityId: string; learnerId: string; role: string | null; actorUserId: string },
): Promise<void> {
  const res = await tx.query(
    `UPDATE activity_members m SET role = $4
       FROM activities a
      WHERE m.tenant_id = $1 AND m.activity_id = $2 AND m.learner_id = $3
        AND a.tenant_id = m.tenant_id AND a.id = m.activity_id AND a.archived_at IS NULL
      RETURNING m.learner_id`,
    [input.tenantId, input.activityId, input.learnerId, input.role?.trim() || null],
  );
  if (!res.rows[0]) throw notFound("Activity member not found");
  await recordSecurityEvent(tx, {
    eventType: "activities.member.updated",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { activityId: input.activityId, learnerId: input.learnerId },
  });
}

export async function removeMember(
  tx: Tx,
  input: { tenantId: string; activityId: string; learnerId: string; actorUserId: string },
): Promise<void> {
  const res = await tx.query(
    `DELETE FROM activity_members m USING activities a
      WHERE m.tenant_id = $1 AND m.activity_id = $2 AND m.learner_id = $3
        AND a.tenant_id = m.tenant_id AND a.id = m.activity_id AND a.archived_at IS NULL
      RETURNING m.learner_id`,
    [input.tenantId, input.activityId, input.learnerId],
  );
  if (!res.rows[0]) throw notFound("Activity member not found");
  await recordSecurityEvent(tx, {
    eventType: "activities.member.removed",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { activityId: input.activityId, learnerId: input.learnerId },
  });
}
