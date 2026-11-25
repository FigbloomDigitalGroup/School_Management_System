import type { ExamPaperRow, QuestionDraft } from "../examPapers";
import { apiClient } from "./client";
import { isApiError } from "./errors";
import { listClassesOrEmpty, listMembershipsOrEmpty } from "./feesApi";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import { activeTenantId } from "./peopleApi";
import type { components } from "./schema";
import { listActiveLearnerIds, listApiSubjects } from "./setupApi";
import { apiListTeachingAssignments, apiMyStaffId, whenRefused } from "./teachingLookups";

/**
 * Online exam papers on apps/api: the API side of `examPapers.ts`, plus the school class/subject/size
 * lookups used by `ExamPapers`.
 *
 * Differences from Supabase, handled here rather than in the screens:
 *  - `GET /online-exam-papers` returns `{ id, tenantId, class_id, subject_id, title, max_score, created_at }`
 *    (and `questions` when returned). There is no read-only PDF/typed mode, open/close window, duration,
 *    draft/publish state, edit, delete, or attempt/scripts listing endpoint.
 *  - `POST /online-exam-papers` uses strict validation (`z.strictObject`): it accepts `{ class_id,
 *    subject_id, title, max_score, questions? }` where each question is `mcq` or `true_false` with
 *    `id`, `prompt` (<= 1000), `options` (each <= 200), `correct_answer` (option text), and `points`.
 */

type ApiOnlineExamPaper = components["schemas"]["OnlineExamPaper"];
export type ApiPaperQuestion = NonNullable<components["schemas"]["PostOnlineExamPapersRequest"]["questions"]>[number];

const API_PROMPT_MAX = 1000;
const API_OPTION_MAX = 200;

function whenForbidden<T>(fallback: T): (err: unknown) => T {
  return (err) => {
    if (isApiError(err) && err.code === "forbidden") return fallback;
    throw err;
  };
}

/** Validates and converts editor question drafts into the API's strict `mcq` question objects. */
export function apiQuestionsFromDrafts(questions: readonly QuestionDraft[]): ApiPaperQuestion[] {
  return questions.map((q, i) => {
    const label = `Question ${i + 1}`;
    if (q.kind !== "choice") {
      throw new Error(`${label}: only multiple-choice questions are supported on the new system.`);
    }
    const prompt = q.prompt.trim();
    if (!prompt) throw new Error(`${label} has no question written.`);
    if (prompt.length > API_PROMPT_MAX) {
      throw new Error(`${label} is too long. Keep it to ${API_PROMPT_MAX} characters.`);
    }
    const options = q.options.map((o) => o.trim());
    if (options.length < 2) throw new Error(`${label} needs at least 2 options.`);
    if (options.some((o) => !o)) throw new Error(`${label} has an empty option. Fill it in or remove it.`);
    const tooLong = options.find((o) => o.length > API_OPTION_MAX);
    if (tooLong) throw new Error(`${label}: keep each option to ${API_OPTION_MAX} characters or fewer.`);
    if (q.correctOption === null || q.correctOption < 0 || q.correctOption >= options.length) {
      throw new Error(`${label}: pick the correct option.`);
    }
    if (!Number.isInteger(q.points) || q.points < 1 || q.points > 1000) {
      throw new Error(`${label}: marks must be a whole number from 1 to 1000.`);
    }
    return {
      id: `q${i + 1}`,
      prompt,
      kind: "mcq",
      options,
      correct_answer: options[q.correctOption]!,
      points: q.points,
    };
  });
}

function mapPaper(
  p: ApiOnlineExamPaper,
  classById: ReadonlyMap<string, string>,
  subjectById: ReadonlyMap<string, string>,
): ExamPaperRow {
  const parsedMax = Number(p.max_score);
  return {
    id: p.id,
    kind: "exam",
    title: p.title,
    instructions: "",
    classId: p.class_id,
    className: classById.get(p.class_id) ?? "—",
    subjectId: p.subject_id,
    subjectName: subjectById.get(p.subject_id) ?? "—",
    examId: null,
    examName: null,
    mode: "online",
    filePath: null,
    fileName: null,
    opensAt: p.created_at,
    closesAt: null,
    durationMinutes: null,
    publishedAt: p.created_at,
    resultsReleasedAt: null,
    questionCount: p.questions?.length ?? 0,
    attemptCount: 0,
    maxScore: Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : null,
  };
}

