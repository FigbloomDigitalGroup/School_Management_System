import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSpec, responseSchema, validate } from "./support/openapiConformance.js";
import { createTestApp, type FixtureIds } from "./support.js";

/**
 * Higher-education section instructors (migration 107, docs/TEACHER-READS.md Part 3), through the real figbloom_app login.
 *
 * Write side (an administrator names, changes and clears a section's instructor) and read side (a lecturer reads their own
 * sections and their roster). Negative first: another lecturer's section, a section with no instructor, another school's
 * section, an instructor id of another school, an archived instructor, a parent, a student, a driver, a person with no staff
 * record, an archived record, an archived learner, a withdrawn enrolment, a cursor replayed by someone else, a school that is not
 * a higher-education school.
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
type Row = Record<string, any>;
type Method = "GET" | "POST" | "PATCH";

const SPEC = {
  list: "/v1/tenants/{tenantId}/me/teaching/he-sections",
  roster: "/v1/tenants/{tenantId}/me/teaching/he-sections/{sectionId}/enrolments",
  patch: "/v1/tenants/{tenantId}/he-sections/{sectionId}",
};

/** The rows made in `beforeAll`, by what they are (typed, so a misspelt key is a compile error, not an `undefined` id). */
interface Ids {
  // members of school A (user ids)
  lec1: string; lec2: string; nolink: string; student: string; driver: string;
  // a school administrator of school B
  adminB: string;
  // staff records: two lecturers, a visitor with no sign-in, a retired (archived) professor; and school B's lecturer
  sL1: string; sL2: string; sVisit: string; sOld: string; sB: string;
  // calendar
  year: string; t1: string; t2: string; tB: string;
  // courses, and sections S1..S4 of school A (S4 has no instructor) and SB of school B
  cs101: string; ma201: string; bb100: string;
  S1: string; S2: string; S3: string; S4: string; SB: string;
  // learners, and the enrolment that is later withdrawn
  ada: string; ben: string; cy: string; dee: string; bea: string; cyEnrolment: string;
}

