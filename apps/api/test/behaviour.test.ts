import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSpec, responseSchema, validate } from "./support/openapiConformance.js";
import { createTestApp, type FixtureIds } from "./support.js";

/**
 * The behaviour and discipline log (docs/BEHAVIOUR.md, migration 118), through the real figbloom_app login. A port of the live
 * Supabase feature. Negative first: who may not use it (a parent, a student, a driver, a staff member with no area, an org admin
 * without a delegation, a teacher on the office routes, another school by path and by header, a suspended school, a disabled
 * account, anonymous); a teacher recording for a learner they do not teach; what the database refuses on its own (a rewritten
 * entry, a forged recorder, another school's rows, a delete); then the rules, the log's scope, voiding, and the points.
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
type Json = Record<string, any>;

describe("behaviour and discipline log", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  const spec = loadSpec();
  const tok: Record<string, string> = {};
  const id: Record<string, string> = {};
  const P = (tenant: string) => `/v1/tenants/${tenant}/behaviour`;

  const call = (who: string | null, method: "GET" | "POST" | "PUT" | "PATCH", path: string, payload?: unknown, opts: { tenant?: string; header?: string } = {}) => {
    const tenant = opts.tenant ?? ids.tenantA;
    return ctx.app.inject({
      method,
      url: `${P(tenant)}${path}`,
      headers: { ...(who ? { authorization: `Bearer ${tok[who]}` } : {}), "x-tenant-id": opts.header ?? tenant },
      ...(payload === undefined ? {} : { payload: payload as Json }),
    });
  };
  const ok = async (who: string, method: "GET" | "POST" | "PUT" | "PATCH", path: string, payload?: unknown, status = method === "POST" ? 201 : 200): Promise<Json> => {
    const res = await call(who, method, path, payload);
    expect(res.statusCode, `${method} ${path} ${res.body}`).toBe(status);
    return res.json();
  };
  const q = (sql: string, params: unknown[] = []) => ctx.pool.query(sql, params);
  const one = async (sql: string, params: unknown[]) => (await q(sql, params)).rows[0].id as string;
  const conforms = (method: string, path: string, status: number, body: unknown) => {
    const schema = responseSchema(spec, method, `/v1/tenants/{tenantId}/behaviour${path}`, status);
    expect(typeof schema, String(schema)).toBe("object");
    const errs = validate(spec, schema, body);
    expect(errs, errs.join("; ")).toEqual([]);
  };

  async function member(name: string, role: string, loginId: string, tenant: string): Promise<string> {
    const userId = randomUUID();
    await q(`INSERT INTO users (id, email, password_hash, full_name, status) SELECT $1, NULL, password_hash, $2, 'active' FROM users WHERE id = $3`, [userId, name, ids.adminA]);
    await q(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, $3, $4)`, [userId, tenant, role, loginId]);
    return userId;
  }
  async function login(tenantId: string, loginId: string): Promise<string> {
    const res = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId, loginId, password: "correct-horse-battery" } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().token as string;
  }
  async function byEmail(email: string): Promise<string> {
    const res = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email, password: "correct-horse-battery" } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().token as string;
  }
  async function whileChanged(change: string, undo: string, params: unknown[], fn: () => Promise<void>): Promise<void> {
    await q(change, params);
    try {
      await fn();
    } finally {
      await q(undo, params);
    }
  }
  const staff = (tenant: string, name: string, userId: string | null) =>
    one(`INSERT INTO staff_members (tenant_id, full_name, classification, user_id) VALUES ($1, $2, 'teacher', $3) RETURNING id`, [tenant, name, userId]);
  const klass = (tenant: string, year: string, name: string, classTeacher: string | null = null) =>
    one(`INSERT INTO classes (tenant_id, academic_year_id, name, class_teacher_staff_id) VALUES ($1, $2, $3, $4) RETURNING id`, [tenant, year, name, classTeacher]);
  async function learnerIn(tenant: string, classId: string, year: string, name: string): Promise<string> {
    const learnerId = await one(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, $3, 'female') RETURNING id`, [tenant, `BH-${randomUUID().slice(0, 8)}`, name]);
    await q(`INSERT INTO class_memberships (tenant_id, learner_id, class_id, academic_year_id) VALUES ($1, $2, $3, $4)`, [tenant, learnerId, classId, year]);
    return learnerId;
  }
  /** Run fn on a figbloom_app connection in a transaction with the given school and user, always rolled back. */
  async function asApp<T>(tenant: string, user: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [tenant, user]);
      return await fn(c);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }
  const code = async (c: pg.PoolClient, sql: string, params: unknown[] = []): Promise<string | undefined> => {
    await c.query("SAVEPOINT s");
    try {
      await c.query(sql, params);
      await c.query("RELEASE SAVEPOINT s");
      return undefined;
    } catch (err) {
      await c.query("ROLLBACK TO SAVEPOINT s");
      return (err as { code?: string }).code;
    }
  };

  // today at the school (Africa/Nairobi), and days from it
  let today = "";
  const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
  const cat: Record<string, string> = {};
  const record = (who: string, body: Json) => call(who, "POST", "/entries", body);
  const recordOk = async (who: string, body: Json): Promise<string[]> => (await ok(who, "POST", "/entries", body)).entry_ids as string[];
  const pointsOf = async (who: string, learner: string, extra = ""): Promise<Json> => {
    const body = await ok(who, "GET", `/points?learner_ids=${learner}${extra}`);
    return body.learners[0];
  };
  const setSettings = (patch: Json) =>
    ok("admin", "PUT", "/settings", {
      points_enabled: true, mode: "both", starting_points: 100, reset: "term", max_points_per_entry: 10, thresholds: [],
      parents_see_demerits: false, parents_see_incidents: false, ...patch,
    });

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    const A = ids.tenantA;
    const B = ids.tenantB;
    today = (await q(`SELECT (now() AT TIME ZONE 'Africa/Nairobi')::date::text AS d`)).rows[0].d;

    id.teacher2 = await member("Teacher Two", "teacher", "TC-0002", A);
    id.teacher3 = await member("Teacher Three", "teacher", "TC-0003", A); // linked, teaches nothing
    id.office = await member("Discipline Teacher", "teacher", "TC-0004", A); // holds the Discipline area
    id.feesTeacher = await member("Fees Teacher", "teacher", "TC-0005", A); // holds another area
    id.student = await member("Student One", "student", "ST-0001", A);
    id.driver = await member("Driver One", "driver", "DR-0001", A);
    id.staffer = await member("Office Staff", "staff", "SF-0001", A); // no area
    id.adminB = await member("Admin B", "school_admin", "AD-0002", B);
    await q(`INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'discipline')`, [A, id.office]);
    await q(`INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'fees')`, [A, id.feesTeacher]);

    // School A: this year (current) with three terms, next year with one; classes X (Teacher A), Y (Teacher Two), Z (nobody)
    id.year = await one(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on, is_current) VALUES ($1, 'BH year', $2, $3, true) RETURNING id`, [A, day(-300), day(100)]);
    id.year2 = await one(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on) VALUES ($1, 'BH next year', $2, $3) RETURNING id`, [A, day(110), day(400)]);
    const term = (year: string, index: number, from: number, to: number, current = false) =>
      one(`INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on, is_current) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, [A, year, index, `BH T${index}`, day(from), day(to), current]);
    await term(id.year, 1, -100, -60);
    await term(id.year, 2, -40, 10, true);
    await term(id.year, 3, 50, 100);
    await term(id.year2, 1, 120, 160);
    id.sA = await staff(A, "Teacher A", ids.teacherA);
    id.s2 = await staff(A, "Teacher Two", id.teacher2);
    id.s3 = await staff(A, "Teacher Three", id.teacher3);
    id.maths = await one(`INSERT INTO subjects (tenant_id, code, name) VALUES ($1, 'BHM', 'BH Maths') RETURNING id`, [A]);
    id.X = await klass(A, id.year, "BH X");
    id.Y = await klass(A, id.year, "BH Y");
    id.Z = await klass(A, id.year, "BH Z");
    await q(`INSERT INTO teaching_assignments (tenant_id, staff_member_id, class_id, subject_id) VALUES ($1, $2, $3, $4)`, [A, id.sA, id.X, id.maths]);
    await q(`INSERT INTO teaching_assignments (tenant_id, staff_member_id, class_id, subject_id) VALUES ($1, $2, $3, $4)`, [A, id.s2, id.Y, id.maths]);
    id.alice = await learnerIn(A, id.X, id.year, "Alice");
    id.brian = await learnerIn(A, id.X, id.year, "Brian");
    id.dan = await learnerIn(A, id.Y, id.year, "Dan");
    id.zed = await learnerIn(A, id.Z, id.year, "Zed");
    id.eve = await learnerIn(A, id.X, id.year, "Eve (archived)");
    await q(`UPDATE learners SET active = false, archived_at = now() WHERE id = $1`, [id.eve]);
    id.fay = await learnerIn(A, id.X, id.year, "Fay (left class)");
    await q(`UPDATE class_memberships SET active = false, archived_at = now() WHERE learner_id = $1`, [id.fay]);
    // School B: a class, a learner and a category of its own
    const yB = await one(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on, is_current) VALUES ($1, 'BHB year', $2, $3, true) RETURNING id`, [B, day(-300), day(100)]);
    const cB = await klass(B, yB, "BHB class");
    id.bella = await learnerIn(B, cB, yB, "Bella of School B");
    id.bCat = await one(`INSERT INTO behaviour_categories (tenant_id, kind, name, points, severity) VALUES ($1, 'demerit', 'B Rule', 2, 'minor') RETURNING id`, [B]);

    tok.admin = await byEmail("admin-a@example.com");
    tok.orgAdmin = await byEmail("orgadmin@example.com");
    tok.adminB = await login(B, "AD-0002");
    tok.teacher = await login(A, "TC-0001");
    tok.teacher2 = await login(A, "TC-0002");
    tok.teacher3 = await login(A, "TC-0003");
    tok.office = await login(A, "TC-0004");
    tok.feesTeacher = await login(A, "TC-0005");
    tok.parent = await login(A, "PT-0001");
    tok.student = await login(A, "ST-0001");
    tok.driver = await login(A, "DR-0001");
    tok.staffer = await login(A, "SF-0001");

    expect((await call("admin", "POST", "/categories/defaults")).statusCode).toBe(200);
    const cats = await ok("admin", "GET", "/categories");
    for (const c of cats.categories as Json[]) cat[c.name] = c.id;
  }, 300_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  // ---------------------------------------------------------------- who may use it

  describe("who may use the log", () => {
    const entryId = () => randomUUID();
    const routes = (): Array<[string, "GET" | "POST" | "PUT" | "PATCH", string, unknown, "reader" | "office"]> => [
      ["get settings", "GET", "/settings", undefined, "reader"],
      ["put settings", "PUT", "/settings", { points_enabled: true, mode: "both", starting_points: 100, reset: "term", max_points_per_entry: 10, thresholds: [], parents_see_demerits: false, parents_see_incidents: false }, "office"],
      ["list categories", "GET", "/categories", undefined, "reader"],
      ["create category", "POST", "/categories", { kind: "merit", name: "Perseverance", points: 2 }, "office"],
      ["defaults", "POST", "/categories/defaults", undefined, "office"],
      ["edit category", "PATCH", `/categories/${randomUUID()}`, { name: "Anything" }, "office"],
      ["record", "POST", "/entries", { learner_ids: [randomUUID()], kind: "merit", category_id: randomUUID() }, "reader"],
      ["list entries", "GET", "/entries", undefined, "reader"],
      ["void", "POST", `/entries/${entryId()}/void`, { reason: "A mistake" }, "reader"],
      ["points", "GET", "/points", undefined, "reader"],
      ["classes", "GET", "/classes", undefined, "reader"],
      ["recorders", "GET", "/recorders", undefined, "office"],
    ];

    it("a parent, a student, a driver, staff with no area, an org admin without a delegation get the audited 403 on every route", async () => {
      for (const who of ["parent", "student", "driver", "staffer", "orgAdmin"]) {
        for (const [what, method, path, payload] of routes()) {
          const res = await call(who, method, path, payload);
          expect(res.statusCode, `${who} ${what} ${res.body}`).toBe(403);
          expect(res.json().error.code).toBe("forbidden");
        }
      }
      const denied = await q(`SELECT DISTINCT detail->>'permission' AS p FROM security_audit_events WHERE actor_user_id = $1 AND event_type = 'rbac.permission.denied'`, [ids.parentA]);
      expect(denied.rows.map((r) => r.p)).toEqual(expect.arrayContaining(["resource.discipline.read", "resource.discipline.write"]));
    });

    it("a teacher, and a holder of another area, are refused on the office routes (setup, recorders)", async () => {
      for (const who of ["teacher", "teacher3", "feesTeacher"]) {
        for (const [what, method, path, payload, kind] of routes()) {
          if (kind !== "office") continue;
          const res = await call(who, method, path, payload);
          expect(res.statusCode, `${who} ${what} ${res.body}`).toBe(403);
        }
      }
    });

    it("another school is refused by path and by header, and anonymous callers get 401", async () => {
      for (const [what, method, path, payload] of routes()) {
        expect((await call("adminB", method, path, payload)).statusCode, `adminB ${what}`).toBe(403);
        expect((await call("admin", method, path, payload, { tenant: ids.tenantB })).statusCode, `path B ${what}`).toBe(403);
        expect((await call("admin", method, path, payload, { header: ids.tenantB })).statusCode, `header B ${what}`).toBe(403);
        expect((await call(null, method, path, payload)).statusCode, `anonymous ${what}`).toBe(401);
      }
    });

    it("a suspended school gets 403 and a disabled account 401", async () => {
      await whileChanged(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, `UPDATE tenants SET status = 'active' WHERE id = $1`, [ids.tenantA], async () => {
        expect((await call("teacher", "GET", "/settings")).statusCode).toBe(403);
        expect((await call("office", "GET", "/entries")).statusCode).toBe(403);
      });
      await whileChanged(`UPDATE users SET status = 'disabled' WHERE id = $1`, `UPDATE users SET status = 'active' WHERE id = $1`, [id.office], async () => {
        expect((await call("office", "GET", "/entries")).statusCode).toBe(401);
      });
    });

    it("the Discipline area and a full administrator are the office; a teacher with it is both", async () => {
      expect((await call("admin", "GET", "/recorders")).statusCode).toBe(200);
      expect((await call("office", "GET", "/recorders")).statusCode).toBe(200);
      expect((await call("office", "PUT", "/settings", routes()[1]![3])).statusCode).toBe(200);
    });

    it("an organisation administrator cannot be delegated the Discipline area", async () => {
      const grantor = await ctx.app.inject({
        method: "POST",
        url: "/v1/rbac/org-delegations",
        headers: { authorization: `Bearer ${tok.admin}`, "x-tenant-id": ids.tenantA },
        payload: { delegateUserId: ids.orgAdmin, permissionCodes: ["area.discipline"] },
      });
      expect([400, 403, 422]).toContain(grantor.statusCode);
      expect((await q(`SELECT public.is_delegable_permission('area.discipline') AS ok`)).rows[0].ok).toBe(false);
    });
  });

  // ---------------------------------------------------------------- settings and categories

  describe("settings and categories", () => {
    it("settings are the defaults until the office saves them, and a teacher may read them", async () => {
      await q(`DELETE FROM behaviour_settings WHERE tenant_id = $1`, [ids.tenantA]);
      const before = await ok("teacher", "GET", "/settings");
      conforms("GET", "/settings", 200, before);
      expect(before.settings).toEqual({
        points_enabled: true, mode: "both", starting_points: 100, reset: "term", max_points_per_entry: 10,
        thresholds: [{ points: -15, label: "Parent meeting" }, { points: 30, label: "Certificate" }],
        parents_see_demerits: false, parents_see_incidents: false,
      });
    });

    it("the office replaces the settings, and each invalid shape is refused", async () => {
      const saved = await setSettings({ mode: "demerits_only", reset: "year", max_points_per_entry: 12, thresholds: [{ points: -20, label: " Meeting " }], parents_see_demerits: true });
      conforms("PUT", "/settings", 200, saved);
      expect(saved.settings.thresholds).toEqual([{ points: -20, label: "Meeting" }]);
      expect((await ok("office", "GET", "/settings")).settings).toMatchObject({ mode: "demerits_only", reset: "year", max_points_per_entry: 12, parents_see_demerits: true });
      const bad: Json[] = [
        { mode: "all" }, { reset: "weekly" }, { starting_points: -1 }, { starting_points: 10001 }, { max_points_per_entry: 0 }, { max_points_per_entry: 101 },
        { thresholds: [{ points: 0, label: "Zero" }] }, { thresholds: [{ points: 5.5, label: "Half" }] }, { thresholds: [{ points: 5, label: "" }] },
        { thresholds: [{ points: 5, label: "x".repeat(61) }] }, { thresholds: Array.from({ length: 11 }, (_, i) => ({ points: i + 1, label: "T" })) },
        { points_enabled: "yes" },
      ];
      for (const patch of bad) expect((await call("admin", "PUT", "/settings", { points_enabled: true, mode: "both", starting_points: 100, reset: "term", max_points_per_entry: 10, thresholds: [], parents_see_demerits: false, parents_see_incidents: false, ...patch })).statusCode, JSON.stringify(patch)).toBe(400);
      expect((await call("admin", "PUT", "/settings", { points_enabled: true })).statusCode).toBe(400);
      expect((await call("admin", "PUT", "/settings", { points_enabled: true, mode: "both", starting_points: 1, reset: "term", max_points_per_entry: 1, thresholds: [], parents_see_demerits: false, parents_see_incidents: false, tenant_id: ids.tenantB })).statusCode).toBe(400);
      expect((await q(`SELECT 1 FROM security_audit_events WHERE tenant_id = $1 AND event_type = 'academics.behaviour.settings_updated'`, [ids.tenantA])).rowCount).toBeGreaterThan(0);
      await setSettings({});
    });

    it("the 14 suggested categories are added once, and never over a name the school already has", async () => {
      const list = await ok("admin", "GET", "/categories");
      conforms("GET", "/categories", 200, list);
      expect(list.categories).toHaveLength(14);
      expect(list.categories.filter((c: Json) => c.kind === "merit")).toHaveLength(5);
      expect(list.categories.every((c: Json) => (c.kind === "merit") === (c.severity === null))).toBe(true);
      expect((await ok("admin", "POST", "/categories/defaults", undefined, 200)).added).toBe(0);
      const renamed = await ok("admin", "PATCH", `/categories/${cat["Helping others"]}`, { name: "Kindness" });
      expect(renamed.category.name).toBe("Kindness");
      expect((await ok("admin", "POST", "/categories/defaults", undefined, 200)).added).toBe(1);
      await ok("admin", "PATCH", `/categories/${cat["Helping others"]}`, { name: "Helping others" }).catch(() => undefined);
    });

    it("a category is created, edited, archived and restored; names are unique per kind in any case", async () => {
      const made = await ok("admin", "POST", "/categories", { kind: "merit", name: "  Perseverance ", points: 3 });
      conforms("POST", "/categories", 201, made);
      expect(made.category).toMatchObject({ kind: "merit", name: "Perseverance", points: 3, severity: null, archived_at: null });
      const dup = await call("admin", "POST", "/categories", { kind: "merit", name: "perseverance", points: 1 });
      expect(dup.statusCode).toBe(409);
      // the same name under the other kind is a different category
      const demerit = await ok("admin", "POST", "/categories", { kind: "demerit", name: "Perseverance", points: 1 });
      expect(demerit.category.severity).toBe("minor");
      expect((await call("admin", "POST", "/categories", { kind: "merit", name: "Bad", points: 1, severity: "minor" })).statusCode).toBe(400);
      expect((await call("admin", "POST", "/categories", { kind: "merit", name: "x", points: 1 })).statusCode).toBe(400);
      expect((await call("admin", "POST", "/categories", { kind: "merit", name: "Okay", points: 0 })).statusCode).toBe(400);
      expect((await call("admin", "POST", "/categories", { kind: "merit", name: "Okay", points: 101 })).statusCode).toBe(400);

      const edited = await ok("admin", "PATCH", `/categories/${made.category.id}`, { points: 4 });
      conforms("PATCH", "/categories/{categoryId}", 200, edited);
      expect(edited.category.points).toBe(4);
      expect((await call("admin", "PATCH", `/categories/${made.category.id}`, { severity: "major" })).statusCode, "a merit has no severity").toBe(400);
      expect((await call("admin", "PATCH", `/categories/${made.category.id}`, {})).statusCode).toBe(400);
      expect((await call("admin", "PATCH", `/categories/${made.category.id}`, { kind: "demerit" })).statusCode).toBe(400);
      expect((await call("admin", "PATCH", `/categories/${made.category.id}`, { name: "Kindness" })).statusCode, "taken by a merit above").toBe(409);

      const archived = await ok("admin", "PATCH", `/categories/${made.category.id}`, { archived: true });
      expect(archived.category.archived_at).not.toBeNull();
      expect((await ok("teacher", "GET", "/categories")).categories.map((c: Json) => c.id)).not.toContain(made.category.id);
      expect((await ok("admin", "GET", "/categories")).categories.map((c: Json) => c.id)).not.toContain(made.category.id);
      expect((await ok("admin", "GET", "/categories?include_archived=true")).categories.map((c: Json) => c.id)).toContain(made.category.id);
      // a teacher cannot ask for the archived ones
      expect((await ok("teacher", "GET", "/categories?include_archived=true")).categories.map((c: Json) => c.id)).not.toContain(made.category.id);
      expect((await ok("admin", "PATCH", `/categories/${made.category.id}`, { archived: false })).category.archived_at).toBeNull();
      expect((await call("admin", "GET", "/categories?include_archived=maybe")).statusCode).toBe(400);
      const events = await q(`SELECT event_type FROM security_audit_events WHERE tenant_id = $1 AND event_type LIKE 'academics.behaviour.category_%'`, [ids.tenantA]);
      expect(events.rows.map((r) => r.event_type)).toEqual(expect.arrayContaining(["academics.behaviour.category_created", "academics.behaviour.category_updated", "academics.behaviour.category_archived", "academics.behaviour.category_restored"]));
    });

    it("another school's category is not found, and a school never sees another's", async () => {
      expect((await call("admin", "PATCH", `/categories/${id.bCat}`, { name: "Hijacked" })).statusCode).toBe(404);
      expect((await call("admin", "PATCH", `/categories/not-a-uuid`, { name: "Hijacked" })).statusCode).toBe(400);
      expect((await q(`SELECT name FROM behaviour_categories WHERE id = $1`, [id.bCat])).rows[0].name).toBe("B Rule");
      expect((await ok("admin", "GET", "/categories?include_archived=true")).categories.map((c: Json) => c.id)).not.toContain(id.bCat);
    });
  });

  // ---------------------------------------------------------------- recording

  describe("recording", () => {
    it("a teacher records a merit for the learners they teach, with a staff-only note", async () => {
      const res = await ok("teacher", "POST", "/entries", { learner_ids: [id.alice, id.brian, id.alice], kind: "merit", category_id: cat["Leadership"], note: "Led the group", staff_note: "Quiet about it" });
      conforms("POST", "/entries", 201, res);
      expect(res.count).toBe(2);
      const rows = (await q(`SELECT e.*, e.occurred_on::text AS day, n.note AS staff FROM behaviour_entries e LEFT JOIN behaviour_staff_notes n ON n.entry_id = e.id WHERE e.id = ANY($1) ORDER BY e.id`, [res.entry_ids])).rows;
      expect(rows.map((r) => r.learner_id).sort()).toEqual([id.alice, id.brian].sort());
      for (const r of rows) {
        expect(r).toMatchObject({ kind: "merit", points: 3, severity: null, note: "Led the group", staff: "Quiet about it", recorded_by: ids.teacherA, class_id: id.X, follow_up_status: null, voided_at: null });
        expect(r.day).toBe(today);
      }
      const audit = (await q(`SELECT detail FROM security_audit_events WHERE event_type = 'academics.behaviour.recorded' AND actor_user_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [ids.teacherA])).rows[0].detail;
      expect(audit).toMatchObject({ kind: "merit", count: 2 });
      expect(JSON.stringify(audit)).not.toContain("Led the group");
      expect(JSON.stringify(audit)).not.toContain("Quiet about it");
    });

    it("a teacher cannot record for a learner they do not teach, for any reason, and nothing is written", async () => {
      const before = (await q(`SELECT count(*)::int AS n FROM behaviour_entries`)).rows[0].n;
      const cases: Array<[string, Array<string | undefined>]> = [
        ["another class", [id.dan]], ["a class nobody teaches", [id.zed]], ["a mix of taught and not", [id.alice, id.dan]],
        ["a learner who left the class", [id.fay]], ["an archived learner", [id.eve]], ["another school's learner", [id.bella]], ["an id that does not exist", [randomUUID()]],
      ];
      for (const [what, learner_ids] of cases) {
        const res = await record("teacher", { learner_ids, kind: "merit", category_id: cat["Leadership"] });
        expect(res.statusCode, what).toBe(403);
        expect(res.json().error.message, what).toBe("You can only record behaviour for learners you teach");
      }
      // a teacher who teaches nothing, and one whose class teacher is someone else
      expect((await record("teacher3", { learner_ids: [id.alice], kind: "merit", category_id: cat["Leadership"] })).statusCode).toBe(403);
      expect((await q(`SELECT count(*)::int AS n FROM behaviour_entries`)).rows[0].n).toBe(before);
    });

    it("the class teacher of a class records for it too", async () => {
      await q(`UPDATE classes SET class_teacher_staff_id = $1 WHERE id = $2`, [id.s3, id.Z]);
      try {
        expect((await record("teacher3", { learner_ids: [id.zed], kind: "merit", category_id: cat["Leadership"] })).statusCode).toBe(201);
      } finally {
        await q(`UPDATE classes SET class_teacher_staff_id = NULL WHERE id = $1`, [id.Z]);
      }
      // the teaching rule is live: with the class teacher gone, the same teacher is refused again
      expect((await record("teacher3", { learner_ids: [id.zed], kind: "merit", category_id: cat["Leadership"] })).statusCode).toBe(403);
    });

    it("the office records for any active learner of the school, and only those", async () => {
      expect((await record("admin", { learner_ids: [id.dan, id.zed], kind: "merit", category_id: cat["Leadership"] })).statusCode).toBe(201);
      expect((await record("office", { learner_ids: [id.dan], kind: "merit", category_id: cat["Leadership"] })).statusCode).toBe(201);
      for (const learner_ids of [[id.eve], [id.bella], [randomUUID()], [id.dan, id.bella]]) {
        const res = await record("admin", { learner_ids, kind: "merit", category_id: cat["Leadership"] });
        expect(res.statusCode, JSON.stringify(learner_ids)).toBe(400);
      }
    });

    it("a demerit takes its size and severity from the category; a serious one starts open", async () => {
      const [minor] = await recordOk("teacher", { learner_ids: [id.alice], kind: "demerit", category_id: cat["Late to class"] });
      const [serious] = await recordOk("teacher", { learner_ids: [id.alice], kind: "demerit", category_id: cat["Fighting"], points: 7 });
      const rows = (await q(`SELECT id, points, severity, follow_up_status FROM behaviour_entries WHERE id = ANY($1)`, [[minor, serious]])).rows;
      expect(rows.find((r) => r.id === minor)).toMatchObject({ points: -1, severity: "minor", follow_up_status: null });
      expect(rows.find((r) => r.id === serious)).toMatchObject({ points: -7, severity: "serious", follow_up_status: "open" });
    });

    it("an incident takes a demerit category or a note; it defaults to serious", async () => {
      const [withCat] = await recordOk("teacher", { learner_ids: [id.brian], kind: "incident", category_id: cat["Bullying"] });
      const [withNote] = await recordOk("teacher", { learner_ids: [id.brian], kind: "incident", note: "Left the compound" });
      const [minorOne] = await recordOk("teacher", { learner_ids: [id.brian], kind: "incident", note: "Raised voice", severity: "minor" });
      const rows = (await q(`SELECT id, points, severity, follow_up_status, category_id FROM behaviour_entries WHERE id = ANY($1)`, [[withCat, withNote, minorOne]])).rows;
      expect(rows.find((r) => r.id === withCat)).toMatchObject({ points: -10, severity: "serious", follow_up_status: "open" });
      expect(rows.find((r) => r.id === withNote)).toMatchObject({ points: 0, severity: "serious", follow_up_status: "open", category_id: null });
      expect(rows.find((r) => r.id === minorOne)).toMatchObject({ points: 0, severity: "minor", follow_up_status: null });
      expect((await record("teacher", { learner_ids: [id.brian], kind: "incident" })).statusCode, "no category and no note").toBe(400);
      expect((await record("teacher", { learner_ids: [id.brian], kind: "incident", category_id: cat["Leadership"] })).statusCode, "a merit category").toBe(400);
    });

    it("the category must exist, be this school's, be in use, and match the kind", async () => {
      const L = [id.alice];
      expect((await record("teacher", { learner_ids: L, kind: "merit", category_id: cat["Fighting"] })).statusCode, "wrong kind").toBe(400);
      expect((await record("teacher", { learner_ids: L, kind: "demerit", category_id: cat["Leadership"] })).statusCode, "wrong kind").toBe(400);
      expect((await record("teacher", { learner_ids: L, kind: "merit" })).statusCode, "no category").toBe(400);
      expect((await record("teacher", { learner_ids: L, kind: "merit", category_id: randomUUID() })).statusCode, "unknown").toBe(404);
      expect((await record("teacher", { learner_ids: L, kind: "demerit", category_id: id.bCat })).statusCode, "another school's").toBe(404);
      const made = (await ok("admin", "POST", "/categories", { kind: "merit", name: "Short lived", points: 1 })).category.id as string;
      await ok("admin", "PATCH", `/categories/${made}`, { archived: true });
      const res = await record("teacher", { learner_ids: L, kind: "merit", category_id: made });
      expect(res.statusCode, "archived").toBe(409);
      expect(res.json().error.message).toContain("no longer in use");
    });

    it("the size is within the school's maximum; the date is not in the future or over a year old", async () => {
      const L = [id.alice];
      const base = { learner_ids: L, kind: "merit", category_id: cat["Leadership"] };
      expect((await record("teacher", { ...base, points: 11 })).statusCode).toBe(400);
      expect((await record("teacher", { ...base, points: 10 })).statusCode).toBe(201);
      await setSettings({ max_points_per_entry: 12 });
      expect((await record("teacher", { ...base, points: 12 })).statusCode).toBe(201);
      await setSettings({ max_points_per_entry: 2 });
      const tight = await record("teacher", { ...base, points: 3 });
      expect(tight.statusCode).toBe(400);
      expect(tight.json().error.message).toContain("at most 2");
      await setSettings({});
      for (const bad of [0, -1, 1.5, 101]) expect((await record("teacher", { ...base, points: bad })).statusCode, `points ${bad}`).toBe(400);
      expect((await record("teacher", { ...base, occurred_on: day(2) })).statusCode, "future").toBe(400);
      expect((await record("teacher", { ...base, occurred_on: day(-400) })).statusCode, "over a year").toBe(400);
      expect((await record("teacher", { ...base, occurred_on: "2026-02-30" })).statusCode, "not a date").toBe(400);
      const past = await recordOk("teacher", { ...base, occurred_on: day(-5) });
      expect((await q(`SELECT occurred_on::text AS d FROM behaviour_entries WHERE id = $1`, [past[0]])).rows[0].d).toBe(day(-5));
    });

    it("the body is strict: no forged recorder, tenant or void fields, at most 80 learners, no empty list", async () => {
      const base = { learner_ids: [id.alice], kind: "merit", category_id: cat["Leadership"] };
      for (const extra of [{ recorded_by: ids.adminA }, { tenant_id: ids.tenantB }, { voided_at: "2026-01-01T00:00:00Z" }, { points_signed: 5 }, { class_id: id.Y }]) {
        expect((await record("teacher", { ...base, ...extra })).statusCode, JSON.stringify(extra)).toBe(400);
      }
      expect((await record("teacher", { ...base, learner_ids: [] })).statusCode).toBe(400);
      expect((await record("admin", { ...base, learner_ids: Array.from({ length: 81 }, () => randomUUID()) })).statusCode).toBe(400);
      expect((await record("teacher", { ...base, learner_ids: ["nope"] })).statusCode).toBe(400);
      expect((await record("teacher", { ...base, kind: "praise" })).statusCode).toBe(400);
      expect((await record("teacher", { ...base, note: "x".repeat(1001) })).statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------- the database's own guard

  describe("the database refuses on its own", () => {
    let entry: string;
    beforeAll(async () => {
      entry = (await recordOk("teacher", { learner_ids: [id.alice], kind: "merit", category_id: cat["Leadership"], note: "Guard test", staff_note: "private" }))[0]!;
    });
    const insert = `INSERT INTO behaviour_entries (tenant_id, learner_id, category_id, kind, points, note, occurred_on) VALUES ($1, $2, $3, 'merit', 2, 'direct', $4::date) RETURNING id, recorded_by, class_id`;

    it("an entry is never rewritten, deleted or moved to another school", async () => {
      await asApp(ids.tenantA, ids.teacherA, async (c) => {
        for (const sql of [
          `UPDATE behaviour_entries SET points = 9 WHERE id = $1`, `UPDATE behaviour_entries SET note = 'edited' WHERE id = $1`,
          `UPDATE behaviour_entries SET learner_id = '${id.brian}' WHERE id = $1`, `UPDATE behaviour_entries SET tenant_id = '${ids.tenantB}' WHERE id = $1`,
          `UPDATE behaviour_entries SET recorded_by = '${ids.adminA}' WHERE id = $1`, `UPDATE behaviour_entries SET occurred_on = occurred_on - 1 WHERE id = $1`,
          `DELETE FROM behaviour_entries WHERE id = $1`, `TRUNCATE behaviour_entries`,
          `UPDATE behaviour_staff_notes SET note = 'edited' WHERE entry_id = $1`, `DELETE FROM behaviour_staff_notes WHERE entry_id = $1`,
          `UPDATE behaviour_categories SET kind = 'demerit' WHERE id = '${cat["Leadership"]}'`, `DELETE FROM behaviour_categories WHERE id = '${cat["Leadership"]}'`,
          `DELETE FROM behaviour_settings`,
        ]) {
          expect(await code(c, sql, sql.includes("$1") ? [entry] : []), sql).toBe("42501");
        }
        expect((await c.query(`SELECT points, note FROM behaviour_entries WHERE id = $1`, [entry])).rows[0]).toEqual({ points: 3, note: "Guard test" });
      });
    });

    it("a direct insert is checked and stamped: the recorder is the request's user, void and incident columns are cleared, the class is the learner's", async () => {
      await asApp(ids.tenantA, ids.teacherA, async (c) => {
        const r = await c.query(
          `INSERT INTO behaviour_entries (tenant_id, learner_id, category_id, kind, points, occurred_on, recorded_by, voided_at, voided_by, void_reason, action_taken, follow_up_status, resolved_at, class_id)
           VALUES ($1, $2, $3, 'demerit', -2, $4::date, $5, now(), $5, 'forged', 'suspension', 'resolved', now(), $6) RETURNING *`,
          [ids.tenantA, id.alice, cat["Disrupting class"], today, ids.adminA, id.Y],
        ).catch((e) => e);
        // the void_reason/voided_at pair is cleared together, so the forged row is accepted without the forgery
        expect((r as { code?: string }).code).toBeUndefined();
        expect(r.rows[0]).toMatchObject({ recorded_by: ids.teacherA, voided_at: null, voided_by: null, void_reason: null, action_taken: null, follow_up_status: null, resolved_at: null, class_id: id.X, severity: "minor" });
      });
    });

    it("another school's rows are invisible and cannot be written", async () => {
      await asApp(ids.tenantA, ids.teacherA, async (c) => {
        expect((await c.query(`SELECT 1 FROM behaviour_entries WHERE tenant_id = $1`, [ids.tenantB])).rowCount).toBe(0);
        expect(await code(c, insert, [ids.tenantB, id.bella, id.bCat, today])).toBe("42501");
        expect(await code(c, insert, [ids.tenantA, id.bella, cat["Leadership"], today]), "another school's learner").toBe("42501");
        expect(await code(c, insert, [ids.tenantA, id.alice, id.bCat, today]), "another school's category").toBe("42501");
      });
    });

    it("the learner, category, kind, sign, size and date rules hold without the API", async () => {
      await asApp(ids.tenantA, ids.teacherA, async (c) => {
        expect(await code(c, insert, [ids.tenantA, id.eve, cat["Leadership"], today]), "archived learner").toBe("23514");
        expect(await code(c, insert, [ids.tenantA, id.alice, cat["Fighting"], today]), "merit with a demerit category").toBe("22023");
        expect(await code(c, insert, [ids.tenantA, id.alice, cat["Leadership"], day(3)]), "future").toBe("22023");
        expect(await code(c, insert, [ids.tenantA, id.alice, cat["Leadership"], day(-400)]), "old").toBe("22023");
        expect(await code(c, `INSERT INTO behaviour_entries (tenant_id, learner_id, category_id, kind, points, occurred_on) VALUES ($1, $2, $3, 'merit', -2, $4::date)`, [ids.tenantA, id.alice, cat["Leadership"], today]), "wrong sign").toBe("23514");
        expect(await code(c, `INSERT INTO behaviour_entries (tenant_id, learner_id, category_id, kind, points, occurred_on) VALUES ($1, $2, $3, 'merit', 11, $4::date)`, [ids.tenantA, id.alice, cat["Leadership"], today]), "over the maximum").toBe("22023");
        expect(await code(c, `INSERT INTO behaviour_entries (tenant_id, learner_id, kind, points, occurred_on) VALUES ($1, $2, 'merit', 2, $3::date)`, [ids.tenantA, id.alice, today]), "no category").toBe("22023");
        expect(await code(c, `UPDATE behaviour_categories SET severity = 'minor' WHERE id = '${cat["Leadership"]}'`), "a merit with a severity").toBe("23514");
      });
    });

    it("voiding stamps the voider, is final, and cannot be mixed with a follow-up", async () => {
      await asApp(ids.tenantA, ids.adminA, async (c) => {
        expect(await code(c, `UPDATE behaviour_entries SET voided_at = now(), voided_by = '${ids.teacherA}', void_reason = 'ab' WHERE id = $1`, [entry]), "reason too short").toBe("23514");
        expect(await code(c, `UPDATE behaviour_entries SET voided_at = now(), void_reason = 'A mistake', follow_up_status = 'open' WHERE id = $1`, [entry]), "void and follow up").toBe("22023");
        expect(await code(c, `UPDATE behaviour_entries SET voided_by = '${ids.teacherA}' WHERE id = $1`, [entry]), "voider without a void").toBe("22023");
        expect(await code(c, `UPDATE behaviour_entries SET voided_at = now(), voided_by = '${ids.teacherA}', void_reason = 'A mistake' WHERE id = $1`, [entry])).toBeUndefined();
        const row = (await c.query(`SELECT voided_by, void_reason FROM behaviour_entries WHERE id = $1`, [entry])).rows[0];
        expect(row).toEqual({ voided_by: ids.adminA, void_reason: "A mistake" });
        expect(await code(c, `UPDATE behaviour_entries SET void_reason = 'Another reason' WHERE id = $1`, [entry]), "a voided entry is final").toBe("23514");
        expect(await code(c, `UPDATE behaviour_entries SET voided_at = NULL, void_reason = NULL WHERE id = $1`, [entry]), "cannot be un-voided").toBe("23514");
      });
    });

    it("the incident record is stamped from the request and keeps its first times", async () => {
      const serious = (await recordOk("admin", { learner_ids: [id.alice], kind: "demerit", category_id: cat["Vandalism"], severity: undefined }))[0]!;
      await asApp(ids.tenantA, ids.adminA, async (c) => {
        await c.query(`UPDATE behaviour_entries SET follow_up_status = 'open', action_taken = 'warning', parent_notified_at = now() WHERE id = $1`, [serious]);
        const first = (await c.query(`SELECT parent_notified_at FROM behaviour_entries WHERE id = $1`, [serious])).rows[0].parent_notified_at as Date;
        await c.query(`UPDATE behaviour_entries SET follow_up_status = 'resolved', resolved_by = '${ids.teacherA}', resolved_at = '2020-01-01' WHERE id = $1`, [serious]);
        const resolved = (await c.query(`SELECT resolved_by, resolved_at, parent_notified_at FROM behaviour_entries WHERE id = $1`, [serious])).rows[0];
        expect(resolved.resolved_by).toBe(ids.adminA);
        expect(resolved.resolved_at.getUTCFullYear()).toBeGreaterThan(2020);
        expect(resolved.parent_notified_at).toEqual(first);
        await c.query(`UPDATE behaviour_entries SET follow_up_status = 'open', parent_notified_at = now() + interval '1 day' WHERE id = $1`, [serious]);
        const reopened = (await c.query(`SELECT resolved_by, resolved_at, parent_notified_at FROM behaviour_entries WHERE id = $1`, [serious])).rows[0];
        expect(reopened).toMatchObject({ resolved_by: null, resolved_at: null });
        expect(reopened.parent_notified_at).toEqual(first);
        expect(await code(c, `UPDATE behaviour_entries SET action_taken = 'expulsion' WHERE id = $1`, [serious])).toBe("23514");
        expect(await code(c, `UPDATE behaviour_entries SET follow_up_status = 'pending' WHERE id = $1`, [serious])).toBe("23514");
      });
    });

    it("the staff-only note is in a table of its own and only staff routes ever select it", async () => {
      const notes = (await q(`SELECT n.note FROM behaviour_staff_notes n WHERE n.entry_id = $1`, [entry])).rows;
      expect(notes).toEqual([{ note: "private" }]);
      const list = await ok("admin", "GET", `/entries?learner_id=${id.alice}&include_voided=true&limit=200`);
      expect(list.entries.find((e: Json) => e.id === entry).staff_note).toBe("private");
    });
  });

  // ---------------------------------------------------------------- the log

  describe("the log", () => {
    const ids_of = (body: Json) => (body.entries as Json[]).map((e) => e.id);
    let aliceByTeacher: string;
    let danByAdmin: string;
    let danByTeacher2: string;
    beforeAll(async () => {
      aliceByTeacher = (await recordOk("teacher", { learner_ids: [id.alice], kind: "demerit", category_id: cat["Late to class"], occurred_on: day(-3), note: "log-a" }))[0]!;
      danByAdmin = (await recordOk("admin", { learner_ids: [id.dan], kind: "merit", category_id: cat["Sportsmanship"], occurred_on: day(-3), note: "log-d" }))[0]!;
      danByTeacher2 = (await recordOk("teacher2", { learner_ids: [id.dan], kind: "demerit", category_id: cat["Disrespect"], occurred_on: day(-2), note: "log-d2" }))[0]!;
    });

    it("the office reads the whole school; a teacher reads what they recorded and what is recorded for the learners they teach", async () => {
      const office = await ok("admin", "GET", "/entries?limit=200");
      conforms("GET", "/entries", 200, office);
      expect(ids_of(office)).toEqual(expect.arrayContaining([aliceByTeacher, danByAdmin, danByTeacher2]));
      expect(office.entries.every((e: Json) => !("tenant_id" in e))).toBe(true);
      const t1 = ids_of(await ok("teacher", "GET", "/entries?limit=200"));
      expect(t1).toContain(aliceByTeacher);
      expect(t1).not.toContain(danByAdmin);
      expect(t1).not.toContain(danByTeacher2);
      const t2 = ids_of(await ok("teacher2", "GET", "/entries?limit=200"));
      expect(t2).toEqual(expect.arrayContaining([danByAdmin, danByTeacher2]));
      expect(t2).not.toContain(aliceByTeacher);
      expect(ids_of(await ok("teacher3", "GET", "/entries?limit=200"))).not.toEqual(expect.arrayContaining([aliceByTeacher]));
      expect(ids_of(await ok("teacher3", "GET", "/entries?limit=200"))).not.toContain(danByTeacher2);
      expect((await ok("office", "GET", "/entries?limit=200")).entries.length).toBe(office.entries.length);
      // a recorder keeps what they recorded even for a learner they no longer teach
      await q(`UPDATE class_memberships SET active = false, archived_at = now() WHERE learner_id = $1`, [id.alice]);
      try {
        expect(ids_of(await ok("teacher", "GET", "/entries?limit=200"))).toContain(aliceByTeacher);
        expect(ids_of(await ok("teacher3", "GET", "/entries?limit=200"))).not.toContain(aliceByTeacher);
      } finally {
        await q(`UPDATE class_memberships SET active = true, archived_at = NULL WHERE learner_id = $1`, [id.alice]);
      }
    });

    it("each entry names the learner, category, class and recorder, with the staff-only note", async () => {
      const row = (await ok("admin", "GET", `/entries?learner_id=${id.alice}&limit=200`)).entries.find((e: Json) => e.id === aliceByTeacher);
      expect(row).toMatchObject({
        learner_name: "Alice", category_name: "Late to class", kind: "demerit", points: -1, severity: "minor", occurred_on: day(-3), class_name: "BH X",
        recorder_name: "Teacher A", note: "log-a", voided_at: null, staff_note: null,
      });
    });

    it("newest day first, then the latest recorded", async () => {
      const list = (await ok("admin", "GET", "/entries?limit=200")).entries as Json[];
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1]!;
        const b = list[i]!;
        expect(a.occurred_on > b.occurred_on || (a.occurred_on === b.occurred_on && a.created_at >= b.created_at), `${a.occurred_on} ${a.created_at} / ${b.occurred_on} ${b.created_at}`).toBe(true);
      }
    });

    it("filters: class, kind, category, recorder, learner, days, serious and open", async () => {
      const get = async (qs: string) => ids_of(await ok("admin", "GET", `/entries?limit=200&${qs}`));
      expect(await get(`class_id=${id.Y}`)).toEqual(expect.arrayContaining([danByAdmin, danByTeacher2]));
      expect(await get(`class_id=${id.Y}`)).not.toContain(aliceByTeacher);
      expect(await get("kind=merit")).toContain(danByAdmin);
      expect(await get("kind=merit")).not.toContain(aliceByTeacher);
      expect(await get(`category_id=${cat["Disrespect"]}`)).toEqual([danByTeacher2]);
      expect(await get(`recorded_by=${id.teacher2}`)).toEqual([danByTeacher2]);
      expect(await get(`learner_id=${id.dan}`)).toEqual(expect.arrayContaining([danByAdmin, danByTeacher2]));
      expect(await get(`from=${day(-2)}&to=${day(-2)}`)).toEqual([danByTeacher2]);
      expect((await get(`serious_only=true`)).length).toBeGreaterThan(0);
      expect((await get(`open_only=true`)).every((x) => x !== aliceByTeacher)).toBe(true);
      for (const bad of ["kind=praise", "class_id=x", "from=2026-13-01", `from=${day(0)}&to=${day(-1)}`, "open_only=maybe"]) {
        expect((await call("admin", "GET", `/entries?${bad}`)).statusCode, bad).toBe(400);
      }
    });

    it("pages are bound to the caller and the filters; another school's entries never appear", async () => {
      const page1 = await ok("admin", "GET", "/entries?limit=2");
      expect(page1.entries).toHaveLength(2);
      expect(page1.page.next_cursor).toEqual(expect.any(String));
      const page2 = await ok("admin", "GET", `/entries?limit=2&cursor=${encodeURIComponent(page1.page.next_cursor)}`);
      expect(ids_of(page2).filter((x) => ids_of(page1).includes(x))).toEqual([]);
      expect((await call("admin", "GET", `/entries?limit=2&kind=merit&cursor=${encodeURIComponent(page1.page.next_cursor)}`)).statusCode).toBe(400);
      expect((await call("teacher2", "GET", `/entries?limit=2&cursor=${encodeURIComponent(page1.page.next_cursor)}`)).statusCode).toBe(400);
      await q(`INSERT INTO behaviour_entries (tenant_id, learner_id, category_id, kind, points, occurred_on) VALUES ($1, $2, $3, 'demerit', -2, $4::date)`, [ids.tenantB, id.bella, id.bCat, today]);
      expect((await ok("admin", "GET", "/entries?limit=200")).entries.map((e: Json) => e.learner_name)).not.toContain("Bella of School B");
    });

    it("classes and recorders", async () => {
      const office = await ok("admin", "GET", "/classes");
      conforms("GET", "/classes", 200, office);
      expect(office.classes.map((c: Json) => c.name)).toEqual(expect.arrayContaining(["BH X", "BH Y", "BH Z"]));
      expect(office.classes.map((c: Json) => c.name)).not.toContain("BHB class");
      expect((await ok("teacher", "GET", "/classes")).classes.map((c: Json) => c.name)).toEqual(["BH X"]);
      expect((await ok("teacher2", "GET", "/classes")).classes.map((c: Json) => c.name)).toEqual(["BH Y"]);
      expect((await ok("teacher3", "GET", "/classes")).classes).toEqual([]);
      const rec = await ok("admin", "GET", "/recorders");
      conforms("GET", "/recorders", 200, rec);
      expect(rec.recorders.map((r: Json) => r.full_name)).toEqual(expect.arrayContaining(["Teacher A", "Teacher Two", "Admin A"]));
      expect(rec.recorders.map((r: Json) => r.user_id)).not.toContain(ids.parentA);
    });
  });

  // ---------------------------------------------------------------- voiding

  describe("voiding", () => {
    let mine: string;
    let others: string;
    let danOnly: string;
    beforeAll(async () => {
      mine = (await recordOk("teacher", { learner_ids: [id.alice], kind: "demerit", category_id: cat["Late to class"], note: "void-mine" }))[0]!;
      others = (await recordOk("admin", { learner_ids: [id.alice], kind: "demerit", category_id: cat["Late to class"], note: "void-others" }))[0]!;
      danOnly = (await recordOk("admin", { learner_ids: [id.dan], kind: "demerit", category_id: cat["Late to class"], note: "void-dan" }))[0]!;
    });
    const voidIt = (who: string, entry: string, reason: unknown = "Recorded in error") => call(who, "POST", `/entries/${entry}/void`, { reason });

    it("who recorded an entry, and only they or the office, may void it", async () => {
      // a teacher who may read the entry (the learner is taught) but did not record it
      expect((await voidIt("teacher", others)).statusCode).toBe(403);
      // a teacher who may not read it at all: not found, not forbidden
      expect((await voidIt("teacher", danOnly)).statusCode).toBe(404);
      expect((await voidIt("teacher3", mine)).statusCode).toBe(404);
      expect((await voidIt("feesTeacher", mine)).statusCode).toBe(404);
      for (const who of ["parent", "student", "driver", "staffer"]) expect((await voidIt(who, mine)).statusCode, who).toBe(403);
      expect((await voidIt("adminB", mine)).statusCode).toBe(403);
      expect((await q(`SELECT voided_at FROM behaviour_entries WHERE id = ANY($1)`, [[mine, others, danOnly]])).rows.every((r) => r.voided_at === null)).toBe(true);
    });

    it("the recorder voids their own; it stays in the log, struck through, with the reason and who", async () => {
      const res = await voidIt("teacher", mine);
      expect(res.statusCode, res.body).toBe(200);
      conforms("POST", "/entries/{entryId}/void", 200, res.json());
      expect(res.json().entry).toMatchObject({ id: mine, void_reason: "Recorded in error" });
      expect(res.json().entry.voided_at).not.toBeNull();
      expect((await q(`SELECT voided_by FROM behaviour_entries WHERE id = $1`, [mine])).rows[0].voided_by).toBe(ids.teacherA);
      expect((await voidIt("teacher", mine)).statusCode, "twice").toBe(409);
      expect((await voidIt("admin", mine)).statusCode, "twice, by the office").toBe(409);
      expect((await q(`SELECT detail FROM security_audit_events WHERE event_type = 'academics.behaviour.voided' AND actor_user_id = $1`, [ids.teacherA])).rows[0].detail).toEqual({ entryId: mine });
    });

    it("the office voids anyone's entry; the reason is 3 to 300 characters", async () => {
      for (const bad of ["", "ab", "  ab ", "x".repeat(301), 5, null]) expect((await voidIt("admin", others, bad)).statusCode, JSON.stringify(bad)).toBe(400);
      expect((await call("admin", "POST", `/entries/${others}/void`, {})).statusCode).toBe(400);
      expect((await call("admin", "POST", `/entries/${others}/void`, { reason: "Wrong learner", extra: 1 })).statusCode).toBe(400);
      expect((await voidIt("admin", others, "Wrong learner")).statusCode).toBe(200);
      expect((await voidIt("office", danOnly, "Wrong learner")).statusCode).toBe(200);
      expect((await voidIt("admin", randomUUID())).statusCode).toBe(404);
      expect((await call("admin", "POST", "/entries/not-a-uuid/void", { reason: "Wrong learner" })).statusCode).toBe(400);
    });

    it("a voided entry leaves the log unless asked for, and stops counting", async () => {
      const without = (await ok("admin", "GET", "/entries?limit=200")).entries.map((e: Json) => e.id);
      expect(without).not.toContain(mine);
      expect(without).not.toContain(others);
      const withVoided = (await ok("admin", "GET", "/entries?limit=200&include_voided=true")).entries.map((e: Json) => e.id);
      expect(withVoided).toEqual(expect.arrayContaining([mine, others, danOnly]));
      expect((await ok("teacher", "GET", "/entries?limit=200&include_voided=true")).entries.map((e: Json) => e.id)).toContain(mine);
    });

    it("another school's entry is not found", async () => {
      const bEntry = (await q(`SELECT id FROM behaviour_entries WHERE tenant_id = $1 LIMIT 1`, [ids.tenantB])).rows[0].id as string;
      expect((await voidIt("admin", bEntry)).statusCode).toBe(404);
      expect((await q(`SELECT voided_at FROM behaviour_entries WHERE id = $1`, [bEntry])).rows[0].voided_at).toBeNull();
    });
  });

  // ---------------------------------------------------------------- points

  describe("points", () => {
    let pat: string;
    let pam: string;
    let pia: string;
    beforeAll(async () => {
      pat = await learnerIn(ids.tenantA, id.X!, id.year!, "Pat Points");
      pam = await learnerIn(ids.tenantA, id.X!, id.year!, "Pam Points");
      pia = await learnerIn(ids.tenantA, id.Y!, id.year!, "Pia Points");
      await setSettings({ reset: "term" });
      const base = (kind: string, category: string, extra: Json) => ({ learner_ids: [pat], kind, category_id: cat[category], ...extra });
      await recordOk("admin", base("merit", "Leadership", { points: 5, occurred_on: day(-10) }));
      await recordOk("admin", base("merit", "Helping others", { occurred_on: day(-9) }));
      await recordOk("admin", base("demerit", "Disrespect", { points: 4, occurred_on: day(-8) }));
      await recordOk("admin", base("demerit", "Late to class", { occurred_on: day(-7) }));
      // before this term (term 2 starts 40 days ago, term 1 ran 100 to 60 days ago) but in this year
      await recordOk("admin", base("merit", "Leadership", { points: 6, occurred_on: day(-60) }));
      // a voided entry never counts
      const voided = (await recordOk("admin", base("demerit", "Fighting", { occurred_on: day(-6) })))[0]!;
      await call("admin", "POST", `/entries/${voided}/void`, { reason: "Wrong child" });
      await recordOk("admin", { learner_ids: [pia], kind: "merit", category_id: cat["Leadership"], points: 2 });
    });

    it("lists the learners in scope with their points, by name; nobody outside the scope", async () => {
      const body = await ok("admin", "GET", "/points?limit=200");
      conforms("GET", "/points", 200, body);
      const names = (body.learners as Json[]).map((l) => l.full_name);
      expect(names).toEqual([...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
      expect(names).toEqual(expect.arrayContaining(["Alice", "Pat Points", "Dan", "Zed"]));
      expect(names).not.toContain("Eve (archived)");
      expect(names).not.toContain("Bella of School B");
      expect((await ok("teacher", "GET", "/points?limit=200")).learners.map((l: Json) => l.full_name)).toEqual(expect.arrayContaining(["Alice", "Pat Points", "Pam Points"]));
      expect((await ok("teacher", "GET", "/points?limit=200")).learners.map((l: Json) => l.full_name)).not.toContain("Pia Points");
      expect((await ok("teacher2", "GET", "/points?limit=200")).learners.map((l: Json) => l.full_name).sort()).toEqual(["Dan", "Pia Points"]);
      expect((await ok("teacher3", "GET", "/points")).learners).toEqual([]);
      const filtered = await ok("admin", "GET", `/points?class_id=${id.Y}&limit=200`);
      expect(filtered.learners.map((l: Json) => l.class_name)).toEqual(["BH Y", "BH Y"]);
      expect((await ok("teacher", "GET", `/points?class_id=${id.Y}`)).learners, "a class a teacher does not teach").toEqual([]);
      expect((await ok("admin", "GET", `/points?learner_ids=${pat},${pam}`)).learners.map((l: Json) => l.full_name)).toEqual(["Pam Points", "Pat Points"]);
    });

    it("both: merits add and demerits take away, in this term only", async () => {
      await setSettings({ mode: "both", reset: "term" });
      const p = await pointsOf("admin", pat);
      expect(p).toMatchObject({ merit_points: 7, demerit_points: -5, balance: 2, period_start: day(-40), period_end: day(49) });
      expect(await pointsOf("admin", pam)).toMatchObject({ merit_points: 0, demerit_points: 0, balance: 0 });
    });

    it("merits only and demerits only", async () => {
      await setSettings({ mode: "merits_only", reset: "term" });
      expect(await pointsOf("admin", pat)).toMatchObject({ merit_points: 7, demerit_points: -5, balance: 7 });
      await setSettings({ mode: "demerits_only", reset: "term", starting_points: 50 });
      expect(await pointsOf("admin", pat)).toMatchObject({ merit_points: 7, demerit_points: -5, balance: 45 });
      expect(await pointsOf("admin", pam)).toMatchObject({ balance: 50 });
    });

    it("points off: totals are still counted, the balance is null", async () => {
      await setSettings({ points_enabled: false });
      expect(await pointsOf("admin", pat)).toMatchObject({ merit_points: 7, demerit_points: -5, balance: null });
    });

    it("the period: a term, a year (from its first term to the next year's first term), or never", async () => {
      await setSettings({ mode: "both", reset: "year" });
      expect(await pointsOf("admin", pat)).toMatchObject({ merit_points: 13, demerit_points: -5, balance: 8, period_start: day(-100), period_end: day(119) });
      await setSettings({ mode: "both", reset: "never" });
      expect(await pointsOf("admin", pat)).toMatchObject({ merit_points: 13, demerit_points: -5, balance: 8, period_start: null, period_end: null });
      await setSettings({ mode: "both", reset: "term" });
      // `on` moves the period: a day in term 1 counts only the entry of that term, not today's
      expect(await pointsOf("admin", pat, `&on=${day(-60)}`)).toMatchObject({ merit_points: 6, demerit_points: 0, period_start: day(-100), period_end: day(-41) });
      expect(await pointsOf("admin", pat, `&on=${day(-10)}`)).toMatchObject({ merit_points: 5, demerit_points: 0 }); // entries after `on` do not count
    });

    it("the query is validated and paged", async () => {
      for (const bad of ["on=2026-13-40", "class_id=x", "learner_ids=x", `learner_ids=${randomUUID()},nope`, `learner_ids=${Array.from({ length: 101 }, () => randomUUID()).join(",")}`]) {
        expect((await call("admin", "GET", `/points?${bad}`)).statusCode, bad).toBe(400);
      }
      const p1 = await ok("admin", "GET", "/points?limit=2");
      expect(p1.learners).toHaveLength(2);
      const p2 = await ok("admin", "GET", `/points?limit=2&cursor=${encodeURIComponent(p1.page.next_cursor)}`);
      expect(p2.learners.map((l: Json) => l.learner_id).filter((x: string) => p1.learners.some((l: Json) => l.learner_id === x))).toEqual([]);
      expect((await call("teacher", "GET", `/points?limit=2&cursor=${encodeURIComponent(p1.page.next_cursor)}`)).statusCode).toBe(400);
    });
  });
});
