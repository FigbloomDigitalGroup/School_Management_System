import { expect, test, type Page, type Route } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { LOGINS, S, axeFindings, defineKnownTests, isKnownContrast, layoutFindings, measure, type Finding, type Known, type RoleName } from "./support/qa16";

process.loadEnvFile?.(); // Node 20.6+ built-in
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

/**
 * QA 16 (FIG-1249), the parts a scan of every screen cannot see:
 *   1  the keyboard: sign-in without a mouse, a visible focus ring on every stop, and what a dialog does with focus
 *   2  dialogs: each one opened at 1280 and 390 px, checked for fit and with axe
 *   3  states: a failed request must say so (never an empty list that looks like real data), and loading must look like loading
 *   4  double clicks on Pay, Submit register, Bill learners and Record payment: how many requests are sent
 *   5  very long names on the screens that show them
 *   6  the accessibility preferences (text size, bold, high contrast): they apply, they last, and the screens stay usable
 * Desktop project only: the width is set inside each test.
 */

const findings: Finding[] = [];
const notes: string[] = [];

test.describe.configure({ mode: "serial", timeout: 300_000 });
test.skip(({ isMobile }) => isMobile, "the width is set inside each test");

const loginAs = async (page: Page, role: RoleName, width = 1280) => {
  await db.from("login_lookups").delete().gte("looked_up_at", "1970-01-01"); // 30 login-ID lookups per 10 minutes per caller (see flows.spec.ts)
  await page.setViewportSize({ width: 1280, height: 900 });
  await LOGINS[role](page);
  if (width !== 1280) await page.setViewportSize({ width, height: 844 });
};
const settle = async (page: Page, ms = 700) => { await page.waitForLoadState("networkidle"); await page.waitForTimeout(ms); };

test.beforeAll(() => {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.SUPABASE_URL ?? "")) throw new Error("local Supabase only");
});

// ================================================================ 1. the keyboard
interface Stop { name: string; tag: string; ring: boolean; inDialog: boolean }
const focused = (page: Page): Promise<Stop | null> => page.evaluate(() => {
  const el = document.activeElement as HTMLInputElement | null;
  if (!el || el === document.body) return null;
  const cs = getComputedStyle(el);
  const name = el.getAttribute("aria-label") || el.labels?.[0]?.textContent || el.textContent || el.placeholder || el.tagName;
  return {
    name: name.trim().replace(/\s+/g, " ").slice(0, 40), tag: el.tagName.toLowerCase(),
    ring: (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none",
    inDialog: !!el.closest("[role=dialog]"),
  };
});
async function tabUntil(page: Page, match: RegExp, stops: Stop[], max = 60): Promise<Stop> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const f = await focused(page);
    if (f) { stops.push(f); if (match.test(f.name)) return f; }
  }
  throw new Error(`Tab never reached ${match} in ${max} presses (stops: ${stops.map((s) => s.name).join(" > ")})`);
}

test("QA16-USE 1a sign-in works with the keyboard alone, and every stop shows a focus ring", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/signin");
  await settle(page, 300);
  const stops: Stop[] = [];
  // after a button swaps the sign-in view, where is focus? (the button that had it is gone)
  const lostAfter: string[] = [];
  await tabUntil(page, /Admin portal/, stops);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  if (!(await focused(page))) lostAfter.push("choosing the Admin portal");
  await tabUntil(page, /Sign in with email instead/, stops);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  if (!(await focused(page))) lostAfter.push("Sign in with email instead");
  await tabUntil(page, /^Email/i, stops);
  await page.keyboard.type("principal@alliance.sc.ke");
  await tabUntil(page, /^Password/i, stops);
  await page.keyboard.type("figbloom-dev");
  await page.keyboard.press("Enter"); // what a keyboard user and a phone's Go key do
  await page.waitForTimeout(2500);
  const enterSignsIn = !new URL(page.url()).pathname.startsWith("/signin");
  if (!enterSignsIn) {
    findings.push({ role: "signed out", route: "/signin", width: 1280, kind: "Enter does not submit the sign-in form", detail: "the fields are not inside a form, so Enter in the password field does nothing" });
    await tabUntil(page, /^Sign in$/, stops); // the keyboard path that does work
    await page.keyboard.press("Enter");
  }
  await page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 20000 });
  for (const l of lostAfter) findings.push({ role: "signed out", route: "/signin", width: 1280, kind: "focus is lost when the view changes", detail: `after ${l}, nothing has focus: the next Tab starts again from the top of the page` });
  notes.push(`1a Enter signs in: ${enterSignsIn}; focus lost after: ${lostAfter.join(", ") || "never"}`);
  for (const s of stops.filter((x) => !x.ring)) findings.push({ role: "signed out", route: "/signin", width: 1280, kind: "no focus ring", detail: `${s.tag} "${s.name}"` });
  notes.push(`1a sign-in by keyboard: ${stops.length} stops, ${stops.filter((x) => !x.ring).length} without a ring`);
});

