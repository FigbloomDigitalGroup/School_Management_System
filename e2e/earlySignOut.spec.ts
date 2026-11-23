import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { today as schoolToday } from "../packages/shared/src/attendance";

process.loadEnvFile?.(); // Node 20.6+ built-in
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

/**
 * FIG-1513 stage A: early sign-out, in a real browser against the seeded local school.
 *
 * Faith Achieng (Form 2 West, class teacher TC-0002, parent PT-0002) is signed out by her class teacher, seen by her parent, then voided.
 * Every value that must stay private is a marker string, so a leak into any page shows up as a plain text match.
 *
 * Local Supabase only. Serial: the steps share one learner and one day.
 */
test.describe.configure({ mode: "serial" });

// Each run tags its records with a run id and counts only those. Sign-outs are never deleted (they carry audit events written by the
// functions that made them), so voided ones from earlier runs stay in the local database and must not count. The authoriser and the void
// reason carry the run id too, so what the admin list shows is this run's record, not an earlier one.
const RUN = Date.now().toString(36);
const SECRET = {
  idNumber: "E2E-ID-884213",
  phone: "+254700555123",
  authorisedBy: `Authoriser Zed ${RUN}`,
  note: "e2e private note",
  voidReason: `e2e void reason private ${RUN}`,
};
const COLLECTOR = "Wanjiru E2E Kamau";
const REASON = `e2e doctor appointment ${RUN}`;

const schoolClock = () => new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Nairobi", hour: "2-digit", minute: "2-digit", hour12: false });
/** HH:MM on the school's clock, `minutesAgo` before now. */
const clockAgo = (minutesAgo: number) => schoolClock().format(new Date(Date.now() - minutesAgo * 60_000));

async function waitForSignedIn(page: Page) {
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 15000 });
}
async function signInWithId(page: Page, loginId: string, portal: "Teacher" | "Parent") {
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

async function openRegister(page: Page) {
  await signInWithId(page, "TC-0002", "Teacher");
  await page.goto("/s/alliance/teacher/attendance");
  await expect(page.getByText("Everyone starts present")).toBeVisible();
  await page.getByLabel("Class").selectOption({ label: "Form 2 West" });
  await expect(page.getByText(/^43 learners$/)).toBeVisible();
}
const faithRow = (page: Page) => page.getByRole("listitem").filter({ hasText: "Faith Achieng" }).first();

async function fillModal(page: Page, extra: { time?: string } = {}) {
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Reason for leaving").fill(REASON);
  await dlg.getByLabel("Authorised by").fill(SECRET.authorisedBy);
  await dlg.getByLabel("Collected by (name)").fill(COLLECTOR);
  await dlg.getByLabel("Relationship to the learner").fill("Mother");
  await dlg.getByLabel("Collector's ID number").fill(SECRET.idNumber);
  await dlg.getByLabel("Collector's phone").fill(SECRET.phone);
  await dlg.getByLabel("Note (optional)").fill(SECRET.note);
  if (extra.time) await dlg.getByLabel("Time out (optional)").fill(extra.time);
  return dlg;
}

async function faithId() {
  const { data, error } = await admin.from("students").select("id, tenants!inner(slug)").eq("admission_no", "4102").eq("tenants.slug", "alliance").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}
/** This run's sign-outs for Faith, voided or not (the name is historical: filter on voided_at for the live ones). */
async function liveRows() {
  const { data, error } = await admin.from("early_sign_outs").select("id, voided_at, reason").eq("student_id", await faithId()).eq("reason", REASON).order("signed_out_at");
  if (error) throw new Error(error.message);
  return data!;
}
/** Faith's sign-outs today that are still live, from any run: a live one changes what the register and the five-minute rule do. */
async function liveToday() {
  const { data, error } = await admin.from("early_sign_outs").select("id, reason").eq("student_id", await faithId()).eq("taken_on", schoolToday()).is("voided_at", null);
  if (error) throw new Error(error.message);
  return data!;
}

test.beforeAll(async () => {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.SUPABASE_URL ?? "")) throw new Error("local Supabase only");
  await admin.from("login_lookups").delete().gte("looked_up_at", "1970-01-01");
  // Voided records from earlier runs are left alone. A live one would be "already signed out" for the five-minute rule: stop and say so.
  expect(await liveToday(), "Faith has no live early sign-out today (void it in the app first)").toHaveLength(0);
});

