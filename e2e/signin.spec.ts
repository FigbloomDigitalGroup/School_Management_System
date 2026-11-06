import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

process.loadEnvFile?.(); // Node 20.6+ built-in
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

/**
 * QA 08 (FIG-1241): sign-in outcomes, not just the messages. flows.spec.ts already checks that the five portals are offered, that
 * email is Admin-only and that an unknown ID shows a hint. This adds what it leaves out: a wrong password is refused with the same
 * words whether or not the account exists, a wrong portal REALLY signs the account out (flows.spec.ts only checks the message and
 * the URL), the masked name looks right, the driver portal admits a driver, and the emailed reset link works once.
 *
 * The reset test uses a throwaway user (created and deleted here) and the local mail catcher (Mailpit, port 58324). It deletes only
 * its own message. Local Supabase only.
 */
test.describe.configure({ mode: "serial" });

const PASSWORD = "figbloom-dev";
const MAIL = process.env.QA_MAILPIT_URL ?? "http://127.0.0.1:58324";

test.beforeAll(async () => {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.SUPABASE_URL ?? "")) throw new Error("local Supabase only");
  await db.from("login_lookups").delete().gte("looked_up_at", "1970-01-01"); // same reason as flows.spec.ts
});

type Portal = "Admin" | "Teacher" | "Student" | "Parent" | "Driver";

async function pickSchoolAndId(page: Page, portal: Portal, loginId: string) {
  await page.goto("/signin");
  await page.getByRole("button", { name: `${portal} portal` }).click();
  await page.getByLabel("School").fill("Alliance High School");
  await page.getByRole("button").filter({ hasText: "Alliance High School" }).first().click();
  await page.getByLabel("Your ID").fill(loginId);
  await page.getByLabel("Your ID").blur();
  await expect(page.getByText(/^Signing in as /)).toBeVisible({ timeout: 5000 });
}

/** What is in the browser's storage for Supabase Auth: null when no session is stored. */
async function storedSession(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
    return key ? JSON.parse(localStorage.getItem(key) ?? "null") : null;
  });
}

test.describe("wrong password, wrong portal, masked name", () => {
  test("a school ID with the wrong password is refused with a generic message, and no session is kept", async ({ page }) => {
    await pickSchoolAndId(page, "Teacher", "TC-0002");
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText("Check your ID and password.")).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(/\/signin/);
    expect(await storedSession(page)).toBeNull();
  });

  test("an email with the wrong password is refused with a generic message, and no session is kept", async ({ page }) => {
    await page.goto("/signin");
    await page.getByRole("button", { name: "Admin portal" }).click();
    await page.getByRole("button", { name: "Sign in with email instead" }).click();
    await page.getByLabel("Email").fill("principal@alliance.sc.ke");
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText("Check the email and password.")).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(/\/signin/);
    expect(await storedSession(page)).toBeNull();
  });

  test("an email that has no account gets exactly the same refusal as a wrong password (no way to tell them apart)", async ({ page }) => {
    await page.goto("/signin");
    await page.getByRole("button", { name: "Admin portal" }).click();
    await page.getByRole("button", { name: "Sign in with email instead" }).click();
    await page.getByLabel("Email").fill("nobody-at-all@alliance.sc.ke");
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText("Check the email and password.")).toBeVisible({ timeout: 10000 });
  });

  test("the name shown for a recognised ID is masked: a first name and the last name's initial", async ({ page }) => {
    await pickSchoolAndId(page, "Teacher", "TC-0002");
    await expect(page.getByText(/^Signing in as \p{Lu}[\p{L}'-]+ \p{Lu}\.$/u)).toBeVisible();
  });

  test("an account that signs in through the wrong portal is really signed out: Auth is told, and nothing is kept in the browser", async ({ page }) => {
    await pickSchoolAndId(page, "Student", "TC-0002");
    await page.getByLabel("Password").fill(PASSWORD);
    const loggedOut = page.waitForRequest((r) => r.url().includes("/auth/v1/logout"), { timeout: 15000 });
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText(/not a student account.*Teacher portal/i)).toBeVisible({ timeout: 15000 });
    await loggedOut; // the sign-out request really went to Auth
    expect(await storedSession(page)).toBeNull();
    await page.goto("/s/alliance/teacher"); // and a protected page does not open
    await expect(page).toHaveURL(/\/signin/);
  });

  test("the Driver portal admits a driver", async ({ page }) => {
    await pickSchoolAndId(page, "Driver", "BD-0001");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/signin"), { timeout: 15000 });
    expect(await storedSession(page)).not.toBeNull();
  });
});

