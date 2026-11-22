import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

async function loginEmail(app: Ctx["app"], email: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login/email",
    payload: { email, password: "correct-horse-battery" },
  });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

async function loginLoginId(app: Ctx["app"], tenantId: string, loginId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login/login-id",
    payload: { tenantId, loginId, password: "correct-horse-battery" },
  });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

function bearer(token: string, tenantId: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "x-tenant-id": tenantId };
}

describe("Stage 9 academics", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let admin: string;
  let teacherB: string;
  let yearId: string;
  let termId: string;
  let classId: string;
  let subjectId: string;
  let learnerId: string;
  let staffId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    admin = await loginEmail(ctx.app, "admin-a@example.com");
    teacherB = await loginLoginId(ctx.app, ids.tenantB, "TC-0001");
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("rejects another school's session and a cross-school learner foreign key", async () => {
    const denied = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/academic-years`,
      headers: bearer(teacherB, ids.tenantA),
    });
    expect(denied.statusCode).toBe(403);

    const year = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/academic-years`,
      headers: bearer(admin, ids.tenantA),
      payload: { label: "2026", starts_on: "2020-01-01", ends_on: "2035-12-31", is_current: true },
    });
    expect(year.statusCode).toBe(201);
    yearId = year.json().academic_year.id as string;

    const other = await ctx.pool.query<{ id: string }>(
      `INSERT INTO learners (tenant_id, admission_no, full_name, gender)
       VALUES ($1, 'B-900', 'Other School Learner', 'male') RETURNING id`,
      [ids.tenantB],
    );
    const term = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/academic-terms`,
      headers: bearer(admin, ids.tenantA),
      payload: {
        academic_year_id: yearId,
        index: 1,
        label: "Term 1",
        starts_on: "2020-01-01",
        ends_on: "2035-12-31",
        is_current: true,
      },
    });
    expect(term.statusCode).toBe(201);
    termId = term.json().term.id as string;

    const schoolClass = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/classes`,
      headers: bearer(admin, ids.tenantA),
      payload: { academic_year_id: yearId, name: "Form 1 East", form_level: 1 },
    });
    expect(schoolClass.statusCode).toBe(201);
    classId = schoolClass.json().school_class.id as string;

    const cross = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/class-memberships`,
      headers: bearer(admin, ids.tenantA),
      payload: { learner_id: other.rows[0]!.id, class_id: classId },
    });
    expect(cross.statusCode).toBe(400);
    expect(cross.json().error.code).toBe("validation_error");
  });

  it("creates a year, term, class, membership and teaching assignment", async () => {
    const subject = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/subjects`,
      headers: bearer(admin, ids.tenantA),
      payload: { code: "MATH", name: "Mathematics" },
    });
    expect(subject.statusCode).toBe(201);
    subjectId = subject.json().subject.id as string;

    const learner = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(admin, ids.tenantA),
      payload: { admission_no: "4601", full_name: "Amina Yusuf", gender: "female" },
    });
    expect(learner.statusCode).toBe(201);
    learnerId = learner.json().learner.id as string;

    const membership = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/class-memberships`,
      headers: bearer(admin, ids.tenantA),
      payload: { learner_id: learnerId, class_id: classId },
    });
    expect(membership.statusCode).toBe(201);
    expect(membership.json().membership).toMatchObject({
      learner_id: learnerId,
      class_id: classId,
      academic_year_id: yearId,
      active: true,
    });

    const staff = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/staff`,
      headers: bearer(admin, ids.tenantA),
      payload: { full_name: "Teacher A", classification: "teacher", userId: ids.teacherA },
    });
    expect(staff.statusCode).toBe(201);
    staffId = staff.json().staff.id as string;

    const assignment = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/teaching-assignments`,
      headers: bearer(admin, ids.tenantA),
      payload: { staff_member_id: staffId, class_id: classId, subject_id: subjectId },
    });
    expect(assignment.statusCode).toBe(201);
    expect(assignment.json().assignment).toMatchObject({
      staff_member_id: staffId,
      class_id: classId,
      subject_id: subjectId,
      active: true,
    });

    const listed = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/academic-terms?academicYearId=${yearId}`,
      headers: bearer(admin, ids.tenantA),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().terms.map((row: { id: string }) => row.id)).toContain(termId);
  });

  it("rejects a stale mark row_version with 409", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/assessments`,
      headers: bearer(admin, ids.tenantA),
      payload: {
        class_id: classId,
        subject_id: subjectId,
        term_id: termId,
        title: "Midterm",
        kind: "exam",
        max_score: 100,
      },
    });
    expect(created.statusCode).toBe(201);
    const assessmentId = created.json().assessment.id as string;

    const first = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/assessments/${assessmentId}/marks`,
      headers: bearer(admin, ids.tenantA),
      payload: { learner_id: learnerId, score: 10 },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().mark.row_version).toBe(1);

    const second = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/assessments/${assessmentId}/marks`,
      headers: { ...bearer(admin, ids.tenantA), "if-match": "1" },
      payload: { learner_id: learnerId, score: 12, row_version: 1 },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().mark.row_version).toBe(2);
    expect(Number(second.json().mark.score)).toBe(12);

    const stale = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/assessments/${assessmentId}/marks`,
      headers: bearer(admin, ids.tenantA),
      payload: { learner_id: learnerId, score: 8, row_version: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("conflict");

    const published = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/assessments/${assessmentId}/publish`,
      headers: bearer(admin, ids.tenantA),
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().assessment.status).toBe("published");
  });

  it("records a school-configured learning area with provenance and no official catalogue claim", async () => {
    const official = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/curriculum-provenance`,
      headers: bearer(admin, ids.tenantA),
      payload: { source_kind: "platform_reference", source_label: "KICD" },
    });
    expect(official.statusCode).toBe(400);

    const provenance = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/curriculum-provenance`,
      headers: bearer(admin, ids.tenantA),
      payload: {
        source_kind: "school_configured",
        source_label: "School CBC notes 2026",
        notes: "Configured by the school. Not an official catalogue.",
      },
    });
    expect(provenance.statusCode).toBe(201);
    expect(provenance.json().provenance).toMatchObject({
      source_kind: "school_configured",
      official_catalogue: false,
    });

    const area = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learning-areas`,
      headers: bearer(admin, ids.tenantA),
      payload: {
        provenance_id: provenance.json().provenance.id,
        code: "MATH-CBC",
        name: "Mathematics",
      },
    });
    expect(area.statusCode).toBe(201);
    expect(area.json().learning_area).toMatchObject({
      official_catalogue: false,
      provenance_id: provenance.json().provenance.id,
    });
    expect(JSON.stringify(area.json())).not.toMatch(/official KICD catalogue/i);
  });
});
