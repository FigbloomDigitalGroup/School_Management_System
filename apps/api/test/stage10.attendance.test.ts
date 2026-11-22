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

describe("Stage 10 attendance", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let admin: string;
  let teacher: string;
  let classId: string;
  let termId: string;
  let learnerA: string;
  let learnerB: string;
  let learnerC: string;
  let today: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    admin = await loginEmail(ctx.app, "admin-a@example.com");
    teacher = await loginLoginId(ctx.app, ids.tenantA, "TC-0001");
    const day = await ctx.pool.query<{ d: string }>(
      `SELECT (now() AT TIME ZONE COALESCE(t.timezone, 'Africa/Nairobi'))::date::text AS d
         FROM tenants t WHERE t.id = $1`,
      [ids.tenantA],
    );
    today = day.rows[0]!.d;

    const year = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/academic-years`,
      headers: bearer(admin, ids.tenantA),
      payload: { label: "Attend 2026", starts_on: "2020-01-01", ends_on: "2035-12-31" },
    });
    expect(year.statusCode).toBe(201);
    const term = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/academic-terms`,
      headers: bearer(admin, ids.tenantA),
      payload: {
        academic_year_id: year.json().academic_year.id,
        index: 1,
        label: "Term",
        starts_on: "2020-01-01",
        ends_on: "2035-12-31",
      },
    });
    expect(term.statusCode).toBe(201);
    termId = term.json().term.id as string;
    const schoolClass = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/classes`,
      headers: bearer(admin, ids.tenantA),
      payload: { academic_year_id: year.json().academic_year.id, name: "Attendance Class" },
    });
    expect(schoolClass.statusCode).toBe(201);
    classId = schoolClass.json().school_class.id as string;

    const idsOut: string[] = [];
    for (const [no, name] of [
      ["4701", "Learner A"],
      ["4702", "Learner B"],
      ["4703", "Learner C"],
    ] as const) {
      const learner = await ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/learners`,
        headers: bearer(admin, ids.tenantA),
        payload: { admission_no: no, full_name: name, gender: "male" },
      });
      expect(learner.statusCode).toBe(201);
      const learnerId = learner.json().learner.id as string;
      idsOut.push(learnerId);
      const membership = await ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/class-memberships`,
        headers: bearer(admin, ids.tenantA),
        payload: { learner_id: learnerId, class_id: classId },
      });
      expect(membership.statusCode).toBe(201);
    }
    learnerA = idsOut[0]!;
    learnerB = idsOut[1]!;
    learnerC = idsOut[2]!;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  async function putSettings(afternoon: boolean) {
    const res = await ctx.app.inject({
      method: "PUT",
      url: `/v1/tenants/${ids.tenantA}/attendance-settings`,
      headers: bearer(admin, ids.tenantA),
      payload: { afternoon_enabled: afternoon, percentage_mode: "session" },
    });
    expect(res.statusCode).toBe(200);
  }

  async function mark(learnerId: string, markValue: string, session?: "afternoon") {
    return ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/attendance-registers`,
      headers: bearer(admin, ids.tenantA),
      payload: {
        learner_id: learnerId,
        class_id: classId,
        term_id: termId,
        taken_on: today,
        mark: markValue,
        ...(session ? { session } : {}),
      },
    });
  }

  async function stored(learnerId: string): Promise<{ morning: string | null; afternoon: string | null }> {
    const morning = await ctx.pool.query<{ mark: string }>(
      `SELECT mark FROM attendance WHERE learner_id = $1 AND taken_on = $2::date`,
      [learnerId, today],
    );
    const afternoon = await ctx.pool.query<{ mark: string }>(
      `SELECT mark FROM attendance_afternoon WHERE learner_id = $1 AND taken_on = $2::date`,
      [learnerId, today],
    );
    return { morning: morning.rows[0]?.mark ?? null, afternoon: afternoon.rows[0]?.mark ?? null };
  }

  it("a morning upsert without session does not overwrite the afternoon register", async () => {
    await putSettings(true);
    const afternoon = await mark(learnerA, "present", "afternoon");
    expect(afternoon.statusCode).toBe(200);
    expect(afternoon.json().register.session).toBe("afternoon");

    const morning = await mark(learnerA, "absent");
    expect(morning.statusCode).toBe(200);
    expect(morning.json().register.session).toBe("morning");
    expect(await stored(learnerA)).toEqual({ morning: "absent", afternoon: "present" });
  });

  it("an afternoon upsert does not touch the morning register", async () => {
    const afternoon = await mark(learnerA, "late", "afternoon");
    expect(afternoon.statusCode).toBe(200);
    expect(await stored(learnerA)).toEqual({ morning: "absent", afternoon: "late" });
  });

  it("refuses an afternoon upsert while the afternoon register is off", async () => {
    await putSettings(false);
    const refused = await mark(learnerB, "present", "afternoon");
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toContain("does not take an afternoon register");
    expect((await stored(learnerB)).afternoon).toBeNull();
  });

  it("records an early sign-out and hides collector fields without collector permission", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/early-sign-outs`,
      headers: bearer(admin, ids.tenantA),
      payload: {
        learner_id: learnerB,
        reason: "Medical appointment",
        collected_by_name: "Jane Collector",
        collected_by_relationship: "Mother",
        id_number: "ID998877",
        phone: "+254712345678",
        authorised_by: "School office",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().sign_out.learner_id).toBe(learnerB);
    expect(created.json().collector).toMatchObject({ id_number: "ID998877", phone: "+254712345678" });

    await ctx.pool.query(
      `INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'attendance')`,
      [ids.tenantA, ids.teacherA],
    );
    const signOutId = created.json().sign_out.id as string;
    const asTeacher = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/early-sign-outs/${signOutId}`,
      headers: bearer(teacher, ids.tenantA),
    });
    expect(asTeacher.statusCode).toBe(200);
    expect(asTeacher.json().sign_out.collected_by_name).toBe("Jane Collector");
    expect(asTeacher.json().collector).toBeNull();
    const body = JSON.stringify(asTeacher.json());
    expect(body).not.toContain("ID998877");
    expect(body).not.toContain("+254712345678");
    expect(body).not.toContain("id_number");
  });

  it("leaves a live early sign-out out of afternoon absence counting", async () => {
    await putSettings(true);
    expect((await mark(learnerC, "present")).statusCode).toBe(200);
    expect((await mark(learnerC, "absent", "afternoon")).statusCode).toBe(200);

    const before = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/attendance-counted?termId=${termId}`,
      headers: bearer(admin, ids.tenantA),
    });
    expect(before.statusCode).toBe(200);
    const beforeRows = (before.json().entries as Array<{ learner_id: string; here: boolean }>).filter(
      (row) => row.learner_id === learnerC,
    );
    expect(beforeRows).toHaveLength(2);
    expect(beforeRows.some((row) => row.here === false)).toBe(true);

    const signed = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/early-sign-outs`,
      headers: bearer(admin, ids.tenantA),
      payload: {
        learner_id: learnerC,
        reason: "Left with a parent",
        collected_by_name: "Peter Parent",
        collected_by_relationship: "Father",
        id_number: "ID112233",
        phone: "+254700111222",
        authorised_by: "Class teacher",
      },
    });
    expect(signed.statusCode).toBe(201);

    const after = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/attendance-counted?termId=${termId}`,
      headers: bearer(admin, ids.tenantA),
    });
    const afterRows = (after.json().entries as Array<{ learner_id: string; here: boolean }>).filter(
      (row) => row.learner_id === learnerC,
    );
    // OD-4 added `session` to each counted entry; the afternoon absence is still left out.
    expect(afterRows).toEqual([{ learner_id: learnerC, class_id: classId, taken_on: today, session: "morning", here: true }].map((row) => ({
      class_id: row.class_id,
      learner_id: row.learner_id,
      taken_on: row.taken_on,
      session: row.session,
      here: row.here,
    })));
    expect(afterRows.every((row) => row.here)).toBe(true);
  });
});
