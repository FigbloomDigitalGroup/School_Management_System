import { expect, test, type Page } from "@playwright/test";
import { confirmDialog } from "./support/confirm";
import { createClient } from "@supabase/supabase-js";

process.loadEnvFile?.(); // Node 20.6+ built-in
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

/**
 * QA 12 (FIG-1245): the school setup screens as the school admin uses them: starting a new term (Settings > Term dates), the Classes
 * screen (delete, the timetable editor) and what a school of several levels shows. The onboarding wizard is covered by flows.spec.ts
 * ("platform"), the pure rules by packages/shared/src/{timetable,curriculum,levels}.test.ts, the app's own functions by
 * tests/integration/schoolSetup.test.ts and the database's rules by supabase/rls-checks/school_setup.sql.
 *
 * Everything this writes is put back: terms of 2027 and later are deleted and Term 3, 2026 is made current again, throwaway classes
 * are named "QA12 E2E ..." (learners QA12-E-...), timetable periods are labelled "QA12 Chem". afterAll checks the counts against
 * what it found (Alliance seed: 2 terms, 8 classes, 40 timetable periods, 430 attendance rows) and fails loudly if they differ.
 * Desktop only: these are admin screens read at desktop width.
 *
 * Known defects use test.fail(): they pass while the defect exists and fail the day it is fixed. Then remove test.fail().
 */
test.describe.configure({ mode: "serial", timeout: 90_000 });
test.skip(({ isMobile }) => isMobile, "the admin screens are read at desktop width");

const PASSWORD = "figbloom-dev";
const table: string[][] = [["Screen", "What was done", "Expected", "Found"]];
let tenantId = "", term3 = "", teacherId = "";
const base = { terms: 0, classes: 0, slots: 0, attendance: 0, leave: 0, cover: 0 };
const count = async (tbl: string) => (await db.from(tbl).select("id", { count: "exact", head: true }).eq("tenant_id", tenantId)).count ?? 0;
const currentTerms = async () => ((await db.from("terms").select("id, year, index").eq("tenant_id", tenantId).eq("is_current", true)).data ?? []) as { id: string; year: number; index: number }[];

/** Terms: every term of 2027 and later goes; Term 3, 2026 is the only current term again. */
async function restoreTerms() {
  await db.from("terms").update({ is_current: false }).eq("tenant_id", tenantId);
  await db.from("terms").delete().eq("tenant_id", tenantId).gte("year", 2027);
  await db.from("terms").update({ is_current: true }).eq("id", term3);
}
const SUB_EMAIL = "qa12e.sub@alliance.sc.ke", UNI_SLUG = "qa12-uni", UNI_ADMIN = "qa12e.registrar@qa12uni.ac.ke";
/** Wednesday of this week as the app's own currentWeekDates() works it out (cover is looked up for every day of the current week). */
function wednesday(now: Date = new Date()): string {
  const dow = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() + (dow === 0 ? -6 : 1 - dow));
  const d = new Date(monday);
  d.setDate(monday.getDate() + 2);
  return d.toISOString().slice(0, 10);
}
async function removeUser(email: string) {
  const { data } = await db.from("profiles").select("id").eq("email", email);
  for (const p of data ?? []) { await db.from("profiles").delete().eq("id", p.id as string); await db.auth.admin.deleteUser(p.id as string); }
}
async function removeThrowaways() {
  const old = await db.from("students").select("id").eq("tenant_id", tenantId).like("admission_no", "QA12-E-%");
  for (const s of old.data ?? []) { await db.from("attendance").delete().eq("student_id", s.id as string); await db.from("students").delete().eq("id", s.id as string); }
  // the cover fixtures: a substitute teacher, a leave request for TC-0002, two linked periods, the cover rows and the messages sent
  for (const s of (await db.from("profiles").select("id").eq("email", SUB_EMAIL)).data ?? []) {
    await db.from("announcements").delete().eq("tenant_id", tenantId).filter("audience->>user_id", "eq", s.id as string);
    await db.from("teacher_subjects").delete().eq("teacher_id", s.id as string);
    await db.from("teaching_assignments").delete().eq("teacher_id", s.id as string);
  }
  await db.from("coverage_assignments").delete().eq("tenant_id", tenantId).eq("date", wednesday());
  await db.from("leave_requests").delete().eq("tenant_id", tenantId).eq("reason", "QA12E");
  await db.from("timetable_slots").delete().eq("tenant_id", tenantId).eq("label", "QA12 Chem");
  await removeUser(SUB_EMAIL);
  // the throwaway university
  await removeUser(UNI_ADMIN);
  await db.from("tenants").delete().eq("slug", UNI_SLUG);
  await db.from("classes").delete().eq("tenant_id", tenantId).like("name", "QA12 E2E %");
}

