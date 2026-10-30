import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { KCSE, expected } from "../packages/shared/src/gradeTables.fixture";
import { pdfPageTexts } from "../packages/shared/src/pdfText.fixture";

process.loadEnvFile?.(); // Node 20.6+ built-in
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

/**
 * QA 09 follow-up (FIG-1242): report cards, from the marks in the database to the screen, the PDF and the family.
 *
 * Seed data only (npm run db:seed): Alliance, Form 2 West, 43 learners, nine subjects, exam "Mock 1", every subject published.
 * The office prepares the class on the admin screen, and every figure it shows (mean, grade, position) is compared with a value
 * worked out here from the marks in the database and the hand-typed KCSE table (packages/shared/src/gradeTables.fixture.ts),
 * never from the app's own functions. The PDFs the screen downloads are read back and compared the same way, page by page. Then
 * the class teacher writes a comment, the office sends ONE card to families, and the parent's Results screen and the card the
 * parent downloads are compared with each other and with the database.
 *
 * It writes 43 report cards into the seeded current term for Form 2 West and deletes them afterwards (beforeAll and afterAll).
 * Sending one card writes two audit entries (sent, withdrawn) that a school admin cannot delete; they stay in the local database.
 * Desktop only: the office prepares report cards on a desktop. Needs the stack and the edge functions running.
 */
test.describe.configure({ mode: "serial", timeout: 90_000 }); // the first PDF after a cold Vite loads the PDF library and reloads the page
test.skip(({ isMobile }) => isMobile, "report cards are prepared on a desktop");

const SCHOOL = "Alliance High School";
const CLASS = "Form 2 West";
const EXAM = "Mock 1";
const PASSWORD = "figbloom-dev";

// ---------------------------------------------------------------- what the database says, worked out by hand

interface Learner { id: string; name: string; adm: string; scores: Map<string, number>; total: number; mean: number; grade: string; points: number; position: number }
interface Facts { tenantId: string; termId: string; termName: string; classId: string; learners: Learner[]; classMean: Map<string, number>; subjects: string[] }

async function facts(): Promise<Facts> {
  const tenant = (await db.from("tenants").select("id").eq("slug", "alliance").single()).data!.id as string;
  const term = (await db.from("terms").select("id, name").eq("tenant_id", tenant).eq("is_current", true).single()).data!;
  const cls = (await db.from("classes").select("id").eq("tenant_id", tenant).eq("name", CLASS).single()).data!.id as string;
  const exam = (await db.from("exams").select("id").eq("tenant_id", tenant).eq("name", EXAM).single()).data!.id as string;
  const students = (await db.from("students").select("id, full_name, admission_no").eq("class_id", cls).eq("active", true)).data!;
  const marks = (await db.from("marks").select("student_id, score, subjects(name)").eq("exam_id", exam).in("student_id", students.map((s) => s.id))).data!;

  const subjects = [...new Set(marks.map((m) => (m.subjects as unknown as { name: string }).name))].sort();
  const partial = students.map((s) => {
    const scores = new Map<string, number>();
    for (const m of marks.filter((x) => x.student_id === s.id)) scores.set((m.subjects as unknown as { name: string }).name, m.score as number);
    const total = [...scores.values()].reduce((a, b) => a + b, 0);
    const mean = Math.round(total / scores.size); // 43 and 9 are odd, so no average is ever exactly .5
    const points = [...scores.values()].reduce((a, sc) => a + expected(KCSE, sc)![1], 0);
    return { id: s.id as string, name: s.full_name as string, adm: s.admission_no as string, scores, total, mean, grade: expected(KCSE, mean)![0], points };
  });
  const learners = partial.map((l) => ({ ...l, position: 1 + partial.filter((o) => o.mean > l.mean).length }));
  const classMean = new Map(subjects.map((name) => {
    const all = learners.map((l) => l.scores.get(name)).filter((x): x is number => x !== undefined);
    return [name, Math.round(all.reduce((a, b) => a + b, 0) / all.length)] as const;
  }));
  return { tenantId: tenant, termId: term.id as string, termName: term.name as string, classId: cls, learners, classMean, subjects };
}

const summaryLine = (l: Learner, ranked: number, subjectCount: number) =>
  `Subjects: ${subjectCount} · Total: ${l.total} · Mean: ${l.mean}% · Mean grade: ${l.grade} · Points: ${l.points} · Position: ${l.position} of ${ranked}`;

