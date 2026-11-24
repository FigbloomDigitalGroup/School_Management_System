import type { ActivityCategory, ActivityInput, ActivityRow, LearnerOption, MemberRow } from "../activities";
import { diffIds } from "../activities";
import { NotOnApiError } from "../capabilities";
import { apiClient } from "./client";
import { isApiError } from "./errors";
import { classNameByLearner, fetchLearnersById, tolerantRead } from "./learnerNamesApi";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import { activeTenantId, listLearners, listStaffMembers } from "./peopleApi";
import { settlePool } from "./pool";
import type { components } from "./schema";

/**
 * Sports and co-curricular activities on apps/api: the API side of activities.ts.
 *
 * Differences from Supabase, handled here rather than in the screens:
 *  - `GET /activities` lists open activities only and carries no patrons; there is no way to read or remove a patron
 *    (`listPatrons: false`). Patrons can be added: `POST /activities/{id}/patrons` takes the sign-in (user id) of an active
 *    teacher or school administrator, so the picker lists the staff records that have a sign-in.
 *  - There is no PATCH or DELETE on an activity (`editActivity`, `deleteActivity` false) and none on a member
 *    (`editMemberRole`, `removeMember` false, B11). A member's role can only be given when the learner is added, which the
 *    screen does not ask for.
 *  - There are no event endpoints (`events: false`), so the fixtures, results and "tell families" parts are hidden and the
 *    shared functions behind them throw `NotOnApiError`.
 *  - `GET /activities/{id}/members` gives `learner_id`, `role` and `joined_on` with no name. Names come from the learner list
 *    (and a read each for archived ones), classes from the class memberships. Both need the People and Academics areas; for
 *    someone without them the member shows as "Learner (name not shown)".
 *  - Everything here is for school administrators and holders of the Activities area. A plain teacher cannot read activities,
 *    and the API has no "activities I am patron of" read, so the teacher page shows every activity to an Activities-area holder.
 */

type ApiActivity = components["schemas"]["Activity"];
type ApiActivityMember = components["schemas"]["ActivityMember"];

export const ACTIVITY_WRITE_CONCURRENCY = 4;

/** What a member is called when the person may not read learners. */
export const HIDDEN_MEMBER_NAME = "Learner (name not shown)";

export function activityFromApi(a: ApiActivity): ActivityRow {
  return {
    id: a.id,
    tenantId: a.tenant_id,
    name: a.name,
    category: a.category as ActivityCategory,
    description: a.description,
    meetingSchedule: a.meeting_schedule,
    active: a.active,
    patrons: [],
  };
}

function listApiActivities(tenantId: string): Promise<ApiActivity[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/activities", {
      path: { tenantId },
      query: { limit: API_PAGE_LIMIT, cursor },
      tenantId,
    });
    return { items: r.activities, page: r.page };
  });
}

function listApiActivityMembers(tenantId: string, activityId: string): Promise<ApiActivityMember[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/activities/{activityId}/members", {
      path: { tenantId, activityId },
      query: { limit: API_PAGE_LIMIT, cursor },
      tenantId,
    });
    return { items: r.members, page: r.page };
  });
}

/** What a few writes say when some of them failed: how many went through, and the first reason. */
function partialFailure(results: { ok: boolean; error?: unknown }[], what: string, fallback: string): Error | null {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return null;
  const done = results.length - failed.length;
  const first = failed[0]!.error;
  const why = first instanceof Error && first.message ? first.message : fallback;
  return new Error(done > 0 ? `Added ${done} of ${results.length} ${what} before one failed: ${why}` : why);
}

