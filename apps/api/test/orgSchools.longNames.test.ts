/**
 * WP-A1 final remediation: /v1/org/schools paginates correctly when organisation or school
 * names are longer than the old 256-character cursor bound. The schema has no name limit, so
 * the cursor carries only the last school's id and the boundary is read in SQL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestApp, type FixtureIds } from "./support.js";
import { CURSOR_VERSION, encodeCursor, pageFingerprint } from "../src/http/pagination.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

describe("org schools pagination with long names", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let token: string;
  let slugN = 0;
  const bearer = () => ({ authorization: `Bearer ${token}` });

  const addTenant = async (orgId: string, name: string, status = "active") => {
    const id = randomUUID();
    await ctx.pool.query(
      `INSERT INTO tenants (id, organization_id, name, slug, status) VALUES ($1, $2, $3, $4, $5)`,
      [id, orgId, name, `long-${++slugN}-${id.slice(0, 8)}`, status],
    );
    return id;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    const login = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "orgadmin@example.com", password: "correct-horse-battery" },
    });
    expect(login.statusCode).toBe(200);
    token = login.json().token as string;

    // Organisation A: name above the old bound.
    await ctx.pool.query(`UPDATE organizations SET name = $2 WHERE id = $1`, [ids.orgA, `Org-${"A".repeat(300)}`]);
    // A second organisation the same admin runs, with an enormous name.
    const orgC = randomUUID();
    await ctx.pool.query(
      `INSERT INTO organizations (id, name, slug, kind, status) VALUES ($1, $2, 'org-c-long', 'group_owner', 'active')`,
      [orgC, `Org-${"C".repeat(5000)}`],
    );
    await ctx.pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role) VALUES ($1, $2, 'org_admin')`,
      [ids.orgAdmin, orgC],
    );
    // An organisation the admin does NOT run (must never appear).
    const orgD = randomUUID();
    await ctx.pool.query(`INSERT INTO organizations (id, name, slug, kind, status) VALUES ($1, 'Foreign Org', 'foreign-org', 'group_owner', 'active')`, [orgD]);
    await addTenant(orgD, "Foreign School");

    // Names below, at and above 256, plus huge ones that differ only at the very end, and ties.
    for (const len of [1, 255, 256, 257, 1000]) await addTenant(ids.orgA, `s${"x".repeat(len - 1)}`);
    await addTenant(ids.orgA, `${"a".repeat(4000)}x`);
    await addTenant(ids.orgA, `${"a".repeat(4000)}y`);
    await addTenant(ids.orgA, "Same name");
    await addTenant(ids.orgA, "Same name"); // identical name: ordered by id
    for (const len of [255, 256, 257]) await addTenant(orgC, `c${"y".repeat(len - 1)}`);
    await addTenant(orgC, "b".repeat(9000));
    await addTenant(orgC, "Same name");
    await addTenant(orgC, "Suspended-org-school", "suspended"); // suspended school still listed (rule unchanged)
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.runtimePool.end();
    await ctx.pool.end();
  });

  const expectedOrder = async () =>
    (await ctx.pool.query<{ id: string; name: string }>(
      `SELECT t.id, t.name
         FROM tenants t
         JOIN organizations o ON o.id = t.organization_id
         JOIN organization_memberships om ON om.organization_id = o.id AND om.user_id = $1 AND om.role = 'org_admin'
        WHERE o.status = 'active'
        ORDER BY o.name COLLATE "C", t.name COLLATE "C", t.id`,
      [ids.orgAdmin],
    )).rows;

  async function walk(limit: number) {
    const seen: Array<{ id: string; name: string }> = [];
    const cursors: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 200; guard++) {
      const res: { statusCode: number; body: string; json(): any } = await ctx.app.inject({
        method: "GET",
        url: `/v1/org/schools?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        headers: bearer(),
      });
      expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
      const body: { items: Array<{ id: string; name: string }>; page: { next_cursor: string | null } } = res.json();
      expect(body.items.length).toBeLessThanOrEqual(limit);
      for (const it of body.items) seen.push({ id: it.id, name: it.name });
      cursor = body.page.next_cursor;
      if (!cursor) break;
      cursors.push(cursor);
    }
    return { seen, cursors };
  }

  it("the data really contains names below, at and above 256 characters", async () => {
    const lengths = (await expectedOrder()).map((r) => r.name.length);
    for (const want of [255, 256, 257, 1000, 4001, 9000]) expect(lengths, `length ${want}`).toContain(want);
    expect((await ctx.pool.query<{ l: number }>(`SELECT max(char_length(name))::int AS l FROM organizations`)).rows[0]!.l).toBeGreaterThan(5000);
  });

  it.each([1, 2, 3, 5, 7, 50])("traverses every school exactly once in SQL order with limit %i", async (limit) => {
    const expected = await expectedOrder();
    expect(expected.length).toBeGreaterThanOrEqual(16);
    const { seen, cursors } = await walk(limit);
    expect(seen.map((s) => s.id)).toEqual(expected.map((e) => e.id)); // no skip, no duplicate, same order
    expect(new Set(seen.map((s) => s.id)).size).toBe(seen.length);
    // Names are returned whole, never truncated.
    expect(seen.map((s) => s.name.length)).toEqual(expected.map((e) => e.name.length));
    // The cursor stays small however long the names are.
    for (const c of cursors) expect(c.length).toBeLessThan(200);
    // Foreign organisations never appear.
    expect(seen.some((s) => s.name === "Foreign School")).toBe(false);
  });

  it("pages that end exactly on a long name continue correctly (every boundary)", async () => {
    const expected = await expectedOrder();
    // limit=1 makes every school a page boundary, including the 4001- and 9000-character ones.
    const { seen } = await walk(1);
    expect(seen).toHaveLength(expected.length);
    expect(seen.map((s) => s.id)).toEqual(expected.map((e) => e.id));
  });

  it("an id that is no longer in the caller's set is rejected like an unknown one, as 400 with the generic envelope", async () => {
    const fp = pageFingerprint("org_name_school_name", { scopeUserId: ids.orgAdmin });
    const cursorFor = (id: string) => encodeCursor({ v: CURSOR_VERSION, k: [id], f: fp, s: "org_name_school_name" });
    const foreign = (await ctx.pool.query<{ id: string }>(`SELECT id FROM tenants WHERE name = 'Foreign School'`)).rows[0]!.id;
    const gone = await addTenant(ids.orgA, "Will be deleted");
    await ctx.pool.query(`DELETE FROM tenants WHERE id = $1`, [gone]);
    for (const id of [foreign, gone, randomUUID()]) {
      const res = await ctx.app.inject({ method: "GET", url: `/v1/org/schools?cursor=${encodeURIComponent(cursorFor(id))}`, headers: bearer() });
      expect(res.statusCode).toBe(400);
      const err = res.json().error;
      expect(err.code).toBe("validation_error");
      expect(err.message).toBe("cursor is no longer valid; start again from the first page");
      expect(Object.keys(res.json())).toEqual(["error"]);
    }
  });

  it("malformed and old-format (3-key) cursors still fail with 400", async () => {
    const fp = pageFingerprint("org_name_school_name", { scopeUserId: ids.orgAdmin });
    const oldFormat = encodeCursor({ v: CURSOR_VERSION, k: ["Org A", "School A", ids.tenantA], f: fp, s: "org_name_school_name" });
    const notUuid = encodeCursor({ v: CURSOR_VERSION, k: ["not-a-uuid"], f: fp, s: "org_name_school_name" });
    const otherPrincipal = encodeCursor({ v: CURSOR_VERSION, k: [ids.tenantA], f: pageFingerprint("org_name_school_name", { scopeUserId: ids.adminA }), s: "org_name_school_name" });
    for (const c of [oldFormat, notUuid, otherPrincipal, "!!!!!!!!!!", "abc"]) {
      const res = await ctx.app.inject({ method: "GET", url: `/v1/org/schools?cursor=${encodeURIComponent(c)}`, headers: bearer() });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation_error");
    }
  });

  it("a school in a non-active organisation is neither listed nor usable as a cursor anchor", async () => {
    const dormantOrg = randomUUID();
    await ctx.pool.query(`INSERT INTO organizations (id, name, slug, kind, status) VALUES ($1, 'Dormant', 'dormant-long', 'group_owner', 'suspended')`, [dormantOrg]);
    await ctx.pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role) VALUES ($1, $2, 'org_admin')`, [ids.orgAdmin, dormantOrg]);
    const dormantSchool = await addTenant(dormantOrg, "Dormant School");
    const { seen } = await walk(50);
    expect(seen.some((s) => s.id === dormantSchool)).toBe(false);
    const fp = pageFingerprint("org_name_school_name", { scopeUserId: ids.orgAdmin });
    const res = await ctx.app.inject({
      method: "GET",
      url: `/v1/org/schools?cursor=${encodeURIComponent(encodeCursor({ v: CURSOR_VERSION, k: [dormantSchool], f: fp, s: "org_name_school_name" }))}`,
      headers: bearer(),
    });
    expect(res.statusCode).toBe(400);
  });
});
