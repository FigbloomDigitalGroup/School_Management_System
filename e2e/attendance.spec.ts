import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { today as schoolToday } from "../packages/shared/src/attendance";

process.loadEnvFile?.(); // Node 20.6+ built-in
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

/**
 * QA 10 (FIG-1243): attendance figures on each screen against the rows they are built from, and what the teacher's register and
 * the offline queue do in a browser.
 *
 * The expected numbers are worked out here from the attendance rows (read with the service role, counted with plain loops), not by
 * calling any of the app's own code. Each screen is then read as a person sees it. Seed data only (npm run db:seed and db:seed-org):
 * Alliance has ten days of registers for Form 2 West (the first ten school days of the term, to 2026-09-11), Kijani Ridge has registers for five classes from the start of
 * the term to 2026-10-27, and neither school has taken a register today. The tests that write (the teacher's register, the queue)
 * clear today's Alliance rows before and after, as flows.spec.ts does; the one that archives a learner puts them back.
 * supabase/rls-checks/attendance.sql and tests/integration/attendance.test.ts ask the same questions without a browser.
 *
 * Known defects use test.fail(): they pass while the defect exists and fail the day it is fixed. Then remove test.fail().
 * Prints a side-by-side table of every figure at the end (the QA 10 comment in Linear uses it).
 */
test.describe.configure({ mode: "serial", timeout: 90_000 });

const PASSWORD = "figbloom-dev";
const table: string[][] = [["Screen", "Figure", "Database", "Screen shows"]];

test.beforeAll(async () => {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.SUPABASE_URL ?? "")) throw new Error("local Supabase only");
  await db.from("login_lookups").delete().gte("looked_up_at", "1970-01-01"); // same reason as flows.spec.ts
});

test.afterAll(() => {
  const widths = table[0]!.map((_, c) => Math.max(...table.map((r) => r[c]!.length)));
  console.log("\n" + table.map((r) => "| " + r.map((cell, c) => cell.padEnd(widths[c]!)).join(" | ") + " |").join("\n"));
});

// ---------------------------------------------------------------- the database side
interface Att { class_id: string; student_id: string; mark: string; taken_on: string }
const isHere = (mark: string) => mark === "present" || mark === "late";
/** Today in the school's time zone (Africa/Nairobi), which is the date the app files a register under (FIG-1400): not the UTC date. */
const todayInSchool = () => schoolToday();

async function pages<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

async function school(slug: string) {
  const t = await db.from("tenants").select("id").eq("slug", slug).single();
  const tenantId = t.data!.id as string;
  const term = await db.from("terms").select("id").eq("tenant_id", tenantId).eq("is_current", true).single();
  const classes = (await db.from("classes").select("id, name").eq("tenant_id", tenantId).order("name")).data as { id: string; name: string }[];
  const learners = await pages<{ id: string; class_id: string; full_name: string; admission_no: string }>((a, b) =>
    db.from("students").select("id, class_id, full_name, admission_no").eq("tenant_id", tenantId).eq("active", true).order("id").range(a, b));
  const rows = await pages<Att>((a, b) =>
    db.from("attendance").select("class_id, student_id, mark, taken_on").eq("tenant_id", tenantId).eq("term_id", term.data!.id as string).order("taken_on").order("student_id").range(a, b));
  return { tenantId, termId: term.data!.id as string, classes, learners, rows };
}

/** What the Dashboard should say about one date: per class, who was here, late and absent, against the active roster. */
function dashboardFor(s: Awaited<ReturnType<typeof school>>, date: string) {
  const onDate = s.rows.filter((r) => r.taken_on === date);
  const perClass = new Map<string, { here: number; late: number; absent: number; total: number; submitted: boolean }>();
  for (const c of s.classes) {
    const mine = onDate.filter((r) => r.class_id === c.id);
    perClass.set(c.id, {
      here: mine.filter((r) => isHere(r.mark)).length, late: mine.filter((r) => r.mark === "late").length, absent: mine.filter((r) => r.mark === "absent").length,
      total: s.learners.filter((l) => l.class_id === c.id).length, submitted: mine.length > 0,
    });
  }
  const submitted = [...perClass.values()].filter((c) => c.submitted);
  const hereSum = submitted.reduce((a, c) => a + c.here, 0), rosterSum = submitted.reduce((a, c) => a + c.total, 0);
  return { perClass, submitted: submitted.length, percent: `${Math.round((hereSum / Math.max(rosterSum, 1)) * 100)}%` };
}

