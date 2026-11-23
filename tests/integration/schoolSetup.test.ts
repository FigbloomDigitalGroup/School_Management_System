import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initSupabase, supabase } from "../../packages/shared/src/supabase";
import { saveClassTimetable, fetchClassTimetableSlots } from "../../packages/shared/src/timetable";
import { loginIdEmail } from "../../packages/shared/src/auth";
import { gradeFor } from "../../packages/shared/src/grading";
import { gradingSchemeFor } from "../../packages/shared/src/gradingSchemes";
import { assignCoverage } from "../../packages/shared/src/coverage";
import { TEST_ROLES, anonClient, signInAs, type SignedIn, type TestRole } from "./support/signInAs";
import { assertLocalSupabaseUrl } from "./support/localGuard";

/**
 * QA 12 (FIG-1245): school setup through the app's own functions and the public sign-in functions: which schools can sign in
 * by status (the decision the issue asks to record), what the timetable save does when it is refused part-way, what the
 * cover assignment tells a substitute, and why a class that has marks cannot change level (every grade is worked out from it). The database rules are in
 * supabase/rls-checks/school_setup.sql, the screens are in e2e/setup.spec.ts.
 *
 * Kijani Ridge's status is changed (as the platform admin, the way the console does) and put back in afterAll. Everything else
 * is a throwaway class named "QA12 <run> wipe", removed in afterAll, which fails loudly if anything is left.
 * Known defects use it.fails: they pass while the defect exists and fail when it is fixed. Then change it.fails to it.
 */

const run = Date.now().toString(36);
const base = () => assertLocalSupabaseUrl(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL).origin;
const anonKey = () => process.env.VITE_SUPABASE_ANON_KEY!;
const caller = (label: string) => ({ "cf-connecting-ip": `qa12-${run}-${label}` });

