import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { SeedOutput } from "../../scripts/api-seed/seed";
import { computeTotpCode } from "../../scripts/api-seed/totp";

const SEED_PATH = process.env.API_SEED_OUTPUT
  ? resolve(process.cwd(), process.env.API_SEED_OUTPUT)
  : resolve(tmpdir(), "figbloom-api-seed.json");
const API_URL = (process.env.API_URL ?? process.env.VITE_API_URL ?? "http://127.0.0.1:4199").replace(/\/+$/, "");

function loadSeed(): SeedOutput {
  if (!existsSync(SEED_PATH)) {
    throw new Error(`Missing API seed output at ${SEED_PATH}. Run "npm run api:seed" against a local apps/api first.`);
  }
  return JSON.parse(readFileSync(SEED_PATH, "utf8")) as SeedOutput;
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });

async function signOut(page: Page) {
  await nav(page).locator('button[aria-haspopup="menu"]').click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/signin/, { timeout: 15_000 });
}

async function openMyAccount(page: Page) {
  await nav(page).locator('button[aria-haspopup="menu"]').click();
  await page.getByRole("menuitem", { name: "My account" }).click();
  await expect(page.getByRole("heading", { name: "My account" })).toBeVisible({ timeout: 10_000 });
}

async function signInTeacher(page: Page, seed: SeedOutput, password = seed.teacher.password) {
  await page.goto("/signin");
  await page.locator("#api-email").fill(seed.teacher.email);
  await page.locator("#api-password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${seed.slug}/teacher`), { timeout: 15_000 });
}

/** Signs in as the seeded admin; returns the TOTP step that was used, so a later step can be waited for (a code works once). */
async function signInAdmin(page: Page, seed: SeedOutput): Promise<number> {
  await page.goto("/signin");
  await page.locator("#api-email").fill(seed.admin.email);
  await page.locator("#api-password").fill(seed.admin.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  const mfaInput = page.locator("#api-mfa-answer");
  await expect(mfaInput).toBeVisible({ timeout: 15_000 });
  const adminUrl = new RegExp(`/s/${seed.slug}/admin`);
  for (const attempt of [0, 1]) {
    if (attempt === 1) await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 750);
    const at = Date.now();
    await mfaInput.fill(computeTotpCode(seed.admin.totpSecret, at, 0));
    await page.getByRole("button", { name: "Continue" }).click();
    try {
      await expect(page).toHaveURL(adminUrl, { timeout: 4_000 });
      return Math.floor(at / 30_000);
    } catch {
      if (attempt === 1) throw new Error("Admin MFA sign-in did not complete after waiting for the next TOTP step.");
    }
  }
  throw new Error("unreachable");
}

/** The app asks for the password again before a sensitive change when the last confirmation is older than the server's window. */
async function confirmPasswordIfAsked(page: Page, password: string) {
  const prompt = page.getByRole("dialog", { name: "Confirm your password" });
  try {
    await prompt.waitFor({ state: "visible", timeout: 2_500 });
  } catch {
    return;
  }
  await prompt.getByLabel("Password").fill(password);
  await prompt.getByRole("button", { name: "Confirm" }).click();
  await expect(prompt).toBeHidden({ timeout: 10_000 });
}

/** Puts a password back through the API when a test left it changed (the teacher's is used by the other specs). */
async function restorePassword(request: APIRequestContext, email: string, from: string, to: string) {
  const login = await request.post(`${API_URL}/v1/auth/login/email`, { data: { email, password: from } });
  if (!login.ok()) return; // never changed
  const { token } = (await login.json()) as { token: string };
  await request.post(`${API_URL}/v1/auth/password/change`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { currentPassword: from, newPassword: to },
  });
}

