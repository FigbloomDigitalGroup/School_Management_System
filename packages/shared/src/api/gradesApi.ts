import { NotOnApiError, type GradesAccess } from "../capabilities";
import type { Exam, Subject } from "../types";
import { apiClient } from "./client";
import { isApiError, userMessage } from "./errors";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import { settlePool } from "./pool";
import type { components } from "./schema";
import { permissionCodes } from "./sessionApi";
import { listAcademicTerms, listApiSubjects, listClasses, subjectFromApi } from "./setupApi";

/**
 * Exams and marks on apps/api (the grades slice): the API side of exams.ts and the marks functions of teacherData.ts.
 *
 * The API's model is not Supabase's, and the differences are handled here, not in the screens:
 *  - An exam is a name for the term ("Mock 1"). The API has no such record: it has an ASSESSMENT for each class and subject, with
 *    a title, a kind, a `max_score` and a status (draft, published, closed). So an exam here is every assessment of kind "exam"
 *    that has the same title in a term, and its id is `<termId>|<title>`. Making an exam makes one assessment for every class and
 *    subject that has a teacher.
 *  - The paper's total is the assessment's `max_score`, not a fixed 100.
 *  - Publishing is final and needs the Academics area; a published paper's marks are locked (a recorded correction is the only
 *    change). So "Withdraw results" does not exist, and a teacher who only has their classes can save marks but not publish.
 *  - A mark is a number; there is no "absent" mark. An absent learner simply has no mark.
 *  - There is no bulk write: marks are sent a few at a time, and a failure says how many were saved.
 */

type ApiAssessment = components["schemas"]["Assessment"];
type ApiMark = components["schemas"]["Mark"];

/** Marks sent at once (the API has no bulk write; the same limit as registers). */
export const MARK_WRITE_CONCURRENCY = 4;

function tenantIdOrThrow(tenantId?: string): string {
  const id = tenantId ?? apiClient().activeTenant();
  if (!id) throw new Error("No active school selected.");
  return id;
}

// ---------------------------------------------------------------- an exam is a title in a term

export function examIdOf(termId: string, title: string): string {
  return `${termId}|${title}`;
}

export function parseExamId(examId: string): { termId: string; title: string } {
  const at = examId.indexOf("|");
  if (at <= 0) throw new Error("That exam is not one of this school's exams.");
  return { termId: examId.slice(0, at), title: examId.slice(at + 1) };
}

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The numbers of an assessment's decimal text. */
export const numberOf = (text: string): number => Number(text);

export async function listAssessments(tenantId: string, query: { classId?: string; termId?: string }): Promise<ApiAssessment[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/assessments", {
      path: { tenantId }, query: { ...query, limit: API_PAGE_LIMIT, cursor }, tenantId,
    });
    return { items: r.assessments, page: r.page };
  });
}

export async function listMarksOf(tenantId: string, assessmentId: string): Promise<ApiMark[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/assessments/{assessmentId}/marks", {
      path: { tenantId, assessmentId }, query: { limit: API_PAGE_LIMIT, cursor }, tenantId,
    });
    return { items: r.marks, page: r.page };
  });
}

