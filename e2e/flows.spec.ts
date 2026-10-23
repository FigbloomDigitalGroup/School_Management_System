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
  // The same IDs as DEMO_LOGINS in packages/shared/src/demo.ts: the seeded accounts.
  teacher: { school: "Alliance High School", loginId: "TC-0002", password: "figbloom-dev" },
  parent: { school: "Alliance High School", loginId: "PT-0002", password: "figbloom-dev" },
  student: { school: "Alliance High School", loginId: "ST-0002", password: "figbloom-dev" },
};

/** Sign-in is a client-side redirect after an async Supabase call — wait for
 *  it to actually land (and the session to persist) before doing anything
 *  else, or a subsequent page.goto() races it and bounces back to /signin. */
async function waitForSignedIn(page: Page) {
  await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 15000 });
}

type PortalName = "Admin" | "Teacher" | "Student" | "Parent" | "Driver";

/** Sign-in opens on a portal choice; the real role is still checked after auth. */
async function choosePortal(page: Page, portal: PortalName) {
  await page.getByRole("button", { name: `${portal} portal` }).click();
}

const portalForId = (loginId: string): PortalName =>
  ({ AD: "Admin", TC: "Teacher", ST: "Student", PT: "Parent", BD: "Driver" } as const)[loginId.slice(0, 2) as "AD"];

