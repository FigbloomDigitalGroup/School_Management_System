import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { createTestApp, type FixtureIds } from "./support.js";
import { loadSpec, responseSchema, validate } from "./support/openapiConformance.js";
import { STRUCTURE_REQUEST_SCHEMAS } from "../src/http/routes/academicsStructure.js";
import { ASSESSMENT_REQUEST_SCHEMAS } from "../src/http/routes/academicsAssessments.js";
import { CBE_REQUEST_SCHEMAS } from "../src/http/routes/academicsCbe.js";
import { HIGHER_REQUEST_SCHEMAS } from "../src/http/routes/academicsHigher.js";
import { ATTENDANCE_REQUEST_SCHEMAS } from "../src/http/routes/attendance.js";

/**
 * OA-1 drift guard for the Stage 9/10 contract (both directions):
 *  1. every runtime request schema equals the spec's request body (generated from zod, so any later
 *     change to either side fails here);
 *  2. every Stage 9/10 operation documents a 2xx response schema and a $ref request body;
 *  3. a tour calls EVERY Stage 9/10 operation and validates each success body against the documented
 *     schema (undocumented properties fail), and asserts the tour covered them all.
 */
type Json = any;

const spec = loadSpec();
const REGISTRY: Record<string, z.ZodType> = {
  ...STRUCTURE_REQUEST_SCHEMAS,
  ...ASSESSMENT_REQUEST_SCHEMAS,
  ...CBE_REQUEST_SCHEMAS,
  ...HIGHER_REQUEST_SCHEMAS,
  ...ATTENDANCE_REQUEST_SCHEMAS,
};

function stage910Ops(): string[] {
  const out: string[] = [];
  for (const [p, item] of Object.entries<Json>(spec.paths)) {
    for (const [m, op] of Object.entries<Json>(item)) {
      if (op?.tags?.some((t: string) => t === "academics" || t === "attendance")) out.push(`${m.toUpperCase()} ${p}`);
    }
  }
  return out.sort();
}

describe("OA-1 static contract", () => {
  it("every runtime request schema equals its OpenAPI request body", () => {
    const drift: string[] = [];
    for (const [key, schema] of Object.entries(REGISTRY)) {
      const [method, path] = key.split(" ") as [string, string];
      const body = spec.paths[path]?.[method.toLowerCase()]?.requestBody?.content?.["application/json"]?.schema;
      if (!body?.$ref) {
        drift.push(`${key}: no $ref request body`);
        continue;
      }
      const documented = String(body.$ref).slice(2).split("/").reduce((cur: Json, k: string) => cur?.[k], spec);
      const runtime = z.toJSONSchema(schema, { unrepresentable: "any" }) as Json;
      delete runtime.$schema;
      if (!isDeepStrictEqual(documented, runtime)) drift.push(`${key}: spec and runtime schemas differ`);
    }
    expect(drift).toEqual([]);
  });

  it("every Stage 9/10 operation has a 2xx schema, and every body-taking one a registered request schema", () => {
    const bad: string[] = [];
    for (const key of stage910Ops()) {
      const [method, path] = key.split(" ") as [string, string];
      const op = spec.paths[path][method.toLowerCase()];
      const ok = Object.entries<Json>(op.responses).filter(([c]) => c.startsWith("2"));
      if (ok.length === 0 || !ok.every(([, r]) => r.content?.["application/json"]?.schema)) bad.push(`${key}: 2xx schema missing`);
      const rb = op.requestBody?.content?.["application/json"]?.schema;
      if (rb && !REGISTRY[key]) bad.push(`${key}: request body has no runtime schema registration`);
      if (rb && rb.additionalProperties === true) bad.push(`${key}: request body allows arbitrary properties`);
    }
    expect(bad).toEqual([]);
    // 84 + migration 101: PATCH subject, PATCH class, class archive, PATCH teaching assignment, its archive; + migration 107: PATCH he-section;
    // + migration 110: publish an online exam paper; + migration 125: PATCH and archive homework;
    // + migration 127: PATCH, publish, unpublish and archive a learning material.
    expect(stage910Ops().length).toBe(97);
  });
});

