import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { today as schoolToday } from "../packages/shared/src/attendance";
import { loginIdEmail } from "../packages/shared/src/auth";
import { attendanceFigures, countAttendance, type PercentageMode, type SessionEntry, type SignOutDay } from "../packages/shared/src/attendanceSession";

process.loadEnvFile?.(); // Node 20.6+ built-in
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

/**
 * FIG-1514: the morning and the afternoon register, in a real browser against the seeded local school (Alliance, Form 2 West, class
 * teacher TC-0002; Faith Achieng ADM 4102, parent PT-0002).
 *
 * Everything is done through the screens (settings panel, register, sign-out modal, void); the service client only reads to work out
 * the expected figures with the same counting rule (countAttendance), and removes today's registers and the settings row this spec
 * made. Expected figures come from the live rows, so the spec does not depend on the seed's exact marks.
 *
 * Sign-outs are never deleted: this run's carry a run id in the reason and end voided (by the UI in the void test, or by teardown through
 * void_early_sign_out() if the run stopped early). Voided sign-outs left by earlier runs are tolerated; a live one for Faith today stops
 * the spec before it starts. The AreasHome test gives the seeded "other staff" member the attendance area and takes it away afterwards.
 *
 * Local Supabase only. Desktop only. Serial: the steps share one class and one day. Leaves Alliance with no register today, no
 * attendance settings row and no live sign-out of its own, as the other specs expect.
 */
test.describe.configure({ mode: "serial" });

// Sign-outs are never deleted (they are the school's record, with audit events written by the functions that made them). Each run tags
// its own with a run id, so it counts only what it made, and voids what it made through the product's own void function. Not "e2e…":
// earlySignOut.spec.ts counts its own rows by that prefix.
const RUN = Date.now().toString(36);
const REASON = `FIG-1514 e2e clinic ${RUN}`;
const VOID_REASON = "FIG-1514 e2e void";
const SECTION_PM = "Present in the morning, missing in the afternoon";

async function waitForSignedIn(page: Page) {
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 15000 });
}
async function signInWithId(page: Page, loginId: string, portal: "Teacher" | "Parent" | "Other staff") {
  await page.goto("/signin");
  await page.getByRole("button", { name: `${portal} portal` }).click();
  await page.getByLabel("School").fill("Alliance High School");
  await page.getByRole("button").filter({ hasText: "Alliance High School" }).first().click();
  await page.getByLabel("Your ID").fill(loginId);
  await page.getByLabel("Your ID").blur();
  await expect(page.getByText(/^Signing in as /)).toBeVisible({ timeout: 5000 });
  await page.getByLabel("Password").fill("figbloom-dev");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await waitForSignedIn(page);
}
async function signInAdmin(page: Page) {
  await page.goto("/signin");
  await page.getByRole("button", { name: "Admin portal" }).click();
  await page.getByRole("button", { name: "Sign in with email instead" }).click();
  await page.getByLabel("Email").fill("principal@alliance.sc.ke");
  await page.getByLabel("Password").fill("figbloom-dev");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await waitForSignedIn(page);
}

/** The teacher's register for Form 2 West, on the given session when the school takes an afternoon register. */
async function teacherRegister(page: Page, session?: "Morning" | "Afternoon") {
  await signInWithId(page, "TC-0002", "Teacher");
  await page.goto("/s/alliance/teacher/attendance");
  await expect(page.getByText(/Everyone starts present|register is in/).first()).toBeVisible({ timeout: 25000 });
  const cls = page.getByLabel("Class");
  if (await cls.count()) await cls.selectOption({ label: "Form 2 West" });
  if (session) {
    const btn = page.getByRole("group", { name: "Register" }).first().getByRole("button", { name: session, exact: true });
    await expect(btn).toBeVisible({ timeout: 15000 });
    if ((await btn.getAttribute("aria-pressed")) !== "true") await btn.click();
    await expect(btn).toHaveAttribute("aria-pressed", "true");
  }
}
/** Faith's line of the register roster: the list item holding her mark buttons (not a line of a sign-out list that also names her). */
const faithRow = (page: Page) => page.getByRole("listitem").filter({ has: page.getByRole("group", { name: "Mark for Faith Achieng" }) });
/**
 * Faith's register line in the "who wasn't here" detail. The dialog also lists the day's early sign-outs, voided ones included, and
 * those name her too; only the register line carries her admission number.
 */
