import { supabase } from "./supabase";
import { classAudienceIncludes, type Audience, type ClassLevel } from "./types";
import { yearMatches } from "./levels";

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
  balance: number;
  billed: number;
  dueOn: string | null;
  attendancePct: number | null;
  absentDates: string[];
  mean: number | null;
  examName: string | null;
  subjects: ChildSubject[];
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

/** The real class-wide mean for every subject of one exam, computed server
 *  side (class_means_for_exam) — RLS only lets a parent/student read their
 *  own child's marks rows, so this can never be derived from a client-side
 *  SELECT without exposing other students' individual scores. */
export async function fetchClassMeans(examId: string, classId: string): Promise<Map<string, number>> {
  const { data, error } = await supabase().rpc("class_means_for_exam", { p_exam_id: examId, p_class_id: classId });
  if (error) throw error;
  return new Map((data as { subject_id: string; mean_score: number }[] ?? []).map((r) => [r.subject_id, r.mean_score]));
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
  const childClassIds = new Set(kids.map((k) => k.class_id));
  const childYears = kids.filter((k) => k.classes).map((k) => ({ level: k.classes!.level, year: k.classes!.form_level }));

  const [{ data: announcementRows, error: aErr }, { data: readRows, error: rErr }] = await Promise.all([
    supabase().from("announcements").select("id, audience"),
    supabase().from("announcement_reads").select("announcement_id").eq("profile_id", profileId),
  ]);
  if (aErr) throw aErr;
  if (rErr) throw rErr;

  const readIds = new Set((readRows ?? []).map((r) => r.announcement_id as string));
  return ((announcementRows ?? []) as { id: string; audience: Audience | null }[]).filter((a) => {
    if (readIds.has(a.id)) return false;
    const audience = a.audience;
    if (!audience) return false;
    switch (audience.kind) {
      case "whole_school": return true;
      case "role": return audience.role === "parent";
      case "class": return childClassIds.has(audience.class_id) && classAudienceIncludes(audience.recipients, "guardians");
      case "form_level": return childYears.some((y) => yearMatches({ level: audience.level, year: audience.form_level }, y));
      case "user": return audience.user_id === profileId;
    }
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
  const classIds = [...new Set(kids.map((k) => k.class_id))];

  const [{ data: term }, { data: invoiceRows }, { data: attendanceRows }, { data: examRows }] = await Promise.all([
    supabase().from("terms").select("id, name").eq("is_current", true).maybeSingle(),
    studentIds.length
      ? supabase().from("fee_invoices").select("student_id, total_cents, paid_cents, due_on").in("student_id", studentIds)
      : Promise.resolve({ data: [] as { student_id: string; total_cents: number; paid_cents: number; due_on: string }[] }),
    studentIds.length
      ? supabase().from("attendance").select("student_id, mark, taken_on").in("student_id", studentIds)
      : Promise.resolve({ data: [] as { student_id: string; mark: string; taken_on: string }[] }),
    supabase().from("exams").select("id, name, published_at").not("published_at", "is", null).order("published_at", { ascending: false }).limit(1),
  ]);

  const exam = (examRows ?? [])[0] as { id: string; name: string } | undefined;

  const [{ data: markRows }, classMeansByClass, { data: feeItemRows }, { data: paymentRows }, { data: announcementRows }, { data: readRows }] = await Promise.all([
    exam && studentIds.length
      ? supabase().from("marks").select("student_id, score, subject_id, subjects(name)").eq("exam_id", exam.id).in("student_id", studentIds)
      : Promise.resolve({ data: [] as { student_id: string; score: number | null; subject_id: string; subjects: { name: string } | null }[] }),
    exam && classIds.length
      ? Promise.all(classIds.map((cid) => fetchClassMeans(exam.id, cid)))
          .then((maps) => new Map(classIds.map((cid, i) => [cid, maps[i]!])))
      : Promise.resolve(new Map<string, Map<string, number>>()),
    term
      ? supabase().from("fee_items").select("id, name, amount_cents, applies_to, form_level, level").eq("term_id", term.id)
      : Promise.resolve({ data: [] as ParentData["feeItems"] }),
    studentIds.length
      ? supabase().from("payments").select("id, amount_cents, mpesa_receipt, msisdn, completed_at, created_at, fee_invoices!inner(student_id)").in("fee_invoices.student_id", studentIds).eq("status", "success").order("completed_at", { ascending: false })
      : Promise.resolve({ data: [] as { id: string; amount_cents: number; mpesa_receipt: string | null; msisdn: string | null; completed_at: string | null; created_at: string }[] }),
    supabase().from("announcements").select("id, subject, body, audience, published_at, created_at, profiles!announcements_author_id_fkey(full_name, role)").order("created_at", { ascending: false }),
    supabase().from("announcement_reads").select("announcement_id").eq("profile_id", profileId),
  ]);

  const readIds = new Set((readRows ?? []).map((r) => r.announcement_id as string));
  const meanFor = (classId: string, subjectId: string): number | null => classMeansByClass.get(classId)?.get(subjectId) ?? null;

  const invoices = new Map((invoiceRows ?? []).map((i) => [i.student_id, i]));
  const attendanceByStudent = new Map<string, { student_id: string; mark: string; taken_on: string }[]>();
  for (const a of (attendanceRows ?? []) as { student_id: string; mark: string; taken_on: string }[]) {
    const arr = attendanceByStudent.get(a.student_id) ?? [];
    arr.push(a);
    attendanceByStudent.set(a.student_id, arr);
  }
  const marksByStudent = new Map<string, { subject_id: string; score: number | null; subjects: { name: string } | null }[]>();
  for (const m of (markRows ?? []) as { student_id: string; score: number | null; subject_id: string; subjects: { name: string } | null }[]) {
    const arr = marksByStudent.get(m.student_id) ?? [];
    arr.push(m);
    marksByStudent.set(m.student_id, arr);
  }
  const paymentsByStudent = new Map<string, Receipt[]>();
  for (const p of (paymentRows ?? []) as { id: string; amount_cents: number; mpesa_receipt: string | null; msisdn: string | null; completed_at: string | null; created_at: string; fee_invoices: { student_id: string } | null }[]) {
    if (!p.fee_invoices) continue;
    const arr = paymentsByStudent.get(p.fee_invoices.student_id) ?? [];
    arr.push({
      id: p.id,
      amount: p.amount_cents,
      when: formatShortDate((p.completed_at ?? p.created_at).slice(0, 10)),
      ref: p.mpesa_receipt ?? "M-Pesa",
    });
    paymentsByStudent.set(p.fee_invoices.student_id, arr);
  }

  const children: ChildInfo[] = kids.map((k) => {
    const inv = invoices.get(k.id);
    const rows = attendanceByStudent.get(k.id) ?? [];
    const present = rows.filter((r) => r.mark === "present" || r.mark === "late").length;
    const absentDates = rows.filter((r) => r.mark === "absent").sort((a, b) => a.taken_on.localeCompare(b.taken_on)).map((r) => r.taken_on);
    const myMarks = (marksByStudent.get(k.id) ?? []).filter((m) => m.score !== null);
    const subjects: ChildSubject[] = myMarks.map((m) => ({
      name: m.subjects?.name ?? "Subject",
      score: m.score as number,
      classMean: meanFor(k.class_id, m.subject_id),
    }));

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
      balance: inv ? Math.max(inv.total_cents - inv.paid_cents, 0) : 0,
      billed: inv ? inv.total_cents : 0,
      dueOn: inv?.due_on ?? null,
      attendancePct: rows.length ? Math.round((present / rows.length) * 100) : null,
      absentDates,
      mean: myMarks.length ? Math.round(myMarks.reduce((a, m) => a + (m.score as number), 0) / myMarks.length) : null,
      examName: exam?.name ?? null,
      subjects,
      receipts: paymentsByStudent.get(k.id) ?? [],
    };
  });

  const childClassIds = new Set(children.map((c) => c.classId));
  const childYears = children.map((c) => ({ level: c.classLevel, year: c.formLevel }));
  const messages: MessageInfo[] = ((announcementRows ?? []) as unknown as {
    id: string; subject: string; body: string; created_at: string;
    audience: Audience | null;
    profiles: { full_name: string; role: string } | null;
  }[])
    .filter((a) => {
      const audience = a.audience;
      if (!audience) return false;
      switch (audience.kind) {
        case "whole_school": return true;
        case "role": return audience.role === "parent";
        case "class": return childClassIds.has(audience.class_id) && classAudienceIncludes(audience.recipients, "guardians");
        case "form_level": return childYears.some((y) => yearMatches({ level: audience.level, year: audience.form_level }, y));
        case "user": return audience.user_id === profileId; // e.g. a promotion/repeat notice addressed to this guardian personally
      }
    })
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
