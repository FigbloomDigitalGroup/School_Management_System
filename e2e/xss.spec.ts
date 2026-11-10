import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.loadEnvFile?.(); // Node 20.6+ built-in
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

/**
 * QA 14 (FIG-1247), cross-site scripting: a hostile string is put into every kind of text a person can type (a learner's name, a
 * teacher's and a parent's name, the school's name, a class, a subject, a fee item, an announcement, homework, an incident, an
 * organization, and a CSV import cell) and every screen that shows it is opened as each role. A screen is only safe if the string
 * is shown as plain text: no script runs, no dialog opens, no element it contains ends up in the page.
 *
 * The string closes an attribute and a tag, then opens an image with an onerror handler, an svg with an onload handler and a script
 * element, each of which sets window.__xss. So three things are checked on every screen:
 *   - window.__xss is still unset and no alert dialog opened (nothing ran),
 *   - the page holds no <img src="x"> and no element with an onerror/onload attribute (nothing was injected),
 *   - the text does appear on at least one screen for every planted value (so the test is not passing because nothing was shown).
 *
 * Everything planted is put back in afterAll (the values are written back from a copy taken first; rows made here are deleted).
 * Desktop only. The phone apps are React Native, which has no HTML to inject into; they are covered by the code search in
 * tests/security/repoConfig.test.ts (no WebView, no HTML sink).
 */

const PASSWORD = "figbloom-dev";
const hostile = (key: string) =>
  `QA14-${key} "><img src=x onerror="window.__xss=1;alert('${key}')"><svg onload="window.__xss=1"></svg><script>window.__xss=1</script>`;
const markerOf = (key: string) => `QA14-${key}`;

test.describe.configure({ mode: "serial", timeout: 120_000 });
test.skip(({ isMobile }) => isMobile, "the office screens are read at desktop width");

interface Plant { key: string; table: string; column: string; id: string; original: string }
const planted: Plant[] = [];
const seen = new Map<string, string[]>(); // marker -> the screens that showed it
const problems: string[] = [];
let tenantId = "";
let importedAdmission = "";
let incidentId = "";

async function plant(key: string, table: string, column: string, id: string): Promise<void> {
  const before = await db.from(table).select(column).eq("id", id).single();
  expect(before.error, `${table}.${column} ${id} can be read`).toBeNull();
  const original = (before.data as unknown as Record<string, string>)[column]!;
  const r = await db.from(table).update({ [column]: hostile(key) }).eq("id", id);
  expect(r.error, `${table}.${column} can be written`).toBeNull();
  planted.push({ key, table, column, id, original });
}