// ---------------------------------------------------------------- the browser

test.beforeAll(async () => {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.SUPABASE_URL ?? "")) throw new Error("local Supabase only");
  await db.from("login_lookups").delete().gte("looked_up_at", "1970-01-01"); // same reason as flows.spec.ts
  const f = await facts();
  await db.from("report_cards").delete().eq("term_id", f.termId).eq("class_id", f.classId);
});
test.afterAll(async () => {
  const f = await facts();
  await db.from("report_cards").delete().eq("term_id", f.termId).eq("class_id", f.classId);
});

async function signInAdmin(page: Page) {
  await page.goto("/signin");
  await page.getByRole("button", { name: "Admin portal" }).click();
  await page.getByRole("button", { name: "Sign in with email instead" }).click();
  await page.getByLabel("Email").fill("principal@alliance.sc.ke");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 15000 });
}

async function signInWithId(page: Page, portal: "Teacher" | "Parent", loginId: string) {
  await page.goto("/signin");
  await page.getByRole("button", { name: `${portal} portal` }).click();
  await page.getByLabel("School").fill(SCHOOL);
  await page.getByRole("button").filter({ hasText: SCHOOL }).first().click();
  await page.getByLabel("Your ID").fill(loginId);
  await page.getByLabel("Your ID").blur();
  await expect(page.getByText(/^Signing in as /)).toBeVisible({ timeout: 5000 });
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 15000 });
}

/** Presses a button that starts a download, and returns the file's name and bytes. */
async function download(page: Page, press: () => Promise<void>) {
  const [file] = await Promise.all([page.waitForEvent("download"), press()]);
  return { name: file.suggestedFilename(), bytes: new Uint8Array(await readFile((await file.path())!)) };
}

async function openOfficeScreen(page: Page) {
  await page.goto("/s/alliance/admin/report-cards");
  await page.getByLabel("Class", { exact: true }).selectOption({ label: CLASS });
}

// ---------------------------------------------------------------- 1. the office prepares the class

