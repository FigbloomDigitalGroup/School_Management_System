import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { setLogSink } from "../src/log.js";
import { loadSpec, responseSchema, validate } from "./support/openapiConformance.js";
import { createTestApp } from "./support.js";

/**
 * Student accounts (docs/STUDENT-ACCOUNTS.md, migration 110), through the real figbloom_app login. Negative first: who may
 * make, reset, revoke and read a learner's login; the one-time password appears once and nowhere else; a learner reads
 * their OWN learner only (a classmate, another class, another school, a random id are 404) and nothing a parent-only,
 * staff or administrator path serves; each way a login stops being live closes every read; a learner pays and sits exams
 * for their own learner only and never sees an answer key; chat reaches the class's teachers and the office only.
 */
const PASSWORD = "correct-horse-battery";
const OWN_PW = "my-own-passw0rd-1";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

/** The shared per-learner reads a learner may use, relative to /me/children/{learnerId}. */
const SHARED_PATHS = ["/attendance", "/results", "/report-cards", "/homework", "/materials", "/timetable", "/fees", "/activities", "/items", "/behaviour"];

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

describe("student accounts", () => {
  let ctx: Ctx;
  const spec = loadSpec();
  const A = () => ctx.ids.tenantA;
  const B = () => ctx.ids.tenantB;
  const owner = async (sql: string, p: unknown[] = []) => (await ctx.pool.query(sql, p)).rows;

  const loginRaw = (body: Record<string, unknown>) =>
    ctx.app.inject({ method: "POST", url: body.email ? "/v1/auth/login/email" : "/v1/auth/login/login-id", payload: body });
  async function login(body: Record<string, unknown>): Promise<string> {
    const r = await loginRaw(body);
    expect(r.statusCode, r.body).toBe(200);
    return r.json().token as string;
  }
  const call = (method: "GET" | "POST" | "PUT", url: string, token: string | undefined, payload?: unknown, tenant: string | null = A()) =>
    ctx.app.inject({
      method,
      url,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenant ? { "x-tenant-id": tenant } : {}) },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const t = (path: string, tenant = A()) => `/v1/tenants/${tenant}${path}`;
  function conforms(method: string, specPath: string, status: number, body: unknown) {
    const schema = responseSchema(spec, method, specPath, status);
    expect(typeof schema, `${method} ${specPath} ${status}`).toBe("object");
    const errs = validate(spec, schema, body);
    expect(errs, `${specPath} ${status}: ${errs.join("; ")}`).toEqual([]);
  }

  let admin: string;
  let teacher: string; // TC-0001: a plain teacher, no admin area
  let parent: string; // PT-0001: a parent with no link
  let people: string; // a staff member holding the People area
  let peopleUser: string;
  let adminB: string; // a school administrator of school B
  let year: string;
  let term: string;
  let class1A: string;
  let class2B: string;
  let s1: string; // learner in 1A
  let s2: string; // classmate in 1A
  let s3: string; // learner in 2B
  let sb: string; // learner of school B
  let maths: string;
  let otherTeacherUser: string;
  let otherTeacher: string;

  async function learner(tenant: string, name: string, cls?: string): Promise<string> {
    const id = (await owner(`INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, $3, 'male') RETURNING id`, [tenant, "S" + randomUUID().slice(0, 8), name]))[0].id as string;
    if (cls) await owner(`INSERT INTO class_memberships (tenant_id, learner_id, class_id, academic_year_id) VALUES ($1, $2, $3, $4)`, [tenant, id, cls, year]);
    return id;
  }
  async function member(tenant: string, role: string, loginId: string, name: string): Promise<string> {
    const userId = randomUUID();
    const hash = (await owner(`SELECT password_hash AS h FROM users WHERE id = $1`, [ctx.ids.adminA]))[0].h as string;
    await owner(`INSERT INTO users (id, email, password_hash, full_name, status) VALUES ($1, NULL, $2, $3, 'active')`, [userId, hash, name]);
    await owner(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, $3, $4)`, [userId, tenant, role, loginId]);
    return userId;
  }
  async function ok(method: "GET" | "POST" | "PUT", path: string, payload?: unknown, token = admin): Promise<Record<string, any>> {
    const r = await call(method, t(path), token, payload);
    expect([200, 201, 204], `${method} ${path}: ${r.body}`).toContain(r.statusCode);
    return r.statusCode === 204 ? {} : r.json();
  }
  /** The office makes a login; returns the answer (with the one-time password). */
  async function makeLogin(learnerId: string, token = admin): Promise<{ login_id: string; one_time_password: string; user_id: string }> {
    const r = await call("POST", t(`/learners/${learnerId}/student-account`), token);
    expect(r.statusCode, r.body).toBe(201);
    return r.json().account;
  }
  /** A learner with a login who has signed in and replaced the one-time password (a learner who has one gets a reset). */
  async function signedIn(learnerId: string): Promise<{ token: string; userId: string; loginId: string }> {
    const has = (await call("GET", t(`/learners/${learnerId}/student-account`), admin)).json().account.has_login as boolean;
    let made: { login_id: string; one_time_password: string; user_id: string };
    if (has) {
      const freshAdmin = await login({ email: "admin-a@example.com", password: PASSWORD });
      const r = await call("POST", t(`/learners/${learnerId}/student-account/reset-password`), freshAdmin);
      expect(r.statusCode, r.body).toBe(200);
      made = r.json().account;
    } else {
      made = await makeLogin(learnerId);
    }
    const token = await login({ tenantId: A(), loginId: made.login_id, password: made.one_time_password });
    const ch = await call("POST", "/v1/auth/password/change", token, { currentPassword: made.one_time_password, newPassword: OWN_PW }, null);
    expect(ch.statusCode, ch.body).toBe(200);
    return { token, userId: made.user_id, loginId: made.login_id };
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login({ email: "admin-a@example.com", password: PASSWORD });
    teacher = await login({ tenantId: A(), loginId: "TC-0001", password: PASSWORD });
    parent = await login({ tenantId: A(), loginId: "PT-0001", password: PASSWORD });
    peopleUser = await member(A(), "staff", "SF-0901", "Office Olive");
    await owner(`INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'people')`, [A(), peopleUser]);
    people = await login({ tenantId: A(), loginId: "SF-0901", password: PASSWORD });
    await member(B(), "school_admin", "AD-0902", "Admin Bee");
    adminB = await login({ tenantId: B(), loginId: "AD-0902", password: PASSWORD });

    year = (await owner(`INSERT INTO academic_years (tenant_id, label, starts_on, ends_on, is_current) VALUES ($1, 'This year', $2, $3, true) RETURNING id`, [A(), isoDay(-200), isoDay(160)]))[0].id as string;
    term = (await owner(`INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on, is_current) VALUES ($1, $2, 1, 'Term 1', $3, $4, true) RETURNING id`, [A(), year, isoDay(-60), isoDay(30)]))[0].id as string;
    class1A = (await owner(`INSERT INTO classes (tenant_id, academic_year_id, name, form_level, stream) VALUES ($1, $2, 'Form 1 A', 1, 'A') RETURNING id`, [A(), year]))[0].id as string;
    class2B = (await owner(`INSERT INTO classes (tenant_id, academic_year_id, name, form_level, stream) VALUES ($1, $2, 'Form 2 B', 2, 'B') RETURNING id`, [A(), year]))[0].id as string;
    s1 = await learner(A(), "Student One", class1A);
    s2 = await learner(A(), "Student Two", class1A);
    s3 = await learner(A(), "Student Three", class2B);
    sb = await learner(B(), "Student Bee");

    // Teacher A teaches maths in 1A through a staff record linked to the account; another teacher teaches nothing there.
    maths = (await ok("POST", "/subjects", { code: "MAT", name: "Mathematics" })).subject.id;
    const staff = (await ok("POST", "/staff", { full_name: "Teacher Tia", classification: "teacher", userId: ctx.ids.teacherA })).staff.id;
    await ok("POST", "/teaching-assignments", { staff_member_id: staff, class_id: class1A, subject_id: maths });
    otherTeacherUser = await member(A(), "teacher", "TC-0777", "Teacher Other");
    await ok("POST", "/staff", { full_name: "Teacher Other", classification: "teacher", userId: otherTeacherUser });
    otherTeacher = await login({ tenantId: A(), loginId: "TC-0777", password: PASSWORD });
  }, 180_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  describe("making a login: the school office only", () => {
    it("a plain teacher, a parent, an organisation administrator and another school's administrator are refused; nothing is made", async () => {
      const orgAdmin = await login({ email: "orgadmin@example.com", password: PASSWORD });
      for (const [who, tenant] of [[teacher, A()], [parent, A()], [orgAdmin, A()], [adminB, A()]] as const) {
        for (const r of [
          await call("POST", t(`/learners/${s1}/student-account`), who, undefined, tenant),
          await call("GET", t(`/learners/${s1}/student-account`), who, undefined, tenant),
          await call("POST", t(`/learners/${s1}/student-account/reset-password`), who, undefined, tenant),
          await call("POST", t(`/learners/${s1}/student-account/revoke`), who, { reason: "not yours" }, tenant),
        ]) {
          expect(r.statusCode, r.body).toBe(403);
          expect(r.body).not.toMatch(/one_time_password/);
        }
      }
      expect((await owner(`SELECT count(*)::int AS n FROM learner_accounts WHERE learner_id = $1`, [s1]))[0].n).toBe(0);
    });

    it("a school administrator and a People-area staff member may; the password is shown once, never stored, logged or audited", async () => {
      const lines: string[] = [];
      const restore = setLogSink((line) => lines.push(line));
      let made: Record<string, any>;
      let made2: Record<string, any>;
      try {
        const r = await call("POST", t(`/learners/${s1}/student-account`), admin);
        expect(r.statusCode, r.body).toBe(201);
        expect(r.headers["cache-control"]).toBe("no-store");
        conforms("POST", "/v1/tenants/{tenantId}/learners/{learnerId}/student-account", 201, r.json());
        made = r.json().account;
        const r2 = await call("POST", t(`/learners/${s2}/student-account`), people);
        expect(r2.statusCode, r2.body).toBe(201);
        made2 = r2.json().account;
      } finally {
        restore();
      }
      expect(made).toMatchObject({ learner_id: s1, must_change_password: true });
      expect(made.login_id).toMatch(/^ST-\d{4}$/);
      expect(made2.login_id).toMatch(/^ST-\d{4}$/);
      expect(made2.login_id).not.toBe(made.login_id);
      expect(made.one_time_password).toMatch(/^[A-Za-z2-9]{12}$/);
      const pw = made.one_time_password as string;

      // never in a later answer, an audit row, a log line, or the database in clear
      const status = await call("GET", t(`/learners/${s1}/student-account`), admin);
      expect(status.statusCode).toBe(200);
      conforms("GET", "/v1/tenants/{tenantId}/learners/{learnerId}/student-account", 200, status.json());
      expect(status.json().account).toMatchObject({ has_login: true, login_id: made.login_id, account_status: "active", must_change_password: true, last_sign_in_at: null, revoked_logins: 0 });
      const again = await call("POST", t(`/learners/${s1}/student-account`), admin);
      expect(again.statusCode).toBe(409); // a second create is refused, never a second account
      for (const body of [status.body, again.body]) expect(body).not.toContain(pw);
      const audit = await owner(`SELECT event_type, detail::text AS d FROM security_audit_events WHERE event_type LIKE 'student.%'`);
      expect(audit.map((a) => a.event_type)).toEqual(expect.arrayContaining(["student.account.created"]));
      for (const a of audit) expect(a.d).not.toContain(pw);
      expect(lines.join("\n")).not.toContain(pw);
      const users = await owner(`SELECT u.email, u.must_change_password, u.full_name, m.role, u.password_hash AS h FROM users u JOIN school_memberships m ON m.user_id = u.id WHERE u.id = $1`, [made.user_id]);
      expect(users[0]).toMatchObject({ email: null, must_change_password: true, full_name: "Student One", role: "student" });
      expect(users[0].h).toMatch(/^\$argon2id\$/);
      expect(users[0].h).not.toContain(pw);
    });

    it("a learner of another school, an id that does not exist and an archived learner are refused", async () => {
      expect((await call("POST", t(`/learners/${sb}/student-account`), admin)).statusCode).toBe(404);
      expect((await call("POST", t(`/learners/${randomUUID()}/student-account`), admin)).statusCode).toBe(404);
      expect((await call("GET", t(`/learners/${sb}/student-account`), admin)).statusCode).toBe(404);
      expect((await call("POST", t(`/learners/not-a-uuid/student-account`), admin)).statusCode).toBe(400);
      const gone = await learner(A(), "Archived Learner");
      await owner(`UPDATE learners SET active = false, archived_at = now() WHERE id = $1`, [gone]);
      expect((await call("POST", t(`/learners/${gone}/student-account`), admin)).statusCode).toBe(409);
      const none = await learner(A(), "No Login Yet");
      expect((await call("GET", t(`/learners/${none}/student-account`), admin)).json().account).toMatchObject({ has_login: false, login_id: null, must_change_password: null });
      expect((await call("POST", t(`/learners/${none}/student-account/reset-password`), admin)).statusCode).toBe(404);
      expect((await call("POST", t(`/learners/${none}/student-account/revoke`), admin, { reason: "nothing to revoke" })).statusCode).toBe(404);
    });

    it("concurrent creates for one learner give one account; login numbers never collide", async () => {
      const l = await learner(A(), "Race Learner", class1A);
      const many = await Promise.all(Array.from({ length: 6 }, () => call("POST", t(`/learners/${l}/student-account`), admin)));
      expect(many.map((r) => r.statusCode).sort()).toEqual([201, 409, 409, 409, 409, 409]);
      expect((await owner(`SELECT count(*)::int AS n FROM learner_accounts WHERE learner_id = $1`, [l]))[0].n).toBe(1);
      // many learners at once: distinct login ids
      const ls = await Promise.all(Array.from({ length: 5 }, (_, i) => learner(A(), `Batch ${i}`)));
      const made = await Promise.all(ls.map((x) => call("POST", t(`/learners/${x}/student-account`), admin)));
      for (const r of made) expect(r.statusCode, r.body).toBe(201);
      const ids = made.map((r) => r.json().account.login_id as string);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe("signing in", () => {
    it("the login id and the one-time password sign in; nothing works until the password is changed; then the learner reads their own record", async () => {
      const l = await learner(A(), "First Timer", class1A);
      const made = await makeLogin(l);
      expect((await loginRaw({ tenantId: A(), loginId: made.login_id, password: "wrong-password-1" })).statusCode).toBe(401);
      expect((await loginRaw({ tenantId: B(), loginId: made.login_id, password: made.one_time_password })).statusCode).toBe(401);
      const signIn = await loginRaw({ tenantId: A(), loginId: made.login_id.toLowerCase(), password: made.one_time_password });
      expect(signIn.statusCode, signIn.body).toBe(200);
      expect(signIn.json()).toMatchObject({ activeTenantId: A(), user: { must_change_password: true, email: null } });
      const token = signIn.json().token as string;
      const me = await call("GET", "/v1/auth/me", token, undefined, null);
      expect(me.json()).toMatchObject({ authz: { role: "student", tenantId: A() }, memberships: [{ role: "student", loginId: made.login_id }] });
      const blocked = await call("GET", t("/me/learner"), token);
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().error.message).toBe("Password change required");
      const ch = await call("POST", "/v1/auth/password/change", token, { currentPassword: made.one_time_password, newPassword: OWN_PW }, null);
      expect(ch.statusCode, ch.body).toBe(200);
      expect(ch.json().user.must_change_password).toBe(false);
      const mine = await call("GET", t("/me/learner"), token);
      expect(mine.statusCode, mine.body).toBe(200);
      conforms("GET", "/v1/tenants/{tenantId}/me/learner", 200, mine.json());
      expect(mine.json().learner).toMatchObject({ learner_id: l, full_name: "First Timer", login_id: made.login_id, class: { id: class1A, name: "Form 1 A" } });
      // the one-time password no longer works; the office sees the change and the sign-in
      expect((await loginRaw({ tenantId: A(), loginId: made.login_id, password: made.one_time_password })).statusCode).toBe(401);
      const status = (await call("GET", t(`/learners/${l}/student-account`), admin)).json().account;
      expect(status.must_change_password).toBe(false);
      expect(status.last_sign_in_at).not.toBeNull();
    });

    it("session policy: the guardian idle timeout and the 8-hour lifetime; two-step sign-in is never required, and cannot be configured", async () => {
      const s = await signedIn(await learner(A(), "Policy Learner", class1A));
      expect((await owner(`SELECT public.auth_session_idle_seconds($1) AS s`, [s.userId]))[0].s).toBe(1800);
      expect((await owner(`SELECT public.auth_session_idle_seconds($1) AS s`, [ctx.ids.parentA]))[0].s).toBe(1800);
      expect((await owner(`SELECT public.auth_session_idle_seconds($1) AS s`, [ctx.ids.teacherA]))[0].s).toBe(900);
      const sess = await owner(`SELECT id, extract(epoch FROM expires_at - created_at)::int AS life FROM sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [s.userId]);
      expect(sess[0].life).toBeLessThanOrEqual(8 * 3600 + 60);
      // every role the configuration accepts, and still not required for a learner
      const mfa = await owner(`SELECT required FROM public.auth_mfa_state($1, $2, ARRAY['teacher', 'staff', 'driver', 'parent'])`, [sess[0].id, s.userId]);
      expect(mfa[0].required).toBe(false);
      const saved = { db: process.env.DATABASE_URL, roles: process.env.MFA_REQUIRED_ROLES };
      try {
        process.env.DATABASE_URL = ctx.runtimeUrl;
        process.env.MFA_REQUIRED_ROLES = "teacher,student";
        expect(() => loadConfig()).toThrow(/mfaRequiredRoles/);
        process.env.MFA_REQUIRED_ROLES = "teacher,parent";
        expect(loadConfig().mfaRequiredRoles).toEqual(["teacher", "parent"]);
      } finally {
        if (saved.db === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = saved.db;
        if (saved.roles === undefined) delete process.env.MFA_REQUIRED_ROLES;
        else process.env.MFA_REQUIRED_ROLES = saved.roles;
      }
    });
  });

  describe("a learner's own records", () => {
    let me: { token: string; userId: string; loginId: string };
    let mate: { token: string; userId: string };
    let published: string;
    let draft: string;
    let inv1: string;
    let inv2: string;

    beforeAll(async () => {
      me = await signedIn(s1);
      mate = await signedIn(s2);
      // marks: a published assessment (s1 70, s2 50, s3 is another class), a draft (never shown)
      published = (await ok("POST", "/assessments", { class_id: class1A, subject_id: maths, term_id: term, title: "Midterm maths", kind: "exam", max_score: 100 })).assessment.id;
      draft = (await ok("POST", "/assessments", { class_id: class1A, subject_id: maths, term_id: term, title: "Unreleased test", kind: "exam", max_score: 100 })).assessment.id;
      for (const [a, l, score] of [[published, s1, 70], [published, s2, 50], [draft, s1, 99]] as const) await ok("POST", `/assessments/${a}/marks`, { learner_id: l, score });
      await ok("POST", `/assessments/${published}/publish`);
      await ok("POST", "/homework-items", { class_id: class1A, subject_id: maths, term_id: term, title: "Fractions sheet", due_on: isoDay(3), body: "Page 12" });
      await ok("POST", "/homework-items", { class_id: class2B, subject_id: maths, term_id: term, title: "2B essay", due_on: isoDay(3), body: "Write" });
      // fees: an invoice each; a voided charge never shows
      await ok("POST", "/finance/fee-items", { term_id: term, name: "Tuition", amount_minor: 500000, applies_to: "all" });
      await ok("POST", "/finance/billing-runs", { term_id: term, due_on: isoDay(10) });
      const invoiceOf = async (l: string) => (await owner(`SELECT id FROM finance_invoices WHERE tenant_id = $1 AND learner_id = $2`, [A(), l]))[0].id as string;
      inv1 = await invoiceOf(s1);
      inv2 = await invoiceOf(s2);
      await ok("POST", `/finance/invoices/${inv1}/charges`, { amount_minor: 5000, reason: "Charged in error" });
      const wrong = (await owner(`SELECT id FROM finance_charges WHERE invoice_id = $1`, [inv1]))[0].id as string;
      await ok("POST", `/finance/invoices/${inv1}/charges/${wrong}/void`, { reason: "Not owed" });
    }, 180_000);

    it("the shared per-learner reads answer for the learner's own learner, with that learner's data only", async () => {
      for (const p of SHARED_PATHS) {
        const r = await call("GET", t(`/me/children/${s1}${p}`), me.token);
        expect(r.statusCode, `${p}: ${r.body}`).toBe(200);
        conforms("GET", `/v1/tenants/{tenantId}/me/children/{learnerId}${p}`, 200, r.json());
        expect(r.body, p).not.toContain(s2);
        expect(r.body, p).not.toContain(s3);
      }
      const results = (await call("GET", t(`/me/children/${s1}/results`), me.token)).json();
      expect(results.marks.map((m: { assessment_id: string }) => m.assessment_id)).toEqual([published]);
      expect(results.marks[0]).toMatchObject({ score: "70" });
      expect(JSON.stringify(results)).not.toContain(draft);
      const hw = (await call("GET", t(`/me/children/${s1}/homework`), me.token)).json();
      expect(hw.homework.map((h: { title: string }) => h.title)).toEqual(["Fractions sheet"]);
      const fees = (await call("GET", t(`/me/children/${s1}/fees`), me.token)).json();
      expect(fees.invoices.map((i: { id: string }) => i.id)).toEqual([inv1]);
      expect(fees.invoices[0].charges).toEqual([]); // the voided charge never appears
      expect(JSON.stringify(fees)).not.toContain(inv2);
      expect((await call("GET", t(`/me/children/${s1}/timetable`), me.token)).json()).toEqual({ timetable: null }); // nothing published
    });

    it("every other learner is 404 (a classmate, another class, another school, a random id), audited; another school's path is 403", async () => {
      for (const p of SHARED_PATHS) {
        for (const who of [s2, s3, sb, randomUUID()]) {
          const r = await call("GET", t(`/me/children/${who}${p}`), me.token);
          expect(r.statusCode, `${p} ${who}`).toBe(404);
          expect(r.json().error.message).toBe("Learner not found");
        }
        expect((await call("GET", t(`/me/children/${sb}${p}`, B()), me.token, undefined, B())).statusCode, p).toBe(403);
        expect((await call("GET", t(`/me/children/not-a-uuid${p}`), me.token)).statusCode, p).toBe(400);
      }
      const denied = await owner(`SELECT detail->>'learnerId' AS l FROM security_audit_events WHERE event_type = 'student.learner.denied' AND actor_user_id = $1`, [me.userId]);
      expect(denied.map((r) => r.l)).toEqual(expect.arrayContaining([s2, s3, sb]));
      // the classmate reads their own, never s1's
      expect((await call("GET", t(`/me/children/${s2}/results`), mate.token)).json().marks[0]).toMatchObject({ score: "50" });
      expect((await call("GET", t(`/me/children/${s1}/results`), mate.token)).statusCode).toBe(404);
    });

    it("a learner cannot use the parent-only paths or any staff or administrator path", async () => {
      expect((await call("GET", t(`/me/children/${s1}/health`), me.token)).statusCode).toBe(403);
      expect((await call("GET", t("/me/children"), me.token)).statusCode).toBe(403);
      expect((await call("GET", t("/me/transport"), me.token)).statusCode).toBe(403);
      for (const path of ["/learners", "/staff", "/guardians", "/classes", "/assessments", "/class-memberships", "/finance/invoices", "/me/teaching/learners", `/learners/${s1}`, `/learners/${s1}/student-account`, "/online-exam-papers"]) {
        expect((await call("GET", t(path), me.token)).statusCode, path).toBe(403);
      }
      expect((await call("POST", t(`/learners/${s2}/student-account/reset-password`), me.token)).statusCode).toBe(403);
      // the staff chat list is empty for a learner (no staff directory)
      const staffList = await call("GET", t("/chat/contacts"), me.token);
      expect(staffList.statusCode).toBe(200);
      expect(staffList.json().contacts).toEqual([]);
      const perms = (await call("GET", "/v1/rbac/permissions", me.token)).json().items as string[];
      expect(perms).toContain("resource.student.self.read");
      expect(perms).not.toContain("resource.family.read");
      expect(perms.filter((p) => p !== "session.manage" && /\.(write|administer|manage)$/.test(p))).toEqual([]);
    });

    it("a teacher, an administrator and a parent cannot use the learner-only paths; a parent's family branch never reaches a learner who is not their child", async () => {
      for (const who of [teacher, admin, parent, people]) {
        for (const path of ["/me/learner", "/me/learner/online-exams", `/me/learner/online-exam-attempts/${randomUUID()}`]) {
          expect((await call("GET", t(path), who)).statusCode, path).toBe(403);
        }
        expect((await call("PUT", t(`/me/learner/online-exam-attempts/${randomUUID()}/answers`), who, { answers: {} })).statusCode).toBe(403);
      }
      for (const p of SHARED_PATHS) expect((await call("GET", t(`/me/children/${s1}${p}`), parent)).statusCode, p).toBe(404);
      for (const p of SHARED_PATHS) expect((await call("GET", t(`/me/children/${s1}${p}`), teacher)).statusCode, p).toBe(403);
    });

    it("paying: the learner's own invoice only (proof as 'learner', invoice PDF, M-Pesa prompt, AI-helper opt-in)", async () => {
      const proof = (invoiceId: string, code: string) => ({ invoice_id: invoiceId, sms_text: `${code} Confirmed. Ksh1,000.00 sent to SCHOOL`, txn_source: "mpesa", txn_code: code });
      const mine = await call("POST", t("/finance/proofs"), me.token, proof(inv1, "QST1CD2EF3"));
      expect(mine.statusCode, mine.body).toBe(201);
      expect(mine.json().proof.submitted_via).toBe("learner");
      const pdf = await call("GET", t(`/finance/invoices/${inv1}/pdf`), me.token);
      expect(pdf.statusCode).toBe(200);
      const prompt = await call("POST", t("/finance/mpesa/prompts"), me.token, { invoice_id: inv1, amount_minor: 100000, msisdn: "254712345678" });
      expect(prompt.statusCode, prompt.body).not.toBe(403); // passes the payer check (no provider configured here)
      expect((await call("GET", t(`/me/children/${s1}/fees`), me.token)).json().invoices[0].proofs.map((p: { txn_code: string }) => p.txn_code)).toEqual(["QST1CD2EF3"]);
      // a classmate's invoice: 403 with nothing stored; the classmate pays their own
      for (const r of [
        await call("POST", t("/finance/proofs"), me.token, proof(inv2, "QZZ9ZZ9ZZ9")),
        await call("GET", t(`/finance/invoices/${inv2}/pdf`), me.token),
        await call("POST", t("/finance/mpesa/prompts"), me.token, { invoice_id: inv2, amount_minor: 100000, msisdn: "254712345678" }),
        await call("PUT", t("/finance/ai-helper/optins"), me.token, { learner_id: s2, term_id: term, opted_in: true }),
        await call("GET", t(`/finance/invoices/${randomUUID()}/pdf`), me.token),
      ]) {
        expect(r.statusCode, r.body).toBe(403);
      }
      expect((await owner(`SELECT count(*)::int AS n FROM finance_payment_proofs WHERE txn_code = 'QZZ9ZZ9ZZ9'`))[0].n).toBe(0);
      expect((await call("GET", t(`/finance/invoices/${inv2}/pdf`), mate.token)).statusCode).toBe(200);
      const optin = await call("PUT", t("/finance/ai-helper/optins"), me.token, { learner_id: s1, term_id: term, opted_in: true });
      expect(optin.statusCode, optin.body).not.toBe(403); // past the payer check (the school may have no AI-helper settings)
    });

    it("notices: class and form-level notices reach the learners in them; role notices by role", async () => {
      const ids: Record<string, string> = {};
      for (const [key, audience] of [
        ["class1A", { kind: "class", class_id: class1A }],
        ["class2B", { kind: "class", class_id: class2B }],
        ["form1", { kind: "form_level", form_level: 1 }],
        ["form2", { kind: "form_level", form_level: 2 }],
        ["students", { kind: "role", role: "student" }],
        ["parents", { kind: "role", role: "parent" }],
      ] as const) {
        const r = await call("POST", t("/communications/announcements"), admin, { subject: `Notice ${key}`, body: "Hello", audience, channels: ["in_app"] });
        expect(r.statusCode, r.body).toBe(201);
        ids[key] = r.json().announcement.id;
        expect((await call("POST", t(`/communications/announcements/${ids[key]}/publish`), admin)).statusCode).toBe(200);
      }
      const inbox = async (token: string) => {
        const seen = new Set(((await call("GET", t("/communications/announcements/inbox?limit=200"), token)).json().announcements as Array<{ id: string }>).map((a) => a.id));
        return Object.keys(ids).filter((k) => seen.has(ids[k]!)).sort();
      };
      expect(await inbox(me.token)).toEqual(["class1A", "form1", "students"].sort());
      const s3Student = await signedIn(s3);
      expect(await inbox(s3Student.token)).toEqual(["class2B", "form2", "students"].sort());
      expect(await inbox(parent)).toEqual(["parents"]);
    });

    it("chat: the learner's class teachers and the school office only; the teacher side under the same rule", async () => {
      const contacts = await call("GET", t("/me/chat-contacts"), me.token);
      expect(contacts.statusCode, contacts.body).toBe(200);
      conforms("GET", "/v1/tenants/{tenantId}/me/chat-contacts", 200, contacts.json());
      const list = contacts.json().contacts as Array<Record<string, any>>;
      expect(list.find((c) => c.user_id === ctx.ids.adminA)).toMatchObject({ role: "school_admin" });
      expect(list.find((c) => c.user_id === ctx.ids.teacherA)).toMatchObject({ role: "teacher", teaches: [{ learner_id: s1, class_name: "Form 1 A", subject: "Mathematics" }] });
      expect(list.map((c) => c.user_id)).not.toContain(otherTeacherUser);
      expect(list.map((c) => c.user_id)).not.toContain(peopleUser);
      expect(list.every((c) => c.role === "school_admin" || c.role === "teacher")).toBe(true);

      const start = (token: string, peer: string) => call("POST", t("/chat/conversations"), token, { peer_user_id: peer });
      const conv = await start(me.token, ctx.ids.teacherA);
      expect(conv.statusCode, conv.body).toBe(201);
      expect((await call("POST", t(`/chat/conversations/${conv.json().conversation.id}/messages`), me.token, { body: "Hello teacher" })).statusCode).toBe(201);
      expect((await call("POST", t(`/chat/conversations/${conv.json().conversation.id}/messages`), teacher, { body: "Hello learner" })).statusCode).toBe(201);
      expect((await start(me.token, ctx.ids.adminA)).statusCode).toBe(201);
      for (const peer of [otherTeacherUser, peopleUser, mate.userId, ctx.ids.parentA]) expect((await start(me.token, peer)).statusCode, peer).toBe(403);
      expect((await start(teacher, me.userId)).statusCode).toBe(201);
      expect((await start(otherTeacher, me.userId)).statusCode).toBe(403);
      expect((await start(parent, me.userId)).statusCode).toBe(403);
      expect((await start(people, me.userId)).statusCode).toBe(403);
      expect((await start(mate.token, me.userId)).statusCode).toBe(403);
      // staff contact lists and parent contact lists are unchanged by this
      expect((await call("GET", t("/me/chat-contacts"), teacher)).statusCode).toBe(403);
    });
  });

  describe("online exams: published papers of the learner's own class, own attempts, no answer key", () => {
    let me: { token: string; userId: string };
    let mate: { token: string; userId: string };
    let paper: string;
    let other: string; // a paper of class 2B
    let blank: string; // a published paper with no questions
    const QUESTIONS = [
      { id: "q1", prompt: "Capital of Kenya?", kind: "mcq", options: ["Nairobi", "Mombasa"], correct_answer: "Nairobi", points: 2 },
      { id: "q2", prompt: "2 + 2 = 5", kind: "true_false", correct_answer: "false", points: 1 },
    ];

    beforeAll(async () => {
      me = await signedIn(await learner(A(), "Exam Sitter", class1A));
      mate = await signedIn(await learner(A(), "Exam Mate", class1A));
      paper = (await ok("POST", "/online-exam-papers", { class_id: class1A, subject_id: maths, title: "Geography quiz", max_score: 3, questions: QUESTIONS })).paper.id;
      other = (await ok("POST", "/online-exam-papers", { class_id: class2B, subject_id: maths, title: "2B quiz", max_score: 3, questions: QUESTIONS })).paper.id;
      blank = (await ok("POST", "/online-exam-papers", { class_id: class1A, subject_id: maths, title: "Paper exam", max_score: 50 })).paper.id;
    }, 120_000);

    it("an unpublished paper does not exist for a learner; publishing (staff only) makes it appear, without questions or key", async () => {
      expect((await call("GET", t("/me/learner/online-exams"), me.token)).json().papers).toEqual([]);
      const meId = (await call("GET", t("/me/learner"), me.token)).json().learner.learner_id as string;
      expect((await call("POST", t(`/online-exam-papers/${paper}/attempts`), me.token, { learner_id: meId })).statusCode).toBe(404);
      expect((await call("POST", t(`/online-exam-papers/${paper}/publish`), me.token)).statusCode).toBe(403);
      expect((await call("POST", t(`/online-exam-papers/${paper}/publish`), teacher)).statusCode).toBe(403); // no academics write
      const pub = await call("POST", t(`/online-exam-papers/${paper}/publish`), admin);
      expect(pub.statusCode, pub.body).toBe(200);
      conforms("POST", "/v1/tenants/{tenantId}/online-exam-papers/{paperId}/publish", 200, pub.json());
      const first = pub.json().paper.published_at as string;
      expect((await call("POST", t(`/online-exam-papers/${paper}/publish`), admin)).json().paper.published_at).toBe(first);
      await ok("POST", `/online-exam-papers/${other}/publish`);
      await ok("POST", `/online-exam-papers/${blank}/publish`);
      const list = await call("GET", t("/me/learner/online-exams"), me.token);
      expect(list.statusCode).toBe(200);
      conforms("GET", "/v1/tenants/{tenantId}/me/learner/online-exams", 200, list.json());
      expect(list.json().papers.map((p: { id: string }) => p.id).sort()).toEqual([paper, blank].sort()); // not 2B's paper
      expect(list.body).not.toMatch(/correct_answer|Capital of Kenya/);
      expect(list.json().papers.find((p: { id: string }) => p.id === paper)).toMatchObject({ question_count: 2, attempts: [], class: { id: class1A }, subject: { name: "Mathematics" } });
    });

    it("a learner starts, saves and submits their OWN attempt only; never with a score; never sees a key or a mark", async () => {
      const meId = (await call("GET", t("/me/learner"), me.token)).json().learner.learner_id as string;
      const mateId = (await call("GET", t("/me/learner"), mate.token)).json().learner.learner_id as string;
      // another learner's id, another class's paper, a paper with no questions
      expect((await call("POST", t(`/online-exam-papers/${paper}/attempts`), me.token, { learner_id: mateId })).statusCode).toBe(404);
      expect((await call("POST", t(`/online-exam-papers/${other}/attempts`), me.token, { learner_id: meId })).statusCode).toBe(404);
      expect((await call("POST", t(`/online-exam-papers/${blank}/attempts`), me.token, { learner_id: meId })).statusCode).toBe(409);
      const start = await call("POST", t(`/online-exam-papers/${paper}/attempts`), me.token, { learner_id: meId });
      expect(start.statusCode, start.body).toBe(201);
      conforms("POST", "/v1/tenants/{tenantId}/online-exam-papers/{paperId}/attempts", 201, start.json());
      expect(start.body).not.toContain("correct_answer");
      const attempt = start.json().attempt;
      expect(attempt.paper.questions.map((q: { id: string }) => q.id)).toEqual(["q1", "q2"]);
      expect((await call("POST", t(`/online-exam-papers/${paper}/attempts`), me.token, { learner_id: meId })).statusCode).toBe(409); // one attempt

      // the classmate cannot see, save or submit it
      expect((await call("GET", t(`/me/learner/online-exam-attempts/${attempt.id}`), mate.token)).statusCode).toBe(404);
      expect((await call("PUT", t(`/me/learner/online-exam-attempts/${attempt.id}/answers`), mate.token, { answers: { q1: "Mombasa" } })).statusCode).toBe(404);
      expect((await call("POST", t(`/online-exam-attempts/${attempt.id}/submit`), mate.token, { answers: { q1: "Mombasa" } })).statusCode).toBe(404);

      const saved = await call("PUT", t(`/me/learner/online-exam-attempts/${attempt.id}/answers`), me.token, { answers: { q1: "Nairobi" } });
      expect(saved.statusCode, saved.body).toBe(200);
      conforms("PUT", "/v1/tenants/{tenantId}/me/learner/online-exam-attempts/{attemptId}/answers", 200, saved.json());
      expect(saved.json().attempt.answers).toEqual({ q1: "Nairobi" });
      expect((await call("PUT", t(`/me/learner/online-exam-attempts/${attempt.id}/answers`), me.token, { answers: { q9: "x" } })).statusCode).toBe(400);
      const read = await call("GET", t(`/me/learner/online-exam-attempts/${attempt.id}`), me.token);
      conforms("GET", "/v1/tenants/{tenantId}/me/learner/online-exam-attempts/{attemptId}", 200, read.json());
      expect(read.body).not.toContain("correct_answer");

      const withScore = await call("POST", t(`/online-exam-attempts/${attempt.id}/submit`), me.token, { score: 3 });
      expect(withScore.statusCode).toBe(403);
      const submit = await call("POST", t(`/online-exam-attempts/${attempt.id}/submit`), me.token, { answers: { q1: "Nairobi", q2: "true" } });
      expect(submit.statusCode, submit.body).toBe(200);
      conforms("POST", "/v1/tenants/{tenantId}/online-exam-attempts/{attemptId}/submit", 200, submit.json());
      expect(submit.json().attempt).toEqual({ id: attempt.id, status: "submitted", submitted_at: expect.any(String) });
      expect(submit.body).not.toMatch(/mark|score/);
      expect((await call("POST", t(`/online-exam-attempts/${attempt.id}/submit`), me.token, { answers: {} })).statusCode).toBe(409);
      expect((await call("PUT", t(`/me/learner/online-exam-attempts/${attempt.id}/answers`), me.token, { answers: {} })).statusCode).toBe(409);
      // the school's mark: auto-marked against the key (2 of 3), marked by nobody
      const mark = await owner(`SELECT score::text AS s, marked_by FROM attempt_marks WHERE attempt_id = $1`, [attempt.id]);
      expect(mark[0]).toEqual({ s: "2", marked_by: null });
      const listed = (await call("GET", t("/me/learner/online-exams"), me.token)).json().papers.find((p: { id: string }) => p.id === paper);
      expect(listed.attempts).toEqual([{ id: attempt.id, status: "submitted", started_at: expect.any(String), submitted_at: expect.any(String) }]);
      // a learner cannot start an attempt for anyone through the staff body either (a random learner id)
      expect((await call("POST", t(`/online-exam-papers/${paper}/attempts`), me.token, { learner_id: randomUUID() })).statusCode).toBe(404);
      // staff keep their own path: an administrator starts and marks an attempt for the classmate
      const staffStart = await call("POST", t(`/online-exam-papers/${paper}/attempts`), admin, { learner_id: mateId });
      expect(staffStart.statusCode, staffStart.body).toBe(201);
      expect(staffStart.json().attempt).toMatchObject({ learner_id: mateId, status: "in_progress" });
    });
  });

  describe("a login that stops being live closes every read at once", () => {
    async function fresh() {
      const l = await learner(A(), "Lifecycle Learner", class1A);
      return { l, ...(await signedIn(l)) };
    }
    async function expectOpen(f: Awaited<ReturnType<typeof fresh>>) {
      expect((await call("GET", t("/me/learner"), f.token)).statusCode).toBe(200);
      for (const p of SHARED_PATHS) expect((await call("GET", t(`/me/children/${f.l}${p}`), f.token)).statusCode, p).toBe(200);
    }
    async function expectClosed(f: Awaited<ReturnType<typeof fresh>>, status: number) {
      expect((await call("GET", t("/me/learner"), f.token)).statusCode).toBe(status);
      for (const p of SHARED_PATHS) expect((await call("GET", t(`/me/children/${f.l}${p}`), f.token)).statusCode, p).toBe(status);
      expect((await call("GET", t("/me/learner/online-exams"), f.token)).statusCode).toBe(status);
    }

    it("revoked by the office (needs a recent password): sessions end, the login id stops signing in, a new create is a new login", async () => {
      const f = await fresh();
      await expectOpen(f);
      const freshAdmin = await login({ email: "admin-a@example.com", password: PASSWORD });
      expect((await call("POST", t(`/learners/${f.l}/student-account/revoke`), teacher, { reason: "left school" })).statusCode).toBe(403);
      const r = await call("POST", t(`/learners/${f.l}/student-account/revoke`), freshAdmin, { reason: "left school" });
      expect(r.statusCode, r.body).toBe(200);
      await expectClosed(f, 401);
      expect((await loginRaw({ tenantId: A(), loginId: f.loginId, password: OWN_PW })).statusCode).toBe(401);
      expect((await call("GET", t(`/learners/${f.l}/student-account`), freshAdmin)).json().account).toMatchObject({ has_login: false, revoked_logins: 1 });
      const again = await makeLogin(f.l, freshAdmin);
      expect(again.login_id).not.toBe(f.loginId);
      expect(again.user_id).not.toBe(f.userId);
    });

    it("an archived learner (the login still signs in, but reaches nothing)", async () => {
      const f = await fresh();
      await expectOpen(f);
      await owner(`UPDATE learners SET active = false, archived_at = now() WHERE id = $1`, [f.l]);
      await expectClosed(f, 404);
      // and the chat closes
      expect((await call("POST", t("/chat/conversations"), f.token, { peer_user_id: ctx.ids.adminA })).statusCode).toBe(403);
    });

    it("an archived membership (deactivated): the school refuses the caller, and the link is revoked for good", async () => {
      const f = await fresh();
      await expectOpen(f);
      await owner(`UPDATE school_memberships SET archived_at = now() WHERE user_id = $1 AND tenant_id = $2`, [f.userId, A()]);
      await expectClosed(f, 403);
      expect((await owner(`SELECT revoke_reason FROM learner_accounts WHERE user_id = $1`, [f.userId]))[0].revoke_reason).toBe("membership deactivated");
      await owner(`UPDATE school_memberships SET archived_at = NULL WHERE user_id = $1 AND tenant_id = $2`, [f.userId, A()]);
      await expectClosed(f, 404);
    });

    it("a disabled account", async () => {
      const f = await fresh();
      await expectOpen(f);
      await owner(`UPDATE users SET status = 'disabled' WHERE id = $1`, [f.userId]);
      await expectClosed(f, 401);
      const freshAdmin = await login({ email: "admin-a@example.com", password: PASSWORD });
      expect((await call("POST", t(`/learners/${f.l}/student-account/reset-password`), freshAdmin)).statusCode).toBe(409); // stays disabled
    });

    it("a reset by the office: a new one-time password once, every session ended, the change forced again", async () => {
      const f = await fresh();
      await expectOpen(f);
      expect((await call("POST", t(`/learners/${f.l}/student-account/reset-password`), teacher)).statusCode).toBe(403);
      const freshPeople = await login({ tenantId: A(), loginId: "SF-0901", password: PASSWORD });
      const r = await call("POST", t(`/learners/${f.l}/student-account/reset-password`), freshPeople);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.headers["cache-control"]).toBe("no-store");
      conforms("POST", "/v1/tenants/{tenantId}/learners/{learnerId}/student-account/reset-password", 200, r.json());
      const pw = r.json().account.one_time_password as string;
      expect(r.json().account).toMatchObject({ login_id: f.loginId, must_change_password: true });
      expect((await call("GET", t("/me/learner"), f.token)).statusCode).toBe(401); // the old session ended
      expect((await loginRaw({ tenantId: A(), loginId: f.loginId, password: OWN_PW })).statusCode).toBe(401);
      const tok = await login({ tenantId: A(), loginId: f.loginId, password: pw });
      expect((await call("GET", t("/me/learner"), tok)).json().error.message).toBe("Password change required");
      const audit = await owner(`SELECT detail::text AS d FROM security_audit_events WHERE event_type = 'student.account.password_reset' AND detail->>'userId' = $1`, [f.userId]);
      expect(audit).toHaveLength(1);
      expect(audit[0].d).not.toContain(pw);
      expect((await call("GET", t(`/learners/${f.l}/student-account`), freshPeople)).body).not.toContain(pw);
    });
  });
});
