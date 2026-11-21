import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createTestApp, type FixtureIds } from "./support.js";

/**
 * Stage 9/10 independent review (Claude, 2026-11-19): adversarial attendance probes.
 * Every assertion states the SAFE behaviour. Database-boundary probes run as the real
 * runtime login (figbloom_app) with a tenant context, never through mocks.
 */

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

describe("Stage 10 independent review probes", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let admin: string;
  let teacher: string;
  let today: string;
  let yearId: string;
  let termId: string;
  let classX: string;
  let classY: string;
  let inX: string;
  let inY: string;
  let legacy: string;
  let dayLearner: string;
  let otherYearTerm: string;

  async function post(path: string, payload: unknown, token = admin) {
    return ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}${path}`,
      headers: bearer(token, ids.tenantA),
      payload: payload as Record<string, unknown>,
    });
  }

  async function newLearner(no: string, classId: string): Promise<string> {
    const learner = await post("/learners", { admission_no: no, full_name: `Learner ${no}`, gender: "female" });
    expect(learner.statusCode).toBe(201);
    const id = learner.json().learner.id as string;
    expect((await post("/class-memberships", { learner_id: id, class_id: classId })).statusCode).toBe(201);
    return id;
  }

  async function settings(afternoon: boolean, mode: "session" | "day" = "session") {
    const res = await ctx.app.inject({
      method: "PUT",
      url: `/v1/tenants/${ids.tenantA}/attendance-settings`,
      headers: bearer(admin, ids.tenantA),
      payload: { afternoon_enabled: afternoon, percentage_mode: mode },
    });
    expect(res.statusCode).toBe(200);
  }

  function register(learnerId: string, classId: string, extra: Record<string, unknown> = {}) {
    return { learner_id: learnerId, class_id: classId, term_id: termId, taken_on: today, mark: "present", ...extra };
  }

  async function asApp<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
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

  async function storedRow(table: "attendance" | "attendance_afternoon", learnerId: string) {
    const res = await ctx.pool.query<{ mark: string; marked_at: Date; class_id: string }>(
      `SELECT mark, marked_at, class_id FROM ${table} WHERE learner_id = $1 AND taken_on = $2::date`,
      [learnerId, today],
    );
    return res.rows[0] ?? null;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    admin = await loginEmail(ctx.app, "admin-a@example.com");
    teacher = await loginLoginId(ctx.app, ids.tenantA, "TC-0001");
    const day = await ctx.pool.query<{ d: string }>(
      `SELECT (now() AT TIME ZONE COALESCE(t.timezone, 'Africa/Nairobi'))::date::text AS d FROM tenants t WHERE t.id = $1`,
      [ids.tenantA],
    );
    today = day.rows[0]!.d;

    const year = await post("/academic-years", { label: "Review 2026", starts_on: "2020-01-01", ends_on: "2035-12-31" });
    expect(year.statusCode).toBe(201);
    yearId = year.json().academic_year.id as string;
    const term = await post("/academic-terms", {
      academic_year_id: yearId,
      index: 1,
      label: "Review term",
      starts_on: "2020-01-01",
      ends_on: "2035-12-31",
    });
    expect(term.statusCode).toBe(201);
    termId = term.json().term.id as string;

    const otherYear = await post("/academic-years", { label: "Review other", starts_on: "2036-01-01", ends_on: "2036-12-31" });
    expect(otherYear.statusCode).toBe(201);
    const otherTerm = await post("/academic-terms", {
      academic_year_id: otherYear.json().academic_year.id,
      index: 1,
      label: "Other term",
      starts_on: "2036-01-01",
      ends_on: "2036-12-31",
    });
    expect(otherTerm.statusCode).toBe(201);
    otherYearTerm = otherTerm.json().term.id as string;

    const x = await post("/classes", { academic_year_id: yearId, name: "Review X" });
    const y = await post("/classes", { academic_year_id: yearId, name: "Review Y" });
    expect(x.statusCode).toBe(201);
    expect(y.statusCode).toBe(201);
    classX = x.json().school_class.id as string;
    classY = y.json().school_class.id as string;

    const subject = await post("/subjects", { code: "RVW", name: "Review subject" });
    expect(subject.statusCode).toBe(201);
    const staff = await post("/staff", { full_name: "Teacher A", classification: "teacher", userId: ids.teacherA });
    expect(staff.statusCode).toBe(201);
    const assignment = await post("/teaching-assignments", {
      staff_member_id: staff.json().staff.id,
      class_id: classX,
      subject_id: subject.json().subject.id,
    });
    expect(assignment.statusCode).toBe(201);

    inX = await newLearner("9101", classX);
    inY = await newLearner("9102", classY);
    legacy = await newLearner("9103", classX);
    dayLearner = await newLearner("9104", classX);
  }, 180_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  describe("register scope (learner must belong to the class the caller is authorised for)", () => {
    it("a teacher of class X can take the register of a learner in X", async () => {
      const res = await post("/attendance-registers", register(inX, classX), teacher);
      expect(res.statusCode).toBe(200);
    });

    it("a teacher of class X cannot write a learner of class Y by naming class X", async () => {
      const res = await post("/attendance-registers", register(inY, classX, { mark: "absent" }), teacher);
      expect([400, 403]).toContain(res.statusCode);
      expect(await storedRow("attendance", inY)).toBeNull();
    });

    it("a teacher of class X cannot write class Y at all", async () => {
      const res = await post("/attendance-registers", register(inY, classY), teacher);
      expect(res.statusCode).toBe(403);
    });

    it("even an admin cannot file a learner under a class they are not a member of", async () => {
      const res = await post("/attendance-registers", register(inY, classX));
      expect(res.statusCode).toBe(400);
      expect(await storedRow("attendance", inY)).toBeNull();
    });

    it("the term must belong to the class's academic year", async () => {
      const res = await post("/attendance-registers", register(inX, classX, { term_id: otherYearTerm }));
      expect(res.statusCode).toBe(400);
    });
  });

  describe("legacy morning-only compatibility (student_id,taken_on contract)", () => {
    it("an old-shaped upsert (no session) lands in the morning and never touches a newer afternoon row", async () => {
      await settings(true);
      const pm = await post("/attendance-registers", register(legacy, classX, { session: "afternoon", mark: "late" }));
      expect(pm.statusCode).toBe(200);
      const pmBefore = await storedRow("attendance_afternoon", legacy);

      const oldStamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const old = await post("/attendance-registers", register(legacy, classX, { mark: "absent", marked_at: oldStamp }));
      expect(old.statusCode).toBe(200);
      expect(old.json().register.session).toBe("morning");

      const pmAfter = await storedRow("attendance_afternoon", legacy);
      expect(pmAfter).toEqual(pmBefore);
      expect((await storedRow("attendance", legacy))?.mark).toBe("absent");
      const count = await ctx.pool.query(`SELECT 1 FROM attendance_afternoon WHERE learner_id = $1`, [legacy]);
      expect(count.rowCount).toBe(1);
    });

    it("session: null is the morning register", async () => {
      const res = await post("/attendance-registers", register(legacy, classX, { mark: "present", session: null }));
      expect(res.statusCode).toBe(200);
      expect(res.json().register.session).toBe("morning");
      expect((await storedRow("attendance", legacy))?.mark).toBe("present");
      expect((await storedRow("attendance_afternoon", legacy))?.mark).toBe("late");
    });

    it("a stale morning replay (older marked_at) cannot overwrite a newer morning mark", async () => {
      const stale = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      const res = await post("/attendance-registers", register(legacy, classX, { mark: "excused", marked_at: stale }));
      expect(res.statusCode).toBe(200);
      expect((await storedRow("attendance", legacy))?.mark).toBe("present");
      expect(res.json().register.mark).toBe("present");
    });

    it("an old-shaped morning upsert still works while the afternoon register is off", async () => {
      await settings(false);
      const res = await post("/attendance-registers", register(legacy, classX, { mark: "late" }));
      expect(res.statusCode).toBe(200);
      expect((await storedRow("attendance_afternoon", legacy))?.mark).toBe("late");
    });

    it("an unknown session value is refused, not silently treated as morning", async () => {
      const res = await post("/attendance-registers", register(legacy, classX, { session: "evening" }));
      expect(res.statusCode).toBe(400);
    });
  });

  describe("afternoon off at the database boundary (figbloom_app)", () => {
    it("refuses INSERT and INSERT ... ON CONFLICT, keeps stored rows readable and countable", async () => {
      await settings(false);
      await asApp(ids.tenantA, async (c) => {
        const insert = await sqlState(
          c.query(
            `INSERT INTO attendance_afternoon (tenant_id, learner_id, class_id, term_id, taken_by, taken_on, mark)
             VALUES ($1, $2, $3, $4, $5, $6::date, 'present')`,
            [ids.tenantA, inX, classX, termId, ids.adminA, today],
          ),
        );
        expect(insert).toBe("23514");
      });
      await asApp(ids.tenantA, async (c) => {
        const upsert = await sqlState(
          c.query(
            `INSERT INTO attendance_afternoon (tenant_id, learner_id, class_id, term_id, taken_by, taken_on, mark)
             VALUES ($1, $2, $3, $4, $5, $6::date, 'absent')
             ON CONFLICT (learner_id, taken_on) DO UPDATE SET mark = EXCLUDED.mark`,
            [ids.tenantA, legacy, classX, termId, ids.adminA, today],
          ),
        );
        expect(upsert).toBe("23514");
      });
      await asApp(ids.tenantA, async (c) => {
        const read = await c.query(`SELECT mark FROM attendance_afternoon WHERE learner_id = $1`, [legacy]);
        expect(read.rows[0]?.mark).toBe("late");
        const counted = await c.query(
          `SELECT 1 FROM attendance_counted($1::uuid, $2::uuid) WHERE learner_id = $3`,
          [ids.tenantA, termId, legacy],
        );
        expect(counted.rowCount).toBe(2);
      });
      const viaApi = await post("/attendance-registers", register(legacy, classX, { session: "afternoon", mark: "absent" }));
      expect(viaApi.statusCode).toBe(400);
      expect((await storedRow("attendance_afternoon", legacy))?.mark).toBe("late");
    });

    it("the runtime role cannot DELETE registers or rewrite tenant/learner columns", async () => {
      await asApp(ids.tenantA, async (c) => {
        expect(await sqlState(c.query(`DELETE FROM attendance_afternoon WHERE learner_id = $1`, [legacy]))).toBe("42501");
      });
      await asApp(ids.tenantA, async (c) => {
        expect(await sqlState(c.query(`DELETE FROM attendance WHERE learner_id = $1`, [legacy]))).toBe("42501");
      });
      await asApp(ids.tenantA, async (c) => {
        expect(
          await sqlState(c.query(`UPDATE attendance SET learner_id = $1 WHERE learner_id = $2`, [inX, legacy])),
        ).toBe("42501");
      });
      await asApp(ids.tenantA, async (c) => {
        expect(
          await sqlState(c.query(`UPDATE attendance_afternoon SET tenant_id = $1 WHERE learner_id = $2`, [ids.tenantB, legacy])),
        ).toBe("42501");
      });
    });

    it("re-enabling the afternoon register accepts new afternoon writes again", async () => {
      await settings(true);
      const res = await post("/attendance-registers", register(inX, classX, { session: "afternoon", mark: "present" }));
      expect(res.statusCode).toBe(200);
      expect(res.json().register.session).toBe("afternoon");
    });
  });

  describe("tenant isolation at the database boundary", () => {
    it("tenant B sees none of tenant A's registers, sign-outs or collector rows", async () => {
      await asApp(ids.tenantB, async (c) => {
        for (const table of ["attendance", "attendance_afternoon", "early_sign_outs", "early_sign_out_collectors", "attendance_settings"]) {
          const res = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
          expect(res.rows[0]?.n, table).toBe(0);
        }
      });
    });

    it("tenant B cannot attach a collector row to tenant A's sign-out (composite FK)", async () => {
      const signOut = await ctx.pool.query<{ id: string }>(
        `INSERT INTO early_sign_outs (tenant_id, learner_id, class_id, learner_name, taken_on, signed_out_at,
            signed_out_local, reason, collected_by_name, collected_by_relationship)
         VALUES ($1, $2, $3, 'Probe', $4::date, now() - interval '6 hours', '04:00', 'probe', 'Probe', 'Aunt') RETURNING id`,
        [ids.tenantA, inY, classY, today],
      );
      const state = await asApp(ids.tenantB, async (c) =>
        sqlState(
          c.query(
            `INSERT INTO early_sign_out_collectors (sign_out_id, tenant_id, id_number, phone, authorised_by)
             VALUES ($1, $2, 'X1234', '+254700000000', 'Probe')`,
            [signOut.rows[0]!.id, ids.tenantB],
          ),
        ),
      );
      expect(state).toBe("23503");
    });
  });

  describe("early sign-out integrity and collector PII", () => {
    let signOutId: string;

    it("records with collector fields and keeps PII out of audit details", async () => {
      await settings(true);
      const res = await post("/early-sign-outs", {
        learner_id: inX,
        reason: "Clinic visit",
        collected_by_name: "Grace Guardian",
        collected_by_relationship: "Aunt",
        id_number: "PII-ID-7788",
        phone: "+254799887766",
        authorised_by: "Deputy Principal Secret",
        note: "PII-NOTE-text",
      });
      expect(res.statusCode).toBe(201);
      signOutId = res.json().sign_out.id as string;
      const voided = await post(`/early-sign-outs/${signOutId}/void`, { reason: "PII-VOID-reason" });
      expect(voided.statusCode).toBe(200);
      const events = await ctx.pool.query<{ detail: unknown }>(
        `SELECT detail FROM security_audit_events WHERE event_type LIKE 'attendance.early_sign_out.%'`,
      );
      expect(events.rowCount).toBeGreaterThanOrEqual(2);
      const blob = JSON.stringify(events.rows);
      for (const secret of ["PII-ID-7788", "254799887766", "Deputy Principal Secret", "PII-NOTE-text", "PII-VOID-reason"]) {
        expect(blob).not.toContain(secret);
      }
    });

    it("an attendance-area holder without collector permission sees no collector fields in list or detail", async () => {
      await ctx.pool.query(
        `INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'attendance') ON CONFLICT DO NOTHING`,
        [ids.tenantA, ids.teacherA],
      );
      for (const url of [`/early-sign-outs`, `/early-sign-outs?takenOn=${today}`, `/early-sign-outs/${signOutId}`]) {
        const res = await ctx.app.inject({
          method: "GET",
          url: `/v1/tenants/${ids.tenantA}${url}`,
          headers: bearer(teacher, ids.tenantA),
        });
        expect(res.statusCode, url).toBe(200);
        const body = res.body;
        for (const secret of ["PII-ID-7788", "254799887766", "Deputy Principal Secret", "PII-NOTE-text", "PII-VOID-reason", "id_number", "void_reason"]) {
          expect(body, `${url} ${secret}`).not.toContain(secret);
        }
      }
    });

    it("a malformed phone is refused without echoing the value", async () => {
      const res = await post("/early-sign-outs", {
        learner_id: inX,
        reason: "Clinic",
        collected_by_name: "A",
        collected_by_relationship: "B",
        id_number: "ZZ-SECRET-1",
        phone: "not-a-phone!!",
        authorised_by: "C",
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain("not-a-phone");
      expect(res.body).not.toContain("ZZ-SECRET-1");
    });

    it("a voided sign-out cannot be un-voided or have its void reason rewritten, even by the runtime role", async () => {
      await asApp(ids.tenantA, async (c) => {
        expect(
          await sqlState(c.query(`UPDATE early_sign_outs SET voided_at = NULL, voided_by = NULL WHERE id = $1`, [signOutId])),
        ).not.toBeNull();
      });
      await asApp(ids.tenantA, async (c) => {
        expect(
          await sqlState(c.query(`UPDATE early_sign_outs SET voided_at = now() - interval '1 day' WHERE id = $1`, [signOutId])),
        ).not.toBeNull();
      });
      await asApp(ids.tenantA, async (c) => {
        expect(
          await sqlState(c.query(`UPDATE early_sign_out_collectors SET void_reason = 'rewritten' WHERE sign_out_id = $1`, [signOutId])),
        ).not.toBeNull();
      });
      const again = await post(`/early-sign-outs/${signOutId}/void`, { reason: "twice" });
      expect(again.statusCode).toBe(409);
    });

    it("a void reason cannot be written on a live (not voided) sign-out", async () => {
      const live = await post("/early-sign-outs", {
        learner_id: legacy,
        reason: "Dentist",
        collected_by_name: "Uncle Probe",
        collected_by_relationship: "Uncle",
        id_number: "ID44556",
        phone: "+254711000111",
        authorised_by: "Office",
      });
      expect(live.statusCode).toBe(201);
      await asApp(ids.tenantA, async (c) => {
        expect(
          await sqlState(
            c.query(`UPDATE early_sign_out_collectors SET void_reason = 'sneaky' WHERE sign_out_id = $1`, [live.json().sign_out.id]),
          ),
        ).not.toBeNull();
      });
    });
  });

  describe("attendance counting", () => {
    async function counted(learnerId: string) {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/v1/tenants/${ids.tenantA}/attendance-counted?termId=${termId}`,
        headers: bearer(admin, ids.tenantA),
      });
      expect(res.statusCode).toBe(200);
      return (res.json().entries as Array<{ learner_id: string; here: boolean; class_id: string }>).filter(
        (r) => r.learner_id === learnerId,
      );
    }

    it("day mode counts one unit per learner-day: present in either session is here", async () => {
      await settings(true, "day");
      expect((await post("/attendance-registers", register(dayLearner, classX, { mark: "absent" }))).statusCode).toBe(200);
      expect(
        (await post("/attendance-registers", register(dayLearner, classX, { session: "afternoon", mark: "present" }))).statusCode,
      ).toBe(200);
      const rows = await counted(dayLearner);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.here).toBe(true);
      expect(rows[0]!.class_id).toBe(classX);
    });

    it("session mode counts both entries; a voided sign-out does not excuse an afternoon absence", async () => {
      await settings(true, "session");
      expect(
        (await post("/attendance-registers", register(dayLearner, classX, { session: "afternoon", mark: "absent" }))).statusCode,
      ).toBe(200);
      const signed = await post("/early-sign-outs", {
        learner_id: dayLearner,
        reason: "Clinic",
        collected_by_name: "Parent Probe",
        collected_by_relationship: "Mother",
        id_number: "ID77889",
        phone: "+254722000333",
        authorised_by: "Office",
      });
      expect(signed.statusCode).toBe(201);
      expect(await counted(dayLearner)).toHaveLength(1);
      expect((await post(`/early-sign-outs/${signed.json().sign_out.id}/void`, { reason: "Entered in error" })).statusCode).toBe(200);
      const rows = await counted(dayLearner);
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => !r.here)).toHaveLength(2);
    });
  });
});