const detailRegisterRow = (detail: Locator) => detail.getByRole("listitem").filter({ hasText: "Faith Achieng" }).filter({ hasText: "ADM 4102" });

/**
 * The "Attendance today" card once the dashboard has loaded. Its caption depends on the setting:
 * "N of M classes submitted" while the afternoon register is off, "N morning, P afternoon of M classes" while it is on.
 */
const CARD_OFF = /\d+ of \d+ classes submitted/;
const CARD_ON = /\d+ morning, \d+ afternoon of \d+ classes/;
async function adminDashboard(page: Page) {
  await signInAdmin(page);
  await page.goto("/s/alliance/admin");
  await expect(page.getByText(CARD_OFF).or(page.getByText(CARD_ON)).first()).toBeVisible({ timeout: 30000 });
}
/** The Form 2 West row of "Attendance by class" (the innermost element holding both its name and its figure). */
const classRow = (page: Page) => page.locator("div")
  .filter({ has: page.getByText("Form 2 West", { exact: true }) })
  .filter({ has: page.getByTitle("See who was late, absent or excused") }).last();
const pmReport = (page: Page) => page.getByRole("region", { name: SECTION_PM }).or(page.locator(`section[aria-label="${SECTION_PM}"]`)).first();

const settingsPanel = (page: Page) =>
  page.getByRole("region", { name: "Attendance settings" }).or(page.locator("section[aria-label='Attendance settings']")).first();
const isSettingsWrite = (r: { url(): string; request(): { method(): string } }) =>
  r.url().includes("/rest/v1/attendance_settings") && r.request().method() === "POST";

/**
 * Changes the settings in the panel and waits for THIS save: its own request must succeed and the database must hold the new values.
 * (Run 4: waiting for the "saved" toast alone passed on the previous save's toast, which stays up for 3.6 s, and read the row too early.)
 */
async function saveSettings(page: Page, change: { afternoon?: boolean; mode?: PercentageMode }) {
  const panel = settingsPanel(page);
  await expect(panel.getByRole("button", { name: "Save settings" })).toBeVisible({ timeout: 20000 });
  if (change.afternoon !== undefined) await panel.getByLabel("Take an afternoon register").setChecked(change.afternoon);
  if (change.mode) await panel.getByRole("radio", { name: change.mode === "day" ? /^By day/ : /^By session/ }).check();
  const response = page.waitForResponse(isSettingsWrite, { timeout: 15000 });
  await panel.getByRole("button", { name: "Save settings" }).click();
  expect((await response).ok(), "the settings write succeeded").toBe(true);
  await expect(page.getByText("Attendance settings saved.")).toBeVisible({ timeout: 15000 });
  // nothing left to save: the panel now shows what is stored
  await expect(panel.getByRole("button", { name: "Save settings" })).toBeDisabled();
  const row = await settingsRow();
  if (change.afternoon !== undefined) expect(row?.afternoon_enabled, "stored afternoon setting").toBe(change.afternoon);
  if (change.mode) expect(row?.percentage_mode, "stored percentage mode").toBe(change.mode);
}

// ---------------------------------------------------------------- the database side (read and clean only)
let tenantId = "";
let classId = "";
let faithId = "";
const day = () => schoolToday();

