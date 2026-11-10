import { expect, test, type Page } from "@playwright/test";
import { confirmDialog } from "./support/confirm";
import { createClient } from "@supabase/supabase-js";
import { loginIdEmail } from "../packages/shared/src/auth";

process.loadEnvFile?.(); // Node 20.6+ built-in
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

/**
 * QA 11 (FIG-1244): the People screen as the school admin uses it to add, import, archive, restore and promote learners, and
 * what the lists say when the school is large. The learner CSV rules are in apps/web/src/lib/studentImport.test.ts, the app's own
 * functions are in tests/integration/learners.test.ts, and the database's rules are in supabase/rls-checks/learner_records.sql.
 *
 * Everything this writes has an admission number starting QA11-E- (the first demo school, Alliance), a name that contains QA11E so
 * the name search finds it, or is the throwaway class "QA11 Promo". Set-up and cleanup use the service role, in batches; afterAll
 * removes it all, puts the counts back, and fails loudly if it could not. Seed data only (npm run db:seed): Alliance has 339 learners (419 with Kijani Ridge's 80).
 * Desktop only: the People table is read at desktop width.
 *
 * Known defects use test.fail(): they pass while the defect exists and fail the day it is fixed. Then remove test.fail().
 * In serial mode a later test does not run if an earlier one failed, so a KNOWN test that builds on an earlier test only ever runs
 * once that earlier test has passed.
 */
test.describe.configure({ mode: "serial", timeout: 120_000 });
test.skip(({ isMobile }) => isMobile, "the People table is read at desktop width");

const PASSWORD = "figbloom-dev";
const table: string[][] = [["Screen", "Figure", "Database", "Screen shows"]];
let tenantId = "";
let baseline = 0;
const classId: Record<string, string> = {};

const activeCount = async () => (await db.from("students").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("active", true)).count ?? 0;
const learner = async (admissionNo: string) => (await db.from("students").select("id, full_name, gender, boarding, class_id, active, archived_at, date_of_birth, profile_id").eq("tenant_id", tenantId).eq("admission_no", admissionNo).maybeSingle()).data;

async function removeProbes() {
  for (let i = 0; i < 40; i++) {
    const { data } = await db.from("students").select("id").eq("tenant_id", tenantId).like("admission_no", "QA11-E-%").limit(100); // 100 ids: a longer list makes the request URL too long
    if (!data?.length) return null;
    const ids = data.map((s) => s.id as string);
    // a learner with a health record cannot be deleted (FIG-1467): clear the records first
    const health = await db.from("student_health").delete().in("student_id", ids);
    if (health.error) return health.error.message;
    const { error } = await db.from("students").delete().in("id", ids);
    if (error) return error.message;
  }
  return "more than 4,000 left";
}

test.beforeAll(async () => {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.SUPABASE_URL ?? "")) throw new Error("local Supabase only");
  await db.from("login_lookups").delete().gte("looked_up_at", "1970-01-01"); // same reason as flows.spec.ts
  tenantId = (await db.from("tenants").select("id").eq("slug", "alliance").single()).data!.id as string;
  for (const c of (await db.from("classes").select("id, name").eq("tenant_id", tenantId)).data ?? []) classId[c.name as string] = c.id as string;
  await removeProbes();
  await db.from("classes").delete().eq("tenant_id", tenantId).eq("name", "QA11 Promo");
  baseline = await activeCount();
  expect(baseline, "seed data only: Alliance has 339 learners").toBe(339);
});

test.afterAll(async () => {
  const errors: string[] = [];
  const left = await removeProbes();
  if (left) errors.push(`learners: ${left}`);
  const cls = await db.from("classes").delete().eq("tenant_id", tenantId).eq("name", "QA11 Promo");
  if (cls.error) errors.push(`class: ${cls.error.message}`);
  const stray = await db.from("profiles").select("id, login_id").eq("tenant_id", tenantId).eq("full_name", "QA11E Login One");
  for (const p of stray.data ?? []) { await db.from("profiles").delete().eq("id", p.id as string); await db.auth.admin.deleteUser(p.id as string); }
  const now = await activeCount();
  if (now !== baseline) errors.push(`Alliance has ${now} active learners, not ${baseline}`);
  const widths = table[0]!.map((_, c) => Math.max(...table.map((r) => r[c]!.length)));
  console.log("\n" + table.map((r) => "| " + r.map((cell, c) => cell.padEnd(widths[c]!)).join(" | ") + " |").join("\n"));
  if (errors.length) throw new Error(`cleanup failed, run the file again to sweep: ${errors.join("; ")}`);
});