async function post(name: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base()}/functions/v1/${name}`, {
    method: "POST",
    headers: { apikey: anonKey(), "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json };
}

/** Points the app's own functions (which use the global client) at one signed-in user. */
let current = "";
async function actAs(role: TestRole) {
  if (current === role) return;
  initSupabase({ url: base(), anonKey: anonKey(), detectSessionInUrl: false });
  const { error } = await supabase().auth.signInWithPassword({ email: TEST_ROLES[role].email, password: TEST_ROLES[role].password });
  if (error) throw new Error(`could not sign in as ${role}: ${error.message}`);
  current = role;
}

let platform: SignedIn, admin: SignedIn, teacher: SignedIn;
let tenantId = "", kijani = { id: "", name: "" }, chemistry = "", wipeClass = "";
const table: string[][] = [];

beforeAll(async () => {
  platform = await signInAs("platform_staff");
  admin = await signInAs("school_admin");
  teacher = await signInAs("teacher");
  tenantId = (await admin.client.from("profiles").select("tenant_id").eq("id", admin.userId).single()).data!.tenant_id as string;
  const k = await platform.client.from("tenants").select("id, name").eq("slug", "kijani-ridge").single();
  kijani = { id: k.data!.id as string, name: k.data!.name as string };
  chemistry = (await admin.client.from("subjects").select("id").eq("tenant_id", tenantId).eq("code", "CHE").single()).data!.id as string;
  // In case an aborted run left a throwaway class behind.
  await admin.client.from("classes").delete().eq("tenant_id", tenantId).like("name", "QA12 %");
  await platform.client.from("tenants").update({ status: "active" }).eq("id", kijani.id);
  const made = await admin.client.from("classes").insert({ tenant_id: tenantId, name: `QA12 ${run} wipe`, level: "secondary", form_level: 1 }).select("id").single();
  if (made.error) throw new Error(`could not make the throwaway class: ${made.error.message}`);
  wipeClass = made.data.id as string;
  await actAs("school_admin");
}, 120_000);

afterAll(async () => {
  const errors: string[] = [];
  if (platform) {
    const back = await platform.client.from("tenants").update({ status: "active" }).eq("id", kijani.id);
    if (back.error) errors.push(`putting Kijani Ridge back to active: ${back.error.message}`);
    const now = await platform.client.from("tenants").select("status").eq("id", kijani.id).single();
    if (now.data?.status !== "active") errors.push(`Kijani Ridge is ${now.data?.status}`);
  }
  if (admin) {
    const notes = await admin.client.from("announcements").delete().eq("tenant_id", tenantId).like("subject", `%QA12 ${run}%`);
    if (notes.error) errors.push(`removing the cover messages: ${notes.error.message}`);
    const gone = await admin.client.from("classes").delete().eq("id", wipeClass);
    if (gone.error) errors.push(`removing the throwaway class: ${gone.error.message}`);
    const left = await admin.client.from("classes").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).like("name", "QA12 %");
    if (left.count) errors.push(`${left.count} QA12 classes are still there`);
    const msgs = await admin.client.from("announcements").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).like("subject", `%QA12 ${run}%`);
    if (msgs.count) errors.push(`${msgs.count} cover messages are still there`);
  }
  if (table.length) console.log("\n" + table.map((r) => r.join(" | ")).join("\n"));
  if (errors.length) throw new Error(`cleanup failed, run the file again to sweep: ${errors.join("; ")}`);
}, 120_000);

// ---------------------------------------------------------------- 1. who can sign in, by school status

describe("which schools can sign in, by status", () => {
  const STATUSES: [string, boolean][] = [
    ["active", true], ["trial", true], ["overdue", true], ["onboarding", false], ["setup_stalled", false], ["suspended", false],
  ];

  it("the sign-in screen's two lookups (search-schools and resolve-login-id) accept active, trial and overdue schools and refuse the rest", async () => {
    table.push(["Status", "Listed by search-schools", "resolve-login-id says", "Signing in with the password directly"]);
    for (const [status, allowed] of STATUSES) {
      const set = await platform.client.from("tenants").update({ status }).eq("id", kijani.id);
      expect(set.error, `setting ${status}`).toBeNull();
      const found = await post("search-schools", { query: "Kijani" }, caller(`s-${status}`));
      const listed = ((found.json.schools ?? []) as { id: string }[]).some((s) => s.id === kijani.id);
      const resolved = await post("resolve-login-id", { tenant_id: kijani.id, login_id: "TC-0001" }, caller(`r-${status}`));
      const direct = await anonClient().auth.signInWithPassword({ email: loginIdEmail("TC-0001", "kijani-ridge"), password: "figbloom-dev" });
      table.push([status, listed ? "yes" : "no", String(resolved.status), direct.error ? `refused: ${direct.error.message}` : "signs in"]);
      expect(listed, `${status}: listed`).toBe(allowed);
      expect(resolved.status, `${status}: resolve-login-id`).toBe(allowed ? 200 : 404);
      if (status === "suspended") expect(direct.error, "a suspended school's users are banned").not.toBeNull();
    }
  }, 120_000);

  it("a school put back to active can be found and signed into again (the test's own restore)", async () => {
    await platform.client.from("tenants").update({ status: "active" }).eq("id", kijani.id);
    const resolved = await post("resolve-login-id", { tenant_id: kijani.id, login_id: "TC-0001" }, caller("back"));
    expect(resolved.status).toBe(200);
    const direct = await anonClient().auth.signInWithPassword({ email: loginIdEmail("TC-0001", "kijani-ridge"), password: "figbloom-dev" });
    expect(direct.error).toBeNull();
  });

  it("the platform admin can move a school between any two statuses: there is no sequence (INFO)", async () => {
    const path = ["setup_stalled", "active", "onboarding", "overdue", "trial", "active"];
    const outcomes: string[] = [];
    for (const status of path) {
      const r = await platform.client.from("tenants").update({ status }).eq("id", kijani.id).select("status");
      outcomes.push(`${status}: ${r.error ? "refused" : r.data?.[0]?.status === status ? "taken" : "not changed"}`);
    }
    console.log(`status moves, one after the other (Kijani Ridge): ${outcomes.join(", ")}`);
    expect(outcomes.every((o) => o.endsWith("taken"))).toBe(true);
  });
});

// ---------------------------------------------------------------- 2. the timetable save

describe("saving a class's timetable", () => {
  const GOOD = [
    { day: "Mon" as const, start_time: "08:00", label: "Maths", room: "A1" },
    { day: "Mon" as const, start_time: "08:40", label: "English", room: null },
    { day: "Tue" as const, start_time: "08:00", label: "Science", room: null },
  ];
  let kept = -1;

  it("a clean grid is saved, and a second save replaces it (nothing stale is kept)", async () => {
    await actAs("school_admin");
    await saveClassTimetable(tenantId, wipeClass, GOOD);
    expect(await fetchClassTimetableSlots(wipeClass)).toHaveLength(3);
    await saveClassTimetable(tenantId, wipeClass, GOOD.slice(0, 2));
    expect((await fetchClassTimetableSlots(wipeClass)).map((s) => s.label).sort()).toEqual(["English", "Maths"]);
    await saveClassTimetable(tenantId, wipeClass, GOOD);
    expect(await fetchClassTimetableSlots(wipeClass)).toHaveLength(3);
  });

  it("a save the database refuses part-way (here a time of 25:99, which only a direct call can send) is refused with the database's words", async () => {
    await actAs("school_admin");
    let refused = "";
    try { await saveClassTimetable(tenantId, wipeClass, [{ day: "Mon", start_time: "08:00", label: "Keep?", room: null }, { day: "Mon", start_time: "25:99", label: "Bad", room: null }]); }
    catch (e) { refused = (e as { message?: string }).message ?? String(e); }
    kept = (await fetchClassTimetableSlots(wipeClass)).length;
    table.push(["Timetable save refused part-way", "periods the class had / has now", "3 / 3", `3 / ${kept}`]);
    expect(refused).toMatch(/check constraint|violates/i);
  });

  it("QA12-TIMETABLE FIG-1431: a refused save leaves the class's old timetable as it was (one database call, so the delete is undone with the insert)", () => {
    expect(kept).toBe(3);
  });
});

// ---------------------------------------------------------------- 3. cover

describe("assigning cover", () => {
  // The substitute is TC-0002 (so the test can read what the substitute sees); the "absent" teacher is the admin's profile, which is all
  // the database needs: any two profiles of the school. The slot is a throwaway class's, a date far in the future.
  const item = () => ({ date: "2041-03-03", classId: wipeClass, className: `QA12 ${run} wipe`, subjectId: chemistry, subjectName: "Chemistry", time: "08:00", absentTeacherId: admin.userId });
  const mine = async () => ((await teacher.client.from("announcements").select("subject, body").like("subject", `%QA12 ${run}%`)).data ?? []) as { subject: string; body: string }[];
  let afterFree: { subject: string; body: string }[] = [];

  it("the substitute is told in the app when cover is assigned to them", async () => {
    await actAs("school_admin");
    await assignCoverage({ tenantId, assignedBy: admin.userId, item: item(), coveringTeacherId: teacher.userId });
    const seen = await mine();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toContain("You're covering Chemistry");
  });

  it("changing the slot to a free period is recorded, and the earlier substitute's message is the only thing they have", async () => {
    await actAs("school_admin");
    await assignCoverage({ tenantId, assignedBy: admin.userId, item: item(), coveringTeacherId: null });
    const row = await admin.client.from("coverage_assignments").select("covering_teacher_id").eq("class_id", wipeClass).eq("date", "2041-03-03").eq("start_time", "08:00").single();
    expect(row.data?.covering_teacher_id).toBeNull();
    afterFree = await mine();
    table.push(["Cover changed to a free period", "what the earlier substitute can read", "told it is off", `${afterFree.length} message(s): ${afterFree.map((m) => m.body.slice(0, 22)).join(" / ")}`]);
  });

  it("QA12-COVER FIG-1434: a substitute who was told they are covering is told when the cover is taken away", () => {
    const stillCovering = afterFree.some((m) => /You're covering/.test(m.body));
    const toldItIsOff = afterFree.some((m) => /no longer|not covering|cancel|withdrawn|free period/i.test(m.subject + " " + m.body));
    expect(!stillCovering || toldItIsOff).toBe(true);
  });
});

// ---------------------------------------------------------------- 4. the grade follows the class's level

describe("a grade is worked out from the class's level every time it is shown", () => {
  it("the same mark gets a different grade under the secondary scale and the junior one, so moving a class between levels re-grades every mark it has", () => {
    const secondary = gradingSchemeFor("KE", "secondary");
    const junior = gradingSchemeFor("KE", "junior_secondary");
    const differing: string[] = [];
    for (let score = 0; score <= 100; score++) {
      const a = String(gradeFor(score, secondary)), b = String(gradeFor(score, junior));
      if (a !== b) differing.push(`${score}: ${a} / ${b}`);
    }
    table.push(["Grade of the same mark", "secondary / junior_secondary scale", "same", `${differing.length} of 101 marks differ, e.g. ${differing.slice(30, 33).join(", ")}`]);
    expect(secondary).not.toBe(junior);
    expect(differing.length).toBeGreaterThan(0);
  });

  it("QA12-REGRADE FIG-1435: so a class that already has marks cannot be moved to another level, and one with none still can", async () => {
    const exam = (await admin.client.from("exams").select("id").eq("tenant_id", tenantId).limit(1).single()).data!.id as string;
    const kid = await admin.client.from("students").insert({
      tenant_id: tenantId, admission_no: `QA12-${run}-REGRADE`, full_name: "QA12 Regrade Learner", class_id: wipeClass, boarding: false, active: true, gender: "female",
    }).select("id").single();
    expect(kid.error).toBeNull();
    const kidId = kid.data!.id as string;
    try {
      const given = await admin.client.from("marks").insert({ tenant_id: tenantId, exam_id: exam, student_id: kidId, subject_id: chemistry, entered_by: admin.userId, score: 72 });
      expect(given.error).toBeNull();

      const moved = await admin.client.from("classes").update({ level: "primary" }).eq("id", wipeClass).select();
      expect(moved.error?.code).toBe("23514");
      expect(moved.error?.message).toMatch(/already has marks/);
      expect((await admin.client.from("classes").select("level").eq("id", wipeClass).single()).data?.level).toBe("secondary");

      // The year within the level and the name are not a change of scale.
      const yearAndName = await admin.client.from("classes").update({ form_level: 2, name: `QA12 ${run} wipe` }).eq("id", wipeClass).select();
      expect(yearAndName.error).toBeNull();

      // Once the learner has no marks the class can be corrected.
      await admin.client.from("marks").delete().eq("student_id", kidId);
      const corrected = await admin.client.from("classes").update({ level: "primary", form_level: 2 }).eq("id", wipeClass).select("level").single();
      expect(corrected.error).toBeNull();
      expect(corrected.data?.level).toBe("primary");
    } finally {
      await admin.client.from("marks").delete().eq("student_id", kidId);
      await admin.client.from("students").delete().eq("id", kidId);
    }
  });
});
