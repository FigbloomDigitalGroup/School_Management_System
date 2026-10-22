import { supabase } from "./supabase";
import type { TimetableSlot, Weekday } from "./types";

export const WEEKDAYS: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri"];

/** [start_time, label, room, teacherName] — the shape every timetable-consuming screen already renders. */
export type TimetableRow = [string, string, string, string | null];

export async function fetchClassTimetableSlots(classId: string): Promise<TimetableSlot[]> {
  const { data, error } = await supabase()
    .from("timetable_slots").select("*").eq("class_id", classId)
    .order("day").order("start_time").returns<TimetableSlot[]>();
  if (error) throw error;
  return data ?? [];
}

/**
 * The view shape (day -> ordered rows) that StudentApp/Today/Timetable screens
 * read. Teacher name is resolved via the teacher_names() RPC rather than a
 * plain profiles(full_name) embed: a student can read teaching_assignments
 * (open tenant-wide), but profile_read_self only lets staff read another
 * profile row directly, so the embed silently comes back null for a student
 * caller. teacher_names() is a narrow security-definer lookup (id + name
 * only, teachers only, same tenant only) that a non-staff caller can use.
 */
export async function fetchClassTimetable(classId: string): Promise<Record<Weekday, TimetableRow[]>> {
  const [slots, { data: assignmentRows, error }] = await Promise.all([
    fetchClassTimetableSlots(classId),
    supabase().from("teaching_assignments").select("subject_id, teacher_id").eq("class_id", classId)
      .returns<{ subject_id: string; teacher_id: string }[]>(),
  ]);
  if (error) throw new Error(error.message);

  const teacherIds = Array.from(new Set((assignmentRows ?? []).map((a) => a.teacher_id)));
  const { data: teacherRows, error: nameErr } = teacherIds.length
    ? await supabase().rpc("teacher_names", { teacher_ids: teacherIds })
    : { data: [], error: null };
  if (nameErr) throw new Error(nameErr.message);
  const nameById = new Map((teacherRows as { id: string; full_name: string }[] ?? []).map((t) => [t.id, t.full_name]));

  const teacherBySubject = new Map((assignmentRows ?? []).map((a) => [a.subject_id, nameById.get(a.teacher_id) ?? null]));

  const byDay: Record<Weekday, TimetableRow[]> = { Mon: [], Tue: [], Wed: [], Thu: [], Fri: [] };
  for (const s of slots) {
    byDay[s.day].push([s.start_time, s.label, s.room ?? "", s.subject_id ? teacherBySubject.get(s.subject_id) ?? null : null]);
  }
  return byDay;
}

/** Today's timetable key, or null on a weekend when there's no school day to show. */
export function todayWeekday(now: Date = new Date()): Weekday | null {
  const short = now.toLocaleDateString("en-US", { weekday: "short" });
  return (WEEKDAYS as string[]).includes(short) ? (short as Weekday) : null;
}

/** Index of the last period whose start_time has passed — -1 before the first period starts. */
export function currentPeriodIndex(rows: TimetableRow[], now: Date = new Date()): number {
  const hhmmss = now.toTimeString().slice(0, 8);
  let idx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]![0] <= hhmmss) idx = i;
    else break;
  }
  return idx;
}

/** Replaces every slot for this class — simplest correct model for a short weekly grid (same pattern as fleet's replaceRouteStops). */
export async function saveClassTimetable(
  tenantId: string,
  classId: string,
  slots: { day: Weekday; start_time: string; label: string; room: string | null; subject_id?: string | null }[],
): Promise<void> {
  const { error: delErr } = await supabase().from("timetable_slots").delete().eq("class_id", classId);
  if (delErr) throw delErr;
  const rows = slots.filter((s) => s.label.trim().length > 0);
  if (!rows.length) return;
  const { error } = await supabase().from("timetable_slots").insert(
    rows.map((s) => ({
      tenant_id: tenantId, class_id: classId, day: s.day, start_time: s.start_time,
      label: s.label.trim(), room: s.room?.trim() || null, subject_id: s.subject_id ?? null,
    })),
  );
  if (error) throw error;
}
