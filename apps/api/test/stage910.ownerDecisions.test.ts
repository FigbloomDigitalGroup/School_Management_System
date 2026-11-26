import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createTestApp, type FixtureIds } from "./support.js";

/**
 * Stage 9/10 owner decisions OD-1..OD-5, D-5 and review findings A9-6, A9-9, A9-11, R10-5
 * (implemented 2026-11-19). Each assertion states the required behaviour. Database probes run as
 * the real runtime login (figbloom_app) with a tenant context.
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
type Json = Record<string, unknown>;

function bearer(token: string, tenantId: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "x-tenant-id": tenantId };
}

describe("Stage 9/10 owner decisions", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let admin: string;
  let teacher: string;
  let parent: string;
  let yearId: string;
  let termId: string;
  let classX: string;
  let classY: string;
  let subjectId: string;
  let otherSubjectId: string;
  let inX: string;
  let inX2: string;
  let inY: string;
  let today: string;
  let assignmentX: string;

  async function call(method: "GET" | "POST" | "PUT" | "PATCH", path: string, token: string, payload?: unknown, headers: Json = {}) {
    return ctx.app.inject({
      method,
      url: `/v1/tenants/${ids.tenantA}${path}`,
      headers: { ...bearer(token, ids.tenantA), ...(headers as Record<string, string>) },
      ...(payload === undefined ? {} : { payload: payload as Json }),
    });
  }
  const post = (path: string, payload: unknown, token = admin, headers: Json = {}) => call("POST", path, token, payload, headers);
  const patch = (path: string, payload: unknown, token = admin) => call("PATCH", path, token, payload);
  const get = (path: string, token = admin) => call("GET", path, token);

  async function created(path: string, payload: unknown, key: string): Promise<string> {
    const res = await post(path, payload);
    expect(res.statusCode, `${path} ${res.body}`).toBe(201);
    return res.json()[key].id as string;
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

  async function events(type: string): Promise<Array<{ detail: Json }>> {
    const res = await ctx.pool.query<{ detail: Json }>(
      `SELECT detail FROM security_audit_events WHERE event_type = $1 ORDER BY occurred_at, id`,
      [type],
    );
    return res.rows;
  }

  async function login(body: Json): Promise<string> {
    const res = await ctx.app.inject({ method: "POST", url: body.email ? "/v1/auth/login/email" : "/v1/auth/login/login-id", payload: body });
    expect(res.statusCode).toBe(200);
    return res.json().token as string;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    admin = await login({ email: "admin-a@example.com", password: "correct-horse-battery" });
    teacher = await login({ tenantId: ids.tenantA, loginId: "TC-0001", password: "correct-horse-battery" });
    parent = await login({ tenantId: ids.tenantA, loginId: "PT-0001", password: "correct-horse-battery" });
    const day = await ctx.pool.query<{ d: string }>(
      `SELECT (now() AT TIME ZONE COALESCE(t.timezone, 'Africa/Nairobi'))::date::text AS d FROM tenants t WHERE t.id = $1`,
      [ids.tenantA],
    );
    today = day.rows[0]!.d;

    yearId = (await post("/academic-years", { label: "OD 2026", starts_on: "2020-01-01", ends_on: "2035-12-31" })).json().academic_year.id;
    termId = await created(
      "/academic-terms",
      { academic_year_id: yearId, index: 1, label: "OD T1", starts_on: "2020-01-01", ends_on: "2035-12-31" },
      "term",
    );
    classX = await created("/classes", { academic_year_id: yearId, name: "OD X" }, "school_class");
    classY = await created("/classes", { academic_year_id: yearId, name: "OD Y" }, "school_class");
    subjectId = await created("/subjects", { code: "ODS", name: "OD subject" }, "subject");
    otherSubjectId = await created("/subjects", { code: "ODO", name: "OD other" }, "subject");
    const staff = await post("/staff", { full_name: "Teacher A", classification: "teacher", userId: ids.teacherA });
    expect(staff.statusCode).toBe(201);
    assignmentX = await created(
      "/teaching-assignments",
      { staff_member_id: staff.json().staff.id, class_id: classX, subject_id: subjectId },
      "assignment",
    );
    const learner = async (no: string, classId: string) => {
      const id = await created("/learners", { admission_no: no, full_name: `OD ${no}`, gender: "female" }, "learner");
      expect((await post("/class-memberships", { learner_id: id, class_id: classId })).statusCode).toBe(201);
      return id;
    };
    inX = await learner("9301", classX);
    inX2 = await learner("9302", classX);
    inY = await learner("9303", classY);
  }, 180_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  describe("W1.1 homework edit and archive", () => {
    it("refuses a parent before looking up a homework id", async () => {
      const id = "00000000-0000-4000-8000-000000000002";
      expect((await patch(`/homework-items/${id}`, { title: "Change" }, parent)).statusCode).toBe(403);
      expect((await call("POST", `/homework-items/${id}/archive`, parent)).statusCode).toBe(403);
    });

    it("allows blank instructions, partial edits, normalized guides, and one-way idempotent archive", async () => {
      const created = await post("/homework-items", {
        class_id: classX,
        subject_id: subjectId,
        term_id: termId,
        title: "W1 homework",
        due_on: "2030-01-01",
        body: "",
        hand_in: "upload",
        parent_guide: { about: "  Fractions  ", needs: ["Exercise book", " exercise book ", "Pencils"], help: "  Read together  ", avoid: "  Do not write it for them  ", minutes: null },
      });
      expect(created.statusCode, created.body).toBe(201);
      const homework = created.json().homework;
      expect(homework).toMatchObject({ body: "", hand_in: "upload", parent_guide: { about: "Fractions", needs: ["Exercise book", "Pencils"], help: "Read together", avoid: "Do not write it for them" }, archived_at: null });
      const id = homework.id as string;

      const updated = await patch(`/homework-items/${id}`, { title: "W1 homework revised", parent_guide: null });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(updated.json().homework).toMatchObject({ title: "W1 homework revised", body: "", hand_in: "upload", parent_guide: null, archived_at: null });
      expect((await patch(`/homework-items/${id}`, {})).statusCode).toBe(400);

      const key = { "idempotency-key": "w11-homework-archive-01" };
      const archived = await call("POST", `/homework-items/${id}/archive`, admin, undefined, key);
      expect(archived.statusCode, archived.body).toBe(200);
      expect(archived.json().homework.archived_at).toEqual(expect.any(String));
      const replay = await call("POST", `/homework-items/${id}/archive`, admin, undefined, key);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(replay.json()).toEqual(archived.json());
      expect((await patch(`/homework-items/${id}`, { title: "Too late" })).statusCode).toBe(409);
      expect((await call("POST", `/homework-items/${id}/archive`, admin)).statusCode).toBe(409);
      expect((await get("/homework-items")).json().homework.some((h: { id: string }) => h.id === id)).toBe(false);

      const audit = await ctx.pool.query<{ event_type: string; detail: Json }>(
        `SELECT event_type, detail FROM security_audit_events
          WHERE event_type IN ('academics.homework.created', 'academics.homework.updated', 'academics.homework.archived')
            AND detail->>'homeworkId' = $1
          ORDER BY occurred_at, id`,
        [id],
      );
      expect(audit.rows.map((r) => r.event_type)).toEqual([
        "academics.homework.created",
        "academics.homework.updated",
        "academics.homework.archived",
      ]);
      expect(JSON.stringify(audit.rows)).not.toContain("W1 homework revised");
      expect(JSON.stringify(audit.rows)).not.toContain("Fractions");
    });
  });

  // ================================================================ OD-1
  describe("OD-1 published marks are locked; corrections keep history", () => {
    let assessmentId: string;
    let markVersion: number;

    beforeAll(async () => {
      assessmentId = await created(
        "/assessments",
        { class_id: classX, subject_id: subjectId, term_id: termId, title: "OD exam", kind: "exam", max_score: 100 },
        "assessment",
      );
      const mark = await post(`/assessments/${assessmentId}/marks`, { learner_id: inX, score: 40 });
      expect(mark.statusCode).toBe(201);
      expect((await post(`/assessments/${assessmentId}/publish`, {})).statusCode).toBe(200);
      markVersion = mark.json().mark.row_version as number;
    });

    it("refuses ordinary mark writes after publication, for admins and assessors alike", async () => {
      const asAdmin = await post(`/assessments/${assessmentId}/marks`, { learner_id: inX, score: 99, row_version: markVersion });
      expect(asAdmin.statusCode).toBe(409);
      const asTeacher = await post(`/assessments/${assessmentId}/marks`, { learner_id: inX2, score: 10 }, teacher);
      expect(asTeacher.statusCode).toBe(409);
      const stored = await ctx.pool.query(`SELECT score::text AS s FROM mark_entries WHERE learner_id = $1`, [inX]);
      expect(stored.rows[0]?.s).toBe("40");
    });

    it("the database refuses a published mark change or a new mark without a correction row (figbloom_app)", async () => {
      await asApp(async (c) => {
        expect(
          await sqlState(c.query(`UPDATE mark_entries SET score = 1, row_version = row_version + 1 WHERE learner_id = $1`, [inX])),
        ).toBe("23514");
      });
      await asApp(async (c) => {
        expect(
          await sqlState(
            c.query(
              `INSERT INTO mark_entries (tenant_id, assessment_id, learner_id, score, row_version) VALUES ($1, $2, $3, 5, 1)`,
              [ids.tenantA, assessmentId, inX2],
            ),
          ),
        ).toBe("23514");
      });
      await asApp(async (c) => {
        expect(await sqlState(c.query(`UPDATE assessments SET status = 'draft', published_at = NULL WHERE id = $1`, [assessmentId]))).toBe("23514");
      });
      await asApp(async (c) => {
        expect(await sqlState(c.query(`UPDATE mark_corrections SET reason = 'rewritten reason'`))).toBe("42501");
      });
    });

    it("a correction needs the academics write permission, a reason and the current row_version", async () => {
      const body = { learner_id: inX, score: 45, reason: "Re-marked after appeal", row_version: markVersion };
      expect((await post(`/assessments/${assessmentId}/mark-corrections`, body, teacher)).statusCode).toBe(403);
      expect((await post(`/assessments/${assessmentId}/mark-corrections`, { ...body, reason: "no" })).statusCode).toBe(400);
      expect((await post(`/assessments/${assessmentId}/mark-corrections`, { ...body, row_version: markVersion + 5 })).statusCode).toBe(409);
      expect((await post(`/assessments/${assessmentId}/mark-corrections`, { ...body, score: 40 })).statusCode).toBe(400);
    });

    it("records the original and replacement score, actor, time and reason; replays return the original response", async () => {
      const key = { "idempotency-key": "od1-correction-0001" };
      const body = { learner_id: inX, score: 45, reason: "Re-marked after appeal", row_version: markVersion };
      const res = await post(`/assessments/${assessmentId}/mark-corrections`, body, admin, key);
      expect(res.statusCode).toBe(201);
      const out = res.json();
      expect(out.correction).toMatchObject({
        previous_score: "40",
        new_score: "45",
        reason: "Re-marked after appeal",
        corrected_by: ids.adminA,
        resulting_row_version: markVersion + 1,
      });
      expect(out.mark).toMatchObject({ score: "45", row_version: markVersion + 1 });

      // A second correction moves the mark on; the first request's replay is unchanged.
      const second = await post(`/assessments/${assessmentId}/mark-corrections`, {
        learner_id: inX,
        score: 47,
        reason: "Second moderation",
        row_version: markVersion + 1,
      });
      expect(second.statusCode).toBe(201);
      const replay = await post(`/assessments/${assessmentId}/mark-corrections`, body, admin, key);
      expect(replay.statusCode).toBe(201);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(replay.json()).toEqual(out);

      const history = await get(`/assessments/${assessmentId}/mark-corrections`);
      expect(history.statusCode).toBe(200);
      expect(history.json().corrections.map((c: Json) => c.new_score)).toEqual(["45", "47"]);

      const audit = await events("academics.mark.corrected");
      expect(audit).toHaveLength(2);
      expect(JSON.stringify(audit)).not.toContain("appeal");
      // Ids and versions only: no score, grade or reason field in the audit detail.
      for (const e of audit) {
        expect(Object.keys(e.detail).sort()).toEqual(
          ["assessmentId", "correctionId", "fromRowVersion", "learnerId", "markId", "toRowVersion"],
        );
      }
    });

    it("a correction can add a missing mark (row_version 0); a draft assessment is not corrected", async () => {
      const res = await post(`/assessments/${assessmentId}/mark-corrections`, {
        learner_id: inX2,
        score: 30,
        reason: "Script found after publication",
        row_version: 0,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().correction.previous_score).toBeNull();
      expect(res.json().mark.row_version).toBe(1);

      const draft = await created(
        "/assessments",
        { class_id: classX, subject_id: subjectId, term_id: termId, title: "OD draft", kind: "exam", max_score: 100 },
        "assessment",
      );
      expect(
        (await post(`/assessments/${draft}/mark-corrections`, { learner_id: inX, score: 1, reason: "Not published yet", row_version: 0 })).statusCode,
      ).toBe(409);
    });

    it("two concurrent corrections from the same version: exactly one succeeds", async () => {
      const current = await ctx.pool.query<{ row_version: number }>(
        `SELECT row_version FROM mark_entries WHERE assessment_id = $1 AND learner_id = $2`,
        [assessmentId, inX],
      );
      const v = current.rows[0]!.row_version;
      const [a, b] = await Promise.all([
        post(`/assessments/${assessmentId}/mark-corrections`, { learner_id: inX, score: 50, reason: "Concurrent one", row_version: v }),
        post(`/assessments/${assessmentId}/mark-corrections`, { learner_id: inX, score: 51, reason: "Concurrent two", row_version: v }),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
      const rows = await ctx.pool.query(`SELECT 1 FROM mark_corrections WHERE learner_id = $1 AND resulting_row_version = $2`, [inX, v + 1]);
      expect(rows.rowCount).toBe(1);
    });
  });

  // ================================================================ OD-2 + A9-9
  describe("OD-2 teacher read scope (read only) and A9-9 existence hiding", () => {
    let assessX: string;
    let assessY: string;

    beforeAll(async () => {
      assessX = await created(
        "/assessments",
        { class_id: classX, subject_id: subjectId, term_id: termId, title: "Scope X", kind: "exam", max_score: 10 },
        "assessment",
      );
      assessY = await created(
        "/assessments",
        { class_id: classY, subject_id: subjectId, term_id: termId, title: "Scope Y", kind: "exam", max_score: 10 },
        "assessment",
      );
      expect((await post(`/assessments/${assessX}/marks`, { learner_id: inX, score: 7 })).statusCode).toBe(201);
      expect((await post(`/assessments/${assessY}/marks`, { learner_id: inY, score: 8 })).statusCode).toBe(201);
      expect((await post("/attendance-registers", { learner_id: inX, class_id: classX, term_id: termId, taken_on: today, mark: "present" })).statusCode).toBe(200);
      expect((await post("/attendance-registers", { learner_id: inY, class_id: classY, term_id: termId, taken_on: today, mark: "absent" })).statusCode).toBe(200);
      for (const [learner, id] of [[inX, "SCOPE-ID-X"], [inY, "SCOPE-ID-Y"]] as const) {
        const res = await post("/early-sign-outs", {
          learner_id: learner,
          reason: "Clinic",
          collected_by_name: "Scope Collector",
          collected_by_relationship: "Aunt",
          id_number: id,
          phone: "+254700123456",
          authorised_by: "Scope Office",
          note: "SCOPE-NOTE",
        });
        expect(res.statusCode).toBe(201);
      }
    });

    it("a teacher lists only assessments of classes they teach", async () => {
      const res = await get("/assessments?limit=200", teacher);
      expect(res.statusCode).toBe(200);
      const classes = new Set(res.json().assessments.map((a: Json) => a.class_id));
      expect([...classes]).toEqual([classX]);
    });

    it("a teacher reads marks of their class; another class and a missing id answer the same 404", async () => {
      const own = await get(`/assessments/${assessX}/marks`, teacher);
      expect(own.statusCode).toBe(200);
      expect(own.json().marks.map((m: Json) => m.learner_id)).toEqual([inX]);
      const other = await get(`/assessments/${assessY}/marks`, teacher);
      const missing = await get(`/assessments/00000000-0000-4000-8000-000000000000/marks`, teacher);
      expect(other.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(other.json().error.message).toBe(missing.json().error.message);
    });

    it("A9-9: mark writes cannot probe assessment ids outside the caller's classes", async () => {
      const other = await post(`/assessments/${assessY}/marks`, { learner_id: inY, score: 1 }, teacher);
      const missing = await post(`/assessments/00000000-0000-4000-8000-000000000000/marks`, { learner_id: inY, score: 1 }, teacher);
      expect(other.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(other.json().error.message).toBe(missing.json().error.message);
      // A user who teaches nothing is refused before any lookup: same 403 for real and fake ids.
      const p1 = await post(`/assessments/${assessX}/marks`, { learner_id: inX, score: 1 }, parent);
      const p2 = await post(`/assessments/00000000-0000-4000-8000-000000000000/marks`, { learner_id: inX, score: 1 }, parent);
      expect([p1.statusCode, p2.statusCode]).toEqual([403, 403]);
    });

    it("a teacher reads registers and a sanitised sign-out list of their classes only", async () => {
      const regs = await get(`/attendance-registers?takenOn=${today}`, teacher);
      expect(regs.statusCode).toBe(200);
      expect(new Set(regs.json().registers.map((r: Json) => r.class_id))).toEqual(new Set([classX]));
      const outs = await get(`/early-sign-outs?takenOn=${today}`, teacher);
      expect(outs.statusCode).toBe(200);
      const list = outs.json().sign_outs as Array<{ sign_out: Json; collector: unknown }>;
      expect(list.map((x) => x.sign_out.learner_id)).toEqual([inX]);
      expect(list.every((x) => x.collector === null)).toBe(true);
      for (const secret of ["SCOPE-ID-X", "SCOPE-ID-Y", "254700123456", "Scope Office", "SCOPE-NOTE", "id_number"]) {
        expect(outs.body).not.toContain(secret);
      }
    });

    it("grants no writes and no wider reads", async () => {
      expect((await post("/assessments", { class_id: classX, subject_id: subjectId, term_id: termId, title: "T", kind: "exam", max_score: 1 }, teacher)).statusCode).toBe(403);
      expect((await call("PUT", "/attendance-settings", teacher, { afternoon_enabled: true, percentage_mode: "session" })).statusCode).toBe(403);
      expect((await get(`/attendance-counted?termId=${termId}`, teacher)).statusCode).toBe(403);
      expect((await get("/homework-items", teacher)).statusCode).toBe(403);
      const detail = (await get(`/early-sign-outs?takenOn=${today}`)).json().sign_outs[0].sign_out.id as string;
      expect((await get(`/early-sign-outs/${detail}`, teacher)).statusCode).toBe(403);
      // Wrong subject in the teacher's own class: still no mark write.
      const otherSubject = await created(
        "/assessments",
        { class_id: classX, subject_id: otherSubjectId, term_id: termId, title: "Other subject", kind: "exam", max_score: 10 },
        "assessment",
      );
      expect((await post(`/assessments/${otherSubject}/marks`, { learner_id: inX, score: 1 }, teacher)).statusCode).toBe(403);
    });

    it("a parent (no teaching role) is refused; another tenant is refused", async () => {
      expect((await get("/assessments", parent)).statusCode).toBe(403);
      expect((await get(`/attendance-registers`, parent)).statusCode).toBe(403);
      expect((await get(`/early-sign-outs`, parent)).statusCode).toBe(403);
      const cross = await ctx.app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantB}/assessments`, headers: bearer(teacher, ids.tenantA) });
      expect(cross.statusCode).toBe(403);
    });

    it("only ACTIVE teaching assignments give read scope", async () => {
      await ctx.pool.query(`UPDATE teaching_assignments SET active = false, archived_at = now() WHERE id = $1`, [assignmentX]);
      try {
        expect((await get("/assessments", teacher)).statusCode).toBe(403);
        expect((await get(`/assessments/${assessX}/marks`, teacher)).statusCode).toBe(403);
      } finally {
        await ctx.pool.query(`UPDATE teaching_assignments SET active = true, archived_at = NULL WHERE id = $1`, [assignmentX]);
      }
    });
  });

  // ================================================================ OD-3
  describe("OD-3 one current CBE result with revision history", () => {
    let cbe: string;
    let strand: string;

    beforeAll(async () => {
      const prov = await created("/curriculum-provenance", { source_kind: "school_configured", source_label: "OD notes" }, "provenance");
      const area = await created("/learning-areas", { provenance_id: prov, code: "ODA", name: "OD area" }, "learning_area");
      strand = await created("/strands", { learning_area_id: area, code: "ODST", name: "OD strand" }, "strand");
      cbe = await created("/cbe-assessments", { class_id: classX, learning_area_id: area, term_id: termId, title: "OD CBE" }, "cbe_assessment");
    });

    it("creates once, treats an identical resend as unchanged, and requires version + reason to change", async () => {
      const key = { "idempotency-key": "od3-create-0001" };
      const body = { learner_id: inX, strand_id: strand, level_code: "ME", points: 3 };
      const first = await post(`/cbe-assessments/${cbe}/results`, body, admin, key);
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ outcome: "created", result: { row_version: 1, level_code: "ME" } });

      const again = await post(`/cbe-assessments/${cbe}/results`, body);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ outcome: "unchanged", result: { id: first.json().result.id, row_version: 1 } });

      expect((await post(`/cbe-assessments/${cbe}/results`, { ...body, level_code: "EE", points: 4 })).statusCode).toBe(409);
      expect((await post(`/cbe-assessments/${cbe}/results`, { ...body, level_code: "EE", points: 4, row_version: 1 })).statusCode).toBe(400);
      const revised = await post(`/cbe-assessments/${cbe}/results`, {
        ...body,
        level_code: "EE",
        points: 4,
        row_version: 1,
        reason: "Moderated upwards",
      });
      expect(revised.statusCode).toBe(200);
      expect(revised.json()).toMatchObject({ outcome: "revised", result: { id: first.json().result.id, row_version: 2, level_code: "EE" } });

      const replay = await post(`/cbe-assessments/${cbe}/results`, body, admin, key);
      expect(replay.statusCode).toBe(201);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(replay.json()).toEqual(first.json());

      const rows = await ctx.pool.query(`SELECT 1 FROM cbe_results WHERE cbe_assessment_id = $1 AND learner_id = $2`, [cbe, inX]);
      expect(rows.rowCount).toBe(1);
      const history = await ctx.pool.query<{ previous_level_code: string; new_level_code: string; reason: string; revised_by: string }>(
        `SELECT previous_level_code, new_level_code, reason, revised_by FROM cbe_result_revisions`,
      );
      expect(history.rows).toEqual([{ previous_level_code: "ME", new_level_code: "EE", reason: "Moderated upwards", revised_by: ids.adminA }]);
    });

    it("the database refuses a duplicate current result and an unrevised change (figbloom_app)", async () => {
      await asApp(async (c) => {
        expect(
          await sqlState(
            c.query(
              `INSERT INTO cbe_results (tenant_id, cbe_assessment_id, learner_id, strand_id, level_code, points) VALUES ($1, $2, $3, $4, 'BE', 1)`,
              [ids.tenantA, cbe, inX, strand],
            ),
          ),
        ).toBe("23505");
      });
      await asApp(async (c) => {
        expect(
          await sqlState(c.query(`UPDATE cbe_results SET points = 1, row_version = row_version + 1 WHERE learner_id = $1`, [inX])),
        ).toBe("23514");
      });
    });
  });

  // ================================================================ OD-5
  describe("OD-5 one current HE grade with corrections", () => {
    let enrolment: string;
    let withdrawn: string;

    beforeAll(async () => {
      await ctx.pool.query(
        `INSERT INTO school_profiles (tenant_id, institution_type) VALUES ($1, 'higher_ed')
         ON CONFLICT (tenant_id) DO UPDATE SET institution_type = 'higher_ed'`,
        [ids.tenantA],
      );
      const course = await created("/he-courses", { code: "OD101", title: "OD course" }, "course");
      const section = await created("/he-sections", { course_id: course, term_id: termId, label: "A" }, "section");
      enrolment = await created("/he-enrolments", { section_id: section, learner_id: inX }, "enrolment");
      withdrawn = await created("/he-enrolments", { section_id: section, learner_id: inX2 }, "enrolment");
    });

    it("first grade 201, identical resend 200 unchanged, a different grade must be a correction", async () => {
      const key = { "idempotency-key": "od5-grade-0001" };
      const first = await post(`/he-enrolments/${enrolment}/grade`, { score: 61, grade: "B" }, admin, key);
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ outcome: "created", grade: { score: "61", grade: "B", row_version: 1 } });
      const same = await post(`/he-enrolments/${enrolment}/grade`, { score: 61, grade: "B" });
      expect(same.statusCode).toBe(200);
      expect(same.json().outcome).toBe("unchanged");
      expect((await post(`/he-enrolments/${enrolment}/grade`, { score: 70, grade: "A" })).statusCode).toBe(409);

      expect((await post(`/he-enrolments/${enrolment}/grade-corrections`, { score: 70, grade: "A", reason: "Remark", row_version: 9 })).statusCode).toBe(409);
      const corrected = await post(`/he-enrolments/${enrolment}/grade-corrections`, { score: 70, grade: "A", reason: "External moderation", row_version: 1 });
      expect(corrected.statusCode).toBe(200);
      expect(corrected.json().grade).toMatchObject({ score: "70", grade: "A", row_version: 2 });

      const replay = await post(`/he-enrolments/${enrolment}/grade`, { score: 61, grade: "B" }, admin, key);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());

      const revisions = await get(`/he-enrolments/${enrolment}/grade-revisions`);
      expect(revisions.statusCode).toBe(200);
      expect(revisions.json().revisions).toEqual([
        expect.objectContaining({ previous_score: "61", previous_grade: "B", new_score: "70", new_grade: "A", reason: "External moderation", revised_by: ids.adminA }),
      ]);
      expect((await get(`/he-enrolments/${enrolment}/grade`)).json().grade).toMatchObject({ score: "70", row_version: 2 });
    });

    it("withdrawn: no ordinary grade, no first grade by correction; an existing grade can still be corrected", async () => {
      await ctx.pool.query(`UPDATE he_enrolments SET status = 'withdrawn' WHERE id = $1`, [withdrawn]);
      expect((await post(`/he-enrolments/${withdrawn}/grade`, { score: 50 })).statusCode).toBe(409);
      expect((await post(`/he-enrolments/${withdrawn}/grade-corrections`, { score: 50, reason: "Historic fix", row_version: 1 })).statusCode).toBe(409);
      await asApp(async (c) => {
        expect(
          await sqlState(c.query(`INSERT INTO he_grades (tenant_id, enrolment_id, score) VALUES ($1, $2, 50)`, [ids.tenantA, withdrawn])),
        ).toBe("23514");
      });

      await ctx.pool.query(`UPDATE he_enrolments SET status = 'withdrawn' WHERE id = $1`, [enrolment]);
      expect((await post(`/he-enrolments/${enrolment}/grade`, { score: 70, grade: "A" })).statusCode).toBe(409);
      const historic = await post(`/he-enrolments/${enrolment}/grade-corrections`, { score: 72, grade: "A", reason: "Transcript audit", row_version: 2 });
      expect(historic.statusCode).toBe(200);
      expect(historic.json().grade.row_version).toBe(3);
      const status = await ctx.pool.query(`SELECT status FROM he_enrolments WHERE id = $1`, [enrolment]);
      expect(status.rows[0]?.status).toBe("withdrawn");
    });

    it("the database refuses a duplicate grade and an unrevised change (figbloom_app)", async () => {
      await asApp(async (c) => {
        expect(
          await sqlState(c.query(`UPDATE he_grades SET score = 1, row_version = row_version + 1 WHERE enrolment_id = $1`, [enrolment])),
        ).toBe("23514");
      });
      await asApp(async (c) => {
        expect(await sqlState(c.query(`UPDATE he_grade_revisions SET reason = 'changed reason'`))).toBe("42501");
      });
    });
  });

  // ================================================================ OD-4
  describe("OD-4 cursor pagination", () => {
    it("pages a list completely, without duplicates, and stops with next_cursor null", async () => {
      for (let i = 0; i < 5; i++) await created("/subjects", { code: `PG${i}`, name: `Paged ${i}` }, "subject");
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await get(`/subjects?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.subjects.length).toBeLessThanOrEqual(2);
        seen.push(...body.subjects.map((s: Json) => s.id as string));
        cursor = body.page.next_cursor;
        pages++;
      } while (cursor && pages < 20);
      expect(cursor).toBeNull();
      const all = (await get("/subjects?limit=200")).json().subjects.map((s: Json) => s.id);
      expect(seen).toEqual(all);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it("refuses out-of-range limits, malformed cursors and a cursor from another list", async () => {
      expect((await get("/subjects?limit=0")).statusCode).toBe(400);
      expect((await get("/subjects?limit=201")).statusCode).toBe(400);
      expect((await get("/subjects?sort=name")).statusCode).toBe(400);
      expect((await get("/subjects?cursor=not*base64")).statusCode).toBe(400);
      expect((await get(`/subjects?cursor=${Buffer.from("{}").toString("base64url")}`)).statusCode).toBe(400);
      const classesCursor = (await get("/classes?limit=1")).json().page.next_cursor as string;
      expect(classesCursor).toBeTruthy();
      expect((await get(`/subjects?cursor=${classesCursor}`)).statusCode).toBe(400);
      // A cursor forged with injection text, or re-used under another filter, is refused.
      const forged = Buffer.from(JSON.stringify({ v: 2, s: "subjects", f: "x".repeat(43), k: ["x'); DROP TABLE subjects; --", ids.tenantB] })).toString("base64url");
      expect((await get(`/subjects?cursor=${forged}`)).statusCode).toBe(400);
      const subjectsCursor = (await get("/subjects?limit=1")).json().page.next_cursor as string;
      expect((await get(`/subjects?limit=1&active=true&cursor=${subjectsCursor}`)).statusCode).toBe(400);
      const all = await get("/subjects?limit=200");
      expect(all.json().subjects.every((s: Json) => s.tenantId === ids.tenantA)).toBe(true);
    });

    it("attendance-counted needs a term and pages on (date, learner, session)", async () => {
      expect((await get("/attendance-counted")).statusCode).toBe(400);
      expect((await get(`/attendance-counted?termId=${termId}&limit=201`)).statusCode).toBe(400);
      const full = (await get(`/attendance-counted?termId=${termId}&limit=200`)).json().entries as Json[];
      expect(full.length).toBeGreaterThanOrEqual(2);
      const paged: Json[] = [];
      let cursor: string | null = null;
      do {
        const res = await get(`/attendance-counted?termId=${termId}&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
        expect(res.statusCode).toBe(200);
        paged.push(...res.json().entries);
        cursor = res.json().page.next_cursor;
      } while (cursor);
      expect(paged).toEqual(full);
      expect((await get(`/attendance-counted?termId=${termId}&cursor=bad*cursor`)).statusCode).toBe(400);
    });
  });

  // ================================================================ A9-6
  it("A9-6: an idempotent replay finds its resource outside the first 200 list rows", async () => {
    const key = { "idempotency-key": "a96-homework-0001" };
    const body = { class_id: classX, subject_id: subjectId, term_id: termId, title: "Late homework", due_on: "2035-12-30", body: "Read" };
    const first = await post("/homework-items", body, admin, key);
    expect(first.statusCode).toBe(201);
    await ctx.pool.query(
      `INSERT INTO homework_items (tenant_id, class_id, subject_id, term_id, title, due_on, body)
       SELECT $1, $2, $3, $4, 'Filler ' || g, DATE '2021-01-01' + g, 'x' FROM generate_series(1, 210) g`,
      [ids.tenantA, classX, subjectId, termId],
    );
    const replay = await post("/homework-items", body, admin, key);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
  });

  // ================================================================ A9-11
  describe("A9-11 known constraint cases are client errors, never 500", () => {
    it("concurrent set-current calls both complete and leave exactly one current year", async () => {
      const y1 = (await post("/academic-years", { label: "Race A", starts_on: "2040-01-01", ends_on: "2040-12-31" })).json().academic_year.id;
      const y2 = (await post("/academic-years", { label: "Race B", starts_on: "2041-01-01", ends_on: "2041-12-31" })).json().academic_year.id;
      const [a, b] = await Promise.all([post(`/academic-years/${y1}/set-current`, {}), post(`/academic-years/${y2}/set-current`, {})]);
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      const current = await ctx.pool.query(`SELECT 1 FROM academic_years WHERE tenant_id = $1 AND is_current`, [ids.tenantA]);
      expect(current.rowCount).toBe(1);
    });

    it("unknown rubric, unknown evidence learner, oversize component: 400", async () => {
      const prov = await created("/curriculum-provenance", { source_kind: "school_configured", source_label: "A911" }, "provenance");
      const area = await created("/learning-areas", { provenance_id: prov, code: "A911", name: "A911" }, "learning_area");
      const rubric = await post("/cbe-assessments", {
        class_id: classX,
        learning_area_id: area,
        term_id: termId,
        title: "Bad rubric",
        rubric_config_id: "00000000-0000-4000-8000-000000000001",
      });
      expect(rubric.statusCode).toBe(400);
      const evidence = await post("/evidence-assets", { provenance_id: prov, title: "E", learner_id: "00000000-0000-4000-8000-000000000002" });
      expect(evidence.statusCode).toBe(400);
      const component = await post("/assessments", {
        class_id: classX,
        subject_id: subjectId,
        term_id: termId,
        title: "Big",
        kind: "exam",
        max_score: 100,
        components: [{ name: "Part", max_score: 20000 }],
      });
      expect(component.statusCode).toBe(400);
      for (const res of [rubric, evidence, component]) expect(res.body).not.toMatch(/violates|constraint|relation|SQL/i);
    });
  });

  // ================================================================ R10-5
  it("R10-5: a stale register write is reported as stale_ignored and is not audited as a change", async () => {
    const base = { learner_id: inX2, class_id: classX, term_id: termId, taken_on: today };
    const now = new Date().toISOString();
    const first = await post("/attendance-registers", { ...base, mark: "present", marked_at: now });
    expect(first.json().outcome).toBe("applied");
    const before = (await events("attendance.register.upserted")).length;

    const stale = await post("/attendance-registers", { ...base, mark: "absent", marked_at: new Date(Date.now() - 3_600_000).toISOString() });
    expect(stale.statusCode).toBe(200);
    expect(stale.json().outcome).toBe("stale_ignored");
    expect(stale.json().register.mark).toBe("present");
    expect((await events("attendance.register.upserted")).length).toBe(before);
    const ignored = await events("attendance.register.stale_ignored");
    expect(ignored).toHaveLength(1);
    expect(ignored[0]!.detail).toMatchObject({ learnerId: inX2, session: "morning" });

    const identical = await post("/attendance-registers", { ...base, mark: "present", marked_at: first.json().register.marked_at });
    expect(identical.json().outcome).toBe("unchanged");
    expect((await events("attendance.register.upserted")).length).toBe(before);
    expect(await events("attendance.register.stale_ignored")).toHaveLength(1);
  });

  // ================================================================ D-5
  it("D-5: a free-text label cannot make school content official", async () => {
    const res = await post("/curriculum-provenance", { source_kind: "school_configured", source_label: "KICD Official Catalogue 2026" });
    expect(res.statusCode).toBe(201);
    expect(res.json().provenance).toMatchObject({ source_kind: "school_configured", official_catalogue: false });
    expect((await post("/curriculum-provenance", { source_kind: "platform_reference", source_label: "KICD" })).statusCode).toBe(400);
    await asApp(async (c) => {
      expect(
        await sqlState(
          c.query(`INSERT INTO curriculum_provenance (tenant_id, source_kind, source_label) VALUES ($1, 'platform_reference', 'KICD')`, [ids.tenantA]),
        ),
      ).toBe("23514");
    });
    await asApp(async (c) => {
      expect(
        await sqlState(c.query(`INSERT INTO curriculum_provenance (tenant_id, source_kind, source_label) VALUES (NULL, 'platform_reference', 'KICD')`)),
      ).toBe("42501");
    });
    // Migration 079 may seed progressive platform_reference provenance (tenant_id NULL only).
    // That is not an official KICD/KNEC catalogue claim: API surfaces still force official_catalogue=false.
    const seeded = await ctx.pool.query<{ n: number; tenanted: number }>(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE tenant_id IS NOT NULL)::int AS tenanted
         FROM curriculum_provenance WHERE source_kind = 'platform_reference'`,
    );
    expect(seeded.rows[0]?.tenanted).toBe(0);
    expect(seeded.rows[0]?.n).toBeGreaterThanOrEqual(0);
    const catalogue = await ctx.pool.query<{ n: number; verified: number }>(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE verification_status = 'verified')::int AS verified
         FROM curriculum_reference_entries`,
    );
    // Progressive seed may exist; must not claim verified official SLO/catalogue completeness.
    expect(catalogue.rows[0]?.verified ?? 0).toBe(0);
  });
});
