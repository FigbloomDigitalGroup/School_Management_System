import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createTestApp, type FixtureIds } from "./support.js";

/**
 * Stage 9/10 independent review (Claude, 2026-11-19): academics regression probes for
 * A9-1, A9-3, A9-4, A9-5, A9-7, A9-15 and the provenance audit (A9-13).
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

function bearer(token: string, tenantId: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "x-tenant-id": tenantId };
}

describe("Stage 9 independent review probes", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let admin: string;
  let yearId: string;
  let termId: string;
  let classX: string;
  let classY: string;
  let subjectId: string;
  let inX: string;
  let inY: string;

  async function post(path: string, payload: unknown, headers: Record<string, string> = {}) {
    return ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}${path}`,
      headers: { ...bearer(admin, ids.tenantA), ...headers },
      payload: payload as Record<string, unknown>,
    });
  }

  async function created<T = string>(path: string, payload: unknown, key: string, field = "id"): Promise<T> {
    const res = await post(path, payload);
    expect(res.statusCode, `${path} ${res.body}`).toBe(201);
    return res.json()[key][field] as T;
  }

  async function asApp<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.tenantA]);
      return await fn(c);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }

  async function sqlState(p: Promise<unknown>): Promise<string | null> {
    try {
      await p;
      return null;
    } catch (err) {
      return (err as { code?: string }).code ?? "unknown";
    }
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    const login = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "admin-a@example.com", password: "correct-horse-battery" },
    });
    admin = login.json().token as string;

    yearId = await created("/academic-years", { label: "S9 review", starts_on: "2020-01-01", ends_on: "2035-12-31" }, "academic_year");
    termId = await created(
      "/academic-terms",
      { academic_year_id: yearId, index: 1, label: "T1", starts_on: "2020-01-01", ends_on: "2035-12-31" },
      "term",
    );
    classX = await created("/classes", { academic_year_id: yearId, name: "S9 X" }, "school_class");
    classY = await created("/classes", { academic_year_id: yearId, name: "S9 Y" }, "school_class");
    subjectId = await created("/subjects", { code: "S9R", name: "Review subject" }, "subject");
    inX = await created("/learners", { admission_no: "9201", full_name: "In X", gender: "male" }, "learner");
    inY = await created("/learners", { admission_no: "9202", full_name: "In Y", gender: "male" }, "learner");
    expect((await post("/class-memberships", { learner_id: inX, class_id: classX })).statusCode).toBe(201);
    expect((await post("/class-memberships", { learner_id: inY, class_id: classY })).statusCode).toBe(201);
  }, 180_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("A9-1: a mark can only be written for a learner of the assessment's class", async () => {
    const assessmentId = await created(
      "/assessments",
      { class_id: classX, subject_id: subjectId, term_id: termId, title: "Review exam", kind: "exam", max_score: 100 },
      "assessment",
    );
    const outsider = await post(`/assessments/${assessmentId}/marks`, { learner_id: inY, score: 50 });
    expect(outsider.statusCode).toBe(400);
    const stored = await ctx.pool.query(`SELECT 1 FROM mark_entries WHERE learner_id = $1`, [inY]);
    expect(stored.rowCount).toBe(0);
    const member = await post(`/assessments/${assessmentId}/marks`, { learner_id: inX, score: 50 });
    expect(member.statusCode).toBe(201);
  });

  it("A9-15: the runtime role cannot update a mark without advancing row_version by one", async () => {
    await asApp(async (c) => {
      expect(await sqlState(c.query(`UPDATE mark_entries SET score = 1 WHERE learner_id = $1`, [inX]))).toBe("23514");
    });
    await asApp(async (c) => {
      expect(
        await sqlState(c.query(`UPDATE mark_entries SET score = 1, row_version = row_version + 5 WHERE learner_id = $1`, [inX])),
      ).toBe("23514");
    });
    await asApp(async (c) => {
      expect(
        await sqlState(c.query(`UPDATE mark_entries SET score = 1, row_version = row_version + 1 WHERE learner_id = $1`, [inX])),
      ).toBeNull();
    });
  });

  it("A9-3: a CBE result must name a strand/outcome of the assessment's area and a learner of its class", async () => {
    const provenance = await created(
      "/curriculum-provenance",
      { source_kind: "school_configured", source_label: "Review notes" },
      "provenance",
    );
    const areaA = await created("/learning-areas", { provenance_id: provenance, code: "RA", name: "Area A" }, "learning_area");
    const areaB = await created("/learning-areas", { provenance_id: provenance, code: "RB", name: "Area B" }, "learning_area");
    const strandA = await created("/strands", { learning_area_id: areaA, code: "SA", name: "Strand A" }, "strand");
    const strandA2 = await created("/strands", { learning_area_id: areaA, code: "SA2", name: "Strand A2" }, "strand");
    const strandB = await created("/strands", { learning_area_id: areaB, code: "SB", name: "Strand B" }, "strand");
    const subB = await created("/sub-strands", { strand_id: strandB, code: "SSB", name: "Sub B" }, "sub_strand");
    const outcomeB = await created("/learning-outcomes", { sub_strand_id: subB, code: "OB", statement: "Outcome B" }, "learning_outcome");
    const subA2 = await created("/sub-strands", { strand_id: strandA2, code: "SSA2", name: "Sub A2" }, "sub_strand");
    const outcomeA2 = await created("/learning-outcomes", { sub_strand_id: subA2, code: "OA2", statement: "Outcome A2" }, "learning_outcome");
    const cbe = await created(
      "/cbe-assessments",
      { class_id: classX, learning_area_id: areaA, term_id: termId, title: "Review CBE" },
      "cbe_assessment",
    );
    const result = (body: Record<string, unknown>) =>
      post(`/cbe-assessments/${cbe}/results`, { level_code: "ME", points: 3, ...body });

    expect((await result({ learner_id: inX, strand_id: strandB })).statusCode).toBe(400);
    expect((await result({ learner_id: inX, learning_outcome_id: outcomeB })).statusCode).toBe(400);
    expect((await result({ learner_id: inX, strand_id: strandA, learning_outcome_id: outcomeA2 })).statusCode).toBe(400);
    expect((await result({ learner_id: inY, strand_id: strandA })).statusCode).toBe(400);
    const stored = await ctx.pool.query(`SELECT 1 FROM cbe_results WHERE cbe_assessment_id = $1`, [cbe]);
    expect(stored.rowCount).toBe(0);
    expect((await result({ learner_id: inX, strand_id: strandA })).statusCode).toBe(201);
    expect((await result({ learner_id: inX, learning_outcome_id: outcomeA2 })).statusCode).toBe(201);
  });

  it("A9-13: creating curriculum provenance is audited without free text", async () => {
    const events = await ctx.pool.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM security_audit_events WHERE event_type = 'academics.cbe.provenance.created'`,
    );
    expect(events.rowCount).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(events.rows)).not.toContain("Review notes");
  });

  describe("online exam attempts (A9-4, A9-5)", () => {
    let paperId: string;

    beforeAll(async () => {
      paperId = await created(
        "/online-exam-papers",
        { class_id: classX, subject_id: subjectId, title: "Review paper", max_score: 40 },
        "paper",
      );
    });

    it("refuses a learner outside the paper's class", async () => {
      expect((await post(`/online-exam-papers/${paperId}/attempts`, { learner_id: inY })).statusCode).toBe(400);
    });

    it("allows one in-progress attempt per learner, replays start and submit with the same key", async () => {
      const key = { "idempotency-key": "review-start-0001" };
      const first = await post(`/online-exam-papers/${paperId}/attempts`, { learner_id: inX }, key);
      expect(first.statusCode).toBe(201);
      const again = await post(`/online-exam-papers/${paperId}/attempts`, { learner_id: inX }, key);
      expect(again.statusCode).toBe(201);
      expect(again.headers["idempotent-replayed"]).toBe("true");
      expect(again.json()).toEqual(first.json());

      const second = await post(`/online-exam-papers/${paperId}/attempts`, { learner_id: inX });
      expect(second.statusCode).toBe(409);

      const attemptId = first.json().attempt.id as string;
      const submitKey = { "idempotency-key": "review-submit-0001" };
      const submitted = await post(`/online-exam-attempts/${attemptId}/submit`, { score: 30 }, submitKey);
      expect(submitted.statusCode).toBe(200);
      const replayed = await post(`/online-exam-attempts/${attemptId}/submit`, { score: 30 }, submitKey);
      expect(replayed.statusCode).toBe(200);
      expect(replayed.headers["idempotent-replayed"]).toBe("true");
      expect(replayed.json()).toEqual(submitted.json());

      await asApp(async (c) => {
        expect(
          await sqlState(c.query(`UPDATE online_exam_attempts SET status = 'in_progress', submitted_at = NULL WHERE id = $1`, [attemptId])),
        ).toBe("23514");
      });

      const retake = await post(`/online-exam-papers/${paperId}/attempts`, { learner_id: inX });
      expect(retake.statusCode).toBe(201);
      const started = await ctx.pool.query(
        `SELECT 1 FROM security_audit_events WHERE event_type = 'academics.online_exam.attempt_started'`,
      );
      expect(started.rowCount).toBeGreaterThanOrEqual(2);
    });
  });

  it("A9-7: a timetable slot cannot link an assignment for another class or subject", async () => {
    const staff = await post("/staff", { full_name: "Review Teacher", classification: "teacher", userId: ids.teacherA });
    expect(staff.statusCode).toBe(201);
    const assignmentY = await created(
      "/teaching-assignments",
      { staff_member_id: staff.json().staff.id, class_id: classY, subject_id: subjectId },
      "assignment",
    );
    const slot = { subject_id: subjectId, day_of_week: 1, starts_at: "08:00", ends_at: "08:40" };
    expect((await post("/timetable-slots", { ...slot, class_id: classX, teaching_assignment_id: assignmentY })).statusCode).toBe(400);
    expect((await post("/timetable-slots", { ...slot, class_id: classY, teaching_assignment_id: assignmentY })).statusCode).toBe(201);
  });

  it("rejects overlapping active timetable slots for the same class and day", async () => {
    const first = await post("/timetable-slots", {
      class_id: classX,
      subject_id: subjectId,
      day_of_week: 3,
      starts_at: "09:00",
      ends_at: "09:40",
    });
    expect(first.statusCode, first.body).toBe(201);
    const overlap = await post("/timetable-slots", {
      class_id: classX,
      subject_id: subjectId,
      day_of_week: 3,
      starts_at: "09:20",
      ends_at: "10:00",
    });
    expect(overlap.statusCode, overlap.body).toBe(409);
    expect(overlap.json().error.code).toBe("conflict");
    const adjacent = await post("/timetable-slots", {
      class_id: classX,
      subject_id: subjectId,
      day_of_week: 3,
      starts_at: "09:40",
      ends_at: "10:20",
    });
    expect(adjacent.statusCode, adjacent.body).toBe(201);
  });
});
