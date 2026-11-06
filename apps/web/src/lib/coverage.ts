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

export async function fetchTeachersOnLeaveForDate(tenantId: string, date: string): Promise<Set<string>> {
  const { data, error } = await supabase()
    .from("leave_requests").select("teacher_id").eq("tenant_id", tenantId).eq("status", "approved")
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
 *  teacher, never someone also out that day, never someone teaching or
 *  already covering another class at that time. */
export async function fetchCoverageForDate(tenantId: string, weekday: Weekday, date: string): Promise<CoverageItem[]> {
  const onLeave = await fetchTeachersOnLeaveForDate(tenantId, date);
  if (onLeave.size === 0) return [];

  const sb = supabase();
  const { data: slots, error: slotsErr } = await sb
    .from("timetable_slots").select("class_id, start_time, label, subject_id")
    .eq("tenant_id", tenantId).eq("day", weekday).not("subject_id", "is", null)
    .returns<{ class_id: string; start_time: string; label: string; subject_id: string }[]>();
  if (slotsErr) throw new Error(slotsErr.message);
  if (!slots?.length) return [];

  const classIds = [...new Set(slots.map((s) => s.class_id))];
  const subjectIds = [...new Set(slots.map((s) => s.subject_id))];

  const [{ data: classes, error: e1 }, { data: subjects, error: e2 }, { data: profiles, error: e3 },
    { data: assignments, error: e4 }, { data: specializations, error: e5 }, { data: decided, error: e6 }] = await Promise.all([
    sb.from("classes").select("id, name").eq("tenant_id", tenantId).in("id", classIds).returns<{ id: string; name: string }[]>(),
    sb.from("subjects").select("id, name").eq("tenant_id", tenantId).in("id", subjectIds).returns<{ id: string; name: string }[]>(),
    sb.from("profiles").select("id, full_name").eq("tenant_id", tenantId).eq("role", "teacher").returns<{ id: string; full_name: string }[]>(),
    sb.from("teaching_assignments").select("class_id, subject_id, teacher_id").eq("tenant_id", tenantId).in("class_id", classIds).in("subject_id", subjectIds)
      .returns<{ class_id: string; subject_id: string; teacher_id: string }[]>(),
    sb.from("teacher_subjects").select("teacher_id, subject_id").eq("tenant_id", tenantId).in("subject_id", subjectIds)
      .returns<{ teacher_id: string; subject_id: string }[]>(),
    sb.from("coverage_assignments").select("class_id, start_time, covering_teacher_id, assigned_at").eq("tenant_id", tenantId).eq("date", date).in("class_id", classIds)
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

  // Who is teaching which classes at each time, from this weekday's timetable: a teacher teaching another class then, or already asked to
  // cover another class then, cannot be offered this one (FIG-1434).
  const teachingAt = new Map<string, Map<string, Set<string>>>();
  for (const s of slots) {
    const t = teacherByClassSubject.get(`${s.class_id}|${s.subject_id}`);
    if (!t) continue;
    const at = teachingAt.get(s.start_time) ?? new Map<string, Set<string>>();
    at.set(t, (at.get(t) ?? new Set<string>()).add(s.class_id));
    teachingAt.set(s.start_time, at);
  }
  const isBusy = (teacher: string, time: string, classId: string) =>
    [...(teachingAt.get(time)?.get(teacher) ?? [])].some((c) => c !== classId)
    || (decided ?? []).some((d) => d.start_time === time && d.class_id !== classId && d.covering_teacher_id === teacher);

  const items: CoverageItem[] = [];
  for (const slot of slots) {
    const teacherId = teacherByClassSubject.get(`${slot.class_id}|${slot.subject_id}`);
    if (!teacherId || !onLeave.has(teacherId)) continue;
    const substitutes = (substitutesBySubject.get(slot.subject_id) ?? [])
      .filter((id) => id !== teacherId && !onLeave.has(id) && !isBusy(id, slot.start_time, slot.class_id))
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

/** True if this teacher is teaching a different class at that weekday and time (a subject-linked period of the timetable). */
async function isTeachingElsewhere(tenantId: string, date: string, time: string, classId: string, teacherId: string): Promise<boolean> {
  const weekday = WEEKDAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7];
  if (!weekday) return false; // a weekend has no timetable
  const sb = supabase();
  const { data: slots, error } = await sb
    .from("timetable_slots").select("class_id, subject_id")
    .eq("tenant_id", tenantId).eq("day", weekday).eq("start_time", time).neq("class_id", classId).not("subject_id", "is", null)
    .returns<{ class_id: string; subject_id: string }[]>();
  if (error) throw new Error(error.message);
  if (!slots?.length) return false;
  const { data: mine, error: taughtErr } = await sb
    .from("teaching_assignments").select("class_id, subject_id")
    .eq("tenant_id", tenantId).eq("teacher_id", teacherId).in("class_id", slots.map((s) => s.class_id))
    .returns<{ class_id: string; subject_id: string }[]>();
  if (taughtErr) throw new Error(taughtErr.message);
  return slots.some((s) => (mine ?? []).some((a) => a.class_id === s.class_id && a.subject_id === s.subject_id));
}

/** Records the principal's decision for one coverage gap — a specific
 *  substitute, or that the period just runs free (covering=null). Notifies
 *  the new substitute in-app, and tells the one who had it before when it is
 *  taken away or given to someone else (FIG-1434). A teacher who is teaching
 *  another class at that time is refused here as well as left out of the list. */
export async function assignCoverage(input: {
  tenantId: string; assignedBy: string;
  item: Pick<CoverageItem, "date" | "classId" | "className" | "subjectId" | "subjectName" | "time" | "absentTeacherId">;
  coveringTeacherId: string | null;
}): Promise<void> {
  const sb = supabase();
  const { data: before, error: beforeErr } = await sb
    .from("coverage_assignments").select("covering_teacher_id")
    .eq("tenant_id", input.tenantId).eq("date", input.item.date).eq("class_id", input.item.classId).eq("start_time", input.item.time)
    .maybeSingle<{ covering_teacher_id: string | null }>();
  if (beforeErr) throw new Error(beforeErr.message);
  const previousId = before?.covering_teacher_id ?? null;

  if (input.coveringTeacherId && input.coveringTeacherId !== previousId
      && await isTeachingElsewhere(input.tenantId, input.item.date, input.item.time, input.item.classId, input.coveringTeacherId)) {
    throw new Error("That teacher is teaching another class at that time. Choose someone who is free.");
  }

  const { error } = await sb.from("coverage_assignments").upsert({
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
    const { error: notifyErr } = await sb.from("announcements").insert({
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

  if (previousId && previousId !== input.coveringTeacherId) {
    const { error: offErr } = await sb.from("announcements").insert({
      tenant_id: input.tenantId,
      author_id: input.assignedBy,
      subject: `Cover cancelled — ${input.item.subjectName}, ${input.item.className}`,
      body: `You are no longer covering ${input.item.subjectName} for ${input.item.className} at ${input.item.time} on ${input.item.date}. ${input.coveringTeacherId ? "It has been given to someone else." : "The period will run as a free period."}`,
      audience: { kind: "user", user_id: previousId },
      channels: ["in_app"],
      published_at: new Date().toISOString(),
    });
    if (offErr) throw new Error(offErr.message);
  }
}

/** fetchCoverageForDate for every day of the current week, merged and
 *  ordered by date then time — what the Dashboard's "Needs cover" card and
 *  the Timetable's per-day flag are both built from, so leave requested for
 *  a day later this week shows up now, not only once that day arrives. */
export async function fetchCoverageThisWeek(tenantId: string): Promise<CoverageItem[]> {
  const week = currentWeekDates();
  const perDay = await Promise.all(WEEKDAYS.map((day) => fetchCoverageForDate(tenantId, day, week[day])));
  return perDay.flat().sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
}
