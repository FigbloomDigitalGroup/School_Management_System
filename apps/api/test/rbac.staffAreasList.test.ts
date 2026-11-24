import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { hashPassword } from "../src/modules/identity/password.js";

/**
 * GET /v1/rbac/staff-areas: the read side of the staff-areas write. Who holds which admin areas of their own in the active
 * school, keyset-paged by user id; only a holder of rbac.staff_areas.manage may read it; one school never sees another's.
 * Real HTTP application, real figbloom_app runtime login.
 */
describe("GET /v1/rbac/staff-areas", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const PASSWORD = "correct-horse-battery";
  const tokens: Record<string, string> = {};
  let staffB = ""; // a second staff member of school A
  let staffC = ""; // a staff member of school B
  const A = () => ctx.ids.tenantA;
  const B = () => ctx.ids.tenantB;

  const login = async (body: Record<string, unknown>) => {
    const r = await ctx.app.inject({ method: "POST", url: body.email ? "/v1/auth/login/email" : "/v1/auth/login/login-id", payload: body });
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  };
  const get = (who: string, query = "", tenant = A()) =>
    ctx.app.inject({ method: "GET", url: `/v1/rbac/staff-areas${query}`, headers: { authorization: `Bearer ${tokens[who]}`, "x-tenant-id": tenant } });
  const put = (who: string, userId: string, areas: string[], tenant = A()) =>
    ctx.app.inject({ method: "PUT", url: "/v1/rbac/staff-areas", headers: { authorization: `Bearer ${tokens[who]}`, "x-tenant-id": tenant }, payload: { userId, areas } });

  beforeAll(async () => {
    ctx = await createTestApp();
    const hash = await hashPassword(PASSWORD);
    const mk = async (name: string) => {
      const id = randomUUID();
      await ctx.pool.query(`INSERT INTO users (id, email, password_hash, full_name, status) VALUES ($1, NULL, $2, $3, 'active')`, [id, hash, name]);
      return id;
    };
    staffB = await mk("Staff B");
    staffC = await mk("Staff C");
    await ctx.pool.query(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'staff', 'SF-0201')`, [staffB, A()]);
    await ctx.pool.query(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'staff', 'SF-0202')`, [staffC, B()]);
    tokens.admin = await login({ email: "admin-a@example.com", password: PASSWORD });
    tokens.teacher = await login({ tenantId: A(), loginId: "TC-0001", password: PASSWORD });
    tokens.parent = await login({ tenantId: A(), loginId: "PT-0001", password: PASSWORD });
    tokens.super = await login({ email: "super@example.com", password: PASSWORD });
    await ctx.pool.query(`DELETE FROM staff_area_grants WHERE tenant_id IN ($1, $2)`, [A(), B()]);
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("is empty until someone holds an area", async () => {
    const r = await get("admin");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ tenantId: A(), items: [], page: { next_cursor: null } });
  });

  it("lists what the write set, in the catalogue's order, one row per person", async () => {
    expect((await put("admin", ctx.ids.teacherA, ["attendance", "fees", "people"])).statusCode).toBe(200);
    expect((await put("admin", staffB, ["audit"])).statusCode).toBe(200);
    const r = await get("admin");
    expect(r.statusCode).toBe(200);
    const byUser = new Map((r.json().items as Array<{ userId: string; areas: string[] }>).map((i) => [i.userId, i.areas]));
    expect(byUser.size).toBe(2);
    expect(byUser.get(ctx.ids.teacherA)).toEqual(["people", "fees", "attendance"]);
    expect(byUser.get(staffB)).toEqual(["audit"]);
    // a person whose areas were all taken away is no longer listed
    expect((await put("admin", staffB, [])).statusCode).toBe(200);
    const after = await get("admin");
    expect((after.json().items as Array<{ userId: string }>).map((i) => i.userId)).toEqual([ctx.ids.teacherA]);
  });

  it("pages by user id and refuses a cursor from another list or tenant", async () => {
    expect((await put("admin", staffB, ["visitors"])).statusCode).toBe(200);
    const first = await get("admin", "?limit=1");
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(1);
    const cursor = first.json().page.next_cursor as string;
    expect(cursor).toBeTruthy();
    const second = await get("admin", `?limit=1&cursor=${encodeURIComponent(cursor)}`);
    expect(second.statusCode).toBe(200);
    expect(second.json().items).toHaveLength(1);
    expect(second.json().page.next_cursor).toBeNull();
    const seen = [first.json().items[0].userId, second.json().items[0].userId];
    expect(new Set(seen).size).toBe(2);
    expect([...seen].sort()).toEqual(seen);
    // not another school's, and not another endpoint's
    expect((await get("super", `?limit=1&cursor=${encodeURIComponent(cursor)}`, B())).statusCode).toBe(400);
    const permCursor = (await ctx.app.inject({ method: "GET", url: "/v1/rbac/permissions?limit=1", headers: { authorization: `Bearer ${tokens.admin}`, "x-tenant-id": A() } })).json().page.next_cursor as string;
    expect((await get("admin", `?cursor=${encodeURIComponent(permCursor)}`)).statusCode).toBe(400);
    expect((await get("admin", "?limit=0")).statusCode).toBe(400);
    expect((await get("admin", "?sort=name")).statusCode).toBe(400);
  });

  it("shows a school only its own grants", async () => {
    expect((await put("super", staffC, ["leave"], B())).statusCode).toBe(200);
    const a = await get("admin");
    expect((a.json().items as Array<{ userId: string }>).map((i) => i.userId)).not.toContain(staffC);
    const b = await get("super", "", B());
    expect(b.statusCode).toBe(200);
    expect(b.json().items).toEqual([{ userId: staffC, areas: ["leave"] }]);
  });

  it("is refused to a teacher, a parent and anyone not signed in", async () => {
    expect((await get("teacher")).statusCode).toBe(403);
    expect((await get("parent")).statusCode).toBe(403);
    const anon = await ctx.app.inject({ method: "GET", url: "/v1/rbac/staff-areas", headers: { "x-tenant-id": A() } });
    expect(anon.statusCode).toBe(401);
  });
});