const SHELL_STOPS: [RoleName, string][] = [
  ["school admin", `${S}/admin`], ["school admin", `${S}/admin/people`], ["teacher", `${S}/teacher/attendance`],
  ["parent", `${S}/parent`], ["student", `${S}/student`], ["platform admin", "/platform/tenants"],
];
test("QA16-USE 1b the first 25 keyboard stops of each console are all visible, and reach the page's own controls", async ({ page }) => {
  let current: RoleName | null = null;
  for (const [role, route] of SHELL_STOPS) {
    if (role !== current) { await loginAs(page, role); current = role; }
    await page.goto(route);
    await settle(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const stops: Stop[] = [];
    for (let i = 0; i < 25; i++) { await page.keyboard.press("Tab"); const f = await focused(page); if (f) stops.push(f); }
    for (const s of stops.filter((x) => !x.ring)) findings.push({ role, route, width: 1280, kind: "no focus ring", detail: `${s.tag} "${s.name}"` });
    notes.push(`1b ${role} ${route}: ${stops.length} stops, ${stops.filter((x) => !x.ring).length} without a ring, last: "${stops[stops.length - 1]?.name}"`);
  }
});

async function dialogKeyboard(page: Page, role: RoleName, route: string, opener: () => ReturnType<Page["getByRole"]>, label: string) {
  const btn = opener().first();
  await btn.focus();
  await page.keyboard.press("Enter");
  const dialog = page.locator("[role=dialog]").first();
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(300);
  const first = await focused(page);
  if (!first?.inDialog) findings.push({ role, route, width: 1280, kind: "focus does not move into the dialog", detail: label });
  let escaped = 0;
  for (let i = 0; i < 40; i++) { await page.keyboard.press("Tab"); const f = await focused(page); if (f && !f.inDialog) escaped++; }
  if (escaped) findings.push({ role, route, width: 1280, kind: "focus leaves the dialog", detail: `${label}: ${escaped} of 40 Tab presses landed outside it` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  if (await page.locator("[role=dialog]").count()) findings.push({ role, route, width: 1280, kind: "Escape does not close the dialog", detail: label });
  const back = await focused(page);
  const opened = await btn.evaluate((el) => el === document.activeElement);
  if (!opened) findings.push({ role, route, width: 1280, kind: "focus is not returned to the opener", detail: `${label}: focus went to ${back ? `${back.tag} "${back.name}"` : "the page"}` });
  notes.push(`1c ${label}: moved in ${!!first?.inDialog}, escaped ${escaped}/40, closed by Escape ${!(await page.locator("[role=dialog]").count())}, returned ${opened}`);
}
test("QA16-USE 1c dialogs: focus moves in, stays in, Escape closes, focus returns", async ({ page }) => {
  await loginAs(page, "school admin");
  await page.goto(`${S}/admin/people`);
  await expect(page.getByText(/^[\d,]+ total$/)).toBeVisible({ timeout: 30000 });
  await dialogKeyboard(page, "school admin", `${S}/admin/people`, () => page.getByRole("button", { name: "Add a learner" }), "People > Add a learner");
  await dialogKeyboard(page, "school admin", `${S}/admin/people`, () => page.getByRole("button", { name: "Import from CSV" }), "People > Import from CSV");
  await dialogKeyboard(page, "school admin", `${S}/admin/people`, () => page.getByRole("button", { name: "Accessibility settings" }), "People > Accessibility settings");
});

// ================================================================ 2. dialogs at two widths
interface Opener { role: RoleName; route: string; label: string; open: (page: Page) => Promise<void> }
const OPENERS: Opener[] = [
  { role: "school admin", route: `${S}/admin/people`, label: "Add a learner", open: (p) => p.getByRole("button", { name: "Add a learner" }).first().click({ timeout: 8000 }) },
  { role: "school admin", route: `${S}/admin/people`, label: "Import from CSV", open: (p) => p.getByRole("button", { name: "Import from CSV" }).first().click({ timeout: 8000 }) },
  { role: "school admin", route: `${S}/admin/people`, label: "Manage a learner", open: (p) => p.locator("[role=row]").nth(1).click({ timeout: 8000 }) },
  { role: "school admin", route: `${S}/admin/fees`, label: "Bill learners", open: (p) => p.getByRole("button", { name: "Bill learners" }).first().click({ timeout: 8000 }) },
  { role: "school admin", route: `${S}/admin/fees`, label: "Record a payment", open: (p) => p.getByRole("button", { name: "Record a payment" }).first().click({ timeout: 8000 }) },
  { role: "school admin", route: `${S}/admin`, label: "Accessibility settings", open: (p) => p.getByRole("button", { name: "Accessibility settings" }).first().click({ timeout: 8000 }) },
  { role: "parent", route: `${S}/parent/fees`, label: "Pay with M-Pesa", open: (p) => p.getByRole("button", { name: "Pay with M-Pesa" }).first().click({ timeout: 8000 }) },
  { role: "platform admin", route: "/platform/invoices", label: "New invoice", open: (p) => p.getByRole("button", { name: "New invoice" }).first().click({ timeout: 8000 }) },
  { role: "platform admin", route: "/platform/incidents", label: "Declare incident", open: (p) => p.getByRole("button", { name: /Declare incident/ }).first().click({ timeout: 8000 }) },
  { role: "platform admin", route: "/platform/organizations", label: "Add an organization", open: (p) => p.getByRole("button", { name: /\+ Add|Add an organi/ }).first().click({ timeout: 8000 }) },
];
test("QA16-USE 2 every dialog at 1280 and 390 px: it fits the window and passes axe", async ({ page }) => {
  let current: RoleName | null = null;
  for (const o of OPENERS) {
    if (o.role !== current) { await loginAs(page, o.role); current = o.role; }
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(o.route);
      await settle(page);
      try { await o.open(page); } catch (e) { notes.push(`2 ${o.label} @${width}: could not open (${(e as Error).message.split("\n")[0]})`); continue; }
      const dlg = page.locator("[role=dialog]").first();
      try { await expect(dlg).toBeVisible({ timeout: 8000 }); } catch { notes.push(`2 ${o.label} @${width}: no dialog appeared`); continue; }
      await page.waitForTimeout(400);
      const box = await dlg.boundingBox();
      if (box && (box.x < -1 || box.x + box.width > width + 1)) findings.push({ role: o.role, route: o.route, width, kind: "dialog wider than the window", detail: `${o.label}: ${Math.round(box.width)}px wide at x=${Math.round(box.x)} in a ${width}px window` });
      const m = await measure(page, "[role=dialog]");
      for (const f of layoutFindings(o.role, o.route, width, m)) findings.push({ ...f, kind: `dialog ${f.kind}`, detail: `${o.label}: ${f.detail}` });
      const offScreen = await dlg.evaluate((el, w) => Array.from(el.querySelectorAll("button")).filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.right > w + 1 || r.left < -1); }).map((b) => (b.getAttribute("aria-label") || b.textContent || "button").trim().slice(0, 30)), width);
      if (offScreen.length) findings.push({ role: o.role, route: o.route, width, kind: "dialog button off screen", detail: `${o.label}: ${offScreen.join(", ")}` });
      const dialogScrollsSideways = await dlg.evaluate((el) => { const body = el.querySelector(".overflow-auto") ?? el; return body.scrollWidth > body.clientWidth + 1; });
      if (dialogScrollsSideways) findings.push({ role: o.role, route: o.route, width, kind: "dialog content scrolls sideways", detail: o.label });
      for (const f of await axeFindings(page, o.role, o.route, width, "[role=dialog]")) findings.push({ ...f, kind: `dialog ${f.kind}`, detail: `${o.label}: ${f.detail}` });
      await page.keyboard.press("Escape");
    }
  }
});