test.beforeAll(async () => {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.SUPABASE_URL ?? "")) throw new Error("local Supabase only");
  await db.from("login_lookups").delete().gte("looked_up_at", "1970-01-01"); // same reason as flows.spec.ts
  tenantId = (await db.from("tenants").select("id").eq("slug", "alliance").single()).data!.id as string;
  term3 = (await db.from("terms").select("id").eq("tenant_id", tenantId).eq("year", 2026).eq("index", 3).single()).data!.id as string;
  teacherId = (await db.from("profiles").select("id").eq("tenant_id", tenantId).eq("login_id", "TC-0002").single()).data!.id as string;
  await restoreTerms();
  await removeThrowaways();
  base.terms = await count("terms"); base.classes = await count("classes"); base.slots = await count("timetable_slots"); base.attendance = await count("attendance");
  base.leave = await count("leave_requests"); base.cover = await count("coverage_assignments");
  expect(base, "seed data only: Alliance has 2 terms, 8 classes, 40 timetable periods, 430 attendance rows, no leave requests, no cover").toEqual({ terms: 2, classes: 8, slots: 40, attendance: 430, leave: 0, cover: 0 });
});

test.afterEach(async () => { await restoreTerms(); });

test.afterAll(async () => {
  const errors: string[] = [];
  await restoreTerms();
  await removeThrowaways();
  const now = { terms: await count("terms"), classes: await count("classes"), slots: await count("timetable_slots"), attendance: await count("attendance"), leave: await count("leave_requests"), cover: await count("coverage_assignments") };
  if ((await db.from("tenants").select("id").eq("slug", UNI_SLUG)).data?.length) errors.push("the throwaway university is still there");
  if ((await db.from("profiles").select("id").eq("email", SUB_EMAIL)).data?.length) errors.push("the substitute teacher is still there");
  if (JSON.stringify(now) !== JSON.stringify(base)) errors.push(`Alliance has ${JSON.stringify(now)}, not ${JSON.stringify(base)}`);
  const cur = await currentTerms();
  if (cur.length !== 1 || cur[0]!.id !== term3) errors.push("Term 3, 2026 is not the one current term");
  const widths = table[0]!.map((_, c) => Math.max(...table.map((r) => r[c]!.length)));
  console.log("\n" + table.map((r) => "| " + r.map((cell, c) => cell.padEnd(widths[c]!)).join(" | ") + " |").join("\n"));
  if (errors.length) throw new Error(`cleanup failed, run the file again to sweep: ${errors.join("; ")}`);
});

// ---------------------------------------------------------------- helpers
async function signIn(page: Page, email: string) {
  await page.goto("/signin");
  await page.getByRole("button", { name: "Admin portal" }).click();
  await page.getByRole("button", { name: "Sign in with email instead" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 15000 });
}
async function openTermForm(page: Page) {
  await signIn(page, "principal@alliance.sc.ke");
  await page.goto("/s/alliance/admin/settings");
  await page.getByRole("button", { name: /Term dates/ }).click();
  await expect(page.getByRole("button", { name: "Start this term" })).toBeVisible({ timeout: 20000 });
}
async function fillTerm(page: Page, f: { term: 1 | 2 | 3; year: number; starts: string; ends: string }) {
  await page.locator("form").filter({ hasText: "Starts on" }).locator("select").selectOption(String(f.term)); // the label of a select includes its options, so getByLabel("Term") never matches
  await page.getByLabel("Year").fill(String(f.year));
  await page.getByLabel("Starts on").fill(f.starts);
  await page.getByLabel("Ends on").fill(f.ends);
  await page.getByRole("button", { name: "Start this term" }).click();
}
async function openClasses(page: Page, school = "alliance", email = "principal@alliance.sc.ke") {
  await signIn(page, email);
  await page.goto(`/s/${school}/admin/classes`);
  await expect(page.getByText(/^\d+ classes\.$/)).toBeVisible({ timeout: 30000 });
}
/** The row of the Classes table that holds this class's name (the nearest ancestor that has a Delete button). */
const rowOf = (page: Page, name: string) => page.getByText(name, { exact: true }).first().locator("xpath=ancestor::*[.//button[normalize-space()='Delete']][1]");

