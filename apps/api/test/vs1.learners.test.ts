import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createTestApp, type FixtureIds } from "./support.js";
import { assertErrorShape } from "../src/openapi/contractAssert.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

async function loginEmail(
  app: Ctx["app"],
  email: string,
  password = "correct-horse-battery",
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login/email",
    payload: { email, password },
  });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

async function loginLoginId(
  app: Ctx["app"],
  tenantId: string,
  loginId: string,
  password = "correct-horse-battery",
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login/login-id",
    payload: { tenantId, loginId, password },
  });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

function bearer(token: string, tenantId?: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (tenantId) headers["x-tenant-id"] = tenantId;
  return headers;
}

describe("VS-1 learner directory create/read", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let adminToken: string;
  let teacherToken: string;
  let parentToken: string;
  let teacherBToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    adminToken = await loginEmail(ctx.app, "admin-a@example.com");
    teacherToken = await loginLoginId(ctx.app, ids.tenantA, "TC-0001");
    parentToken = await loginLoginId(ctx.app, ids.tenantA, "PT-0001");
    teacherBToken = await loginLoginId(ctx.app, ids.tenantB, "TC-0001");
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("school_admin can create and retrieve a learner", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(adminToken, ids.tenantA),
      payload: {
        admission_no: "4501",
        full_name: "Amani Otieno",
        gender: "female",
        boarding: false,
        date_of_birth: "2014-03-12",
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.learner.admission_no).toBe("4501");
    expect(body.learner.full_name).toBe("Amani Otieno");
    expect(body.learner.gender).toBe("female");
    expect(body.learner.tenantId).toBe(ids.tenantA);
    expect(body.learner.active).toBe(true);
    expect(body.learner.archived_at).toBeNull();
    expect(body.learner.date_of_birth).toBe("2014-03-12");

    const fetched = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/learners/${body.learner.id}`,
      headers: bearer(adminToken, ids.tenantA),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().learner.id).toBe(body.learner.id);
    expect(fetched.json().learner.full_name).toBe("Amani Otieno");
  });

  it("staff/teacher with area.people can create and read learners", async () => {
    const grant = await ctx.app.inject({
      method: "PUT",
      url: "/v1/rbac/staff-areas",
      headers: bearer(adminToken, ids.tenantA),
      payload: { userId: ids.teacherA, areas: ["people"] },
    });
    expect(grant.statusCode).toBe(200);

    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(teacherToken, ids.tenantA),
      payload: {
        admission_no: "4502",
        full_name: "Brian Wanjiru",
        gender: "male",
      },
    });
    expect(created.statusCode).toBe(201);

    const read = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/learners/${created.json().learner.id}`,
      headers: bearer(teacherToken, ids.tenantA),
    });
    expect(read.statusCode).toBe(200);
  });

  it("unauthorized roles cannot create or read learners", async () => {
    const create = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(parentToken, ids.tenantA),
      payload: {
        admission_no: "9999",
        full_name: "Should Fail",
        gender: "male",
      },
    });
    expect(create.statusCode).toBe(403);
    expect(assertErrorShape(create.json())).toEqual([]);
    expect(create.json().error.code).toBe("forbidden");
    expect(String(create.json().error.message)).not.toMatch(/sql|stack|postgres/i);

    // Teacher without people area (revoke if previously granted).
    await ctx.app.inject({
      method: "PUT",
      url: "/v1/rbac/staff-areas",
      headers: bearer(adminToken, ids.tenantA),
      payload: { userId: ids.teacherA, areas: [] },
    });
    const createTeacher = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(teacherToken, ids.tenantA),
      payload: {
        admission_no: "9998",
        full_name: "Should Fail",
        gender: "female",
      },
    });
    expect(createTeacher.statusCode).toBe(403);

    // Seed a learner as admin, then parent cannot read.
    const seeded = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { admission_no: "4503", full_name: "Hidden Learner", gender: "female" },
    });
    expect(seeded.statusCode).toBe(201);
    const read = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/learners/${seeded.json().learner.id}`,
      headers: bearer(parentToken, ids.tenantA),
    });
    expect(read.statusCode).toBe(403);
  });

  it("rejects missing auth and missing tenant context", async () => {
    const noAuth = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      payload: { admission_no: "1", full_name: "X", gender: "male" },
    });
    expect(noAuth.statusCode).toBe(401);
    expect(assertErrorShape(noAuth.json())).toEqual([]);

    // Super admin without selecting a school has no tenant context.
    const superToken = await loginEmail(ctx.app, "super@example.com");
    const noTenant = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: { authorization: `Bearer ${superToken}` },
      payload: { admission_no: "1", full_name: "X", gender: "male" },
    });
    expect(noTenant.statusCode).toBe(403);
    expect(noTenant.json().error.code).toBe("forbidden");
  });

  it("refuses cross-tenant read and write", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { admission_no: "4510", full_name: "Tenant A Only", gender: "male" },
    });
    expect(created.statusCode).toBe(201);
    const learnerId = created.json().learner.id as string;

    // Admin of A cannot create into B by swapping path tenant.
    const crossWrite = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantB}/learners`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { admission_no: "4511", full_name: "Cross Write", gender: "female" },
    });
    expect(crossWrite.statusCode).toBe(403);
    expect(crossWrite.json().error.message).toMatch(/cross-tenant|access/i);

    // Teacher in B cannot read A's learner even with A's id in the path.
    const crossRead = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/learners/${learnerId}`,
      headers: bearer(teacherBToken, ids.tenantB),
    });
    expect(crossRead.statusCode).toBe(403);

    // Path tenant B + X-Tenant-Id B still cannot fetch a learner owned by A
    // when somehow authenticated as B admin — create school_admin for B.
    await ctx.pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status)
       SELECT gen_random_uuid(), 'admin-b@example.com', password_hash, 'Admin B', 'active'
       FROM users WHERE id = $1`,
      [ids.adminA],
    );
    const adminB = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'admin-b@example.com'`,
    );
    const adminBId = adminB.rows[0]!.id;
    await ctx.pool.query(
      `INSERT INTO school_memberships (user_id, tenant_id, role, login_id)
       VALUES ($1, $2, 'school_admin', 'AD-0001')`,
      [adminBId, ids.tenantB],
    );
    const adminBToken = await loginEmail(ctx.app, "admin-b@example.com");

    // Using B auth with path tenant A is denied (assertSameTenant / membership).
    const pathMismatch = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/learners/${learnerId}`,
      headers: bearer(adminBToken, ids.tenantB),
    });
    expect(pathMismatch.statusCode).toBe(403);

    // Authenticated to B, path B, but learner id belongs to A → not found.
    const wrongTenantRow = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantB}/learners/${learnerId}`,
      headers: bearer(adminBToken, ids.tenantB),
    });
    expect(wrongTenantRow.statusCode).toBe(404);
    expect(assertErrorShape(wrongTenantRow.json())).toEqual([]);
    expect(String(wrongTenantRow.json().error.message)).not.toMatch(/sql|stack|relation/i);
  });

  it("validates input and returns safe human-readable errors", async () => {
    const missing = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { admission_no: "", full_name: "X", gender: "other" },
    });
    expect(missing.statusCode).toBe(400);
    expect(assertErrorShape(missing.json())).toEqual([]);
    expect(missing.json().error.code).toBe("validation_error");
    expect(JSON.stringify(missing.json())).not.toMatch(/INSERT|stack|pg_/i);

    const badDob = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(adminToken, ids.tenantA),
      payload: {
        admission_no: "4520",
        full_name: "Bad Dob",
        gender: "male",
        date_of_birth: "not-a-date",
      },
    });
    expect(badDob.statusCode).toBe(400);

    const dup = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { admission_no: "4501", full_name: "Dup", gender: "male" },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("conflict");
    expect(String(dup.json().error.message)).toMatch(/4501/i);
    expect(String(dup.json().error.message)).not.toMatch(/duplicate key|23505/i);
  });

  it("writes a directory.learner.created audit event", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { admission_no: "4530", full_name: "Audit Learner", gender: "female" },
    });
    expect(created.statusCode).toBe(201);
    const learnerId = created.json().learner.id as string;

    const audit = await ctx.pool.query<{ event_type: string; detail: { learnerId?: string } }>(
      `SELECT event_type, detail
       FROM security_audit_events
       WHERE event_type = 'directory.learner.created'
         AND tenant_id = $1
         AND detail->>'learnerId' = $2
       ORDER BY occurred_at DESC
       LIMIT 1`,
      [ids.tenantA, learnerId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]!.event_type).toBe("directory.learner.created");
  });

  it("enforces figbloom_app least privilege and RLS on learners", async () => {
    await ctx.pool.query(
      `INSERT INTO learners (tenant_id, admission_no, full_name, gender, created_by)
       VALUES ($1, '4600', 'Visible A', 'male', $2),
              ($3, '4601', 'Hidden B', 'female', $2)`,
      [ids.tenantA, ids.adminA, ids.tenantB],
    );

    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE figbloom_app");
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.tenantA]);
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.adminA]);
      await client.query(`SELECT set_config('app.authz_mode', '', true)`);

      const visible = await client.query(
        `SELECT admission_no FROM learners ORDER BY admission_no`,
      );
      const admissions = visible.rows.map((r) => r.admission_no as string);
      expect(admissions).toContain("4600");
      expect(admissions).not.toContain("4601");

      await client.query("SAVEPOINT sp_del");
      await expect(client.query(`DELETE FROM learners WHERE admission_no = '4600'`)).rejects.toThrow(
        /permission denied/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT sp_del");

      await client.query("SAVEPOINT sp_cross");
      await expect(
        client.query(
          `INSERT INTO learners (tenant_id, admission_no, full_name, gender)
           VALUES ($1, '4602', 'Cross Insert', 'male')`,
          [ids.tenantB],
        ),
      ).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT sp_cross");
    } finally {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      client.release();
    }
  });

  it("OpenAPI documents VS-1 learner operations with authZ metadata", () => {
    const spec = parseYaml(readFileSync(join(process.cwd(), "openapi/openapi.yaml"), "utf8")) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const create = spec.paths["/v1/tenants/{tenantId}/learners"]?.post;
    const get = spec.paths["/v1/tenants/{tenantId}/learners/{learnerId}"]?.get;
    expect(create).toBeTruthy();
    expect(get).toBeTruthy();
    expect(create!["x-figbloom-authz"]).toBe("permission");
    expect(create!["x-figbloom-permissions"]).toEqual(["resource.learner.write"]);
    expect(get!["x-figbloom-authz"]).toBe("permission");
    expect(get!["x-figbloom-permissions"]).toEqual(["resource.learner.read"]);

    const routes = (ctx.app as { routeTable: Array<{ method: string; url: string }> }).routeTable;
    expect(routes.some((r) => r.method === "POST" && r.url === "/v1/tenants/:tenantId/learners")).toBe(
      true,
    );
    expect(
      routes.some((r) => r.method === "GET" && r.url === "/v1/tenants/:tenantId/learners/:learnerId"),
    ).toBe(true);
  });

  it("rejects client-supplied permissions evidence on create", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(parentToken, ids.tenantA),
      payload: {
        admission_no: "4700",
        full_name: "Forged",
        gender: "male",
        permissions: ["resource.learner.write", "area.people"],
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/permissions/i);
  });

  it("org_admin with delegated write can create; write-only cannot read", async () => {
    const orgToken = await loginEmail(ctx.app, "orgadmin@example.com");

    // Without delegation: forbidden.
    const denied = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(orgToken, ids.tenantA),
      payload: { admission_no: "4800", full_name: "Org Denied", gender: "male" },
    });
    expect(denied.statusCode).toBe(403);

    // Owner decision: resource.learner.write is not delegable to an org admin.
    const grantWrite = await ctx.app.inject({
      method: "POST",
      url: "/v1/rbac/org-delegations",
      headers: bearer(adminToken, ids.tenantA),
      payload: {
        delegateUserId: ids.orgAdmin,
        permissionCodes: ["resource.learner.write"],
      },
    });
    expect(grantWrite.statusCode).toBe(400);
    const stillDenied = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(orgToken, ids.tenantA),
      payload: { admission_no: "4801", full_name: "Org Created", gender: "female" },
    });
    expect(stillDenied.statusCode).toBe(403);
    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { admission_no: "4801", full_name: "Org Created", gender: "female" },
    });
    expect(created.statusCode).toBe(201);

    const readDenied = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/learners/${created.json().learner.id}`,
      headers: bearer(orgToken, ids.tenantA),
    });
    expect(readDenied.statusCode).toBe(403);

    const grantRead = await ctx.app.inject({
      method: "POST",
      url: "/v1/rbac/org-delegations",
      headers: bearer(adminToken, ids.tenantA),
      payload: {
        delegateUserId: ids.orgAdmin,
        permissionCodes: ["resource.learner.read"],
      },
    });
    expect(grantRead.statusCode).toBe(200);

    const readOk = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/learners/${created.json().learner.id}`,
      headers: bearer(orgToken, ids.tenantA),
    });
    expect(readOk.statusCode).toBe(200);
    expect(readOk.json().learner.admission_no).toBe("4801");
  });
});
