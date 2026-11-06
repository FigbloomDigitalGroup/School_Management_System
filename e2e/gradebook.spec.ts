import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

process.loadEnvFile?.(); // Node 20.6+ built-in
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

/**
 * QA 09 (FIG-1242): the teacher's gradebook, read as a teacher sees it.
 *
 * Marks are typed into one unpublished, empty column of the seed (Alliance, Form 1 East, Chemistry, End of Term 3: teacher TC-0002's)
 * and the screen is read back. Nothing is saved or published: typing only changes the page, and the Save and Publish buttons are
 * never pressed. The last test checks that no mark was written. The grades expected here are typed out below from the KCSE table,
 * not taken from the app's own code; packages/shared/src/gradeTables.test.ts holds the same table for every mark from 0 to 100,
 * and tests/integration/marksAndPublishing.test.ts drives the saving and publishing behind this screen.
 *
 * Seed data only (npm run db:seed): the column must have no marks yet and must not be published.
 */
test.describe.configure({ mode: "serial" });

const SCHOOL = "Alliance High School";
const CLASS = "Form 1 East";
const EXAM = "End of Term 3";
const SUBJECT = "Chemistry";

test.beforeAll(async () => {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.SUPABASE_URL ?? "")) throw new Error("local Supabase only");
  await db.from("login_lookups").delete().gte("looked_up_at", "1970-01-01"); // same reason as flows.spec.ts
});

async function marksInColumn() {
  const exam = await db.from("exams").select("id").eq("name", EXAM).single();
  const marks = await db.from("marks").select("id, students!inner(classes!inner(name))", { count: "exact", head: true })
    .eq("exam_id", exam.data!.id as string).eq("students.classes.name", CLASS);
  return marks.count ?? 0;
}

async function signInAsTeacher(page: Page) {
  await page.goto("/signin");
  await page.getByRole("button", { name: "Teacher portal" }).click();
  await page.getByLabel("School").fill(SCHOOL);
  await page.getByRole("button").filter({ hasText: SCHOOL }).first().click();
  await page.getByLabel("Your ID").fill("TC-0002");
  await page.getByLabel("Your ID").blur();
  await expect(page.getByText(/^Signing in as /)).toBeVisible({ timeout: 5000 });
  await page.getByLabel("Password").fill("figbloom-dev");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 15000 });
}

/** Opens the empty column and returns how many learners the class has. */
async function openColumn(page: Page) {
  await signInAsTeacher(page);
  await page.goto("/s/alliance/teacher/gradebook");
  await page.getByLabel("Class").selectOption({ label: CLASS });
  await page.getByLabel("Subject").selectOption({ label: SUBJECT });
  await page.getByLabel("Exam").selectOption({ label: EXAM });
  await expect(page.getByText("Draft: school staff only")).toBeVisible();
  await expect(page.locator("[data-row]").first()).toBeVisible();
  const learners = await page.locator("[data-row]").count();
  await expect(page.getByText(`0 of ${learners} entered`)).toBeVisible();
  return learners;
}

const input = (page: Page, i: number) => page.locator(`[data-row="${i}"]`);
/** The grade cell of row i: the fourth cell of the row that holds the input. */
const gradeCell = (page: Page, i: number) => input(page, i).locator("xpath=../..").locator(":scope > div").nth(3);
const publishButton = (page: Page) => page.getByRole("button", { name: /still to enter|Publish marks|Fix \d+ marks?/ });

// The KCSE table as printed: [lowest mark, grade]. Each grade runs up to the next line.
const KCSE: Array<[number, string]> = [
  [0, "E"], [30, "D-"], [35, "D"], [40, "D+"], [45, "C-"], [50, "C"], [55, "C+"], [60, "B-"], [65, "B"], [70, "B+"], [75, "A-"], [80, "A"],
];
// Every cut-off, the mark just below it, the extremes, and a mark in the middle of a band.
const MARKS: Array<[number, string]> = [
  [0, "E"], [29, "E"], [30, "D-"], [34, "D-"], [35, "D"], [39, "D"], [40, "D+"], [44, "D+"], [45, "C-"], [49, "C-"], [50, "C"], [54, "C"],
  [55, "C+"], [59, "C+"], [60, "B-"], [64, "B-"], [65, "B"], [69, "B"], [70, "B+"], [74, "B+"], [75, "A-"], [79, "A-"], [80, "A"], [100, "A"],
  [57, "C+"], [92, "A"],
];

