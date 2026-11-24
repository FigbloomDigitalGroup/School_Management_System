import type { ClassOption } from "../performanceData";
import {
  learnerTrend, type ClassPerformanceRow, type LearnerHistoryRow, type LearnerMeanRow, type LearnerTrend,
} from "../performance";
import { apiFetchClassRoster } from "./attendanceApi";
import { apiClient } from "./client";
import { examIdOf, examPapersOf, listAssessments, listMarksOf, numberOf } from "./gradesApi";
import { isApiError } from "./errors";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import { settlePool } from "./pool";
import type { components } from "./schema";
import { classGroupFromApi, currentAcademicYear, listAcademicTerms, listApiSubjects, listClasses } from "./setupApi";

/**
 * Performance over time on apps/api (the grades slice): the API side of performanceData.ts.
 *
 * Supabase worked these figures out in the database (class_exam_performance and friends). The API has no such report (its
 * academics summary is counts only), so they are worked out here from the papers (assessments of kind "exam") that are out
 * (published or closed) and their marks. Like Supabase, only published results count, so an exam still being entered never
 * pulls a mean down. A paper is out of its own `max_score`, so every mark is turned into a percentage first: a mean over
 * exams with different totals is then still a mean.
 *
 * What a person may read decides what they get: classes and papers of the classes a plain teacher teaches are readable,
 * but the term names and the subjects need the Academics area and the learners' names need the People area. A person who
 * may not read them is told, not shown a guess.
 */

type ApiAssessment = components["schemas"]["Assessment"];
type ApiMark = components["schemas"]["Mark"];

/** Reads at once. */
const READ_CONCURRENCY = 6;

function tenantIdOrThrow(tenantId?: string): string {
  const id = tenantId ?? apiClient().activeTenant();
  if (!id) throw new Error("No active school selected.");
  return id;
}

export const PERFORMANCE_REFUSED =
  "The new system does not let you read this school's terms and subjects with the access you have, so results over time cannot be shown to you yet. Ask the school office to give you the Academics area.";

const round1 = (n: number) => Math.round(n * 10) / 10;
const percent = (score: number, max: number) => (max > 0 ? (score * 100) / max : 0);

// ---------------------------------------------------------------- published marks (kept briefly: a published paper's marks are final)

const MARKS_TTL_MS = 60_000;
const marksCache = new Map<string, { at: number; marks: ApiMark[] }>();

/** Forgets the marks read so far (tests, and signing out). */
export function clearPublishedMarksCache(): void {
  marksCache.clear();
}

async function publishedMarksOf(tenantId: string, papers: readonly ApiAssessment[]): Promise<Map<string, ApiMark[]>> {
  const out = new Map<string, ApiMark[]>();
  const now = Date.now();
  const todo: ApiAssessment[] = [];
  for (const p of papers) {
    const hit = marksCache.get(`${tenantId}:${p.id}`);
    if (hit && now - hit.at < MARKS_TTL_MS) out.set(p.id, hit.marks);
    else todo.push(p);
  }
  const settled = await settlePool(todo, READ_CONCURRENCY, (p) => listMarksOf(tenantId, p.id));
  for (const [i, s] of settled.entries()) {
    // A paper whose marks cannot be read stops the whole figure: a mean over only some of the papers would be wrong.
    if (!s.ok) throw s.error;
    marksCache.set(`${tenantId}:${todo[i]!.id}`, { at: now, marks: s.value });
    out.set(todo[i]!.id, s.value);
  }
  return out;
}

/** The exam papers that are out (published or closed), optionally of one class. */
async function papersOut(tenantId: string, classId?: string): Promise<ApiAssessment[]> {
  return examPapersOf(await listAssessments(tenantId, { classId })).filter((a) => a.status !== "draft");
}

async function termsById(tenantId: string): Promise<Map<string, { label: string; starts_on: string }>> {
  try {
    return new Map((await listAcademicTerms(tenantId)).map((t) => [t.id, { label: t.label, starts_on: t.starts_on }]));
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") throw new Error(PERFORMANCE_REFUSED);
    throw err;
  }
}

async function subjectNames(tenantId: string): Promise<Map<string, string>> {
  try {
    return new Map((await listApiSubjects(tenantId)).map((s) => [s.id, s.name]));
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") throw new Error(PERFORMANCE_REFUSED);
    throw err;
  }
}

