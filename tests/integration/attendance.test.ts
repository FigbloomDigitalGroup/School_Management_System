import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initSupabase, supabase } from "../../packages/shared/src/supabase";
import { newRegister, tally, toRecords, today, type Register } from "../../packages/shared/src/attendance";
import { fetchClassRoster, fetchTodayAttendanceMarks, writeAttendance } from "../../packages/shared/src/teacherData";
import { WriteQueue, type KeyValueStore } from "../../packages/shared/src/queue";
import { sendQueuedWrite } from "../../packages/shared/src/queueSend";
import { loadParentData } from "../../packages/shared/src/parentData";
import { defaultReportCardOptions, prepareClassReportCards, type ReportCardData } from "../../packages/shared/src/reportCards";
import { loginIdEmail } from "../../packages/shared/src/auth";
import type { AttendanceMark } from "../../packages/shared/src/types";
import { TEST_ROLES, signInAs, type SignedIn, type TestRole } from "./support/signInAs";
import { assertLocalSupabaseUrl } from "./support/localGuard";

/**
 * QA 10 (FIG-1243): attendance, as the app's own functions store, read and queue it.
 *
 * This signs in as the seeded teacher TC-0002 (class teacher of Form 2 West, assigned to every Form), the school admin, the parent
 * PT-0002 (Faith in Form 2 West, Samuel in Form 4 East) and the Kijani Ridge teacher TC-0001, and runs writeAttendance,
 * fetchClassRoster, fetchTodayAttendanceMarks, loadParentData, prepareClassReportCards and the offline WriteQueue with the
 * real sendQueuedWrite against the local database.
 *
 * Every row it writes goes into a throwaway term ("QA10 reg ...", early 2019), or, for the parent's number, a second one ("QA10 old
 * ...", March and April 2019), or, for a register dated today, one around today ("QA10 now ..."): the database refuses a register
 * dated after today in the school's time zone or outside its term (FIG-1400), so the dates cannot be made up in the future. afterAll
 * deletes the terms, which takes their attendance with them, then the throwaway learners, and fails loudly if a delete did not work
 * (the QA 05 file's cleanup did not check, and once left 719 invoices behind). beforeAll sweeps anything an aborted run left. The
 * seeded Alliance registers (the first ten school days of the term, to 2026-09-11) are never touched. The screens are read in e2e/attendance.spec.ts; the database
 * rules are in supabase/rls-checks/attendance.sql.
 *
 * Known defects are written as the behaviour we want and use it.fails: they pass while the defect exists and fail the day it is
 * fixed. Then change it.fails to it.
 */

const run = Date.now().toString(36);
let admin: SignedIn, teacher: SignedIn, parent: SignedIn;
let tenantId = "", termId = "", oldTermId = "", nowTermId = "", currentTermId = "";
let form2West = "", form1East = "", faith = "";
let roster: { id: string; full_name: string }[] = [];
const madeStudents: string[] = [];
let school: ReportCardData["school"];

// ---------------------------------------------------------------- helpers

/** Points the app's own functions (which use the global client) at one signed-in user. */
let current = "";
async function actAs(email: string, password: string) {
  if (current === email) return;
  initSupabase({ url: assertLocalSupabaseUrl(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL).origin, anonKey: process.env.VITE_SUPABASE_ANON_KEY!, detectSessionInUrl: false });
  const { error } = await supabase().auth.signInWithPassword({ email, password });
  if (error) throw new Error(`could not sign in as ${email}: ${error.message}`);
  current = email;
}
const actAsRole = (role: TestRole) => actAs(TEST_ROLES[role].email, TEST_ROLES[role].password);

