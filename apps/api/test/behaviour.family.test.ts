import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSpec, responseSchema, validate } from "./support/openapiConformance.js";
import { createTestApp, type FixtureIds } from "./support.js";

/**
 * Behaviour log, part 2 (docs/BEHAVIOUR.md, S2b; migration 119): the office's incident follow-up, the in-app notices when a serious
 * entry is recorded, and what a parent and a learner read. Negative first: who may not follow up an incident; what a family never
 * sees (a voided entry, the staff-only note, the recorder, a kind the school keeps back); another family's child; who is never
 * told (a revoked link, an archived guardian); the definer function that names the parents to tell, asked by the wrong person.
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
type Json = Record<string, any>;
const PASSWORD = "correct-horse-battery";

describe("behaviour log, part 2: incidents, notices, family reads", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  const spec = loadSpec();
  const tok: Record<string, string> = {};
  const id: Record<string, string> = {};
  const A = () => ids.tenantA;
  const owner = async (sql: string, p: unknown[] = []) => (await ctx.pool.query(sql, p)).rows;
  const call = (who: string | null, method: "GET" | "POST" | "PUT", url: string, payload?: unknown, header?: string) =>
    ctx.app.inject({
      method,
      url,
      headers: { ...(who ? { authorization: `Bearer ${tok[who]}` } : {}), "x-tenant-id": header ?? A() },
      ...(payload === undefined ? {} : { payload: payload as Json }),
    });
  const B = (path: string) => `/v1/tenants/${A()}/behaviour${path}`;
  const kid = (learner: string | undefined) => `/v1/tenants/${A()}/me/children/${learner}/behaviour`;
  const okBody = async (res: Awaited<ReturnType<typeof call>>, status = 200): Promise<Json> => {
    expect(res.statusCode, res.body).toBe(status);
    return res.json();
  };
  const conforms = (specPath: string, method: string, status: number, body: unknown) => {
    const schema = responseSchema(spec, method, specPath, status);
    expect(typeof schema, String(schema)).toBe("object");
    const errs = validate(spec, schema, body);
    expect(errs, errs.join("; ")).toEqual([]);
  };
  const login = async (body: Record<string, unknown>): Promise<string> => {
    const r = await ctx.app.inject({ method: "POST", url: body.email ? "/v1/auth/login/email" : "/v1/auth/login/login-id", payload: body });
    expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
    return r.json().token as string;
  };
  async function member(name: string, role: string, loginId: string, tenant: string): Promise<string> {
    const userId = randomUUID();
    await owner(`INSERT INTO users (id, email, password_hash, full_name, status) SELECT $1, NULL, password_hash, $2, 'active' FROM users WHERE id = $3`, [userId, name, ids.adminA]);
    await owner(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, $3, $4)`, [userId, tenant, role, loginId]);
    return userId;
  }
  const learner = async (tenant: string, name: string, klass: string, year: string) => {
    const l = (await owner(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, $3, 'female') RETURNING id`, [tenant, `BF-${randomUUID().slice(0, 8)}`, name]))[0].id as string;
    await owner(`INSERT INTO class_memberships (tenant_id, learner_id, class_id, academic_year_id) VALUES ($1, $2, $3, $4)`, [tenant, l, klass, year]);
    return l;
  };
  /** A parent account linked to a new guardian of `learnerId`, as the migrator (the accept flow itself is covered elsewhere). */
  async function parentOf(tenant: string, learnerId: string, loginId: string, name: string): Promise<{ userId: string; guardianId: string; token: string }> {
    const g = (await owner(`INSERT INTO guardians (tenant_id, full_name, phone) VALUES ($1, $2, '0712345678') RETURNING id`, [tenant, name]))[0].id as string;
    await owner(`INSERT INTO guardian_links (tenant_id, guardian_id, learner_id, relationship, is_primary_payer) VALUES ($1, $2, $3, 'mother', true)`, [tenant, g, learnerId]);
    const userId = await member(name, "parent", loginId, tenant);
    const inv = (await owner(
      `INSERT INTO guardian_invitations (tenant_id, guardian_id, learner_id, contact_method, contact_value, token_hash, status, expires_at, accepted_at, accepted_by, contact_verification, closed_at)
       VALUES ($1, $2, $3, 'sms', '0712345678', $4, 'accepted', now() + interval '1 day', now(), $5, 'token_and_contact_echo', now()) RETURNING id`,
      [tenant, g, learnerId, createHash("sha256").update(randomBytes(16)).digest("hex"), userId],
    ))[0].id as string;
    await owner(`INSERT INTO guardian_accounts (tenant_id, guardian_id, user_id, invitation_id) VALUES ($1, $2, $3, $4)`, [tenant, g, userId, inv]);
    return { userId, guardianId: g, token: await login({ tenantId: tenant, loginId, password: PASSWORD }) };
  }
  async function asApp<T>(tenant: string, user: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [tenant, user ?? ""]);
      return await fn(c);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }
  const setSettings = async (patch: Json) =>
    okBody(await call("admin", "PUT", B("/settings"), {
      points_enabled: true, mode: "both", starting_points: 100, reset: "term", max_points_per_entry: 10, thresholds: [],
      parents_see_demerits: false, parents_see_incidents: false, ...patch,
    }));
  const record = (who: string, body: Json) => call(who, "POST", B("/entries"), body);
  const recordOk = async (who: string, body: Json): Promise<string[]> => (await okBody(await record(who, body), 201)).entry_ids as string[];
  /** Notices to a person (the in-app announcements addressed to them), newest first. */
  const noticesTo = async (userId: string) =>
    owner(`SELECT subject, body, channels, published_at FROM communications_announcements WHERE tenant_id = $1 AND audience->>'user_id' = $2 ORDER BY created_at DESC`, [A(), userId]);
  const cat: Record<string, string> = {};
  const incidentBody = { action_taken: "parent_meeting", follow_up_status: "open", parent_notified: true };

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    const T = A();
    id.teacher2 = await member("Teacher Two", "teacher", "TC-0002", T); // records; teaches the class but is not its class teacher
    id.feesTeacher = await member("Fees Teacher", "teacher", "TC-0005", T);
    id.driver = await member("Driver One", "driver", "DR-0001", T);
    id.adminB = await member("Admin B", "school_admin", "AD-0002", ids.tenantB);
    await owner(`INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'fees')`, [T, id.feesTeacher]);

    id.year = (await owner(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on, is_current) VALUES ($1, 'BF year', current_date - 200, current_date + 150, true) RETURNING id`, [T]))[0].id;
    await owner(`INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on, is_current) VALUES ($1, $2, 1, 'BF T1', current_date - 40, current_date + 30, true)`, [T, id.year]);
    id.sA = (await owner(`INSERT INTO staff_members (tenant_id, full_name, classification, user_id) VALUES ($1, 'Teacher A', 'teacher', $2) RETURNING id`, [T, ids.teacherA]))[0].id;
    id.s2 = (await owner(`INSERT INTO staff_members (tenant_id, full_name, classification, user_id) VALUES ($1, 'Teacher Two', 'teacher', $2) RETURNING id`, [T, id.teacher2]))[0].id;
    id.maths = (await owner(`INSERT INTO subjects (tenant_id, code, name) VALUES ($1, 'BFM', 'BF Maths') RETURNING id`, [T]))[0].id;
    id.F1 = (await owner(`INSERT INTO classes (tenant_id, academic_year_id, name, class_teacher_staff_id) VALUES ($1, $2, 'BF 1', $3) RETURNING id`, [T, id.year, id.sA]))[0].id;
    await owner(`INSERT INTO teaching_assignments (tenant_id, staff_member_id, class_id, subject_id) VALUES ($1, $2, $3, $4)`, [T, id.s2, id.F1, id.maths]);
    id.c1 = await learner(T, "Child One", id.F1!, id.year!);
    id.c2 = await learner(T, "Child Two", id.F1!, id.year!);
    id.c3 = await learner(T, "Child Three", id.F1!, id.year!);
    id.c4 = await learner(T, "Child Four", id.F1!, id.year!); // nothing is ever recorded for this one
    id.p1 = (await parentOf(T, id.c1!, "PT-0911", "Parent One")).userId;
    id.p1g = (await owner(`SELECT guardian_id FROM guardian_accounts WHERE user_id = $1`, [id.p1]))[0].guardian_id;
    id.p2 = (await parentOf(T, id.c2!, "PT-0912", "Parent Two")).userId;
    id.p4 = (await parentOf(T, id.c4!, "PT-0914", "Parent Four")).userId;

    const yB = (await owner(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on, is_current) VALUES ($1, 'BFB year', current_date - 200, current_date + 150, true) RETURNING id`, [ids.tenantB]))[0].id as string;
    const cB = (await owner(`INSERT INTO classes (tenant_id, academic_year_id, name) VALUES ($1, $2, 'BFB class') RETURNING id`, [ids.tenantB, yB]))[0].id as string;
    id.cb = await learner(ids.tenantB, "Child Bee", cB, yB);

    tok.admin = await login({ email: "admin-a@example.com", password: PASSWORD });
    tok.teacher = await login({ tenantId: T, loginId: "TC-0001", password: PASSWORD }); // the class teacher
    tok.teacher2 = await login({ tenantId: T, loginId: "TC-0002", password: PASSWORD });
    tok.feesTeacher = await login({ tenantId: T, loginId: "TC-0005", password: PASSWORD });
    tok.driver = await login({ tenantId: T, loginId: "DR-0001", password: PASSWORD });
    tok.adminB = await login({ tenantId: ids.tenantB, loginId: "AD-0002", password: PASSWORD });
    tok.p1 = await login({ tenantId: T, loginId: "PT-0911", password: PASSWORD });
    tok.p2 = await login({ tenantId: T, loginId: "PT-0912", password: PASSWORD });
    tok.p4 = await login({ tenantId: T, loginId: "PT-0914", password: PASSWORD });
    tok.lone = await login({ tenantId: T, loginId: "PT-0001", password: PASSWORD }); // a parent with no child
    const pb = await parentOf(ids.tenantB, id.cb, "PT-0913", "Parent Bee");
    tok.pb = pb.token;

    // the student: made through the office's own route, then signed in with the one-time password
    const acct = await call("admin", "POST", `/v1/tenants/${T}/learners/${id.c3}/student-account`);
    const account = (await okBody(acct, 201)).account as { login_id: string; one_time_password: string };
    const first = await login({ tenantId: T, loginId: account.login_id, password: account.one_time_password });
    const ch = await ctx.app.inject({ method: "POST", url: "/v1/auth/password/change", headers: { authorization: `Bearer ${first}` }, payload: { currentPassword: account.one_time_password, newPassword: "a-new-passw0rd-9" } });
    expect(ch.statusCode, ch.body).toBe(200);
    tok.student = await login({ tenantId: T, loginId: account.login_id, password: "a-new-passw0rd-9" });

    expect((await call("admin", "POST", B("/categories/defaults"))).statusCode).toBe(200);
    for (const c of (await okBody(await call("admin", "GET", B("/categories")))).categories as Json[]) cat[c.name] = c.id;
  }, 300_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  // ---------------------------------------------------------------- incident follow-up

  describe("the office follows up an incident", () => {
    let serious: string;
    beforeAll(async () => {
      serious = (await recordOk("teacher2", { learner_ids: [id.c1], kind: "demerit", category_id: cat["Fighting"], note: "Pushed a classmate" }))[0]!;
    });
    const put = (who: string | null, entry: string, body: unknown = incidentBody, header?: string) => call(who, "PUT", B(`/entries/${entry}/incident`), body, header);

    it("nobody but the office may: the recorder, the class teacher, a holder of another area, a parent, a student, a driver, another school", async () => {
      for (const who of ["teacher2", "teacher", "feesTeacher", "p1", "student", "driver", "adminB"]) {
        const res = await put(who, serious);
        expect(res.statusCode, `${who} ${res.body}`).toBe(403);
      }
      expect((await put(null, serious)).statusCode).toBe(401);
      expect((await put("admin", serious, incidentBody, ids.tenantB)).statusCode, "admin naming school B").toBe(403);
      const row = (await owner(`SELECT action_taken, follow_up_status, parent_notified_at FROM behaviour_entries WHERE id = $1`, [serious]))[0];
      expect(row).toEqual({ action_taken: null, follow_up_status: "open", parent_notified_at: null });
    });

    it("the office records the action, whether the parents were told, and resolves it; who and when come from the request", async () => {
      const body = await okBody(await put("admin", serious));
      conforms("/v1/tenants/{tenantId}/behaviour/entries/{entryId}/incident", "PUT", 200, body);
      expect(body.entry).toMatchObject({ id: serious, action_taken: "parent_meeting", follow_up_status: "open", resolved_at: null });
      expect(body.entry.parent_notified_at).not.toBeNull();
      const first = body.entry.parent_notified_at as string;
      const resolved = (await okBody(await put("admin", serious, { action_taken: "suspension", follow_up_status: "resolved", parent_notified: true }))).entry;
      expect(resolved).toMatchObject({ follow_up_status: "resolved", action_taken: "suspension" });
      expect(resolved.resolved_at).not.toBeNull();
      expect(new Date(resolved.parent_notified_at).getTime(), "keeps the first time").toBe(new Date(first).getTime());
      expect((await owner(`SELECT resolved_by FROM behaviour_entries WHERE id = $1`, [serious]))[0].resolved_by).toBe(ids.adminA);
      const reopened = (await okBody(await put("admin", serious, { action_taken: null, follow_up_status: "open", parent_notified: false }))).entry;
      expect(reopened).toMatchObject({ follow_up_status: "open", action_taken: null, resolved_at: null, parent_notified_at: null });
      expect((await owner(`SELECT detail FROM security_audit_events WHERE event_type = 'academics.behaviour.incident_updated' AND actor_user_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [ids.adminA]))[0].detail).toMatchObject({ entryId: serious, status: "open" });
    });

    it("any entry that is not voided can be followed up; a voided one, an unknown one and another school's cannot", async () => {
      const [merit] = await recordOk("admin", { learner_ids: [id.c2], kind: "merit", category_id: cat["Leadership"] });
      expect((await put("admin", merit!, { action_taken: "warning", follow_up_status: "resolved", parent_notified: false })).statusCode).toBe(200);
      const [gone] = await recordOk("admin", { learner_ids: [id.c2], kind: "demerit", category_id: cat["Fighting"] });
      expect((await call("admin", "POST", B(`/entries/${gone}/void`), { reason: "Wrong child" })).statusCode).toBe(200);
      expect((await put("admin", gone!)).statusCode, "voided").toBe(409);
      expect((await put("admin", randomUUID())).statusCode).toBe(404);
      const bEntry = (await owner(
        `INSERT INTO behaviour_categories (tenant_id, kind, name, points, severity) VALUES ($1, 'demerit', 'Bee rule', 1, 'minor') RETURNING id`,
        [ids.tenantB],
      ))[0].id as string;
      const bId = (await owner(`INSERT INTO behaviour_entries (tenant_id, learner_id, category_id, kind, points, occurred_on) VALUES ($1, $2, $3, 'demerit', -1, current_date) RETURNING id`, [ids.tenantB, id.cb, bEntry]))[0].id as string;
      expect((await put("admin", bId)).statusCode, "another school's").toBe(404);
      expect((await call("admin", "PUT", B("/entries/not-a-uuid/incident"), incidentBody)).statusCode).toBe(400);
    });

    it("the body is strict", async () => {
      for (const bad of [{}, { follow_up_status: "open", parent_notified: true }, { ...incidentBody, action_taken: "expulsion" }, { ...incidentBody, follow_up_status: "pending" },
        { ...incidentBody, parent_notified: "yes" }, { ...incidentBody, resolved_by: ids.adminA }, { ...incidentBody, resolved_at: "2020-01-01T00:00:00Z" }]) {
        expect((await put("admin", serious, bad)).statusCode, JSON.stringify(bad)).toBe(400);
      }
    });
  });

  // ---------------------------------------------------------------- notices

  describe("notices when a serious entry is recorded", () => {
    it("with demerits shown to families: the class teacher and the child's parent are told, nobody else", async () => {
      await setSettings({ parents_see_demerits: true });
      const t0 = (await noticesTo(ids.teacherA)).length;
      const p0 = (await noticesTo(id.p1!)).length;
      const [e] = await recordOk("teacher2", { learner_ids: [id.c1], kind: "demerit", category_id: cat["Bullying"], note: "Teased a classmate", staff_note: "Mother is aware of the history" });
      const teacher = await noticesTo(ids.teacherA);
      const parent = await noticesTo(id.p1!);
      expect(teacher.length).toBe(t0 + 1);
      expect(parent.length).toBe(p0 + 1);
      expect(teacher[0]).toMatchObject({ subject: "Serious incident: Child One", channels: ["in_app"] });
      expect(teacher[0].body).toContain("Bullying was recorded for Child One");
      expect(teacher[0].body).toContain("Teased a classmate");
      expect(teacher[0].body).toContain("The office follows it up on the Behaviour page.");
      expect(teacher[0].published_at).not.toBeNull();
      expect(parent[0]).toMatchObject({ subject: "About Child One", channels: ["in_app"] });
      expect(parent[0].body).toContain("Bullying was recorded for Child One");
      expect(parent[0].body).toContain("The school will be in touch");
      expect(parent[0].body).not.toContain("Teased a classmate"); // a family notice never carries the teacher's note
      for (const n of [...teacher, ...parent]) expect(n.body).not.toContain("Mother is aware");
      expect((await noticesTo(id.p2!)).length, "another family").toBe(0);
      expect((await noticesTo(id.teacher2!)).length, "the recorder").toBe(0);
      expect((await owner(`SELECT detail FROM security_audit_events WHERE event_type = 'academics.behaviour.notices_sent' ORDER BY occurred_at DESC LIMIT 1`))[0].detail).toEqual({ entries: 1, teachers: 1, families: 1 });
      void e;
    });

    it("the class teacher is not told about what they recorded themselves", async () => {
      const t0 = (await noticesTo(ids.teacherA)).length;
      const p0 = (await noticesTo(id.p1!)).length;
      await recordOk("teacher", { learner_ids: [id.c1], kind: "demerit", category_id: cat["Fighting"] });
      expect((await noticesTo(ids.teacherA)).length).toBe(t0);
      expect((await noticesTo(id.p1!)).length).toBe(p0 + 1);
    });

    it("with demerits kept back from families only the class teacher is told; an incident follows its own switch", async () => {
      await setSettings({ parents_see_demerits: false, parents_see_incidents: false });
      let p0 = (await noticesTo(id.p1!)).length;
      const t0 = (await noticesTo(ids.teacherA)).length;
      await recordOk("teacher2", { learner_ids: [id.c1], kind: "demerit", category_id: cat["Fighting"] });
      expect((await noticesTo(ids.teacherA)).length).toBe(t0 + 1);
      expect((await noticesTo(id.p1!)).length).toBe(p0);
      await setSettings({ parents_see_demerits: false, parents_see_incidents: true });
      await recordOk("teacher2", { learner_ids: [id.c1], kind: "demerit", category_id: cat["Fighting"] });
      expect((await noticesTo(id.p1!)).length, "a demerit follows parents_see_demerits").toBe(p0);
      await recordOk("teacher2", { learner_ids: [id.c1], kind: "incident", note: "Left the compound" });
      expect((await noticesTo(id.p1!)).length, "an incident follows parents_see_incidents").toBe(p0 + 1);
      p0 = (await noticesTo(id.p1!)).length;
      await setSettings({ parents_see_demerits: true, parents_see_incidents: true });
    });

    it("a minor demerit and a merit tell nobody", async () => {
      const t0 = (await noticesTo(ids.teacherA)).length;
      const p0 = (await noticesTo(id.p1!)).length;
      await recordOk("teacher2", { learner_ids: [id.c1], kind: "demerit", category_id: cat["Late to class"] });
      await recordOk("teacher2", { learner_ids: [id.c1], kind: "merit", category_id: cat["Leadership"] });
      await recordOk("teacher2", { learner_ids: [id.c1], kind: "incident", note: "A raised voice", severity: "minor" });
      expect((await noticesTo(ids.teacherA)).length).toBe(t0);
      expect((await noticesTo(id.p1!)).length).toBe(p0);
    });

    it("a revoked account link, an archived guardian and a disabled account are never told", async () => {
      const p0 = (await noticesTo(id.p1!)).length;
      const change = async (change: string, undo: string, params: unknown[]) => {
        await owner(change, params);
        try {
          await recordOk("teacher2", { learner_ids: [id.c1], kind: "demerit", category_id: cat["Fighting"] });
          expect((await noticesTo(id.p1!)).length).toBe(p0);
        } finally {
          await owner(undo, params);
        }
      };
      await change(`UPDATE guardian_accounts SET revoked_at = now(), revoke_reason = 'test' WHERE user_id = $1`, `UPDATE guardian_accounts SET revoked_at = NULL, revoke_reason = NULL WHERE user_id = $1`, [id.p1]);
      await change(`UPDATE guardians SET archived_at = now(), active = false WHERE id = $1`, `UPDATE guardians SET archived_at = NULL, active = true WHERE id = $1`, [id.p1g]);
      await change(`UPDATE users SET status = 'disabled' WHERE id = $1`, `UPDATE users SET status = 'active' WHERE id = $1`, [id.p1]);
    });

    it("the function that names the parents answers only the person who recorded the entry, just now", async () => {
      await setSettings({ parents_see_demerits: true });
      const [e] = await recordOk("teacher2", { learner_ids: [id.c1], kind: "demerit", category_id: cat["Fighting"] });
      const ask = (tenant: string, user: string | null, entry: string) =>
        asApp(tenant, user, async (c) => (await c.query(`SELECT user_id FROM behaviour_notice_family_users($1)`, [entry])).rows.map((r) => r.user_id as string));
      expect(await ask(A(), id.teacher2!, e!)).toEqual([id.p1]);
      expect(await ask(A(), ids.teacherA, e!), "someone who did not record it").toEqual([]);
      expect(await ask(A(), ids.adminA, e!), "even the office").toEqual([]);
      expect(await ask(A(), id.p1!, e!), "the parent themself").toEqual([]);
      expect(await ask(ids.tenantB, id.teacher2!, e!), "another school's context").toEqual([]);
      expect(await ask(A(), id.teacher2!, randomUUID())).toEqual([]);
      await expect(ask(A(), null, e!)).rejects.toMatchObject({ code: "42501" });
      // a minor entry, a voided entry and an old entry name nobody
      const [minor] = await recordOk("teacher2", { learner_ids: [id.c1], kind: "demerit", category_id: cat["Late to class"] });
      expect(await ask(A(), id.teacher2!, minor!)).toEqual([]);
      await call("teacher2", "POST", B(`/entries/${e}/void`), { reason: "Recorded in error" });
      expect(await ask(A(), id.teacher2!, e!), "voided").toEqual([]);
      const [older] = await recordOk("teacher2", { learner_ids: [id.c1], kind: "demerit", category_id: cat["Fighting"] });
      expect(await ask(A(), id.teacher2!, older!)).toEqual([id.p1]);
      await owner(`ALTER TABLE behaviour_entries DISABLE TRIGGER behaviour_entries_guard`);
      try {
        await owner(`UPDATE behaviour_entries SET created_at = now() - interval '11 minutes' WHERE id = $1`, [older]);
      } finally {
        await owner(`ALTER TABLE behaviour_entries ENABLE TRIGGER behaviour_entries_guard`);
      }
      expect(await ask(A(), id.teacher2!, older!), "after ten minutes").toEqual([]);
      // the school keeps demerits back: nobody
      await setSettings({ parents_see_demerits: false });
      const [kept] = await recordOk("teacher2", { learner_ids: [id.c1], kind: "demerit", category_id: cat["Fighting"] });
      expect(await ask(A(), id.teacher2!, kept!)).toEqual([]);
      await setSettings({ parents_see_demerits: true });
    });
  });

  // ---------------------------------------------------------------- what a family reads

  describe("what a parent and a learner read", () => {
    let merit: string;
    let demerit: string;
    let incident: string;
    let voided: string;
    beforeAll(async () => {
      await setSettings({ mode: "both", reset: "term", parents_see_demerits: false, parents_see_incidents: false });
      // a fresh learner for exact numbers: c3 is the student
      merit = (await recordOk("teacher2", { learner_ids: [id.c3], kind: "merit", category_id: cat["Leadership"], note: "Led the group", staff_note: "Quiet about it" }))[0]!;
      demerit = (await recordOk("teacher2", { learner_ids: [id.c3], kind: "demerit", category_id: cat["Disrespect"], note: "Talked back", staff_note: "Second time this week" }))[0]!;
      incident = (await recordOk("teacher2", { learner_ids: [id.c3], kind: "incident", note: "Left the compound", staff_note: "Seen by the guard" }))[0]!;
      voided = (await recordOk("teacher2", { learner_ids: [id.c3], kind: "merit", category_id: cat["Helping others"], note: "Voided one" }))[0]!;
      await call("teacher2", "POST", B(`/entries/${voided}/void`), { reason: "Wrong child" });
    });

    it("a stranger, staff and another school's parent are refused; a learner of another family is not found", async () => {
      for (const who of ["admin", "teacher", "teacher2", "feesTeacher", "driver"]) expect((await call(who, "GET", kid(id.c3))).statusCode, who).toBe(403);
      expect((await call(null, "GET", kid(id.c3))).statusCode).toBe(401);
      // c3 has no parent here: another family's parent, a parent with no child, another school's parent and a parent naming another school
      for (const who of ["p1", "p2", "lone"]) expect((await call(who, "GET", kid(id.c3))).statusCode, who).toBe(404);
      expect((await call("pb", "GET", kid(id.c3))).statusCode, "a parent of school B has no membership here").toBe(403);
      expect((await call("p1", "GET", kid(id.c2))).statusCode).toBe(404);
      expect((await call("p1", "GET", kid(id.cb))).statusCode).toBe(404);
      expect((await call("p1", "GET", `/v1/tenants/${ids.tenantB}/me/children/${id.c1}/behaviour`, undefined, ids.tenantB)).statusCode).toBe(403);
      expect((await call("p1", "GET", kid(randomUUID()))).statusCode).toBe(404);
      expect((await call("p1", "GET", kid("not-a-uuid"))).statusCode).toBe(400);
      // a learner reads only their own record
      expect((await call("student", "GET", kid(id.c1))).statusCode).toBe(404);
    });

    it("merits and the total always; demerits and incidents only when the school turns them on; never the staff-only note or the recorder", async () => {
      const ownRead = await okBody(await call("student", "GET", kid(id.c3)));
      conforms("/v1/tenants/{tenantId}/me/children/{learnerId}/behaviour", "GET", 200, ownRead);
      const kinds = (b: Json) => (b.behaviour.entries as Json[]).map((e) => e.id);
      expect(kinds(ownRead)).toEqual([merit]);
      // the total counts the demerit the school does not show: 3 merits - 3 demerit = 0 (Leadership 3, Disrespect 3)
      expect(ownRead.behaviour.points).toMatchObject({ merit_points: 3, demerit_points: -3, balance: 0 });
      expect(ownRead.behaviour.settings).toMatchObject({ mode: "both", reset: "term", parents_see_demerits: false, parents_see_incidents: false });
      expect(ownRead.behaviour.settings).not.toHaveProperty("max_points_per_entry");

      await setSettings({ parents_see_demerits: true });
      expect(kinds(await okBody(await call("student", "GET", kid(id.c3))))).toEqual([demerit, merit]); // newest first
      await setSettings({ parents_see_demerits: false, parents_see_incidents: true });
      expect(kinds(await okBody(await call("student", "GET", kid(id.c3)))).sort()).toEqual([incident, merit].sort());
      await setSettings({ parents_see_demerits: true, parents_see_incidents: true });
      const all = await okBody(await call("student", "GET", kid(id.c3)));
      expect(kinds(all).sort()).toEqual([merit, demerit, incident].sort());
      expect(kinds(all)).not.toContain(voided);
      const text = JSON.stringify(all);
      for (const secret of ["Quiet about it", "Second time this week", "Seen by the guard", "Voided one", "Teacher Two", ids.teacherA, id.teacher2]) expect(text, String(secret)).not.toContain(secret as string);
      for (const e of all.behaviour.entries as Json[]) {
        expect(Object.keys(e).sort()).toEqual(["action_taken", "category_name", "follow_up_status", "id", "kind", "note", "occurred_on", "parent_notified_at", "points", "resolved_at", "severity"]);
      }
      expect(all.behaviour.entries.find((e: Json) => e.id === merit)).toMatchObject({ kind: "merit", points: 3, category_name: "Leadership", note: "Led the group" });
      await setSettings({ parents_see_demerits: false, parents_see_incidents: false });
    });

    it("a parent reads their own child's record, the same shape", async () => {
      await setSettings({ parents_see_demerits: true });
      const own = (await recordOk("teacher2", { learner_ids: [id.c1], kind: "merit", category_id: cat["Sportsmanship"] }))[0]!;
      const body = await okBody(await call("p1", "GET", kid(id.c1)));
      conforms("/v1/tenants/{tenantId}/me/children/{learnerId}/behaviour", "GET", 200, body);
      expect((body.behaviour.entries as Json[]).some((e) => e.id === own)).toBe(true);
      expect((body.behaviour.entries as Json[]).every((e) => e.kind !== "incident")).toBe(true);
      expect(body.behaviour.points.period_start).not.toBeNull();
      await setSettings({ parents_see_demerits: false });
    });

    it("the follow-up the office records is shown with a visible incident", async () => {
      await setSettings({ parents_see_incidents: true });
      await call("admin", "PUT", B(`/entries/${incident}/incident`), { action_taken: "counsellor", follow_up_status: "resolved", parent_notified: true });
      const row = (await okBody(await call("student", "GET", kid(id.c3)))).behaviour.entries.find((e: Json) => e.id === incident);
      expect(row).toMatchObject({ kind: "incident", action_taken: "counsellor", follow_up_status: "resolved" });
      expect(row.parent_notified_at).not.toBeNull();
      expect(row.resolved_at).not.toBeNull();
      await setSettings({ parents_see_incidents: false });
    });

    it("an ended link, an archived learner and a disabled account read nothing", async () => {
      const gone = async (change: string, undo: string, params: unknown[], who: string, learnerId: string | undefined, status: number) => {
        await owner(change, params);
        try {
          expect((await call(who, "GET", kid(learnerId))).statusCode).toBe(status);
        } finally {
          await owner(undo, params);
        }
      };
      await gone(`UPDATE guardian_links SET archived_at = now() WHERE guardian_id = $1`, `UPDATE guardian_links SET archived_at = NULL WHERE guardian_id = $1`, [id.p1g], "p1", id.c1, 404);
      await gone(`UPDATE learners SET active = false, archived_at = now() WHERE id = $1`, `UPDATE learners SET active = true, archived_at = NULL WHERE id = $1`, [id.c1], "p1", id.c1, 404);
      await gone(`UPDATE users SET status = 'disabled' WHERE id = $1`, `UPDATE users SET status = 'active' WHERE id = $1`, [id.p1], "p1", id.c1, 401);
    });

    it("a learner with nothing recorded reads zero points and no entries", async () => {
      const empty = await okBody(await call("p4", "GET", kid(id.c4)));
      expect(empty.behaviour.entries).toEqual([]);
      expect(empty.behaviour.points).toMatchObject({ merit_points: 0, demerit_points: 0, balance: 0 });
      await setSettings({ points_enabled: false });
      expect((await okBody(await call("p4", "GET", kid(id.c4)))).behaviour.points.balance).toBeNull();
      await setSettings({});
    });
  });
});
