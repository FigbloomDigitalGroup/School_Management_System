import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSpec, responseSchema, validate } from "./support/openapiConformance.js";
import { createTestApp, type FixtureIds } from "./support.js";

/**
 * Teacher reads, part 2 (docs/TEACHER-READS.md, "Content of the classes I teach" and "My items"), through the real
 * figbloom_app login. Negative first: for each read, the teacher's own classes give exactly their rows, and every other caller
 * or state (another class's teacher, no assignment, no linked or an archived staff record, an ended assignment, an archived
 * class, another school, an archived membership, a suspended school, a disabled account, a parent, a student, a driver, a
 * parent wrongly linked to a staff record, a cursor replayed by someone else) gets nothing more.
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
type Row = Record<string, unknown>;

/** What each content read returns for the fixtures below (titles). */
const CONTENT = [
  {
    path: "/me/teaching/homework-items",
    adminPath: "/homework-items",
    spec: "/v1/tenants/{tenantId}/me/teaching/homework-items",
    key: "homework",
    teacherA: ["HW X english", "HW X maths", "HW Z"],
    teacherAInX: ["HW X english", "HW X maths"],
    teacher2: ["HW Y"],
    withoutX: ["HW Z"],
    withoutZ: ["HW X english", "HW X maths"],
    inB: ["HW B"],
  },
  {
    path: "/me/teaching/learning-materials",
    adminPath: "/learning-materials",
    spec: "/v1/tenants/{tenantId}/me/teaching/learning-materials",
    key: "materials",
    // "Mat all" names no class: shared with every class, so a teacher of at least one class reads it too.
    teacherA: ["Mat X", "Mat Z", "Mat all"],
    teacherAInX: ["Mat X"],
    teacher2: ["Mat Y", "Mat all"],
    withoutX: ["Mat Z", "Mat all"],
    withoutZ: ["Mat X", "Mat all"],
    inB: ["Mat B"],
  },
  {
    path: "/me/teaching/online-exam-papers",
    adminPath: "/online-exam-papers",
    spec: "/v1/tenants/{tenantId}/me/teaching/online-exam-papers",
    key: "papers",
    teacherA: ["Paper X", "Paper Z"],
    teacherAInX: ["Paper X"],
    teacher2: ["Paper Y"],
    withoutX: ["Paper Z"],
    withoutZ: ["Paper X"],
    inB: ["Paper B"],
  },
] as const;

