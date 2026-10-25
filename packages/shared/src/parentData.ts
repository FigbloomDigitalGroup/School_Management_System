import { supabase } from "./supabase";
import type { Audience, ClassLevel, Payment } from "./types";
import { receiptRef } from "./fees";
import { fetchExamSubjects, fetchPublishedExams, type PublishedExam } from "./examResults";
import { audienceIncludes, type AudienceViewer } from "./audience";

/**
 * One real query for everything a signed-in parent's screens need — mobile
 * (PhoneFrame) and desktop both call this, so there is one place that knows
 * how a parent's children, fees, attendance, marks and messages fit together.
 */

export interface ChildSubject {
  name: string;
  score: number;
  classMean: number | null;
}

export interface Receipt {
  id: string;
  amount: number;
  when: string;
  ref: string;
}

export interface ChildInfo {
  id: string; // student id
  name: string;
  first: string;
  cls: string;
  adm: string;
  classId: string;
  classLevel: ClassLevel; // picks the grading scheme (FIG-356) via gradingSchemeFor()
  formLevel: number;
  boarding: boolean;
  /** This term's invoice, which a payment is made against; null until the school has billed. */
  invoiceId: string | null;
  balance: number;
  billed: number;
  dueOn: string | null;
  attendancePct: number | null;
  absentDates: string[];
  mean: number | null;
  /** The exam `mean` and `subjects` come from: the newest one this child has results out for. */
  examId: string | null;
  examName: string | null;
  subjects: ChildSubject[];
  /** Every exam this child has results out for, newest first, so the screen can switch between them. */
  exams: PublishedExam[];
  receipts: Receipt[];
}

export interface MessageInfo {
  id: string;
  who: "school" | "teacher";
  from: string;
  subject: string;
  when: string;
  unread: boolean;
  body: string;
}

export interface ParentData {
  children: ChildInfo[];
  feeItems: { id: string; name: string; amount_cents: number; applies_to: "all" | "boarders" | "day" | "form_level"; form_level: number | null; level: ClassLevel | null }[];
  termLabel: string | null;
  messages: MessageInfo[];
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function formatShortDate(dateOnly: string): string {
  return new Date(`${dateOnly}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * Fires on every new announcement in the tenant — the badge/list callers
 * re-derive their own unread count or message list from it rather than
 * trying to match audience against the raw payload themselves, since that
 * logic (whole_school/role/class/form_level/user) already lives in one place.
 * Mirrors fleet.ts's subscribeVehiclePositions()/subscribeVehicleAlerts(),
 * except the channel name is made unique per call rather than just
 * `announcements-${tenantId}` — under React 18 StrictMode's dev-mode
 * double-invoke (mount, cleanup, mount again), a name reused across calls
 * raced with the first channel's still-in-flight async removal, and
 * Supabase's client returned that same not-yet-torn-down channel on the
 * second mount — calling .on() on an already-subscribed channel throws.
 * (Date.now()/Math.random() rather than crypto.randomUUID(): this file is
 * also type-checked for the React Native build, which has no DOM lib.)
 */
export function subscribeAnnouncements(tenantId: string, onInsert: () => void): () => void {
  const channel = supabase()
    .channel(`announcements-${tenantId}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "announcements", filter: `tenant_id=eq.${tenantId}` },
      () => onInsert(),
    )
    .subscribe();
  return () => { void supabase().removeChannel(channel); };
}

/** Records that this guardian has opened a message, so it drops off their unread badge for good. */
export async function markMessageRead(profileId: string, announcementId: string): Promise<void> {
  const { error } = await supabase()
    .from("announcement_reads")
    .upsert({ announcement_id: announcementId, profile_id: profileId }, { onConflict: "announcement_id,profile_id" });
  if (error) throw error;
}

/** How many of a guardian's messages they haven't opened yet — drives the sidebar badge.
 *  Deliberately lighter than loadParentData(): just enough to know audience match and read state,
 *  not fees/attendance/marks, since ParentShell needs this on every navigation. */