test.describe("password reset by emailed link", () => {
  const run = Date.now().toString(36);
  const email = `qa8-reset-${run}@example.com`;
  let userId = "";
  const messageIds: string[] = [];

  test.beforeAll(async () => {
    const made = await db.auth.admin.createUser({ email, password: "old-password-1", email_confirm: true });
    if (made.error) throw new Error(made.error.message);
    userId = made.data.user!.id;
  });

  test.afterAll(async () => {
    if (userId) await db.auth.admin.deleteUser(userId);
    if (messageIds.length) {
      await fetch(`${MAIL}/api/v1/messages`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ IDs: messageIds }) });
    }
  });

  async function inbox(address: string): Promise<{ ID: string }[]> {
    for (let i = 0; i < 20; i++) {
      const found = await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`)).json();
      if (found.messages?.length) return found.messages;
      await new Promise((r) => setTimeout(r, 500));
    }
    return [];
  }

  async function askForALink(page: Page, address: string) {
    await page.goto("/signin");
    await page.getByRole("button", { name: "Admin portal" }).click();
    await page.getByRole("button", { name: "Sign in with email instead" }).click();
    await page.getByLabel("Email").fill(address);
    await page.getByRole("button", { name: /Forgot password\? We'll email you a link/ }).click();
    await expect(page.getByText("If that email has an account, a reset link is on its way.")).toBeVisible({ timeout: 10000 });
  }

  test("an address with no account gets the same answer on screen and no mail is sent", async ({ page }) => {
    const nobody = `qa8-nobody-${run}@example.com`;
    await askForALink(page, nobody);
    await page.waitForTimeout(2000);
    const found = await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${nobody}`)}`)).json();
    expect(found.messages_count ?? found.messages?.length ?? 0).toBe(0);
  });

  test("the emailed link opens the Set a new password screen, changes the password, and works only once", async ({ page, browser }) => {
    await askForALink(page, email);
    const mails = await inbox(email);
    expect(mails.length, "one reset mail arrived").toBe(1);
    messageIds.push(mails[0]!.ID);
    const msg = await (await fetch(`${MAIL}/api/v1/message/${mails[0]!.ID}`)).json();
    expect(msg.Subject).toBe("Reset your password");
    const link = (msg.HTML.match(/href="([^"]+verify[^"]+)"/)?.[1] as string | undefined)?.replace(/&amp;/g, "&");
    expect(link, "the mail carries a recovery link").toBeTruthy();
    expect(new URL(link!).searchParams.get("type")).toBe("recovery");

    // the link, opened in a fresh browser as the person would
    const ctx = await browser.newContext();
    const reset = await ctx.newPage();
    await reset.goto(link!);
    await expect(reset.getByRole("heading", { name: "Set a new password" })).toBeVisible();
    await reset.getByLabel("New password").fill("short");
    await reset.getByLabel("Confirm password").fill("short");
    await reset.getByRole("button", { name: "Set password" }).click();
    await expect(reset.getByText("At least 8 characters.").last()).toBeVisible(); // refused on screen
    await reset.getByLabel("New password").fill("a-brand-new-password-1");
    await reset.getByLabel("Confirm password").fill("a-brand-new-password-1");
    await reset.getByRole("button", { name: "Set password" }).click();
    await expect(reset.getByText("Your password has been changed.")).toBeVisible({ timeout: 10000 });
    await ctx.close();

    // the old password no longer works, the new one does
    const check = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    expect((await check.auth.signInWithPassword({ email, password: "old-password-1" })).error, "the old password").not.toBeNull();
    expect((await check.auth.signInWithPassword({ email, password: "a-brand-new-password-1" })).error, "the new password").toBeNull();

    // the same link a second time says it has been used, and offers a new one
    const again = await (await browser.newContext()).newPage();
    await again.goto(link!);
    await expect(again.getByText(/expired or has already been used/i)).toBeVisible({ timeout: 10000 });
  });
});
