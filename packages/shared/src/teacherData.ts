import { fetchClassTimetableSlots } from "./timetable";
import { formatWhen } from "./parentData";
import type { NoticeInfo } from "./studentData";
import { supabase } from "./supabase";
import { today, type Register } from "./attendance";
import type { Announcement, Audience, AttendanceMark, ClassGroup, Exam, Student, Subject, Term, Weekday } from "./types";

/**
 * Shared across every teacher screen that needs "which classes is this
 * teacher looking at" — Gradebook, Attendance's class picker, Classes,
 * Messages — so the assigned-vs-class-teacher union logic lives in one
 * place. Also shared between web and the teacher mobile app (FIG-319).
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

/** Whole-school announcements, plus anything addressed to this teacher personally (e.g. a principal's reminder). */
export async function fetchTeacherNotices(teacherId: string): Promise<NoticeInfo[]> {
  const [{ data, error }, { data: reads, error: readsError }] = await Promise.all([
    supabase()
      .from("announcements")
      .select("id, subject, body, created_at, audience, profiles!announcements_author_id_fkey(full_name, role)")
      .order("created_at", { ascending: false }),
    supabase().from("announcement_reads").select("announcement_id").eq("profile_id", teacherId),
  ]);
  if (error) throw new Error(error.message);
  if (readsError) throw new Error(readsError.message);

  const readIds = new Set((reads ?? []).map((r) => r.announcement_id as string));

  return ((data ?? []) as unknown as {
    id: string; subject: string; body: string; created_at: string;
    audience: Audience | null;
    profiles: { full_name: string; role: string } | null;
  }[])
    .filter((a) => {
      const audience = a.audience;
      if (!audience) return false;
      return audience.kind === "whole_school" || (audience.kind === "user" && audience.user_id === teacherId);
    })
    .map((a) => ({
      id: a.id,
      subject: a.subject,
      from: a.profiles?.role === "teacher" ? (a.profiles?.full_name ?? "Another teacher") : "School office",
      when: formatWhen(a.created_at),
      unread: !readIds.has(a.id),
      body: a.body,
    }));
}

/** How many of a teacher's notices they haven't opened yet — drives the sidebar badge. */
export async function fetchTeacherUnreadNoticeCount(teacherId: string): Promise<number> {
  const notices = await fetchTeacherNotices(teacherId);
  return notices.filter((n) => n.unread).length;
}

/** Records that this teacher has opened a notice, so it drops off the unread badge for good. */
export async function markNoticeRead(teacherId: string, announcementId: string): Promise<void> {
  const { error } = await supabase()
    .from("announcement_reads")
    .upsert({ announcement_id: announcementId, profile_id: teacherId }, { onConflict: "announcement_id,profile_id" });
  if (error) throw new Error(error.message);
}

export interface TeacherTimetableRow {
  time: string;
  label: string;
  room: string;
  subjectId: string | null;
  teacherId: string | null;    // who's assigned to this subject in this class, if any
  teacherName: string | null;
  mine: boolean;                // this teacher's own period, or a non-subject one everyone sees
}

/**
 * A class's timetable, filtered to what this teacher actually needs to see.
 * A subject-only teacher (not this class's class teacher) sees only their
 * own periods plus unlinked ones (Games, Library, Class meeting — nobody's
 * excluded from those). The class teacher sees the whole week, since it's
 * their homeroom, but each period still says whose subject it is so "why is
 * X teaching Y" never comes up — who teaches a period comes from
 * teaching_assignments, not a separate field that could drift out of sync.
 */