async function settingsRow() {
  const { data } = await db.from("attendance_settings").select("afternoon_enabled, percentage_mode").eq("tenant_id", tenantId).maybeSingle();
  return data as { afternoon_enabled: boolean; percentage_mode: PercentageMode } | null;
}
async function entries(f: { classId?: string; studentId?: string; on?: string }): Promise<SessionEntry[]> {
  const out: SessionEntry[] = [];
  for (const [table, session] of [["attendance", "morning"], ["attendance_afternoon", "afternoon"]] as const) {
    let q = db.from(table).select("student_id, taken_on, mark, class_id").eq("tenant_id", tenantId);
    if (f.classId) q = q.eq("class_id", f.classId);
    if (f.studentId) q = q.eq("student_id", f.studentId);
    if (f.on) q = q.eq("taken_on", f.on);
    const { data, error } = await q.range(0, 9999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) out.push({ ...(r as Omit<SessionEntry, "session">), session });
  }
  return out;
}
async function signOuts(f: { studentId?: string; on?: string }): Promise<SignOutDay[]> {
  let q = db.from("early_sign_outs").select("student_id, taken_on, voided_at").eq("tenant_id", tenantId);
  if (f.studentId) q = q.eq("student_id", f.studentId);
  if (f.on) q = q.eq("taken_on", f.on);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as SignOutDay[];
}
/** What the Dashboard must show for Form 2 West today: "here / total", counted like the screens count. */
async function expectedFigure(mode: PercentageMode) {
  const f = attendanceFigures(countAttendance(await entries({ classId, on: day() }), mode, await signOuts({ on: day() })));
  return `${f.here} / ${f.total}`;
}
/** This run's sign-outs only (the reason carries the run id). */
async function ourSignOuts() {
  const { data, error } = await db.from("early_sign_outs").select("id, voided_at").eq("student_id", faithId).eq("reason", REASON);
  if (error) throw new Error(error.message);
  return data ?? [];
}
/** Faith's sign-outs today that are still live, whoever made them: a live one excuses her afternoon absence and changes every figure. */
async function liveSignOutsToday() {
  const { data, error } = await db.from("early_sign_outs").select("id, reason").eq("student_id", faithId).eq("taken_on", day()).is("voided_at", null);
  if (error) throw new Error(error.message);
  return data ?? [];
}
/**
 * Voids this run's sign-outs that are still live (a run stopped between the sign-out and its void), through void_early_sign_out() as the
 * class teacher who recorded them: the record and its audit trail stay, exactly as a mistaken sign-out is corrected in the app.
 */
async function voidOurLiveSignOuts() {
  const live = (await ourSignOuts()).filter((r) => !r.voided_at);
  if (live.length === 0) return;
  const teacher = createClient(process.env.SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { error: e1 } = await teacher.auth.signInWithPassword({ email: loginIdEmail("TC-0002", "alliance"), password: "figbloom-dev" });
  if (e1) throw new Error(`sign in to void: ${e1.message}`);
  for (const r of live) {
    const { error } = await teacher.rpc("void_early_sign_out", { p_id: r.id, p_reason: `${VOID_REASON} (teardown)` });
    if (error) throw new Error(`void ${r.id}: ${error.message}`);
  }
  await teacher.auth.signOut();
}
/** Today's registers and the settings row: rows this spec makes through the screens, and that no other spec expects. */
async function cleanUp() {
  for (const t of ["attendance", "attendance_afternoon"]) {
    const { error } = await db.from(t).delete().eq("tenant_id", tenantId).eq("taken_on", day());
    if (error) throw new Error(`${t}: ${error.message}`);
  }
  const { error } = await db.from("attendance_settings").delete().eq("tenant_id", tenantId);
  if (error) throw new Error(`attendance_settings: ${error.message}`);
}

// The other staff member (Lucy Njeri, SF-0001, seeded with the visitors area) is given the attendance area for the AreasHome test, and
// it is taken away again afterwards, only if this run gave it.
let staffId = "";
let grantedArea = false;

// Desktop only (the "phone" project is a Pixel 5): the steps share one class and one day, so one browser is enough.
test.skip(({ isMobile }) => isMobile, "desktop only: the steps share one class and one day");

test.beforeAll(async () => {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.SUPABASE_URL ?? "")) throw new Error("local Supabase only");
  await db.from("login_lookups").delete().gte("looked_up_at", "1970-01-01");
  const { data: t } = await db.from("tenants").select("id").eq("slug", "alliance").single();
  tenantId = t!.id as string;
  const { data: c } = await db.from("classes").select("id").eq("tenant_id", tenantId).eq("name", "Form 2 West").single();
  classId = c!.id as string;
  const { data: s } = await db.from("students").select("id").eq("tenant_id", tenantId).eq("admission_no", "4102").single();
  faithId = s!.id as string;
  // a clean day: today's registers and the settings row (no other spec expects any)
  await cleanUp();
  expect(await settingsRow(), "Alliance starts with no attendance settings (the defaults)").toBeNull();
  // Voided sign-outs from earlier runs (this spec's or earlySignOut.spec.ts's) change nothing and are left alone. A LIVE one would
  // excuse Faith's afternoon absence, so every figure below would be wrong: stop and say so rather than delete someone's record.
  expect(await liveSignOutsToday(), "Faith has no live early sign-out today (void it in the app first)").toEqual([]);

  const { data: lucy } = await db.from("profiles").select("id").eq("tenant_id", tenantId).eq("login_id", "SF-0001").single();
  staffId = lucy!.id as string;
  const { data: held } = await db.from("staff_permissions").select("area").eq("profile_id", staffId).eq("area", "attendance");
  if (!held?.length) {
    const { error } = await db.from("staff_permissions").insert({ tenant_id: tenantId, profile_id: staffId, area: "attendance" });
    if (error) throw new Error(`grant the attendance area: ${error.message}`);
    grantedArea = true;
  }
});