/** The sign-in page changes view without changing address (portal, email form, school search), so the walk in a11y.spec.ts sees only its first view. */
test("QA16-USE 2b every view of the sign-in page fits the window and passes axe", async ({ page }) => {
  const portals = ["Admin portal", "Teacher portal", "Student portal", "Parent portal", "Driver portal", "Gate & reception portal"];
  const check = async (label: string, width: number) => {
    await page.waitForTimeout(500);
    for (const f of layoutFindings("signed out", "/signin", width, await measure(page))) findings.push({ ...f, kind: `view ${f.kind}`, detail: `${label}: ${f.detail}` });
    for (const f of await axeFindings(page, "signed out", "/signin", width)) findings.push({ ...f, kind: `view ${f.kind}`, detail: `${label}: ${f.detail}` });
  };
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const name of portals) {
      await page.goto("/signin"); await settle(page, 300);
      await page.getByRole("button", { name }).click({ timeout: 8000 });
      await check(name, width);
      if (name === "Admin portal") { await page.getByRole("button", { name: "Sign in with email instead" }).click({ timeout: 8000 }); await check("Admin portal, email form", width); }
      if (name === "Teacher portal") { await page.getByLabel("School").fill("Alliance"); await check("Teacher portal, school suggestions", width); }
    }
  }
});

