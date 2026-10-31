import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { axeFindings, defineKnownTests, isKnownContrast, layoutFindings, LOGINS, measure, S, type Finding, type Known, type RoleName } from "./support/qa16";

process.loadEnvFile?.(); // Node 20.6+ built-in
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

/**
 * QA 16 (FIG-1249): every screen of every role, at 1280, 768 and 390 px wide. For each screen and width this records
 *   - a page wider than the window, a control or a figure cut off by its box, a broken image, a blank screen,
 *   - console errors, page errors and failed requests,
 *   - at 1280 and 390: the serious and critical axe violations (WCAG 2.0 and 2.1, levels A and AA, which includes colour contrast).
 * Desktop project only: the width is set here, so the phone project would repeat the same checks.
 * The keyboard, dialog, error-state, double-click and long-name checks are in usability.spec.ts.
 *
 * Known defects: each one has a test below (tagged QA16-... FIG-n) that asserts the screens are fine and is expected to fail
 * (test.fail), so the suite is green today and goes red when a fix lands, as a reminder to delete the test.
 * The last test fails on any finding that no known-defect entry accounts for, so a new problem cannot slip in.
 * To run one known defect alone: -g "QA16-WALK|QA16-NAME" (the walk gathers the findings the others read).
 */

const WIDTHS = [1280, 768, 390] as const;
const AXE_WIDTHS: readonly number[] = [1280, 390];

interface Role { key: RoleName; routes: string[] }
const ROLES: Role[] = [
  { key: "platform admin",
    routes: ["tenants", "organizations", "curriculum", "usage", "subscriptions", "invoices", "health", "incidents", "impersonation", "audit"].map((x) => `/platform/${x}`) },
  { key: "school admin",
    routes: ["", "/people", "/fees", "/announcements", "/fleet", "/settings", "/classes", "/subjects", "/reports", "/performance", "/leave", "/inventory", "/exams", "/papers", "/materials", "/report-cards", "/chats", "/account", "/activities", "/visitors", "/bloom"].map((x) => `${S}/admin${x}`) },
  { key: "teacher",
    routes: ["attendance", "gradebook", "timetable", "classes", "sections", "messages", "notices", "leave", "items", "homework", "exams", "materials", "report-cards", "performance", "buses", "chats", "account", "activities", "visitors", "bloom"].map((x) => `${S}/teacher/${x}`) },
  { key: "parent",
    routes: ["", "/fees", "/results", "/homework", "/materials", "/bus", "/inbox", "/chats", "/items", "/settings", "/activities"].map((x) => `${S}/parent${x}`) },
  { key: "student",
    routes: ["", "/timetable", "/work", "/materials", "/exams", "/results", "/study-helper", "/fees", "/chats", "/notices", "/activities", "/items"].map((x) => `${S}/student${x}`) },
  { key: "driver", routes: [`${S}/driver`, `${S}/driver/profile`] },
  { key: "group admin",
    routes: ["dashboard", "schools", "admins", "audit"].map((x) => `/org/kijani-ridge-group/${x}`) },
  // the gate and reception screens (GD-0001, RC-0001) are not here: this branch still has the guard and receptionist roles, and the
  // local database has main's schema, which removed them in favour of "staff", so those two logins cannot sign in. Add them after main is merged.
  { key: "signed out", routes: ["/signin", "/signup", "/reset-password", "/org-picker", "/no-such-page"] },
];

const findings: Finding[] = [];
const visited: { role: string; route: string; width: number; landed: string }[] = [];

test.describe.configure({ mode: "serial", timeout: 900_000 });
test.skip(({ isMobile }) => isMobile, "the width is set inside the test");

test.beforeAll(async () => {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.SUPABASE_URL ?? "")) throw new Error("local Supabase only");
  await db.from("login_lookups").delete().gte("looked_up_at", "1970-01-01"); // same reason as flows.spec.ts
  // one school's page in the group console: its address carries the school's id
  const org = (await db.from("organizations").select("id").eq("slug", "kijani-ridge-group").single()).data;
  const school = org && (await db.from("tenants").select("id").eq("organization_id", org.id as string).order("name").limit(1).single()).data;
  if (school) ROLES.find((r) => r.key === "group admin")!.routes.push(`/org/kijani-ridge-group/schools/${school.id as string}`);
});

for (const role of ROLES) {
  test(`QA16-WALK ${role.key}: every screen at 1280, 768 and 390 px`, async ({ page }) => {
    const log: { type: string; text: string }[] = [];
    let current = "";
    // the Vite dev server's hot-reload socket and "network suspended" (the laptop slept) are the machine's, not the app's
    const machineNoise = /WebSocket connection to 'ws:\/\/localhost:5173|ERR_NETWORK_IO_SUSPENDED/;
    page.on("console", (m) => { if (m.type() === "error" && !machineNoise.test(m.text())) log.push({ type: "console error", text: `${current} ${m.text()}`.slice(0, 220) }); });
    page.on("pageerror", (e) => log.push({ type: "page error", text: `${current} ${e.message}`.slice(0, 220) }));
    // a request the page cancelled itself when we moved to the next screen (the HEAD row counts) is not a failure
    page.on("requestfailed", (r) => { if (!/favicon|fonts\./.test(r.url()) && !machineNoise.test(r.failure()?.errorText ?? "") && r.failure()?.errorText !== "net::ERR_ABORTED") log.push({ type: "request failed", text: `${current} ${r.method()} ${r.url().slice(0, 100)} ${r.failure()?.errorText}` }); });
    page.on("response", (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) log.push({ type: `http ${r.status()}`, text: `${current} ${r.request().method()} ${r.url().slice(0, 110)}` }); });

    await page.setViewportSize({ width: 1280, height: 900 });
    await LOGINS[role.key](page);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const route of role.routes) {
        current = `[${role.key} ${route} @${width}]`;
        const before = log.length;
        await page.goto(route);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(700); // the screens fetch after first paint
        visited.push({ role: role.key, route, width, landed: new URL(page.url()).pathname });
        for (const f of layoutFindings(role.key, route, width, await measure(page))) if (!findings.some((x) => x.role === f.role && x.route === f.route && x.width === f.width && x.kind === f.kind && x.detail === f.detail)) findings.push(f); // the same cut-off button can be in a list seven times
        for (const entry of log.slice(before)) findings.push({ role: role.key, route, width, kind: entry.type, detail: entry.text });
        if (AXE_WIDTHS.includes(width)) findings.push(...await axeFindings(page, role.key, route, width));
      }
    }
  });
}