// ---------------------------------------------------------------- the screen side
async function textLines(page: Page): Promise<string[]> {
  await page.waitForLoadState("networkidle");
  return (await page.locator("body").innerText()).split("\n").map((l) => l.trim()).filter(Boolean);
}
function after(lines: string[], label: string, n: number): string[] {
  const i = lines.findIndex((l) => l.toLowerCase() === label.toLowerCase());
  expect(i, `"${label}" is on the screen`).toBeGreaterThanOrEqual(0);
  return lines.slice(i + 1, i + 1 + n);
}
async function signInAdmin(page: Page) {
  await page.goto("/signin");
  await page.getByRole("button", { name: "Admin portal" }).click();
  await page.getByRole("button", { name: "Sign in with email instead" }).click();
  await page.getByLabel("Email").fill("principal@alliance.sc.ke");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 15000 });
}
async function openPeople(page: Page) {
  await signInAdmin(page);
  await page.goto("/s/alliance/admin/people");
  await expect(page.getByText(/^[\d,]+ total$/)).toBeVisible({ timeout: 30000 });
}
const search = async (page: Page, q: string) => { await page.getByLabel("Search people").fill(q); await page.waitForTimeout(400); };
const totalShown = async (page: Page) => Number((await page.getByText(/^[\d,]+ total$/).innerText()).replace(/[^\d]/g, ""));
async function addLearnerForm(page: Page, f: { no: string; name: string; gender?: "Female" | "Male"; cls?: string; dob?: string }) {
  await page.getByRole("button", { name: "Add a learner" }).click();
  await page.getByLabel("Admission number").fill(f.no);
  await page.getByLabel("Full name").fill(f.name);
  await page.getByLabel("Gender").selectOption({ label: f.gender ?? "Female" });
  await page.getByLabel("Class").last().selectOption({ label: f.cls ?? "Form 1 East" });
  if (f.dob) await page.getByLabel("Date of birth (optional)").fill(f.dob);
  await page.getByRole("button", { name: "Add learner", exact: true }).click();
}
const csvFile = (text: string) => ({ name: "learners.csv", mimeType: "text/csv", buffer: Buffer.from(text, "utf8") });
const CSV_HEADER = "admission_no,full_name,gender,class,boarding,date_of_birth";

