import { supabase } from "./supabase";
import { fetchAllPages } from "./paging";
import { gradeFor, pointsFor, summarise } from "./grading";
import { gradingSchemeFor, rubricFor, type GradingSchemeId } from "./gradingSchemes";
import { loadPublishedCbeResults } from "./cbeData";
import { fetchCompetencyRatings, ratedItems, type RatedItem } from "./competencies";
import type { ClassLevel } from "./types";

/**
 * Report cards: one per learner per term, issued by the school.
 *
 * The office prepares a class: it picks the term's exams that count, and
 * every learner's card is worked out here from the whole class's marks —
 * average and grade per subject, class means, position — and stored as a
 * snapshot (report_cards.data). Families read the snapshot, never the marks
 * behind it: position and class means need classmates' marks, which RLS
 * rightly hides from them. See supabase/migrations/20261026000000_report_cards.sql.
 *
 * buildReportCards() is pure (tested in reportCards.test.ts); the rest load
 * and save. reportCardPdf.ts turns the snapshot into the PDF.
 */

// ------------------------------------------------------------------ the snapshot

export interface ReportCardSubject {
  name: string;
  code: string;
  /** Percentage per exam, in the same order as ReportCardData.exams; null = no mark. */
  scores: (number | null)[];
  /** Mean of the exams sat, as a whole percentage; null when none were. */
  average: number | null;
  grade: string | null;
  points: number | null;
  /** The class's mean of this subject's averages. */
  classMean: number | null;
}

export interface ReportCardCbeArea {
  area: string;
  assessment: string;
  /** Rubric code, e.g. "ME" or "EE2"; null when not judged. */
  level: string | null;
  label: string | null;
  comment: string | null;
  /** Each strand's level. Optional: cards prepared before strands were printed don't have it. */
  strands?: { name: string; level: string; label: string }[];
}

export interface ReportCardData {
  version: 1;
  school: { name: string; county: string | null; country: string; logoUrl: string | null; accent: string };
  learner: { id: string; name: string; admissionNo: string; className: string };
  term: { name: string; year: number; startsOn: string; endsOn: string };
  scheme: GradingSchemeId;
  exams: { id: string; name: string }[];
  subjects: ReportCardSubject[];
  summary: {
    subjectsSat: number;
    /** Sum of the subject averages. */
    total: number | null;
    mean: number | null;
    grade: string | null;
    points: number | null;
    /** Null when position is switched off, or the learner sat nothing. Ties share a place. */
    position: number | null;
    /** Learners with a mean, i.e. "out of". */
    ranked: number;
  };
  cbe: ReportCardCbeArea[];
  /** Core competencies and values the class teacher rated (CBC classes). Optional for older cards. */
  competencies?: RatedItem[];
  /** The rubric the levels on this card are read against, for the key; null for 8-4-4 classes. */
  rubric?: { code: string; label: string }[] | null;
  attendance: { present: number; days: number } | null;
  fees: { billedCents: number; paidCents: number } | null;
  classTeacher: string | null;
  nextTermBegins: string | null;
  preparedOn: string;
}

export interface ReportCardOptions {
  showPosition: boolean;
  showAttendance: boolean;
  showFees: boolean;
  /** YYYY-MM-DD, or null to leave it off. */
  nextTermBegins: string | null;
}

/** Position is common on 8-4-4 report cards and discouraged under CBC, so it starts off there. */
export function defaultReportCardOptions(scheme: GradingSchemeId): ReportCardOptions {
  return { showPosition: scheme === "kcse", showAttendance: true, showFees: false, nextTermBegins: null };
}

// ------------------------------------------------------------------ working it out (pure)

export interface ReportCardInput {
  school: ReportCardData["school"];
  term: ReportCardData["term"];
  className: string;
  classTeacher: string | null;
  scheme: GradingSchemeId;
  /** In the order they should appear as columns. */
  exams: { id: string; name: string; outOf: number }[];
  learners: { id: string; name: string; admissionNo: string }[];
  marks: { studentId: string; examId: string; subjectId: string; subjectName: string; subjectCode: string; score: number | null }[];
  cbe?: Map<string, ReportCardCbeArea[]>;
  competencies?: Map<string, RatedItem[]>;
  rubric?: { code: string; label: string }[] | null;
  attendance?: Map<string, { present: number; days: number }>;
  fees?: Map<string, { billedCents: number; paidCents: number }>;
  options: ReportCardOptions;
  today: string;
}

const pct = (score: number, outOf: number) => (outOf > 0 ? (score / outOf) * 100 : 0);
const round = (n: number) => Math.round(n);