// ================================================================ starting a new term (Settings > Term dates)
test.describe("Term dates", () => {
  test("starting the next term ends the current one and makes the new one current", async ({ page }) => {
    await openTermForm(page);
    await fillTerm(page, { term: 1, year: 2027, starts: "2027-01-05", ends: "2027-04-02" });
    await expect(page.getByText("Term 1, 2027 started.")).toBeVisible({ timeout: 15000 });
    const cur = await currentTerms();
    expect(cur.map((t) => `${t.year}/${t.index}`)).toEqual(["2027/1"]);
    expect((await db.from("terms").select("is_current").eq("id", term3).single()).data!.is_current).toBe(false);
  });

  test("QA12-ROLLOVER FIG-1427: a new term the database refuses (Term 3 of 2026 again) leaves the school with its current term", async ({ page }) => {
    await openTermForm(page);
    await fillTerm(page, { term: 3, year: 2026, starts: "2026-12-01", ends: "2026-12-20" });
    await expect(page.getByText(/Could not create the term/)).toBeVisible({ timeout: 15000 });
    const shown = (await page.getByText(/Could not create the term/).first().innerText()).trim();
    const cur = await currentTerms();
    table.push(["Term dates", "start Term 3, 2026 (it exists)", "refused in words; Term 3 stays current", `"${shown.slice(0, 70)}"; current terms: ${cur.length}`]);
    expect(cur.map((t) => t.id)).toEqual([term3]);
  });

  test("QA12-ROLLOVER FIG-1427: a term that ends the day it starts is refused before the current term is switched off", async ({ page }) => {
    await openTermForm(page);
    await fillTerm(page, { term: 1, year: 2027, starts: "2027-01-05", ends: "2027-01-05" });
    await expect(page.getByText(/Could not create the term|must be after the start date/)).toBeVisible({ timeout: 15000 });
    const shown = (await page.getByText(/Could not create the term|must be after the start date/).first().innerText()).trim();
    const cur = await currentTerms();
    table.push(["Term dates", "start a term that ends the day it starts", "\"The end date must be after the start date.\"; Term 3 stays current", `"${shown.slice(0, 70)}"; current terms: ${cur.length}`]);
    expect(cur.map((t) => t.id)).toEqual([term3]);
  });

  test("KNOWN QA12-TERMS FIG-1432 (open): a new term that starts while the current term is still running is refused or warned about", async ({ page }) => {
    test.fail();
    await openTermForm(page);
    await fillTerm(page, { term: 1, year: 2027, starts: "2026-10-01", ends: "2027-02-01" }); // Term 3, 2026 runs to 27 November
    await page.waitForTimeout(2500);
    const made = (await db.from("terms").select("id").eq("tenant_id", tenantId).eq("year", 2027).eq("index", 1)).data ?? [];
    table.push(["Term dates", "start Term 1, 2027 on 1 October (Term 3 runs to 27 November)", "refused or warned", made.length ? "saved; Term 3 ended early" : "not saved"]);
    expect(made, "the overlapping term was not saved").toHaveLength(0);
  });
});