/** Who teaches each class and subject now, by name; a person who may not read staff gets the subjects without teachers. */
async function teachersByClassSubject(tenantId: string): Promise<Map<string, { id: string; name: string | null }>> {
  const out = new Map<string, { id: string; name: string | null }>();
  try {
    const [assignments, staff] = await Promise.all([
      listAllPages(async (cursor) => {
        const r = await apiClient().get("/v1/tenants/{tenantId}/teaching-assignments", { path: { tenantId }, query: { active: true, limit: API_PAGE_LIMIT, cursor }, tenantId });
        return { items: r.assignments, page: r.page };
      }),
      listAllPages(async (cursor) => {
        const r = await apiClient().get("/v1/tenants/{tenantId}/staff", { path: { tenantId }, query: { limit: API_PAGE_LIMIT, cursor }, tenantId });
        return { items: r.staff, page: r.page };
      }).catch((err: unknown) => {
        if (isApiError(err) && err.code === "forbidden") return null;
        throw err;
      }),
    ]);
    const names = new Map((staff ?? []).map((s) => [s.id, s.full_name]));
    for (const a of assignments) {
      if (a.active) out.set(`${a.class_id}|${a.subject_id}`, { id: a.staff_member_id, name: names.get(a.staff_member_id) ?? null });
    }
  } catch (err) {
    if (!(isApiError(err) && err.code === "forbidden")) throw err;
  }
  return out;
}

// ---------------------------------------------------------------- the pure part

export interface PerformanceInput {
  papers: readonly ApiAssessment[];
  marks: ReadonlyMap<string, readonly ApiMark[]>;
  terms: ReadonlyMap<string, { label: string; starts_on: string }>;
  classNames: ReadonlyMap<string, string>;
  subjectNames: ReadonlyMap<string, string>;
  teachers: ReadonlyMap<string, { id: string; name: string | null }>;
}

/** When an exam first went out: the earliest publication of any of its papers (like Supabase's exam-level date). */
function publishedAtByExam(papers: readonly ApiAssessment[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of papers) {
    if (!p.published_at) continue;
    const id = examIdOf(p.term_id, p.title);
    const cur = out.get(id);
    if (!cur || p.published_at < cur) out.set(id, p.published_at);
  }
  return out;
}

/** A row per exam, class and subject: how many marks, their mean and each mark, as percentages. Papers with no marks have no row. */
export function classPerformanceRows(input: PerformanceInput): ClassPerformanceRow[] {
  const firstOut = publishedAtByExam(input.papers);
  const rows: ClassPerformanceRow[] = [];
  for (const p of input.papers) {
    const max = numberOf(p.max_score);
    const scores = (input.marks.get(p.id) ?? []).map((m) => round1(percent(numberOf(m.score), max))).sort((a, b) => a - b);
    if (scores.length === 0) continue;
    const term = input.terms.get(p.term_id);
    const teacher = input.teachers.get(`${p.class_id}|${p.subject_id}`);
    rows.push({
      exam_id: examIdOf(p.term_id, p.title), exam_name: p.title, term_id: p.term_id, term_name: term?.label ?? "Term", term_starts_on: term?.starts_on ?? "",
      published_at: firstOut.get(examIdOf(p.term_id, p.title)) ?? p.published_at,
      class_id: p.class_id, class_name: input.classNames.get(p.class_id) ?? "Class", subject_id: p.subject_id, subject_name: input.subjectNames.get(p.subject_id) ?? "Subject",
      teacher_id: teacher?.id ?? null, teacher_name: teacher?.name ?? null,
      learners: scores.length, mean_score: round1(scores.reduce((a, s) => a + s, 0) / scores.length), scores,
    });
  }
  return rows;
}

/** Each learner's mean over the subjects of an exam, as percentages (the roster's learners only). */
export function learnerMeanRows(papers: readonly ApiAssessment[], marks: ReadonlyMap<string, readonly ApiMark[]>, names: ReadonlyMap<string, string>): LearnerMeanRow[] {
  const byKey = new Map<string, { exam_id: string; student_id: string; scores: number[] }>();
  for (const p of papers) {
    const max = numberOf(p.max_score);
    const examId = examIdOf(p.term_id, p.title);
    for (const m of marks.get(p.id) ?? []) {
      if (!names.has(m.learner_id)) continue;
      const key = `${examId}|${m.learner_id}`;
      const cur = byKey.get(key) ?? { exam_id: examId, student_id: m.learner_id, scores: [] };
      cur.scores.push(percent(numberOf(m.score), max));
      byKey.set(key, cur);
    }
  }
  return [...byKey.values()].map((r) => ({
    exam_id: r.exam_id, student_id: r.student_id, full_name: names.get(r.student_id)!,
    mean_score: round1(r.scores.reduce((a, s) => a + s, 0) / r.scores.length), subjects: r.scores.length,
  }));
}

