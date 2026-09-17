import { supabase, WEEKDAYS, type Weekday } from "@figbloom/shared";

/**
 * Phase 3 of the timetable/HR feature: cross-references approved leave
 * against the timetable. Only subject-linked periods can be checked (that's
 * the only way we know who's assigned to a period at all — see Phase 1), so
 * an unlinked period (Games, Library, Class meeting) is never flagged, same
 * as it was never attributed to a teacher in the first place.
 *
 * The timetable itself has no concrete dates (it's a recurring weekly
 * template — "Tue" means every Tuesday, not one specific Tuesday), so
 * cross-referencing leave against it only makes sense against THIS week's
 * actual dates. A leave request for Friday, checked on a Tuesday, needs
 * Friday's real calendar date to compare against — not just "today".
 */

export type WeekDates = Record<Weekday, string>;

/** This week's Mon-Fri as YYYY-MM-DD, anchored on today (or the date passed in). */
export function currentWeekDates(now: Date = new Date()): WeekDates {
  const dow = now.getDay(); // 0=Sun..6=Sat
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);

  const out = {} as WeekDates;
  WEEKDAYS.forEach((day, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    out[day] = d.toISOString().slice(0, 10);
  });
  return out;
}

export async function fetchTeachersOnLeaveForDate(date: string): Promise<Set<string>> {
  const { data, error } = await supabase()
    .from("leave_requests").select("teacher_id").eq("status", "approved")
    .lte("starts_on", date).gte("ends_on", date)
    .returns<{ teacher_id: string }[]>();
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((r) => r.teacher_id));
}

export interface CoverageAssignment {
  coveringTeacherId: string | null; // null = deliberately left as a free period
  coveringTeacherName: string | null;
  assignedAt: string;
}

export interface CoverageItem {
  date: string;
  weekday: Weekday;
  classId: string;
  className: string;
  time: string;
  subjectId: string;
  subjectName: string;
  absentTeacherId: string;
  absentTeacherName: string;
  substitutes: { id: string; name: string }[];
  assignment: CoverageAssignment | null;
}

/** Every period on one weekday/date whose assigned teacher is on approved
 *  leave that day, with substitute candidates drawn from who else
 *  specializes in that subject (teacher_subjects) — never the absent
 *  teacher, never someone also out that day. */
