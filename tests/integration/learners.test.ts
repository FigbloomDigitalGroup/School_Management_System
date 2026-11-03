import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initSupabase, supabase } from "../../packages/shared/src/supabase";
import { archiveLearners, deleteLearners, fetchArchivedLearners, restoreLearners } from "../../packages/shared/src/learners";
import { importStudents, parseStudentCsv, type ParseContext } from "../../apps/web/src/lib/studentImport";
import { TEST_ROLES, anonClient, signInAs, type SignedIn, type TestRole } from "./support/signInAs";
import { assertLocalSupabaseUrl } from "./support/localGuard";

/**
 * QA 11 (FIG-1244): learner records through the app's own functions: the CSV import end to end (parseStudentCsv, then
 * importStudents, exactly as the People screen calls them), archive, restore and delete, and what an archived learner can still do.
 *
 * Every throwaway learner has an admission number starting QA11- and goes in the first demo school (Alliance). afterAll removes
 * them in small batches and fails loudly if any are left; beforeAll sweeps what an aborted run left. The seeded learners are only
 * ever read, except Faith (ST-0002), who is archived for one test and restored in a finally, and again in afterAll if need be.
 * The CSV parser's own rules are in apps/web/src/lib/studentImport.test.ts; the database's rules are in
 * supabase/rls-checks/learner_records.sql; the screens are in e2e/learners.spec.ts.
 *
 * Known defects are written as the behaviour we want and use it.fails: they pass while the defect exists and fail the day it is
 * fixed. Then change it.fails to it.
 */

const run = Date.now().toString(36);
let admin: SignedIn;
let tenantId = "", faith = "";
let classIdByName = new Map<string, string>();

// ---------------------------------------------------------------- helpers

/** Points the app's own functions (which use the global client) at one signed-in user. */
let current = "";
async function actAs(role: TestRole) {
  if (current === role) return;
  initSupabase({ url: assertLocalSupabaseUrl(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL).origin, anonKey: process.env.VITE_SUPABASE_ANON_KEY!, detectSessionInUrl: false });
  const { error } = await supabase().auth.signInWithPassword({ email: TEST_ROLES[role].email, password: TEST_ROLES[role].password });
  if (error) throw new Error(`could not sign in as ${role}: ${error.message}`);
  current = role;
}

/** The admission numbers the People screen checks against: the ACTIVE learners it has loaded. */
async function activeNumbers(): Promise<Set<string>> {
  const { data, error } = await admin.client.from("students").select("admission_no").eq("tenant_id", tenantId).eq("active", true).range(0, 999);
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((s) => s.admission_no as string));
}
const ctx = async (): Promise<ParseContext> => ({ classIdByName, existingAdmissionNos: await activeNumbers() });
const mine = async (like: string) => {
  const { data, error } = await admin.client.from("students")
    .select("id, admission_no, full_name, gender, boarding, date_of_birth, class_id, active, home_address, home_lat, home_lng, archived_at").eq("tenant_id", tenantId).like("admission_no", like).order("admission_no");
  if (error) throw new Error(error.message);
  return data ?? [];
};
const countMine = async (like: string) => {
  const { count } = await admin.client.from("students").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).like("admission_no", like);
  return count ?? 0;
};
async function addLearner(label: string): Promise<string> {
  const { data, error } = await admin.client.from("students")
    .insert({ tenant_id: tenantId, admission_no: `QA11-${run}-${label}`, full_name: `QA11 Probe ${label}`, boarding: false, active: true, gender: "male", class_id: classIdByName.get("form 1 east") }).select("id").single();
  if (error) throw new Error(`could not add a learner: ${error.message}`);
  return data.id as string;
}
/** Removes every QA11- learner in batches of 200 (the delete guard checks seven tables per learner), and says if any survive. */
async function removeProbes(): Promise<string | null> {
  for (let i = 0; i < 40; i++) {
    const { data } = await admin.client.from("students").select("id").eq("tenant_id", tenantId).like("admission_no", "QA11-%").limit(200);
    if (!data?.length) return null;
    const { error } = await admin.client.from("students").delete().in("id", data.map((s) => s.id as string));
    if (error) return error.message;
  }
  return "still more than 8,000 left";
}

const HEADER = "admission_no,full_name,gender,class,boarding,date_of_birth";
const num = (label: string) => `QA11-${run}-${label}`;

// ---------------------------------------------------------------- set up