/** The assessments of kind "exam", in the order they were made. */
export function examPapersOf(rows: readonly ApiAssessment[]): ApiAssessment[] {
  return rows.filter((a) => a.kind === "exam").sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

interface ExamGroup { termId: string; name: string; papers: ApiAssessment[] }

/** The exams the papers make up: one per term and title (ignoring case and edge spaces), by name. */
export function groupExams(rows: readonly ApiAssessment[]): ExamGroup[] {
  const groups = new Map<string, ExamGroup>();
  for (const a of examPapersOf(rows)) {
    const key = `${a.term_id}|${a.title.trim().toLowerCase()}`;
    const g = groups.get(key) ?? { termId: a.term_id, name: a.title, papers: [] };
    g.papers.push(a);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const earliest = (dates: (string | null)[]): string | null => {
  const present = dates.filter((d): d is string => !!d).sort();
  return present[0] ?? null;
};

export function examFromGroup(tenantId: string, g: ExamGroup): Exam {
  return {
    id: examIdOf(g.termId, g.name), tenant_id: tenantId, term_id: g.termId, name: g.name,
    out_of: numberOf(g.papers[0]!.max_score), published_at: earliest(g.papers.map((p) => p.published_at)),
  };
}

/** The term's exams, for the Gradebook's picker. A teacher reads only the papers of the classes they teach. */
export async function apiFetchExamsForTerm(termId: string, tenantId?: string): Promise<Exam[]> {
  const tid = tenantIdOrThrow(tenantId);
  return groupExams(await listAssessments(tid, { termId })).map((g) => examFromGroup(tid, g));
}

/** An exam as the Exams page lists it. `marksEntered` is 0: the API has no mark count (the page hides it). */
export interface ApiExamSummary {
  id: string;
  name: string;
  outOf: number;
  marksEntered: number;
  resultsOut: number;
  /** Papers set: one per class and subject. */
  papers: number;
}

export async function apiFetchExamSummaries(termId: string, tenantId?: string): Promise<ApiExamSummary[]> {
  const tid = tenantIdOrThrow(tenantId);
  return groupExams(await listAssessments(tid, { termId })).map((g) => ({
    id: examIdOf(g.termId, g.name),
    name: g.name,
    outOf: numberOf(g.papers[0]!.max_score),
    marksEntered: 0,
    resultsOut: g.papers.filter((p) => p.status !== "draft").length,
    papers: g.papers.length,
  }));
}

// ---------------------------------------------------------------- making an exam

/** Every class of the term's year and subject that has a teacher: the papers an exam is made of. */
async function papersToSet(tenantId: string, termId: string): Promise<{ classId: string; subjectId: string }[]> {
  const terms = await listAcademicTerms(tenantId);
  const term = terms.find((t) => t.id === termId);
  if (!term) throw new Error("That term is not one of this school's terms.");
  const [classes, assignments] = await Promise.all([
    listClasses(tenantId, term.academic_year_id),
    listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/teaching-assignments", {
        path: { tenantId }, query: { active: true, limit: API_PAGE_LIMIT, cursor }, tenantId,
      });
      return { items: r.assignments, page: r.page };
    }),
  ]);
  const inYear = new Set(classes.map((c) => c.id));
  const seen = new Set<string>();
  const out: { classId: string; subjectId: string }[] = [];
  for (const a of assignments) {
    const key = `${a.class_id}|${a.subject_id}`;
    if (!a.active || !inYear.has(a.class_id) || seen.has(key)) continue;
    seen.add(key);
    out.push({ classId: a.class_id, subjectId: a.subject_id });
  }
  return out;
}

export interface SetUpResult { made: number; alreadyThere: number }

/**
 * Makes the exam's papers: one for each class and subject that has a teacher and has no paper of this title yet. Running it again
 * for the same title makes only the missing ones (a subject given a teacher after the exam was made).
 */
export async function apiSetUpExam(termId: string, name: string, outOf: number, tenantId?: string): Promise<SetUpResult> {
  const tid = tenantIdOrThrow(tenantId);
  const [wanted, existing] = await Promise.all([papersToSet(tid, termId), listAssessments(tid, { termId })]);
  if (wanted.length === 0) {
    throw new Error("No class has a subject teacher yet. An exam is set for each class and subject that has one: give the subjects teachers in Classes first.");
  }
  const have = new Set(examPapersOf(existing).filter((a) => sameTitle(a.title, name)).map((a) => `${a.class_id}|${a.subject_id}`));
  const todo = wanted.filter((w) => !have.has(`${w.classId}|${w.subjectId}`));
  if (todo.length === 0) return { made: 0, alreadyThere: wanted.length };

  const settled = await settlePool(todo, MARK_WRITE_CONCURRENCY, async (w) => {
    await apiClient().post("/v1/tenants/{tenantId}/assessments", {
      path: { tenantId: tid },
      body: { class_id: w.classId, subject_id: w.subjectId, term_id: termId, title: name, kind: "exam", max_score: outOf },
      tenantId: tid,
    });
  });
  const failed = settled.filter((s): s is { ok: false; error: unknown } => !s.ok);
  const made = todo.length - failed.length;
  if (failed.length === 0) return { made, alreadyThere: wanted.length - todo.length };
  const detail = userMessage(failed[0]!.error);
  if (made === 0) throw new Error(detail);
  throw new Error(`Set up ${made} of ${todo.length} papers (${failed.length} failed: ${detail}). Use "Add new class subjects" to finish.`);
}

/** The papers of the exam that the school has not made yet, for "Add new class subjects". */
export function apiTopUpExam(examId: string, outOf: number, tenantId?: string): Promise<SetUpResult> {
  const { termId, title } = parseExamId(examId);
  return apiSetUpExam(termId, title, outOf, tenantId);
}

export function apiRenameExam(): never {
  throw new NotOnApiError("Renaming an exam");
}

export function apiDeleteExam(): never {
  throw new NotOnApiError("Deleting an exam");
}

// ---------------------------------------------------------------- the Exams page: papers, publish, close

export interface ExamSetPaper {
  id: string;
  classId: string;
  className: string;
  subjectId: string;
  subjectName: string;
  status: "draft" | "published" | "closed";
  outOf: number;
  publishedAt: string | null;
}

