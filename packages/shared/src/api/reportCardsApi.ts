import { NotOnApiError } from "../capabilities";
import { COMPETENCY_LEVELS, competencyKey, ratedItems, type CompetencyKind } from "../competencies";
import { gradingSchemeFor, rubricFor } from "../gradingSchemes";
import {
  buildReportCards, defaultReportCardOptions,
  type ReportCardCbeArea, type ReportCardData, type ReportCardSetup, type StoredReportCard,
} from "../reportCards";
import { apiFetchTeacherClasses } from "./attendanceApi";
import { apiClient } from "./client";
import { isApiError } from "./errors";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import { activeTenantId } from "./peopleApi";
import { settlePool } from "./pool";
import type { components } from "./schema";
import { accentFromApi, permissionCodes } from "./sessionApi";
import { byYear, classGroupFromApi, listAcademicTerms, listAcademicYears, listApiSubjects, listClasses, yearNumberOf } from "./setupApi";

/**
 * Report cards and core competencies on apps/api: the API side of reportCards.ts and competencies.ts.
 *
 * Differences from Supabase, handled here rather than in the screens:
 *  - `POST /v1/tenants/{tenantId}/report-cards` publishes one class-level snapshot immediately (no draft state,
 *    no per-exam subset selection, no withdraw/unpublish, no per-learner comments).
 *  - `GET /v1/tenants/{tenantId}/report-cards` returns snapshots newest first. We hydrate the latest snapshot
 *    into one `StoredReportCard` per learner using its `figures`, plus the snapshot's assessment marks and
 *    learner/class/term metadata where the caller has permission to read them, so the table and client-side
 *    PDF downloads work cleanly.
 *  - Plain teachers (OD-2) can read `/classes`, `/report-cards`, `/assessments`, `/assessments/{id}/marks`,
 *    and `/competency-ratings` for classes they teach, but get 403 on `/academic-terms`, `/academic-years`,
 *    `/learners`, and `/subjects`, and 403 on `POST /competency-ratings`. Reads degrade cleanly without
 *    inventing data.
 *  - `POST /v1/tenants/{tenantId}/competency-ratings` requires `row_version` when changing an existing rating
 *    and has no DELETE endpoint; we cache `row_version` per rating and throw `NotOnApiError` if asked to clear.
 */

type ApiReportCard = components["schemas"]["ReportCard"];
type ApiAssessment = components["schemas"]["Assessment"];
type ApiMark = components["schemas"]["Mark"];
type ApiLearner = components["schemas"]["Learner"];
type ApiCompetencyRating = components["schemas"]["CompetencyRating"];

const MARK_FETCH_CONCURRENCY = 4;

/** A refused read (403) answers `fallback`; any other failure is passed on. */
function whenForbidden<T>(fallback: T): (err: unknown) => T {
  return (err) => {
    if (isApiError(err) && err.code === "forbidden") return fallback;
    throw err;
  };
}

// ---------------------------------------------------------------- competency row_version cache

const ratingVersions = new Map<string, number>();

function versionKey(tenantId: string, termId: string, learnerId: string, kind: CompetencyKind, item: string): string {
  return `${tenantId}|${termId}|${learnerId}|${kind}|${item}`;
}

/** Clears the cached competency rating row_versions (for tests). */
export function resetCompetencyRatingVersions(): void {
  ratingVersions.clear();
}

/** Whether the signed-in caller holds `resource.academics.write` (needed for POST /competency-ratings). */
export async function apiCanWriteCompetencyRatings(tenantId?: string): Promise<boolean> {
  const tid = tenantId ?? activeTenantId();
  const codes = await permissionCodes(tid).catch(() => [] as string[]);
  return codes.includes("resource.academics.write");
}

// ---------------------------------------------------------------- setup (terms & classes)

