import type { ActivityCategory, ActivityRow, LearnerActivities } from "../activities";
import { attendanceFigures, countAttendance, type SessionEntry, type SignOutDay } from "../attendanceSession";
import type { CbeLearningAreaResult } from "../cbeData";
import type { EarlySignOut } from "../earlySignOut";
import type { ExamSubject, PublishedExam } from "../examResults";
import { receiptRef } from "../fees";
import type { FeeCharge } from "../feeCharges";
import { rubricFor, summariseStrands } from "../gradingSchemes";
import type { ChildHomework, HomeworkItem } from "../homework";
import type { InventoryCategory, InventoryIssueRow, IssueStatus, ItemCondition } from "../inventory";
import type { ChildInfo, ChildSubject, ParentData, Receipt } from "../parentData";
import type { PaymentProof } from "../paymentProofs";
import type { ClassLevel } from "../types";
import { apiClient } from "./client";
import type { components } from "./schema";

/**
 * What a parent reads about their own children on apps/api (the API side of parentData.ts, examResults.ts, cbeData.ts, homework.ts,
 * activities.ts, inventory.ts and earlySignOut.ts for the parent pages). Every read is
 * `GET /v1/tenants/{tenantId}/me/children...` and needs `resource.family.read`; which learners are "my children" is decided by the
 * server on every call (apps/api/docs/FAMILY-READS.md), so nothing here filters by guardian.
 *
 * Differences from Supabase, handled here rather than in the screens:
 *  - Money is `*_minor`; mapped to `*_cents`.
 *  - The API has no "current term" for a parent: "this term's invoice" is the newest invoice that is not voided.
 *  - A mark has its own `max_score`; the screens work in percent, so a mark is turned into a percentage (and keeps the raw score).
 *  - Marks are per subject and per assessment: an "exam" is the assessments of one title in one term.
 *  - The child's class carries no education level, so it is read from the class name and year (see `levelOfChildClass`).
 *  - The API caps every list; nothing here pages (one child's lists are small).
 */

export type FamilyChild = components["schemas"]["FamilyChild"];
type FamilyAttendance = components["schemas"]["FamilyAttendance"];
type FamilyResults = components["schemas"]["FamilyResults"];
type FamilyInvoice = components["schemas"]["FamilyInvoice"];
type FamilyHomework = components["schemas"]["FamilyHomework"];
type FamilyMaterial = components["schemas"]["FamilyMaterial"];
type FamilyActivity = components["schemas"]["FamilyActivity"];
type FamilyItem = components["schemas"]["FamilyItem"];
type FamilyReportCard = components["schemas"]["FamilyReportCard"];

export function familyTenantId(): string {
  const id = apiClient().activeTenant();
  if (!id) throw new Error("No active school selected.");
  return id;
}

// ---------------------------------------------------------------- reads, one call each

export async function apiFetchChildren(): Promise<FamilyChild[]> {
  const tenantId = familyTenantId();
  const res = await apiClient().get("/v1/tenants/{tenantId}/me/children", { path: { tenantId }, tenantId });
  return res.children;
}

export async function apiFetchChildAttendance(learnerId: string, range?: { from?: string; to?: string }): Promise<FamilyAttendance> {
  const tenantId = familyTenantId();
  const res = await apiClient().get("/v1/tenants/{tenantId}/me/children/{learnerId}/attendance", { path: { tenantId, learnerId }, query: range, tenantId });
  return res.attendance;
}

export function apiFetchChildResults(learnerId: string, termId?: string): Promise<FamilyResults> {
  const tenantId = familyTenantId();
  return apiClient().get("/v1/tenants/{tenantId}/me/children/{learnerId}/results", { path: { tenantId, learnerId }, query: termId ? { termId } : undefined, tenantId });
}

export async function apiFetchChildFees(learnerId: string): Promise<FamilyInvoice[]> {
  const tenantId = familyTenantId();
  const res = await apiClient().get("/v1/tenants/{tenantId}/me/children/{learnerId}/fees", { path: { tenantId, learnerId }, tenantId });
  return res.invoices;
}

