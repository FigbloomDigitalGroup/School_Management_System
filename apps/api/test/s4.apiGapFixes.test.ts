import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/modules/identity/password.js";
import { createTestApp } from "./support.js";

/**
 * Web-on-the-API gap fixes (migration 101): a learner can go back into a class they left that year (finding 7),
 * archiving a learner ends their class membership (finding 8), a class can be updated (room, class teacher, level...)
 * and archived, a subject can be updated (level, year range, core flag), and a teaching assignment can change teacher
 * or end. Every new write is refused to a plain teacher, a People-only teacher, another school's administrator and an
 * anonymous caller, and a school's own administrator cannot reach another school's rows through their own school.
 */
const PASSWORD = "correct-horse-battery";
type Method = "GET" | "POST" | "PATCH";

describe("API gap fixes for the web (migration 101)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const A = () => ctx.ids.tenantA;
  const B = () => ctx.ids.tenantB;
  const tok: Record<string, string> = {};
  let yearId = "";
  let classX = "";
  let classY = "";
  let mathId = "";
  const staff: Record<string, string> = {};

  async function req(method: Method, path: string, token: string | null, body?: unknown, tenant = A(), extra: Record<string, string> = {}) {
    const res = await ctx.app.inject({
      method,
      url: `/v1/tenants/${tenant}${path}`,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "x-tenant-id": tenant, ...extra },
      ...(body === undefined ? {} : { payload: body as never }),
    });
    return { status: res.statusCode, json: () => res.json(), headers: res.headers };
  }
  const admin = (method: Method, path: string, body?: unknown) => req(method, path, tok.adminA!, body);

  async function login(body: Record<string, string>): Promise<string> {
    const r = await ctx.app.inject({ method: "POST", url: body.email ? "/v1/auth/login/email" : "/v1/auth/login/login-id", payload: body });
    expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
    return r.json().token as string;
  }
  async function member(email: string, tenant: string, role: string, loginId: string, area?: string): Promise<string> {
    const id = randomUUID();
    await ctx.pool.query(`INSERT INTO users (id, email, password_hash, full_name, status) VALUES ($1, $2, $3, $2, 'active')`, [
      id,
      email,
      await hashPassword(PASSWORD),
    ]);
    await ctx.pool.query(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, $3, $4)`, [id, tenant, role, loginId]);
    if (area) await ctx.pool.query(`INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, $3)`, [tenant, id, area]);
    return login({ email, password: PASSWORD });
  }
  async function newLearner(admission: string): Promise<string> {
    const r = await admin("POST", "/learners", { admission_no: admission, full_name: `Learner ${admission}`, gender: "female" });
    expect(r.status, JSON.stringify(r.json())).toBe(201);
    return r.json().learner.id as string;
  }
  async function newStaff(name: string, token = tok.adminA!, tenant = A()): Promise<string> {
    const r = await req("POST", "/staff", token, { full_name: name, classification: "teacher" }, tenant);
    expect(r.status, JSON.stringify(r.json())).toBe(201);
    return r.json().staff.id as string;
  }
  async function newClass(name: string, extra: Record<string, unknown> = {}): Promise<string> {
    const r = await admin("POST", "/classes", { academic_year_id: yearId, name, form_level: 1, education_level: "secondary", ...extra });
    expect(r.status, JSON.stringify(r.json())).toBe(201);
    return r.json().school_class.id as string;
  }
  async function assign(learnerId: string, classId: string) {
    return admin("POST", "/class-memberships", { learner_id: learnerId, class_id: classId });
  }
  async function activeMemberships(learnerId: string) {
    const r = await admin("GET", `/class-memberships?learnerId=${learnerId}&active=true`);
    expect(r.status).toBe(200);
    return r.json().memberships as Array<{ id: string; class_id: string }>;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    tok.adminA = await login({ email: "admin-a@example.com", password: PASSWORD });
    tok.teacherA = await login({ tenantId: A(), loginId: "TC-0001", password: PASSWORD });
    tok.adminB = await member("s4-admin-b@example.com", B(), "school_admin", "AD-0401");
    tok.peopleA = await member("s4-people@example.com", A(), "teacher", "TC-0401", "people");
    tok.academicsA = await member("s4-academics@example.com", A(), "teacher", "TC-0402", "academics");

    const year = await admin("POST", "/academic-years", { label: "2026", starts_on: "2020-01-01", ends_on: "2035-12-31", is_current: true });
    expect(year.status).toBe(201);
    yearId = year.json().academic_year.id as string;
    classX = await newClass("Form 1 East");
    classY = await newClass("Form 1 West");
    const math = await admin("POST", "/subjects", { code: "MATH", name: "Mathematics" });
    expect(math.status).toBe(201);
    mathId = math.json().subject.id as string;
    staff.one = await newStaff("Teacher One");
    staff.two = await newStaff("Teacher Two");
    staff.three = await newStaff("Teacher Three");
    staff.archived = await newStaff("Teacher Gone");
    expect((await admin("POST", `/staff/${staff.archived}/archive`)).status).toBe(200);
    staff.otherSchool = await newStaff("Teacher In School B", tok.adminB, B());
  }, 180_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  describe("finding 7: going back into a class left this year", () => {
    it("a learner can rejoin a class they left, and still has only one active class a year", async () => {
      const l = await newLearner("S4-701");
      const first = await assign(l, classX);
      expect(first.status, JSON.stringify(first.json())).toBe(201);
      // one active membership per learner per year still holds
      const second = await assign(l, classY);
      expect(second.status).toBe(409);
      expect((await admin("POST", `/class-memberships/${first.json().membership.id}/archive`)).status).toBe(200);
      const toY = await assign(l, classY);
      expect(toY.status).toBe(201);
      expect((await admin("POST", `/class-memberships/${toY.json().membership.id}/archive`)).status).toBe(200);
      // back into X, which they left earlier this year: refused with 409 before migration 101
      const back = await assign(l, classX);
      expect(back.status, JSON.stringify(back.json())).toBe(201);
      expect(back.json().membership).toMatchObject({ learner_id: l, class_id: classX, active: true });
      const all = await admin("GET", `/class-memberships?learnerId=${l}`);
      expect(all.json().memberships.filter((m: { class_id: string }) => m.class_id === classX)).toHaveLength(2);
    });

    it("the old unique index is gone and the one-active-per-year index is unchanged", async () => {
      const idx = await ctx.pool.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'class_memberships' ORDER BY indexname`,
      );
      const byName = Object.fromEntries(idx.rows.map((r) => [r.indexname, r.indexdef]));
      expect(byName.class_memberships_learner_class_year_uidx).toBeUndefined();
      expect(byName.class_memberships_learner_class_year_idx).not.toMatch(/UNIQUE/);
      expect(byName.class_memberships_learner_year_active_uidx).toMatch(/UNIQUE .*\(tenant_id, learner_id, academic_year_id\) WHERE \(active = true\)/);
    });
  });

  describe("finding 8: archiving a learner ends their class membership", () => {
    it("a People-only teacher archives the learner; the membership ends; restore gives no class; placing again works", async () => {
      const l = await newLearner("S4-801");
      const m = await assign(l, classX);
      expect(m.status).toBe(201);
      const archived = await req("POST", `/learners/${l}/archive`, tok.peopleA!);
      expect(archived.status, JSON.stringify(archived.json())).toBe(200);
      expect(await activeMemberships(l)).toEqual([]);
      const ended = await admin("GET", `/class-memberships?learnerId=${l}`);
      expect(ended.json().memberships[0]).toMatchObject({ id: m.json().membership.id, active: false });
      expect(ended.json().memberships[0].archived_at).not.toBeNull();
      const audit = await ctx.pool.query<{ detail: { endedClassMembershipIds: string[] } }>(
        `SELECT detail FROM security_audit_events WHERE event_type = 'directory.learner.archived' AND detail->>'learnerId' = $1`,
        [l],
      );
      expect(audit.rows[0]?.detail.endedClassMembershipIds).toEqual([m.json().membership.id]);

      expect((await admin("POST", `/learners/${l}/restore`)).status).toBe(200);
      expect(await activeMemberships(l)).toEqual([]);
      expect((await assign(l, classX)).status).toBe(201);
    });

    it("archiving a learner with no class still works and touches nobody else's membership", async () => {
      const other = await newLearner("S4-802");
      expect((await assign(other, classY)).status).toBe(201);
      const lonely = await newLearner("S4-803");
      expect((await admin("POST", `/learners/${lonely}/archive`)).status).toBe(200);
      expect(await activeMemberships(other)).toHaveLength(1);
    });
  });

  describe("classes: update and archive", () => {
    it("creates a class with a room and returns room on reads", async () => {
      const id = await newClass("Form 1 North", { room: "  Lab 1  " });
      const got = await admin("GET", `/classes/${id}`);
      expect(got.json().school_class).toMatchObject({ id, room: "Lab 1" });
      const list = await admin("GET", `/classes?academicYearId=${yearId}`);
      expect(list.json().classes.find((c: { id: string }) => c.id === id).room).toBe("Lab 1");
    });

    it("changes the room, stream, class teacher and level; null clears", async () => {
      let r = await admin("PATCH", `/classes/${classX}`, { room: " Room 4 ", stream: "East" });
      expect(r.status, JSON.stringify(r.json())).toBe(200);
      expect(r.json().school_class).toMatchObject({ id: classX, room: "Room 4", stream: "East", name: "Form 1 East", form_level: 1 });
      r = await admin("PATCH", `/classes/${classX}`, { class_teacher_staff_id: staff.one });
      expect(r.json().school_class.class_teacher_staff_id).toBe(staff.one);
      r = await admin("PATCH", `/classes/${classX}`, { class_teacher_staff_id: null, room: null });
      expect(r.json().school_class).toMatchObject({ class_teacher_staff_id: null, room: null });
      r = await admin("PATCH", `/classes/${classX}`, { education_level: "junior_secondary", form_level: 7, name: "Grade 7 East" });
      expect(r.json().school_class).toMatchObject({ education_level: "junior_secondary", form_level: 7, name: "Grade 7 East" });
      // an Academics-area teacher may update too
      r = await req("PATCH", `/classes/${classX}`, tok.academicsA!, { room: "Room 5" });
      expect(r.status).toBe(200);
      const audit = await ctx.pool.query(
        `SELECT 1 FROM security_audit_events WHERE event_type = 'academics.class.updated' AND detail->>'classId' = $1`,
        [classX],
      );
      expect(audit.rowCount).toBeGreaterThanOrEqual(4);
    });

    it("refuses a bad teacher, a level that does not fit, a duplicate name and a bad body", async () => {
      const bad = async (body: unknown, status: number) => {
        const r = await admin("PATCH", `/classes/${classX}`, body);
        expect(r.status, `${JSON.stringify(body)} -> ${JSON.stringify(r.json())}`).toBe(status);
      };
      await bad({ class_teacher_staff_id: staff.otherSchool }, 400);
      await bad({ class_teacher_staff_id: staff.archived }, 400);
      await bad({ class_teacher_staff_id: randomUUID() }, 400);
      await bad({ form_level: 2 }, 400); // junior_secondary is Grade 7-9
      await bad({ pathway: "stem" }, 400); // senior school only
      await bad({ name: "Form 1 West" }, 409);
      await bad({}, 400);
      await bad({ academic_year_id: yearId }, 400);
      await bad({ room: "" }, 400);
      await bad({ room: "x".repeat(65) }, 400);
      const missing = await admin("PATCH", `/classes/${randomUUID()}`, { room: "A" });
      expect(missing.status).toBe(404);
      const unchanged = await admin("GET", `/classes/${classX}`);
      expect(unchanged.json().school_class).toMatchObject({ name: "Grade 7 East", room: "Room 5", class_teacher_staff_id: null });
    });

    it("keeps an archived class teacher when the form sends it back unchanged", async () => {
      const id = await newClass("Form 1 South", { class_teacher_staff_id: staff.two });
      const gone = await newStaff("Teacher Leaving");
      expect((await admin("PATCH", `/classes/${id}`, { class_teacher_staff_id: gone })).status).toBe(200);
      expect((await admin("POST", `/staff/${gone}/archive`)).status).toBe(200);
      const r = await admin("PATCH", `/classes/${id}`, { class_teacher_staff_id: gone, room: "Hall" });
      expect(r.status, JSON.stringify(r.json())).toBe(200);
      expect(r.json().school_class).toMatchObject({ class_teacher_staff_id: gone, room: "Hall" });
    });

    it("archive is refused while an active learner is in the class, then ends its teaching assignments", async () => {
      const id = await newClass("Form 1 Closing");
      const l = await newLearner("S4-901");
      const m = await assign(l, id);
      const ta = await admin("POST", "/teaching-assignments", { staff_member_id: staff.one, class_id: id, subject_id: mathId });
      expect(ta.status).toBe(201);
      const refused = await admin("POST", `/classes/${id}/archive`);
      expect(refused.status).toBe(409);
      expect(refused.json().error.message).toBe("The class still has 1 learner. Move them to another class first.");
      expect((await admin("GET", `/classes/${id}`)).json().school_class.active).toBe(true);

      expect((await admin("POST", `/class-memberships/${m.json().membership.id}/archive`)).status).toBe(200);
      const key = { "idempotency-key": "s4-class-archive-0001" };
      const done = await req("POST", `/classes/${id}/archive`, tok.adminA!, undefined, A(), key);
      expect(done.status, JSON.stringify(done.json())).toBe(200);
      expect(done.json().school_class).toMatchObject({ id, active: false });
      expect(done.json().school_class.archived_at).not.toBeNull();
      const replay = await req("POST", `/classes/${id}/archive`, tok.adminA!, undefined, A(), key);
      expect(replay.status).toBe(200);
      expect(replay.headers["idempotent-replayed"]).toBe("true");

      const tas = await admin("GET", `/teaching-assignments?classId=${id}`);
      expect(tas.json().assignments).toEqual([expect.objectContaining({ id: ta.json().assignment.id, active: false })]);
      expect((await admin("POST", `/classes/${id}/archive`)).status).toBe(400);
      expect((await admin("PATCH", `/classes/${id}`, { room: "B2" })).status).toBe(400);
      expect((await assign(l, id)).status).toBe(400);
    });

    it("archive ends a membership left open for an already archived learner (rows from before finding 8)", async () => {
      const id = await newClass("Form 1 Legacy");
      const l = await newLearner("S4-902");
      const m = await assign(l, id);
      // as the API did before this change: the learner archived, the membership left active
      await ctx.pool.query(`UPDATE learners SET active = false, archived_at = now() WHERE id = $1`, [l]);
      const done = await admin("POST", `/classes/${id}/archive`);
      expect(done.status, JSON.stringify(done.json())).toBe(200);
      const row = await ctx.pool.query<{ active: boolean }>(`SELECT active FROM class_memberships WHERE id = $1`, [m.json().membership.id]);
      expect(row.rows[0]!.active).toBe(false);
    });
  });

  describe("subjects: level, year range and core flag", () => {
    it("creates with and without the new fields", async () => {
      const plain = await admin("GET", "/subjects");
      expect(plain.json().subjects.find((s: { id: string }) => s.id === mathId)).toMatchObject({
        education_level: null,
        min_form_level: null,
        max_form_level: null,
        is_core: true,
      });
      const cs = await admin("POST", "/subjects", { code: "CS", name: "Computer Studies", education_level: "secondary", min_form_level: 1, max_form_level: 2, is_core: false });
      expect(cs.status, JSON.stringify(cs.json())).toBe(201);
      expect(cs.json().subject).toMatchObject({ education_level: "secondary", min_form_level: 1, max_form_level: 2, is_core: false });
      const bad = await admin("POST", "/subjects", { code: "KIS", name: "Kiswahili", education_level: "junior_secondary", min_form_level: 1 });
      expect(bad.status).toBe(400);
    });

    it("updates the code, name, level, years and core flag; a field left out keeps its value", async () => {
      const created = await admin("POST", "/subjects", { code: "BIO", name: "Biology", education_level: "secondary", min_form_level: 1, max_form_level: 2 });
      const id = created.json().subject.id as string;
      let r = await admin("PATCH", `/subjects/${id}`, { max_form_level: 4, is_core: false });
      expect(r.status, JSON.stringify(r.json())).toBe(200);
      expect(r.json().subject).toMatchObject({ code: "BIO", name: "Biology", education_level: "secondary", min_form_level: 1, max_form_level: 4, is_core: false });
      r = await admin("PATCH", `/subjects/${id}`, { code: "BIO2", name: "Biology (new)", education_level: null, min_form_level: null });
      expect(r.json().subject).toMatchObject({ code: "BIO2", name: "Biology (new)", education_level: null, min_form_level: null, max_form_level: 4 });
      r = await req("PATCH", `/subjects/${id}`, tok.academicsA!, { is_core: true });
      expect(r.status).toBe(200);
      expect(r.json().subject.is_core).toBe(true);
      const audit = await ctx.pool.query<{ detail: { fields: string[] } }>(
        `SELECT detail FROM security_audit_events WHERE event_type = 'academics.subject.updated' AND detail->>'subjectId' = $1 ORDER BY occurred_at`,
        [id],
      );
      expect(audit.rows.map((x) => x.detail.fields)).toEqual([["max_form_level", "is_core"], ["code", "name", "education_level", "min_form_level"], ["is_core"]]);
    });

    it("refuses years out of order or outside the level, a duplicate code and a bad body", async () => {
      const id = (await admin("POST", "/subjects", { code: "CHE", name: "Chemistry", education_level: "secondary", min_form_level: 1, max_form_level: 4 })).json().subject.id as string;
      const bad = async (body: unknown, status: number) => {
        const r = await admin("PATCH", `/subjects/${id}`, body);
        expect(r.status, `${JSON.stringify(body)} -> ${JSON.stringify(r.json())}`).toBe(status);
      };
      await bad({ min_form_level: 3, max_form_level: 2 }, 400);
      await bad({ education_level: "junior_secondary" }, 400); // Form 1-4 is not Grade 7-9
      await bad({ max_form_level: 13 }, 400);
      await bad({ code: "math" }, 409); // codes are unique ignoring case
      await bad({}, 400);
      await bad({ active: false }, 400);
      expect((await admin("PATCH", `/subjects/${randomUUID()}`, { name: "X" })).status).toBe(404);
      const after = await admin("GET", "/subjects");
      expect(after.json().subjects.find((s: { id: string }) => s.id === id)).toMatchObject({ code: "CHE", min_form_level: 1, max_form_level: 4 });
    });
  });

  describe("teaching assignments: change teacher, end", () => {
    it("changes the teacher in place, ends the assignment, and a new one can be made", async () => {
      const ta = await admin("POST", "/teaching-assignments", { staff_member_id: staff.one, class_id: classY, subject_id: mathId });
      expect(ta.status).toBe(201);
      const id = ta.json().assignment.id as string;
      let r = await admin("PATCH", `/teaching-assignments/${id}`, { staff_member_id: staff.three });
      expect(r.status, JSON.stringify(r.json())).toBe(200);
      expect(r.json().assignment).toMatchObject({ id, staff_member_id: staff.three, class_id: classY, subject_id: mathId, active: true });
      r = await admin("PATCH", `/teaching-assignments/${id}`, { staff_member_id: staff.three });
      expect(r.status).toBe(200);
      for (const s of [staff.otherSchool, staff.archived, randomUUID()]) {
        expect((await admin("PATCH", `/teaching-assignments/${id}`, { staff_member_id: s })).status).toBe(400);
      }
      expect((await admin("PATCH", `/teaching-assignments/${id}`, {})).status).toBe(400);
      expect((await admin("PATCH", `/teaching-assignments/${id}`, { staff_member_id: staff.two, class_id: classX })).status).toBe(400);

      r = await admin("POST", `/teaching-assignments/${id}/archive`);
      expect(r.status).toBe(200);
      expect(r.json().assignment).toMatchObject({ id, active: false });
      expect((await admin("POST", `/teaching-assignments/${id}/archive`)).status).toBe(400);
      expect((await admin("PATCH", `/teaching-assignments/${id}`, { staff_member_id: staff.two })).status).toBe(400);
      const again = await admin("POST", "/teaching-assignments", { staff_member_id: staff.two, class_id: classY, subject_id: mathId });
      expect(again.status).toBe(201);
      expect((await admin("POST", `/teaching-assignments/${randomUUID()}/archive`)).status).toBe(404);
      expect((await admin("PATCH", `/teaching-assignments/${randomUUID()}`, { staff_member_id: staff.two })).status).toBe(404);
      const audit = await ctx.pool.query(
        `SELECT event_type FROM security_audit_events WHERE detail->>'assignmentId' = $1 ORDER BY occurred_at`,
        [id],
      );
      expect(audit.rows.map((x) => x.event_type)).toEqual([
        "academics.teaching_assignment.created",
        "academics.teaching_assignment.updated",
        "academics.teaching_assignment.archived",
      ]);
    });
  });

  describe("negative authorization on every new write", () => {
    it("plain teacher, People-only teacher, another school's admin and anonymous callers are refused; nothing changes", async () => {
      const subject = (await admin("POST", "/subjects", { code: "GEO", name: "Geography" })).json().subject.id as string;
      const cls = await newClass("Form 1 Guarded", { room: "R1" });
      const ta = (await admin("POST", "/teaching-assignments", { staff_member_id: staff.one, class_id: cls, subject_id: subject })).json().assignment.id as string;
      const ops: Array<[Method, string, unknown]> = [
        ["PATCH", `/classes/${cls}`, { room: "Hacked" }],
        ["POST", `/classes/${cls}/archive`, undefined],
        ["PATCH", `/subjects/${subject}`, { name: "Hacked" }],
        ["PATCH", `/teaching-assignments/${ta}`, { staff_member_id: staff.two }],
        ["POST", `/teaching-assignments/${ta}/archive`, undefined],
      ];
      for (const [method, path, body] of ops) {
        for (const who of ["teacherA", "peopleA", "adminB"]) {
          const r = await req(method, path, tok[who]!, body);
          expect(r.status, `${who} ${method} ${path}`).toBe(403);
        }
        expect((await req(method, path, null, body)).status, `anonymous ${method} ${path}`).toBe(401);
        // school B's administrator, in their own school, naming school A's rows: not found there
        const own = await req(method, path, tok.adminB!, body, B());
        expect(own.status, `adminB own-school ${method} ${path}`).toBe(404);
      }
      const c = (await admin("GET", `/classes/${cls}`)).json().school_class;
      expect(c).toMatchObject({ room: "R1", active: true });
      expect((await admin("GET", "/subjects")).json().subjects.find((s: { id: string }) => s.id === subject).name).toBe("Geography");
      const a = (await admin("GET", `/teaching-assignments?classId=${cls}`)).json().assignments[0];
      expect(a).toMatchObject({ id: ta, staff_member_id: staff.one, active: true });
    });

    it("a plain teacher still cannot archive a learner (finding 8 adds no new path)", async () => {
      const l = await newLearner("S4-990");
      expect((await assign(l, classY)).status).toBe(201);
      expect((await req("POST", `/learners/${l}/archive`, tok.teacherA!)).status).toBe(403);
      expect(await activeMemberships(l)).toHaveLength(1);
    });
  });
});
