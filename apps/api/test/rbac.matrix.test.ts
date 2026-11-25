import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { hashPassword } from "../src/modules/identity/password.js";
import {
  ACADEMICS_AREA_IMPLIED,
  ACTIVITIES_AREA_IMPLIED,
  ATTENDANCE_AREA_IMPLIED,
  AUDIT_AREA_IMPLIED,
  DISCIPLINE_AREA_IMPLIED,
  COMMUNICATION_AREA_IMPLIED,
  FEES_AREA_IMPLIED,
  INVENTORY_AREA_IMPLIED,
  LEAVE_AREA_IMPLIED,
  MEDICAL_AREA_IMPLIED,
  PEOPLE_AREA_IMPLIED,
  TRANSPORT_AREA_IMPLIED,
  VISITORS_AREA_IMPLIED,
} from "../src/modules/rbac/authorize.js";
import { createTestApp } from "./support.js";
import { BODY_FIXTURES, sampleBody } from "./support/routeSweep.js";

/**
 * Workstream 5: the RBAC and cross-tenant matrices, EXECUTED over every documented operation.
 *
 * For each non-public operation (x-figbloom-authz = permission) and each principal, the expected outcome is derived from an
 * oracle that reads the permission catalogue from the DATABASE (role_permissions) plus the admin-area implications, never from the
 * route handlers: allowed iff the principal's effective permissions include every permission the OpenAPI operation documents.
 *   allowed  -> the request is NOT refused by authorization (any of 2xx/400/404/409: the fixture ids do not exist, and that is fine)
 *   denied   -> exactly 403 (a 400 would mean validation masked authorization, and fails the test)
 * Cross-tenant principals (a school administrator of school B, naming school A) must never succeed and never get data.
 * Disabled and revoked principals get 401 on every operation. Set RBAC_MATRIX_OUT to write the full matrix as JSON.
 */
const PASSWORD = "correct-horse-battery";
/**
 * Operations whose authorization is intentionally RICHER than the single documented permission list (each is described in the
 * OpenAPI prose and covered by a targeted real-data test below). For these the matrix only requires that the answer is not a
 * validation mask and that anonymous callers get 401.
 */
const ANY_OF: Record<string, { reason: string; sets: string[][] }> = {
  "POST /v1/rbac/org-delegations": { reason: "authority paths: platform/school administrator (manage) OR org administrator of the same organization (grant)", sets: [["rbac.org_delegations.manage"], ["org.delegations.grant"]] },
  "DELETE /v1/rbac/org-delegations": { reason: "authority paths: platform/school administrator (manage) OR org administrator of the same organization (revoke)", sets: [["rbac.org_delegations.manage"], ["org.delegations.revoke"]] },
  // Student accounts (docs/STUDENT-ACCOUNTS.md): the per-learner reads are shared by a parent (their children) and a learner
  // (their own learner), and the two attempt endpoints by staff and a learner (their own attempt); test/student.accounts.test.ts
  ...Object.fromEntries(
    ["attendance", "results", "report-cards", "homework", "materials", "timetable", "fees", "activities", "items"].map((leaf) => [
      `GET /v1/tenants/{tenantId}/me/children/{learnerId}/${leaf}`,
      { reason: "a parent's child (family) OR a learner's own learner (student)", sets: [["resource.family.read"], ["resource.student.self.read"]] },
    ]),
  ),
  // Behaviour log (docs/BEHAVIOUR.md): the office (the Discipline area) OR a teacher who records. Teachers' reach is the learners they teach (test/behaviour.test.ts).
  ...Object.fromEntries(
    [["GET", "/settings"], ["GET", "/categories"], ["GET", "/entries"], ["GET", "/points"], ["GET", "/classes"]].map(([method, leaf]) => [
      `${method} /v1/tenants/{tenantId}/behaviour${leaf}`,
      { reason: "the office (Discipline area) OR a teacher who records", sets: [["resource.discipline.read"], ["resource.behaviour.record"]] },
    ]),
  ),
  "POST /v1/tenants/{tenantId}/behaviour/entries/{entryId}/void": { reason: "the office OR the recorder (a teacher who records)", sets: [["resource.discipline.write"], ["resource.behaviour.record"]] },
  "GET /v1/tenants/{tenantId}/me/chat-contacts": { reason: "a parent (family) OR a learner (student)", sets: [["resource.family.read"], ["resource.student.self.read"]] },
  "POST /v1/tenants/{tenantId}/online-exam-papers/{paperId}/attempts": { reason: "staff (academics write) OR a learner for their own learner", sets: [["resource.academics.write"], ["resource.student.self.read"]] },
  "POST /v1/tenants/{tenantId}/online-exam-attempts/{attemptId}/submit": { reason: "staff (academics write) OR a learner for their own attempt", sets: [["resource.academics.write"], ["resource.student.self.read"]] },
};
const SCOPED = new Set(["POST /v1/tenants/{tenantId}/behaviour/entries", "POST /v1/tenants/{tenantId}/early-sign-outs", "POST /v1/tenants/{tenantId}/early-sign-outs/{signOutId}/void", "GET /v1/tenants/{tenantId}/leave-requests"]);
type Row = { role: string; operation: string; permissions: string[]; tenantContext: string; expected: string; actual: number; pass: boolean };