/** org owners, Figbloom staff and email-provisioned school admins — Admin portal only. */
async function signInEmail(page: Page, email: string, password: string) {
  await page.goto("/signin");
  await choosePortal(page, "Admin");
  await page.getByRole("button", { name: "Sign in with email instead" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await waitForSignedIn(page);
}

/** Everyone else: school + school-assigned login_id + password (FIG-396). */
async function signInWithId(
  page: Page, school: string, loginId: string, password: string, portal: PortalName = portalForId(loginId),
) {
  await page.goto("/signin");
  await choosePortal(page, portal);
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
  test("the door offers the five portals, and no credentials until one is chosen", async ({ page }) => {
    await page.goto("/signin");
    for (const portal of ["Admin", "Teacher", "Student", "Parent", "Driver"]) {
      await expect(page.getByRole("button", { name: `${portal} portal` })).toBeVisible();
    }
    await expect(page.getByLabel("School")).toHaveCount(0);
  });

  test("email sign-in is offered under the Admin portal only", async ({ page }) => {
    await page.goto("/signin");
    await choosePortal(page, "Teacher");
    await expect(page.getByRole("button", { name: "Sign in with email instead" })).toHaveCount(0);
    await page.getByRole("button", { name: /Choose a different portal/ }).click();
    await choosePortal(page, "Admin");
    await expect(page.getByRole("button", { name: "Sign in with email instead" })).toBeVisible();
  });

  test("an account signing in through the wrong portal is turned away and signed out", async ({ page }) => {
    await page.goto("/signin");
    await choosePortal(page, "Student");
    await page.getByLabel("School").fill(LOGINS.teacher.school);
    await page.getByRole("button").filter({ hasText: LOGINS.teacher.school }).first().click();
    await page.getByLabel("Your ID").fill(LOGINS.teacher.loginId);
    await page.getByLabel("Your ID").blur();
    await expect(page.getByText(/^Signing in as /)).toBeVisible({ timeout: 5000 });
    await page.getByLabel("Password").fill(LOGINS.teacher.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText(/not a student account.*Teacher portal/i)).toBeVisible({ timeout: 15000 });
    await expect(page).toHaveURL(/\/signin/);
  });

  test("the school+ID mode is the default; picking a school reveals the ID field", async ({ page }) => {
    await page.goto("/signin");
    await choosePortal(page, "Teacher");
    await expect(page.getByLabel("School")).toBeVisible();
    await page.getByLabel("School").fill("Alliance High School");
    await page.getByRole("button").filter({ hasText: "Alliance High School" }).first().click();
    await expect(page.getByLabel("Your ID")).toBeVisible();
  });

  test("an unrecognized ID shows a hint instead of silently failing", async ({ page }) => {
    await page.goto("/signin");
    await choosePortal(page, "Teacher");
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
  // The attendance tests write to the same class's same day's register —
  // Attendance.tsx prefills from whatever is already saved for today, so a
  // register left by an earlier test (or an earlier run, or the other Playwright
  // project) would open straight to "register is in". Reset before EACH test.
  test.describe.configure({ mode: "serial" });

  const todayIso = () => new Date().toISOString().slice(0, 10);
  async function attendanceRowsToday() {
    const { data: tenant } = await admin.from("tenants").select("id").eq("slug", "alliance").single();
    const { count } = await admin.from("attendance").select("id", { count: "exact", head: true }).eq("tenant_id", tenant!.id).eq("taken_on", todayIso());
    return count ?? 0;
  }

  test.beforeEach(async ({ page }) => {
    const { data: tenant } = await admin.from("tenants").select("id").eq("slug", "alliance").single();
    await admin.from("attendance").delete().eq("tenant_id", tenant!.id).eq("taken_on", todayIso());
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
    await expect(page.getByText(/parents of absent learners/i)).toBeVisible();
  });

  const attendanceWrite = /\/rest\/v1\/attendance/;

  test("a register submitted while the server is unreachable is held, then sent by itself", async ({ page }) => {
    // The browser believes it is online, but the school's server doesn't answer:
    // the old screen said "submitted" and quietly lost the register.
    await page.route(attendanceWrite, (route) => (route.request().method() === "POST" ? route.abort("failed") : route.continue()));

    await page.getByRole("button", { name: "Submit register" }).click();
    await page.getByRole("button", { name: "Yes, submit" }).click();
    await expect(page.getByText("Saved on this phone. It will send itself when you have signal.")).toBeVisible();
    await expect(page.getByText(/held on this phone/)).toBeVisible();
    expect(await attendanceRowsToday()).toBe(0);
    expect(await page.evaluate(() => window.localStorage.getItem("figbloom.queue.v1"))).toContain('"table":"attendance"');

    // The server comes back: the register goes out without the teacher doing anything.
    await page.unroute(attendanceWrite);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(attendanceRowsToday, { timeout: 15000 }).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem("figbloom.queue.v1")), { timeout: 15000 }).toBe("[]");
    await expect(page.getByText(/held on this phone/)).toHaveCount(0, { timeout: 15000 });
  });

  test("a register the server refuses is not reported as saved, and is not held", async ({ page }) => {
    await page.route(attendanceWrite, (route) => (route.request().method() === "POST"
      ? route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ code: "42501", message: 'new row violates row-level security policy for table "attendance"', details: null, hint: null }),
        })
      : route.continue()));

    await page.getByRole("button", { name: "Submit register" }).click();
    await page.getByRole("button", { name: "Yes, submit" }).click();
    await expect(page.getByText(/The register was not saved: .*row-level security/)).toBeVisible();
    // Still on the roster, not on "register is in", and nothing parked in the queue to fail forever.
    await expect(page.getByText("Everyone starts present")).toBeVisible();
    await expect(page.getByText("register is in")).toHaveCount(0);
    expect(await page.evaluate(() => window.localStorage.getItem("figbloom.queue.v1"))).toBeNull();
    expect(await attendanceRowsToday()).toBe(0);
  });

  test("something saved on this device that the server refused is shown, and can be discarded", async ({ page }) => {
    // Parked in the queue by an earlier visit: the server said no, so waiting can't help.
    const refused = [{
      id: "marks-1", table: "marks", rows: [], queuedAt: new Date().toISOString(), attempts: 1,
      lastError: "new row violates row-level security policy for table \"marks\"",
      rejected: { at: new Date().toISOString(), message: "new row violates row-level security policy for table \"marks\"" },
    }];
    await page.evaluate((q) => window.localStorage.setItem("figbloom.queue.v1", JSON.stringify(q)), refused);
    await page.reload();

    const notice = page.getByRole("alert").filter({ hasText: "could not be sent" });
    await expect(notice).toContainText("Marks saved on this device could not be sent");
    await expect(notice).toContainText("row-level security");

    await notice.getByRole("button", { name: "Discard" }).click();
    await expect(notice).toHaveCount(0);
    expect(await page.evaluate(() => window.localStorage.getItem("figbloom.queue.v1"))).toBe("[]");
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
  test("the gradebook says whether this class's marks are out, and lets the teacher withdraw them", async ({ page }) => {
    await page.goto("/s/alliance/teacher/gradebook");
    await page.getByLabel("Class").selectOption({ label: "Form 2 West" });
    await page.getByLabel("Exam").selectOption({ label: "Mock 1" });
    // The seed publishes Mock 1 for Form 2 West, one class and subject at a time.
    await expect(page.getByText("Published to parents")).toBeVisible();
    await expect(page.getByRole("button", { name: "Withdraw results" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Publish marks" })).toHaveCount(0);
  });

  test("the homework page offers to set work for the teacher's classes", async ({ page }) => {
    await page.goto("/s/alliance/teacher/homework");
    await expect(page.getByRole("heading", { name: "Homework" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Set homework" }).first()).toBeEnabled();
  });
});

test.describe("school admin", () => {
  test("exams are listed for the term, and an exam with marks cannot be deleted", async ({ page }) => {
    await signInEmail(page, LOGINS.schoolAdmin.email, LOGINS.schoolAdmin.password);
    await page.goto("/s/alliance/admin/exams");
    await expect(page.getByText("Mock 1").first()).toBeVisible();
    await expect(page.getByText("Out of 100").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "New exam" }).first()).toBeEnabled();
    // Mock 1 has marks entered, so its Delete is switched off.
    await expect(page.locator("button:disabled", { hasText: "Delete" }).first()).toBeVisible();
  });

  test("a learner with records is archived, not deleted: the roll and class totals follow, and restoring puts them back", async ({ page, browser, isMobile }) => {
    test.skip(isMobile, "the admin console's Manage dialog is wider than a phone screen");
    // A learner with a full history (the seed gives every learner attendance, marks and an invoice) and no login of their own.
    const { data: tenant } = await admin.from("tenants").select("id").eq("slug", "alliance").single();
    const { data: cls } = await admin.from("classes").select("id").eq("tenant_id", tenant!.id).eq("name", "Form 2 West").single();
    const { data: kid } = await admin.from("students").select("id, full_name, admission_no").eq("class_id", cls!.id).eq("active", true).is("profile_id", null).order("admission_no").limit(1).single();
    const activeInClass = async () => (await admin.from("students").select("id", { count: "exact", head: true }).eq("class_id", cls!.id).eq("active", true)).count ?? 0;
    const totalBefore = await activeInClass();
    const marksBefore = (await admin.from("marks").select("id", { count: "exact", head: true }).eq("student_id", kid!.id)).count ?? 0;
    expect(marksBefore).toBeGreaterThan(0);

    try {
      await signInEmail(page, LOGINS.schoolAdmin.email, LOGINS.schoolAdmin.password);
      await page.goto("/s/alliance/admin/people");
      // Names repeat across classes; the admission number doesn't.
      await page.getByPlaceholder("Name or admission number").fill(kid!.admission_no);
      await page.getByText(`ADM ${kid!.admission_no}`).first().click();
      const manage = page.getByRole("dialog");

      // Deleting is refused, in words, because they have records.
      page.once("dialog", (d) => void d.accept());
      await manage.getByRole("button", { name: "Delete…" }).click();
      await expect(page.getByText(/on file, so they can't be deleted/)).toBeVisible();
      await expect(manage).toBeVisible();

      // Archiving takes them off the roll and keeps everything.
      page.once("dialog", (d) => void d.accept());
      await manage.getByRole("button", { name: "Archive learner" }).click();
      await expect(page.getByText(/archived\. Find them under "Archived"/)).toBeVisible();
      await expect(page.getByText("No learner matches that")).toBeVisible();
      const { data: archived } = await admin.from("students").select("active, archived_at, archived_by").eq("id", kid!.id).single();
      expect(archived).toMatchObject({ active: false });
      expect(archived!.archived_at).not.toBeNull();
      expect((await admin.from("marks").select("id", { count: "exact", head: true }).eq("student_id", kid!.id)).count).toBe(marksBefore);

      // The class totals a teacher sees stop counting them: "n of 43 handed in" becomes "n of 42".
      const teacher = await (await browser.newContext()).newPage();
      await signInWithId(teacher, LOGINS.teacher.school, LOGINS.teacher.loginId, LOGINS.teacher.password);
      await teacher.goto("/s/alliance/teacher/homework");
      await expect(teacher.getByText(new RegExp(`\\bof ${totalBefore - 1}\\b`)).first()).toBeVisible();
      await teacher.context().close();

      // They are under Archived, and restoring puts them back.
      await page.getByRole("group", { name: "Which learners" }).getByRole("button", { name: "archived" }).click();
      await page.getByText(`ADM ${kid!.admission_no}`).first().click();
      await page.getByRole("dialog").getByRole("button", { name: "Restore learner" }).click();
      await expect(page.getByText(/restored\./)).toBeVisible();
      await expect.poll(activeInClass).toBe(totalBefore);
      await page.getByRole("group", { name: "Which learners" }).getByRole("button", { name: "current" }).click();
      await expect(page.getByText(`ADM ${kid!.admission_no}`).first()).toBeVisible();
    } finally {
      await admin.from("students").update({ active: true, archived_at: null, archived_by: null }).eq("id", kid!.id);
    }
  });

  test("a learner added by mistake, with no records, can still be deleted", async ({ page, isMobile }) => {
    test.skip(isMobile, "the admin console's Manage dialog is wider than a phone screen");
    const { data: tenant } = await admin.from("tenants").select("id").eq("slug", "alliance").single();
    const { data: cls } = await admin.from("classes").select("id").eq("tenant_id", tenant!.id).eq("name", "Form 2 West").single();
    const name = `E2E Mistake ${Date.now()}`;
    const { data: mistake } = await admin.from("students").insert({ tenant_id: tenant!.id, admission_no: `E2E-${Date.now() % 100000}`, full_name: name, class_id: cls!.id, boarding: false }).select("id").single();
    try {
      await signInEmail(page, LOGINS.schoolAdmin.email, LOGINS.schoolAdmin.password);
      await page.goto("/s/alliance/admin/people");
      await page.getByPlaceholder("Name or admission number").fill(name);
      await page.getByText(name).first().click();
      page.once("dialog", (d) => void d.accept());
      await page.getByRole("dialog").getByRole("button", { name: "Delete…" }).click();
      await expect(page.getByText(`${name} deleted.`)).toBeVisible();
      expect((await admin.from("students").select("id", { count: "exact", head: true }).eq("id", mistake!.id)).count).toBe(0);
    } finally {
      await admin.from("students").delete().eq("id", mistake!.id);
    }
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

  test("with no M-Pesa credentials set up, the dialog says so and claims nothing", async () => {
    const page = await context.newPage();
    await page.goto("/s/alliance/parent");

    // A local stack has no Daraja credentials, so the request comes back
    // "unavailable". The screen must say that, not pretend a prompt went out
    // or that money moved (it used to simulate a success here).
    await page.getByRole("button", { name: "Pay with M-Pesa" }).click();
    await page.getByRole("button", { name: "Send M-Pesa prompt" }).click();

    await expect(page.getByText(/Online M-Pesa isn't available for your school right now/)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Nothing was sent to your phone and nothing was charged/)).toBeVisible();
    await expect(page.getByText("Check your phone")).toHaveCount(0);
    await expect(page.getByText(/received/)).toHaveCount(0);
    await page.close();
  });

  test("paying more than the balance is refused before any prompt is sent", async () => {
    const page = await context.newPage();
    await page.goto("/s/alliance/parent");

    await page.getByRole("button", { name: "Pay with M-Pesa" }).click();
    await page.getByRole("button", { name: "Another amount" }).click();
    await page.locator('input[inputmode="numeric"]').first().fill("99999");

    await page.getByRole("button", { name: "Send M-Pesa prompt" }).click();
    await expect(page.getByText(/That is more than the KSh [\d,]+ still owed/)).toBeVisible();
    await expect(page.getByText("Check your phone")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send M-Pesa prompt" })).toBeVisible();
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

  test("a half-published exam does not hide the last complete one: the learner can switch", async ({ page }) => {
    // Teachers publish a class and subject at a time. Put one subject of a new
    // exam out for this learner's class, the way a first teacher would.
    const examName = `E2E half published ${Date.now()}`;
    const { data: tenant } = await admin.from("tenants").select("id").eq("slug", "alliance").single();
    const { data: term } = await admin.from("terms").select("id").eq("tenant_id", tenant!.id).eq("is_current", true).single();
    const { data: learner } = await admin.from("profiles").select("id").eq("login_id", LOGINS.student.loginId).single();
    const { data: teacher } = await admin.from("profiles").select("id").eq("login_id", LOGINS.teacher.loginId).single();
    const { data: studentRow } = await admin.from("students").select("id, class_id").eq("profile_id", learner!.id).single();
    const { data: subject } = await admin.from("subjects").select("id").eq("tenant_id", tenant!.id).eq("name", "Chemistry").single();
    const { data: exam } = await admin.from("exams").insert({ tenant_id: tenant!.id, term_id: term!.id, name: examName }).select("id").single();
    try {
      await admin.from("marks").insert({ tenant_id: tenant!.id, exam_id: exam!.id, student_id: studentRow!.id, subject_id: subject!.id, score: 71, entered_by: teacher!.id });
      await admin.from("mark_publications").insert({ tenant_id: tenant!.id, exam_id: exam!.id, class_id: studentRow!.class_id, subject_id: subject!.id });

      await page.goto("/s/alliance/student/results");
      const switcher = page.getByRole("group", { name: "Exam" });
      await expect(switcher).toBeVisible();
      // Newest first, each pill says how many subjects are out, and the new exam is showing.
      const pills = switcher.getByRole("button");
      await expect(pills.first()).toContainText(`${examName} · 1 subject`);
      await expect(pills.first()).toHaveAttribute("aria-pressed", "true");

      // The earlier, complete exam is one tap away.
      await switcher.getByRole("button", { name: /Mock 1/ }).click();
      await expect(page.getByText("Mathematics").first()).toBeVisible();
      await expect(switcher.getByRole("button", { name: /Mock 1/ })).toHaveAttribute("aria-pressed", "true");
    } finally {
      await admin.from("mark_publications").delete().eq("exam_id", exam!.id);
      await admin.from("marks").delete().eq("exam_id", exam!.id);
      await admin.from("exams").delete().eq("id", exam!.id);
    }
  });
});