test.beforeAll(async () => {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.SUPABASE_URL ?? "")) throw new Error("local Supabase only");
  await db.from("login_lookups").delete().gte("looked_up_at", "1970-01-01"); // same reason as flows.spec.ts
  tenantId = (await db.from("tenants").select("id").eq("slug", "alliance").single()).data!.id as string;

  const profile = async (loginId: string) => (await db.from("profiles").select("id, full_name").eq("tenant_id", tenantId).eq("login_id", loginId).single()).data!;
  const teacher = await profile("TC-0002");
  const parent = await profile("PT-0002");
  const studentUser = await profile("ST-0002");
  const myRecord = (await db.from("students").select("id").eq("profile_id", studentUser.id as string).single()).data!.id as string;
  const form2West = (await db.from("classes").select("id").eq("tenant_id", tenantId).eq("name", "Form 2 West").single()).data!.id as string;
  const classmate = (await db.from("students").select("id").eq("tenant_id", tenantId).eq("class_id", form2West).neq("id", myRecord).limit(1).single()).data!.id as string;
  const form4West = (await db.from("classes").select("id").eq("tenant_id", tenantId).eq("name", "Form 4 West").single()).data!.id as string;
  const subject = (await db.from("subjects").select("id").eq("tenant_id", tenantId).limit(1).single()).data!.id as string;
  const feeItem = (await db.from("fee_items").select("id").eq("tenant_id", tenantId).limit(1).single()).data!.id as string;
  const announcement = (await db.from("announcements").select("id").eq("tenant_id", tenantId).limit(1).single()).data!.id as string;
  const assignment = (await db.from("assignments").select("id").eq("tenant_id", tenantId).limit(1).single()).data!.id as string;
  const org = (await db.from("organizations").select("id").limit(1).single()).data!.id as string;

  // the school's name keeps "Alliance High School" at the front so the sign-in search still finds it
  const tenant = await db.from("tenants").select("name").eq("id", tenantId).single();
  const tenantOriginal = tenant.data!.name as string;
  const t = await db.from("tenants").update({ name: `${tenantOriginal} ${hostile("school")}` }).eq("id", tenantId);
  expect(t.error).toBeNull();
  planted.push({ key: "school", table: "tenants", column: "name", id: tenantId, original: tenantOriginal });

  await plant("student", "students", "full_name", myRecord);
  await plant("classmate", "students", "full_name", classmate);
  await plant("teacher", "profiles", "full_name", teacher.id as string);
  await plant("parent", "profiles", "full_name", parent.id as string);
  await plant("class", "classes", "name", form4West);
  await plant("subject", "subjects", "name", subject);
  await plant("fee", "fee_items", "name", feeItem);
  await plant("announceSubject", "announcements", "subject", announcement);
  await plant("announceBody", "announcements", "body", announcement);
  await plant("homeworkTitle", "assignments", "title", assignment);
  await plant("homeworkBody", "assignments", "body", assignment);
  await plant("org", "organizations", "name", org);

  const inc = await db.from("platform_incidents").insert({ severity: "SEV-3", title: hostile("incident"), summary: hostile("incidentSummary"), affected_schools: 1, status: "investigating" }).select("id").single();
  expect(inc.error).toBeNull();
  incidentId = inc.data!.id as string;
});

test.afterAll(async () => {
  const errors: string[] = [];
  for (const p of [...planted].reverse()) {
    const r = await db.from(p.table).update({ [p.column]: p.original }).eq("id", p.id);
    if (r.error) errors.push(`${p.table}.${p.column}: ${r.error.message}`);
  }
  if (incidentId) { const r = await db.from("platform_incidents").delete().eq("id", incidentId); if (r.error) errors.push(`incident: ${r.error.message}`); }
  if (importedAdmission) { const r = await db.from("students").delete().eq("tenant_id", tenantId).eq("admission_no", importedAdmission); if (r.error) errors.push(`imported learner: ${r.error.message}`); }
  const left = (await db.from("students").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).like("full_name", "QA14-%")).count;
  if (left) errors.push(`${left} learners still carry a QA14 name`);
  console.log("\nplanted value -> screens that showed it as text\n" + [...seen.entries()].map(([k, v]) => `  ${k.padEnd(16)} ${v.length}: ${v.slice(0, 4).join(", ")}${v.length > 4 ? ", ..." : ""}`).join("\n"));
  if (errors.length) throw new Error(`cleanup failed, run the file again to sweep: ${errors.join("; ")}`);
});

// ---------------------------------------------------------------- helpers
async function signInWithId(page: Page, school: string, loginId: string, portal: "Teacher" | "Student" | "Parent") {
  await page.goto("/signin");
  await page.getByRole("button", { name: `${portal} portal` }).click();
  await page.getByLabel("School").fill(school);
  await page.getByRole("button").filter({ hasText: school }).first().click();
  await page.getByLabel("Your ID").fill(loginId);
  await page.getByLabel("Your ID").blur();
  await expect(page.getByText(/^Signing in as /)).toBeVisible({ timeout: 10000 });
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 15000 });
}
async function signInEmail(page: Page, email: string) {
  await page.goto("/signin");
  await page.getByRole("button", { name: "Admin portal" }).click();
  await page.getByRole("button", { name: "Sign in with email instead" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 15000 });
}