/** A register for Form 2 West, everyone present except the overrides. */
function register(date: string, overrides: Record<number, AttendanceMark> = {}, classId = form2West, ids = roster.map((r) => r.id)): Register {
  const r = newRegister(classId, termId, ids, date);
  for (const [i, mark] of Object.entries(overrides)) r.marks[ids[Number(i)]!] = mark;
  return r;
}
async function rowsOn(date: string, classId = form2West) {
  const { data, error } = await admin.client.from("attendance").select("id, student_id, mark, taken_by, term_id").eq("class_id", classId).eq("taken_on", date);
  if (error) throw new Error(error.message);
  return data as { id: string; student_id: string; mark: AttendanceMark; taken_by: string; term_id: string }[];
}
const marksOf = (rows: { student_id: string; mark: AttendanceMark }[]) => Object.fromEntries(rows.map((r) => [r.student_id, r.mark]));
const countBy = (rows: { mark: AttendanceMark }[]) => ({
  present: rows.filter((r) => r.mark === "present").length, absent: rows.filter((r) => r.mark === "absent").length,
  late: rows.filter((r) => r.mark === "late").length, excused: rows.filter((r) => r.mark === "excused").length, total: rows.length,
});
const auditCount = async () => {
  const { count } = await admin.client.from("audit_events").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId);
  return count ?? 0;
};
async function addLearner(label: string, classId: string): Promise<string> {
  const { data, error } = await admin.client.from("students")
    .insert({ tenant_id: tenantId, admission_no: `QA10-${run}-${label}`, full_name: `QA10 Probe ${label}`, boarding: false, active: true, class_id: classId }).select("id").single();
  if (error) throw new Error(`could not add a learner: ${error.message}`);
  madeStudents.push(data.id as string);
  return data.id as string;
}
/** A date n days from an ISO date (n may be negative). */
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** The time a register was taken, as the apps stamp it (toRecords' markedAt): n minutes ago. */
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const memoryStore = (): KeyValueStore => { let v: string | null = null; return { getItem: () => v, setItem: (_k, value) => { v = value; } }; };

// ---------------------------------------------------------------- set up

async function sweep() {
  await admin.client.from("terms").delete().eq("tenant_id", tenantId).like("name", "QA10 %");
  await admin.client.from("students").delete().eq("tenant_id", tenantId).like("admission_no", "QA10-%");
}

beforeAll(async () => {
  [admin, teacher, parent] = await Promise.all((["school_admin", "teacher", "parent"] as const).map((r) => signInAs(r))) as [SignedIn, SignedIn, SignedIn];
  tenantId = (await admin.client.from("profiles").select("tenant_id").eq("id", admin.userId).single()).data!.tenant_id as string;
  await sweep();

  currentTermId = (await admin.client.from("terms").select("id").eq("tenant_id", tenantId).eq("is_current", true).single()).data!.id as string;
  const cls = await admin.client.from("classes").select("id, name").eq("tenant_id", tenantId).in("name", ["Form 2 West", "Form 1 East"]);
  form2West = cls.data!.find((c) => c.name === "Form 2 West")!.id as string;
  form1East = cls.data!.find((c) => c.name === "Form 1 East")!.id as string;
  const kids = await parent.client.from("students").select("id, class_id").order("admission_no");
  faith = kids.data![0]!.id as string;
  expect(kids.data![0]!.class_id, "the parent's first child is in Form 2 West").toBe(form2West);

  const t = await admin.client.from("tenants").select("name, county, country, logo_url, accent").eq("id", tenantId).single();
  school = { name: t.data!.name as string, county: t.data!.county as string | null, country: t.data!.country as string, logoUrl: t.data!.logo_url as string | null, accent: t.data!.accent as string };

  const throwaway = [
    ["reg", 2019, 1, "2019-01-05", "2019-02-28"],
    ["old", 2019, 2, "2019-03-05", "2019-04-28"],
    ["now", 2019, 3, addDays(today(), -30), addDays(today(), 30)],
  ] as const;
  for (const [name, year, index, starts_on, ends_on] of throwaway) {
    const term = await admin.client.from("terms").insert({ tenant_id: tenantId, name: `QA10 ${name} ${run}`, year, index, starts_on, ends_on, is_current: false }).select("id").single();
    if (term.error) throw new Error(`could not make the ${name} term: ${term.error.message}`);
    if (name === "reg") termId = term.data.id as string;
    else if (name === "old") oldTermId = term.data.id as string;
    else nowTermId = term.data.id as string;
  }

  await actAsRole("teacher");
  roster = (await fetchClassRoster(form2West)).map((s) => ({ id: s.id, full_name: s.full_name }));
  expect(roster.length, "Form 2 West has a roster of 40 or more").toBeGreaterThanOrEqual(40);
  const todays = await admin.client.from("attendance").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("taken_on", today());
  expect(todays.count, "seed data only: nothing taken in Alliance today yet").toBe(0);
}, 60_000);

afterAll(async () => {
  const errors: string[] = [];
  if (admin) {
    for (const id of [termId, oldTermId, nowTermId].filter(Boolean)) {
      const { error } = await admin.client.from("terms").delete().eq("id", id);
      if (error) errors.push(`term ${id}: ${error.message}`);
    }
    if (madeStudents.length) {
      const { error } = await admin.client.from("students").delete().in("id", madeStudents);
      if (error) errors.push(`learners: ${error.message}`);
    }
    const left = await admin.client.from("attendance").select("id", { count: "exact", head: true }).in("term_id", [termId, oldTermId, nowTermId].filter(Boolean));
    if (left.count) errors.push(`${left.count} attendance rows of the throwaway terms are still there`);
  }
  if (errors.length) throw new Error(`cleanup failed, run the file again to sweep: ${errors.join("; ")}`);
}, 60_000);

// ---------------------------------------------------------------- 1. one register per learner per day

describe("a register is stored once, as the teacher saw it", () => {
  const D = "2019-02-02";
  it("a full register becomes one row per learner, and the counts are the ones the teacher saw", async () => {
    await actAsRole("teacher");
    const reg = register(D, { 0: "absent", 1: "late", 2: "excused" });
    expect(tally(reg)).toEqual({ present: roster.length - 3, absent: 1, late: 1, excused: 1, total: roster.length });
    await writeAttendance(reg, tenantId, teacher.userId);
    const rows = await rowsOn(D);
    expect(rows).toHaveLength(roster.length);
    expect(new Set(rows.map((r) => r.student_id)).size).toBe(roster.length);
    expect(countBy(rows)).toEqual(tally(reg));
    expect(rows.every((r) => r.taken_by === teacher.userId && r.term_id === termId)).toBe(true);
  });

  it("sending the same register again, and three times at once, adds no rows and keeps every row's id", async () => {
    const before = await rowsOn(D);
    const reg = register(D, { 0: "absent", 1: "late", 2: "excused" });
    await writeAttendance(reg, tenantId, teacher.userId);
    await Promise.all([1, 2, 3].map(() => writeAttendance(reg, tenantId, teacher.userId)));
    const after = await rowsOn(D);
    expect(after).toHaveLength(roster.length);
    expect(new Set(after.map((r) => r.id))).toEqual(new Set(before.map((r) => r.id)));
    expect(countBy(after)).toEqual(tally(reg));
  });

  it("correcting one mark changes that learner and nobody else", async () => {
    const before = marksOf(await rowsOn(D));
    await writeAttendance(register(D, { 0: "absent", 1: "late", 2: "excused", 5: "absent" }), tenantId, teacher.userId);
    const rows = await rowsOn(D);
    expect(rows).toHaveLength(roster.length);
    const after = marksOf(rows);
    expect(after[roster[5]!.id]).toBe("absent");
    for (const r of roster) if (r.id !== roster[5]!.id) expect(after[r.id], r.full_name).toBe(before[r.id]);
  });

  it("'already taken today' reads back what was stored for the class, and is empty for a class that has not taken it", async () => {
    const todays = newRegister(form2West, nowTermId, roster.map((r) => r.id), today());
    todays.marks[roster[3]!.id] = "absent";
    todays.marks[roster[4]!.id] = "late";
    await writeAttendance(todays, tenantId, teacher.userId);
    const read = await fetchTodayAttendanceMarks(form2West);
    expect(read).toHaveLength(roster.length);
    expect(read.find((r) => r.student_id === roster[3]!.id)!.mark).toBe("absent");
    expect(read.find((r) => r.student_id === roster[4]!.id)!.mark).toBe("late");
    expect(await fetchTodayAttendanceMarks(form1East)).toEqual([]);
  });

  it("an archived learner is not on the register any more, and the rows they already have stay", async () => {
    const q = await addLearner("1", form2West);
    expect((await fetchClassRoster(form2West)).map((s) => s.id)).toContain(q);
    await admin.client.from("attendance").insert({ tenant_id: tenantId, student_id: q, class_id: form2West, term_id: termId, taken_by: admin.userId, taken_on: "2019-02-03", mark: "present" });
    const archived = await admin.client.rpc("archive_learners", { p_ids: [q] });
    expect(archived.error, "archive_learners").toBeNull();
    const ids = (await fetchClassRoster(form2West)).map((s) => s.id);
    expect(ids).not.toContain(q);
    expect(ids).toHaveLength(roster.length);
    expect((await rowsOn("2019-02-03")).filter((r) => r.student_id === q)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- 2. changing a register

describe("changing a register", () => {
  const D = "2019-01-12"; // weeks before the other dates: an old register
  it("(a decision, not a defect) a teacher can change a register of any date through the API, though the screen only offers today", async () => {
    await admin.client.from("attendance").upsert(toRecords(register(D, { 7: "absent" }), tenantId, admin.userId), { onConflict: "student_id,taken_on" });
    await actAsRole("teacher");
    await writeAttendance(register(D, { 7: "present", 8: "absent" }), tenantId, teacher.userId);
    const rows = marksOf(await rowsOn(D));
    expect(rows[roster[7]!.id]).toBe("present");
    expect(rows[roster[8]!.id]).toBe("absent");
  });

  it("QA10-TRACE FIG-1406 (fixed on main): a correction leaves a trace: the row still says who took the register, or an audit event is written", async () => {
    const D2 = "2019-01-13";
    await admin.client.from("attendance").upsert(toRecords(register(D2, { 9: "absent" }), tenantId, admin.userId), { onConflict: "student_id,taken_on" });
    const before = await auditCount();
    await actAsRole("teacher");
    await writeAttendance(register(D2, { 9: "present" }), tenantId, teacher.userId);
    const row = (await rowsOn(D2)).find((r) => r.student_id === roster[9]!.id)!;
    expect(row.mark).toBe("present");
    const traced = row.taken_by === admin.userId || (await auditCount()) > before;
    expect(traced, "the correction is not recorded anywhere: taken_by now names the person who corrected it, and no audit event was written").toBe(true);
  });
});

// ---------------------------------------------------------------- 3. a learner in another class's register

describe("a learner of another class", () => {
  it.fails("QA10-CLASS FIG-1407 (open): a teacher cannot file a learner of another class in their own class's register", async () => {
    const y = await addLearner("2", form1East);
    await actAsRole("teacher");
    const { error } = await supabase().from("attendance")
      .insert({ tenant_id: tenantId, student_id: y, class_id: form2West, term_id: termId, taken_by: teacher.userId, taken_on: "2019-02-04", mark: "absent" });
    expect(error, "the database took a Form 1 East learner into the Form 2 West register").not.toBeNull();
  });
});

// ---------------------------------------------------------------- 4. the numbers the parent and the report card show

describe("a child's attendance figure, for this term", () => {
  const rowsOfFaith = async (term: string) => {
    const { data } = await admin.client.from("attendance").select("mark").eq("student_id", faith).eq("term_id", term);
    return (data ?? []) as { mark: AttendanceMark }[];
  };

  it.fails("QA10-PARENT FIG-1404 (open): ten absences in another term do not change the parent's 'this term' percentage or the days missed", async () => {
    await actAsRole("parent");
    const before = (await loadParentData(parent.userId)).children.find((c) => c.id === faith)!;
    expect(before.attendancePct, "the seed gives Faith attendance rows in the current term").not.toBeNull();
    const days = ["2019-04-08", "2019-04-09", "2019-04-10", "2019-04-11", "2019-04-12", "2019-04-15", "2019-04-16", "2019-04-17", "2019-04-18", "2019-04-19"];
    const ins = await admin.client.from("attendance").insert(days.map((taken_on) => ({ tenant_id: tenantId, student_id: faith, class_id: form2West, term_id: oldTermId, taken_by: admin.userId, taken_on, mark: "absent" })));
    expect(ins.error, "the other term's rows are saved").toBeNull();
    const after = (await loadParentData(parent.userId)).children.find((c) => c.id === faith)!;
    expect({ pct: after.attendancePct, absent: after.absentDates.length }).toEqual({ pct: before.attendancePct, absent: before.absentDates.length });
  });

  it("the report card counts this term's rows only, whatever another term holds (present + late over every row of the term)", async () => {
    // The ten absences from the test above (if it has run) sit in another term; the card must not see them.
    await actAsRole("school_admin");
    const cards = await prepareClassReportCards({ tenantId, school, termId: currentTermId, classId: form2West, examIds: [], options: defaultReportCardOptions("kcse") });
    const card = cards.find((c) => c.learner.id === faith)!;
    const rows = await rowsOfFaith(currentTermId);
    expect(rows.length, "the seed gives Faith ten days in the current term").toBeGreaterThan(0);
    expect(card.attendance).toEqual({ present: rows.filter((r) => r.mark === "present" || r.mark === "late").length, days: rows.length });
  });
});

// ---------------------------------------------------------------- 5. the offline queue against the real server

describe("a register held on the phone, sent for real", () => {
  const phone = async () => {
    await actAsRole("teacher");
    const queue = new WriteQueue(memoryStore(), sendQueuedWrite);
    queue.setUser(teacher.userId);
    return queue;
  };

  it("the same held register queued twice goes out twice and leaves one row per learner", async () => {
    const D = "2019-02-09";
    const queue = await phone();
    const reg = register(D, { 0: "absent", 1: "late" });
    await queue.enqueue("attendance", toRecords(reg, tenantId, teacher.userId));
    await queue.enqueue("attendance", toRecords(reg, tenantId, teacher.userId));
    expect(await queue.flush()).toEqual({ sent: 2, remaining: 0 });
    const rows = await rowsOn(D);
    expect(rows).toHaveLength(roster.length);
    expect(countBy(rows)).toEqual(tally(reg));
  });

  it("a register that was already partly saved goes out whole and does not stall the queue", async () => {
    const D = "2019-02-10";
    const partial = register(D, { 0: "absent" });
    await admin.client.from("attendance").upsert(toRecords(partial, tenantId, teacher.userId).slice(0, 20), { onConflict: "student_id,taken_on" });
    expect(await rowsOn(D)).toHaveLength(20);
    const queue = await phone();
    const full = register(D, { 0: "late", 30: "absent" });
    await queue.enqueue("attendance", toRecords(full, tenantId, teacher.userId));
    expect(await queue.flush()).toEqual({ sent: 1, remaining: 0 });
    const rows = await rowsOn(D);
    expect(rows).toHaveLength(roster.length);
    expect(countBy(rows)).toEqual(tally(full));
  });

  it("QA10-STALE FIG-1410 (fixed): a register held on the phone does not overwrite a newer one taken meanwhile", async () => {
    const D = "2019-02-11";
    const queue = await phone();
    const held = register(D, { 0: "absent" }); // taken offline a minute ago
    await queue.enqueue("attendance", toRecords(held, tenantId, teacher.userId, minutesAgo(1)));
    await writeAttendance(register(D, {}), tenantId, teacher.userId); // corrected online afterwards (stamped now): learner 0 is present
    expect(marksOf(await rowsOn(D))[roster[0]!.id]).toBe("present");
    expect(await queue.flush(), "the held register is sent and taken without an error, so the phone drops it").toEqual({ sent: 1, remaining: 0 });
    expect(marksOf(await rowsOn(D))[roster[0]!.id], "the older held register has overwritten the newer correction").toBe("present");
  });

  it("a register held on the phone that is newer than the one stored does replace it, whichever way round they were taken", async () => {
    const D = "2019-02-13";
    // The office's register, ten minutes old, is stored. The teacher's, taken a minute ago on a phone with no signal, arrives later.
    await admin.client.from("attendance").upsert(toRecords(register(D, { 0: "absent" }), tenantId, admin.userId, minutesAgo(10)), { onConflict: "student_id,taken_on" });
    const queue = await phone();
    await queue.enqueue("attendance", toRecords(register(D, { 0: "late" }), tenantId, teacher.userId, minutesAgo(1)));
    expect(await queue.flush()).toEqual({ sent: 1, remaining: 0 });
    const row = (await rowsOn(D)).find((r) => r.student_id === roster[0]!.id)!;
    expect(row.mark).toBe("late");
    expect(row.taken_by).toBe(teacher.userId);
  });

  it("a register the server refuses (another school's teacher) is set aside, not retried, and nothing is written", async () => {
    const D = "2019-02-12";
    await actAs(loginIdEmail("TC-0001", "kijani-ridge"), "figbloom-dev");
    const outsider = (await supabase().auth.getUser()).data.user!.id;
    const queue = new WriteQueue(memoryStore(), sendQueuedWrite);
    queue.setUser(outsider);
    await queue.enqueue("attendance", toRecords(register(D, { 0: "absent" }), tenantId, outsider));
    expect(await queue.flush()).toEqual({ sent: 0, remaining: 0 });
    expect(await queue.pending()).toEqual([]);
    const refused = await queue.rejected();
    expect(refused).toHaveLength(1);
    // since 20261103600000 the same-school trigger answers before row-level security does
    expect(refused[0]!.rejected!.message).toMatch(/row-level security|belongs to another school/);
    expect(await rowsOn(D)).toHaveLength(0);
    await actAsRole("teacher");
  });
});

// ---------------------------------------------------------------- 6. which day a register belongs to (FIG-1400)

describe("the date of a register", () => {
  const ids = () => roster.map((r) => r.id);
  const phone = async () => {
    await actAsRole("teacher");
    const queue = new WriteQueue(memoryStore(), sendQueuedWrite);
    queue.setUser(teacher.userId);
    return queue;
  };

  it("a register dated tomorrow is refused with a message that says why, and nothing is stored", async () => {
    await actAsRole("teacher");
    const tomorrow = addDays(today(), 1);
    await expect(writeAttendance(newRegister(form2West, nowTermId, ids(), tomorrow), tenantId, teacher.userId)).rejects.toThrow(/dated .* but today is .*: check the date on this phone/);
    expect(await rowsOn(tomorrow)).toHaveLength(0);
  });

  it("a register dated outside the term it names is refused, naming the term", async () => {
    await actAsRole("teacher");
    const afterTerm = "2019-03-01"; // the day after "QA10 reg" ends
    await expect(writeAttendance(register(afterTerm), tenantId, teacher.userId)).rejects.toThrow(/outside the term "QA10 reg .*" \(05 Jan 2019 to 28 Feb 2019\)/);
    expect(await rowsOn(afterTerm)).toHaveLength(0);
  });

  it("the first and the last day of a term are taken", async () => {
    await actAsRole("teacher");
    await writeAttendance(register("2019-01-05", { 0: "absent" }), tenantId, teacher.userId);
    await writeAttendance(register("2019-02-28", { 0: "late" }), tenantId, teacher.userId);
    expect(await rowsOn("2019-01-05")).toHaveLength(roster.length);
    expect(await rowsOn("2019-02-28")).toHaveLength(roster.length);
  });

  it("a held register with a wrong date is set aside with the reason, and the register behind it still goes out", async () => {
    const queue = await phone();
    const tomorrow = addDays(today(), 1);
    const good = "2019-02-14";
    await queue.enqueue("attendance", toRecords(newRegister(form2West, nowTermId, ids(), tomorrow), tenantId, teacher.userId));
    await queue.enqueue("attendance", toRecords(register(good, { 0: "absent" }), tenantId, teacher.userId));
    expect(await queue.flush()).toEqual({ sent: 1, remaining: 0 });
    const refused = await queue.rejected();
    expect(refused, "the wrongly dated register is kept, not lost").toHaveLength(1);
    expect(refused[0]!.rejected!.message).toMatch(/but today is/);
    expect(await rowsOn(tomorrow)).toHaveLength(0);
    expect(await rowsOn(good)).toHaveLength(roster.length);
  });
});