/**
 * Ranks by mean, highest first; equal means share a place and the next place
 * is skipped (1, 2, 2, 4), the way schools write it. Unranked (null) stays null.
 */
export function rankByMean(means: Map<string, number | null>): Map<string, number | null> {
  const ranked = [...means.entries()].filter((e): e is [string, number] => e[1] !== null).sort((a, b) => b[1] - a[1]);
  const out = new Map<string, number | null>([...means.keys()].map((k) => [k, null]));
  ranked.forEach(([id, mean], i) => {
    const prev = ranked[i - 1];
    out.set(id, prev && prev[1] === mean ? out.get(prev[0])! : i + 1);
  });
  return out;
}

/** Every learner's card for one class. A subject appears on a card only if the learner has a mark for it in one of the exams. */
export function buildReportCards(input: ReportCardInput): ReportCardData[] {
  const examIndex = new Map(input.exams.map((e, i) => [e.id, i]));
  const outOf = new Map(input.exams.map((e) => [e.id, e.outOf]));

  // learner -> subject -> per-exam percentages
  type Row = { name: string; code: string; scores: (number | null)[] };
  const grid = new Map<string, Map<string, Row>>();
  for (const m of input.marks) {
    const i = examIndex.get(m.examId);
    if (i === undefined || m.score === null) continue;
    const subjects = grid.get(m.studentId) ?? new Map<string, Row>();
    const row = subjects.get(m.subjectId) ?? { name: m.subjectName, code: m.subjectCode, scores: input.exams.map(() => null) };
    row.scores[i] = pct(m.score, outOf.get(m.examId) ?? 100);
    subjects.set(m.subjectId, row);
    grid.set(m.studentId, subjects);
  }

  const averageOf = (scores: (number | null)[]) => {
    const sat = scores.filter((s): s is number => s !== null);
    return sat.length ? round(sat.reduce((a, b) => a + b, 0) / sat.length) : null;
  };

  // class mean per subject, over the learners who sat it
  const subjectTotals = new Map<string, { sum: number; n: number }>();
  for (const subjects of grid.values()) {
    for (const [subjectId, row] of subjects) {
      const avg = averageOf(row.scores);
      if (avg === null) continue;
      const t = subjectTotals.get(subjectId) ?? { sum: 0, n: 0 };
      t.sum += avg; t.n += 1;
      subjectTotals.set(subjectId, t);
    }
  }

  const cards = input.learners.map((l) => {
    const subjects: ReportCardSubject[] = [...(grid.get(l.id) ?? new Map<string, Row>()).entries()]
      .map(([subjectId, row]) => {
        const average = averageOf(row.scores);
        const t = subjectTotals.get(subjectId);
        return {
          name: row.name,
          code: row.code,
          scores: row.scores.map((s) => (s === null ? null : round(s))),
          average,
          grade: average === null ? null : gradeFor(average, input.scheme),
          points: average === null ? null : pointsFor(average, input.scheme),
          classMean: t ? round(t.sum / t.n) : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const s = summarise(subjects.map((x) => ({ subject: x.name, score: x.average })), input.scheme);
    const card: ReportCardData = {
      version: 1,
      school: input.school,
      learner: { id: l.id, name: l.name, admissionNo: l.admissionNo, className: input.className },
      term: input.term,
      scheme: input.scheme,
      exams: input.exams.map((e) => ({ id: e.id, name: e.name })),
      subjects,
      summary: {
        subjectsSat: s.entered,
        total: s.entered ? subjects.reduce((a, x) => a + (x.average ?? 0), 0) : null,
        mean: s.meanScore,
        grade: s.meanGrade,
        points: s.entered ? s.totalPoints : null,
        position: null,
        ranked: 0,
      },
      cbe: input.cbe?.get(l.id) ?? [],
      competencies: input.competencies?.get(l.id) ?? [],
      rubric: input.rubric ?? null,
      attendance: input.options.showAttendance ? (input.attendance?.get(l.id) ?? null) : null,
      fees: input.options.showFees ? (input.fees?.get(l.id) ?? null) : null,
      classTeacher: input.classTeacher,
      nextTermBegins: input.options.nextTermBegins,
      preparedOn: input.today,
    };
    return card;
  });

  if (input.options.showPosition) {
    // Ranked on the mean the card prints, so two cards both reading "61" share the place.
    const positions = rankByMean(new Map(cards.map((c) => [c.learner.id, c.summary.mean])));
    const ranked = cards.filter((c) => c.summary.mean !== null).length;
    for (const c of cards) {
      c.summary.position = positions.get(c.learner.id) ?? null;
      c.summary.ranked = ranked;
    }
  }
  return cards;
}

// ------------------------------------------------------------------ comments

const COMMENT_BANDS: { test: (grade: string) => boolean; teacher: string; principal: string }[] = [
  { test: (g) => /^(A|A-|EE\d?)$/.test(g), teacher: "Excellent work this term. {first} is focused and consistent. Keep it up.", principal: "An excellent result. Well done." },
  { test: (g) => /^(B\+|B|B-|ME1)$/.test(g), teacher: "Good work. {first} understands most topics well and can reach the top with a little more practice.", principal: "A good result. Aim higher next term." },
  { test: (g) => /^(C\+|C|C-|ME2|ME)$/.test(g), teacher: "Fair work. {first} is capable of more with regular revision and asking for help early.", principal: "A fair result. More effort will be rewarded." },
  { test: () => true, teacher: "{first} needs a lot more effort and support. Let us work on this together with home.", principal: "Below expectations. We will support {first} closely next term." },
];

/** A starting comment from the mean grade, for the office to edit. Empty when there's no grade. */
export function suggestComment(grade: string | null, firstName: string, who: "teacher" | "principal"): string {
  if (!grade) return "";
  const band = COMMENT_BANDS.find((b) => b.test(grade))!;
  return band[who].replace(/\{first\}/g, firstName);
}

// ------------------------------------------------------------------ loading the class (staff)

export interface PrepareInput {
  tenantId: string;
  school: ReportCardData["school"];
  termId: string;
  classId: string;
  examIds: string[];
  options: ReportCardOptions;
}

/** Works out every active learner's card for one class and term. Reads only — saveReportCards() stores them. */
export async function prepareClassReportCards(p: PrepareInput): Promise<ReportCardData[]> {
  const sb = supabase();
  const [{ data: term, error: tErr }, { data: cls, error: cErr }, { data: learners, error: lErr }, { data: exams, error: eErr }] = await Promise.all([
    sb.from("terms").select("name, year, starts_on, ends_on").eq("id", p.termId).single<{ name: string; year: number; starts_on: string; ends_on: string }>(),
    sb.from("classes").select("name, level, class_teacher:profiles!classes_class_teacher_id_fkey(full_name)").eq("id", p.classId)
      .single<{ name: string; level: ClassLevel; class_teacher: { full_name: string } | null }>(),
    sb.from("students").select("id, full_name, admission_no").eq("class_id", p.classId).eq("active", true).order("full_name")
      .returns<{ id: string; full_name: string; admission_no: string }[]>(),
    p.examIds.length
      ? sb.from("exams").select("id, name, out_of, published_at").in("id", p.examIds)
          .returns<{ id: string; name: string; out_of: number; published_at: string | null }[]>()
      : Promise.resolve({ data: [] as { id: string; name: string; out_of: number; published_at: string | null }[], error: null }),
  ]);
  for (const e of [tErr, cErr, lErr, eErr]) if (e) throw new Error(e.message);
  const ids = (learners ?? []).map((l) => l.id);
  const scheme = gradingSchemeFor(p.school.country, cls!.level);
  // CBE classes are judged on a rubric (null for 8-4-4 Forms): their cards carry its key and the core competencies.
  const rubric = rubricFor(p.school.country, cls!.level);

  const [marks, cbe, attendance, fees, ratings] = await Promise.all([
    p.examIds.length && ids.length
      ? fetchAllPages<{ student_id: string; exam_id: string; subject_id: string; score: number | null; subjects: { name: string; code: string } | null }>((from, to) =>
          sb.from("marks").select("student_id, exam_id, subject_id, score, subjects(name, code)")
            .in("exam_id", p.examIds).in("student_id", ids)
            .order("exam_id").order("student_id").order("subject_id").range(from, to)
            .returns<{ student_id: string; exam_id: string; subject_id: string; score: number | null; subjects: { name: string; code: string } | null }[]>())
      : Promise.resolve([]),
    loadClassCbe(ids, p.school.country, p.termId),
    p.options.showAttendance ? loadAttendance(ids, p.termId) : Promise.resolve(new Map()),
    p.options.showFees ? loadFees(ids, p.termId) : Promise.resolve(new Map()),
    rubric ? fetchCompetencyRatings(p.termId, ids) : Promise.resolve(new Map<string, Map<string, string>>()),
  ]);

  // Columns in the order the exams went out, unpublished last, then by name.
  const ordered = [...(exams ?? [])].sort((a, b) =>
    (a.published_at ?? "~").localeCompare(b.published_at ?? "~") || a.name.localeCompare(b.name));

  return buildReportCards({
    school: p.school,
    term: { name: term!.name, year: term!.year, startsOn: term!.starts_on, endsOn: term!.ends_on },
    className: cls!.name,
    classTeacher: cls!.class_teacher?.full_name ?? null,
    scheme,
    exams: ordered.map((e) => ({ id: e.id, name: e.name, outOf: e.out_of })),
    learners: (learners ?? []).map((l) => ({ id: l.id, name: l.full_name, admissionNo: l.admission_no })),
    marks: marks.map((m) => ({
      studentId: m.student_id, examId: m.exam_id, subjectId: m.subject_id,
      subjectName: m.subjects?.name ?? "Subject", subjectCode: m.subjects?.code ?? "", score: m.score,
    })),
    cbe,
    competencies: new Map([...ratings.entries()].map(([id, levels]) => [id, ratedItems(levels)])),
    rubric: rubric?.map((l) => ({ code: l.code, label: l.label })) ?? null,
    attendance,
    fees,
    options: p.options,
    today: new Date().toISOString().slice(0, 10),
  });
}

async function loadClassCbe(studentIds: string[], country: string, termId: string): Promise<Map<string, ReportCardCbeArea[]>> {
  const results = await loadPublishedCbeResults(studentIds, country, { termId });
  return new Map([...results.entries()].map(([id, areas]) => [id, areas.map((a) => ({
    area: a.subjectName, assessment: a.assessmentTitle, level: a.overall?.code ?? null, label: a.overall?.label ?? null, comment: a.comment,
    strands: a.strands.map((st) => ({ name: st.name, level: st.code, label: st.label })),
  }))]));
}

async function loadAttendance(studentIds: string[], termId: string): Promise<Map<string, { present: number; days: number }>> {
  if (!studentIds.length) return new Map();
  const rows = await fetchAllPages<{ student_id: string; mark: string }>((from, to) =>
    supabase().from("attendance").select("student_id, mark").eq("term_id", termId).in("student_id", studentIds)
      .order("student_id").order("taken_on").range(from, to).returns<{ student_id: string; mark: string }[]>());
  const out = new Map<string, { present: number; days: number }>();
  for (const r of rows) {
    const a = out.get(r.student_id) ?? { present: 0, days: 0 };
    a.days += 1;
    if (r.mark === "present" || r.mark === "late") a.present += 1;
    out.set(r.student_id, a);
  }
  return out;
}

async function loadFees(studentIds: string[], termId: string): Promise<Map<string, { billedCents: number; paidCents: number }>> {
  if (!studentIds.length) return new Map();
  const { data, error } = await supabase().from("fee_invoices").select("student_id, total_cents, paid_cents")
    .eq("term_id", termId).in("student_id", studentIds)
    .returns<{ student_id: string; total_cents: number; paid_cents: number }[]>();
  if (error) throw new Error(error.message);
  return new Map((data ?? []).map((f) => [f.student_id, { billedCents: f.total_cents, paidCents: f.paid_cents }]));
}

// ------------------------------------------------------------------ stored cards

export interface StoredReportCard {
  id: string;
  termId: string;
  studentId: string;
  classId: string | null;
  data: ReportCardData;
  teacherComment: string | null;
  principalComment: string | null;
  publishedAt: string | null;
  preparedAt: string;
}

interface CardRow {
  id: string; term_id: string; student_id: string; class_id: string | null; data: ReportCardData;
  teacher_comment: string | null; principal_comment: string | null; published_at: string | null; prepared_at: string;
}
const CARD_COLS = "id, term_id, student_id, class_id, data, teacher_comment, principal_comment, published_at, prepared_at";
const toCard = (r: CardRow): StoredReportCard => ({
  id: r.id, termId: r.term_id, studentId: r.student_id, classId: r.class_id, data: r.data,
  teacherComment: r.teacher_comment, principalComment: r.principal_comment, publishedAt: r.published_at, preparedAt: r.prepared_at,
});

/** One class's cards for a term, as staff see them (drafts included), by learner name. */
export async function fetchClassReportCards(termId: string, classId: string): Promise<StoredReportCard[]> {
  const { data, error } = await supabase().from("report_cards").select(CARD_COLS)
    .eq("term_id", termId).eq("class_id", classId).returns<CardRow[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map(toCard).sort((a, b) => a.data.learner.name.localeCompare(b.data.learner.name));
}

/**
 * Stores freshly prepared cards. Comments already written stay. A card that
 * has gone out to the family is left exactly as issued: withdraw it first to
 * re-prepare it. Returns how many were saved and how many were skipped.
 */
export async function saveReportCards(
  tenantId: string, termId: string, classId: string, cards: ReportCardData[],
): Promise<{ saved: number; skippedPublished: number }> {
  const existing = await fetchClassReportCards(termId, classId);
  const published = new Set(existing.filter((c) => c.publishedAt).map((c) => c.studentId));
  const rows = cards.filter((c) => !published.has(c.learner.id)).map((c) => ({
    tenant_id: tenantId, term_id: termId, student_id: c.learner.id, class_id: classId, data: c, prepared_at: new Date().toISOString(),
  }));
  if (rows.length) {
    const { error } = await supabase().from("report_cards").upsert(rows, { onConflict: "term_id,student_id" });
    if (error) throw new Error(error.message);
  }
  return { saved: rows.length, skippedPublished: cards.length - rows.length };
}

/** Admins write both comments directly. */
export async function saveReportCardComments(id: string, comments: { teacher?: string | null; principal?: string | null }): Promise<void> {
  const patch: Record<string, string | null> = {};
  if (comments.teacher !== undefined) patch.teacher_comment = comments.teacher?.trim() || null;
  if (comments.principal !== undefined) patch.principal_comment = comments.principal?.trim() || null;
  const { data, error } = await supabase().from("report_cards").update(patch).eq("id", id).select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("Only the school office can change this report card.");
}

/** The class teacher's comment, for a class teacher (admins may use it too). */
export async function saveTeacherComment(id: string, comment: string): Promise<void> {
  const { error } = await supabase().rpc("set_report_card_teacher_comment", { p_card_id: id, p_comment: comment });
  if (error) throw new Error(error.message);
}

/** Sends cards out to families (or withdraws them). */
export async function setReportCardsPublished(ids: string[], published: boolean): Promise<void> {
  if (!ids.length) return;
  const { error } = await supabase().from("report_cards")
    .update({ published_at: published ? new Date().toISOString() : null }).in("id", ids);
  if (error) throw new Error(error.message);
}

/** A family's (or learner's) published cards, newest term first. RLS returns only their own. */
export async function fetchMyReportCards(studentIds: string[]): Promise<StoredReportCard[]> {
  if (!studentIds.length) return [];
  const { data, error } = await supabase().from("report_cards").select(CARD_COLS)
    .in("student_id", studentIds).not("published_at", "is", null).returns<CardRow[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map(toCard)
    .sort((a, b) => b.data.term.startsOn.localeCompare(a.data.term.startsOn));
}

/** "Term 2 2026 report card — Amani Otieno.pdf", safe as a file name. */
export function reportCardFileName(d: Pick<ReportCardData, "term" | "learner">): string {
  return `${d.term.name} report card - ${d.learner.name}`.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() + ".pdf";
}

// ------------------------------------------------------------------ choosing what to prepare

export interface ReportCardSetup {
  terms: { id: string; name: string; isCurrent: boolean }[];
  classes: { id: string; name: string; level: ClassLevel }[];
}

/** Terms newest first, and the classes this person prepares or comments on: every class for the office, their own for a class teacher. */
export async function fetchReportCardSetup(tenantId: string, classTeacherId?: string): Promise<ReportCardSetup> {
  let classes = supabase().from("classes").select("id, name, level, form_level").eq("tenant_id", tenantId);
  if (classTeacherId) classes = classes.eq("class_teacher_id", classTeacherId);
  const [{ data: terms, error: tErr }, { data: cls, error: cErr }] = await Promise.all([
    supabase().from("terms").select("id, name, is_current, starts_on").eq("tenant_id", tenantId).order("starts_on", { ascending: false })
      .returns<{ id: string; name: string; is_current: boolean }[]>(),
    classes.order("form_level").order("name").returns<{ id: string; name: string; level: ClassLevel }[]>(),
  ]);
  if (tErr) throw new Error(tErr.message);
  if (cErr) throw new Error(cErr.message);
  return {
    terms: (terms ?? []).map((t) => ({ id: t.id, name: t.name, isCurrent: t.is_current })),
    classes: (cls ?? []).map((c) => ({ id: c.id, name: c.name, level: c.level })),
  };
}

/** A term's exams, oldest first, marking which have any results out. */
export async function fetchTermExams(termId: string): Promise<{ id: string; name: string; outOf: number; published: boolean }[]> {
  const { data, error } = await supabase().from("exams").select("id, name, out_of, published_at").eq("term_id", termId)
    .returns<{ id: string; name: string; out_of: number; published_at: string | null }[]>();
  if (error) throw new Error(error.message);
  return (data ?? [])
    .sort((a, b) => (a.published_at ?? "~").localeCompare(b.published_at ?? "~") || a.name.localeCompare(b.name))
    .map((e) => ({ id: e.id, name: e.name, outOf: e.out_of, published: !!e.published_at }));
}
