import { supabase } from "./supabase";
import { fetchClassMeans, formatShortDate, formatWhen, type Receipt } from "./parentData";
import { classAudienceIncludes, type ClassLevel } from "./types";

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
  classLevel: ClassLevel | null; // null alongside classId — picks the grading scheme (FIG-356) via gradingSchemeFor()
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

/**
 * A student's own fee balance and payment history — only reachable at all
 * once a student has no guardian (FIG-329) or simply wants to pay for
 * themselves. Kept as a separate loader from loadStudentData(), the same way
 * ParentFees.tsx fetches its own invoice beyond loadParentData() — Fees is a
 * separate route, no reason to pay its query cost on every student screen.
 */
export interface StudentFeeData {
  studentId: string;
  invoiceId: string | null;
  name: string;
  admissionNo: string;
  className: string;
  formLevel: number;
  boarding: boolean;
  balance: number;
  billed: number;
  dueOn: string | null;
  termLabel: string | null;
  feeItems: { id: string; name: string; amount_cents: number; applies_to: "all" | "boarders" | "day" | "form_level"; form_level: number | null }[];
  receipts: Receipt[];
}

export async function loadStudentFeeData(profileId: string): Promise<StudentFeeData | null> {
  const { data: studentRow } = await supabase()
    .from("students")
    .select("id, full_name, admission_no, boarding, classes(name, form_level)")
    .eq("profile_id", profileId)
    .maybeSingle<{ id: string; full_name: string; admission_no: string; boarding: boolean; classes: { name: string; form_level: number } | null }>();
  if (!studentRow) return null;

  const { data: term } = await supabase().from("terms").select("id, name").eq("is_current", true).maybeSingle<{ id: string; name: string }>();

  const [{ data: invoice }, { data: feeItemRows }, { data: paymentRows }] = await Promise.all([
    term
      ? supabase().from("fee_invoices").select("id, total_cents, paid_cents, due_on").eq("student_id", studentRow.id).eq("term_id", term.id).maybeSingle<{ id: string; total_cents: number; paid_cents: number; due_on: string }>()
      : Promise.resolve({ data: null }),
    term
      ? supabase().from("fee_items").select("id, name, amount_cents, applies_to, form_level").eq("term_id", term.id)
      : Promise.resolve({ data: [] as StudentFeeData["feeItems"] }),
    supabase()
      .from("payments")
      .select("id, amount_cents, mpesa_receipt, completed_at, created_at, fee_invoices!inner(student_id)")
      .eq("fee_invoices.student_id", studentRow.id)
      .eq("status", "success")
      .order("completed_at", { ascending: false })
      .returns<{ id: string; amount_cents: number; mpesa_receipt: string | null; completed_at: string | null; created_at: string }[]>(),
  ]);

  const receipts: Receipt[] = (paymentRows ?? []).map((p) => ({
    id: p.id,
    amount: p.amount_cents,
    when: formatShortDate((p.completed_at ?? p.created_at).slice(0, 10)),
    ref: p.mpesa_receipt ?? "M-Pesa",
  }));

  return {
    studentId: studentRow.id,
    invoiceId: invoice?.id ?? null,
    name: studentRow.full_name,
    admissionNo: studentRow.admission_no,
    className: studentRow.classes?.name ?? "",
    formLevel: studentRow.classes?.form_level ?? 1,
    boarding: studentRow.boarding,
    balance: invoice ? Math.max(invoice.total_cents - invoice.paid_cents, 0) : 0,
    billed: invoice ? invoice.total_cents : 0,
    dueOn: invoice?.due_on ?? null,
    termLabel: term?.name ?? null,
    feeItems: (feeItemRows ?? []) as StudentFeeData["feeItems"],
    receipts,
  };
}

export async function loadStudentData(profileId: string): Promise<StudentData | null> {
  const { data: studentRow } = await supabase()
    .from("students")
    .select("id, class_id, classes(name, level)")
    .eq("profile_id", profileId)
    .maybeSingle<{ id: string; class_id: string | null; classes: { name: string; level: ClassLevel } | null }>();
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

  const [{ data: markRows }, classMeans] = await Promise.all([
    exam
      ? supabase().from("marks").select("score, subject_id, subjects(name)").eq("exam_id", exam.id).eq("student_id", studentRow.id)
      : Promise.resolve({ data: [] as { score: number | null; subject_id: string; subjects: { name: string } | null }[] }),
    exam && studentRow.class_id
      ? fetchClassMeans(exam.id, studentRow.class_id)
      : Promise.resolve(new Map<string, number>()),
  ]);

  const meanFor = (subjectId: string): number | null => classMeans.get(subjectId) ?? null;

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
    audience: { kind: string; class_id?: string; user_id?: string; recipients?: "guardians" | "students" | "both" } | null;
    profiles: { full_name: string; role: string } | null;
  }[])
    .filter((a) => {
      const kind = a.audience?.kind;
      if (kind === "whole_school") return true;
      if (kind === "class") return a.audience?.class_id === studentRow.class_id && classAudienceIncludes(a.audience?.recipients, "students");
      if (kind === "user") return a.audience?.user_id === profileId; // e.g. a promotion/repeat notice addressed to this student personally
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
    classLevel: studentRow.classes?.level ?? null,
    className: studentRow.classes?.name ?? "",
    work,
    notices,
    subjects,
    examName: exam?.name ?? null,
  };
}

/** Records that this student has opened a notice, so it drops off the unread badge for good. */
export async function markStudentNoticeRead(profileId: string, announcementId: string): Promise<void> {
  const { error } = await supabase()
    .from("announcement_reads")
    .upsert({ announcement_id: announcementId, profile_id: profileId }, { onConflict: "announcement_id,profile_id" });
  if (error) throw new Error(error.message);
}
