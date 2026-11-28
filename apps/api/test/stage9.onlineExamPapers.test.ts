import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";

describe("online exam paper edit and archive", () => {
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

  it("keeps exam content stable after attempts and archives without blocking an active attempt", async () => {
    const tenantId = ctx.ids.tenantA;
    const headers = { authorization: `Bearer ${token}`, "x-tenant-id": tenantId };
    const call = (method: "POST" | "GET" | "PATCH", url: string, payload?: object, key?: string) => ctx.app.inject({
      method,
      url,
      headers: { ...headers, ...(key ? { "idempotency-key": key } : {}) },
      ...(payload ? { payload } : {}),
    });

    const year = await call("POST", `/v1/tenants/${tenantId}/academic-years`, { label: "Paper year", starts_on: "2020-01-01", ends_on: "2035-12-31", is_current: true }, "paper-year-001");
    expect(year.statusCode).toBe(201);
    const schoolClass = await call("POST", `/v1/tenants/${tenantId}/classes`, { academic_year_id: year.json().academic_year.id, name: "Paper class", form_level: 4 }, "paper-class-001");
    expect(schoolClass.statusCode).toBe(201);
    const subject = await call("POST", `/v1/tenants/${tenantId}/subjects`, { code: "PAPR", name: "Paper subject" }, "paper-subject-001");
    expect(subject.statusCode).toBe(201);
    const learner = await call("POST", `/v1/tenants/${tenantId}/learners`, { admission_no: "PAPER-1", full_name: "Paper Learner", gender: "female" }, "paper-learner-001");
    expect(learner.statusCode).toBe(201);
    await call("POST", `/v1/tenants/${tenantId}/class-memberships`, { learner_id: learner.json().learner.id, class_id: schoolClass.json().school_class.id }, "paper-member-001");

    const question = { id: "q1", prompt: "The sky is blue?", kind: "true_false", correct_answer: "true", points: 5 };
    const created = await call("POST", `/v1/tenants/${tenantId}/online-exam-papers`, {
      class_id: schoolClass.json().school_class.id,
      subject_id: subject.json().subject.id,
      title: "Draft quiz",
      max_score: 5,
      questions: [question],
    }, "paper-create-001");
    expect(created.statusCode).toBe(201);
    const paperId = created.json().paper.id as string;

    const editedBeforeStart = await call("PATCH", `/v1/tenants/${tenantId}/online-exam-papers/${paperId}`, {
      title: "Ready quiz",
      questions: [{ ...question, prompt: "Revised prompt" }],
    });
    expect(editedBeforeStart.statusCode).toBe(200);

    const published = await call("POST", `/v1/tenants/${tenantId}/online-exam-papers/${paperId}/publish`);
    expect(published.statusCode).toBe(200);
    const started = await call("POST", `/v1/tenants/${tenantId}/online-exam-papers/${paperId}/attempts`, { learner_id: learner.json().learner.id }, "paper-attempt-001");
    expect(started.statusCode).toBe(201);
    const attemptId = started.json().attempt.id as string;

    const editedTitle = await call("PATCH", `/v1/tenants/${tenantId}/online-exam-papers/${paperId}`, { title: "Quiz in progress" });
    expect(editedTitle.statusCode).toBe(200);
    const changedQuestions = await call("PATCH", `/v1/tenants/${tenantId}/online-exam-papers/${paperId}`, { questions: [{ ...question, prompt: "Changed after start" }] });
    expect(changedQuestions.statusCode).toBe(409);

    const archived = await call("POST", `/v1/tenants/${tenantId}/online-exam-papers/${paperId}/archive`, undefined, "paper-archive-001");
    expect(archived.statusCode).toBe(200);
    expect(archived.json().paper.archived_at).toEqual(expect.any(String));
    const archivedAgain = await call("POST", `/v1/tenants/${tenantId}/online-exam-papers/${paperId}/archive`, undefined, "paper-archive-002");
    expect(archivedAgain.statusCode).toBe(200);
    expect((await call("POST", `/v1/tenants/${tenantId}/online-exam-papers/${paperId}/publish`)).statusCode).toBe(409);
    expect((await call("POST", `/v1/tenants/${tenantId}/online-exam-papers/${paperId}/attempts`, { learner_id: learner.json().learner.id }, "paper-attempt-002")).statusCode).toBe(404);

    const papers = await call("GET", `/v1/tenants/${tenantId}/online-exam-papers`);
    expect(papers.json().papers.some((paper: { id: string }) => paper.id === paperId)).toBe(false);
    const submitted = await call("POST", `/v1/tenants/${tenantId}/online-exam-attempts/${attemptId}/submit`, { answers: { q1: "true" } }, "paper-submit-001");
    expect(submitted.statusCode).toBe(200);
    const stored = await ctx.pool.query<{ id: string; archived_at: Date | null }>("SELECT id, archived_at FROM online_exam_papers WHERE tenant_id = $1 AND id = $2", [tenantId, paperId]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.archived_at).toEqual(expect.any(Date));
  });
});
