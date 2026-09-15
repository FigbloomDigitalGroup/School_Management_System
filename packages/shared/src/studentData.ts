import { supabase } from "./supabase";
import { formatShortDate, formatWhen } from "./parentData";

/**
 * One real query for everything a signed-in student's screens need — mobile
 * (PhoneFrame) and desktop both call this, so there is one place that knows
 * how "work", "notices" and "results" map onto assignments/announcements/marks.
 */

export const HAND_IN_LABEL: Record<string, string> = {
  paper: "Exercise book",
  in_person: "Hand to teacher",
  upload: "Upload online",
};

export interface WorkItem {
  id: string;
  title: string;
  subject: string;
  teacher: string;
  dueOn: string;
  state: "open" | "late" | "done";
  how: string;
  body: string;
}

export interface ResultSubject {
  name: string;
  score: number;
  classMean: number | null;
}

export interface NoticeInfo {
  id: string;
  subject: string;
  from: string;
  when: string;
  unread: boolean;
  body: string;
}

export interface StudentData {
  studentId: string;
  classId: string | null; // null for a higher-ed student (FIG-327): they enroll into course_sections instead of one fixed class
  className: string;
  work: WorkItem[];
  notices: NoticeInfo[];
  subjects: ResultSubject[];
  examName: string | null;
}

export function daysUntil(dueOn: string): number {
  const d = new Date(`${dueOn}T00:00:00`);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - now.getTime()) / 86_400_000);
}

export function formatDueLabel(dueOn: string, late: boolean): string {
  if (late) return `Overdue since ${formatShortDate(dueOn)}`;
  const diff = daysUntil(dueOn);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff > 1 && diff < 7) return new Date(`${dueOn}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long" });
  return formatShortDate(dueOn);
}

export async function loadStudentData(profileId: string): Promise<StudentData | null> {
  const { data: studentRow } = await supabase()
    .from("students")
    .select("id, class_id, classes(name)")
    .eq("profile_id", profileId)
    .maybeSingle<{ id: string; class_id: string | null; classes: { name: string } | null }>();
  if (!studentRow) return null;

  // A higher-ed student (FIG-327) has class_id = null — class-scoped queries
  // are skipped rather than run with .eq("class_id", null), which PostgREST
  // rejects outright (400) rather than treating as an IS NULL filter.
  const [{ data: assignmentRows }, { data: subRows }, { data: examRows }, { data: announcementRows }] = await Promise.all([
    studentRow.class_id
      ? supabase()
          .from("assignments")
          .select("id, title, body, due_on, hand_in, subjects(name), profiles(full_name)")
          .eq("class_id", studentRow.class_id)
          .order("due_on", { ascending: true })
      : Promise.resolve({ data: [] as unknown[] }),
    supabase().from("assignment_submissions").select("assignment_id, marked_done_at").eq("student_id", studentRow.id),
    supabase().from("exams").select("id, name, published_at").not("published_at", "is", null).order("published_at", { ascending: false }).limit(1),
    supabase().from("announcements").select("id, subject, body, audience, published_at, created_at, profiles!announcements_author_id_fkey(full_name, role)").order("created_at", { ascending: false }),
  ]);

  const exam = (examRows ?? [])[0] as { id: string; name: string } | undefined;

  const [{ data: markRows }, { data: classMarkRows }] = await Promise.all([
    exam
      ? supabase().from("marks").select("score, subject_id, subjects(name)").eq("exam_id", exam.id).eq("student_id", studentRow.id)
      : Promise.resolve({ data: [] as { score: number | null; subject_id: string; subjects: { name: string } | null }[] }),
    exam && studentRow.class_id
      ? supabase().from("marks").select("subject_id, score, students!inner(class_id)").eq("exam_id", exam.id).eq("students.class_id", studentRow.class_id)
      : Promise.resolve({ data: [] as { subject_id: string; score: number | null; students: { class_id: string } | null }[] }),
  ]);

  const classMeans = new Map<string, number[]>();
  for (const row of (classMarkRows ?? []) as { subject_id: string; score: number | null }[]) {
    if (row.score === null) continue;
    const arr = classMeans.get(row.subject_id) ?? [];
    arr.push(row.score);
    classMeans.set(row.subject_id, arr);
  }
  const meanFor = (subjectId: string): number | null => {
    const arr = classMeans.get(subjectId);
    if (!arr || !arr.length) return null;
    return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  };

  const subjects: ResultSubject[] = ((markRows ?? []) as { score: number | null; subject_id: string; subjects: { name: string } | null }[])
    .filter((m) => m.score !== null)
    .map((m) => ({ name: m.subjects?.name ?? "Subject", score: m.score as number, classMean: meanFor(m.subject_id) }));

  const submittedAt = new Map(((subRows ?? []) as { assignment_id: string; marked_done_at: string }[]).map((s) => [s.assignment_id, s.marked_done_at]));

  const work: WorkItem[] = ((assignmentRows ?? []) as unknown as {
    id: string; title: string; body: string; due_on: string; hand_in: string;
    subjects: { name: string } | null; profiles: { full_name: string } | null;
  }[]).map((a) => {
    const done = submittedAt.has(a.id);
    const late = !done && daysUntil(a.due_on) < 0;
    return {
      id: a.id,
      title: a.title,
      subject: a.subjects?.name ?? "Subject",
      teacher: a.profiles?.full_name ?? "Class teacher",
      dueOn: a.due_on,
      state: done ? "done" : late ? "late" : "open",
      how: HAND_IN_LABEL[a.hand_in] ?? "Exercise book",
      body: a.body,
    };
  });

  const notices: NoticeInfo[] = ((announcementRows ?? []) as unknown as {
    id: string; subject: string; body: string; created_at: string;
    audience: { kind: string; class_id?: string } | null;
    profiles: { full_name: string; role: string } | null;
  }[])
    .filter((a) => {
      const kind = a.audience?.kind;
      if (kind === "whole_school") return true;
      if (kind === "class") return a.audience?.class_id === studentRow.class_id;
      return false;
    })
    .map((a) => ({
      id: a.id,
      subject: a.subject,
      from: a.profiles?.role === "teacher" ? (a.profiles?.full_name ?? "Class teacher") : "School office",
      when: formatWhen(a.created_at),
      unread: true,
      body: a.body,
    }));

  return {
    studentId: studentRow.id,
    classId: studentRow.class_id,
    className: studentRow.classes?.name ?? "",
    work,
    notices,
    subjects,
    examName: exam?.name ?? null,
  };
}