export async function fetchParentUnreadCount(profileId: string): Promise<number> {
  const { data: guardianRows, error: gErr } = await supabase()
    .from("guardians")
    .select("students(class_id, classes(form_level, level))")
    .eq("profile_id", profileId);
  if (gErr) throw gErr;

  const kids = ((guardianRows ?? []) as unknown as { students: { class_id: string; classes: { form_level: number; level: ClassLevel } | null } | null }[])
    .map((g) => g.students)
    .filter((s): s is NonNullable<typeof s> => s !== null);
  const viewer: AudienceViewer = {
    profileId,
    role: "parent",
    classIds: [...new Set(kids.map((k) => k.class_id))],
    years: kids.filter((k) => k.classes).map((k) => ({ level: k.classes!.level, year: k.classes!.form_level })),
  };

  const [{ data: announcementRows, error: aErr }, { data: readRows, error: rErr }] = await Promise.all([
    supabase().from("announcements").select("id, audience"),
    supabase().from("announcement_reads").select("announcement_id").eq("profile_id", profileId),
  ]);
  if (aErr) throw aErr;
  if (rErr) throw rErr;

  const readIds = new Set((readRows ?? []).map((r) => r.announcement_id as string));
  return ((announcementRows ?? []) as { id: string; audience: Audience | null }[]).filter((a) => {
    if (readIds.has(a.id)) return false;
    return audienceIncludes(a.audience, viewer);
  }).length;
}

export function formatPhone(raw: string | null): string {
  if (!raw) return "";
  const d = raw.replace(/[^0-9]/g, "");
  if (d.length === 12 && d.startsWith("254")) {
    return `+${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 9)} ${d.slice(9, 12)}`;
  }
  return raw;
}