beforeAll(async () => {
  admin = await signInAs("school_admin");
  tenantId = (await admin.client.from("profiles").select("tenant_id").eq("id", admin.userId).single()).data!.tenant_id as string;
  const classes = await admin.client.from("classes").select("id, name").eq("tenant_id", tenantId);
  classIdByName = new Map((classes.data ?? []).map((c) => [(c.name as string).trim().toLowerCase(), c.id as string]));
  expect(classIdByName.has("form 1 east") && classIdByName.has("form 2 west")).toBe(true);
  faith = (await admin.client.from("students").select("id").eq("tenant_id", tenantId).eq("admission_no", "4102").single()).data!.id as string;
  await admin.client.rpc("restore_learners", { p_ids: [faith] }); // in case an aborted run left Faith archived
  const left = await removeProbes();
  if (left) throw new Error(`could not sweep an earlier run's learners: ${left}`);
  await actAs("school_admin");
}, 120_000);

afterAll(async () => {
  const errors: string[] = [];
  if (admin) {
    const restored = await admin.client.rpc("restore_learners", { p_ids: [faith] });
    if (restored.error) errors.push(`restoring Faith: ${restored.error.message}`);
    const left = await removeProbes();
    if (left) errors.push(`removing the throwaway learners: ${left}`);
    const still = await countMine("QA11-%");
    if (still) errors.push(`${still} QA11- learners are still there`);
    const f = await admin.client.from("students").select("active").eq("id", faith).single();
    if (!f.data?.active) errors.push("Faith is not active");
  }
  if (errors.length) throw new Error(`cleanup failed, run the file again to sweep: ${errors.join("; ")}`);
}, 120_000);

// ---------------------------------------------------------------- 1. the import, end to end

describe("the CSV import saves what the screen said was ready", () => {
  const FILE = [
    `${HEADER},home_address,home_lat,home_lng`,
    `${num("I1")},QA11 Import One,female,Form 1 East,yes,2011-05-06,"Plot 1, Test Road",-1.2186,36.9258`,
    `${num("I2")},QA11 Import Two,male,Form 2 West,no,,,,`,
    `${num("I3")},"QA11 ""Three"", Import",male,Form 1 East,no,2012-01-31,,,`,
  ].join("\r\n");

  it("three valid rows are saved in one go with every column in the right place", async () => {
    const rows = parseStudentCsv("﻿" + FILE, await ctx());
    expect(rows.map((r) => r.errors)).toEqual([[], [], []]);
    expect(await importStudents(tenantId, classIdByName, rows)).toBe(3);

    const saved = await mine(`QA11-${run}-I%`);
    expect(saved.map((s) => [s.admission_no.split("-").pop(), s.full_name, s.gender, s.boarding, s.date_of_birth])).toEqual([
      ["I1", "QA11 Import One", "female", true, "2011-05-06"],
      ["I2", "QA11 Import Two", "male", false, null],
      ["I3", 'QA11 "Three", Import', "male", false, "2012-01-31"],
    ]);
    expect(saved.map((s) => s.class_id)).toEqual([classIdByName.get("form 1 east"), classIdByName.get("form 2 west"), classIdByName.get("form 1 east")]);
    expect([saved[0]!.home_address, saved[0]!.home_lat, saved[0]!.home_lng]).toEqual(["Plot 1, Test Road", -1.2186, 36.9258]);
    expect(saved.every((s) => s.active)).toBe(true);
  });

  it("importing the same file again creates nobody: every row is flagged and nothing is saved", async () => {
    const rows = parseStudentCsv(FILE, await ctx());
    expect(rows.map((r) => r.errors.length)).toEqual([1, 1, 1]);
    expect(rows[0]!.errors[0]).toMatch(/is already on the roster/);
    expect(await importStudents(tenantId, classIdByName, rows)).toBe(0);
    expect(await countMine(`QA11-${run}-I%`)).toBe(3);
  });
});