// ================================================================ adding one learner
test.describe("Add a learner", () => {
  test("a new learner is saved with what was typed, and the list finds them by name", async ({ page }) => {
    await openPeople(page);
    await addLearnerForm(page, { no: "QA11-E-A1", name: "QA11E Added One", gender: "Female", cls: "Form 2 West" });
    await expect(page.getByText("QA11E Added One added.")).toBeVisible();
    const row = await learner("QA11-E-A1");
    expect(row).toMatchObject({ full_name: "QA11E Added One", gender: "female", boarding: false, active: true, class_id: classId["Form 2 West"] });
    await search(page, "qa11e added");
    await expect(page.getByText("ADM QA11-E-A1")).toBeVisible();
  });

  test("the same admission number again is refused in words, before anything is sent", async ({ page }) => {
    await openPeople(page);
    await addLearnerForm(page, { no: "QA11-E-A1", name: "QA11E Added Twice" });
    await expect(page.getByText("Admission QA11-E-A1 is already on the roster.")).toBeVisible();
    expect(await learner("QA11-E-A1")).not.toBeNull();
    expect((await db.from("students").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("full_name", "QA11E Added Twice")).count).toBe(0);
  });

  test("a required field left empty is named", async ({ page }) => {
    await openPeople(page);
    await page.getByRole("button", { name: "Add a learner" }).click();
    await page.getByRole("button", { name: "Add learner", exact: true }).click();
    await expect(page.getByText("Admission number, name, gender and class are all required.")).toBeVisible();
  });

  test("KNOWN QA11-IMPORT-ERROR FIG-1422 (open): when the database refuses a learner (a number that belongs to an archived learner), the message says why", async ({ page }) => {
    test.fail();
    await db.from("students").insert({ tenant_id: tenantId, admission_no: "QA11-E-AR1", full_name: "QA11E Archived Earlier", class_id: classId["Form 1 East"], boarding: false, active: false, gender: "male" });
    await openPeople(page);
    await addLearnerForm(page, { no: "QA11-E-AR1", name: "QA11E Reuses The Number" });
    const toastText = await page.getByText(/Could not add the learner|already|duplicate|taken|in use/i).first().innerText({ timeout: 8000 });
    table.push(["Add a learner", "message when the database refuses (archived number)", "says why", toastText]);
    expect(toastText).toMatch(/already|taken|in use|exists|duplicate|archived/i);
  });

  test("KNOWN QA11-DOB FIG-1421 (open): a date of birth in the future is refused", async ({ page }) => {
    test.fail();
    try {
      await openPeople(page);
      await addLearnerForm(page, { no: "QA11-E-FUT", name: "QA11E Born In 2090", dob: "2090-01-01" });
      await page.waitForTimeout(2500);
      expect(await learner("QA11-E-FUT"), "the learner was saved with a date of birth in 2090").toBeNull();
    } finally {
      await db.from("students").delete().eq("tenant_id", tenantId).eq("admission_no", "QA11-E-FUT"); // the defect lets it in; keep the counts true
    }
  });
});

// ================================================================ the CSV upload
test.describe("Import from CSV", () => {
  const FILE = [
    "﻿" + CSV_HEADER,
    'QA11-E-C1,"QA11E Kamau, Wanjiku",female,Form 1 East,yes,2011-03-14',
    "",
    "QA11-E-C2,QA11E Otieno Odhiambo,male,Form 2 West,no,",
    "QA11-E-C3,QA11E Wrong Class,male,Form 9 North,no,",
    "QA11-E-C1,QA11E Twice,male,Form 1 East,no,",
    "QA11-E-C4,QA11E Good Four,female,Form 1 East,no,2012-02-02",
  ].join("\r\n") + "\r\n";

  test("a file with a byte-order mark, CRLF line endings, a blank line and a quoted comma: the screen says what is ready and what needs fixing, then saves exactly the ready rows", async ({ page }) => {
    await openPeople(page);
    await page.getByRole("button", { name: "Import from CSV" }).click();
    await page.locator('input[aria-label="CSV file"]').setInputFiles(csvFile(FILE));
    await expect(page.getByText(/3 of 5 rows ready to import/)).toBeVisible();
    const summary = await page.getByText(/rows ready to import/).innerText();
    table.push(["Import", "summary line", "3 of 5 ready, 1 male, 2 female, 2 need fixing", summary]);
    expect(summary).toContain("3 of 5 rows ready to import — 1 male, 2 female");
    expect(summary).toContain("2 need fixing");
    await expect(page.getByText('"Form 9 North" is not one of this school\'s classes.')).toBeVisible();
    await expect(page.getByText("Admission QA11-E-C1 appears twice in this file.")).toBeVisible();
    await page.getByRole("button", { name: "Import 3 learners" }).click();
    await expect(page.getByText("Imported 3 learners.")).toBeVisible();

    expect(await learner("QA11-E-C1")).toMatchObject({ full_name: "QA11E Kamau, Wanjiku", gender: "female", boarding: true, class_id: classId["Form 1 East"], date_of_birth: "2011-03-14" });
    expect(await learner("QA11-E-C2")).toMatchObject({ class_id: classId["Form 2 West"], boarding: false, date_of_birth: null });
    expect(await learner("QA11-E-C4")).toMatchObject({ full_name: "QA11E Good Four" });
    expect(await learner("QA11-E-C3"), "the row with the unknown class is not saved").toBeNull();
    expect(await activeCount()).toBe(baseline + 1 + 3);
  });

  test("uploading the same file again: every row is flagged, the button is off, and nobody is added", async ({ page }) => {
    await openPeople(page);
    await page.getByRole("button", { name: "Import from CSV" }).click();
    await page.locator('input[aria-label="CSV file"]').setInputFiles(csvFile(FILE));
    await expect(page.getByText(/0 of 5 rows ready to import/)).toBeVisible();
    await expect(page.getByText("Admission QA11-E-C1 is already on the roster.").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^Import\s*learners?$/ })).toBeDisabled();
    expect(await activeCount()).toBe(baseline + 1 + 3);
  });

  test("KNOWN QA11-LINES FIG-1423 (open): a row's error is shown against its line in the file, even with blank lines above it", async ({ page }) => {
    test.fail();
    await openPeople(page);
    await page.getByRole("button", { name: "Import from CSV" }).click();
    await page.locator('input[aria-label="CSV file"]').setInputFiles(csvFile([CSV_HEADER, "", "", "QA11-E-L1,QA11E Wrong Class Again,male,Form 9 North,no,"].join("\r\n")));
    await expect(page.getByText(/0 of 1 row ready to import/)).toBeVisible();
    table.push(["Import", "line label of a row on line 4 of the file", "L4", (await page.getByText(/^L\d+$/).first().innerText())]);
    await expect(page.getByText("L4", { exact: true })).toBeVisible({ timeout: 3000 });
  });
});

