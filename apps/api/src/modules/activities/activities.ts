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
  created_at: string;
}

const COLS = `id, tenant_id, name, category, description, meeting_schedule, active, created_at`;

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
  const inner = `SELECT ${COLS} FROM activities WHERE tenant_id = $1 AND active = true`;
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

export async function addPatron(
  tx: Tx,
  input: { tenantId: string; activityId: string; teacherUserId: string; actorUserId: string },
): Promise<void> {
  const activity = await tx.query(
    `SELECT 1 FROM activities WHERE tenant_id = $1 AND id = $2 AND active = true`,
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

export async function addMember(
  tx: Tx,
  input: { tenantId: string; activityId: string; learnerId: string; role?: string | null; actorUserId: string },
): Promise<void> {
  const activity = await tx.query(`SELECT 1 FROM activities WHERE tenant_id = $1 AND id = $2 AND active = true`, [
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
  const activity = await tx.query(`SELECT 1 FROM activities WHERE tenant_id = $1 AND id = $2`, [
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