const isoDay = (offsetDays: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

describe("teacher reads, part 2: class content and my items", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  const spec = loadSpec();
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
  const list = async (who: string, path: string, key: string, opts: { tenant?: string } = {}): Promise<Row[]> => {
    const res = await get(who, path, opts);
    expect(res.statusCode, `${who} ${path} ${res.body}`).toBe(200);
    return res.json()[key] as Row[];
  };
  const titles = (rows: Row[]) => rows.map((r) => String(r.title)).sort();
  const post = async (who: string, tenant: string, path: string, payload: unknown): Promise<Record<string, any>> => {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${tenant}${path}`,
      headers: { authorization: `Bearer ${tok[who]}`, "x-tenant-id": tenant },
      payload: payload as Record<string, unknown>,
    });
    expect([200, 201], `POST ${path} ${res.body}`).toContain(res.statusCode);
    return res.json();
  };
  const conforms = (specPath: string, body: unknown) => {
    const schema = responseSchema(spec, "GET", specPath, 200);
    expect(typeof schema, specPath).toBe("object");
    const errs = validate(spec, schema, body);
    expect(errs, `${specPath}: ${errs.join("; ")}`).toEqual([]);
  };
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
    id.adminB = await member("Admin B", "school_admin", "AD-0002", B);

    id.y26 = await one(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on, is_current) VALUES ($1, 'SC 2026', '2026-01-01', '2026-12-31', true) RETURNING id`, [A]);
    id.t26 = await one(`INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on, is_current) VALUES ($1, $2, 1, 'SC 2026 T1', '2026-01-05', '2026-12-18', true) RETURNING id`, [A, id.y26]);
    id.maths = await one(`INSERT INTO subjects (tenant_id, code, name) VALUES ($1, 'SCM', 'SC Maths') RETURNING id`, [A]);
    id.english = await one(`INSERT INTO subjects (tenant_id, code, name) VALUES ($1, 'SCE', 'SC English') RETURNING id`, [A]);

    id.sA = await staff(A, "Teacher A", ids.teacherA);
    id.s2 = await staff(A, "Teacher Two", id.teacher2);
    id.s3 = await staff(A, "Teacher Three", id.teacher3); // linked, teaches nothing
    id.sC = await staff(A, "Colleague C", null); // no account, teaches English in X
    await staff(A, "Teacher Four record", null); // Teacher Four's record was never linked

    id.X = await klass(A, id.y26, "SC X"); // Teacher A teaches Maths, Colleague C English
    id.Z = await klass(A, id.y26, "SC Z", id.sA); // Teacher A is class teacher
    id.Y = await klass(A, id.y26, "SC Y", id.s2); // Teacher Two's
    id.aX = await assign(A, id.sA, id.X, id.maths);
    await assign(A, id.sC, id.X, id.english);
    await assign(A, id.s2, id.Y, id.maths);

    const yB = await one(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on, is_current) VALUES ($1, 'SCB 2026', '2026-01-01', '2026-12-31', true) RETURNING id`, [B]);
    const tB = await one(`INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on, is_current) VALUES ($1, $2, 1, 'SCB 2026 T1', '2026-01-05', '2026-12-18', true) RETURNING id`, [B, yB]);
    const mathsB = await one(`INSERT INTO subjects (tenant_id, code, name) VALUES ($1, 'SCB', 'SCB Maths') RETURNING id`, [B]);
    const sB = await staff(B, "Teacher B", ids.teacherB);
    id.CB = await klass(B, yB, "SCB class", sB);

    tok.admin = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: "correct-horse-battery" } })).json().token;
    tok.adminB = await login(B, "AD-0002");
    tok.teacherA = await login(A, "TC-0001");
    tok.teacher2 = await login(A, "TC-0002");
    tok.teacher3 = await login(A, "TC-0003");
    tok.teacher4 = await login(A, "TC-0004");
    tok.parent = await login(A, "PT-0001");
    tok.student = await login(A, "ST-0001");
    tok.driver = await login(A, "DR-0001");
    tok.teacherB = await login(B, "TC-0001");

    // Content, made through the API by each school's administrator (materials need an object key the API makes itself).
    const hw = (who: string, tenant: string, classId: string, subjectId: string, termId: string, title: string, due: number) =>
      post(who, tenant, "/homework-items", { class_id: classId, subject_id: subjectId, term_id: termId, title, due_on: isoDay(due), body: `${title} instructions` });
    await hw("admin", A, id.X, id.maths, id.t26, "HW X maths", 5);
    await hw("admin", A, id.X, id.english, id.t26, "HW X english", 6);
    await hw("admin", A, id.Z, id.maths, id.t26, "HW Z", 7);
    await hw("admin", A, id.Y, id.maths, id.t26, "HW Y", 8);
    await hw("adminB", B, id.CB, mathsB, tB, "HW B", 5);

    await post("admin", A, "/learning-materials", { title: "Mat X", class_id: id.X, subject_id: id.maths });
    await post("admin", A, "/learning-materials", { title: "Mat Z", class_id: id.Z, subject_id: id.maths });
    await post("admin", A, "/learning-materials", { title: "Mat Y", class_id: id.Y, subject_id: id.maths });
    await post("admin", A, "/learning-materials", { title: "Mat all" });
    await post("adminB", B, "/learning-materials", { title: "Mat B", class_id: id.CB, subject_id: mathsB });

    await post("admin", A, "/online-exam-papers", { class_id: id.X, subject_id: id.maths, title: "Paper X", max_score: 10 });
    await post("admin", A, "/online-exam-papers", { class_id: id.Z, subject_id: id.maths, title: "Paper Z", max_score: 20 });
    await post("admin", A, "/online-exam-papers", { class_id: id.Y, subject_id: id.maths, title: "Paper Y", max_score: 30 });
    await post("adminB", B, "/online-exam-papers", { class_id: id.CB, subject_id: mathsB, title: "Paper B", max_score: 40 });
  }, 240_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  describe.each(CONTENT)("GET $path", (c) => {
    it("a teacher reads the rows of the classes they teach and nothing else, in the same shape as the admin read", async () => {
      const res = await get("teacherA", c.path);
      expect(res.statusCode, res.body).toBe(200);
      conforms(c.spec, res.json());
      const rows = res.json()[c.key] as Row[];
      expect(titles(rows)).toEqual([...c.teacherA]);
      const adminRows = await list("admin", c.adminPath, c.key);
      for (const r of rows) expect(adminRows.find((a) => a.id === r.id), String(r.title)).toEqual(r);
      expect(titles(await list("teacher2", c.path, c.key))).toEqual([...c.teacher2]);
    });

    it("classId narrows to one class; another teacher's class, another school's class and an unknown class give an empty list", async () => {
      const mine = await list("teacherA", `${c.path}?classId=${id.X}`, c.key);
      expect(titles(mine)).toEqual([...c.teacherAInX]);
      for (const other of [id.Y, id.CB, randomUUID()]) {
        expect(await list("teacherA", `${c.path}?classId=${other}`, c.key), other).toEqual([]);
      }
      expect((await get("teacherA", `${c.path}?classId=not-a-uuid`)).statusCode).toBe(400);
    });

    it("a teacher with no assignment, or with no linked staff record, gets an empty list", async () => {
      expect(await list("teacher3", c.path, c.key)).toEqual([]);
      expect(await list("teacher4", c.path, c.key)).toEqual([]);
    });

    it("an ended assignment, an archived class or an archived staff record stops the read", async () => {
      await whileChanged(
        `UPDATE teaching_assignments SET active = false, archived_at = now() WHERE id = $1`,
        `UPDATE teaching_assignments SET active = true, archived_at = NULL WHERE id = $1`,
        [id.aX],
        async () => expect(titles(await list("teacherA", c.path, c.key))).toEqual([...c.withoutX]),
      );
      await whileChanged(
        `UPDATE classes SET active = false, archived_at = now() WHERE id = $1`,
        `UPDATE classes SET active = true, archived_at = NULL WHERE id = $1`,
        [id.Z],
        async () => expect(titles(await list("teacherA", c.path, c.key))).toEqual([...c.withoutZ]),
      );
      await whileChanged(
        `UPDATE staff_members SET active = false, archived_at = now() WHERE id = $1`,
        `UPDATE staff_members SET active = true, archived_at = NULL WHERE id = $1`,
        [id.sA],
        async () => expect(await list("teacherA", c.path, c.key)).toEqual([]),
      );
      expect(titles(await list("teacherA", c.path, c.key))).toEqual([...c.teacherA]);
    });

    it("a parent, a student and a driver get the audited 403, and a parent wrongly linked to a staff record is still refused", async () => {
      for (const who of ["parent", "student", "driver"]) {
        const res = await get(who, c.path);
        expect(res.statusCode, who).toBe(403);
        expect(res.json().error.code).toBe("forbidden");
      }
      const audit = await q(
        `SELECT 1 FROM security_audit_events WHERE actor_user_id = $1 AND event_type = 'rbac.permission.denied' AND detail->>'permission' = 'resource.teaching.read'`,
        [ids.parentA],
      );
      expect(audit.rowCount).toBeGreaterThan(0);
      const linked = await staff(ids.tenantA, "Parent as staff", ids.parentA);
      await q(`UPDATE classes SET class_teacher_staff_id = $2 WHERE id = $1`, [id.X, linked]);
      try {
        expect((await get("parent", c.path)).statusCode).toBe(403);
      } finally {
        await q(`UPDATE classes SET class_teacher_staff_id = NULL WHERE id = $1`, [id.X]);
        await q(`UPDATE staff_members SET user_id = NULL, active = false, archived_at = now() WHERE id = $1`, [linked]);
      }
    });

    it("another school: never its rows, and its path or header is refused", async () => {
      expect(titles(await list("teacherB", c.path, c.key, { tenant: ids.tenantB }))).toEqual([...c.inB]);
      expect((await get("teacherB", c.path)).statusCode).toBe(403);
      expect((await get("teacherA", c.path, { tenant: ids.tenantB })).statusCode).toBe(403);
      expect((await get("teacherA", c.path, { header: ids.tenantB })).statusCode).toBe(403);
    });

    it("an archived membership and a suspended school get 403; a disabled account and anonymous get 401", async () => {
      await whileChanged(
        `UPDATE school_memberships SET archived_at = now() WHERE user_id = $1 AND tenant_id = $2`,
        `UPDATE school_memberships SET archived_at = NULL WHERE user_id = $1 AND tenant_id = $2`,
        [ids.teacherA, ids.tenantA],
        async () => expect((await get("teacherA", c.path)).statusCode).toBe(403),
      );
      await whileChanged(
        `UPDATE tenants SET status = 'suspended' WHERE id = $1`,
        `UPDATE tenants SET status = 'active' WHERE id = $1`,
        [ids.tenantA],
        async () => expect((await get("teacherA", c.path)).statusCode).toBe(403),
      );
      await whileChanged(
        `UPDATE users SET status = 'disabled' WHERE id = $1`,
        `UPDATE users SET status = 'active' WHERE id = $1`,
        [ids.teacherA],
        async () => expect((await get("teacherA", c.path)).statusCode).toBe(401),
      );
      expect((await ctx.app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantA}${c.path}` })).statusCode).toBe(401);
    });

    it("a school administrator holds the permission but teaches nothing here, so reads their own (empty) teaching list", async () => {
      expect(await list("admin", c.path, c.key)).toEqual([]);
      expect((await list("admin", c.adminPath, c.key)).length).toBeGreaterThanOrEqual(c.teacherA.length);
    });

    it("pages in a fixed order, and a cursor cannot be replayed by another teacher", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const res = await get("teacherA", `${c.path}?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        expect(res.statusCode, res.body).toBe(200);
        const body = res.json();
        seen.push(...(body[c.key] as Row[]).map((r) => String(r.title)));
        cursor = body.page.next_cursor as string | null;
        if (!cursor) break;
      }
      expect(seen.sort()).toEqual([...c.teacherA]);
      const first = await get("teacherA", `${c.path}?limit=1`);
      const token = first.json().page.next_cursor as string;
      expect(token).toBeTruthy();
      expect((await get("teacher2", `${c.path}?limit=1&cursor=${encodeURIComponent(token)}`)).statusCode).toBe(400);
      expect((await get("teacherA", `${c.path}?sort=title`)).statusCode).toBe(400);
    });
  });

  describe("learning materials: the ones that name no class", () => {
    const path = "/me/teaching/learning-materials";
    it("are shared with a teacher of at least one class, but not with a teacher of none, and not when the list is narrowed to a class", async () => {
      expect(titles(await list("teacherA", path, "materials"))).toContain("Mat all");
      expect(titles(await list("teacher2", path, "materials"))).toContain("Mat all");
      expect(titles(await list("teacher3", path, "materials"))).toEqual([]);
      expect(titles(await list("teacherA", `${path}?classId=${id.X}`, "materials"))).not.toContain("Mat all");
    });
  });

  describe("GET /me/inventory/issues", () => {
    const path = "/me/inventory/issues";
    const spec_ = "/v1/tenants/{tenantId}/me/inventory/issues";
    let returnedId: string;

    beforeAll(async () => {
      const A = ids.tenantA;
      const B = ids.tenantB;
      const item = async (who: string, tenant: string, body: Record<string, unknown>) => (await post(who, tenant, "/inventory/items", body)).item.id as string;
      const issue = async (who: string, tenant: string, body: Record<string, unknown>) => (await post(who, tenant, "/inventory/issues", body)).issue.id as string;
      const book = await item("admin", A, { name: "Maths textbook", category: "textbooks", tracking: "asset", asset_tag: "BK-001", location: "Store 1" });
      const balls = await item("admin", A, { name: "Netballs", category: "sports", tracking: "stock", quantity: 10, location: "Sports store" });
      const projector = await item("admin", A, { name: "Projector", category: "ict", tracking: "asset", asset_tag: "IT-007" });
      const jumper = await item("admin", A, { name: "School jumper", category: "uniforms", tracking: "asset", asset_tag: "UN-001" });
      const oldBook = await item("admin", A, { name: "Old atlas", category: "textbooks", tracking: "asset", asset_tag: "BK-002" });
      await issue("admin", A, { item_id: book, holder_user_id: ids.teacherA, due_on: isoDay(10) });
      await issue("admin", A, { item_id: balls, holder_user_id: ids.teacherA, quantity: 3 });
      await issue("admin", A, { item_id: projector, holder_user_id: id.teacher2 });
      // A learner's issue and a returned one are not "held" by anyone's account.
      const learnerId = await one(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, 'INV-1', 'Inv Learner', 'female') RETURNING id`, [A]);
      await issue("admin", A, { item_id: jumper, learner_id: learnerId });
      returnedId = await issue("admin", A, { item_id: oldBook, holder_user_id: ids.teacherA });
      await post("admin", A, `/inventory/issues/${returnedId}/close`, { status: "returned", returned_condition: "good" });
      const lamp = await item("adminB", B, { name: "School B lamp", category: "ict", tracking: "asset", asset_tag: "BL-1" });
      await issue("adminB", B, { item_id: lamp, holder_user_id: ids.teacherB });
    }, 60_000);

    it("a teacher reads the items held by them, newest first, and nothing else (no register, no other holder, no learner issue, no closed issue)", async () => {
      const res = await get("teacherA", path);
      expect(res.statusCode, res.body).toBe(200);
      conforms(spec_, res.json());
      const rows = res.json().issues as Row[];
      expect(rows.map((r) => r.item_name)).toEqual(["Netballs", "Maths textbook"]);
      for (const r of rows) {
        expect(Object.keys(r).sort()).toEqual(["asset_tag", "due_on", "id", "issued_at", "item_category", "item_id", "item_name", "quantity", "status"]);
        expect(r.status).toBe("out");
      }
      const book = rows.find((r) => r.item_name === "Maths textbook")!;
      expect(book).toMatchObject({ asset_tag: "BK-001", item_category: "textbooks", quantity: 1, due_on: isoDay(10) });
      expect(rows.find((r) => r.item_name === "Netballs")).toMatchObject({ asset_tag: null, quantity: 3, due_on: null });
      expect(rows.map((r) => r.id)).not.toContain(returnedId);
      expect((await list("teacher2", path, "issues")).map((r) => r.item_name)).toEqual(["Projector"]);
    });

    it("a member who holds nothing gets an empty list, not an error (own rows only), and nobody reads another person's items", async () => {
      for (const who of ["teacher3", "teacher4", "parent", "student", "driver", "admin"]) {
        expect(await list(who, path, "issues"), who).toEqual([]);
      }
    });

    it("another school: never its items, and its path or header is refused", async () => {
      expect((await list("teacherB", path, "issues", { tenant: ids.tenantB })).map((r) => r.item_name)).toEqual(["School B lamp"]);
      expect((await get("teacherB", path)).statusCode).toBe(403);
      expect((await get("teacherA", path, { tenant: ids.tenantB })).statusCode).toBe(403);
      expect((await get("teacherA", path, { header: ids.tenantB })).statusCode).toBe(403);
    });

    it("an archived membership and a suspended school get 403; a disabled account and anonymous get 401", async () => {
      await whileChanged(
        `UPDATE school_memberships SET archived_at = now() WHERE user_id = $1 AND tenant_id = $2`,
        `UPDATE school_memberships SET archived_at = NULL WHERE user_id = $1 AND tenant_id = $2`,
        [ids.teacherA, ids.tenantA],
        async () => expect((await get("teacherA", path)).statusCode).toBe(403),
      );
      await whileChanged(
        `UPDATE tenants SET status = 'suspended' WHERE id = $1`,
        `UPDATE tenants SET status = 'active' WHERE id = $1`,
        [ids.tenantA],
        async () => expect((await get("teacherA", path)).statusCode).toBe(403),
      );
      await whileChanged(
        `UPDATE users SET status = 'disabled' WHERE id = $1`,
        `UPDATE users SET status = 'active' WHERE id = $1`,
        [ids.teacherA],
        async () => expect((await get("teacherA", path)).statusCode).toBe(401),
      );
      expect((await ctx.app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantA}${path}` })).statusCode).toBe(401);
    });

    it("an item that is returned drops off the list at once; pages are bound to the caller", async () => {
      const first = await get("teacherA", `${path}?limit=1`);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().issues).toHaveLength(1);
      const token = first.json().page.next_cursor as string;
      expect(token).toBeTruthy();
      const second = await get("teacherA", `${path}?limit=1&cursor=${encodeURIComponent(token)}`);
      expect(second.json().issues.map((r: Row) => r.item_name)).toEqual(["Maths textbook"]);
      expect(second.json().page.next_cursor).toBeNull();
      expect((await get("teacher2", `${path}?limit=1&cursor=${encodeURIComponent(token)}`)).statusCode).toBe(400);

      const bookIssue = (await list("teacherA", path, "issues")).find((r) => r.item_name === "Maths textbook")!;
      await post("admin", ids.tenantA, `/inventory/issues/${bookIssue.id}/close`, { status: "returned" });
      expect((await list("teacherA", path, "issues")).map((r) => r.item_name)).toEqual(["Netballs"]);
    });
  });
});