export async function fetchTeacherClassTimetable(classId: string, teacherId: string): Promise<{
  byDay: Record<Weekday, TeacherTimetableRow[]>;
  isClassTeacher: boolean;
}> {
  const sb = supabase();
  const [slots, { data: classRow, error: e1 }, { data: assignmentRows, error: e2 }] = await Promise.all([
    fetchClassTimetableSlots(classId),
    sb.from("classes").select("class_teacher_id").eq("id", classId).maybeSingle<{ class_teacher_id: string | null }>(),
    sb.from("teaching_assignments").select("subject_id, teacher_id, profiles(full_name)").eq("class_id", classId)
      .returns<{ subject_id: string; teacher_id: string; profiles: { full_name: string } | null }[]>(),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);

  const isClassTeacher = classRow?.class_teacher_id === teacherId;
  const bySubject = new Map((assignmentRows ?? []).map((a) => [a.subject_id, { teacherId: a.teacher_id, name: a.profiles?.full_name ?? "Unknown" }]));

  const byDay: Record<Weekday, TeacherTimetableRow[]> = { Mon: [], Tue: [], Wed: [], Thu: [], Fri: [] };
  for (const s of slots) {
    const assignment = s.subject_id ? bySubject.get(s.subject_id) : undefined;
    const mine = !s.subject_id || assignment?.teacherId === teacherId;
    if (!isClassTeacher && !mine) continue;
    byDay[s.day].push({
      time: s.start_time, label: s.label, room: s.room ?? "",
      subjectId: s.subject_id, teacherId: assignment?.teacherId ?? null, teacherName: assignment?.name ?? null, mine,
    });
  }
  for (const day of (["Mon", "Tue", "Wed", "Thu", "Fri"] as Weekday[])) byDay[day].sort((a, b) => a.time.localeCompare(b.time));

  return { byDay, isClassTeacher };
}

/** Everyone active in a class, for the attendance roster — same query web and mobile both need. */
export async function fetchClassRoster(classId: string): Promise<Student[]> {
  const { data, error } = await supabase()
    .from("students").select("*").eq("class_id", classId).eq("active", true).order("full_name");
  if (error) throw new Error(error.message);
  return (data ?? []) as Student[];
}

/** Marks already taken today for a class, so re-opening the register (or opening it on a
 *  second device) shows what was submitted rather than a blank "everyone present" state. */
export async function fetchTodayAttendanceMarks(classId: string): Promise<{ student_id: string; mark: AttendanceMark }[]> {
  const { data, error } = await supabase()
    .from("attendance").select("student_id, mark").eq("class_id", classId).eq("taken_on", today());
  if (error) throw new Error(error.message);
  return (data ?? []) as { student_id: string; mark: AttendanceMark }[];
}

export interface MyClassRow extends ClassGroup {
  subjects: string[];
  learnerCount: number;
}

/** "My classes" — every class a teacher is assigned to, whether as class
 *  teacher or a subject teacher, with what they teach there and roll size. */
export async function fetchMyClasses(teacherId: string): Promise<MyClassRow[]> {
  const classes = await fetchTeacherClasses(teacherId);
  if (!classes.length) return [];

  const [subjectLists, { data: studentRows }] = await Promise.all([
    Promise.all(classes.map((c) => fetchTeacherSubjectsForClass(teacherId, c.id))),
    supabase().from("students").select("id,class_id").eq("active", true).in("class_id", classes.map((c) => c.id))
      .returns<{ id: string; class_id: string }[]>(),
  ]);

  const countByClass = new Map<string, number>();
  for (const s of studentRows ?? []) countByClass.set(s.class_id, (countByClass.get(s.class_id) ?? 0) + 1);

  return classes.map((c, i) => ({
    ...c,
    subjects: subjectLists[i]!.map((s) => s.name),
    learnerCount: countByClass.get(c.id) ?? 0,
  }));
}

/** This term's exams, for the gradebook's exam picker — web and mobile both need it. */
export async function fetchExamsForTerm(termId: string): Promise<Exam[]> {
  const { data, error } = await supabase().from("exams").select("*").eq("term_id", termId).order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as Exam[];
}

/** Existing scores for one exam+subject, keyed by student — only students with a saved row appear. */
export async function fetchMarksForExamSubject(
  examId: string, subjectId: string, studentIds: string[],
): Promise<Record<string, number | null>> {
  if (!studentIds.length) return {};
  const { data, error } = await supabase()
    .from("marks").select("student_id, score")
    .eq("exam_id", examId).eq("subject_id", subjectId).in("student_id", studentIds);
  if (error) throw new Error(error.message);
  const out: Record<string, number | null> = {};
  for (const row of (data ?? []) as { student_id: string; score: number | null }[]) out[row.student_id] = row.score;
  return out;
}

export interface MarkRow {
  tenant_id: string;
  exam_id: string;
  student_id: string;
  subject_id: string;
  score: number | null;
  entered_by: string;
}

/** A draft save — visible only to the entering teacher until publishExam() runs.
 *  Named saveExamMarks, not saveMarks, to avoid colliding with courseGrades.ts's
 *  higher-ed equivalent (assessment-based, different signature). */
export async function saveExamMarks(rows: MarkRow[]): Promise<void> {
  if (!rows.length) return;
  const { error } = await supabase().from("marks").upsert(rows, { onConflict: "exam_id,student_id,subject_id" });
  if (error) throw new Error(error.message);
}

/** Flips an exam visible to parents/students. Callers should saveExamMarks() whatever's
 *  on screen first — publishing on top of an unsaved draft must not lose it. */
export async function publishExam(examId: string): Promise<void> {
  const { error } = await supabase().from("exams").update({ published_at: new Date().toISOString() }).eq("id", examId);
  if (error) throw new Error(error.message);
}

/** A teacher's own sent messages — always in-app only, always one class at a time,
 *  a lighter form over the same announcements table admin's whole-school composer uses. */
export async function fetchSentByMe(teacherId: string): Promise<Announcement[]> {
  const { data, error } = await supabase()
    .from("announcements").select("*").eq("author_id", teacherId)
    .order("created_at", { ascending: false }).limit(20);
  if (error) throw new Error(error.message);
  return (data ?? []) as Announcement[];
}

export type ClassMessageRecipients = "guardians" | "students" | "both";

/** Sends a note to one class's parents, students, or both — in-app only, published immediately. */
export async function sendClassMessage(
  tenantId: string, teacherId: string, classId: string,
  recipients: ClassMessageRecipients, subject: string, body: string,
): Promise<void> {
  const { error } = await supabase().from("announcements").insert({
    tenant_id: tenantId,
    author_id: teacherId,
    subject: subject.trim(),
    body: body.trim(),
    audience: { kind: "class", class_id: classId, recipients } satisfies Audience,
    channels: ["in_app"],
    published_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

/** Upserts one class's register for today — onConflict(student_id, taken_on) means
 *  correcting a mark after submit is just another call, not a separate edit path.
 *  Deliberately doesn't use attendance.ts's toRecords(), which stamps a
 *  synced_at field the "attendance" table has no column for. */
export async function writeAttendance(reg: Register, tenantId: string, takenBy: string): Promise<void> {
  const rows = Object.entries(reg.marks).map(([student_id, mark]) => ({
    tenant_id: tenantId,
    student_id,
    class_id: reg.classId,
    term_id: reg.termId,
    taken_by: takenBy,
    taken_on: reg.date,
    mark,
    note: reg.notes[student_id] ?? null,
  }));
  const { error } = await supabase().from("attendance").upsert(rows, { onConflict: "student_id,taken_on" });
  if (error) throw new Error(error.message);
}