test.describe("My account and Access on the new API (VITE_BACKEND=api)", () => {
  test("a plain teacher sees their details, changes how they are reached, and changes their password", async ({ page, request }) => {
    test.setTimeout(120_000);
    const seed = loadSeed();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    const temporary = `Temp-${Date.now()}-pw1`;
    let changed = false;

    try {
      await signInTeacher(page, seed);
      await openMyAccount(page);
      await expect(page).toHaveURL(new RegExp(`/s/${seed.slug}/teacher/account`));
      const main = page.locator("main");

      // Details: what the server says, read-only, with the reason. No calls, no edit form.
      const details = main.getByRole("region", { name: "Your details" });
      await expect(details.getByText("David Kamau").first()).toBeVisible();
      await expect(details.getByText(seed.teacher.email)).toBeVisible();
      await expect(details.getByText("not on the new system yet")).toBeVisible();
      await expect(main.getByLabel("Full name")).toHaveCount(0);
      await expect(main.getByText("Call someone")).toHaveCount(0);

      // Two-step: a teacher is not asked for it, so nothing is offered.
      const twoStep = main.getByRole("region", { name: "Two-step verification" });
      await expect(twoStep.getByText("Not set up")).toBeVisible();
      await expect(twoStep.getByText(/not asked for a second step/)).toBeVisible();
      await expect(twoStep.getByRole("button")).toHaveCount(0);

      // How we reach you: a staff member has notices and chat. A flip is saved on the server and survives a reload.
      const chat = main.getByRole("switch", { name: /Chat messages/ });
      await expect(main.getByRole("switch")).toHaveCount(2);
      await expect(main.getByRole("switch", { name: /Fee reminders/ })).toHaveCount(0);
      const before = await chat.isChecked();
      await chat.click();
      await expect(chat).toHaveJSProperty("checked", !before);
      await page.reload();
      await expect(main.getByRole("switch", { name: /Chat messages/ })).toHaveJSProperty("checked", !before, { timeout: 10_000 });
      await main.getByRole("switch", { name: /Chat messages/ }).click();
      await expect(main.getByRole("switch", { name: /Chat messages/ })).toHaveJSProperty("checked", before);

      // Password: the server's rule is checked before anything is sent; a wrong current password is said plainly.
      const pw = main.getByRole("region", { name: "Password" });
      await pw.getByLabel("Current password").fill(seed.teacher.password);
      await pw.getByLabel("New password", { exact: true }).fill("short1");
      await pw.getByLabel("New password again").fill("short1");
      await pw.getByRole("button", { name: "Change password" }).click();
      await expect(pw.getByText(/at least 10 characters/).last()).toBeVisible();

      await pw.getByLabel("Current password").fill("not-my-password-1");
      await pw.getByLabel("New password", { exact: true }).fill(temporary);
      await pw.getByLabel("New password again").fill(temporary);
      await pw.getByRole("button", { name: "Change password" }).click();
      await expect(pw.getByText("Your current password is not right.")).toBeVisible({ timeout: 10_000 });

      await pw.getByLabel("Current password").fill(seed.teacher.password);
      await pw.getByRole("button", { name: "Change password" }).click();
      await expect(page.getByText(/Password changed/)).toBeVisible({ timeout: 10_000 });
      changed = true;

      // The new password signs in; the old one does not.
      await signOut(page);
      await page.locator("#api-email").fill(seed.teacher.email);
      await page.locator("#api-password").fill(seed.teacher.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByText("Check the email and password.")).toBeVisible({ timeout: 10_000 });
      await signInTeacher(page, seed, temporary);
      await openMyAccount(page);
      const again = page.locator("main").getByRole("region", { name: "Password" });
      await again.getByLabel("Current password").fill(temporary);
      await again.getByLabel("New password", { exact: true }).fill(seed.teacher.password);
      await again.getByLabel("New password again").fill(seed.teacher.password);
      await again.getByRole("button", { name: "Change password" }).click();
      await expect(page.getByText(/Password changed/)).toBeVisible({ timeout: 10_000 });
      changed = false;
      expect(errors).toEqual([]);
    } finally {
      if (changed) await restorePassword(request, seed.teacher.email, temporary, seed.teacher.password);
    }
  });

  test("an admin changes a teacher's admin areas, makes new recovery codes, and sees roles are not offered", async ({ page }) => {
    test.setTimeout(150_000);
    const seed = loadSeed();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    const usedStep = await signInAdmin(page, seed);
    const main = page.locator("main");

    // Access & roles: no roles table on the API build, with the reason; areas are given one person at a time.
    await nav(page).getByRole("link", { name: "Access & roles" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${seed.slug}/admin/access`));
    await expect(page.getByRole("heading", { name: "Access & roles" })).toBeVisible();
    await expect(page.getByText(/Naming your own roles, like Exams officer, is not on the new system yet/)).toBeVisible();
    await expect(page.getByRole("button", { name: "New role" })).toHaveCount(0);
    const row = main.locator('[role="row"]', { hasText: "David Kamau" });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.getByText("No admin access")).toBeVisible();

    try {
      await row.getByRole("button", { name: "Change access for David Kamau" }).click();
      const dialog = page.getByRole("dialog", { name: "Access for David Kamau" });
      await dialog.locator('input[id$="-attendance"]').check();
      await expect(dialog.getByText("Parents' records")).toBeVisible();
      await dialog.getByRole("button", { name: "Save access" }).click();
      await confirmPasswordIfAsked(page, seed.admin.password);
      await expect(page.getByText("David now has: Attendance.")).toBeVisible({ timeout: 10_000 });
      await expect(main.locator('[role="row"]', { hasText: "David Kamau" }).getByText("Attendance")).toBeVisible({ timeout: 10_000 });
    } finally {
      // Leave the teacher as found: an area would send them to the admin console in the other specs.
      const current = main.locator('[role="row"]', { hasText: "David Kamau" });
      if (await current.getByText("Attendance").isVisible().catch(() => false)) {
        await current.getByRole("button", { name: "Change access for David Kamau" }).click();
        const dialog = page.getByRole("dialog", { name: "Access for David Kamau" });
        await dialog.locator('input[id$="-attendance"]').uncheck();
        await dialog.getByRole("button", { name: "Save access" }).click();
        await confirmPasswordIfAsked(page, seed.admin.password);
        await expect(page.getByText("David no longer has admin access.")).toBeVisible({ timeout: 10_000 });
      }
    }

    // My account: the admin has two-step on (their role needs it), so it cannot be turned off; new recovery codes can be made.
    await openMyAccount(page);
    await expect(page).toHaveURL(new RegExp(`/s/${seed.slug}/admin/account`));
    const twoStep = main.getByRole("region", { name: "Two-step verification" });
    await expect(twoStep.getByText("On", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(twoStep.getByText(/cannot be turned off/)).toBeVisible();
    await expect(twoStep.getByRole("button", { name: /Turn off/ })).toHaveCount(0);
    await twoStep.getByRole("button", { name: "New recovery codes" }).click();
    const codes = page.getByRole("dialog", { name: "New recovery codes" });
    // A code works once: the sign-in used one, so wait for a later 30-second step.
    if (Math.floor(Date.now() / 30_000) <= usedStep) await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 750);
    await codes.getByLabel("6-digit code from your app").fill(computeTotpCode(seed.admin.totpSecret, Date.now(), 0));
    await codes.getByRole("button", { name: "Make new codes" }).click();
    await confirmPasswordIfAsked(page, seed.admin.password);
    await expect(codes.getByTestId("new-recovery-codes").locator("li")).toHaveCount(8, { timeout: 10_000 });
    await codes.getByLabel("I have saved my recovery codes.").check();
    await codes.getByRole("button", { name: "Done" }).click();
    await expect(codes).toBeHidden();

    // The admin has the same password, choices and details sections.
    await expect(main.getByRole("region", { name: "Password" })).toBeVisible();
    await expect(main.getByRole("region", { name: "How we reach you" })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