test.afterAll(async () => {
  if (!tenantId) return;
  await voidOurLiveSignOuts();
  await cleanUp();
  if (grantedArea) await db.from("staff_permissions").delete().eq("profile_id", staffId).eq("area", "attendance");
});

test("afternoon off (the default): no session switch, no afternoon badges; the settings panel is on the admin dashboard (AC 3, 7)", async ({ browser }) => {
  const t = await (await browser.newContext()).newPage();
  await teacherRegister(t);
  await expect(t.getByText("Everyone starts present")).toBeVisible();
  await expect(t.getByRole("group", { name: "Register" })).toHaveCount(0);
  await t.screenshot({ path: "test-results/pm-1-teacher-off.png" });
  await t.close();

  const a = await (await browser.newContext()).newPage();
  await adminDashboard(a);
  await expect(a.getByRole("button", { name: "Save settings" })).toBeVisible({ timeout: 20000 });
  await expect(a.getByLabel("Take an afternoon register")).not.toBeChecked();
  await expect(a.getByText("Afternoon in")).toHaveCount(0);
  await expect(a.getByText("Afternoon not taken")).toHaveCount(0);
  await a.screenshot({ path: "test-results/pm-2-admin-off.png", fullPage: true });
  await a.close();
});

test("the admin turns the afternoon register on in the panel; the database has it (AC 7)", async ({ page }) => {
  await adminDashboard(page);
  await saveSettings(page, { afternoon: true });
  expect(await settingsRow()).toEqual({ afternoon_enabled: true, percentage_mode: "session" });
  // on the same screen, without a reload: the dashboard follows the setting it sits next to
  await expect(page.getByText(CARD_ON).first()).toBeVisible({ timeout: 20000 });
  await expect(page.getByText("Afternoon not taken").first()).toBeVisible({ timeout: 20000 });
});

test("the teacher takes the morning register, then the afternoon one with Faith absent: two registers, neither touches the other (AC 1, 8)", async ({ page }) => {
  await teacherRegister(page, "Morning");
  await expect(page.getByText(/^43 learners$/)).toBeVisible();
  await page.getByRole("button", { name: "Submit register" }).click();
  await page.getByRole("button", { name: "Yes, submit" }).click();
  await expect(page.getByText("Form 2 West morning register is in")).toBeVisible({ timeout: 15000 });

  // switch on the "register is in" screen: the afternoon has not been taken, so the roster opens
  await page.getByRole("group", { name: "Register" }).first().getByRole("button", { name: "Afternoon", exact: true }).click();
  await expect(page.getByText("Everyone starts present")).toBeVisible({ timeout: 15000 });
  await page.getByRole("group", { name: "Mark for Faith Achieng" }).getByRole("button", { name: "Absent" }).click();
  await page.getByRole("button", { name: "Submit register" }).click();
  await expect(page.getByText("Form 2 West afternoon register is in")).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: "test-results/pm-3-teacher-afternoon-in.png" });

  const am = (await entries({ classId, on: day() })).filter((e) => e.session === "morning");
  const pm = (await entries({ classId, on: day() })).filter((e) => e.session === "afternoon");
  expect(am).toHaveLength(43);
  expect(pm).toHaveLength(43);
  expect(am.find((e) => e.student_id === faithId)?.mark, "the afternoon save left the morning register alone").toBe("present");
  expect(pm.find((e) => e.student_id === faithId)?.mark).toBe("absent");
  expect(pm.filter((e) => e.mark !== "present")).toHaveLength(1);
});