export async function loadParentData(profileId: string): Promise<ParentData> {
  const { data: guardianRows, error: gErr } = await supabase()
    .from("guardians")
    .select("students(id, full_name, admission_no, class_id, boarding, classes(name, form_level, level))")
    .eq("profile_id", profileId);
  if (gErr) throw gErr;

  const kids = ((guardianRows ?? []) as unknown as { students: { id: string; full_name: string; admission_no: string; class_id: string; boarding: boolean; classes: { name: string; form_level: number; level: ClassLevel } } | null }[])
    .map((g) => g.students)
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => a.admission_no.localeCompare(b.admission_no));

  const studentIds = kids.map((k) => k.id);

  const [{ data: term }, { data: invoiceRows }, { data: attendanceRows }, examsByStudent] = await Promise.all([
    supabase().from("terms").select("id, name").eq("is_current", true).maybeSingle(),
    studentIds.length
      ? supabase().from("fee_invoices").select("id, student_id, total_cents, paid_cents, due_on").in("student_id", studentIds)
      : Promise.resolve({ data: [] as { id: string; student_id: string; total_cents: number; paid_cents: number; due_on: string }[] }),
    studentIds.length
      ? supabase().from("attendance").select("student_id, mark, taken_on").in("student_id", studentIds)
      : Promise.resolve({ data: [] as { student_id: string; mark: string; taken_on: string }[] }),
    // Each child's own list: an exam only one class's teachers have published must not stand in for this child's results.
    fetchPublishedExams(studentIds),
  ]);

  const [subjectsByStudent, { data: feeItemRows }, { data: paymentRows }, { data: announcementRows }, { data: readRows }] = await Promise.all([
    Promise.all(kids.map(async (k) => {
      const newest = examsByStudent.get(k.id)?.[0];
      return [k.id, newest ? await fetchExamSubjects(k.id, k.class_id, newest.id) : []] as const;
    })).then((pairs) => new Map<string, ChildSubject[]>(pairs)),
    term
      ? supabase().from("fee_items").select("id, name, amount_cents, applies_to, form_level, level").eq("term_id", term.id)
      : Promise.resolve({ data: [] as ParentData["feeItems"] }),
    studentIds.length
      ? supabase().from("payments").select("id, amount_cents, method, mpesa_receipt, reference, msisdn, completed_at, created_at, fee_invoices!inner(student_id)").in("fee_invoices.student_id", studentIds).eq("status", "success").order("completed_at", { ascending: false })
      : Promise.resolve({ data: [] as { id: string; amount_cents: number; method: Payment["method"]; mpesa_receipt: string | null; reference: string | null; msisdn: string | null; completed_at: string | null; created_at: string }[] }),
    supabase().from("announcements").select("id, subject, body, audience, published_at, created_at, profiles!announcements_author_id_fkey(full_name, role)").order("created_at", { ascending: false }),
    supabase().from("announcement_reads").select("announcement_id").eq("profile_id", profileId),
  ]);

  const readIds = new Set((readRows ?? []).map((r) => r.announcement_id as string));

  const invoices = new Map((invoiceRows ?? []).map((i) => [i.student_id, i]));
  const attendanceByStudent = new Map<string, { student_id: string; mark: string; taken_on: string }[]>();
  for (const a of (attendanceRows ?? []) as { student_id: string; mark: string; taken_on: string }[]) {
    const arr = attendanceByStudent.get(a.student_id) ?? [];
    arr.push(a);
    attendanceByStudent.set(a.student_id, arr);
  }
  const paymentsByStudent = new Map<string, Receipt[]>();
  for (const p of (paymentRows ?? []) as { id: string; amount_cents: number; method: Payment["method"]; mpesa_receipt: string | null; reference: string | null; msisdn: string | null; completed_at: string | null; created_at: string; fee_invoices: { student_id: string } | null }[]) {
    if (!p.fee_invoices) continue;
    const arr = paymentsByStudent.get(p.fee_invoices.student_id) ?? [];
    arr.push({
      id: p.id,
      amount: p.amount_cents,
      when: formatShortDate((p.completed_at ?? p.created_at).slice(0, 10)),
      ref: receiptRef(p),
    });
    paymentsByStudent.set(p.fee_invoices.student_id, arr);
  }

  const children: ChildInfo[] = kids.map((k) => {
    const inv = invoices.get(k.id);
    const rows = attendanceByStudent.get(k.id) ?? [];
    const present = rows.filter((r) => r.mark === "present" || r.mark === "late").length;
    const absentDates = rows.filter((r) => r.mark === "absent").sort((a, b) => a.taken_on.localeCompare(b.taken_on)).map((r) => r.taken_on);
    const exams = examsByStudent.get(k.id) ?? [];
    const subjects = subjectsByStudent.get(k.id) ?? [];

    return {
      id: k.id,
      name: k.full_name,
      first: k.full_name.split(" ")[0]!,
      cls: k.classes?.name ?? "",
      adm: k.admission_no,
      classId: k.class_id,
      classLevel: k.classes?.level ?? "secondary",
      formLevel: k.classes?.form_level ?? 1,
      boarding: k.boarding,
      invoiceId: inv?.id ?? null,
      balance: inv ? Math.max(inv.total_cents - inv.paid_cents, 0) : 0,
      billed: inv ? inv.total_cents : 0,
      dueOn: inv?.due_on ?? null,
      attendancePct: rows.length ? Math.round((present / rows.length) * 100) : null,
      absentDates,
      mean: subjects.length ? Math.round(subjects.reduce((a, m) => a + m.score, 0) / subjects.length) : null,
      examId: exams[0]?.id ?? null,
      examName: exams[0]?.name ?? null,
      subjects,
      exams,
      receipts: paymentsByStudent.get(k.id) ?? [],
    };
  });

  // RLS (announcement_visible_to_me) already drops anything not addressed to
  // this parent; filtering again here keeps the inbox right for anything the
  // database lets through for other reasons, and is the same shared rule.
  const viewer: AudienceViewer = {
    profileId,
    role: "parent",
    classIds: [...new Set(children.map((c) => c.classId))],
    years: children.map((c) => ({ level: c.classLevel, year: c.formLevel })),
  };
  const messages: MessageInfo[] = ((announcementRows ?? []) as unknown as {
    id: string; subject: string; body: string; created_at: string;
    audience: Audience | null;
    profiles: { full_name: string; role: string } | null;
  }[])
    .filter((a) => audienceIncludes(a.audience, viewer))
    .map((a) => {
      const isTeacher = a.profiles?.role === "teacher";
      return {
        id: a.id,
        who: isTeacher ? "teacher" : "school",
        from: isTeacher ? (a.profiles?.full_name ?? "Class teacher") : "School office",
        subject: a.subject,
        when: formatWhen(a.created_at),
        unread: !readIds.has(a.id),
        body: a.body,
      };
    });

  return {
    children,
    feeItems: (feeItemRows ?? []) as ParentData["feeItems"],
    termLabel: term?.name ?? null,
    messages,
  };
}