describe("rows that pass the check but cannot be saved", () => {
  it.fails("QA11-DATE FIG-1412: one row with a date that does not exist does not stop the good rows being imported", async () => {
    const rows = parseStudentCsv([HEADER, `${num("D1")},Good One,male,Form 1 East,no,2011-01-01`, `${num("D2")},Bad Date,male,Form 1 East,no,2010-02-31`, `${num("D3")},Good Two,male,Form 1 East,no,2011-01-02`].join("\n"), await ctx());
    expect(await importStudents(tenantId, classIdByName, rows), "only the two good rows are saved").toBe(2);
  });
  it("(what the open defect leaves behind) the whole import fails, with the database's own words, and none of the three is saved", async () => {
    const rows = parseStudentCsv([HEADER, `${num("D4")},Good One,male,Form 1 East,no,2011-01-01`, `${num("D5")},Bad Date,male,Form 1 East,no,2010-02-31`, `${num("D6")},Good Two,male,Form 1 East,no,2011-01-02`].join("\n"), await ctx());
    expect(rows.map((r) => r.errors.length), "the check passed all three").toEqual([0, 0, 0]);
    const err = await importStudents(tenantId, classIdByName, rows).then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect((err as { message?: string }).message).toMatch(/date\/time field value out of range/);
    expect(await countMine(`QA11-${run}-D%`)).toBe(0);
  });

  it.fails("QA11-ARCHIVED FIG-1413: a number that belongs to an archived learner is flagged before anything is saved", async () => {
    const id = await addLearner("A1");
    expect(await archiveLearners([id])).toBe(1);
    const rows = parseStudentCsv([HEADER, `${num("A1")},Reuses A1,male,Form 1 East,no,`].join("\n"), await ctx());
    expect(rows[0]!.errors.length, "the People screen lists active learners only, so it cannot see the number").toBeGreaterThan(0);
  });
  it("(what the open defect leaves behind) saving it fails the whole import with the database's own words, and the good row beside it is lost", async () => {
    const rows = parseStudentCsv([HEADER, `${num("A1")},Reuses A1,male,Form 1 East,no,`, `${num("A2")},A Good Row,male,Form 1 East,no,`].join("\n"), await ctx());
    expect(rows.map((r) => r.errors.length)).toEqual([0, 0]);
    const err = await importStudents(tenantId, classIdByName, rows).then(() => null, (e: unknown) => e);
    expect((err as { message?: string } | null)?.message).toMatch(/duplicate key value violates unique constraint "students_tenant_id_admission_no_key"/);
    expect(await countMine(`QA11-${run}-A2`)).toBe(0);
  });
});

// FIG-1414 (fixed on main): allergies and conditions need the family's signed consent form, named in two more columns, and the
// import records the form before it saves the health row. Without the form the row is flagged when the file is checked.
describe("the health columns of the import", () => {
  const FILE = (label: string, consent = true) => [
    `${HEADER},allergies,medical_conditions${consent ? ",health_consent_signed_by,health_consent_date" : ""}`,
    `${num(label)},QA11 Health ${label},female,Form 1 East,no,2011-05-06,"Peanuts; Eggs",Asthma${consent ? ",Grace Wanjiru,2026-01-15" : ""}`,
  ].join("\n");
  it("QA11-HEALTH FIG-1414: a row with allergies, conditions and the consent form is saved, with its health record, and the import reports no failure", async () => {
    const rows = parseStudentCsv(FILE("H1"), await ctx());
    expect(rows[0]!.errors).toEqual([]);
    expect(await importStudents(tenantId, classIdByName, rows)).toBe(1);
    const [saved] = await mine(num("H1"));
    expect(saved, "the learner was saved").toBeDefined();
    const health = await admin.client.from("student_health").select("allergies, medical_conditions").eq("student_id", saved!.id);
    expect(health.error).toBeNull();
    expect(health.data).toHaveLength(1);
    expect(JSON.stringify(health.data![0])).toMatch(/Peanuts/);
  });
  it("a row with allergies or conditions and no consent form is flagged when the file is checked, and is not saved", async () => {
    const rows = parseStudentCsv(FILE("H2", false), await ctx());
    expect(rows[0]!.errors.join(" ")).toMatch(/consent form/i);
    const saved = await importStudents(tenantId, classIdByName, rows).then((n) => n, () => 0);
    expect(saved).toBe(0);
    expect(await mine(num("H2"))).toEqual([]);
  });
});

describe("what the office is told when the database refuses an import", () => {
  it.fails("QA11-IMPORT-ERROR FIG-1422: a failed import throws an Error with the database's words in it (the screen shows only the words of an Error; anything else becomes 'Import failed.')", async () => {
    const rows = parseStudentCsv([HEADER, `${num("E1")},Bad Date,male,Form 1 East,no,2010-02-31`].join("\n"), await ctx());
    const err = await importStudents(tenantId, classIdByName, rows).then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect(err instanceof Error, "the thrown value is a plain object from the database client, not an Error").toBe(true);
  });
});