test("the admin sees both registers: badges, the side-by-side detail, the counted figure and the PM-missing report (AC 2, 3, 9 Dashboard, 10)", async ({ page }) => {
  await adminDashboard(page);
  const row = classRow(page);
  await expect(row.getByText("Afternoon in")).toBeVisible({ timeout: 20000 });
  await expect(row.getByTitle("See who was late, absent or excused")).toHaveText(await expectedFigure("session"));
  console.log("DASHBOARD Form 2 West (session):", await row.getByTitle("See who was late, absent or excused").innerText());

  await expect(pmReport(page)).toContainText("Faith Achieng", { timeout: 20000 });
  await pmReport(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/pm-4-admin-report.png", fullPage: true });

  await row.getByTitle("See who was late, absent or excused").click();
  const detail = page.getByRole("dialog").filter({ hasText: "Form 2 West · who wasn't here" });
  await expect(detail).toBeVisible();
  const faith = detailRegisterRow(detail);
  await expect(faith).toContainText("Morning");
  await expect(faith).toContainText("Present");
  await expect(faith).toContainText("Afternoon");
  await expect(faith).toContainText("Absent");
  await page.screenshot({ path: "test-results/pm-5-admin-detail-side-by-side.png" });
});

test("AC 10 through the screens: the teacher signs Faith out early from the afternoon register; she leaves the report and her afternoon absence leaves the figure", async ({ browser }) => {
  const t = await (await browser.newContext()).newPage();
  await teacherRegister(t, "Afternoon");
  await expect(t.getByText("Form 2 West afternoon register is in")).toBeVisible({ timeout: 15000 });
  // the sign-out button is on each learner of the roster: open it with "Correct a mark"
  await t.getByRole("button", { name: "Correct a mark" }).click();
  await faithRow(t).getByRole("button", { name: "Sign out early" }).click();
  const dlg = t.getByRole("dialog");
  await dlg.getByLabel("Reason for leaving").fill(REASON);
  await dlg.getByLabel("Authorised by").fill("Deputy E2E");
  await dlg.getByLabel("Collected by (name)").fill("Mother E2E");
  await dlg.getByLabel("Relationship to the learner").fill("Mother");
  await dlg.getByLabel("Collector's ID number").fill("FIG1514-ID");
  await dlg.getByLabel("Collector's phone").fill("+254700000514");
  await t.screenshot({ path: "test-results/pm-6-signout-modal.png" });
  await dlg.getByRole("button", { name: "Sign out early" }).click();
  await expect(t.getByRole("dialog")).toHaveCount(0, { timeout: 15000 });
  await expect(faithRow(t).getByText(/^Left early at \d\d:\d\d$/)).toBeVisible({ timeout: 15000 });
  expect((await ourSignOuts()).filter((r) => !r.voided_at), "one live sign-out, recorded through the modal").toHaveLength(1);
  await t.close();

  const a = await (await browser.newContext()).newPage();
  await adminDashboard(a);
  await expect(pmReport(a)).toContainText("Nobody who was here in the morning was missing in the afternoon", { timeout: 20000 });
  await expect(pmReport(a)).not.toContainText("Faith Achieng");
  const expected = await expectedFigure("session");
  await expect(classRow(a).getByTitle("See who was late, absent or excused")).toHaveText(expected);
  console.log("DASHBOARD Form 2 West after the sign-out (session):", expected);
  await pmReport(a).scrollIntoViewIfNeeded();
  await a.screenshot({ path: "test-results/pm-7-admin-report-after-signout.png", fullPage: true });
  await a.close();
});

test("a voided sign-out excuses nothing: after the void Faith is back on the report (AC 10)", async ({ browser }) => {
  const t = await (await browser.newContext()).newPage();
  await teacherRegister(t, "Afternoon");
  await t.getByRole("button", { name: "Correct a mark" }).click();
  await faithRow(t).getByRole("button", { name: "Void" }).click();
  await t.getByRole("alertdialog").getByLabel("Reason").fill(VOID_REASON);
  await t.getByRole("alertdialog").getByRole("button", { name: "Void sign-out", exact: true }).click();
  await expect.poll(async () => (await ourSignOuts()).filter((r) => !r.voided_at).length, { timeout: 15000 }).toBe(0);
  await t.close();

  const a = await (await browser.newContext()).newPage();
  await adminDashboard(a);
  await expect(pmReport(a)).toContainText("Faith Achieng", { timeout: 20000 });
  await expect(classRow(a).getByTitle("See who was late, absent or excused")).toHaveText(await expectedFigure("session"));
  await a.close();
});

test("the parent's attendance figure reads both registers in the school's mode (AC 9 parent web)", async ({ page }) => {
  const mine = await entries({ studentId: faithId });
  const outs = await signOuts({ studentId: faithId });
  const both = attendanceFigures(countAttendance(mine, "session", outs)).pct;
  const morningOnly = attendanceFigures(countAttendance(mine.filter((e) => e.session === "morning"), "session", outs)).pct;
  console.log(`PARENT Faith: both registers ${both}%, morning register alone ${morningOnly}%`);
  await signInWithId(page, "PT-0002", "Parent");
  await page.goto("/s/alliance/parent");
  await expect(page.getByText("ADM 4102")).toBeVisible({ timeout: 25000 });
  // the stat card (StatCard upper-cases its label)
  const card = page.locator("div.rounded-lg").filter({ has: page.getByText("ATTENDANCE", { exact: true }) }).filter({ hasText: "this term" }).last();
  await expect(card).toBeVisible({ timeout: 25000 });
  const shown = /(\d+%|—)/.exec(await card.innerText())?.[1];
  expect(shown).toBe(`${both}%`);
  await page.screenshot({ path: "test-results/pm-8-parent.png", fullPage: true });
});

test("by day: the dashboard counts each learner once, and Reports says learner-days (AC 9 Dashboard, Reports)", async ({ page }) => {
  await adminDashboard(page);
  await saveSettings(page, { mode: "day" });
  expect(await settingsRow()).toEqual({ afternoon_enabled: true, percentage_mode: "day" });
  // no reload: the figure on the same screen is recalculated in the new mode once the setting is saved
  const expected = await expectedFigure("day");
  expect(expected, "the day figure differs from the session one, so a stale figure cannot pass").not.toBe(await expectedFigure("session"));
  await expect(classRow(page).getByTitle("See who was late, absent or excused")).toHaveText(expected, { timeout: 20000 });
  console.log("DASHBOARD Form 2 West (day):", expected);
  await page.screenshot({ path: "test-results/pm-9-admin-day-mode.png", fullPage: true });

  await page.goto("/s/alliance/admin/reports");
  await expect(page.getByText(/learner-days this term/).first()).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "test-results/pm-10-reports-day-mode.png", fullPage: true });

  await page.goto("/s/alliance/admin");
  await saveSettings(page, { mode: "session" });
  expect((await settingsRow())?.percentage_mode).toBe("session");
});