export async function apiFetchReportCardSetup(tenantId: string, classTeacherUserId?: string): Promise<ReportCardSetup> {
  const [rawTerms, classes] = await Promise.all([
    listAcademicTerms(tenantId).catch(whenForbidden([])),
    classTeacherUserId
      ? apiFetchTeacherClasses(classTeacherUserId, tenantId)
      : listClasses(tenantId).then((rows) => rows.map((c) => classGroupFromApi(c, tenantId)).sort(byYear)),
  ]);

  let terms = [...rawTerms]
    .sort((a, b) => b.starts_on.localeCompare(a.starts_on) || b.label.localeCompare(a.label))
    .map((t) => ({ id: t.id, name: t.label, isCurrent: t.is_current }));

  // Plain teachers cannot read /academic-terms (403), but GET /report-cards is OD-2 scoped.
  // Surface any term_ids that already have published report cards for their classes so they can view/download them.
  if (terms.length === 0 && classTeacherUserId && classes.length > 0) {
    const pubs = await listReportCards(tenantId).catch(whenForbidden([]));
    const seen = new Set<string>();
    const discovered: { id: string; name: string; isCurrent: boolean }[] = [];
    for (const p of pubs) {
      if (seen.has(p.term_id)) continue;
      seen.add(p.term_id);
      discovered.push({
        id: p.term_id,
        name: discovered.length === 0 ? "Latest published term" : `Published term ${discovered.length + 1}`,
        isCurrent: discovered.length === 0,
      });
    }
    terms = discovered;
  }

  return {
    terms,
    classes: classes.map((c) => ({ id: c.id, name: c.name, level: c.level })),
  };
}

// ---------------------------------------------------------------- assessments / unpublished marks

async function listAssessments(tenantId: string, query: { termId?: string; classId?: string }): Promise<ApiAssessment[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/assessments", {
      path: { tenantId },
      query: { ...query, limit: API_PAGE_LIMIT, cursor },
      tenantId,
    });
    return { items: r.assessments, page: r.page };
  });
}

export async function apiFetchTermExams(termId: string): Promise<{ id: string; name: string; outOf: number; published: boolean }[]> {
  const tenantId = activeTenantId();
  const rows = await listAssessments(tenantId, { termId }).catch(whenForbidden([]));
  return [...rows]
    .sort((a, b) => {
      const aPub = a.published_at ? 0 : 1;
      const bPub = b.published_at ? 0 : 1;
      return aPub - bPub || (a.published_at ?? "").localeCompare(b.published_at ?? "") || a.title.localeCompare(b.title);
    })
    .map((a) => ({
      id: a.id,
      name: a.title,
      outOf: Number(a.max_score) || 100,
      published: a.status === "published" || a.status === "closed",
    }));
}

export async function apiFetchUnpublishedMarks(
  classId: string,
  examIds: string[],
): Promise<{ examId: string; examName: string; subjectId: string; subjectName: string }[]> {
  if (!examIds.length) return [];
  const tenantId = activeTenantId();
  const wanted = new Set(examIds);
  const [assessments, subjects] = await Promise.all([
    listAssessments(tenantId, { classId }).catch(whenForbidden([])),
    listApiSubjects(tenantId).catch(whenForbidden([])),
  ]);
  const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
  return assessments
    .filter((a) => wanted.has(a.id) && a.status === "draft")
    .map((a) => ({
      examId: a.id,
      examName: a.title,
      subjectId: a.subject_id,
      subjectName: subjectName.get(a.subject_id) ?? "Subject",
    }))
    .sort((a, b) => a.examName.localeCompare(b.examName) || a.subjectName.localeCompare(b.subjectName));
}

// ---------------------------------------------------------------- report cards

async function listReportCards(tenantId: string, query: { termId?: string; classId?: string } = {}): Promise<ApiReportCard[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/report-cards", {
      path: { tenantId },
      query: { ...query, limit: API_PAGE_LIMIT, cursor },
      tenantId,
    });
    return { items: r.report_cards, page: r.page };
  });
}