describe("several thousand rows", () => {
  it("500 rows are checked and saved in one import, all of them", async () => {
    const body = Array.from({ length: 500 }, (_, i) => `QA11-${run}-M${String(i + 1).padStart(4, "0")},Mid Learner ${i + 1},${i % 2 ? "male" : "female"},Form 1 East,no,2010-01-01`);
    const rows = parseStudentCsv([HEADER, ...body].join("\n"), await ctx());
    expect(rows.filter((r) => r.errors.length)).toEqual([]);
    expect(await importStudents(tenantId, classIdByName, rows)).toBe(500);
    expect(await countMine(`QA11-${run}-M%`)).toBe(500);
  }, 60_000);

  // The import sends every row in one request, so there is a ceiling: measured on an idle local database (2026-10-30, rolled-back SQL as
  // the school admin, 8 s limit), 2,000 rows take about 1.5 s, 3,000 about 2.5 s, 4,500 about 5 s and 7,000 hit the limit, so the whole
  // import fails and nothing is saved. A school that size is rare and a hosted database is faster or slower, so this is recorded as INFO,
  // not filed; this test only guards the size a big school really has.
  it("3,000 rows are checked and saved by one import, all of them", async () => {
    const body = Array.from({ length: 3000 }, (_, i) => `QA11-${run}-S${String(i + 1).padStart(4, "0")},Scale Learner ${i + 1},${i % 2 ? "male" : "female"},${i % 3 ? "Form 1 East" : "Form 2 West"},no,2010-01-01`);
    const rows = parseStudentCsv([HEADER, ...body].join("\n"), await ctx());
    expect(rows.filter((r) => r.errors.length)).toEqual([]);
    const t0 = Date.now();
    const saved = await importStudents(tenantId, classIdByName, rows).then((n) => ({ n }), (e: unknown) => ({ e }));
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    console.log(`importing 3,000 learners took ${seconds}s: ${"n" in saved ? "saved " + saved.n : "failed: " + (saved.e as { message?: string }).message}`);
    expect("e" in saved ? (saved.e as { message?: string }).message : null, "the import failed").toBeNull();
    expect(saved).toEqual({ n: 3000 });
  }, 120_000);
});

// ---------------------------------------------------------------- 2. archive, restore, delete

describe("archive, restore and delete, as the People screen calls them", () => {
  it("archiving takes a learner off the active roll and into the Archived list; restoring brings them back", async () => {
    const id = await addLearner("R1");
    expect(await archiveLearners([id])).toBe(1);
    expect((await mine(num("R1")))[0]).toMatchObject({ active: false });
    expect((await mine(num("R1")))[0]!.archived_at).not.toBeNull();
    expect((await fetchArchivedLearners(tenantId)).map((l) => l.id)).toContain(id);
    expect(await restoreLearners([id])).toBe(1);
    expect((await mine(num("R1")))[0]).toMatchObject({ active: true, archived_at: null });
    expect((await fetchArchivedLearners(tenantId)).map((l) => l.id)).not.toContain(id);
  });

  it("a teacher who tries to delete a learner is told only the school admin can, and the learner is still there", async () => {
    const id = await addLearner("T1");
    await actAs("teacher");
    await expect(deleteLearners([id])).rejects.toThrow("Only the school admin can delete learners.");
    await actAs("school_admin");
    expect(await countMine(num("T1"))).toBe(1);
  });

  it("deleting a learner who has records is refused in words that name the records and say to archive; one refusal removes none of the batch", async () => {
    const id = await addLearner("D1");
    await expect(deleteLearners([id, faith])).rejects.toThrow(/has attendance, exam marks, fee records on file, so they can't be deleted\. Archive them instead/);
    expect(await countMine(num("D1")), "the learner with no records, in the same batch, is still there").toBe(1);
    await expect(deleteLearners([id])).resolves.toBeUndefined();
    expect(await countMine(num("D1"))).toBe(0);
  });
});

// ---------------------------------------------------------------- 3. what an archived learner can still do

describe("a learner who has been archived", () => {
  it.fails("FIG-1305 (open): can no longer sign in", async () => {
    try {
      expect(await archiveLearners([faith])).toBe(1);
      const { error } = await anonClient().auth.signInWithPassword({ email: TEST_ROLES.student.email, password: TEST_ROLES.student.password });
      expect(error, "an archived learner (ST-0002, Faith) can still sign in").not.toBeNull();
    } finally {
      await restoreLearners([faith]);
    }
  });
});