describe("higher-education section instructor, and a lecturer's own sections and roster", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  const spec = loadSpec();
  const tok: Record<string, string> = {};
  const id = {} as Ids;

  const send = (method: Method, who: string | null, path: string, opts: { tenant?: string; header?: string; payload?: unknown; key?: string } = {}) => {
    const tenant = opts.tenant ?? ids.tenantA;
    return ctx.app.inject({
      method,
      url: `/v1/tenants/${tenant}${path}`,
      headers: {
        ...(who ? { authorization: `Bearer ${tok[who]}` } : {}),
        "x-tenant-id": opts.header ?? tenant,
        ...(opts.key ? { "idempotency-key": opts.key } : {}),
      },
      ...(opts.payload === undefined ? {} : { payload: opts.payload as Record<string, unknown> }),
    });
  };
  const get = (who: string | null, path: string, opts: { tenant?: string; header?: string } = {}) => send("GET", who, path, opts);
  const patch = (who: string | null, sectionId: string, payload: unknown, opts: { tenant?: string; header?: string } = {}) =>
    send("PATCH", who, `/he-sections/${sectionId}`, { ...opts, payload });
  const sections = async (who: string, opts: { tenant?: string } = {}): Promise<Row[]> => {
    const res = await get(who, "/me/teaching/he-sections", opts);
    expect(res.statusCode, `${who} ${res.body}`).toBe(200);
    return res.json().sections as Row[];
  };
  const roster = async (who: string, sectionId: string): Promise<Row[]> => {
    const res = await get(who, `/me/teaching/he-sections/${sectionId}/enrolments`);
    expect(res.statusCode, `${who} ${res.body}`).toBe(200);
    return res.json().enrolments as Row[];
  };
  const labels = (rows: Row[]) => rows.map((r) => `${r.course_code} ${r.label}`);
  const names = (rows: Row[]) => rows.map((r) => String(r.full_name));
  const conforms = (method: string, specPath: string, body: unknown, status = 200) => {
    const schema = responseSchema(spec, method, specPath, status);
    expect(typeof schema, specPath).toBe("object");
    const errs = validate(spec, schema, body);
    expect(errs, `${specPath}: ${errs.join("; ")}`).toEqual([]);
  };
  const q = (sql: string, params: unknown[] = []) => ctx.pool.query(sql, params);
  const one = async (sql: string, params: unknown[]) => (await q(sql, params)).rows[0].id as string;
  const audits = async (sectionId: string): Promise<Row[]> =>
    (
      await q(
        `SELECT detail, actor_user_id FROM security_audit_events
          WHERE event_type = 'academics.he.section.instructor_changed' AND detail->>'sectionId' = $1 ORDER BY occurred_at, id`,
        [sectionId],
      )
    ).rows;
  const instructorOf = async (sectionId: string) => (await q(`SELECT instructor_staff_id FROM he_sections WHERE id = $1`, [sectionId])).rows[0].instructor_staff_id as string | null;

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
  const staff = (tenant: string, name: string, userId: string | null, archived = false) =>
    one(
      `INSERT INTO staff_members (tenant_id, full_name, classification, user_id, active, archived_at)
       VALUES ($1, $2, 'teacher', $3, $4, CASE WHEN $4 THEN NULL ELSE now() END) RETURNING id`,
      [tenant, name, userId, !archived],
    );
  /** Run `fn` with a row temporarily changed by the owner, then put it back. */
  async function whileChanged(change: string, undo: string, params: unknown[], fn: () => Promise<void>): Promise<void> {
    await q(change, params);
    try {
      await fn();
    } finally {
      await q(undo, params);
    }
  }
  async function created(who: string, tenant: string, path: string, payload: unknown, key: string): Promise<string> {
    const res = await send("POST", who, path, { tenant, payload });
    expect(res.statusCode, `POST ${path} ${res.body}`).toBe(201);
    return res.json()[key].id as string;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    const A = ids.tenantA;
    const B = ids.tenantB;
    for (const t of [A, B]) {
      await q(
        `INSERT INTO school_profiles (tenant_id, institution_type) VALUES ($1, 'higher_ed') ON CONFLICT (tenant_id) DO UPDATE SET institution_type = 'higher_ed'`,
        [t],
      );
    }

    id.lec1 = await member("Lecturer One", "teacher", "TC-0002", A);
    id.lec2 = await member("Lecturer Two", "teacher", "TC-0003", A);
    id.nolink = await member("Lecturer Unlinked", "teacher", "TC-0004", A); // a teacher member whose staff record was never linked
    id.student = await member("Student One", "student", "ST-0001", A);
    id.driver = await member("Driver One", "driver", "DR-0001", A);
    id.adminB = await member("Admin B", "school_admin", "AD-0002", B);

    id.sL1 = await staff(A, "Dr One", id.lec1);
    id.sL2 = await staff(A, "Dr Two", id.lec2);
    id.sVisit = await staff(A, "Visiting Professor", null); // a staff record with no sign-in
    id.sOld = await staff(A, "Retired Professor", null, true); // archived
    id.sB = await staff(B, "Dr B", ids.teacherB);

    id.year = await one(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on, is_current) VALUES ($1, 'HE 2026', '2026-01-01', '2026-12-31', true) RETURNING id`, [A]);
    id.t1 = await one(`INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on, is_current) VALUES ($1, $2, 1, 'Semester 1 2026', '2026-01-05', '2026-05-30', true) RETURNING id`, [A, id.year]);
    id.t2 = await one(`INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on, is_current) VALUES ($1, $2, 2, 'Semester 2 2026', '2026-08-03', '2026-12-18', false) RETURNING id`, [A, id.year]);
    const yearB = await one(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on, is_current) VALUES ($1, 'HEB 2026', '2026-01-01', '2026-12-31', true) RETURNING id`, [B]);
    id.tB = await one(`INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on, is_current) VALUES ($1, $2, 1, 'B Semester 1', '2026-01-05', '2026-05-30', true) RETURNING id`, [B, yearB]);

    tok.admin = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: "correct-horse-battery" } })).json().token;
    tok.adminB = await login(B, "AD-0002");
    tok.lec1 = await login(A, "TC-0002");
    tok.lec2 = await login(A, "TC-0003");
    tok.nolink = await login(A, "TC-0004");
    tok.teacherA = await login(A, "TC-0001"); // a teacher member with no staff record and no sections
    tok.parent = await login(A, "PT-0001");
    tok.student = await login(A, "ST-0001");
    tok.driver = await login(A, "DR-0001");
    tok.teacherB = await login(B, "TC-0001");

    // Courses and sections, made through the API by each school's administrator.
    id.cs101 = await created("admin", A, "/he-courses", { code: "CS101", title: "Data Structures" }, "course");
    id.ma201 = await created("admin", A, "/he-courses", { code: "MA201", title: "Linear Algebra" }, "course");
    id.bb100 = await created("adminB", B, "/he-courses", { code: "BB100", title: "B Basics" }, "course");
    id.S1 = await created("admin", A, "/he-sections", { course_id: id.cs101, term_id: id.t1, label: "A", instructor_staff_id: id.sL1 }, "section");
    id.S2 = await created("admin", A, "/he-sections", { course_id: id.cs101, term_id: id.t2, label: "B", instructor_staff_id: id.sL1 }, "section");
    id.S3 = await created("admin", A, "/he-sections", { course_id: id.ma201, term_id: id.t1, label: "A", instructor_staff_id: id.sL2 }, "section");
    id.S4 = await created("admin", A, "/he-sections", { course_id: id.ma201, term_id: id.t1, label: "B" }, "section"); // no instructor yet
    id.SB = await created("adminB", B, "/he-sections", { course_id: id.bb100, term_id: id.tB, label: "A", instructor_staff_id: id.sB }, "section");

    // Learners and enrolments (made through the API; a withdrawal and an archived learner need the owner).
    const learner = async (tenant: string, admission: string, name: string) =>
      one(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, $3, 'female') RETURNING id`, [tenant, admission, name]);
    id.ada = await learner(A, "HE-001", "Ada Mwangi");
    id.ben = await learner(A, "HE-002", "Ben Otieno");
    id.cy = await learner(A, "HE-003", "Cy Kamau"); // withdrawn from S1
    id.dee = await learner(A, "HE-004", "Dee Njeri"); // archived after enrolling in S1
    id.bea = await learner(B, "HEB-001", "Bea Bondo");
    const enrol = (who: string, tenant: string, section: string, learnerId: string) => created(who, tenant, "/he-enrolments", { section_id: section, learner_id: learnerId }, "enrolment");
    await enrol("admin", A, id.S1, id.ada);
    await enrol("admin", A, id.S1, id.ben);
    id.cyEnrolment = await enrol("admin", A, id.S1, id.cy);
    await enrol("admin", A, id.S1, id.dee);
    await enrol("admin", A, id.S2, id.ada);
    await enrol("admin", A, id.S3, id.ben);
    await enrol("adminB", B, id.SB, id.bea);
    await q(`UPDATE he_enrolments SET status = 'withdrawn' WHERE id = $1`, [id.cyEnrolment]);
    await q(`UPDATE learners SET active = false, archived_at = now() WHERE id = $1`, [id.dee]);
  }, 240_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  // ------------------------------------------------------------------------------------------------ write side

  describe("naming the instructor (an administrator)", () => {
    it("the list carries each section's instructor, and the courseId and sectionId filters narrow it", async () => {
      const res = await get("admin", "/he-sections");
      expect(res.statusCode, res.body).toBe(200);
      conforms("GET", "/v1/tenants/{tenantId}/he-sections", res.json());
      const byId = new Map((res.json().sections as Row[]).map((s) => [s.id, s]));
      expect(byId.get(id.S1)!.instructor_staff_id).toBe(id.sL1);
      expect(byId.get(id.S3)!.instructor_staff_id).toBe(id.sL2);
      expect(byId.get(id.S4)!.instructor_staff_id).toBeNull();
      expect(byId.has(id.SB)).toBe(false); // another school's section is not in this school's list

      const cs = await get("admin", `/he-sections?courseId=${id.cs101}`);
      expect((cs.json().sections as Row[]).map((s) => s.id).sort()).toEqual([id.S1, id.S2].sort());
      expect((await get("admin", "/he-sections?courseId=not-a-uuid")).statusCode).toBe(400);

      const en = await get("admin", `/he-enrolments?sectionId=${id.S1}`);
      expect(en.statusCode, en.body).toBe(200);
      expect((en.json().enrolments as Row[]).map((e) => e.learner_id).sort()).toEqual([id.ada, id.ben, id.cy, id.dee].sort());
      expect((await get("admin", `/he-enrolments?sectionId=${id.S3}`)).json().enrolments).toHaveLength(1);
      expect((await get("admin", "/he-enrolments?sectionId=not-a-uuid")).statusCode).toBe(400);
    });

    it("POST names an instructor, audits it, and a replay with the same Idempotency-Key returns the same section", async () => {
      const key = `he-section-${randomUUID()}`;
      const body = { course_id: id.cs101, term_id: id.t2, label: "Idem", instructor_staff_id: id.sVisit };
      const first = await send("POST", "admin", "/he-sections", { payload: body, key });
      expect(first.statusCode, first.body).toBe(201);
      expect(first.json().section).toMatchObject({ label: "Idem", instructor_staff_id: id.sVisit });
      const second = await send("POST", "admin", "/he-sections", { payload: body, key });
      expect(second.statusCode, second.body).toBe(201);
      expect(second.headers["idempotent-replayed"]).toBe("true");
      expect(second.json().section).toEqual(first.json().section);
      const events = await audits(first.json().section.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.detail).toEqual({ sectionId: first.json().section.id, fromStaffMemberId: null, toStaffMemberId: id.sVisit });
      expect(events[0]!.actor_user_id).toBe(ids.adminA);
    });

    it("POST with no instructor, or null, makes a section with none and records nothing; a duplicate label is still 409", async () => {
      const made = await send("POST", "admin", "/he-sections", { payload: { course_id: id.cs101, term_id: id.t2, label: "NoOne" } });
      expect(made.statusCode, made.body).toBe(201);
      expect(made.json().section.instructor_staff_id).toBeNull();
      const withNull = await send("POST", "admin", "/he-sections", { payload: { course_id: id.cs101, term_id: id.t2, label: "NullOne", instructor_staff_id: null } });
      expect(withNull.statusCode, withNull.body).toBe(201);
      expect(withNull.json().section.instructor_staff_id).toBeNull();
      expect(await audits(made.json().section.id)).toEqual([]);
      expect(await audits(withNull.json().section.id)).toEqual([]);
      const dup = await send("POST", "admin", "/he-sections", { payload: { course_id: id.cs101, term_id: id.t2, label: "NoOne", instructor_staff_id: id.sVisit } });
      expect(dup.statusCode).toBe(409);
    });

    it("POST refuses an unknown, an archived and another school's staff id (the same 400), and creates nothing", async () => {
      const before = (await q(`SELECT count(*)::int AS n FROM he_sections WHERE tenant_id = $1`, [ids.tenantA])).rows[0].n;
      for (const [why, staffId] of [["unknown", randomUUID()], ["archived", id.sOld], ["another school", id.sB]] as const) {
        const res = await send("POST", "admin", "/he-sections", { payload: { course_id: id.cs101, term_id: id.t2, label: `Bad-${why}`.slice(0, 20), instructor_staff_id: staffId } });
        expect(res.statusCode, `${why} ${res.body}`).toBe(400);
        expect(res.json().error.message).toBe("instructor_staff_id must be an active staff member in this school");
      }
      expect((await send("POST", "admin", "/he-sections", { payload: { course_id: id.cs101, term_id: id.t2, label: "BadId", instructor_staff_id: "not-a-uuid" } })).statusCode).toBe(400);
      expect((await q(`SELECT count(*)::int AS n FROM he_sections WHERE tenant_id = $1`, [ids.tenantA])).rows[0].n).toBe(before);
    });

    it("PATCH names, changes and clears the instructor; each change is audited with the old and the new staff id, and a repeat records nothing", async () => {
      expect(await instructorOf(id.S4)).toBeNull();
      const named = await patch("admin", id.S4, { instructor_staff_id: id.sVisit });
      expect(named.statusCode, named.body).toBe(200);
      conforms("PATCH", SPEC.patch, named.json());
      expect(named.json().section).toMatchObject({ id: id.S4, course_id: id.ma201, term_id: id.t1, label: "B", instructor_staff_id: id.sVisit });

      const changed = await patch("admin", id.S4, { instructor_staff_id: id.sL2 });
      expect(changed.json().section.instructor_staff_id).toBe(id.sL2);
      const again = await patch("admin", id.S4, { instructor_staff_id: id.sL2 }); // the same instructor: nothing changes
      expect(again.statusCode).toBe(200);
      expect(again.json().section.instructor_staff_id).toBe(id.sL2);
      const cleared = await patch("admin", id.S4, { instructor_staff_id: null });
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(cleared.json().section.instructor_staff_id).toBeNull();
      expect((await patch("admin", id.S4, { instructor_staff_id: null })).statusCode).toBe(200); // clearing a section with none

      expect(await instructorOf(id.S4)).toBeNull();
      const events = await audits(id.S4);
      expect(events.map((e) => [e.detail.fromStaffMemberId, e.detail.toStaffMemberId])).toEqual([
        [null, id.sVisit],
        [id.sVisit, id.sL2],
        [id.sL2, null],
      ]);
      for (const e of events) expect(Object.keys(e.detail).sort()).toEqual(["fromStaffMemberId", "sectionId", "toStaffMemberId"]); // ids only: no names
      const listed = (await get("admin", "/he-sections")).json().sections as Row[];
      expect(listed.find((s) => s.id === id.S4)!.instructor_staff_id).toBeNull();
    });

    it("PATCH refuses a bad body, an unknown, archived or other-school staff id, and an unknown section, and changes nothing", async () => {
      for (const [why, body, status] of [
        ["empty body", {}, 400],
        ["not a uuid", { instructor_staff_id: "nope" }, 400],
        ["a number", { instructor_staff_id: 7 }, 400],
        ["another field", { instructor_staff_id: null, label: "Z" }, 400],
        ["only another field", { label: "Z" }, 400],
        ["unknown staff", { instructor_staff_id: randomUUID() }, 400],
        ["archived staff", { instructor_staff_id: id.sOld }, 400],
        ["another school's staff", { instructor_staff_id: id.sB }, 400],
      ] as const) {
        const res = await patch("admin", id.S4, body);
        expect(res.statusCode, `${why} ${res.body}`).toBe(status);
      }
      expect(await instructorOf(id.S4)).toBeNull();
      expect((await patch("admin", randomUUID(), { instructor_staff_id: id.sL1 })).statusCode).toBe(404);
      expect((await patch("admin", "not-a-uuid", { instructor_staff_id: id.sL1 })).statusCode).toBe(400);
      // another school's section, named in this school's path, does not exist for this school (RLS); its own instructor is untouched
      const auditsBefore = (await audits(id.SB)).length; // the one made when B's administrator created the section with its instructor
      expect((await patch("admin", id.SB, { instructor_staff_id: id.sL1 })).statusCode).toBe(404);
      expect(await instructorOf(id.SB)).toBe(id.sB);
      expect(await audits(id.SB)).toHaveLength(auditsBefore);
      expect(auditsBefore).toBe(1);
    });

    it("PATCH keeps an instructor who was archived later (a form that sends it back unchanged still saves)", async () => {
      await patch("admin", id.S4, { instructor_staff_id: id.sVisit });
      try {
        await whileChanged(
          `UPDATE staff_members SET active = false, archived_at = now() WHERE id = $1`,
          `UPDATE staff_members SET active = true, archived_at = NULL WHERE id = $1`,
          [id.sVisit],
          async () => {
            expect((await patch("admin", id.S4, { instructor_staff_id: id.sVisit })).statusCode).toBe(200);
            expect((await patch("admin", id.S4, { instructor_staff_id: id.sL1 })).statusCode).toBe(200); // moving to an active one is allowed
            expect((await patch("admin", id.S4, { instructor_staff_id: id.sVisit })).statusCode).toBe(400); // naming the archived one again is not
          },
        );
      } finally {
        await patch("admin", id.S4, { instructor_staff_id: null });
      }
      expect(await instructorOf(id.S4)).toBeNull();
    });

    it("PATCH needs the Academics write permission: a lecturer, a parent, a student, a driver, another school's administrator and an anonymous caller are refused", async () => {
      for (const who of ["lec1", "teacherA", "parent", "student", "driver"]) {
        const res = await patch(who, id.S4, { instructor_staff_id: id.sL1 });
        expect(res.statusCode, who).toBe(403);
        expect(res.json().error.code).toBe("forbidden");
      }
      expect((await patch("adminB", id.S4, { instructor_staff_id: id.sL1 })).statusCode).toBe(403); // B's path rule: not a member of A
      expect((await patch("adminB", id.S4, { instructor_staff_id: id.sL1 }, { tenant: ids.tenantB })).statusCode).toBe(404); // in B's own path the section is not there
      expect((await patch(null, id.S4, { instructor_staff_id: id.sL1 })).statusCode).toBe(401);
      expect(await instructorOf(id.S4)).toBeNull();
      // a lecturer cannot read the school-wide lists either: the teaching reads are the only way in
      expect((await get("lec1", "/he-sections")).statusCode).toBe(403);
      expect((await get("lec1", `/he-enrolments?sectionId=${id.S3}`)).statusCode).toBe(403);
    });

    it("the database keeps the instructor in the same school, and the runtime role may change only that column", async () => {
      const fk = await q(
        `SELECT confdeltype, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'he_sections'::regclass AND conname = 'he_sections_instructor_fk'`,
      );
      expect(fk.rows).toHaveLength(1);
      expect(fk.rows[0].confdeltype).toBe("r"); // RESTRICT
      expect(fk.rows[0].def).toContain("(instructor_staff_id, tenant_id)");
      // the owner is not stopped by row security, so this is the constraint itself answering
      await expect(q(`UPDATE he_sections SET instructor_staff_id = $2 WHERE id = $1`, [id.S4, id.sB])).rejects.toMatchObject({ code: "23503" });
      await expect(q(`DELETE FROM staff_members WHERE id = $1`, [id.sL1])).rejects.toMatchObject({ code: "23503" }); // a section never loses its instructor silently
      const priv = await q(
        `SELECT has_column_privilege('figbloom_app', 'public.he_sections', 'instructor_staff_id', 'UPDATE') AS instructor,
                has_column_privilege('figbloom_app', 'public.he_sections', 'label', 'UPDATE') AS label,
                has_column_privilege('figbloom_app', 'public.he_sections', 'course_id', 'UPDATE') AS course,
                has_column_privilege('figbloom_app', 'public.he_sections', 'tenant_id', 'UPDATE') AS tenant,
                has_table_privilege('figbloom_app', 'public.he_sections', 'DELETE') AS del`,
      );
      expect(priv.rows[0]).toEqual({ instructor: true, label: false, course: false, tenant: false, del: false });
      expect(await instructorOf(id.S4)).toBeNull();
    });

    it("a school that is not a higher-education school is refused on every route", async () => {
      await whileChanged(
        `UPDATE school_profiles SET institution_type = 'k12' WHERE tenant_id = $1`,
        `UPDATE school_profiles SET institution_type = 'higher_ed' WHERE tenant_id = $1`,
        [ids.tenantA],
        async () => {
          expect((await patch("admin", id.S4, { instructor_staff_id: id.sL1 })).statusCode).toBe(400);
          expect((await send("POST", "admin", "/he-sections", { payload: { course_id: id.cs101, term_id: id.t2, label: "K12", instructor_staff_id: id.sL1 } })).statusCode).toBe(400);
          expect((await get("lec1", "/me/teaching/he-sections")).statusCode).toBe(400);
          expect((await get("lec1", `/me/teaching/he-sections/${id.S1}/enrolments`)).statusCode).toBe(400);
        },
      );
      expect((await get("lec1", "/me/teaching/he-sections")).statusCode).toBe(200);
    });
  });

  // ------------------------------------------------------------------------------------------------ GET /me/teaching/he-sections

  describe("GET /me/teaching/he-sections", () => {
    it("a lecturer reads the sections they instruct, with course, term, label and the learners enrolled now, and nothing else", async () => {
      const res = await get("lec1", "/me/teaching/he-sections");
      expect(res.statusCode, res.body).toBe(200);
      conforms("GET", SPEC.list, res.json());
      const rows = res.json().sections as Row[];
      expect(labels(rows)).toEqual(["CS101 A", "CS101 B"]);
      expect(rows[0]).toEqual({
        id: id.S1,
        course_id: id.cs101,
        course_code: "CS101",
        course_title: "Data Structures",
        term_id: id.t1,
        term_label: "Semester 1 2026",
        label: "A",
        enrolled_count: 2, // Ada and Ben: Cy withdrew, Dee was archived
      });
      expect(rows[1]).toMatchObject({ id: id.S2, term_label: "Semester 2 2026", enrolled_count: 1 });
      expect(labels(await sections("lec2"))).toEqual(["MA201 A"]);
      expect((await sections("lec2"))[0]).toMatchObject({ id: id.S3, enrolled_count: 1 });
    });

    it("a member with no sections gets an empty list, not an error (no staff link, no instructor role, an administrator)", async () => {
      for (const who of ["nolink", "teacherA", "admin"]) expect(await sections(who), who).toEqual([]);
    });

    it("the enrolled count follows the roster: a withdrawal and an archived learner drop out at once", async () => {
      const count = async () => (await sections("lec1")).find((s) => s.id === id.S1)!.enrolled_count;
      expect(await count()).toBe(2);
      await whileChanged(
        `UPDATE learners SET active = false, archived_at = now() WHERE id = $1`,
        `UPDATE learners SET active = true, archived_at = NULL WHERE id = $1`,
        [id.ada],
        async () => expect(await count()).toBe(1),
      );
      await whileChanged(
        `UPDATE he_enrolments SET status = 'withdrawn' WHERE section_id = $1 AND learner_id = $2`,
        `UPDATE he_enrolments SET status = 'enrolled' WHERE section_id = $1 AND learner_id = $2`,
        [id.S1, id.ben],
        async () => expect(await count()).toBe(1),
      );
      expect(await count()).toBe(2);
    });

    it("changing the instructor moves the section at once; clearing it removes it from everyone", async () => {
      try {
        expect((await patch("admin", id.S1, { instructor_staff_id: id.sL2 })).statusCode).toBe(200);
        expect(labels(await sections("lec1"))).toEqual(["CS101 B"]);
        expect(labels(await sections("lec2"))).toEqual(["CS101 A", "MA201 A"]);
        expect((await patch("admin", id.S1, { instructor_staff_id: null })).statusCode).toBe(200);
        expect(labels(await sections("lec1"))).toEqual(["CS101 B"]);
        expect(labels(await sections("lec2"))).toEqual(["MA201 A"]);
      } finally {
        await patch("admin", id.S1, { instructor_staff_id: id.sL1 });
      }
      expect(labels(await sections("lec1"))).toEqual(["CS101 A", "CS101 B"]);
    });

    it("an archived staff record, or one linked to someone else, does not make a lecturer the instructor", async () => {
      await whileChanged(
        `UPDATE staff_members SET active = false, archived_at = now() WHERE id = $1`,
        `UPDATE staff_members SET active = true, archived_at = NULL WHERE id = $1`,
        [id.sL1],
        async () => expect(await sections("lec1")).toEqual([]),
      );
      // "The instructor" is whoever the staff record is linked to: move the link to another account and the sections follow it.
      await q(`UPDATE staff_members SET user_id = $2 WHERE id = $1`, [id.sL1, id.nolink]);
      try {
        expect(await sections("lec1")).toEqual([]);
        expect(labels(await sections("nolink"))).toEqual(["CS101 A", "CS101 B"]);
      } finally {
        await q(`UPDATE staff_members SET user_id = $2 WHERE id = $1`, [id.sL1, id.lec1]);
      }
      expect(labels(await sections("lec1"))).toEqual(["CS101 A", "CS101 B"]);
      expect(await sections("nolink")).toEqual([]);
    });

    it("another school: never its sections, and its path or header is refused", async () => {
      expect(labels(await sections("teacherB", { tenant: ids.tenantB }))).toEqual(["BB100 A"]);
      expect((await get("teacherB", "/me/teaching/he-sections")).statusCode).toBe(403);
      expect((await get("lec1", "/me/teaching/he-sections", { tenant: ids.tenantB })).statusCode).toBe(403);
      expect((await get("lec1", "/me/teaching/he-sections", { header: ids.tenantB })).statusCode).toBe(403);
    });

    it("a parent, a student and a driver get the audited 403, and a parent wrongly linked to a staff record who is named instructor is still refused", async () => {
      for (const who of ["parent", "student", "driver"]) {
        const res = await get(who, "/me/teaching/he-sections");
        expect(res.statusCode, who).toBe(403);
        expect(res.json().error.code).toBe("forbidden");
      }
      const denied = await q(
        `SELECT 1 FROM security_audit_events WHERE actor_user_id = $1 AND event_type = 'rbac.permission.denied' AND detail->>'permission' = 'resource.teaching.read'`,
        [ids.parentA],
      );
      expect(denied.rowCount).toBeGreaterThan(0);
      const linked = await staff(ids.tenantA, "Parent as staff", ids.parentA);
      await q(`UPDATE he_sections SET instructor_staff_id = $2 WHERE id = $1`, [id.S4, linked]);
      try {
        expect((await get("parent", "/me/teaching/he-sections")).statusCode).toBe(403);
        expect((await get("parent", `/me/teaching/he-sections/${id.S4}/enrolments`)).statusCode).toBe(403);
      } finally {
        await q(`UPDATE he_sections SET instructor_staff_id = NULL WHERE id = $1`, [id.S4]);
        await q(`UPDATE staff_members SET user_id = NULL, active = false, archived_at = now() WHERE id = $1`, [linked]);
      }
    });

    it("an archived membership and a suspended school get 403; a disabled account and anonymous get 401", async () => {
      await whileChanged(
        `UPDATE school_memberships SET archived_at = now() WHERE user_id = $1 AND tenant_id = $2`,
        `UPDATE school_memberships SET archived_at = NULL WHERE user_id = $1 AND tenant_id = $2`,
        [id.lec1, ids.tenantA],
        async () => expect((await get("lec1", "/me/teaching/he-sections")).statusCode).toBe(403),
      );
      await whileChanged(
        `UPDATE tenants SET status = 'suspended' WHERE id = $1`,
        `UPDATE tenants SET status = 'active' WHERE id = $1`,
        [ids.tenantA],
        async () => expect((await get("lec1", "/me/teaching/he-sections")).statusCode).toBe(403),
      );
      await whileChanged(
        `UPDATE users SET status = 'disabled' WHERE id = $1`,
        `UPDATE users SET status = 'active' WHERE id = $1`,
        [id.lec1],
        async () => expect((await get("lec1", "/me/teaching/he-sections")).statusCode).toBe(401),
      );
      expect((await get(null, "/me/teaching/he-sections")).statusCode).toBe(401);
    });

    it("pages in a fixed order, and a cursor cannot be replayed by another lecturer; sort is refused", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 5; i++) {
        const res = await get("lec1", `/me/teaching/he-sections?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        expect(res.statusCode, res.body).toBe(200);
        const body = res.json();
        expect(body.sections.length).toBeLessThanOrEqual(1);
        seen.push(...labels(body.sections as Row[]));
        cursor = body.page.next_cursor as string | null;
        if (!cursor) break;
      }
      expect(seen).toEqual(["CS101 A", "CS101 B"]);
      const first = await get("lec1", "/me/teaching/he-sections?limit=1");
      const token = first.json().page.next_cursor as string;
      expect(token).toBeTruthy();
      expect((await get("lec2", `/me/teaching/he-sections?limit=1&cursor=${encodeURIComponent(token)}`)).statusCode).toBe(400);
      expect((await get("lec1", "/me/teaching/he-sections?sort=label")).statusCode).toBe(400);
      expect((await get("lec1", "/me/teaching/he-sections?limit=0")).statusCode).toBe(400);
    });
  });

  // ------------------------------------------------------------------------------------------------ roster

  describe("GET /me/teaching/he-sections/{sectionId}/enrolments", () => {
    const path = (sectionId: string) => `/me/teaching/he-sections/${sectionId}/enrolments`;

    it("the instructor reads the learners enrolled in the section: name and admission number (with ids), by name, and nobody else", async () => {
      const res = await get("lec1", path(id.S1));
      expect(res.statusCode, res.body).toBe(200);
      conforms("GET", SPEC.roster, res.json());
      const rows = res.json().enrolments as Row[];
      expect(names(rows)).toEqual(["Ada Mwangi", "Ben Otieno"]); // not Cy (withdrawn) and not Dee (archived)
      expect(rows.map((r) => r.admission_no)).toEqual(["HE-001", "HE-002"]);
      expect(rows.map((r) => r.learner_id)).toEqual([id.ada, id.ben]);
      for (const r of rows) expect(Object.keys(r).sort()).toEqual(["admission_no", "full_name", "id", "learner_id"]); // no date of birth, gender, boarding or contacts
      expect(rows.length).toBe((await sections("lec1")).find((s) => s.id === id.S1)!.enrolled_count);
      expect(names(await roster("lec2", id.S3))).toEqual(["Ben Otieno"]);
      expect(names(await roster("lec1", id.S2))).toEqual(["Ada Mwangi"]);
    });

    it("another lecturer's section, a section with no instructor, another school's section and an unknown section are all 404 (and a malformed id 400)", async () => {
      const bodies = new Set<string>();
      for (const [why, who, sectionId] of [
        ["another lecturer's", "lec1", id.S3],
        ["the other way round", "lec2", id.S1],
        ["no instructor", "lec1", id.S4],
        ["another school's", "lec1", id.SB],
        ["unknown", "lec1", randomUUID()],
        ["a teacher with no staff record", "nolink", id.S1],
        ["a teacher who instructs nothing", "teacherA", id.S1],
        ["an administrator who does not instruct it", "admin", id.S1],
      ] as const) {
        const res = await get(who, path(sectionId));
        expect(res.statusCode, `${why} ${res.body}`).toBe(404);
        expect(res.json().error.code).toBe("not_found");
        bodies.add(res.json().error.message);
      }
      expect([...bodies]).toEqual(["Section not found"]); // the answer never says which of the cases it was
      expect((await get("lec1", path("not-a-uuid"))).statusCode).toBe(400);
      // another school's lecturer cannot reach this school's section either
      expect((await get("teacherB", path(id.S1), { tenant: ids.tenantB })).statusCode).toBe(404);
    });

    it("a parent, a student and a driver are refused (403) even for a section that exists; an anonymous caller is 401", async () => {
      for (const who of ["parent", "student", "driver"]) expect((await get(who, path(id.S1))).statusCode, who).toBe(403);
      expect((await get(null, path(id.S1))).statusCode).toBe(401);
    });

    it("another school: its lecturer reads its own roster there, and its path or header is refused", async () => {
      const res = await get("teacherB", path(id.SB), { tenant: ids.tenantB });
      expect(res.statusCode, res.body).toBe(200);
      expect(names(res.json().enrolments as Row[])).toEqual(["Bea Bondo"]);
      expect((await get("teacherB", path(id.SB))).statusCode).toBe(403);
      expect((await get("lec1", path(id.S1), { tenant: ids.tenantB })).statusCode).toBe(403);
      expect((await get("lec1", path(id.S1), { header: ids.tenantB })).statusCode).toBe(403);
    });

    it("the roster follows the instructor: clearing or moving it takes the section away from the former instructor at once", async () => {
      try {
        expect((await patch("admin", id.S1, { instructor_staff_id: id.sL2 })).statusCode).toBe(200);
        expect((await get("lec1", path(id.S1))).statusCode).toBe(404);
        expect(names(await roster("lec2", id.S1))).toEqual(["Ada Mwangi", "Ben Otieno"]);
        expect((await patch("admin", id.S1, { instructor_staff_id: null })).statusCode).toBe(200);
        expect((await get("lec2", path(id.S1))).statusCode).toBe(404);
      } finally {
        await patch("admin", id.S1, { instructor_staff_id: id.sL1 });
      }
      expect(names(await roster("lec1", id.S1))).toEqual(["Ada Mwangi", "Ben Otieno"]);
    });

    it("a withdrawn enrolment, an archived learner, an archived staff record and an archived membership stop the read or the row", async () => {
      await whileChanged(
        `UPDATE learners SET active = false, archived_at = now() WHERE id = $1`,
        `UPDATE learners SET active = true, archived_at = NULL WHERE id = $1`,
        [id.ada],
        async () => expect(names(await roster("lec1", id.S1))).toEqual(["Ben Otieno"]),
      );
      await whileChanged(
        `UPDATE staff_members SET active = false, archived_at = now() WHERE id = $1`,
        `UPDATE staff_members SET active = true, archived_at = NULL WHERE id = $1`,
        [id.sL1],
        async () => expect((await get("lec1", path(id.S1))).statusCode).toBe(404),
      );
      await whileChanged(
        `UPDATE school_memberships SET archived_at = now() WHERE user_id = $1 AND tenant_id = $2`,
        `UPDATE school_memberships SET archived_at = NULL WHERE user_id = $1 AND tenant_id = $2`,
        [id.lec1, ids.tenantA],
        async () => expect((await get("lec1", path(id.S1))).statusCode).toBe(403),
      );
      await whileChanged(
        `UPDATE tenants SET status = 'suspended' WHERE id = $1`,
        `UPDATE tenants SET status = 'active' WHERE id = $1`,
        [ids.tenantA],
        async () => expect((await get("lec1", path(id.S1))).statusCode).toBe(403),
      );
      await whileChanged(
        `UPDATE users SET status = 'disabled' WHERE id = $1`,
        `UPDATE users SET status = 'active' WHERE id = $1`,
        [id.lec1],
        async () => expect((await get("lec1", path(id.S1))).statusCode).toBe(401),
      );
      expect(names(await roster("lec1", id.S1))).toEqual(["Ada Mwangi", "Ben Otieno"]);
    });

    it("pages by name, and sort is refused", async () => {
      const first = await get("lec1", `${path(id.S1)}?limit=1`);
      expect(first.statusCode, first.body).toBe(200);
      expect(names(first.json().enrolments as Row[])).toEqual(["Ada Mwangi"]);
      const token = first.json().page.next_cursor as string;
      expect(token).toBeTruthy();
      const second = await get("lec1", `${path(id.S1)}?limit=1&cursor=${encodeURIComponent(token)}`);
      expect(names(second.json().enrolments as Row[])).toEqual(["Ben Otieno"]);
      expect(second.json().page.next_cursor).toBeNull();
      // a cursor from one section is not accepted on another
      expect((await get("lec1", `${path(id.S2)}?limit=1&cursor=${encodeURIComponent(token)}`)).statusCode).toBe(400);
      expect((await get("lec1", `${path(id.S1)}?sort=name`)).statusCode).toBe(400);
    });
  });
});
