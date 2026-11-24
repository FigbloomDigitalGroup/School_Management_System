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

/**
 * Signs in as the seeded admin, handling single-use TOTP replay by waiting for the next step instead of
 * spending +1 (the API only accepts a step later than the last one it accepted, so +1 would also refuse
 * the next sign-in, at offset 0, for two steps).
 */
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

test.describe("Leave on the new API (VITE_BACKEND=api)", () => {
  test("teacher submits and withdraws leave, then admin approves a request with a note", async ({ page }) => {
    test.setTimeout(90_000);
    const seed = loadSeed();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    // Unique non-overlapping future dates per run so re-runs against the same local API never hit 409 overlap.
    const baseYear = 2027 + (Math.floor(Date.now() / 1000) % 20);
    const month = String((Math.floor(Date.now() / 1000) % 10) + 1).padStart(2, "0");
    const keepStart = `${baseYear}-${month}-03`;
    const keepEnd = `${baseYear}-${month}-05`;
    const withdrawStart = `${baseYear}-${month}-12`;
    const withdrawEnd = `${baseYear}-${month}-13`;
    const keepReason = `Conference attendance ${Date.now()}`;
    const withdrawReason = `Dentist appointment ${Date.now()}`;
    const reviewNote = "Cover arranged with Form 1 team";

    // 1. Teacher opens Leave from the sidebar, hits client-side reason check, submits two requests, withdraws one.
    await signInTeacher(page, seed);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Leave" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${seed.slug}/teacher/leave`));
    await expect(page.getByRole("heading", { name: "Leave" })).toBeVisible();

    const main = page.locator("main");
    const myRequests = main.locator("div.overflow-hidden", { has: page.getByRole("heading", { name: "Your requests" }) });

    // Submit with too-short reason -> validation toast, nothing created.
    await main.locator("#leave-start").fill(keepStart);
    await main.locator("#leave-end").fill(keepEnd);
    await main.locator("#leave-reason").fill("no");
    await main.getByRole("button", { name: "Request leave" }).click();
    await expect(page.getByText(/at least 3 characters/i)).toBeVisible({ timeout: 5_000 });

    // Submit the request to keep and wait for the form reset + list item (not the textarea itself).
    await main.locator("#leave-reason").fill(keepReason);
    await main.getByRole("button", { name: "Request leave" }).click();
    await expect(main.locator("#leave-reason")).toHaveValue("", { timeout: 10_000 });
    await expect(myRequests.getByText(keepReason)).toBeVisible({ timeout: 10_000 });

    // Submit a second request and withdraw it.
    await main.locator("#leave-start").fill(withdrawStart);
    await main.locator("#leave-end").fill(withdrawEnd);
    await main.locator("#leave-reason").fill(withdrawReason);
    await main.getByRole("button", { name: "Request leave" }).click();
    await expect(main.locator("#leave-reason")).toHaveValue("", { timeout: 10_000 });
    await expect(myRequests.getByText(withdrawReason)).toBeVisible({ timeout: 10_000 });

    const withdrawCard = myRequests.locator("div.border-b", { hasText: withdrawReason }).first();
    await withdrawCard.getByRole("button", { name: "Withdraw" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Withdraw" }).click();
    await expect(withdrawCard.getByText("Cancelled")).toBeVisible({ timeout: 10_000 });

    await signOut(page);

    // 2. Admin signs in, opens Leave requests from the sidebar, sees David Kamau's pending request, and approves it.
    await signInAdmin(page, seed);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Leave requests" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${seed.slug}/admin/leave`));
    await expect(page.getByRole("heading", { name: "Leave requests" })).toBeVisible();

    await expect(main.getByText(keepReason)).toBeVisible({ timeout: 10_000 });
    const pendingRow = main.locator('[role="row"]', { hasText: keepReason });
    await expect(pendingRow.getByText("David Kamau")).toBeVisible();
    await pendingRow.getByRole("textbox").fill(reviewNote);
    await pendingRow.getByRole("button", { name: "Approve" }).click();

    await expect(page.getByText(/Approved — David Kamau notified\./)).toBeVisible({ timeout: 10_000 });
    await expect(main.getByText(reviewNote)).toBeVisible({ timeout: 10_000 });

    await signOut(page);

    // 3. Teacher signs back in and sees the approved decision and review note.
    await signInTeacher(page, seed);
    await page.goto(`/s/${seed.slug}/teacher/leave`);
    const approvedCard = myRequests.locator("div.border-b", { hasText: keepReason }).first();
    await expect(approvedCard.getByText("Approved")).toBeVisible({ timeout: 10_000 });
    await expect(approvedCard.getByText(`"${reviewNote}"`)).toBeVisible();

    expect(errors).toEqual([]);
  });
});
