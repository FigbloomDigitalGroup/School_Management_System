import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { SeedOutput } from "../../scripts/api-seed/seed";
import { computeTotpCode } from "../../scripts/api-seed/totp";

const SEED_PATH = process.env.API_SEED_OUTPUT
  ? resolve(process.cwd(), process.env.API_SEED_OUTPUT)
  : resolve(tmpdir(), "figbloom-api-seed.json");

function loadSeed(): SeedOutput {
  if (!existsSync(SEED_PATH)) {
    throw new Error(`Missing API seed output at ${SEED_PATH}. Run "npm run api:seed" against a local apps/api first.`);
  }
  return JSON.parse(readFileSync(SEED_PATH, "utf8")) as SeedOutput;
}

async function signOut(page: Page) {
  await page.getByRole("navigation", { name: "Main" }).locator('button[aria-haspopup="menu"]').click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/signin/, { timeout: 15_000 });
}

async function signInTeacher(page: Page, seed: SeedOutput) {
  await page.goto("/signin");
  await page.locator("#api-email").fill(seed.teacher.email);
  await page.locator("#api-password").fill(seed.teacher.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${seed.slug}/teacher`), { timeout: 15_000 });
}

/** The admin signs in with a TOTP code; a code is accepted once, so a second sign-in waits for the next 30 s step. */
async function signInAdmin(page: Page, seed: SeedOutput) {
  await page.goto("/signin");
  await page.locator("#api-email").fill(seed.admin.email);
  await page.locator("#api-password").fill(seed.admin.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  const mfaInput = page.locator("#api-mfa-answer");
  await expect(mfaInput).toBeVisible({ timeout: 15_000 });

  const adminUrl = new RegExp(`/s/${seed.slug}/admin`);
  for (const attempt of [0, 1]) {
    if (attempt === 1) await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 750);
    await mfaInput.fill(computeTotpCode(seed.admin.totpSecret, Date.now(), 0));
    await page.getByRole("button", { name: "Continue" }).click();
    try {
      await expect(page).toHaveURL(adminUrl, { timeout: 4_000 });
      return;
    } catch {
      if (attempt === 1) throw new Error("Admin MFA sign-in did not complete after waiting for next TOTP step.");
    }
  }
}

const two = (n: number) => String(n).padStart(2, "0");

test.describe("Timetable and My classes on the new API (VITE_BACKEND=api)", () => {
  test("admin adds a period to a class; the class teacher sees it on Timetable and as their class under My classes", async ({ page }) => {
    test.setTimeout(120_000);
    const seed = loadSeed();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    // A random 20-minute period so a re-run against the same local API does not hit the overlap refusal.
    const hour = 5 + Math.floor(Math.random() * 14);
    const minute = Math.floor(Math.random() * 40);
    const starts = `${two(hour)}:${two(minute)}`;
    const ends = `${two(hour)}:${two(minute + 15)}`;
    const room = `TT-${Date.now() % 100000}`;

    // 1. The administrator opens Classes, then the Timetable window of Form 1 East.
    await signInAdmin(page, seed);
    await page.goto(`/s/${seed.slug}/admin/classes`);
    const main = page.locator("main");
    const row = main.locator('[role="row"]', { hasText: "Form 1 East" });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole("button", { name: "Timetable" }).click();

    const dialog = page.getByRole("dialog", { name: /Timetable · Form 1 East/ });
    await expect(dialog).toBeVisible();
    // The week-grid editor (it replaces the whole week) is not offered; this window lists periods and adds one.
    await expect(dialog.getByText("Add a period")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Save timetable" })).toHaveCount(0);

    await dialog.getByLabel("Day").selectOption("Mon");
    await dialog.getByPlaceholder("08:00").fill(starts);
    await dialog.getByPlaceholder("08:40").fill(ends);
    await dialog.getByLabel("Subject").selectOption({ label: "Mathematics" });
    await dialog.getByPlaceholder("e.g. Lab 1").fill(room);
    await dialog.getByRole("button", { name: "Add period" }).click();
    await expect(dialog.getByText(room)).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByText(`${starts}–${ends}`)).toBeVisible();

    // The same time again overlaps: the API refuses it and the window says so.
    await dialog.getByPlaceholder("08:00").fill(starts);
    await dialog.getByPlaceholder("08:40").fill(ends);
    await dialog.getByRole("button", { name: "Add period" }).click();
    await expect(page.getByText(/Could not add the period/)).toBeVisible({ timeout: 10_000 });

    await dialog.getByRole("button", { name: "Close" }).click();
    await signOut(page);

    // 2. The teacher who leads Form 1 East sees the period on Timetable (the whole class, as its class teacher).
    await signInTeacher(page, seed);
    await page.goto(`/s/${seed.slug}/teacher/timetable`);
    await expect(page.getByRole("heading", { name: "Your week" })).toBeVisible({ timeout: 15_000 });
    await expect(main.getByText("Your homeroom")).toBeVisible();
    await main.getByRole("button", { name: /Form 1 East/ }).first().click();
    await expect(main.getByText(new RegExp(room))).toBeVisible({ timeout: 10_000 });
    // The calls panel and leave "needs cover" flags are not on the API build.
    await expect(main.getByText("Live classes")).toHaveCount(0);

    // 3. My classes lists Form 1 East with the teacher as its class teacher.
    await page.goto(`/s/${seed.slug}/teacher/classes`);
    await expect(page.getByRole("heading", { name: "My classes" })).toBeVisible({ timeout: 15_000 });
    const classRow = main.locator('[role="row"]', { hasText: "Form 1 East" });
    await expect(classRow).toBeVisible({ timeout: 10_000 });
    await expect(classRow.getByText("Class teacher")).toBeVisible();

    expect(errors).toEqual([]);
  });
});
