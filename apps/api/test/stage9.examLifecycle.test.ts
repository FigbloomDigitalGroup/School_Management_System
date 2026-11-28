import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";

describe("exam rename, mark count, and archive", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    const login = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "admin-a@example.com", password: "correct-horse-battery" },
    });
    expect(login.statusCode).toBe(200);
    token = login.json().token as string;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("renames exams, reports mark counts, and archives without deleting historic data", async () => {
    const tenantId = ctx.ids.tenantA;
    const headers = { authorization: `Bearer ${token}`, "x-tenant-id": tenantId };
    const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object, key?: string) => ctx.app.inject({
      method,
      url,
      headers: { ...headers, ...(key ? { "idempotency-key": key } : {}) },
      ...(payload ? { payload } : {}),
    });
    const year = await call("POST", `/v1/tenants/${tenantId}/academic-years`, { label: "Exam year", starts_on: "2020-01-01", ends_on: "2035-12-31", is_current: true }, "exam-year-001");
    expect(year.statusCode).toBe(201);
    const term = await call("POST", `/v1/tenants/${tenantId}/academic-terms`, {
      academic_year_id: year.json().academic_year.id, index: 1, label: "Term 1", starts_on: "2020-01-01", ends_on: "2035-12-31", is_current: true,
    }, "exam-term-001");
    expect(term.statusCode).toBe(201);
    const schoolClass = await call("POST", `/v1/tenants/${tenantId}/classes`, { academic_year_id: year.json().academic_year.id, name: "Exam class", form_level: 4 }, "exam-class-001");
    expect(schoolClass.statusCode).toBe(201);
    const subject = await call("POST", `/v1/tenants/${tenantId}/subjects`, { code: "EXAM", name: "Exam subject" }, "exam-subject-001");
    expect(subject.statusCode).toBe(201);
    const learner = await call("POST", `/v1/tenants/${tenantId}/learners`, { admission_no: "EXAM-1", full_name: "Exam Learner", gender: "female" }, "exam-learner-001");
    expect(learner.statusCode).toBe(201);
    await call("POST", `/v1/tenants/${tenantId}/class-memberships`, { learner_id: learner.json().learner.id, class_id: schoolClass.json().school_class.id }, "exam-membership-001");

    const created = await call("POST", `/v1/tenants/${tenantId}/assessments`, {
      class_id: schoolClass.json().school_class.id,
      subject_id: subject.json().subject.id,
      term_id: term.json().term.id,
      title: "Midterm",
      kind: "exam",
      max_score: 100,
    }, "exam-create-001");
    expect(created.statusCode).toBe(201);
    const assessmentId = created.json().assessment.id as string;
    expect(created.json().assessment).toMatchObject({ archived_at: null, marks_entered: 0 });

    const mark = await call("POST", `/v1/tenants/${tenantId}/assessments/${assessmentId}/marks`, { learner_id: learner.json().learner.id, score: 84 }, "exam-mark-001");
    expect(mark.statusCode).toBe(201);
    const listed = await call("GET", `/v1/tenants/${tenantId}/assessments?termId=${term.json().term.id}`);
    expect(listed.json().assessments.find((row: { id: string }) => row.id === assessmentId).marks_entered).toBe(1);

    const renamed = await call("PATCH", `/v1/tenants/${tenantId}/assessments/${assessmentId}`, { title: "Term 1 examination" });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().assessment).toMatchObject({ title: "Term 1 examination", marks_entered: 1 });
    expect((await call("POST", `/v1/tenants/${tenantId}/assessments/${assessmentId}/publish`, undefined, "exam-publish-001")).statusCode).toBe(200);

    const archived = await call("POST", `/v1/tenants/${tenantId}/assessments/${assessmentId}/archive`, undefined, "exam-archive-001");
    expect(archived.statusCode).toBe(200);
    expect(archived.json().assessment).toMatchObject({ marks_entered: 1, title: "Term 1 examination" });
    expect(archived.json().assessment.archived_at).toEqual(expect.any(String));
    const archiveReplay = await call("POST", `/v1/tenants/${tenantId}/assessments/${assessmentId}/archive`, undefined, "exam-archive-002");
    expect(archiveReplay.statusCode).toBe(200);
    expect(archiveReplay.json().assessment.archived_at).toBe(archived.json().assessment.archived_at);

    const active = await call("GET", `/v1/tenants/${tenantId}/assessments?termId=${term.json().term.id}`);
    expect(active.json().assessments.some((row: { id: string }) => row.id === assessmentId)).toBe(false);
    expect((await call("POST", `/v1/tenants/${tenantId}/assessments/${assessmentId}/marks`, { learner_id: learner.json().learner.id, score: 85 }, "exam-mark-002")).statusCode).toBe(404);

    const report = await call("POST", `/v1/tenants/${tenantId}/report-cards`, { term_id: term.json().term.id, class_id: schoolClass.json().school_class.id }, "exam-report-card-001");
    expect(report.statusCode).toBe(201);
    expect(report.json().report_card.figures.assessment_ids).not.toContain(assessmentId);
    const retained = await ctx.pool.query<{ id: string; archived_at: Date | null }>("SELECT id, archived_at FROM assessments WHERE tenant_id = $1 AND id = $2", [tenantId, assessmentId]);
    expect(retained.rows).toHaveLength(1);
    expect(retained.rows[0]?.archived_at).toEqual(expect.any(Date));
  });
});
