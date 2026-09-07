import { supabase } from "./supabase";
import type { TimetableSlot, Weekday } from "./types";

export const WEEKDAYS: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri"];

/** [start_time, label, room] — the shape every timetable-consuming screen already renders. */
export type TimetableRow = [string, string, string];

export async function fetchClassTimetableSlots(classId: string): Promise<TimetableSlot[]> {
  const { data, error } = await supabase()
    .from("timetable_slots").select("*").eq("class_id", classId)
    .order("day").order("start_time").returns<TimetableSlot[]>();
  if (error) throw error;
  return data ?? [];
}

/** The view shape (day -> ordered rows) that StudentApp/Today/Timetable screens read. */
export async function fetchClassTimetable(classId: string): Promise<Record<Weekday, TimetableRow[]>> {
  const slots = await fetchClassTimetableSlots(classId);
  const byDay: Record<Weekday, TimetableRow[]> = { Mon: [], Tue: [], Wed: [], Thu: [], Fri: [] };
  for (const s of slots) byDay[s.day].push([s.start_time, s.label, s.room ?? ""]);
  return byDay;
}

/** Replaces every slot for this class — simplest correct model for a short weekly grid (same pattern as fleet's replaceRouteStops). */
export async function saveClassTimetable(
  tenantId: string,
  classId: string,
  slots: { day: Weekday; start_time: string; label: string; room: string | null }[],
): Promise<void> {
  const { error: delErr } = await supabase().from("timetable_slots").delete().eq("class_id", classId);
  if (delErr) throw delErr;
  const rows = slots.filter((s) => s.label.trim().length > 0);
  if (!rows.length) return;
  const { error } = await supabase().from("timetable_slots").insert(
    rows.map((s) => ({
      tenant_id: tenantId, class_id: classId, day: s.day, start_time: s.start_time,
      label: s.label.trim(), room: s.room?.trim() || null,
    })),
  );
  if (error) throw error;
}