export async function apiFetchActivities(tenantId: string): Promise<ActivityRow[]> {
  const rows = await listApiActivities(tenantId);
  return rows.map(activityFromApi).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** One count for each activity: there is no count endpoint, so each activity's members are read (four at a time). */
export async function apiFetchMemberCounts(tenantId: string): Promise<Map<string, number>> {
  const activities = await listApiActivities(tenantId);
  const out = new Map<string, number>();
  const results = await settlePool(activities, ACTIVITY_WRITE_CONCURRENCY, async (a) => ({
    id: a.id,
    count: (await listApiActivityMembers(tenantId, a.id)).length,
  }));
  for (const r of results) {
    if (!r.ok) throw r.error;
    out.set(r.value.id, r.value.count);
  }
  return out;
}

export async function apiFetchActivityMembers(activityId: string): Promise<MemberRow[]> {
  const tenantId = activeTenantId();
  const [members, learners, classes] = await Promise.all([
    listApiActivityMembers(tenantId, activityId),
    tolerantRead(() => listLearners(tenantId, true), null),
    tolerantRead(() => classNameByLearner(tenantId), new Map<string, string>()),
  ]);
  const names = new Map<string, string>((learners ?? []).map((l) => [l.id, l.full_name]));
  if (learners) {
    // A member who has since been archived is not in the active list: read them one by one.
    const missing = members.map((m) => m.learner_id).filter((id) => !names.has(id));
    for (const [id, l] of await fetchLearnersById(tenantId, missing)) names.set(id, l.full_name);
  }
  return members
    .map((m) => ({
      studentId: m.learner_id,
      name: names.get(m.learner_id) ?? HIDDEN_MEMBER_NAME,
      className: classes.get(m.learner_id) ?? "",
      role: m.role ?? null,
      joinedOn: m.joined_on,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.studentId.localeCompare(b.studentId));
}

export async function apiFetchActiveLearners(tenantId: string): Promise<LearnerOption[]> {
  const [learners, classes] = await Promise.all([
    listLearners(tenantId, true),
    tolerantRead(() => classNameByLearner(tenantId), new Map<string, string>()),
  ]);
  return learners
    .map((l) => ({ id: l.id, name: l.full_name, className: classes.get(l.id) ?? "", admissionNo: l.admission_no }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** Teachers for the patron picker: staff records that have a sign-in, by that sign-in's id (what the API wants). */
export async function apiFetchTeachers(tenantId: string): Promise<{ id: string; name: string }[]> {
  const staff = await tolerantRead(() => listStaffMembers(tenantId, true), []);
  return staff
    .filter((s): s is typeof s & { userId: string } => Boolean(s.userId) && s.classification === "teacher")
    .map((s) => ({ id: s.userId, name: s.full_name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function apiCreateActivity(tenantId: string, input: ActivityInput): Promise<string> {
  try {
    const res = await apiClient().post("/v1/tenants/{tenantId}/activities", {
      path: { tenantId },
      body: {
        name: input.name,
        category: input.category,
        description: input.description,
        meeting_schedule: input.meetingSchedule,
      },
      tenantId,
    });
    return res.activity.id;
  } catch (err) {
    if (isApiError(err) && err.code === "conflict") throw new Error("There's already an activity with that name.");
    throw err;
  }
}

/** Adds patrons. The API cannot take one away, so a change that removes a patron is refused before anything is sent. */
export async function apiSetActivityPatrons(tenantId: string, activityId: string, current: string[], wanted: string[]): Promise<void> {
  const { add, remove } = diffIds(current, wanted);
  if (remove.length > 0) throw new NotOnApiError("Removing an activity patron");
  if (add.length === 0) return;
  const results = await settlePool(add, ACTIVITY_WRITE_CONCURRENCY, async (teacherUserId) => {
    await apiClient().post("/v1/tenants/{tenantId}/activities/{activityId}/patrons", {
      path: { tenantId, activityId },
      body: { teacher_user_id: teacherUserId },
      tenantId,
    });
  });
  const failure = partialFailure(results, "patrons", "Could not add every patron.");
  if (failure) throw failure;
}

export async function apiAddActivityMembers(tenantId: string, activityId: string, studentIds: string[]): Promise<void> {
  if (studentIds.length === 0) return;
  const results = await settlePool(studentIds, ACTIVITY_WRITE_CONCURRENCY, async (learnerId) => {
    await apiClient().post("/v1/tenants/{tenantId}/activities/{activityId}/members", {
      path: { tenantId, activityId },
      body: { learner_id: learnerId },
      tenantId,
    });
  });
  const failure = partialFailure(results, "members", "Could not add every member.");
  if (failure) throw failure;
}