// ---------------------------------------------------------------- the child's class

const shortDate = (dateOnly: string): string => new Date(`${dateOnly}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/**
 * The API's class has a year and a name but no education level (finding 23), and the level picks the grading scheme and whether the
 * child is on the CBE rubric. Read it from the class's own name where it says ("Form 2 West", "Grade 4", "PP1"), then from the year
 * where the year is unambiguous (7 to 12 are CBE junior and senior school; 5 and 6 can only be primary), and for years 1 to 4, which
 * are a Form, a primary Grade or a pre-primary year, from what the child has results in: strand levels and no exam marks is CBE.
 * Anything else is read as the 8-4-4 Form, as the app always read a class with no level.
 */
export function levelOfChildClass(cls: { name: string; form_level: number | null } | null, evidence: { cbe: boolean; marks: boolean } = { cbe: false, marks: false }): ClassLevel {
  if (!cls) return "secondary";
  const name = cls.name;
  if (/\bform\b/i.test(name)) return "secondary";
  if (/\bpp\s?[12]\b/i.test(name)) return "pre_primary";
  const year = cls.form_level;
  if (year !== null) {
    if (year >= 10) return "senior_school";
    if (year >= 7) return "junior_secondary";
    if (year >= 5) return "primary";
  }
  if (/\bgrade\b/i.test(name)) return year !== null && year >= 7 ? "junior_secondary" : "primary";
  if (evidence.cbe && !evidence.marks) return "primary";
  return "secondary";
}

// ---------------------------------------------------------------- marks

const round1 = (n: number) => Math.round(n * 10) / 10;

/** A mark as the screens read it: a percentage, with the raw score kept so a paper marked out of 50 still says "40 / 50". */
export function subjectFromMark(m: FamilyResults["marks"][number]): ChildSubject {
  const max = Number(m.max_score);
  const score = Number(m.score);
  const percent = (v: number) => (max > 0 ? round1((v / max) * 100) : v);
  const mean = m.class_mean === null ? null : Number(m.class_mean);
  return {
    name: m.subject.name,
    score: percent(score),
    classMean: mean === null || Number.isNaN(mean) ? null : percent(mean),
    grade: m.grade,
    rawScore: score,
    maxScore: max,
  };
}

interface ExamGroup { exam: PublishedExam; subjects: ChildSubject[]; publishedAt: string }

/** An exam is the assessments of one title in one term. Newest first (by when the first of them went out), then by name. */
export function groupExams(marks: FamilyResults["marks"]): ExamGroup[] {
  const terms = new Set(marks.map((m) => m.term.id));
  const groups = new Map<string, ExamGroup>();
  for (const m of marks) {
    const id = `${m.term.id}|${m.kind}|${m.title}`;
    const published = m.published_at ?? "";
    const g = groups.get(id) ?? { exam: { id, name: terms.size > 1 ? `${m.title}, ${m.term.label}` : m.title, subjectCount: 0 }, subjects: [], publishedAt: published };
    g.exam.subjectCount += 1;
    g.subjects.push(subjectFromMark(m));
    if (published > g.publishedAt) g.publishedAt = published;
    groups.set(id, g);
  }
  const out = [...groups.values()];
  for (const g of out) g.subjects.sort((a, b) => a.name.localeCompare(b.name));
  return out.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.exam.name.localeCompare(b.exam.name));
}

/** One child's marks of one exam (as `groupExams` named it): the API side of `fetchExamSubjects`. */
export async function apiFetchExamSubjects(studentId: string, examId: string): Promise<ExamSubject[]> {
  const results = await apiFetchChildResults(studentId);
  return groupExams(results.marks).find((g) => g.exam.id === examId)?.subjects.map((s) => ({ name: s.name, score: s.score, classMean: s.classMean })) ?? [];
}

// ---------------------------------------------------------------- CBE results

/** The child's published strand results, per learning area the latest assessment (as `loadPublishedCbeResults` does on Supabase). */
export function cbeAreasFromResults(cbe: FamilyResults["cbe_results"], country: string, level: ClassLevel): CbeLearningAreaResult[] {
  const rubric = rubricFor(country, level) ?? [];
  const latest = new Map<string, { id: string; on: string }>();
  for (const r of cbe) {
    const on = r.assessment_date ?? r.published_at?.slice(0, 10) ?? "";
    const cur = latest.get(r.learning_area.id);
    if (!cur || on > cur.on || (on === cur.on && r.cbe_assessment_id > cur.id)) latest.set(r.learning_area.id, { id: r.cbe_assessment_id, on });
  }
  const byArea = new Map<string, CbeLearningAreaResult>();
  for (const r of cbe) {
    if (latest.get(r.learning_area.id)?.id !== r.cbe_assessment_id) continue;
    const area = byArea.get(r.learning_area.id) ?? {
      subjectId: r.learning_area.id,
      subjectName: r.learning_area.name,
      assessmentTitle: r.title,
      assessedOn: r.assessment_date ?? r.published_at?.slice(0, 10) ?? "",
      // The family read does not say whether the assessment was formative or summative; no screen shows it.
      kind: "summative" as const,
      overall: null,
      strands: [],
      comment: r.teacher_feedback,
    };
    area.strands.push({
      strandId: r.strand?.id ?? `${r.cbe_assessment_id}:overall`,
      name: r.strand?.name ?? "Overall",
      code: r.level_code,
      label: rubric.find((l) => l.code === r.level_code)?.label ?? r.level_code,
    });
    if (!area.comment && r.teacher_feedback) area.comment = r.teacher_feedback;
    byArea.set(r.learning_area.id, area);
  }
  const out = [...byArea.values()];
  for (const a of out) {
    a.strands.sort((x, y) => x.name.localeCompare(y.name));
    a.overall = summariseStrands(a.strands.map((s) => s.code), rubric).overall;
  }
  return out.sort((a, b) => a.subjectName.localeCompare(b.subjectName));
}

export async function apiLoadPublishedCbeResults(studentIds: string[], country: string, opts: { termId?: string } = {}): Promise<Map<string, CbeLearningAreaResult[]>> {
  const out = new Map<string, CbeLearningAreaResult[]>();
  if (!studentIds.length) return out;
  const children = new Map((await apiFetchChildren()).map((c) => [c.learner_id, c]));
  await Promise.all(studentIds.map(async (id) => {
    const child = children.get(id);
    if (!child) return;
    const results = await apiFetchChildResults(id, opts.termId);
    const level = levelOfChildClass(child.class, { cbe: results.cbe_results.length > 0, marks: results.marks.length > 0 });
    const areas = cbeAreasFromResults(results.cbe_results, country, level);
    if (areas.length) out.set(id, areas);
  }));
  return out;
}

// ---------------------------------------------------------------- the whole picture (loadParentData)

/** The invoice a payment is made against: the newest one that is not voided. */
export function currentInvoice(invoices: FamilyInvoice[]): FamilyInvoice | null {
  return invoices.find((i) => i.voided_at === null && i.status !== "voided") ?? null;
}

export function chargesFromInvoice(inv: FamilyInvoice, studentId: string): FeeCharge[] {
  return inv.charges.map((c, i) => ({
    id: `${inv.id}:charge:${i}`, invoiceId: inv.id, studentId, amountCents: c.amount_minor, reason: c.reason, issueId: null,
    createdAt: c.created_at, voidedAt: null, voidReason: null,
  }));
}

export function receiptsFromInvoices(invoices: FamilyInvoice[]): Receipt[] {
  return invoices
    .filter((i) => i.voided_at === null)
    .flatMap((i) => i.payments)
    .filter((p) => p.status === "success")
    .sort((a, b) => (b.completed_at ?? b.created_at).localeCompare(a.completed_at ?? a.created_at))
    .map((p) => ({ id: p.id, amount: p.amount_minor, when: shortDate((p.completed_at ?? p.created_at).slice(0, 10)), ref: receiptRef({ method: p.method, mpesa_receipt: p.mpesa_receipt, reference: p.reference }) }));
}

/** Attendance as the Home page counts it: sessions with a mark, an afternoon absence after an early sign-out left out. */
export function attendanceOfChild(learnerId: string, a: FamilyAttendance): { pct: number | null; absentDates: string[] } {
  const entries: SessionEntry[] = a.marks.map((m) => ({ student_id: learnerId, taken_on: m.date, session: m.session, mark: m.mark }));
  const signOuts: SignOutDay[] = a.early_sign_outs.map((s) => ({ student_id: learnerId, taken_on: s.date, voided_at: null }));
  const left = new Set(signOuts.map((s) => s.taken_on));
  const absent = new Set<string>();
  for (const e of entries) if (e.mark === "absent" && !(e.session === "afternoon" && left.has(e.taken_on))) absent.add(e.taken_on);
  return { pct: attendanceFigures(countAttendance(entries, "session", signOuts)).pct, absentDates: [...absent].sort() };
}

export async function apiLoadParentData(): Promise<ParentData> {
  const kids = [...(await apiFetchChildren())].sort((a, b) => a.admission_no.localeCompare(b.admission_no));
  const per = await Promise.all(kids.map(async (k) => {
    const [invoices, attendance, results] = await Promise.all([apiFetchChildFees(k.learner_id), apiFetchChildAttendance(k.learner_id), apiFetchChildResults(k.learner_id)]);
    return { k, invoices, attendance, results };
  }));

  let termLabel: string | null = null;
  const children: ChildInfo[] = per.map(({ k, invoices, attendance, results }) => {
    const inv = currentInvoice(invoices);
    if (inv && !termLabel) termLabel = inv.term.label;
    const exams = groupExams(results.marks);
    const subjects = exams[0]?.subjects ?? [];
    const att = attendanceOfChild(k.learner_id, attendance);
    const level = levelOfChildClass(k.class, { cbe: results.cbe_results.length > 0, marks: results.marks.length > 0 });
    return {
      id: k.learner_id,
      name: k.full_name,
      first: k.full_name.split(" ")[0] ?? k.full_name,
      cls: k.class?.name ?? "",
      adm: k.admission_no,
      classId: k.class?.id ?? "",
      classLevel: level,
      formLevel: k.class?.form_level ?? 1,
      boarding: k.boarding,
      invoiceId: inv?.id ?? null,
      balance: inv ? Math.max(inv.balance_minor, 0) : 0,
      billed: inv ? inv.total_minor : 0,
      charges: inv ? chargesFromInvoice(inv, k.learner_id) : [],
      feeLines: inv ? inv.lines.map((l, i) => ({ id: `${inv.id}:line:${i}`, name: l.name, amountCents: l.amount_minor })) : [],
      dueOn: inv?.due_on ?? null,
      attendancePct: att.pct,
      absentDates: att.absentDates,
      mean: subjects.length ? Math.round(subjects.reduce((sum, s) => sum + s.score, 0) / subjects.length) : null,
      examId: exams[0]?.exam.id ?? null,
      examName: exams[0]?.exam.name ?? null,
      subjects,
      exams: exams.map((g) => g.exam),
      receipts: receiptsFromInvoices(invoices),
      proofs: inv ? inv.proofs.map((p): PaymentProof => ({
        id: p.id, invoice_id: inv.id, file_path: null, file_name: p.file_name, note: p.note, status: p.status, uploaded_at: p.created_at,
        txn_code: p.txn_code, txn_amount_cents: p.txn_amount_minor, rejection_reason: p.rejection_reason,
      })) : [],
    };
  });

  return { children, feeItems: [], termLabel, messages: [] };
}

// ---------------------------------------------------------------- homework

const homeworkItem = (h: FamilyHomework): HomeworkItem => ({
  id: h.id, title: h.title, body: h.body, subject: h.subject.name, teacher: "", dueOn: h.due_on, handIn: null, guide: null,
  done: false, doneBy: null, hasFile: false,
});

/** Homework of each child's class, due in the last three weeks or later (the API's default window). Nothing says whether it was done. */
export async function apiLoadParentHomework(studentIds: string[]): Promise<Record<string, ChildHomework>> {
  const tenantId = familyTenantId();
  const out: Record<string, ChildHomework> = {};
  await Promise.all(studentIds.map(async (id) => {
    const res = await apiClient().get("/v1/tenants/{tenantId}/me/children/{learnerId}/homework", { path: { tenantId, learnerId: id }, tenantId });
    out[id] = { studentId: id, parentMarksDone: false, items: res.homework.map(homeworkItem) };
  }));
  return out;
}

// ---------------------------------------------------------------- materials

export interface FamilyMaterialView {
  id: string;
  title: string;
  description: string | null;
  subject: string;
  createdAt: string;
  /** False until the school's files can be opened from the new system (A5): the title and note are all there is. */
  fileAvailable: boolean;
}

export async function apiFetchChildMaterials(learnerId: string): Promise<FamilyMaterialView[]> {
  const tenantId = familyTenantId();
  const res = await apiClient().get("/v1/tenants/{tenantId}/me/children/{learnerId}/materials", { path: { tenantId, learnerId }, tenantId });
  return res.materials.map((m: FamilyMaterial) => ({
    id: m.id, title: m.title, description: m.description, subject: m.subject?.name ?? "General", createdAt: m.created_at, fileAvailable: m.storage_status === "available",
  }));
}

// ---------------------------------------------------------------- activities

const ACTIVITY_CATEGORIES: readonly ActivityCategory[] = ["sport", "club", "arts", "other"];
const activityCategory = (c: string): ActivityCategory => ((ACTIVITY_CATEGORIES as readonly string[]).includes(c) ? (c as ActivityCategory) : "other");

export function activityFromFamily(a: FamilyActivity, tenantId: string): LearnerActivities["clubs"][number] {
  const activity: ActivityRow = {
    id: a.activity_id, tenantId, name: a.name, category: activityCategory(a.category), description: a.description,
    meetingSchedule: a.meeting_schedule, active: a.active, patrons: a.patrons.map((name) => ({ id: name, name })),
  };
  return { activity, role: a.role, joinedOn: a.joined_on };
}

/** Clubs and teams only: the family read has no fixtures, trips or awards (see `parentCapabilities().activityEvents`). */
export async function apiLoadLearnerActivities(studentId: string): Promise<LearnerActivities> {
  const tenantId = familyTenantId();
  const res = await apiClient().get("/v1/tenants/{tenantId}/me/children/{learnerId}/activities", { path: { tenantId, learnerId: studentId }, tenantId });
  return {
    clubs: res.activities.map((a) => activityFromFamily(a, tenantId)).sort((a, b) => a.activity.name.localeCompare(b.activity.name)),
    upcoming: [],
    achievements: [],
  };
}

// ---------------------------------------------------------------- issued items

const CATEGORIES: readonly InventoryCategory[] = ["textbooks", "furniture", "lab_equipment", "sports", "ict", "uniforms", "music", "kitchen", "stationery", "tools", "medical", "other"];
const CONDITIONS: readonly ItemCondition[] = ["new", "good", "fair", "poor", "broken"];
const STATUSES: readonly IssueStatus[] = ["out", "returned", "damaged", "lost"];

export function issueFromFamilyItem(i: FamilyItem, learnerId: string, learnerName: string, admissionNo: string, tenantId: string): InventoryIssueRow {
  const asCondition = (v: string | null): ItemCondition | null => ((CONDITIONS as readonly string[]).includes(v ?? "") ? (v as ItemCondition) : null);
  return {
    id: i.id, tenant_id: tenantId, item_id: i.id, student_id: learnerId, profile_id: null, quantity: i.quantity, issued_by: null, issued_at: i.issued_at,
    due_on: i.due_on, condition_out: asCondition(i.condition_out), status: (STATUSES as readonly string[]).includes(i.status) ? (i.status as IssueStatus) : "out",
    returned_condition: asCondition(i.returned_condition), closed_at: i.closed_at, note: null,
    itemName: i.item.name, itemCategory: (CATEGORIES as readonly string[]).includes(i.item.category) ? (i.item.category as InventoryCategory) : "other",
    assetTag: i.item.asset_tag, holderName: learnerName, holderKind: "learner", holderDetail: `ADM ${admissionNo}`, issuedByName: null,
  };
}

export async function apiFetchLearnerInventory(studentIds: string[]): Promise<InventoryIssueRow[]> {
  if (!studentIds.length) return [];
  const tenantId = familyTenantId();
  const children = new Map((await apiFetchChildren()).map((c) => [c.learner_id, c]));
  const lists = await Promise.all(studentIds.map(async (id) => {
    const child = children.get(id);
    if (!child) return [];
    const res = await apiClient().get("/v1/tenants/{tenantId}/me/children/{learnerId}/items", { path: { tenantId, learnerId: id }, tenantId });
    return res.items.map((i) => issueFromFamilyItem(i, id, child.full_name, child.admission_no, tenantId));
  }));
  return lists.flat().sort((a, b) => b.issued_at.localeCompare(a.issued_at));
}

// ---------------------------------------------------------------- today's early sign-out

/** Today's early sign-outs of these children, as the Home page shows them (never the collector's ID or phone: the API sends neither). */
export async function apiFetchChildEarlySignOuts(studentIds: string[], day: string): Promise<EarlySignOut[]> {
  const tenantId = familyTenantId();
  const children = new Map((await apiFetchChildren()).map((c) => [c.learner_id, c]));
  const lists = await Promise.all(studentIds.map(async (id) => {
    const child = children.get(id);
    if (!child) return [];
    const a = await apiFetchChildAttendance(id, { from: day, to: day });
    return a.early_sign_outs.filter((s) => s.date === day).map((s): EarlySignOut => ({
      id: s.id, tenant_id: tenantId, student_id: id, class_id: child.class?.id ?? null, student_name: child.full_name, class_name: child.class?.name ?? null,
      taken_on: s.date, signed_out_at: s.signed_out_at,
      // The API gives the instant, not the school's wall clock: the browser's own clock is the nearest the family has.
      signed_out_local: new Date(s.signed_out_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }),
      reason: s.reason, collected_by_name: s.collected_by_name, collected_by_relationship: s.collected_by_relationship,
      recorded_by: null, recorded_at: s.signed_out_at, voided_at: null,
    }));
  }));
  return lists.flat();
}

// ---------------------------------------------------------------- report cards

export interface FamilyReportCardView {
  id: string;
  termLabel: string;
  className: string;
  publishedAt: string;
  method: string | null;
  gradingSchemeName: string | null;
  /** The child's own total, count, average and grade at publication; null when the child had no mark. */
  summary: { sum: number; count: number; average: number | null; grade: string | null } | null;
  cbe: { title: string; levelCode: string; points: number; feedback: string | null }[];
  competencies: { kind: string; item: string; levelCode: string }[];
}

export function reportCardFromFamily(r: FamilyReportCard): FamilyReportCardView {
  return {
    id: r.id, termLabel: r.term.label, className: r.class.name, publishedAt: r.published_at, method: r.method, gradingSchemeName: r.grading_scheme_name,
    summary: r.summary ? { sum: Number(r.summary.sum), count: r.summary.count, average: r.summary.average === null ? null : Number(r.summary.average), grade: r.summary.grade } : null,
    cbe: r.cbe_results.map((c) => ({ title: c.title, levelCode: c.level_code, points: Number(c.points), feedback: c.teacher_feedback })),
    competencies: r.competencies.map((c) => ({ kind: c.kind, item: c.item, levelCode: c.level_code })),
  };
}

export async function apiFetchChildReportCards(learnerId: string): Promise<FamilyReportCardView[]> {
  const tenantId = familyTenantId();
  const res = await apiClient().get("/v1/tenants/{tenantId}/me/children/{learnerId}/report-cards", { path: { tenantId, learnerId }, tenantId });
  return res.report_cards.map(reportCardFromFamily).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}