test.describe("the office prepares Form 2 West", () => {
  // KNOWN FIG-1387 (open): the screen says every exam with results out counts by default, but on first load nothing is ticked and
  // Prepare is off. After switching to another term the OLD term's exam stays selected without being shown, and Prepare is on.
  // Both come from the two effects in ReportCards.tsx that read the exam list before the new term's exams have arrived.
  // test.fail(): passes while the defect is there; when it is fixed it fails and tells you to remove test.fail().
  test("KNOWN FIG-1387 (open): the exam with results out is ticked by default", async ({ page }) => {
    test.fail();
    await signInAdmin(page);
    await openOfficeScreen(page);
    await expect(page.getByText("(no results out)")).toBeVisible();
    await expect(page.getByLabel(EXAM)).toBeChecked();
  });

  test("KNOWN FIG-1387 (open): a term with no exams cannot be prepared", async ({ page }) => {
    test.fail();
    await signInAdmin(page);
    await openOfficeScreen(page);
    await page.getByLabel("Term", { exact: true }).selectOption({ label: "Term 2, 2026" });
    await expect(page.getByText("No exams this term.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Prepare/ })).toBeDisabled(); // never pressed here
  });

  test("ticking the exam by hand, preparing makes one card per learner", async ({ page }) => {
    const f = await facts();
    expect(f.learners, "the seed: 43 learners with nine marks each").toHaveLength(43);
    expect(f.subjects).toHaveLength(9);
    await signInAdmin(page);
    await openOfficeScreen(page);
    await expect(page.getByText("(no results out)")).toBeVisible();
    await page.getByLabel(EXAM).check();
    await expect(page.getByLabel(/End of Term 3/)).not.toBeChecked();
    await page.getByRole("button", { name: "Prepare report cards" }).click();
    await expect(page.getByText("43 report cards prepared.")).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(`${CLASS} · 43 report cards`)).toBeVisible();
    expect((await db.from("report_cards").select("id", { count: "exact", head: true }).eq("term_id", f.termId).eq("class_id", f.classId)).count).toBe(43);
  });

  test("every learner's mean, grade and position on the screen is the hand-worked one", async ({ page }) => {
    const f = await facts();
    await signInAdmin(page);
    await openOfficeScreen(page);
    const rows = page.getByRole("row").filter({ hasText: "ADM " });
    await expect(rows).toHaveCount(43);
    const shown = new Map<string, string[]>();
    for (let i = 0; i < 43; i++) {
      const cells = await rows.nth(i).locator(":scope > div").allInnerTexts();
      shown.set(cells[0]!.split("\n")[1]!.replace("ADM ", ""), cells);
    }
    const bad: string[] = [];
    for (const l of f.learners) {
      const cells = shown.get(l.adm);
      const got = cells ? [cells[0]!.split("\n")[0], cells[1], cells[2], cells[3]] : null;
      const want = [l.name, `${l.mean}%`, l.grade, `${l.position}/43`];
      if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`ADM ${l.adm}: screen ${JSON.stringify(got)}, database says ${JSON.stringify(want)}`);
    }
    expect(bad, "learners whose row differs from the hand-worked figures").toEqual([]);
    // the table is not trivially flat: the seed has many different means, so ties are real but rare
    expect(new Set(f.learners.map((l) => l.mean)).size).toBeGreaterThan(10);
  });

  test("the class PDF has one page per learner, and every page prints that learner's hand-worked rows and summary", async ({ page }) => {
    const f = await facts();
    await signInAdmin(page);
    await openOfficeScreen(page);
    const pdf = await download(page, () => page.getByRole("button", { name: "All report cards (PDF)" }).click());
    expect(pdf.name).toBe(`${f.termName} report cards - ${CLASS}.pdf`);
    const pages = await pdfPageTexts(pdf.bytes);
    expect(pages).toHaveLength(43);
    const bad: string[] = [];
    const seen = new Set<string>();
    for (const text of pages) {
      const lines = text.split("\n");
      // by admission number: three pairs of learners in this class share a name
      const adm = lines[lines.indexOf("Admission no.") + 1]!;
      const l = f.learners.find((x) => x.adm === adm);
      if (!l) { bad.push(`a page for admission number ${adm}, who is not in the class`); continue; }
      if (lines[lines.indexOf("Name") + 1] !== l.name) bad.push(`ADM ${adm}: the page says "${lines[lines.indexOf("Name") + 1]}", the database says "${l.name}"`);
      seen.add(l.adm);
      for (const subject of f.subjects) {
        const score = l.scores.get(subject)!;
        const [grade, points] = expected(KCSE, score)!;
        const i = lines.indexOf(subject);
        const got = lines.slice(i, i + 6).join("|");
        const want = [subject, score, score, grade, points, f.classMean.get(subject)].join("|");
        if (got !== want) bad.push(`${l.name} ${subject}: PDF ${got}, database says ${want}`);
      }
      if (!lines.includes(summaryLine(l, 43, 9))) bad.push(`${l.name}: no summary line ${summaryLine(l, 43, 9)}`);
    }
    expect(bad, "PDF lines that differ from the hand-worked figures").toEqual([]);
    expect(seen.size, "every learner has a page").toBe(43);
  });

  test("one learner's PDF is named after the term and the learner", async ({ page }) => {
    const f = await facts();
    await signInAdmin(page);
    await openOfficeScreen(page);
    const l = f.learners.find((x) => x.name === "Faith Achieng")!;
    const pdf = await download(page, () => page.getByRole("row").filter({ hasText: `ADM ${l.adm}` }).getByRole("button", { name: "PDF" }).click());
    expect(pdf.name).toBe(`${f.termName} report card - ${l.name}.pdf`);
    const [text] = await pdfPageTexts(pdf.bytes);
    expect(text!.split("\n")).toContain(summaryLine(l, 43, 9));
  });
});

// ---------------------------------------------------------------- 2. the class teacher

