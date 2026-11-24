import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

/**
 * Teacher reads (docs/TEACHER-READS.md), through the real figbloom_app login. Negative first: for each read, the teacher's own
 * classes give exactly their data, and every other caller or state (another class's teacher, no assignment, no linked or an
 * archived staff record, an ended assignment, an archived class, an archived learner, an ended membership, another school, an
 * archived membership, a suspended school, a disabled account, a parent, a student, a driver, a parent wrongly linked to a
 * staff record) gets nothing more.
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

describe("teacher reads", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  const tok: Record<string, string> = {};
  const id: Record<string, string> = {};

  const get = (who: string, path: string, opts: { tenant?: string; header?: string } = {}) => {
    const tenant = opts.tenant ?? ids.tenantA;
    return ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${tenant}${path}`,
      headers: { authorization: `Bearer ${tok[who]}`, "x-tenant-id": opts.header ?? tenant },
    });
  };
  const ok = async (who: string, path: string, key: string, opts: { tenant?: string } = {}) => {
    const res = await get(who, path, opts);
    expect(res.statusCode, `${who} ${path} ${res.body}`).toBe(200);
    return res.json()[key] as Array<Record<string, unknown>>;
  };
  const learnerNames = async (who: string, query = "", tenant?: string) =>
    (await ok(who, `/me/teaching/learners${query}`, "learners", { tenant })).map((l) => l.full_name);
  const colleagueNames = async (who: string) => (await ok(who, "/me/teaching/colleagues", "colleagues")).map((c) => c.full_name);
  const yearLabels = async (who: string) => (await ok(who, "/academic-years", "academic_years")).map((y) => y.label).sort();
  const termLabels = async (who: string, query = "") => (await ok(who, `/academic-terms${query}`, "terms")).map((t) => t.label).sort();
  const q = (sql: string, params: unknown[] = []) => ctx.pool.query(sql, params);
  const one = async (sql: string, params: unknown[]) => (await q(sql, params)).rows[0].id as string;

  async function member(name: string, role: string, loginId: string, tenant: string): Promise<string> {
    const userId = randomUUID();
    await q(
      `INSERT INTO users (id, email, password_hash, full_name, status) SELECT $1, NULL, password_hash, $2, 'active' FROM users WHERE id = $3`,
      [userId, name, ids.adminA],
    );
    await q(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, $3, $4)`, [userId, tenant, role, loginId]);
    return userId;
  }
  async function login(tenantId: string, loginId: string): Promise<string> {
    const res = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId, loginId, password: "correct-horse-battery" } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().token as string;
  }
  const staff = (tenant: string, name: string, userId: string | null) =>
    one(`INSERT INTO staff_members (tenant_id, full_name, classification, user_id) VALUES ($1, $2, 'teacher', $3) RETURNING id`, [tenant, name, userId]);
  const klass = (tenant: string, year: string, name: string, classTeacher: string | null = null) =>
    one(`INSERT INTO classes (tenant_id, academic_year_id, name, class_teacher_staff_id) VALUES ($1, $2, $3, $4) RETURNING id`, [tenant, year, name, classTeacher]);
  const assign = (tenant: string, staffId: string, classId: string, subjectId: string) =>
    one(`INSERT INTO teaching_assignments (tenant_id, staff_member_id, class_id, subject_id) VALUES ($1, $2, $3, $4) RETURNING id`, [tenant, staffId, classId, subjectId]);
  async function learnerIn(tenant: string, classId: string, year: string, name: string): Promise<string> {
    const learnerId = await one(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, $3, 'female') RETURNING id`, [
      tenant,
      `TR-${randomUUID().slice(0, 8)}`,
      name,
    ]);
    await q(`INSERT INTO class_memberships (tenant_id, learner_id, class_id, academic_year_id) VALUES ($1, $2, $3, $4)`, [tenant, learnerId, classId, year]);
    return learnerId;
  }
  /** Run `fn` with a row temporarily changed by the owner, then put it back. */
  async function whileChanged(change: string, undo: string, params: unknown[], fn: () => Promise<void>): Promise<void> {
    await q(change, params);
    try {
      await fn();
    } finally {
      await q(undo, params);
    }
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    const A = ids.tenantA;
    const B = ids.tenantB;

    id.teacher2 = await member("Teacher Two", "teacher", "TC-0002", A);
    id.teacher3 = await member("Teacher Three", "teacher", "TC-0003", A);
    id.teacher4 = await member("Teacher Four", "teacher", "TC-0004", A);
    id.student = await member("Student One", "student", "ST-0001", A);
    id.driver = await member("Driver One", "driver", "DR-0001", A);
    id.office = await member("Office Staff", "staff", "SF-0001", A);

    // School A: year 2026 (taught by Teacher A and Teacher Two), year 2025 (Teacher Two only).
    id.y26 = await one(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on, is_current) VALUES ($1, 'TR 2026', '2026-01-01', '2026-12-31', true) RETURNING id`, [A]);
    id.y25 = await one(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on) VALUES ($1, 'TR 2025', '2025-01-01', '2025-12-31') RETURNING id`, [A]);
    id.t26 = await one(`INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on, is_current) VALUES ($1, $2, 1, 'TR 2026 T1', '2026-01-05', '2026-04-03', true) RETURNING id`, [A, id.y26]);
    id.t25 = await one(`INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on) VALUES ($1, $2, 1, 'TR 2025 T1', '2025-01-06', '2025-04-04') RETURNING id`, [A, id.y25]);
    id.maths = await one(`INSERT INTO subjects (tenant_id, code, name) VALUES ($1, 'TRM', 'TR Maths') RETURNING id`, [A]);
    id.english = await one(`INSERT INTO subjects (tenant_id, code, name) VALUES ($1, 'TRE', 'TR English') RETURNING id`, [A]);

    id.sA = await staff(A, "Teacher A", ids.teacherA);
    id.s2 = await staff(A, "Teacher Two", id.teacher2);
    id.s3 = await staff(A, "Teacher Three", id.teacher3); // linked, teaches nothing
    id.sC = await staff(A, "Colleague C", null); // no account, teaches English in X
    await staff(A, "Teacher Four record", null); // Teacher Four's record was never linked

    id.X = await klass(A, id.y26, "TR X"); // Teacher A teaches Maths, Colleague C English
    id.Z = await klass(A, id.y26, "TR Z", id.sA); // Teacher A is class teacher
    id.Y = await klass(A, id.y26, "TR Y", id.s2); // Teacher Two's
    id.W = await klass(A, id.y25, "TR W"); // last year, Teacher Two
    id.aX = await assign(A, id.sA, id.X, id.maths);
    await assign(A, id.sC, id.X, id.english);
    await assign(A, id.s2, id.Y, id.maths);
    await assign(A, id.s2, id.W, id.maths);

    id.alice = await learnerIn(A, id.X, id.y26, "Alice");
    id.brian = await learnerIn(A, id.X, id.y26, "Brian");
    id.cara = await learnerIn(A, id.Z, id.y26, "Cara");
    id.dan = await learnerIn(A, id.Y, id.y26, "Dan");
    id.wanda = await learnerIn(A, id.W, id.y25, "Wanda");
    id.eve = await learnerIn(A, id.X, id.y26, "Eve (archived)");
    await q(`UPDATE learners SET active = false, archived_at = now() WHERE id = $1`, [id.eve]);
    id.fay = await learnerIn(A, id.X, id.y26, "Fay (left)");
    await q(`UPDATE class_memberships SET active = false, archived_at = now() WHERE learner_id = $1`, [id.fay]);

    // School B: Teacher B (fixture TC-0001 in B) teaches one class with one learner.
    const yB = await one(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on, is_current) VALUES ($1, 'TRB 2026', '2026-01-01', '2026-12-31', true) RETURNING id`, [B]);
    const sB = await staff(B, "Teacher B", ids.teacherB);
    id.CB = await klass(B, yB, "TRB class", sB);
    await learnerIn(B, id.CB, yB, "Bella of School B");

    tok.admin = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: "correct-horse-battery" } })).json().token;
    tok.teacherA = await login(A, "TC-0001");
    tok.teacher2 = await login(A, "TC-0002");
    tok.teacher3 = await login(A, "TC-0003");
    tok.teacher4 = await login(A, "TC-0004");
    tok.parent = await login(A, "PT-0001");
    tok.student = await login(A, "ST-0001");
    tok.driver = await login(A, "DR-0001");
    tok.office = await login(A, "SF-0001");
    tok.teacherB = await login(B, "TC-0001");
  }, 240_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  describe("GET /me/teaching/learners", () => {
    it("a teacher reads the names of the active learners of the active classes they teach, and nothing else", async () => {
      const rows = await ok("teacherA", "/me/teaching/learners", "learners");
      expect(rows.map((r) => r.full_name)).toEqual(["Alice", "Brian", "Cara"]);
      for (const r of rows) expect(Object.keys(r).sort()).toEqual(["admission_no", "class_id", "full_name", "learner_id"]);
      expect(rows.find((r) => r.full_name === "Cara")!.class_id).toBe(id.Z);
      expect(await learnerNames("teacherA", `?classId=${id.X}`)).toEqual(["Alice", "Brian"]);
    });

    it("another teacher's class, a class of another year and an unknown class give an empty list, not an error", async () => {
      expect(await learnerNames("teacherA", `?classId=${id.Y}`)).toEqual([]);
      expect(await learnerNames("teacherA", `?classId=${id.W}`)).toEqual([]);
      expect(await learnerNames("teacherA", `?classId=${randomUUID()}`)).toEqual([]);
      expect(await learnerNames("teacher2")).toEqual(["Dan", "Wanda"]);
    });

    it("a teacher with no assignment, or with no linked staff record, gets an empty list", async () => {
      expect(await learnerNames("teacher3")).toEqual([]);
      expect(await learnerNames("teacher4")).toEqual([]);
    });

    it("an ended assignment, an archived class or an archived staff record stops the read", async () => {
      await whileChanged(
        `UPDATE teaching_assignments SET active = false, archived_at = now() WHERE id = $1`,
        `UPDATE teaching_assignments SET active = true, archived_at = NULL WHERE id = $1`,
        [id.aX],
        async () => expect(await learnerNames("teacherA")).toEqual(["Cara"]),
      );
      await whileChanged(
        `UPDATE classes SET active = false, archived_at = now() WHERE id = $1`,
        `UPDATE classes SET active = true, archived_at = NULL WHERE id = $1`,
        [id.Z],
        async () => expect(await learnerNames("teacherA")).toEqual(["Alice", "Brian"]),
      );
      await whileChanged(
        `UPDATE staff_members SET active = false, archived_at = now() WHERE id = $1`,
        `UPDATE staff_members SET active = true, archived_at = NULL WHERE id = $1`,
        [id.sA],
        async () => expect(await learnerNames("teacherA")).toEqual([]),
      );
      expect(await learnerNames("teacherA")).toEqual(["Alice", "Brian", "Cara"]);
    });

    it("pages by name", async () => {
      const first = await get("teacherA", "/me/teaching/learners?limit=2");
      expect(first.statusCode).toBe(200);
      expect(first.json().learners.map((l: { full_name: string }) => l.full_name)).toEqual(["Alice", "Brian"]);
      const cursor = first.json().page.next_cursor as string;
      expect(cursor).toBeTruthy();
      const second = await get("teacherA", `/me/teaching/learners?limit=2&cursor=${encodeURIComponent(cursor)}`);
      expect(second.json().learners.map((l: { full_name: string }) => l.full_name)).toEqual(["Cara"]);
      expect(second.json().page.next_cursor).toBeNull();
      // A cursor is bound to the caller's scope: another teacher cannot replay it.
      expect((await get("teacher2", `/me/teaching/learners?limit=2&cursor=${encodeURIComponent(cursor)}`)).statusCode).toBe(400);
    });

    it("a parent, a student and a driver get the audited 403", async () => {
      for (const who of ["parent", "student", "driver"]) {
        const res = await get(who, "/me/teaching/learners");
        expect(res.statusCode, who).toBe(403);
        expect(res.json().error.code).toBe("forbidden");
      }
      const audit = await q(
        `SELECT 1 FROM security_audit_events WHERE actor_user_id = $1 AND event_type = 'rbac.permission.denied' AND detail->>'permission' = 'resource.teaching.read'`,
        [ids.parentA],
      );
      expect(audit.rowCount).toBeGreaterThan(0);
    });

    it("a parent wrongly linked to a teaching staff record is still refused", async () => {
      const linked = await staff(ids.tenantA, "Parent as staff", ids.parentA);
      await q(`UPDATE classes SET class_teacher_staff_id = $2 WHERE id = $1`, [id.X, linked]);
      try {
        expect((await get("parent", "/me/teaching/learners")).statusCode).toBe(403);
        expect((await get("parent", "/me/teaching/colleagues")).statusCode).toBe(403);
        expect((await get("parent", "/academic-years")).statusCode).toBe(403);
        expect((await get("parent", "/academic-terms")).statusCode).toBe(403);
      } finally {
        await q(`UPDATE classes SET class_teacher_staff_id = NULL WHERE id = $1`, [id.X]);
        await q(`UPDATE staff_members SET user_id = NULL, active = false, archived_at = now() WHERE id = $1`, [linked]);
      }
    });

    it("another school: never its learners, and its path or header is refused", async () => {
      expect(await learnerNames("teacherB", "", ids.tenantB)).toEqual(["Bella of School B"]);
      expect((await get("teacherB", "/me/teaching/learners")).statusCode).toBe(403);
      expect((await get("teacherA", "/me/teaching/learners", { tenant: ids.tenantB })).statusCode).toBe(403);
      expect((await get("teacherA", "/me/teaching/learners", { header: ids.tenantB })).statusCode).toBe(403);
      expect((await get("teacherA", `/me/teaching/learners?classId=${id.CB}`)).json().learners).toEqual([]);
    });

    it("an archived membership and a suspended school get 403; a disabled account gets 401", async () => {
      await whileChanged(
        `UPDATE school_memberships SET archived_at = now() WHERE user_id = $1 AND tenant_id = $2`,
        `UPDATE school_memberships SET archived_at = NULL WHERE user_id = $1 AND tenant_id = $2`,
        [ids.teacherA, ids.tenantA],
        async () => {
          for (const p of ["/me/teaching/learners", "/me/teaching/colleagues", "/academic-years", "/chat/contacts"]) {
            expect((await get("teacherA", p)).statusCode, p).toBe(403);
          }
        },
      );
      await whileChanged(
        `UPDATE tenants SET status = 'suspended' WHERE id = $1`,
        `UPDATE tenants SET status = 'active' WHERE id = $1`,
        [ids.tenantA],
        async () => {
          for (const p of ["/me/teaching/learners", "/me/teaching/colleagues", "/academic-terms", "/chat/contacts"]) {
            expect((await get("teacherA", p)).statusCode, p).toBe(403);
          }
        },
      );
      await whileChanged(
        `UPDATE users SET status = 'disabled' WHERE id = $1`,
        `UPDATE users SET status = 'active' WHERE id = $1`,
        [ids.teacherA],
        async () => expect((await get("teacherA", "/me/teaching/learners")).statusCode).toBe(401),
      );
    });

    it("a school administrator holds the permission but teaches nothing here, and anonymous gets 401", async () => {
      expect(await learnerNames("admin")).toEqual([]);
      expect((await ctx.app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantA}/me/teaching/learners` })).statusCode).toBe(401);
    });
  });

  describe("GET /me/teaching/colleagues", () => {
    it("names the active staff who teach the caller's classes (the caller included), with no contact fields", async () => {
      const rows = await ok("teacherA", "/me/teaching/colleagues", "colleagues");
      expect(rows.map((r) => r.full_name)).toEqual(["Colleague C", "Teacher A"]);
      for (const r of rows) expect(Object.keys(r).sort()).toEqual(["full_name", "staff_member_id"]);
      expect(await colleagueNames("teacher2")).toEqual(["Teacher Two"]);
    });

    it("an ended assignment or an archived colleague drops out; no classes gives an empty list", async () => {
      await whileChanged(
        `UPDATE teaching_assignments SET active = false, archived_at = now() WHERE id = $1`,
        `UPDATE teaching_assignments SET active = true, archived_at = NULL WHERE id = $1`,
        [id.aX],
        async () => expect(await colleagueNames("teacherA")).toEqual(["Teacher A"]),
      );
      await whileChanged(
        `UPDATE staff_members SET active = false, archived_at = now() WHERE id = $1`,
        `UPDATE staff_members SET active = true, archived_at = NULL WHERE id = $1`,
        [id.sC],
        async () => expect(await colleagueNames("teacherA")).toEqual(["Teacher A"]),
      );
      expect(await colleagueNames("teacher3")).toEqual([]);
      expect(await colleagueNames("teacher4")).toEqual([]);
    });

    it("a parent, a student, a driver and another school's teacher are refused", async () => {
      for (const who of ["parent", "student", "driver", "teacherB"]) {
        expect((await get(who, "/me/teaching/colleagues")).statusCode, who).toBe(403);
      }
    });
  });

  describe("academic years and terms (widened for teachers)", () => {
    it("a teacher reads only the years of the classes they teach, and those years' terms", async () => {
      expect(await yearLabels("teacherA")).toEqual(["TR 2026"]);
      expect(await termLabels("teacherA")).toEqual(["TR 2026 T1"]);
      expect(await termLabels("teacherA", `?academicYearId=${id.y26}`)).toEqual(["TR 2026 T1"]);
      expect(await termLabels("teacherA", `?academicYearId=${id.y25}`)).toEqual([]);
      expect(await yearLabels("teacher2")).toEqual(["TR 2025", "TR 2026"]);
    });

    it("a year or term outside the teacher's classes is 404, like one that does not exist", async () => {
      expect((await get("teacherA", `/academic-years/${id.y26}`)).statusCode).toBe(200);
      expect((await get("teacherA", `/academic-terms/${id.t26}`)).statusCode).toBe(200);
      const outside = await get("teacherA", `/academic-years/${id.y25}`);
      const missing = await get("teacherA", `/academic-years/${randomUUID()}`);
      expect(outside.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(outside.json().error.message).toBe(missing.json().error.message);
      expect((await get("teacherA", `/academic-terms/${id.t25}`)).statusCode).toBe(404);
      expect((await get("teacherA", `/academic-terms/${randomUUID()}`)).statusCode).toBe(404);
    });

    it("an administrator still reads every year and term", async () => {
      expect(await yearLabels("admin")).toEqual(expect.arrayContaining(["TR 2025", "TR 2026"]));
      expect(await termLabels("admin")).toEqual(expect.arrayContaining(["TR 2025 T1", "TR 2026 T1"]));
      expect((await get("admin", `/academic-years/${id.y25}`)).statusCode).toBe(200);
    });

    it("a teacher who teaches nothing, or whose class was archived, gets the audited 403", async () => {
      for (const who of ["teacher3", "teacher4"]) {
        expect((await get(who, "/academic-years")).statusCode, who).toBe(403);
        expect((await get(who, "/academic-terms")).statusCode, who).toBe(403);
        expect((await get(who, `/academic-terms/${id.t26}`)).statusCode, who).toBe(403);
      }
      // Teacher Two's only 2025 class archived: the 2025 year leaves their scope.
      await whileChanged(
        `UPDATE classes SET active = false, archived_at = now() WHERE id = $1`,
        `UPDATE classes SET active = true, archived_at = NULL WHERE id = $1`,
        [id.W],
        async () => {
          expect(await yearLabels("teacher2")).toEqual(["TR 2026"]);
          expect((await get("teacher2", `/academic-terms/${id.t25}`)).statusCode).toBe(404);
        },
      );
    });

    it("a parent, a student, a driver and another school's teacher are refused; no write is opened", async () => {
      for (const who of ["parent", "student", "driver", "teacherB"]) {
        expect((await get(who, "/academic-years")).statusCode, who).toBe(403);
        expect((await get(who, `/academic-terms/${id.t26}`)).statusCode, who).toBe(403);
      }
      const write = await ctx.app.inject({
        method: "POST",
        url: `/v1/tenants/${ids.tenantA}/academic-terms`,
        headers: { authorization: `Bearer ${tok.teacherA}`, "x-tenant-id": ids.tenantA },
        payload: { academic_year_id: id.y26, index: 2, label: "Nope", starts_on: "2026-05-01", ends_on: "2026-07-31" },
      });
      expect(write.statusCode).toBe(403);
    });
  });

  describe("chat names", () => {
    const contacts = async (who: string) =>
      (await ok(who, "/chat/contacts", "contacts")).map((c) => `${c.full_name}:${c.role}`);

    it("a teacher's contacts are the other active staff-role members, named; never parents or students", async () => {
      const list = await contacts("teacherA");
      expect(list).toEqual(
        expect.arrayContaining(["Admin A:school_admin", "Teacher Two:teacher", "Driver One:driver", "Office Staff:staff"]),
      );
      expect(list.some((c) => c.startsWith("Teacher A:"))).toBe(false);
      expect(list.some((c) => c.startsWith("Parent A") || c.startsWith("Student One"))).toBe(false);
      for (const c of await ok("teacherA", "/chat/contacts", "contacts")) expect(Object.keys(c).sort()).toEqual(["full_name", "role", "user_id"]);
    });

    it("a disabled account and an archived membership drop out", async () => {
      await whileChanged(`UPDATE users SET status = 'disabled' WHERE id = $1`, `UPDATE users SET status = 'active' WHERE id = $1`, [id.teacher3], async () => {
        expect((await contacts("teacherA")).some((c) => c.startsWith("Teacher Three"))).toBe(false);
      });
      await whileChanged(
        `UPDATE school_memberships SET archived_at = now() WHERE user_id = $1`,
        `UPDATE school_memberships SET archived_at = NULL WHERE user_id = $1`,
        [id.office],
        async () => expect((await contacts("teacherA")).some((c) => c.startsWith("Office Staff"))).toBe(false),
      );
    });

    it("a parent and a student get an empty list; another school's teacher is refused", async () => {
      expect(await contacts("parent")).toEqual([]);
      expect(await contacts("student")).toEqual([]);
      expect((await get("teacherB", "/chat/contacts")).statusCode).toBe(403);
      // In their own school, Teacher B sees nobody from school A.
      const inB = (await ok("teacherB", "/chat/contacts", "contacts", { tenant: ids.tenantB })).map((c) => c.full_name);
      expect(inB.some((n) => ["Teacher A", "Teacher Two", "Admin A"].includes(n as string))).toBe(false);
    });

    it("each conversation names the other person and their role here (null once they leave)", async () => {
      const start = async (who: string, peer: string) => {
        const res = await ctx.app.inject({
          method: "POST",
          url: `/v1/tenants/${ids.tenantA}/chat/conversations`,
          headers: { authorization: `Bearer ${tok[who]}`, "x-tenant-id": ids.tenantA },
          payload: { peer_user_id: peer },
        });
        expect(res.statusCode, res.body).toBe(201);
      };
      await start("teacherA", id.teacher2!);
      await start("parent", ids.adminA);
      const peers = async (who: string) =>
        (await ok(who, "/chat/conversations", "conversations")).map((c) => `${c.peer_full_name}:${c.peer_role}`);
      expect(await peers("teacherA")).toEqual(["Teacher Two:teacher"]);
      expect(await peers("teacher2")).toEqual(["Teacher A:teacher"]);
      expect(await peers("admin")).toEqual(["Parent A:parent"]);
      expect(await peers("teacher3")).toEqual([]);
      await whileChanged(
        `UPDATE school_memberships SET archived_at = now() WHERE user_id = $1`,
        `UPDATE school_memberships SET archived_at = NULL WHERE user_id = $1`,
        [id.teacher2],
        async () => expect(await peers("teacherA")).toEqual(["Teacher Two:null"]),
      );
    });
  });
});
