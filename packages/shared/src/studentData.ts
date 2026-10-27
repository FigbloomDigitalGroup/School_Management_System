import { supabase } from "./supabase";
import { formatShortDate, formatWhen, type Receipt } from "./parentData";
import { fetchExamSubjects, fetchPublishedExams, type PublishedExam } from "./examResults";
import type { Audience, ClassLevel, Payment } from "./types";
import { receiptRef } from "./fees";
import { fetchInvoiceCharges, standingCharges, type FeeCharge } from "./feeCharges";
import { audienceIncludes, type AudienceViewer } from "./audience";
import { normaliseGuide } from "./homework";

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
  /** What the teacher said the learner needs (from the parent guide). Optional: a cache written by an older build won't carry it. */
  needs?: string[];
  /** Expected time in minutes, from the same guide. */
  minutes?: number | null;
  /** A file was uploaded with it — "undo" is not offered, the row is the only record of the file. */
  hasFile?: boolean;
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
  /** The newest exam this learner has results out for; `subjects` are its marks. */
  subjects: ResultSubject[];
  examId: string | null;
  examName: string | null;
  /** Every exam this learner has results out for, newest first, so the screen can switch between them. */
  exams: PublishedExam[];
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
  classLevel: ClassLevel | null;
  boarding: boolean;
  balance: number;
  /** The invoice total: fees billed plus any charges. */
  billed: number;
  /** Charges on this term's invoice (a lost textbook), already inside `billed`. */
  charges: FeeCharge[];
  dueOn: string | null;
  termLabel: string | null;
  feeItems: { id: string; name: string; amount_cents: number; applies_to: "all" | "boarders" | "day" | "form_level"; form_level: number | null; level: ClassLevel | null }[];
  receipts: Receipt[];
}

export async function loadStudentFeeData(profileId: string): Promise<StudentFeeData | null> {
  const { data: studentRow } = await supabase()
    .from("students")
    .select("id, full_name, admission_no, boarding, classes(name, form_level, level)")
    .eq("profile_id", profileId)
    .maybeSingle<{ id: string; full_name: string; admission_no: string; boarding: boolean; classes: { name: string; form_level: number; level: ClassLevel } | null }>();
  if (!studentRow) return null;

  const { data: term } = await supabase().from("terms").select("id, name").eq("is_current", true).maybeSingle<{ id: string; name: string }>();

  const [{ data: invoice }, { data: feeItemRows }, { data: paymentRows }] = await Promise.all([
    term
      ? supabase().from("fee_invoices").select("id, total_cents, paid_cents, due_on").eq("student_id", studentRow.id).eq("term_id", term.id).maybeSingle<{ id: string; total_cents: number; paid_cents: number; due_on: string }>()
      : Promise.resolve({ data: null }),
    term
      ? supabase().from("fee_items").select("id, name, amount_cents, applies_to, form_level, level").eq("term_id", term.id)
      : Promise.resolve({ data: [] as StudentFeeData["feeItems"] }),
    supabase()
      .from("payments")
      .select("id, amount_cents, method, mpesa_receipt, reference, completed_at, created_at, fee_invoices!inner(student_id)")
      .eq("fee_invoices.student_id", studentRow.id)
      .eq("status", "success")
      .order("completed_at", { ascending: false })
      .returns<{ id: string; amount_cents: number; method: Payment["method"]; mpesa_receipt: string | null; reference: string | null; completed_at: string | null; created_at: string }[]>(),
  ]);

  // Only the lines (the balance is the invoice's), so a failed read costs the detail, not the total.
  const charges = invoice ? standingCharges(await fetchInvoiceCharges([invoice.id]).catch(() => [])) : [];

  const receipts: Receipt[] = (paymentRows ?? []).map((p) => ({
    id: p.id,
    amount: p.amount_cents,
    when: formatShortDate((p.completed_at ?? p.created_at).slice(0, 10)),
    ref: receiptRef(p),
  }));

  return {
    studentId: studentRow.id,
    invoiceId: invoice?.id ?? null,
    name: studentRow.full_name,
    admissionNo: studentRow.admission_no,
    className: studentRow.classes?.name ?? "",
    formLevel: studentRow.classes?.form_level ?? 1,
    classLevel: studentRow.classes?.level ?? null,
    boarding: studentRow.boarding,
    balance: invoice ? Math.max(invoice.total_cents - invoice.paid_cents, 0) : 0,
    billed: invoice ? invoice.total_cents : 0,
    charges,
    dueOn: invoice?.due_on ?? null,
    termLabel: term?.name ?? null,
    feeItems: (feeItemRows ?? []) as StudentFeeData["feeItems"],
    receipts,
  };
}

