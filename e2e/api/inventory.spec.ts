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

/**
 * Signs in as the seeded admin, handling single-use TOTP replay without spending the +1 step
 * (so a follow-up idempotent `api:seed` run inside the same 30-second window can still succeed).
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

test.describe("Inventory on the new API (VITE_BACKEND=api)", () => {
  test("admin adds an item, issues it to a learner, records its return, and writes it off", async ({ page }) => {
    test.setTimeout(90_000);
    const seed = loadSeed();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    const suffix = String(Date.now()).slice(-6);
    const itemName = `KLB Biology Form 2 (${suffix})`;
    const assetTag = `BIO-${suffix}`;

    await signInAdmin(page, seed);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Inventory" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${seed.slug}/admin/inventory`));
    await expect(page.getByRole("heading", { name: "Inventory" })).toBeVisible();

    const main = page.locator("main");

    // Capabilities hidden on API: History tab and Lost stat card are not shown.
    await expect(main.getByRole("button", { name: "History" })).toHaveCount(0);
    await expect(main.getByText("Lost", { exact: true })).toHaveCount(0);

    // 1. Add a stock item.
    await main.getByRole("button", { name: "Add item" }).first().click();
    const addDialog = page.getByRole("dialog");
    await addDialog.locator("#inv-name").fill(itemName);
    await addDialog.locator("#inv-qty").fill("5");
    await addDialog.locator("#inv-tag-stock").fill(assetTag);
    await addDialog.locator("#inv-location").fill("Library store");
    // Cost/purchased/notes are hidden on API.
    await expect(addDialog.locator("#inv-cost")).toHaveCount(0);
    await addDialog.getByRole("button", { name: "Add item" }).click();

    await expect(page.getByText(`${itemName} added to the register.`)).toBeVisible({ timeout: 10_000 });
    const itemRow = main.locator('[role="row"]', { hasText: itemName });
    await expect(itemRow).toBeVisible({ timeout: 10_000 });
    await expect(itemRow.getByText("5 of 5")).toBeVisible();
    await expect(itemRow.getByRole("button", { name: "Edit" })).toHaveCount(0);

    // 2. Issue 1 copy to Amina Ochieng.
    await itemRow.getByRole("button", { name: "Issue" }).click();
    const issueDialog = page.getByRole("dialog");
    await issueDialog.locator("#issue-search").fill("Amina");
    const holderSelect = issueDialog.locator("#issue-holder");
    await expect(holderSelect.locator("option", { hasText: "Amina Ochieng" })).toHaveCount(1, { timeout: 10_000 });
    const aminaValue = await holderSelect.locator("option", { hasText: "Amina Ochieng" }).first().getAttribute("value");
    await holderSelect.selectOption(aminaValue!);
    await issueDialog.getByRole("button", { name: "Issue" }).click();

    await expect(page.getByText(`${itemName} issued to Amina Ochieng.`)).toBeVisible({ timeout: 10_000 });
    await expect(itemRow.getByText("4 of 5")).toBeVisible({ timeout: 10_000 });

    // 3. Switch to Out now, verify the issue, and record its return.
    await main.getByRole("button", { name: "Out now" }).click();
    const issueRow = main.locator('[role="row"]', { hasText: itemName });
    await expect(issueRow.getByText("Amina Ochieng")).toBeVisible({ timeout: 10_000 });
    await issueRow.getByRole("button", { name: "Return" }).click();
    const returnDialog = page.getByRole("dialog");
    await returnDialog.locator("#return-note").fill("Returned in good shape");
    await returnDialog.getByRole("button", { name: "Record return" }).click();

    await expect(page.getByText(`${itemName} returned by Amina Ochieng.`)).toBeVisible({ timeout: 10_000 });
    await expect(main.locator('[role="row"]', { hasText: itemName })).toHaveCount(0, { timeout: 10_000 });

    // 4. Back to Register, confirm 5 of 5 on shelf, open detail modal, and write off the item.
    await main.getByRole("button", { name: "Register" }).click();
    await expect(itemRow.getByText("5 of 5")).toBeVisible({ timeout: 10_000 });
    await itemRow.click();
    const detailDialog = page.getByRole("dialog");
    await detailDialog.getByRole("button", { name: "Write off" }).click();

    await expect(page.getByText(`${itemName} written off.`)).toBeVisible({ timeout: 10_000 });
    await expect(main.locator('[role="row"]', { hasText: itemName })).toHaveCount(0, { timeout: 10_000 });

    expect(errors).toEqual([]);
  });
});
