import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSpec, responseSchema, validate } from "./support/openapiConformance.js";
import { createTestApp } from "./support.js";

/**
 * Family reads (A1, docs/FAMILY-READS.md), through the real figbloom_app login. Negative first: every per-child path is
 * refused for another family's child, another school's learner, a random id, staff, and each way a link stops being live
 * (revoked account link, archived relationship, archived guardian record, archived learner, archived parent membership,
 * disabled account).
 */
const PASSWORD = "correct-horse-battery";
const NEW_PW = "brand-new-passw0rd";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

/** Every per-child GET path, relative to /v1/tenants/{t}/me/children/{learnerId}. */
const CHILD_PATHS: string[] = ["/attendance", "/results", "/report-cards", "/homework", "/materials", "/timetable", "/fees", "/activities", "/items", "/behaviour", "/health", "/ai-helper"];

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

describe("family reads (A1)", () => {
  let ctx: Ctx;
  const spec = loadSpec();
  let admin: string;
  let teacher: string;
  const A = () => ctx.ids.tenantA;
  const B = () => ctx.ids.tenantB;
  const owner = async (sql: string, p: unknown[] = []) => (await ctx.pool.query(sql, p)).rows;

  async function login(body: Record<string, unknown>): Promise<string> {
    const r = await ctx.app.inject({ method: "POST", url: body.email ? "/v1/auth/login/email" : "/v1/auth/login/login-id", payload: body });
    expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
    return r.json().token as string;
  }
  const get = (url: string, token: string, tenant?: string) =>
    ctx.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}`, ...(tenant ? { "x-tenant-id": tenant } : {}) } });
  const call = (method: "GET" | "POST" | "PUT", url: string, token: string | undefined, payload?: unknown, tenant?: string) =>
    ctx.app.inject({
      method,
      url,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenant ? { "x-tenant-id": tenant } : {}) },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  function conforms(specPath: string, status: number, body: unknown) {
    const schema = responseSchema(spec, "GET", specPath, status);
    expect(typeof schema, `${specPath} ${status}`).toBe("object");
    const errs = validate(spec, schema, body);
    expect(errs, `${specPath} ${status}: ${errs.join("; ")}`).toEqual([]);
  }

  async function learner(tenant: string, name: string): Promise<string> {
    return (await owner(
      `INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, $2, $3, 'female') RETURNING id`,
      [tenant, "F" + randomUUID().slice(0, 8), name],
    ))[0].id as string;
  }
  async function guardian(tenant: string, email: string | null = null): Promise<string> {
    return (await owner(`INSERT INTO guardians (tenant_id, full_name, email, phone) VALUES ($1, 'A Guardian', $2, '0712345678') RETURNING id`, [tenant, email]))[0].id as string;
  }
  async function relate(tenant: string, g: string, l: string, primary = false): Promise<string> {
    return (await owner(
      `INSERT INTO guardian_links (tenant_id, guardian_id, learner_id, relationship, is_primary_payer) VALUES ($1, $2, $3, 'mother', $4) RETURNING id`,
      [tenant, g, l, primary],
    ))[0].id as string;
  }
  /** A parent account linked to a guardian record, as the migrator (the accept flow itself is covered by guardian.invitations). */
  async function parentAccount(tenant: string, g: string, loginId: string): Promise<{ userId: string; token: string }> {
    const userId = randomUUID();
    const hash = (await owner(`SELECT password_hash AS h FROM users WHERE id = $1`, [ctx.ids.adminA]))[0].h as string;
    await owner(`INSERT INTO users (id, email, password_hash, full_name, status) VALUES ($1, NULL, $2, 'A Parent', 'active')`, [userId, hash]);
    await owner(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'parent', $3)`, [userId, tenant, loginId]);
    await linkAccount(tenant, g, userId);
    return { userId, token: await login({ tenantId: tenant, loginId, password: PASSWORD }) };
  }
  async function linkAccount(tenant: string, g: string, userId: string): Promise<void> {
    const l = (await owner(`SELECT learner_id FROM guardian_links WHERE guardian_id = $1 AND archived_at IS NULL LIMIT 1`, [g]))[0].learner_id as string;
    const inv = (await owner(
      `INSERT INTO guardian_invitations (tenant_id, guardian_id, learner_id, contact_method, contact_value, token_hash, status, expires_at,
                                         accepted_at, accepted_by, contact_verification, closed_at)
       VALUES ($1, $2, $3, 'sms', '0712345678', $4, 'accepted', now() + interval '1 day', now(), $5, 'token_and_contact_echo', now()) RETURNING id`,
      [tenant, g, l, createHash("sha256").update(randomBytes(16)).digest("hex"), userId],
    ))[0].id as string;
    await owner(`INSERT INTO guardian_accounts (tenant_id, guardian_id, user_id, invitation_id) VALUES ($1, $2, $3, $4)`, [tenant, g, userId, inv]);
  }

  // The world: school A has class 1A (current year) with C1 (family 1), C3 (family 2); C2 (family 1) is in class 2B.
  // School B has CB (family B).
  let year: string;
  let term: string;
  let class1A: string;
  let class2B: string;
  let c1: string;
  let c2: string;
  let c3: string;
  let cb: string;
  let p1: string; // token, linked through the real invitation flow
  let p1User: string;
  let p2: string;
  let p2User: string;
  let pb: string;
  let lone: string; // a parent member with no link at all

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login({ email: "admin-a@example.com", password: PASSWORD });
    teacher = await login({ tenantId: A(), loginId: "TC-0001", password: PASSWORD });
    lone = await login({ tenantId: A(), loginId: "PT-0001", password: PASSWORD });

    year = (await owner(
      `INSERT INTO academic_years (tenant_id, label, starts_on, ends_on, is_current) VALUES ($1, 'This year', $2, $3, true) RETURNING id`,
      [A(), isoDay(-200), isoDay(160)],
    ))[0].id as string;
    term = (await owner(
      `INSERT INTO academic_terms (tenant_id, academic_year_id, index, label, starts_on, ends_on, is_current) VALUES ($1, $2, 1, 'Term 1', $3, $4, true) RETURNING id`,
      [A(), year, isoDay(-60), isoDay(30)],
    ))[0].id as string;
    class1A = (await owner(`INSERT INTO classes (tenant_id, academic_year_id, name, form_level, stream) VALUES ($1, $2, 'Form 1 A', 1, 'A') RETURNING id`, [A(), year]))[0].id as string;
    class2B = (await owner(`INSERT INTO classes (tenant_id, academic_year_id, name, form_level, stream) VALUES ($1, $2, 'Form 2 B', 2, 'B') RETURNING id`, [A(), year]))[0].id as string;
    c1 = await learner(A(), "Child One");
    c2 = await learner(A(), "Child Two");
    c3 = await learner(A(), "Child Three");
    cb = await learner(B(), "Child Bee");
    for (const [l, c] of [[c1, class1A], [c3, class1A], [c2, class2B]] as const) {
      await owner(`INSERT INTO class_memberships (tenant_id, learner_id, class_id, academic_year_id) VALUES ($1, $2, $3, $4)`, [A(), l, c, year]);
    }

    // family 1 through the real invitation + acceptance flow
    const email = `family-${randomUUID().slice(0, 8)}@example.com`;
    const g1 = await guardian(A(), email);
    await relate(A(), g1, c1, true);
    await relate(A(), g1, c2);
    const inv = await call("POST", `/v1/tenants/${A()}/guardians/${g1}/invitations`, admin, { learner_id: c1, method: "email" }, A());
    expect(inv.statusCode, JSON.stringify(inv.json())).toBe(201);
    const acc = await call("POST", "/v1/guardian-invitations/accept", undefined, { token: inv.json().invitation.token, contact: email, confirm: true, password: NEW_PW, full_name: "Parent One" });
    expect(acc.statusCode, JSON.stringify(acc.json())).toBe(200);
    p1 = await login({ email, password: NEW_PW });
    p1User = (await owner(`SELECT id FROM users WHERE lower(email) = $1`, [email]))[0].id as string;

    const g2 = await guardian(A());
    await relate(A(), g2, c3);
    const fam2 = await parentAccount(A(), g2, "PT-0902");
    p2 = fam2.token;
    p2User = fam2.userId;
    const gb = await guardian(B());
    await relate(B(), gb, cb);
    pb = (await parentAccount(B(), gb, "PT-0903")).token;
  }, 180_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  const base = (t: string) => `/v1/tenants/${t}/me/children`;

  describe("children list", () => {
    it("lists only the caller's own children in this school, with the current-year class", async () => {
      const r = await get(base(A()), p1, A());
      expect(r.statusCode, r.body).toBe(200);
      conforms("/v1/tenants/{tenantId}/me/children", 200, r.json());
      const kids = r.json().children as Array<Record<string, unknown>>;
      expect(kids.map((k) => k.learner_id).sort()).toEqual([c1, c2].sort());
      const one = kids.find((k) => k.learner_id === c1)!;
      expect(one).toMatchObject({ full_name: "Child One", relationship: "mother", is_primary_payer: true, boarding: false });
      expect(one.class).toMatchObject({ id: class1A, name: "Form 1 A", form_level: 1, stream: "A", academic_year_id: year });
      expect(kids.find((k) => k.learner_id === c2)!.class).toMatchObject({ id: class2B });
      expect(JSON.stringify(r.json())).not.toContain(c3);
    });

    it("another family sees only their own child; a parent with no link and another school's parent see nothing of school A", async () => {
      expect((await get(base(A()), p2, A())).json().children.map((k: { learner_id: string }) => k.learner_id)).toEqual([c3]);
      const none = await get(base(A()), lone, A());
      expect(none.statusCode).toBe(200);
      expect(none.json().children).toEqual([]);
      expect((await get(base(A()), pb, A())).statusCode).toBe(403); // no membership in school A
      expect((await get(base(B()), pb, B())).json().children.map((k: { learner_id: string }) => k.learner_id)).toEqual([cb]);
      expect((await get(base(B()), p1, B())).statusCode).toBe(403); // the path names school B, the caller is not a member
      expect((await get(base(B()), p1, A())).statusCode).toBe(403); // path and header disagree
    });

    it("staff (school administrator, teacher) are refused with an audited 403; anonymous is 401", async () => {
      expect((await get(base(A()), admin, A())).statusCode).toBe(403);
      expect((await get(base(A()), teacher, A())).statusCode).toBe(403);
      expect((await ctx.app.inject({ method: "GET", url: base(A()) })).statusCode).toBe(401);
      const denied = await owner(
        `SELECT detail->>'permission' AS p FROM security_audit_events WHERE event_type = 'rbac.permission.denied' AND actor_user_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
        [ctx.ids.teacherA],
      );
      expect(denied[0]?.p).toBe("resource.family.read");
    });

    it("the permission is in the parent's permission set", async () => {
      const r = await get("/v1/rbac/permissions", p1, A());
      expect(r.statusCode).toBe(200);
      expect(r.json().items).toContain("resource.family.read");
    });
  });

  describe("one child's school record", () => {
    const adm = (method: "GET" | "POST" | "PUT", path: string, payload?: unknown) => call(method, `/v1/tenants/${A()}${path}`, admin, payload, A());
    async function ok(method: "GET" | "POST" | "PUT", path: string, payload?: unknown): Promise<Record<string, any>> {
      const r = await adm(method, path, payload);
      expect([200, 201, 204], `${method} ${path}: ${r.body}`).toContain(r.statusCode);
      return r.statusCode === 204 ? {} : r.json();
    }
    const child = (learnerId: string, p: string, token = p1) => get(`${base(A())}/${learnerId}${p}`, token, A());
    let maths: string;
    let english: string;
    let published: string;
    let draft: string;
    let twoMarks: string;
    let other: string; // a third learner in class 1A, no family link

    beforeAll(async () => {
      other = await learner(A(), "Classmate Three");
      await owner(`INSERT INTO class_memberships (tenant_id, learner_id, class_id, academic_year_id) VALUES ($1, $2, $3, $4)`, [A(), other, class1A, year]);
      maths = (await ok("POST", "/subjects", { code: "MAT", name: "Mathematics" })).subject.id;
      english = (await ok("POST", "/subjects", { code: "ENG", name: "English" })).subject.id;

      // marks: a published assessment with 3 marks (mean shown), one with 2 marks (mean hidden), a draft (never shown)
      const assess = async (title: string, subject: string) =>
        (await ok("POST", "/assessments", { class_id: class1A, subject_id: subject, term_id: term, title, kind: "exam", max_score: 100 })).assessment.id as string;
      published = await assess("Midterm maths", maths);
      twoMarks = await assess("Spelling quiz", english);
      draft = await assess("Unreleased test", maths);
      for (const [a, l, score] of [[published, c1, 70], [published, c3, 50], [published, other, 90], [twoMarks, c1, 8], [twoMarks, c3, 6], [draft, c1, 99]] as const) {
        await ok("POST", `/assessments/${a}/marks`, { learner_id: l, score });
      }
      await ok("POST", `/assessments/${published}/publish`);
      await ok("POST", `/assessments/${twoMarks}/publish`);
      await ok("POST", "/report-cards", { term_id: term, class_id: class1A });

      // CBE: a published observation with results for c1 and c3, and a draft with a result for c1
      const prov = (await ok("POST", "/curriculum-provenance", { source_kind: "school_configured", source_label: "School pack" })).provenance.id;
      const area = (await ok("POST", "/learning-areas", { provenance_id: prov, code: "ENGA", name: "English Activities" })).learning_area.id;
      const strand = (await ok("POST", "/strands", { learning_area_id: area, code: "LIST", name: "Listening" })).strand.id;
      const rubric = (await ok("POST", "/rubric-configs", {
        name: "Levels",
        scoring_mode: "level_only",
        descriptors: [{ level_code: "EE", label: "Exceeding" }, { level_code: "ME", label: "Meeting" }, { level_code: "AE", label: "Approaching" }, { level_code: "BE", label: "Below" }],
      })).rubric_config.id;
      const cbe = async (title: string) =>
        (await ok("POST", "/cbe-assessments", { class_id: class1A, learning_area_id: area, term_id: term, title, rubric_config_id: rubric, strand_id: strand })).cbe_assessment.id as string;
      const cbePub = await cbe("Listening observation");
      const cbeDraft = await cbe("Draft observation");
      await ok("POST", `/cbe-assessments/${cbePub}/results`, { learner_id: c1, strand_id: strand, level_code: "ME", teacher_feedback: "Good listener" });
      await ok("POST", `/cbe-assessments/${cbePub}/results`, { learner_id: c3, strand_id: strand, level_code: "BE", teacher_feedback: "Needs help" });
      await ok("POST", `/cbe-assessments/${cbeDraft}/results`, { learner_id: c1, strand_id: strand, level_code: "EE" });
      await ok("POST", `/cbe-assessments/${cbePub}/publish`);

      // attendance (morning and afternoon) and early sign-outs, one voided
      await owner(`INSERT INTO attendance_settings (tenant_id, afternoon_enabled) VALUES ($1, true) ON CONFLICT (tenant_id) DO UPDATE SET afternoon_enabled = true`, [A()]);
      for (const [l, day, mark] of [[c1, -1, "present"], [c1, -2, "absent"], [c3, -1, "late"]] as const) {
        await owner(`INSERT INTO attendance (tenant_id, learner_id, class_id, term_id, taken_by, taken_on, mark) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [A(), l, class1A, term, ctx.ids.adminA, isoDay(day), mark]);
      }
      await owner(`INSERT INTO attendance_afternoon (tenant_id, learner_id, class_id, term_id, taken_by, taken_on, mark) VALUES ($1, $2, $3, $4, $5, $6, 'excused')`, [A(), c1, class1A, term, ctx.ids.adminA, isoDay(-1)]);
      for (const [l, reason, voided] of [[c1, "Dentist", false], [c1, "Entered by mistake", true], [c3, "Fever", false]] as const) {
        await owner(
          `INSERT INTO early_sign_outs (tenant_id, learner_id, class_id, learner_name, class_name, taken_on, signed_out_at, signed_out_local, reason,
                                        collected_by_name, collected_by_relationship, recorded_by, voided_at, voided_by)
           VALUES ($1, $2, $3, 'x', 'Form 1 A', $4, now() - interval '1 day', '10:00', $5, 'Aunt Jane', 'aunt', $6, $7, $8)`,
          [A(), l, class1A, isoDay(-1), reason, ctx.ids.adminA, voided ? new Date() : null, voided ? ctx.ids.adminA : null],
        );
      }

      // homework and materials: class 1A (C1's) and class 2B (C2's); one homework item is old
      await ok("POST", "/homework-items", {
        class_id: class1A,
        subject_id: maths,
        term_id: term,
        title: "Fractions sheet",
        due_on: isoDay(3),
        body: "Page 12",
        hand_in: "in_person",
        parent_guide: { about: "Fractions practice", needs: ["Exercise book"], help: "Ask the child to explain their answer", avoid: "Do not give the answer", minutes: 20 },
      });
      await ok("POST", "/homework-items", { class_id: class1A, subject_id: maths, term_id: term, title: "Old sheet", due_on: isoDay(-30), body: "Page 2" });
      await ok("POST", "/homework-items", { class_id: class2B, subject_id: english, term_id: term, title: "2B essay", due_on: isoDay(3), body: "Write" });
      await ok("POST", "/learning-materials", { title: "Fractions notes", class_id: class1A, subject_id: maths });
      await ok("POST", "/learning-materials", { title: "2B reader", class_id: class2B });

      // timetable: a teacher (staff record linked to the teacher's account) teaches maths in 1A
      const staff = (await ok("POST", "/staff", { full_name: "Teacher Tia", classification: "teacher", userId: ctx.ids.teacherA })).staff.id;
      const ta = (await ok("POST", "/teaching-assignments", { staff_member_id: staff, class_id: class1A, subject_id: maths })).assignment.id;
      await ok("POST", "/timetable-slots", { class_id: class1A, subject_id: maths, teaching_assignment_id: ta, day_of_week: 1, starts_at: "08:00", ends_at: "08:40", room: "Lab 1" });
      await ok("POST", "/timetable-slots", { class_id: class1A, subject_id: english, day_of_week: 1, starts_at: "07:20", ends_at: "08:00" });
    }, 180_000);

    it("attendance: the child's own marks for both sessions and early sign-outs that were not voided", async () => {
      const r = await child(c1, "/attendance");
      expect(r.statusCode, r.body).toBe(200);
      conforms("/v1/tenants/{tenantId}/me/children/{learnerId}/attendance", 200, r.json());
      const a = r.json().attendance;
      expect(a.marks).toEqual([
        { date: isoDay(-2), session: "morning", mark: "absent" },
        { date: isoDay(-1), session: "morning", mark: "present" },
        { date: isoDay(-1), session: "afternoon", mark: "excused" },
      ]);
      expect(a.counts).toEqual({ morning: { absent: 1, present: 1 }, afternoon: { excused: 1 } });
      expect(a.early_sign_outs.map((e: { reason: string }) => e.reason)).toEqual(["Dentist"]);
      expect(JSON.stringify(a)).not.toContain("late"); // C3's mark
      expect(JSON.stringify(a)).not.toContain("Fever");
      // an explicit window, and the bounds
      const one = await child(c1, `/attendance?from=${isoDay(-1)}&to=${isoDay(-1)}`);
      expect(one.json().attendance.marks).toHaveLength(2);
      expect((await child(c1, `/attendance?from=${isoDay(0)}&to=${isoDay(-5)}`)).statusCode).toBe(400);
      expect((await child(c1, `/attendance?from=${isoDay(-400)}&to=${isoDay(0)}`)).statusCode).toBe(400);
      expect((await child(c1, "/attendance?from=2026-02-31&to=2026-03-01")).statusCode).toBe(400);
    });

    it("results: own marks on published assessments only; the class mean needs at least three marks; CBE published only", async () => {
      const r = await child(c1, "/results");
      expect(r.statusCode, r.body).toBe(200);
      conforms("/v1/tenants/{tenantId}/me/children/{learnerId}/results", 200, r.json());
      const marks = r.json().marks as Array<Record<string, any>>;
      expect(marks.map((m) => m.assessment_id).sort()).toEqual([published, twoMarks].sort());
      const mid = marks.find((m) => m.assessment_id === published)!;
      expect(mid).toMatchObject({ title: "Midterm maths", score: "70", max_score: "100", class_mean: "70.00", status: "published", subject: { name: "Mathematics" }, term: { id: term, label: "Term 1" } });
      expect(marks.find((m) => m.assessment_id === twoMarks)!.class_mean).toBeNull();
      expect(JSON.stringify(r.json())).not.toContain(draft);
      expect(JSON.stringify(r.json())).not.toContain('"99"');
      const cbe = r.json().cbe_results as Array<Record<string, any>>;
      expect(cbe).toHaveLength(1);
      expect(cbe[0]).toMatchObject({ title: "Listening observation", level_code: "ME", teacher_feedback: "Good listener", learning_area: { name: "English Activities" }, strand: { name: "Listening" } });
      expect(JSON.stringify(r.json())).not.toContain("Needs help");
      // another family's child sees their own score, not C1's
      const theirs = await child(c3, "/results", p2);
      expect(theirs.json().marks.find((m: { assessment_id: string }) => m.assessment_id === published).score).toBe("50");
      // a term filter
      expect((await child(c1, `/results?termId=${randomUUID()}`)).json().marks).toEqual([]);
      expect((await child(c1, "/results?termId=nope")).statusCode).toBe(400);
    });

    it("report cards: the child's own slice of the published class snapshot, nothing of classmates", async () => {
      const r = await child(c1, "/report-cards");
      expect(r.statusCode, r.body).toBe(200);
      conforms("/v1/tenants/{tenantId}/me/children/{learnerId}/report-cards", 200, r.json());
      const cards = r.json().report_cards as Array<Record<string, any>>;
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ term: { id: term }, class: { id: class1A, name: "Form 1 A" }, summary: { sum: "78", count: 2, average: "39.00" } });
      const text = JSON.stringify(r.json());
      for (const leak of [c3, other, "Needs help"]) expect(text).not.toContain(leak);
      // C2 (class 2B) has no report card; C3's family sees C3's own figures
      expect((await child(c2, "/report-cards")).json().report_cards).toEqual([]);
      const c3card = (await child(c3, "/report-cards", p2)).json().report_cards[0];
      expect(c3card.summary).toMatchObject({ sum: "56", count: 2 });
      expect(JSON.stringify(c3card)).not.toContain(c1);
    });

    it("homework and materials: the child's current class only; old homework only on request", async () => {
      const hw = await child(c1, "/homework");
      expect(hw.statusCode, hw.body).toBe(200);
      conforms("/v1/tenants/{tenantId}/me/children/{learnerId}/homework", 200, hw.json());
      expect(hw.json().homework.map((h: { title: string }) => h.title)).toEqual(["Fractions sheet"]);
      expect(hw.json().homework[0].subject).toEqual({ id: maths, name: "Mathematics" });
      expect(hw.json().homework[0]).toMatchObject({
        hand_in: "in_person",
        teacher_name: "Admin A",
        parent_guide: { about: "Fractions practice", needs: ["Exercise book"], help: "Ask the child to explain their answer", avoid: "Do not give the answer", minutes: 20 },
      });
      const all = await child(c1, `/homework?from=${isoDay(-60)}`);
      expect(all.json().homework.map((h: { title: string }) => h.title)).toEqual(["Old sheet", "Fractions sheet"]);
      expect((await child(c2, "/homework")).json().homework.map((h: { title: string }) => h.title)).toEqual(["2B essay"]);
      const mat = await child(c1, "/materials");
      expect(mat.statusCode, mat.body).toBe(200);
      conforms("/v1/tenants/{tenantId}/me/children/{learnerId}/materials", 200, mat.json());
      expect(mat.json().materials.map((m: { title: string }) => m.title)).toEqual(["Fractions notes"]);
      expect((await child(c2, "/materials")).json().materials.map((m: { title: string }) => m.title)).toEqual(["2B reader"]);
    });

    it("timetable: nothing until a timetable is published; then the published slots with subject and teacher", async () => {
      expect((await child(c1, "/timetable")).json()).toEqual({ timetable: null });
      const pub = (await ok("POST", "/timetable-publications", { class_id: class1A, term_id: term })).publication.id;
      expect((await child(c1, "/timetable")).json()).toEqual({ timetable: null }); // a draft
      await ok("POST", `/timetable-publications/${pub}/publish`);
      // a later slot change is not visible until it is published again
      await ok("POST", "/timetable-slots", { class_id: class1A, subject_id: english, day_of_week: 2, starts_at: "09:00", ends_at: "09:40" });
      const r = await child(c1, "/timetable");
      expect(r.statusCode, r.body).toBe(200);
      conforms("/v1/tenants/{tenantId}/me/children/{learnerId}/timetable", 200, r.json());
      const t = r.json().timetable;
      expect(t).toMatchObject({ publication_id: pub, version: 1, class: { id: class1A } });
      expect(t.slots).toEqual([
        { day_of_week: 1, starts_at: "07:20", ends_at: "08:00", room: null, subject: { id: english, name: "English" }, teacher_name: null },
        { day_of_week: 1, starts_at: "08:00", ends_at: "08:40", room: "Lab 1", subject: { id: maths, name: "Mathematics" }, teacher_name: "Teacher Tia" },
      ]);
      expect((await child(c2, "/timetable")).json()).toEqual({ timetable: null }); // class 2B has none
    });
  });

  describe("fees, and paying through the payer link", () => {
    const fin = (method: "GET" | "POST" | "PUT", path: string, token: string, payload?: unknown) => call(method, `/v1/tenants/${A()}/finance${path}`, token, payload, A());
    let inv1: string; // C1's invoice
    let inv3: string; // C3's invoice

    beforeAll(async () => {
      const item = await fin("POST", "/fee-items", admin, { term_id: term, name: "Tuition", amount_minor: 500000, applies_to: "all" });
      expect(item.statusCode, item.body).toBe(201);
      const run = await fin("POST", "/billing-runs", admin, { term_id: term, due_on: isoDay(10) });
      expect(run.statusCode, run.body).toBe(201);
      const invoiceOf = async (l: string) => (await owner(`SELECT id FROM finance_invoices WHERE tenant_id = $1 AND learner_id = $2`, [A(), l]))[0].id as string;
      inv1 = await invoiceOf(c1);
      inv3 = await invoiceOf(c3);
      expect((await fin("POST", "/payments", admin, { invoice_id: inv1, amount_minor: 100000, method: "cash" })).statusCode).toBe(201);
      expect((await fin("POST", "/payments", admin, { invoice_id: inv3, amount_minor: 200000, method: "bank", reference: "BANK-C3" })).statusCode).toBe(201);
      expect((await fin("POST", `/invoices/${inv1}/charges`, admin, { amount_minor: 20000, reason: "Lost library book" })).statusCode).toBe(200);
      expect((await fin("POST", `/invoices/${inv1}/charges`, admin, { amount_minor: 5000, reason: "Charged in error" })).statusCode).toBe(200);
      const wrong = (await owner(`SELECT id FROM finance_charges WHERE invoice_id = $1 AND reason = 'Charged in error'`, [inv1]))[0].id as string;
      expect((await fin("POST", `/invoices/${inv1}/charges/${wrong}/void`, admin, { reason: "Not owed" })).statusCode).toBe(200);
      // a pending M-Pesa prompt row with a phone number, as the office or another guardian would leave behind
      await owner(
        `INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status, msisdn, checkout_request_id)
         VALUES ($1, $2, 10000, 'mpesa', 'pending', '254712000999', $3)`,
        [A(), inv1, `ws_CO_${randomUUID().slice(0, 12)}`],
      );
    }, 120_000);

    it("the child's invoice with lines, live charges, payments and proofs; no phone number, nothing of another learner", async () => {
      const r = await get(`${base(A())}/${c1}/fees`, p1, A());
      expect(r.statusCode, r.body).toBe(200);
      conforms("/v1/tenants/{tenantId}/me/children/{learnerId}/fees", 200, r.json());
      const invs = r.json().invoices as Array<Record<string, any>>;
      expect(invs).toHaveLength(1);
      expect(invs[0]).toMatchObject({
        id: inv1,
        term: { id: term, label: "Term 1" },
        lines_minor: 500000,
        charges_minor: 20000,
        total_minor: 520000,
        paid_minor: 100000,
        balance_minor: 420000,
        status: "part_paid",
        lines: [{ name: "Tuition", amount_minor: 500000 }],
      });
      expect(invs[0]!.charges.map((c: { reason: string }) => c.reason)).toEqual(["Lost library book"]);
      expect(invs[0]!.payments.map((p: { method: string; status: string }) => `${p.method}:${p.status}`).sort()).toEqual(["cash:success", "mpesa:pending"]);
      const text = JSON.stringify(r.json());
      for (const leak of ["254712000999", "msisdn", "recorded_by", "created_by", inv3, "BANK-C3", c3]) expect(text).not.toContain(leak);
      // C2 has an invoice of its own; C3's family sees C3's
      expect((await get(`${base(A())}/${c3}/fees`, p2, A())).json().invoices.map((i: { id: string }) => i.id)).toEqual([inv3]);
    });

    it("assertMayPayFor: a linked parent may pay and send a proof for their child's invoice; nobody else may", async () => {
      const proof = (invoiceId: string, code: string) => ({ invoice_id: invoiceId, sms_text: `${code} Confirmed. Ksh1,000.00 sent to SCHOOL for account FIG`, txn_source: "mpesa", txn_code: code });
      // linked parent: the proof is accepted, the PDF is served, the prompt passes the payer check (no provider is configured here: 503)
      const mine = await fin("POST", "/proofs", p1, proof(inv1, "QAB1CD2EF3"));
      expect(mine.statusCode, mine.body).toBe(201);
      expect(mine.json().proof.submitted_via).toBe("guardian");
      const pdf = await fin("GET", `/invoices/${inv1}/pdf`, p1);
      expect(pdf.statusCode, pdf.body.slice(0, 200)).toBe(200);
      expect(pdf.headers["content-type"]).toContain("application/pdf");
      const prompt = await fin("POST", "/mpesa/prompts", p1, { invoice_id: inv1, amount_minor: 100000, msisdn: "254712345678" });
      expect(prompt.statusCode, prompt.body).not.toBe(403);
      // the proof now shows on the family's fees read
      const fees = await get(`${base(A())}/${c1}/fees`, p1, A());
      expect(fees.json().invoices[0].proofs.map((p: { txn_code: string }) => p.txn_code)).toEqual(["QAB1CD2EF3"]);

      // another family, a parent with no link, a teacher, another school's parent: 403 with the same message, nothing stored
      for (const [who, tenant] of [[p2, A()], [lone, A()], [teacher, A()]] as const) {
        for (const r of [
          await call("POST", `/v1/tenants/${tenant}/finance/proofs`, who, proof(inv1, "QZZ9ZZ9ZZ9"), tenant),
          await call("GET", `/v1/tenants/${tenant}/finance/invoices/${inv1}/pdf`, who, undefined, tenant),
          await call("POST", `/v1/tenants/${tenant}/finance/mpesa/prompts`, who, { invoice_id: inv1, amount_minor: 100000, msisdn: "254712345678" }, tenant),
        ]) {
          expect(r.statusCode).toBe(403);
        }
      }
      expect((await call("GET", `/v1/tenants/${A()}/finance/invoices/${randomUUID()}/pdf`, p1, undefined, A())).statusCode).toBe(403); // a missing invoice looks the same
      expect((await owner(`SELECT count(*)::int AS n FROM finance_payment_proofs WHERE txn_code = 'QZZ9ZZ9ZZ9'`))[0].n).toBe(0);
      // the same parent for another family's child's invoice
      expect((await fin("POST", "/proofs", p1, proof(inv3, "QYY8YY8YY8"))).statusCode).toBe(403);
    });

    it("a revoked link takes the payer power away at once", async () => {
      const l = await learner(A(), "Payer Child");
      const g = await guardian(A());
      await relate(A(), g, l);
      const fam = await parentAccount(A(), g, "PT-0950");
      await call("POST", `/v1/tenants/${A()}/finance/billing-runs`, admin, { term_id: term, due_on: isoDay(10) }, A());
      const inv = (await owner(`SELECT id FROM finance_invoices WHERE tenant_id = $1 AND learner_id = $2`, [A(), l]))[0].id as string;
      expect((await call("GET", `/v1/tenants/${A()}/finance/invoices/${inv}/pdf`, fam.token, undefined, A())).statusCode).toBe(200);
      expect((await call("POST", `/v1/tenants/${A()}/guardians/${g}/account-link/revoke`, admin, { reason: "left the family" }, A())).statusCode).toBe(200);
      expect((await call("GET", `/v1/tenants/${A()}/finance/invoices/${inv}/pdf`, fam.token, undefined, A())).statusCode).toBe(403);
    });
  });

  describe("clubs, issued items and health", () => {
    const adm = (method: "GET" | "POST" | "PUT", path: string, payload?: unknown) => call(method, `/v1/tenants/${A()}${path}`, admin, payload, A());
    async function ok(method: "GET" | "POST" | "PUT", path: string, payload?: unknown): Promise<Record<string, any>> {
      const r = await adm(method, path, payload);
      expect([200, 201, 204], `${method} ${path}: ${r.body}`).toContain(r.statusCode);
      return r.statusCode === 204 ? {} : r.json();
    }
    const child = (learnerId: string, p: string, token = p1) => get(`${base(A())}/${learnerId}${p}`, token, A());
    let authorization: string;

    beforeAll(async () => {
      const chess = (await ok("POST", "/activities", { name: "Chess club", category: "club", meeting_schedule: "Fridays 4pm" })).activity.id;
      const choir = (await ok("POST", "/activities", { name: "Choir", category: "arts" })).activity.id;
      await ok("POST", `/activities/${chess}/members`, { learner_id: c1, role: "Captain" });
      await ok("POST", `/activities/${chess}/members`, { learner_id: c3 });
      await ok("POST", `/activities/${choir}/members`, { learner_id: c3 });
      await ok("POST", `/activities/${chess}/patrons`, { teacher_user_id: ctx.ids.teacherA });

      const book = (await ok("POST", "/inventory/items", { name: "Maths textbook", category: "textbooks", tracking: "asset", asset_tag: "BK-001" })).item.id;
      const jumper = (await ok("POST", "/inventory/items", { name: "School jumper", category: "uniforms", tracking: "asset", asset_tag: "UN-007" })).item.id;
      await ok("POST", "/inventory/issues", { item_id: book, learner_id: c1, due_on: isoDay(60) });
      await ok("POST", "/inventory/issues", { item_id: jumper, learner_id: c3 });

      await ok("PUT", `/health/learners/${c1}/profile`, { blood_group: "O+", allergies: ["Peanuts"], chronic_conditions: [] });
      await ok("PUT", `/health/learners/${c3}/profile`, { blood_group: "A-", allergies: ["Penicillin"] });
      authorization = (await ok("POST", "/health/medications/authorizations", {
        learner_id: c1, medication_name: "Salbutamol", dosage_instruction: "2 puffs", frequency_instruction: "when needed", route: "inhaled",
        start_date: isoDay(0), end_date: isoDay(30),
      })).authorization.id;
      await ok("POST", "/health/medications/authorizations", {
        learner_id: c3, medication_name: "Amoxicillin", dosage_instruction: "250mg", frequency_instruction: "3 times a day", start_date: isoDay(0), end_date: isoDay(7),
      });
      await ok("POST", "/health/sick-bay/visits", { learner_id: c1, complaint: "Headache", temperature_c: 37.4, treatment: "Rest" });
      await ok("POST", "/health/sick-bay/visits", { learner_id: c3, complaint: "Stomach ache" });
    }, 120_000);

    it("activities: the child's own clubs with patron names, nothing of a classmate's", async () => {
      const r = await child(c1, "/activities");
      expect(r.statusCode, r.body).toBe(200);
      conforms("/v1/tenants/{tenantId}/me/children/{learnerId}/activities", 200, r.json());
      expect(r.json().activities).toEqual([
        expect.objectContaining({ name: "Chess club", category: "club", meeting_schedule: "Fridays 4pm", active: true, role: "Captain", patrons: ["Teacher A"] }),
      ]);
      expect(JSON.stringify(r.json())).not.toContain("Choir");
      expect((await child(c3, "/activities", p2)).json().activities.map((a: { name: string }) => a.name)).toEqual(["Chess club", "Choir"]);
    });

    it("items: what was issued to the child only", async () => {
      const r = await child(c1, "/items");
      expect(r.statusCode, r.body).toBe(200);
      conforms("/v1/tenants/{tenantId}/me/children/{learnerId}/items", 200, r.json());
      expect(r.json().items).toEqual([expect.objectContaining({ item: { name: "Maths textbook", category: "textbooks", asset_tag: "BK-001" }, quantity: 1, status: "out", due_on: isoDay(60) })]);
      expect(JSON.stringify(r.json())).not.toContain("UN-007");
    });

    it("health: profile, authorizations a parent can consent to, sick-bay visits; nothing of another learner", async () => {
      const r = await child(c1, "/health");
      expect(r.statusCode, r.body).toBe(200);
      conforms("/v1/tenants/{tenantId}/me/children/{learnerId}/health", 200, r.json());
      const h = r.json().health;
      expect(h.profile).toMatchObject({ blood_group: "O+", allergies: ["Peanuts"] });
      expect(h.medication_authorizations).toEqual([expect.objectContaining({ id: authorization, medication_name: "Salbutamol", status: "pending_consent", guardian_consent_status: "pending" })]);
      expect(h.sick_bay_visits).toEqual([expect.objectContaining({ complaint: "Headache", temperature_c: "37.4", treatment: "Rest" })]);
      for (const leak of ["Penicillin", "Amoxicillin", "Stomach ache"]) expect(JSON.stringify(r.json())).not.toContain(leak);
      // the parent answers through the existing consent endpoint, and the read shows it
      const consent = await call("POST", `/v1/tenants/${A()}/health/medications/authorizations/${authorization}/consent`, p1, { decision: "granted" }, A());
      expect(consent.statusCode, consent.body).toBe(200);
      expect((await child(c1, "/health")).json().health.medication_authorizations[0].guardian_consent_status).toBe("granted");
      // a child with no health record
      expect((await child(c2, "/health")).json().health).toEqual({ profile: null, medication_authorizations: [], medication_schedules: [], medication_administrations: [], sick_bay_visits: [] });
    });

    it("study-helper read conforms to OpenAPI, supplies current_term for PUT /finance/ai-helper/optins, and leaks no co-guardian user id", async () => {
      const initial = await child(c1, "/ai-helper");
      expect(initial.statusCode, initial.body).toBe(200);
      conforms("/v1/tenants/{tenantId}/me/children/{learnerId}/ai-helper", 200, initial.json());
      expect(initial.json().ai_helper).toEqual({
        school_on: false,
        access_mode: "all",
        price_minor: 0,
        currency: "KES",
        cancel_days: 7,
        billing_enabled: false,
        current_term: { id: term, label: "Term 1" },
        optin: null,
      });

      const cfg = await call("PUT", `/v1/tenants/${A()}/finance/ai-helper/settings`, admin, { access_mode: "opt_in", price_minor: 50_000, cancel_days: 7 }, A());
      expect(cfg.statusCode, cfg.body).toBe(200);
      const put = await call("PUT", `/v1/tenants/${A()}/finance/ai-helper/optins`, p1, { learner_id: c1, term_id: initial.json().ai_helper.current_term.id, opted_in: true }, A());
      expect(put.statusCode, put.body).toBe(200);

      const after = await child(c1, "/ai-helper");
      expect(after.statusCode, after.body).toBe(200);
      conforms("/v1/tenants/{tenantId}/me/children/{learnerId}/ai-helper", 200, after.json());
      expect(after.json().ai_helper).toMatchObject({
        school_on: true,
        access_mode: "opt_in",
        price_minor: 50_000,
        current_term: { id: term, label: "Term 1" },
        optin: { opted_in: true },
      });
      expect(JSON.stringify(after.json())).not.toContain(p1User);
      expect((await child(c2, "/ai-helper")).json().ai_helper.optin).toBeNull();
    });
  });

  describe("announcements inbox and chat for families", () => {
    const comms = (method: "GET" | "POST", path: string, token: string, payload?: unknown) => call(method, `/v1/tenants/${A()}${path}`, token, payload, A());
    const ids: Record<string, string> = {};
    let otherTeacher: string; // a teacher of school A who teaches none of family 1's children
    let otherTeacherUser: string;

    beforeAll(async () => {
      const post = async (key: string, audience: Record<string, unknown>, publish = true) => {
        const r = await comms("POST", "/communications/announcements", admin, { subject: `Notice ${key}`, body: "Hello", audience, channels: ["in_app"] });
        expect(r.statusCode, r.body).toBe(201);
        ids[key] = r.json().announcement.id;
        if (publish) expect((await comms("POST", `/communications/announcements/${ids[key]}/publish`, admin)).statusCode).toBe(200);
      };
      await post("class1A", { kind: "class", class_id: class1A });
      await post("class2B", { kind: "class", class_id: class2B });
      await post("form2", { kind: "form_level", form_level: 2 });
      await post("form3", { kind: "form_level", form_level: 3 });
      await post("parents", { kind: "role", role: "parent" });
      await post("teachers", { kind: "role", role: "teacher" });
      await post("draft1A", { kind: "class", class_id: class1A }, false);

      otherTeacherUser = randomUUID();
      const hash = (await owner(`SELECT password_hash AS h FROM users WHERE id = $1`, [ctx.ids.adminA]))[0].h as string;
      await owner(`INSERT INTO users (id, email, password_hash, full_name, status) VALUES ($1, NULL, $2, 'Teacher Other', 'active')`, [otherTeacherUser, hash]);
      await owner(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'teacher', 'TC-0777')`, [otherTeacherUser, A()]);
      const staff = await comms("POST", "/staff", admin, { full_name: "Teacher Other", classification: "teacher", userId: otherTeacherUser });
      expect(staff.statusCode, staff.body).toBe(201);
      otherTeacher = await login({ tenantId: A(), loginId: "TC-0777", password: PASSWORD });
    }, 120_000);

    const inbox = async (token: string) => {
      const r = await comms("GET", "/communications/announcements/inbox?limit=200", token);
      expect(r.statusCode, r.body).toBe(200);
      const seen = new Set((r.json().announcements as Array<{ id: string }>).map((a) => a.id));
      return Object.keys(ids).filter((k) => seen.has(ids[k]!)).sort();
    };

    it("a class or form-level notice reaches the parents of children in it, and nobody else's parents", async () => {
      expect(await inbox(p1)).toEqual(["class1A", "class2B", "form2", "parents"].sort()); // C1 in 1A, C2 in 2B (form 2)
      expect(await inbox(p2)).toEqual(["class1A", "parents"].sort()); // C3 in 1A only
      expect(await inbox(lone)).toEqual(["parents"]); // no linked child
      expect(await inbox(teacher)).toEqual(["class1A", "teachers"]); // staff reach unchanged: the teacher teaches maths in 1A
    });

    it("chat contacts: the school administrators and the teachers of the caller's children", async () => {
      const r = await comms("GET", "/me/chat-contacts", p1);
      expect(r.statusCode, r.body).toBe(200);
      conforms("/v1/tenants/{tenantId}/me/chat-contacts", 200, r.json());
      const contacts = r.json().contacts as Array<Record<string, any>>;
      expect(contacts.find((c) => c.user_id === ctx.ids.adminA)).toMatchObject({ role: "school_admin", teaches: [] });
      expect(contacts.find((c) => c.user_id === ctx.ids.teacherA)).toMatchObject({ role: "teacher", full_name: "Teacher A", teaches: [{ learner_id: c1, class_name: "Form 1 A", subject: "Mathematics" }] });
      expect(contacts.some((c) => c.user_id === otherTeacherUser)).toBe(false);
      expect((await comms("GET", "/me/chat-contacts", lone)).json().contacts.map((c: { role: string }) => c.role)).toEqual(["school_admin"]);
      expect((await comms("GET", "/me/chat-contacts", teacher)).statusCode).toBe(403);
    });

    it("a parent may chat with their child's teacher (either may start), not with another teacher or another parent", async () => {
      const start = await comms("POST", "/chat/conversations", p1, { peer_user_id: ctx.ids.teacherA });
      expect(start.statusCode, start.body).toBe(201);
      const conv = start.json().conversation.id as string;
      expect((await comms("POST", `/chat/conversations/${conv}/messages`, p1, { body: "Hello teacher" })).statusCode).toBe(201);
      expect((await comms("POST", `/chat/conversations/${conv}/messages`, teacher, { body: "Hello parent" })).statusCode).toBe(201);
      expect((await comms("POST", "/chat/conversations", teacher, { peer_user_id: p1User })).statusCode).toBe(201);
      expect((await comms("POST", "/chat/conversations", p1, { peer_user_id: otherTeacherUser })).statusCode).toBe(403);
      expect((await comms("POST", "/chat/conversations", otherTeacher, { peer_user_id: p1User })).statusCode).toBe(403);
      expect((await comms("POST", "/chat/conversations", p1, { peer_user_id: p2User })).statusCode).toBe(403);
      expect((await comms("POST", "/chat/conversations", p1, { peer_user_id: ctx.ids.adminA })).statusCode).toBe(201); // unchanged
    });

    it("a revoked link closes the class inbox and the teacher chat at once (an open conversation cannot be written to)", async () => {
      const l = await learner(A(), "Chat Child");
      await owner(`INSERT INTO class_memberships (tenant_id, learner_id, class_id, academic_year_id) VALUES ($1, $2, $3, $4)`, [A(), l, class1A, year]);
      const g = await guardian(A());
      await relate(A(), g, l);
      const fam = await parentAccount(A(), g, "PT-0960");
      expect(await inbox(fam.token)).toContain("class1A");
      const conv = (await comms("POST", "/chat/conversations", fam.token, { peer_user_id: ctx.ids.teacherA })).json().conversation.id as string;
      expect((await comms("POST", `/chat/conversations/${conv}/messages`, fam.token, { body: "Before" })).statusCode).toBe(201);
      expect((await comms("POST", `/guardians/${g}/account-link/revoke`, admin, { reason: "custody changed" })).statusCode).toBe(200);
      expect(await inbox(fam.token)).not.toContain("class1A");
      expect((await comms("POST", `/chat/conversations/${conv}/messages`, fam.token, { body: "After" })).statusCode).toBe(403);
      expect((await comms("POST", `/chat/conversations/${conv}/messages`, teacher, { body: "After" })).statusCode).toBe(403);
      expect((await comms("GET", "/me/chat-contacts", fam.token)).json().contacts.map((c: { role: string }) => c.role)).toEqual(["school_admin"]);
    });
  });

  describe("every per-child path", () => {
    it("is 200 for the caller's own child", async () => {
      for (const p of CHILD_PATHS) {
        const r = await get(`${base(A())}/${c1}${p}`, p1, A());
        expect(r.statusCode, `${p}: ${r.body}`).toBe(200);
      }
    });

    it("is 404 for another family's child, another school's learner and a random id, and the refusal is audited", async () => {
      for (const p of CHILD_PATHS) {
        for (const who of [c3, cb, randomUUID()]) {
          const r = await get(`${base(A())}/${who}${p}`, p1, A());
          expect(r.statusCode, `${p} ${who}`).toBe(404);
          expect(r.json().error.message).toBe("Child not found");
        }
        expect((await get(`${base(A())}/${c1}${p}`, p2, A())).statusCode, p).toBe(404);
        expect((await get(`${base(A())}/${c1}${p}`, lone, A())).statusCode, p).toBe(404);
        expect((await get(`${base(B())}/${cb}${p}`, p1, B())).statusCode, p).toBe(403);
        expect((await get(`${base(A())}/not-a-uuid${p}`, p1, A())).statusCode, p).toBe(400);
      }
      if (CHILD_PATHS.length > 0) {
        const rows = await owner(
          `SELECT detail->>'learnerId' AS l FROM security_audit_events WHERE event_type = 'family.child.denied' AND actor_user_id = $1 AND tenant_id = $2`,
          [p1User, A()],
        );
        expect(rows.map((r) => r.l)).toContain(c3);
      }
    });

    it("is 403 for a school administrator and a teacher, even for a learner of their own school", async () => {
      for (const p of CHILD_PATHS) {
        expect((await get(`${base(A())}/${c1}${p}`, admin, A())).statusCode, p).toBe(403);
        expect((await get(`${base(A())}/${c1}${p}`, teacher, A())).statusCode, p).toBe(403);
      }
    });
  });

  describe("a link that stops being live closes every read at once", () => {
    async function family() {
      const l = await learner(A(), "Lifecycle Child");
      await owner(`INSERT INTO class_memberships (tenant_id, learner_id, class_id, academic_year_id) VALUES ($1, $2, $3, $4)`, [A(), l, class1A, year]);
      const g = await guardian(A());
      const link = await relate(A(), g, l);
      const acct = await parentAccount(A(), g, `PT-${String(1000 + Math.floor(Math.random() * 8999))}`);
      return { l, g, link, ...acct };
    }
    async function expectOpen(f: Awaited<ReturnType<typeof family>>) {
      expect((await get(base(A()), f.token, A())).json().children.map((k: { learner_id: string }) => k.learner_id)).toEqual([f.l]);
      for (const p of CHILD_PATHS) expect((await get(`${base(A())}/${f.l}${p}`, f.token, A())).statusCode, p).toBe(200);
    }
    async function expectClosed(f: Awaited<ReturnType<typeof family>>, status = 404) {
      const list = await get(base(A()), f.token, A());
      if (status === 404) {
        expect(list.statusCode).toBe(200);
        expect(list.json().children).toEqual([]);
      } else {
        expect(list.statusCode).toBe(status);
      }
      for (const p of CHILD_PATHS) expect((await get(`${base(A())}/${f.l}${p}`, f.token, A())).statusCode, p).toBe(status);
    }

    it("a revoked account link", async () => {
      const f = await family();
      await expectOpen(f);
      const r = await call("POST", `/v1/tenants/${A()}/guardians/${f.g}/account-link/revoke`, admin, { reason: "wrong person" }, A());
      expect(r.statusCode, r.body).toBe(200);
      await expectClosed(f);
    });

    it("an archived guardian-learner relationship", async () => {
      const f = await family();
      await expectOpen(f);
      await owner(`UPDATE guardian_links SET archived_at = now() WHERE id = $1`, [f.link]);
      await expectClosed(f);
    });

    it("an archived guardian record", async () => {
      const f = await family();
      await expectOpen(f);
      await owner(`UPDATE guardians SET active = false, archived_at = now() WHERE id = $1`, [f.g]);
      await expectClosed(f);
    });

    it("an archived learner", async () => {
      const f = await family();
      await expectOpen(f);
      await owner(`UPDATE learners SET active = false, archived_at = now() WHERE id = $1`, [f.l]);
      await expectClosed(f);
    });

    it("an archived parent membership (the school refuses the caller altogether)", async () => {
      const f = await family();
      await expectOpen(f);
      await owner(`UPDATE school_memberships SET archived_at = now() WHERE user_id = $1 AND tenant_id = $2`, [f.userId, A()]);
      await expectClosed(f, 403);
      // the membership trigger also revoked the account link, so restoring the membership does not bring the child back
      await owner(`UPDATE school_memberships SET archived_at = NULL WHERE user_id = $1 AND tenant_id = $2`, [f.userId, A()]);
      await expectClosed(f);
    });

    it("an expired invitation never makes a link (links themselves do not expire; revocation is final)", async () => {
      const l = await learner(A(), "Expired Invite Child");
      const g = await guardian(A());
      await relate(A(), g, l);
      const inv = await call("POST", `/v1/tenants/${A()}/guardians/${g}/invitations`, admin, { learner_id: l, method: "sms" }, A());
      expect(inv.statusCode, inv.body).toBe(201);
      await owner(`UPDATE guardian_invitations SET created_at = now() - interval '4 days', expires_at = now() - interval '1 day' WHERE id = $1`, [inv.json().invitation.id]);
      // the signed-in parent (no link yet) holds the token and the phone, but it has expired
      const acc = await call("POST", "/v1/guardian-invitations/accept", lone, { token: inv.json().invitation.token, contact: "0712345678", confirm: true });
      expect(acc.statusCode).toBe(400);
      expect((await get(base(A()), lone, A())).json().children).toEqual([]);
      for (const p of CHILD_PATHS) expect((await get(`${base(A())}/${l}${p}`, lone, A())).statusCode, p).toBe(404);
    });

    it("a disabled account", async () => {
      const f = await family();
      await expectOpen(f);
      await owner(`UPDATE users SET status = 'disabled' WHERE id = $1`, [f.userId]);
      await expectClosed(f, 401);
    });
  });
});

