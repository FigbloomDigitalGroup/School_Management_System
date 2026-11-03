import { expect, test, type Browser, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

process.loadEnvFile?.(); // Node 20.6+ built-in
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

/**
 * QA 13 (FIG-1246): every figure on the report screens re-derived from the database, never from the screen. For each number the
 * expected value is worked out here from raw rows read with the service role (paged past the 1,000-row cap) with plain arithmetic,
 * then compared with what the screen shows. The money figures on the Dashboard, Fees, Reports and the group dashboard were done in
 * QA 07 (reconciliation.spec.ts) and attendance in QA 10 (attendance.spec.ts); this file covers the rest: Reports class means,
 * Performance, the CBE report, the platform console, the group dashboard's other cards and the attendance drill-down, then
 * archived learners, an empty school, large data and who may open each screen.
 *
 * Everything this writes is put back (see afterAll). Desktop only: these are office screens read at desktop width.
 * Known defects use test.fail(): they pass while the defect exists and fail the day it is fixed. Then remove test.fail().
 */
test.describe.configure({ mode: "serial", timeout: 120_000 });
test.skip(({ isMobile }) => isMobile, "the office screens are read at desktop width");

const PASSWORD = "figbloom-dev";
const RUN_START = new Date().toISOString(); // anything the app writes after this moment (health checks) is the run's own
const table: string[][] = [["Screen", "Figure", "SQL result", "Shown", "Match?"]];
/** A row from a known-defect test (title starts with KNOWN) keeps NO when the cells differ. In any other test the cells are only worded differently (a redirect, a before and after) and the test asserts them, so the row says "by test". */
function record(screen: string, figure: string, sql: unknown, shown: unknown) {
  const same = String(sql) === String(shown);
  table.push([screen, figure, String(sql), String(shown), same ? "yes" : test.info().title.startsWith("KNOWN") ? "NO" : "by test"]);
}

let alliance = "", kijani = "", term3 = "";
let healthBaseline: number | null = null; // service_status rows before the run (see cleanupQa13)

/** Every row of a query, 1,000 at a time (the service role is capped at 1,000 per request too). */
async function all<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

test.beforeAll(async () => {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.SUPABASE_URL ?? "")) throw new Error("local Supabase only");
  await db.from("login_lookups").delete().gte("looked_up_at", "1970-01-01"); // same reason as flows.spec.ts
  alliance = (await db.from("tenants").select("id").eq("slug", "alliance").single()).data!.id as string;
  kijani = (await db.from("tenants").select("id").eq("slug", "kijani-ridge").single()).data!.id as string;
  term3 = (await db.from("terms").select("id").eq("tenant_id", alliance).eq("is_current", true).single()).data!.id as string;
});

test.afterAll(async () => {
  const widths = table[0]!.map((_, c) => Math.max(...table.map((r) => (r[c] ?? "").length)));
  console.log("\n" + table.map((r) => "| " + table[0]!.map((_, c) => (r[c] ?? "").padEnd(widths[c]!)).join(" | ") + " |").join("\n"));
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
async function lines(page: Page, path: string): Promise<string[]> {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2500);
  return (await page.locator("body").innerText()).split("\n").map((l) => l.trim()).filter(Boolean);
}
/** The n lines after a label (case-insensitive: CSS-uppercased labels come back in capitals). */
function after(ls: string[], label: string, n: number, from = 0, exact = false): string[] {
  const i = ls.findIndex((l, k) => k >= from && (exact ? l === label : l.toLowerCase() === label.toLowerCase()));
  expect(i, `"${label}" is on the screen`).toBeGreaterThanOrEqual(0);
  return ls.slice(i + 1, i + 1 + n);
}
const num = (s: string) => Number(s.replace(/[^\d.]/g, ""));

// ================================================================ Reports: the class means
test.describe("Reports: Academic performance", () => {
  test("each class's mean is the mean of its marks in the latest published exam, and the grade follows from it", async ({ page }) => {
    const exam = (await db.from("exams").select("id, name").eq("tenant_id", alliance).eq("term_id", term3).not("published_at", "is", null).order("published_at", { ascending: false }).limit(1).single()).data!;
    const students = await all<{ id: string; class_id: string }>((f, t) => db.from("students").select("id, class_id").eq("tenant_id", alliance).range(f, t));
    const classOf = new Map(students.map((s) => [s.id, s.class_id]));
    const marks = await all<{ student_id: string; score: number | null }>((f, t) => db.from("marks").select("student_id, score").eq("exam_id", exam.id).order("id").range(f, t));
    const classes = (await db.from("classes").select("id, name").eq("tenant_id", alliance)).data ?? [];
    await signIn(page, "principal@alliance.sc.ke");
    const ls = await lines(page, "/s/alliance/admin/reports");
    const start = ls.findIndex((l) => l.toLowerCase().startsWith("academic performance"));
    expect(start, "the Academic performance table is on the screen").toBeGreaterThanOrEqual(0);
    for (const c of classes) {
      const scores = marks.filter((m) => classOf.get(m.student_id) === c.id && m.score !== null).map((m) => m.score as number);
      const [mean] = after(ls, c.name as string, 1, start);
      const expected = scores.length ? String(Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)) : "No marks";
      const shown = mean!.split(" · ")[0]!;
      record("Reports", `${c.name} class mean, ${exam.name}`, expected, shown);
      expect(shown, `${c.name} mean`).toBe(expected);
    }
  });

  test("KNOWN QA13-MARKS-UNITS FIG-1440 (open): 'marks entered' is never more than the number it is out of", async ({ page }) => {
    test.fail();
    await signIn(page, "principal@alliance.sc.ke");
    const ls = await lines(page, "/s/alliance/admin/reports");
    const start = ls.findIndex((l) => l.toLowerCase().startsWith("academic performance"));
    const [, entered] = after(ls, "Form 2 West", 2, start);
    const m = /^([\d,]+) of ([\d,]+)$/.exec(entered!);
    expect(m, `the entered column reads "N of M": ${entered}`).not.toBeNull();
    const roster = (await db.from("students").select("id", { count: "exact", head: true }).eq("tenant_id", alliance).eq("active", true).eq("class_id", (await db.from("classes").select("id").eq("tenant_id", alliance).eq("name", "Form 2 West").single()).data!.id as string)).count;
    table.push(["Reports", "Form 2 West 'marks entered N of M'", `N marks of ${roster} learners x 9 subjects = ${(roster ?? 0) * 9}`, entered!, num(m![1]!) <= num(m![2]!) ? "yes" : "NO"]);
    expect(num(m![1]!), `${m![1]} marks entered of ${m![2]}`).toBeLessThanOrEqual(num(m![2]!));
  });
});

// ================================================================ Performance
test.describe("Performance over time", () => {
  test("the school's mean, the number of subjects and marks, and each subject's mean match the published marks", async ({ page }) => {
    const exam = (await db.from("exams").select("id, name").eq("tenant_id", alliance).eq("term_id", term3).not("published_at", "is", null).order("published_at", { ascending: false }).limit(1).single()).data!;
    const students = await all<{ id: string; class_id: string }>((f, t) => db.from("students").select("id, class_id").eq("tenant_id", alliance).range(f, t));
    const classOf = new Map(students.map((s) => [s.id, s.class_id]));
    const pubs = (await db.from("mark_publications").select("class_id, subject_id").eq("exam_id", exam.id)).data ?? [];
    const published = new Set(pubs.map((p) => `${p.class_id}|${p.subject_id}`));
    const subjects = new Map(((await db.from("subjects").select("id, name").eq("tenant_id", alliance)).data ?? []).map((s) => [s.id as string, s.name as string]));
    const marks = (await all<{ student_id: string; subject_id: string; score: number | null }>((f, t) => db.from("marks").select("student_id, subject_id, score").eq("exam_id", exam.id).order("id").range(f, t)))
      .filter((m) => m.score !== null && published.has(`${classOf.get(m.student_id)}|${m.subject_id}`));
    const mean = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
    await signIn(page, "principal@alliance.sc.ke");
    const ls = await lines(page, "/s/alliance/admin/performance");
    const [shownMean] = after(ls, "MEAN MARK", 1);
    const [shownSubjects, shownMarks] = after(ls, "SUBJECTS OUT", 2);
    const expectedMean = String(mean(marks.map((m) => m.score as number)));
    const bySubject = new Map<string, number[]>();
    for (const m of marks) bySubject.set(subjects.get(m.subject_id)!, [...(bySubject.get(subjects.get(m.subject_id)!) ?? []), m.score as number]);
    record("Performance", `whole-school mean, ${exam.name}`, expectedMean, shownMean);
    record("Performance", "subjects with marks", bySubject.size, shownSubjects);
    record("Performance", "marks counted", `${marks.length} marks`, shownMarks);
    expect(shownMean).toBe(expectedMean);
    expect(Number(shownSubjects)).toBe(bySubject.size);
    expect(shownMarks).toBe(`${marks.length} marks`);
    const compared = ls.findIndex((l) => l.toLowerCase().startsWith("subjects compared"));
    for (const [name, xs] of bySubject) {
      const [value] = after(ls, name, 1, compared);
      record("Performance", `${name} mean`, mean(xs), value);
      expect(Number(value), `${name} mean`).toBe(mean(xs));
    }
  });
});

// ================================================================ the CBE report (Reports, a CBE school)
test.describe("Reports: CBE learning areas", () => {
  test("each class and learning area shows the learners at each overall level of its latest published assessment", async ({ page }) => {
    const term = (await db.from("terms").select("id").eq("tenant_id", kijani).eq("is_current", true).single()).data!.id as string;
    const assessments = (await db.from("cbe_assessments").select("id, class_id, subject_id, assessed_on, published_at, classes(name, level), subjects(name)").eq("tenant_id", kijani).eq("term_id", term).not("published_at", "is", null)).data as unknown as { id: string; class_id: string; subject_id: string; assessed_on: string; classes: { name: string; level: string }; subjects: { name: string } }[];
    const latest = new Map<string, (typeof assessments)[number]>();
    for (const a of assessments) { const k = `${a.class_id}|${a.subject_id}`; const cur = latest.get(k); if (!cur || a.assessed_on > cur.assessed_on) latest.set(k, a); }
    const results = await all<{ assessment_id: string; student_id: string; points: number }>((f, t) => db.from("cbe_results").select("assessment_id, student_id, points").eq("tenant_id", kijani).order("id").range(f, t));
    // Rubric points are typed here, not imported: the 4-level rubric for pre-primary and primary, the 8-level one above that.
    const FOUR: [string, number][] = [["EE", 4], ["ME", 3], ["AE", 2], ["BE", 1]];
    const EIGHT: [string, number][] = [["EE", 8], ["EE", 7], ["ME", 6], ["ME", 5], ["AE", 4], ["AE", 3], ["BE", 2], ["BE", 1]];
    const expected = new Map<string, { EE: number; ME: number; AE: number; BE: number; learners: number }>();
    for (const a of latest.values()) {
      const rubric = ["pre_primary", "primary"].includes(a.classes.level) ? FOUR : EIGHT;
      const perLearner = new Map<string, number[]>();
      for (const r of results.filter((r) => r.assessment_id === a.id)) perLearner.set(r.student_id, [...(perLearner.get(r.student_id) ?? []), r.points]);
      const counts = { EE: 0, ME: 0, AE: 0, BE: 0, learners: perLearner.size };
      for (const pts of perLearner.values()) {
        const m = pts.reduce((x, y) => x + y, 0) / pts.length;
        let best = rubric[0]!;
        for (const l of rubric) if (Math.abs(l[1] - m) < Math.abs(best[1] - m)) best = l; // the higher level wins a tie
        counts[best[0] as "EE" | "ME" | "AE" | "BE"] += 1;
      }
      expected.set(`${a.classes.name}|${a.subjects.name}`, counts);
    }
    await signIn(page, "head@kijaniridge.sc.ke");
    const ls = await lines(page, "/s/kijani-ridge/admin/reports");
    const header = ls.findIndex((l) => l.toLowerCase() === "learners by overall level");
    expect(header, "the CBE table is on the screen").toBeGreaterThanOrEqual(0);
    const shown = new Map<string, { EE: number; ME: number; AE: number; BE: number; learners: number }>();
    for (let i = header + 1; i < ls.length; i++) {
      if (!/^EE \d+$/.test(ls[i]!)) continue;
      const n = (k: number) => num(ls[i + k]!.split(" ")[1]!);
      shown.set(`${ls[i - 3]}|${ls[i - 2]}`, { EE: n(0), ME: n(1), AE: n(2), BE: n(3), learners: num(ls[i + 4]!.replace(/^of\s*/, "")) });
    }
    expect(shown.size, "one row per class and learning area").toBe(expected.size);
    for (const [key, want] of expected) {
      const got = shown.get(key);
      const w = `EE ${want.EE} ME ${want.ME} AE ${want.AE} BE ${want.BE} of ${want.learners}`;
      const g = got ? `EE ${got.EE} ME ${got.ME} AE ${got.AE} BE ${got.BE} of ${got.learners}` : "missing";
      record("Reports (CBE)", key.replace("|", " / "), w, g);
      expect(g, key).toBe(w);
    }
  });
});