export async function apiFetchExamPapers(examId: string, tenantId?: string): Promise<ExamSetPaper[]> {
  const tid = tenantIdOrThrow(tenantId);
  const { termId, title } = parseExamId(examId);
  const [rows, classes, subjects] = await Promise.all([listAssessments(tid, { termId }), listClasses(tid), listApiSubjects(tid)]);
  const className = new Map(classes.map((c) => [c.id, c.name]));
  const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
  return examPapersOf(rows)
    .filter((a) => sameTitle(a.title, title))
    .map((a) => ({
      id: a.id, classId: a.class_id, className: className.get(a.class_id) ?? "Class", subjectId: a.subject_id,
      subjectName: subjectName.get(a.subject_id) ?? "Subject", status: a.status, outOf: numberOf(a.max_score), publishedAt: a.published_at,
    }))
    .sort((a, b) => a.className.localeCompare(b.className) || a.subjectName.localeCompare(b.subjectName));
}

/** How many marks each paper has (one read each, a few at once). A paper that could not be read is left out. */
export async function apiCountPaperMarks(paperIds: readonly string[], tenantId?: string): Promise<Map<string, number>> {
  const tid = tenantIdOrThrow(tenantId);
  const settled = await settlePool(paperIds, MARK_WRITE_CONCURRENCY, async (id) => (await listMarksOf(tid, id)).length);
  const out = new Map<string, number>();
  settled.forEach((s, i) => { if (s.ok) out.set(paperIds[i]!, s.value); });
  return out;
}

export interface PaperActionResult { done: number; failed: number; firstError: string | null }

/** Publishes or closes papers, a few at once. Every paper is tried; the answer says how many were done. */
export async function apiPaperAction(action: "publish" | "close", paperIds: readonly string[], tenantId?: string): Promise<PaperActionResult> {
  const tid = tenantIdOrThrow(tenantId);
  const settled = await settlePool(paperIds, MARK_WRITE_CONCURRENCY, async (assessmentId) => {
    if (action === "publish") await apiClient().post("/v1/tenants/{tenantId}/assessments/{assessmentId}/publish", { path: { tenantId: tid, assessmentId }, tenantId: tid });
    else await apiClient().post("/v1/tenants/{tenantId}/assessments/{assessmentId}/close", { path: { tenantId: tid, assessmentId }, tenantId: tid });
  });
  const failed = settled.filter((s): s is { ok: false; error: unknown } => !s.ok);
  return { done: paperIds.length - failed.length, failed: failed.length, firstError: failed[0] ? userMessage(failed[0].error) : null };
}

// ---------------------------------------------------------------- the Gradebook

/** What the signed-in person may do with grades (see GradesAccess). */
export async function apiFetchGradesAccess(tenantId?: string): Promise<GradesAccess> {
  const tid = tenantIdOrThrow(tenantId);
  let codes: string[];
  try {
    codes = await permissionCodes(tid);
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") return { gradebook: false, gradebookReason: GRADEBOOK_REFUSED, publish: false };
    throw err;
  }
  const may = (code: string) => codes.includes(code);
  const gradebook = may("resource.academics.read") && may("resource.learner.read");
  return { gradebook, gradebookReason: gradebook ? null : GRADEBOOK_REFUSED, publish: may("resource.academics.write") };
}

export const GRADEBOOK_REFUSED =
  "The new system does not let you read this school's terms, subjects and learners with the access you have, so the Gradebook cannot open for you yet. Ask the school office to give you the Academics and People areas.";

/** The subjects this teacher teaches in one class: their own teaching assignments there. Someone who may not read the staff list has none to show. */
export async function apiFetchTeacherSubjectsForClass(teacherUserId: string, classId: string, tenantId?: string): Promise<Subject[]> {
  const tid = tenantIdOrThrow(tenantId);
  let staff;
  try {
    staff = await listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/staff", { path: { tenantId: tid }, query: { active: true, limit: API_PAGE_LIMIT, cursor }, tenantId: tid });
      return { items: r.staff, page: r.page };
    });
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") return [];
    throw err;
  }
  const mine = staff.find((s) => s.userId === teacherUserId);
  if (!mine) return [];
  const [assignments, subjects] = await Promise.all([
    listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/teaching-assignments", {
        path: { tenantId: tid }, query: { classId, staffMemberId: mine.id, active: true, limit: API_PAGE_LIMIT, cursor }, tenantId: tid,
      });
      return { items: r.assignments, page: r.page };
    }),
    listApiSubjects(tid),
  ]);
  const mineIds = new Set(assignments.filter((a) => a.class_id === classId && a.staff_member_id === mine.id && a.active).map((a) => a.subject_id));
  return subjects.filter((s) => mineIds.has(s.id)).map((s) => subjectFromApi(s, tid)).sort((a, b) => a.name.localeCompare(b.name));
}