export async function loadStudentData(profileId: string): Promise<StudentData | null> {
  const { data: studentRow } = await supabase()
    .from("students")
    .select("id, class_id, classes(name, level, form_level)")
    .eq("profile_id", profileId)
    .maybeSingle<{ id: string; class_id: string | null; classes: { name: string; level: ClassLevel; form_level: number } | null }>();
  if (!studentRow) return null;

  // A higher-ed student (FIG-327) has class_id = null — class-scoped queries
  // are skipped rather than run with .eq("class_id", null), which PostgREST
  // rejects outright (400) rather than treating as an IS NULL filter.
  const [{ data: assignmentRows }, { data: subRows }, examsByStudent, { data: announcementRows }] = await Promise.all([
    studentRow.class_id
      ? supabase()
          .from("assignments")
          .select("id, title, body, due_on, hand_in, parent_guide, subjects(name), profiles(full_name)")
          .eq("class_id", studentRow.class_id)
          .order("due_on", { ascending: true })
      : Promise.resolve({ data: [] as unknown[] }),
    supabase().from("assignment_submissions").select("assignment_id, marked_done_at, file_path").eq("student_id", studentRow.id),
    fetchPublishedExams([studentRow.id]),
    supabase().from("announcements").select("id, subject, body, audience, published_at, created_at, profiles!announcements_author_id_fkey(full_name, role)").order("created_at", { ascending: false }),
  ]);

  // The exams come from the marks this learner can read, so an exam only another class has published is not offered.
  const exams = examsByStudent.get(studentRow.id) ?? [];
  const exam = exams[0];
  const subjects: ResultSubject[] = exam ? await fetchExamSubjects(studentRow.id, studentRow.class_id, exam.id) : [];

  const submittedAt = new Map(((subRows ?? []) as { assignment_id: string; marked_done_at: string; file_path: string | null }[]).map((s) => [s.assignment_id, s]));

  const work: WorkItem[] = ((assignmentRows ?? []) as unknown as {
    id: string; title: string; body: string; due_on: string; hand_in: string; parent_guide: unknown;
    subjects: { name: string } | null; profiles: { full_name: string } | null;
  }[]).map((a) => {
    const done = submittedAt.has(a.id);
    const guide = normaliseGuide(a.parent_guide);
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
      needs: guide?.needs ?? [],
      minutes: guide?.minutes ?? null,
      hasFile: !!submittedAt.get(a.id)?.file_path,
    };
  });

  // The same rule RLS (announcement_visible_to_me) applies -- so "All
  // students", a year-group notice and a named-people message all land here.
  const viewer: AudienceViewer = {
    profileId,
    role: "student",
    classIds: studentRow.class_id ? [studentRow.class_id] : [],
    years: studentRow.classes ? [{ level: studentRow.classes.level, year: studentRow.classes.form_level }] : [],
  };
  const notices: NoticeInfo[] = ((announcementRows ?? []) as unknown as {
    id: string; subject: string; body: string; created_at: string;
    audience: Audience | null;
    profiles: { full_name: string; role: string } | null;
  }[])
    .filter((a) => audienceIncludes(a.audience, viewer))
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
    examId: exam?.id ?? null,
    examName: exam?.name ?? null,
    exams,
  };
}

/** Records that this student has opened a notice, so it drops off the unread badge for good. */
export async function markStudentNoticeRead(profileId: string, announcementId: string): Promise<void> {
  const { error } = await supabase()
    .from("announcement_reads")
    .upsert({ announcement_id: announcementId, profile_id: profileId }, { onConflict: "announcement_id,profile_id" });
  if (error) throw new Error(error.message);
}

/**
 * FIG-873: the plain "Mark as handed in" button (no file) — previously local
 * state only, on both mobile and web. Shares the same row/conflict target as
 * uploadAssignmentSubmission()'s file-attach path (apps/web/src/lib/uploads.ts),
 * just without file_path/file_name.
 */
export async function markAssignmentHandedIn(assignmentId: string, studentId: string): Promise<void> {
  const { error } = await supabase()
    .from("assignment_submissions")
    // Already ticked (e.g. by a parent) stays as it is, so marked_by keeps saying who ticked it.
    .upsert({ assignment_id: assignmentId, student_id: studentId, marked_done_at: new Date().toISOString() }, { onConflict: "assignment_id,student_id", ignoreDuplicates: true });
  if (error) throw new Error(error.message);
}