// ================================================================ the platform console
test.describe("Platform console", () => {
  test("MRR, learner seats, the attention count, the filter chips and the school detail cards match the tenants table", async ({ page }) => {
    const tenants = (await db.from("tenants").select("id, slug, status, plan, price_cents_override, licensed_seats")).data ?? [];
    const price = new Map(((await db.from("plan_pricing").select("plan, price_cents")).data ?? []).map((p) => [p.plan as string, p.price_cents as number]));
    const billed = tenants.filter((t) => t.status === "active" || t.status === "overdue");
    const mrr = billed.reduce((a, t) => a + ((t.price_cents_override as number | null) ?? price.get(t.plan as string) ?? 0), 0);
    const students = (await db.from("students").select("id", { count: "exact", head: true }).eq("active", true)).count ?? 0;
    const licensed = tenants.reduce((a, t) => a + (t.licensed_seats as number), 0);
    const attention = tenants.filter((t) => t.status === "overdue" || t.status === "setup_stalled");
    await signIn(page, "joyce@figbloom.co.ke");
    const ls = await lines(page, "/platform/tenants");
    const text = ls.join(" ");
    const [mrrValue, mrrSub] = after(ls, "MRR", 2);
    const [seats, seatsSub] = after(ls, "Learner seats", 2);
    const [att, attSub] = after(ls, "Needs attention", 2);
    record("Platform", "MRR", `KSh ${(mrr / 100).toLocaleString("en-US")} across ${billed.length} billed schools`, `${mrrValue} ${mrrSub}`);
    record("Platform", "learner seats", `${students} (${Math.round((students / licensed) * 100)}% of licensed)`, `${seats} (${seatsSub})`);
    record("Platform", "needs attention", `${attention.length}: ${attention.filter((t) => t.status === "overdue").length} overdue · ${attention.filter((t) => t.status === "setup_stalled").length} stalled setup`, `${att}: ${attSub}`);
    expect(`${mrrValue} ${mrrSub}`).toBe(`KSh ${(mrr / 100).toLocaleString("en-US")} across ${billed.length} billed schools`);
    expect(seats).toBe(students.toLocaleString("en-US"));
    expect(seatsSub).toBe(`${Math.round((students / licensed) * 100)}% of licensed`);
    expect(att).toBe(String(attention.length));
    expect(attSub).toBe(`${attention.filter((t) => t.status === "overdue").length} overdue · ${attention.filter((t) => t.status === "setup_stalled").length} stalled setup`);
    const chips = { All: tenants.length, Attention: attention.length, Trial: tenants.filter((t) => t.status === "trial").length };
    for (const [name, n] of Object.entries(chips)) { const m = new RegExp(`${name} (\\d+)`).exec(text); record("Platform", `filter chip ${name}`, n, m?.[1]); expect(m?.[1]).toBe(String(n)); }
    // the school detail card for the first school (Alliance)
    const staff = (await db.from("profiles").select("id", { count: "exact", head: true }).eq("tenant_id", alliance).in("role", ["school_admin", "teacher"])).count;
    const parents = (await db.from("profiles").select("id", { count: "exact", head: true }).eq("tenant_id", alliance).eq("role", "parent")).count;
    const learners = (await db.from("students").select("id", { count: "exact", head: true }).eq("tenant_id", alliance).eq("active", true)).count;
    record("Platform (Alliance)", "learners / seats", `${learners} of 2,000 licensed`, /LEARNERS (\d[\d,]*) of ([\d,]+) licensed/i.exec(text)?.slice(1, 3).join(" of ") + " licensed");
    expect(text).toMatch(new RegExp(`LEARNERS ${learners} of 2,000 licensed`, "i"));
    expect(text).toMatch(new RegExp(`STAFF ACCOUNTS ${staff}`, "i"));
    expect(text).toMatch(new RegExp(`PARENT ACCOUNTS ${parents}`, "i"));
  });

  test("KNOWN QA13-ACTIVE-TENANTS FIG-1442 (open): the 'Active tenants' card counts the tenants that are active", async ({ page }) => {
    test.fail();
    const tenants = (await db.from("tenants").select("status")).data ?? [];
    await signIn(page, "joyce@figbloom.co.ke");
    const ls = await lines(page, "/platform/tenants");
    const [value, sub] = after(ls, "Active tenants", 2);
    const active = tenants.filter((t) => t.status === "active").length;
    table.push(["Platform", "Active tenants card", `${active} with status active (${tenants.length} tenants in all)`, `${value} (${sub})`, value === String(active) ? "yes" : "NO"]);
    expect(value, `the card says ${value} and its own sub-line says ${sub}`).toBe(String(active));
  });
});

// ================================================================ the group dashboard's other cards
test.describe("Group dashboard", () => {
  test("schools, the K-12 / higher-ed split, active students, present today and the not-active count match the database", async ({ page }) => {
    const schools = (await db.from("tenants").select("id, status, institution_type").eq("organization_id", (await db.from("organizations").select("id").eq("slug", "kijani-ridge-group").single()).data!.id as string)).data ?? [];
    const ids = schools.map((s) => s.id as string);
    const students = (await db.from("students").select("id", { count: "exact", head: true }).in("tenant_id", ids).eq("active", true)).count ?? 0;
    const today = new Date().toISOString().slice(0, 10);
    const present = (await db.from("attendance").select("id", { count: "exact", head: true }).in("tenant_id", ids).eq("taken_on", today).eq("mark", "present")).count ?? 0;
    const k12 = schools.filter((s) => s.institution_type === "k12").length;
    await signIn(page, "group@kijaniridge.sc.ke");
    const ls = await lines(page, "/org/kijani-ridge-group/dashboard");
    const [n, split] = after(ls, "SCHOOLS", 2, 0, true); // the card label is capitals; the sidebar link "Schools" is not
    const [stu, presentSub] = after(ls, "ACTIVE STUDENTS", 2, 0, true);
    const [notActive] = after(ls, "NEEDS ATTENTION", 1, 0, true);
    record("Group dashboard", "schools / split", `${schools.length}: ${k12} K-12 · ${schools.length - k12} higher-ed`, `${n}: ${split}`);
    record("Group dashboard", "active students / present today", `${students} / ${present}`, `${stu} / ${presentSub.replace(" present today", "")}`);
    record("Group dashboard", "needs attention", schools.filter((s) => s.status !== "active").length, notActive);
    expect(n).toBe(String(schools.length));
    expect(split).toBe(`${k12} K-12 · ${schools.length - k12} higher-ed`);
    expect(stu).toBe(students.toLocaleString("en-US"));
    expect(presentSub).toBe(`${present.toLocaleString("en-US")} present today`);
    expect(notActive).toBe(String(schools.filter((s) => s.status !== "active").length));
  });
});

// ================================================================ the attendance drill-down
test.describe("Dashboard: who wasn't here", () => {
  test("the drill-down for a class lists exactly the learners marked absent or late on the register's date", async ({ page }) => {
    const latest = (await db.from("attendance").select("taken_on").eq("tenant_id", alliance).order("taken_on", { ascending: false }).limit(1).single()).data!.taken_on as string;
    const cls = (await db.from("classes").select("id").eq("tenant_id", alliance).eq("name", "Form 2 West").single()).data!.id as string;
    const rows = (await db.from("attendance").select("mark, students(full_name, admission_no)").eq("class_id", cls).eq("taken_on", latest)).data as unknown as { mark: string; students: { full_name: string; admission_no: string } }[];
    const away = rows.filter((r) => r.mark === "absent" || r.mark === "late");
    await signIn(page, "principal@alliance.sc.ke");
    await page.goto("/s/alliance/admin");
    await page.waitForLoadState("networkidle");
    await page.getByTitle("See who was late, absent or excused").first().click(); // the "37 / 43" fraction on the only class whose register was taken
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("who wasn't here", { timeout: 15000 });
    await expect(dialog).toContainText("ADM ", { timeout: 15000 }); // the names load after the heading
    const text = await dialog.innerText();
    const listed = (a: string) => new RegExp("ADM " + a + "(?!\\d)").test(text); // by admission number: two learners in the class share a name
    record("Dashboard drill-down", `Form 2 West on ${latest}: learners listed (absent or late)`, `${away.length} learners`, `${away.filter((r) => listed(r.students.admission_no)).length} listed, ${rows.filter((r) => r.mark === "present" && listed(r.students.admission_no)).length} present ones listed too`);
    for (const r of away) expect(listed(r.students.admission_no), `${r.students.full_name} ${r.students.admission_no} (${r.mark})`).toBe(true);
    for (const r of rows.filter((x) => x.mark === "present")) expect(listed(r.students.admission_no), `${r.students.full_name} ${r.students.admission_no} was present`).toBe(false);
  });
});

// ================================================================ cleanup of everything the tests below write
const EMPTY_SLUG = "qa13-empty", EMPTY_ADMIN = "qa13e.admin@qa13empty.sc.ke";
// payments: main's seed records a real payment behind every paid invoice (FIG-1332); and since FIG-1319 nothing with a payment on it can be
// deleted, so the learners this file bills and pays (QA13-F-...) stay behind, archived, and so do the ones the integration tests bill (QA05-...).
// The counts below leave out every learner whose admission number starts QA (the seed's are numbers), and count the seeded term's invoices and
// payments only (the integration tests bill every active learner in terms of their own, and pay some of those invoices).
const SEED = { allianceStudents: 339, allianceInvoices: 339, marks: 387, publications: 9, alliancePayments: 300 };
const RUN = Date.now().toString(36);
let faithId = "", kijaniKidId = "", west = "", mock1 = "", teacherId = "";

async function removeUser(email: string) {
  for (const p of (await db.from("profiles").select("id").eq("email", email)).data ?? []) { await db.from("profiles").delete().eq("id", p.id as string); await db.auth.admin.deleteUser(p.id as string); }
}
async function cleanupQa13(): Promise<string[]> {
  const errors: string[] = [];
  await db.from("students").update({ active: true, archived_at: null }).eq("tenant_id", alliance).eq("admission_no", "4102");
  if (kijaniKidId) await db.from("students").update({ active: true, archived_at: null }).eq("id", kijaniKidId);
  if (mock1 && west) {
    const others = (await all<{ id: string }>((f, t) => db.from("students").select("id").eq("tenant_id", alliance).neq("class_id", west).order("id").range(f, t))).map((s) => s.id);
    for (let i = 0; i < others.length; i += 100) await db.from("marks").delete().eq("exam_id", mock1).in("student_id", others.slice(i, i + 100));
    await db.from("mark_publications").delete().eq("exam_id", mock1).neq("class_id", west);
  }
  const extra = await all<{ id: string }>((f, t) => db.from("students").select("id").eq("tenant_id", alliance).like("admission_no", "QA13-E-%").order("id").range(f, t));
  for (let i = 0; i < extra.length; i += 100) {
    const ids = extra.slice(i, i + 100).map((s) => s.id);
    await db.from("fee_invoices").delete().in("student_id", ids);
    // their invoices were seeded with a paid amount, and an invoice that has been paid is kept for good (FIG-1319), so the learners cannot be
    // deleted any more: archive them (npm run db:fresh removes them, and must run before the next reconciliation spec)
    const del = await db.from("students").delete().in("id", ids);
    if (del.error) { const arch = await db.from("students").update({ active: false }).in("id", ids); if (arch.error) errors.push(`learners: ${arch.error.message}`); }
  }
  await db.from("platform_invoices").delete().eq("amount_cents", 123456);
  await db.from("platform_incidents").delete().like("title", "QA13X%");
  await db.from("platform_invoices").delete().gte("created_at", "1970-01-01");
  await db.from("impersonation_sessions").delete().eq("reason", "QA13X");
  for (const o of (await db.from("organizations").select("id").like("name", "QA13X%")).data ?? []) await db.from("organization_admins").delete().eq("organization_id", o.id as string);
  await db.from("tenants").update({ organization_id: null }).eq("slug", "nakuru-girls");
  await db.from("organizations").delete().like("name", "QA13X%");
  await db.from("strands").delete().is("tenant_id", null);
  await db.from("learning_areas").update({ verified_at: null }).not("verified_at", "is", null);
  await db.from("service_status").delete().or(`detail.eq.QA13X,checked_at.gte.${RUN_START}`);
  await db.from("tenants").update({ trial_ends_at: null, renews_on: null }).in("slug", ["nakuru-girls", "alliance"]);
  for (const s of (await db.from("students").select("id").eq("tenant_id", alliance).like("admission_no", "QA13-F-%")).data ?? []) {
    // an invoice with a payment on it is kept for good (FIG-1319), and so is its learner: archive them so nothing else counts them
    const invoicesGone = !(await db.from("fee_invoices").delete().eq("student_id", s.id as string)).error;
    const gone = invoicesGone && !(await db.from("students").delete().eq("id", s.id as string)).error;
    if (!gone) await db.from("students").update({ active: false }).eq("id", s.id as string);
  }
  await removeUser(EMPTY_ADMIN);
  await db.from("tenants").delete().eq("slug", EMPTY_SLUG);
  const n = async (tbl: string, f: (q: ReturnType<typeof db.from>) => unknown) => ((await (f(db.from(tbl)) as PromiseLike<{ count: number | null }>)).count ?? 0);
  const students = await n("students", (q) => q.select("id", { count: "exact", head: true }).eq("tenant_id", alliance).not("admission_no", "like", "QA%"));
  const invoices = await n("fee_invoices", (q) => q.select("id, students!inner(admission_no)", { count: "exact", head: true }).eq("tenant_id", alliance).eq("term_id", term3).not("students.admission_no", "like", "QA%"));
  const marks = await n("marks", (q) => q.select("id", { count: "exact", head: true }).eq("exam_id", mock1));
  const pubs = await n("mark_publications", (q) => q.select("exam_id", { count: "exact", head: true }).eq("exam_id", mock1));
  if (students !== SEED.allianceStudents) errors.push(`Alliance has ${students} learners, not ${SEED.allianceStudents}`);
  if (invoices !== SEED.allianceInvoices) errors.push(`Alliance has ${invoices} invoices, not ${SEED.allianceInvoices}`);
  if (marks !== SEED.marks) errors.push(`Mock 1 has ${marks} marks, not ${SEED.marks}`);
  if (pubs !== SEED.publications) errors.push(`Mock 1 has ${pubs} publications, not ${SEED.publications}`);
  if ((await db.from("tenants").select("id").eq("slug", EMPTY_SLUG)).data?.length) errors.push("the empty school is still there");
  const incidents = await n("platform_incidents", (q) => q.select("id", { count: "exact", head: true }));
  const health = await n("service_status", (q) => q.select("id", { count: "exact", head: true }));
  const payments = await n("payments", (q) => q.select("id, fee_invoices!inner(students!inner(admission_no))", { count: "exact", head: true }).eq("tenant_id", alliance).eq("fee_invoices.term_id", term3).not("fee_invoices.students.admission_no", "like", "QA%"));
  if (incidents !== 0) errors.push(`${incidents} incidents are left`);
  const invoicesP = await n("platform_invoices", (q) => q.select("id", { count: "exact", head: true }));
  const sessions = await n("impersonation_sessions", (q) => q.select("id", { count: "exact", head: true }));
  const orgs = await n("organizations", (q) => q.select("id", { count: "exact", head: true }));
  const official = await n("strands", (q) => q.select("id", { count: "exact", head: true }).is("tenant_id", null));
  const verifiedAreas = await n("learning_areas", (q) => q.select("id", { count: "exact", head: true }).not("verified_at", "is", null));
  if (invoicesP !== 0) errors.push(`${invoicesP} platform invoices are left`);
  if (sessions !== 0) errors.push(`${sessions} impersonation sessions are left`);
  if (orgs !== 1) errors.push(`${orgs} organizations, not 1`);
  if (official !== 0) errors.push(`${official} official strands are left`);
  if (verifiedAreas !== 0) errors.push(`${verifiedAreas} learning areas are still verified`);
  // The seed writes none; an earlier "Check now" may have left a few. Whatever is there before the run must be there after it.
  if (healthBaseline === null) healthBaseline = health;
  if (health !== healthBaseline) errors.push(`service_status has ${health} rows, not ${healthBaseline}`);
  if (payments !== SEED.alliancePayments) errors.push(`Alliance has ${payments} payments, not ${SEED.alliancePayments}`);
  return errors;
}
test.beforeAll(async () => {
  west = (await db.from("classes").select("id").eq("tenant_id", alliance).eq("name", "Form 2 West").single()).data!.id as string;
  mock1 = (await db.from("exams").select("id").eq("tenant_id", alliance).eq("term_id", term3).not("published_at", "is", null).order("published_at", { ascending: false }).limit(1).single()).data!.id as string;
  teacherId = (await db.from("profiles").select("id").eq("tenant_id", alliance).eq("login_id", "TC-0002").single()).data!.id as string;
  faithId = (await db.from("students").select("id").eq("tenant_id", alliance).eq("admission_no", "4102").single()).data!.id as string;
  kijaniKidId = (await db.from("students").select("id").eq("tenant_id", kijani).eq("active", true).order("id").limit(1).single()).data!.id as string;
  const left = await cleanupQa13();
  if (left.length) throw new Error(`the database is not at seed before the run: ${left.join("; ")}`);
});
test.afterAll(async () => {
  const left = await cleanupQa13();
  if (left.length) throw new Error(`cleanup failed, run the file again to sweep: ${left.join("; ")}`);
});