async function listAssessmentMarks(tenantId: string, assessmentId: string): Promise<ApiMark[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/assessments/{assessmentId}/marks", {
      path: { tenantId, assessmentId },
      query: { limit: API_PAGE_LIMIT, cursor },
      tenantId,
    });
    return { items: r.marks, page: r.page };
  });
}

async function fetchSchoolSummary(tenantId: string): Promise<ReportCardData["school"]> {
  const [tenantRes, profileRes] = await Promise.all([
    apiClient().get("/v1/tenants/{tenantId}", { path: { tenantId }, tenantId }).catch(whenForbidden(null)),
    apiClient().get("/v1/tenants/{tenantId}/school-profile", { path: { tenantId }, tenantId }).catch(whenForbidden(null)),
  ]);
  const profile = profileRes?.schoolProfile ?? null;
  const tenant = tenantRes ?? null;
  const rawCountry = profile?.country;
  const country = typeof rawCountry === "string" && /^[A-Za-z]{2}$/.test(rawCountry.trim()) ? rawCountry.trim().toUpperCase() : "KE";
  return {
    name: profile?.name ?? tenant?.name ?? "School",
    county: profile?.county ?? null,
    country,
    logoUrl: null,
    accent: accentFromApi(profile?.accent),
  };
}

/**
 * Reads the latest published report-card snapshot for `(termId, classId)` and hydrates one
 * `StoredReportCard` per learner for the table and PDF downloads.
 */