// ================================================================ 3. states
const EMPTY_WORDS = /\bno [a-z' ]{2,40}(yet|found|match|on file|to show)|nothing (here|to show|yet)|not (published|set up|billed) yet|\b0 total\b/i;
const ERROR_WORDS = /could not|couldn.t|can.t load|cannot|unable|went wrong|try again|failed|something broke|not available|error/i;
const STATE_SCREENS: [RoleName, string][] = [
  ["school admin", `${S}/admin/people`], ["school admin", `${S}/admin/classes`], ["school admin", `${S}/admin/fees`], ["school admin", `${S}/admin/reports`],
  ["teacher", `${S}/teacher/attendance`], ["parent", `${S}/parent/fees`], ["parent", `${S}/parent/results`], ["student", `${S}/student/results`],
  ["platform admin", "/platform/tenants"], ["platform admin", "/platform/usage"],
];
test("QA16-USE 3a a failed request says so: it never shows an empty list as if it were the data", async ({ page }) => {
  let current: RoleName | null = null;
  for (const [role, route] of STATE_SCREENS) {
    if (role !== current) { await loginAs(page, role); current = role; }
    // load the screen once so the shell is up, then fail every data request and load it again
    await page.goto(route); await settle(page, 300);
    const fail = (r: Route) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "qa16 injected failure", code: "XX000" }) });
    // the session's own reads (who is signed in, which school) are left alone; everything the screen asks for fails
    await page.route("**/rest/v1/**", (r) => { const u = r.request().url(); return u.includes("/rest/v1/profiles") || u.includes("/rest/v1/tenants") ? r.continue() : fail(r); });
    await page.goto(route);
    await page.waitForTimeout(3500);
    const landed = new URL(page.url()).pathname;
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    await page.unroute("**/rest/v1/**");
    const errorShown = ERROR_WORDS.test(text), emptyShown = EMPTY_WORDS.test(text);
    if (landed !== route) findings.push({ role, route, width: 1280, kind: "a data error sends the person elsewhere", detail: `landed on ${landed}` });
    else if (!errorShown) findings.push({ role, route, width: 1280, kind: emptyShown ? "failed request looks like empty data" : "failed request shows no error", detail: `${emptyShown ? 'shows "' + (text.match(EMPTY_WORDS)?.[0] ?? "") + '"' : "no error words"}; text starts: ${text.slice(0, 90)}` });
    notes.push(`3a ${role} ${route}: landed ${landed}, error words ${errorShown}, empty words ${emptyShown}`);
  }
});
test("QA16-USE 3c a failed profile read does not sign the person out", async ({ page }) => {
  let current: RoleName | null = null;
  for (const [role, route] of [STATE_SCREENS[0]!, STATE_SCREENS[4]!, STATE_SCREENS[5]!, STATE_SCREENS[8]!]) {
    if (role !== current) { await loginAs(page, role); current = role; }
    await page.goto(route); await settle(page, 300);
    await page.route("**/rest/v1/profiles**", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "qa16 injected failure", code: "XX000" }) }));
    await page.goto(route);
    await page.waitForTimeout(3500);
    const landed = new URL(page.url()).pathname;
    const text = (await page.locator("body").innerText()).replace(/s+/g, " ");
    await page.unroute("**/rest/v1/profiles**");
    if (landed !== route) findings.push({ role, route, width: 1280, kind: "a failed profile read signs the person out", detail: `landed on ${landed}; the page says: ${text.slice(0, 90)}` });
    else if (!ERROR_WORDS.test(text)) findings.push({ role, route, width: 1280, kind: "a failed profile read shows no error", detail: text.slice(0, 90) });
    notes.push(`3c ${role} ${route}: landed ${landed}`);
  }
});
test("QA16-USE 3b while data loads there is a loading state, and no empty-state flash", async ({ page }) => {
  let current: RoleName | null = null;
  for (const [role, route] of STATE_SCREENS) {
    if (role !== current) { await loginAs(page, role); current = role; }
    await page.route("**/rest/v1/**", async (r) => { await new Promise((res) => setTimeout(res, 3500)); await r.continue().catch(() => undefined); });
    await page.goto(route, { waitUntil: "commit" });
    await page.waitForTimeout(900);
    const probe = await page.evaluate(() => ({
      loading: !!document.querySelector(".animate-pulse, [aria-busy=true], [role=progressbar], [role=status]") || /loading/i.test(document.body.innerText),
      text: document.body.innerText.replace(/\s+/g, " "),
    }));
    await page.waitForTimeout(3500);
    await page.unroute("**/rest/v1/**");
    if (!probe.loading) findings.push({ role, route, width: 1280, kind: "no loading state while data loads", detail: `text at 0.9 s: ${probe.text.slice(0, 80)}` });
    if (EMPTY_WORDS.test(probe.text)) findings.push({ role, route, width: 1280, kind: "empty state shown while data loads", detail: probe.text.match(EMPTY_WORDS)?.[0] ?? "" });
    notes.push(`3b ${role} ${route}: loading indicator ${probe.loading}, empty words ${EMPTY_WORDS.test(probe.text)}`);
  }
});