// ================================================================ archived learners
test.describe("Archived learners", () => {
  type Seen = Record<string, string>;
  async function session(browser: Browser, email: string, read: (p: Page) => Promise<Seen>): Promise<Seen> {
    const ctx = await browser.newContext({ baseURL: "http://localhost:5173" });
    const p = await ctx.newPage();
    try { await signIn(p, email); return await read(p); } finally { await ctx.close(); }
  }
  const school = (p: Page) => async (): Promise<Seen> => {
    const dash = await lines(p, "/s/alliance/admin");
    const rep = await lines(p, "/s/alliance/admin/reports");
    const perf = await lines(p, "/s/alliance/admin/performance");
    const ppl = await lines(p, "/s/alliance/admin/people");
    const start = rep.findIndex((l) => l.toLowerCase().startsWith("academic performance"));
    return {
      "Dashboard: Learners": after(dash, "LEARNERS", 1, 0, true)[0]!,
      "Reports: register entries": after(rep, "ATTENDANCE", 2, 0, true)[1]!,
      "Reports: Form 2 West marks entered": after(rep, "Form 2 West", 2, start)[1]!,
      "Performance: marks counted": after(perf, "SUBJECTS OUT", 2, 0, true)[1]!,
      "People: total": ppl.find((l) => /^[\d,]+ total$/.test(l)) ?? "?",
    };
  };
  const readAll = async (browser: Browser) => ({
    ...(await session(browser, "principal@alliance.sc.ke", (p) => school(p)())),
    ...(await session(browser, "joyce@figbloom.co.ke", async (p) => {
      const ls = await lines(p, "/platform/tenants");
      return { "Platform: Learner seats": after(ls, "Learner seats", 1)[0]!, "Platform: Alliance learners": /LEARNERS ([\d,]+) of/i.exec(ls.join(" "))?.[1] ?? "?" };
    })),
    ...(await session(browser, "group@kijaniridge.sc.ke", async (p) => {
      const ls = await lines(p, "/org/kijani-ridge-group/dashboard");
      return { "Group: Active students": after(ls, "ACTIVE STUDENTS", 1, 0, true)[0]! };
    })),
  });

  test("two learners archived: every count of people drops by one, and attendance and marks history stays", async ({ browser }) => {
    const before = await readAll(browser);
    const stamp = new Date().toISOString();
    expect((await db.from("students").update({ active: false, archived_at: stamp }).eq("id", faithId)).error).toBeNull();
    expect((await db.from("students").update({ active: false, archived_at: stamp }).eq("id", kijaniKidId)).error).toBeNull();
    const after_ = await readAll(browser);
    for (const k of Object.keys(before)) record("Archived learner", k, before[k], after_[k]);
    const n = (s: string) => Number(s.replace(/[^\d]/g, ""));
    expect(n(after_["Dashboard: Learners"]!), "Dashboard Learners").toBe(n(before["Dashboard: Learners"]!) - 1);
    expect(n(after_["People: total"]!), "People total").toBe(n(before["People: total"]!) - 1);
    expect(n(after_["Platform: Learner seats"]!), "platform seats (two archived)").toBe(n(before["Platform: Learner seats"]!) - 2);
    expect(n(after_["Platform: Alliance learners"]!), "platform Alliance learners").toBe(n(before["Platform: Alliance learners"]!) - 1);
    expect(n(after_["Group: Active students"]!), "group active students").toBe(n(before["Group: Active students"]!) - 1);
    expect(after_["Reports: register entries"], "attendance history is kept").toBe(before["Reports: register entries"]);
    expect(after_["Performance: marks counted"], "published marks are kept").toBe(before["Performance: marks counted"]);
  });
});

// ================================================================ Reports and unpublished marks
test.describe("Reports and Performance read the same marks", () => {
  test("KNOWN QA13-UNPUBLISHED FIG-1441 (open): a class whose marks are entered but not published shows no mean on Reports, as on Performance", async ({ page }) => {
    test.fail();
    const kid = (await db.from("students").select("id").eq("tenant_id", alliance).eq("class_id", (await db.from("classes").select("id").eq("tenant_id", alliance).eq("name", "Form 1 East").single()).data!.id as string).limit(1).single()).data!.id as string;
    const subj = async (code: string) => (await db.from("subjects").select("id").eq("tenant_id", alliance).eq("code", code).single()).data!.id as string;
    try {
      const rows = [];
      for (const [c, s] of [["CHE", 55], ["ENG", 60], ["MAT", 65]] as const) rows.push({ tenant_id: alliance, exam_id: mock1, student_id: kid, subject_id: await subj(c), score: s, entered_by: teacherId });
      expect((await db.from("marks").insert(rows)).error).toBeNull();
      await signIn(page, "principal@alliance.sc.ke");
      const rep = await lines(page, "/s/alliance/admin/reports");
      const start = rep.findIndex((l) => l.toLowerCase().startsWith("academic performance"));
      const [mean] = after(rep, "Form 1 East", 1, start);
      const perf = await lines(page, "/s/alliance/admin/performance");
      const [subjectsOut] = after(perf, "SUBJECTS OUT", 2, 0, true).slice(1);
      table.push(["Reports vs Performance", "Form 1 East: 3 marks entered, none published", "no mean on either screen", `Reports shows "${mean}"; Performance counts ${subjectsOut}`]);
      expect(mean, "Reports shows a mean for a class nobody has published").toBe("No marks");
    } finally {
      await db.from("marks").delete().eq("exam_id", mock1).eq("student_id", kid);
    }
  });
});

// ================================================================ a brand-new school
test.describe("A brand-new school (no term, no classes, no learners)", () => {
  test("set up: an empty K-12 school and its admin", async () => {
    const t = await db.from("tenants").insert({ name: "QA13 Empty School", slug: EMPTY_SLUG, county: "Nairobi", institution_type: "k12", level: "secondary", country: "KE", status: "active", plan: "standard" }).select("id").single();
    expect(t.error).toBeNull();
    const u = await db.auth.admin.createUser({ email: EMPTY_ADMIN, password: PASSWORD, email_confirm: true });
    expect(u.error).toBeNull();
    expect((await db.from("profiles").insert({ id: u.data.user!.id, tenant_id: t.data!.id, role: "school_admin", full_name: "QA13E Admin", email: EMPTY_ADMIN, must_change_password: false })).error).toBeNull();
  });

  test("no screen shows NaN, Infinity, undefined or null, and none shows a made-up percentage", async ({ page }) => {
    await signIn(page, EMPTY_ADMIN);
    const seen: string[] = [];
    for (const path of ["", "/reports", "/performance", "/fees", "/people", "/classes"]) {
      const ls = await lines(page, `/s/${EMPTY_SLUG}/admin${path}`);
      const body = ls.slice(ls.findIndex((l) => l === "▴") + 1).join(" | ");
      seen.push(`/admin${path}: ${body.slice(0, 230)}`);
      expect(body, `${path || "Dashboard"} shows a broken value`).not.toMatch(/NaN|Infinity|undefined|\bnull\b/);
      expect(body, `${path || "Dashboard"} shows an error`).not.toMatch(/Could not load/i);
    }
    for (const s of seen) table.push(["Empty school", s.split(":")[0]!, "an empty state", s.slice(s.indexOf(":") + 2)]);
  });

  test("KNOWN QA13-EMPTY FIG-1445 (open): the Dashboard of a school with no term says so, and shows no percentage it has no data for", async ({ page }) => {
    test.fail();
    await signIn(page, EMPTY_ADMIN);
    const ls = await lines(page, `/s/${EMPTY_SLUG}/admin`);
    const body = ls.slice(ls.findIndex((l) => l === "▴") + 1).join(" | ");
    table.push(["Empty school", "Dashboard headline", "an empty state: no term yet, no percentages", body.slice(0, 200)]);
    expect(body, "the Dashboard is still saying it is loading the term").not.toMatch(/LOADING TERM/i);
    expect(body, "the Dashboard shows 0% as if it were real data").not.toMatch(/\b0%/);
  });
});

// ================================================================ who may open each screen
test.describe("Who may open the report screens", () => {
  async function idSignIn(page: Page, loginId: string, portal: string) {
    await page.goto("/signin");
    await page.getByRole("button", { name: `${portal} portal` }).click();
    await page.getByLabel("School").fill("Alliance High School");
    await page.getByRole("button").filter({ hasText: "Alliance High School" }).first().click();
    await page.getByLabel("Your ID").fill(loginId);
    await page.getByLabel("Your ID").blur();
    await expect(page.getByText(/^Signing in as /)).toBeVisible({ timeout: 5000 });
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 15000 });
  }
  const stays = async (page: Page, path: string) => {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    const text = await page.locator("body").innerText();
    return { opened: new URL(page.url()).pathname === path && /FEES COLLECTED|ATTENDANCE TODAY|SCHOOL · REPORTS|SCHOOL · FEES|SCHOOL · PERFORMANCE|ORGANIZATION CONSOLE|PLATFORM CONSOLE|ACTIVE TENANTS|Dashboard/.test(text), url: new URL(page.url()).pathname };
  };
  for (const [who, loginId, portal] of [["teacher", "TC-0002", "Teacher"], ["parent", "PT-0002", "Parent"], ["student", "ST-0002", "Student"]] as const) {
    test(`a ${who} cannot open the school admin's Dashboard, Reports, Fees or Performance, the group dashboard or the platform console`, async ({ page }) => {
      await idSignIn(page, loginId, portal);
      for (const path of ["/s/alliance/admin", "/s/alliance/admin/reports", "/s/alliance/admin/fees", "/s/alliance/admin/performance", "/org/kijani-ridge-group/dashboard", "/platform/tenants"]) {
        const r = await stays(page, path);
        record(`Access: ${who}`, path, "redirected away", r.opened ? "OPENED" : `went to ${r.url}`);
        expect(r.opened, `${who} opened ${path}`).toBe(false);
      }
    });
  }
  test("a school admin cannot open the group dashboard or the platform console; a group admin cannot open the platform console or another group's school", async ({ page }) => {
    await signIn(page, "principal@alliance.sc.ke");
    for (const path of ["/org/kijani-ridge-group/dashboard", "/platform/tenants"]) {
      const r = await stays(page, path);
      record("Access: school admin", path, "redirected away", r.opened ? "OPENED" : `went to ${r.url}`);
      expect(r.opened, `the school admin opened ${path}`).toBe(false);
    }
    await page.context().clearCookies();
    const ctx = await page.context().browser()!.newContext({ baseURL: "http://localhost:5173" });
    const p2 = await ctx.newPage();
    try {
      await signIn(p2, "group@kijaniridge.sc.ke");
      for (const path of ["/platform/tenants", "/s/alliance/admin/reports"]) {
        const r = await stays(p2, path);
        record("Access: group admin", path, "redirected away", r.opened ? "OPENED" : `went to ${r.url}`);
        expect(r.opened, `the group admin opened ${path}`).toBe(false);
      }
      const own = await stays(p2, "/s/kijani-ridge/admin/reports");
      record("Access: group admin", "/s/kijani-ridge/admin/reports (a school of the group)", "opens", own.opened ? "opens" : `went to ${own.url}`);
      expect(own.opened, "the group admin can read the reports of a school in the group").toBe(true);
    } finally { await ctx.close(); }
  });
  test("nobody signed in is sent to the sign-in screen", async ({ page }) => {
    for (const path of ["/s/alliance/admin/reports", "/platform/tenants", "/org/kijani-ridge-group/dashboard"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1500);
      record("Access: nobody signed in", path, "/signin", new URL(page.url()).pathname);
      expect(new URL(page.url()).pathname, path).toBe("/signin");
    }
  });
});

