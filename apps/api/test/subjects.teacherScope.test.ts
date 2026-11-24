import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

/**
 * GET /v1/tenants/:tenantId/subjects, OD-2 read scope.
 *
 * Timetable slots and teaching assignments carry only subject ids, so a teacher with no `resource.academics.read` must be able to
 * read the NAMES of the subjects of the classes they teach, and nothing wider. Holders of the permission read every subject as
 * before; a caller who teaches nothing still gets the audited 403; no write is opened.
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
type Json = Record<string, unknown>;

describe("GET /v1/tenants/:tenantId/subjects is teacher-scoped for a caller without academics read", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let admin: string;
  let teacher: string;
  let parent: string;
  let otherSchoolTeacher: string;
  let classX: string;
  let classY: string;
  let taught: string;
  let inTimetableOnly: string;
  let someoneElses: string;

  const headers = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}`, "x-tenant-id": ids.tenantA });
  const call = (method: "GET" | "POST", path: string, token: string, payload?: Json) =>
    ctx.app.inject({ method, url: `/v1/tenants/${ids.tenantA}${path}`, headers: headers(token), ...(payload ? { payload } : {}) });
  const subjectNames = async (token: string, query = "") => {
    const res = await call("GET", `/subjects${query}`, token);
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().subjects as { name: string }[]).map((s) => s.name);
  };
  async function created(path: string, payload: Json, key: string): Promise<string> {
    const res = await call("POST", path, admin, payload);
    expect(res.statusCode, `${path} ${res.body}`).toBe(201);
    return res.json()[key].id as string;
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
    otherSchoolTeacher = await login({ tenantId: ids.tenantB, loginId: "TC-0001", password: "correct-horse-battery" });

    const year = (await call("POST", "/academic-years", admin, { label: "Subj 2026", starts_on: "2020-01-01", ends_on: "2035-12-31" })).json().academic_year.id as string;
    classX = await created("/classes", { academic_year_id: year, name: "SUBJ X" }, "school_class");
    classY = await created("/classes", { academic_year_id: year, name: "SUBJ Y" }, "school_class");
    taught = await created("/subjects", { code: "SBT", name: "Taught subject" }, "subject");
    inTimetableOnly = await created("/subjects", { code: "SBL", name: "Timetable-only subject" }, "subject");
    someoneElses = await created("/subjects", { code: "SBO", name: "Other class subject" }, "subject");
    await created("/subjects", { code: "SBU", name: "Unused subject" }, "subject");

    // Before they are linked to a staff record the teacher teaches nothing (checked first, below).
    const mine = (await call("POST", "/staff", admin, { full_name: "Teacher A", classification: "teacher", userId: ids.teacherA })).json().staff.id as string;
    const colleague = (await call("POST", "/staff", admin, { full_name: "Colleague", classification: "teacher" })).json().staff.id as string;
    // classX: the teacher teaches `taught`; its timetable also has `inTimetableOnly` (nobody assigned). classY is a colleague's.
    await created("/teaching-assignments", { staff_member_id: mine, class_id: classX, subject_id: taught }, "assignment");
    await created("/timetable-slots", { class_id: classX, subject_id: inTimetableOnly, day_of_week: 1, starts_at: "08:00", ends_at: "08:40" }, "slot");
    await created("/teaching-assignments", { staff_member_id: colleague, class_id: classY, subject_id: someoneElses }, "assignment");
  }, 180_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("a teacher reads only the subjects of the assignments and timetable slots of the classes they teach", async () => {
    expect(await subjectNames(teacher)).toEqual(["Taught subject", "Timetable-only subject"]);
    // The other filters still apply inside the scope.
    expect(await subjectNames(teacher, "?active=true")).toEqual(["Taught subject", "Timetable-only subject"]);
    expect(await subjectNames(teacher, "?active=false")).toEqual([]);
  });

  it("a school administrator (academics read) still reads every subject", async () => {
    const names = await subjectNames(admin);
    for (const n of ["Taught subject", "Timetable-only subject", "Other class subject", "Unused subject"]) expect(names).toContain(n);
  });

  it("an archived assignment or slot no longer exposes its subject to the teacher", async () => {
    const slots = (await call("GET", `/timetable-slots?classId=${classX}`, admin)).json().slots as { id: string; subject_id: string }[];
    expect(slots.length).toBeGreaterThan(0);
    // No archive route for a slot exists: the database row is what the scope reads, so archive it as the owner does.
    await ctx.pool.query(`UPDATE timetable_slots SET active = false, archived_at = now() WHERE tenant_id = $1 AND class_id = $2`, [ids.tenantA, classX]);
    expect(await subjectNames(teacher)).toEqual(["Taught subject"]);
    await ctx.pool.query(`UPDATE timetable_slots SET active = true, archived_at = NULL WHERE tenant_id = $1 AND class_id = $2`, [ids.tenantA, classX]);
    expect(await subjectNames(teacher)).toEqual(["Taught subject", "Timetable-only subject"]);
  });

  it("grants no write and no wider read to that teacher", async () => {
    expect((await call("POST", "/subjects", teacher, { code: "NEW", name: "Nope" })).statusCode).toBe(403);
    // Other academics lists stay closed to them (the classes list is scoped by the same rule and is a separate read).
    expect((await call("GET", "/academic-years", teacher)).statusCode).toBe(403);
  });

  it("a parent, another school's teacher and an unauthenticated caller are refused", async () => {
    expect((await call("GET", "/subjects", parent)).statusCode).toBe(403);
    expect((await call("GET", "/subjects", otherSchoolTeacher)).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantA}/subjects` })).statusCode).toBe(401);
  });

  it("a teacher who teaches nothing gets the audited 403, not an empty list", async () => {
    // Un-link the staff record: the same teacher now teaches nothing.
    await ctx.pool.query(`UPDATE staff_members SET user_id = NULL WHERE tenant_id = $1 AND user_id = $2`, [ids.tenantA, ids.teacherA]);
    const res = await call("GET", "/subjects", teacher);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
    await ctx.pool.query(`UPDATE staff_members SET user_id = $2 WHERE tenant_id = $1 AND full_name = 'Teacher A'`, [ids.tenantA, ids.teacherA]);
    expect(await subjectNames(teacher)).toEqual(["Taught subject", "Timetable-only subject"]);
  });
});
