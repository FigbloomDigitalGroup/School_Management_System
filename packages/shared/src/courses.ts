import { supabase } from "./supabase";
import { WEEKDAYS, type TimetableRow } from "./timetable";
import type { Course, CourseSection, Enrollment, EnrollmentStatus, Semester, Weekday } from "./types";

/**
 * Data access for the higher-ed course/enrollment model (FIG-327) — the
 * parallel to classes/subjects/students.class_id for K-12. Nothing here is
 * read or written by a k12 tenant; every screen that calls these is gated by
 * institution_type === 'higher_ed'.
 */

export async function fetchSemesters(tenantId: string): Promise<Semester[]> {
  const { data, error } = await supabase()
    .from("semesters").select("*").eq("tenant_id", tenantId)
    .order("year", { ascending: false }).order("index", { ascending: false })
    .returns<Semester[]>();
  if (error) throw error;
  return data ?? [];
}

export async function createSemester(input: Omit<Semester, "id">): Promise<Semester> {
  const { data, error } = await supabase().from("semesters").insert(input).select("*").single<Semester>();
  if (error) throw error;
  return data;
}

/** Only one semester may be current at a time — same pattern as terms. */
export async function setCurrentSemester(tenantId: string, semesterId: string): Promise<void> {
  const { error: clearErr } = await supabase().from("semesters").update({ is_current: false }).eq("tenant_id", tenantId);
  if (clearErr) throw clearErr;
  const { error } = await supabase().from("semesters").update({ is_current: true }).eq("id", semesterId);
  if (error) throw error;
}

export async function fetchCourses(tenantId: string): Promise<Course[]> {
  const { data, error } = await supabase()
    .from("courses").select("*").eq("tenant_id", tenantId).order("code").returns<Course[]>();
  if (error) throw error;
  return data ?? [];
}

export async function createCourse(input: Omit<Course, "id">): Promise<Course> {
  const { data, error } = await supabase().from("courses").insert(input).select("*").single<Course>();
  if (error) throw error;
  return data;
}

export interface CourseSectionRow extends CourseSection {
  course_code: string;
  course_name: string;
  instructor_name: string | null;
  enrolled_count: number;
}

export async function fetchCourseSections(tenantId: string, semesterId: string): Promise<CourseSectionRow[]> {
  const { data, error } = await supabase()
    .from("course_sections")
    .select("*, courses(code, name), profiles(full_name), enrollments(count)")
    .eq("tenant_id", tenantId)
    .eq("semester_id", semesterId)
    .order("section_label")
    .returns<(CourseSection & { courses: { code: string; name: string } | null; profiles: { full_name: string } | null; enrollments: { count: number }[] })[]>();
  if (error) throw error;
  return (data ?? []).map((s) => ({
    ...s,
    course_code: s.courses?.code ?? "",
    course_name: s.courses?.name ?? "",
    instructor_name: s.profiles?.full_name ?? null,
    enrolled_count: s.enrollments?.[0]?.count ?? 0,
  }));
}

export interface InstructorSectionRow extends CourseSection {
  course_code: string;
  course_name: string;
  semester_name: string;
  enrolled_count: number;
}

/**
 * A lecturer's own sections, across however many courses/semesters they
 * teach — the higher-ed analogue of teacherData.ts's fetchTeacherClasses(),
 * but simpler: one source (instructor_id), not a union with a
 * class_teacher_id-style homeroom-owner concept, since higher-ed has none.
 */
export async function fetchInstructorSections(tenantId: string, instructorId: string): Promise<InstructorSectionRow[]> {
  const { data, error } = await supabase()
    .from("course_sections")
    .select("*, courses(code, name), semesters(name), enrollments(count)")
    .eq("tenant_id", tenantId)
    .eq("instructor_id", instructorId)
    .order("section_label")
    .returns<(CourseSection & { courses: { code: string; name: string } | null; semesters: { name: string } | null; enrollments: { count: number }[] })[]>();
  if (error) throw error;
  return (data ?? []).map((s) => ({
    ...s,
    course_code: s.courses?.code ?? "",
    course_name: s.courses?.name ?? "",
    semester_name: s.semesters?.name ?? "",
    enrolled_count: s.enrollments?.[0]?.count ?? 0,
  }));
}

export async function createCourseSection(input: Omit<CourseSection, "id">): Promise<CourseSection> {
  const { data, error } = await supabase().from("course_sections").insert(input).select("*").single<CourseSection>();
  if (error) throw error;
  return data;
}