// ================================================================ 4. double clicks
/** Counts the requests a double click sends. The answer is delayed and faked, so nothing is written and the first request is still in flight when the second click lands. */
async function requestsFor(page: Page, pattern: string, method: string, stub: { status: number; body: string }, action: () => Promise<void>): Promise<number> {
  let n = 0;
  await page.route(pattern, async (route) => {
    if (route.request().method() !== method) { await route.continue(); return; }
    n++;
    await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({ status: stub.status, contentType: "application/json", body: stub.body });
  });
  await action();
  await page.waitForTimeout(2800);
  await page.unroute(pattern);
  return n;
}
const throwaway: string[] = [];
test("QA16-USE 4 a double click on Pay, Submit register, Bill learners and Record payment sends one request", async ({ page }) => {
  const tenant = (await db.from("tenants").select("id").eq("slug", "alliance").single()).data!.id as string;
  const cls = (await db.from("classes").select("id").eq("tenant_id", tenant).eq("name", "Form 1 East").single()).data!.id as string;

  // Pay with M-Pesa (parent)
  await loginAs(page, "parent");
  await page.goto(`${S}/parent/fees`); await settle(page);
  await page.getByRole("button", { name: "Pay with M-Pesa" }).first().click();
  const dlg = page.locator("[role=dialog]").first();
  await expect(dlg).toBeVisible();
  await dlg.getByPlaceholder("e.g. 0712 345 678").fill("0712345678");
  const pay = await requestsFor(page, "**/functions/v1/mpesa-stk-push**", "POST", { status: 503, body: JSON.stringify({ error: "qa16 stub" }) },
    () => dlg.getByRole("button", { name: "Send M-Pesa prompt" }).dblclick());
  notes.push(`4 Pay with M-Pesa, double click: ${pay} request(s)`);
  if (pay !== 1) findings.push({ role: "parent", route: `${S}/parent/fees`, width: 1280, kind: "double click sends more than one request", detail: `Pay with M-Pesa: ${pay} requests to mpesa-stk-push` });

  // Submit register (teacher)
  await loginAs(page, "teacher");
  await page.goto(`${S}/teacher/attendance`); await settle(page);
  // the class list opens on Form 1 East, which has no register for today
  await page.waitForTimeout(800);
  const submit = page.getByRole("button", { name: "Submit register" });
  await expect(submit).toBeVisible();
  const reg = await requestsFor(page, "**/rest/v1/attendance**", "POST", { status: 201, body: "[]" }, () => submit.dblclick());
  notes.push(`4 Submit register, double click: ${reg} request(s)`);
  if (reg !== 1) findings.push({ role: "teacher", route: `${S}/teacher/attendance`, width: 1280, kind: "double click sends more than one request", detail: `Submit register: ${reg} requests to attendance` });

  // Bill learners and Record payment (school admin)
  for (const n of [1, 2, 3]) {
    const r = await db.from("students").insert({ tenant_id: tenant, admission_no: `QA16-B${n}`, full_name: `QA16 Billing ${n}`, gender: "female", class_id: cls }).select("id").single();
    expect(r.error).toBeNull();
    throwaway.push(r.data!.id as string);
  }
  await loginAs(page, "school admin");
  await page.goto(`${S}/admin/fees`); await settle(page);
  await page.getByRole("button", { name: "Bill learners" }).first().click();
  const bill = page.locator("[role=dialog]").first();
  await expect(bill).toBeVisible();
  const create = bill.getByRole("button", { name: /^Create \d+ invoice/ });
  await expect(create).toBeEnabled({ timeout: 15000 });
  const billed = await requestsFor(page, "**/rest/v1/fee_invoices**", "POST", { status: 201, body: "[]" }, () => create.dblclick());
  notes.push(`4 Bill learners, double click: ${billed} request(s) to fee_invoices`);
  if (billed !== 1) findings.push({ role: "school admin", route: `${S}/admin/fees`, width: 1280, kind: "double click sends more than one request", detail: `Bill learners: ${billed} requests to fee_invoices` });

  await page.goto(`${S}/admin/fees`); await settle(page);
  await page.getByRole("button", { name: "Record a payment" }).first().click();
  const rec = page.locator("[role=dialog]").first();
  await expect(rec).toBeVisible();
  await rec.locator("input").first().fill("Alex");
  await page.waitForTimeout(1200);
  await rec.locator("button", { hasText: /ADM|KSh/ }).first().click();
  await rec.getByPlaceholder("e.g. 15000").fill("100");
  const save = rec.getByRole("button", { name: /^Record payment$|^Confirm and record$/ });
  await expect(save).toBeEnabled();
  const recorded = await requestsFor(page, "**/rest/v1/rpc/record_payment**", "POST", { status: 200, body: "null" }, () => save.dblclick());
  notes.push(`4 Record payment, double click: ${recorded} request(s) to record_payment`);
  if (recorded !== 1) findings.push({ role: "school admin", route: `${S}/admin/fees`, width: 1280, kind: "double click sends more than one request", detail: `Record payment: ${recorded} requests to record_payment` });
});

