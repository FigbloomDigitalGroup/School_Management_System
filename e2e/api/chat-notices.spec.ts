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

/** Same as the other API specs: a TOTP code is single-use, so a replay waits for the next 30-second step. */
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

async function signInTeacher(page: Page, seed: SeedOutput) {
  await page.goto("/signin");
  await page.locator("#api-email").fill(seed.teacher.email);
  await page.locator("#api-password").fill(seed.teacher.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${seed.slug}/teacher`), { timeout: 15_000 });
}

const sidebar = (page: Page, name: string) => page.getByRole("navigation", { name: "Main" }).getByRole("link", { name, exact: true });
/** The messages of the open thread (the list on the left repeats a message as its preview, so scope to the thread). */
const thread = (page: Page) => page.locator('main [aria-live="polite"]');

test.describe("Chats and notices on the new API (VITE_BACKEND=api)", () => {
  test("admin and teacher chat live, the teacher reads notices, and what the API cannot do is hidden", async ({ browser }, testInfo) => {
    testInfo.setTimeout(150_000);
    const seed = loadSeed();
    const baseURL = String(testInfo.project.use.baseURL ?? "http://localhost:5173");
    const errors: string[] = [];
    const adminContext = await browser.newContext({ baseURL });
    const teacherContext = await browser.newContext({ baseURL });
    try {
      const admin = await adminContext.newPage();
      const teacher = await teacherContext.newPage();
      admin.on("pageerror", (err) => errors.push(`admin: ${err.message}`));
      teacher.on("pageerror", (err) => errors.push(`teacher: ${err.message}`));
      const stamp = Date.now();
      const adminMessage = `Staff meeting moved to 4pm (${stamp})`;
      const teacherMessage = `Noted, I will be there (${stamp})`;

      // 1. The admin's Chats: only "My chats" (no every-chat or calls tabs on the API). A chat is started from the staff list.
      await signInAdmin(admin, seed);
      await sidebar(admin, "Chats").click();
      await expect(admin).toHaveURL(new RegExp(`/s/${seed.slug}/admin/chats`));
      await expect(admin.getByRole("heading", { name: "Chats" })).toBeVisible();
      await expect(admin.getByRole("tab")).toHaveCount(0);

      await admin.locator("main").getByRole("button", { name: "New chat" }).first().click();
      const picker = admin.getByRole("dialog");
      await expect(picker.getByText("Staff with an account at the school.")).toBeVisible();
      await picker.getByRole("button", { name: /David Kamau/ }).click();
      await expect(admin.locator("main").getByText("David Kamau").first()).toBeVisible({ timeout: 10_000 });

      // What the API cannot do is not offered: files, calls, and the "administrators can read this chat" line.
      await expect(admin.getByLabel("Attach a file")).toHaveCount(0);
      await expect(admin.getByLabel(/Voice call/)).toHaveCount(0);
      await expect(admin.getByText("The school's administrators can read this chat.")).toHaveCount(0);

      await admin.getByLabel("Message", { exact: true }).fill(adminMessage);
      await admin.getByRole("button", { name: "Send", exact: true }).click();
      await expect(thread(admin).getByText(adminMessage)).toBeVisible({ timeout: 10_000 });

      // 2. The teacher (a plain teacher: no staff list) sees the chat, unnamed, with the message, and replies.
      await signInTeacher(teacher, seed);
      await sidebar(teacher, "Chats").click();
      await expect(teacher).toHaveURL(new RegExp(`/s/${seed.slug}/teacher/chats`));
      const row = teacher.locator("main button", { hasText: adminMessage }).first();
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row.getByText("Someone at the school")).toBeVisible();
      await row.click();
      await expect(thread(teacher).getByText(adminMessage)).toBeVisible({ timeout: 10_000 });
      await teacher.getByLabel("Message", { exact: true }).fill(teacherMessage);
      await teacher.getByRole("button", { name: "Send", exact: true }).click();
      await expect(thread(teacher).getByText(teacherMessage)).toBeVisible({ timeout: 10_000 });

      // The teacher cannot list people to start a chat with (the staff list needs a permission a teacher lacks).
      await teacher.locator("main").getByRole("button", { name: "New chat" }).first().click();
      await expect(teacher.getByRole("dialog").getByText("A list of people to chat with is not on the new system yet.")).toBeVisible({ timeout: 10_000 });
      await teacher.keyboard.press("Escape");

      // 3. The reply reaches the admin's open thread by polling, with no reload.
      await expect(thread(admin).getByText(teacherMessage)).toBeVisible({ timeout: 20_000 });

      // 4. Notices: the inbox holds the seeded whole-school notice, from the office, with no unread mark.
      await sidebar(teacher, "Notices").click();
      await expect(teacher).toHaveURL(new RegExp(`/s/${seed.slug}/teacher/notices`));
      await expect(teacher.getByRole("heading", { name: "Notices" })).toBeVisible();
      await expect(teacher.locator("main").getByText("Welcome to Term 1").first()).toBeVisible({ timeout: 15_000 });
      await expect(teacher.locator("main").getByText("School office").first()).toBeVisible();
      await expect(teacher.locator("main").getByText(/Term 1 opens Monday/).first()).toBeVisible();
      await expect(teacher.getByText("Waiting for your signature")).toHaveCount(0);

      // 5. Messages: a plain teacher cannot send on the API, and the page says so instead of failing on Send.
      await sidebar(teacher, "Messages").click();
      await expect(teacher).toHaveURL(new RegExp(`/s/${seed.slug}/teacher/messages`));
      await expect(teacher.getByText("Teachers can't send messages here yet.")).toBeVisible({ timeout: 15_000 });
      await expect(teacher.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);

      expect(errors).toEqual([]);
    } finally {
      await adminContext.close();
      await teacherContext.close();
    }
  });
});