export async function apiFetchClassReportCards(termId: string, classId: string): Promise<StoredReportCard[]> {
  const tenantId = activeTenantId();
  const snapshots = await listReportCards(tenantId, { termId, classId });
  if (!snapshots.length) return [];
  const latest = snapshots[0]!;

  // Collect every learner id present in the snapshot (marks, CBE, or competencies).
  const learnerIds = new Set<string>();
  for (const l of latest.figures.learners) learnerIds.add(l.learner_id);
  for (const l of latest.figures.cbe?.learners ?? []) learnerIds.add(l.learner_id);
  for (const l of latest.figures.competencies?.learners ?? []) learnerIds.add(l.learner_id);
  if (learnerIds.size === 0) return [];

  const [school, years, terms, classes, subjects, learners, assessments] = await Promise.all([
    fetchSchoolSummary(tenantId),
    listAcademicYears(tenantId).catch(whenForbidden([])),
    listAcademicTerms(tenantId).catch(whenForbidden([])),
    listClasses(tenantId).catch(whenForbidden([])),
    listApiSubjects(tenantId).catch(whenForbidden([])),
    listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/learners", {
        path: { tenantId },
        query: { active: true, limit: API_PAGE_LIMIT, cursor },
        tenantId,
      });
      return { items: r.learners, page: r.page };
    }).catch(whenForbidden([] as ApiLearner[])),
    listAssessments(tenantId, { classId, termId }).catch(whenForbidden([])),
  ]);

  const termRow = terms.find((t) => t.id === termId);
  const yearRow = termRow ? years.find((y) => y.id === termRow.academic_year_id) : undefined;
  const classRow = classes.find((c) => c.id === classId);
  const subjectById = new Map(subjects.map((s) => [s.id, s]));
  const learnerById = new Map(learners.map((l) => [l.id, l]));

  const snapshotAssessmentIds = new Set(latest.figures.assessment_ids);
  const includedAssessments = assessments
    .filter((a) => snapshotAssessmentIds.has(a.id))
    .sort((a, b) => {
      const aPub = a.published_at ? 0 : 1;
      const bPub = b.published_at ? 0 : 1;
      return aPub - bPub || (a.published_at ?? "").localeCompare(b.published_at ?? "") || a.title.localeCompare(b.title);
    });

  // Fetch marks for the snapshot's assessments so subject rows and PDFs have exact scores.
  const markBatches = await settlePool(includedAssessments, MARK_FETCH_CONCURRENCY, async (a) => ({
    assessment: a,
    marks: await listAssessmentMarks(tenantId, a.id).catch(whenForbidden([] as ApiMark[])),
  }));

  const marksInput: {
    studentId: string; examId: string; subjectId: string; subjectName: string; subjectCode: string; score: number | null;
  }[] = [];
  for (const batch of markBatches) {
    if (!batch.ok) continue;
    const { assessment, marks } = batch.value;
    const subj = subjectById.get(assessment.subject_id);
    for (const m of marks) {
      if (!learnerIds.has(m.learner_id)) continue;
      const numeric = Number(m.score);
      marksInput.push({
        studentId: m.learner_id,
        examId: assessment.id,
        subjectId: assessment.subject_id,
        subjectName: subj?.name ?? assessment.title,
        subjectCode: subj?.code ?? "",
        score: Number.isFinite(numeric) ? numeric : null,
      });
    }
  }

  const classLevel = classRow?.education_level ?? "secondary";
  const scheme = gradingSchemeFor(school.country, classLevel);
  const rubric = rubricFor(school.country, classLevel);

  // Hydrate CBE snapshot results per learner.
  const cbeMap = new Map<string, ReportCardCbeArea[]>();
  const rubricLabel = (code: string) =>
    rubric?.find((r) => r.code === code)?.label ?? COMPETENCY_LEVELS.find((r) => r.code === code)?.label ?? code;
  for (const entry of latest.figures.cbe?.learners ?? []) {
    const areas: ReportCardCbeArea[] = entry.results.map((r) => ({
      area: r.title,
      assessment: r.instrument_type,
      level: r.level_code,
      label: rubricLabel(r.level_code),
      comment: r.teacher_feedback ?? r.observation ?? null,
      strands: [],
    }));
    if (areas.length) cbeMap.set(entry.learner_id, areas);
  }

  // Hydrate competency/value ratings from the snapshot.
  const compMap = new Map<string, ReturnType<typeof ratedItems>>();
  for (const entry of latest.figures.competencies?.learners ?? []) {
    const levels = new Map<string, string>();
    for (const r of entry.ratings) {
      if (r.kind === "competency" || r.kind === "value") {
        levels.set(competencyKey(r.kind, r.item), r.level_code);
      }
    }
    const items = ratedItems(levels);
    if (items.length) compMap.set(entry.learner_id, items);
  }

  const learnerList = [...learnerIds]
    .map((id) => {
      const l = learnerById.get(id);
      return {
        id,
        name: l?.full_name ?? `Learner ${id.slice(0, 8)}`,
        admissionNo: l?.admission_no ?? "",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const built = buildReportCards({
    school,
    term: {
      name: termRow?.label ?? "Term",
      year: yearRow ? yearNumberOf(yearRow) : termRow ? Number(termRow.starts_on.slice(0, 4)) : new Date().getFullYear(),
      startsOn: termRow?.starts_on ?? latest.published_at.slice(0, 10),
      endsOn: termRow?.ends_on ?? latest.published_at.slice(0, 10),
    },
    className: classRow?.name ?? "Class",
    classTeacher: null,
    scheme,
    exams: includedAssessments.map((a) => ({ id: a.id, name: a.title, outOf: Number(a.max_score) || 100 })),
    learners: learnerList,
    marks: marksInput,
    cbe: cbeMap,
    competencies: compMap,
    rubric: rubric?.map((r) => ({ code: r.code, label: r.label })) ?? null,
    options: defaultReportCardOptions(scheme),
    today: latest.published_at.slice(0, 10),
  });

  // If marks weren't readable or empty, keep the server snapshot's exact mean & grade.
  const snapshotByLearner = new Map(latest.figures.learners.map((l) => [l.learner_id, l]));
  return built.map((card) => {
    const snap = snapshotByLearner.get(card.learner.id);
    if (snap && card.summary.mean === null && snap.average !== null) {
      const avg = Math.round(Number(snap.average));
      if (Number.isFinite(avg)) {
        card.summary.mean = avg;
        card.summary.subjectsSat = snap.count;
        if (snap.grade) card.summary.grade = snap.grade;
      }
    }
    return {
      id: `${latest.id}:${card.learner.id}`,
      termId: latest.term_id,
      studentId: card.learner.id,
      classId: latest.class_id,
      data: card,
      teacherComment: null,
      principalComment: null,
      publishedAt: latest.published_at,
      preparedAt: latest.published_at,
    };
  });
}

/** Publishes a class report card snapshot on the API and returns the publication id and learner count. */
export async function apiPublishClassReportCard(
  tenantId: string,
  termId: string,
  classId: string,
): Promise<{ reportCardId: string; learnerCount: number }> {
  const res = await apiClient().post("/v1/tenants/{tenantId}/report-cards", {
    path: { tenantId },
    body: { term_id: termId, class_id: classId },
    tenantId,
  });
  const rc = res.report_card;
  const ids = new Set<string>();
  for (const l of rc.figures.learners) ids.add(l.learner_id);
  for (const l of rc.figures.cbe?.learners ?? []) ids.add(l.learner_id);
  for (const l of rc.figures.competencies?.learners ?? []) ids.add(l.learner_id);
  return { reportCardId: rc.id, learnerCount: ids.size };
}

export async function apiSaveReportCards(
  tenantId: string,
  termId: string,
  classId: string,
): Promise<{ saved: number; skippedPublished: number }> {
  const { learnerCount } = await apiPublishClassReportCard(tenantId, termId, classId);
  return { saved: learnerCount, skippedPublished: 0 };
}

// ---------------------------------------------------------------- competencies

async function listCompetencyRatings(
  tenantId: string,
  query: { termId?: string; learnerId?: string },
): Promise<ApiCompetencyRating[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/competency-ratings", {
      path: { tenantId },
      query: { ...query, limit: API_PAGE_LIMIT, cursor },
      tenantId,
    });
    return { items: r.ratings, page: r.page };
  });
}

