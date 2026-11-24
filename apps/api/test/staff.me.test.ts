import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

/**
 * GET /v1/tenants/:tenantId/staff/me — the caller's own staff record.
 *
 * Why it exists: class teachers, teaching assignments and timetable slots name STAFF ids, and a teacher with no directory
 * permission cannot read the staff list, so on their own they could never tell which of those is theirs. The route reads only the
 * caller's own row, so it needs no directory permission.
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
type Json = Record<string, unknown>;

describe("GET /v1/tenants/:tenantId/staff/me", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let admin: string;
  let teacher: string;
  let parent: string;
  let otherSchoolTeacher: string;
  let staffId: string;

  const headers = (token: string, tenantId: string): Record<string, string> => ({ authorization: `Bearer ${token}`, "x-tenant-id": tenantId });
  const getMe = (token: string | null, tenantId: string = ids.tenantA) =>
    ctx.app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/staff/me`, ...(token ? { headers: headers(token, tenantId) } : {}) });
  const adminCall = (method: "GET" | "POST" | "PATCH", path: string, payload?: Json) =>
    ctx.app.inject({ method, url: `/v1/tenants/${ids.tenantA}${path}`, headers: headers(admin, ids.tenantA), ...(payload ? { payload } : {}) });

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
    const made = await adminCall("POST", "/staff", { full_name: "Teacher A", classification: "teacher", userId: ids.teacherA });
    expect(made.statusCode).toBe(201);
    staffId = made.json().staff.id as string;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("a teacher with no directory permission reads their own record, and not the list", async () => {
    const me = await getMe(teacher);
    expect(me.statusCode).toBe(200);
    expect(me.json().staff).toMatchObject({ id: staffId, userId: ids.teacherA, full_name: "Teacher A", active: true });
    // The same teacher cannot read the directory or another person's row: the route widened nothing.
    expect((await ctx.app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantA}/staff`, headers: headers(teacher, ids.tenantA) })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantA}/staff/${staffId}`, headers: headers(teacher, ids.tenantA) })).statusCode).toBe(403);
  });

  it("answers 404 when the account has no staff record here (administrator not in the directory, parent)", async () => {
    for (const token of [admin, parent]) {
      const res = await getMe(token);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    }
  });

  it("answers 404 once the record is archived, and the record again after it is restored", async () => {
    expect((await adminCall("POST", `/staff/${staffId}/archive`)).statusCode).toBe(200);
    expect((await getMe(teacher)).statusCode).toBe(404);
    expect((await adminCall("POST", `/staff/${staffId}/restore`)).statusCode).toBe(200);
    expect((await getMe(teacher)).json().staff.id).toBe(staffId);
  });

  it("is a school-scoped read: another school's teacher gets nothing from this school, and an unauthenticated caller 401", async () => {
    // A teacher of school B naming school A: no membership there.
    const cross = await ctx.app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantA}/staff/me`, headers: headers(otherSchoolTeacher, ids.tenantA) });
    expect(cross.statusCode).toBe(403);
    // In their own school they have no staff record: 404, never school A's row.
    expect((await getMe(otherSchoolTeacher, ids.tenantB)).statusCode).toBe(404);
    expect((await getMe(null)).statusCode).toBe(401);
  });

  it("rejects a path tenant that is not a UUID", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/v1/tenants/not-a-uuid/staff/me", headers: { authorization: `Bearer ${teacher}` } });
    expect(res.statusCode).toBe(400);
  });
});