// ================================================================ the buttons on a selection
test.describe("a selection of learners", () => {
  async function select(page: Page) {
    await openPeople(page);
    await search(page, "qa11e");
    await page.getByLabel("Select all shown").check();
    await expect(page.getByText(/^\d+ selected$/)).toBeVisible();
  }

  test("KNOWN QA11-STUBS FIG-1417 (open): 'Change class' does what its message says", async ({ page }) => {
    test.fail();
    await select(page);
    const before = await db.from("students").select("id, class_id").eq("tenant_id", tenantId).like("admission_no", "QA11-E-%");
    await page.getByRole("button", { name: "Change class" }).click();
    await page.waitForTimeout(800);
    const claimed = await page.getByText(/Moved \d+ learners to another class/).count();
    const after = await db.from("students").select("id, class_id").eq("tenant_id", tenantId).like("admission_no", "QA11-E-%");
    const moved = JSON.stringify(after.data?.sort((a, b) => (a.id as string).localeCompare(b.id as string))) !== JSON.stringify(before.data?.sort((a, b) => (a.id as string).localeCompare(b.id as string)));
    table.push(["Change class", "toast says moved / learners actually moved", "both or neither", `${claimed ? "toast shown" : "no toast"} / ${moved ? "moved" : "nobody moved"}`]);
    expect(claimed === 0 || moved, "the screen said the learners were moved and nobody was").toBe(true);
  });

  test("KNOWN QA11-STUBS FIG-1417 (open): 'Export' produces what its message says", async ({ page }) => {
    test.fail();
    await select(page);
    const download = page.waitForEvent("download", { timeout: 3000 }).catch(() => null);
    await page.getByRole("button", { name: "Export" }).click();
    await page.waitForTimeout(800);
    const claimed = await page.getByText(/Exported \d+ records/).count();
    const file = await download;
    table.push(["Export", "toast says exported / a file was downloaded", "both or neither", `${claimed ? "toast shown" : "no toast"} / ${file ? "file" : "no file"}`]);
    expect(claimed === 0 || file !== null, "the screen said the records were exported and no file came").toBe(true);
  });

  test("archive, then find them under Archived, then restore: the screen's words and the database agree", async ({ page }) => {
    await openPeople(page);
    await search(page, "qa11e good four");
    await page.locator('input[type="checkbox"]').nth(1).check();
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await confirmDialog(page, "Archive");
    await expect(page.getByText(/1 learner archived\. Find them under "Archived"\./)).toBeVisible();
    expect(await learner("QA11-E-C4")).toMatchObject({ active: false });
    expect((await learner("QA11-E-C4"))!.archived_at).not.toBeNull();
    expect(await activeCount()).toBe(baseline + 1 + 2);

    await page.getByRole("button", { name: "archived", exact: true }).click();
    await search(page, "qa11e good four");
    await expect(page.getByText("ADM QA11-E-C4")).toBeVisible();
    await page.locator('input[type="checkbox"]').nth(1).check();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.getByText(/1 learner restored\./)).toBeVisible();
    expect(await learner("QA11-E-C4")).toMatchObject({ active: true, archived_at: null });
    expect(await activeCount()).toBe(baseline + 1 + 3);
  });

  test("KNOWN QA11-SEARCH FIG-1424 (open): the search finds a learner by admission number when it has letters in it", async ({ page }) => {
    test.fail();
    await openPeople(page);
    await search(page, "QA11-E-C2");
    await expect(page.getByText("ADM QA11-E-C2"), "the learner exists; the search lowercases what is typed but not the admission number").toBeVisible({ timeout: 3000 });
  });
});