test("the attendance-area holder's home (AreasHome) follows the settings at once: the mode changes the figure, the afternoon setting the badges, with no reload (AC 3, 9 AreasHome)", async ({ page }) => {
  // Lucy Njeri is "other staff" with the visitors area, given the attendance area for this run: /admin is AreasHome for her, not the
  // full Dashboard, so this is the screen an attendance officer uses.
  await signInWithId(page, "SF-0001", "Other staff");
  await page.goto("/s/alliance/admin");
  const registers = page.locator("section").filter({ has: page.getByRole("heading", { name: /^Attendance by class · / }) });
  await expect(registers.getByRole("heading", { name: `Attendance by class · ${day()}` })).toBeVisible({ timeout: 30000 });
  const row = registers.locator("div").filter({ has: page.getByText("Form 2 West", { exact: true }) })
    .filter({ has: page.getByTitle("See who was late, absent or excused, and correct it") }).last();
  const figure = row.getByTitle("See who was late, absent or excused, and correct it");
  // afternoon on, by session (as test 8 left it): both badges and the session figure
  await expect(row.getByText("Afternoon in")).toBeVisible({ timeout: 20000 });
  await expect(figure).toHaveText(await expectedFigure("session"));
  await expect(pmReport(page)).toContainText("Faith Achieng", { timeout: 20000 });
  await page.screenshot({ path: "test-results/pm-11a-areashome-session.png", fullPage: true });

  // by day, from the panel on this page: the figure changes on the same screen
  const dayFigure = await expectedFigure("day");
  expect(dayFigure, "the day figure differs from the session one, so a stale figure cannot pass").not.toBe(await expectedFigure("session"));
  await saveSettings(page, { mode: "day" });
  expect((await settingsRow())?.percentage_mode).toBe("day");
  await expect(figure).toHaveText(dayFigure, { timeout: 20000 });
  await page.screenshot({ path: "test-results/pm-11b-areashome-day.png", fullPage: true });
  await saveSettings(page, { mode: "session" });
  await expect(figure).toHaveText(await expectedFigure("session"), { timeout: 20000 });

  // A refused save is not reported as saved: the database refuses it (as it refuses anyone without the area), the panel says so in the
  // database's words, the stored row and the badges stay as they were, and the change is still there to save.
  const refuse = (route: Route) => route.fulfill({
    status: 403, contentType: "application/json",
    body: JSON.stringify({ code: "42501", message: 'new row violates row-level security policy for table "attendance_settings"', details: null, hint: null }),
  });
  await page.route(/\/rest\/v1\/attendance_settings/, (route) => (route.request().method() === "POST" ? refuse(route) : route.continue()));
  await settingsPanel(page).getByLabel("Take an afternoon register").setChecked(false);
  await settingsPanel(page).getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /Could not save the settings: .*row-level security/ })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Attendance settings saved.")).toHaveCount(0);
  expect((await settingsRow())?.afternoon_enabled, "nothing was stored").toBe(true);
  await expect(row.getByText("Afternoon in")).toBeVisible();
  await expect(settingsPanel(page).getByRole("button", { name: "Save settings" }), "the unsaved change is still there to save").toBeEnabled();
  await page.screenshot({ path: "test-results/pm-11c0-areashome-save-refused.png", fullPage: true });
  await page.unroute(/\/rest\/v1\/attendance_settings/);
  // let the refusal's notice go before the real save, so nothing on screen is left over from it
  await expect(page.getByRole("alert").filter({ hasText: "Could not save the settings" })).toHaveCount(0, { timeout: 10000 });

  // afternoon off: the badges go on the same screen; on again: they come back
  await saveSettings(page, { afternoon: false });
  expect((await settingsRow())?.afternoon_enabled).toBe(false);
  await expect(registers.getByText("Afternoon in")).toHaveCount(0, { timeout: 20000 });
  await expect(registers.getByText("Afternoon not taken")).toHaveCount(0);
  await page.screenshot({ path: "test-results/pm-11c-areashome-off.png", fullPage: true });
  await saveSettings(page, { afternoon: true });
  await expect(row.getByText("Afternoon in")).toBeVisible({ timeout: 20000 });
  expect(await settingsRow()).toEqual({ afternoon_enabled: true, percentage_mode: "session" });
});