test("the class teacher records a sign-out; a second within five minutes is refused in words; a separate earlier departure is accepted", async ({ page }) => {
  await openRegister(page);
  await page.screenshot({ path: "test-results/early-1-register-before.png", fullPage: false });

  // 1. record
  await faithRow(page).getByRole("button", { name: "Sign out early" }).click();
  const dlg = await fillModal(page);
  await page.screenshot({ path: "test-results/early-2-modal-filled.png" });
  await dlg.getByRole("button", { name: "Sign out early" }).click();
  await expect(faithRow(page).getByText(/^Left early at \d\d:\d\d$/)).toBeVisible({ timeout: 15000 });
  await expect(faithRow(page).getByRole("button", { name: "Sign out again" })).toBeVisible();
  await page.screenshot({ path: "test-results/early-3-register-after.png" });
  expect(await liveRows()).toHaveLength(1);

  // 2. a second within five minutes of the first: refused by the server, in words, nothing saved
  await faithRow(page).getByRole("button", { name: "Sign out again" }).click();
  const dlg2 = await fillModal(page);
  await dlg2.getByRole("button", { name: "Sign out early" }).click();
  const alert = dlg2.getByRole("alert");
  await expect(alert).toBeVisible({ timeout: 15000 });
  const refusal = (await alert.innerText()).replace(/\s+/g, " ");
  console.log("FIVE-MINUTE REFUSAL TEXT:", refusal);
  // the words say what the rule is and which time it clashed with (M-A), not "a moment ago"
  expect(refusal).toContain("Faith Achieng already has a sign-out recorded at");
  expect(refusal).toContain("within five minutes of this time");
  expect(refusal).toContain("enter a time at least five minutes apart");
  expect(refusal).not.toContain("moment ago");
  const first = (await liveRows())[0];
  const { data: clash } = await admin.from("early_sign_outs").select("signed_out_local").eq("id", first.id).single();
  expect(refusal, "it names the time of the sign-out it clashed with").toContain(`recorded at ${String(clash!.signed_out_local).slice(0, 5)},`);
  await page.screenshot({ path: "test-results/early-4-duplicate-refused.png" });
  expect(await liveRows(), "refused, so still one row").toHaveLength(1);

  // 3. a genuinely separate earlier departure (30 minutes before): accepted
  await dlg2.getByLabel("Time out (optional)").fill(clockAgo(30));
  await dlg2.getByRole("button", { name: "Sign out early" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15000 });
  expect(await liveRows(), "a separate departure is allowed").toHaveLength(2);

  // 4. the future is refused
  await faithRow(page).getByRole("button", { name: "Sign out again" }).click();
  const dlg3 = await fillModal(page, { time: "23:59" });
  const nowHM = clockAgo(0);
  if (nowHM < "23:55") {
    await dlg3.getByRole("button", { name: "Sign out early" }).click();
    await expect(dlg3.getByRole("alert")).toBeVisible({ timeout: 15000 });
    console.log("FUTURE-TIME REFUSAL TEXT:", (await dlg3.getByRole("alert").innerText()).replace(/\s+/g, " "));
    expect(await liveRows()).toHaveLength(2);
  }
  await dlg3.getByRole("button", { name: "Cancel" }).click();
});

