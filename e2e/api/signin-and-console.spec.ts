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

  test("school admin signs in with MFA and loads every ported console page", async ({ page }) => {
    const seed = loadSeed();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

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
    await expect(page.getByText(seed.schoolName)).toBeVisible();

    await page.getByRole("button", { name: "Check the connection" }).click();
    await expect(page.getByText(/The API answered ready in \d+ ms\./)).toBeVisible();

    // Walk every admin page ported to the new API and confirm seeded data renders cleanly.
    await page.goto(`/s/${seed.slug}/admin/settings`);
    await expect(page.getByText("Term 1, 2026")).toBeVisible({ timeout: 15_000 });

    await page.goto(`/s/${seed.slug}/admin/classes`);
    await expect(page.getByText("Form 1 East")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Form 2 West")).toBeVisible();

    await page.goto(`/s/${seed.slug}/admin/subjects`);
    await expect(page.getByText("Mathematics")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("English")).toBeVisible();

    await page.goto(`/s/${seed.slug}/admin/people`);
    await expect(page.getByText("Amina Ochieng")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Brian Kamau")).toBeVisible();

    await page.goto(`/s/${seed.slug}/admin/fees`);
    await expect(page.getByText("Tuition")).toBeVisible({ timeout: 15_000 });

    await page.goto(`/s/${seed.slug}/admin/announcements`);
    await expect(page.getByText("Welcome to Term 1")).toBeVisible({ timeout: 15_000 });

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