/** The paper of one exam for one class and subject. Throws a sentence the Gradebook shows when there is none. */
async function paperFor(tenantId: string, examId: string, classId: string, subjectId: string): Promise<ApiAssessment> {
  const { termId, title } = parseExamId(examId);
  const rows = await listAssessments(tenantId, { classId, termId });
  const paper = examPapersOf(rows).find((a) => a.subject_id === subjectId && sameTitle(a.title, title));
  if (!paper) throw new Error(`There is no "${title}" paper for this class and subject yet. The school office adds it in Exams ("Add new class subjects").`);
  return paper;
}

/** Which subjects of the exam are out (published or closed) for the class. */
export async function apiFetchPublishedSubjects(examId: string, classId: string, tenantId?: string): Promise<Set<string>> {
  const tid = tenantIdOrThrow(tenantId);
  const { termId, title } = parseExamId(examId);
  const rows = await listAssessments(tid, { classId, termId });
  return new Set(examPapersOf(rows).filter((a) => sameTitle(a.title, title) && a.status !== "draft").map((a) => a.subject_id));
}

export async function apiFetchMarksForExamSubject(
  examId: string, subjectId: string, studentIds: string[], classId: string | undefined, tenantId?: string,
): Promise<Record<string, number | null>> {
  if (!studentIds.length) return {};
  if (!classId) throw new Error("Pick a class first.");
  const tid = tenantIdOrThrow(tenantId);
  const paper = await paperFor(tid, examId, classId, subjectId);
  const wanted = new Set(studentIds);
  const out: Record<string, number | null> = {};
  for (const m of await listMarksOf(tid, paper.id)) if (wanted.has(m.learner_id)) out[m.learner_id] = numberOf(m.score);
  return out;
}

export interface ApiMarkRow { student_id: string; exam_id: string; subject_id: string; score: number | null }

/**
 * Saves a class's marks for one subject of an exam, as a draft. Marks that have not changed are not sent. A mark that was saved cannot be
 * taken back to "absent" (the API has no delete), and a published paper is locked; both are refused before anything is written.
 * The writes go a few at a time; if some fail, the sentence says how many were saved.
 */
export async function apiSaveExamMarks(rows: readonly ApiMarkRow[], classId: string | undefined, tenantId?: string): Promise<void> {
  if (!rows.length) return;
  if (!classId) throw new Error("Pick a class first.");
  const tid = tenantIdOrThrow(tenantId);
  const first = rows[0]!;
  const paper = await paperFor(tid, first.exam_id, classId, first.subject_id);
  if (paper.status !== "draft") throw new Error("These marks are published, and published marks are final on the new system.");
  const existing = new Map((await listMarksOf(tid, paper.id)).map((m) => [m.learner_id, m]));
  const max = numberOf(paper.max_score);

  const writes: { learnerId: string; score: number; rowVersion: number | null }[] = [];
  for (const r of rows) {
    const had = existing.get(r.student_id);
    if (r.score === null) {
      if (had) throw new Error("A mark that was saved cannot be changed back to absent on the new system. Put the real mark back, or leave it as it is.");
      continue;
    }
    if (r.score < 0 || r.score > max) throw new Error(`This paper is out of ${max}.`);
    if (had && numberOf(had.score) === r.score) continue;
    writes.push({ learnerId: r.student_id, score: r.score, rowVersion: had ? had.row_version : null });
  }
  if (!writes.length) return;

  const settled = await settlePool(writes, MARK_WRITE_CONCURRENCY, async (w) => {
    await apiClient().post("/v1/tenants/{tenantId}/assessments/{assessmentId}/marks", {
      path: { tenantId: tid, assessmentId: paper.id },
      body: { learner_id: w.learnerId, score: w.score, ...(w.rowVersion === null ? {} : { row_version: w.rowVersion }) },
      tenantId: tid,
    });
  });
  const failed = settled.filter((s): s is { ok: false; error: unknown } => !s.ok);
  if (failed.length === 0) return;
  const detail = userMessage(failed[0]!.error);
  if (failed.length === writes.length) throw new Error(detail);
  throw new Error(`Saved ${writes.length - failed.length} of ${writes.length} marks (${failed.length} failed: ${detail})`);
}

export async function apiPublishMarks(examId: string, classId: string, subjectId: string, tenantId?: string): Promise<void> {
  const tid = tenantIdOrThrow(tenantId);
  const paper = await paperFor(tid, examId, classId, subjectId);
  try {
    await apiClient().post("/v1/tenants/{tenantId}/assessments/{assessmentId}/publish", { path: { tenantId: tid, assessmentId: paper.id }, tenantId: tid });
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") throw new Error("Only the school office (the Academics area) can publish marks on the new system.");
    throw err;
  }
}

export function apiUnpublishMarks(): never {
  throw new NotOnApiError("Taking published results back to draft");
}
