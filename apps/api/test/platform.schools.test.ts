/**
 * Platform console slice P1 (apps/api/docs/PLATFORM-CONSOLE.md): GET /v1/platform/schools and /{schoolId}.
 * Read-only directory of every school for super administrators. Negative cases: no session, school admin, org admin,
 * teacher, parent, and school users sending X-Tenant-Id (their own school or another one). A refused caller gets 403 before
 * any query parameter is looked at, and the refusal is audited.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";
import { CURSOR_VERSION, encodeCursor, pageFingerprint } from "../src/http/pagination.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
const PASSWORD = "correct-horse-battery";
const B = "/v1/platform/schools";

describe("platform school directory (read-only)", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  const tokens: Record<string, string> = {};
  let orgC: string;
  let suspendedSchool: string;
  let onboardingSchool: string;

  const login = async (payload: Record<string, unknown>) => {
    const url = "email" in payload ? "/v1/auth/login/email" : "/v1/auth/login/login-id";
    const res = await ctx.app.inject({ method: "POST", url, payload });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    return res.json().token as string;
  };
  const get = (url: string, token?: string, tenant?: string) =>
    ctx.app.inject({
      method: "GET",
      url,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenant ? { "x-tenant-id": tenant } : {}) },
    });
  const addSchool = async (orgId: string, name: string, status = "active") => {
    const id = randomUUID();
    await ctx.pool.query(`INSERT INTO tenants (id, organization_id, name, slug, status) VALUES ($1, $2, $3, $4, $5)`, [
      id,
      orgId,
      name,
      `plat-${id.slice(0, 8)}`,
      status,
    ]);
    return id;
  };
  /** Every school in the order the endpoint promises, straight from the owner connection. */
  const expected = async (where = "TRUE", params: unknown[] = []) =>
    (
      await ctx.pool.query<{ id: string }>(`SELECT id FROM tenants t WHERE ${where} ORDER BY t.name COLLATE "C", t.id`, params)
    ).rows.map((r) => r.id);
  async function walk(query: string, limit: number, token = tokens.super!) {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 100; guard++) {
      const sep = query ? "&" : "";
      const res = await get(`${B}?${query}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, token);
      expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
      const body = res.json() as { items: Array<{ id: string }>; page: { limit: number; next_cursor: string | null } };
      expect(body.items.length).toBeLessThanOrEqual(limit);
      expect(body.page.limit).toBe(limit);
      seen.push(...body.items.map((i) => i.id));
      cursor = body.page.next_cursor;
      if (!cursor) break;
    }
    return seen;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    orgC = randomUUID();
    await ctx.pool.query(`INSERT INTO organizations (id, name, slug, kind, status) VALUES ($1, 'Org C', 'org-c-plat', 'county', 'pending')`, [orgC]);
    suspendedSchool = await addSchool(ids.orgB, "Suspended Academy", "suspended");
    onboardingSchool = await addSchool(orgC, "Onboarding High", "onboarding");
    await addSchool(ids.orgA, "Same Name");
    await addSchool(ids.orgB, "Same Name"); // identical names: ordered by id
    await addSchool(ids.orgA, "zeta school"); // lower case sorts after upper case under COLLATE "C"
    await addSchool(ids.orgA, "Alpha School");

    tokens.super = await login({ email: "super@example.com", password: PASSWORD });
    tokens.schoolAdmin = await login({ email: "admin-a@example.com", password: PASSWORD });
    tokens.orgAdmin = await login({ email: "orgadmin@example.com", password: PASSWORD });
    tokens.teacher = await login({ tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD });
    tokens.teacherB = await login({ tenantId: ids.tenantB, loginId: "TC-0001", password: PASSWORD });
    tokens.parent = await login({ tenantId: ids.tenantA, loginId: "PT-0001", password: PASSWORD });
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("a super admin lists every school, in name order, with directory fields only", async () => {
    const res = await get(B, tokens.super);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["items", "page"]);
    expect(body.page).toEqual({ limit: 50, next_cursor: null });
    expect(body.items.map((s: { id: string }) => s.id)).toEqual(await expected());
    const a = body.items.find((s: { id: string }) => s.id === ids.tenantA);
    expect(a).toEqual({
      id: ids.tenantA,
      name: "School A",
      slug: "school-a",
      status: "active",
      timezone: "Africa/Nairobi",
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      organization: { id: ids.orgA, name: "Org A", slug: "org-a", kind: "group_owner", status: "active" },
      hrRequestedAt: null,
      hrRequestedBy: null,
    });
    // nothing from inside a school but its request for HR (migration 117): exactly these keys on every item
    for (const s of body.items) {
      expect(Object.keys(s).sort()).toEqual(["createdAt", "hrRequestedAt", "hrRequestedBy", "id", "name", "organization", "slug", "status", "timezone"]);
      expect(Object.keys(s.organization).sort()).toEqual(["id", "kind", "name", "slug", "status"]);
    }
    // suspended schools and schools of a pending organisation are listed too (this is the platform's view)
    const listed = new Set(body.items.map((s: { id: string }) => s.id));
    expect(listed.has(suspendedSchool)).toBe(true);
    expect(listed.has(onboardingSchool)).toBe(true);
  });

  it("a school's request for HR & Payroll shows on the list and the detail: when, and the id of the account that asked (no name)", async () => {
    await ctx.pool.query(`UPDATE tenants SET hr_requested_at = '2026-11-20T08:30:00.123Z', hr_requested_by = $2 WHERE id = $1`, [ids.tenantB, ids.teacherB]);
    try {
      const item = (await get(B, tokens.super)).json().items.find((s: { id: string }) => s.id === ids.tenantB);
      expect(item).toMatchObject({ hrRequestedAt: "2026-11-20T08:30:00.123Z", hrRequestedBy: ids.teacherB });
      const one = (await get(`${B}/${ids.tenantB}`, tokens.super)).json();
      expect(one).toMatchObject({ hrRequestedAt: "2026-11-20T08:30:00.123Z", hrRequestedBy: ids.teacherB });
      expect(JSON.stringify(one)).not.toContain("Teacher B");
      // the other schools never asked
      expect((await get(`${B}/${ids.tenantA}`, tokens.super)).json()).toMatchObject({ hrRequestedAt: null, hrRequestedBy: null });
    } finally {
      await ctx.pool.query(`UPDATE tenants SET hr_requested_at = NULL, hr_requested_by = NULL WHERE id = $1`, [ids.tenantB]);
    }
  });

  it.each([1, 2, 3, 50])("paging with limit %i visits every school exactly once in order", async (limit) => {
    const seen = await walk("", limit);
    expect(seen).toEqual(await expected());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("filters by status and by organisation, and pages within the filter", async () => {
    expect(await walk("status=suspended", 1)).toEqual([suspendedSchool]);
    expect(await walk("status=onboarding", 50)).toEqual([onboardingSchool]);
    expect(await walk("status=trial", 50)).toEqual([]);
    expect(await walk(`organizationId=${ids.orgA}`, 2)).toEqual(await expected("t.organization_id = $1", [ids.orgA]));
    expect(await walk(`organizationId=${ids.orgB}&status=active`, 1)).toEqual(
      await expected("t.organization_id = $1 AND t.status = 'active'", [ids.orgB]),
    );
    expect(await walk(`organizationId=${randomUUID()}`, 50)).toEqual([]);
  });

  it("refuses bad parameters with 400 validation_error", async () => {
    for (const q of ["status=closed", "status=", "organizationId=nope", "limit=0", "limit=201", "limit=1e2", "sort=name", "cursor=abc", "cursor=!!!!!!!!!!"]) {
      const res = await get(`${B}?${q}`, tokens.super);
      if (q === "status=") {
        expect(res.statusCode, q).toBe(200); // an empty filter is no filter
        continue;
      }
      expect(res.statusCode, q).toBe(400);
      expect(res.json().error.code, q).toBe("validation_error");
    }
    // repeated status (an array) is refused, not taken as either value
    expect((await get(`${B}?status=active&status=suspended`, tokens.super)).statusCode).toBe(400);
  });

  it("a cursor is bound to its filters, and a cursor for a school that no longer exists is refused", async () => {
    const first = (await get(`${B}?status=active&limit=1`, tokens.super)).json();
    const cursor = first.page.next_cursor as string;
    expect(cursor).toBeTruthy();
    for (const q of ["", "status=suspended", `organizationId=${ids.orgA}`, "status=active&organizationId=" + ids.orgA]) {
      const res = await get(`${B}?${q}${q ? "&" : ""}limit=1&cursor=${encodeURIComponent(cursor)}`, tokens.super);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().error.message, q).toBe("cursor does not match this query");
    }
    const fp = pageFingerprint("school_name", { scope: "platform", status: null, organizationId: null });
    const gone = await addSchool(ids.orgA, "Will be deleted");
    await ctx.pool.query(`DELETE FROM tenants WHERE id = $1`, [gone]);
    for (const id of [gone, randomUUID()]) {
      const c = encodeCursor({ v: CURSOR_VERSION, k: [id], f: fp, s: "school_name" });
      const res = await get(`${B}?cursor=${encodeURIComponent(c)}`, tokens.super);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe("cursor is no longer valid; start again from the first page");
    }
    // the org-schools cursor (another endpoint, another fingerprint) does not work here
    const orgCursor = encodeCursor({
      v: CURSOR_VERSION,
      k: [ids.tenantA],
      f: pageFingerprint("org_name_school_name", { scopeUserId: ids.orgAdmin }),
      s: "org_name_school_name",
    });
    expect((await get(`${B}?cursor=${encodeURIComponent(orgCursor)}`, tokens.super)).statusCode).toBe(400);
  });

  it("a super admin reads one school, including a suspended one; unknown is 404, malformed is 400", async () => {
    const res = await get(`${B}/${ids.tenantB}`, tokens.super);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: ids.tenantB, name: "School B", slug: "school-b", status: "active", organization: { id: ids.orgB } });
    const list = (await get(B, tokens.super)).json().items.find((s: { id: string }) => s.id === ids.tenantB);
    expect(res.json()).toEqual(list); // the same record as the list item
    expect((await get(`${B}/${suspendedSchool}`, tokens.super)).json()).toMatchObject({ status: "suspended" });
    const missing = await get(`${B}/${randomUUID()}`, tokens.super);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toMatchObject({ code: "not_found", message: "School not found" });
    expect((await get(`${B}/not-a-uuid`, tokens.super)).statusCode).toBe(400);
  });

  it("the caller's school is ignored: a super admin gets the same answer with or without X-Tenant-Id", async () => {
    const plain = (await get(B, tokens.super)).json();
    expect((await get(B, tokens.super, ids.tenantA)).json()).toEqual(plain);
    expect((await get(`${B}/${ids.tenantB}`, tokens.super, ids.tenantA)).json()).toEqual((await get(`${B}/${ids.tenantB}`, tokens.super)).json());
  });

  it("no session is 401 on both routes", async () => {
    expect((await get(B)).statusCode).toBe(401);
    expect((await get(`${B}/${ids.tenantA}`)).statusCode).toBe(401);
    expect((await get(B, "not-a-real-token")).statusCode).toBe(401);
    expect((await get(`${B}/${ids.tenantA}`, undefined, ids.tenantA)).statusCode).toBe(401);
  });

  it("school admin, org admin, teacher and parent are 403 on both routes, with or without X-Tenant-Id", async () => {
    const cases: Array<[string, string | undefined]> = [
      ["schoolAdmin", undefined],
      ["schoolAdmin", ids.tenantA],
      ["schoolAdmin", ids.tenantB],
      ["orgAdmin", undefined],
      ["orgAdmin", ids.tenantA],
      ["teacher", undefined],
      ["teacher", ids.tenantA],
      ["teacher", ids.tenantB], // spoofing another school
      ["teacherB", ids.tenantA],
      ["parent", undefined],
      ["parent", ids.tenantA],
    ];
    for (const [who, tenant] of cases) {
      for (const url of [B, `${B}/${ids.tenantA}`, `${B}/${ids.tenantB}`, `${B}?status=active`]) {
        const res = await get(url, tokens[who], tenant);
        expect(res.statusCode, `${who} ${tenant ?? "-"} ${url}`).toBe(403);
        expect(res.json().error.code).toBe("forbidden");
        expect(res.body).not.toContain("School A");
        expect(res.body).not.toContain("school-b");
      }
    }
  });

  it("a refused caller gets 403, not 400, for bad parameters (nothing is read before the permission check)", async () => {
    for (const who of ["schoolAdmin", "orgAdmin", "teacher"]) {
      expect((await get(`${B}?status=closed&limit=999`, tokens[who])).statusCode, who).toBe(403);
      expect((await get(`${B}/not-a-uuid`, tokens[who])).statusCode, who).toBe(403);
    }
  });

  it("an org admin's refusal is audited as a permission denial naming platform.tenants.read", async () => {
    const before = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM security_audit_events WHERE event_type = 'rbac.permission.denied' AND actor_user_id = $1 AND detail->>'permission' = 'platform.tenants.read'`,
      [ids.orgAdmin],
    );
    expect((await get(`${B}/${ids.tenantA}`, tokens.orgAdmin)).statusCode).toBe(403);
    const after = await ctx.pool.query<{ n: number; tenant_id: string | null }>(
      `SELECT count(*)::int AS n, max(tenant_id::text) AS tenant_id FROM security_audit_events WHERE event_type = 'rbac.permission.denied' AND actor_user_id = $1 AND detail->>'permission' = 'platform.tenants.read'`,
      [ids.orgAdmin],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n + 1);
    expect(after.rows[0]!.tenant_id).toBeNull(); // a platform read is not about one school
  });

  it("losing the platform role takes effect on the next request", async () => {
    await ctx.pool.query(`DELETE FROM platform_roles WHERE user_id = $1`, [ids.superAdmin]);
    try {
      expect((await get(B, tokens.super)).statusCode).toBe(403);
      expect((await get(`${B}/${ids.tenantA}`, tokens.super)).statusCode).toBe(403);
    } finally {
      await ctx.pool.query(`INSERT INTO platform_roles (user_id, role) VALUES ($1, 'super_admin')`, [ids.superAdmin]);
    }
    expect((await get(B, tokens.super)).statusCode).toBe(200);
  });

  it("the routes write nothing: no tenant, organisation or audit row changes on a read", async () => {
    const snap = async () =>
      (
        await ctx.pool.query<{ t: string; o: string; a: number }>(
          `SELECT (SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM tenants t) AS t,
                  (SELECT md5(string_agg(o::text, ',' ORDER BY id)) FROM organizations o) AS o,
                  (SELECT count(*)::int FROM security_audit_events) AS a`,
        )
      ).rows[0]!;
    const before = await snap();
    await get(B, tokens.super);
    await get(`${B}/${ids.tenantA}`, tokens.super);
    expect(await snap()).toEqual(before);
  });
});