// ================================================================ promoting a class
test.describe("Promote", () => {
  test("each learner goes where the admin chose: up, repeat, graduate, leave; and the school's roll follows", async ({ page }) => {
    const cls = await db.from("classes").insert({ tenant_id: tenantId, name: "QA11 Promo", form_level: 1, level: "secondary", stream: null }).select("id").single();
    expect(cls.error).toBeNull();
    const rows = ["P1", "P2", "P3", "P4"].map((p, i) => ({ tenant_id: tenantId, admission_no: `QA11-E-${p}`, full_name: `QA11E Promo ${["One", "Two", "Three", "Four"][i]}`, class_id: cls.data!.id, boarding: false, active: true, gender: i % 2 ? "male" : "female" }));
    expect((await db.from("students").insert(rows)).error).toBeNull();

    await signInAdmin(page);
    await page.goto("/s/alliance/admin/classes");
    const row = page.getByText("QA11 Promo", { exact: true }).locator("xpath=ancestor::div[.//button[normalize-space()='Promote']][1]");
    await row.getByRole("button", { name: "Promote" }).click();
    await expect(page.getByText("Promote · QA11 Promo")).toBeVisible();
    await page.getByLabel("Where QA11E Promo One goes next").selectOption({ label: "Form 2 West" });
    await page.getByLabel("Where QA11E Promo Two goes next").selectOption({ label: "Repeat — stays in QA11 Promo" });
    await page.getByLabel("Where QA11E Promo Three goes next").selectOption({ label: "Graduating — completed QA11 Promo" });
    await page.getByLabel("Where QA11E Promo Four goes next").selectOption({ label: "Leaving — withdrawn from school" });
    await expect(page.getByText(/^1\s*promoted$/)).toBeVisible();
    await page.locator("footer").getByRole("button", { name: "Apply" }).click(); // the other Apply, in the bulk bar, sets a pass mark
    await confirmDialog(page, "Apply");
    await expect(page.getByText("QA11 Promo: 4 learners processed and notified.")).toBeVisible();

    expect(await learner("QA11-E-P1")).toMatchObject({ class_id: classId["Form 2 West"], active: true });
    expect(await learner("QA11-E-P2")).toMatchObject({ class_id: cls.data!.id, active: true });
    expect(await learner("QA11-E-P3")).toMatchObject({ active: false });
    expect(await learner("QA11-E-P4")).toMatchObject({ active: false });
  });

  test("KNOWN QA11-PROMOTE FIG-1420 (open): learners who graduate or leave are archived the way Archive does it: stamped with when and by whom, and logged", async ({ page }) => {
    test.fail();
    const p3 = (await learner("QA11-E-P3"))!;
    const log = await db.from("audit_events").select("id").eq("tenant_id", tenantId).contains("metadata", { student_ids: [p3.id] });
    table.push(["Promote", "archived_at of a graduating learner / audit events naming them", "set / at least one", `${p3.archived_at ?? "empty"} / ${log.data?.length ?? 0}`]);
    expect(p3.archived_at, "the learner was taken off the roll without a stamp").not.toBeNull();
    expect(log.data?.length ?? 0).toBeGreaterThan(0);
    void page;
  });
});