test("turned off again: the switch goes, the afternoon register is kept and still shown in the detail (AC 3a, 7)", async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  await adminDashboard(a);
  await saveSettings(a, { afternoon: false });
  expect((await settingsRow())?.afternoon_enabled).toBe(false);
  // on the same screen first: the card caption changes back only once the dashboard has reloaded with the afternoon off
  await expect(a.getByText(CARD_OFF).first()).toBeVisible({ timeout: 20000 });
  await expect(a.getByText("Afternoon in")).toHaveCount(0);
  await expect(a.getByText("Afternoon not taken")).toHaveCount(0);
  // and it stays that way after a reload
  await a.reload();
  await expect(a.getByText(CARD_OFF).first()).toBeVisible({ timeout: 30000 });
  await expect(a.getByText("Afternoon in")).toHaveCount(0);
  await expect(a.getByText("Afternoon not taken")).toHaveCount(0);
  await classRow(a).getByTitle("See who was late, absent or excused").click();
  const detail = a.getByRole("dialog").filter({ hasText: "Form 2 West · who wasn't here" });
  await expect(detailRegisterRow(detail)).toContainText("Afternoon");
  await expect(detailRegisterRow(detail)).toContainText("Absent");
  await a.screenshot({ path: "test-results/pm-11-admin-off-detail-kept.png" });
  await a.close();

  const pm = (await entries({ classId, on: day() })).filter((e) => e.session === "afternoon");
  expect(pm, "nothing deleted when the setting went off").toHaveLength(43);

  const t = await (await browser.newContext()).newPage();
  await teacherRegister(t);
  await expect(t.getByText(/register is in/).first()).toBeVisible({ timeout: 15000 });
  await expect(t.getByRole("group", { name: "Register" })).toHaveCount(0);
  await expect(t.getByText("Form 2 West register is in")).toBeVisible();
  await t.screenshot({ path: "test-results/pm-12-teacher-off-again.png" });
  await t.close();
});