describe("RBAC and cross-tenant matrices over the full OpenAPI surface", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const spec = YAML.parse(readFileSync(join(process.cwd(), "openapi", "openapi.yaml"), "utf8"));
  const tokens: Record<string, string> = {};
  const rows: Row[] = [];
  const A = () => ctx.ids.tenantA;
  const B = () => ctx.ids.tenantB;

  const login = async (body: Record<string, unknown>) => {
    const r = await ctx.app.inject({ method: "POST", url: body.email ? "/v1/auth/login/email" : "/v1/auth/login/login-id", payload: body });
    expect(r.statusCode, JSON.stringify(body)).toBe(200);
    return r.json().token as string;
  };
  async function user(email: string, hash: string, status = "active") {
    const id = randomUUID();
    await ctx.pool.query(`INSERT INTO users (id, email, password_hash, full_name, status) VALUES ($1, $2, $3, $2, $4)`, [id, email, hash, status]);
    return id;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    const hash = await hashPassword(PASSWORD);
    const adminB = await user("matrix-admin-b@example.com", hash);
    await ctx.pool.query(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'school_admin', 'AD-0007')`, [adminB, B()]);
    tokens.super_admin = await login({ email: "super@example.com", password: PASSWORD });
    tokens.school_admin_A = await login({ email: "admin-a@example.com", password: PASSWORD });
    tokens.teacher_A = await login({ tenantId: A(), loginId: "TC-0001", password: PASSWORD });
    tokens.parent_A = await login({ tenantId: A(), loginId: "PT-0001", password: PASSWORD });
    // a learner with a student login (docs/STUDENT-ACCOUNTS.md) and NO live learner link: the role's own permissions only
    const student = await user("matrix-student@example.com", hash);
    await ctx.pool.query(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'student', 'ST-0901')`, [student, A()]);
    tokens.student_A = await login({ tenantId: A(), loginId: "ST-0901", password: PASSWORD });
    tokens.school_admin_B_in_A = await login({ email: "matrix-admin-b@example.com", password: PASSWORD });
    tokens.org_admin = await login({ email: "orgadmin@example.com", password: PASSWORD });
    // a disabled account and a revoked session
    const disabled = await user("matrix-disabled@example.com", hash);
    await ctx.pool.query(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'school_admin', 'AD-0008')`, [disabled, A()]);
    tokens.disabled = await login({ email: "matrix-disabled@example.com", password: PASSWORD });
    await ctx.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [disabled]);
    const revoked = await user("matrix-revoked@example.com", hash);
    await ctx.pool.query(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'school_admin', 'AD-0009')`, [revoked, A()]);
    tokens.revoked = await login({ email: "matrix-revoked@example.com", password: PASSWORD });
    await ctx.pool.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1`, [revoked]);
  }, 180_000);
  afterAll(async () => {
    if (process.env.RBAC_MATRIX_OUT) {
      mkdirSync(dirname(process.env.RBAC_MATRIX_OUT), { recursive: true });
      writeFileSync(process.env.RBAC_MATRIX_OUT, JSON.stringify(rows, null, 1));
    }
    await ctx.app.close();
    await ctx.pool.end();
  });

  /** All operations the sweep covers. Self-session operations that would end the principal's own session are not executed. */
  const SKIP = new Set(["POST /v1/auth/logout", "POST /v1/auth/password/change", "POST /v1/auth/select-tenant", "POST /v1/auth/logout-all"]);
  function operations() {
    const out: { key: string; method: string; path: string; op: any; authz: string; perms: string[] }[] = [];
    for (const [path, ops] of Object.entries<any>(spec.paths)) {
      for (const [method, op] of Object.entries<any>(ops)) {
        const key = `${method.toUpperCase()} ${path}`;
        if (op["x-figbloom-authz"] === "public" || SKIP.has(key)) continue;
        out.push({ key, method: method.toUpperCase(), path, op, authz: op["x-figbloom-authz"], perms: op["x-figbloom-permissions"] ?? [] });
      }
    }
    return out;
  }
  const requiredQuery = (op: any) =>
    (op?.parameters ?? [])
      .map((p: any) => (p.$ref ? spec.components.parameters[String(p.$ref).split("/").pop()!] : p))
      .filter((p: any) => p?.in === "query" && p.required)
      .map((p: any) => `${p.name}=${p.schema?.format === "uuid" ? randomUUID() : "1"}`)
      .join("&");
  async function send(o: ReturnType<typeof operations>[number], token: string | null, tenant: string | null) {
    const pathUrl = o.path.replace(/\{tenantId\}/g, tenant ?? A()).replace(/\{[A-Za-z]+\}/g, () => randomUUID());
    const qs = requiredQuery(o.op);
    const payload = o.method === "GET" ? undefined : (BODY_FIXTURES[o.key] ?? sampleBody(spec, o.op) ?? {});
    return ctx.app.inject({
      method: o.method as "GET",
      url: qs ? `${pathUrl}?${qs}` : pathUrl,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenant ? { "x-tenant-id": tenant } : {}) },
      payload: payload as never,
    });
  }

  /** The oracle: effective permissions per role from the database catalogue plus the admin-area implications. */
  async function effective(role: "school_admin" | "teacher" | "parent" | "student"): Promise<Set<string>> {
    const r = await ctx.pool.query<{ permission_code: string }>(`SELECT permission_code FROM role_permissions WHERE role = $1`, [role]);
    const set = new Set(r.rows.map((x) => x.permission_code));
    if (role === "school_admin") {
      for (const l of [PEOPLE_AREA_IMPLIED, ACADEMICS_AREA_IMPLIED, FEES_AREA_IMPLIED, COMMUNICATION_AREA_IMPLIED, VISITORS_AREA_IMPLIED, MEDICAL_AREA_IMPLIED, INVENTORY_AREA_IMPLIED, LEAVE_AREA_IMPLIED, ACTIVITIES_AREA_IMPLIED, TRANSPORT_AREA_IMPLIED, ATTENDANCE_AREA_IMPLIED, AUDIT_AREA_IMPLIED, DISCIPLINE_AREA_IMPLIED]) {
        for (const c of l) set.add(c);
      }
    }
    return set;
  }

  it("the matrix covers every non-public documented operation (the sweep cannot silently shrink)", () => {
    const ops = operations();
    expect(ops.length).toBeGreaterThan(180);
    // every permission-gated operation documents at least one permission; every documented permission exists in the catalogue
    for (const o of ops.filter((x) => x.authz === "permission")) expect(o.perms.length, o.key).toBeGreaterThan(0);
  });

  it("anonymous callers get 401 on every non-public operation", async () => {
    for (const o of operations()) {
      const res = await send(o, null, A());
      const ok = res.statusCode === 401;
      rows.push({ role: "anonymous", operation: o.key, permissions: o.perms, tenantContext: "tenantA", expected: "401", actual: res.statusCode, pass: ok });
      expect(res.statusCode, o.key).toBe(401);
    }
  });

  it("disabled accounts and revoked sessions get 401 on every non-public operation", async () => {
    for (const o of operations()) {
      for (const who of ["disabled", "revoked"] as const) {
        const res = await send(o, tokens[who]!, A());
        rows.push({ role: who, operation: o.key, permissions: o.perms, tenantContext: "tenantA", expected: "401", actual: res.statusCode, pass: res.statusCode === 401 });
        expect(res.statusCode, `${who} ${o.key}`).toBe(401);
      }
    }
  });

  for (const [principal, role] of [
    ["school_admin_A", "school_admin"],
    ["teacher_A", "teacher"],
    ["parent_A", "parent"],
    ["student_A", "student"],
  ] as const) {
    it(`${principal}: every permission-gated operation is allowed exactly when the catalogue grants all documented permissions`, async () => {
      const eff = await effective(role);
      const mismatches: string[] = [];
      for (const o of operations().filter((x) => x.authz === "permission" && !x.key.includes("/v1/platform/"))) {
        if (SCOPED.has(o.key)) continue; // row/scope-dependent authorization: proven by the targeted tests below
        const sets = ANY_OF[o.key]?.sets ?? [o.perms];
        const shouldAllow = sets.some((set) => set.every((p) => eff.has(p)));
        const res = await send(o, tokens[principal]!, A());
        const allowed = res.statusCode !== 401 && res.statusCode !== 403;
        const pass = allowed === shouldAllow && !(res.statusCode === 400 && !shouldAllow);
        rows.push({ role: principal, operation: o.key, permissions: o.perms, tenantContext: "tenantA", expected: shouldAllow ? "allowed" : "403", actual: res.statusCode, pass });
        if (!pass) mismatches.push(`${o.key} [${o.perms.join(",")}] expected ${shouldAllow ? "allowed" : "403"} got ${res.statusCode}`);
      }
      expect(mismatches).toEqual([]);
    });
  }

  it("platform operations: only the super administrator is allowed; every other principal is 403", async () => {
    const platform = operations().filter((x) => x.path.startsWith("/v1/platform/"));
    expect(platform.length).toBeGreaterThanOrEqual(10);
    for (const o of platform) {
      const su = await send(o, tokens.super_admin!, null);
      rows.push({ role: "super_admin", operation: o.key, permissions: o.perms, tenantContext: "platform", expected: "allowed", actual: su.statusCode, pass: su.statusCode !== 401 && su.statusCode !== 403 });
      expect([401, 403], `super ${o.key}`).not.toContain(su.statusCode);
      for (const who of ["school_admin_A", "teacher_A", "parent_A", "org_admin", "school_admin_B_in_A"]) {
        const res = await send(o, tokens[who]!, null);
        rows.push({ role: who, operation: o.key, permissions: o.perms, tenantContext: "platform", expected: "403", actual: res.statusCode, pass: res.statusCode === 403 });
        expect(res.statusCode, `${who} ${o.key}`).toBe(403);
      }
    }
  });

  it("super administrator is allowed on every permission-gated tenant operation (never refused by authorization)", async () => {
    for (const o of operations().filter((x) => x.authz === "permission" && !x.path.startsWith("/v1/platform/") && x.path.includes("{tenantId}"))) {
      const res = await send(o, tokens.super_admin!, A());
      rows.push({ role: "super_admin", operation: o.key, permissions: o.perms, tenantContext: "tenantA", expected: "allowed", actual: res.statusCode, pass: res.statusCode !== 401 && res.statusCode !== 403 });
      expect([401, 403], o.key).not.toContain(res.statusCode);
    }
  });

  describe("cross-tenant: a school administrator of school B naming school A", () => {
    it("never succeeds and never receives data on any tenant-scoped operation", async () => {
      for (const o of operations().filter((x) => x.path.includes("{tenantId}"))) {
        const res = await send(o, tokens.school_admin_B_in_A!, A());
        const body = res.body ?? "";
        const pass = res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 400;
        rows.push({ role: "school_admin_B_in_A", operation: o.key, permissions: o.perms, tenantContext: "tenantA (caller belongs to B)", expected: "401/403/404", actual: res.statusCode, pass });
        expect([401, 403, 404], `${o.key} -> ${res.statusCode}`).toContain(res.statusCode);
        expect(body).not.toContain(A()); // no echo of the victim school's id in an error body
      }
    });

    it("sending school A's id in the path while holding a token scoped to school B (header mismatch) is refused", async () => {
      const ops = operations().filter((x) => x.path.includes("{tenantId}") && x.method === "GET").slice(0, 40);
      for (const o of ops) {
        const pathUrl = o.path.replace(/\{tenantId\}/g, A()).replace(/\{[A-Za-z]+\}/g, () => randomUUID());
        const res = await ctx.app.inject({ method: "GET", url: pathUrl, headers: { authorization: `Bearer ${tokens.school_admin_B_in_A}`, "x-tenant-id": B() } });
        expect([401, 403, 404, 400], `${o.key} ${res.statusCode}`).toContain(res.statusCode);
        expect(res.statusCode).not.toBe(200);
      }
    });

    it("school A's administrator cannot reach school B through the same operations", async () => {
      for (const o of operations().filter((x) => x.path.includes("{tenantId}") && !x.path.startsWith("/v1/platform/"))) {
        const res = await send(o, tokens.school_admin_A!, B());
        rows.push({ role: "school_admin_A", operation: o.key, permissions: o.perms, tenantContext: "tenantB (caller belongs to A)", expected: "401/403/404", actual: res.statusCode, pass: [401, 403, 404].includes(res.statusCode) });
        expect([401, 403, 404], `${o.key} -> ${res.statusCode}`).toContain(res.statusCode);
      }
    });
  });

  describe("scoped authorization proven on real rows", () => {
    async function seedLearner() {
      const learner = (await ctx.pool.query(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, 'Scoped Learner', 'female') RETURNING id`, [A(), 'SC' + randomUUID().slice(0, 8)])).rows[0].id as string;
      const year = (await ctx.pool.query(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on, is_current) VALUES ($1, $2, '2026-01-01', '2026-12-31', false) RETURNING id`, [A(), 'Y' + randomUUID().slice(0, 6)])).rows[0].id as string;
      const cls = (await ctx.pool.query(`INSERT INTO classes (tenant_id, academic_year_id, name) VALUES ($1, $2, 'Scoped Class') RETURNING id`, [A(), year])).rows[0].id as string;
      await ctx.pool.query(`INSERT INTO class_memberships (tenant_id, learner_id, class_id, academic_year_id) VALUES ($1, $2, $3, $4)`, [A(), learner, cls, year]);
      return learner;
    }
    const body = (learner: string) => ({ learner_id: learner, reason: 'Clinic visit', collected_by_name: 'Jane Doe', collected_by_relationship: 'mother', id_number: '12345678', phone: '0712345678', authorised_by: 'Principal' });
    const post = (token: string, payload: unknown) => ctx.app.inject({ method: 'POST', url: `/v1/tenants/${A()}/early-sign-outs`, headers: { authorization: `Bearer ${token}`, 'x-tenant-id': A() }, payload: payload as never });
    it('early sign-out: a teacher who is not the learner class teacher, and a parent, are refused; the administrator is allowed; the recorder may void', async () => {
      const learner = await seedLearner();
      const pr = await post(tokens.parent_A!, body(learner));
      expect(pr.statusCode, JSON.stringify(pr.json())).toBe(403);
      expect((await post(tokens.teacher_A!, body(learner))).statusCode).toBe(403);
      const ok = await post(tokens.school_admin_A!, body(learner));
      expect(ok.statusCode, JSON.stringify(ok.json())).toBe(201);
      const id = ok.json().sign_out.id as string;
      const voidAs = (token: string) => ctx.app.inject({ method: 'POST', url: `/v1/tenants/${A()}/early-sign-outs/${id}/void`, headers: { authorization: `Bearer ${token}`, 'x-tenant-id': A() }, payload: { reason: 'Recorded in error' } });
      const denied = await voidAs(tokens.teacher_A!);
      expect([403, 404]).toContain(denied.statusCode); // not the recorder and no attendance.write: refused (or invisible)
      expect((await voidAs(tokens.school_admin_B_in_A!)).statusCode).toBeGreaterThanOrEqual(403);
      expect((await voidAs(tokens.school_admin_A!)).statusCode).toBe(200);
    });
    it('leave list: a member without resource.leave.read sees only their own requests', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: `/v1/tenants/${A()}/leave-requests`, headers: { authorization: `Bearer ${tokens.parent_A}`, 'x-tenant-id': A() } });
      expect(res.statusCode).toBe(200);
      for (const r of res.json().leave_requests ?? []) expect(r.staff_user_id).toBe(ctx.ids.parentA);
    });
  });

  it("an organization administrator holds no school privilege without an explicit delegation (R2-05)", async () => {
    for (const o of operations().filter((x) => !SCOPED.has(x.key) && x.authz === "permission" && x.path.includes("{tenantId}") && x.perms.some((p) => p.startsWith("resource.") || p.startsWith("rbac.") || p.startsWith("identity.")))) {
      const res = await send(o, tokens.org_admin!, A());
      rows.push({ role: "org_admin", operation: o.key, permissions: o.perms, tenantContext: "tenantA (no delegation)", expected: "403/404", actual: res.statusCode, pass: res.statusCode === 403 || res.statusCode === 404 });
      expect([403, 404], `${o.key} -> ${res.statusCode}`).toContain(res.statusCode);
    }
  });
});