export async function assignSectionInstructor(sectionId: string, instructorId: string | null): Promise<void> {
  const { error } = await supabase().from("course_sections").update({ instructor_id: instructorId }).eq("id", sectionId);
  if (error) throw error;
}

export interface EnrolledStudentRow {
  enrollment_id: string;
  student_id: string;
  full_name: string;
  admission_no: string;
  status: EnrollmentStatus;
}

export async function fetchEnrollmentsForSection(sectionId: string): Promise<EnrolledStudentRow[]> {
  const { data, error } = await supabase()
    .from("enrollments")
    .select("id, student_id, status, students(full_name, admission_no)")
    .eq("course_section_id", sectionId)
    .order("enrolled_at")
    .returns<{ id: string; student_id: string; status: EnrollmentStatus; students: { full_name: string; admission_no: string } | null }[]>();
  if (error) throw error;
  return (data ?? []).map((e) => ({
    enrollment_id: e.id,
    student_id: e.student_id,
    full_name: e.students?.full_name ?? "",
    admission_no: e.students?.admission_no ?? "",
    status: e.status,
  }));
}

/** Enroll several students into one section in one call — the admin bulk-enroll flow. */
export async function enrollStudents(tenantId: string, courseSectionId: string, studentIds: string[]): Promise<void> {
  if (!studentIds.length) return;
  const { error } = await supabase().from("enrollments").upsert(
    studentIds.map((student_id) => ({ tenant_id: tenantId, course_section_id: courseSectionId, student_id, status: "enrolled" as const })),
    { onConflict: "student_id,course_section_id", ignoreDuplicates: true },
  );
  if (error) throw error;
}

export async function setEnrollmentStatus(enrollmentId: string, status: EnrollmentStatus): Promise<void> {
  const { error } = await supabase().from("enrollments").update({ status }).eq("id", enrollmentId);
  if (error) throw error;
}

// ---------------------------------------------------------------- schedule

export async function fetchSectionTimetableSlots(sectionId: string): Promise<{ day: Weekday; start_time: string; label: string; room: string | null }[]> {
  const { data, error } = await supabase()
    .from("course_section_timetable_slots").select("day, start_time, label, room").eq("course_section_id", sectionId)
    .order("day").order("start_time")
    .returns<{ day: Weekday; start_time: string; label: string; room: string | null }[]>();
  if (error) throw error;
  return data ?? [];
}

export async function saveSectionTimetable(
  tenantId: string,
  sectionId: string,
  slots: { day: Weekday; start_time: string; label: string; room: string | null }[],
): Promise<void> {
  const { error: delErr } = await supabase().from("course_section_timetable_slots").delete().eq("course_section_id", sectionId);
  if (delErr) throw delErr;
  const rows = slots.filter((s) => s.label.trim().length > 0);
  if (!rows.length) return;
  const { error } = await supabase().from("course_section_timetable_slots").insert(
    rows.map((s) => ({
      tenant_id: tenantId, course_section_id: sectionId, day: s.day, start_time: s.start_time,
      label: s.label.trim(), room: s.room?.trim() || null,
    })),
  );
  if (error) throw error;
}

/**
 * A student's combined weekly view across every section they're enrolled in —
 * the higher-ed equivalent of fetchClassTimetable(classId), except many
 * sections feed one grid instead of one class.
 */
export async function fetchStudentSchedule(studentId: string): Promise<Record<Weekday, TimetableRow[]>> {
  const { data: enrolled, error } = await supabase()
    .from("enrollments")
    .select("course_section_id")
    .eq("student_id", studentId)
    .eq("status", "enrolled")
    .returns<{ course_section_id: string }[]>();
  if (error) throw error;

  const byDay: Record<Weekday, TimetableRow[]> = { Mon: [], Tue: [], Wed: [], Thu: [], Fri: [] };
  const sectionIds = (enrolled ?? []).map((e) => e.course_section_id);
  if (!sectionIds.length) return byDay;

  const { data: slots, error: slotErr } = await supabase()
    .from("course_section_timetable_slots")
    .select("day, start_time, label, room")
    .in("course_section_id", sectionIds)
    .returns<{ day: Weekday; start_time: string; label: string; room: string | null }[]>();
  if (slotErr) throw slotErr;

  for (const s of slots ?? []) byDay[s.day].push([s.start_time, s.label, s.room ?? ""]);
  for (const day of WEEKDAYS) byDay[day].sort((a, b) => a[0].localeCompare(b[0]));
  return byDay;
}