/** Lists all online exam papers for the school, resolving class and subject names. */
export async function apiFetchExamPapers(tenantId: string): Promise<ExamPaperRow[]> {
  const [papers, classes, subjects] = await Promise.all([
    listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/online-exam-papers", {
        path: { tenantId },
        query: { limit: API_PAGE_LIMIT, cursor },
        tenantId,
      });
      return { items: r.papers, page: r.page };
    }),
    listClassesOrEmpty(tenantId),
    listApiSubjects(tenantId).catch(whenForbidden([])),
  ]);

  const classById = new Map(classes.map((c) => [c.id, c.name]));
  const subjectById = new Map(subjects.map((s) => [s.id, s.name]));
  return papers.map((p) => mapPaper(p, classById, subjectById));
}

/** Creates an online exam paper on apps/api and returns its id. */
export async function apiCreateOnlineExamPaper(
  tenantId: string,
  input: { classId: string; subjectId: string; title: string; maxScore: number; questions: QuestionDraft[] },
): Promise<string> {
  if (!input.classId) throw new Error("Pick the class.");
  if (!input.subjectId) throw new Error("Pick the subject.");
  const title = input.title.trim().replace(/\s+/g, " ");
  if (!title) throw new Error("Give the paper a title, e.g. Mid-term Mathematics Paper 1.");
  if (title.length > 160) throw new Error("Keep the title to 160 characters or fewer.");

  const apiQuestions = input.questions.length > 0 ? apiQuestionsFromDrafts(input.questions) : null;
  const maxScore = apiQuestions ? apiQuestions.reduce((sum, q) => sum + q.points, 0) : input.maxScore;
  if (!Number.isFinite(maxScore) || maxScore <= 0 || maxScore > 10000) {
    throw new Error("Total marks must be greater than 0 and at most 10000.");
  }

  const res = await apiClient().post("/v1/tenants/{tenantId}/online-exam-papers", {
    path: { tenantId },
    body: {
      class_id: input.classId,
      subject_id: input.subjectId,
      title,
      max_score: maxScore,
      questions: apiQuestions,
    },
    tenantId,
  });
  return res.paper.id;
}

/** All active classes of a school as `{ id, name }` options, ordered by name. */
export async function apiFetchSchoolClassOptions(tenantId: string): Promise<{ id: string; name: string }[]> {
  const classes = await listClassesOrEmpty(tenantId);
  return classes
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** All active subjects of a school as `{ id, name }` options, ordered by name. */
export async function apiFetchSchoolSubjectOptions(tenantId: string): Promise<{ id: string; name: string }[]> {
  const subjects = await listApiSubjects(tenantId).catch(whenForbidden([]));
  return subjects
    .map((s) => ({ id: s.id, name: s.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Active learner headcounts per class id on apps/api. */
export async function apiFetchClassSizes(classIds: string[]): Promise<Record<string, number>> {
  if (classIds.length === 0) return {};
  const tenantId = activeTenantId();
  const wanted = new Set(classIds);
  const counts: Record<string, number> = Object.fromEntries(classIds.map((id) => [id, 0]));

  const [memberships, activeLearners] = await Promise.all([
    listMembershipsOrEmpty(tenantId),
    listActiveLearnerIds(tenantId),
  ]);

  for (const m of memberships) {
    if (!wanted.has(m.class_id)) continue;
    if (activeLearners && !activeLearners.has(m.learner_id)) continue;
    counts[m.class_id] = (counts[m.class_id] ?? 0) + 1;
  }
  return counts;
}

/** `"classId:subjectId"` pairs this signed-in teacher is assigned to teach, via `GET /staff/me`. */
export async function apiFetchMyTeachingPairs(tenantId?: string): Promise<Set<string>> {
  const tid = tenantId ?? activeTenantId();
  const myStaffId = await apiMyStaffId(tid);
  if (!myStaffId) return new Set();
  const assignments = await apiListTeachingAssignments(tid).catch(whenRefused([]));
  return new Set(
    assignments
      .filter((a) => a.staff_member_id === myStaffId && a.active)
      .map((a) => `${a.class_id}:${a.subject_id}`),
  );
}