test.describe("teacher gradebook, one empty column", () => {
  test("the table typed here is the KCSE table: the marks below are on the right side of every line", () => {
    for (const [mark, grade] of MARKS) {
      const line = [...KCSE].reverse().find(([lowest]) => mark >= lowest)!;
      expect(line[1], `${mark}`).toBe(grade);
    }
  });

  test("each typed mark shows the grade the KCSE table gives it", async ({ page }) => {
    const learners = await openColumn(page);
    expect(learners).toBeGreaterThanOrEqual(MARKS.length);
    for (const [i, [mark]] of MARKS.entries()) await input(page, i).fill(String(mark));
    for (const [i, [mark, grade]] of MARKS.entries()) await expect(gradeCell(page, i), `${mark} should show ${grade}`).toHaveText(grade);
    // The rows with nothing typed show a dash, not a grade.
    await expect(gradeCell(page, MARKS.length)).toHaveText("—");
  });

  test("a missed paper is 'abs', a blank is a dash and a zero is a mark (an E), not the same thing", async ({ page }) => {
    const learners = await openColumn(page);
    await input(page, 0).fill("abs");
    await input(page, 1).fill("0");
    await expect(gradeCell(page, 0)).toHaveText("abs");
    await expect(gradeCell(page, 1)).toHaveText("E");
    await expect(gradeCell(page, 2)).toHaveText("—");
    // Both a zero and an abs count as entered; the blank does not.
    await expect(page.getByText(`2 of ${learners} entered`)).toBeVisible();
    // 'abs' is left out of the mean and the zero is in it: the only number is the zero.
    await expect(page.getByText("your mean 0")).toBeVisible();
    await input(page, 0).fill("");
    await expect(page.getByText(`1 of ${learners} entered`)).toBeVisible();
  });

  test("'your mean' is worked out as (90 + 80 + 71 + 0) / 4 = 60.25, shown as 60; nothing is out yet, so there is no class mean", async ({ page }) => {
    const learners = await openColumn(page);
    for (const [i, mark] of [90, 80, 71, 0].entries()) await input(page, i).fill(String(mark));
    await expect(page.getByText(`4 of ${learners} entered`)).toBeVisible();
    await expect(page.getByText("your mean 60")).toBeVisible();
    await expect(page.getByText("no class mean yet")).toBeVisible();
    // Exactly .5 goes up, as it does on the server: (84 + 85) / 2 = 84.5.
    for (let i = 0; i < 4; i++) await input(page, i).fill("");
    await input(page, 0).fill("84");
    await input(page, 1).fill("85");
    await expect(page.getByText("your mean 85")).toBeVisible();
  });

  test("a mark the paper cannot have is refused in words, not accepted", async ({ page }) => {
    await openColumn(page);
    await input(page, 0).fill("101");
    await expect(page.getByText("This paper is out of 100.")).toBeVisible();
    await expect(input(page, 0)).toHaveAttribute("aria-invalid", "true");
    await input(page, 0).fill("72.5");
    await expect(page.getByText("Numbers only, or 'abs' if they missed it.")).toBeVisible();
    await input(page, 0).fill("-5");
    await expect(page.getByText("Numbers only, or 'abs' if they missed it.")).toBeVisible();
    await input(page, 0).fill("72");
    await expect(input(page, 0)).toHaveAttribute("aria-invalid", "false");
    await expect(gradeCell(page, 0)).toHaveText("B+");
  });

  test("Publish stays off, and says how many learners are still to enter, until every learner has an entry", async ({ page }) => {
    const learners = await openColumn(page);
    await expect(publishButton(page)).toBeDisabled();
    await expect(publishButton(page)).toHaveText(`${learners} still to enter`);

    await input(page, 0).fill("55");
    await input(page, 1).fill("abs");
    await expect(publishButton(page)).toHaveText(`${learners - 2} still to enter`);
    await expect(publishButton(page)).toBeDisabled();

    for (let i = 2; i < learners - 1; i++) await input(page, i).fill("60");
    await expect(publishButton(page)).toHaveText("1 still to enter");
    await expect(publishButton(page)).toBeDisabled();

    // The last one makes it ready. The button is looked at, never pressed.
    await input(page, learners - 1).fill("0");
    await expect(publishButton(page)).toHaveText("Publish marks");
    await expect(publishButton(page)).toBeEnabled();
  });

  // KNOWN FIG-1374 (open): the screen counts anything typed in a box as "entered", even a mark it has just refused. With
  // one such box the column is "complete", Publish is on, and the press saves the valid marks, drops the refused one and publishes
  // the class with one learner missing (the server accepts that too: FIG-1375, in marksAndPublishing.test.ts).
  // test.fail(): passes while the defect is there; when it is fixed it fails and tells you to remove test.fail().
  for (const typed of ["abc", "140", "72.5"]) {
    test(`FIG-1374: '${typed}' in one box does not make the column ready to publish`, async ({ page }) => {
      const learners = await openColumn(page);
      for (let i = 0; i < learners - 1; i++) await input(page, i).fill("60");
      await input(page, learners - 1).fill(typed);
      await expect(input(page, learners - 1)).toHaveAttribute("aria-invalid", "true"); // the screen does see it is wrong
      await expect(publishButton(page)).toBeDisabled();
      await expect(publishButton(page)).toHaveText("Fix 1 mark");
    });
  }

  test("nothing typed above was saved: the column still has no marks", async () => {
    expect(await marksInColumn()).toBe(0);
  });
});
