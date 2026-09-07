import { supabase, type ClassGroup, type Subject, type Term } from "@figbloom/shared";

/**
 * Shared across every teacher screen that needs "which classes is this
 * teacher looking at" — Gradebook, Attendance's class picker, Classes,
 * Messages — so the assigned-vs-class-teacher union logic lives in one place.
 */

/** Classes this teacher may act on: assigned via teaching_assignments, or class-teacher of. */
export async function fetchTeacherClasses(teacherId: string): Promise<ClassGroup[]> {
  const [{ data: assigned, error: e1 }, { data: owned, error: e2 }] = await Promise.all([
    supabase().from("teaching_assignments").select("class_id").eq("teacher_id", teacherId),
    supabase().from("classes").select("*").eq("class_teacher_id", teacherId),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);

  const assignedIds = Array.from(new Set(((assigned ?? []) as { class_id: string }[]).map((r) => r.class_id)));
  let assignedClasses: ClassGroup[] = [];
  if (assignedIds.length) {
    const { data, error } = await supabase().from("classes").select("*").in("id", assignedIds);
    if (error) throw new Error(error.message);
    assignedClasses = (data ?? []) as ClassGroup[];
  }

  const byId = new Map<string, ClassGroup>();
  for (const c of [...assignedClasses, ...((owned ?? []) as ClassGroup[])]) byId.set(c.id, c);
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchCurrentTerm(): Promise<Term | null> {
  const { data, error } = await supabase().from("terms").select("*").eq("is_current", true).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Term | null) ?? null;
}

/** Subjects this teacher is assigned to teach for one specific class. */
export async function fetchTeacherSubjectsForClass(teacherId: string, classId: string): Promise<Subject[]> {
  const { data, error } = await supabase()
    .from("teaching_assignments")
    .select("subject_id, subjects(*)")
    .eq("teacher_id", teacherId)
    .eq("class_id", classId);
  if (error) throw new Error(error.message);

  const byId = new Map<string, Subject>();
  for (const row of (data ?? []) as { subject_id: string; subjects: Subject | Subject[] | null }[]) {
    const subj = Array.isArray(row.subjects) ? row.subjects[0] : row.subjects;
    if (subj) byId.set(subj.id, subj);
  }
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}