describe("OA-1 runtime conformance tour", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let token: string;
  const covered = new Set<string>();
  const problems: string[] = [];

  async function call(method: "GET" | "POST" | "PUT" | "PATCH", template: string, vars: Record<string, string>, payload?: unknown, query = "") {
    const url = template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `MISSING_${k}`) + query;
    const res = await ctx.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, "x-tenant-id": ids.tenantA },
      ...(payload === undefined ? {} : { payload: payload as Json }),
    });
    const key = `${method} ${template}`;
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const schema = responseSchema(spec, method, template, res.statusCode);
      if (typeof schema === "string") problems.push(schema);
      else {
        const errs = validate(spec, schema, res.json());
        if (errs.length) problems.push(`${key} ${res.statusCode}: ${errs.slice(0, 5).join("; ")}`);
        else covered.add(key);
      }
    } else {
      problems.push(`${key}: unexpected ${res.statusCode} ${res.body.slice(0, 200)}`);
    }
    return res.json() as Json;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    const login = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "admin-a@example.com", password: "correct-horse-battery" },
    });
    token = login.json().token as string;
    await ctx.pool.query(
      `INSERT INTO school_profiles (tenant_id, institution_type) VALUES ($1, 'higher_ed')
       ON CONFLICT (tenant_id) DO UPDATE SET institution_type = 'higher_ed'`,
      [ids.tenantA],
    );
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("every Stage 9/10 operation answers with a body that matches its documented schema", async () => {
    const T = "/v1/tenants/{tenantId}";
    const v: Record<string, string> = { tenantId: ids.tenantA };
    const day = await ctx.pool.query<{ d: string }>(
      `SELECT (now() AT TIME ZONE COALESCE(t.timezone, 'Africa/Nairobi'))::date::text AS d FROM tenants t WHERE t.id = $1`,
      [ids.tenantA],
    );
    const today = day.rows[0]!.d;

    // structure
    v.academicYearId = (await call("POST", `${T}/academic-years`, v, { label: "Tour", starts_on: "2020-01-01", ends_on: "2035-12-31" })).academic_year.id;
    await call("GET", `${T}/academic-years`, v);
    await call("GET", `${T}/academic-years/{academicYearId}`, v);
    await call("POST", `${T}/academic-years/{academicYearId}/set-current`, v, {});
    v.termId = (await call("POST", `${T}/academic-terms`, v, { academic_year_id: v.academicYearId, index: 1, label: "Tour T1", starts_on: "2020-01-01", ends_on: "2035-12-31" })).term.id;
    await call("GET", `${T}/academic-terms`, v);
    await call("GET", `${T}/academic-terms/{termId}`, v);
    await call("POST", `${T}/academic-terms/{termId}/set-current`, v, {});
    v.subjectId = (await call("POST", `${T}/subjects`, v, { code: "TOUR", name: "Tour subject" })).subject.id;
    await call("GET", `${T}/subjects`, v);
    await call("PATCH", `${T}/subjects/{subjectId}`, v, { education_level: "secondary", min_form_level: 1, max_form_level: 4, is_core: false });
    v.classId = (await call("POST", `${T}/classes`, v, { academic_year_id: v.academicYearId, name: "Tour class", form_level: 1, stream: "East", room: "Tour room" })).school_class.id;
    await call("GET", `${T}/classes`, v);
    await call("GET", `${T}/classes/{classId}`, v);
    await call("PATCH", `${T}/classes/{classId}`, v, { room: "Tour lab", class_teacher_staff_id: null });
    const learner = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: { authorization: `Bearer ${token}`, "x-tenant-id": ids.tenantA },
      payload: { admission_no: "TOUR1", full_name: "Tour Learner", gender: "female" },
    });
    v.learnerId = learner.json().learner.id;
    v.membershipId = (await call("POST", `${T}/class-memberships`, v, { learner_id: v.learnerId, class_id: v.classId })).membership.id;
    await call("GET", `${T}/class-memberships`, v);
    const staff = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/staff`,
      headers: { authorization: `Bearer ${token}`, "x-tenant-id": ids.tenantA },
      payload: { full_name: "Tour Teacher", classification: "teacher", userId: ids.teacherA },
    });
    const assignmentId = (await call("POST", `${T}/teaching-assignments`, v, { staff_member_id: staff.json().staff.id, class_id: v.classId, subject_id: v.subjectId })).assignment.id;
    v.assignmentId = assignmentId;
    await call("GET", `${T}/teaching-assignments`, v);
    const secondStaff = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/staff`,
      headers: { authorization: `Bearer ${token}`, "x-tenant-id": ids.tenantA },
      payload: { full_name: "Tour Teacher Two", classification: "teacher" },
    });
    await call("PATCH", `${T}/teaching-assignments/{assignmentId}`, v, { staff_member_id: secondStaff.json().staff.id });
    await call("POST", `${T}/timetable-slots`, v, { class_id: v.classId, subject_id: v.subjectId, teaching_assignment_id: assignmentId, day_of_week: 2, starts_at: "08:00", ends_at: "08:40", room: "Lab" });
    await call("GET", `${T}/timetable-slots`, v, undefined, `?classId=${v.classId}`);

    // assessments
    v.assessmentId = (await call("POST", `${T}/assessments`, v, { class_id: v.classId, subject_id: v.subjectId, term_id: v.termId, title: "Tour exam", kind: "exam", max_score: 50, components: [{ name: "Paper 1", max_score: 50 }] })).assessment.id;
    await call("GET", `${T}/assessments`, v);
    await call("POST", `${T}/assessments/{assessmentId}/marks`, v, { learner_id: v.learnerId, score: 20, grade: "C" });
    await call("GET", `${T}/assessments/{assessmentId}/marks`, v);
    await call("POST", `${T}/assessments/{assessmentId}/publish`, v, {});
    await call("POST", `${T}/assessments/{assessmentId}/mark-corrections`, v, { learner_id: v.learnerId, score: 22, grade: "C", reason: "Tour correction", row_version: 1 });
    await call("POST", `${T}/assessments/{assessmentId}/close`, v);
    await call("GET", `${T}/assessments/{assessmentId}/mark-corrections`, v);
    v.homeworkId = (await call("POST", `${T}/homework-items`, v, { class_id: v.classId, subject_id: v.subjectId, term_id: v.termId, title: "Tour homework", due_on: "2030-01-01", body: "Read" })).homework.id;
    await call("PATCH", `${T}/homework-items/{homeworkId}`, v, { body: "" });
    await call("GET", `${T}/homework-items`, v);
    await call("POST", `${T}/homework-items/{homeworkId}/archive`, v);
    v.materialId = (await call("POST", `${T}/learning-materials`, v, { title: "Tour notes", description: "Notes", class_id: v.classId, subject_id: v.subjectId })).material.id;
    await call("PATCH", `${T}/learning-materials/{materialId}`, v, { title: "Tour notes, edited" });
    await call("POST", `${T}/learning-materials/{materialId}/publish`, v);
    await call("POST", `${T}/learning-materials/{materialId}/unpublish`, v);
    await call("GET", `${T}/learning-materials`, v);
    await call("POST", `${T}/learning-materials/{materialId}/archive`, v);
    await call("POST", `${T}/grading-schemes`, v, { name: "Tour scheme", rules: { bands: [{ min: 0, max: 50, grade: "D" }, { min: 50, max: 100, grade: "A" }] } });
    await call("GET", `${T}/grading-schemes`, v);
    await call("POST", `${T}/report-cards`, v, { term_id: v.termId, class_id: v.classId });
    await call("GET", `${T}/report-cards`, v, undefined, `?classId=${v.classId}&termId=${v.termId}`);

    // CBC/CBE
    v.provenanceId = (await call("POST", `${T}/curriculum-provenance`, v, { source_kind: "school_configured", source_label: "Tour notes", source_uri: "https://example.org/x", notes: "School configured" })).provenance.id;
    await call("GET", `${T}/curriculum-provenance`, v);
    v.areaId = (await call("POST", `${T}/learning-areas`, v, {
      provenance_id: v.provenanceId,
      code: "TA",
      name: "Tour area",
      education_level: "junior_secondary",
      min_grade: 7,
      max_grade: 9,
      is_core: true,
    })).learning_area.id;
    await call("GET", `${T}/learning-areas`, v);
    v.strandId = (await call("POST", `${T}/strands`, v, { learning_area_id: v.areaId, code: "TS", name: "Tour strand" })).strand.id;
    await call("GET", `${T}/strands`, v);
    v.subStrandId = (await call("POST", `${T}/sub-strands`, v, { strand_id: v.strandId, code: "TSS", name: "Tour sub" })).sub_strand.id;
    await call("GET", `${T}/sub-strands`, v);
    await call("POST", `${T}/learning-outcomes`, v, { sub_strand_id: v.subStrandId, code: "TO", statement: "Can tour" });
    await call("GET", `${T}/learning-outcomes`, v);
    v.rubricId = (await call("POST", `${T}/rubric-configs`, v, { name: "Tour rubric", descriptors: [{ level_code: "ME", label: "Meets", points: 3 }, { level_code: "EE", label: "Exceeds", points: 4 }] })).rubric_config.id;
    await call("GET", `${T}/rubric-configs`, v);
    await call("GET", `${T}/curriculum-reference`, v);
    v.cbeAssessmentId = (await call("POST", `${T}/cbe-assessments`, v, { class_id: v.classId, learning_area_id: v.areaId, term_id: v.termId, title: "Tour CBE", rubric_config_id: v.rubricId })).cbe_assessment.id;
    await call("GET", `${T}/cbe-assessments`, v);
    await call("GET", `${T}/cbe-assessments/{cbeAssessmentId}`, v);
    await call("POST", `${T}/cbe-assessments/{cbeAssessmentId}/results`, v, { learner_id: v.learnerId, strand_id: v.strandId, level_code: "ME", points: 3 });
    await call("POST", `${T}/cbe-assessments/{cbeAssessmentId}/results`, v, { learner_id: v.learnerId, strand_id: v.strandId, level_code: "EE", points: 4, row_version: 1, reason: "Tour revision" });
    await call("GET", `${T}/cbe-assessments/{cbeAssessmentId}/results`, v);
    await call("POST", `${T}/cbe-assessments/{cbeAssessmentId}/publish`, v);
    await call("POST", `${T}/cbe-assessments/{cbeAssessmentId}/close`, v);
    await call("GET", `${T}/learners/{learnerId}/cbe-progress`, v, undefined, `?termId=${v.termId}`);
    await call("POST", `${T}/competency-ratings`, v, { term_id: v.termId, learner_id: v.learnerId, kind: "competency", item: "communication", level_code: "ME" });
    await call("GET", `${T}/competency-ratings`, v, undefined, `?termId=${v.termId}`);
    await call("POST", `${T}/evidence-assets`, v, { provenance_id: v.provenanceId, title: "Tour evidence", learner_id: v.learnerId });
    await call("GET", `${T}/evidence-assets`, v);

    // higher education + online assessment
    const courseId = (await call("POST", `${T}/he-courses`, v, { code: "TOUR101", title: "Tour course", credit_hours: 3 })).course.id;
    await call("GET", `${T}/he-courses`, v);
    const sectionId = (await call("POST", `${T}/he-sections`, v, { course_id: courseId, term_id: v.termId, label: "A", instructor_staff_id: null })).section.id;
    v.sectionId = sectionId;
    await call("GET", `${T}/he-sections`, v);
    await call("PATCH", `${T}/he-sections/{sectionId}`, v, { instructor_staff_id: staff.json().staff.id });
    v.enrolmentId = (await call("POST", `${T}/he-enrolments`, v, { section_id: sectionId, learner_id: v.learnerId })).enrolment.id;
    await call("GET", `${T}/he-enrolments`, v);
    await call("POST", `${T}/he-enrolments/{enrolmentId}/grade`, v, { score: 60, grade: "B" });
    await call("GET", `${T}/he-enrolments/{enrolmentId}/grade`, v);
    await call("POST", `${T}/he-enrolments/{enrolmentId}/grade-corrections`, v, { score: 65, grade: "B", reason: "Tour correction", row_version: 1 });
    await call("GET", `${T}/he-enrolments/{enrolmentId}/grade-revisions`, v);
    v.paperId = (await call("POST", `${T}/online-exam-papers`, v, { class_id: v.classId, subject_id: v.subjectId, title: "Tour paper", max_score: 20 })).paper.id;
    await call("GET", `${T}/online-exam-papers`, v);
    await call("POST", `${T}/online-exam-papers/{paperId}/publish`, v); // migration 110 (docs/STUDENT-ACCOUNTS.md)
    v.attemptId =(await call("POST", `${T}/online-exam-papers/{paperId}/attempts`, v, { learner_id: v.learnerId })).attempt.id;
    await call("POST", `${T}/online-exam-attempts/{attemptId}/submit`, v, { score: 15 });

    // attendance
    await call("GET", `${T}/attendance-settings`, v);
    await call("PUT", `${T}/attendance-settings`, v, { afternoon_enabled: true, percentage_mode: "session" });
    await call("POST", `${T}/attendance-registers`, v, { learner_id: v.learnerId, class_id: v.classId, term_id: v.termId, taken_on: today, mark: "present", note: "On time" });
    await call("GET", `${T}/attendance-registers`, v);
    await call("GET", `${T}/attendance-counted`, v, undefined, `?termId=${v.termId}`);
    v.signOutId = (await call("POST", `${T}/early-sign-outs`, v, { learner_id: v.learnerId, reason: "Clinic", collected_by_name: "Tour Parent", collected_by_relationship: "Mother", id_number: "TOUR123", phone: "+254700000111", authorised_by: "Office", note: "Tour" })).sign_out.id;
    await call("GET", `${T}/early-sign-outs`, v);
    await call("GET", `${T}/early-sign-outs/{signOutId}`, v);
    await call("POST", `${T}/early-sign-outs/{signOutId}/void`, v, { reason: "Entered in error" });
    await call("POST", `${T}/class-memberships/{membershipId}/archive`, v, {});
    // migration 101: end the assignment, then archive the class (its only learner has just left it)
    await call("POST", `${T}/teaching-assignments/{assignmentId}/archive`, v);
    await call("POST", `${T}/classes/{classId}/archive`, v);

    expect(problems).toEqual([]);
    const missing = stage910Ops().filter((k) => !covered.has(k));
    expect(missing).toEqual([]);
  });
});