// ================================================================ 5. very long names
const LONG_WORD = "Wolfeschlegelsteinhausenbergerdorffwelchevoralternwarengewissenhaft"; // 66 letters, nowhere to break
const LONG_NAME = "Wanjiru Muthoni-Kamau Ochieng-Odhiambo Mwangi Nyambura-Wangari Chepkoech Kiplagat";
const LONG_SCREENS: [RoleName, string][] = [
  ["school admin", `${S}/admin`], ["school admin", `${S}/admin/people`], ["school admin", `${S}/admin/classes`],
  ["teacher", `${S}/teacher/attendance`], ["teacher", `${S}/teacher/classes`], ["parent", `${S}/parent`], ["parent", `${S}/parent/fees`], ["student", `${S}/student`],
  ["platform admin", "/platform/tenants"],
];
const renamed: { table: string; column: string; id: string; original: string }[] = [];
async function rename(table: string, column: string, id: string, to: string) {
  const before = await db.from(table).select(column).eq("id", id).single();
  expect(before.error).toBeNull();
  renamed.push({ table, column, id, original: (before.data as unknown as Record<string, string>)[column]! });
  expect((await db.from(table).update({ [column]: to }).eq("id", id)).error).toBeNull();
}
test("QA16-USE 5 very long names do not break the screens that show them", async ({ page }) => {
  const tenant = (await db.from("tenants").select("id, name").eq("slug", "alliance").single()).data!;
  const profile = async (loginId: string) => (await db.from("profiles").select("id").eq("tenant_id", tenant.id as string).eq("login_id", loginId).single()).data!.id as string;
  const faith = (await db.from("students").select("id").eq("tenant_id", tenant.id as string).eq("admission_no", "4102").single()).data!.id as string;
  const form4 = (await db.from("classes").select("id").eq("tenant_id", tenant.id as string).eq("name", "Form 4 West").single()).data!.id as string;

  const before = new Map<string, Set<string>>();
  const sweep = async (tag: "before" | "after") => {
    let current: RoleName | null = null;
    for (const width of [1280, 390]) for (const [role, route] of LONG_SCREENS) {
      if (role !== current) { await loginAs(page, role, width); current = role; } else await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(route); await settle(page);
      if (route.endsWith("/people")) { await page.getByLabel("Search people").fill(tag === "after" ? "Wolfe" : "Faith"); await page.waitForTimeout(700); }
      const m = await measure(page);
      const key = `${role} ${route} @${width}`;
      const kinds = new Set(layoutFindings(role, route, width, m).map((f) => `${f.kind}: ${f.detail}`));
      if (tag === "before") before.set(key, kinds);
      else for (const k of kinds) if (!before.get(key)?.has(k)) findings.push({ role, route, width, kind: "long name breaks the layout", detail: k });
    }
  };
  await sweep("before");
  await rename("tenants", "name", tenant.id as string, `${tenant.name as string} ${LONG_NAME}`);
  await rename("students", "full_name", faith, LONG_WORD);
  await rename("profiles", "full_name", await profile("PT-0002"), LONG_NAME);
  await rename("profiles", "full_name", await profile("TC-0002"), LONG_NAME);
  await rename("classes", "name", form4, `${LONG_WORD.slice(0, 40)} Form 4 West`);
  await sweep("after");
});