test("the register summary lists who left early, read from the same records", async ({ page }) => {
  await openRegister(page);
  await page.getByRole("button", { name: "Submit register" }).click();
  await page.getByRole("button", { name: "Yes, submit" }).click();
  await expect(page.getByText("register is in")).toBeVisible({ timeout: 15000 });
  const list = page.getByRole("region", { name: "Left early today" }).or(page.locator("section[aria-label='Left early today']"));
  await expect(list).toContainText("Faith Achieng");
  await expect(list).toContainText(COLLECTOR);
  await page.screenshot({ path: "test-results/early-5-summary.png", fullPage: true });
  const text = await list.innerText();
  for (const v of [SECRET.idNumber, SECRET.phone, SECRET.note, SECRET.authorisedBy]) expect(text).not.toContain(v);
  // leave the day's register as the other specs expect it
  const { data: t } = await admin.from("tenants").select("id").eq("slug", "alliance").single();
  await admin.from("attendance").delete().eq("tenant_id", t!.id as string).eq("taken_on", schoolToday());
});

test("the parent sees that the child left early, and none of the private details", async ({ page }) => {
  await signInWithId(page, "PT-0002", "Parent");
  await page.goto("/s/alliance/parent");
  await expect(page.getByText("ADM 4102")).toBeVisible({ timeout: 25_000 });
  const card = page.getByRole("status").filter({ hasText: /left early at/i });
  await expect(card).toBeVisible({ timeout: 25_000 });
  await expect(card).toContainText(COLLECTOR);
  await page.screenshot({ path: "test-results/early-6-parent.png", fullPage: true });
  const body = await page.locator("body").innerText();
  for (const v of [SECRET.idNumber, SECRET.phone, SECRET.note, SECRET.authorisedBy]) expect(body, `parent page must not contain ${v}`).not.toContain(v);
  // and the parent's own API reads cannot reach the restricted table either
  const token = await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.includes("auth-token")) return (JSON.parse(localStorage.getItem(k)!) as { access_token: string }).access_token;
    return null;
  });
  expect(token, "parent session token found in the page").toBeTruthy();
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/early_sign_out_collectors?select=*`, { headers: { apikey: process.env.VITE_SUPABASE_ANON_KEY!, authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  expect(await res.json(), "the parent gets no restricted rows").toEqual([]);
  const own = await fetch(`${process.env.SUPABASE_URL}/rest/v1/early_sign_outs?select=*`, { headers: { apikey: process.env.VITE_SUPABASE_ANON_KEY!, authorization: `Bearer ${token}` } });
  const rows = (await own.json()) as Record<string, unknown>[];
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) for (const bad of ["authorised_by", "note", "void_reason", "id_number", "phone"]) expect(Object.keys(r)).not.toContain(bad);
});

test("the school admin sees the daily list with the restricted details", async ({ page }) => {
  await signInAdmin(page);
  await page.goto("/s/alliance/admin");
  const section = page.locator("section").filter({ hasText: /Early sign-outs ·/ }).first();
  await expect(section).toContainText("Faith Achieng", { timeout: 25_000 });
  await expect(section).toContainText(SECRET.idNumber);
  await expect(section).toContainText(SECRET.phone);
  await expect(section).toContainText(SECRET.authorisedBy);
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/early-7-admin-list.png", fullPage: true });
});

test("voiding needs a reason; the void shows struck through to the admin, and the parent never sees the reason", async ({ page }) => {
  await openRegister(page);
  await faithRow(page).getByRole("button", { name: "Void" }).click();
  const box = page.getByRole("alertdialog");
  await expect(box).toBeVisible();
  await page.screenshot({ path: "test-results/early-8-void-prompt.png" });
  // a void with no reason cannot be confirmed
  const confirm = box.getByRole("button", { name: "Void sign-out", exact: true });
  await confirm.click();
  await expect(page.getByRole("alertdialog"), "still asking: a void needs a reason").toBeVisible();
  expect((await liveRows()).filter((r) => r.voided_at), "nothing voided without a reason").toHaveLength(0);
  await box.getByLabel("Reason").fill(SECRET.voidReason);
  await confirm.click();
  await expect.poll(async () => (await liveRows()).filter((r) => r.voided_at).length, { timeout: 15000 }).toBe(1);
  // void the other one too, so nothing is left live
  await expect(faithRow(page).getByRole("button", { name: "Void" })).toBeVisible({ timeout: 15000 });
  await faithRow(page).getByRole("button", { name: "Void" }).click();
  await page.getByRole("alertdialog").getByLabel("Reason").fill(SECRET.voidReason);
  await page.getByRole("alertdialog").getByRole("button", { name: "Void sign-out", exact: true }).click();
  await expect.poll(async () => (await liveRows()).filter((r) => r.voided_at).length, { timeout: 15000 }).toBe(2);
  await expect(faithRow(page).getByText(/^Left early at/)).toHaveCount(0, { timeout: 15000 });

  // the void reason is in the restricted table, not on the record the family can read
  const { data: restricted } = await admin.from("early_sign_out_collectors").select("void_reason").in("sign_out_id", (await liveRows()).map((r) => r.id));
  expect(restricted!.every((r) => r.void_reason === SECRET.voidReason)).toBe(true);
  const { data: main } = await admin.from("early_sign_outs").select("*").in("id", (await liveRows()).map((r) => r.id));
  expect(JSON.stringify(main)).not.toContain(SECRET.voidReason);
});

test("after the void: the parent card is gone and the reason never reached the parent; the admin list shows it voided", async ({ browser }) => {
  const p = await (await browser.newContext()).newPage();
  await signInWithId(p, "PT-0002", "Parent");
  await p.goto("/s/alliance/parent");
  await expect(p.getByText("ADM 4102")).toBeVisible({ timeout: 25_000 });
  await expect(p.getByRole("status").filter({ hasText: /left early at/i })).toHaveCount(0);
  expect(await p.locator("body").innerText()).not.toContain(SECRET.voidReason);
  await p.close();

  const a = await (await browser.newContext()).newPage();
  await signInAdmin(a);
  await a.goto("/s/alliance/admin");
  const section = a.locator("section").filter({ hasText: /Early sign-outs ·/ }).first();
  await expect(section).toContainText(`Voided: ${SECRET.voidReason}`, { timeout: 25_000 });
  await a.screenshot({ path: "test-results/early-9-admin-voided.png", fullPage: true });
  await a.close();
});

test("a sign-out can be recorded again at once after the previous one is voided: a voided record does not count towards the five minutes", async ({ page }) => {
  // every earlier record is voided now, and the first of them was made only minutes ago, well inside the five-minute window
  expect((await liveRows()).filter((r) => !r.voided_at), "nothing is live before this test").toHaveLength(0);
  await openRegister(page);
  await faithRow(page).getByRole("button", { name: /Sign out early|Sign out again/ }).click();
  const dlg = await fillModal(page);
  await dlg.getByRole("button", { name: "Sign out early" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15000 });
  await expect(faithRow(page).getByText(/^Left early at \d\d:\d\d$/)).toBeVisible({ timeout: 15000 });
  expect((await liveRows()).filter((r) => !r.voided_at), "the new sign-out is live").toHaveLength(1);
  await page.screenshot({ path: "test-results/early-10-after-void-recorded.png" });

  // and the five-minute rule applies to it again
  await faithRow(page).getByRole("button", { name: "Sign out again" }).click();
  const dlg2 = await fillModal(page);
  await dlg2.getByRole("button", { name: "Sign out early" }).click();
  await expect(dlg2.getByRole("alert")).toContainText("within five minutes of this time", { timeout: 15000 });
  expect((await liveRows()).filter((r) => !r.voided_at)).toHaveLength(1);
  await dlg2.getByRole("button", { name: "Cancel" }).click();

  // leave nothing live for the next run
  await faithRow(page).getByRole("button", { name: "Void" }).click();
  await page.getByRole("alertdialog").getByLabel("Reason").fill(SECRET.voidReason);
  await page.getByRole("alertdialog").getByRole("button", { name: "Void sign-out", exact: true }).click();
  await expect.poll(async () => (await liveRows()).filter((r) => !r.voided_at).length, { timeout: 15000 }).toBe(0);
});