// ================================================================ buttons that only show a message
test.describe("Buttons that only show a message", () => {
  const announcements = async () => (await db.from("announcements").select("id", { count: "exact", head: true }).eq("tenant_id", alliance)).count ?? 0;

  test("Dashboard 'New announcement' only shows the message 'Announcement composer'", async ({ page }) => {
    await signIn(page, "principal@alliance.sc.ke");
    await lines(page, "/s/alliance/admin");
    const before = await announcements();
    const url = page.url();
    await page.getByRole("button", { name: "New announcement" }).click();
    await expect(page.getByText("Announcement composer", { exact: true })).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);
    table.push(["Dashboard", "New announcement", "opens the composer", `a message "Announcement composer"; same page: ${page.url() === url}; announcements ${before} -> ${await announcements()}`]);
    expect(page.url()).toBe(url);
    expect(await announcements()).toBe(before);
  });

  test("KNOWN QA13-TOAST FIG-1446 (open): 'Impersonate admin' says a session is logged, and no session is logged", async ({ page }) => {
    test.fail();
    const sessions = async () => (await db.from("impersonation_sessions").select("id", { count: "exact", head: true })).count ?? 0;
    await signIn(page, "joyce@figbloom.co.ke");
    await lines(page, "/platform/tenants");
    const before = await sessions();
    await page.getByRole("button", { name: "Impersonate admin" }).click();
    const toast = await page.getByText(/^Impersonating /).first().innerText();
    await page.waitForTimeout(1000);
    const after_ = await sessions();
    table.push(["Platform > school", "Impersonate admin", "a logged session, as the toast says", `"${toast}"; sessions logged ${before} -> ${after_}`]);
    expect(after_, `the message says "${toast}"`).toBeGreaterThan(before);
  });

  test("KNOWN QA13-TOAST FIG-1446 (open): Invoices 'Remind' says a reminder was sent, and nothing is sent or recorded", async ({ page }) => {
    test.fail();
    const made = await db.from("platform_invoices").insert({ tenant_id: alliance, amount_cents: 123456, due_date: new Date().toISOString().slice(0, 10) }).select("*").single();
    expect(made.error).toBeNull();
    try {
      await signIn(page, "joyce@figbloom.co.ke");
      await lines(page, "/platform/invoices");
      const before = await announcements();
      await page.getByRole("button", { name: "Remind" }).first().click();
      const toast = await page.getByText(/^Reminder sent/).first().innerText();
      await page.waitForTimeout(1000);
      const row = (await db.from("platform_invoices").select("*").eq("id", made.data!.id as string).single()).data!;
      const changed = JSON.stringify(row) !== JSON.stringify(made.data);
      const after_ = await announcements();
      table.push(["Platform > Invoices", "Remind", "a reminder sent and recorded", `"${toast}"; school announcements ${before} -> ${after_}; invoice row changed: ${changed}`]);
      expect(after_ > before || changed, `the message says "${toast}"`).toBe(true);
    } finally {
      await db.from("platform_invoices").delete().eq("id", made.data!.id as string);
    }
  });

  test("'Export for audit', 'Filter by school' and 'Export range' do nothing at all (no download, no message, no filter)", async ({ page }) => {
    await signIn(page, "joyce@figbloom.co.ke");
    const results: string[] = [];
    for (const [link, button] of [["Impersonation log", "Export for audit"], ["Audit trail", "Filter by school"], ["Audit trail", "Export range"]] as const) {
      await page.getByRole("link", { name: link, exact: true }).click();
      await page.waitForLoadState("networkidle");
      const download = page.waitForEvent("download", { timeout: 2500 }).catch(() => null);
      const before = await page.locator("body").innerText();
      await page.getByRole("button", { name: button }).click();
      const got = await download;
      await page.waitForTimeout(800);
      const after_ = await page.locator("body").innerText();
      const b = new Set(before.split("\n").map((l) => l.trim()).filter(Boolean));
      const changed = after_.split("\n").map((l) => l.trim()).filter((l) => l && !b.has(l));
      results.push(`${button}: download ${got ? "yes" : "no"}, lines that appeared: ${changed.length ? changed.slice(0, 3).join(" / ") : "none"}`);
      expect(got, `${button} produced a download`).toBeNull();
    }
    table.push(["Platform", "Export for audit / Filter by school / Export range", "export or filter", results.join("; ")]);
  });
});

// ================================================================ platform pages: Usage, Subscriptions, System health, Incidents
const fmtWhen = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
const ksh = (cents: number) => `KSh ${(cents / 100).toLocaleString("en-US")}`;

test.describe("Platform: Usage & capacity", () => {
  test("the number of schools and active schools, the licensed seats of each school and 'over licence' match the tenants table", async ({ page }) => {
    const tenants = (await db.from("tenants").select("name, licensed_seats, status").order("name")).data ?? [];
    await signIn(page, "joyce@figbloom.co.ke");
    const ls = await lines(page, "/platform/usage");
    const [n, sub] = after(ls, "SCHOOLS", 2, 0, true);
    const active = tenants.filter((t) => t.status === "active").length;
    record("Platform > Usage", "schools / active", `${tenants.length} / ${active} active`, `${n} / ${sub}`);
    expect(n).toBe(String(tenants.length));
    expect(sub).toBe(`${active} active`);
    for (const t of tenants) {
      const i = ls.findIndex((l) => l === t.name);
      expect(ls[i + 2], `${t.name}: licensed seats`).toBe((t.licensed_seats as number).toLocaleString("en-US"));
    }
    record("Platform > Usage", "licensed seats of each of the 11 schools", "as the tenants table", "as the tenants table");
    expect(after(ls, "OVER LICENCE", 1, 0, true)[0]).toBe("0");
  });

  test("KNOWN QA13-USAGE-LABELS FIG-1449 (open): 'Licensed seats' says it is across the active schools and adds up the seats of the active schools", async ({ page }) => {
    test.fail();
    const tenants = (await db.from("tenants").select("licensed_seats, status")).data ?? [];
    const activeSeats = tenants.filter((t) => t.status === "active").reduce((a, t) => a + (t.licensed_seats as number), 0);
    await signIn(page, "joyce@figbloom.co.ke");
    const ls = await lines(page, "/platform/usage");
    const [value, sub] = after(ls, "LICENSED SEATS", 2, 0, true);
    table.push(["Platform > Usage", "licensed seats", `${activeSeats.toLocaleString("en-US")} (the six active schools; ${tenants.reduce((a, t) => a + (t.licensed_seats as number), 0).toLocaleString("en-US")} over all 11)`, `${value} (${sub})`, value === activeSeats.toLocaleString("en-US") ? "yes" : "NO"]);
    expect(value, `the card says "${sub}"`).toBe(activeSeats.toLocaleString("en-US"));
  });

  test("KNOWN QA13-USAGE-LABELS FIG-1449 (open): 'Seats in use' is the learners on roll, the same count the Tenants page calls Learner seats", async ({ page }) => {
    test.fail();
    const learners = (await db.from("students").select("id", { count: "exact", head: true }).eq("active", true)).count ?? 0;
    const staff = (await db.from("profiles").select("id", { count: "exact", head: true }).in("role", ["school_admin", "teacher"]).not("tenant_id", "is", null)).count ?? 0;
    await signIn(page, "joyce@figbloom.co.ke");
    const ls = await lines(page, "/platform/usage");
    const [value] = after(ls, "SEATS IN USE", 1, 0, true);
    const al = ls.findIndex((l) => l === "Alliance High School");
    table.push(["Platform > Usage", "seats in use", `${learners} learners (${learners + staff} if the ${staff} school admin and teacher accounts are counted too)`, `${value}; Alliance row ${ls[al + 3]} (339 learners + 2 staff)`, value === String(learners) ? "yes" : "NO"]);
    expect(value, "seats in use, with staff accounts counted").toBe(String(learners));
  });
});

test.describe("Platform: Subscriptions", () => {
  test("MRR, active licences, trials, at-risk schools and each school's price and renewal match the tenants table", async ({ page }) => {
    const tenants = (await db.from("tenants").select("id, name, slug, status, plan, price_cents_override").order("name")).data ?? [];
    const price = new Map(((await db.from("plan_pricing").select("plan, price_cents")).data ?? []).map((p) => [p.plan as string, p.price_cents as number]));
    const priceOf = (t: { plan: unknown; price_cents_override: unknown }) => (t.price_cents_override as number | null) ?? price.get(t.plan as string) ?? 0;
    const billed = tenants.filter((t) => t.status === "active" || t.status === "overdue");
    await signIn(page, "joyce@figbloom.co.ke");
    const ls = await lines(page, "/platform/subscriptions");
    const [mrr, mrrSub] = after(ls, "MRR", 2, 0, true);
    const [lic, licSub] = after(ls, "ACTIVE LICENCES", 2, 0, true);
    const [trials] = after(ls, "IN TRIAL", 1, 0, true);
    const [risk] = after(ls, "AT RISK", 2, 0, true);
    record("Platform > Subscriptions", "MRR", `${ksh(billed.reduce((a, t) => a + priceOf(t), 0))} across ${billed.length} billed schools`, `${mrr} ${mrrSub}`);
    record("Platform > Subscriptions", "active licences / trials / at risk", `${tenants.filter((t) => t.status === "active").length} of ${tenants.length}; ${tenants.filter((t) => t.status === "trial").length}; ${tenants.filter((t) => t.status === "overdue" || t.status === "suspended").length}`, `${lic} ${licSub}; ${trials}; ${risk}`);
    expect(`${mrr} ${mrrSub}`).toBe(`${ksh(billed.reduce((a, t) => a + priceOf(t), 0))} across ${billed.length} billed schools`);
    expect(lic).toBe(String(tenants.filter((t) => t.status === "active").length));
    expect(licSub).toBe(`of ${tenants.length} schools`);
    expect(trials).toBe(String(tenants.filter((t) => t.status === "trial").length));
    expect(risk).toBe(String(tenants.filter((t) => t.status === "overdue" || t.status === "suspended").length));
    for (const t of tenants) {
      const i = ls.findIndex((l) => l === t.name);
      const priceShown = ls[i + 3];
      expect(priceShown, `${t.name}: price`).toBe(priceOf(t) > 0 ? ksh(priceOf(t)) : "—");
    }
  });

  test("a trial ending within 10 days is counted and shown with its date; a renewal date is shown; both are put back", async ({ page }) => {
    const soon = new Date(Date.now() + 5 * 86400_000).toISOString();
    const renews = "2027-01-11";
    try {
      expect((await db.from("tenants").update({ trial_ends_at: soon }).eq("slug", "nakuru-girls")).error).toBeNull();
      expect((await db.from("tenants").update({ renews_on: renews }).eq("slug", "alliance")).error).toBeNull();
      await signIn(page, "joyce@figbloom.co.ke");
      const ls = await lines(page, "/platform/subscriptions");
      const [, sub] = after(ls, "IN TRIAL", 2, 0, true);
      const alliance_ = ls.findIndex((l) => l === "Alliance High School");
      const nakuru = ls.findIndex((l) => l === "Nakuru Girls High");
      record("Platform > Subscriptions", "trial ending in 5 days", "1 ending within 10 days; Trial ends " + fmtDate(soon), `${sub}; ${ls[nakuru + 4]}`);
      expect(sub).toBe("1 ending within 10 days");
      expect(ls[nakuru + 4]).toBe(`Trial ends ${fmtDate(soon)}`);
      expect(ls[alliance_ + 4]).toBe(fmtDate(renews));
    } finally {
      await db.from("tenants").update({ trial_ends_at: null }).eq("slug", "nakuru-girls");
      await db.from("tenants").update({ renews_on: null }).eq("slug", "alliance");
    }
  });

  test("KNOWN QA13-MRR-UNITS FIG-1451 (open): the card called MRR is not the sum of a column headed 'per term'", async ({ page }) => {
    test.fail();
    await signIn(page, "joyce@figbloom.co.ke");
    const ls = await lines(page, "/platform/subscriptions");
    const [mrr] = after(ls, "MRR", 1, 0, true);
    const header = ls.findIndex((l) => l === "PER TERM");
    const sumColumn = (await db.from("tenants").select("plan, price_cents_override, status")).data!.filter((t) => t.status === "active" || t.status === "overdue");
    const price = new Map(((await db.from("plan_pricing").select("plan, price_cents")).data ?? []).map((p) => [p.plan as string, p.price_cents as number]));
    const sum = sumColumn.reduce((a, t) => a + ((t.price_cents_override as number | null) ?? price.get(t.plan as string) ?? 0), 0);
    table.push(["Platform > Subscriptions", "MRR against the 'per term' column", `a monthly figure, not ${ksh(sum)} (the sum of the per-term prices of the billed schools)`, `${mrr}; column header "${ls[header]}"`, mrr === ksh(sum) ? "NO" : "yes"]);
    expect(header, "the column is headed PER TERM").toBeGreaterThanOrEqual(0);
    expect(mrr, "MRR equals the sum of the per-term prices").not.toBe(ksh(sum));
  });
});

test.describe("Platform: System health", () => {
  const rowsFor = (ls: string[], label: string) => {
    const labels = ["Supabase", "M-Pesa Daraja"];
    const start = ls.findIndex((l, i) => l === label && i > ls.findIndex((x) => x === "SERVICE"));
    const next = ls.findIndex((l, i) => i > start && labels.includes(l));
    return ls.slice(start, next < 0 ? ls.length : next);
  };

  test("services checked, 'not OK', last checked, and each service's status, latency and reliability match the check history", async ({ page }) => {
    const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const planted = [
      { service: "supabase", status: "ok", latency_ms: 110, detail: "QA13X", checked_at: at(180) },
      { service: "supabase", status: "ok", latency_ms: 130, detail: "QA13X", checked_at: at(120) },
      { service: "supabase", status: "down", latency_ms: null, detail: "QA13X", checked_at: at(60) },
      { service: "mpesa", status: "ok", latency_ms: 200, detail: "QA13X", checked_at: at(150) },
      { service: "mpesa", status: "degraded", latency_ms: 900, detail: "QA13X", checked_at: at(30) },
    ];
    expect((await db.from("service_status").insert(planted)).error).toBeNull();
    const history = (await db.from("service_status").select("*").order("checked_at", { ascending: false }).limit(200)).data as { service: string; status: string; latency_ms: number | null; checked_at: string }[];
    const label: Record<string, string> = { supabase: "Supabase", mpesa: "M-Pesa Daraja" };
    const by = new Map<string, typeof history>();
    for (const r of history) by.set(r.service, [...(by.get(r.service) ?? []), r]);
    const notOk = [...by.values()].filter((rs) => rs[0]!.status === "down" || rs[0]!.status === "degraded").map((rs) => label[rs[0]!.service]!);
    await signIn(page, "joyce@figbloom.co.ke");
    const ls = await lines(page, "/platform/health");
    const [checked, checkedSub] = after(ls, "SERVICES CHECKED", 2, 0, true);
    const [bad, badSub] = after(ls, "NOT OK", 2, 0, true);
    const [last] = after(ls, "LAST CHECKED", 1, 0, true);
    record("Platform > Health", "services checked", `${by.size}: ${[...by.keys()].map((k) => label[k]).sort().join(", ")}`, `${checked}: ${checkedSub.split(", ").sort().join(", ")}`);
    record("Platform > Health", "not OK (latest check down or degraded)", `${notOk.length}: ${notOk.sort().join(", ")}`, `${bad}: ${badSub.split(", ").sort().join(", ")}`);
    record("Platform > Health", "last checked", fmtWhen(history[0]!.checked_at), last);
    expect(checked).toBe(String(by.size));
    expect(checkedSub.split(", ").sort()).toEqual([...by.keys()].map((k) => label[k]!).sort());
    expect(bad).toBe(String(notOk.length));
    expect(badSub.split(", ").sort()).toEqual(notOk.sort());
    expect(last).toBe(fmtWhen(history[0]!.checked_at));
    for (const [service, rs] of by) {
      const slice = rowsFor(ls, label[service]!).join(" | ");
      const ok = rs.filter((r) => r.status === "ok").length;
      const expectedPct = `${Math.round((ok / rs.length) * 100)}% of ${rs.length}`;
      const latest = rs[0]!;
      const parts = [latest.latency_ms !== null ? `${latest.latency_ms} ms` : "—", expectedPct, fmtWhen(latest.checked_at)];
      record("Platform > Health", `${label[service]}: latency / reliability / last checked`, parts.join(" / "), parts.filter((p) => slice.includes(p)).join(" / "));
      expect(slice, `${label[service]} reliability`).toContain(expectedPct);
      expect(slice, `${label[service]} latency`).toContain(latest.latency_ms !== null ? `${latest.latency_ms} ms` : "—");
      expect(slice, `${label[service]} last checked`).toContain(fmtWhen(latest.checked_at));
    }
  });

  test("'Check now' runs a real check: the page then shows what was stored, and M-Pesa is 'Not configured' here", async ({ page }) => {
    const before = new Date().toISOString();
    await signIn(page, "joyce@figbloom.co.ke");
    await lines(page, "/platform/health");
    await page.getByRole("button", { name: "Check now" }).click();
    await expect(page.getByRole("button", { name: "Check now" })).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(3000);
    const stored = (await db.from("service_status").select("service, status, latency_ms, checked_at").gte("checked_at", before).order("checked_at", { ascending: false })).data ?? [];
    const ls = await lines(page, "/platform/health");
    const text = ls.join(" | ");
    table.push(["Platform > Health", "Check now", "a stored check for each service", `${stored.length} rows stored: ${stored.map((s) => `${s.service} ${s.status}`).join(", ")}`]);
    expect(stored.length, "check-services stored a check").toBeGreaterThanOrEqual(2);
    const supa = stored.find((s) => s.service === "supabase");
    expect(supa?.status).toBe("ok");
    expect(text).toContain(fmtWhen(stored[0]!.checked_at));
    expect(stored.find((s) => s.service === "mpesa")?.status).toBe("not_configured");
    expect(text).toContain("Not configured");
  });

  test("INFO: 'Not OK' says 0 and 'all clear' while M-Pesa is 'Not configured' with a reliability of 0%", async ({ page }) => {
    await db.from("service_status").delete().or(`detail.eq.QA13X,checked_at.gte.${RUN_START}`);
    await signIn(page, "joyce@figbloom.co.ke");
    const ls = await lines(page, "/platform/health");
    const [bad, sub] = after(ls, "NOT OK", 2, 0, true);
    const mpesa = ls.join(" | ").match(/M-Pesa Daraja[^|]*\|[^|]*\|[^|]*\|[^|]*\|\s*(\d+% of \d+)/)?.[1];
    table.push(["Platform > Health", "M-Pesa not configured", "(a decision) a stop on the card, or a row that says so", `Not OK ${bad} "${sub}"; M-Pesa reliability ${mpesa}`]);
    expect(bad).toBe("0");
  });
});