// ================================================================ 6. accessibility preferences
const PREF_ROLES: [RoleName, string][] = [
  ["school admin", `${S}/admin`], ["teacher", `${S}/teacher/attendance`], ["parent", `${S}/parent`], ["student", `${S}/student`],
  ["platform admin", "/platform/tenants"], ["group admin", "/org/kijani-ridge-group/dashboard"], ["driver", `${S}/driver`],
];
test("QA16-USE 6 the accessibility preferences apply, last, and leave the screens usable", async ({ page }) => {
  for (const [role, route] of PREF_ROLES) {
    await loginAs(page, role);
    await page.goto(route); await settle(page);
    const arrived = await page.evaluate(() => ({ zoom: document.getElementById("root")?.style.zoom ?? "", contrast: document.documentElement.hasAttribute("data-a11y-contrast") }));
    const button = page.getByRole("button", { name: "Accessibility settings" }).first();
    if (!(await button.count())) { findings.push({ role, route, width: 1280, kind: "no way to open the accessibility settings", detail: "the screen has no Accessibility settings button" }); notes.push(`6 ${role}: no button`); continue; }
    await button.click({ timeout: 8000 });
    await page.getByRole("radio", { name: /Largest/ }).click({ timeout: 8000 });
    // the saved choice belongs to the browser, so the previous person's may already be on: only switch it on, never off
    if (!(await page.getByRole("switch", { name: /Higher contrast/ }).isChecked({ timeout: 8000 }))) await page.getByText("Higher contrast", { exact: true }).click({ timeout: 8000 });
    await page.getByRole("button", { name: "Done" }).click();
    const applied = await page.evaluate(() => ({ zoom: document.getElementById("root")?.style.zoom ?? "", contrast: document.documentElement.hasAttribute("data-a11y-contrast") }));
    await page.reload(); await settle(page);
    const kept = await page.evaluate(() => ({ zoom: document.getElementById("root")?.style.zoom ?? "", contrast: document.documentElement.hasAttribute("data-a11y-contrast") }));
    if (applied.zoom !== "1.5" || !applied.contrast) findings.push({ role, route, width: 1280, kind: "preference does not apply", detail: `zoom ${applied.zoom}, contrast ${applied.contrast}` });
    if (kept.zoom !== "1.5" || !kept.contrast) findings.push({ role, route, width: 1280, kind: "preference is not kept after a reload", detail: `zoom ${kept.zoom}, contrast ${kept.contrast}` });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(route); await settle(page);
      for (const f of layoutFindings(role, route, width, await measure(page))) findings.push({ ...f, kind: `at the largest text size: ${f.kind}` });
      if (width === 1280) for (const f of (await axeFindings(page, role, route, width)).filter((x) => x.kind.endsWith("color-contrast"))) findings.push({ ...f, kind: "high contrast mode still fails contrast" });
    }
    notes.push(`6 ${role}: arrived with ${JSON.stringify(arrived)}, applied ${JSON.stringify(applied)}, kept ${JSON.stringify(kept)}`);
  }
});