export async function fetchCoverageForDate(weekday: Weekday, date: string): Promise<CoverageItem[]> {
  const onLeave = await fetchTeachersOnLeaveForDate(date);
  if (onLeave.size === 0) return [];

  const sb = supabase();
  const { data: slots, error: slotsErr } = await sb
    .from("timetable_slots").select("class_id, start_time, label, subject_id")
    .eq("day", weekday).not("subject_id", "is", null)
    .returns<{ class_id: string; start_time: string; label: string; subject_id: string }[]>();
  if (slotsErr) throw new Error(slotsErr.message);
  if (!slots?.length) return [];

  const classIds = [...new Set(slots.map((s) => s.class_id))];
  const subjectIds = [...new Set(slots.map((s) => s.subject_id))];

  const [{ data: classes, error: e1 }, { data: subjects, error: e2 }, { data: profiles, error: e3 },
    { data: assignments, error: e4 }, { data: specializations, error: e5 }, { data: decided, error: e6 }] = await Promise.all([
    sb.from("classes").select("id, name").in("id", classIds).returns<{ id: string; name: string }[]>(),
    sb.from("subjects").select("id, name").in("id", subjectIds).returns<{ id: string; name: string }[]>(),
    sb.from("profiles").select("id, full_name").eq("role", "teacher").returns<{ id: string; full_name: string }[]>(),
    sb.from("teaching_assignments").select("class_id, subject_id, teacher_id").in("class_id", classIds).in("subject_id", subjectIds)
      .returns<{ class_id: string; subject_id: string; teacher_id: string }[]>(),
    sb.from("teacher_subjects").select("teacher_id, subject_id").in("subject_id", subjectIds)
      .returns<{ teacher_id: string; subject_id: string }[]>(),
    sb.from("coverage_assignments").select("class_id, start_time, covering_teacher_id, assigned_at").eq("date", date).in("class_id", classIds)
      .returns<{ class_id: string; start_time: string; covering_teacher_id: string | null; assigned_at: string }[]>(),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);
  if (e3) throw new Error(e3.message);
  if (e4) throw new Error(e4.message);
  if (e5) throw new Error(e5.message);
  if (e6) throw new Error(e6.message);

  const classById = new Map((classes ?? []).map((c) => [c.id, c.name]));
  const subjectById = new Map((subjects ?? []).map((s) => [s.id, s.name]));
  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name]));
  const teacherByClassSubject = new Map((assignments ?? []).map((a) => [`${a.class_id}|${a.subject_id}`, a.teacher_id]));
  const substitutesBySubject = new Map<string, string[]>();
  for (const s of specializations ?? []) {
    const list = substitutesBySubject.get(s.subject_id) ?? [];
    list.push(s.teacher_id);
    substitutesBySubject.set(s.subject_id, list);
  }
  const decidedBySlot = new Map((decided ?? []).map((d) => [`${d.class_id}|${d.start_time}`, d]));

  const items: CoverageItem[] = [];
  for (const slot of slots) {
    const teacherId = teacherByClassSubject.get(`${slot.class_id}|${slot.subject_id}`);
    if (!teacherId || !onLeave.has(teacherId)) continue;
    const substitutes = (substitutesBySubject.get(slot.subject_id) ?? [])
      .filter((id) => id !== teacherId && !onLeave.has(id))
      .map((id) => ({ id, name: nameById.get(id) ?? "Unknown teacher" }));
    const decision = decidedBySlot.get(`${slot.class_id}|${slot.start_time}`);
    items.push({
      date, weekday,
      classId: slot.class_id,
      className: classById.get(slot.class_id) ?? "Unknown class",
      time: slot.start_time,
      subjectId: slot.subject_id,
      subjectName: subjectById.get(slot.subject_id) ?? slot.label,
      absentTeacherId: teacherId,
      absentTeacherName: nameById.get(teacherId) ?? "Unknown teacher",
      substitutes,
      assignment: decision ? {
        coveringTeacherId: decision.covering_teacher_id,
        coveringTeacherName: decision.covering_teacher_id ? (nameById.get(decision.covering_teacher_id) ?? "Unknown teacher") : null,
        assignedAt: decision.assigned_at,
      } : null,
    });
  }
  return items;
}

/** Records the principal's decision for one coverage gap — a specific
 *  substitute, or that the period just runs free (covering=null). Notifies
 *  the substitute in-app; a free period has nobody to notify. */
export async function assignCoverage(input: {
  tenantId: string; assignedBy: string;
  item: Pick<CoverageItem, "date" | "classId" | "className" | "subjectId" | "subjectName" | "time" | "absentTeacherId">;
  coveringTeacherId: string | null;
}): Promise<void> {
  const { error } = await supabase().from("coverage_assignments").upsert({
    tenant_id: input.tenantId,
    date: input.item.date,
    class_id: input.item.classId,
    subject_id: input.item.subjectId,
    start_time: input.item.time,
    absent_teacher_id: input.item.absentTeacherId,
    covering_teacher_id: input.coveringTeacherId,
    assigned_by: input.assignedBy,
    assigned_at: new Date().toISOString(),
  }, { onConflict: "date,class_id,start_time" });
  if (error) throw new Error(error.message);

  if (input.coveringTeacherId) {
    const { error: notifyErr } = await supabase().from("announcements").insert({
      tenant_id: input.tenantId,
      author_id: input.assignedBy,
      subject: `Covering ${input.item.subjectName} — ${input.item.className}`,
      body: `You're covering ${input.item.subjectName} for ${input.item.className} at ${input.item.time} on ${input.item.date}, since the usual teacher is on approved leave.`,
      audience: { kind: "user", user_id: input.coveringTeacherId },
      channels: ["in_app"],
      published_at: new Date().toISOString(),
    });
    if (notifyErr) throw new Error(notifyErr.message);
  }
}

/** fetchCoverageForDate for every day of the current week, merged and
 *  ordered by date then time — what the Dashboard's "Needs cover" card and
 *  the Timetable's per-day flag are both built from, so leave requested for
 *  a day later this week shows up now, not only once that day arrives. */
export async function fetchCoverageThisWeek(): Promise<CoverageItem[]> {
  const week = currentWeekDates();
  const perDay = await Promise.all(WEEKDAYS.map((day) => fetchCoverageForDate(day, week[day])));
  return perDay.flat().sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
}
