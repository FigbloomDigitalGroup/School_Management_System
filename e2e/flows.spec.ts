import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

process.loadEnvFile?.(); // Node 20.6+ built-in
const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

/**
 * The five flows that must never break. Each mirrors a real user's morning, so
 * a failure here means somebody's day is broken, not that a selector moved.
 *
 * Every flow below signs in for real (see supabase/seed.ts's DEMO_LOGINS) —
 * routes are auth-gated, so there is no shortcut around it.
 *
 * The whole file still runs serially, not per describe block: several
 * describe blocks below (teacher, parent) mutate the same shared "alliance"
 * tenant's data (today's attendance register, fee/M-Pesa simulation state),
 * so running them as separate parallel workers risks one test's writes
 * racing another's reads. (This used to also be required by Supabase Auth's
 * signInWithOtp() rate limit for the parent flow's shared phone number —
 * FIG-396 replaced that OTP flow with login_id+password, so that specific
 * reason no longer applies, but the shared-tenant-state reason still does.)
 */
test.describe.configure({ mode: "serial" });

const LOGINS = {
  platform: { email: "joyce@figbloom.co.ke", password: "figbloom-dev" },
  schoolAdmin: { email: "principal@alliance.sc.ke", password: "figbloom-dev" },
  teacher: { school: "Alliance High School", loginId: "TC-0001", password: "figbloom-dev" },
  parent: { school: "Alliance High School", loginId: "PT-0001", password: "figbloom-dev" },
  student: { school: "Alliance High School", loginId: "ST-0001", password: "figbloom-dev" },
};

/** Sign-in is a client-side redirect after an async Supabase call — wait for
 *  it to actually land (and the session to persist) before doing anything
 *  else, or a subsequent page.goto() races it and bounces back to /signin. */
async function waitForSignedIn(page: Page) {
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 15000 });
}