// ================================================================ what the tests found
const DIALOG_FIT = ["dialog wider than the window", "dialog button off screen", "dialog clipped control", "dialog text hidden", "dialog content scrolls sideways", "dialog overflow", "dialog broken image", "dialog blank"];

const KNOWN: Known[] = [
  { tag: "QA16-DIALOG-WIDTH", fig: "FIG-1471", what: "every dialog fits a 390 px window",
    match: (f) => DIALOG_FIT.includes(f.kind) && f.width === 390 },
  { tag: "QA16-MODAL-FOCUS", fig: "FIG-1480", what: "a dialog keeps Tab inside it and returns focus to the button that opened it",
    match: (f) => f.kind === "focus leaves the dialog" || f.kind === "focus is not returned to the opener" },
  { tag: "QA16-SIGNIN-FORM", fig: "FIG-1479", what: "Enter signs in, and focus moves on when the sign-in view changes",
    match: (f) => f.kind === "Enter does not submit the sign-in form" || f.kind === "focus is lost when the view changes" },
  { tag: "QA16-ERROR-STATES", fig: "FIG-1474", what: "a failed request shows an error, never an empty list or nothing",
    match: (f) => f.kind === "failed request looks like empty data" || f.kind === "failed request shows no error" },
  { tag: "QA16-PROFILE-SIGNOUT", fig: "FIG-1475", what: "a failed profile read does not sign the person out",
    match: (f) => f.kind === "a failed profile read signs the person out" },
  { tag: "QA16-LONG-NAMES", fig: "FIG-1482", what: "very long names do not push a phone screen sideways",
    match: (f) => f.kind === "long name breaks the layout" },
  { tag: "QA16-LARGEST-TEXT", fig: "FIG-1483", what: "at the Largest text size a phone screen has nothing cut off or scrolling sideways",
    match: (f) => f.width === 390 && f.kind.startsWith("at the largest text size: ") },
  { tag: "QA16-DRIVER-SETTINGS", fig: "FIG-1484", what: "the driver's page has an Accessibility settings button",
    match: (f) => f.kind === "no way to open the accessibility settings" },
  { tag: "QA16-CONTRAST", fig: "FIG-1478", what: "dialogs, the sign-in views and screens in Higher contrast meet the 4.5 to 1 contrast minimum",
    match: (f) => (f.kind === "dialog axe serious color-contrast" || f.kind === "view axe serious color-contrast" || f.kind === "high contrast mode still fails contrast") && isKnownContrast(f) },
];
defineKnownTests(test, "QA16-USE", KNOWN, findings, () => notes.length > 0);

// ================================================================ cleanup and report
test.afterAll(async () => {
  const errors: string[] = [];
  for (const r of [...renamed].reverse()) { const x = await db.from(r.table).update({ [r.column]: r.original }).eq("id", r.id); if (x.error) errors.push(`${r.table}.${r.column}: ${x.error.message}`); }
  if (throwaway.length) { const x = await db.from("students").delete().in("id", throwaway); if (x.error) errors.push(`throwaway learners: ${x.error.message}`); }
  const left = (await db.from("students").select("id", { count: "exact", head: true }).like("admission_no", "QA16-%")).count;
  if (left) errors.push(`${left} QA16 learners are left`);
  const out = process.env.QA16_OUT2;
  if (out) writeFileSync(out, JSON.stringify({ findings, notes }, null, 1));
  console.log(`\nQA16 usability: ${findings.length} findings\n${notes.join("\n")}`);
  if (errors.length) throw new Error(`cleanup failed, run the file again to sweep: ${errors.join("; ")}`);
});