const latestDate = (s: Awaited<ReturnType<typeof school>>) => s.rows.reduce((m, r) => (r.taken_on > m ? r.taken_on : m), "");

// ---------------------------------------------------------------- the screen side
async function textLines(page: Page): Promise<string[]> {
  await page.waitForLoadState("networkidle");
  return (await page.locator("body").innerText()).split("\n").map((l) => l.trim()).filter(Boolean);
}
/** The n lines after a label. Labels are upper-cased by CSS, and innerText follows that, so compare without case. */
function after(lines: string[], label: string, n: number): string[] {
  const i = lines.findIndex((l) => l.toLowerCase() === label.toLowerCase());
  expect(i, `"${label}" is on the screen`).toBeGreaterThanOrEqual(0);
  return lines.slice(i + 1, i + 1 + n);
}
function same(screen: string, figure: string, database: string, shown: string | undefined) {
  table.push([screen, figure, database, shown ?? "(missing)"]);
  expect(shown, `${screen}: ${figure}`).toBe(database);
}

async function waitForSignedIn(page: Page) {
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 15000 });
}
async function signInEmail(page: Page, email: string) {
  await page.goto("/signin");
  await page.getByRole("button", { name: "Admin portal" }).click();
  await page.getByRole("button", { name: "Sign in with email instead" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await waitForSignedIn(page);
}
async function signInWithId(page: Page, schoolName: string, loginId: string, portal: string) {
  await page.goto("/signin");
  await page.getByRole("button", { name: `${portal} portal` }).click();
  await page.getByLabel("School").fill(schoolName);
  await page.getByRole("button").filter({ hasText: schoolName }).first().click();
  await page.getByLabel("Your ID").fill(loginId);
  await page.getByLabel("Your ID").blur();
  await expect(page.getByText(/^Signing in as /)).toBeVisible({ timeout: 5000 });
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await waitForSignedIn(page);
}
/** The session ends, but whatever the app stored on this device (the held registers) stays, as when someone signs out. */
async function endSession(page: Page) {
  await page.evaluate(() => { for (const k of Object.keys(window.localStorage)) if (k.startsWith("sb-")) window.localStorage.removeItem(k); });
  await page.goto("/signin");
}

const SCHOOLS = [
  { slug: "alliance", name: "Alliance High School", admin: "principal@alliance.sc.ke" },
  { slug: "kijani-ridge", name: "Kijani Ridge Academy", admin: "head@kijaniridge.sc.ke" },
] as const;

// ================================================================ the admin Dashboard
test.describe("admin Dashboard: the card and the by-class list against the rows", () => {
  for (const s of SCHOOLS) {
    test(`${s.slug}: the figures are the rows of the most recent register on file`, async ({ page }) => {
      const d = await school(s.slug);
      const date = latestDate(d);
      const exp = dashboardFor(d, date);
      await signInEmail(page, s.admin);
      const t0 = Date.now();
      await page.goto(`/s/${s.slug}/admin`);
      await expect(page.getByText(/classes submitted/).first()).toBeVisible({ timeout: 30000 });
      table.push([`Dashboard ${s.slug}`, "seconds until the figures appear", "-", String(Math.round((Date.now() - t0) / 100) / 10)]);
      const lines = await textLines(page);

      const card = after(lines, "Attendance today", 2);
      same(`Dashboard ${s.slug}`, "attendance %", exp.percent, card[0]);
      same(`Dashboard ${s.slug}`, "classes submitted", `${exp.submitted} of ${d.classes.length} classes submitted`, card[1]);

      const h = lines.findIndex((l) => l.toLowerCase().startsWith("attendance by class ·"));
      expect(h, "the by-class list is on the screen").toBeGreaterThanOrEqual(0);
      same(`Dashboard ${s.slug}`, "date of the by-class list", date, lines[h]!.split("·")[1]!.trim());
      const names = new Set(d.classes.map((c) => c.name));
      for (const c of d.classes) {
        const start = lines.indexOf(c.name, h + 1);
        expect(start, `${c.name} is in the list`).toBeGreaterThan(h);
        let end = start + 1;
        while (end < lines.length && !names.has(lines[end]!)) end++;
        const block = lines.slice(start + 1, end);
        const e = exp.perClass.get(c.id)!;
        if (!e.submitted) { same(`Dashboard ${s.slug}`, `${c.name}: not taken`, "Not taken", block[0]); continue; }
        same(`Dashboard ${s.slug}`, `${c.name}: here / on roll`, `${e.here} / ${e.total}`, block.find((l) => /^\d+ \/ \d+$/.test(l)));
        const note = [e.late > 0 ? `${e.late} late` : "", e.absent > 0 ? `${e.absent} absent` : ""].filter(Boolean).join(" · ");
        if (note) same(`Dashboard ${s.slug}`, `${c.name}: late / absent`, note, block.find((l) => /late|absent/.test(l)));
      }
    });
  }

  test("alliance: 'who wasn't here' lists the learners marked late, absent or excused on that date, and nobody else", async ({ page }) => {
    const d = await school("alliance");
    const date = latestDate(d);
    const form2West = d.classes.find((c) => c.name === "Form 2 West")!;
    const label: Record<string, string> = { late: "Late", absent: "Absent", excused: "Excused" };
    const expected = d.rows.filter((r) => r.taken_on === date && r.class_id === form2West.id && r.mark !== "present")
      .map((r) => { const l = d.learners.find((x) => x.id === r.student_id)!; return `${l.full_name}|${l.admission_no}|${label[r.mark]}`; }).sort();
    expect(expected.length, "the seeded day has at least one learner away").toBeGreaterThan(0);

    await signInEmail(page, SCHOOLS[0].admin);
    await page.goto("/s/alliance/admin");
    const here = dashboardFor(d, date).perClass.get(form2West.id)!;
    await page.getByRole("button", { name: `${here.here} / ${here.total}` }).click();
    await expect(page.getByText("Form 2 West · who wasn't here")).toBeVisible();
    const lines = await textLines(page);
    const t = lines.findIndex((l) => l.toLowerCase() === "form 2 west · who wasn't here");
    const shown: string[] = [];
    for (let i = t + 1; i < lines.length && lines[i]!.toLowerCase() !== "close"; i++) {
      const m = /^ADM (.+)$/.exec(lines[i]!);
      if (m) shown.push(`${lines[i - 1]}|${m[1]}|${lines[i + 1]}`);
    }
    table.push(["AttendanceDetail alliance", "learners away on " + date, String(expected.length), String(shown.length)]);
    expect(shown.sort()).toEqual(expected);
  });

  test("KNOWN QA10-TODAY FIG-1401 (open): with no register taken yet today, 'Attendance today' does not show an earlier day", async ({ page }) => {
    test.fail();
    const d = await school("alliance");
    expect(d.rows.some((r) => r.taken_on === todayInSchool()), "nothing has been taken in Alliance today").toBe(false);
    await signInEmail(page, SCHOOLS[0].admin);
    await page.goto("/s/alliance/admin");
    await expect(page.getByText(/classes submitted/).first()).toBeVisible();
    const card = after(await textLines(page), "Attendance today", 2);
    table.push(["Dashboard alliance", "attendance today, no register yet today", "— / 0 of 8", `${card[0]} / ${card[1]}`]);
    expect(card[0]).toBe("—");
    expect(card[1]).toBe(`0 of ${d.classes.length} classes submitted`);
  });

  // FIG-1409 (QA10-ARCHIVE) was a known bug: "here" came from the day's register rows and "on roll" from active learners, so archiving a
  // learner who was present moved only the second number. Fixed by FIG-1514 decision J: both numbers are now the day's counted register
  // entries, so the archived learner still counts on both sides, as the register was taken. Normal assertion from here on.
  test("QA10-ARCHIVE FIG-1409 (fixed by FIG-1514): a learner archived after the register still counts on both sides of 'here / on roll'", async ({ page }) => {
    const d = await school("kijani-ridge");
    const date = latestDate(d);
    const exp = dashboardFor(d, date);
    const target = d.classes.map((c) => ({ c, e: exp.perClass.get(c.id)! })).filter((x) => x.e.submitted).sort((a, b) => b.e.total - a.e.total)[0]!;
    const present = d.rows.find((r) => r.taken_on === date && r.class_id === target.c.id && r.mark === "present")!;
    try {
      const up = await db.from("students").update({ active: false }).eq("id", present.student_id);
      expect(up.error).toBeNull();
      await signInEmail(page, SCHOOLS[1].admin);
      await page.goto("/s/kijani-ridge/admin");
      await expect(page.getByText(/classes submitted/).first()).toBeVisible({ timeout: 30000 });
      const lines = await textLines(page);
      const h = lines.findIndex((l) => l.toLowerCase().startsWith("attendance by class ·"));
      const start = lines.indexOf(target.c.name, h + 1);
      const shown = lines.slice(start + 1, start + 6).find((l) => /^\d+ \/ \d+$/.test(l));
      // Decision J: the figure is the register as it was taken, so the archived learner counts on both sides.
      const asItWas = `${target.e.here} / ${target.e.total}`;
      table.push(["Dashboard kijani-ridge", `${target.c.name}: after archiving one learner who was present`, asItWas, shown ?? "(missing)"]);
      expect(shown).toBe(asItWas);
    } finally {
      await db.from("students").update({ active: true }).eq("id", present.student_id);
    }
  });
});

// ================================================================ Reports
test.describe("admin Reports: the term's attendance against the rows", () => {
  async function reportsMatch(page: Page, slug: (typeof SCHOOLS)[number]) {
    const d = await school(slug.slug);
    const here = d.rows.filter((r) => isHere(r.mark)).length;
    await signInEmail(page, slug.admin);
    await page.goto(`/s/${slug.slug}/admin/reports`);
    await expect(page.getByText(/register entries this term/).first()).toBeVisible({ timeout: 30000 });
    const lines = await textLines(page);
    const card = after(lines, "Attendance", 2);
    same(`Reports ${slug.slug}`, "term attendance %", `${Math.round((here / d.rows.length) * 100)}%`, card[0]);
    same(`Reports ${slug.slug}`, "register entries this term", `${d.rows.length.toLocaleString()} register entries this term`, card[1]);
    const h = lines.findIndex((l) => l.toLowerCase() === "attendance by class · this term");
    expect(h, "the by-class table is on the screen").toBeGreaterThanOrEqual(0);
    const tableLines = lines.slice(h + 1);
    for (const c of d.classes) {
      const mine = d.rows.filter((r) => r.class_id === c.id);
      const i = tableLines.indexOf(c.name);
      expect(i, `${c.name} is in the table`).toBeGreaterThanOrEqual(0);
      same(`Reports ${slug.slug}`, `${c.name}: rate`, mine.length ? `${Math.round((mine.filter((r) => isHere(r.mark)).length / mine.length) * 100)}%` : "No data", tableLines[i + 1]);
      same(`Reports ${slug.slug}`, `${c.name}: entries`, String(mine.length), tableLines[i + 2]);
    }
  }

  test("alliance: the term's percentage, entries and each class's rate are the rows", async ({ page }) => {
    await reportsMatch(page, SCHOOLS[0]);
  });

  test("QA10-REPORTS FIG-1402: kijani-ridge, whose term has more than 1,000 register entries, is counted in full", async ({ page }) => {
    await reportsMatch(page, SCHOOLS[1]);
  });
});

// ================================================================ the parent's screen
test.describe("parent Home: the child's attendance", () => {
  test("Faith's percentage is her rows (present + late over every row); the seed has only this term's", async ({ page }) => {
    const d = await school("alliance");
    const faith = (await db.from("students").select("id").eq("admission_no", "4102").eq("tenant_id", d.tenantId).single()).data!.id as string;
    const mine = d.rows.filter((r) => r.student_id === faith);
    expect(mine.length, "the seed gives Faith ten days").toBe(10);
    await signInWithId(page, SCHOOLS[0].name, "PT-0002", "Parent");
    await page.goto("/s/alliance/parent");
    await expect(page.getByText("Faith").first()).toBeVisible();
    const lines = await textLines(page);
    const card = after(lines, "Attendance", 2);
    same("Parent Home", "Faith: attendance %", `${Math.round((mine.filter((r) => isHere(r.mark)).length / mine.length) * 100)}%`, card[0]);
    same("Parent Home", "Faith: caption", "this term", card[1]);
  });
});

// ================================================================ the teacher's register in a browser
test.describe("teacher register", () => {
  const todayRows = async () => {
    const t = await db.from("tenants").select("id").eq("slug", "alliance").single();
    return pages<{ id: string; mark: string; students: { full_name: string } | null; class_id: string }>((a, b) =>
      db.from("attendance").select("id, mark, class_id, students(full_name)").eq("tenant_id", t.data!.id as string).eq("taken_on", todayInSchool()).order("id").range(a, b)
        .returns<{ id: string; mark: string; students: { full_name: string } | null; class_id: string }[]>());
  };
  const clearToday = async () => {
    const t = await db.from("tenants").select("id").eq("slug", "alliance").single();
    await db.from("attendance").delete().eq("tenant_id", t.data!.id as string).eq("taken_on", todayInSchool());
  };
  const openRegister = async (page: Page) => {
    await signInWithId(page, SCHOOLS[0].name, "TC-0002", "Teacher");
    await page.goto("/s/alliance/teacher/attendance");
    await expect(page.getByText("Everyone starts present")).toBeVisible();
    // The register opens on the teacher's first class; choose the one these tests are worked out for.
    await page.getByLabel("Class").selectOption({ label: "Form 2 West" });
    await expect(page.getByText("Everyone starts present")).toBeVisible();
    await expect(page.getByText(/^43 learners$/)).toBeVisible();
  };
  const nameOf = async (page: Page, i: number) => (await page.getByRole("listitem").nth(i).locator("div.truncate").first().innerText()).trim();

  test.beforeEach(clearToday);
  test.afterAll(clearToday);

  test("submitting, then correcting and submitting again, leaves one row per learner, and the card shows the counts", async ({ page }) => {
    await openRegister(page);
    const n0 = await nameOf(page, 0), n1 = await nameOf(page, 1), n2 = await nameOf(page, 2);
    await page.getByRole("listitem").nth(0).getByRole("button", { name: "Absent" }).click();
    await page.getByRole("listitem").nth(1).getByRole("button", { name: "Late" }).click();
    await page.getByRole("button", { name: "Submit register" }).click();
    await expect(page.getByText("register is in")).toBeVisible();

    const first = await todayRows();
    const roll = first.length;
    expect(roll, "one row per learner of Form 2 West").toBeGreaterThanOrEqual(40);
    expect(first.filter((r) => r.mark === "absent").map((r) => r.students!.full_name)).toEqual([n0]);
    expect(first.filter((r) => r.mark === "late").map((r) => r.students!.full_name)).toEqual([n1]);
    const lines = await textLines(page);
    const card = lines.indexOf("Form 2 West", lines.findIndex((l) => l.toLowerCase() === "your classes today"));
    same("Teacher card", "here / on roll, absent, late", `${roll - 1}/${roll} here · 1 absent · 1 late`, lines.slice(card, card + 6).find((l) => /here/.test(l)));

    await page.getByRole("button", { name: "Correct a mark" }).click();
    await expect(page.getByText("Everyone starts present")).toBeVisible();
    await page.getByRole("listitem").nth(0).getByRole("button", { name: "Present" }).click();
    await page.getByRole("listitem").nth(2).getByRole("button", { name: "Absent" }).click();
    await page.getByRole("button", { name: "Submit register" }).click();
    await expect(page.getByText("register is in")).toBeVisible();

    const second = await todayRows();
    expect(second).toHaveLength(roll);
    expect(new Set(second.map((r) => r.id))).toEqual(new Set(first.map((r) => r.id)));
    const markOf = (name: string) => second.find((r) => r.students!.full_name === name)!.mark;
    expect([markOf(n0), markOf(n1), markOf(n2)]).toEqual(["present", "late", "absent"]);
    table.push(["Teacher register", "rows after submit, correct, submit", String(roll), String(second.length)]);
  });


  test("KNOWN QA10-EMPTY FIG-1411 (open): a register cannot be submitted, and is not reported as in, before the class's learners have loaded", async ({ page }) => {
    test.fail();
    await signInWithId(page, SCHOOLS[0].name, "TC-0002", "Teacher");
    // A slow connection: the learners take six seconds to arrive. Until then the page holds a register with nobody on it.
    await page.route(/\/rest\/v1\/students/, async (route) => { await new Promise((r) => setTimeout(r, 6000)); await route.continue(); });
    await page.goto("/s/alliance/teacher/attendance");
    await page.getByRole("button", { name: "Submit register" }).click();
    const confirm = page.getByRole("button", { name: "Yes, submit" });
    if (await confirm.isVisible({ timeout: 2000 }).catch(() => false)) {
      table.push(["Teacher register", "confirmation shown before the learners load", "none (button off)", await page.getByText(/nobody on this roster/).innerText().catch(() => "asked")]);
      await confirm.click();
    }
    await page.waitForTimeout(2500);
    const reportedIn = await page.getByText("register is in").count();
    table.push(["Teacher register", "'register is in' before the learners loaded", "not shown", reportedIn ? "shown, 0 learners saved" : "not shown"]);
    expect(reportedIn, "an empty register was reported as in").toBe(0);
  });

  /** The teacher is on the phone with no signal: Form 2 West's register goes in with one learner absent, and is held. */
  async function holdRegister(page: Page) {
    await openRegister(page);
    await page.route(/\/rest\/v1\/attendance/, (route) => (route.request().method() === "POST" ? route.abort("failed") : route.continue()));
    await page.getByRole("listitem").nth(0).getByRole("button", { name: "Absent" }).click();
    await page.getByRole("button", { name: "Submit register" }).click();
    await expect(page.getByText("Saved on this phone. It will send itself when you have signal.")).toBeVisible();
    expect((await todayRows()).length).toBe(0);
    const held = await queueOf(page);
    expect(held).toContain('"table":"attendance"');
    expect(held, "the held register carries the teacher's id").toContain('"userId"');
    await page.unroute(/\/rest\/v1\/attendance/); // the signal is back
    return held!;
  }
  const queueOf = (page: Page) => page.evaluate(() => window.localStorage.getItem("figbloom.queue.v1"));
  /** Every attendance write the page sends from now on: where it was sent from, by whom, and whose rows it carries. */
  function watchWrites(page: Page) {
    const sent: string[] = [];
    page.on("request", (r) => {
      if (r.method() !== "POST" || !/\/rest\/v1\/attendance/.test(r.url())) return;
      const token = (r.headers().authorization ?? "").replace("Bearer ", "");
      let sub = "?";
      try { sub = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).sub; } catch { /* the anon key has no user */ }
      let rows = "";
      try { const body = JSON.parse(r.postData() ?? "[]") as { taken_by: string }[]; rows = `, ${body.length} rows taken_by ${[...new Set(body.map((x) => x.taken_by))].join(",")}`; } catch { /* not JSON */ }
      sent.push(`from ${page.url().replace(/^https?:\/\/[^/]+/, "")} as user ${sub}${rows}`);
    });
    return sent;
  }

  test("another teacher (Kijani Ridge's TC-0001) signing in on the same phone does not send the held register; it goes out when the teacher is back", async ({ page }) => {
    const held = await holdRegister(page);
    const sent = watchWrites(page);
    await endSession(page);
    await signInWithId(page, SCHOOLS[1].name, "TC-0001", "Teacher");
    await page.goto("/s/kijani-ridge/teacher/attendance");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForTimeout(3000);
    table.push(["Held register", "sent by a second teacher's session", "nothing sent", sent.join("; ") || "nothing sent"]);
    expect(sent, "no attendance write was sent while the other teacher was signed in").toEqual([]);
    expect((await todayRows()).length, "nothing reached the server").toBe(0);
    expect(await queueOf(page), "the register is still held, untouched").toBe(held);

    await endSession(page);
    await signInWithId(page, SCHOOLS[0].name, "TC-0002", "Teacher");
    await expect.poll(async () => (await todayRows()).length, { timeout: 20000 }).toBeGreaterThan(0);
    await expect.poll(() => queueOf(page), { timeout: 20000 }).toBe("[]");
    expect((await todayRows()).filter((r) => r.mark === "absent")).toHaveLength(1);
  });

  // FIG-1403: the queue used to be told who is signed in only by TeacherShell, so for every other kind of user it was not scoped
  // to anyone and the browser's 'online' event sent whatever was held, with that user's login. App() now does it for every role.
  test("QA10-SHARED FIG-1403: the school admin signing in on the same phone does not send the teacher's held register", async ({ page }) => {
    await holdRegister(page);
    const sent = watchWrites(page);
    await endSession(page);
    await signInEmail(page, SCHOOLS[0].admin);
    await page.goto("/s/alliance/admin");
    await expect(page.getByText(/classes submitted/).first()).toBeVisible({ timeout: 30000 });
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForTimeout(3000);
    table.push(["Held register", "sent by the admin's session", "nothing sent", sent.join("; ") || "nothing sent"]);
    expect(sent, "the admin's session sent the teacher's register").toEqual([]);
  });

  test("QA10-SHARED FIG-1403: a parent signing in on the same phone does not get the teacher's held register refused and set aside for good", async ({ page }) => {
    const held = await holdRegister(page);
    await endSession(page);
    await signInWithId(page, SCHOOLS[0].name, "PT-0002", "Parent");
    await page.goto("/s/alliance/parent");
    // A parent's Home can take several seconds to load (FIG-1500); what is checked here is the queue, after it has.
    await expect(page.getByText("Faith").first()).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForTimeout(3000);
    const now = await queueOf(page);
    table.push(["Held register", "state after a parent's session tried to send it", "still waiting", now?.includes('"rejected"') ? "refused, set aside" : "still waiting"]);
    expect(now, "the register is still waiting, as it was").toBe(held);
  });
});