/** Watches one page for anything that would mean a hostile string ran, and returns a function that reads the verdict. */
function watch(page: Page) {
  const dialogs: string[] = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
  return async (where: string) => {
    const state = await page.evaluate(() => ({
      ran: (window as unknown as { __xss?: number }).__xss ?? 0,
      images: document.querySelectorAll('img[src="x"]').length,
      handlers: document.querySelectorAll("[onerror],[onload]").length,
      injectedScripts: Array.from(document.scripts).filter((s) => s.textContent?.includes("__xss")).length,
      text: document.body.innerText,
    }));
    if (state.ran || dialogs.length) problems.push(`${where}: a script ran (window.__xss=${state.ran}, dialogs: ${dialogs.join("|") || "none"})`);
    if (state.images || state.handlers || state.injectedScripts) problems.push(`${where}: an element from the string is in the page (${state.images} img, ${state.handlers} with onerror/onload, ${state.injectedScripts} script)`);
    for (const key of [...planted.map((p) => p.key), "incident", "incidentSummary", "csvCell"]) {
      if (state.text.includes(markerOf(key)) || state.text.includes(markerOf(key).toUpperCase())) {
        const list = seen.get(key) ?? [];
        if (!list.includes(where)) list.push(where);
        seen.set(key, list);
      }
    }
    return state.text;
  };
}

async function visit(page: Page, check: (where: string) => Promise<string>, as: string, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  return check(`${as} ${path}`);
}

// ---------------------------------------------------------------- the screens
const ADMIN_SCREENS = [
  "/s/alliance/admin", "/s/alliance/admin/people", "/s/alliance/admin/classes", "/s/alliance/admin/subjects", "/s/alliance/admin/fees",
  "/s/alliance/admin/announcements", "/s/alliance/admin/reports", "/s/alliance/admin/performance", "/s/alliance/admin/settings",
  "/s/alliance/admin/exams", "/s/alliance/admin/report-cards", "/s/alliance/admin/account",
];
const TEACHER_SCREENS = [
  "/s/alliance/teacher/attendance", "/s/alliance/teacher/gradebook", "/s/alliance/teacher/classes", "/s/alliance/teacher/timetable",
  "/s/alliance/teacher/homework", "/s/alliance/teacher/notices", "/s/alliance/teacher/account", "/s/alliance/teacher/sections",
];
const PARENT_SCREENS = [
  "/s/alliance/parent", "/s/alliance/parent/fees", "/s/alliance/parent/results", "/s/alliance/parent/homework", "/s/alliance/parent/inbox", "/s/alliance/parent/settings",
];
const STUDENT_SCREENS = ["/s/alliance/student", "/s/alliance/student/timetable", "/s/alliance/student/work", "/s/alliance/student/results"];
const PLATFORM_SCREENS = [
  "/platform/tenants", "/platform/organizations", "/platform/incidents", "/platform/audit", "/platform/usage", "/platform/subscriptions",
];

test("the school admin's screens show every hostile string as text and run none of them", async ({ page }) => {
  const check = watch(page);
  await signInEmail(page, "principal@alliance.sc.ke");
  for (const path of ADMIN_SCREENS) await visit(page, check, "admin", path);
  // People lists 50 learners a page in name order, so the two planted learners are found by searching for them
  await page.goto("/s/alliance/admin/people");
  await expect(page.getByText(/^[\d,]+ total$/)).toBeVisible({ timeout: 30000 });
  await page.getByLabel("Search people").fill("QA14-");
  await page.waitForTimeout(800);
  await check("admin /s/alliance/admin/people (searched)");
  expect(problems).toEqual([]);
});

test("the teacher's screens show every hostile string as text and run none of them", async ({ page }) => {
  const check = watch(page);
  await signInWithId(page, "Alliance High School", "TC-0002", "Teacher");
  for (const path of TEACHER_SCREENS) await visit(page, check, "teacher", path);
  expect(problems).toEqual([]);
});