export async function apiFetchCompetencyRatings(
  termId: string,
  studentIds: string[],
): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  if (!studentIds.length) return out;
  const tenantId = activeTenantId();
  const wanted = new Set(studentIds);
  const rows = await listCompetencyRatings(tenantId, { termId });
  for (const r of rows) {
    ratingVersions.set(versionKey(tenantId, r.term_id, r.learner_id, r.kind, r.item), r.row_version);
    if (!wanted.has(r.learner_id)) continue;
    const m = out.get(r.learner_id) ?? new Map<string, string>();
    m.set(competencyKey(r.kind, r.item), r.level_code);
    out.set(r.learner_id, m);
  }
  return out;
}

export async function apiSaveCompetencyRating(
  tenantId: string,
  termId: string,
  studentId: string,
  kind: CompetencyKind,
  item: string,
  level: string | null,
): Promise<void> {
  if (level === null) {
    throw new NotOnApiError("Clearing a competency rating");
  }
  if (level !== "EE" && level !== "ME" && level !== "AE" && level !== "BE") {
    throw new Error("Competency level must be EE, ME, AE, or BE.");
  }
  const key = versionKey(tenantId, termId, studentId, kind, item);
  let rowVersion = ratingVersions.get(key);
  if (rowVersion === undefined) {
    const existing = await listCompetencyRatings(tenantId, { termId, learnerId: studentId }).catch(whenForbidden([]));
    for (const r of existing) {
      ratingVersions.set(versionKey(tenantId, r.term_id, r.learner_id, r.kind, r.item), r.row_version);
    }
    rowVersion = ratingVersions.get(key);
  }
  const res = await apiClient().post("/v1/tenants/{tenantId}/competency-ratings", {
    path: { tenantId },
    body: {
      term_id: termId,
      learner_id: studentId,
      kind,
      item,
      level_code: level,
      ...(rowVersion !== undefined ? { row_version: rowVersion } : {}),
    },
    tenantId,
  });
  ratingVersions.set(key, res.rating.row_version);
}