// ================================================================ the Classes screen
test.describe("Classes", () => {
  test("a class that still has learners is not deleted, and the message says how many are in it", async ({ page }) => {
    await openClasses(page);
    await rowOf(page, "Form 1 East").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText(/Form 1 East has \d+ learners? on it — move them first\./)).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("alertdialog"), "no confirmation is asked for a class that cannot be deleted").toHaveCount(0);
    expect((await db.from("classes").select("id").eq("tenant_id", tenantId).eq("name", "Form 1 East")).data).toHaveLength(1);
  });

  test("KNOWN QA12-DELETE FIG-1428 (open): deleting a class its learners have already left keeps the attendance they were marked in it", async ({ page }) => {
    test.fail();
    const made = await db.from("classes").insert({ tenant_id: tenantId, name: "QA12 E2E Old", level: "secondary", form_level: 2 }).select("id").single();
    expect(made.error).toBeNull();
    const kid = await db.from("students").insert({ tenant_id: tenantId, admission_no: "QA12-E-OLD1", full_name: "QA12E Old Learner", class_id: made.data!.id, boarding: false, active: true, gender: "female" }).select("id").single();
    expect(kid.error).toBeNull();
    const att = await db.from("attendance").insert({ tenant_id: tenantId, student_id: kid.data!.id, class_id: made.data!.id, term_id: term3, taken_by: teacherId, taken_on: "2026-09-02", mark: "present" });
    expect(att.error).toBeNull();
    const up = (await db.from("classes").select("id").eq("tenant_id", tenantId).eq("name", "Form 3 East").single()).data!.id as string;
    await db.from("students").update({ class_id: up }).eq("id", kid.data!.id as string); // the learner was promoted; the old class is empty

    await openClasses(page);
    await rowOf(page, "QA12 E2E Old").getByRole("button", { name: "Delete" }).click();
    const asked = await confirmDialog(page, "Delete");
    await expect(page.getByText("QA12 E2E Old deleted.")).toBeVisible({ timeout: 10000 });
    const left = (await db.from("attendance").select("id", { count: "exact", head: true }).eq("student_id", kid.data!.id as string)).count ?? 0;
    table.push(["Classes", "delete an emptied class whose former learner was marked in it", "attendance kept (1 row); the confirmation says what goes", `${left} row(s) left; confirmation: "${asked}"`]);
    expect(left, "the learner's attendance in the deleted class").toBe(1);
  });

  test("the timetable editor refuses a period that already exists and a time that is not HH:MM, in words", async ({ page }) => {
    await openClasses(page);
    await rowOf(page, "Form 1 East").getByRole("button", { name: "Timetable" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Timetable · Form 1 East");
    await dialog.getByLabel("New period time").fill("07:10");
    await dialog.getByRole("button", { name: "Add period" }).click();
    await dialog.getByLabel("New period time").fill("07:10");
    await dialog.getByRole("button", { name: "Add period" }).click();
    await expect(page.getByText("That period already exists.")).toBeVisible({ timeout: 10000 });
    await dialog.getByLabel("New period time").fill("7pm");
    await dialog.getByRole("button", { name: "Add period" }).click();
    await expect(page.getByText("Enter a time as HH:MM, e.g. 08:00.")).toBeVisible({ timeout: 10000 });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect((await db.from("timetable_slots").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId)).count).toBe(base.slots);
  });

  test("KNOWN QA12-CLASH FIG-1429 (open): the same teacher's subject cannot be put in two classes at the same time", async ({ page }) => {
    test.fail();
    await openClasses(page);
    for (const cls of ["Form 1 East", "Form 3 East"]) {
      await rowOf(page, cls).getByRole("button", { name: "Timetable" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("New period time").fill("07:20");
      await dialog.getByRole("button", { name: "Add period" }).click();
      await dialog.getByLabel("Mon 07:20 subject").fill("QA12 Chem");
      await dialog.getByLabel("Mon 07:20 linked subject").selectOption({ label: "Chemistry" });
      await dialog.getByRole("button", { name: "Save timetable" }).click();
      await expect(page.getByText(`Timetable saved for ${cls}.`)).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(500);
    }
    const slots = (await db.from("timetable_slots").select("class_id, subject_id").eq("tenant_id", tenantId).eq("label", "QA12 Chem").eq("day", "Mon").eq("start_time", "07:20")).data ?? [];
    const booked = await db.from("teaching_assignments").select("class_id").eq("teacher_id", teacherId).in("class_id", slots.map((s) => s.class_id as string)).in("subject_id", slots.map((s) => s.subject_id as string));
    table.push(["Timetable editor", "Chemistry (TC-0002) in Form 1 East and Form 3 East at Mon 07:20", "the second save is refused or warned", `both saved, no warning; TC-0002 is booked in ${booked.data?.length ?? 0} classes at once`]);
    expect(booked.data?.length ?? 0, "classes TC-0002 is booked into at Mon 07:20").toBeLessThan(2);
  });
});

// ================================================================ the curriculum type decides the screens
test.describe("what a school's levels change on screen", () => {
  test("a one-level school (Alliance) lists classes by Form with no Level column; a school with PP, Grade and senior classes (Kijani Ridge) shows Level and Grade labels", async ({ page }) => {
    await openClasses(page);
    const alliance = (await page.locator("body").innerText());
    expect(alliance).toMatch(/Form 1 East/);
    expect(alliance).not.toMatch(/\bLEVEL\b/i);
    await page.context().clearCookies();
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await openClasses(page, "kijani-ridge", "head@kijaniridge.sc.ke");
    const kijani = (await page.locator("body").innerText());
    table.push(["Classes", "Alliance (one level) vs Kijani Ridge (PP to Grade 12)", "Level column only for the mixed school", `Alliance has Level: ${/\bLEVEL\b/i.test(alliance)}; Kijani Ridge has Level: ${/\bLEVEL\b/i.test(kijani)}`]);
    expect(kijani).toMatch(/\bLEVEL\b/i);
    expect(kijani).toMatch(/PP1|Grade \d+/);
  });
});

// ================================================================ Reports and Fees follow the current term
test.describe("Reports and Fees follow the school's current term", () => {
  test("a new, empty current term shows its own (empty) figures on Reports and Fees, not the previous term's", async ({ page }) => {
    const invoices = (await db.from("fee_invoices").select("total_cents").eq("tenant_id", tenantId).eq("term_id", term3)).data ?? [];
    const billed = Math.round(invoices.reduce((s, i) => s + (i.total_cents as number), 0) / 100).toLocaleString("en-US");
    await signIn(page, "principal@alliance.sc.ke");
    await page.goto("/s/alliance/admin/reports");
    await expect(page.locator("body")).toContainText(billed, { timeout: 30000 }); // while Term 3 is current its figure is there
    await page.goto("/s/alliance/admin/fees");
    await expect(page.locator("body")).toContainText(billed, { timeout: 30000 });
    // the school starts an empty term (what Settings > Term dates leaves behind)
    await db.from("terms").update({ is_current: false }).eq("id", term3);
    const made = await db.from("terms").insert({ tenant_id: tenantId, name: "Term 1, 2027", year: 2027, index: 1, starts_on: "2027-01-05", ends_on: "2027-04-02", is_current: true });
    expect(made.error).toBeNull();
    const seen: string[] = [];
    for (const [screen, path] of [["Reports", "/s/alliance/admin/reports"], ["Fees", "/s/alliance/admin/fees"]] as const) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1500);
      const text = await page.locator("body").innerText();
      seen.push(`${screen}: ${text.includes(billed) ? "still shows " + billed : "no old figure"}`);
      expect(text, `${screen} must not show Term 3's billed total`).not.toContain(billed);
    }
    table.push(["Reports / Fees", `a new empty term is current (Term 3 billed ${billed})`, "the old figure is gone", seen.join("; ")]);
  });
});

