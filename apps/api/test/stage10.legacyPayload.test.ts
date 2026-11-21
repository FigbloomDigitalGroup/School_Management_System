import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

/**
 * Stage 10 final compatibility check (2026-11-19).
 *
 * Legacy payload evidence (pinned below from the source, so a change there fails this test):
 *  - packages/shared/src/attendance.ts `toRecords` sets EVERY row's `class_id` to `r.classId`,
 *    the class the teacher selected (`newRegister(classId, ...)`).
 *  - The rows are built only for the roster, and both clients load it with
 *    `fetchClassRoster(classId)` = `students WHERE class_id = <selected class> AND active`.
 *  => every learner in a legacy register IS a member of the class the row names. The R10-1 rule
 *     (learner must be a member of class_id; an archived membership still counts) accepts it,
 *     including a register queued offline and replayed after the learner moved class.
 *
 * Also verified here: the OD-2 class-teacher read scope (class teacher, no teaching assignment)
 * reads its own class only and gains no write permission.
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
const REPO = join(process.cwd(), "..", "..");
const src = (p: string) => readFileSync(join(REPO, p), "utf8");

function bearer(token: string, tenantId: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "x-tenant-id": tenantId };
}

describe("legacy register payload evidence (source pinned)", () => {
  it("toRecords files every row under the teacher's selected class", () => {
    const shared = src("packages/shared/src/attendance.ts");
    expect(shared).toMatch(/export function newRegister\(classId: string, termId: string, studentIds: string\[\]/);
    expect(shared).toMatch(/return Object\.entries\(r\.marks\)\.map\(\(\[student_id, mark\]\) => \(\{/);
    expect(shared).toMatch(/\n\s+class_id: r\.classId,\r?\n/);
  });

  it("both clients build the register only from the selected class's roster", () => {
    const teacherData = src("packages/shared/src/teacherData.ts");
    expect(teacherData).toMatch(/fetchClassRoster\(classId: string\)[\s\S]{0,200}\.from\("students"\)\.select\("\*"\)\.eq\("class_id", classId\)\.eq\("active", true\)/);
    const web = src("apps/web/src/screens/teacher/Attendance.tsx");
    expect(web).toMatch(/fetchClassRoster\(classId\)/);
    expect(web).toMatch(/newRegister\(classId, term\.id, rosterData\.map\(\(s\) => s\.id\)/);
    const mobile = src("apps/mobile/src/screens/teacher/Attendance.tsx");
    expect(mobile).toMatch(/fetchClassRoster\(classId\)/);
    expect(mobile).toMatch(/newRegister\(classId, termId, r\.map\(\(s\) => s\.id\)/);
  });
});

describe("legacy register payload against the new API", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let admin: string;
  let teacher: string;
  let today: string;
  let yearId: string;
  let termId: string;
  let classX: string;
  let classY: string;
  let classInactive: string;
  let roster: string[];
  let outsider: string;

  async function post(path: string, payload: unknown, token = admin) {
    return ctx.app.inject({ method: "POST", url: `/v1/tenants/${ids.tenantA}${path}`, headers: bearer(token, ids.tenantA), payload: payload as Record<string, unknown> });
  }
  async function get(path: string, token = admin) {
    return ctx.app.inject({ method: "GET", url: `/v1/tenants/${ids.tenantA}${path}`, headers: bearer(token, ids.tenantA) });
  }
  async function created(path: string, payload: unknown, key: string): Promise<string> {
    const res = await post(path, payload);
    expect(res.statusCode, res.body).toBe(201);
    return res.json()[key].id as string;
  }

  /** Exactly the row `toRecords` produces (packages/shared/src/attendance.ts). */
  function legacyRows(classId: string, studentIds: string[], markedAt: string) {
    return studentIds.map((student_id) => ({
      tenant_id: ids.tenantA,
      student_id,
      class_id: classId,
      term_id: termId,
      taken_by: ids.teacherA,
      taken_on: today,
      mark: "present" as const,
      note: null,
      marked_at: markedAt,
    }));
  }

  /** The Stage 15 adapter: rename student_id, drop server-derived fields, send NO session. */
  function toApiBody(row: ReturnType<typeof legacyRows>[number]) {
    return { learner_id: row.student_id, class_id: row.class_id, term_id: row.term_id, taken_on: row.taken_on, mark: row.mark, note: row.note, marked_at: row.marked_at };
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    admin = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: "admin-a@example.com", password: "correct-horse-battery" } })).json().token;
    teacher = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: ids.tenantA, loginId: "TC-0001", password: "correct-horse-battery" } })).json().token;
    today = (await ctx.pool.query<{ d: string }>(`SELECT (now() AT TIME ZONE COALESCE(timezone, 'Africa/Nairobi'))::date::text AS d FROM tenants WHERE id = $1`, [ids.tenantA])).rows[0]!.d;
    yearId = (await post("/academic-years", { label: "Legacy", starts_on: "2020-01-01", ends_on: "2035-12-31" })).json().academic_year.id;
    termId = await created("/academic-terms", { academic_year_id: yearId, index: 1, label: "Legacy T1", starts_on: "2020-01-01", ends_on: "2035-12-31" }, "term");
    // The teacher is CLASS TEACHER of X only: no teaching assignment anywhere.
    const staff = await post("/staff", { full_name: "Teacher A", classification: "teacher", userId: ids.teacherA });
    expect(staff.statusCode).toBe(201);
    const staffId = staff.json().staff.id as string;
    classX = await created("/classes", { academic_year_id: yearId, name: "Legacy X", class_teacher_staff_id: staffId }, "school_class");
    classY = await created("/classes", { academic_year_id: yearId, name: "Legacy Y" }, "school_class");
    classInactive = await created("/classes", { academic_year_id: yearId, name: "Legacy Old", class_teacher_staff_id: staffId }, "school_class");
    await ctx.pool.query(`UPDATE classes SET active = false, archived_at = now() WHERE id = $1`, [classInactive]);
    const learner = async (no: string, classId: string) => {
      const id = await created("/learners", { admission_no: no, full_name: `Legacy ${no}`, gender: "male" }, "learner");
      expect((await post("/class-memberships", { learner_id: id, class_id: classId })).statusCode).toBe(201);
      return id;
    };
    roster = [await learner("9401", classX), await learner("9402", classX), await learner("9403", classX)];
    outsider = await learner("9404", classY);
    await ctx.app.inject({ method: "PUT", url: `/v1/tenants/${ids.tenantA}/attendance-settings`, headers: bearer(admin, ids.tenantA), payload: { afternoon_enabled: true, percentage_mode: "session" } });
  }, 180_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("a legacy roster register (selected class, no session) is accepted for every learner, as the class teacher", async () => {
    const rows = legacyRows(classX, roster, new Date(Date.now() - 60_000).toISOString());
    for (const row of rows) {
      const res = await post("/attendance-registers", toApiBody(row), teacher);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ outcome: "applied", register: { session: "morning", class_id: classX, learner_id: row.student_id } });
    }
    const pm = await ctx.pool.query(`SELECT count(*)::int AS n FROM attendance_afternoon WHERE learner_id = ANY($1::uuid[])`, [roster]);
    expect(pm.rows[0]!.n).toBe(0);
  });

  it("a register queued offline and replayed after a learner moved class is still accepted (archived membership)", async () => {
    const moved = roster[0]!;
    const held = legacyRows(classX, [moved], new Date().toISOString())[0]!;
    const membership = await ctx.pool.query<{ id: string }>(`SELECT id FROM class_memberships WHERE learner_id = $1 AND class_id = $2`, [moved, classX]);
    expect((await post(`/class-memberships/${membership.rows[0]!.id}/archive`, {})).statusCode).toBe(200);
    expect((await post("/class-memberships", { learner_id: moved, class_id: classY })).statusCode).toBe(201);
    const res = await post("/attendance-registers", toApiBody(held), teacher);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().outcome).toBe("applied");
  });

  it("the R10-1 rule still refuses a learner who was never in the named class", async () => {
    const forged = legacyRows(classX, [outsider], new Date().toISOString())[0]!;
    const res = await post("/attendance-registers", toApiBody(forged), teacher);
    expect(res.statusCode).toBe(400);
    const stored = await ctx.pool.query(`SELECT 1 FROM attendance WHERE learner_id = $1`, [outsider]);
    expect(stored.rowCount).toBe(0);
  });

  it("the raw legacy row shape (student_id, tenant_id, taken_by) is not accepted on the wire: Stage 15 must map it", async () => {
    const raw = legacyRows(classX, [roster[1]!], new Date().toISOString())[0]!;
    expect((await post("/attendance-registers", raw, teacher)).statusCode).toBe(400);
  });

  describe("OD-2 class-teacher read scope (confirmed): read only", () => {
    it("reads registers and the sign-out list of the class it teaches, nothing else", async () => {
      expect((await post("/attendance-registers", { learner_id: outsider, class_id: classY, term_id: termId, taken_on: today, mark: "absent" })).statusCode).toBe(200);
      const regs = await get(`/attendance-registers?takenOn=${today}&limit=200`, teacher);
      expect(regs.statusCode).toBe(200);
      expect(new Set(regs.json().registers.map((r: { class_id: string }) => r.class_id))).toEqual(new Set([classX]));
      const outs = await get("/early-sign-outs", teacher);
      expect(outs.statusCode).toBe(200);
      const assess = await created("/assessments", { class_id: classX, subject_id: await created("/subjects", { code: "LGS", name: "Legacy subject" }, "subject"), term_id: termId, title: "Legacy exam", kind: "exam", max_score: 10 }, "assessment");
      expect((await get(`/assessments/${assess}/marks`, teacher)).statusCode).toBe(200);
      expect((await get("/assessments", teacher)).json().assessments.every((a: { class_id: string }) => a.class_id === classX)).toBe(true);
    });

    it("grants no write beyond what a class teacher already had", async () => {
      const subject = await created("/subjects", { code: "LGW", name: "Legacy write" }, "subject");
      const assess = await created("/assessments", { class_id: classX, subject_id: subject, term_id: termId, title: "No write", kind: "exam", max_score: 10 }, "assessment");
      expect((await post("/assessments", { class_id: classX, subject_id: subject, term_id: termId, title: "T", kind: "exam", max_score: 1 }, teacher)).statusCode).toBe(403);
      // Not an assessor (no teaching assignment for the subject): no mark write, no correction.
      expect((await post(`/assessments/${assess}/marks`, { learner_id: roster[1], score: 5 }, teacher)).statusCode).toBe(403);
      expect((await post(`/assessments/${assess}/mark-corrections`, { learner_id: roster[1], score: 5, reason: "Not allowed", row_version: 0 }, teacher)).statusCode).toBe(403);
      expect((await ctx.app.inject({ method: "PUT", url: `/v1/tenants/${ids.tenantA}/attendance-settings`, headers: bearer(teacher, ids.tenantA), payload: { afternoon_enabled: false, percentage_mode: "day" } })).statusCode).toBe(403);
      expect((await get(`/attendance-counted?termId=${termId}`, teacher)).statusCode).toBe(403);
      expect((await post("/homework-items", { class_id: classX, subject_id: subject, term_id: termId, title: "H", due_on: "2030-01-01", body: "b" }, teacher)).statusCode).toBe(403);
      // Writes to another class's register remain refused.
      expect((await post("/attendance-registers", { learner_id: outsider, class_id: classY, term_id: termId, taken_on: today, mark: "present" }, teacher)).statusCode).toBe(403);
    });

    it("an inactive class gives no read scope", async () => {
      const a = await created("/assessments", { class_id: classInactive, subject_id: await created("/subjects", { code: "LGI", name: "Legacy inactive" }, "subject"), term_id: termId, title: "Old", kind: "exam", max_score: 10 }, "assessment");
      expect((await get(`/assessments/${a}/marks`, teacher)).statusCode).toBe(404);
    });
  });
});
