import { NO_FEES, type ClassAttendanceDetail, type ClassAttendanceRow, type FeeTotals, type OverviewBasics, type OverviewClass, type RegisterDays } from "../adminOverview";
import type { PmMissingRow } from "../attendanceSession";
import { signOutList, type EarlySignOut, type EarlySignOutCollector } from "../earlySignOut";
import {
  apiFetchAttendanceSettings,
  apiFetchClassRoster,
  apiFetchCollectorDetails,
  apiFetchEarlySignOutsForStudents,
  apiFetchSessionEntries,
} from "./attendanceApi";
import { apiClient } from "./client";
import { isApiError } from "./errors";
import { apiFetchTenantCurrentTerm, listClassesOrEmpty, listInvoicesForTerm, listLearnersOrEmpty, listMembershipsOrEmpty } from "./feesApi";
import { listLearners, listMemberships, listStaffMembers } from "./peopleApi";
import type { components } from "./schema";

/**
 * The admin home on apps/api (`AdminDashboard` and `AreasHome`): the API side of `adminOverview.ts` and
 * `fetchPmMissingLearners`.
 *
 * Differences from Supabase, handled here rather than in the screens:
 *  - Fee totals are aggregated client-side from live term invoices (`listInvoicesForTerm`) matching the
 *    `term_fee_totals` SQL buckets.
 *  - A class records `class_teacher_staff_id` (a staff directory record id). `remindClassTeacher` and
 *    `fetchClassAttendanceDetail` resolve that staff record to its linked `userId` for announcements and
 *    the `classTeacherId === profile.id` early-sign-out check.
 *  - `fetchRegisterDays` queries `attendance-registers` with `limit=1` (API orders newest date first) and
 *    keeps an afternoon read failure from hiding the morning figures.
 *  - `fetchPmMissingLearners` degrades cleanly when `/learners` returns 403 for an attendance-only holder
 *    by returning placeholder rows rather than hiding learners who left without signing out.
 */

type ApiInvoice = components["schemas"]["FinanceInvoice"];

/** Aggregates term fee totals matching Supabase's `term_fee_totals()` buckets. */
export function feeTotalsFromInvoices(invoices: readonly Pick<ApiInvoice, "total_minor" | "paid_minor">[]): FeeTotals {
  let billed = 0;
  let paid = 0;
  let nothingPaid = 0;
  let partPaid = 0;
  let fullPaid = 0;
  let owing = 0;

  for (const inv of invoices) {
    billed += inv.total_minor;
    paid += inv.paid_minor;
    if (inv.paid_minor === 0) nothingPaid += 1;
    if (inv.paid_minor > 0 && inv.paid_minor < inv.total_minor) partPaid += 1;
    if (inv.paid_minor >= inv.total_minor && inv.total_minor > 0) fullPaid += 1;
    if (inv.paid_minor < inv.total_minor) owing += 1;
  }

  return {
    billed,
    paid,
    invoices: invoices.length,
    nothing_paid: nothingPaid,
    part_paid: partPaid,
    full_paid: fullPaid,
    owing,
  };
}

