/**
 * Database-backed HTTP pagination tests (FIG-1621 / IR-01..IR-07).
 * Exercises real PostgreSQL ordering, cursor v2, and app.inject routes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestApp, type FixtureIds } from "./support.js";
import {
  CURSOR_VERSION,
  encodeCursor,
  pageFingerprint,
} from "../src/http/pagination.js";

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

function bearer(token: string, tenantId?: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (tenantId) headers["x-tenant-id"] = tenantId;
  return headers;
}

describe("FIG-1621 SQL keyset pagination (HTTP)", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let orgToken: string;
  let adminToken: string;
  let teacherBToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    orgToken = await loginEmail(ctx.app, "orgadmin@example.com");
    adminToken = await loginEmail(ctx.app, "admin-a@example.com");
    const teacherBLogin = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/login-id",
      payload: { tenantId: ids.tenantB, loginId: "TC-0001", password: "correct-horse-battery" },
    });
    expect(teacherBLogin.statusCode).toBe(200);
    teacherBToken = teacherBLogin.json().token as string;

    // Mixed-case org/school names that disagree between JS `<` and en_US.UTF-8.
    await ctx.pool.query(
      `UPDATE organizations SET name = $2 WHERE id = $1`,
      [ids.orgA, "alpha Org"],
    );
    const extra = [
      { id: randomUUID(), name: "Beta", slug: "beta-school" },
      { id: randomUUID(), name: "Delta", slug: "delta-school" },
      { id: randomUUID(), name: "gamma", slug: "gamma-school" },
    ];
    for (const s of extra) {
      await ctx.pool.query(
        `INSERT INTO tenants (id, organization_id, name, slug, status)
         VALUES ($1, $2, $3, $4, 'active')`,
        [s.id, ids.orgA, s.name, s.slug],
      );
    }
    await ctx.pool.query(`UPDATE tenants SET name = 'alpha' WHERE id = $1`, [ids.tenantA]);
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.runtimePool.end();
    await ctx.pool.end();
  });

  async function walkOrgSchools(limit: number): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const url =
        cursor == null
          ? `/v1/org/schools?limit=${limit}`
          : `/v1/org/schools?limit=${limit}&cursor=${encodeURIComponent(cursor)}`;
      const res = await ctx.app.inject({
        method: "GET",
        url,
        headers: bearer(orgToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        items: Array<{ id: string; name: string; organizationName: string }>;
        page: { next_cursor: string | null; limit: number };
      };
      expect(body.page.limit).toBe(limit);
      for (const item of body.items) {
        expect(seen).not.toContain(item.id);
        seen.push(item.id);
      }
      if (!body.page.next_cursor) break;
      cursor = body.page.next_cursor;
    }
    return seen;
  }

  it("traverses mixed-case org schools across pages without repeating page one", async () => {
    const order = await ctx.pool.query<{ id: string; name: string }>(
      `SELECT t.id, t.name
       FROM tenants t
       JOIN organizations o ON o.id = t.organization_id
       JOIN organization_memberships om
         ON om.organization_id = o.id AND om.user_id = $1 AND om.role = 'org_admin'
       WHERE o.status = 'active'
       ORDER BY o.name COLLATE "C", t.name COLLATE "C", t.id`,
      [ids.orgAdmin],
    );
    // COLLATE "C": ASCII uppercase before lowercase (Beta, Delta, alpha, gamma).
    expect(order.rows.map((r) => r.name)).toEqual(["Beta", "Delta", "alpha", "gamma"]);

    const walked = await walkOrgSchools(2);
    expect(walked).toEqual(order.rows.map((r) => r.id));
    expect(walked.length).toBe(4);
  });

  it("rejects malformed, wrong-version, wrong-sort, wrong-filter and foreign-scope cursors", async () => {
    const first = await ctx.app.inject({
      method: "GET",
      url: "/v1/org/schools?limit=1",
      headers: bearer(orgToken),
    });
    expect(first.statusCode).toBe(200);
    const next = first.json().page.next_cursor as string;
    expect(next).toBeTruthy();

    const bad = await ctx.app.inject({
      method: "GET",
      url: `/v1/org/schools?cursor=!!!`,
      headers: bearer(orgToken),
    });
    expect(bad.statusCode).toBe(400);

    const truncated = await ctx.app.inject({
      method: "GET",
      url: `/v1/org/schools?cursor=${encodeURIComponent(next.slice(0, 12))}`,
      headers: bearer(orgToken),
    });
    expect(truncated.statusCode).toBe(400);

    const wrongVersion = Buffer.from(
      JSON.stringify({
        v: 1,
        k: [ids.tenantA],
        f: pageFingerprint("org_name_school_name", { scopeUserId: ids.orgAdmin }),
        s: "org_name_school_name",
      }),
      "utf8",
    ).toString("base64url");
    const v1 = await ctx.app.inject({
      method: "GET",
      url: `/v1/org/schools?cursor=${encodeURIComponent(wrongVersion)}`,
      headers: bearer(orgToken),
    });
    expect(v1.statusCode).toBe(400);

    const wrongSort = encodeCursor({
      v: CURSOR_VERSION,
      k: [ids.tenantA],
      f: pageFingerprint("org_name_school_name", { scopeUserId: ids.orgAdmin }),
      s: "other",
    });
    const sortRes = await ctx.app.inject({
      method: "GET",
      url: `/v1/org/schools?cursor=${encodeURIComponent(wrongSort)}`,
      headers: bearer(orgToken),
    });
    expect(sortRes.statusCode).toBe(400);

    const foreignScope = encodeCursor({
      v: CURSOR_VERSION,
      k: [ids.tenantA],
      f: pageFingerprint("org_name_school_name", { scopeUserId: ids.adminA }),
      s: "org_name_school_name",
    });
    const foreign = await ctx.app.inject({
      method: "GET",
      url: `/v1/org/schools?cursor=${encodeURIComponent(foreignScope)}`,
      headers: bearer(orgToken),
    });
    expect(foreign.statusCode).toBe(400);

    const unsupportedSort = await ctx.app.inject({
      method: "GET",
      url: "/v1/org/schools?sort=name",
      headers: bearer(orgToken),
    });
    expect(unsupportedSort.statusCode).toBe(400);
  });

  it("rejects bad limits and returns empty pages / exact-multiple without phantom cursor", async () => {
    for (const limit of ["0", "201", "0x10", "1e2"]) {
      const res = await ctx.app.inject({
        method: "GET",
        url: `/v1/org/schools?limit=${limit}`,
        headers: bearer(orgToken),
      });
      expect(res.statusCode).toBe(400);
    }

    const emptyOrg = await ctx.pool.query<{ id: string }>(
      `INSERT INTO organizations (id, name, slug, kind, status)
       VALUES ($1, 'Empty', 'empty-org', 'group_owner', 'active')
       RETURNING id`,
      [randomUUID()],
    );
    const emptyAdmin = randomUUID();
    await ctx.pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status)
       SELECT $1, 'empty-org@example.com', password_hash, 'Empty Org', 'active'
       FROM users WHERE id = $2`,
      [emptyAdmin, ids.orgAdmin],
    );
    await ctx.pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role)
       VALUES ($1, $2, 'org_admin')`,
      [emptyAdmin, emptyOrg.rows[0]!.id],
    );
    const emptyLogin = await loginEmail(ctx.app, "empty-org@example.com");
    const emptyList = await ctx.app.inject({
      method: "GET",
      url: "/v1/org/schools",
      headers: bearer(emptyLogin),
    });
    expect(emptyList.statusCode).toBe(200);
    expect(emptyList.json().items).toEqual([]);
    expect(emptyList.json().page.next_cursor).toBeNull();

    const exact = await walkOrgSchools(4);
    expect(exact.length).toBe(4);
    const lastPage = await ctx.app.inject({
      method: "GET",
      url: "/v1/org/schools?limit=4",
      headers: bearer(orgToken),
    });
    expect(lastPage.json().page.next_cursor).toBeNull();
  });

  it("denies unauthorized org schools and never leaks foreign tenants", async () => {
    const noAuth = await ctx.app.inject({ method: "GET", url: "/v1/org/schools" });
    expect(noAuth.statusCode).toBe(401);

    const teacher = await ctx.app.inject({
      method: "GET",
      url: "/v1/org/schools",
      headers: bearer(adminToken),
    });
    // school admin lacks org.tenants.read
    expect(teacher.statusCode).toBe(403);

    const schools = await ctx.app.inject({
      method: "GET",
      url: "/v1/org/schools",
      headers: bearer(orgToken),
    });
    const idsReturned = (schools.json().items as Array<{ id: string }>).map((s) => s.id);
    expect(idsReturned).not.toContain(ids.tenantB);
  });

  it("pages org-delegations with microsecond ties and distinct ids", async () => {
    const rows = [
      { id: randomUUID(), us: 100, code: "tenant.read" },
      { id: randomUUID(), us: 900, code: "resource.learner.read" },
      { id: randomUUID(), us: 100, code: "resource.guardian.read" },
    ];
    // Same millisecond, different microseconds (100 vs 900); identical µs with distinct ids.
    for (const r of rows) {
      await ctx.pool.query(
        `INSERT INTO org_admin_school_delegations
           (id, tenant_id, organization_id, delegate_user_id, permission_code, granted_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6,
           timestamptz '2026-01-15 12:00:00.000000+00' + ($7 || ' microseconds')::interval)`,
        [r.id, ids.tenantA, ids.orgA, ids.orgAdmin, r.code, ids.adminA, String(r.us)],
      );
    }

    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const url =
        cursor == null
          ? `/v1/rbac/org-delegations?limit=1&status=all`
          : `/v1/rbac/org-delegations?limit=1&status=all&cursor=${encodeURIComponent(cursor)}`;
      const res = await ctx.app.inject({
        method: "GET",
        url,
        headers: bearer(adminToken, ids.tenantA),
      });
      expect(res.statusCode).toBe(200);
      const items = res.json().items as Array<{ id: string; createdAt: string }>;
      expect(items.length).toBeLessThanOrEqual(1);
      for (const item of items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
        // Microseconds preserved in the response / cursor key material.
        expect(item.createdAt).toMatch(/\.\d{6}Z$/);
      }
      cursor = res.json().page.next_cursor as string | null;
      if (!cursor) break;
    }
    for (const r of rows) expect(seen.has(r.id)).toBe(true);

    const aFirst = await ctx.app.inject({
      method: "GET",
      url: "/v1/rbac/org-delegations?limit=1&status=all",
      headers: bearer(adminToken, ids.tenantA),
    });
    const aCursor = aFirst.json().page.next_cursor as string;
    // Teacher B has no org_delegations.read
    const denied = await ctx.app.inject({
      method: "GET",
      url: `/v1/rbac/org-delegations?cursor=${encodeURIComponent(aCursor)}`,
      headers: bearer(teacherBToken, ids.tenantB),
    });
    expect(denied.statusCode).toBe(403);

    // Give adminA membership on tenant B so authz passes; fingerprint must still reject.
    await ctx.pool.query(
      `INSERT INTO school_memberships (user_id, tenant_id, role, login_id)
       VALUES ($1, $2, 'school_admin', 'AD-0002')
       ON CONFLICT (user_id, tenant_id) DO NOTHING`,
      [ids.adminA, ids.tenantB],
    );
    const cross = await ctx.app.inject({
      method: "GET",
      url: `/v1/rbac/org-delegations?status=all&cursor=${encodeURIComponent(aCursor)}`,
      headers: bearer(adminToken, ids.tenantB),
    });
    expect(cross.statusCode).toBe(400);
  });

  it("pages learner guardians with identical timestamps (kills missing tie-breaker mutation)", async () => {
    const learner = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { admission_no: "PAG-01", full_name: "Page Learner", gender: "female" },
    });
    expect(learner.statusCode).toBe(201);
    const learnerId = learner.json().learner.id as string;

    // Enough links with the SAME created_at to cross page boundaries; without the
    // id tie-breaker in the keyset predicate, later same-ts rows would be omitted.
    const names = [
      "Zed Guardian",
      "Ann Guardian",
      "Mia Guardian",
      "Bob Guardian",
      "Cy Guardian",
    ];
    for (const full_name of names) {
      const g = await ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/guardians`,
        headers: bearer(adminToken, ids.tenantA),
        payload: {
          full_name,
          learners: [{ learner_id: learnerId, relationship: "guardian" }],
        },
      });
      expect(g.statusCode).toBe(201);
    }

    const links = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM guardian_links WHERE learner_id = $1 AND tenant_id = $2 ORDER BY id`,
      [learnerId, ids.tenantA],
    );
    expect(links.rows.length).toBe(5);
    await ctx.pool.query(
      `UPDATE guardian_links
       SET created_at = timestamptz '2026-02-01 10:00:00.000000+00'
       WHERE learner_id = $1 AND tenant_id = $2`,
      [learnerId, ids.tenantA],
    );

    const expectedOrder = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM guardian_links
       WHERE learner_id = $1 AND tenant_id = $2
       ORDER BY created_at, id`,
      [learnerId, ids.tenantA],
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const url =
        cursor == null
          ? `/v1/tenants/${ids.tenantA}/learners/${learnerId}/guardians?limit=2`
          : `/v1/tenants/${ids.tenantA}/learners/${learnerId}/guardians?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const res = await ctx.app.inject({
        method: "GET",
        url,
        headers: bearer(adminToken, ids.tenantA),
      });
      expect(res.statusCode).toBe(200);
      const items = res.json().items as Array<{ linkId: string; created_at: string }>;
      for (const item of items) {
        expect(seen).not.toContain(item.linkId);
        seen.push(item.linkId);
        expect(item.created_at).toBe("2026-02-01T10:00:00.000000Z");
      }
      cursor = res.json().page.next_cursor as string | null;
      if (!cursor) break;
    }
    expect(seen).toEqual(expectedOrder.rows.map((r) => r.id));
    expect(seen.length).toBe(5);

    const first = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/learners/${learnerId}/guardians?limit=1`,
      headers: bearer(adminToken, ids.tenantA),
    });
    const aCursor = first.json().page.next_cursor as string;
    const cross = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantB}/learners/${learnerId}/guardians?cursor=${encodeURIComponent(aCursor)}`,
      headers: bearer(teacherBToken, ids.tenantB),
    });
    // Path tenant mismatch / no access — must not return tenant A guardians.
    expect([403, 404]).toContain(cross.statusCode);
    if (cross.statusCode === 200) {
      expect(cross.json().items).toEqual([]);
    }
  });

  it("pages permissions via SQL unnest with exact traversal (kills >= boundary mutation)", async () => {
    const all: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 40; i++) {
      const url =
        cursor == null
          ? "/v1/rbac/permissions?limit=2"
          : `/v1/rbac/permissions?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const res = await ctx.app.inject({
        method: "GET",
        url,
        headers: bearer(adminToken, ids.tenantA),
      });
      expect(res.statusCode).toBe(200);
      const items = res.json().items as string[];
      for (const code of items) {
        expect(all).not.toContain(code);
        all.push(code);
      }
      cursor = res.json().page.next_cursor as string | null;
      if (!cursor) break;
    }
    expect(all.length).toBeGreaterThan(2);
    // Exact SQL order and set — a `>=` predicate would duplicate the boundary code.
    const expected = await ctx.app.inject({
      method: "GET",
      url: "/v1/rbac/permissions?limit=200",
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(expected.statusCode).toBe(200);
    expect(all).toEqual(expected.json().items);
    expect(new Set(all).size).toBe(all.length);

    const badSort = await ctx.app.inject({
      method: "GET",
      url: "/v1/rbac/permissions?sort=name",
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(badSort.statusCode).toBe(400);
  });

  it("rejects malformed cursor key content with HTTP 400 on all four endpoints (never 500)", async () => {
    const expectCursor400 = async (url: string, headers: Record<string, string>) => {
      const res = await ctx.app.inject({ method: "GET", url, headers });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation_error");
      expect(res.statusCode).not.toBe(500);
    };

    const orgFp = pageFingerprint("org_name_school_name", { scopeUserId: ids.orgAdmin });
    const orgBadUuid = encodeCursor({
      v: CURSOR_VERSION,
      k: ["not-a-uuid"],
      f: orgFp,
      s: "org_name_school_name",
    });
    const orgNul = encodeCursor({
      v: CURSOR_VERSION,
      k: ["\0"],
      f: orgFp,
      s: "org_name_school_name",
    });
    await expectCursor400(
      `/v1/org/schools?cursor=${encodeURIComponent(orgBadUuid)}`,
      bearer(orgToken),
    );
    await expectCursor400(`/v1/org/schools?cursor=${encodeURIComponent(orgNul)}`, bearer(orgToken));

    const delFp = pageFingerprint("created_at_desc", { status: "all", tenantId: ids.tenantA });
    const delBadTs = encodeCursor({
      v: CURSOR_VERSION,
      k: ["garbage", ids.tenantA],
      f: delFp,
      s: "created_at_desc",
    });
    const delBadId = encodeCursor({
      v: CURSOR_VERSION,
      k: ["2026-01-15T12:00:00.000100Z", "x"],
      f: delFp,
      s: "created_at_desc",
    });
    const delInfinity = encodeCursor({
      v: CURSOR_VERSION,
      k: ["infinity", ids.tenantA],
      f: delFp,
      s: "created_at_desc",
    });
    await expectCursor400(
      `/v1/rbac/org-delegations?status=all&cursor=${encodeURIComponent(delBadTs)}`,
      bearer(adminToken, ids.tenantA),
    );
    await expectCursor400(
      `/v1/rbac/org-delegations?status=all&cursor=${encodeURIComponent(delBadId)}`,
      bearer(adminToken, ids.tenantA),
    );
    await expectCursor400(
      `/v1/rbac/org-delegations?status=all&cursor=${encodeURIComponent(delInfinity)}`,
      bearer(adminToken, ids.tenantA),
    );

    const learner = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { admission_no: "CUR-01", full_name: "Cursor Learner", gender: "male" },
    });
    expect(learner.statusCode).toBe(201);
    const learnerId = learner.json().learner.id as string;
    const gFp = pageFingerprint("link_created_at", {
      tenantId: ids.tenantA,
      learnerId,
    });
    const gBadTs = encodeCursor({
      v: CURSOR_VERSION,
      k: ["2026-13-45T00:00:00.000000Z", randomUUID()],
      f: gFp,
      s: "link_created_at",
    });
    await expectCursor400(
      `/v1/tenants/${ids.tenantA}/learners/${learnerId}/guardians?cursor=${encodeURIComponent(gBadTs)}`,
      bearer(adminToken, ids.tenantA),
    );

    const permFp = pageFingerprint("code", { tenantId: ids.tenantA, userId: ids.adminA });
    const permNul = encodeCursor({
      v: CURSOR_VERSION,
      k: ["tenant.\0read"],
      f: permFp,
      s: "code",
    });
    const permBadVer = Buffer.from(
      JSON.stringify({ v: 99, k: ["tenant.read"], f: permFp, s: "code" }),
      "utf8",
    ).toString("base64url");
    await expectCursor400(
      `/v1/rbac/permissions?cursor=${encodeURIComponent(permNul)}`,
      bearer(adminToken, ids.tenantA),
    );
    await expectCursor400(
      `/v1/rbac/permissions?cursor=${encodeURIComponent(permBadVer)}`,
      bearer(adminToken, ids.tenantA),
    );

    // Valid cursor regression on org schools.
    const first = await ctx.app.inject({
      method: "GET",
      url: "/v1/org/schools?limit=1",
      headers: bearer(orgToken),
    });
    expect(first.statusCode).toBe(200);
    const next = first.json().page.next_cursor as string;
    expect(next).toBeTruthy();
    const second = await ctx.app.inject({
      method: "GET",
      url: `/v1/org/schools?limit=1&cursor=${encodeURIComponent(next)}`,
      headers: bearer(orgToken),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().items[0].id).not.toBe(first.json().items[0].id);
  });

  it("GET /v1/auth/me returns all memberships without silent truncation", async () => {
    const emptyUser = randomUUID();
    await ctx.pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status)
       SELECT $1, 'empty-m@example.com', password_hash, 'Empty Memberships', 'active'
       FROM users WHERE id = $2`,
      [emptyUser, ids.adminA],
    );
    const emptyToken = await loginEmail(ctx.app, "empty-m@example.com");
    const emptyMe = await ctx.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: bearer(emptyToken),
    });
    expect(emptyMe.statusCode).toBe(200);
    expect(emptyMe.json().memberships).toEqual([]);

    const exactUser = randomUUID();
    await ctx.pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status)
       SELECT $1, 'exact200@example.com', password_hash, 'Exact 200', 'active'
       FROM users WHERE id = $2`,
      [exactUser, ids.adminA],
    );
    for (let i = 0; i < 200; i++) {
      const tid = randomUUID();
      await ctx.pool.query(
        `INSERT INTO tenants (id, organization_id, name, slug, status)
         VALUES ($1, $2, $3, $4, 'active')`,
        [tid, ids.orgA, `ESchool ${i}`, `e-school-${i}`],
      );
      await ctx.pool.query(
        `INSERT INTO school_memberships (user_id, tenant_id, role, login_id)
         VALUES ($1, $2, 'staff', $3)`,
        [exactUser, tid, `ES-${String(i).padStart(4, "0")}`],
      );
    }
    const exactToken = await loginEmail(ctx.app, "exact200@example.com");
    const exactMe = await ctx.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: bearer(exactToken),
    });
    expect(exactMe.statusCode).toBe(200);
    expect(exactMe.json().memberships.length).toBe(200);

    const userId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status)
       SELECT $1, 'many-m@example.com', password_hash, 'Many Memberships', 'active'
       FROM users WHERE id = $2`,
      [userId, ids.adminA],
    );
    for (let i = 0; i < 201; i++) {
      const tid = randomUUID();
      const oid = i % 2 === 0 ? ids.orgA : ids.orgB;
      await ctx.pool.query(
        `INSERT INTO tenants (id, organization_id, name, slug, status)
         VALUES ($1, $2, $3, $4, 'active')`,
        [tid, oid, `MSchool ${i}`, `m-school-${i}`],
      );
      await ctx.pool.query(
        `INSERT INTO school_memberships (user_id, tenant_id, role, login_id)
         VALUES ($1, $2, 'staff', $3)`,
        [userId, tid, `MS-${String(i).padStart(4, "0")}`],
      );
    }
    const token = await loginEmail(ctx.app, "many-m@example.com");
    const me = await ctx.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: bearer(token),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().memberships.length).toBe(201);
    expect(me.json().membershipsComplete).toBe(true);

    const noAuth = await ctx.app.inject({ method: "GET", url: "/v1/auth/me" });
    expect(noAuth.statusCode).toBe(401);
  });
});
