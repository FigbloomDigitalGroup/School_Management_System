import { supabase, today, todayWeekday } from "@figbloom/shared";

/**
 * Phase 3 of the timetable/HR feature: cross-references today's approved
 * leave against today's timetable. Only subject-linked periods can be
 * checked (that's the only way we know who's assigned to a period at all —
 * see Phase 1), so an unlinked period (Games, Library, Class meeting) is
 * never flagged, same as it was never attributed to a teacher in the first place.
 */

export async function fetchTeachersOnLeaveToday(): Promise<Set<string>> {
  const { data, error } = await supabase()
    .from("leave_requests").select("teacher_id").eq("status", "approved")
    .lte("starts_on", today()).gte("ends_on", today())
    .returns<{ teacher_id: string }[]>();
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((r) => r.teacher_id));
}

export interface CoverageItem {
  classId: string;
  className: string;
  time: string;
  subjectName: string;
  absentTeacherId: string;
  absentTeacherName: string;
  substitutes: { id: string; name: string }[];
}

/** Every period today whose assigned teacher is on approved leave, with
 *  substitute candidates drawn from who else specializes in that subject
 *  (teacher_subjects) — never the absent teacher, never someone also out today. */
export async function fetchCoverageToday(): Promise<CoverageItem[]> {
  const onLeave = await fetchTeachersOnLeaveToday();
  if (onLeave.size === 0) return [];

  const weekday = todayWeekday();
  if (!weekday) return []; // weekend — nothing scheduled

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
    { data: assignments, error: e4 }, { data: specializations, error: e5 }] = await Promise.all([
    sb.from("classes").select("id, name").in("id", classIds).returns<{ id: string; name: string }[]>(),
    sb.from("subjects").select("id, name").in("id", subjectIds).returns<{ id: string; name: string }[]>(),
    sb.from("profiles").select("id, full_name").eq("role", "teacher").returns<{ id: string; full_name: string }[]>(),
    sb.from("teaching_assignments").select("class_id, subject_id, teacher_id").in("class_id", classIds).in("subject_id", subjectIds)
      .returns<{ class_id: string; subject_id: string; teacher_id: string }[]>(),
    sb.from("teacher_subjects").select("teacher_id, subject_id").in("subject_id", subjectIds)
      .returns<{ teacher_id: string; subject_id: string }[]>(),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);
  if (e3) throw new Error(e3.message);
  if (e4) throw new Error(e4.message);
  if (e5) throw new Error(e5.message);

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

  const items: CoverageItem[] = [];
  for (const slot of slots) {
    const teacherId = teacherByClassSubject.get(`${slot.class_id}|${slot.subject_id}`);
    if (!teacherId || !onLeave.has(teacherId)) continue;
    const substitutes = (substitutesBySubject.get(slot.subject_id) ?? [])
      .filter((id) => id !== teacherId && !onLeave.has(id))
      .map((id) => ({ id, name: nameById.get(id) ?? "Unknown teacher" }));
    items.push({
      classId: slot.class_id,
      className: classById.get(slot.class_id) ?? "Unknown class",
      time: slot.start_time,
      subjectName: subjectById.get(slot.subject_id) ?? slot.label,
      absentTeacherId: teacherId,
      absentTeacherName: nameById.get(teacherId) ?? "Unknown teacher",
      substitutes,
    });
  }
  items.sort((a, b) => a.time.localeCompare(b.time) || a.className.localeCompare(b.className));
  return items;
}