test("the parent's screens show every hostile string as text and run none of them", async ({ page }) => {
  const check = watch(page);
  await signInWithId(page, "Alliance High School", "PT-0002", "Parent");
  for (const path of PARENT_SCREENS) await visit(page, check, "parent", path);
  expect(problems).toEqual([]);
});

test("the student's screens show every hostile string as text and run none of them", async ({ page }) => {
  const check = watch(page);
  await signInWithId(page, "Alliance High School", "ST-0002", "Student");
  for (const path of STUDENT_SCREENS) await visit(page, check, "student", path);
  expect(problems).toEqual([]);
});

test("the platform console shows every hostile string as text and runs none of them", async ({ page }) => {
  const check = watch(page);
  await signInEmail(page, "joyce@figbloom.co.ke");
  for (const path of PLATFORM_SCREENS) await visit(page, check, "platform", path);
  await visit(page, check, "platform", "/platform/tenants");
  await page.getByText("Alliance High School", { exact: false }).first().click(); // the school's own page has no address of its own
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await check("platform school detail");
  expect(problems).toEqual([]);
});

test("the sign-in school search lists a school whose name holds the string, as text, and runs none of it", async ({ page }) => {
  const check = watch(page);
  await page.goto("/signin");
  await page.getByRole("button", { name: "Teacher portal" }).click();
  await page.getByLabel("School").fill("Alliance High School");
  await expect(page.getByRole("button").filter({ hasText: "Alliance High School" }).first()).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(800);
  await check("signed out /signin school search");
  expect(problems).toEqual([]);
});

test("a CSV cell holding the string is imported as typed, shown as text and run as nothing", async ({ page }) => {
  const check = watch(page);
  importedAdmission = "QA14-IMP-1";
  const file = join(mkdtempSync(join(tmpdir(), "qa14-")), "learners.csv");
  const name = hostile("csvCell").replace(/"/g, '""'); // a quote inside a quoted cell is doubled
  writeFileSync(file, `admission_no,full_name,gender,class,boarding,date_of_birth\r\n${importedAdmission},"${name}",female,Form 1 East,no,\r\n`);
  await signInEmail(page, "principal@alliance.sc.ke");
  await page.goto("/s/alliance/admin/people");
  await expect(page.getByText(/^[\d,]+ total$/)).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "Import from CSV" }).click();
  await page.locator('input[aria-label="CSV file"]').setInputFiles(file);
  await expect(page.getByText(/1 of 1 row ready to import/)).toBeVisible();
  const preview = await check("admin people, CSV preview");
  expect(preview, "the preview shows the cell as text").toContain(markerOf("csvCell"));
  await page.getByRole("button", { name: /^Import 1 learner/ }).click();
  await expect(page.getByText(/Imported 1 learner/)).toBeVisible();
  const stored = (await db.from("students").select("full_name").eq("tenant_id", tenantId).eq("admission_no", importedAdmission).single()).data!.full_name as string;
  expect(stored, "the import keeps the cell exactly as typed (escaping is the screen's job)").toBe(hostile("csvCell"));
  await page.getByLabel("Search people").fill(markerOf("csvCell")); // by name: a search by an admission number with letters finds nothing (FIG-1424)
  await page.waitForTimeout(800);
  const after = await check("admin people, after the import");
  expect(after).toContain(markerOf("csvCell"));
  rmSync(file, { force: true });
  expect(problems).toEqual([]);
});

test("every planted value was shown as text on at least one screen, so the checks above looked at something", async () => {
  const shownNowhere = planted.map((p) => p.key).filter((k) => !seen.has(k));
  // announcement and homework bodies, the fee item and the organization appear on screens the lists above include; a value shown
  // nowhere means the screen list or the plant is wrong, and the test would be passing for no reason
  expect(shownNowhere, `values never seen on any screen (seen: ${[...seen.keys()].join(", ")})`).toEqual([]);
  expect(seen.has("incident")).toBe(true);
});