test.describe("Platform: Incidents", () => {
  const day = 86400_000;
  test("open, schools affected, mean time to fix and Sev-1 in the last 90 days match the incidents table", async ({ page }) => {
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const rows = [
      { severity: "SEV-1", title: "QA13X A", summary: "x", affected_schools: 2, status: "investigating", opened_at: iso(now - 2 * day) },
      { severity: "SEV-2", title: "QA13X B", summary: "x", affected_schools: 3, status: "fix_in_review", opened_at: iso(now - 1 * day) },
      { severity: "SEV-3", title: "QA13X C", summary: "x", affected_schools: 1, status: "resolved", opened_at: iso(now - 5 * day), resolved_at: iso(now - 5 * day + 90 * 60_000) },
      { severity: "SEV-1", title: "QA13X D", summary: "x", affected_schools: 4, status: "resolved", opened_at: iso(now - 120 * day), resolved_at: iso(now - 120 * day + 30 * 60_000) },
    ];
    expect((await db.from("platform_incidents").insert(rows)).error).toBeNull();
    const all_ = (await db.from("platform_incidents").select("*")).data as { severity: string; affected_schools: number; status: string; opened_at: string; resolved_at: string | null }[];
    const open = all_.filter((i) => i.status !== "resolved");
    const fix = all_.filter((i) => i.resolved_at).map((i) => (new Date(i.resolved_at!).getTime() - new Date(i.opened_at).getTime()) / 60000);
    const mean = Math.round(fix.reduce((a, b) => a + b, 0) / fix.length);
    const sev1 = all_.filter((i) => i.severity === "SEV-1" && new Date(i.opened_at).getTime() >= now - 90 * day).length;
    const affected = open.reduce((a, i) => a + i.affected_schools, 0);
    await signIn(page, "joyce@figbloom.co.ke");
    const ls = await lines(page, "/platform/incidents");
    const [o, oSub] = after(ls, "OPEN", 2, 0, true);
    const [m] = after(ls, "MEAN TIME TO FIX", 1, 0, true);
    const [a] = after(ls, "SCHOOLS AFFECTED", 1, 0, true);
    const [s] = after(ls, "SEV-1, LAST 90 DAYS", 1, 0, true);
    record("Platform > Incidents", "open / schools affected", `${open.length} affecting ${affected} schools`, `${o} ${oSub}`);
    record("Platform > Incidents", "mean time to fix (30 and 90 min)", `${mean} min`, m);
    record("Platform > Incidents", "Sev-1 in the last 90 days (one is 120 days old)", sev1, s);
    expect(o).toBe(String(open.length));
    expect(oSub).toBe(`affecting ${affected} schools`);
    expect(a).toBe(String(affected));
    expect(m).toBe(`${mean} min`);
    expect(s).toBe(String(sev1));
  });

  test("'Resolve' marks the incident resolved with a time, and the cards follow", async ({ page }) => {
    await signIn(page, "joyce@figbloom.co.ke");
    await lines(page, "/platform/incidents");
    await page.getByRole("row").filter({ hasText: "QA13X A" }).getByRole("button", { name: "Resolve" }).click();
    await expect(page.getByText("Incident resolved.")).toBeVisible({ timeout: 15000 });
    const a = (await db.from("platform_incidents").select("status, resolved_at, opened_at").eq("title", "QA13X A").single()).data!;
    expect(a.status).toBe("resolved");
    expect(a.resolved_at).not.toBeNull();
    const all_ = (await db.from("platform_incidents").select("status, affected_schools, opened_at, resolved_at")).data!;
    const open = all_.filter((i) => i.status !== "resolved");
    const fix = all_.filter((i) => i.resolved_at).map((i) => (new Date(i.resolved_at as string).getTime() - new Date(i.opened_at as string).getTime()) / 60000);
    const mean = Math.round(fix.reduce((x, y) => x + y, 0) / fix.length);
    await page.waitForTimeout(1500);
    const ls = await lines(page, "/platform/incidents");
    const [o, oSub] = after(ls, "OPEN", 2, 0, true);
    const [m] = after(ls, "MEAN TIME TO FIX", 1, 0, true);
    record("Platform > Incidents", "after resolving A: open / mean time to fix", `${open.length} affecting ${open.reduce((x, i) => x + (i.affected_schools as number), 0)} schools / ${mean} min`, `${o} ${oSub} / ${m}`);
    expect(o).toBe(String(open.length));
    expect(m).toBe(`${mean} min`);
  });

  test("declaring an incident stores what was typed and adds it to the open ones", async ({ page }) => {
    await signIn(page, "joyce@figbloom.co.ke");
    const ls0 = await lines(page, "/platform/incidents");
    const openBefore = Number(after(ls0, "OPEN", 1, 0, true)[0]);
    await page.getByRole("button", { name: "Declare incident" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Severity").selectOption("SEV-2");
    await dialog.getByLabel("Schools affected").fill("7");
    await dialog.getByLabel("Incident").fill("QA13X declared");
    await dialog.getByLabel("What schools could not do").fill("Teachers could not see the roster");
    await dialog.getByRole("button", { name: "Declare incident" }).click();
    await expect(page.getByText("Incident declared.")).toBeVisible({ timeout: 15000 });
    const made = (await db.from("platform_incidents").select("severity, affected_schools, status, summary").eq("title", "QA13X declared").single()).data!;
    expect(made).toMatchObject({ severity: "SEV-2", affected_schools: 7, status: "investigating", summary: "Teachers could not see the roster" });
    await page.waitForTimeout(1500);
    const ls = await lines(page, "/platform/incidents");
    record("Platform > Incidents", "a declared incident (SEV-2, 7 schools)", `open ${openBefore + 1}`, `open ${after(ls, "OPEN", 1, 0, true)[0]}`);
    expect(after(ls, "OPEN", 1, 0, true)[0]).toBe(String(openBefore + 1));
  });
});

// ================================================================ the billing and payment dialogs
test.describe("Fees: the billing and payment dialogs", () => {
  const people = [
    { no: `QA13-F-${RUN}-01`, name: "QA13F Day Form1", cls: "Form 1 East", form: 1, boarding: false },
    { no: `QA13-F-${RUN}-02`, name: "QA13F Boarder Form1", cls: "Form 1 East", form: 1, boarding: true },
    { no: `QA13-F-${RUN}-03`, name: "QA13F Day Form4", cls: "Form 4 East", form: 4, boarding: false },
    { no: `QA13-F-${RUN}-04`, name: "QA13F Boarder Form4", cls: "Form 4 West", form: 4, boarding: true },
    { no: `QA13-F-${RUN}-05`, name: "QA13F Day Form2", cls: "Form 2 West", form: 2, boarding: false },
  ];
  let items: { amount_cents: number; applies_to: string; form_level: number | null }[] = [];
  // The rule worked out by hand from the fee items: who each item applies to.
  const billFor = (p: { form: number; boarding: boolean }) => items.filter((i) => i.applies_to === "all" || (i.applies_to === "boarders" && p.boarding) || (i.applies_to === "day" && !p.boarding) || (i.applies_to === "form_level" && i.form_level === p.form))
    .reduce((a, i) => a + Number(i.amount_cents), 0);
  const activeCount = async () => (await db.from("students").select("id", { count: "exact", head: true }).eq("tenant_id", alliance).eq("active", true)).count ?? 0;
  const openFees = async (page: Page) => { await signIn(page, "principal@alliance.sc.ke"); await lines(page, "/s/alliance/admin/fees"); };

  test("set up: five learners with no invoice (day and boarding, Forms 1, 2 and 4)", async () => {
    items = ((await db.from("fee_items").select("amount_cents, applies_to, form_level").eq("tenant_id", alliance).eq("term_id", term3)).data ?? []) as typeof items;
    expect(items.length, "the term has fee items").toBeGreaterThan(0);
    for (const p of people) {
      const cls = (await db.from("classes").select("id").eq("tenant_id", alliance).eq("name", p.cls).single()).data!.id as string;
      expect((await db.from("students").insert({ tenant_id: alliance, admission_no: p.no, full_name: p.name, class_id: cls, boarding: p.boarding, active: true, gender: "female" })).error).toBeNull();
    }
  });

  test("the Bill learners preview says how many will be billed and the total, and how many already have an invoice", async ({ page }) => {
    const want = people.reduce((a, p) => a + billFor(p), 0);
    const active = await activeCount();
    await openFees(page);
    await page.getByRole("button", { name: "Bill learners" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("will be billed", { timeout: 30000 });
    const text = await dialog.innerText();
    record("Fees > Bill learners", "learners to bill / total", `${people.length} learners, ${ksh(want)}`, text.replace(/\s+/g, " ").match(/\d[\d,]* learners? will be billed, KSh [\d,]+ in total\./)?.[0]);
    record("Fees > Bill learners", "already have an invoice", `${active - people.length}`, text.match(/([\d,]+) already have an invoice/)?.[1]);
    expect(text.replace(/\s+/g, " ")).toContain(`${people.length} learners will be billed, ${ksh(want)} in total.`);
    expect(text).toContain(`${(active - people.length).toLocaleString("en-US")} already have an invoice for this term and are left as they are.`);
  });

  test("'Create 5 invoices' makes exactly those invoices with those totals, the message and the audit entry say the same, and a second run bills nobody", async ({ page }) => {
    const want = new Map(people.map((p) => [p.no, billFor(p)]));
    const total = [...want.values()].reduce((a, b) => a + b, 0);
    await openFees(page);
    await page.getByRole("button", { name: "Bill learners" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("will be billed", { timeout: 30000 });
    await dialog.getByLabel("Due date").fill("2026-12-15");
    await dialog.getByRole("button", { name: `Create ${people.length} invoices` }).click();
    await expect(page.getByText(`${people.length} invoices created for Term 3, 2026`)).toBeVisible({ timeout: 30000 });
    const made = (await db.from("fee_invoices").select("total_cents, paid_cents, due_on, students!inner(admission_no)").eq("term_id", term3).like("students.admission_no", "QA13-F-%")).data as unknown as { total_cents: number; paid_cents: number; due_on: string; students: { admission_no: string } }[];
    expect(made).toHaveLength(people.length);
    for (const inv of made) { expect(Number(inv.total_cents), inv.students.admission_no).toBe(want.get(inv.students.admission_no)); expect(Number(inv.paid_cents)).toBe(0); expect(inv.due_on).toBe("2026-12-15"); }
    // Since main's FIG-1331 the database writes the billing audit event itself, from what it saved: "N fee invoices created for <term>", with the count and total in its details.
    const auditRow = (await db.from("audit_events").select("event, metadata").eq("tenant_id", alliance).like("event", "%fee invoices created for%").order("created_at", { ascending: false }).limit(1).single()).data!;
    const audit = auditRow.event as string;
    const details = auditRow.metadata as { invoices: number; total_cents: number };
    record("Fees > Bill learners", "invoices created / total / audit entry", `${made.length} / ${ksh(made.reduce((a, i) => a + Number(i.total_cents), 0))} / "${made.length} fee invoices created for Term 3, 2026" with ${made.length} invoices and ${ksh(total)}`, `${made.length} / ${ksh(total)} / "${audit}" with ${details.invoices} invoices and ${ksh(Number(details.total_cents))}`);
    expect(audit).toBe(`${made.length} fee invoices created for Term 3, 2026`);
    expect(details.invoices).toBe(made.length);
    expect(Number(details.total_cents)).toBe(total);
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: "Bill learners" }).click();
    await expect(page.getByRole("dialog")).toContainText("0 learners will be billed", { timeout: 30000 });
    await expect(page.getByRole("dialog").getByRole("button", { name: /^Create 0 invoices$/ })).toBeDisabled();
  });

  test("Record a payment: the search shows the right balance, the payment moves the balance by exactly what was typed, and too much or nothing is refused in words", async ({ page }) => {
    const p = people[1]!; // a boarder in Form 1: KSh 32,000
    const bill = billFor(p);
    await openFees(page);
    await page.getByRole("button", { name: "Record a payment" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Learner").fill(p.no);
    const result = dialog.getByRole("button").filter({ hasText: p.name });
    await expect(result).toBeVisible({ timeout: 15000 });
    record("Fees > Record a payment", `balance shown for ${p.name}`, ksh(bill), (await result.innerText()).replace(/\s+/g, " "));
    await expect(result).toContainText(ksh(bill));
    await result.click();
    // more than is owed
    await dialog.getByLabel("Amount received").fill(String((bill + 100000) / 100));
    await dialog.getByRole("button", { name: "Record payment" }).click();
    await expect(dialog).toContainText(`That is more than the ${ksh(bill)} still owed.`);
    // nothing
    await dialog.getByLabel("Amount received").fill("0");
    await dialog.getByRole("button", { name: "Record payment" }).click();
    const zero = (await dialog.innerText()).replace(/\s+/g, " ");
    record("Fees > Record a payment", "an amount of 0", "refused in words", zero.match(/(Enter|enter)[^.]*\./)?.[0] ?? zero.slice(-120));
    // a real one
    await dialog.getByLabel("Amount received").fill("5000");
    await dialog.getByRole("button", { name: "Record payment" }).click();
    await expect(page.getByText(`${ksh(500000)} recorded for ${p.name}`)).toBeVisible({ timeout: 20000 });
    const inv = (await db.from("fee_invoices").select("paid_cents, total_cents, students!inner(admission_no)").eq("term_id", term3).eq("students.admission_no", p.no).single()).data as unknown as { paid_cents: number; total_cents: number };
    const pay = (await db.from("payments").select("amount_cents, method").eq("invoice_id", (await db.from("fee_invoices").select("id, students!inner(admission_no)").eq("term_id", term3).eq("students.admission_no", p.no).single()).data!.id as string)).data ?? [];
    record("Fees > Record a payment", "after KSh 5,000 cash: paid / payments", `${ksh(500000)} / 1 payment of ${ksh(500000)}`, `${ksh(Number(inv.paid_cents))} / ${pay.length} payment(s) of ${pay.map((x) => ksh(Number(x.amount_cents))).join(", ")}`);
    expect(Number(inv.paid_cents)).toBe(500000);
    expect(pay).toHaveLength(1);
    expect(Number(pay[0]!.amount_cents)).toBe(500000);
    expect(pay[0]!.method).toBe("cash");
    // the balance the search now shows
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: "Record a payment" }).click();
    const d2 = page.getByRole("dialog");
    await d2.getByLabel("Learner").fill(p.no);
    await expect(d2.getByRole("button").filter({ hasText: p.name })).toContainText(ksh(bill - 500000), { timeout: 15000 });
  });
});

// ================================================================ platform pages, part 2: Invoices, Impersonation log, Audit trail, Organizations, Curriculum
const DAY = 86_400_000;
const plusDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const localToday = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in the machine's time zone, as the screens' "today"
const dateMinus = (days: number) => { const d = new Date(); d.setDate(d.getDate() - days); return d.toLocaleDateString("en-CA"); };

test.describe("Platform: Invoices", () => {
  type Inv = { id: string; amount_cents: number; status: string; due_date: string; created_at: string; paid_at: string | null };
  const figures = async () => {
    const rows = (await db.from("platform_invoices").select("id, amount_cents, status, due_date, created_at, paid_at")).data as Inv[];
    const due = rows.filter((r) => r.status === "due");
    const paid = rows.filter((r) => r.status === "paid");
    const billed = rows.reduce((a, r) => a + r.amount_cents, 0);
    const days = paid.filter((r) => r.paid_at).map((r) => (new Date(r.paid_at!).getTime() - new Date(r.created_at).getTime()) / DAY);
    return {
      rows,
      outstanding: due.reduce((a, r) => a + r.amount_cents, 0), outstandingN: due.length,
      overdue30: due.filter((r) => r.due_date <= dateMinus(30)).length,
      collected: paid.reduce((a, r) => a + r.amount_cents, 0), pct: billed > 0 ? Math.round((paid.reduce((a, r) => a + r.amount_cents, 0) / billed) * 100) : null,
      avgDays: days.length ? String(Math.round(days.reduce((a, b) => a + b, 0) / days.length)) : "—",
    };
  };
  const readCards = async (page: Page) => {
    const ls = await lines(page, "/platform/invoices");
    const [out, outSub] = after(ls, "OUTSTANDING", 2, 0, true);
    const [o30] = after(ls, "OVERDUE 30D+", 1, 0, true);
    const [col, colSub] = after(ls, "COLLECTED", 2, 0, true);
    const [avg] = after(ls, "AVG DAYS TO PAY", 1, 0, true);
    return { ls, out, outSub, o30, col, colSub, avg };
  };

  test("set up: two paid and four due invoices (overdue by 45 days, by exactly 30, by 29, and not yet due)", async () => {
    expect((await db.from("platform_invoices").select("id", { count: "exact", head: true })).count, "the table is empty on the seed").toBe(0);
    const now = Date.now();
    const rowsToPlant = [
      { tenant_id: alliance, amount_cents: 5_000_000, due_date: plusDays(10) },
      { tenant_id: kijani, amount_cents: 12_000_000, due_date: plusDays(-45) },
      { tenant_id: kijani, amount_cents: 5_000_000, due_date: dateMinus(30) },
      { tenant_id: alliance, amount_cents: 5_000_000, due_date: dateMinus(29) },
      { tenant_id: alliance, amount_cents: 12_000_000, due_date: plusDays(-15), status: "paid", created_at: new Date(now - 20 * DAY).toISOString(), paid_at: new Date(now - 10 * DAY).toISOString() },
      { tenant_id: kijani, amount_cents: 5_000_000, due_date: plusDays(-6), status: "paid", created_at: new Date(now - 8 * DAY).toISOString(), paid_at: new Date(now - 4 * DAY).toISOString() },
    ];
    const r = await db.from("platform_invoices").insert(rowsToPlant, { defaultToNull: false }); // rows with fewer keys take the column defaults
    expect(r.error).toBeNull();
  });

  test("outstanding, overdue 30 days or more, collected with its percentage of billed, and the average days to pay match the invoices", async ({ page }) => {
    const f = await figures();
    await signIn(page, "joyce@figbloom.co.ke");
    const c = await readCards(page);
    record("Platform > Invoices", "outstanding", `${ksh(f.outstanding)} across ${f.outstandingN} invoices`, `${c.out} ${c.outSub}`);
    record("Platform > Invoices", "overdue 30d+ (a due date exactly 30 days ago counts, 29 does not)", f.overdue30, c.o30);
    record("Platform > Invoices", "collected", `${ksh(f.collected)} (${f.pct}% of billed)`, `${c.col} (${c.colSub})`);
    record("Platform > Invoices", "average days to pay (10 and 4)", f.avgDays, c.avg);
    expect(`${c.out} ${c.outSub}`).toBe(`${ksh(f.outstanding)} across ${f.outstandingN} invoices`);
    expect(c.o30).toBe(String(f.overdue30));
    expect(c.col).toBe(ksh(f.collected));
    expect(c.colSub).toBe(`${f.pct}% of billed`);
    expect(c.avg).toBe(f.avgDays);
  });

  test("each row says Due, Overdue or Paid the way the due date and status say", async ({ page }) => {
    const f = await figures();
    await signIn(page, "joyce@figbloom.co.ke");
    const { ls } = await readCards(page);
    const text = ls.join(" | ");
    for (const r of f.rows) {
      const label = r.status === "paid" ? "Paid" : r.due_date < localToday() ? "Overdue" : "Due";
      const due = new Date(r.due_date).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
      const m = new RegExp(`${ksh(r.amount_cents).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\| ${due} \\| (Due|Overdue|Paid)`).exec(text);
      expect(m?.[1], `${ksh(r.amount_cents)} due ${r.due_date}`).toBe(label);
    }
    record("Platform > Invoices", "the label on each of the 6 rows", "Due, Overdue (3), Paid (2)", "as the dates and statuses say");
  });

  test("'Mark paid' stamps the invoice paid with a time, and the cards follow", async ({ page }) => {
    await signIn(page, "joyce@figbloom.co.ke");
    await lines(page, "/platform/invoices");
    await page.getByRole("row").filter({ hasText: ksh(5_000_000) }).filter({ hasText: "Due" }).filter({ hasNotText: "Overdue" }).getByRole("button", { name: "Mark paid" }).first().click();
    await expect(page.getByText("Marked as paid.")).toBeVisible({ timeout: 15000 });
    const f = await figures();
    expect(f.rows.filter((r) => r.status === "paid")).toHaveLength(3);
    expect(f.rows.filter((r) => r.status === "paid").every((r) => r.paid_at)).toBe(true);
    await page.waitForTimeout(1500);
    const c = await readCards(page);
    record("Platform > Invoices", "after Mark paid: outstanding / collected / average days", `${ksh(f.outstanding)} / ${ksh(f.collected)} / ${f.avgDays}`, `${c.out} / ${c.col} / ${c.avg}`);
    expect(c.out).toBe(ksh(f.outstanding));
    expect(c.col).toBe(ksh(f.collected));
    expect(c.avg).toBe(f.avgDays);
  });

  test("'New invoice' turns the typed amount in shillings into cents, and refuses nothing, zero, a negative and a word in words", async ({ page }) => {
    await signIn(page, "joyce@figbloom.co.ke");
    await lines(page, "/platform/invoices");
    const before = (await db.from("platform_invoices").select("id", { count: "exact", head: true })).count ?? 0;
    await page.getByRole("button", { name: "New invoice" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("School").selectOption({ label: "Alliance High School" });
    await dialog.getByLabel("Due date").fill(plusDays(20));
    const refused: string[] = [];
    for (const bad of ["", "0", "-5", "abc"]) {
      await dialog.getByLabel("Amount (KES)").fill(bad);
      await dialog.getByRole("button", { name: "Create invoice" }).click();
      await expect(page.getByText(/Enter an amount greater than zero\./).first()).toBeVisible({ timeout: 10000 });
      refused.push(`"${bad}"`);
      await page.waitForTimeout(400);
    }
    await dialog.getByLabel("Amount (KES)").fill("120000.55");
    await dialog.getByRole("button", { name: "Create invoice" }).click();
    await expect(page.getByText("Invoice created.")).toBeVisible({ timeout: 15000 });
    const made = (await db.from("platform_invoices").select("amount_cents, due_date, status").eq("amount_cents", 12_000_055)).data ?? [];
    record("Platform > Invoices", "New invoice: KES 120000.55 typed", "12000055 cents, due in 20 days, due", `${made.map((m) => `${m.amount_cents} cents, ${m.due_date}, ${m.status}`).join("; ")}; refused: ${refused.join(", ")}`);
    expect(made).toHaveLength(1);
    expect(made[0]!.due_date).toBe(plusDays(20));
    expect(made[0]!.status).toBe("due");
    expect((await db.from("platform_invoices").select("id", { count: "exact", head: true })).count).toBe(before + 1);
  });
});

test.describe("Platform: Impersonation log", () => {
  let joyce = "", peter = "", grace = "";
  type S = { staff: string; tenant: string; scope: string; startMin: number; lenMin: number | null };
  const mins = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const expectedFigures = async () => {
    const rows = ((await db.from("impersonation_sessions").select("started_at, ended_at, scope, writes_count, tenants(name), profiles(full_name)").order("started_at", { ascending: false }).limit(1000)).data ?? []) as unknown as { started_at: string; ended_at: string | null; scope: string; writes_count: number; tenants: { name: string }; profiles: { full_name: string } }[];
    const now = new Date();
    const month = rows.filter((r) => { const d = new Date(r.started_at); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
    const lens = rows.filter((r) => r.ended_at).map((r) => (new Date(r.ended_at!).getTime() - new Date(r.started_at).getTime()) / 60000).sort((a, b) => a - b);
    const trueMedian = lens.length ? (lens.length % 2 ? lens[(lens.length - 1) / 2]! : (lens[lens.length / 2 - 1]! + lens[lens.length / 2]!) / 2) : null;
    return {
      total: rows.length, month: month.length, staffThisMonth: new Set(month.map((r) => r.profiles.full_name)).size, staffAll: new Set(rows.map((r) => r.profiles.full_name)).size,
      writes: rows.filter((r) => r.scope === "write").length, writeActions: rows.reduce((a, r) => a + r.writes_count, 0), schools: new Set(rows.map((r) => r.tenants.name)).size, trueMedian,
    };
  };
  const readCards = async (page: Page) => {
    const ls = await lines(page, "/platform/impersonation");
    const [m, mSub] = after(ls, "SESSIONS THIS MONTH", 2, 0, true);
    const [med] = after(ls, "MEDIAN LENGTH", 1, 0, true);
    const [w, wSub] = after(ls, "WRITE ACTIONS", 2, 0, true);
    const [sch] = after(ls, "SCHOOLS ENTERED", 1, 0, true);
    return { m, mSub, med, w, wSub, sch };
  };

  test("set up: six sessions by three staff (four ended after 10, 20, 40 and 50 minutes, one open, one from 40 days ago)", async () => {
    joyce = (await db.from("profiles").select("id").eq("email", "joyce@figbloom.co.ke").single()).data!.id as string;
    peter = (await db.from("profiles").select("id").eq("tenant_id", alliance).eq("role", "school_admin").limit(1).single()).data!.id as string;
    grace = (await db.from("profiles").select("id").eq("tenant_id", kijani).eq("role", "school_admin").limit(1).single()).data!.id as string;
    expect((await db.from("impersonation_sessions").select("id", { count: "exact", head: true })).count, "the table is empty on the seed").toBe(0);
    const plan: S[] = [
      { staff: joyce, tenant: alliance, scope: "write", startMin: 200, lenMin: 10 },
      { staff: joyce, tenant: kijani, scope: "read", startMin: 190, lenMin: 20 },
      { staff: peter, tenant: alliance, scope: "read", startMin: 180, lenMin: 40 },
      { staff: peter, tenant: kijani, scope: "write", startMin: 170, lenMin: 50 },
      { staff: joyce, tenant: alliance, scope: "write", startMin: 5, lenMin: null },
      { staff: grace, tenant: kijani, scope: "read", startMin: 40 * 24 * 60, lenMin: null },
    ];
    const r = await db.from("impersonation_sessions").insert(plan.map((s) => ({ tenant_id: s.tenant, staff_id: s.staff, reason: "QA13X", scope: s.scope === "read" ? "read_only" : s.scope, writes_count: s.scope === "write" ? (s.lenMin === 10 ? 5 : s.lenMin === 50 ? 3 : 0) : 0, started_at: mins(s.startMin), ended_at: s.lenMin === null ? null : mins(s.startMin - s.lenMin) })));
    expect(r.error).toBeNull();
  });

  test("sessions this month, write actions, and schools entered match the sessions", async ({ page }) => {
    const e = await expectedFigures();
    await signIn(page, "joyce@figbloom.co.ke");
    const c = await readCards(page);
    record("Platform > Impersonation log", "sessions this month", e.month, c.m);
    record("Platform > Impersonation log", "the 'Write actions' card = sessions with write scope / sessions", `${e.writes} of ${e.total}`, `${c.w} ${c.wSub}`);
    record("Platform > Impersonation log", "schools entered", e.schools, c.sch);
    expect(c.m).toBe(String(e.month));
    expect(c.w).toBe(String(e.writes));
    expect(c.wSub).toBe(`of ${e.total} sessions`);
    expect(c.sch).toBe(String(e.schools));
  });

  test("KNOWN QA13-IMPERSONATION-CARDS FIG-1454 (open): 'by N staff members' counts the staff of this month's sessions", async ({ page }) => {
    test.fail();
    const e = await expectedFigures();
    await signIn(page, "joyce@figbloom.co.ke");
    const c = await readCards(page);
    table.push(["Platform > Impersonation log", "sessions this month / staff", `${e.month} by ${e.staffThisMonth} staff (${e.staffAll} over all sessions)`, `${c.m} ${c.mSub}`, c.mSub === `by ${e.staffThisMonth} staff members` ? "yes" : "NO"]);
    expect(c.mSub, "the staff counted next to 'this month'").toBe(`by ${e.staffThisMonth} staff members`);
  });

  test("KNOWN QA13-IMPERSONATION-CARDS FIG-1454 (open): 'Median length' is the median of the ended sessions (10, 20, 40 and 50 minutes: 30)", async ({ page }) => {
    test.fail();
    const e = await expectedFigures();
    await signIn(page, "joyce@figbloom.co.ke");
    const c = await readCards(page);
    table.push(["Platform > Impersonation log", "median length of 10, 20, 40, 50 minutes", `${e.trueMedian} min`, c.med, c.med === `${e.trueMedian} min` ? "yes" : "NO"]);
    expect(c.med, "the median of an even number of sessions").toBe(`${e.trueMedian} min`);
  });

  test("KNOWN QA13-IMPERSONATION-CARDS FIG-1454 (open): 'Write actions' counts the writes made (5 + 3 + 0), not the sessions allowed to write (3)", async ({ page }) => {
    test.fail();
    const e = await expectedFigures();
    await signIn(page, "joyce@figbloom.co.ke");
    const c = await readCards(page);
    table.push(["Platform > Impersonation log", "write actions (writes_count 5, 3 and 0)", `${e.writeActions} (${e.writes} sessions had write scope)`, c.w, c.w === String(e.writeActions) ? "yes" : "NO"]);
    expect(c.w, "write actions, by writes_count").toBe(String(e.writeActions));
  });

  test("KNOWN QA13-IMPERSONATION-CAP FIG-1454 (open): the cards count every session, not only the latest 100 the page loads", async ({ page }) => {
    test.fail();
    const rows = Array.from({ length: 110 }, (_, i) => ({ tenant_id: alliance, staff_id: joyce, reason: "QA13X", scope: "write", writes_count: 1, started_at: mins(300 + i) }));
    expect((await db.from("impersonation_sessions").insert(rows)).error).toBeNull();
    const e = await expectedFigures();
    await signIn(page, "joyce@figbloom.co.ke");
    const c = await readCards(page);
    table.push(["Platform > Impersonation log", "sessions, with 110 more added", `of ${e.total} sessions`, c.wSub, c.wSub === `of ${e.total} sessions` ? "yes" : "NO"]);
    expect(c.wSub, "the number of sessions the cards are built from").toBe(`of ${e.total} sessions`);
  });
});

test.describe("Platform: Audit trail", () => {
  test("the audit table cannot be changed or deleted through the API by anyone, so 'immutable' holds (checked as the platform admin through the page's own login)", async () => {
    // The page is read only; this checks the claim at the source: a platform-admin session can read but not alter an audit row.
    const asJoyce = createClient(process.env.SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!);
    expect((await asJoyce.auth.signInWithPassword({ email: "joyce@figbloom.co.ke", password: PASSWORD })).error).toBeNull();
    const row = (await asJoyce.from("audit_events").select("id, event").limit(1).single()).data!;
    const upd = await asJoyce.from("audit_events").update({ event: "QA13 tampered" }).eq("id", row.id as string).select("id");
    const del = await asJoyce.from("audit_events").delete().eq("id", row.id as string).select("id");
    const still = (await db.from("audit_events").select("event").eq("id", row.id as string).single()).data!.event;
    record("Platform > Audit trail", "a platform admin edits / deletes an audit row", "0 rows changed, event unchanged", `${upd.data?.length ?? 0} updated, ${del.data?.length ?? 0} deleted, event ${still === row.event ? "unchanged" : "CHANGED"}`);
    expect(upd.data ?? []).toHaveLength(0);
    expect(del.data ?? []).toHaveLength(0);
    expect(still).toBe(row.event);
  });

  test("KNOWN QA13-AUDIT-CAP FIG-1452 (open): 'Events today', 'Privileged changes' and 'Financial events' count all the events, not only the latest 200 the page loads", async ({ page }) => {
    test.fail();
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const count = async (f: (q: ReturnType<typeof db.from>) => unknown) => ((await (f(db.from("audit_events")) as PromiseLike<{ count: number | null }>)).count ?? 0);
    const today = await count((q) => q.select("id", { count: "exact", head: true }).gte("created_at", midnight.toISOString()));
    const privileged = await count((q) => q.select("id", { count: "exact", head: true }).in("category", ["access", "academic"]));
    const financial = await count((q) => q.select("id", { count: "exact", head: true }).eq("category", "financial"));
    await signIn(page, "joyce@figbloom.co.ke");
    const ls = await lines(page, "/platform/audit");
    const [t] = after(ls, "EVENTS TODAY", 1, 0, true);
    const [p] = after(ls, "PRIVILEGED CHANGES", 1, 0, true);
    const [f] = after(ls, "FINANCIAL EVENTS", 1, 0, true);
    const rowsShown = ls.filter((l) => /^\d{2} \w{3}, \d{2}:\d{2}$/.test(l)).length;
    table.push(["Platform > Audit trail", "events today / privileged / financial (all events)", `${today.toLocaleString("en-US")} / ${privileged} / ${financial.toLocaleString("en-US")}`, `${t} / ${p} / ${f}; ${rowsShown} rows listed`, `${t}/${p}/${f}` === `${today.toLocaleString("en-US")}/${privileged}/${financial.toLocaleString("en-US")}` ? "yes" : "NO"]);
    expect(t, "events today").toBe(today.toLocaleString("en-US"));
    expect(p, "privileged changes").toBe(String(privileged));
    expect(f, "financial events").toBe(financial.toLocaleString("en-US"));
  });

  test("with at most 200 events in play the cards and the list agree with the table: the page is right for the events it loads", async ({ page }) => {
    await signIn(page, "joyce@figbloom.co.ke");
    const latest = (await db.from("audit_events").select("category, created_at, tenants(name)").order("created_at", { ascending: false }).limit(200)).data as unknown as { category: string; created_at: string; tenants: { name: string } | null }[];
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const ls = await lines(page, "/platform/audit");
    const exp = {
      today: latest.filter((r) => new Date(r.created_at) >= midnight).length,
      priv: latest.filter((r) => r.category === "access" || r.category === "academic").length,
      fin: latest.filter((r) => r.category === "financial").length,
      schools: new Set(latest.filter((r) => new Date(r.created_at) >= midnight).map((r) => r.tenants?.name).filter(Boolean)).size,
    };
    record("Platform > Audit trail", "the same three cards over the latest 200 events", `${exp.today} / ${exp.priv} / ${exp.fin}, across ${exp.schools} schools`, `${after(ls, "EVENTS TODAY", 1, 0, true)[0]} / ${after(ls, "PRIVILEGED CHANGES", 1, 0, true)[0]} / ${after(ls, "FINANCIAL EVENTS", 1, 0, true)[0]}, ${after(ls, "EVENTS TODAY", 2, 0, true)[1]}`);
    expect(after(ls, "EVENTS TODAY", 1, 0, true)[0]).toBe(exp.today.toLocaleString("en-US"));
    expect(after(ls, "PRIVILEGED CHANGES", 1, 0, true)[0]).toBe(String(exp.priv));
    expect(after(ls, "FINANCIAL EVENTS", 1, 0, true)[0]).toBe(String(exp.fin));
    expect(after(ls, "EVENTS TODAY", 2, 0, true)[1]).toBe(`across ${exp.schools} schools`);
  });
});

test.describe("Platform: Organizations", () => {
  test("set up: a county office, a second county, a government body and a constituency, one with a member school and one with an admin", async () => {
    expect((await db.from("organizations").select("id", { count: "exact", head: true })).count, "one organization on the seed").toBe(1);
    const made = await db.from("organizations").insert([
      { name: "QA13X County A", slug: "qa13x-county-a", kind: "county" },
      { name: "QA13X County B", slug: "qa13x-county-b", kind: "county" },
      { name: "QA13X Government", slug: "qa13x-gov", kind: "government" },
      { name: "QA13X Constituency", slug: "qa13x-const", kind: "constituency" },
    ]).select("id, slug");
    expect(made.error).toBeNull();
    const a = made.data!.find((o) => o.slug === "qa13x-county-a")!.id as string;
    expect((await db.from("tenants").update({ organization_id: a }).eq("slug", "nakuru-girls")).error).toBeNull();
    const org = (await db.from("profiles").select("id").eq("role", "org_admin").limit(1).single()).data!.id as string;
    expect((await db.from("organization_admins").insert({ organization_id: a, profile_id: org })).error).toBeNull();
  });

  test("the four count cards match the organizations by kind", async ({ page }) => {
    const orgs = (await db.from("organizations").select("kind")).data ?? [];
    await signIn(page, "joyce@figbloom.co.ke");
    const ls = await lines(page, "/platform/organizations");
    const shown = { all: after(ls, "ORGANIZATIONS", 1, 0, true)[0], gov: after(ls, "GOVERNMENT/COUNTY", 1, 0, true)[0], con: after(ls, "CONSTITUENCIES", 1, 0, true)[0], grp: after(ls, "GROUP OWNERS", 1, 0, true)[0] };
    const want = { all: String(orgs.length), gov: String(orgs.filter((o) => o.kind === "government" || o.kind === "county").length), con: String(orgs.filter((o) => o.kind === "constituency").length), grp: String(orgs.filter((o) => o.kind === "group_owner").length) };
    record("Platform > Organizations", "organizations / government and county / constituencies / group owners", `${want.all} / ${want.gov} / ${want.con} / ${want.grp}`, `${shown.all} / ${shown.gov} / ${shown.con} / ${shown.grp}`);
    expect(shown).toEqual(want);
  });

  test("an organization's detail shows its member schools and its admins as the database has them", async ({ page }) => {
    await signIn(page, "joyce@figbloom.co.ke");
    await lines(page, "/platform/organizations");
    await page.getByText("QA13X County A", { exact: true }).first().click();
    await page.waitForTimeout(2500);
    const ls = (await page.locator("body").innerText()).split("\n").map((l) => l.trim()).filter(Boolean);
    const members = (await db.from("tenants").select("name").eq("organization_id", (await db.from("organizations").select("id").eq("slug", "qa13x-county-a").single()).data!.id as string)).data ?? [];
    const [ms] = after(ls, "MEMBER SCHOOLS", 1, 0, true);
    const [ad] = after(ls, "ORG ADMINS", 1, 0, true);
    record("Platform > Organizations", "QA13X County A: member schools / org admins", `${members.length} (${members.map((m) => m.name).join(", ")}) / 1`, `${ms} / ${ad}; lists ${ls.includes("Nakuru Girls High") ? "Nakuru Girls High" : "no school"}`);
    expect(ms).toBe(String(members.length));
    expect(ad).toBe("1");
    expect(ls).toContain("Nakuru Girls High");
    expect(ls).toContain("group@kijaniridge.sc.ke");
  });

  test("'+ Add' creates the organization with the typed name, kind and county and a lower-case slug, and a repeated slug is refused", async ({ page }) => {
    await signIn(page, "joyce@figbloom.co.ke");
    await lines(page, "/platform/organizations");
    const add = async (slug: string) => {
      await page.getByRole("button", { name: "+ Add" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name", { exact: true }).fill("QA13X Added"); // "Contact name (optional)" also contains "Name"
      await dialog.getByLabel("Slug").fill(slug);
      await dialog.getByLabel("Kind").selectOption("county");
      await dialog.getByLabel("County (optional)").fill("Nakuru");
      await dialog.getByRole("button", { name: /^Create/ }).click();
      return dialog;
    };
    await add("QA13X-Added-Org");
    await expect(page.getByText("QA13X Added created.")).toBeVisible({ timeout: 15000 });
    const made = (await db.from("organizations").select("name, slug, kind, county").eq("slug", "qa13x-added-org")).data ?? [];
    expect(made).toEqual([{ name: "QA13X Added", slug: "qa13x-added-org", kind: "county", county: "Nakuru" }]);
    await page.waitForTimeout(1500);
    const dialog = await add("qa13x-added-org");
    const shown = await page.getByText(/Could not create the organization/).first().innerText({ timeout: 15000 });
    record("Platform > Organizations", "'+ Add' twice with the same slug", "refused, in words, one row", `"${shown.replace(/\s+/g, " ").slice(0, 110)}"; rows: ${((await db.from("organizations").select("id").eq("slug", "qa13x-added-org")).data ?? []).length}`);
    expect((await db.from("organizations").select("id").eq("slug", "qa13x-added-org")).data).toHaveLength(1);
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });
});

test.describe("Platform: Curriculum", () => {
  let areas: { id: string; code: string; name: string; min_grade: number; max_grade: number; level: string; verified_at: string | null }[] = [];
  const cards = async (page: Page) => {
    const ls = await lines(page, "/platform/curriculum");
    return { ls, verified: after(ls, "Learning areas verified", 1)[0]!, grades: after(ls, "Grades with strands", 1)[0]! };
  };
  test("the two cards match the catalogue: areas verified of all, and learning area x grade slots that have strands", async ({ page }) => {
    areas = ((await db.from("learning_areas").select("id, code, name, min_grade, max_grade, level, verified_at").order("sort_order")).data ?? []) as typeof areas;
    const slots = areas.reduce((n, a) => n + (a.max_grade - a.min_grade + 1), 0);
    const strands = (await db.from("strands").select("learning_area_id, grade").is("tenant_id", null)).data ?? [];
    const covered = new Set(strands.map((s) => `${s.learning_area_id}:${s.grade}`)).size;
    await signIn(page, "joyce@figbloom.co.ke");
    const c = await cards(page);
    record("Platform > Curriculum", "areas verified / grades with strands", `${areas.filter((a) => a.verified_at).length} of ${areas.length}; ${covered} of ${slots}`, `${c.verified}; ${c.grades}`);
    expect(c.verified).toBe(`${areas.filter((a) => a.verified_at).length} of ${areas.length}`);
    expect(c.grades).toBe(`${covered} of ${slots}`);
  });

  test("strands loaded for a grade move the card and the grade's own 'strands / sub-strands' count", async ({ page }) => {
    const lang = areas.find((a) => a.code === "PP-LANG")!;
    const first = await db.from("strands").insert([{ learning_area_id: lang.id, grade: 1, name: "QA13X Listening", sort_order: 1 }, { learning_area_id: lang.id, grade: 1, name: "QA13X Speaking", sort_order: 2 }]).select("id");
    expect(first.error).toBeNull();
    const subs = await db.from("strands").insert([{ learning_area_id: lang.id, grade: 1, name: "QA13X Songs", parent_id: first.data![0]!.id, sort_order: 1 }, { learning_area_id: lang.id, grade: 1, name: "QA13X Stories", parent_id: first.data![0]!.id, sort_order: 2 }]);
    expect(subs.error).toBeNull();
    await signIn(page, "joyce@figbloom.co.ke");
    const c = await cards(page);
    const row = c.ls.slice(c.ls.findIndex((l) => l === "PP-LANG"), c.ls.findIndex((l) => l === "PP-LANG") + 8).join(" | ");
    record("Platform > Curriculum", "PP-LANG grade 1 after 2 strands and 2 sub-strands were loaded", "PP1 · 2/2; 1 of 208", `${row.match(/PP1 · \d+\/\d+/)?.[0]}; ${c.grades}`);
    expect(row).toContain("PP1 · 2/2");
    expect(row).toContain("PP2 · 0/0");
    expect(c.grades).toBe("1 of 208");
  });

  test("'Mark verified' stamps the area, the card follows, and 'Unverify' takes it back", async ({ page }) => {
    await signIn(page, "joyce@figbloom.co.ke");
    await cards(page);
    const row = page.getByLabel("Name of PP-LANG").locator("xpath=ancestor::*[.//button[normalize-space()='Mark verified']][1]");
    await row.getByRole("button", { name: "Mark verified" }).click();
    await expect(page.getByText(/verified\.$/).first()).toBeVisible({ timeout: 15000 });
    const stamped = (await db.from("learning_areas").select("verified_at").eq("code", "PP-LANG").single()).data!.verified_at;
    expect(stamped).not.toBeNull();
    await page.waitForTimeout(1500);
    expect((await cards(page)).verified).toBe(`1 of ${areas.length}`);
    await page.getByRole("button", { name: "Unverify" }).first().click();
    await expect(page.getByText(/marked unverified\./).first()).toBeVisible({ timeout: 15000 });
    expect((await db.from("learning_areas").select("verified_at").eq("code", "PP-LANG").single()).data!.verified_at).toBeNull();
    record("Platform > Curriculum", "Mark verified, then Unverify (PP-LANG)", "1 of 71, then 0 of 71", "as stated; verified_at stamped then cleared");
  });

  test("a strand CSV chosen through the file chooser is checked, imported with its counts in the message, and importing it again adds nothing", async ({ page }) => {
    await db.from("strands").delete().is("tenant_id", null); // the earlier test's strands
    await signIn(page, "joyce@figbloom.co.ke");
    await cards(page);
    const csv = "area_code,grade,strand,sub_strand\nPP-MATH,1,Numbers,Counting\nPP-MATH,1,Numbers,Matching\nPP-MATH,2,Shapes,\nXX-NOPE,1,Ghost,\n";
    const run = async () => {
      await page.getByRole("button", { name: "Import strands (CSV)" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("CSV file").setInputFiles({ name: "strands.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
      await dialog.getByLabel("Source").fill("QA13X test design");
      await dialog.getByRole("button", { name: "Check file" }).click();
      const checked = (await dialog.innerText()).replace(/\s+/g, " ");
      await dialog.getByRole("button", { name: /^Import \d+ strands?$/ }).click();
      return checked;
    };
    const checked = await run();
    record("Platform > Curriculum", "CSV check message (4 lines, one with an unknown area)", "2 strands ready, 1 line skipped, the bad line named", checked.match(/\d+ strands?[^✕]*skipped[^✕]*|Line \d+:[^✕]*/g)?.slice(0, 2).join(" / ") ?? checked.slice(-160));
    await expect(page.getByText("Added 2 strands and 2 sub-strands.")).toBeVisible({ timeout: 20000 });
    const rows = (await db.from("strands").select("grade, parent_id, name, source").is("tenant_id", null).order("grade")).data ?? [];
    expect(rows.filter((r) => !r.parent_id)).toHaveLength(2);
    expect(rows.filter((r) => r.parent_id)).toHaveLength(2);
    expect(rows.every((r) => r.source === "QA13X test design")).toBe(true);
    await page.waitForTimeout(1500);
    await run();
    await expect(page.getByText("Added 0 strands and 0 sub-strands.")).toBeVisible({ timeout: 20000 });
    expect((await db.from("strands").select("id", { count: "exact", head: true }).is("tenant_id", null)).count).toBe(4);
    expect(checked).toContain("Line 5"); // the unknown area is on line 5 of the file (header, three rows, then this one: 1 + 4)
  });
});

// ================================================================ more than 1,000 rows
test.describe("More than 1,000 rows", () => {
  const shillings = (cents: number) => `KSh ${(cents / 100).toLocaleString("en-US")}`;
  const expected: { billed: number; paid: number; byClass: Map<string, string>; mean: string } = { billed: 0, paid: 0, byClass: new Map(), mean: "" };

  test("set up: 1,200 more learners with an invoice each, and 888 more published marks, so the term passes 1,000 invoices and the latest exam 1,000 marks", async () => {
    const c1 = (await db.from("classes").select("id").eq("tenant_id", alliance).eq("name", "Form 1 East").single()).data!.id as string;
    const ids: string[] = [];
    for (let i = 0; i < 1100; i += 200) {
      const rows = Array.from({ length: 200 }, (_, j) => ({ tenant_id: alliance, admission_no: `QA13-E-${RUN}-${String(i + j + 1).padStart(4, "0")}`, full_name: `QA13E Learner ${i + j + 1}`, class_id: c1, boarding: false, active: true, gender: "female" }));
      const r = await db.from("students").insert(rows).select("id");
      expect(r.error).toBeNull();
      ids.push(...r.data!.map((s) => s.id as string));
    }
    for (let i = 0; i < ids.length; i += 200) {
      const r = await db.from("fee_invoices").insert(ids.slice(i, i + 200).map((id) => ({ tenant_id: alliance, student_id: id, term_id: term3, total_cents: 100000, paid_cents: 50000, due_on: "2026-12-01" })));
      expect(r.error).toBeNull();
    }
    const subj = async (code: string) => (await db.from("subjects").select("id").eq("tenant_id", alliance).eq("code", code).single()).data!.id as string;
    const codes = [await subj("CHE"), await subj("ENG"), await subj("MAT")];
    const others = await all<{ id: string; class_id: string }>((f, t) => db.from("students").select("id, class_id").eq("tenant_id", alliance).neq("class_id", west).not("admission_no", "like", "QA13-E-%").order("id").range(f, t));
    const marks = others.flatMap((s, i) => codes.map((c, k) => ({ tenant_id: alliance, exam_id: mock1, student_id: s.id, subject_id: c, score: 40 + ((i * 3 + k * 7) % 50), entered_by: teacherId })));
    for (let i = 0; i < marks.length; i += 300) expect((await db.from("marks").insert(marks.slice(i, i + 300))).error).toBeNull();
    const pubs = [...new Set(others.map((s) => s.class_id))].flatMap((cl) => codes.map((c) => ({ exam_id: mock1, class_id: cl, subject_id: c, tenant_id: alliance })));
    expect((await db.from("mark_publications").insert(pubs)).error).toBeNull();
    // what the screens should now say
    const invoices = await all<{ total_cents: number; paid_cents: number }>((f, t) => db.from("fee_invoices").select("total_cents, paid_cents").eq("tenant_id", alliance).eq("term_id", term3).order("id").range(f, t));
    expected.billed = invoices.reduce((a, i) => a + i.total_cents, 0);
    expected.paid = invoices.reduce((a, i) => a + i.paid_cents, 0);
    const students = await all<{ id: string; class_id: string }>((f, t) => db.from("students").select("id, class_id").eq("tenant_id", alliance).order("id").range(f, t));
    const classOf = new Map(students.map((s) => [s.id, s.class_id]));
    const allMarks = await all<{ student_id: string; score: number | null }>((f, t) => db.from("marks").select("student_id, score").eq("exam_id", mock1).order("id").range(f, t));
    expect(allMarks.length, "the latest exam now has more than 1,000 marks").toBeGreaterThan(1000);
    for (const c of (await db.from("classes").select("id, name").eq("tenant_id", alliance)).data ?? []) {
      const xs = allMarks.filter((m) => classOf.get(m.student_id) === c.id && m.score !== null).map((m) => m.score as number);
      expected.byClass.set(c.name as string, xs.length ? String(Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)) : "No marks");
    }
    expected.mean = String(Math.round((allMarks.reduce((a, m) => a + (m.score ?? 0), 0) / allMarks.length) * 10) / 10);
    table.push(["Large data (set up)", "latest exam marks / Term 3 invoices", "more than 1,000 of each", `${allMarks.length} marks, ${invoices.length} invoices`]);
    expect(invoices.length).toBeGreaterThan(1000);
  }, 240_000);

  test("Performance (which aggregates in the database) still shows the school's mean for every published mark", async ({ page }) => {
    await signIn(page, "principal@alliance.sc.ke");
    const ls = await lines(page, "/s/alliance/admin/performance");
    const [mean] = after(ls, "MEAN MARK", 1);
    const [, marks] = after(ls, "SUBJECTS OUT", 2, 0, true);
    record("Performance (1,000+ marks)", "whole-school mean", expected.mean, mean);
    expect(mean).toBe(expected.mean);
    expect(num(marks!)).toBeGreaterThan(1000);
  });

  test("KNOWN QA13-LARGE FIG-1438 (open): Reports' fee totals are the sums of every invoice of the term, not of the first 1,000", async ({ page }) => {
    test.fail();
    await signIn(page, "principal@alliance.sc.ke");
    const ls = await lines(page, "/s/alliance/admin/reports");
    const [pct, amounts] = after(ls, "FEES COLLECTED", 2, 0, true);
    const want = `${shillings(expected.paid)} of ${shillings(expected.billed)}`;
    record("Reports (1,000+ invoices)", "fees collected", `${Math.round((expected.paid / expected.billed) * 100)}% ${want}`, `${pct} ${amounts}`);
    expect(`${pct} ${amounts}`).toBe(`${Math.round((expected.paid / expected.billed) * 100)}% ${want}`);
  });

  test("KNOWN QA13-LARGE FIG-1438 (open): the Dashboard's fee totals are the sums of every invoice of the term, not of the first 1,000", async ({ page }) => {
    test.fail();
    await signIn(page, "principal@alliance.sc.ke");
    const ls = await lines(page, "/s/alliance/admin");
    const [pct, amounts] = after(ls, "FEES COLLECTED", 2, 0, true);
    const want = `${shillings(expected.paid)} of ${shillings(expected.billed)}`;
    record("Dashboard (1,000+ invoices)", "fees collected", `${Math.round((expected.paid / expected.billed) * 100)}% ${want}`, `${pct} ${amounts}`);
    expect(`${pct} ${amounts}`).toBe(`${Math.round((expected.paid / expected.billed) * 100)}% ${want}`);
  });

  test("KNOWN QA13-LARGE FIG-1439 (open): Reports' class means use every mark of the exam, not the first 1,000", async ({ page }) => {
    test.fail();
    await signIn(page, "principal@alliance.sc.ke");
    const ls = await lines(page, "/s/alliance/admin/reports");
    const start = ls.findIndex((l) => l.toLowerCase().startsWith("academic performance"));
    const wrong: string[] = [];
    for (const [name, want] of expected.byClass) {
      const got = after(ls, name, 1, start)[0]!.split(" · ")[0]!;
      record("Reports (1,000+ marks)", `${name} class mean`, want, got);
      if (got !== want) wrong.push(`${name}: ${got} not ${want}`);
    }
    expect(wrong, "class means that differ from the database").toEqual([]);
  });

  test("the Fees screen (which reads page by page) still shows the sums of every invoice", async ({ page }) => {
    await signIn(page, "principal@alliance.sc.ke");
    const text = (await lines(page, "/s/alliance/admin/fees")).join(" ");
    record("Fees (1,000+ invoices)", "billed this term", shillings(expected.billed), text.includes(shillings(expected.billed)) ? shillings(expected.billed) : "not on the screen");
    expect(text).toContain(shillings(expected.billed));
  });

  test("the Tenants page's 'Learner seats' (a count, not a list) is right at scale", async ({ page }) => {
    const learners = (await db.from("students").select("id", { count: "exact", head: true }).eq("active", true)).count ?? 0;
    await signIn(page, "joyce@figbloom.co.ke");
    const ls = await lines(page, "/platform/tenants");
    const [seats] = after(ls, "Learner seats", 1);
    record("Platform > Tenants (1,000+ learners)", "learner seats", learners.toLocaleString("en-US"), seats);
    expect(seats).toBe(learners.toLocaleString("en-US"));
  });

  test("KNOWN QA13-USAGE-LARGE FIG-1450 (open): Platform > Usage counts every active learner of the platform, not the first 1,000", async ({ page }) => {
    test.fail();
    const learners = (await db.from("students").select("id", { count: "exact", head: true }).eq("active", true)).count ?? 0;
    const staff = (await db.from("profiles").select("id", { count: "exact", head: true }).in("role", ["school_admin", "teacher"]).not("tenant_id", "is", null)).count ?? 0;
    await signIn(page, "joyce@figbloom.co.ke");
    const ls = await lines(page, "/platform/usage");
    const [value] = after(ls, "SEATS IN USE", 1, 0, true);
    record("Platform > Usage (1,000+ learners)", "seats in use (learners and staff, as the page counts them)", (learners + staff).toLocaleString("en-US"), value);
    expect(value).toBe((learners + staff).toLocaleString("en-US"));
  });
});