/** Current term, classes, active learners, teaching/admin staff count, and term fee totals on the API. */
export async function apiFetchOverviewBasics(tenantId: string): Promise<OverviewBasics> {
  const term = await apiFetchTenantCurrentTerm(tenantId).catch(() => null);

  const [classRows, learners, memberships, staff, fees] = await Promise.all([
    listClassesOrEmpty(tenantId).catch(() => []),
    listLearners(tenantId, true).catch(() => []),
    listMemberships(tenantId).catch(() => []),
    listStaffMembers(tenantId, true).catch(() => []),
    term ? listInvoicesForTerm(tenantId, term.id).then(feeTotalsFromInvoices) : Promise.resolve(NO_FEES),
  ]);

  const classes: OverviewClass[] = classRows
    .map((c) => ({ id: c.id, name: c.name, class_teacher_id: c.class_teacher_staff_id ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const classIdSet = new Set(classes.map((c) => c.id));
  const classByLearner = new Map<string, string>();
  for (const m of memberships) {
    if (classIdSet.has(m.class_id)) classByLearner.set(m.learner_id, m.class_id);
  }

  const students = learners.map((l) => ({ id: l.id, class_id: classByLearner.get(l.id) ?? "" }));
  const staffCount = staff.filter((s) => s.classification === "school_admin" || s.classification === "teacher").length;

  return { term, classes, students, staffCount, fees };
}

/** Sends an in-app attendance reminder announcement to a class's teacher. */
export async function apiRemindClassTeacher(tenantId: string, cls: Pick<OverviewClass, "name" | "class_teacher_id">): Promise<void> {
  if (!cls.class_teacher_id) throw new Error(`${cls.name} has no class teacher assigned yet.`);
  const staff = await listStaffMembers(tenantId, true);
  const match = staff.find((s) => s.id === cls.class_teacher_id || s.userId === cls.class_teacher_id);
  if (!match) throw new Error(`Could not find the class teacher for ${cls.name}.`);
  if (!match.userId) throw new Error(`${match.full_name} does not have a sign-in account yet.`);

  const created = await apiClient().post("/v1/tenants/{tenantId}/communications/announcements", {
    path: { tenantId },
    body: {
      subject: `Attendance not yet taken — ${cls.name}`,
      body: `${cls.name} hasn't submitted today's attendance register yet. Please take it as soon as you can.`,
      audience: { kind: "user", user_id: match.userId },
      channels: ["in_app"],
    },
    tenantId,
  });
  await apiClient().post("/v1/tenants/{tenantId}/communications/announcements/{announcementId}/publish", {
    path: { tenantId, announcementId: created.announcement.id },
    tenantId,
  });
}

/** Classes, newest morning and afternoon register dates, and attendance settings on the API. */
export async function apiFetchRegisterDays(tenantId: string): Promise<RegisterDays> {
  const [classRows, latestMorning, latestAfternoon, settings] = await Promise.all([
    listClassesOrEmpty(tenantId),
    apiClient()
      .get("/v1/tenants/{tenantId}/attendance-registers", {
        path: { tenantId },
        query: { session: "morning", limit: 1 },
        tenantId,
      })
      .then((r) => r.registers[0]?.taken_on ?? null),
    apiClient()
      .get("/v1/tenants/{tenantId}/attendance-registers", {
        path: { tenantId },
        query: { session: "afternoon", limit: 1 },
        tenantId,
      })
      .then((r) => r.registers[0]?.taken_on ?? null)
      .catch(() => null),
    apiFetchAttendanceSettings(tenantId),
  ]);

  const classes = classRows
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { classes, latestMorning, latestAfternoon, settings };
}

/** One class's morning/afternoon register marks, resolved class teacher userId, and early sign-outs on the API. */
export async function apiFetchClassAttendanceDetail(classId: string, date: string, tenantId: string): Promise<ClassAttendanceDetail> {
  const [roster, entries, settings, classes, staff] = await Promise.all([
    apiFetchClassRoster(classId, tenantId),
    apiFetchSessionEntries({ tenantId, classId, from: date, to: date }),
    apiFetchAttendanceSettings(tenantId),
    listClassesOrEmpty(tenantId),
    listStaffMembers(tenantId, true).catch((err) => (isApiError(err) && err.code === "forbidden" ? [] : Promise.reject(err))),
  ]);

  const cls = classes.find((c) => c.id === classId);
  const classTeacherId = cls?.class_teacher_staff_id
    ? (staff.find((s) => s.id === cls.class_teacher_staff_id)?.userId ?? null)
    : null;

  const amByStudent = new Map(entries.filter((e) => e.session === "morning").map((e) => [e.student_id, e.mark]));
  const pmEntries = entries.filter((e) => e.session === "afternoon");
  const pmByStudent = new Map(pmEntries.map((e) => [e.student_id, e.mark]));
  const pmTaken = pmEntries.length > 0;
  const showPm = settings.afternoon_enabled || pmTaken;

  const rows: ClassAttendanceRow[] = roster.map((s) => ({
    id: s.id,
    name: s.full_name,
    admissionNo: s.admission_no,
    mark: amByStudent.get(s.id) ?? "present",
    pmMark: showPm && pmTaken ? (pmByStudent.get(s.id) ?? "present") : null,
  }));

  const signOuts = signOutList(
    await apiFetchEarlySignOutsForStudents(rows.map((r) => r.id), date, tenantId).catch(() => [] as EarlySignOut[]),
  );
  const details = await apiFetchCollectorDetails(signOuts.map((s) => s.id), tenantId).catch(
    () => new Map<string, EarlySignOutCollector>(),
  );

  return { rows, showPm, pmTaken, classTeacherId, signOuts, details };
}

/** Learner names, admission numbers, and class names for learners present AM / missing PM on the API. */
export async function apiFetchPmMissingLearners(tenantId: string, ids: string[]): Promise<PmMissingRow[]> {
  if (ids.length === 0) return [];
  const [learners, memberships, classes] = await Promise.all([
    listLearnersOrEmpty(tenantId),
    listMembershipsOrEmpty(tenantId),
    listClassesOrEmpty(tenantId),
  ]);

  const classNameById = new Map(classes.map((c) => [c.id, c.name]));
  const classNameByLearner = new Map<string, string>();
  for (const m of memberships) {
    const className = classNameById.get(m.class_id);
    if (className) classNameByLearner.set(m.learner_id, className);
  }
  const learnerById = new Map(learners.map((l) => [l.id, l]));

  return [...new Set(ids)]
    .map((id) => {
      const learner = learnerById.get(id);
      return {
        id,
        name: learner?.full_name ?? "Learner (restricted)",
        admissionNo: learner?.admission_no ?? "—",
        className: classNameByLearner.get(id) ?? "—",
      };
    })
    .sort((a, b) => a.className.localeCompare(b.className) || a.name.localeCompare(b.name));
}