test.describe("the class teacher", () => {
  test("sees the class's drafts, cannot prepare or send, and writes the class teacher's comment", async ({ page }) => {
    const f = await facts();
    await signInWithId(page, "Teacher", "TC-0002");
    await page.goto("/s/alliance/teacher/report-cards");
    await expect(page.getByText(`${CLASS} · 43 report cards`)).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "Prepare report cards" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Send \d+ to families/ })).toHaveCount(0);

    const first = page.getByRole("row").filter({ hasText: "ADM " }).first();
    const name = (await first.locator(":scope > div").first().innerText()).split("\n")[0]!;
    await first.getByRole("button", { name: "Comments" }).click();
    await page.getByLabel("Class teacher's comment").fill("Steady progress this term.");
    await page.getByRole("button", { name: "Save comments" }).click();
    await expect(page.getByText("Comments saved.")).toBeVisible();

    const cards = (await db.from("report_cards").select("teacher_comment, data").eq("term_id", f.termId).eq("class_id", f.classId)).data!;
    const card = cards.find((c) => (c.data as { learner: { name: string } }).learner.name === name)!;
    expect(card.teacher_comment).toBe("Steady progress this term.");
    expect(cards.filter((c) => c.teacher_comment !== null), "only that learner's card has a comment").toHaveLength(1);
  });
});

// ---------------------------------------------------------------- 3. sending one card to a family

test.describe("one card goes to a family", () => {
  test("the office sends Faith's card, and only hers", async ({ page }) => {
    const f = await facts();
    const faith = f.learners.find((x) => x.name === "Faith Achieng")!;
    // Keep one card, so that "Send to families" can only mean this one (the other 42 would otherwise add 42 audit entries).
    await db.from("report_cards").delete().eq("term_id", f.termId).eq("class_id", f.classId).neq("student_id", (await db.from("students").select("id").eq("admission_no", faith.adm).single()).data!.id as string);
    await signInAdmin(page);
    await openOfficeScreen(page);
    await expect(page.getByText(`${CLASS} · 1 report card`)).toBeVisible();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Send 1 to families" }).click();
    await expect(page.getByText("Report cards sent to families.")).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: `ADM ${faith.adm}` }).getByText("Sent", { exact: true })).toBeVisible();
    const sent = (await db.from("report_cards").select("published_at").eq("term_id", f.termId).eq("class_id", f.classId)).data!;
    expect(sent.map((c) => c.published_at !== null)).toEqual([true]);
  });

  test("the parent's Results screen and the report card agree on Faith's mean and grade, and the PDF prints them", async ({ page }) => {
    const f = await facts();
    const faith = f.learners.find((x) => x.name === "Faith Achieng")!;
    await signInWithId(page, "Parent", "PT-0002");
    await page.goto("/s/alliance/parent/results");
    await expect(page.getByText(`${CLASS} · ADM ${faith.adm}`)).toBeVisible({ timeout: 15000 });

    // The marks screen: "MEAN GRADE · MOCK 1", the grade, and "N marks".
    const block = page.locator("div.rounded-lg", { hasText: "MEAN GRADE" }).first();
    await expect(block).toBeVisible();
    const [, resultsGrade, resultsMean] = /MEAN GRADE.*\n(\S+)\n(\d+) marks/.exec(await block.innerText())!;
    expect([resultsGrade, Number(resultsMean)], "the marks screen").toEqual([faith.grade, faith.mean]);

    // The report card entry under it.
    const entry = page.locator("section", { has: page.getByRole("heading", { name: "Report cards", exact: true }) }).locator("li");
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText(f.termName);
    expect((await entry.innerText()).replace(/\s+/g, " ")).toContain(`${CLASS} · mean ${faith.mean}%, ${faith.grade}`);

    const pdf = await download(page, () => entry.getByRole("button", { name: "Download PDF" }).click());
    expect(pdf.name).toBe(`${f.termName} report card - ${faith.name}.pdf`);
    const [text] = await pdfPageTexts(pdf.bytes);
    expect(text!.split("\n")).toContain(summaryLine(faith, 43, 9));
  });

  test("withdrawing takes the card off the parent's screen", async ({ page }) => {
    const f = await facts();
    await signInAdmin(page);
    await openOfficeScreen(page);
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Withdraw all" }).click();
    await expect(page.getByText("Report cards withdrawn.")).toBeVisible();
    expect((await db.from("report_cards").select("published_at").eq("term_id", f.termId).eq("class_id", f.classId)).data!.map((c) => c.published_at)).toEqual([null]);

    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await signInWithId(page, "Parent", "PT-0002");
    await page.goto("/s/alliance/parent/results");
    await expect(page.getByText("MEAN GRADE")).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("heading", { name: "Report cards" })).toHaveCount(0);
  });
});