/** One learner's published marks as history rows, with the class mean of each paper (every mark in it, as percentages). */
export function learnerHistoryRows(
  learnerId: string, papers: readonly ApiAssessment[], marks: ReadonlyMap<string, readonly ApiMark[]>,
  terms: ReadonlyMap<string, { label: string; starts_on: string }>, subjectNames: ReadonlyMap<string, string>,
): LearnerHistoryRow[] {
  const firstOut = publishedAtByExam(papers);
  const rows: LearnerHistoryRow[] = [];
  for (const p of papers) {
    const all = marks.get(p.id) ?? [];
    const mine = all.find((m) => m.learner_id === learnerId);
    if (!mine) continue;
    const max = numberOf(p.max_score);
    const term = terms.get(p.term_id);
    rows.push({
      exam_id: examIdOf(p.term_id, p.title), exam_name: p.title, term_id: p.term_id, term_name: term?.label ?? "Term", term_starts_on: term?.starts_on ?? "",
      published_at: firstOut.get(examIdOf(p.term_id, p.title)) ?? p.published_at,
      subject_id: p.subject_id, subject_name: subjectNames.get(p.subject_id) ?? "Subject",
      score: round1(percent(numberOf(mine.score), max)),
      class_mean: round1(all.reduce((a, m) => a + percent(numberOf(m.score), max), 0) / all.length),
    });
  }
  return rows;
}

// ---------------------------------------------------------------- what performanceData.ts calls

export async function apiFetchClassOptions(tenantId: string): Promise<ClassOption[]> {
  const year = await currentAcademicYear(tenantId);
  const classes = await listClasses(tenantId, year?.id);
  return classes
    .map((c) => classGroupFromApi(c, tenantId))
    .map(({ id, name, level, form_level }) => ({ id, name, level, form_level }))
    .sort((a, b) => a.form_level - b.form_level || a.name.localeCompare(b.name));
}

/** The class's learners by name; empty for someone who may not read learners (the pages then leave the learner views out). */
export async function apiFetchClassLearnerNames(classId: string): Promise<{ id: string; full_name: string }[]> {
  try {
    return (await apiFetchClassRoster(classId)).map((s) => ({ id: s.id, full_name: s.full_name }));
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") return [];
    throw err;
  }
}

export async function apiFetchClassPerformance(tenantId: string, classId: string | null): Promise<ClassPerformanceRow[]> {
  const tid = tenantIdOrThrow(tenantId);
  const papers = await papersOut(tid, classId ?? undefined);
  if (papers.length === 0) return [];
  const [marks, terms, subjects, classes, teachers] = await Promise.all([
    publishedMarksOf(tid, papers), termsById(tid), subjectNames(tid), listClasses(tid), teachersByClassSubject(tid),
  ]);
  return classPerformanceRows({ papers, marks, terms, classNames: new Map(classes.map((c) => [c.id, c.name])), subjectNames: subjects, teachers });
}

export async function apiFetchClassLearnerMeans(classId: string, tenantId?: string): Promise<LearnerMeanRow[]> {
  const tid = tenantIdOrThrow(tenantId);
  const names = new Map((await apiFetchClassLearnerNames(classId)).map((l) => [l.id, l.full_name]));
  if (names.size === 0) return [];
  const papers = await papersOut(tid, classId);
  if (papers.length === 0) return [];
  return learnerMeanRows(papers, await publishedMarksOf(tid, papers), names);
}

export async function apiFetchLearnerTrend(learnerId: string, tenantId?: string): Promise<LearnerTrend> {
  const tid = tenantIdOrThrow(tenantId);
  const memberships = await listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/class-memberships", { path: { tenantId: tid }, query: { learnerId, active: true, limit: API_PAGE_LIMIT, cursor }, tenantId: tid });
    return { items: r.memberships, page: r.page };
  });
  const classIds = [...new Set(memberships.map((m) => m.class_id))];
  const papers = (await Promise.all(classIds.map((id) => papersOut(tid, id)))).flat();
  if (papers.length === 0) return learnerTrend([]);
  const [marks, terms, subjects] = await Promise.all([publishedMarksOf(tid, papers), termsById(tid), subjectNames(tid)]);
  return learnerTrend(learnerHistoryRows(learnerId, papers, marks, terms, subjects));
}