// ================================================================ what the walk found
const LAYOUT_KINDS = ["content scrolls sideways", "overflow", "clipped control", "text hidden", "broken image", "blank"];
/** A layout problem on a phone or tablet width on one of these screens (at 1280 px every screen is clean, so a problem there is never excused). */
const smallScreen = (f: Finding, screens: [RoleName, string][]) => LAYOUT_KINDS.includes(f.kind) && f.width < 1280 && screens.some(([role, route]) => f.role === role && f.route === route);
const ADMIN = `${S}/admin`, TEACHER = `${S}/teacher`, PARENT = `${S}/parent`, STUDENT = `${S}/student`;

const KNOWN: Known[] = [
  { tag: "QA16-ANNOUNCE-PHONE", fig: "FIG-1472", what: "the Announcements composer fits a phone and a tablet",
    match: (f) => smallScreen(f, [["school admin", `${ADMIN}/announcements`]]) },
  { tag: "QA16-FEES-PHONE", fig: "FIG-1473", what: "the three Fees screens fit a phone",
    match: (f) => smallScreen(f, [["school admin", `${ADMIN}/fees`], ["parent", `${PARENT}/fees`], ["student", `${STUDENT}/fees`]]) },
  { tag: "QA16-SIGNUP-PHONE", fig: "FIG-1485", what: "the organization sign-up page fits a phone",
    match: (f) => smallScreen(f, [["signed out", "/signup"]]) },
  { tag: "QA16-ORGPICKER-RENDER", fig: "FIG-1486", what: "the organization picker logs no console error",
    match: (f) => f.kind === "console error" && f.role === "signed out" && f.route === "/org-picker" },
  { tag: "QA16-PHONE-OTHER", fig: "FIG-1481", what: "twelve more screens fit a phone",
    match: (f) => (LAYOUT_KINDS.includes(f.kind) && f.width < 1280 && f.role === "group admin" && /\/schools\/[0-9a-f-]{36}$/.test(f.route)) || smallScreen(f, [
      ["school admin", ADMIN], ["school admin", `${ADMIN}/fleet`], ["teacher", `${TEACHER}/gradebook`], ["teacher", `${TEACHER}/timetable`], ["teacher", `${TEACHER}/notices`],
      ["teacher", `${TEACHER}/leave`], ["parent", `${PARENT}/inbox`], ["parent", `${PARENT}/settings`], ["student", `${STUDENT}/work`], ["student", `${STUDENT}/notices`],
      ["group admin", "/org/kijani-ridge-group/dashboard"],
    ]) },
  { tag: "QA16-TABLE-ARIA", fig: "FIG-1476", what: "the shared table has no axe critical violation",
    match: (f) => /^axe critical aria-required-(children|parent)$/.test(f.kind) && (f.nodes ?? []).every((n) => /role="(row|columnheader|cell|gridcell|rowheader)"/.test(n.html)) },
  { tag: "QA16-SCROLL-FOCUS", fig: "FIG-1477", what: "every scrolling box can be reached with the keyboard",
    match: (f) => f.kind === "axe serious scrollable-region-focusable" && (f.nodes ?? []).every((n) => /overflow(-[xy])?-auto/.test(n.html)) },
  { tag: "QA16-CONTRAST", fig: "FIG-1478", what: "text meets the 4.5 to 1 contrast minimum",
    match: (f) => f.kind === "axe serious color-contrast" && isKnownContrast(f) },
];

test("QA16-WALK-COVERAGE every screen was visited at three widths and none sent the person elsewhere", () => {
  test.skip(visited.length === 0, "reads what the walk found: run it with -g QA16-WALK");
  const expected = ROLES.reduce((n, r) => n + r.routes.length, 0) * WIDTHS.length;
  const expectedLanding = (route: string) => (route === "/org-picker" ? "/signin" : route); // someone who is not an organization admin is sent to sign in
  const moved = visited.filter((v) => v.landed.replace(/\/$/, "") !== expectedLanding(v.route).replace(/\/$/, "")).map((v) => `${v.role} ${v.route} @${v.width} landed on ${v.landed}`);
  expect({ visits: visited.length, moved }).toEqual({ visits: expected, moved: [] });
});

defineKnownTests(test, "QA16-WALK", KNOWN, findings, () => visited.length > 0);

test.afterAll(() => {
  const out = process.env.QA16_OUT; // debugging aid: everything the walk saw, for working out what a finding is
  if (out) writeFileSync(out, JSON.stringify({ findings, visited }, null, 1));
  console.log(`\nQA16: ${visited.length} screen visits, ${findings.length} findings`);
});
