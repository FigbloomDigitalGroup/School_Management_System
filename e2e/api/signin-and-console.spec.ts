import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
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

test.describe("Web on the new API (VITE_BACKEND=api)", () => {
  test("unauthenticated visits to a school route redirect to /signin", async ({ page }) => {
    const seed = loadSeed();
    await page.goto(`/s/${seed.slug}/admin/fees`);
    await expect(page).toHaveURL(/\/signin/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("school admin signs in with MFA and loads every ported console page", async ({ page }, testInfo) => {
    const seed = loadSeed();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    // A TOTP code is accepted once per 30-second step. A CI retry inside the same step would send the first
    // attempt's code again and be refused (the retry then sits on /signin), so a retry waits for the next step.
    if (testInfo.retry > 0) {
      testInfo.setTimeout(testInfo.timeout + 31_000);
      await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
    }

    await page.goto("/signin");
    await page.locator("#api-email").fill(seed.admin.email);
    await page.locator("#api-password").fill(seed.admin.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    // Admin accounts require TOTP challenge under MFA_ENFORCEMENT=enforce.
    const mfaInput = page.locator("#api-mfa-answer");
    await expect(mfaInput).toBeVisible({ timeout: 15_000 });
    await mfaInput.fill(computeTotpCode(seed.admin.totpSecret));
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page).toHaveURL(new RegExp(`/s/${seed.slug}/admin`), { timeout: 15_000 });
    await expect(page.getByTestId("api-home")).toBeVisible();
    // The school name is in the sidebar and in the page heading; the heading is the one this page owns.
    await expect(page.getByRole("heading", { name: seed.schoolName })).toBeVisible();

    await page.getByRole("button", { name: "Check the connection" }).click();
    await expect(page.getByText(/The API answered ready in \d+ ms\./)).toBeVisible();

    // Walk every admin page ported to the new API and confirm seeded data renders cleanly. A seeded value can
    // fairly appear more than once on a page (a list and a summary), which would trip Playwright's strict mode,
    // so each check asks only that it is shown somewhere.
    await page.goto(`/s/${seed.slug}/admin/settings`);
    await expect(page.getByText("Term 1, 2026").first()).toBeVisible({ timeout: 15_000 });

    await page.goto(`/s/${seed.slug}/admin/classes`);
    await expect(page.getByText("Form 1 East").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Form 2 West").first()).toBeVisible();

    await page.goto(`/s/${seed.slug}/admin/subjects`);
    await expect(page.getByText("Mathematics").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("English").first()).toBeVisible();

    await page.goto(`/s/${seed.slug}/admin/people`);
    await expect(page.getByText("Amina Ochieng").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Brian Kamau").first()).toBeVisible();

    await page.goto(`/s/${seed.slug}/admin/fees`);
    await expect(page.getByText("Tuition").first()).toBeVisible({ timeout: 15_000 });

    await page.goto(`/s/${seed.slug}/admin/announcements`);
    await expect(page.getByText("Welcome to Term 1").first()).toBeVisible({ timeout: 15_000 });

    expect(errors).toEqual([]);
  });

  test("teacher signs in cleanly and signs out", async ({ page }) => {
    const seed = loadSeed();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/signin");
    await page.locator("#api-email").fill(seed.teacher.email);
    await page.locator("#api-password").fill(seed.teacher.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(new RegExp(`/s/${seed.slug}`), { timeout: 15_000 });
    await expect(page.getByTestId("api-home")).toBeVisible();
    await expect(page.getByText("Teacher", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/signin/);

    expect(errors).toEqual([]);
  });
});