// ================================================================ a school with more than 1,000 learners
test.describe("a school with more than 1,000 learners", () => {
  let active = 0;
  test("set up: 1,101 more learners (the last one sorts after every other name)", async () => {
    const make = (n: number) => ({ tenant_id: tenantId, admission_no: `QA11-E-K${String(n).padStart(4, "0")}`, full_name: `QA11E Cap ${String(n).padStart(4, "0")}`, class_id: classId["Form 1 East"], boarding: false, active: true, gender: n % 2 ? "male" : "female" });
    const all = Array.from({ length: 1100 }, (_, i) => make(i + 1));
    all.push({ ...make(1101), admission_no: "QA11-E-KLAST", full_name: "ZZZ QA11E Last Learner" });
    for (let i = 0; i < all.length; i += 300) expect((await db.from("students").insert(all.slice(i, i + 300))).error).toBeNull();
    active = await activeCount();
    expect(active, "Alliance now has well over 1,000 active learners").toBeGreaterThan(1400);
  });

  test("QA11-CAP FIG-1416: People lists every learner of the school, and can find the last one by name", async ({ page }) => {
    await openPeople(page);
    const shown = await totalShown(page);
    table.push(["People", "learners in the school / total shown", String(active), String(shown)]);
    await search(page, "zzz qa11e last");
    const found = await page.getByText("ADM QA11-E-KLAST").count();
    table.push(["People", "search for the last learner by name", "found", found ? "found" : "not found"]);
    expect(shown, "People shows every learner, not the first 1,000").toBe(active);
    expect(found).toBe(1);
  });

  test("QA11-CAP FIG-1416: the Dashboard's Learners card counts every learner of the school", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/s/alliance/admin");
    await expect(page.getByText(/classes submitted/).first()).toBeVisible({ timeout: 30000 });
    const card = after(await textLines(page), "Learners", 1);
    table.push(["Dashboard", "Learners card", active.toLocaleString(), card[0] ?? "(missing)"]);
    expect(card[0]).toBe(active.toLocaleString());
  });

  test("clean up: the extra learners are removed and Alliance is back to its seed size", async () => {
    expect(await removeProbes()).toBeNull();
    expect(await activeCount()).toBe(baseline);
  });
});

// ================================================================ deleting a learner who has a login
test.describe("deleting a learner who was added by mistake and has a login", () => {
  test("QA11-LOGIN FIG-1419 (fixed): the login goes with the learner", async () => {
    const made = await db.from("students").insert({ tenant_id: tenantId, admission_no: "QA11-E-LG1", full_name: "QA11E Login One", class_id: classId["Form 1 East"], boarding: false, active: true, gender: "female" }).select("id").single();
    expect(made.error).toBeNull();
    const url = process.env.SUPABASE_URL!;
    const anon = createClient(url, process.env.VITE_SUPABASE_ANON_KEY!);
    expect((await anon.auth.signInWithPassword({ email: "principal@alliance.sc.ke", password: PASSWORD })).error).toBeNull();
    const provisioned = await anon.functions.invoke("provision-student", { body: { tenant_id: tenantId, student_id: made.data!.id } });
    expect(provisioned.error, "the school admin creates the learner's login").toBeNull();
    const { login_id, password } = provisioned.data as { login_id: string; password: string };

    // The People screen's Delete: the learner has no records, so the database allows it.
    const del = await anon.from("students").delete().eq("id", made.data!.id).select("id");
    expect(del.error).toBeNull();
    expect(del.data).toHaveLength(1);

    const profile = await db.from("profiles").select("id").eq("login_id", login_id).eq("tenant_id", tenantId);
    const signIn = await createClient(url, process.env.VITE_SUPABASE_ANON_KEY!).auth.signInWithPassword({ email: loginIdEmail(login_id, "alliance"), password });
    table.push(["Delete a learner", `login ${login_id}: profile left / can still sign in`, "gone / no", `${profile.data?.length ? "left" : "gone"} / ${signIn.error ? "no" : "yes"}`]);
    expect(profile.data, "the learner is deleted but their account is still there").toHaveLength(0);
    expect(signIn.error, "and it still signs in").not.toBeNull();
  });
});
