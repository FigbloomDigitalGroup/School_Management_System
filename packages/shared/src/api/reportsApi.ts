import type { TermReport } from "../adminOverview";
import { gradingSchemeFor, type GradingSchemeId } from "../gradingSchemes";
import type { Exam } from "../types";
import { apiFetchAttendanceSettings } from "./attendanceApi";
import { apiClient } from "./client";
import { examFromGroup, groupExams, listAssessments, listMarksOf, numberOf } from "./gradesApi";
import { listClassesOrEmpty, listInvoicesForTerm, listLearnersOrEmpty, listMembershipsOrEmpty, apiFetchTenantCurrentTerm } from "./feesApi";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import { settlePool } from "./pool";
import type { components } from "./schema";
import { classGroupFromApi } from "./setupApi";

/**
 * The admin Reports page on apps/api (the grades slice): the API side of `fetchTermReport` in adminOverview.ts.
 *
 * Supabase added the term up in the database (`term_class_figures`). The API's reports are whole-school counts (`/reports/overview`,
 * `/reports/finance-summary`, `/reports/academics-summary`), with nothing by class, so the figures are worked out here from the term's
 * own rows: `/attendance-counted` for attendance, the term's invoices for fees, and the marks of the latest published exam. Each is
 * read a page of 200 at a time, so a big school waits longer than it did on Supabase (finding 25 in docs/WEB_ON_THE_NEW_API.md).
 *
 * Differences from Supabase worth knowing:
 *  - Attendance counts the school's own way (`/attendance-counted` follows the attendance setting: one entry per register entry, or
 *    one per learner and day), and a live early sign-out drops an afternoon absence, which the register itself does not.
 *  - A class mean is made from published papers only (Supabase's counted any entered mark, FIG-1441), as percentages of each paper's
 *    own total.
 */

type ApiMark = components["schemas"]["Mark"];

const round = Math.round;

/** One entry of /attendance-counted: a learner here or not for a day (or session). */
export interface CountedEntry { class_id: string; here: boolean }

export async function listCountedAttendance(tenantId: string, termId: string): Promise<CountedEntry[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/attendance-counted", { path: { tenantId }, query: { termId, limit: API_PAGE_LIMIT, cursor }, tenantId });
    return { items: r.entries.map((e) => ({ class_id: e.class_id, here: e.here })), page: r.page };
  });
}

/** The pure part: the term's figures by class. */
export function termFigures(input: {
  classIds: readonly string[];
  attendance: readonly CountedEntry[];
  invoices: readonly { learner_id: string; total_minor: number; paid_minor: number }[];
  /** The class each active learner is in now; invoices of anyone else count for no class (as Supabase counted only active learners'). */
  classOfLearner: ReadonlyMap<string, string>;
}): { attendance: Map<string, { present: number; total: number }>; fees: Map<string, { billed: number; paid: number }> } {
  const attendance = new Map<string, { present: number; total: number }>(input.classIds.map((id) => [id, { present: 0, total: 0 }]));
  for (const e of input.attendance) {
    const a = attendance.get(e.class_id);
    if (!a) continue;
    a.total += 1;
    if (e.here) a.present += 1;
  }
  const fees = new Map<string, { billed: number; paid: number }>(input.classIds.map((id) => [id, { billed: 0, paid: 0 }]));
  for (const i of input.invoices) {
    const cls = input.classOfLearner.get(i.learner_id);
    const f = cls ? fees.get(cls) : undefined;
    if (!f) continue;
    f.billed += i.total_minor;
    f.paid += i.paid_minor;
  }
  return { attendance, fees };
}

/** Each class's mean of one exam's published marks (as percentages), the learners marked and the roster. */
export function classMeans(input: {
  papers: readonly { id: string; class_id: string; max_score: string }[];
  marks: ReadonlyMap<string, readonly ApiMark[]>;
  rosterByClass: ReadonlyMap<string, number>;
  levelOf: ReadonlyMap<string, GradingSchemeId>;
}): TermReport["meanByClass"] {
  const sums = new Map<string, { sum: number; count: number; learners: Set<string> }>();
  for (const p of input.papers) {
    const max = numberOf(p.max_score);
    const cur = sums.get(p.class_id) ?? { sum: 0, count: 0, learners: new Set<string>() };
    for (const m of input.marks.get(p.id) ?? []) {
      cur.sum += max > 0 ? (numberOf(m.score) * 100) / max : 0;
      cur.count += 1;
      cur.learners.add(m.learner_id);
    }
    sums.set(p.class_id, cur);
  }
  const out: TermReport["meanByClass"] = new Map();
  for (const [classId, s] of sums) {
    if (s.count === 0) continue;
    out.set(classId, { mean: round(s.sum / s.count), marked: s.learners.size, roster: input.rosterByClass.get(classId) ?? 0, scheme: input.levelOf.get(classId) ?? "kcse" });
  }
  return out;
}