/** org owners and Figbloom staff — the only two roles still on real email. */
async function signInEmail(page: Page, email: string, password: string) {
  await page.goto("/signin");
  await page.getByRole("button", { name: "Sign in with email instead" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await waitForSignedIn(page);
}

/** Everyone else: school + school-assigned login_id + password (FIG-396). */
async function signInWithId(page: Page, school: string, loginId: string, password: string) {
  await page.goto("/signin");
  await page.getByLabel("School").fill(school);
  await page.getByRole("button").filter({ hasText: school }).first().click();
  await page.getByLabel("Your ID").fill(loginId);
  await page.getByLabel("Your ID").blur();
  await expect(page.getByText(/^Signing in as /)).toBeVisible({ timeout: 5000 });
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await waitForSignedIn(page);
}

test.describe("sign in", () => {
  test("no role is named anywhere on the door", async ({ page }) => {
    await page.goto("/signin");
    await expect(page.getByText(/\bStaff\b|\bParent\b|\bStudent\b|\bPlatform\b/)).toHaveCount(0);
  });

  test("the school+ID mode is the default; picking a school reveals the ID field", async ({ page }) => {
    await page.goto("/signin");
    await expect(page.getByLabel("School")).toBeVisible();
    await page.getByLabel("School").fill("Alliance High School");
    await page.getByRole("button").filter({ hasText: "Alliance High School" }).first().click();
    await expect(page.getByLabel("Your ID")).toBeVisible();
  });

  test("an unrecognized ID shows a hint instead of silently failing", async ({ page }) => {
    await page.goto("/signin");
    await page.getByLabel("School").fill("Alliance High School");
    await page.getByRole("button").filter({ hasText: "Alliance High School" }).first().click();
    await page.getByLabel("Your ID").fill("TC-9999");
    await page.getByLabel("Your ID").blur();
    await expect(page.getByText(/couldn't find that ID/i)).toBeVisible({ timeout: 5000 });
  });
});

test.describe("platform", () => {
  test.beforeEach(async ({ page }) => {
    await signInEmail(page, LOGINS.platform.email, LOGINS.platform.password);
  });

  test("super admin onboards a school in five steps", async ({ page }) => {
    await page.goto("/platform/tenants");
    await page.getByRole("button", { name: "+ Onboard" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("step 1 of 5");

    // Not "Kabarak High School" — suggestSlug() strips "high"/"school" as filler
    // words, so that name's slug would collide with the seeded "kabarak" tenant.
    await dialog.getByLabel("School name").fill("Nyeri Girls Secondary School");
    await dialog.getByRole("button", { name: "Continue" }).click();

    // The workspace address is flagged as permanent — it can't be changed later.
    await expect(dialog).toContainText("The address is permanent.");
    await dialog.getByRole("button", { name: "Continue" }).click(); // Workspace -> Plan
    await dialog.getByRole("button", { name: "Continue" }).click(); // Plan -> Administrator

    await dialog.getByLabel("Full name").fill("Peter Mwangi");
    await dialog.getByLabel("Email").fill("peter.mwangi@nyerigirls.sc.ke");
    await dialog.getByRole("button", { name: "Continue" }).click(); // Administrator -> Review

    await expect(dialog).toContainText("Review before creating");
    await expect(dialog).toContainText("Nyeri Girls Secondary School");
    await dialog.getByRole("button", { name: "Create school and send invite" }).click();

    // Nothing is actually emailed/texted locally — the success screen hands over
    // real login credentials instead of claiming an invite was delivered.
    await expect(dialog).toContainText("is live");
    await expect(dialog).toContainText("Nothing was emailed or texted");
  });

  test("a taken address is refused", async ({ page }) => {
    await page.goto("/platform/tenants");
    await page.getByRole("button", { name: "+ Onboard" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("School name").fill("Alliance");
    await dialog.getByRole("button", { name: "Continue" }).click(); // School -> Workspace, where the slug check runs
    // The wizard only knows which slugs are taken, not who owns each one.
    await expect(dialog).toContainText("already taken by another school");
  });

  test("console chips cannot contradict their own stat cards", async ({ page }) => {
    await page.goto("/platform/incidents");
    await page.getByRole("button", { name: "Open" }).click();
    // "Open" must include Investigating and Fix in review, not just one of them.
    await expect(page.getByText("Investigating")).toBeVisible();
    await expect(page.getByText("Fix in review")).toBeVisible();
    // Scoped to table rows — "Resolved" is also the label of the (always-rendered)
    // filter chip itself, and a substring match would also hit "resolved 14 Aug"
    // in a stat card's sub-text.
    await expect(page.getByRole("row").filter({ hasText: "Resolved" })).toHaveCount(0);
  });
});

test.describe("teacher", () => {
  // Both attendance tests write to the same class's same day's register —
  // Attendance.tsx prefills from whatever is already saved for today, so a
  // stale row from an earlier run (or the other Playwright project) would
  // make the roster no longer all-present. Reset before either test touches
  // it, rather than relying on run order to keep the starting state honest.
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const { data: tenant } = await admin.from("tenants").select("id").eq("slug", "alliance").single();
    const today = new Date().toISOString().slice(0, 10);
    await admin.from("attendance").delete().eq("tenant_id", tenant!.id).eq("taken_on", today);
  });

  test.beforeEach(async ({ page }) => {
    await signInWithId(page, LOGINS.teacher.school, LOGINS.teacher.loginId, LOGINS.teacher.password);
    await page.goto("/s/alliance/teacher/attendance");
  });

  test("an all-present register asks for one confirmation", async ({ page }) => {
    await page.getByRole("button", { name: "Submit register" }).click();
    await expect(page.getByText(/Marking all \d+ learners present/)).toBeVisible();
    await page.getByRole("button", { name: "Yes, submit" }).click();
    await expect(page.getByText("register is in")).toBeVisible();
  });

  test("teacher submits a full register in a handful of actions", async ({ page }) => {
    // Everyone starts present, so the count is the whole roster.
    await expect(page.getByText(/\d+ present/)).toBeVisible();
    await expect(page.getByText("Everyone starts present")).toBeVisible();

    const rows = page.getByRole("listitem");
    await rows.nth(0).getByRole("button", { name: "Absent" }).click();
    await rows.nth(1).getByRole("button", { name: "Late" }).click();

    await page.getByRole("button", { name: "Submit register" }).click();
    await expect(page.getByText("register is in")).toBeVisible();
    await expect(page.getByText(/Parents of absent learners/)).toBeVisible();
  });

  test("gradebook will not publish a partial column", async ({ page }) => {
    await page.goto("/s/alliance/teacher/gradebook");
    const publish = page.getByRole("button", { name: /still to enter|Publish marks/ });
    await expect(publish).toBeVisible();

    // Out-of-range marks are refused in the teacher's own words.
    const first = page.locator('[data-row="0"]');
    await first.fill("140");
    await expect(page.getByText("This paper is out of 100")).toBeVisible();

    // "abs" is a valid entry — a missed paper is missing, not zero.
    await first.fill("abs");
    await expect(page.getByText("This paper is out of 100")).toHaveCount(0);
  });
});

test.describe("parent", () => {
  // One real sign-in for the whole block, reused via a shared context
  // (session lives in localStorage, which is scoped per context+origin, not
  // per page) — no need to pay the school-search + ID-resolve round trip
  // again for every single test.
  let context: import("@playwright/test").BrowserContext;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    const page = await context.newPage();
    await signInWithId(page, LOGINS.parent.school, LOGINS.parent.loginId, LOGINS.parent.password);
    await page.close();
  });

  test.afterAll(async () => {
    await context.close();
  });

  test("parent's M-Pesa prompt simulates a successful payment", async () => {
    const page = await context.newPage();
    await page.goto("/s/alliance/parent");

    // There is no sandbox Daraja account wired up — the STK push is a client-side
    // simulation, so no real receipt is created (see parent/Fees.tsx's startPay()).
    await page.getByRole("button", { name: "Pay with M-Pesa" }).click();
    await page.getByRole("button", { name: "Send M-Pesa prompt" }).click();

    // The waiting state tells them to expect a prompt on the handset.
    await expect(page.getByText("Check your phone")).toBeVisible();
    await expect(page.getByText(/received/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Method")).toBeVisible();
    await page.close();
  });

  test("a failed payment says whether money left the account", async () => {
    const page = await context.newPage();
    await page.goto("/s/alliance/parent");

    await page.getByRole("button", { name: "Pay with M-Pesa" }).click();

    // Overpaying triggers the failure path in the simulation.
    await page.getByRole("button", { name: "Another amount" }).click();
    await page.locator('input[inputmode="numeric"]').first().fill("99999");
    await page.getByRole("button", { name: "Send M-Pesa prompt" }).click();

    await expect(page.getByText("did not go through")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/No money left your account/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Pay at the school office instead" })).toBeVisible();
    await page.close();
  });

  test("switching children changes every figure on the screen", async () => {
    const page = await context.newPage();
    await page.goto("/s/alliance/parent");

    // "Form 2 West" alone also matches an unrelated seeded announcement's text —
    // the admission number makes this the one unambiguous "which child" marker.
    await expect(page.getByText("ADM 4102")).toBeVisible();

    // ChildSwitcher shows first names only.
    await page.getByRole("button", { name: "Samuel" }).click();
    await expect(page.getByText("ADM 4103")).toBeVisible();
    await page.close();
  });
});

test.describe("student", () => {
  test.beforeEach(async ({ page }) => {
    await signInWithId(page, LOGINS.student.school, LOGINS.student.loginId, LOGINS.student.password);
    await page.goto("/s/alliance/student");
  });

  test("a student never sees a class position", async ({ page }) => {
    // The console nav renders NavLinks (role "link"), not buttons.
    await page.getByRole("link", { name: /Results/ }).click();
    // Every subject row also says "...class mean of N", so this is scoped to the
    // one-off blurb rather than a broad match that hits all of them (or neither,
    // if results haven't been published for this student yet).
    await expect(page.getByText(/Marks shown against the class mean|Not published yet/)).toBeVisible();
    await expect(page.getByText(/position/i)).toContainText("not shown");
  });
});
