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

async function signInAdmin(page: Page, seed: SeedOutput) {
  await page.goto("/signin");
  await page.locator("#api-email").fill(seed.admin.email);
  await page.locator("#api-password").fill(seed.admin.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  const mfaInput = page.locator("#api-mfa-answer");
  await expect(mfaInput).toBeVisible({ timeout: 15_000 });

  const adminUrl = new RegExp(`/s/${seed.slug}/admin`);
  for (const attempt of [0, 1]) {
    if (attempt === 1) {
      await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 750);
    }
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

test.describe("Report cards on the new API (VITE_BACKEND=api)", () => {
  test("admin opens Report cards, publishes a class snapshot, and plain teacher views without errors", async ({ page }) => {
    test.setTimeout(90_000);
    const seed = loadSeed();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    // 1. Admin opens Report cards from the sidebar.
    await signInAdmin(page, seed);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Report cards" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${seed.slug}/admin/report-cards`));
    await expect(page.getByRole("heading", { name: "Report cards" })).toBeVisible();

    const main = page.locator("main");
    await expect(main.locator("#rc-term")).toBeVisible({ timeout: 15_000 });
    await expect(main.locator("#rc-class")).toBeVisible();

    // Unsupported controls must stay hidden on the API build.
    await expect(main.getByRole("button", { name: /Sign \d+ card/i })).toHaveCount(0);
    await expect(main.getByRole("button", { name: /Draft comments with Bloom/i })).toHaveCount(0);
    await expect(main.getByRole("button", { name: /Suggest missing comments/i })).toHaveCount(0);
    await expect(main.getByRole("button", { name: /Withdraw all/i })).toHaveCount(0);

    // Publish the selected class snapshot on the API.
    const publishBtn = main.getByRole("button", { name: /Publish( report cards| again)/i });
    await expect(publishBtn).toBeVisible();
    await publishBtn.click();
    await expect(page.getByText(/Published\.|Report cards published for/i)).toBeVisible({ timeout: 15_000 });

    await signOut(page);

    // 2. Plain teacher opens Report cards from the sidebar and sees the read-only view without crashing.
    await signInTeacher(page, seed);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Report cards" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${seed.slug}/teacher/report-cards`));
    await expect(page.getByRole("heading", { name: "Report cards" })).toBeVisible();
    await expect(main.locator("#rc-class")).toBeVisible({ timeout: 15_000 });
    // Teacher cannot publish.
    await expect(main.getByRole("button", { name: /Publish/i })).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});