// ================================================================ cover on the admin Dashboard
test.describe("Cover on the admin Dashboard", () => {
  const wed = wednesday();
  let subId = "";
  const messages = async () => ((await db.from("announcements").select("subject, body").eq("tenant_id", tenantId).filter("audience->>user_id", "eq", subId)).data ?? []) as { subject: string; body: string }[];
  const item = (page: Page) => page.locator("section").filter({ hasText: "Needs cover this week" }).locator("li").filter({ hasText: "Chemistry · Form 1 East" });

  test("set up: a substitute who teaches Chemistry and Biology, TC-0002 on approved leave on Wednesday, Chemistry in Form 1 East and Biology in Form 3 East at 07:30", async () => {
    const created = await db.auth.admin.createUser({ email: SUB_EMAIL, password: PASSWORD, email_confirm: true });
    expect(created.error).toBeNull();
    subId = created.data.user!.id;
    expect((await db.from("profiles").insert({ id: subId, tenant_id: tenantId, role: "teacher", full_name: "QA12E Substitute", email: SUB_EMAIL, must_change_password: false })).error).toBeNull();
    const subj = async (code: string) => (await db.from("subjects").select("id").eq("tenant_id", tenantId).eq("code", code).single()).data!.id as string;
    const cls = async (name: string) => (await db.from("classes").select("id").eq("tenant_id", tenantId).eq("name", name).single()).data!.id as string;
    const [che, bio, c1, c3] = [await subj("CHE"), await subj("BIO"), await cls("Form 1 East"), await cls("Form 3 East")];
    expect((await db.from("teacher_subjects").insert({ tenant_id: tenantId, teacher_id: subId, subject_id: che })).error).toBeNull();
    expect((await db.from("teaching_assignments").insert({ tenant_id: tenantId, teacher_id: subId, class_id: c3, subject_id: bio })).error).toBeNull();
    expect((await db.from("timetable_slots").insert([
      { tenant_id: tenantId, class_id: c1, day: "Wed", start_time: "07:30", label: "QA12 Chem", subject_id: che },
      { tenant_id: tenantId, class_id: c3, day: "Wed", start_time: "07:30", label: "QA12 Chem", subject_id: bio },
    ])).error).toBeNull();
    const adminId = (await db.from("profiles").select("id").eq("tenant_id", tenantId).eq("role", "school_admin").limit(1).single()).data!.id as string;
    expect((await db.from("leave_requests").insert({ tenant_id: tenantId, teacher_id: teacherId, starts_on: wed, ends_on: wed, reason: "QA12E", status: "approved", reviewed_by: adminId, reviewed_at: new Date().toISOString() })).error).toBeNull();
  });

  test("the Dashboard shows the lesson that needs cover, with the teacher on leave", async ({ page }) => {
    await signIn(page, "principal@alliance.sc.ke");
    await page.goto("/s/alliance/admin");
    await expect(item(page)).toBeVisible({ timeout: 30000 });
    await expect(item(page)).toContainText("Michael Kiruti is on approved leave");
    await expect(item(page)).toContainText("Wed 07:30");
  });

  test("KNOWN QA12-COVER FIG-1434 (open): a teacher who is teaching another class at that time is not offered as the substitute", async ({ page }) => {
    test.fail();
    await signIn(page, "principal@alliance.sc.ke");
    await page.goto("/s/alliance/admin");
    await expect(item(page)).toBeVisible({ timeout: 30000 });
    const options = await item(page).locator("select option").allInnerTexts();
    table.push(["Dashboard > Needs cover", "Chemistry, Form 1 East, Wed 07:30; the other Chemistry teacher is teaching Biology in Form 3 East then", "not offered", `options: ${options.join(" / ")}`]);
    expect(options.some((o) => o.includes("QA12E Substitute")), "the busy teacher is offered").toBe(false);
  });

  test("assigning the substitute tells them in the app, and the card says who covers", async ({ page }) => {
    await signIn(page, "principal@alliance.sc.ke");
    await page.goto("/s/alliance/admin");
    await expect(item(page)).toBeVisible({ timeout: 30000 });
    await item(page).getByLabel(/Substitute for Chemistry/).selectOption({ label: "QA12E Substitute" });
    await item(page).getByRole("button", { name: "Assign" }).click();
    await expect(page.getByText("Assigned to cover — they've been notified.")).toBeVisible({ timeout: 15000 });
    await expect(item(page)).toContainText("Covered by QA12E Substitute");
    const told = await messages();
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain("You're covering Chemistry");
  });

  test("KNOWN QA12-COVER FIG-1434 (open): marking the slot a free period afterwards tells the substitute it is off", async ({ page }) => {
    test.fail();
    await signIn(page, "principal@alliance.sc.ke");
    await page.goto("/s/alliance/admin");
    await expect(item(page)).toBeVisible({ timeout: 30000 });
    await item(page).getByRole("button", { name: "Change" }).click();
    await item(page).getByRole("button", { name: "Mark free period" }).click();
    await expect(page.getByText("Marked as a free period.")).toBeVisible({ timeout: 15000 });
    const told = await messages();
    const stillCovering = told.some((m) => /You're covering/.test(m.body));
    const toldItIsOff = told.some((m) => /no longer|not covering|cancel|withdrawn|free period/i.test(m.subject + " " + m.body));
    table.push(["Dashboard > Needs cover", "assign a substitute, then Mark free period", "the substitute is told it is off", `${told.length} message(s): ${told.map((m) => m.body.slice(0, 24)).join(" / ")}`]);
    expect(!stillCovering || toldItIsOff, "the substitute is told").toBe(true);
  });
});

// ================================================================ the institution type decides the screens
test.describe("a higher-education school", () => {
  test("set up: a throwaway university and its registrar", async () => {
    const t = await db.from("tenants").insert({ name: "QA12 Test University", slug: UNI_SLUG, county: "Nairobi", institution_type: "higher_ed", higher_ed_subtype: "university", country: "KE", status: "active", plan: "institution" }).select("id").single();
    expect(t.error).toBeNull();
    const u = await db.auth.admin.createUser({ email: UNI_ADMIN, password: PASSWORD, email_confirm: true });
    expect(u.error).toBeNull();
    expect((await db.from("profiles").insert({ id: u.data.user!.id, tenant_id: t.data!.id, role: "school_admin", full_name: "QA12E Registrar", email: UNI_ADMIN, must_change_password: false })).error).toBeNull();
  });

  test("its admin's sidebar has Courses and none of the K-12 screens (Classes, Subjects, Exams); a K-12 school's has the opposite", async ({ page }) => {
    await signIn(page, UNI_ADMIN);
    await page.goto(`/s/${UNI_SLUG}/admin`);
    await expect(page.getByRole("link", { name: "Courses", exact: true })).toBeVisible({ timeout: 30000 });
    const uni: Record<string, number> = {};
    for (const n of ["Classes", "Subjects", "Exams"]) uni[n] = await page.getByRole("link", { name: n, exact: true }).count();
    await page.context().clearCookies();
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await signIn(page, "principal@alliance.sc.ke");
    await page.goto("/s/alliance/admin");
    await expect(page.getByRole("link", { name: "Classes", exact: true })).toBeVisible({ timeout: 30000 });
    const k12Courses = await page.getByRole("link", { name: "Courses", exact: true }).count();
    table.push(["Sidebar", "higher-ed admin vs K-12 admin", "Courses only for higher ed; Classes, Subjects, Exams only for K-12", `higher-ed has Classes ${uni.Classes}, Subjects ${uni.Subjects}, Exams ${uni.Exams}; K-12 has Courses ${k12Courses}`]);
    expect(uni).toEqual({ Classes: 0, Subjects: 0, Exams: 0 });
    expect(k12Courses).toBe(0);
  });

  test("KNOWN QA12-ROUTES FIG-1437 (open): a K-12 screen is not reachable by its address on a higher-education school", async ({ page }) => {
    test.fail();
    await signIn(page, UNI_ADMIN);
    await page.goto(`/s/${UNI_SLUG}/admin/classes`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    const reachable = (await page.getByRole("button", { name: "Add class" }).count()) > 0; // two buttons match (header and empty state), so count, not isVisible
    table.push(["Direct address", `/s/${UNI_SLUG}/admin/classes as a higher-ed admin`, "redirected, no Add class", `${page.url().replace(/^https?:\/\/[^/]+/, "")}; Add class ${reachable ? "shown" : "not shown"}`]);
    expect(reachable, "the K-12 Classes screen opened for a university").toBe(false);
  });

  test("KNOWN QA12-ROUTES FIG-1437 (open): a higher-education screen is not reachable by its address on a K-12 school", async ({ page }) => {
    test.fail();
    await signIn(page, "principal@alliance.sc.ke");
    await page.goto("/s/alliance/admin/courses");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    table.push(["Direct address", "/s/alliance/admin/courses as a K-12 admin", "redirected", `${page.url().replace(/^https?:\/\/[^/]+/, "")}`]);
    expect(page.url(), "the courses screen opened for a K-12 school").not.toMatch(/\/admin\/courses$/);
  });
});