export async function apiFetchTermReport(tenantId: string, country: string): Promise<TermReport> {
  const term = await apiFetchTenantCurrentTerm(tenantId);
  const [classRows, settings] = await Promise.all([listClassesOrEmpty(tenantId), apiFetchAttendanceSettings(tenantId)]);
  const classes = classRows
    .map((c) => classGroupFromApi(c, tenantId))
    .map(({ id, name, form_level, level }) => ({ id, name, form_level, level }))
    .sort((a, b) => a.form_level - b.form_level || a.name.localeCompare(b.name));
  const empty: TermReport = {
    term, percentageMode: settings.percentage_mode, classes, attendanceByClass: new Map(), attendanceOverall: { present: 0, total: 0 },
    feeByClass: new Map(), feeOverall: { billed: 0, paid: 0 }, latestExam: null, meanByClass: new Map(),
  };
  if (!term) return empty;

  const [attendance, invoices, learners, memberships, termPapers] = await Promise.all([
    listCountedAttendance(tenantId, term.id), listInvoicesForTerm(tenantId, term.id), listLearnersOrEmpty(tenantId),
    listMembershipsOrEmpty(tenantId), listAssessments(tenantId, { termId: term.id }),
  ]);
  const activeLearners = new Set(learners.map((l) => l.id));
  const classOfLearner = new Map<string, string>();
  const rosterByClass = new Map<string, number>();
  for (const m of memberships) {
    if (!activeLearners.has(m.learner_id)) continue;
    classOfLearner.set(m.learner_id, m.class_id);
    rosterByClass.set(m.class_id, (rosterByClass.get(m.class_id) ?? 0) + 1);
  }
  const figures = termFigures({ classIds: classes.map((c) => c.id), attendance, invoices, classOfLearner });
  let present = 0; let total = 0; let billed = 0; let paid = 0;
  for (const a of figures.attendance.values()) { present += a.present; total += a.total; }
  for (const f of figures.fees.values()) { billed += f.billed; paid += f.paid; }

  // The latest exam to have gone out this term, and the marks of its published papers.
  const out = groupExams(termPapers).filter((g) => g.papers.some((p) => p.published_at));
  out.sort((a, b) => latest(b.papers.map((p) => p.published_at)).localeCompare(latest(a.papers.map((p) => p.published_at))));
  const group = out[0];
  let latestExam: Exam | null = null;
  let meanByClass: TermReport["meanByClass"] = new Map();
  if (group) {
    latestExam = examFromGroup(tenantId, group);
    const published = group.papers.filter((p) => p.status !== "draft");
    const marks = await marksOfPapers(tenantId, published.map((p) => p.id));
    meanByClass = classMeans({
      papers: published, marks, rosterByClass,
      levelOf: new Map(classes.map((c) => [c.id, gradingSchemeFor(country, c.level)])),
    });
  }
  return {
    term, percentageMode: settings.percentage_mode, classes,
    attendanceByClass: figures.attendance, attendanceOverall: { present, total },
    feeByClass: figures.fees, feeOverall: { billed, paid }, latestExam, meanByClass,
  };
}

const latest = (dates: (string | null)[]): string => dates.filter((d): d is string => !!d).sort().pop() ?? "";

/** The marks of each paper, a few papers at once. A paper that cannot be read stops the report: a mean over some of the papers would be wrong. */
async function marksOfPapers(tenantId: string, ids: readonly string[]): Promise<Map<string, ApiMark[]>> {
  const settled = await settlePool(ids, 6, (id) => listMarksOf(tenantId, id));
  const out = new Map<string, ApiMark[]>();
  settled.forEach((r, i) => {
    if (!r.ok) throw r.error;
    out.set(ids[i]!, r.value);
  });
  return out;
}
